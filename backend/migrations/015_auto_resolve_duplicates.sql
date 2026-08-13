-- "Auto-resolve duplicates" bulk action -- same job-type-per-operation
-- pattern as bulk_delete/bulk_rename (docs/08-api-contracts.md: repository-
-- wide operations are always a job, never synchronous). See ADD VALUE
-- IF NOT EXISTS safety note in 014_bulk_delete.sql -- same reasoning
-- applies here.
ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'auto_resolve_duplicates';
