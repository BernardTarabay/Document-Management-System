const express = require("express");
const controller = require("../controllers/agentController");
const { authenticate } = require("../middleware/authenticate");
const { authenticateAgent } = require("../middleware/authenticateAgent");
const { requirePermission } = require("../middleware/requirePermission");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();

// --- agent-facing -------------------------------------------------------
// Registered BEFORE the user `authenticate` middleware below, because an
// agent presents an agent token (different secret, no user identity) and
// would be rejected outright by it.

// Unauthenticated by necessity: this IS the authentication step, exchanging
// the long-lived API key for a short-lived session token. Rate-limited at
// the app level like the other credential-accepting route (/api/auth).
router.post("/session", asyncHandler(controller.openSession));

router.post("/heartbeat", authenticateAgent, asyncHandler(controller.heartbeat));
router.get("/operations", authenticateAgent, asyncHandler(controller.poll));
router.post("/operations/:operationId/result", authenticateAgent, asyncHandler(controller.report));

// --- admin-facing -------------------------------------------------------
router.use(authenticate);

router.get("/", requirePermission("agent.manage"), asyncHandler(controller.list));
router.post("/", requirePermission("agent.manage"), asyncHandler(controller.register));
router.delete("/:id", requirePermission("agent.manage"), asyncHandler(controller.revoke));
router.get("/:id/operations", requirePermission("agent.manage"), asyncHandler(controller.listOperations));

module.exports = router;
