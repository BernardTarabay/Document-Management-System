-- The `describe` stage.
--
-- Alone in its own migration for the reason migration 031 already had to
-- learn: Postgres will not let a value added to an enum be USED in the same
-- transaction that added it, and the migration runner wraps each file in one
-- transaction. So this has to commit before 035 and describeProcessor can
-- reference it.
--
--   describe   produce one plain-language description of what a file IS, from
--              whatever evidence that particular file offers -- its text, its
--              OCR, its picture, its video or audio, or failing all of those,
--              the facts around it. See services/descriptionService.js.

ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'describe';
