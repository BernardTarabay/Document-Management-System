-- Phase 5: taxonomy (see docs/03-taxonomy.md)
-- Subject/Category/Subcategory modeled as one self-referential table, per the
-- explicit requirement that domain must not affect architecture.

CREATE TABLE IF NOT EXISTS subjects (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id           UUID REFERENCES subjects(id) ON DELETE CASCADE,
  level               subject_level NOT NULL,
  name                TEXT NOT NULL,
  slug                TEXT NOT NULL,
  materialized_path   TEXT NOT NULL,   -- denormalized, e.g. 'finance.budgets.annual'
  description         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_subjects_parent_slug UNIQUE (parent_id, slug)
);

-- NOTE: the composite UNIQUE above does NOT dedupe root-level rows, because
-- standard SQL never treats two NULLs as equal (parent_id IS NULL for every
-- top-level Subject). A partial unique index closes that gap explicitly.
CREATE UNIQUE INDEX IF NOT EXISTS uq_subjects_root_slug ON subjects(slug) WHERE parent_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_subjects_parent_id ON subjects(parent_id);
CREATE INDEX IF NOT EXISTS idx_subjects_materialized_path ON subjects(materialized_path);
CREATE INDEX IF NOT EXISTS idx_subjects_level ON subjects(level);

-- Document Type is orthogonal to Subject (an Invoice can appear under Finance
-- or under Administrative); see docs/03-taxonomy.md §3.4.
CREATE TABLE IF NOT EXISTS document_types (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                TEXT UNIQUE NOT NULL,   -- 'AnnualBudget', 'Invoice', ...
  name                TEXT NOT NULL,
  description         TEXT,
  naming_template     TEXT,                   -- overrides default naming convention if set
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tags (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT UNIQUE NOT NULL,
  slug                TEXT UNIQUE NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
