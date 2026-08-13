// Rate limiting (spec §29). Auth endpoints get a tight limiter since they're
// the classic brute-force/credential-stuffing target; the rest of the API
// gets a looser general limiter. Both are in-memory (fine for a single
// process); a multi-instance deployment would swap the store for a
// Redis-backed one without changing call sites.
const rateLimit = require("express-rate-limit");

// 15 minutes, 30 attempts per IP.
//
// This used to read `15 * 60 * 1000 * 10` with a `// 15 minutes` comment and a
// limit of 1000 -- a 2.5-HOUR window allowing 1000 attempts, which is not a
// brute-force control at all, it is a typo wearing one's clothes. 30 per
// quarter-hour is far more than a human signing in ever needs and far less
// than a password-guessing client wants.
//
// `skipSuccessfulRequests` means a working session is never penalised: only
// failures count toward the limit, so the person who mistypes once and then
// gets it right is unaffected, while the client that is only ever wrong runs
// out quickly.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many failed auth attempts. Wait a few minutes and try again." },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down." },
});

module.exports = { authLimiter, apiLimiter };
