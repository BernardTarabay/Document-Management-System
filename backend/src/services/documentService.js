const documentRepository = require("../repositories/documentRepository");
const auditLogRepository = require("../repositories/auditLogRepository");
const { parsePagination } = require("../utils/pagination");
const { ValidationError } = require("../validators/validationError");

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 404;
    this.publicMessage = message;
  }
}

async function search(query) {
  const { limit, offset } = parsePagination(query);
  if (query.q) return documentRepository.searchByName(query.q, { limit, offset });
  if (query.subjectId) return documentRepository.listBySubject(query.subjectId, { limit, offset });
  return documentRepository.list({ limit, offset });
}

async function getById(id) {
  const document = await documentRepository.getFullById(id);
  if (!document) throw new NotFoundError("Document not found.");
  return document;
}

/**
 * Only display name / document type are editable here -- canonical_name is
 * system-generated (namingService.js) and current_version_id changes only
 * through version-detection/confirmation flows, never a raw PATCH.
 */
async function update(id, { displayName, documentTypeId }, actorUserId) {
  const existing = await documentRepository.findById(id);
  if (!existing) throw new NotFoundError("Document not found.");
  if (!displayName && !documentTypeId) {
    throw new ValidationError("At least one of displayName or documentTypeId is required.");
  }

  const updated = await documentRepository.update(id, { displayName, documentTypeId });

  await auditLogRepository.record({
    userId: actorUserId,
    action: "document.updated",
    entityType: "document",
    entityId: id,
    previousState: { displayName: existing.display_name, documentTypeId: existing.document_type_id },
    newState: { displayName, documentTypeId },
  });

  return updated;
}

module.exports = { NotFoundError, search, getById, update };
