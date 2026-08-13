-- Phase 5: physical file identity, hashes, extracted metadata/content
-- (see docs/01-domain-model.md: File vs Document vs Metadata)

CREATE TABLE IF NOT EXISTS files (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_location_id   UUID NOT NULL REFERENCES storage_locations(id) ON DELETE RESTRICT,

  filename_original     TEXT NOT NULL,      -- immutable historical fact
  filename_current      TEXT NOT NULL,      -- current on-disk name (may equal canonical after rename)
  extension             TEXT,
  mime_type_declared    TEXT,               -- from OS / upload
  mime_type_detected    TEXT,               -- from signature/content inspection

  size_bytes            BIGINT NOT NULL,
  original_path         TEXT NOT NULL,      -- path at ingestion time
  current_path          TEXT NOT NULL,      -- authoritative current path

  created_at_fs         TIMESTAMPTZ,        -- filesystem ctime
  modified_at_fs        TIMESTAMPTZ,        -- filesystem mtime
  imported_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_scanned_at       TIMESTAMPTZ,

  status                file_status NOT NULL DEFAULT 'active',
  processing_status     processing_status NOT NULL DEFAULT 'pending',

  sha256_hash           CHAR(64),           -- denormalized primary hash for fast lookup

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_files_location_path UNIQUE (storage_location_id, current_path)
);

CREATE INDEX IF NOT EXISTS idx_files_storage_location_id ON files(storage_location_id);
CREATE INDEX IF NOT EXISTS idx_files_sha256_hash ON files(sha256_hash);
CREATE INDEX IF NOT EXISTS idx_files_status ON files(status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_files_processing_status ON files(processing_status)
  WHERE processing_status IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS idx_files_filename_trgm
  ON files USING gin (filename_original gin_trgm_ops);

-- A file can have several hash algorithms recorded (sha256 for identity,
-- perceptual/fuzzy hashes later for probable-duplicate detection).
CREATE TABLE IF NOT EXISTS file_hashes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id       UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  algorithm     TEXT NOT NULL,          -- 'sha256', 'simhash', 'phash', ...
  hash_value    TEXT NOT NULL,
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_file_hashes_file_algorithm UNIQUE (file_id, algorithm)
);

CREATE INDEX IF NOT EXISTS idx_file_hashes_algorithm_value ON file_hashes(algorithm, hash_value);

-- Format-specific structured metadata (workbook sheet names, PDF doc info,
-- pptx slide count, pbix model summary, ...). One row per file; shape varies
-- by format, hence jsonb rather than dozens of nullable columns.
CREATE TABLE IF NOT EXISTS file_metadata (
  file_id             UUID PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  extractor           TEXT NOT NULL,          -- 'pdf', 'xlsx', 'pptx', 'pbix', ...
  extractor_version   TEXT,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  extraction_status   processing_status NOT NULL DEFAULT 'pending',
  extraction_error    TEXT,
  extracted_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_file_metadata_gin ON file_metadata USING gin (metadata);

-- Extracted full text, kept separate from structured metadata because it can
-- be large and is only ever used for search, never joined into normal reads.
CREATE TABLE IF NOT EXISTS file_content (
  file_id             UUID PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  extracted_text       TEXT,
  extraction_status    processing_status NOT NULL DEFAULT 'pending',
  extraction_error     TEXT,
  extracted_at         TIMESTAMPTZ,
  search_vector         TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(extracted_text, ''))
  ) STORED
);

CREATE INDEX IF NOT EXISTS idx_file_content_search_vector
  ON file_content USING gin (search_vector);
