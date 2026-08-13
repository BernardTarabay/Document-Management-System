// The curated/triaged inbox view (docs/10-email-inbox.md). Rows here are
// never deleted when a message is trashed upstream -- status flips to
// 'deleted' and the row stays, so there's always an auditable record of
// what auto-triage removed (same "history is additive" philosophy as
// classification_results / audit_logs).
const db = require("../config/database");
const { createBaseRepository } = require("./baseRepository");

const base = createBaseRepository("inbox_messages", { defaultOrderBy: "received_at DESC" });

async function findByAccountAndMessageId(emailAccountId, providerMessageId) {
  const { rows } = await db.query(
    "SELECT * FROM inbox_messages WHERE email_account_id = $1 AND provider_message_id = $2",
    [emailAccountId, providerMessageId]
  );
  return rows[0] || null;
}

async function create(row) {
  const {
    emailAccountId, providerMessageId, threadId, fromAddress, fromName, subject, snippet,
    receivedAt, hasAttachments, classification, classificationMethod, confidenceLevel,
    status, providerWebLink,
  } = row;

  const { rows } = await db.query(
    `INSERT INTO inbox_messages (
       email_account_id, provider_message_id, thread_id, from_address, from_name, subject, snippet,
       received_at, has_attachments, classification, classification_method, confidence_level,
       status, provider_web_link
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (email_account_id, provider_message_id) DO NOTHING
     RETURNING *`,
    [
      emailAccountId, providerMessageId, threadId, fromAddress, fromName, subject, snippet,
      receivedAt, hasAttachments, classification, classificationMethod, confidenceLevel,
      status, providerWebLink,
    ]
  );
  return rows[0] || null;
}

/** Scoped to the logged-in user's own connected accounts -- one user's
 * inbox never shows up in another user's Inbox page. */
async function listForUser(userId, { status = "kept", limit = 50, offset = 0 } = {}) {
  const { rows } = await db.query(
    `SELECT m.* FROM inbox_messages m
     JOIN email_accounts a ON a.id = m.email_account_id
     WHERE a.user_id = $1 AND m.status = $2
     ORDER BY m.received_at DESC NULLS LAST
     LIMIT $3 OFFSET $4`,
    [userId, status, limit, offset]
  );
  return rows;
}

async function updateStatus(id, status) {
  const { rows } = await db.query(
    "UPDATE inbox_messages SET status = $2 WHERE id = $1 RETURNING *",
    [id, status]
  );
  return rows[0] || null;
}

module.exports = { ...base, findByAccountAndMessageId, create, listForUser, updateStatus };
