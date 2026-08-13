const auditLogService = require("../services/auditLogService");

async function list(req, res) {
  res.json(await auditLogService.search(req.query));
}

async function clear(req, res) {
  res.json(await auditLogService.clear(req.user.id));
}

function toCsvField(value) {
  if (value === null || value === undefined) return "";
  const str = typeof value === "object" ? JSON.stringify(value) : String(value);
  return `"${str.replace(/"/g, '""')}"`;
}

async function exportCsv(req, res) {
  const rows = await auditLogService.exportForCsv();
  const header = ["id", "action", "entity_type", "entity_id", "status", "user_id", "reason", "created_at"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [r.id, r.action, r.entity_type, r.entity_id, r.status, r.user_id, r.reason, r.created_at]
        .map(toCsvField)
        .join(",")
    );
  }
  const csv = lines.join("\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`
  );
  res.send(csv);
}

module.exports = { list, clear, exportCsv };
