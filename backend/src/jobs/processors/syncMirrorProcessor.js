// Rebuilds the organized shortcut tree (services/mirror/mirrorService.js).
//
// Runs as a job for the same reason scan does: it walks and writes across
// potentially hundreds of thousands of files, which must never happen
// inside a request. Chained off bulk_rename so approving a name makes the
// shortcut appear on its own, and available on demand from the UI.
const mirrorService = require("../../services/mirror/mirrorService");
const processingJobRepository = require("../../repositories/processingJobRepository");
const auditLogRepository = require("../../repositories/auditLogRepository");

async function handle({ prune = true, actorUserId = null } = {}, bullJob) {
  const processingJobId = bullJob?.data?.processingJobId || null;

  const summary = await mirrorService.sync({
    prune,
    onProgress: ({ processed, total }) => {
      if (!processingJobId) return;
      // Fire-and-forget: progress reporting must never fail the job it is
      // reporting on.
      processingJobRepository.updateProgressTotal(processingJobId, total).catch(() => {});
      processingJobRepository.updateProgress(processingJobId, processed).catch(() => {});
    },
  });

  await auditLogRepository.record({
    userId: actorUserId,
    action: "mirror.synced",
    entityType: "storage_location",
    entityId: null,
    newState: {
      mirrorRoot: summary.mirrorRoot,
      candidates: summary.candidates,
      written: summary.written,
      pruned: summary.pruned,
      skippedOffline: summary.skippedOffline,
      errorCount: summary.errors.length,
    },
    reason:
      `Rebuilt the organized shortcut folder: ${summary.written} shortcut(s) written, ` +
      `${summary.pruned} stale removed, ${summary.skippedOffline} skipped (source offline).`,
  });

  // Errors are returned rather than thrown: one unwritable shortcut should
  // not discard a successful sync of everything else. They surface on the
  // Processing Jobs page as part of the result.
  return {
    ...summary,
    errors: summary.errors.slice(0, 25),
    errorCount: summary.errors.length,
  };
}

module.exports = { handle };
