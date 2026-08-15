const processingJobRepository = require("../repositories/processingJobRepository");
const processingJobItemRepository = require("../repositories/processingJobItemRepository");
const { parsePagination } = require("../utils/pagination");
const { requireOwner } = require("../repositories/ownership");

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 404;
    this.publicMessage = message;
  }
}

/**
 * The Jobs page and the floating jobs dock.
 *
 * Scoped on `owner_user_id`, not `created_by`. The two differ exactly when
 * the system acts on its own -- the watcher's periodic rescan of your folder
 * has no creator but is unmistakably your job. Filtering on created_by would
 * have hidden every automatic job from the person whose files it is
 * processing, which reads as "the background work has stopped happening".
 */
async function search(query, ownerUserId) {
  requireOwner(ownerUserId, "processingJobService.search");
  const { limit, offset } = parsePagination(query);
  const status = query.status || null;
  const jobType = query.jobType || null;

  if (!status || ["queued", "running", "retrying"].includes(status)) {
    // The dock's default view: whatever is in flight right now.
    if (!status && !jobType) return processingJobRepository.listActive(ownerUserId, { limit, offset });
  }
  return processingJobRepository.listForOwner(ownerUserId, { limit, offset, status, jobType });
}

async function count(query, ownerUserId) {
  requireOwner(ownerUserId, "processingJobService.count");
  return {
    count: await processingJobRepository.countForOwner(ownerUserId, {
      status: query.status || null,
      jobType: query.jobType || null,
    }),
  };
}

/** Bulk jobs get a per-item status breakdown (spec §22's "96/3/1" reporting shape). */
async function getById(id, ownerUserId) {
  const job = await processingJobRepository.findByIdForOwner(id, ownerUserId);
  if (!job) throw new NotFoundError("Processing job not found.");
  const itemSummary = await processingJobItemRepository.summaryForJob(id);
  return { ...job, itemSummary };
}

module.exports = { NotFoundError, search, count, getById };
