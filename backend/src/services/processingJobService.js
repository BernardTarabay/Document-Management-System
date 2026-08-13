const processingJobRepository = require("../repositories/processingJobRepository");
const processingJobItemRepository = require("../repositories/processingJobItemRepository");
const { parsePagination } = require("../utils/pagination");

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 404;
    this.publicMessage = message;
  }
}

async function search(query) {
  const { limit, offset } = parsePagination(query);
  if (!query.status || ["queued", "running", "retrying"].includes(query.status)) {
    return processingJobRepository.listActive({ limit, offset });
  }
  return processingJobRepository.list({ limit, offset });
}

/** Bulk jobs get a per-item status breakdown (spec §22's "96/3/1" reporting shape). */
async function getById(id) {
  const job = await processingJobRepository.findById(id);
  if (!job) throw new NotFoundError("Processing job not found.");
  const itemSummary = await processingJobItemRepository.summaryForJob(id);
  return { ...job, itemSummary };
}

module.exports = { NotFoundError, search, getById };
