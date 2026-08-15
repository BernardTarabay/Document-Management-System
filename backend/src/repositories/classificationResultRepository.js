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

/**
 * Where this file currently sits in the taxonomy, or null if nothing has
 * classified it yet.
 *
 * "Latest wins" -- the same rule listBySubject and searchEverything's subject
 * scope use. A file that has been reclassified belongs where it is now, not
 * everywhere it has ever been.
 *
 * Used by descriptionService to give the describer the folder a document was
 * filed under, which is real context for what it is.
 */
async function findLatestSubjectForFile(fileId) {
  const { rows } = await db.query(
    `SELECT s.id, s.name, s.materialized_path
       FROM classification_results cr
       JOIN subjects s ON s.id = cr.classified_subject_id
      WHERE cr.file_id = $1 AND cr.classified_subject_id IS NOT NULL
      ORDER BY cr.created_at DESC
      LIMIT 1`,
    [fileId]
  );
  return rows[0] || null;
}

async function review(id, { status, reviewedBy }) {
  const { rows } = await db.query(
    `UPDATE classification_results SET status = $2, reviewed_by = $3, reviewed_at = now() WHERE id = $1 RETURNING *`,
    [id, status, reviewedBy]
  );
  return rows[0] || null;
}

module.exports = { ...base, create, listProposedForFile, findLatestSubjectForFile, review };
