-- Per-user ownership.
--
-- WHY THIS EXISTS
--
-- Until now this schema was single-tenant with RBAC bolted on top: there was
-- no owner column anywhere. `storage_locations` was a bare list of absolute
-- paths, `files` pointed at a location and nothing else, and every signed-in
-- account holding `document.view` saw the entire corpus. That is a defensible
-- design for one household's archive, and it is exactly the wrong one the
-- moment a second person registers -- self-registration is open (authService
-- .register), so "a second person registers" is one HTTP request away.
--
-- The requirement is now explicit: a user must never be able to reach another
-- user's storage location, files, subjects, duplicates or conversations. That
-- cannot be retrofitted at the route layer, because the leak is in the
-- queries themselves -- `SELECT * FROM files` does not know who is asking. So
-- ownership goes in the schema, is NOT NULL where it can be, and every
-- repository read is scoped by it (see repositories/ownership.js).
--
-- DENORMALISATION ON `files`
--
-- files.owner_user_id duplicates storage_locations.owner_user_id. That is
-- deliberate. The alternative -- joining to storage_locations on every file
-- query to discover the owner -- puts a join in the hottest path in the
-- application (the Files listing, the search, the triage queue, the tree
-- counts) purely to re-derive a value that cannot change independently. The
-- trigger below keeps the two honest, so the denormalised copy cannot drift
-- even if application code forgets to set it.
--
-- BACKFILL
--
-- Existing rows are assigned to the oldest user account, which on any real
-- install of this app is its owner. If there are no users at all there is
-- nothing to own, and the NOT NULL constraints below apply to an empty table.

-- ---------------------------------------------------------------------------
-- 1. Ownership columns
-- ---------------------------------------------------------------------------

ALTER TABLE storage_locations
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE files
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE subjects
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE duplicate_groups
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE processing_jobs
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- 2. Backfill from the oldest account
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  first_user UUID;
BEGIN
  SELECT id INTO first_user FROM users ORDER BY created_at ASC, id ASC LIMIT 1;
  IF first_user IS NULL THEN
    RETURN;   -- no accounts yet; nothing can be owned
  END IF;

  UPDATE storage_locations SET owner_user_id = first_user WHERE owner_user_id IS NULL;
  UPDATE subjects          SET owner_user_id = first_user WHERE owner_user_id IS NULL;

  -- Files follow their location rather than the fallback, so a corpus that
  -- somehow already spans accounts stays attributed correctly.
  UPDATE files f
     SET owner_user_id = sl.owner_user_id
    FROM storage_locations sl
   WHERE sl.id = f.storage_location_id
     AND f.owner_user_id IS NULL;

  UPDATE documents SET owner_user_id = first_user WHERE owner_user_id IS NULL;

  -- A duplicate group belongs to whoever owns its members. Groups are only
  -- ever formed from files, so there is always at least one.
  UPDATE duplicate_groups dg
     SET owner_user_id = sub.owner_user_id
    FROM (
      SELECT dgm.duplicate_group_id, MIN(f.owner_user_id::text)::uuid AS owner_user_id
        FROM duplicate_group_members dgm
        JOIN files f ON f.id = dgm.file_id
       GROUP BY dgm.duplicate_group_id
    ) sub
   WHERE sub.duplicate_group_id = dg.id
     AND dg.owner_user_id IS NULL;
  DELETE FROM duplicate_groups WHERE owner_user_id IS NULL;   -- memberless orphans

  UPDATE processing_jobs pj
     SET owner_user_id = COALESCE(
           (SELECT sl.owner_user_id FROM storage_locations sl WHERE sl.id = pj.storage_location_id),
           pj.created_by,
           first_user
         )
   WHERE pj.owner_user_id IS NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 3. NOT NULL where an unowned row is meaningless
-- ---------------------------------------------------------------------------
--
-- Applied only when the backfill actually left no gaps. A migration that
-- fails here is telling you a row exists that no account can reach, and
-- silently dropping it would be worse than stopping.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage_locations WHERE owner_user_id IS NULL) THEN
    ALTER TABLE storage_locations ALTER COLUMN owner_user_id SET NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM files WHERE owner_user_id IS NULL) THEN
    ALTER TABLE files ALTER COLUMN owner_user_id SET NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM subjects WHERE owner_user_id IS NULL) THEN
    ALTER TABLE subjects ALTER COLUMN owner_user_id SET NOT NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Keep files.owner_user_id honest
-- ---------------------------------------------------------------------------
--
-- The denormalised copy is maintained here rather than in application code so
-- that a processor which forgets to pass an owner cannot create an unowned --
-- and therefore invisible -- file. Ownership of a file is not an independent
-- fact; it is a consequence of which location the bytes were found in.

CREATE OR REPLACE FUNCTION files_inherit_owner() RETURNS TRIGGER AS $$
BEGIN
  SELECT owner_user_id INTO NEW.owner_user_id
    FROM storage_locations WHERE id = NEW.storage_location_id;
  IF NEW.owner_user_id IS NULL THEN
    RAISE EXCEPTION 'storage location % has no owner; refusing to create an unreachable file',
      NEW.storage_location_id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_files_inherit_owner ON files;
CREATE TRIGGER trg_files_inherit_owner
  BEFORE INSERT OR UPDATE OF storage_location_id ON files
  FOR EACH ROW EXECUTE FUNCTION files_inherit_owner();

-- ---------------------------------------------------------------------------
-- 5. Uniqueness becomes per-owner
-- ---------------------------------------------------------------------------

-- Root-level subject slugs were globally unique, so the first account to own
-- a "finance" Subject would have blocked every other account from having one.
DROP INDEX IF EXISTS uq_subjects_root_slug;
CREATE UNIQUE INDEX IF NOT EXISTS uq_subjects_owner_root_slug
  ON subjects(owner_user_id, slug) WHERE parent_id IS NULL;

-- Registering the same folder twice was previously prevented only by a
-- service-layer lookup (storageLocationService.create). That check is still
-- the one that produces a good error message, but it was the ONLY thing
-- standing between a double-submit and a second location row -- which
-- re-ingests every file in the folder as a fresh identity. Two different
-- accounts pointing at the same folder is legitimate and stays allowed;
-- the same account doing it twice is not.
CREATE UNIQUE INDEX IF NOT EXISTS uq_storage_locations_owner_root_path
  ON storage_locations(owner_user_id, root_path);

-- ---------------------------------------------------------------------------
-- 6. Indexes for the scoped reads
-- ---------------------------------------------------------------------------
--
-- Every listing query now carries `owner_user_id = $1`. Leading with the
-- owner keeps these usable for that predicate alone and for the common
-- owner+filter combinations the Files page issues.

CREATE INDEX IF NOT EXISTS idx_files_owner_status
  ON files(owner_user_id, status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_files_owner_location
  ON files(owner_user_id, storage_location_id);
CREATE INDEX IF NOT EXISTS idx_files_owner_processing
  ON files(owner_user_id, processing_status);
CREATE INDEX IF NOT EXISTS idx_subjects_owner ON subjects(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_storage_locations_owner ON storage_locations(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_duplicate_groups_owner_status
  ON duplicate_groups(owner_user_id, status);
CREATE INDEX IF NOT EXISTS idx_processing_jobs_owner_created
  ON processing_jobs(owner_user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 7. Permissions: owning your own data is not an administrative act
-- ---------------------------------------------------------------------------
--
-- `storage.manage` is new. Registering a storage location used to require
-- `user.manage` -- the permission for creating and deactivating OTHER PEOPLE'S
-- ACCOUNTS. That conflation is why the only account on this install could not
-- add a folder: it holds the `User` role, which quite correctly cannot
-- administer users, and so could not do the single most basic thing the
-- application exists for.
--
-- Now that a location has an owner and every read is scoped to it, pointing
-- the app at your own folder is an ordinary user action. Administering other
-- accounts remains `user.manage` and remains Admin-only.

INSERT INTO permissions (key, description) VALUES
  ('storage.manage', 'Add, edit, scan and remove your own storage locations'),
  ('device.manage',  'Register and manage your own devices and their filesystem agents'),
  ('ai.chat',        'Use the AI assistant and keep conversations')
ON CONFLICT (key) DO NOTHING;

-- Admin keeps everything, including the three new keys.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p WHERE r.name = 'Admin'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.name = 'Manager'
  AND p.key NOT IN ('user.manage', 'role.manage', 'audit.manage', 'agent.manage')
ON CONFLICT DO NOTHING;

-- The `User` role gains everything needed to run its own archive end to end.
-- Each of these is now scoped to rows the user owns, so granting them widens
-- what someone can do to THEIR OWN documents and nothing else:
--
--   storage.manage      register and scan their own folders
--   device.manage       enrol their own laptop/desktop
--   scan.run            actually index what they registered
--   document.rename     apply a rename to their own file
--   document.move       file their own document under a subject
--   document.delete     archive their own document
--   subject.manage      build a folder tree that fits their documents
--   duplicate.manage    resolve duplicates among their own files
--   ai.chat             ask the assistant about their own corpus
--
-- `user.manage`, `role.manage`, `audit.*` and `bulk.approve` are deliberately
-- NOT granted: those govern other people, not your own files.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.name = 'User' AND p.key IN (
  'document.view', 'document.download', 'document.upload', 'classification.modify',
  'storage.manage', 'device.manage', 'scan.run',
  'document.rename', 'document.move', 'document.delete', 'document.restore',
  'subject.manage', 'duplicate.manage', 'ai.chat'
)
ON CONFLICT DO NOTHING;

-- Viewer stays read-only, and gains nothing here.
