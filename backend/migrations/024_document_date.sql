-- When a document is actually FROM, as opposed to when its bytes last landed
-- on this disk.
--
-- imported_at and modified_at_fs already exist, and neither answers the
-- question. This repository was assembled from backups and copies, so the
-- filesystem timestamps largely record the day of the copy. Sorting by them
-- is close to sorting at random, and "prefer the newer copy" when resolving
-- duplicates is actively wrong if "newer" means "copied more recently".
--
-- document_date holds the best available answer and document_date_source
-- records where it came from, because the two matter differently:
--
--   exif | pdf | embedded | ole   read out of the document itself -- trustworthy
--   filesystem                    a guess from the file's timestamps
--   none                          nothing was available
--
-- Keeping the source means the UI can show a real date differently from an
-- inferred one, and a filter can be restricted to documents whose date means
-- something. Collapsing them into one nullable column would throw that away.

ALTER TABLE files
  ADD COLUMN IF NOT EXISTS document_date TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS document_date_source TEXT;

COMMENT ON COLUMN files.document_date IS
  'Best available date for the document itself, resolved by services/extraction/documentDate.js.';
COMMENT ON COLUMN files.document_date_source IS
  'Where document_date came from: exif | pdf | embedded | ole | filesystem | none. Anything but filesystem/none was read out of the document.';

-- Sorting and range-filtering by date are the two things this column exists
-- for, and both scan it. Partial: a NULL date can never satisfy a range.
CREATE INDEX IF NOT EXISTS idx_files_document_date
  ON files (document_date DESC) WHERE document_date IS NOT NULL;
