const db = require("../config/database");
const { createBaseRepository } = require("./baseRepository");

const base = createBaseRepository("document_versions", { defaultOrderBy: "version_number DESC" });

async function listForDocument(documentId) {
  const { rows } = await db.query(
    "SELECT * FROM document_versions WHERE document_id = $1 ORDER BY version_number DESC",
    [documentId]
  );
  return rows;
}

async function getNextVersionNumber(documentId) {
  const { rows } = await db.query(
    "SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM document_versions WHERE document_id = $1",
    [documentId]
  );
  return rows[0].next;
}

/**
 * Create a version and, within the same transaction, unset any previous
 * `is_current` row for the document so the "one current version" invariant
 * (enforced by a partial unique index) is never violated mid-write.
 */
async function createCurrentVersion(client, { documentId, fileId, versionNumber, versionLabel, detectionMethod, confidenceLevel, confidenceScore, createdBy }) {
  await client.query(
    "UPDATE document_versions SET is_current = false, status = 'superseded' WHERE document_id = $1 AND is_current = true",
    [documentId]
  );
  const { rows } = await client.query(
    `INSERT INTO document_versions (
       document_id, file_id, version_number, version_label, status, is_current,
       detection_method, confidence_level, confidence_score, created_by
     ) VALUES ($1,$2,$3,$4,'confirmed', true, $5,$6,$7,$8)
     RETURNING *`,
    [documentId, fileId, versionNumber, versionLabel, detectionMethod, confidenceLevel, confidenceScore, createdBy]
  );
  return rows[0];
}

module.exports = { ...base, listForDocument, getNextVersionNumber, createCurrentVersion };
