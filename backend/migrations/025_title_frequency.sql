-- Supports "is this title boilerplate, or is it actually about this file?"
--
-- Many documents in this repository carry the organisation's name as their
-- embedded title, because that is what the Word template had in it. Measured
-- on the live corpus: 403 files share one title, another 25 share its French
-- translation, 20 more say "Secretariat General", and 758 of 1,368 titled
-- files carry a title that at least four other files also carry.
--
-- Naming from that title renames hundreds of unrelated documents to the same
-- thing, which is worse than leaving them alone. Deciding whether a title is
-- shared means counting how many files use it, once per file being named --
-- and without an index that is a sequential scan of file_metadata every time.

CREATE INDEX IF NOT EXISTS idx_file_metadata_title
  ON file_metadata ((metadata->>'title'))
  WHERE metadata->>'title' IS NOT NULL;
