const renameProposalRepository = require("../repositories/renameProposalRepository");
const auditLogRepository = require("../repositories/auditLogRepository");
const { enqueueJob } = require("../queues");
const { parsePagination } = require("../utils/pagination");
const { ValidationError } = require("../validators/validationError");
const pipelineState = require("./pipelineState");
const { requireOwner } = require("../repositories/ownership");
const { JobType, ProposalStatus } = require("../models/enums");

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 404;
    this.publicMessage = message;
  }
}

async function search(query, ownerUserId) {
  requireOwner(ownerUserId, "renameProposalService.search");
  const { limit, offset } = parsePagination(query);
  const status = query.status || ProposalStatus.PENDING;
  if (status === ProposalStatus.PENDING) return renameProposalRepository.listPending(ownerUserId, { limit, offset });
  // Bug fix: this used to call the generic, unfiltered base.list() for
  // every non-pending status, which returned ALL proposals regardless of
  // status -- so the approved/rejected/applied tabs all showed the same
  // full set instead of being filtered. listByStatus() actually filters.
  return renameProposalRepository.listByStatus(status, ownerUserId, { limit, offset });
}

/**
 * Approve or reject one proposal.
 *
 * WHAT REJECTING MEANS -- THE POINT WORTH BEING EXPLICIT ABOUT
 *
 * Rejecting a rename rejects THE NAME, never the file. It means "the name
 * this document already has is the right one", and it is a FINISHED state,
 * not a problem to come back to:
 *
 *   - the file keeps filename_current, untouched
 *   - the pipeline continues; nothing is cancelled
 *   - it stays filed under its subject and still appears in the organized
 *     mirror under its original name (fileRepository.listForMirror takes a
 *     canonical name OR a subject, precisely so a rejected rename does not
 *     make a document vanish from the only browsable view)
 *   - it is NOT sent to triage, NOT marked failed, and the user is NOT asked
 *     to decide again
 *
 * The markUserResolved call below is what enforces the last point. Before it,
 * a rejected proposal left the file matching triage's "could not be named"
 * predicate, so declining a suggestion put the document straight into the
 * queue of things needing attention -- the exact opposite of what the user
 * just said.
 */
async function review(id, status, actorUserId) {
  const proposal = await renameProposalRepository.findByIdForOwner(id, actorUserId);
  if (!proposal) throw new NotFoundError("Rename proposal not found.");
  if (proposal.status !== ProposalStatus.PENDING) {
    throw new ValidationError(`Proposal is already ${proposal.status}, not pending.`);
  }

  const updated = await renameProposalRepository.review(id, { status, reviewedBy: actorUserId });

  if (status === ProposalStatus.REJECTED) {
    // Settled, by the user, deliberately. Recorded so nothing downstream
    // treats "has no canonical name" as "still needs a decision".
    await pipelineState.markUserResolved(proposal.file_id, "kept_name");
  }

  await auditLogRepository.record({
    userId: actorUserId,
    action: status === ProposalStatus.APPROVED ? "rename.approved" : "rename.rejected",
    entityType: "rename_proposal",
    entityId: id,
    previousState: { status: "pending" },
    newState: { status },
    reason: status === ProposalStatus.REJECTED
      ? `The suggested name was declined; "${proposal.current_filename}" is kept. The file is settled ` +
        "and continues normally -- rejecting a name never rejects the document."
      : `Approved "${proposal.proposed_filename}" and queued it to be applied.`,
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
      { createdBy: actorUserId, ownerUserId: actorUserId, progressTotal: 1 }
    );
    return { ...updated, applyJobId: job.id };
  }

  return {
    ...updated,
    // Said in the response, not only in the audit log, so the UI can show the
    // outcome rather than leaving the user to wonder what rejecting did.
    outcome: "original_name_kept",
    keptFilename: proposal.current_filename,
  };
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
  const proposal = await renameProposalRepository.findByIdForOwner(id, actorUserId);
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

  const job = await enqueueJob(
    JobType.CLASSIFY,
    { fileId: proposal.file_id },
    { createdBy: actorUserId, ownerUserId: actorUserId }
  );
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
  // Filtered to the caller's own before anything is queued. Without this a
  // hand-written id list would apply renames to another account's files --
  // and bulkRenameProcessor, whose job is to check the proposal is approved,
  // would happily confirm that it was.
  const owned = [];
  for (const id of proposalIds) {
    if (await renameProposalRepository.findByIdForOwner(id, actorUserId)) owned.push(id);
  }
  if (owned.length === 0) throw new ValidationError("None of those proposals are yours to apply.");
  proposalIds = owned;

  const job = await enqueueJob(JobType.BULK_RENAME, { proposalIds }, { createdBy: actorUserId, ownerUserId: actorUserId, progressTotal: proposalIds.length });

  await auditLogRepository.record({
    userId: actorUserId,
    action: "bulk_rename.started",
    entityType: "processing_job",
    entityId: job.id,
    newState: { proposalCount: proposalIds.length },
  });

  return job;
}

async function pendingCount(ownerUserId) {
  return renameProposalRepository.countPending(ownerUserId);
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
async function countPendingAboveConfidence(minConfidence, ownerUserId) {
  const min = parseConfidence(minConfidence);
  const rows = await renameProposalRepository.listPendingAboveConfidence(min, ownerUserId);
  return { minConfidence: min, count: rows.length };
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
  const matching = await renameProposalRepository.listPendingAboveConfidence(min, actorUserId);

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
    { createdBy: actorUserId, ownerUserId: actorUserId, progressTotal: proposalIds.length }
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
async function countPendingBelowConfidence(maxConfidence, ownerUserId) {
  const max = parseConfidence(maxConfidence);
  const rows = await renameProposalRepository.listPendingBelowConfidence(max, ownerUserId);
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

  // Each rejection means the same thing as a single one: this file keeps the
  // name it has, and is finished. Marking them resolved is what stops three
  // thousand cleared proposals reappearing as three thousand triage entries.
  for (const row of rejected) {
    await pipelineState.markUserResolved(row.file_id, "kept_name").catch(() => {});
  }

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