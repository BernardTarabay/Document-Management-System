// Triage (task #42): the one place collecting everything the pipeline could
// not confidently handle, so an error never stalls the pipeline silently.
//
// This service owns three verbs and no more: LIST what is stuck, COUNT it by
// reason, and RETRY one file. Renaming and moving a triaged file deliberately
// do NOT live here -- they are PATCH /files/:id, exactly as they are from the
// Files page. A second code path for "rename this file" is how the read-only
// guard, the audit entry and the filename validation end up applying on one
// page and not the other.
const triageRepository = require("../repositories/triageRepository");
const auditLogRepository = require("../repositories/auditLogRepository");
const { REASONS, REASON_KEYS, retryPlanFor } = require("./triageReasons");
const { enqueueJob } = require("../queues");
const { parsePagination } = require("../utils/pagination");
const { ValidationError } = require("../validators/validationError");

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 404;
    this.publicMessage = message;
  }
}

/** Rejects an unknown ?reason= rather than silently returning the whole queue
 *  -- a typo'd filter that looks like it worked is how you conclude a reason
 *  has no files under it when it has thousands. */
function parseReason(value) {
  if (value === undefined || value === null || value === "") return null;
  if (!REASON_KEYS.includes(value)) {
    throw new ValidationError(`Unknown triage reason "${value}". Valid reasons: ${REASON_KEYS.join(", ")}.`);
  }
  return value;
}

/**
 * The queue itself. Each row carries its reason plus the human-readable
 * explanation and whether retrying it can do anything, so the page never has
 * to keep its own copy of that vocabulary in sync with the backend's.
 */
async function list(query = {}) {
  const { limit, offset } = parsePagination(query);
  const reason = parseReason(query.reason);
  const rows = await triageRepository.list({ reason, limit, offset });

  return rows.map((row) => {
    const meta = REASONS[row.reason];
    const plan = retryPlanFor(row);
    return {
      ...row,
      size_bytes: row.size_bytes === null ? null : Number(row.size_bytes),
      reasonLabel: meta.label,
      reasonExplanation: meta.explanation,
      // What the retry button will actually do, decided here rather than
      // guessed at by the UI -- so the tooltip and the action can't disagree.
      retryable: !plan.blocked,
      retryJobType: plan.blocked ? null : plan.jobType,
      retryBlockedMessage: plan.blocked || null,
    };
  });
}

/** Counts per reason (plus in-flight), for the filter tabs and the nav badge. */
async function summary() {
  const { byReason, total, inFlight } = await triageRepository.countByReason();
  return {
    total,
    inFlight,
    // Every reason is present, including the zeros: a filter list that hides
    // its empty entries makes the remaining ones look like the whole story,
    // the same argument the dashboard's attention rows make.
    reasons: REASON_KEYS.map((key) => ({
      key,
      label: REASONS[key].label,
      explanation: REASONS[key].explanation,
      count: byReason[key] || 0,
    })),
  };
}

/**
 * Re-run the pipeline for one stuck file, starting at the stage that
 * actually needs redoing (see triageReasons.retryPlanFor).
 *
 * Safe to press twice: every stage this can enqueue is idempotent
 * (docs/06-processing-pipeline.md §6.3) -- extraction upserts, hashing
 * rewrites the same hash, classification appends a result row. The cost of a
 * double-click is time, never correctness.
 */
async function retry(fileId, actorUserId) {
  const row = await triageRepository.findOne(fileId);
  if (!row) {
    throw new NotFoundError(
      "This file is not in the triage queue -- it may have been picked up by a job, or already fixed."
    );
  }

  const plan = retryPlanFor(row);
  if (plan.blocked) throw new ValidationError(plan.blocked);

  const job = await enqueueJob(plan.jobType, plan.payload, {
    storageLocationId: row.storage_location_id,
    createdBy: actorUserId,
  });

  await auditLogRepository.record({
    userId: actorUserId,
    action: "triage.retried",
    entityType: "file",
    entityId: fileId,
    previousState: { reason: row.reason, textQuality: row.text_quality, lastJobStatus: row.last_job_status },
    newState: { jobType: plan.jobType, processingJobId: job.id },
    reason: `Retried from the triage queue (${REASONS[row.reason].label}); re-ran ${plan.jobType}.`,
  });

  return { retried: true, fileId, reason: row.reason, jobType: plan.jobType, jobId: job.id };
}

module.exports = { NotFoundError, list, summary, retry };
