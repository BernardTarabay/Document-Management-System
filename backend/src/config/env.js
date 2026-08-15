// Centralized, validated environment configuration.
// Fail fast at boot rather than surfacing undefined env vars deep in a request.
require("dotenv").config();

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// Node's built-in test runner sets this in each test child process. Used only
// to keep the advisory warning below out of the suite's output -- the hard
// failures still apply everywhere.
const IS_TEST_RUNNER = process.env.NODE_TEST_CONTEXT !== undefined;

const MIN_SECRET_LENGTH = 32;

/**
 * A secret that must not be guessable.
 *
 * `required()` above only proves a variable is SET, which was not enough: this
 * install ran in production for months with JWT_ACCESS_SECRET still set to the
 * literal "change-me-access-secret" from .env.example. Presence is not the
 * property that matters for a signing key -- unpredictability is. Anyone who
 * could reach the API and had seen this repository could mint an access token
 * for any user id and be an administrator.
 *
 * So placeholders are refused OUTRIGHT, in every environment: nothing
 * legitimate is called "change-me-...", and the one situation this has to
 * catch is someone copying .env.example and starting the server. Length is
 * only fatal in production, so a developer's throwaway value and the unit
 * tests' short fixtures still work.
 */
function secret(name, rawValue) {
  const value = required(name, rawValue);
  const generate = `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`;

  if (/change[-_ ]?me|your[-_ ]?secret|placeholder|^(secret|password|test)$/i.test(value)) {
    throw new Error(
      `${name} is still set to a placeholder value ("${value}"). This is a signing key -- ` +
      `anyone who guesses it can forge a session for any account. Generate a real one:\n  ${generate}`
    );
  }

  if (value.length < MIN_SECRET_LENGTH) {
    const message =
      `${name} is only ${value.length} characters; at least ${MIN_SECRET_LENGTH} are needed for a signing key. ` +
      `Generate one with:\n  ${generate}`;
    if ((process.env.NODE_ENV || "development") === "production") throw new Error(message);
    if (!IS_TEST_RUNNER) console.warn(`[env] WARNING: ${message}`);
  }

  return value;
}

const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: parseInt(process.env.PORT || "5000", 10),

  databaseUrl: required("DATABASE_URL"),
  pgSsl: process.env.PGSSL === "true",

  jwt: {
    accessSecret: secret("JWT_ACCESS_SECRET"),
    refreshSecret: secret("JWT_REFRESH_SECRET"),
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "15m",
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d",
  },

  bcryptSaltRounds: parseInt(process.env.BCRYPT_SALT_ROUNDS || "12", 10),

  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",

  // Optional: unset simply means no Filesystem Agent can connect (agentService
  // throws a clear message at first use). But if it IS set, it is a signing
  // key and gets the same placeholder/length treatment as the two above.
  agentJwtSecret: process.env.AGENT_JWT_SECRET
    ? secret("AGENT_JWT_SECRET")
    : undefined,

  // Where the organized shortcut tree is built (docs: the "mirror"). Every
  // entry in it is a shortcut to a file that stays where it already lives,
  // so this folder is disposable -- deleting it loses nothing and
  // `sync_mirror` rebuilds it. Unset means the mirror is simply not built.
  mirrorRoot: process.env.MIRROR_ROOT || null,

  // Real-time ingestion. The watcher notices new/changed files in watched
  // storage locations; the periodic rescan is the safety net for events
  // missed while the machine was asleep or a drive was unplugged.
  watch: {
    enabled: process.env.WATCH_ENABLED !== "false",
    // Wait for writes to settle before ingesting -- a file being copied in
    // fires many events and is incomplete until the last one.
    debounceMs: parseInt(process.env.WATCH_DEBOUNCE_MS || "4000", 10),
    rescanIntervalMinutes: parseInt(process.env.WATCH_RESCAN_INTERVAL_MINUTES || "60", 10),
  },

  // Ceiling on how large a file may be before the two extraction stages
  // refuse to open it.
  //
  // Both stages read the WHOLE file into a Buffer (utils/streamToBuffer), and
  // Buffer.concat transiently holds two copies. They also run on separate
  // queues, so the same file is buffered twice simultaneously, four-wide
  // each. There was no limit of any kind: one very large file in a corpus
  // measured in hundreds of GB was enough to OOM the worker process -- which
  // hosts all fourteen queues, so it took every other in-flight job with it.
  //
  // Over-size files are recorded as 'skipped' with a reason rather than
  // silently ignored, so they appear in triage instead of looking processed.
  extraction: {
    maxBytes: parseInt(process.env.MAX_EXTRACTION_BYTES || String(256 * 1024 * 1024), 10),
  },

  // Auto-apply naming without human review. Only ever consulted for
  // locations that also have auto_apply_naming enabled, and only meaningful
  // for read-only locations, where applying a name touches the mirror
  // rather than the original file.
  autoApply: {
    minConfidence: process.env.AUTO_APPLY_MIN_CONFIDENCE || "high",
  },

  // Where the browser lives -- used only to build the final redirect after
  // an OAuth callback finishes server-side (the provider itself only ever
  // talks to the backend's own callback URL, never this one directly).
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:5173",

  // Encrypts email_accounts.refresh_token_encrypted at rest -- see
  // utils/tokenCrypto.js. Required before any email account can be
  // connected; deliberately NOT defaulted (unlike most of this file) since
  // a default here would mean every uninitialized install shares the same
  // encryption key.
  // Empty/unset stays undefined so tokenCrypto can fail loudly at first use
  // rather than silently encrypting with a shared default. A key that IS
  // present goes through the same placeholder check as the JWT secrets --
  // this one protects real mailbox refresh tokens at rest.
  tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY
    ? secret("TOKEN_ENCRYPTION_KEY")
    : undefined,

  // Email inbox triage (docs/10-email-inbox.md). Gmail is the only provider;
  // the Outlook/Microsoft Graph one was removed. It is OAuth2-only -- there is
  // no password-based path -- so an app must be registered in Google Cloud
  // Console before any account can be connected. Leaving clientId unset means
  // "Connect Gmail" 400s with a clear message; it blocks nothing else.
  email: {
    syncIntervalMinutes: parseInt(process.env.EMAIL_SYNC_INTERVAL_MINUTES || "15", 10),
    google: {
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI,
    },
  },

  // AI classification escalation tier (see docs/09-ai-classification.md).
  // Entirely opt-in: unset GEMINI_API_KEY and the classifier stage behaves
  // exactly as it did before this feature existed (rule-based only).
  ai: {
    enabled: Boolean(process.env.GEMINI_API_KEY) && process.env.AI_CLASSIFICATION_ENABLED !== "false",
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL || "gemini-3.1-flash-lite",
    // Separate knob for the Subjects-page chatbot (docs/08-api-contracts.md
    // §9.10) -- conversational tool-selection benefits from a bit more
    // headroom than the bounded, single-shot classification task above, but
    // defaults to the exact same model/key so the feature works out of the
    // box for anyone who already set GEMINI_API_KEY for classification.
    chatModel: process.env.GEMINI_CHAT_MODEL || process.env.GEMINI_MODEL || "gemini-3.1-flash-lite",
    // Only escalate to the LLM when the rule-based pass wasn't confident --
    // a clean keyword match doesn't need an API call to confirm.
    escalateBelowConfidence: process.env.AI_ESCALATE_BELOW_CONFIDENCE || "high",
    // Hard ceiling so a big scan can never spend more than this without a
    // human deciding to raise it. 0 = unlimited (not recommended).
    dailyCallCap: parseInt(process.env.AI_DAILY_CALL_CAP || "500", 10),
    timeoutMs: parseInt(process.env.AI_REQUEST_TIMEOUT_MS || "20000", 10),
    // Google's Gemini free tier caps gemini-3.1-flash-lite at 15
    // requests/minute (seen firsthand: 429 body says "limit: 15, model:
    // gemini-3.1-flash-lite"). With AI_ESCALATE_BELOW_CONFIDENCE=always,
    // every classified file calls Gemini, so reprocessing even a couple
    // hundred files at once bursts straight through that cap. Default of
    // 12 leaves a safety margin under the free tier's 15; raise this (or
    // set to 0 to disable client-side pacing entirely) once on a paid plan
    // with a higher quota.
    rateLimitPerMinute: parseInt(process.env.GEMINI_RATE_LIMIT_PER_MINUTE || "12", 10),
  },
};

module.exports = env;
