-- Phase 5: audit log (see docs/02-terminology.md §1.7)
-- Append-only by convention (no UPDATE/DELETE application code should touch this table).

CREATE TABLE IF NOT EXISTS audit_logs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID REFERENCES users(id) ON DELETE SET NULL,  -- NULL = system action
  action               TEXT NOT NULL,   -- 'file.imported', 'file.renamed', 'duplicate.merged', ...
  entity_type          TEXT NOT NULL,   -- 'file', 'document', 'duplicate_group', 'user', ...
  entity_id            UUID,
  previous_state        JSONB,
  new_state             JSONB,
  reason                TEXT,
  status                audit_status NOT NULL DEFAULT 'success',
  ip_address            INET,
  user_agent            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
