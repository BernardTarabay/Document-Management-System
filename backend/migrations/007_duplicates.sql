-- Phase 5: duplicate detection & safe deduplication (see docs/01-domain-model.md §1.3)

CREATE TABLE IF NOT EXISTS duplicate_groups (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_type          duplicate_group_type NOT NULL,
  detection_method    detection_method NOT NULL,
  status              duplicate_group_status NOT NULL DEFAULT 'open',
  canonical_file_id   UUID REFERENCES files(id) ON DELETE SET NULL,
  confidence_level    confidence_level,
  confidence_score    NUMERIC(4,3),
  resolved_by         UUID REFERENCES users(id),
  resolved_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_duplicate_groups_status ON duplicate_groups(status);

CREATE TABLE IF NOT EXISTS duplicate_group_members (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  duplicate_group_id  UUID NOT NULL REFERENCES duplicate_groups(id) ON DELETE CASCADE,
  file_id             UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  similarity_score    NUMERIC(4,3),   -- 1.000 for exact-duplicate members
  added_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_duplicate_group_members UNIQUE (duplicate_group_id, file_id)
);

CREATE INDEX IF NOT EXISTS idx_duplicate_group_members_file_id ON duplicate_group_members(file_id);
