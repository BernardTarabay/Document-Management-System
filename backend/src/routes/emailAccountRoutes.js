const express = require("express");
const controller = require("../controllers/emailAccountController");
const { authenticate } = require("../middleware/authenticate");
const { requirePermission } = require("../middleware/requirePermission");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();

// Public on purpose: Google/Microsoft redirect the browser here directly
// with no Authorization header, so this route can't sit behind the
// `authenticate` middleware every other route in this file uses. Identity
// is instead recovered from the signed `state` param (see
// emailAccountService.handleCallback / utils/jwt.js signOAuthState) --
// registered BEFORE router.use(authenticate, ...) below so Express never
// routes it through that middleware.
router.get("/oauth/:provider/callback", asyncHandler(controller.callback));

router.use(authenticate, requirePermission("email.manage"));

router.get("/", asyncHandler(controller.list));
router.get("/connect/:provider", asyncHandler(controller.connect));
router.post("/:id/sync", asyncHandler(controller.sync));
router.delete("/:id", asyncHandler(controller.remove));

module.exports = router;
