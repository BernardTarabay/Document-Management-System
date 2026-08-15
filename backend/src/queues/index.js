// One BullMQ queue per job_type (see docs/06-processing-pipeline.md §6.1).
// This is the ONLY place that should call `new Queue(...)` or `new
// Worker(...)` for a given name -- job processors and API controllers use
// `enqueueJob()` below, never BullMQ directly, so the "a job is always a
// processing_jobs row" invariant (spec §18) can't be bypassed.
const { Queue } = require("bullmq");
const { getRedisConnection } = require("../config/redis");
const processingJobRepository = require("../repositories/processingJobRepository");
const { JobType } = require("../models/enums");

const queues = new Map();

function getQueue(jobType) {
  if (!Object.values(JobType).includes(jobType)) {
    throw new Error(`Unknown job type "${jobType}"`);
  }
  if (!queues.has(jobType)) {
    queues.set(
      jobType,
      new Queue(jobType, {
        connection: getRedisConnection(),
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
          removeOnComplete: { age: 3600 },     // keep BullMQ's own history bounded; source of truth is processing_jobs
          removeOnFail: { age: 24 * 3600 },
        },
      })
    );
  }
  return queues.get(jobType);
}

/**
 * Work out whose archive a job acts on.
 *
 * Tried in order of directness, and every source is an authoritative fact
 * about the work rather than a guess:
 *
 *   1. an explicit ownerUserId from the caller
 *   2. the storage location -- a location belongs to exactly one account
 *   3. the file in the payload -- likewise, and this is what makes the
 *      stage-chaining processors work without threading an owner through
 *      every one of them (hash -> extract_text -> classify -> generate_names
 *      each enqueue the next with only a fileId)
 *   4. the person who asked, for jobs that act on no particular file
 *
 * Deliberately no fifth fallback. If none of these apply the job has no owner,
 * and processingJobRepository.create refuses it -- which surfaces as a failed
 * enqueue at development time instead of a row nobody can see.
 */
async function resolveOwner(jobType, payload = {}, opts = {}) {
  if (opts.ownerUserId) return opts.ownerUserId;

  // Lazy requires: these repositories pull in the ownership helpers, and
  // requiring them at module load creates a cycle back through the services
  // that enqueue jobs.
  if (opts.storageLocationId) {
    const storageLocationRepository = require("../repositories/storageLocationRepository");
    const location = await storageLocationRepository.findById(opts.storageLocationId);
    if (location?.owner_user_id) return location.owner_user_id;
  }

  if (payload?.fileId) {
    const fileRepository = require("../repositories/fileRepository");
    const file = await fileRepository.findById(payload.fileId);
    if (file?.owner_user_id) return file.owner_user_id;
  }

  return opts.createdBy || null;
}

/**
 * Create the `processing_jobs` row (source of truth) AND enqueue the BullMQ
 * job that will act on it, atomically enough for our purposes: the DB row is
 * created first, so even if the Redis enqueue fails, the job is visible as
 * failed/stuck rather than invisible.
 *
 * OWNERSHIP
 *
 * Every job belongs to exactly one account, because every job acts on exactly
 * one account's files. `ownerUserId` is required; when it is not supplied
 * explicitly it is resolved from the storage location, which is the other
 * thing that carries an owner. A job that could be created without one would
 * be invisible on its owner's Jobs page and visible on everyone else's, so
 * this refuses rather than defaulting.
 *
 * @param {string} jobType - one of JobType
 * @param {object} payload - job-specific input (e.g. { storageLocationId } for scan, { fileId } for hash)
 * @param {object} [opts]
 * @param {string} [opts.storageLocationId]
 * @param {string} [opts.ownerUserId] - whose archive this acts on; derived from
 *   the storage location when omitted
 * @param {string} [opts.createdBy] - user id, or null for system-initiated jobs
 * @param {number} [opts.progressTotal]
 */
async function enqueueJob(jobType, payload, opts = {}) {
  const ownerUserId = await resolveOwner(jobType, payload, opts);

  const jobRow = await processingJobRepository.create({
    jobType,
    storageLocationId: opts.storageLocationId || null,
    payload,
    createdBy: opts.createdBy || null,
    ownerUserId,
    progressTotal: opts.progressTotal || 0,
  });

  const queue = getQueue(jobType);
  let bullJob;
  try {
    bullJob = await queue.add(
      jobType,
      { processingJobId: jobRow.id, ...payload },
      { jobId: jobRow.id } // reuse our UUID as the BullMQ job id -- one id to look up everywhere
    );
  } catch (err) {
    // The header above promised that a failed Redis enqueue leaves the job
    // "visible as failed/stuck rather than invisible". It did not: the row was
    // left at 'queued' with nothing on any queue to ever move it, and that is
    // considerably worse than invisible. fileRepository.listUnprocessed --
    // the self-healing rescan that exists precisely to rescue stranded files
    // -- skips any file with a 'queued' or 'running' job, on the reasonable
    // assumption that such a file is merely waiting its turn. So a Redis blip
    // during a scan left the file permanently excluded from the one mechanism
    // built to recover it.
    //
    // Marking the row failed restores the promise: it is visible on the
    // Processing Jobs page, and the next scan picks the file back up.
    await processingJobRepository
      .markFailed(jobRow.id, `Could not enqueue on Redis: ${err.message}`)
      .catch(() => { /* the original error is the one worth reporting */ });
    throw err;
  }

  await processingJobRepository.attachBullMqId(jobRow.id, bullJob.id);
  return jobRow;
}

async function closeAllQueues() {
  await Promise.all([...queues.values()].map((q) => q.close()));
}

module.exports = { getQueue, enqueueJob, closeAllQueues };
