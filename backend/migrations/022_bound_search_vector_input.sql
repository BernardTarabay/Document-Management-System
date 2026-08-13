-- Stop very long documents from failing extraction outright.
--
-- THE BUG
--
-- to_tsvector() refuses any input string over 1,048,575 bytes:
--   ERROR: string is too long for tsvector (1049794 bytes, max 1048575 bytes)
--
-- search_vector is a GENERATED column, so that error fires during the INSERT
-- into file_content. The insert is rejected, no row is written at all, and
-- the file ends up with no extracted text -- indexed by filename only,
-- invisible to search, with nothing on screen to say so. Seen on real data:
-- 44 failures across a 9,398-file folder, on files up to 2,117,096
-- characters.
--
-- THE FIX
--
-- Bound only what gets INDEXED. extracted_text still stores the document in
-- full -- similarity comparison, the compare-two-files feature, and anything
-- that reads the body still see everything. Only the search vector works
-- from a prefix.
--
-- WHY 200,000 CHARACTERS
--
-- Measured on the largest document in the real corpus, the four-config
-- union grows sublinearly because vocabulary repeats:
--
--     input chars     vector bytes
--          50,000           83,196
--         100,000          107,814
--         150,000          124,186
--         200,000          135,880
--         300,000          166,688
--
-- 200,000 characters is ~40 pages -- far past the point where a document
-- stops being about anything new -- and caps the input at 800 KB even in the
-- worst case of 4-byte UTF-8 throughout, safely under the 1,048,575 limit
-- for Arabic and French text that is 2 bytes per character in practice.
-- Only 136 of 9,430 real files exceed even 150,000 characters.

DROP INDEX IF EXISTS idx_file_content_search_vector;

ALTER TABLE file_content DROP COLUMN IF EXISTS search_vector;

ALTER TABLE file_content
  ADD COLUMN search_vector TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('simple',  left(coalesce(extracted_text, ''), 200000)) ||
    to_tsvector('english', left(coalesce(extracted_text, ''), 200000)) ||
    to_tsvector('french',  left(coalesce(extracted_text, ''), 200000)) ||
    to_tsvector('arabic',  left(coalesce(extracted_text, ''), 200000))
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_file_content_search_vector
  ON file_content USING gin (search_vector);
