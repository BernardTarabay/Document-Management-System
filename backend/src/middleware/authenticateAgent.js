// Authenticates a Filesystem Agent's session token and attaches the agent
// row as req.agent.
//
// Deliberately separate from middleware/authenticate.js: an agent is not a
// user. It has no role, no permissions, and must never be able to reach a
// route that expects req.user -- the two token kinds are signed with
// different secrets (AGENT_JWT_SECRET vs JWT_ACCESS_SECRET) precisely so
// one can never be presented as the other.
const agentService = require("../services/agentService");
const filesystemAgentRepository = require("../repositories/filesystemAgentRepository");

async function authenticateAgent(req, res, next) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or malformed Authorization header." });
  }

  let payload;
  try {
    payload = agentService.verifySessionToken(header.slice(7));
  } catch {
    return res.status(401).json({ error: "Invalid or expired agent session token." });
  }

  const agent = await filesystemAgentRepository.findById(payload.sub);
  // Re-checked on every request, not just at session open: revoking an
  // agent has to take effect immediately, not whenever its hour-long token
  // happens to expire.
  if (!agent || agent.revoked_at) {
    return res.status(401).json({ error: "This agent has been revoked." });
  }

  req.agent = agent;
  next();
}

module.exports = { authenticateAgent };
