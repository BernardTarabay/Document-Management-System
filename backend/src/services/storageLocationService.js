const path = require("path");
const storageLocationRepository = require("../repositories/storageLocationRepository");
const fileRepository = require("../repositories/fileRepository");
const auditLogRepository = require("../repositories/auditLogRepository");
const filesystemScanRepository = require("../repositories/filesystemScanRepository");
const { enqueueJob } = require("../queues");
const { ValidationError } = require("../validators/validationError");
const { JobType } = require("../models/enums");

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 404;
    this.publicMessage = message;
  }
}

/**
 * Enriches each location with its most recent scan (status/when/counts) so
 * the Storage Locations page can show "last scanned" without a separate
 * request per card.
 */
async function list() {
  const locations = await storageLocationRepository.listActive();
  const [latestScans, backlog] = await Promise.all([
    filesystemScanRepository.findLatestForLocations(locations.map((l) => l.id)),
    fileRepository.countBacklogByLocation(),
  ]);
  return locations.map((loc) => attachLastScan(loc, latestScans[loc.id], backlog[loc.id]));
}

function attachLastScan(location, scan, backlog) {
  // Always present, even at zero -- "0 waiting" is information, whereas a
  // missing field renders as nothing and is indistinguishable from a broken
  // count.
  const processing = { inFlight: backlog?.inFlight || 0, stalled: backlog?.stalled || 0 };
  if (!scan) return { ...location, last_scan: null, processing };
  return {
    ...location,
    processing,
    last_scan: {
      status: scan.status,
      startedAt: scan.started_at,
      finishedAt: scan.finished_at,
      filesDiscovered: scan.files_discovered,
      filesNew: scan.files_new,
      filesRecovered: scan.files_recovered,
    },
  };
}

async function getById(id) {
  const location = await storageLocationRepository.findById(id);
  if (!location) throw new NotFoundError("Storage location not found.");
  return location;
}

/**
 * Windows' Explorer "Copy as path" wraps the result in literal double quotes
 * (e.g. `"C:\Users\me\Desktop\docs"`), and it's an easy paste to not notice.
 * A quoted string doesn't look absolute to Node's path resolver, so it was
 * silently getting treated as relative and joined onto the backend's cwd --
 * that's what produced the ENOENT in the scan worker. Strip a single layer
 * of wrapping quotes and trim whitespace before it ever reaches the DB.
 */
function normalizeRootPath(rootPath) {
  const trimmed = String(rootPath).trim();
  const unquoted = /^"(.*)"$/.test(trimmed) || /^'(.*)'$/.test(trimmed)
    ? trimmed.slice(1, -1).trim()
    : trimmed;
  // Resolve to a canonical absolute form so the same folder registered as
  // "C:\Docs", "C:\Docs\" and "C:\Docs\Finance\.." all compare equal --
  // otherwise the duplicate-location check below is trivially defeated by a
  // trailing slash.
  return path.resolve(unquoted);
}

/**
 * Register a Storage Location -- or re-activate the one already registered
 * for this folder.
 *
 * Re-registering matters because `remove()` only deactivates (see its own
 * note on why a hard delete isn't offered). Without this check, removing a
 * folder and adding it back produced a SECOND location row for the same
 * directory; `scanProcessor` looks up existing files by
 * (storage_location_id, current_path), found nothing under the new id, and
 * ingested every file a second time. Four files became eight, each pair a
 * duplicate of the other -- with the older copies still carrying all the
 * classification, AI titles and rename history.
 *
 * Reusing the row instead means the scan reconciles against the files it
 * already knows about, which is exactly what the reconciliation design in
 * docs/04 §4.6 is for: a file that went missing and came back becomes
 * 'active' again rather than becoming a new File with a new identity.
 */
async function create(
  { name, type, rootPath, accessMode = "direct", config = {}, isReadOnly = true },
  actorUserId
) {
  if (!name || !type || !rootPath) {
    throw new ValidationError("name, type, and rootPath are required.");
  }
  rootPath = normalizeRootPath(rootPath);

  const existing = await storageLocationRepository.findByRootPath(rootPath);
  if (existing) {
    if (existing.is_active) {
      throw new ValidationError(
        `That folder is already registered as "${existing.name}". ` +
        "Scan it again instead of adding it a second time."
      );
    }

    const reactivated = await storageLocationRepository.reactivate(existing.id, {
      name, type, accessMode, config,
    });

    await auditLogRepository.record({
      userId: actorUserId,
      action: "storage_location.reactivated",
      entityType: "storage_location",
      entityId: existing.id,
      previousState: { isActive: false, name: existing.name },
      newState: { isActive: true, name, type, rootPath, accessMode },
      reason:
        "This folder was previously registered and removed; reusing the existing " +
        "location so its already-ingested files keep their identity and history " +
        "instead of being re-ingested as duplicates.",
    });

    return reactivated;
  }

  const location = await storageLocationRepository.create({
    name, type, rootPath, accessMode, config, isReadOnly,
  });

  await auditLogRepository.record({
    userId: actorUserId,
    action: "storage_location.created",
    entityType: "storage_location",
    entityId: location.id,
    newState: { name, type, rootPath, accessMode, isReadOnly },
    reason: isReadOnly
      ? "Registered read-only: files here are indexed and named, but never renamed or moved on disk."
      : "Registered writable: approved renames will be applied to the files themselves.",
  });

  return location;
}

/**
 * Flip a location between read-only and writable.
 *
 * Turning read-only OFF is the consequential direction -- it grants this
 * app permission to rename and move somebody's real files -- so it is
 * audited with the reason spelled out rather than recorded as a bare field
 * change.
 */
async function setReadOnly(id, isReadOnly, actorUserId) {
  const location = await getById(id);
  const updated = await storageLocationRepository.setReadOnly(id, Boolean(isReadOnly));

  await auditLogRepository.record({
    userId: actorUserId,
    action: "storage_location.read_only_changed",
    entityType: "storage_location",
    entityId: id,
    previousState: { isReadOnly: location.is_read_only },
    newState: { isReadOnly: Boolean(isReadOnly) },
    reason: isReadOnly
      ? "Set read-only: approved renames will no longer touch files in this location."
      : "Set writable: approved renames will now rename and move the actual files on disk.",
  });

  return updated;
}

/**
 * Kicks off Discovery + Ingestion (docs/06-processing-pipeline.md) as a job,
 * never synchronously -- an HTTP request must never block on walking a
 * potentially huge directory tree (spec §18/§30).
 */
async function triggerScan(storageLocationId, actorUserId) {
  const location = await getById(storageLocationId);
  if (!location.is_active) {
    throw new ValidationError(
      `"${location.name}" has been removed. Add the folder again to re-activate it before scanning.`
    );
  }

  const job = await enqueueJob(
    JobType.SCAN,
    { storageLocationId },
    { storageLocationId, createdBy: actorUserId }
  );

  await auditLogRepository.record({
    userId: actorUserId,
    action: "scan.started",
    entityType: "storage_location",
    entityId: storageLocationId,
    newState: { processingJobId: job.id },
  });

  return job;
}

/**
 * Deactivates a Storage Location (the "x" remove action). Files already
 * ingested from it are untouched and stay browsable/searchable -- this
 * only stops it from being scanned again and hides it from the active
 * list. (A true hard delete isn't offered: ON DELETE RESTRICT on
 * files.storage_location_id would just make it fail anyway once anything's
 * been ingested, and silently cascading file deletes on top of real
 * filesystem content is exactly the kind of destructive default this
 * project's schema was deliberately designed to avoid.)
 */
async function remove(id, actorUserId) {
  const location = await getById(id);

  const updated = await storageLocationRepository.deactivate(id);

  await auditLogRepository.record({
    userId: actorUserId,
    action: "storage_location.removed",
    entityType: "storage_location",
    entityId: id,
    previousState: { isActive: true, name: location.name },
    newState: { isActive: false },
    reason: "Removed from the Storage Locations page",
  });

  return updated;
}

module.exports = {
  NotFoundError, list, getById, create, triggerScan, remove, setReadOnly,
  // Exported for tests: this is the function that decides whether two
  // spellings of a path are the same folder, which is what stops a re-add
  // from creating a second location.
  normalizeRootPath,
};
