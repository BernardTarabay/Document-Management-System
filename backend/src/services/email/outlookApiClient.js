// Microsoft Graph mail operations. Graph's message list endpoint already
// returns everything the triage classifier needs in one call (from,
// subject, preview, receivedDateTime, hasAttachments, its own webLink, and
// inferenceClassification as a free "does Outlook itself think this is
// clutter" signal) -- unlike Gmail, there's no separate per-message fetch.
class OutlookApiError extends Error {}

const BASE = "https://graph.microsoft.com/v1.0/me";
const SELECT_FIELDS =
  "id,conversationId,from,subject,bodyPreview,receivedDateTime,hasAttachments,webLink,inferenceClassification";

async function request(accessToken, path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    throw new OutlookApiError(`Graph API ${path} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

/** Most recent inbox messages, already in the shape the triage classifier
 * needs -- no second per-message call the way Gmail requires. */
async function listInboxMessages(accessToken, { top = 50 } = {}) {
  const params = new URLSearchParams({
    $top: String(top),
    $select: SELECT_FIELDS,
    $orderby: "receivedDateTime desc",
  });
  const data = await request(accessToken, `/mailFolders/inbox/messages?${params.toString()}`);

  return (data.value || []).map((m) => ({
    id: m.id,
    threadId: m.conversationId,
    fromName: m.from?.emailAddress?.name || "",
    fromAddress: m.from?.emailAddress?.address || "",
    subject: m.subject || "(no subject)",
    snippet: m.bodyPreview || "",
    receivedAt: m.receivedDateTime ? new Date(m.receivedDateTime) : null,
    hasAttachments: Boolean(m.hasAttachments),
    webLink: m.webLink,
    // 'focused' | 'other' -- Outlook's own clutter/relevance signal, folded
    // into the rule pass alongside our own heuristics.
    inferenceClassification: (m.inferenceClassification || "").toLowerCase(),
  }));
}

/** Outlook has no separate "trash" verb -- moving a message into the
 * well-known "deleteditems" folder IS the trash action (recoverable from
 * there, same as Gmail's Trash label, until the user or a retention policy
 * empties it). This never calls hardDelete. */
async function moveToDeletedItems(accessToken, messageId) {
  await request(accessToken, `/messages/${messageId}/move`, {
    method: "POST",
    body: JSON.stringify({ destinationId: "deleteditems" }),
  });
}

module.exports = { listInboxMessages, moveToDeletedItems, OutlookApiError };
