const renameProposalRepository = require("../repositories/renameProposalRepository");
const auditLogRepository = require("../repositories/auditLogRepository");
const { enqueueJob } = require("../queues");
const { parsePagination } = require("../utils/pagination");
const { ValidationError } = require("../validators/validationError");
const { JobType, ProposalStatus } = require("../models/enums");

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 404;
    this.publicMessage = message;
  }
}

async function search(query) {
  const { limit, offset } = parsePagination(query);
  const status = query.status || ProposalStatus.PENDING;
  if (status === ProposalStatus.PENDING) return renameProposalRepository.listPending({ limit, offset });
  // Bug fix: this used to call the generic, unfiltered base.list() for
  // every non-pending status, which returned ALL proposals regardless of
  // status -- so the approved/rejected/applied tabs all showed the same
  // full set instead of being filtered. listByStatus() actually filters.
  return renameProposalRepository.listByStatus(status, { limit, offset });
}

async function review(id, status, actorUserId) {
  const proposal = await renameProposalRepository.findById(id);
  if (!proposal) throw new NotFoundError("Rename proposal not found.");
  if (proposal.status !== ProposalStatus.PENDING) {
    throw new ValidationError(`Proposal is already ${proposal.status}, not pending.`);
  }

  const updated = await renameProposalRepository.review(id, { status, reviewedBy: actorUserId });

  await auditLogRepository.record({
    userId: actorUserId,
    action: status === ProposalStatus.APPROVED ? "rename.approved" : "rename.rejected",
    entityType: "rename_proposal",
    entityId: id,
    previousState: { status: "pending" },
    newState: { status },
  });

  // Approving IS the decision to do this -- there's deliberately no separate
  // multi-step "approve, then also remember to go apply it" workflow here.
  // Immediately enqueue the actual filesystem rename/move for this one
  // proposal so clicking approve is the whole action, not step one of two.
  // bulkRenameProcessor still re-checks status==='approved' itself before
  // touching anything (spec §22/§23's independent gate), it's just no
  // longer a gate a human has to separately remember to pull.
  if (status === ProposalStatus.APPROVED) {
    const job = await enqueueJob(
      JobType.BULK_RENAME,
      { proposalIds: [id] },
      { createdBy: actorUserId, progressTotal: 1 }
    );
    return { ...updated, applyJobId: job.id };
  }

  return updated;
}

/**
 * Discards a rejected or applied proposal and re-enqueues classification
 * for its underlying file, so a fresh proposal can be generated -- e.g.
 * after fixing a misconfigured classifier, or just wanting a second look.
 * Deliberately blocked for 'pending' proposals: those already have an
 * open decision (approve/reject), retrying one mid-review would silently
 * orphan it.
 */
async function retry(id, actorUserId) {
  const proposal = await renameProposalRepository.findById(id);
  if (!proposal) throw new NotFoundError("Rename proposal not found.");
  if (proposal.status === ProposalStatus.PENDING) {
    throw new ValidationError("Proposal is still pending -- approve or reject it first.");
  }

  await renameProposalRepository.deleteById(id);

  await auditLogRepository.record({
    userId: actorUserId,
    action: "rename.retry",
    entityType: "rename_proposal",
    entityId: id,
    previousState: { status: proposal.status },
    reason: "Retried from the " + proposal.status + " tab -- re-running classification for the file.",
  });

  const job = await enqueueJob(JobType.CLASSIFY, { fileId: proposal.file_id }, { createdBy: actorUserId });
  return { retried: true, fileId: proposal.file_id, jobId: job.id };
}

/**
 * Enqueues the bulk_rename job. The worker (bulkRenameProcessor.js) is the
 * second, independent gate -- it re-checks that each proposal is actually
 * 'approved' before touching the filesystem, so this endpoint can never be
 * used to apply anything that wasn't reviewed (spec §22/§23).
 */
async function bulkApply(proposalIds, actorUserId) {
  if (!Array.isArray(proposalIds) || proposalIds.length === 0) {
    throw new ValidationError("proposalIds must be a non-empty array.");
  }
  const job = await enqueueJob(JobType.BULK_RENAME, { proposalIds }, { createdBy: actorUserId, progressTotal: proposalIds.length });

  await auditLogRepository.record({
    userId: actorUserId,
    action: "bulk_rename.started",
    entityType: "processing_job",
    entityId: job.id,
    newState: { proposalCount: proposalIds.length },
  });

  return job;
}

async function pendingCount() {
  return renameProposalRepository.countPending();
}

/**
 * Parse a 0..1 confidence threshold, refusing anything that is not actually
 * a number.
 *
 * The explicit null/""/undefined rejection is load-bearing, not defensive
 * noise: Number(null) and Number("") are both 0, and 0 is a MEANINGFUL
 * threshold at both ends of this dial. A request that forgot to send the
 * field would otherwise coerce to zero and be obeyed --
 * approveAboveConfidence(null) means "approve every pending proposal and
 * queue every rename", which is the single most destructive thing this
 * service can do, triggered by a typo. Caught by verify-bulk-reject.js.
 */
function parseConfidence(value) {
  if (value === null || value === undefined || value === "") {
    throw new ValidationError("A confidence threshold between 0 and 1 is required.");
  }
  if (typeof value === "boolean") {
    throw new ValidationError("A confidence threshold must be a number between 0 and 1.");
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new ValidationError("A confidence threshold must be a number between 0 and 1.");
  }
  return parsed;
}

/** How many pending proposals a threshold would catch -- shown before the
 *  user commits, so "approve everything above 90%" is never a blind click. */
async function countPendingAboveConfidence(minConfidence) {
  const rows = await renameProposalRepository.listPendingAboveConfidence(parseConfidence(minConfidence));
  return { minConfidence: parseConfidence(minConfidence), count: rows.length };
}

/**
 * Approve every pending proposal at or above a confidence score, then queue
 * them to be applied.
 *
 * Done server-side in one request rather than the client looping over
 * approve-one: a threshold that matches 200 proposals would otherwise be
 * 200 round trips that can half-fail, leaving an approved-but-never-applied
 * mess with no record of what the user actually agreed to.
 */
async function approveAboveConfidence(minConfidence, actorUserId) {
  const min = parseConfidence(minConfidence);
  const matching = await renameProposalRepository.listPendingAboveConfidence(min);

  if (matching.length === 0) {
    return { approved: 0, minConfidence: min, job: null };
  }

  for (const proposal of matching) {
    await renameProposalRepository.review(proposal.id, { status: "approved", reviewedBy: actorUserId });
  }

  const proposalIds = matching.map((p) => p.id);
  const job = await enqueueJob(
    JobType.BULK_RENAME,
    { proposalIds },
    { createdBy: actorUserId, progressTotal: proposalIds.length }
  );

  await auditLogRepository.record({
    userId: actorUserId,
    action: "rename.bulk_approved",
    entityType: "processing_job",
    entityId: job.id,
    newState: { minConfidence: min, proposalCount: proposalIds.length },
    reason:
      `Approved ${proposalIds.length} pending rename proposal(s) with confidence >= ${min} ` +
      "in one action, and queued them to be applied.",
  });

  return { approved: proposalIds.length, minConfidence: min, job };
}

/** How many pending proposals a "clear the junk" threshold would discard.
 *  Shown before committing, so the count agreed to and the set rejected come
 *  from the same predicate. */
async function countPendingBelowConfidence(maxConfidence) {
  const max = parseConfidence(maxConfidence);
  const rows = await renameProposalRepository.listPendingBelowConfidence(max);
  return { maxConfidence: max, count: rows.length };
}

/**
 * Reject every pending proposal at or below a confidence score.
 *
 * The counterpart to approveAboveConfidence, and the reason the review queue
 * is usable at all on a real corpus: classification produces a proposal for
 * every file, including the thousands it had nothing to go on for -- image
 * PDFs, formats with no extractable text, files whose only content is a
 * scanned letterhead. Those land at 0.0 and bury the proposals a human
 * should actually look at.
 *
 * Rejecting is SAFE in a way approving is not. It queues no work and touches
 * no file: it marks the suggestion declined. Nothing on disk changes, no
 * canonical name is written, and if the file is later re-extracted (say OCR
 * gets added) classification runs again and proposes afresh.
 */
async function rejectBelowConfidence(maxConfidence, actorUserId) {
  const max = parseConfidence(maxConfidence);
  const rejected = await renameProposalRepository.rejectPendingBelowConfidence(max, actorUserId);

  if (rejected.length > 0) {
    await auditLogRepository.record({
      userId: actorUserId,
      action: "rename.bulk_rejected",
      entityType: "rename_proposal",
      entityId: null,
      newState: { maxConfidence: max, proposalCount: rejected.length },
      reason:
        `Rejected ${rejected.length} pending rename proposal(s) with confidence <= ${max} ` +
        "in one action. No files were touched.",
    });
  }

  return { rejected: rejected.length, maxConfidence: max };
}

module.exports = {
  NotFoundError, search, review, retry, bulkApply, pendingCount,
  countPendingAboveConfidence, approveAboveConfidence,
  countPendingBelowConfidence, rejectBelowConfidence,
};