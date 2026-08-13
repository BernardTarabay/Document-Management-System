-- Phase 5: logical Document identity, Versions, and their taxonomy/tag placement
-- (see docs/01-domain-model.md)

CREATE TABLE IF NOT EXISTS documents (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name      TEXT,                -- generated per naming convention; nullable until proposed+approved
  display_name        TEXT NOT NULL,
  document_type_id    UUID REFERENCES document_types(id),
  period_start        DATE,
  period_end          DATE,
  status              document_status NOT NULL DEFAULT 'active',
  current_version_id  UUID,                -- FK added after document_versions exists (avoids circular create)
  created_by          UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_versions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id         UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  file_id             UUID UNIQUE REFERENCES files(id) ON DELETE SET NULL,
  version_number      INTEGER NOT NULL,
  version_label       TEXT,               -- optional human label, e.g. 'Final'
  status              version_status NOT NULL DEFAULT 'draft',
  is_current          BOOLEAN NOT NULL DEFAULT false,
  effective_date      DATE,
  detection_method    detection_method NOT NULL DEFAULT 'manual',
  confidence_level    confidence_level,
  confidence_score    NUMERIC(4,3),
  notes               TEXT,
  created_by          UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_document_versions_doc_number UNIQUE (document_id, version_number)
);

ALTER TABLE documents
  ADD CONSTRAINT fk_documents_current_version
  FOREIGN KEY (current_version_id) REFERENCES document_versions(id) ON DELETE SET NULL;

-- Only one current version per document.
CREATE UNIQUE INDEX IF NOT EXISTS uq_document_versions_one_current
  ON document_versions(document_id) WHERE is_current = true;

CREATE INDEX IF NOT EXISTS idx_document_versions_document_id ON document_versions(document_id);
CREATE INDEX IF NOT EXISTS idx_documents_document_type_id ON documents(document_type_id);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_documents_canonical_name_trgm
  ON documents USING gin (canonical_name gin_trgm_ops);

-- Many-to-many: a document's placement(s) in the Subject hierarchy.
CREATE TABLE IF NOT EXISTS document_subjects (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id         UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  subject_id          UUID NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  relevance           relevance_type NOT NULL DEFAULT 'secondary',
  assigned_by         assigned_by_type NOT NULL DEFAULT 'system',
  confidence_level    confidence_level,
  confidence_score    NUMERIC(4,3),
  assigned_by_user_id UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_document_subjects_doc_subject UNIQUE (document_id, subject_id)
);

-- At most one 'primary' subject per document.
CREATE UNIQUE INDEX IF NOT EXISTS uq_document_subjects_one_primary
  ON document_subjects(document_id) WHERE relevance = 'primary';

CREATE INDEX IF NOT EXISTS idx_document_subjects_subject_id ON document_subjects(subject_id);

CREATE TABLE IF NOT EXISTS document_tags (
  document_id         UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag_id              UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_document_tags_tag_id ON document_tags(tag_id);

-- Related-but-distinct documents (Phase 1 §1.3) — self-join on documents, not files.
CREATE TABLE IF NOT EXISTS related_documents (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id_a       UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  document_id_b       UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  relationship_type   related_doc_relationship NOT NULL DEFAULT 'related',
  confidence_level    confidence_level,
  confidence_score    NUMERIC(4,3),
  created_by          UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_related_documents_distinct CHECK (document_id_a <> document_id_b),
  CONSTRAINT uq_related_documents_pair UNIQUE (document_id_a, document_id_b, relationship_type)
);

CREATE INDEX IF NOT EXISTS idx_related_documents_b ON related_documents(document_id_b);
