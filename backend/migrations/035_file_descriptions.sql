-- Every file gets a description you can search by describing it.
--
-- THE PROBLEM
--
-- `files.ai_summary` (migration 012) already holds a sentence or two about
-- what a document is, and the Files page already shows it. It is not, however,
-- something you can FIND a file with, for two separate reasons:
--
--   1. Coverage. It is a by-product of classification, so it exists only when
--      the AI tier happened to run. classifyProcessor skips the call outright
--      when there is no usable text and no embedded title, the daily cap skips
--      more, and nothing anywhere records that a file HAS no description or
--      why. On the current database that is 4 of 14 files with nothing.
--
--   2. Retrieval. fileRepository.searchEverything matches it with
--      `ai_summary ILIKE '%' || $1 || '%'` -- the user's ENTIRE phrase has to
--      appear verbatim inside the summary. Typing what you remember about a
--      document ("the photo of the kid blowing out birthday candles") matches
--      nothing, even when a summary literally reads "a child at a party with a
--      cake". Only file_content.extracted_text is in the real multilingual
--      index (migration 020); the descriptions were never in it at all.
--
-- So the description had to become a first-class thing with its own provenance
-- and its own index, rather than a nullable column left behind by another
-- stage.
--
-- WHY A SEPARATE TABLE RATHER THAN MORE COLUMNS ON `files`
--
--   * A generated tsvector on `files` would recompute and reindex a row of the
--     single hottest table in the application (every listing, every search,
--     every tree count reads it) each time a description is written.
--   * The embedding is ~3KB per row. `files` is sequentially scanned by the
--     listing queries; tripling its row width to carry a blob that only the
--     search cache ever reads is the wrong trade.
--   * "Which files still have no description, and why?" becomes a plain LEFT
--     JOIN instead of a nullable-column heuristic -- which is exactly the
--     mistake migration 032 was written to stop repeating.
--
-- `files.ai_summary` is still WRITTEN (descriptionService mirrors into it) so
-- FilesPage, FileDetailModal, FilePreviewPane, photoService and
-- duplicateGroupRepository keep working untouched. This table is the record;
-- that column is the cache the old UI already reads.
--
-- A ROW ALWAYS EXISTS ONCE THE STAGE HAS RUN
--
-- `description` is nullable and `source` is not. A file the machine genuinely
-- cannot describe gets a row saying so, with a reason in words. That is the
-- same principle as pipelineState's needs_user: a recorded "nothing could read
-- this, here is why" is an answer, and silence is not.

CREATE TABLE IF NOT EXISTS file_descriptions (
  file_id          UUID PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,

  -- Denormalised from files.owner_user_id for the same reason migration 028
  -- denormalised it onto files: the semantic search loads candidate rows by
  -- owner on every query, and a join back to files to discover the owner puts
  -- that join in the hottest new path in the application. NOT NULL, so an
  -- unscoped row cannot exist to be leaked.
  owner_user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- The description itself, in plain language. NULL only when `source` is
  -- 'failed', in which case failure_reason says what stopped it.
  description      TEXT,

  -- A short label, 3-12 words, for places too narrow to show a sentence.
  caption          TEXT,

  -- WHERE the description came from. This is not decoration: it is what lets
  -- the UI show a description derived from a filename differently from one
  -- derived from reading the document, so a guess never looks like a fact.
  --
  --   document_text  summarised from text extracted out of the file
  --   ocr_text       summarised from text OCR recovered from a scan
  --   image          a vision model looked at the picture
  --   video          a multimodal model watched the video
  --   audio          a multimodal model listened to the audio
  --   metadata       NOTHING could read the content (an archive, an encrypted
  --                  PDF, a format with no extractor). Built WITHOUT a model
  --                  from facts only -- type, size, folder, date, and the
  --                  words already present in the filename. It describes the
  --                  file's situation, never its contents.
  --   inherited      adopted from a byte-identical twin that was already
  --                  described, so a duplicate costs no second API call
  --   failed         the stage ran and could not produce one; see
  --                  failure_reason
  source           TEXT NOT NULL CHECK (source IN (
                     'document_text', 'ocr_text', 'image', 'video', 'audio',
                     'metadata', 'inherited', 'failed'
                   )),

  -- Free-form provenance for the curious and for debugging: which model, how
  -- many characters of evidence it saw, the twin it was inherited from, the
  -- duration of the video, token usage.
  detail           JSONB NOT NULL DEFAULT '{}'::jsonb,

  failure_reason   TEXT,

  -- ---------------------------------------------------------------------
  -- The semantic half of retrieval
  -- ---------------------------------------------------------------------
  --
  -- WHY bytea AND NOT pgvector
  --
  -- pgvector is not available on this installation (PostgreSQL 18.4;
  -- pg_available_extensions lists pg_trgm, unaccent and fuzzystrmatch, and no
  -- 'vector'), and installing it on Windows means building it against the
  -- server's MSVC toolchain. It is also not needed at this size: 9,400
  -- descriptions at 768 dimensions is ~7 million multiply-adds per search,
  -- which is single-digit milliseconds in plain JavaScript over a cached
  -- Float32Array. Brute force is the correct algorithm here, and it costs no
  -- dependency the user has to install.
  --
  -- WHY bytea AND NOT float4[]
  --
  -- Postgres sends arrays to node-postgres as TEXT. Loading the cache from
  -- float4[] would mean 768 parseFloat calls per row -- 7.2 million of them
  -- across the corpus, every time the cache is built. As bytea it is exactly
  -- 3,072 bytes that go straight into a Float32Array with no parsing at all.
  --
  -- LAYOUT: little-endian float32, `embedding_dims` of them, L2-NORMALISED at
  -- write time. Normalising on write is what makes cosine similarity a plain
  -- dot product at query time. It is also required rather than cosmetic:
  -- gemini-embedding-001 only returns unit vectors at its full 3072
  -- dimensions; truncated outputs come back un-normalised (measured: ‖v‖ =
  -- 0.59 at 768 dims), so anything comparing them without normalising first is
  -- ranking by vector length as much as by meaning.
  embedding        BYTEA,
  embedding_dims   INTEGER,
  embedding_model  TEXT,

  -- The exact text that was embedded. Stored so a model or prompt change can
  -- re-embed the whole corpus straight from this table, without re-reading
  -- 9,400 documents or paying for a second round of descriptions.
  embedding_input  TEXT,
  embedded_at      TIMESTAMPTZ,

  generated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- The lexical half of retrieval
-- ---------------------------------------------------------------------------
--
-- The same four-configuration union migration 020 arrived at for extracted
-- text, for the same reason: the corpus is French and Arabic, `english`
-- stems French words wrongly, and `simple` is the only configuration that
-- indexes Hebrew usefully. A description of a French document is often
-- written in French, so it needs exactly the same treatment as the document.
--
-- Bounded with left() for the reason migration 022 documents -- a generated
-- column that can exceed tsvector's 1MB input limit rejects the INSERT
-- outright. Descriptions are a sentence or two, so 20,000 characters is far
-- past anything real and still safely under the ceiling.
ALTER TABLE file_descriptions
  ADD COLUMN IF NOT EXISTS search_vector TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('simple',  left(coalesce(description, '') || ' ' || coalesce(caption, ''), 20000)) ||
    to_tsvector('english', left(coalesce(description, '') || ' ' || coalesce(caption, ''), 20000)) ||
    to_tsvector('french',  left(coalesce(description, '') || ' ' || coalesce(caption, ''), 20000)) ||
    to_tsvector('arabic',  left(coalesce(description, '') || ' ' || coalesce(caption, ''), 20000))
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_file_descriptions_search_vector
  ON file_descriptions USING gin (search_vector);

-- The semantic cache loads every embedded row for one owner. Partial, because
-- rows without an embedding are exactly the ones it must not waste I/O on.
CREATE INDEX IF NOT EXISTS idx_file_descriptions_owner_embedded
  ON file_descriptions (owner_user_id) WHERE embedding IS NOT NULL;

-- "What still needs describing, and what failed?" -- the backfill script's
-- query and the coverage half of scripts/verify-descriptions.js.
CREATE INDEX IF NOT EXISTS idx_file_descriptions_source
  ON file_descriptions (owner_user_id, source);

COMMENT ON TABLE file_descriptions IS
  'One plain-language description per file, with its provenance and a normalised embedding. The record; files.ai_summary is the cache the pre-existing UI reads.';
COMMENT ON COLUMN file_descriptions.embedding IS
  'Little-endian float32 x embedding_dims, L2-normalised at write time so cosine similarity is a dot product. See services/ai/embeddingService.js.';
COMMENT ON COLUMN file_descriptions.source IS
  'What evidence produced this description. metadata = nothing could read the content; describes the file''s situation, never its contents.';
