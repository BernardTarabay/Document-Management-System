-- Records whether extracted text is REAL TEXT or extraction noise.
--
-- WHY A COLUMN AND NOT A STATUS
--
-- extraction_status is the processing_status enum (pending/processing/
-- completed/failed/skipped), and none of those fit. Extraction of a scanned
-- PDF genuinely SUCCEEDS -- it returns a string -- the string is just
-- garbage. Calling that "failed" would be wrong (nothing failed, and the
-- self-healing scan would retry it forever), and calling it "completed"
-- while letting the garbage flow downstream is the bug being fixed.
--
-- So quality is recorded alongside status, not instead of it:
--
--   text_quality   'ok' | 'empty' | 'too_short' | 'no_text_layer' | 'gibberish'
--   needs_ocr      the text is unusable AND the file is an image or an
--                  image-only PDF, so OCR would plausibly recover it. A .accdb
--                  with no text is unusable but OCR cannot help it.
--
-- Plain text rather than a new enum: these verdicts come from a heuristic in
-- services/extraction/textQuality.js that will be tuned against real
-- documents, and every tweak would otherwise need a migration.

ALTER TABLE file_content
  ADD COLUMN IF NOT EXISTS text_quality TEXT,
  ADD COLUMN IF NOT EXISTS needs_ocr BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN file_content.text_quality IS
  'Verdict from textQuality.assessText: ok | empty | too_short | no_text_layer | gibberish. Anything but ok means the text must not be used to name or classify the file.';
COMMENT ON COLUMN file_content.needs_ocr IS
  'The text is unusable and the file is an image or image-only PDF, so OCR would plausibly recover real content.';

-- Backfill: everything indexed before this migration is unassessed rather
-- than known-good. NULL says "not judged yet" and is deliberately different
-- from 'ok', so a later pass can tell the two apart.
CREATE INDEX IF NOT EXISTS idx_file_content_needs_ocr
  ON file_content (needs_ocr) WHERE needs_ocr;
