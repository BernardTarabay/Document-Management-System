-- Devices, and where a file's bytes actually are.
--
-- THE PROBLEM THIS SOLVES
--
-- The metadata in this database has always been central: names, subjects,
-- classifications, duplicate groups, rename history. Sign in from a second
-- computer and all of that is already there. What is NOT there is the file --
-- because this application indexes files where they lie and copies nothing.
-- A document discovered in C:\Users\me\Scans on a desktop has no bytes
-- reachable from a laptop, and the "organized view" it appears in is a tree
-- of Windows .lnk shortcuts under MIRROR_ROOT, which is meaningless on any
-- other machine.
--
-- So the honest statement of the gap is: organization is already
-- cross-device; CONTENT is not. This migration models content availability
-- explicitly rather than papering over it.
--
-- THE MODEL
--
--   device            a registered machine belonging to a user
--   storage_location  now lives ON a device (its disk)
--   file_replicas     one row per (file, place-the-bytes-are), with state
--
-- A file is openable right now if it has a `present` replica either on the
-- server or on a device that is currently online. Anything else is reported
-- as unavailable WITH THE REASON -- "Desktop-A is offline" -- instead of a
-- broken download.
--
-- Two ways bytes become reachable, both real, neither a copy the user did not
-- ask for:
--
--   1. On demand, through the origin device's agent. The transport already
--      exists (agent_operations.read_file, services/storage/agentStorageService).
--      Costs nothing on disk; requires that device to be awake.
--   2. Server-side replication, opt-in per storage location. A `replicate`
--      job pulls the bytes once into managed storage so the file is available
--      even when its origin machine is off. This duplicates data, which is
--      why it is off by default and decided per location.

-- ---------------------------------------------------------------------------
-- devices
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE device_status AS ENUM ('online', 'offline', 'never_connected', 'revoked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS devices (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- What the user calls this machine ("Desktop", "Work laptop"). Distinct
  -- from hostname, which is what the machine calls itself and is frequently
  -- something like DESKTOP-4F9K2QP.
  name           TEXT NOT NULL,
  hostname       TEXT,
  platform       TEXT,
  -- 'server' is this backend itself. Locations with access_mode='direct' are
  -- on it, and it is always online by definition -- if it were not, nothing
  -- would be answering the request.
  kind           TEXT NOT NULL DEFAULT 'desktop',
  status         device_status NOT NULL DEFAULT 'never_connected',
  agent_version  TEXT,
  last_seen_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_devices_owner_name UNIQUE (owner_user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_devices_owner ON devices(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_devices_owner_status ON devices(owner_user_id, status);

-- An agent is how a device is reached; the device is the durable identity.
-- Keeping them separate means re-enrolling an agent (new API key, reinstall,
-- OS upgrade) does not create a second "computer" in the UI and does not
-- orphan the availability records that point at that machine.
ALTER TABLE filesystem_agents
  ADD COLUMN IF NOT EXISTS device_id UUID REFERENCES devices(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_filesystem_agents_device ON filesystem_agents(device_id);

ALTER TABLE storage_locations
  -- Which machine's disk this folder is on. NULL is read as "the server",
  -- which is what every access_mode='direct' location has always meant.
  ADD COLUMN IF NOT EXISTS device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
  -- Opt in to keeping a server-side copy of this location's files so they
  -- open from any device even while this one is asleep. Off by default: it
  -- duplicates the user's data, and that must be a decision, not a surprise.
  ADD COLUMN IF NOT EXISTS replication_enabled BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_storage_locations_device ON storage_locations(device_id);

-- ---------------------------------------------------------------------------
-- file_replicas -- the answer to "can I open this right now, and from where?"
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE replica_state AS ENUM ('present', 'missing', 'stale', 'pending', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS file_replicas (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id       UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  -- NULL device_id means the server's own managed storage -- the replication
  -- target. Exactly one such row can exist per file, enforced below.
  device_id     UUID REFERENCES devices(id) ON DELETE CASCADE,
  state         replica_state NOT NULL DEFAULT 'present',
  -- Absolute path on that device (or under the replica root on the server).
  local_path    TEXT,
  size_bytes    BIGINT,
  -- The hash of what is actually at local_path, which is how `stale` is
  -- detected: the origin changed and this copy no longer matches.
  sha256_hash   CHAR(64),
  verified_at   TIMESTAMPTZ,
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One replica row per (file, place). Two partial indexes rather than one
-- constraint because NULL device_id (the server) never compares equal to
-- itself in a normal unique constraint, which would let the replication job
-- write a second server copy every time it ran.
CREATE UNIQUE INDEX IF NOT EXISTS uq_file_replicas_device
  ON file_replicas(file_id, device_id) WHERE device_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_file_replicas_server
  ON file_replicas(file_id) WHERE device_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_file_replicas_file ON file_replicas(file_id);
CREATE INDEX IF NOT EXISTS idx_file_replicas_device_state
  ON file_replicas(device_id, state);
-- Drives the replication worker's "what still needs copying" query.
CREATE INDEX IF NOT EXISTS idx_file_replicas_pending
  ON file_replicas(state) WHERE state IN ('pending', 'failed');

-- ---------------------------------------------------------------------------
-- Seed a 'server' device per existing owner, and attach direct locations
-- ---------------------------------------------------------------------------
--
-- Every location that the backend reads straight off its own filesystem is,
-- physically, on the machine running the backend. Naming that explicitly
-- means the UI never has to special-case "no device" -- there is always an
-- answer to "which computer is this on?".

INSERT INTO devices (owner_user_id, name, kind, status, hostname)
SELECT DISTINCT sl.owner_user_id, 'This server', 'server', 'online'::device_status, NULL
  FROM storage_locations sl
 WHERE sl.owner_user_id IS NOT NULL
   AND sl.access_mode = 'direct'
ON CONFLICT (owner_user_id, name) DO NOTHING;

UPDATE storage_locations sl
   SET device_id = d.id
  FROM devices d
 WHERE d.owner_user_id = sl.owner_user_id
   AND d.kind = 'server'
   AND sl.access_mode = 'direct'
   AND sl.device_id IS NULL;

-- Existing agents predate the device table; give each one a device carrying
-- whatever identity it already reported, so no enrolled machine is lost.
INSERT INTO devices (owner_user_id, name, hostname, platform, kind, status, last_seen_at)
SELECT sl.owner_user_id,
       COALESCE(NULLIF(fa.hostname, ''), fa.name),
       fa.hostname,
       fa.platform,
       'desktop',
       CASE WHEN fa.status = 'online' THEN 'online' ELSE 'offline' END::device_status,
       fa.last_seen_at
  FROM filesystem_agents fa
  JOIN storage_locations sl ON sl.id = fa.storage_location_id
 WHERE fa.device_id IS NULL
   AND sl.owner_user_id IS NOT NULL
ON CONFLICT (owner_user_id, name) DO NOTHING;

UPDATE filesystem_agents fa
   SET device_id = d.id
  FROM storage_locations sl
  JOIN devices d ON d.owner_user_id = sl.owner_user_id
 WHERE fa.storage_location_id = sl.id
   AND fa.device_id IS NULL
   AND d.name = COALESCE(NULLIF(fa.hostname, ''), fa.name);

UPDATE storage_locations sl
   SET device_id = fa.device_id
  FROM filesystem_agents fa
 WHERE fa.storage_location_id = sl.id
   AND sl.access_mode = 'agent'
   AND sl.device_id IS NULL;

-- Every already-indexed file is, by definition, present on the device that
-- holds its location -- that is how it came to be indexed.
INSERT INTO file_replicas (file_id, device_id, state, local_path, size_bytes, sha256_hash, verified_at)
SELECT f.id, sl.device_id, 'present', f.current_path, f.size_bytes, f.sha256_hash, f.last_scanned_at
  FROM files f
  JOIN storage_locations sl ON sl.id = f.storage_location_id
 WHERE sl.device_id IS NOT NULL
   AND f.status = 'active'
ON CONFLICT DO NOTHING;
