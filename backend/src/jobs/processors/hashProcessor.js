// Hashing stage (spec §12). On success, fans out to metadata/text extraction
// and a targeted duplicate check -- see docs/06-processing-pipeline.md §6.1
// for why these are separate jobs rather than one function.
const path = require("path");
const cloudPlaceholder = require("../../utils/cloudPlaceholder");
const fileRepository = require("../../repositories/fileRepository");
const fileHashRepository = require("../../repositories/fileHashRepository");
const fileOcrRepository = require("../../repositories/fileOcrRepository");
const storageLocationRepository = require("../../repositories/storageLocationRepository");
const auditLogRepository = require("../../repositories/auditLogRepository");
const { getStorageServiceFor } = require("../../services/storage/storageService");
const knownContentService = require("../../services/knownContentService");
const quickIdentityService = require("../../services/quickIdentityService");
const { sha256Stream, sha256AndFingerprint } = require("../../services/hashingService");
const { enqueueJob } = require("../../queues");
const imageDetection = require("../../services/imageDetection");
const pipelineState = require("../../services/pipelineState");
const ocrEngine = require("../../services/ocr/ocrEngine");
const { JobType, OcrStatus } = require("../../models/enums");

async function handle({ fileId, forceFullHash = false }) {
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

  /**
   * RECOGNISE IT BEFORE READING IT.
   *
   * The known-content short-circuit below already makes an identical file's
   * downstream work free -- but it fires on the sha256, and reaching the sha256
   * means streaming every byte. On an import that is mostly overlapping copies,
   * which is the normal shape here, that read IS the cost of the import.
   *
   * So this asks the cheap question first: is there already a file with this
   * exact size and mtime? That is answered from an index with nothing opened,
   * and for a genuinely new file the answer is no and this costs one query. If
   * there IS a candidate, 64 KB from each end is enough to decide -- 128 KB
   * instead of 500 MB on a video.
   *
   * A match adopts the twin's sha256 rather than computing it. That is an
   * inference, and it is recorded as one (`hash_source = 'inferred'`) rather
   * than written silently into the column duplicate detection is built on.
   * `forceFullHash` in the payload bypasses all of this, which is how
   * scripts/verify-inferred-hashes.js turns a believed hash into a proven one.
   */
  let hash = null;
  let hashSource = "computed";
  let quickFingerprint = null;

  if (!forceFullHash) {
    const quick = await quickIdentityService
      .findTwinWithoutFullRead(file, storageService, { accessMode: storageLocation.access_mode })
      .catch(() => null); // a sampling failure must never block a real hash
    if (quick) {
      quickFingerprint = quick.fingerprint;
      if (quick.twin?.sha256_hash) {
        hash = quick.twin.sha256_hash;
        hashSource = "inferred";
        await auditLogRepository.record({
          action: "file.hash_inferred",
          entityType: "file",
          entityId: fileId,
          newState: { sha256Hash: hash, matchedFileId: quick.twin.id, fingerprint: quick.fingerprint },
          reason:
            `Identified from ${quickIdentityService.CHUNK_BYTES * 2} bytes rather than reading all ` +
            `${file.size_bytes} -- same size, same timestamp, same head and tail as an already-indexed file. ` +
            "Marked inferred; scripts/verify-inferred-hashes.js can confirm it.",
        });
      }
    }
  }

  if (hash === null) {
    /**
     * The full read, which also produces the fingerprint for free.
     *
     * THE FINGERPRINT IS STORED WHETHER OR NOT IT WAS NEEDED THIS TIME, and
     * that is the whole mechanism: this file is the twin that the NEXT
     * overlapping folder matches against. The first version only computed one
     * when a candidate already existed, which meant the original never stored
     * one, so no copy ever had anything to match, so the shortcut never fired
     * for anyone -- a feature that was exactly as fast as not having it.
     */
    const wantFingerprint = Number(file.size_bytes) >= quickIdentityService.MIN_SIZE_FOR_INFERENCE;
    const result = await sha256AndFingerprint(storageService.readStream(file.current_path), {
      sizeBytes: file.size_bytes,
      chunkBytes: quickIdentityService.CHUNK_BYTES,
      wantFingerprint,
    });
    hash = result.sha256;
    if (result.fingerprint) quickFingerprint = result.fingerprint;
  }

  await fileRepository.updateHash(fileId, hash);
  await fileHashRepository.upsert(fileId, "sha256", hash);
  // Stored whether it matched or not: a file that is nobody's twin today is
  // the twin the NEXT overlapping folder matches against, and the 128 KB has
  // already been read by this point.
  if (quickFingerprint) await quickIdentityService.setFingerprint(fileId, quickFingerprint);
  await quickIdentityService.setHashSource(fileId, hashSource);
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
  const twin = await fileRepository.findProcessedTwinByHash(hash, fileId, file.owner_user_id);
  if (twin) {
    const summary = await knownContentService.adoptFrom({ ...file, sha256_hash: hash }, twin);

    // Duplicate detection still runs. The file genuinely IS a duplicate, and
    // that group is what the Duplicates page and the reclaimable-bytes
    // figure are built from -- skipping it would save nothing and hide the
    // one fact worth surfacing about this file.
    await enqueueJob(JobType.DETECT_DUPLICATES, { fileId }, { storageLocationId: storageLocation.id });

    // The adoption path skips the analysis stages, so it has to carry the
    // routing decision itself -- otherwise a second copy of a photograph is
    // adopted as a document and never appears in Photos.
    if (imageDetection.isImage(file)) {
      await fileRepository.setIsImage(fileId, true);
      await fileRepository.setOcrStatus(fileId, OcrStatus.PENDING);
    }

    // Adoption replaces the analysis stages, so nothing downstream will ever
    // set this file's state. It inherited a finished twin's results, so it is
    // as finished as the twin -- leaving it at 'discovered' made an adopted
    // file look permanently unprocessed.
    await pipelineState.markCompleted(fileId, "hash");

    return { sha256Hash: hash, knownContent: true, ...summary };
  }

  // ROUTING: a picture is not a document, and must not be treated as one.
  //
  // Everything below used to be unconditional, which is how a folder of
  // photographs ended up in triage. extract_text on a JPEG finds nothing,
  // textQuality judges the nothing unusable, generate_names correctly refuses
  // to name a file from unusable text -- and the file lands in triage flagged
  // "needs OCR" with no OCR to be had. Four stages of work to arrive at "this
  // is a photo", which the extension said at ingest.
  //
  // So the route is decided once, here, from the extension and the detected
  // mime, and the file goes down exactly one path.
  const route = imageDetection.routeFor(file);

  await enqueueJob(JobType.EXTRACT_METADATA, { fileId }, { storageLocationId: storageLocation.id });
  await enqueueJob(JobType.DETECT_DUPLICATES, { fileId }, { storageLocationId: storageLocation.id });

  if (route === "image") {
    await fileRepository.setIsImage(fileId, true);

    // Straight to Photos. If an OCR engine is present the text is read in the
    // background; if not, the photo is still listed, viewable and filable --
    // it simply has no text yet, which the Photos page states plainly rather
    // than leaving the user to infer.
    // Only queue OCR when there is OCR left to do.
    //
    // This used to stamp 'queued' unconditionally, which regressed the status
    // of every already-read photo on each rescan -- and worse, it RACED.
    // Hashing runs four wide, so a later hash job's 'queued' could land after
    // an earlier OCR job's 'completed', leaving the photo permanently showing
    // "Queued" while file_ocr said it had been read. Two columns describing
    // one fact and disagreeing, which is the standing cost of the
    // denormalisation and has to be paid at every write.
    let ocrQueued = false;
    const engine = await ocrEngine.detect();

    if (!engine.available) {
      // Nothing to claim -- record that it is waiting on an engine, and only
      // if it has not already been read by one that was present earlier.
      await fileRepository.claimForOcr(fileId);
      await fileRepository.setOcrStatus(fileId, OcrStatus.PENDING);
    } else if (await fileRepository.claimForOcr(fileId)) {
      // We won the claim, so we own the follow-up job. A file already
      // 'completed' or 'running' yields nothing here and is left alone --
      // which is what stops a rescan resetting photos that were already read.
      await enqueueJob(JobType.OCR, { fileId }, { storageLocationId: storageLocation.id });
      ocrQueued = true;
    }

    // Only when OCR is NOT going to run. The OCR stage already asks the vision
    // model what the picture shows and enqueues `describe` itself when it
    // finishes, so queueing it here as well would race: two jobs would reach
    // the "no description yet" check at the same moment and both pay for the
    // same vision call.
    if (!ocrQueued) {
      await enqueueJob(JobType.DESCRIBE, { fileId }, { storageLocationId: storageLocation.id });
    }

    // NEEDS_USER, not COMPLETED: a photograph nobody has looked at is exactly
    // the thing waiting on a person. It shows in Photos as unreviewed, and
    // filing it or keeping its name clears it. It is deliberately NOT in the
    // triage queue -- triageRepository excludes images (see its WHERE clause).
    await pipelineState.markNeedsUser(fileId, "hash", "A photo -- have a look and file it.");

    return { sha256Hash: hash, route, ocrQueued };
  }

  if (route === "media") {
    // Audio/video: still no TEXT to extract, and none will be invented. But
    // there is now something to be said about it -- the describe stage watches
    // the video or listens to the recording and writes down what it contains,
    // which is what makes "the clip of the kid at the football match" findable
    // instead of leaving the user with "WhatsApp Video 2026-07-16 at
    // 00.16.15.mp4" and no way in.
    await enqueueJob(JobType.DESCRIBE, { fileId }, { storageLocationId: storageLocation.id });

    await pipelineState.markNeedsUser(
      fileId, "hash",
      "Audio or video -- there is no text to extract, so Atlas cannot name or classify it. File it yourself."
    );
    return { sha256Hash: hash, route };
  }

  await enqueueJob(JobType.EXTRACT_TEXT, { fileId }, { storageLocationId: storageLocation.id });

  return { sha256Hash: hash, route };
}

module.exports = { handle };
