-- The shortcut mirror, real-time watching, and cloud placeholder handling.

-- sync_mirror: rebuilds the organized shortcut tree from canonical names.
ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'sync_mirror';

ALTER TABLE files
  -- Where this file's shortcut currently lives inside MIRROR_ROOT, relative
  -- to it. Tracked so a re-sync can MOVE an existing shortcut when a file is
  -- reclassified, rather than leaving the old one behind as a duplicate
  -- pointing at the same target.
  ADD COLUMN IF NOT EXISTS mirror_path      TEXT,
  ADD COLUMN IF NOT EXISTS mirror_synced_at TIMESTAMPTZ,

  -- Cloud-sync placeholders (iCloud Drive, OneDrive Files On-Demand). The
  -- file appears in the directory listing at full size, but its bytes are
  -- not on disk -- reading it forces a download. Across a few hundred
  -- gigabytes that means filling the disk and saturating the connection,
  -- so these are detected and skipped rather than blindly read.
  ADD COLUMN IF NOT EXISTS is_cloud_placeholder BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS placeholder_checked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_files_mirror_pending
  ON files(canonical_set_at)
  WHERE canonical_filename IS NOT NULL AND mirror_synced_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_files_placeholders
  ON files(storage_location_id)
  WHERE is_cloud_placeholder = true;

ALTER TABLE storage_locations
  -- Watch this folder for changes and ingest automatically, instead of
  -- waiting for someone to press "Run scan".
  ADD COLUMN IF NOT EXISTS watch_enabled BOOLEAN NOT NULL DEFAULT true,
  -- Apply high-confidence names without human review. Safe specifically
  -- BECAUSE read-only locations never touch the original: the only thing
  -- an auto-applied name affects is the shortcut mirror, which is
  -- regenerable. Defaults off so turning it on stays a deliberate choice.
  ADD COLUMN IF NOT EXISTS auto_apply_naming BOOLEAN NOT NULL DEFAULT false;
