// Aggregates for the dashboard.
//
// WHY THIS EXISTS
//
// The dashboard used to fetch `/files?limit=200` and render `files.length`.
// On a 9,398-file repository it therefore reported "200 files tracked" -- not
// a rounding error, a hard ceiling, and the same bug applied to proposals,
// duplicates and jobs. It also dragged 200 fully-decorated file rows across
// the wire (each with a subject lateral join and a rename-proposal lateral
// join) purely to take the length of the array.
//
// Counting is the database's job. Everything here is a COUNT/SUM over the
// whole table, so the numbers are true at any scale and the payload is a few
// hundred bytes instead of a few hundred rows.
//
// The one deliberate exception is the jobs window: "what has the pipeline
// been doing lately" is a genuinely time-bounded question, so it is scoped to
// a recent interval and says so on screen.

const db = require("../config/database");

// A file counts as "in the repository" unless it has been deleted. Missing
// files (the drive is unplugged) still count -- they are known documents, and
// hiding them would make the total silently shrink when a disk goes offline.
const LIVE = "f.status <> 'deleted'";

/**
 * Headline totals plus the processing funnel, in one pass over `files`.
 *
 * One query rather than six: these are all counts over the same rows with
 * different filters, which is exactly what FILTER is for, and it means the
 * numbers are mutually consistent -- six separate queries could interleave
 * with the worker and report a funnel where a later stage exceeds an earlier
 * one.
 */
async function overview() {
  const { rows } = await db.query(
    `SELECT
       count(*)::int                                                        AS total_files,
       coalesce(sum(f.size_bytes), 0)::bigint                               AS total_bytes,
       count(*) FILTER (WHERE f.status = 'missing')::int                    AS missing,
       count(*) FILTER (WHERE f.is_cloud_placeholder)::int                  AS placeholders,
       count(*) FILTER (WHERE f.sha256_hash IS NOT NULL)::int               AS hashed,
       count(*) FILTER (WHERE fc.file_id IS NOT NULL)::int                  AS extracted,
       count(*) FILTER (WHERE fc.text_quality = 'ok')::int                  AS searchable,
       count(*) FILTER (WHERE fc.needs_ocr)::int                            AS needs_ocr,
       count(*) FILTER (WHERE cls.subject_id IS NOT NULL)::int              AS classified,
       count(*) FILTER (WHERE f.canonical_filename IS NOT NULL)::int        AS named
     FROM files f
     LEFT JOIN file_content fc ON fc.file_id = f.id
     LEFT JOIN LATERAL (
       SELECT cr.classified_subject_id AS subject_id
       FROM classification_results cr
       WHERE cr.file_id = f.id AND cr.classified_subject_id IS NOT NULL
       ORDER BY cr.created_at DESC LIMIT 1
     ) cls ON true
     WHERE ${LIVE}`
  );
  return rows[0];
}

/**
 * Everything that is waiting on a human, with the number attached.
 *
 * Deliberately one row of counts rather than a list of items: the dashboard's
 * job is to say "there are 3,412 suggestions worth clearing", and the page
 * that can actually clear them is one click away.
 */
async function attention() {
  const { rows } = await db.query(
    `SELECT
       (SELECT count(*)::int FROM rename_proposals WHERE status = 'pending')                    AS pending_proposals,
       (SELECT count(*)::int FROM rename_proposals WHERE status = 'pending' AND confidence_score <= 0)
                                                                                                AS zero_confidence_proposals,
       (SELECT count(*)::int FROM duplicate_groups WHERE status = 'open' AND group_type = 'exact')
                                                                                                AS open_exact_duplicates,
       (SELECT count(*)::int FROM duplicate_groups WHERE status = 'open' AND group_type = 'probable')
                                                                                                AS open_probable_duplicates,
       (SELECT count(*)::int FROM file_content WHERE needs_ocr)                                 AS needs_ocr,
       (SELECT count(*)::int FROM files f
          WHERE ${LIVE} AND f.status = 'active'
            AND NOT EXISTS (SELECT 1 FROM classification_results cr
                             WHERE cr.file_id = f.id AND cr.classified_subject_id IS NOT NULL)) AS unfiled,
       -- Discovered but going nowhere: no hash or no content row, and no job
       -- queued to change that. The self-healing scan repairs these, so a
       -- non-zero number here means "the next scan has work to do", not
       -- "these are lost".
       (SELECT count(*)::int FROM files f
          WHERE f.status = 'active'
            AND (f.sha256_hash IS NULL
                 OR NOT EXISTS (SELECT 1 FROM file_content fc WHERE fc.file_id = f.id))
            AND NOT EXISTS (SELECT 1 FROM processing_jobs pj
                             WHERE pj.status IN ('queued','running')
                               AND pj.payload->>'fileId' = f.id::text))                         AS stalled,
       (SELECT count(*)::int FROM processing_jobs WHERE status IN ('queued','running'))         AS jobs_in_flight,
       (SELECT count(*)::int FROM processing_jobs
         WHERE status = 'failed' AND finished_at > now() - interval '24 hours')                 AS jobs_failed_today`
  );
  return rows[0];
}

/**
 * Bytes held by duplicate copies that are not the canonical one.
 *
 * The single most concrete number this app can show someone with a drive
 * they think is too full: not "you have 412 duplicate groups" but "there is
 * 6.1 GB sitting in copies of things you already have". Only EXACT groups
 * count -- probable ones are unconfirmed guesses and it would be dishonest
 * to put their bytes in a "reclaimable" figure.
 */
async function reclaimableBytes() {
  const { rows } = await db.query(
    `SELECT coalesce(sum(f.size_bytes), 0)::bigint AS bytes,
            count(*)::int                          AS copies
       FROM duplicate_group_members dgm
       JOIN duplicate_groups dg ON dg.id = dgm.duplicate_group_id
       JOIN files f ON f.id = dgm.file_id
      WHERE dg.group_type = 'exact'
        AND f.status <> 'deleted'
        -- Every member EXCEPT the one kept. When a group has no canonical
        -- pick yet, all but one copy is still redundant, so charge the group
        -- for (members - 1) by excluding the earliest-imported member.
        AND f.id <> COALESCE(
              dg.canonical_file_id,
              (SELECT f2.id FROM duplicate_group_members m2
                 JOIN files f2 ON f2.id = m2.file_id
                WHERE m2.duplicate_group_id = dg.id
                ORDER BY f2.imported_at ASC LIMIT 1))`
  );
  return rows[0];
}

/**
 * File types, ordered by how much of the repository they represent, with how
 * much of each is actually readable.
 *
 * The coverage column is the point. "1,599 PDFs" is trivia; "1,599 PDFs, 61%
 * readable" is the OCR argument, and it is the difference between a search
 * box that finds things and one that quietly does not.
 */
async function byExtension(limit = 10) {
  const { rows } = await db.query(
    `SELECT lower(coalesce(nullif(f.extension, ''), '(none)')) AS ext,
            count(*)::int                                       AS files,
            coalesce(sum(f.size_bytes), 0)::bigint              AS bytes,
            count(*) FILTER (WHERE fc.text_quality = 'ok')::int  AS searchable
       FROM files f
       LEFT JOIN file_content fc ON fc.file_id = f.id
      WHERE ${LIVE}
      GROUP BY 1
      ORDER BY files DESC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

/** Per-location totals, so "which folder is all of this coming from" is answerable. */
async function byLocation() {
  const { rows } = await db.query(
    `SELECT s.id, s.name, s.root_path, s.is_read_only,
            count(f.id)::int                                     AS files,
            coalesce(sum(f.size_bytes), 0)::bigint               AS bytes,
            count(f.id) FILTER (WHERE f.canonical_filename IS NOT NULL)::int AS named,
            max(fs.finished_at)                                  AS last_scan
       FROM storage_locations s
       LEFT JOIN files f ON f.storage_location_id = s.id AND f.status <> 'deleted'
       LEFT JOIN filesystem_scans fs ON fs.storage_location_id = s.id AND fs.status = 'completed'
      GROUP BY s.id, s.name, s.root_path, s.is_read_only
      ORDER BY files DESC`
  );
  return rows;
}

/** What the pipeline has been doing lately, by job type. */
async function recentJobs(hours = 24) {
  const { rows } = await db.query(
    `SELECT job_type,
            count(*) FILTER (WHERE status = 'completed')::int AS completed,
            count(*) FILTER (WHERE status = 'failed')::int    AS failed,
            count(*) FILTER (WHERE status IN ('queued','running'))::int AS active
       FROM processing_jobs
      WHERE created_at > now() - make_interval(hours => $1)
      GROUP BY job_type
      HAVING count(*) > 0
      ORDER BY 2 DESC, 1`,
    [hours]
  );
  return rows;
}

/** Files added per day, for the "is this thing still ingesting" question. */
async function ingestionTrend(days = 14) {
  const { rows } = await db.query(
    `SELECT d::date AS day, coalesce(c.n, 0)::int AS files
       FROM generate_series(now()::date - ($1::int - 1), now()::date, interval '1 day') d
       LEFT JOIN (
         SELECT imported_at::date AS day, count(*) AS n
           FROM files
          WHERE status <> 'deleted' AND imported_at > now() - make_interval(days => $1)
          GROUP BY 1
       ) c ON c.day = d::date
      ORDER BY day`,
    [days]
  );
  return rows;
}

module.exports = {
  overview, attention, reclaimableBytes, byExtension, byLocation, recentJobs, ingestionTrend,
};
