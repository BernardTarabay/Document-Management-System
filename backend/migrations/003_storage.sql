-- Phase 5: storage locations + filesystem agents (see docs/04-storage-architecture.md)

CREATE TABLE IF NOT EXISTS storage_locations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL,
  type                  storage_type NOT NULL,
  root_path             TEXT NOT NULL,
  access_mode           storage_access_mode NOT NULL DEFAULT 'direct',
  config                JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active             BOOLEAN NOT NULL DEFAULT true,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS filesystem_agents (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_location_id     UUID NOT NULL REFERENCES storage_locations(id) ON DELETE CASCADE,
  name                    TEXT NOT NULL,
  api_key_hash            TEXT NOT NULL,
  status                  agent_status NOT NULL DEFAULT 'offline',
  last_seen_at            TIMESTAMPTZ,
  registered_directories  JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A storage_location with access_mode = 'agent' should have at least one agent
-- registered; enforced at the service layer (a partial index can't express
-- cross-table cardinality, so this is a documented invariant, not a constraint).

ALTER TABLE storage_locations
  ADD COLUMN IF NOT EXISTS primary_agent_id UUID REFERENCES filesystem_agents(id);

CREATE INDEX IF NOT EXISTS idx_filesystem_agents_storage_location_id
  ON filesystem_agents(storage_location_id);
CREATE INDEX IF NOT EXISTS idx_storage_locations_is_active
  ON storage_locations(is_active) WHERE is_active = true;
