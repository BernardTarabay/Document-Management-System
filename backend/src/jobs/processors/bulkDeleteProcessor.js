// "Remove all files" (spec convention: repository-wide operations are
// always a job, never a synchronous request -- docs/08-api-contracts.md).
// Soft-deletes every currently-active file, reusing fileService.removeFile
// per file so removal means exactly the same thing here as it does from
// the Files page's single-file "x" button: status -> 'deleted' (never a
// hard DELETE, per the schema's own "additive, not destructive" design),
// any pending rename proposal for it gets cancelled, and it's audit-logged.
const fileRepository = require("../../repositories/fileRepository");
const fileService = require("../../services/fileService");
const processingJobItemRepository = require("../../repositories/processingJobItemRepository");
const processingJobRepository = require("../../repositories/processingJobRepository");
const { FileStatus } = require("../../models/enums");

const BATCH_SIZE = 200;

async function handle({ actorUserId }, bullJob) {
  const summary = { removed: 0, failed: 0 };
  let processed = 0;

  // Files that failed removal THIS run are excluded from every subsequent
  // fetch. Without this, listByStatus('active', {offset: 0}) keeps handing
  // back the exact same batch when even one file in it fails to remove
  // (permission hiccup, lock, whatever) -- the loop would spin retrying the
  // same non-shrinking set instead of ever finishing. Excluding known
  // failures guarantees every iteration either removes a file for real or
  // permanently shrinks the candidate set, so the loop always terminates.
  const failedIds = [];

  // Bounded by "how many batches could this repository possibly need,"
  // recomputed from a fresh count rather than a fixed constant like 10000 --
  // a fixed cap either wastes cycles for small libraries or silently cuts
  // off huge ones.
  const startingActive = await fileRepository.countByStatus(FileStatus.ACTIVE);
  const maxBatches = Math.max(1, Math.ceil(startingActive / BATCH_SIZE)) + 5; // +5 slack for files added mid-run

  for (let batchCount = 0; batchCount < maxBatches; batchCount += 1) {
    const batch = await fileRepository.listByStatus(FileStatus.ACTIVE, {
      limit: BATCH_SIZE,
      offset: 0,
      excludeIds: failedIds,
    });
    if (batch.length === 0) break;

    for (const file of batch) {
      const jobItem = await processingJobItemRepository.create({
        jobId: bullJob.data.processingJobId,
        fileId: file.id,
        status: "pending",
      });
      try {
        await fileService.removeFile(file.id, actorUserId);
        summary.removed += 1;
        await processingJobItemRepository.complete(jobItem.id, { status: "succeeded" });
      } catch (err) {
        summary.failed += 1;
        failedIds.push(file.id);
        await processingJobItemRepository.complete(jobItem.id, {
          status: "failed",
          errorMessage: err.message,
        });
      }
      processed += 1;
    }

    // Update after each batch (not each file) -- frequent enough for the
    // Processing Jobs page's 4s poll to show real movement, without adding
    // a write per file on top of everything removeFile() already does.
    await processingJobRepository.updateProgress(bullJob.data.processingJobId, processed);
  }

  return summary;
}

module.exports = { handle };
