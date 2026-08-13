// Discovery + Ingestion + Reconciliation (docs/06-processing-pipeline.md §6.1,
// docs/04-storage-architecture.md §4.6). Walks a Storage Location
// incrementally (never loads the full tree into memory -- spec §6/§30),
// creates File rows for anything new, and marks previously-active Files that
// went missing since the last scan.
const path = require("path");
const db = require("../../config/database");
const storageLocationRepository = require("../../repositories/storageLocationRepository");
const fileRepository = require("../../repositories/fileRepository");
const filesystemScanRepository = require("../../repositories/filesystemScanRepository");
const auditLogRepository = require("../../repositories/auditLogRepository");
const { getStorageServiceFor } = require("../../services/storage/storageService");
const { enqueueJob } = require("../../queues");
const { JobType } = require("../../models/enums");

async function handle({ storageLocationId }) {
  const storageLocation = await storageLocationRepository.findById(storageLocationId);
  if (!storageLocation) throw new Error(`Storage location ${storageLocationId} not found`);

  // ONE SCAN PER LOCATION AT A TIME.
  //
  // Nothing used to enforce this. storageWatcher enqueues a rescan for every
  // watched location on a timer (hourly by default) with no check for one
  // already queued or running, and filesystem events enqueue more on top; the
  // scan queue runs four wide. A scan of ~9,400 files takes minutes and can
  // exceed the rescan interval, so sweeps stacked.
  //
  // Two scans over one tree is not merely wasteful, it is wrong. Scan A's
  // reconciliation pass asks "which active files did I not touch?" and marks
  // the answer `missing` -- while scan B is concurrently touching them. Live
  // files got flagged missing and audit-logged as such, purely from overlap.
  //
  // A session-level advisory lock is the right shape here: it is held for the
  // life of this job, released automatically if the worker dies (no stale
  // lock to clean up), and costs one round trip. Losing the race is a normal
  // outcome, not an error -- the scan already running will cover the same
  // ground, so this one reports that it stood down and exits cleanly rather
  // than failing and being retried into the same contention.
  const lock = await acquireScanLock(storageLocationId);
  if (!lock.acquired) {
    return { skipped: true, reason: "a scan of this storage location is already running" };
  }

  const storageService = getStorageServiceFor(storageLocation);
  const scanRow = await filesystemScanRepository.create({ storageLocationId });
  const scanStartedAt = new Date();

  const counts = { discovered: 0, new: 0, missing: 0, moved: 0, changed: 0, recovered: 0 };

  try {
    for await (const entry of storageService.listDirectory()) {
      counts.discovered += 1;
      const relativePath = path.relative(storageService.rootPath, entry.path);
      const existing = await fileRepository.findByLocationAndPath(storageLocationId, relativePath);

      if (!existing) {
        const created = await fileRepository.create({
          storageLocationId,
          filenameOriginal: entry.name,
          filenameCurrent: entry.name,
          extension: path.extname(entry.name).replace(/^\./, ""),
          mimeTypeDeclared: null,
          mimeTypeDetected: null,
          sizeBytes: entry.size,
          originalPath: relativePath,
          currentPath: relativePath,
          createdAtFs: entry.ctime,
          modifiedAtFs: entry.mtime,
          sha256Hash: null,
        });
        await fileRepository.markScanned(created.id);
        counts.new += 1;

        await auditLogRepository.record({
          action: "file.imported",
          entityType: "file",
          entityId: created.id,
          newState: { path: relativePath, sizeBytes: entry.size },
          reason: "Discovered during repository scan",
        });

        await enqueueJob(JobType.HASH, { fileId: created.id }, { storageLocationId });
      } else {
        const sizeChanged = Number(existing.size_bytes) !== entry.size;
        const mtimeChanged =
          existing.modified_at_fs && new Date(existing.modified_at_fs).getTime() !== entry.mtime.getTime();

        if (sizeChanged || mtimeChanged) {
          await fileRepository.updateStatus(existing.id, "changed");
          counts.changed += 1;
          await enqueueJob(JobType.HASH, { fileId: existing.id }, { storageLocationId });
        } else if (existing.status !== "active") {
          await fileRepository.updateStatus(existing.id, "active");
        }
        await fileRepository.markScanned(existing.id);
      }
    }

    const staleFiles = await fileRepository.listStaleActive(storageLocationId, scanStartedAt);
    for (const stale of staleFiles) {
      await fileRepository.updateStatus(stale.id, "missing");
      counts.missing += 1;
      await auditLogRepository.record({
        action: "file.missing",
        entityType: "file",
        entityId: stale.id,
        previousState: { status: "active" },
        newState: { status: "missing" },
        reason: "Not found during repository scan",
      });
    }

    // Reconciliation, second half: files that ARE still on disk but never
    // finished processing. The loop above deliberately does nothing for a
    // known file whose size and mtime are unchanged -- which is correct for
    // deciding whether to re-read it, and is exactly why work lost from the
    // queue (power cut, Redis restart, killed worker) was never retried.
    // Without this the file stays in the list forever, unhashed and
    // unsearchable, and says nothing about it.
    const unprocessed = await fileRepository.listUnprocessed(storageLocationId, scanStartedAt);
    for (const file of unprocessed) {
      // Always restart from hashing: it is the head of the chain and fans
      // out to metadata, text, and duplicate detection, so one job repairs
      // a file no matter which stage it was lost at.
      await enqueueJob(JobType.HASH, { fileId: file.id }, { storageLocationId });
      counts.recovered += 1;
    }
    if (unprocessed.length > 0) {
      await auditLogRepository.record({
        action: "scan.recovered_unprocessed",
        entityType: "storage_location",
        entityId: storageLocationId,
        newState: { count: unprocessed.length, fileIds: unprocessed.slice(0, 50).map((f) => f.id) },
        reason:
          `${unprocessed.length} file(s) had been discovered but never finished processing ` +
          "(most likely queued work lost to a restart or crash). Re-queued from the hashing stage.",
      });
    }

    await filesystemScanRepository.complete(scanRow.id, counts);
    return { scanId: scanRow.id, ...counts };
  } catch (err) {
    await filesystemScanRepository.fail(scanRow.id);
    throw err;
  } finally {
    await lock.release();
  }
}

/**
 * A Postgres session-level advisory lock, scoped to one storage location.
 *
 * Held on a dedicated pool client so it survives every query this job makes
 * on other connections, and released in `finally`. If the worker process dies
 * outright the session ends with it and Postgres drops the lock, which is the
 * property that makes advisory locks preferable to a `scanning` flag on a
 * row: there is no such thing as a stale one.
 *
 * hashtext() maps the uuid to the int4 pg_advisory_lock takes. Collisions
 * across different locations are possible in principle and harmless in
 * practice -- the cost of one is that two unrelated scans serialise.
 */
async function acquireScanLock(storageLocationId) {
  const client = await db.pool.connect();
  try {
    const { rows } = await client.query(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
      [`atlas:scan:${storageLocationId}`]
    );
    if (!rows[0].acquired) {
      client.release();
      return { acquired: false, release: async () => {} };
    }
    return {
      acquired: true,
      release: async () => {
        try {
          await client.query("SELECT pg_advisory_unlock(hashtext($1))", [`atlas:scan:${storageLocationId}`]);
        } finally {
          client.release();
        }
      },
    };
  } catch (err) {
    client.release();
    throw err;
  }
}

module.exports = { handle };
