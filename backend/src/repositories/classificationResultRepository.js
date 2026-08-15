const db = require("../config/database");
const { createBaseRepository } = require("./baseRepository");

const base = createBaseRepository("classification_results");

/**
 * @param {object} fields
 * @param {import('pg').PoolClient} [client] - run inside a caller's
 *   transaction. fileOrganizeService writes this row and the file's placement
 *   provenance together, and a file whose provenance says "you chose this"
 *   while its classification still points at the old folder is worse than
 *   either write failing on its own.
 */
async function create({ fileId, classifiedSubjectId = null, classifiedDocumentTypeId = null, confidenceLevel, confidenceScore = null, method, rawOutput = null }, client = null) {
  const exec = client || db;
  const { rows } = await exec.query(
    `INSERT INTO classification_results (
       file_id, classified_subject_id, classified_document_type_id,
       confidence_level, confidence_score, method, raw_output
     ) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [fileId, classifiedSubjectId, classifiedDocumentTypeId, confidenceLevel, confidenceScore, method, rawOutput]
  );
  return rows[0];
}

async function listProposedForFile(fileId) {
  const { rows } = await db.query(
    "SELECT * FROM classification_results WHERE file_id = $1 ORDER BY created_at DESC",
    [fileId]
  );
  return rows;
}

async function review(id, { status, reviewedBy }) {
  const { rows } = await db.query(
    `UPDATE classification_results SET status = $2, reviewed_by = $3, reviewed_at = now() WHERE id = $1 RETURNING *`,
    [id, status, reviewedBy]
  );
  return rows[0] || null;
}

module.exports = { ...base, create, listProposedForFile, review };
