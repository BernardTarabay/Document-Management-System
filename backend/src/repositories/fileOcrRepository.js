// OCR results, one row per file.
//
// Kept out of `file_content` on purpose. That table holds text the document
// ACTUALLY CONTAINED; this one holds a machine's reading of a picture, with
// the engine, the languages and the confidence that produced it. The two are
// different claims and the naming pipeline treats them differently -- see the
// header of services/ocr/ocrService.js.
const db = require("../config/database");
const { NOT_A_DUPLICATE_COPY } = require("./fileFilters");
const { requireOwner } = require("./ownership");

/**
 * Upsert, because OCR is re-runnable.
 *
 * COALESCE on every optional column so a partial update -- "mark this running"
 * -- cannot blank the text and confidence from a previous successful pass.
 * Without that, pressing retry on a file that already had text would erase the
 * text first and then, if the retry failed, leave the user with less than they
 * started with.
 */
async function upsert(fileId, {
  status, engine, engineVersion, languages, confidence,
  pageCount, text, errorMessage, startedAt, completedAt,
} = {}) {
  const { rows } = await db.query(
    `INSERT INTO file_ocr (
       file_id, status, engine, engine_version, languages, confidence,
       page_count, text, error_message, started_at, completed_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (file_id) DO UPDATE SET
       status         = EXCLUDED.status,
       engine         = COALESCE(EXCLUDED.engine,         file_ocr.engine),
       engine_version = COALESCE(EXCLUDED.engine_version, file_ocr.engine_version),
       languages      = COALESCE(EXCLUDED.languages,      file_ocr.languages),
       confidence     = COALESCE(EXCLUDED.confidence,     file_ocr.confidence),
       page_count     = COALESCE(EXCLUDED.page_count,     file_ocr.page_count),
       text           = COALESCE(EXCLUDED.text,           file_ocr.text),
       -- error_message is the exception: it must be CLEARABLE, or a file that
       -- failed once and then succeeded would keep showing the old error next
       -- to its new text.
       error_message  = EXCLUDED.error_message,
       started_at     = COALESCE(EXCLUDED.started_at,     file_ocr.started_at),
       completed_at   = COALESCE(EXCLUDED.completed_at,   file_ocr.completed_at),
       updated_at     = now()
     RETURNING *`,
    [
      fileId, status || "pending", engine || null, engineVersion || null,
      languages || null, confidence ?? null, pageCount ?? null,
      text ?? null, errorMessage ?? null, startedAt || null, completedAt || null,
    ]
  );
  return rows[0];
}

async function findByFile(fileId) {
  const { rows } = await db.query("SELECT * FROM file_ocr WHERE file_id = $1", [fileId]);
  return rows[0] || null;
}

/** Owner-scoped read, for the Photos workspace and the file detail panel. */
async function findByFileForOwner(fileId, ownerUserId) {
  requireOwner(ownerUserId, "fileOcr.findByFileForOwner");
  const { rows } = await db.query(
    `SELECT o.* FROM file_ocr o
       JOIN files f ON f.id = o.file_id
      WHERE o.file_id = $1 AND f.owner_user_id = $2`,
    [fileId, ownerUserId]
  );
  return rows[0] || null;
}

/** Counts for the Photos workspace tabs. Always every key, including zeros --
 *  a tab that disappears when empty makes the remaining ones look like the
 *  whole story. */
async function countByStatus(ownerUserId) {
  requireOwner(ownerUserId, "fileOcr.countByStatus");
  const { rows } = await db.query(
    // Same definition of "a document" the Library and the dashboard use
    // (fileFilters.NOT_A_DUPLICATE_COPY): the badge on the Photos tab counts
    // pictures, and a second copy of a picture is not a second picture. Without
    // this the grid showed 16 and the badge said 18.
    `SELECT f.ocr_status::text AS status, count(*)::int AS count
       FROM files f
      WHERE f.owner_user_id = $1
        AND f.status = 'active'
        AND ${NOT_A_DUPLICATE_COPY}
        AND (f.is_image = true OR f.ocr_status <> 'not_needed')
      GROUP BY f.ocr_status`,
    [ownerUserId]
  );
  const counts = Object.fromEntries(rows.map((r) => [r.status, r.count]));
  for (const key of ["not_needed", "pending", "queued", "running", "completed", "failed", "unavailable"]) {
    if (!(key in counts)) counts[key] = 0;
  }
  counts.total = rows.reduce((sum, r) => sum + r.count, 0);
  return counts;
}

module.exports = { upsert, findByFile, findByFileForOwner, countByStatus };
