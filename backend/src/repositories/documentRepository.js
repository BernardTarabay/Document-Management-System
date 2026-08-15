// Logical Document identity (see docs/01-domain-model.md).
const db = require("../config/database");
const { createBaseRepository } = require("./baseRepository");
const { requireOwner, ownedRepository } = require("./ownership");

const base = createBaseRepository("documents");
const owned = ownedRepository(db, "documents", { orderBy: "updated_at DESC" });

async function create({ displayName, documentTypeId = null, periodStart = null, periodEnd = null, createdBy = null }) {
  const { rows } = await db.query(
    `INSERT INTO documents (display_name, document_type_id, period_start, period_end, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [displayName, documentTypeId, periodStart, periodEnd, createdBy]
  );
  return rows[0];
}

async function setCanonicalName(id, canonicalName) {
  const { rows } = await db.query(
    "UPDATE documents SET canonical_name = $2 WHERE id = $1 RETURNING *",
    [id, canonicalName]
  );
  return rows[0] || null;
}

async function setCurrentVersion(id, versionId) {
  const { rows } = await db.query(
    "UPDATE documents SET current_version_id = $2 WHERE id = $1 RETURNING *",
    [id, versionId]
  );
  return rows[0] || null;
}

async function update(id, { displayName, documentTypeId }) {
  const { rows } = await db.query(
    `UPDATE documents SET
       display_name = COALESCE($2, display_name),
       document_type_id = COALESCE($3, document_type_id)
     WHERE id = $1 RETURNING *`,
    [id, displayName || null, documentTypeId || null]
  );
  return rows[0] || null;
}

async function setStatus(id, status) {
  const { rows } = await db.query(
    "UPDATE documents SET status = $2 WHERE id = $1 RETURNING *",
    [id, status]
  );
  return rows[0] || null;
}

/** Full document view: primary subject, document type, current version/file. */
async function getFullById(id, ownerUserId) {
  requireOwner(ownerUserId, "documents.getFullById");
  const { rows } = await db.query(
    `SELECT
       d.*,
       dt.code AS document_type_code, dt.name AS document_type_name,
       s.id AS primary_subject_id, s.name AS primary_subject_name, s.materialized_path AS primary_subject_path,
       dv.version_number AS current_version_number, dv.file_id AS current_file_id
     FROM documents d
     LEFT JOIN document_types dt ON dt.id = d.document_type_id
     LEFT JOIN document_subjects ds ON ds.document_id = d.id AND ds.relevance = 'primary'
     LEFT JOIN subjects s ON s.id = ds.subject_id
     LEFT JOIN document_versions dv ON dv.id = d.current_version_id
     WHERE d.id = $1 AND d.owner_user_id = $2`,
    [id, ownerUserId]
  );
  return rows[0] || null;
}

async function listBySubject(subjectId, ownerUserId, { limit = 50, offset = 0 } = {}) {
  requireOwner(ownerUserId, "documents.listBySubject");
  const { rows } = await db.query(
    `SELECT d.* FROM documents d
     JOIN document_subjects ds ON ds.document_id = d.id
     WHERE ds.subject_id = $1 AND d.status = 'active' AND d.owner_user_id = $4
     ORDER BY d.updated_at DESC LIMIT $2 OFFSET $3`,
    [subjectId, limit, offset, ownerUserId]
  );
  return rows;
}

async function searchByName(fragment, ownerUserId, { limit = 50, offset = 0 } = {}) {
  requireOwner(ownerUserId, "documents.searchByName");
  const { rows } = await db.query(
    `SELECT * FROM documents
     WHERE (display_name ILIKE '%' || $1 || '%' OR canonical_name ILIKE '%' || $1 || '%')
       AND owner_user_id = $4
     ORDER BY updated_at DESC LIMIT $2 OFFSET $3`,
    [fragment, limit, offset, ownerUserId]
  );
  return rows;
}

module.exports = {
  ...base, ...owned,
  create,
  update,
  setCanonicalName,
  setCurrentVersion,
  setStatus,
  getFullById,
  listBySubject,
  searchByName,
};
