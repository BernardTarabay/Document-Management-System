const db = require("../config/database");

async function upsert(fileId, { extractor, extractorVersion, metadata, extractionStatus = "completed" }) {
  const { rows } = await db.query(
    `INSERT INTO file_metadata (file_id, extractor, extractor_version, metadata, extraction_status, extracted_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (file_id) DO UPDATE SET
       extractor = EXCLUDED.extractor,
       extractor_version = EXCLUDED.extractor_version,
       metadata = EXCLUDED.metadata,
       extraction_status = EXCLUDED.extraction_status,
       extracted_at = now()
     RETURNING *`,
    [fileId, extractor, extractorVersion, metadata, extractionStatus]
  );
  return rows[0];
}

async function findByFile(fileId) {
  const { rows } = await db.query("SELECT * FROM file_metadata WHERE file_id = $1", [fileId]);
  return rows[0] || null;
}

/** Copy one file's extracted metadata onto another -- see
 *  fileContentRepository.copyFrom for why identical bytes are allowed to
 *  share a result rather than being parsed twice. */
async function copyFrom(sourceFileId, targetFileId) {
  const { rows } = await db.query(
    `INSERT INTO file_metadata (file_id, extractor, extractor_version, metadata, extraction_status, extracted_at)
     SELECT $2, extractor, extractor_version, metadata, extraction_status, now()
       FROM file_metadata WHERE file_id = $1
     ON CONFLICT (file_id) DO UPDATE SET
       extractor = EXCLUDED.extractor,
       extractor_version = EXCLUDED.extractor_version,
       metadata = EXCLUDED.metadata,
       extraction_status = EXCLUDED.extraction_status,
       extracted_at = now()
     RETURNING *`,
    [sourceFileId, targetFileId]
  );
  return rows[0] || null;
}

/**
 * How many OTHER files carry this exact embedded title.
 *
 * A title shared across many documents is the template's title, not the
 * document's -- typically the organisation's name, left in place by whoever
 * set up the Word template. Naming from it would rename hundreds of unrelated
 * files to the same string.
 *
 * Counting is capped: the answer only ever feeds a "is this above the
 * threshold" test, and counting all 403 matches when 5 settles it is wasted
 * work on every single file being named.
 */
async function countFilesSharingTitle(title, { cap = 25 } = {}) {
  if (!title) return 0;
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM (
       SELECT 1 FROM file_metadata
        WHERE metadata->>'title' = $1
        LIMIT $2
     ) capped`,
    [title, cap]
  );
  return rows[0].n;
}

module.exports = { upsert, copyFrom, findByFile, countFilesSharingTitle };
