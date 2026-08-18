// Emptying the Trash, on a timer.
//
// WHAT MAKES THIS SAFE ENOUGH TO RUN UNATTENDED
//
// It is the only thing in this application that removes rows for good, and it
// does so with nobody watching. Three properties earn it that:
//
//   1. It selects on elapsed time alone. Not on a filter, not on anything a
//      request supplied -- only "has this been in the Trash longer than the
//      retention window". There is no input to get wrong.
//   2. The window IS the confirmation. A user putting something in the Trash
//      has been told it will be removed after N days, and has that whole period
//      to change their mind. Nothing is destroyed that was not both chosen and
//      then left alone for a month.
//   3. It never touches your disk. Purging removes Atlas's record of a file.
//      The file itself is untouched -- this application never deletes the
//      originals it indexes -- so a purged file that still exists on disk is
//      simply re-imported by the next scan, which is correct: it is still
//      there, and this is a catalogue of what is there.
//
// Deliberately batched and re-queued rather than looping until empty: an
// unbounded delete on a repository that has been accumulating for months is a
// long transaction holding locks against live work.
const lifecycleService = require("../../services/lifecycleService");
const auditLogRepository = require("../../repositories/auditLogRepository");
const db = require("../../config/database");
const env = require("../../config/env");

const BATCH_SIZE = 500;

async function handle(payload = {}) {
  const retentionDays = payload.retentionDays || env.trash.retentionDays;
  const expired = await lifecycleService.findExpired({ retentionDays, limit: BATCH_SIZE });

  if (expired.length === 0) {
    return { purged: 0, retentionDays, message: "Nothing in the Trash is old enough to remove." };
  }

  // One audit entry per file, written BEFORE the row goes: entity_id will
  // point at something that no longer exists, and this record is the only
  // remaining evidence the document was ever catalogued.
  for (const file of expired) {
    await auditLogRepository.record({
      userId: null,
      action: "file.purged",
      entityType: "file",
      entityId: file.id,
      previousState: { filename: file.filename_current, deletedAt: file.deleted_at },
      reason:
        `Removed from the Trash automatically after ${retentionDays} days. ` +
        "The original file on disk was not touched.",
    });
  }

  const ids = expired.map((f) => f.id);
  await db.query("DELETE FROM files WHERE id = ANY($1::uuid[])", [ids]);

  return {
    purged: ids.length,
    retentionDays,
    // Told rather than inferred, so a scheduler can decide to run again
    // immediately instead of waiting a day to clear a backlog.
    more: expired.length === BATCH_SIZE,
  };
}

module.exports = { handle, BATCH_SIZE };
