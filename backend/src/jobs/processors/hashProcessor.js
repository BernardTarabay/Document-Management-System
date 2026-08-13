// Hashing stage (spec §12). On success, fans out to metadata/text extraction
// and a targeted duplicate check -- see docs/06-processing-pipeline.md §6.1
// for why these are separate jobs rather than one function.
const path = require("path");
const cloudPlaceholder = require("../../utils/cloudPlaceholder");
const fileRepository = require("../../repositories/fileRepository");
const fileHashRepository = require("../../repositories/fileHashRepository");
const storageLocationRepository = require("../../repositories/storageLocationRepository");
const auditLogRepository = require("../../repositories/auditLogRepository");
const { getStorageServiceFor } = require("../../services/storage/storageService");
const knownContentService = require("../../services/knownContentService");
const { sha256Stream } = require("../../services/hashingService");
const { enqueueJob } = require("../../queues");
const { JobType } = require("../../models/enums");

async function handle({ fileId }) {
  const file = await fileRepository.findById(fileId);
  if (!file || file.status === "deleted" || file.status === "missing") {
    return { skipped: true, reason: "file not active" };
  }

  const storageLocation = await storageLocationRepository.findById(file.storage_location_id);
  const storageService = getStorageServiceFor(storageLocation);

  // Check BEFORE opening the file. Hashing streams the whole thing, which
  // is exactly what makes a cloud sync client materialize a placeholder --
  // across a large cloud-backed folder that means downloading everything
  // just to index it. See utils/cloudPlaceholder.js.
  //
  // Only meaningful for locations the backend reads directly; an agent
  // reports its own stat results and does its own reading.
  if (storageLocation.access_mode === "direct") {
    const absolutePath = path.resolve(storageLocation.root_path, file.current_path);
    const placeholder = await cloudPlaceholder.inspect(absolutePath);
    await fileRepository.setCloudPlaceholder(fileId, placeholder.isPlaceholder);

    if (placeholder.isPlaceholder) {
      await auditLogRepository.record({
        action: "file.skipped_placeholder",
        entityType: "file",
        entityId: fileId,
        newState: { sizeBytes: placeholder.size },
        reason:
          `Not hashed: ${placeholder.reason} Reading it would have forced a download. ` +
          "It will be processed automatically once its contents are available locally.",
      });
      // No downstream jobs: extraction would trigger the same download.
      return { skipped: true, reason: "cloud placeholder -- contents not on this disk yet" };
    }
  }

  const hash = await sha256Stream(storageService.readStream(file.current_path));

  await fileRepository.updateHash(fileId, hash);
  await fileHashRepository.upsert(fileId, "sha256", hash);
  if (file.status === "changed") {
    await fileRepository.updateStatus(fileId, "active");
  }

  await auditLogRepository.record({
    action: "file.hashed",
    entityType: "file",
    entityId: fileId,
    newState: { sha256Hash: hash },
  });

  // KNOWN CONTENT SHORT-CIRCUIT
  //
  // The hash is the first moment this file can be recognised as something
  // already indexed. If an identical file has been through the pipeline, its
  // results are this file's results -- identical bytes cannot extract to
  // different text -- so the four analysis stages are replaced by copying
  // what the twin already established. See services/knownContentService.js
  // for what is and is not adopted.
  //
  // This is what makes registering a second, overlapping folder cheap: only
  // the genuinely new files go through the pipeline, instead of every file
  // being re-parsed and handed back for review as a duplicate of something
  // the user already dealt with.
  const twin = await fileRepository.findProcessedTwinByHash(hash, fileId);
  if (twin) {
    const summary = await knownContentService.adoptFrom({ ...file, sha256_hash: hash }, twin);

    // Duplicate detection still runs. The file genuinely IS a duplicate, and
    // that group is what the Duplicates page and the reclaimable-bytes
    // figure are built from -- skipping it would save nothing and hide the
    // one fact worth surfacing about this file.
    await enqueueJob(JobType.DETECT_DUPLICATES, { fileId }, { storageLocationId: storageLocation.id });

    return { sha256Hash: hash, knownContent: true, ...summary };
  }

  await enqueueJob(JobType.EXTRACT_METADATA, { fileId }, { storageLocationId: storageLocation.id });
  await enqueueJob(JobType.EXTRACT_TEXT, { fileId }, { storageLocationId: storageLocation.id });
  await enqueueJob(JobType.DETECT_DUPLICATES, { fileId }, { storageLocationId: storageLocation.id });

  return { sha256Hash: hash };
}

module.exports = { handle };
