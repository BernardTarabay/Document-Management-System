const auditLogRepository = require("../repositories/auditLogRepository");
const { parsePagination } = require("../utils/pagination");

async function search(query) {
  const { limit, offset } = parsePagination(query);
  if (query.entityType && query.entityId) {
    return auditLogRepository.listForEntity(query.entityType, query.entityId, { limit, offset });
  }
  return auditLogRepository.listRecent({ limit, offset });
}

/**
 * Clears the audit log. Gated behind 'audit.manage' at the route layer
 * (stricter than the 'audit.view' everyone with audit access already has),
 * since purging history is a materially bigger action than reading it.
 */
async function clear(actorUserId) {
  const clearedCount = await auditLogRepository.clearAll();
  await auditLogRepository.record({
    userId: actorUserId,
    action: "audit_log.cleared",
    entityType: "audit_log",
    newState: { clearedCount },
    reason: "Manually cleared from the Audit Log page",
  });
  return { cleared: clearedCount };
}

async function exportForCsv() {
  return auditLogRepository.listForExport({ limit: 10000 });
}

module.exports = { search, clear, exportForCsv };
