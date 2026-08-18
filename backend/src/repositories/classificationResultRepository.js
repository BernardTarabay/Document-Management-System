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

/**
 * The file's current classification row, whatever it says.
 *
 * Deliberately NOT filtered to non-null values, unlike findLatestSubjectForFile
 * below: this is the "what does the file look like right now" read that
 * createPartial builds on, and for that a null has to mean null.
 */
async function findLatestForFile(fileId, client = null) {
  const exec = client || db;
  const { rows } = await exec.query(
    `SELECT classified_subject_id, classified_document_type_id
       FROM classification_results
      WHERE file_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [fileId]
  );
  return rows[0] || null;
}

/**
 * Write a classification row that changes only the axes it names, carrying the
 * others forward unchanged.
 *
 * WHY THIS EXISTS. Subject and document type are orthogonal axes
 * (docs/03-taxonomy.md §3.4) that share one row, and every consumer resolves a
 * file's classification as "the latest row" (repositories/fileFilters.js). Any
 * writer that knew about one axis and passed null for the other was therefore
 * not adding information, it was DELETING the other axis.
 *
 * That is what emptied the document-type dimension. fileOrganizeService.
 * moveToSubject hardcoded `classifiedDocumentTypeId: null`, so filing a
 * document under a subject -- the single most common curation action, and the
 * one the whole Subjects page exists to perform -- erased whatever type the
 * file had. The same hole ran the other way: setting a document type from the
 * Files page wrote `classifiedSubjectId: null` and dropped the file out of its
 * subject.
 *
 * `undefined` means "I am not speaking to this axis, keep what is there".
 * `null` means "clear this axis", which stays expressible. The result is that
 * every row is a complete snapshot of the file's classification, which is what
 * "latest row wins" was already assuming everywhere downstream.
 *
 * The same reasoning as the move path itself: enforce the invariant here, once,
 * rather than asking every future caller to remember it.
 */
async function createPartial({ fileId, classifiedSubjectId, classifiedDocumentTypeId, ...rest }, client = null) {
  const current = await findLatestForFile(fileId, client);
  return create(
    {
      fileId,
      classifiedSubjectId:
        classifiedSubjectId === undefined ? current?.classified_subject_id ?? null : classifiedSubjectId,
      classifiedDocumentTypeId:
        classifiedDocumentTypeId === undefined ? current?.classified_document_type_id ?? null : classifiedDocumentTypeId,
      ...rest,
    },
    client
  );
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

module.exports = {
  ...base,
  create,
  createPartial,
  listProposedForFile,
  findLatestForFile,
  findLatestSubjectForFile,
  review,
};
