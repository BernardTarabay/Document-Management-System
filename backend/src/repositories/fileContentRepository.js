const db = require("../config/database");

// The configurations search_vector is built from (migration 020). The query
// side must use the same set, or a stemmed lexeme in the index is
// unreachable by a query that never produced it.
const SEARCH_CONFIGS = ["simple", "english", "french", "arabic"];

/**
 * OR the same query across every configuration.
 *
 * websearch_to_tsquery gives users the syntax they already expect from a
 * search box -- quoted "exact phrases", OR, and -exclusion -- rather than
 * the raw tsquery operators nobody types. Running it per config and OR-ing
 * the results means "conference" finds the English stem, "conférences"
 * finds the French one, and an Arabic or Hebrew word matches its exact
 * token via 'simple'.
 */
function tsQueryExpression(paramIndex) {
  return SEARCH_CONFIGS.map((c) => `websearch_to_tsquery('${c}', $${paramIndex})`).join(" || ");
}

// Matched as an escape, never as a literal NUL in the source -- a raw 0x00
// byte in a source file is invisible in most editors and does not survive
// copy/paste reliably.
const NUL_PATTERN = new RegExp(String.fromCharCode(0), "g");

/**
 * PostgreSQL text columns cannot hold 0x00 -- not escaped, not encoded, at
 * all. Extractors reach into binary containers (PDF content streams, OLE
 * compound files, OOXML parts) and a stray NUL in the output is normal, not
 * exceptional. Left alone it makes the whole INSERT fail with:
 *
 *   invalid byte sequence for encoding "UTF8": 0x00
 *
 * which cost 312 files on a real 9,398-file folder. A NUL carries no textual
 * meaning, so dropping it loses nothing that was ever readable.
 */
function stripNulls(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  return text.replace(NUL_PATTERN, "");
}

async function upsert(fileId, { extractedText, extractionStatus = "completed", textQuality = null, needsOcr = false }) {
  const text = stripNulls(extractedText);
  try {
    const { rows } = await db.query(
      `INSERT INTO file_content (file_id, extracted_text, extraction_status, text_quality, needs_ocr, extracted_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (file_id) DO UPDATE SET
         extracted_text = EXCLUDED.extracted_text,
         extraction_status = EXCLUDED.extraction_status,
         text_quality = EXCLUDED.text_quality,
         needs_ocr = EXCLUDED.needs_ocr,
         extraction_error = NULL,
         extracted_at = now()
       RETURNING file_id, extraction_status, text_quality, needs_ocr, extracted_at`,
      [fileId, text, extractionStatus, textQuality, needsOcr]
    );
    return rows[0];
  } catch (err) {
    // Last resort. Whatever else goes wrong with this particular text, the
    // file MUST end up with a row: fileRepository.listUnprocessed treats a
    // missing file_content row as "work was lost" and re-queues it on every
    // single scan, so a permanently unstorable document would otherwise loop
    // forever, quietly burning the queue an import is waiting behind.
    //
    // Recording the failure is also the only way it becomes visible -- a
    // file with no row looks identical to one that simply has not been
    // reached yet.
    const { rows } = await db.query(
      `INSERT INTO file_content (file_id, extracted_text, extraction_status, extraction_error, extracted_at)
       VALUES ($1, '', 'failed', $2, now())
       ON CONFLICT (file_id) DO UPDATE SET
         extracted_text = '',
         extraction_status = 'failed',
         extraction_error = EXCLUDED.extraction_error,
         extracted_at = now()
       RETURNING file_id, extraction_status, extracted_at`,
      [fileId, `Could not store extracted text (${(text || "").length} chars): ${err.message}`]
    );
    return rows[0];
  }
}

async function findByFile(fileId) {
  const { rows } = await db.query("SELECT * FROM file_content WHERE file_id = $1", [fileId]);
  return rows[0] || null;
}

/**
 * Copy one file's extracted text onto another, entirely inside the database.
 *
 * Used when a newly-scanned file turns out to be byte-identical to one that
 * has already been through extraction (see jobs/processors/hashProcessor.js).
 * Identical bytes cannot produce different text, so re-parsing would spend
 * real time to arrive at exactly this row.
 *
 * INSERT ... SELECT rather than read-then-write on purpose: some of these
 * documents carry megabytes of extracted text, and pulling that across the
 * wire into Node only to send it straight back is the expensive part of an
 * operation whose whole point is to be cheap. It also means the tsvector is
 * recomputed by the same trigger as any other insert, so the copy is
 * searchable on exactly the same terms as the original.
 */
async function copyFrom(sourceFileId, targetFileId) {
  const { rows } = await db.query(
    `INSERT INTO file_content (file_id, extracted_text, extraction_status, text_quality, needs_ocr, extracted_at)
     SELECT $2, extracted_text, extraction_status, text_quality, needs_ocr, now()
       FROM file_content WHERE file_id = $1
     ON CONFLICT (file_id) DO UPDATE SET
       extracted_text = EXCLUDED.extracted_text,
       extraction_status = EXCLUDED.extraction_status,
       text_quality = EXCLUDED.text_quality,
       needs_ocr = EXCLUDED.needs_ocr,
       extraction_error = NULL,
       extracted_at = now()
     RETURNING file_id, extraction_status, text_quality, needs_ocr`,
    [sourceFileId, targetFileId]
  );
  return rows[0] || null;
}

/** Full-text search across extracted content; returns file_ids ranked by relevance. */
async function searchText(query, { limit = 50, offset = 0 } = {}) {
  const { rows } = await db.query(
    `SELECT file_id, ts_rank(search_vector, ${tsQueryExpression(1)}) AS rank
     FROM file_content
     WHERE search_vector @@ (${tsQueryExpression(1)})
     ORDER BY rank DESC LIMIT $2 OFFSET $3`,
    [query, limit, offset]
  );
  return rows;
}

module.exports = { upsert, copyFrom, findByFile, searchText, stripNulls, tsQueryExpression, SEARCH_CONFIGS };
