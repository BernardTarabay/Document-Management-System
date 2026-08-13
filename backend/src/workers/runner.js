// Worker process entrypoint (spec architecture diagram: "Processing Workers"
// is a separate box from the API). Run with `npm run worker` -- this is
// intentionally never imported by src/server.js; the API process enqueues
// jobs, this process (one or more instances, possibly on different
// machines) executes them.
const { Worker } = require("bullmq");
const { getRedisConnection } = require("../config/redis");
const { runProcessingJob } = require("../jobs/runProcessingJob");
const { PROCESSORS } = require("../jobs");

const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || "4", 10);

const workers = Object.entries(PROCESSORS).map(([jobType, processor]) => {
  const worker = new Worker(
    jobType,
    (bullJob) => runProcessingJob(bullJob, processor.handle),
    { connection: getRedisConnection(), concurrency: CONCURRENCY }
  );

  worker.on("completed", (job) => {
    console.log(`[worker:${jobType}] completed job ${job.id}`);
  });
  worker.on("failed", (job, err) => {
    console.error(`[worker:${jobType}] failed job ${job?.id}:`, err.message);
  });

  return worker;
});

console.log(`[worker] Started ${workers.length} worker(s): ${Object.keys(PROCESSORS).join(", ")}`);

async function shutdown(signal) {
  console.log(`[worker] Received ${signal}, closing workers...`);
  await Promise.all(workers.map((w) => w.close()));
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
