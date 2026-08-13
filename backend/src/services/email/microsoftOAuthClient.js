// Microsoft identity platform OAuth2 (Outlook / Microsoft 365 via Graph),
// raw fetch calls same as googleOAuthClient.js -- no MSAL dependency for
// what's a handful of endpoints.
const env = require("../../config/env");

const SCOPE = "offline_access Mail.ReadWrite User.Read";

class MicrosoftOAuthError extends Error {}

function assertConfigured() {
  if (!env.email.microsoft.clientId || !env.email.microsoft.clientSecret || !env.email.microsoft.redirectUri) {
    // See the matching note in googleOAuthClient.js: an unconfigured
    // provider is an operator gap, so it answers 400 with the actionable
    // message instead of a generic 500.
    const err = new MicrosoftOAuthError(
      "Outlook isn't configured on this server yet -- MICROSOFT_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI are unset."
    );
    err.statusCode = 400;
    err.publicMessage = err.message;
    throw err;
  }
}

function authEndpoint() {
  return `https://login.microsoftonline.com/${env.email.microsoft.tenantId}/oauth2/v2.0/authorize`;
}

function tokenEndpoint() {
  return `https://login.microsoftonline.com/${env.email.microsoft.tenantId}/oauth2/v2.0/token`;
}

function buildAuthUrl(state) {
  assertConfigured();
  const params = new URLSearchParams({
    client_id: env.email.microsoft.clientId,
    redirect_uri: env.email.microsoft.redirectUri,
    response_type: "code",
    response_mode: "query",
    scope: SCOPE,
    state,
  });
  return `${authEndpoint()}?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  assertConfigured();
  const res = await fetch(tokenEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.email.microsoft.clientId,
      client_secret: env.email.microsoft.clientSecret,
      redirect_uri: env.email.microsoft.redirectUri,
      grant_type: "authorization_code",
      scope: SCOPE,
    }),
  });
  if (!res.ok) {
    throw new MicrosoftOAuthError(`Microsoft token exchange failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  return res.json(); // { access_token, refresh_token, expires_in, scope, token_type }
}

/**
 * Unlike Google, Microsoft commonly rotates the refresh token on every
 * refresh -- callers MUST check the response for a new refresh_token and
 * re-persist it, or the old one can stop working on a later refresh.
 */
async function refreshAccessToken(refreshToken) {
  assertConfigured();
  const res = await fetch(tokenEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env.email.microsoft.clientId,
      client_secret: env.email.microsoft.clientSecret,
      grant_type: "refresh_token",
      scope: SCOPE,
    }),
  });
  if (!res.ok) {
    throw new MicrosoftOAuthError(`Microsoft token refresh failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

async function getUserEmail(accessToken) {
  const res = await fetch("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new MicrosoftOAuthError(`Couldn't read the Microsoft Graph profile (${res.status}).`);
  }
  const data = await res.json();
  // `mail` is unset for some account types (e.g. certain personal
  // accounts) -- userPrincipalName is the reliable fallback.
  return data.mail || data.userPrincipalName;
}

module.exports = { buildAuthUrl, exchangeCodeForTokens, refreshAccessToken, getUserEmail, MicrosoftOAuthError };
