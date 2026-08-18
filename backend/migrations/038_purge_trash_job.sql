-- The scheduled job that empties the Trash.
--
-- A job_type rather than a bare interval, so an automatic purge and a manual
-- one are the same thing to everything downstream: it appears on the Processing
-- Jobs page, it is audit-logged, and it goes through enqueueJob like every
-- other unit of work (see queues/index.js -- "a job is always a processing_jobs
-- row"). A scheduler that quietly deleted rows outside that machinery would be
-- the one destructive operation with no record of having run.
ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'purge_trash';
