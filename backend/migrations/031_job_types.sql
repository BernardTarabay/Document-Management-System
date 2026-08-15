-- New job types.
--
-- Alone in its own migration on purpose. Postgres will not let a value added
-- to an enum be USED in the same transaction that added it, and the migration
-- runner wraps each file in one transaction -- so the ALTERs have to commit
-- here before 032 and the processors can reference them.
--
--   ocr        real optical character recognition for scans and photographs
--              (previously only DETECTED as needed and then abandoned)
--   replicate  pull one file's bytes into server-side managed storage so it
--              opens from any device
--   bulk_move  file several documents under a subject in one reviewed action.
--              The value has existed in the enum since migration 001 and was
--              never implemented; it is implemented now, so this is a no-op
--              kept only so the list here reads as the complete set.

ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'ocr';
ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'replicate';
ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'bulk_move';
