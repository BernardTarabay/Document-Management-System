// Filesystem Agent lifecycle and operation brokering
// (docs/04-storage-architecture.md §4.4-§4.5).
//
// The security posture, restated from §4.5 because every function here
// depends on it: the AGENT authenticates to the BACKEND, never the reverse.
// The agent receives typed operations referencing paths the backend has
// already resolved and validated against the Storage Location's root_path
// and the agent's registered_directories. It never receives a shell
// command, and never a path it is trusted to police itself.
const crypto = require("crypto");
const path = require("path");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");

const filesystemAgentRepository = require("../repositories/filesystemAgentRepository");
const agentOperationRepository = require("../repositories/agentOperationRepository");
const storageLocationRepository = require("../repositories/storageLocationRepository");
const auditLogRepository = require("../repositories/auditLogRepository");
const env = require("../config/env");
const { resolveWithinRoot } = require("../utils/pathSafety");
const { ValidationError } = require("../validators/validationError");

const API_KEY_BYTES = 32;
const SESSION_TTL = "1h";

class AgentAuthError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 401;
    this.publicMessage = message;
  }
}

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 404;
    this.publicMessage = message;
  }
}

function agentSecret() {
  // Deliberately separate from the user JWT secret: an agent token and a
  // user token must never be interchangeable, or a leaked agent key would
  // become a way to mint user sessions.
  if (!env.agentJwtSecret) {
    throw new Error("AGENT_JWT_SECRET is not set -- required before any Filesystem Agent can connect.");
  }
  return env.agentJwtSecret;
}

// --- registration (admin-facing) ---------------------------------------

/**
 * Register a new agent for an `agent`-mode Storage Location and issue its
 * API key. The plaintext key is returned exactly once and never stored --
 * only its bcrypt hash goes to the database, same treatment as a user
 * password.
 */
async function register({ storageLocationId, name, registeredDirectories = [] }, actorUserId) {
  const location = await storageLocationRepository.findById(storageLocationId);
  if (!location) throw new NotFoundError("Storage location not found.");
  if (location.access_mode !== "agent") {
    throw new ValidationError(
      `Storage location "${location.name}" has access_mode "${location.access_mode}"; ` +
      "only 'agent' locations are brokered by a Filesystem Agent."
    );
  }
  if (!name || !String(name).trim()) throw new ValidationError("An agent name is required.");

  const apiKey = crypto.randomBytes(API_KEY_BYTES).toString("hex");
  const apiKeyHash = await bcrypt.hash(apiKey, env.bcryptSaltRounds);

  const agent = await filesystemAgentRepository.create({
    storageLocationId,
    name: String(name).trim(),
    apiKeyHash,
    registeredDirectories,
  });

  await auditLogRepository.record({
    userId: actorUserId,
    action: "agent.registered",
    entityType: "filesystem_agent",
    entityId: agent.id,
    newState: { name: agent.name, storageLocationId, registeredDirectories },
    reason: "Filesystem Agent registered",
  });

  // apiKey is returned here and nowhere else, ever.
  return { agent, apiKey };
}

async function revoke(agentId, actorUserId) {
  const agent = await filesystemAgentRepository.findById(agentId);
  if (!agent) throw new NotFoundError("Agent not found.");

  await filesystemAgentRepository.revoke(agentId);
  await auditLogRepository.record({
    userId: actorUserId,
    action: "agent.revoked",
    entityType: "filesystem_agent",
    entityId: agentId,
    reason: "Filesystem Agent access revoked",
  });
  return { success: true };
}

// --- authentication (agent-facing) -------------------------------------

/**
 * Exchange the long-lived API key for a short-lived session token. The key
 * itself is then only on the wire once per session rather than on every
 * poll, and a leaked token expires on its own.
 */
async function openSession({ agentId, apiKey, agentVersion, platform, hostname }) {
  if (!agentId || !apiKey) throw new AgentAuthError("agentId and apiKey are required.");

  const agent = await filesystemAgentRepository.findById(agentId);
  // Same generic message whether the agent is unknown, revoked or the key
  // is wrong -- an enumeration oracle here would let someone probe which
  // agent ids exist.
  const invalid = new AgentAuthError("Invalid agent credentials.");
  if (!agent || agent.revoked_at) throw invalid;

  const ok = await bcrypt.compare(apiKey, agent.api_key_hash || "");
  if (!ok) throw invalid;

  await filesystemAgentRepository.updateEnrollment(agent.id, { agentVersion, platform, hostname });
  await filesystemAgentRepository.markHeartbeat(agent.id);

  const location = await storageLocationRepository.findById(agent.storage_location_id);
  const token = jwt.sign({ sub: agent.id, kind: "agent" }, agentSecret(), { expiresIn: SESSION_TTL });

  return {
    token,
    expiresIn: SESSION_TTL,
    agent: {
      id: agent.id,
      name: agent.name,
      storageLocationId: agent.storage_location_id,
      storageLocationName: location?.name || null,
      rootPath: location?.root_path || null,
      registeredDirectories: parseDirectories(agent.registered_directories),
    },
  };
}

function verifySessionToken(token) {
  const payload = jwt.verify(token, agentSecret());
  if (payload.kind !== "agent") throw new AgentAuthError("Not an agent token.");
  return payload;
}

async function heartbeat(agentId, { registeredDirectories } = {}) {
  if (Array.isArray(registeredDirectories)) {
    await filesystemAgentRepository.updateEnrollment(agentId, { registeredDirectories });
  }
  const agent = await filesystemAgentRepository.markHeartbeat(agentId);
  if (!agent) throw new NotFoundError("Agent not found.");
  return { status: agent.status, lastSeenAt: agent.last_seen_at };
}

// --- operation brokering ------------------------------------------------

function parseDirectories(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * docs/04 §4.5 principle 3: the backend validates every path against the
 * Storage Location root AND the agent's registered directories BEFORE
 * issuing an operation. Both checks live here so no caller can skip one.
 *
 * An empty registered_directories list means "the whole root" -- an agent
 * that has not narrowed its scope operates on everything under root_path,
 * which is still bounded by the root check.
 */
function assertPathAllowed(relativePath, rootPath, registeredDirectories) {
  // Throws PathTraversalError (400) if it escapes -- never left to the agent.
  resolveWithinRoot(rootPath, relativePath);

  const dirs = parseDirectories(registeredDirectories);
  if (dirs.length === 0) return;

  const normalized = path.posix.normalize(String(relativePath).replace(/\\/g, "/")).replace(/^\.\//, "");
  const allowed = dirs.some((dir) => {
    const d = path.posix.normalize(String(dir).replace(/\\/g, "/")).replace(/^\.\//, "").replace(/\/$/, "");
    if (d === "" || d === ".") return true;
    // Prefix match on a SEGMENT boundary -- "Finance" must not authorize
    // "Finance-Private", the same off-by-one resolveWithinRoot guards against.
    return normalized === d || normalized.startsWith(`${d}/`);
  });

  if (!allowed) {
    throw new ValidationError(
      `Path "${relativePath}" is outside this agent's registered directories (${dirs.join(", ")}).`
    );
  }
}

async function enqueueOperation(agent, operationType, payload, { expiresInSeconds = 300 } = {}) {
  const location = await storageLocationRepository.findById(agent.storage_location_id);
  if (!location) throw new NotFoundError("Storage location for this agent no longer exists.");

  for (const key of ["path", "fromPath", "toPath", "targetRelativeDir"]) {
    if (payload[key]) assertPathAllowed(payload[key], location.root_path, agent.registered_directories);
  }

  return agentOperationRepository.create({ agentId: agent.id, operationType, payload, expiresInSeconds });
}

async function pollOperations(agentId, limit = 10) {
  await agentOperationRepository.expireOverdue();
  await filesystemAgentRepository.markHeartbeat(agentId);
  return agentOperationRepository.claimNext(agentId, limit);
}

async function reportResult(agentId, operationId, { success, result, errorMessage }) {
  const updated = await agentOperationRepository.complete(operationId, agentId, {
    status: success ? "succeeded" : "failed",
    result: result ? JSON.stringify(result) : null,
    errorMessage: errorMessage || null,
  });
  if (!updated) {
    // Either not this agent's operation, or it already expired/completed.
    // Reported as 404 rather than silently accepted so a confused agent
    // learns its view is stale.
    throw new NotFoundError("No dispatched operation with that id for this agent.");
  }

  if (!success) {
    await auditLogRepository.record({
      action: "agent.operation_failed",
      entityType: "agent_operation",
      entityId: operationId,
      newState: { operationType: updated.operation_type, errorMessage },
      reason: "Filesystem Agent reported an operation failure",
    });
  }
  return updated;
}

module.exports = {
  AgentAuthError,
  NotFoundError,
  register,
  revoke,
  openSession,
  verifySessionToken,
  heartbeat,
  enqueueOperation,
  pollOperations,
  reportResult,
  assertPathAllowed,
  parseDirectories,
};
