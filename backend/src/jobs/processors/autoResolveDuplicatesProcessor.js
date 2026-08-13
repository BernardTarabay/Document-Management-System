// Automates "Set canonical" across every OPEN duplicate group (user
// request: "automate the duplicate resolution thing"). Never deletes or
// modifies a file -- exactly like the manual button, this only ever calls
// setCanonicalFile via duplicateGroupService.autoResolveGroup, which is
// explicit that canonical selection must never delete other members
// (spec §13, duplicateGroupRepository.js's own header comment). This only
// automates WHICH member gets picked, so nobody has to click through
// dozens of groups by hand.
const duplicateGroupRepository = require("../../repositories/duplicateGroupRepository");
const duplicateGroupService = require("../../services/duplicateGroupService");
const processingJobItemRepository = require("../../repositories/processingJobItemRepository");
const processingJobRepository = require("../../repositories/processingJobRepository");
const { DuplicateGroupType } = require("../../models/enums");

const BATCH_SIZE = 100;

async function handle({ actorUserId }, bullJob) {
  const summary = { resolved: 0, skipped: 0, failed: 0 };
  let processed = 0;

  // Groups that failed or had nothing to resolve THIS run are excluded
  // from every subsequent fetch -- same forward-progress guarantee as
  // bulkDeleteProcessor: without it, a single stuck group at offset 0
  // would keep coming back and the loop would never finish.
  const excludeIds = [];

  // EXACT only. Probable-duplicate groups (added alongside content
  // similarity detection) are suggestions requiring human confirmation --
  // docs/01-domain-model.md §1.3 -- and the canonical-pick heuristic in
  // duplicateGroupService assumes byte-identical members, which is only
  // true for exact groups. duplicateGroupService.autoResolveGroup enforces
  // the same rule independently.
  const startingOpen = await duplicateGroupRepository.countOpen(DuplicateGroupType.EXACT);
  const maxBatches = Math.max(1, Math.ceil(startingOpen / BATCH_SIZE)) + 5;

  for (let batchCount = 0; batchCount < maxBatches; batchCount += 1) {
    const page = await duplicateGroupRepository.listOpen({
      limit: BATCH_SIZE,
      offset: 0,
      groupType: DuplicateGroupType.EXACT,
    });
    const batch = page.filter((g) => !excludeIds.includes(g.id));
    if (batch.length === 0) break;

    for (const group of batch) {
      const jobItem = await processingJobItemRepository.create({
        jobId: bullJob.data.processingJobId,
        fileId: null,
        status: "pending",
      });
      try {
        const resolved = await duplicateGroupService.autoResolveGroup(group.id, actorUserId);
        if (resolved) {
          summary.resolved += 1;
          await processingJobItemRepository.complete(jobItem.id, {
            status: "succeeded",
            result: { canonicalFileId: resolved.canonical_file_id },
          });
        } else {
          summary.skipped += 1;
          excludeIds.push(group.id);
          await processingJobItemRepository.complete(jobItem.id, {
            status: "skipped",
            result: { reason: "group no longer open or has no members" },
          });
        }
      } catch (err) {
        summary.failed += 1;
        excludeIds.push(group.id);
        await processingJobItemRepository.complete(jobItem.id, {
          status: "failed",
          errorMessage: err.message,
        });
      }
      processed += 1;
    }

    await processingJobRepository.updateProgress(bullJob.data.processingJobId, processed);
  }

  return summary;
}

module.exports = { handle };
