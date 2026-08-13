-- Phase 5: rename proposals + classification results (see docs/03-taxonomy.md §3.6-3.7)

CREATE TABLE IF NOT EXISTS rename_proposals (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id             UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  current_filename    TEXT NOT NULL,
  proposed_filename   TEXT NOT NULL,
  reason              TEXT,
  metadata_used       JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence_level    confidence_level NOT NULL,
  confidence_score    NUMERIC(4,3),
  status              proposal_status NOT NULL DEFAULT 'pending',
  reviewed_by         UUID REFERENCES users(id),
  reviewed_at         TIMESTAMPTZ,
  applied_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rename_proposals_file_id ON rename_proposals(file_id);
CREATE INDEX IF NOT EXISTS idx_rename_proposals_status ON rename_proposals(status)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS classification_results (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id                   UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  classified_subject_id     UUID REFERENCES subjects(id),
  classified_document_type_id UUID REFERENCES document_types(id),
  confidence_level          confidence_level NOT NULL,
  confidence_score          NUMERIC(4,3),
  method                    classification_method NOT NULL,
  status                    classification_status NOT NULL DEFAULT 'proposed',
  raw_output                JSONB,
  reviewed_by               UUID REFERENCES users(id),
  reviewed_at                TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_classification_results_file_id ON classification_results(file_id);
CREATE INDEX IF NOT EXISTS idx_classification_results_status ON classification_results(status)
  WHERE status = 'proposed';
