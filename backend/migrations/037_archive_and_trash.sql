-- Archive and Trash: two destinations that behave like folders and are not.
--
-- WHY THEY ARE NOT ROWS IN `subjects`
--
-- The obvious implementation is two seeded folders that refuse to be renamed
-- or deleted. It is wrong, and the reason is worth writing down because it will
-- look like the easy option again later.
--
-- A subject answers "what is this document ABOUT". Moving a file to a folder
-- writes a classification row and changes nothing else -- the file is still
-- active, still listed, still searched, still counted. Trash and Archive are
-- statements about a document's LIFECYCLE, not its topic: a trashed file must
-- disappear from every listing, stop being counted, and eventually be removed.
-- Modelling them as subjects would mean every query in the application growing
-- an "...and not filed under the Trash folder" clause, and every one that
-- forgot would show deleted documents as though they were live.
--
-- `files.status` already carries exactly this distinction and already has
-- `archived` and `deleted` values. So Archive and Trash are STATUSES, rendered
-- in the tree as pinned destinations beside the Unfiled pile -- which is itself
-- already a destination that is not a folder. Undeletable and unrenameable
-- follows for free: there is no row to delete or rename.
--
-- WHAT THIS MIGRATION ADDS
--
-- Timestamps. The statuses exist but record no WHEN, and Trash cannot expire
-- something without knowing when it arrived. `archived_at` is included for
-- symmetry and because "when did I archive this" is a question the Archive view
-- has to answer.
--
-- Subjects get `archived_at` too: archiving is described as "a way to hide
-- files AND folders", and a hidden folder is a real need -- an old project you
-- do not want in the tree but do not want to destroy either. Unlike files,
-- there is no expiry: an archived folder is hidden until you unhide it.

ALTER TABLE files
  ADD COLUMN IF NOT EXISTS deleted_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_at  TIMESTAMPTZ;

ALTER TABLE subjects
  ADD COLUMN IF NOT EXISTS archived_at  TIMESTAMPTZ;

-- Files already sitting at status='deleted' from before this migration have no
-- arrival time. Dating them NOW rather than backdating them is the safe
-- direction: it gives the full retention window to things that were deleted
-- before Trash could promise one, instead of purging them on the first sweep.
UPDATE files SET deleted_at = now()  WHERE status = 'deleted'  AND deleted_at  IS NULL;
UPDATE files SET archived_at = now() WHERE status = 'archived' AND archived_at IS NULL;

-- The purge sweep asks one question -- "what is old enough to remove" -- and
-- asks it on a schedule, so it gets its own index rather than scanning every
-- file in the repository each time.
CREATE INDEX IF NOT EXISTS idx_files_trash_expiry
  ON files (owner_user_id, deleted_at)
  WHERE status = 'deleted';

CREATE INDEX IF NOT EXISTS idx_files_archived
  ON files (owner_user_id, archived_at)
  WHERE status = 'archived';

-- Hiding a branch is a prefix question ("is this folder or any ancestor
-- archived"), the same shape the count rollup uses.
CREATE INDEX IF NOT EXISTS idx_subjects_archived
  ON subjects (owner_user_id, archived_at)
  WHERE archived_at IS NOT NULL;
