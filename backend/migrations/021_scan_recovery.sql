-- Records how many already-discovered files a scan had to re-queue because
-- they were never finished.
--
-- This is the visible half of the self-healing scan (see
-- fileRepository.listUnprocessed). A non-zero number here means work was
-- lost from the queue -- a power cut mid-import, a Redis restart, a killed
-- worker -- and the scan picked it back up. Persisting it per scan is what
-- makes that recovery auditable instead of invisible: "the last scan
-- recovered 412 files" is a fact worth seeing on the Storage Locations page,
-- and a number that keeps climbing every scan is a symptom worth chasing.

ALTER TABLE filesystem_scans
  ADD COLUMN IF NOT EXISTS files_recovered INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN filesystem_scans.files_recovered IS
  'Files already known to this location that had no hash or no extracted content and were re-queued by this scan.';

-- Supports the NOT EXISTS anti-join in fileRepository.listUnprocessed, which
-- checks whether a file already has a job in flight before re-queueing it.
-- Without this the check is a sequential scan of processing_jobs once per
-- scan, and that table grows by roughly four rows per file ingested.
CREATE INDEX IF NOT EXISTS idx_processing_jobs_active_file
  ON processing_jobs ((payload->>'fileId'))
  WHERE status IN ('queued', 'running');
