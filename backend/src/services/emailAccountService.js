// Connect/disconnect/list/trigger-sync for email accounts
// (docs/10-email-inbox.md). The actual sync + triage work lives in
// jobs/processors/emailSyncProcessor.js -- this service only owns the
// OAuth handshake and account lifecycle.
const emailAccountRepository = require("../repositories/emailAccountRepository");
const auditLogRepository = require("../repositories/auditLogRepository");
const googleOAuthClient = require("./email/googleOAuthClient");
const microsoftOAuthClient = require("./email/microsoftOAuthClient");
const tokenCrypto = require("../utils/tokenCrypto");
const { signOAuthState, verifyOAuthState } = require("../utils/jwt");
const { enqueueJob } = require("../queues");
const { JobType, EmailProvider, EmailAccountStatus } = require("../models/enums");
const { ValidationError } = require("../validators/validationError");

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 404;
    this.publicMessage = message;
  }
}

class ForbiddenError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 403;
    this.publicMessage = message;
  }
}

function clientFor(provider) {
  if (provider === EmailProvider.GMAIL) return googleOAuthClient;
  if (provider === EmailProvider.OUTLOOK) return microsoftOAuthClient;
  throw new ValidationError(`Unknown email provider "${provider}".`);
}

function assertValidProvider(provider) {
  if (!Object.values(EmailProvider).includes(provider)) {
    throw new ValidationError(`Unknown email provider "${provider}".`);
  }
}

async function list(userId) {
  return emailAccountRepository.listByUser(userId);
}

/** Builds the provider consent-screen URL the frontend redirects the
 * browser to. userId/provider round-trip through the signed `state` param
 * -- see utils/jwt.js signOAuthState. */
function initiateConnect(provider, userId) {
  assertValidProvider(provider);
  const state = signOAuthState({ userId, provider });
  return clientFor(provider).buildAuthUrl(state);
}

/**
 * Handles the provider's redirect back to our own callback URL: exchanges
 * the one-time code for tokens, resolves the mailbox's address, and
 * upserts the email_accounts row. Never trusts the request's own idea of
 * who the user is -- the signed state token is the only source of truth
 * for that, exactly so this endpoint can be hit unauthenticated (the
 * provider redirects the browser here directly, with no way to attach our
 * app's own Authorization header).
 */
async function handleCallback(provider, code, state) {
  assertValidProvider(provider);
  if (!code) throw new ValidationError("Missing authorization code.");

  let statePayload;
  try {
    statePayload = verifyOAuthState(state);
  } catch (err) {
    throw new ValidationError("This connection attempt expired or is invalid -- please try connecting again.");
  }
  if (statePayload.provider !== provider) {
    throw new ValidationError("Provider mismatch on callback -- please try connecting again.");
  }

  const client = clientFor(provider);
  const tokens = await client.exchangeCodeForTokens(code);
  if (!tokens.refresh_token) {
    throw new ValidationError(
      "Google/Microsoft didn't return a refresh token for this connection. This usually means the account " +
      "was already connected once before without fully disconnecting first -- try disconnecting (if listed) " +
      "and reconnecting."
    );
  }

  const emailAddress = await client.getUserEmail(tokens.access_token);
  const refreshTokenEncrypted = tokenCrypto.encrypt(tokens.refresh_token);

  const existing = await emailAccountRepository.findByProviderAndAddress(provider, emailAddress);
  let account;
  if (existing) {
    if (existing.user_id !== statePayload.userId) {
      throw new ValidationError(`${emailAddress} is already connected by another account in this app.`);
    }
    account = await emailAccountRepository.updateTokens(existing.id, {
      refreshTokenEncrypted,
      scopes: tokens.scope || null,
    });
  } else {
    account = await emailAccountRepository.create({
      userId: statePayload.userId,
      provider,
      emailAddress,
      status: EmailAccountStatus.CONNECTED,
      refreshTokenEncrypted,
      scopes: tokens.scope || null,
    });
  }

  await auditLogRepository.record({
    userId: statePayload.userId,
    action: "email_account.connected",
    entityType: "email_account",
    entityId: account.id,
    newState: { provider, emailAddress },
    reason: "Connected from the Inbox page",
  });

  // Kick off a first sync immediately rather than waiting for the next
  // scheduler tick -- connecting an account and seeing nothing happen for
  // up to EMAIL_SYNC_INTERVAL_MINUTES would look broken.
  await enqueueJob(JobType.EMAIL_SYNC, { emailAccountId: account.id }, { createdBy: statePayload.userId });

  return account;
}

async function getOwned(id, userId) {
  const account = await emailAccountRepository.findById(id);
  if (!account) throw new NotFoundError("Email account not found.");
  if (account.user_id !== userId) throw new ForbiddenError("This email account belongs to a different user.");
  return account;
}

async function triggerSync(id, userId) {
  const account = await getOwned(id, userId);
  if (account.status !== EmailAccountStatus.CONNECTED) {
    throw new ValidationError(`This account is ${account.status}, not connected -- reconnect it first.`);
  }
  return enqueueJob(JobType.EMAIL_SYNC, { emailAccountId: account.id }, { createdBy: userId });
}

async function disconnect(id, userId) {
  const account = await getOwned(id, userId);

  // Best-effort token revocation -- Google exposes a simple universal
  // revoke endpoint; Microsoft's v2 endpoint has no equivalent single call
  // for a refresh token, so there's nothing extra to do there beyond
  // clearing our own copy below. Either way, a failed revoke call never
  // blocks disconnecting locally -- the user asked to disconnect, and the
  // stored credential is being destroyed regardless.
  if (account.provider === EmailProvider.GMAIL && account.refresh_token_encrypted) {
    try {
      const refreshToken = tokenCrypto.decrypt(account.refresh_token_encrypted);
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`, { method: "POST" });
    } catch {
      // best-effort only
    }
  }

  // Order matters: updateTokens also flips status back to 'connected' (it
  // doubles as "tokens were just refreshed/reconnected successfully"), so
  // the token has to be cleared BEFORE the final disconnect status write,
  // not after -- otherwise this would silently leave the account looking
  // connected again with no usable token.
  await emailAccountRepository.updateTokens(id, { refreshTokenEncrypted: null, scopes: null });
  await emailAccountRepository.disconnect(id);

  await auditLogRepository.record({
    userId,
    action: "email_account.disconnected",
    entityType: "email_account",
    entityId: id,
    reason: "Disconnected from the Inbox page",
  });

  return { success: true };
}

module.exports = {
  NotFoundError, ForbiddenError,
  list, initiateConnect, handleCallback, triggerSync, disconnect, getOwned,
};
