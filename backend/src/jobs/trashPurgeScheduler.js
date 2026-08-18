// Asks, once a day, whether anything in the Trash has run out its retention.
//
// Modelled on emailSyncScheduler and for the same reason: a plain interval in
// the API process that calls the ordinary enqueueJob, rather than a BullMQ
// repeatable job. This application's invariant is that a job is always a
// processing_jobs row created through enqueueJob (queues/index.js), and a
// scheduler-fired job that skipped that would be invisible on the Processing
// Jobs page and absent from the audit trail. For the one operation that removes
// rows permanently, "no record that it ran" is not an acceptable trade.
//
// The interval is deliberately coarse. Retention is measured in days, so
// checking hourly would buy nothing except a busier job list -- a document
// whose window closes at 3am being removed at noon is exactly as deleted.
const { enqueueJob } = require("../queues");
const { JobType } = require("../models/enums");
const env = require("../config/env");

const INTERVAL_MS = 24 * 60 * 60 * 1000;
// A short delay after boot rather than firing immediately: a server that
// restarts repeatedly should not enqueue a purge on every start.
const FIRST_RUN_DELAY_MS = 5 * 60 * 1000;

let intervalHandle = null;
let firstRunHandle = null;

async function tick() {
  try {
    await enqueueJob(JobType.PURGE_TRASH, { retentionDays: env.trash.retentionDays });
  } catch (err) {
    console.error("[trash-purge-scheduler] Failed to enqueue a purge:", err.message);
  }
}

function startTrashPurgeScheduler() {
  if (intervalHandle) return; // idempotent
  firstRunHandle = setTimeout(tick, FIRST_RUN_DELAY_MS);
  firstRunHandle.unref?.();
  intervalHandle = setInterval(tick, INTERVAL_MS);
  // unref so a graceful shutdown is not held open waiting on a day-long timer.
  intervalHandle.unref();
  console.log(
    `[trash-purge-scheduler] Started -- Trash is emptied after ${env.trash.retentionDays} day(s).`
  );
}

function stopTrashPurgeScheduler() {
  if (firstRunHandle) clearTimeout(firstRunHandle);
  if (intervalHandle) clearInterval(intervalHandle);
  firstRunHandle = null;
  intervalHandle = null;
}

module.exports = { startTrashPurgeScheduler, stopTrashPurgeScheduler };
