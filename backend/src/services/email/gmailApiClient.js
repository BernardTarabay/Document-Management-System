// Gmail API message operations (listing, reading metadata, trashing).
// Deliberately fetches messages with format=metadata + an explicit header
// allowlist rather than format=full -- the triage classifier only ever
// needs From/Subject/List-Unsubscribe + the snippet Gmail already computes,
// never the full body, so there's no reason to pull (or store) more.
class GmailApiError extends Error {}

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

async function request(accessToken, path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${accessToken}`, ...(options.headers || {}) },
  });
  if (!res.ok) {
    throw new GmailApiError(`Gmail API ${path} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

/** First page of the most recent inbox messages. Simple "list what's
 * there, skip what we've already seen" sync rather than Gmail's
 * historyId-based delta API -- robust to gaps (missed webhook, downtime)
 * at the cost of re-listing IDs we already have on every run, which is a
 * cheap call compared to the per-message fetches that follow. */
async function listInboxMessageIds(accessToken, { maxResults = 50 } = {}) {
  const data = await request(accessToken, `/messages?labelIds=INBOX&maxResults=${maxResults}`);
  return (data.messages || []).map((m) => m.id);
}

async function getMessageMetadata(accessToken, messageId) {
  const params = new URLSearchParams({ format: "metadata" });
  params.append("metadataHeaders", "From");
  params.append("metadataHeaders", "Subject");
  params.append("metadataHeaders", "List-Unsubscribe");
  const data = await request(accessToken, `/messages/${messageId}?${params.toString()}`);

  const headers = Object.fromEntries((data.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value]));
  const fromHeader = headers.from || "";
  const fromMatch = /^(.*?)\s*<(.+)>$/.exec(fromHeader);

  return {
    id: data.id,
    threadId: data.threadId,
    labelIds: data.labelIds || [],
    snippet: data.snippet || "",
    subject: headers.subject || "(no subject)",
    fromName: fromMatch ? fromMatch[1].replace(/^"|"$/g, "") : fromHeader,
    fromAddress: fromMatch ? fromMatch[2] : fromHeader,
    hasListUnsubscribe: Boolean(headers["list-unsubscribe"]),
    receivedAt: data.internalDate ? new Date(Number(data.internalDate)) : null,
    hasAttachments: Boolean(data.payload?.parts?.some((p) => p.filename)),
    webLink: `https://mail.google.com/mail/u/0/#all/${data.threadId || data.id}`,
  };
}

/** Gmail's "trash" is a label change (TRASH added, INBOX removed) -- the
 * message survives in Trash for 30 days before Gmail itself permanently
 * deletes it. This never calls the actual permanent-delete endpoint. */
async function trashMessage(accessToken, messageId) {
  await request(accessToken, `/messages/${messageId}/trash`, { method: "POST" });
}

module.exports = { listInboxMessageIds, getMessageMetadata, trashMessage, GmailApiError };
