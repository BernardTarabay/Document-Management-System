-- Recognising a file you already have, without reading it.
--
-- THE COST THIS ATTACKS
--
-- Registering a second folder that overlaps one already indexed is the normal
-- shape of an import here, not an edge case -- a backup of the same drive, a
-- copy made before reorganising. knownContentService already makes the
-- DOWNSTREAM work free for those files: an identical twin's text, metadata,
-- date, classification and AI enrichment are adopted rather than recomputed.
--
-- But that short-circuit fires at the hash, and reaching the hash means
-- streaming every byte of the file. On a corpus that is mostly overlapping
-- copies, the import is dominated by reading hundreds of gigabytes to learn
-- something the size and timestamp already implied.
--
-- WHAT A QUICK FINGERPRINT IS
--
-- sha256 over the file's size, its first 64 KB and its last 64 KB. For a 500 MB
-- video that is 128 KB read instead of 500 MB -- roughly four thousand times
-- less I/O -- and it is a far stronger signal than size and mtime alone, which
-- is what rsync's default quick-check settles for.
--
-- IT IS AN INFERENCE, AND IS RECORDED AS ONE
--
-- Two different files CAN share a size, a head and a tail. It is vanishingly
-- unlikely and it is not impossible, so a file whose sha256 was adopted from a
-- fingerprint match rather than computed is marked `hash_source = 'inferred'`.
-- That keeps "we read every byte and they are identical" distinguishable from
-- "they looked identical and we believed it", makes the inferred set findable,
-- and makes it repairable -- see scripts/verify-inferred-hashes.js.
--
-- Files at or below 128 KB are never inferred: reading them whole costs the
-- same as fingerprinting them, so they get a real hash and full certainty for
-- free. The inference only applies where it actually buys something.

ALTER TABLE files
  ADD COLUMN IF NOT EXISTS quick_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS hash_source       TEXT NOT NULL DEFAULT 'computed';

-- Existing rows were all hashed the long way.
UPDATE files SET hash_source = 'computed' WHERE hash_source IS NULL;

-- The candidate lookup: "do I already have a file this size, with this
-- timestamp, that finished the pipeline?" Answered from the index alone, with
-- no file opened.
CREATE INDEX IF NOT EXISTS idx_files_quick_identity
  ON files (owner_user_id, size_bytes, modified_at_fs)
  WHERE sha256_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_files_quick_fingerprint
  ON files (owner_user_id, quick_fingerprint)
  WHERE quick_fingerprint IS NOT NULL;

-- Small and cheap to scan; used by the verification script to find everything
-- that was believed rather than proven.
CREATE INDEX IF NOT EXISTS idx_files_hash_inferred
  ON files (owner_user_id) WHERE hash_source = 'inferred';
