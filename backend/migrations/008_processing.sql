-- Phase 5: background job tracking + filesystem reconciliation
-- (see docs/04-storage-architecture.md §4.6; jobs implemented in Phase 7)

CREATE TABLE IF NOT EXISTS processing_jobs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type            job_type NOT NULL,
  status              job_status NOT NULL DEFAULT 'queued',
  storage_location_id UUID REFERENCES storage_locations(id) ON DELETE SET NULL,
  payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
  result              JSONB,
  error_message       TEXT,
  progress_total      INTEGER NOT NULL DEFAULT 0,
  progress_current     INTEGER NOT NULL DEFAULT 0,
  bullmq_job_id        TEXT,
  created_by            UUID REFERENCES users(id),
  started_at            TIMESTAMPTZ,
  finished_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_processing_jobs_status ON processing_jobs(status)
  WHERE status IN ('queued', 'running', 'retrying');
CREATE INDEX IF NOT EXISTS idx_processing_jobs_job_type ON processing_jobs(job_type);
CREATE INDEX IF NOT EXISTS idx_processing_jobs_payload_gin ON processing_jobs USING gin (payload);

-- Per-file outcome within a bulk job (spec §22: "96 high-confidence, 3 review, 1 unable").
CREATE TABLE IF NOT EXISTS processing_job_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id              UUID NOT NULL REFERENCES processing_jobs(id) ON DELETE CASCADE,
  file_id             UUID REFERENCES files(id) ON DELETE SET NULL,
  status              job_item_status NOT NULL DEFAULT 'pending',
  error_message       TEXT,
  result              JSONB,
  processed_at        TIMESTAMPTZ,
  CONSTRAINT uq_processing_job_items_job_file UNIQUE (job_id, file_id)
);

CREATE INDEX IF NOT EXISTS idx_processing_job_items_job_id ON processing_job_items(job_id);
CREATE INDEX IF NOT EXISTS idx_processing_job_items_file_id ON processing_job_items(file_id);

-- Summary of one reconciliation pass over a storage location.
CREATE TABLE IF NOT EXISTS filesystem_scans (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_location_id UUID NOT NULL REFERENCES storage_locations(id) ON DELETE CASCADE,
  job_id              UUID REFERENCES processing_jobs(id) ON DELETE SET NULL,
  status              job_status NOT NULL DEFAULT 'queued',
  files_discovered    INTEGER NOT NULL DEFAULT 0,
  files_new           INTEGER NOT NULL DEFAULT 0,
  files_missing       INTEGER NOT NULL DEFAULT 0,
  files_moved         INTEGER NOT NULL DEFAULT 0,
  files_changed       INTEGER NOT NULL DEFAULT 0,
  started_at          TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_filesystem_scans_storage_location_id
  ON filesystem_scans(storage_location_id);
