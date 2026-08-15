// The Photos workspace.
//
// WHY IT IS NOT JUST THE FILES PAGE WITH A FILTER
//
// A photograph is identified by looking at it. Everything the Files page is
// good at -- filename, extracted text, subject, dates -- is close to useless
// for a picture of a receipt, which typically has a camera-generated name
// like IMG_4821.jpg, no text layer at all, and no date beyond when it was
// copied. The only way to know what it is, is to see it.
//
// So this is a visual surface: it returns what a grid of images needs, orders
// unreviewed items first, and carries the OCR verdict alongside each one. The
// image itself is served by GET /files/:id/preview, which is owner-scoped and
// returns a rasterised image rather than the file's own bytes -- no raw
// filesystem path ever reaches the browser.
const fileRepository = require("../repositories/fileRepository");
const fileOcrRepository = require("../repositories/fileOcrRepository");
const subjectRepository = require("../repositories/subjectRepository");
const ocrEngine = require("./ocr/ocrEngine");
const ocrService = require("./ocr/ocrService");
const pipelineState = require("./pipelineState");
const auditLogRepository = require("../repositories/auditLogRepository");
const { enqueueJob } = require("../queues");
const { parsePagination } = require("../utils/pagination");
const { requireOwner } = require("../repositories/ownership");
const { ValidationError } = require("../validators/validationError");
const fileOrganizeService = require("./fileOrganizeService");
const { JobType, OcrStatus, FileStatus } = require("../models/enums");

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 404;
    this.publicMessage = message;
  }
}

const VALID_STATUSES = new Set(Object.values(OcrStatus));

function parseStatus(value) {
  if (!value) return null;
  if (!VALID_STATUSES.has(value)) {
    throw new ValidationError(
      `Unknown OCR status "${value}". Valid: ${[...VALID_STATUSES].join(", ")}.`
    );
  }
  return value;
}

/**
 * One page of the grid.
 *
 * `previewUrl` is a relative API path, not a filesystem path. That is the
 * whole point of requirement 23: the browser asks the API for the picture and
 * the API decides whether this account may see it. A `file://` path or an
 * absolute disk path in this payload would both leak the machine's layout and
 * be unopenable from any other computer.
 *
 * IT IS RELATIVE TO THE API BASE, NOT TO THE SITE ROOT -- so "/files/x/preview",
 * NOT "/api/files/x/preview". The frontend fetches these through its api
 * client, which prepends API_BASE ("/api") itself. Including the prefix here
 * produced "/api/api/files/x/preview", a 404 on every single image, which the
 * Photos grid rendered as "No preview available" -- indistinguishable from a
 * file it genuinely could not read.
 */
async function list(query = {}, ownerUserId) {
  requireOwner(ownerUserId, "photoService.list");
  const { limit, offset } = parsePagination(query);
  const status = parseStatus(query.status);

  const [rows, total] = await Promise.all([
    fileRepository.listPhotos(ownerUserId, { status, limit, offset }),
    fileRepository.countPhotos(ownerUserId, { status }),
  ]);

  return {
    total,
    limit,
    offset,
    photos: rows.map((row) => ({
      id: row.id,
      filename: row.canonical_filename || row.filename_current,
      originalFilename: row.filename_original,
      extension: row.extension,
      sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
      isImage: row.is_image,
      importedAt: row.imported_at,
      documentDate: row.document_date,
      documentDateSource: row.document_date_source,
      subjectId: row.subject_id,
      subjectName: row.subject_name,
      subjectPath: row.subject_path,
      locationName: row.location_name,
      aiShortTitle: row.ai_short_title,
      ocr: {
        status: row.ocr_status,
        confidence: row.ocr_confidence === null || row.ocr_confidence === undefined
          ? null : Number(row.ocr_confidence),
        pageCount: row.ocr_page_count,
        textLength: row.ocr_text_length || 0,
        error: row.ocr_error,
      },
      state: pipelineState.describe(row),
      reviewed: Boolean(row.user_resolved_at),
      previewUrl: `/files/${row.id}/preview`,
      downloadUrl: `/files/${row.id}/download`,
    })),
  };
}

/**
 * The counts, plus whether OCR can actually run.
 *
 * The engine status is here rather than on a separate endpoint because the
 * page has to be able to say "no OCR engine is installed" instead of showing
 * an empty Completed tab and letting the user conclude OCR simply found
 * nothing. Reporting a capability the deployment does not have is the exact
 * kind of fake functionality this rebuild is meant to eliminate.
 */
async function summary(ownerUserId) {
  requireOwner(ownerUserId, "photoService.summary");
  const [counts, engine] = await Promise.all([
    fileOcrRepository.countByStatus(ownerUserId),
    ocrEngine.detect(),
  ]);

  return {
    counts,
    engine: engine.available
      ? {
          available: true,
          name: "tesseract",
          version: engine.version,
          languages: engine.languages,
          configuredLanguages: ocrEngine.DEFAULT_LANGUAGES,
          missingLanguages: await ocrEngine.missingLanguages(),
          // What OCR will ACTUALLY read with. The UI needs this to tell the
          // truth: Atlas no longer refuses when a requested language is
          // absent, it uses the ones that are present and reports the rest.
          usingLanguages: (await ocrEngine.effectiveLanguages()).usable,
        }
      : { available: false, reason: engine.reason },
  };
}

/** One photo, with its OCR text and somewhere to put it. */
async function detail(fileId, ownerUserId) {
  const file = await fileRepository.findByIdForOwner(fileId, ownerUserId);
  if (!file) throw new NotFoundError("Photo not found.");

  const [ocr, recentDestinations] = await Promise.all([
    fileOcrRepository.findByFileForOwner(fileId, ownerUserId),
    subjectRepository.listRecentlyUsed(ownerUserId, 6),
  ]);

  return {
    file: {
      id: file.id,
      filename: file.canonical_filename || file.filename_current,
      originalFilename: file.filename_original,
      extension: file.extension,
      sizeBytes: file.size_bytes === null ? null : Number(file.size_bytes),
      mimeType: file.mime_type_detected || file.mime_type_declared,
      importedAt: file.imported_at,
      documentDate: file.document_date,
      documentDateSource: file.document_date_source,
      createdAtFs: file.created_at_fs,
      modifiedAtFs: file.modified_at_fs,
      isImage: file.is_image,
      aiShortTitle: file.ai_short_title,
      aiSummary: file.ai_summary,
      placementSource: file.placement_source,
    },
    state: pipelineState.describe(file),
    ocr: ocr
      ? {
          status: ocr.status,
          engine: ocr.engine,
          engineVersion: ocr.engine_version,
          languages: ocr.languages,
          confidence: ocr.confidence === null ? null : Number(ocr.confidence),
          pageCount: ocr.page_count,
          // The whole text, not an excerpt: this is a review surface and the
          // user is deciding whether the machine read it correctly.
          text: ocr.text || "",
          error: ocr.error_message,
          completedAt: ocr.completed_at,
          // Said explicitly so the UI never has to re-derive the policy.
          usableForNaming:
            ocr.status === "completed" &&
            (ocr.confidence === null || Number(ocr.confidence) >= ocrService.NAMING_CONFIDENCE_FLOOR),
          namingConfidenceFloor: ocrService.NAMING_CONFIDENCE_FLOOR,
        }
      : { status: file.ocr_status, text: "", confidence: null },
    recentDestinations: recentDestinations.map((s) => ({
      id: s.id, name: s.name, path: s.materialized_path, depth: s.depth,
    })),
    previewUrl: `/files/${file.id}/preview`,
    downloadUrl: `/files/${file.id}/download`,
  };
}

/**
 * Queue OCR for one file.
 *
 * The manual trigger for exactly the work the pipeline does automatically --
 * same service, same job type, same result row. Refuses up front when no
 * engine is installed rather than queueing a job that is certain to fail, so
 * the user is told what to install instead of watching a job go red.
 */
async function requestOcr(fileId, ownerUserId, { force = false, languages } = {}) {
  const file = await fileRepository.findByIdForOwner(fileId, ownerUserId);
  if (!file) throw new NotFoundError("Photo not found.");

  const engine = await ocrEngine.detect({ force: true });
  if (!engine.available) {
    await fileRepository.setOcrStatus(fileId, OcrStatus.UNAVAILABLE);
    throw new ValidationError(engine.reason);
  }

  await fileRepository.setOcrStatus(fileId, OcrStatus.QUEUED);
  const job = await enqueueJob(
    JobType.OCR,
    { fileId, force: Boolean(force), languages },
    { storageLocationId: file.storage_location_id, createdBy: ownerUserId, ownerUserId }
  );

  await auditLogRepository.record({
    userId: ownerUserId,
    action: "ocr.requested",
    entityType: "file",
    entityId: fileId,
    newState: { processingJobId: job.id, force: Boolean(force) },
    reason: force
      ? "Re-ran OCR on request, discarding the previous reading."
      : "Queued OCR from the Photos workspace.",
  });

  return { queued: true, fileId, jobId: job.id };
}

/**
 * Queue OCR for everything waiting on it.
 *
 * A loop of the same single-file call, deliberately -- same reasoning as bulk
 * filing. There is no batch shortcut that skips the engine check or the audit
 * entry, because a bulk path that behaves differently from the single one is
 * how a safety check ends up applying on one page and not the other.
 */
async function requestOcrForPending(ownerUserId, { limit = 200 } = {}) {
  requireOwner(ownerUserId, "photoService.requestOcrForPending");
  const engine = await ocrEngine.detect({ force: true });
  if (!engine.available) throw new ValidationError(engine.reason);

  const pending = await fileRepository.listPhotos(ownerUserId, {
    status: OcrStatus.PENDING, limit, offset: 0,
  });

  const queued = [];
  const failed = [];
  for (const file of pending) {
    try {
      await requestOcr(file.id, ownerUserId);
      queued.push(file.id);
    } catch (err) {
      failed.push({ fileId: file.id, message: err.publicMessage || err.message });
    }
  }

  return { queued: queued.length, failed, total: pending.length };
}


/**
 * File several photos at once.
 *
 * A loop over the single-file path, deliberately -- same reasoning as
 * fileOrganizeService.moveManyToSubject, which is what this calls. A bulk
 * shortcut that skipped the per-file duplicate check would break the one
 * invariant the whole filing design exists to hold.
 *
 * Photos are the case where bulk filing actually matters: nobody files eighty
 * holiday pictures one at a time.
 */
async function moveMany(fileIds, subjectId, ownerUserId, { confirmDuplicates = false } = {}) {
  requireOwner(ownerUserId, "photoService.moveMany");
  if (!subjectId) throw new ValidationError("Choose a folder to move these into.");

  const result = await fileOrganizeService.moveManyToSubject({
    fileIds, subjectId, ownerUserId,
    source: fileOrganizeService.PlacementSource.USER,
    confirmDuplicates,
  });

  // Photos are resolved by being filed -- that is the whole decision for a
  // picture. Marking them so is what takes them out of the "unreviewed" set.
  for (const fileId of result.moved) {
    await pipelineState.markUserResolved(fileId, "moved").catch(() => {});
  }

  return result;
}

/** Rename one photo, through the same path the Files page uses. */
async function rename(fileId, filename, ownerUserId) {
  const fileService = require("./fileService");
  const result = await fileService.updateFile(fileId, { filename }, ownerUserId);
  await pipelineState.markUserResolved(fileId, "renamed").catch(() => {});
  return result;
}

/**
 * Withdraw photos from the working set.
 *
 * Marks them archived; the files on disk are untouched, exactly as everywhere
 * else in this application. Returns per-file outcomes rather than a bare
 * success, because on a selection of thirty the useful answer is which ones
 * did not go.
 */
async function archiveMany(fileIds, ownerUserId) {
  requireOwner(ownerUserId, "photoService.archiveMany");
  if (!Array.isArray(fileIds) || fileIds.length === 0) {
    throw new ValidationError("Select at least one photo.");
  }

  const owned = await fileRepository.listByIdsForOwner(fileIds, ownerUserId);
  const ownedIds = new Set(owned.map((f) => f.id));
  const archived = [];
  const notFound = [];

  for (const fileId of fileIds) {
    if (!ownedIds.has(fileId)) { notFound.push(fileId); continue; }
    await fileRepository.updateStatus(fileId, FileStatus.ARCHIVED);
    await pipelineState.markUserResolved(fileId, "archived", { state: pipelineState.State.ARCHIVED });
    archived.push(fileId);
  }

  await auditLogRepository.record({
    userId: ownerUserId,
    action: "photo.archived_bulk",
    entityType: "file",
    entityId: null,
    newState: { requested: fileIds.length, archived: archived.length },
    reason: "Archived from the Photos workspace. The files on disk are untouched.",
  });

  return { archived: archived.length, notFound };
}

module.exports = {
  NotFoundError, list, summary, detail, requestOcr, requestOcrForPending,
  moveMany, rename, archiveMany,
};
