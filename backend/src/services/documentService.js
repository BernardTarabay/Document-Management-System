const documentRepository = require("../repositories/documentRepository");
const auditLogRepository = require("../repositories/auditLogRepository");
const { parsePagination } = require("../utils/pagination");
const { requireOwner } = require("../repositories/ownership");
const { ValidationError } = require("../validators/validationError");

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 404;
    this.publicMessage = message;
  }
}

async function search(query, ownerUserId) {
  requireOwner(ownerUserId, "documentService.search");
  const { limit, offset } = parsePagination(query);
  if (query.q) return documentRepository.searchByName(query.q, ownerUserId, { limit, offset });
  if (query.subjectId) return documentRepository.listBySubject(query.subjectId, ownerUserId, { limit, offset });
  return documentRepository.listForOwner(ownerUserId, { limit, offset });
}

async function getById(id, ownerUserId) {
  const document = await documentRepository.getFullById(id, ownerUserId);
  if (!document) throw new NotFoundError("Document not found.");
  return document;
}

/**
 * Only display name / document type are editable here -- canonical_name is
 * system-generated (namingService.js) and current_version_id changes only
 * through version-detection/confirmation flows, never a raw PATCH.
 */
async function update(id, { displayName, documentTypeId }, actorUserId) {
  const existing = await documentRepository.findByIdForOwner(id, actorUserId);
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
