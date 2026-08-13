const db = require("../config/database");

async function assign({ documentId, subjectId, relevance = "secondary", assignedBy = "system", confidenceLevel = null, confidenceScore = null, assignedByUserId = null }) {
  const { rows } = await db.query(
    `INSERT INTO document_subjects (document_id, subject_id, relevance, assigned_by, confidence_level, confidence_score, assigned_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (document_id, subject_id) DO UPDATE SET
       relevance = EXCLUDED.relevance,
       confidence_level = EXCLUDED.confidence_level,
       confidence_score = EXCLUDED.confidence_score
     RETURNING *`,
    [documentId, subjectId, relevance, assignedBy, confidenceLevel, confidenceScore, assignedByUserId]
  );
  return rows[0];
}

async function listForDocument(documentId) {
  const { rows } = await db.query(
    `SELECT ds.*, s.name AS subject_name, s.materialized_path
     FROM document_subjects ds JOIN subjects s ON s.id = ds.subject_id
     WHERE ds.document_id = $1`,
    [documentId]
  );
  return rows;
}

module.exports = { assign, listForDocument };
