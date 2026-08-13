// Content (text) extraction stage (spec §8) -- see extractMetadataProcessor.js
// for why this parses the file independently rather than sharing a buffer.
const fileRepository = require("../../repositories/fileRepository");
const storageLocationRepository = require("../../repositories/storageLocationRepository");
const fileContentRepository = require("../../repositories/fileContentRepository");
const { getStorageServiceFor } = require("../../services/storage/storageService");
const { streamToBuffer } = require("../../utils/streamToBuffer");
const { extractContent } = require("../../services/extraction");
const { assessText, wouldBenefitFromOcr } = require("../../services/extraction/textQuality");
const auditLogRepository = require("../../repositories/auditLogRepository");
const { enqueueJob } = require("../../queues");
const { JobType } = require("../../models/enums");
const env = require("../../config/env");

async function handle({ fileId }) {
  const file = await fileRepository.findById(fileId);
  if (!file || file.status === "deleted" || file.status === "missing") {
    return { skipped: true, reason: "file not active" };
  }

  const storageLocation = await storageLocationRepository.findById(file.storage_location_id);
  const storageService = getStorageServiceFor(storageLocation);

  // Refuse before opening, not after. See env.extraction.maxBytes -- this
  // reads the entire file into memory, and there was previously nothing
  // stopping it doing that for a file of any size at all.
  //
  // Recorded as a 'skipped' row rather than left absent: listUnprocessed
  // treats a missing file_content row as lost work and re-queues it on every
  // scan, so a file too big to read would otherwise be retried forever,
  // OOM-ing the worker each time, at the head of a queue an import is
  // waiting behind.
  const sizeBytes = Number(file.size_bytes) || 0;
  if (sizeBytes > env.extraction.maxBytes) {
    const mb = (n) => `${(n / 1024 / 1024).toFixed(0)} MB`;
    await fileContentRepository.upsert(fileId, {
      extractedText: "",
      extractionStatus: "skipped",
    });
    await auditLogRepository.record({
      action: "extraction.skipped_too_large",
      entityType: "file",
      entityId: fileId,
      newState: { sizeBytes, maxBytes: env.extraction.maxBytes },
      reason:
        `"${file.filename_current}" is ${mb(sizeBytes)}, over the ${mb(env.extraction.maxBytes)} extraction ` +
        "limit, so its text was not extracted. Raise MAX_EXTRACTION_BYTES to include files this large.",
    });
    return { skipped: true, reason: "file too large to extract", sizeBytes };
  }

  const buffer = await streamToBuffer(storageService.readStream(file.current_path));

  const result = await extractContent(buffer, file.extension);

  // Judge the text before anything downstream trusts it. A scanned document
  // does not extract to nothing -- it extracts to a little garbage, which
  // the AI tier will happily read and turn into a confident filename. See
  // services/extraction/textQuality.js.
  const quality = assessText(result.text || "", { sizeBytes: Number(file.size_bytes) || buffer.length });
  const needsOcr = wouldBenefitFromOcr(quality, file.extension);

  await fileContentRepository.upsert(fileId, {
    extractedText: result.text || "",
    extractionStatus: result.extractor === "unsupported" ? "skipped" : "completed",
    textQuality: quality.verdict,
    needsOcr,
  });

  if (!quality.usable && (result.text || "").length > 0) {
    // Only worth recording when something WAS extracted and we rejected it --
    // "this file has no text" is unremarkable, "we read this file and threw
    // the result away" is a decision the user may need explained when they
    // wonder why a document was never renamed.
    await auditLogRepository.record({
      action: "extraction.text_rejected",
      entityType: "file",
      entityId: fileId,
      newState: { verdict: quality.verdict, chars: quality.stats.chars, needsOcr },
      reason: quality.reason,
    });
  }

  // Text is the strongest classification signal, so classification is
  // chained off this stage rather than off hashing directly (docs/06 §6.1) --
  // classify still tolerates metadata not being ready yet if extract_metadata
  // hasn't finished, since it never hard-requires it.
  await enqueueJob(JobType.CLASSIFY, { fileId }, { storageLocationId: storageLocation.id });

  // Probable-duplicate and version detection both need extracted text, so
  // they chain off THIS stage rather than off hashing like exact-duplicate
  // detection does. Skipped entirely when nothing USABLE was extracted --
  // both stages would immediately bail on an empty body, and enqueuing a job
  // that can only no-op just adds noise to the Processing Jobs page.
  //
  // The quality gate matters here as much as for naming. Two different
  // scanned documents that both extract to the same handful of page-furniture
  // fragments score as near-identical, so unusable text does not just fail to
  // help -- it manufactures false "probable duplicates" against real,
  // unrelated files, and every one of those costs a human a review.
  if (quality.usable) {
    await enqueueJob(
      JobType.DETECT_DUPLICATES,
      { fileId, phase: "probable" },
      { storageLocationId: storageLocation.id }
    );
    await enqueueJob(JobType.DETECT_VERSIONS, { fileId }, { storageLocationId: storageLocation.id });
  }

  return {
    textLength: (result.text || "").length,
    textQuality: quality.verdict,
    needsOcr,
  };
}

module.exports = { handle };
