-- Make full-text search actually work on this corpus.
--
-- The original search_vector was to_tsvector('english', extracted_text).
-- The documents in this system are overwhelmingly French and Arabic, with
-- some Hebrew and English. Measured against a real title from the
-- repository -- "Conférences des Carmélites déchaussées au Liban":
--
--   english  -> 'au':5 'carmélit':3 'conférenc':1 'des':2 'déchaussé':4
--   french   -> 'carmélit':3 'conférent':1 'déchauss':4 'liban':6
--   simple   -> 'conférences':1 'déchaussées':4  (no stemming at all)
--
-- English applies Porter stemming to French words, which is wrong in
-- principle even where it accidentally works, and it keeps French stop
-- words ("des", "au") as indexed noise while stripping English ones.
--
-- The fix is a UNION of configurations rather than a choice between them.
-- tsvectors concatenate with ||, so one column can hold:
--   simple  -- exact tokens, the only thing that indexes Hebrew usefully
--             and the fallback for every language with no stemmer
--   english -- English stems
--   french  -- French stems (this corpus's dominant language)
--   arabic  -- Arabic stems (Postgres ships a real Arabic snowball stemmer)
--
-- Cost is a larger index -- roughly 3-4x the lexemes. Text is a small
-- fraction of the bytes in a document repository, and search quality is the
-- entire product, so that is a trade worth making.
--
-- Rebuilding a GENERATED column means dropping and re-adding it, which
-- recomputes every row. On a large corpus this migration is slow; that is
-- expected and only happens once.

DROP INDEX IF EXISTS idx_file_content_search_vector;

ALTER TABLE file_content DROP COLUMN IF EXISTS search_vector;

ALTER TABLE file_content
  ADD COLUMN search_vector TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('simple',  coalesce(extracted_text, '')) ||
    to_tsvector('english', coalesce(extracted_text, '')) ||
    to_tsvector('french',  coalesce(extracted_text, '')) ||
    to_tsvector('arabic',  coalesce(extracted_text, ''))
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_file_content_search_vector
  ON file_content USING gin (search_vector);
