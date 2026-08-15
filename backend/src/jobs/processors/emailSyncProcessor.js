// Inbox sync + triage (docs/10-email-inbox.md). Runs on JobType.EMAIL_SYNC,
// triggered either by the "Sync now" button (emailAccountService.triggerSync)
// or the periodic scheduler (server.js). For each new message: classify
// (rule-based first, Gemini for anything ambiguous -- emailTriageClassifier),
// auto-trash it upstream if classified junk, and always keep a row here
// either way so the Inbox page (kept) and the "recently removed" view
// (deleted) both have something to show.
const emailAccountRepository = require("../../repositories/emailAccountRepository");
const inboxMessageRepository = require("../../repositories/inboxMessageRepository");
const auditLogRepository = require("../../repositories/auditLogRepository");
const googleOAuthClient = require("../../services/email/googleOAuthClient");
const gmailApiClient = require("../../services/email/gmailApiClient");
const emailTriageClassifier = require("../../services/ai/emailTriageClassifier");
const tokenCrypto = require("../../utils/tokenCrypto");
const { EmailProvider, EmailAccountStatus, InboxMessageStatus } = require("../../models/enums");

const MAX_MESSAGES_PER_SYNC = 50;

async function fetchNormalizedMessages(account, accessToken) {
  if (account.provider === EmailProvider.GMAIL) {
    const ids = await gmailApiClient.listInboxMessageIds(accessToken, { maxResults: MAX_MESSAGES_PER_SYNC });
    const out = [];
    for (const id of ids) {
      const existing = await inboxMessageRepository.findByAccountAndMessageId(account.id, id);
      if (existing) continue;
      const meta = await gmailApiClient.getMessageMetadata(accessToken, id);
      out.push({
        providerMessageId: meta.id,
        threadId: meta.threadId,
        fromName: meta.fromName,
        fromAddress: meta.fromAddress,
        subject: meta.subject,
        snippet: meta.snippet,
        receivedAt: meta.receivedAt,
        hasAttachments: meta.hasAttachments,
        webLink: meta.webLink,
        providerHints: { gmailLabels: meta.labelIds, hasListUnsubscribe: meta.hasListUnsubscribe },
      });
    }
    return out;
  }

  // Gmail is the only provider. A row with any other provider value can only
  // be a leftover from before Outlook was removed, and syncing it is not
  // possible -- there is no client for it. Refusing loudly beats returning an
  // empty list, which would look like a mailbox with no new mail.
  throw new Error(
    `Email provider "${account.provider}" is no longer supported. Disconnect this account and ` +
    "reconnect it with Gmail."
  );
}

async function trashUpstream(account, accessToken, providerMessageId) {
  if (account.provider !== EmailProvider.GMAIL) {
    throw new Error(`Cannot trash upstream: provider "${account.provider}" is no longer supported.`);
  }
  await gmailApiClient.trashMessage(accessToken, providerMessageId);
}

async function handle({ emailAccountId }) {
  const account = await emailAccountRepository.findById(emailAccountId);
  if (!account || account.status !== EmailAccountStatus.CONNECTED) {
    return { skipped: true, reason: "account not connected" };
  }

  if (account.provider !== EmailProvider.GMAIL) {
    await emailAccountRepository.markError(
      emailAccountId,
      `Provider "${account.provider}" is no longer supported. Disconnect and reconnect with Gmail.`
    );
    return { skipped: true, reason: "unsupported provider" };
  }
  const oauthClient = googleOAuthClient;

  let tokenResponse;
  try {
    const refreshToken = tokenCrypto.decrypt(account.refresh_token_encrypted);
    tokenResponse = await oauthClient.refreshAccessToken(refreshToken);
  } catch (err) {
    await emailAccountRepository.markError(emailAccountId, `Token refresh failed: ${err.message}`);
    throw err;
  }

  // Google generally does not return a refresh token on a refresh call, but
  // re-persist whatever came back so a rotated token is never lost.
  if (tokenResponse.refresh_token) {
    await emailAccountRepository.updateTokens(emailAccountId, {
      refreshTokenEncrypted: tokenCrypto.encrypt(tokenResponse.refresh_token),
      scopes: account.scopes,
    });
  }

  const accessToken = tokenResponse.access_token;
  const counts = { fetched: 0, kept: 0, trashed: 0, failedToTrash: 0 };

  let messages;
  try {
    messages = await fetchNormalizedMessages(account, accessToken);
  } catch (err) {
    await emailAccountRepository.markError(emailAccountId, `Fetching messages failed: ${err.message}`);
    throw err;
  }
  counts.fetched = messages.length;

  for (const message of messages) {
    let result;
    try {
      result = await emailTriageClassifier.classify(message);
    } catch (err) {
      // A classification failure keeps the message rather than risking a
      // false "junk" from a fallback guess -- see emailTriageClassifier.js's
      // own "when unsure, prefer important" instruction for the same logic
      // applied at the AI-judgment level.
      result = {
        classification: "important",
        confidenceLevel: "low",
        method: "rule",
        reason: `Classification failed, kept by default: ${err.message}`,
      };
    }

    const initialStatus = result.classification === "junk" ? InboxMessageStatus.DELETED : InboxMessageStatus.KEPT;
    const row = await inboxMessageRepository.create({
      emailAccountId,
      providerMessageId: message.providerMessageId,
      threadId: message.threadId,
      fromAddress: message.fromAddress,
      fromName: message.fromName,
      subject: message.subject,
      snippet: message.snippet,
      receivedAt: message.receivedAt,
      hasAttachments: message.hasAttachments,
      classification: result.classification,
      classificationMethod: result.method,
      confidenceLevel: result.confidenceLevel,
      status: initialStatus,
      providerWebLink: message.webLink,
    });
    if (!row) continue; // lost a race with another sync of the same account -- already recorded

    if (result.classification === "junk") {
      try {
        await trashUpstream(account, accessToken, message.providerMessageId);
        counts.trashed += 1;
        await auditLogRepository.record({
          userId: account.user_id,
          action: "email.auto_trashed",
          entityType: "inbox_message",
          entityId: row.id,
          newState: { subject: message.subject, from: message.fromAddress },
          reason: `Automatic inbox triage (${result.method}): ${result.reason}. Moved to Trash/Deleted Items -- not permanently deleted.`,
        });
      } catch (err) {
        // Classified junk but the provider call to actually trash it
        // failed -- don't leave the row claiming 'deleted' when the
        // message is still sitting in the real inbox.
        counts.failedToTrash += 1;
        await inboxMessageRepository.updateStatus(row.id, InboxMessageStatus.KEPT);
      }
    } else {
      counts.kept += 1;
    }
  }

  await emailAccountRepository.markSynced(emailAccountId);
  return counts;
}

module.exports = { handle };
