-- Read-only storage locations, and the canonical name a file WOULD have.
--
-- The deployment this is built for indexes someone's real working files --
-- scattered across iCloud, local disks and external drives, hundreds of
-- gigabytes, irreplaceable. Renaming or moving those in place is the single
-- action in this system that could destroy something: a half-completed move
-- across a volume that went offline, or a file pulled out of the iCloud
-- folder that was also its backup.
--
-- So a location can now be marked read-only. The pipeline still does
-- everything it did -- scan, hash, extract, classify, propose a canonical
-- name -- but the filesystem operation at the end is never performed
-- against the original. The proposed name is recorded on the file instead,
-- and the shortcut mirror (see MIRROR_ROOT) is what actually presents the
-- organized view. A wrong name there is a cosmetic annoyance that
-- regenerates; a wrong rename on an original is data loss.

ALTER TABLE storage_locations
  -- Defaults TRUE: a newly registered folder is somebody's real data until
  -- they explicitly say otherwise. The safe default is the one where we
  -- touch nothing.
  ADD COLUMN IF NOT EXISTS is_read_only BOOLEAN NOT NULL DEFAULT true;

-- The existing managed upload location owns its bytes (they were copied
-- there by this app), so it is the one place renaming in place is correct.
UPDATE storage_locations SET is_read_only = false WHERE type = 'managed';

ALTER TABLE files
  -- The name/folder this file WOULD have if it were being renamed in place.
  -- Kept separate from filename_current/current_path, which must always
  -- describe what is actually on disk -- conflating them would leave the
  -- app unable to find the file it just "renamed".
  ADD COLUMN IF NOT EXISTS canonical_filename     TEXT,
  ADD COLUMN IF NOT EXISTS canonical_relative_dir TEXT,
  ADD COLUMN IF NOT EXISTS canonical_set_at       TIMESTAMPTZ;

-- Drives the mirror-sync job: "everything classified since the mirror last
-- ran". Partial, because most rows have no canonical name yet.
CREATE INDEX IF NOT EXISTS idx_files_canonical_set_at
  ON files(canonical_set_at)
  WHERE canonical_filename IS NOT NULL;
