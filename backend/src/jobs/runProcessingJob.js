// Generic wrapper every job processor is run through. Owns the
// processing_jobs row lifecycle (queued -> running -> completed/failed) so
// individual processors only implement their domain logic and never
// duplicate this bookkeeping (see docs/06-processing-pipeline.md §6.3/§6.6).
const processingJobRepository = require("../repositories/processingJobRepository");

/**
 * @param {import('bullmq').Job} bullJob
 * @param {(payload: object, bullJob: import('bullmq').Job) => Promise<object>} handler
 */
async function runProcessingJob(bullJob, handler) {
  const { processingJobId, ...payload } = bullJob.data;

  await processingJobRepository.markStarted(processingJobId);
  try {
    const result = await handler(payload, bullJob);
    await processingJobRepository.markCompleted(processingJobId, result || null);
    return result;
  } catch (err) {
    await processingJobRepository.markFailed(processingJobId, err.message);
    throw err; // rethrow so BullMQ's retry/backoff (queues/index.js) still applies
  }
}

module.exports = { runProcessingJob };
