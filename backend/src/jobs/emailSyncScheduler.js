// Periodic "auto" half of email inbox triage. Deliberately NOT a BullMQ
// native repeatable job (Queue.upsertJobScheduler) -- this app's own
// invariant (queues/index.js: "a job is always a processing_jobs row,
// created via enqueueJob") would be silently broken by a scheduler-fired
// job that never went through enqueueJob first. Instead, this is a plain
// interval, running in the API process, that calls the exact same
// enqueueJob() every manual "Sync now" click already goes through -- so a
// scheduled sync and a manual one are indistinguishable to everything
// downstream (Processing Jobs page, audit log, the worker itself).
const emailAccountRepository = require("../repositories/emailAccountRepository");
const { enqueueJob } = require("../queues");
const { JobType, EmailAccountStatus } = require("../models/enums");
const env = require("../config/env");

let intervalHandle = null;

async function tick() {
  let accounts;
  try {
    accounts = await emailAccountRepository.listConnected();
  } catch (err) {
    console.error("[email-sync-scheduler] Failed to list connected accounts:", err.message);
    return;
  }

  for (const account of accounts) {
    if (account.status !== EmailAccountStatus.CONNECTED) continue;
    try {
      await enqueueJob(JobType.EMAIL_SYNC, { emailAccountId: account.id });
    } catch (err) {
      console.error(`[email-sync-scheduler] Failed to enqueue sync for ${account.id}:`, err.message);
    }
  }
}

function startEmailSyncScheduler() {
  if (intervalHandle) return; // idempotent -- calling this twice is a no-op
  const intervalMs = Math.max(1, env.email.syncIntervalMinutes) * 60 * 1000;
  intervalHandle = setInterval(tick, intervalMs);
  // Node's default behavior keeps the process alive purely because of this
  // timer -- fine for the long-running server process, but unref() means a
  // graceful shutdown (server.close()) isn't blocked waiting on it.
  intervalHandle.unref();
  console.log(`[email-sync-scheduler] Started -- syncing connected accounts every ${env.email.syncIntervalMinutes} minute(s).`);
}

function stopEmailSyncScheduler() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

module.exports = { startEmailSyncScheduler, stopEmailSyncScheduler };
