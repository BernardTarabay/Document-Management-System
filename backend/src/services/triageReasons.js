// The vocabulary of the triage queue: WHY a file is stuck, and what the
// "retry" button should actually do about it.
//
// WHY THIS IS A SEPARATE, PURE MODULE
//
// The SQL in repositories/triageRepository.js decides which reason a file
// falls under -- it has to, because the queue is filtered, counted and
// paginated by reason, and none of that can happen in JS without pulling the
// whole table across the wire. But the two things you cannot express well in
// SQL are the *explanation* shown to a human and the *retry plan*, and both
// are the parts most likely to be wrong. So they live here, as plain data and
// a pure function, and are unit-tested without a database (tests/triage.test.js).
//
// The keys and their ORDER are shared with the SQL: the repository passes
// REASON_KEYS as a parameter and orders rows by array_position() against it,
// so severity ordering can never drift from this file. Adding a reason here
// without adding it to the CASE in the repository simply means nothing is
// ever labelled with it -- it cannot produce a row the UI does not understand.

const { JobType } = require("../models/enums");

/**
 * Ordered most-serious first. `severity` is implied by position; see
 * REASON_KEYS below.
 *
 * `retryable: false` is not a limitation to be worked around -- it means
 * re-running the pipeline genuinely cannot help, and pretending otherwise
 * would queue work that is certain to fail again.
 */
const REASONS = Object.freeze({
  missing: {
    label: "missing from disk",
    // The bytes are gone, so no amount of re-extraction achieves anything.
    // Only a rescan (which is a per-location operation, not a per-file one)
    // can decide whether it moved, came back, or is really gone.
    retryable: false,
    blockedMessage:
      "This file is no longer where it was found. Re-running the pipeline cannot help -- " +
      "rescan its storage location, which is what reconciles moved, restored and truly " +
      "deleted files.",
    explanation:
      "The file was indexed once but was not there on the last scan. It may have been moved, " +
      "renamed outside Atlas, or be on a drive that is currently unplugged.",
  },
  job_failed: {
    label: "job failed",
    retryable: true,
    explanation:
      "The last background job for this file ended in an error, so whatever stage it was on " +
      "never completed.",
  },
  extraction_failed: {
    label: "text could not be stored",
    retryable: true,
    explanation:
      "Text came out of the file but could not be written to the database -- usually an encoding " +
      "problem in the extracted content rather than a problem with the file itself.",
  },
  stalled: {
    label: "stalled",
    retryable: true,
    explanation:
      "Discovered but never finished: it has no hash or no extracted content, and nothing is " +
      "queued to change that. The next scan of its location repairs this too -- this is not lost " +
      "work, just silent work.",
  },
  needs_ocr: {
    label: "needs OCR",
    retryable: true,
    explanation:
      "A scan or photo with no usable text layer. It keeps its original name on purpose: naming it " +
      "from the noise a scan extracts is how documents end up called things nobody wrote. Retrying " +
      "re-extracts, which only helps if the file itself changed -- OCR is not implemented yet.",
  },
  unreadable: {
    label: "unreadable text",
    retryable: true,
    explanation:
      "Text was extracted but judged unusable, and OCR would not help this format. Nothing " +
      "downstream is allowed to name or classify from it, so it needs a name from you.",
  },
});

/** Severity order, most serious first. Shared with the SQL -- see the note above. */
const REASON_KEYS = Object.freeze(Object.keys(REASONS));

// Every key is a bare identifier. Asserted rather than assumed because the
// repository interpolates nothing but still passes these to array_position,
// and a key with a quote in it would be a latent surprise for anyone who
// later reaches for string interpolation.
for (const key of REASON_KEYS) {
  if (!/^[a-z_]+$/.test(key)) throw new Error(`Invalid triage reason key: ${key}`);
}

/**
 * What re-running the pipeline for this file should actually enqueue.
 *
 * Deliberately per-reason rather than "always re-extract". Each stage chains
 * its own successors (docs/06-processing-pipeline.md §6.1), so the right move
 * is to restart at the EARLIEST stage that has no result yet and let the rest
 * follow -- re-hashing a file that already has a hash is wasted IO, and
 * re-extracting a file that was never hashed leaves the gap that stalled it.
 *
 * @param {object} row - a row from triageRepository (snake_case, as from pg)
 * @returns {{jobType: string, payload: object} | {blocked: string}}
 */
function retryPlanFor(row) {
  const reason = REASONS[row?.reason];
  if (!reason) return { blocked: "This file is not in the triage queue." };
  if (!reason.retryable) return { blocked: reason.blockedMessage };

  // A failed job knows better than any rule here which stage to redo: rerun
  // exactly what failed, with exactly the payload it was given. The payload is
  // reused verbatim so stage-specific arguments survive (detect_duplicates
  // carries `phase`, for instance) -- rebuilding it as `{ fileId }` would
  // silently re-run a different job than the one that failed.
  if (row.reason === "job_failed" && row.last_job_type) {
    return { jobType: row.last_job_type, payload: row.last_job_payload || { fileId: row.id } };
  }

  // No hash means the pipeline never really started for this file. hash
  // chains extract_metadata, extract_text and detect_duplicates itself.
  if (!row.sha256_hash) return { jobType: JobType.HASH, payload: { fileId: row.id } };

  // Everything else is a text problem: re-extract, which re-chains classify
  // and (when the text turns out usable this time) naming.
  return { jobType: JobType.EXTRACT_TEXT, payload: { fileId: row.id } };
}

module.exports = { REASONS, REASON_KEYS, retryPlanFor };
