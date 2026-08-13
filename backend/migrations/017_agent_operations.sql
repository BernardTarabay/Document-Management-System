-- Phase 12: Filesystem Agent operation brokering
-- (docs/04-storage-architecture.md §4.4-§4.5).
--
-- An agent runs on a machine the backend cannot address -- typically a
-- personal laptop behind NAT, not always online. So the backend can never
-- call the agent; the agent polls the backend. This table is that channel:
-- the backend enqueues a typed, already-validated operation, the agent
-- claims it, performs it, and reports the result back.
--
-- Why a table rather than a BullMQ queue: these rows are the audit trail of
-- what was asked of a machine the backend does not control, and they must
-- outlive Redis and be queryable from the API (docs/04 §4.5 principle 4 --
-- "the backend records the result, never assumes success"). Same reasoning
-- that makes processing_jobs the source of truth rather than BullMQ.

DO $$ BEGIN
  CREATE TYPE agent_operation_type AS ENUM (
    'list_directory', 'stat', 'read_file', 'rename', 'move', 'remove'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE agent_operation_status AS ENUM (
    'pending', 'dispatched', 'succeeded', 'failed', 'expired'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The agent authenticates with a long random API key issued once at
-- registration; only its bcrypt hash is stored (api_key_hash already exists
-- from migration 003). These columns add the enrollment lifecycle around it.
ALTER TABLE filesystem_agents
  ADD COLUMN IF NOT EXISTS enrolled_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS agent_version      TEXT,
  ADD COLUMN IF NOT EXISTS platform           TEXT,
  ADD COLUMN IF NOT EXISTS hostname           TEXT,
  -- Set when an admin revokes the agent; a revoked agent's key stops
  -- authenticating without deleting the row (which would orphan the audit
  -- trail of everything it ever did).
  ADD COLUMN IF NOT EXISTS revoked_at         TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS agent_operations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          UUID NOT NULL REFERENCES filesystem_agents(id) ON DELETE CASCADE,
  operation_type    agent_operation_type NOT NULL,
  -- The already-resolved, already-path-validated inputs. The agent receives
  -- ONLY this -- never a shell command, never an unvalidated path
  -- (docs/04 §4.5 principles 2 and 3).
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  status            agent_operation_status NOT NULL DEFAULT 'pending',
  result            JSONB,
  error_message     TEXT,
  -- Bounds how long a backend caller waits, and lets a crashed agent's
  -- claimed-but-never-finished operations be reaped rather than hanging
  -- forever.
  expires_at        TIMESTAMPTZ NOT NULL DEFAULT now() + interval '5 minutes',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at     TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ
);

-- The agent's poll is the hottest query in this feature: "my oldest pending
-- work". Partial index keeps it independent of how much completed history
-- has accumulated.
CREATE INDEX IF NOT EXISTS idx_agent_operations_pending
  ON agent_operations(agent_id, created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_agent_operations_agent_created
  ON agent_operations(agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_operations_expiry
  ON agent_operations(expires_at)
  WHERE status IN ('pending', 'dispatched');
