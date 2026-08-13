// Google OAuth2 (Gmail), talked to directly via fetch -- same "no vendor
// SDK, raw HTTP call" style as services/ai/geminiClassifier.js, rather than
// pulling in the `googleapis` package for what's a handful of well-
// documented endpoints.
const env = require("../../config/env");

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

class GoogleOAuthError extends Error {}

function assertConfigured() {
  if (!env.email.google.clientId || !env.email.google.clientSecret || !env.email.google.redirectUri) {
    // Carries statusCode/publicMessage (the convention app.js's error
    // handler reads) so an unconfigured server answers "Connect Gmail" with
    // an actionable 400 rather than a bare 500 -- this is an operator
    // configuration gap, not a server fault. Deliberately NOT applied to
    // the token-exchange/refresh errors below: those embed the provider's
    // raw response body, which isn't safe to echo back to a client.
    const err = new GoogleOAuthError(
      "Gmail isn't configured on this server yet -- GOOGLE_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI are unset."
    );
    err.statusCode = 400;
    err.publicMessage = err.message;
    throw err;
  }
}

function buildAuthUrl(state) {
  assertConfigured();
  const params = new URLSearchParams({
    client_id: env.email.google.clientId,
    redirect_uri: env.email.google.redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPE,
    access_type: "offline",
    // Forces Google to hand back a refresh_token even if this user
    // previously granted consent -- without it, a re-connect after a
    // disconnect can silently come back with no refresh_token at all.
    prompt: "consent",
    state,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  assertConfigured();
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.email.google.clientId,
      client_secret: env.email.google.clientSecret,
      redirect_uri: env.email.google.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    throw new GoogleOAuthError(`Google token exchange failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  return res.json(); // { access_token, refresh_token, expires_in, scope, token_type }
}

async function refreshAccessToken(refreshToken) {
  assertConfigured();
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env.email.google.clientId,
      client_secret: env.email.google.clientSecret,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new GoogleOAuthError(`Google token refresh failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  return res.json(); // { access_token, expires_in, scope, token_type } -- refresh_token usually NOT re-issued here
}

async function getUserEmail(accessToken) {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new GoogleOAuthError(`Couldn't read the Gmail profile (${res.status}).`);
  }
  const data = await res.json();
  return data.emailAddress;
}

module.exports = { buildAuthUrl, exchangeCodeForTokens, refreshAccessToken, getUserEmail, GoogleOAuthError };
