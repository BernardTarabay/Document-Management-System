-- Folder-based organization: lets a single rename_proposals row represent
-- "call it X" and/or "move it to folder Y" together, applied atomically by
-- bulkRenameProcessor.js. Deliberately extends rename_proposals rather than
-- building a parallel bulk_move pipeline (job_type 'bulk_move' exists in
-- the enum but was never implemented) -- in practice a person reviews
-- "rename and reorganize" as one decision about a file, not two, and this
-- way it goes through the exact same approve/reject/bulk-apply double gate
-- (spec §22/§23) the naming pipeline already has, instead of a second,
-- parallel review surface.
--
-- NULL means "no folder change, stays where it is" -- the common case for
-- a file already correctly placed, or when there's no confident Subject to
-- place it under.
ALTER TABLE rename_proposals
  ADD COLUMN IF NOT EXISTS proposed_relative_dir TEXT;
