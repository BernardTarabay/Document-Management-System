// Minimal, dependency-free input validation (spec §29: "Input validation").
// No schema library is in package.json, so these are small, explicit
// functions rather than pulling in a new dependency for a handful of checks.
const { ValidationError } = require("./validationError");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateRegisterInput(body) {
  const { email, password, fullName } = body || {};
  if (!email || !EMAIL_RE.test(email)) throw new ValidationError("A valid email is required.");
  if (!password || password.length < 8) throw new ValidationError("Password must be at least 8 characters.");
  if (!fullName || !fullName.trim()) throw new ValidationError("Full name is required.");
  return { email: email.toLowerCase().trim(), password, fullName: fullName.trim() };
}

function validateLoginInput(body) {
  const { email, password } = body || {};
  if (!email || !password) throw new ValidationError("Email and password are required.");
  return { email: email.toLowerCase().trim(), password };
}

function validateRefreshInput(body) {
  const { refreshToken } = body || {};
  if (!refreshToken) throw new ValidationError("refreshToken is required.");
  return { refreshToken };
}

module.exports = { validateRegisterInput, validateLoginInput, validateRefreshInput };
