// The triage queue: every file the pipeline could not confidently handle,
// in one place, with the reason attached.
//
// WHY THIS EXISTS
//
// The failures were all already recorded -- they were just recorded in six
// different places, none of which was a list you could work through.
// `file_content.text_quality` said a document was unreadable, `needs_ocr`
// said OCR would help, a missing `file_content` row said the work was
// dropped, a failed `processing_jobs` row said a stage errored, and
// `files.status = 'missing'` said the bytes are gone. A user's actual
// question -- "which of my files did this thing fail on, and what do I do
// about each one?" -- had no answer short of running SQL.
//
// The consequence was worse than inconvenience: an error stalled the
// pipeline silently. A file with no content row is invisible to search,
// looks identical to one that simply has not been reached yet, and nothing
// on any page said otherwise.
//
// ONE QUERY, NOT SIX
//
// Every reason is derived in a single CASE over one pass of `files`, so a
// file appears exactly once under its most serious reason rather than once
// per problem it has. That also makes the queue filterable and countable by
// reason without the API pulling rows into JS to categorize them -- the same
// argument dashboardRepository makes for counting in SQL.
//
// WHAT IS DELIBERATELY NOT IN HERE
//
// Files with a queued or running job. They are not stuck, they are waiting
// their turn, and a big import would otherwise dump tens of thousands of
// perfectly healthy files into a queue meant to hold the exceptions. The
// summary reports that number separately so a shrinking triage list during
// an import is legible rather than mysterious.
const db = require("../config/database");
const { REASON_KEYS } = require("../services/triageReasons");

// Identical to the predicate in fileRepository.countBacklogByLocation and
// dashboardRepository.attention, on purpose: "stalled" must mean the same
// number on the Storage Locations page, the dashboard and here, or one of
// the three looks like a bug. ('retrying' is in the job_status enum but no
// processor ever writes it -- see runProcessingJob.js.)
const HAS_ACTIVE_JOB = `
  SELECT 1 AS present FROM processing_jobs pj
   WHERE pj.status IN ('queued', 'running')
     AND pj.payload->>'fileId' = f.id::text
   LIMIT 1
`;

// BullMQ retries a failed job up to three times with exponential backoff
// (queues/index.js), and the processing_jobs row sits at 'failed' in between
// attempts -- so a job that is about to succeed on attempt two looks
// identical to one that has given up. The grace window is comfortably longer
// than the whole retry ladder (5s, 10s, 20s), so a job still in it has
// genuinely stopped rather than merely paused.
const FAILED_JOB_GRACE = "5 minutes";

/**
 * The reason CASE, in priority order -- a file with three problems is listed
 * under the most serious one, because that is the one whose fix comes first.
 *
 * Two subtleties worth not "simplifying" away:
 *
 *   text_quality IS NULL is NOT a problem. NULL means "indexed before the
 *   quality check existed, never judged", which migration 023 deliberately
 *   keeps distinct from 'ok'. Treating it as unreadable would drop the entire
 *   pre-023 backfill into the queue as if it had failed.
 *
 *   The last job is matched on payload->>'fileId', so repository-wide jobs
 *   (scan, bulk_rename, bulk_delete) can never be attributed to a single
 *   file -- their payloads have no fileId.
 *
 * THE TWO TEXT-QUALITY REASONS CLEAR WHEN THE FILE HAS BEEN NAMED
 *
 * `needs_ocr` and `unreadable` are not really "this file is broken" -- they
 * are "the pipeline could not name this file, so it needs you". Once a
 * canonical name exists, that request has been answered, and leaving the row
 * in the queue forever would mean the queue can never be emptied, which is
 * the difference between a worklist and a wall of text. The other four
 * reasons are genuine pipeline gaps and a name does not fix them.
 *
 * Caveat worth knowing: `canonical_filename` is what a rename writes on a
 * READ-ONLY location (the deployment this runs in -- see
 * fileRepository.setCanonicalName). A manual rename on a WRITABLE location
 * renames the real file and updates filename_current instead, so such a file
 * stays listed here with its new name showing. That is visible and mildly
 * annoying rather than wrong; giving it a "dismissed" flag would be a new
 * piece of state, and inventing one was not worth it for a case this
 * deployment does not hit.
 */
const REASON_CASE = `
  CASE
    WHEN f.status = 'missing'                                  THEN 'missing'
    WHEN lj.status = 'failed'
     AND lj.finished_at < now() - interval '${FAILED_JOB_GRACE}' THEN 'job_failed'
    WHEN fc.extraction_status = 'failed'                       THEN 'extraction_failed'
    WHEN f.sha256_hash IS NULL OR fc.file_id IS NULL            THEN 'stalled'
    WHEN f.canonical_filename IS NOT NULL                      THEN NULL
    WHEN fc.needs_ocr                                          THEN 'needs_ocr'
    WHEN fc.text_quality IS NOT NULL
     AND fc.text_quality <> 'ok'                               THEN 'unreadable'
  END
`;

// The shared body. Kept as one string rather than duplicated between the
// list and the counts so the two can never disagree about what is in the
// queue -- a summary that says 40 above a table showing 38 is worse than no
// summary at all.
const TRIAGED = `
  SELECT f.id,
         f.filename_current,
         f.filename_original,
         f.canonical_filename,
         f.current_path,
         f.extension,
         f.size_bytes,
         f.status,
         f.sha256_hash,
         f.imported_at,
         f.document_date,
         f.document_date_source,
         f.ai_short_title,
         f.storage_location_id,
         sl.name          AS location_name,
         sl.is_read_only  AS location_is_read_only,
         fc.text_quality,
         fc.needs_ocr,
         fc.extraction_status,
         fc.extraction_error,
         lj.job_type      AS last_job_type,
         lj.status        AS last_job_status,
         lj.error_message AS last_job_error,
         lj.finished_at   AS last_job_finished_at,
         lj.payload       AS last_job_payload,
         cls.subject_id,
         cls.subject_name,
         ${REASON_CASE} AS reason
    FROM files f
    JOIN storage_locations sl ON sl.id = f.storage_location_id
    LEFT JOIN file_content fc ON fc.file_id = f.id
    LEFT JOIN LATERAL (${HAS_ACTIVE_JOB}) active ON true
    LEFT JOIN LATERAL (
      SELECT pj.job_type, pj.status, pj.error_message, pj.finished_at, pj.payload
        FROM processing_jobs pj
       WHERE pj.payload->>'fileId' = f.id::text
       ORDER BY pj.created_at DESC
       LIMIT 1
    ) lj ON true
    LEFT JOIN LATERAL (
      SELECT s.id AS subject_id, s.name AS subject_name
        FROM classification_results cr
        JOIN subjects s ON s.id = cr.classified_subject_id
       WHERE cr.file_id = f.id AND cr.classified_subject_id IS NOT NULL
       ORDER BY cr.created_at DESC LIMIT 1
    ) cls ON true
   WHERE f.status IN ('active', 'missing')
     AND active.present IS NULL
`;

/**
 * One page of the queue.
 *
 * Ordered by severity and then newest-first. Severity comes from
 * array_position() against the key list exported by triageReasons.js rather
 * than a second CASE, so the order shown can never drift from the order that
 * module documents.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.reason] - restrict to one reason key
 */
async function list({ reason = null, limit = 50, offset = 0 } = {}) {
  const { rows } = await db.query(
    `WITH triaged AS (${TRIAGED})
     SELECT * FROM triaged
      WHERE reason IS NOT NULL
        AND ($1::text IS NULL OR reason = $1)
      ORDER BY array_position($2::text[], reason), imported_at DESC
      LIMIT $3 OFFSET $4`,
    [reason, [...REASON_KEYS], limit, offset]
  );
  return rows;
}

/** One file's triage row, or null if it is not in the queue. */
async function findOne(fileId) {
  const { rows } = await db.query(
    `WITH triaged AS (${TRIAGED})
     SELECT * FROM triaged WHERE id = $1 AND reason IS NOT NULL`,
    [fileId]
  );
  return rows[0] || null;
}

/**
 * How many files sit under each reason, plus the in-flight count.
 *
 * The in-flight number is not decoration: during an import the queue is
 * small because most files are still being worked on, and without that
 * number a user watching triage would reasonably conclude the import had
 * finished.
 */
async function countByReason() {
  const [{ rows: byReason }, { rows: inFlight }] = await Promise.all([
    db.query(
      `WITH triaged AS (${TRIAGED})
       SELECT reason, count(*)::int AS count
         FROM triaged WHERE reason IS NOT NULL GROUP BY reason`
    ),
    db.query(
      `SELECT count(*)::int AS count
         FROM files f
        WHERE f.status = 'active'
          AND EXISTS (${HAS_ACTIVE_JOB})`
    ),
  ]);

  return {
    byReason: Object.fromEntries(byReason.map((r) => [r.reason, r.count])),
    total: byReason.reduce((sum, r) => sum + r.count, 0),
    inFlight: inFlight[0].count,
  };
}

module.exports = { list, findOne, countByReason };
