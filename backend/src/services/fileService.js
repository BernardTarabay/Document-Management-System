const path = require("path");
const { execFile } = require("child_process");
const fileRepository = require("../repositories/fileRepository");
const fileMetadataRepository = require("../repositories/fileMetadataRepository");
const fileContentRepository = require("../repositories/fileContentRepository");
const classificationResultRepository = require("../repositories/classificationResultRepository");
const duplicateGroupRepository = require("../repositories/duplicateGroupRepository");
const storageLocationRepository = require("../repositories/storageLocationRepository");
const renameProposalRepository = require("../repositories/renameProposalRepository");
const subjectRepository = require("../repositories/subjectRepository");
const documentTypeRepository = require("../repositories/documentTypeRepository");
const auditLogRepository = require("../repositories/auditLogRepository");
const { getStorageServiceFor } = require("./storage/storageService");
const { parseFileFilters } = require("../repositories/fileFilters");
const { renameToAvailableName } = require("../utils/resolveAvailableFilename");
const { assertSafeFilename } = require("../utils/filenameSafety");
const { resolveWithinRoot } = require("../utils/pathSafety");
const { parsePagination } = require("../utils/pagination");
const { ValidationError } = require("../validators/validationError");
const { FileStatus, JobType, ClassificationMethod, ConfidenceLevel } = require("../models/enums");
const { enqueueJob } = require("../queues");
const mime = require("../utils/mimeGuess");
const thumbnailService = require("./preview/thumbnailService");
const similarity = require("./similarityService");
const fileOrganizeService = require("./fileOrganizeService");

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 404;
    this.publicMessage = message;
  }
}

/**
 * WHAT "LOCATION" MEANS IN THESE FILTERS
 *
 * Storage location and folder path -- which registered folder the file was
 * found in, and where under it -- NOT EXIF GPS coordinates. Both readings
 * were on the table; this one was chosen because GPS is present on phone
 * photos and essentially absent from scanned documents, so a GPS filter over
 * this corpus would be a control that matches nothing. If geotagged photos
 * ever matter here, that is a second, separate filter rather than a
 * reinterpretation of this one.
 */
async function search(query, ownerUserId) {
  const { limit, offset } = parsePagination(query);
  const filters = parseFileFilters(query, ownerUserId);

  // Search matches file CONTENT as well as names. This used to be
  // filename-only, which made the search box nearly useless for the thing
  // it exists to do -- nobody remembers what a badly-named file was called,
  // they remember what was in it. `mode=filename` keeps the old behaviour
  // for callers that specifically want a name lookup.
  if (query.q) {
    return query.mode === "filename"
      ? fileRepository.searchByFilename(query.q, ownerUserId, { limit, offset })
      : fileRepository.searchEverything(query.q, { limit, offset, filters });
  }
  if (query.status) return fileRepository.listByStatus(query.status, ownerUserId, { limit, offset });
  // Default view -- excludes 'deleted' so removed files (single or bulk)
  // actually disappear instead of lingering with a "deleted" badge. See
  // fileRepository.listNotDeleted for why this isn't the generic list().
  return fileRepository.listNotDeleted({ limit, offset, filters });
}

/**
 * How many files match, repository-wide.
 *
 * Separate from search() rather than folded into its response because the
 * list endpoint returns a bare array that four different callers already
 * consume (the Files page, the Subjects page, the compare picker, the
 * assistant's page context). Changing that shape to attach one number would
 * break all of them; one extra cheap request does not.
 *
 * Counting a full-text search is deliberately NOT supported: ranking is the
 * expensive half of searchEverything, and running it a second time only to
 * discard the rows would double the cost of every keystroke. With a search
 * term the honest thing to report is the page you are on.
 */
async function count(query, ownerUserId) {
  const filters = parseFileFilters(query, ownerUserId);
  if (query.q) {
    throw new ValidationError(
      "Counting is only available without a search term -- narrow with filters, or page through the results."
    );
  }
  return { count: await fileRepository.countMatching({ filters }) };
}

/** The values actually present to filter by -- see fileRepository.filterFacets. */
async function filterOptions(ownerUserId) {
  const [facets, locations] = await Promise.all([
    fileRepository.filterFacets(ownerUserId),
    storageLocationRepository.listActive(ownerUserId),
  ]);

  return {
    extensions: facets.extensions,
    dateRange: {
      earliest: facets.dateRange.earliest,
      latest: facets.dateRange.latest,
      // Surfaced because it is the surprising part of a date filter: a file
      // with no known date matches no range, so the UI can say how many
      // files a date filter will hide before the user wonders where they
      // went.
      undated: facets.dateRange.undated,
    },
    locations: locations.map((l) => ({
      id: l.id,
      name: l.name,
      rootPath: l.root_path,
      isReadOnly: l.is_read_only,
    })),
  };
}

/**
 * Aggregates everything the pipeline learned about a File into one response
 * -- metadata, extracted-text length (not the full text; that's what search
 * is for), latest classification, and duplicate-group membership -- so the
 * frontend never has to make five separate requests for one detail view.
 */
async function getFileDetail(fileId, ownerUserId) {
  const file = await fileRepository.findByIdForOwner(fileId, ownerUserId);
  if (!file) throw new NotFoundError("File not found.");

  const [metadata, content, classifications, duplicateGroups] = await Promise.all([
    fileMetadataRepository.findByFile(fileId),
    fileContentRepository.findByFile(fileId),
    classificationResultRepository.listProposedForFile(fileId),
    duplicateGroupRepository.findGroupContainingFile(fileId),
  ]);

  return {
    ...file,
    metadata: metadata ? { extractor: metadata.extractor, extractionStatus: metadata.extraction_status, data: metadata.metadata } : null,
    content: content
      ? {
          extractionStatus: content.extraction_status,
          textLength: (content.extracted_text || "").length,
          // Short excerpt (not the full text -- that's what search is for)
          // so the Preview panel has something to show for file types that
          // can't be rendered inline (docx/xlsx/pptx/etc.) without needing
          // a whole separate document-conversion pipeline.
          excerpt: (content.extracted_text || "").slice(0, 1500),
        }
      : null,
    latestClassification: classifications[0] || null,
    duplicateGroups,
  };
}

async function getDownloadStream(fileId, ownerUserId) {
  const file = await fileRepository.findByIdForOwner(fileId, ownerUserId);
  if (!file) throw new NotFoundError("File not found.");
  if (file.status !== "active") throw new NotFoundError("File is not currently active on disk.");

  const storageLocation = await storageLocationRepository.findById(file.storage_location_id);
  const storageService = getStorageServiceFor(storageLocation);

  return { file, stream: storageService.readStream(file.current_path) };
}

/**
 * A rendered picture of the file's first page -- for real images, that's
 * just the image itself; for everything else (docx/xlsx/pptx/pdf/legacy
 * office/txt/csv/svg/etc.) it's a PNG rasterized by LibreOffice, cached on
 * disk after the first request. Never returns the file's own raw bytes for
 * non-image formats, so this is safe to serve inline (Content-Disposition:
 * inline) regardless of what the underlying file actually contains -- an
 * uploaded SVG or HTML-disguised-as-something-else can't execute anything,
 * because what comes back is always a flat raster image.
 */
async function getPreviewImage(fileId, ownerUserId) {
  const file = await fileRepository.findByIdForOwner(fileId, ownerUserId);
  if (!file) throw new NotFoundError("File not found.");
  if (file.status !== "active") throw new NotFoundError("File is not currently active on disk.");

  const mimeType = mime.guessMimeType(file.extension, file.mime_type_detected);
  const storageLocation = await storageLocationRepository.findById(file.storage_location_id);
  const storageService = getStorageServiceFor(storageLocation);

  const { buffer, contentType } = await thumbnailService.getThumbnail(file, mimeType, storageService);
  return { file, contentType, buffer };
}

async function recordDownloadAudit(fileId, userId) {
  await auditLogRepository.record({
    userId,
    action: "file.downloaded",
    entityType: "file",
    entityId: fileId,
  });
}

/**
 * Soft-removes a File from the working set (status -> 'deleted'; the row
 * and its history are kept, per the "history is additive, not destructive"
 * schema philosophy -- docs/05-database-schema.md). Also cancels any
 * still-pending rename proposal for it, so a removed file doesn't leave a
 * stray pending proposal behind, and so a rejected proposal is on record
 * if the exact same content is ever re-ingested (see
 * generateNamesProcessor's rejected-match check).
 */
async function removeFile(fileId, actorUserId) {
  const file = await fileRepository.findByIdForOwner(fileId, actorUserId);
  if (!file) throw new NotFoundError("File not found.");

  await fileRepository.updateStatus(fileId, FileStatus.DELETED);
  const cancelledProposalIds = await renameProposalRepository.cancelPendingForFile(fileId, actorUserId);

  await auditLogRepository.record({
    userId: actorUserId,
    action: "file.removed",
    entityType: "file",
    entityId: fileId,
    previousState: { status: file.status },
    newState: { status: FileStatus.DELETED },
    reason: "Removed from the Files page",
  });

  return { removed: true, fileId, cancelledProposalIds };
}


/**
 * Compare two files on demand and report how similar their extracted text
 * is, using the same engine that drives probable-duplicate detection
 * (services/similarityService.js).
 *
 * This exists because the automatic detector only ever compares a bounded
 * candidate pool (same extension, most recent 300 -- see
 * fileRepository.listSimilarityCandidates), so a user who suspects two
 * specific files are near-copies has no way to ask. This answers exactly
 * that question, for any two files, with no such filtering.
 *
 * It is read-only: it never creates a duplicate group. The verdict tells
 * the user how the automatic detector WOULD have scored the pair, which is
 * the useful thing to know, without making a claim in the database that
 * nobody reviewed.
 */
async function compareFiles(fileIdA, fileIdB, ownerUserId) {
  if (!fileIdA || !fileIdB) throw new ValidationError("Two file ids are required.");
  if (fileIdA === fileIdB) throw new ValidationError("Pick two different files to compare.");

  // BOTH sides are owner-scoped. Comparing is read-only, but it reports word
  // counts, hashes and a similarity score -- enough to confirm whether a
  // stranger holds a document you already have, which is exactly the
  // inference an isolated archive must not leak.
  const [a, b] = await Promise.all([
    fileRepository.findByIdForOwner(fileIdA, ownerUserId),
    fileRepository.findByIdForOwner(fileIdB, ownerUserId),
  ]);
  if (!a) throw new NotFoundError("The first file was not found.");
  if (!b) throw new NotFoundError("The second file was not found.");

  const [contentA, contentB] = await Promise.all([
    fileContentRepository.findByFile(a.id),
    fileContentRepository.findByFile(b.id),
  ]);
  const textA = contentA?.extracted_text || "";
  const textB = contentB?.extracted_text || "";

  const describe = (file, text) => ({
    id: file.id,
    filename: file.filename_current || file.filename_original,
    path: file.current_path,
    sizeBytes: file.size_bytes === null ? null : Number(file.size_bytes),
    extension: file.extension,
    sha256Hash: file.sha256_hash,
    aiShortTitle: file.ai_short_title || null,
    hasComparableText: similarity.hasEnoughTextToCompare(text),
    wordCount: similarity.tokenize(text).length,
  });

  const files = [describe(a, textA), describe(b, textB)];

  // An exact hash match is provable and needs no scoring at all.
  if (a.sha256_hash && a.sha256_hash === b.sha256_hash) {
    return {
      files,
      identical: true,
      similarity: 1,
      confidenceLevel: ConfidenceLevel.HIGH,
      verdict: "exact",
      explanation:
        "These two files are byte-for-byte identical -- their SHA-256 hashes match. This is an exact " +
        "duplicate, which the pipeline detects automatically without needing content similarity.",
      threshold: similarity.PROBABLE_DUPLICATE_THRESHOLD,
    };
  }

  if (!files[0].hasComparableText || !files[1].hasComparableText) {
    const which = [
      !files[0].hasComparableText ? files[0].filename : null,
      !files[1].hasComparableText ? files[1].filename : null,
    ].filter(Boolean);
    return {
      files,
      identical: false,
      similarity: null,
      confidenceLevel: null,
      verdict: "not_comparable",
      explanation:
        `Not enough extracted text to compare (${which.join(" and ")}). A file needs at least ` +
        `${similarity.MIN_TOKENS_FOR_COMPARISON} words of extracted content -- scanned images, ` +
        "unsupported formats and near-empty files fall below that. Comparing on so little text " +
        "would score two mostly-empty files as near-identical on boilerplate alone.",
      threshold: similarity.PROBABLE_DUPLICATE_THRESHOLD,
    };
  }

  const score = similarity.textSimilarity(textA, textB);
  const confidenceLevel = similarity.confidenceForScore(score);

  return {
    files,
    identical: false,
    similarity: score,
    confidenceLevel,
    verdict: confidenceLevel ? "probable" : "distinct",
    threshold: similarity.PROBABLE_DUPLICATE_THRESHOLD,
    explanation: confidenceLevel
      ? `These files share ${(score * 100).toFixed(1)}% of their five-word phrases, at or above the ` +
        `${(similarity.PROBABLE_DUPLICATE_THRESHOLD * 100).toFixed(0)}% threshold, so the pipeline would ` +
        "group them as probable duplicates for review. They are not identical -- a probable duplicate is " +
        "a suggestion, never resolved automatically."
      : `These files share ${(score * 100).toFixed(1)}% of their five-word phrases, below the ` +
        `${(similarity.PROBABLE_DUPLICATE_THRESHOLD * 100).toFixed(0)}% threshold, so the pipeline treats ` +
        "them as distinct documents. Some overlap is normal for files that share letterheads, " +
        "headers or standard wording.",
  };
}

/**
 * "Remove all files" (Files page bulk action). Per the same
 * repository-wide-operations-are-always-a-job convention that scan and
 * bulk_rename already follow (docs/08-api-contracts.md), this does not
 * loop synchronously here -- it enqueues a bulk_delete job and
 * bulkDeleteProcessor does the actual per-file removeFile() calls, so
 * progress is visible on the Processing Jobs page and a huge library
 * doesn't tie up the request/response cycle.
 */
async function removeAllFiles(actorUserId) {
  // Sized upfront so the Processing Jobs page can show real X/Y progress
  // instead of the "—" it shows when progress_total is left at 0 -- without
  // this a long-running bulk delete looks identical to a stuck one.
  const totalActive = await fileRepository.countByStatus(FileStatus.ACTIVE, actorUserId);
  const job = await enqueueJob(
    JobType.BULK_DELETE,
    { actorUserId, ownerUserId: actorUserId },
    { createdBy: actorUserId, ownerUserId: actorUserId, progressTotal: totalActive }
  );

  await auditLogRepository.record({
    userId: actorUserId,
    action: "file.remove_all.started",
    entityType: "processing_job",
    entityId: job.id,
    newState: { processingJobId: job.id },
    reason: "Bulk-removed all active files from the Files page",
  });

  return job;
}

/**
 * Manual "Edit" action -- a human directly setting the filename and/or
 * subject/document-type classification, as an alternative to waiting on
 * (or overriding) the AI proposal pipeline. Either field group can be
 * provided independently; the controller enforces which permission each
 * requires (document.rename for filename, classification.modify for
 * subject/documentType) before this is ever called.
 */
async function updateFile(fileId, { filename, subjectId, documentTypeId, confirmDuplicate }, actorUserId) {
  const file = await fileRepository.findByIdForOwner(fileId, actorUserId);
  if (!file) throw new NotFoundError("File not found.");
  if (file.status !== "active") throw new ValidationError("Only active files can be edited.");

  if (filename !== undefined && filename !== null) {
    // Was a check for path separators and nothing else, which accepted "NUL",
    // "report.pdf:stream", names ending in a dot (Windows strips it, so the
    // database would then hold a name that is not what is on disk), control
    // characters, and names long enough to break the mirror's shortcuts.
    // See utils/filenameSafety.js.
    const trimmed = assertSafeFilename(filename);

    if (trimmed !== file.filename_current) {
      const storageLocation = await storageLocationRepository.findById(file.storage_location_id);

      // Read-only location: record the intended name, don't touch the file.
      // The same rule the bulk_rename processor follows -- if manual rename
      // bypassed it, "read-only" would only be true until someone clicked
      // the pencil icon, which is not a guarantee worth making.
      if (storageLocation.is_read_only) {
        await fileRepository.setCanonicalName(fileId, {
          canonicalFilename: trimmed,
          canonicalRelativeDir: file.canonical_relative_dir || null,
        });

        await auditLogRepository.record({
          userId: actorUserId,
          action: "file.canonical_name_set",
          entityType: "file",
          entityId: fileId,
          previousState: { canonicalFilename: file.canonical_filename, filename: file.filename_current },
          newState: { canonicalFilename: trimmed },
          reason:
            `Manually named from the UI. "${storageLocation.name}" is read-only, so the original file ` +
            "was not renamed -- this name is what the shortcut mirror and the UI display.",
        });
      } else {
        // Writable location -- rename the actual file. Deliberately does
        // not move it to a different folder (that is what approving an AI
        // proposal's "Move to X" is for), so targetRelativeDir is null.
        const storageService = getStorageServiceFor(storageLocation);
        // Deliberately does not move the file to a different folder (that is
        // what approving an AI proposal's "Move to X" is for), so the target
        // directory is the one it is already in.
        const currentDir = path.dirname(file.current_path);
        const { absolutePath: newAbsolutePath, filename: safeFilename } = await renameToAvailableName(
          storageService,
          file.current_path,
          trimmed,
          currentDir === "." ? null : currentDir
        );
        const newRelativePath = path.relative(storageService.rootPath, newAbsolutePath);

        const previousFilename = file.filename_current;
        await fileRepository.updatePath(fileId, { currentPath: newRelativePath, filenameCurrent: safeFilename });

        await auditLogRepository.record({
          userId: actorUserId,
          action: "file.renamed",
          entityType: "file",
          entityId: fileId,
          previousState: { filename: previousFilename, path: file.current_path },
          newState: { filename: safeFilename, path: newRelativePath },
          reason:
            "Manually renamed from the Files page" +
            (safeFilename !== trimmed ? `; "${trimmed}" already existed, used "${safeFilename}" instead` : ""),
        });
      }
      // No early return here on purpose: the same request can also carry a
      // subject/documentType change, and returning would silently drop it.
    }
  }

  if (subjectId !== undefined || documentTypeId !== undefined) {
    if (documentTypeId) {
      const documentType = await documentTypeRepository.findById(documentTypeId);
      if (!documentType) throw new ValidationError("documentTypeId does not match a known document type.");
    }

    /**
     * FILING GOES THROUGH THE ONE MOVE PATH.
     *
     * This used to write a classification_results row directly, and that was
     * the hole in the duplicate invariant: PATCH /files/:id is what the Files
     * page's Move modal, the Subjects page and every AI-proposed `move_file`
     * action all call, so all three filed documents into the tree without ever
     * running the duplicate check. The check existed and simply was not on the
     * path anyone used.
     *
     * Routing through fileOrganizeService.moveToSubject means the guard, the
     * ownership check on the destination folder, the placement provenance and
     * the audit entry apply to every move, from every surface, by
     * construction rather than by each caller remembering.
     *
     * `confirmDuplicate` is threaded through so the caller can come back and
     * say "yes, file it anyway" -- the guard advises, it never traps.
     */
    if (subjectId) {
      const outcome = await fileOrganizeService.moveToSubject({
        fileId,
        subjectId,
        ownerUserId: actorUserId,
        source: fileOrganizeService.PlacementSource.USER,
        confirmDuplicate: Boolean(confirmDuplicate),
      });

      // Not moved means the guard wants a decision. Surfaced as structured
      // data rather than an exception so the controller can answer 409 with
      // the findings, and the UI can show what it found.
      if (!outcome.moved) {
        return {
          requiresConfirmation: true,
          findings: outcome.findings,
          destination: outcome.destination,
        };
      }
    }

    // A document TYPE is orthogonal to a subject (docs/03-taxonomy.md §3.4)
    // and carries no duplicate implications, so it is still written here --
    // but only when it is the thing that actually changed, or the subject
    // move above would be immediately overwritten by a second row naming no
    // subject at all.
    if (documentTypeId !== undefined && !subjectId) {
      await classificationResultRepository.create({
        fileId,
        classifiedSubjectId: null,
        classifiedDocumentTypeId: documentTypeId || null,
        confidenceLevel: ConfidenceLevel.HIGH,
        confidenceScore: 1.0,
        method: ClassificationMethod.MANUAL,
        rawOutput: { reason: "Document type manually set from the Files page" },
      });

      await auditLogRepository.record({
        userId: actorUserId,
        action: "file.reclassified",
        entityType: "file",
        entityId: fileId,
        newState: { documentTypeId: documentTypeId || null },
        reason: "Manually set from the Files page",
      });
    }
  }

  return getFileDetail(fileId, actorUserId);
}

/**
 * Launches the host OS's native file manager with this file selected --
 * "open on my computer" only makes sense when the machine running this
 * backend process IS the user's own computer (a local/self-hosted
 * deployment), which is exactly the deployment this was asked for. Never
 * attempted for an agent-brokered location: the backend process has no
 * filesystem access to a machine on the other end of a Filesystem Agent,
 * so there's nothing on ITS disk to reveal (see docs/04-storage-architecture.md
 * §4.4 -- and AgentStorageService doesn't exist yet regardless, Phase 12).
 */
async function revealInFileManager(fileId, ownerUserId) {
  const file = await fileRepository.findByIdForOwner(fileId, ownerUserId);
  if (!file) throw new NotFoundError("File not found.");
  if (file.status !== "active") throw new NotFoundError("File is not currently active on disk.");

  const storageLocation = await storageLocationRepository.findById(file.storage_location_id);
  if (!storageLocation) throw new NotFoundError("Storage location not found.");
  if (storageLocation.access_mode !== "direct") {
    throw new ValidationError(
      "This file lives on an agent-brokered storage location, not on this server's own disk -- " +
      "opening it in a local file explorer isn't possible from here."
    );
  }

  const absolutePath = resolveWithinRoot(storageLocation.root_path, file.current_path);
  await revealPathOnHostOS(absolutePath);
  return { opened: true, path: absolutePath };
}

/**
 * OS-specific "reveal and select" invocation. Always spawned via execFile
 * (argv array, no shell) rather than exec -- the path is server-resolved
 * and validated (resolveWithinRoot above), but there's no reason to ever
 * let a filesystem path pass through a shell for something interpolating
 * it into a command string.
 */
function revealPathOnHostOS(absolutePath) {
  return new Promise((resolve, reject) => {
    let command;
    let args;

    if (process.platform === "win32") {
      command = "explorer.exe";
      args = [`/select,${absolutePath}`];
    } else if (process.platform === "darwin") {
      command = "open";
      args = ["-R", absolutePath];
    } else {
      // No universal "reveal and select" across Linux desktop environments
      // -- best effort is opening the containing folder.
      command = "xdg-open";
      args = [path.dirname(absolutePath)];
    }

    execFile(command, args, (err) => {
      // explorer.exe's exit code is notoriously unreliable -- it commonly
      // returns non-zero even when it launched and selected the file fine.
      // Only a missing binary (no desktop environment at all -- e.g. this
      // backend is actually running headless on a remote server) is worth
      // surfacing as a real failure there.
      if (err && process.platform === "win32" && err.code !== "ENOENT") {
        resolve();
        return;
      }
      if (err) {
        reject(new ValidationError(
          `Couldn't open the system file manager (${err.code === "ENOENT" ? `"${command}" not found` : err.message}). ` +
          "This only works when the server itself is running on the same desktop machine you're browsing from."
        ));
        return;
      }
      resolve();
    });
  });
}

module.exports = {
  NotFoundError,
  search,
  count,
  filterOptions,
  getFileDetail,
  getDownloadStream,
  getPreviewImage,
  recordDownloadAudit,
  removeFile,
  removeAllFiles,
  compareFiles,
  updateFile,
  revealInFileManager,
};
