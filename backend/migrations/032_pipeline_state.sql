-- The file lifecycle becomes an explicit state machine, and OCR becomes real.
--
-- WHAT WAS WRONG
--
-- A file's position in the pipeline was inferred, never recorded. "Is this
-- done?" was answered by asking four different questions -- does it have a
-- hash, does it have extracted text, is its text quality usable, does it have
-- a job in flight -- and every consumer (triageRepository, listUnprocessed,
-- the dashboard, the scan's recovery pass) asked them slightly differently.
-- That is why retrying a triaged file could quietly return it to triage: the
-- retry re-ran a stage, the stage succeeded, and the file still matched the
-- same "stuck" predicate for a different reason, forever, with nothing
-- counting the laps.
--
-- So: one column that says where the file IS, one that says how many times we
-- have tried, and one that says what went wrong in words. A file can now be
-- proven to be making progress, and a file that genuinely cannot be finished
-- by machine is marked as needing a person instead of being re-queued.
--
-- THE STATES
--
--   discovered      indexed, nothing done yet
--   processing      a stage is queued or running
--   needs_user      the machine has done all it can; a human must decide
--                   (this is what "in triage" means, and it is a RESTING
--                   state, not an error)
--   completed       processed as far as this file can go, and filed
--   failed_retryable a stage failed and retrying is still worth doing
--   failed_terminal  retried to the limit, or failed for a reason retrying
--                    cannot change (bytes are gone, format unsupported)
--   archived        withdrawn from the working set by the user
--
-- Every file is in exactly one of these, and every transition is made by
-- services/pipelineState.js -- so "what happens on failure/retry/manual
-- intervention" has one answer, written down once.

DO $$ BEGIN
  CREATE TYPE file_pipeline_state AS ENUM (
    'discovered', 'processing', 'needs_user', 'completed',
    'failed_retryable', 'failed_terminal', 'archived'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE files
  ADD COLUMN IF NOT EXISTS pipeline_state   file_pipeline_state NOT NULL DEFAULT 'discovered',
  -- Which stage the file is on or last attempted, e.g. 'extract_text'.
  ADD COLUMN IF NOT EXISTS pipeline_stage   TEXT,
  -- Counted PER STAGE, not per file: a file that failed extraction twice and
  -- then failed classification once has not "failed three times", and a
  -- shared counter would strand it early. Shape: {"extract_text": 2}
  ADD COLUMN IF NOT EXISTS retry_counts     JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- The last failure in plain language, kept on the file so the triage queue
  -- can show WHY without joining to the job that died.
  ADD COLUMN IF NOT EXISTS failure_reason   TEXT,
  ADD COLUMN IF NOT EXISTS failure_stage    TEXT,
  ADD COLUMN IF NOT EXISTS state_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set when the user has explicitly dealt with a needs_user file (moved it,
  -- kept its name, archived it). Stops a resolved file reappearing in triage
  -- because the underlying condition -- an unreadable scan, say -- is still
  -- true and always will be.
  ADD COLUMN IF NOT EXISTS user_resolved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS user_resolution  TEXT;

CREATE INDEX IF NOT EXISTS idx_files_owner_pipeline_state
  ON files(owner_user_id, pipeline_state);
CREATE INDEX IF NOT EXISTS idx_files_needs_user
  ON files(owner_user_id, state_changed_at DESC)
  WHERE pipeline_state = 'needs_user' AND user_resolved_at IS NULL;

-- Backfill: derive each existing file's state from what it actually has.
-- Deliberately conservative -- anything ambiguous becomes 'discovered', which
-- is the state that gets picked up and finished, rather than a guess at
-- 'completed' that would silently exclude it from ever being processed.
UPDATE files SET pipeline_state = CASE
  WHEN status = 'archived'                        THEN 'archived'
  WHEN status = 'missing'                         THEN 'failed_terminal'
  WHEN processing_status = 'completed'            THEN 'completed'
  WHEN processing_status = 'failed'               THEN 'failed_retryable'
  WHEN processing_status = 'processing'           THEN 'processing'
  ELSE 'discovered'
END::file_pipeline_state
WHERE pipeline_state = 'discovered';

-- ---------------------------------------------------------------------------
-- OCR
-- ---------------------------------------------------------------------------
--
-- Until now `needs_ocr` was a diagnosis with no treatment: the triage queue
-- could tell you a scan had no text layer and then had nothing to offer,
-- because no OCR engine was ever wired in. These columns track a real OCR
-- attempt -- which engine, which languages, how confident, and the text it
-- produced -- kept separate from file_content.extracted_text so that
-- machine-read text is never mistaken for text the document actually
-- contained. Naming and classification treat the two differently, and
-- collapsing them is how a document ends up named from OCR noise.

DO $$ BEGIN
  CREATE TYPE ocr_status AS ENUM (
    'not_needed', 'pending', 'queued', 'running', 'completed', 'failed', 'unavailable'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE files
  ADD COLUMN IF NOT EXISTS ocr_status ocr_status NOT NULL DEFAULT 'not_needed';

CREATE TABLE IF NOT EXISTS file_ocr (
  file_id         UUID PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  status          ocr_status NOT NULL DEFAULT 'pending',
  engine          TEXT,
  engine_version  TEXT,
  languages       TEXT,
  -- 0..1, averaged over recognised words. Low confidence is not a failure --
  -- it is the signal that a human should look at the picture, which is
  -- exactly what the Photos workspace is for.
  confidence      NUMERIC(4,3),
  page_count      INTEGER,
  text            TEXT,
  error_message   TEXT,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_file_ocr_status ON file_ocr(status);

-- Files that are pictures, and therefore belong in the Photos workspace
-- rather than in a document list. Recorded as a column instead of being
-- re-derived from the mime type on every query, because the Photos page,
-- the triage counts and the dashboard all need the same answer and a
-- disagreement between them is a bug the user sees as files vanishing.
ALTER TABLE files
  ADD COLUMN IF NOT EXISTS is_image BOOLEAN NOT NULL DEFAULT false;

UPDATE files SET is_image = true
 WHERE COALESCE(mime_type_detected, mime_type_declared, '') LIKE 'image/%'
    OR lower(COALESCE(extension, '')) IN
       ('jpg','jpeg','png','gif','bmp','tif','tiff','webp','heic','heif','avif');

CREATE INDEX IF NOT EXISTS idx_files_owner_images
  ON files(owner_user_id, imported_at DESC) WHERE is_image = true;
CREATE INDEX IF NOT EXISTS idx_files_owner_ocr_status
  ON files(owner_user_id, ocr_status)
  WHERE ocr_status IN ('pending', 'queued', 'running', 'failed');

-- Files already flagged as needing OCR by the text-quality pass move from
-- "diagnosed" to "waiting for the engine".
UPDATE files f SET ocr_status = 'pending'
  FROM file_content fc
 WHERE fc.file_id = f.id
   AND f.ocr_status = 'not_needed'
   AND (f.is_image = true OR fc.extracted_text IS NULL OR length(trim(fc.extracted_text)) < 32);
