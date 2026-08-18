const express = require("express");
const controller = require("../controllers/duplicateGroupController");
const { authenticate } = require("../middleware/authenticate");
const { requirePermission } = require("../middleware/requirePermission");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();
router.use(authenticate, requirePermission("duplicate.manage"));

// Reclaiming disk space from resolved duplicates.
//
// AFTER the router-level authenticate, not before it. Registered above that
// line these ran with no req.user at all -- they answered 401 only because
// requirePermission happens to check for one, which is luck rather than a
// guard, and this is the one route in the application that deletes files from
// disk.
//
// Literal segments before "/:id" as everywhere else, or "redundant-copies" is
// read as a group id and fails the uuid cast.
//
// The preview is read-only and inherits duplicate.manage from the router. The
// delete needs document.delete on top, AND a typed confirmation in the body.
router.get("/redundant-copies", asyncHandler(controller.redundantPreview));
router.post("/redundant-copies/delete", requirePermission("document.delete"), asyncHandler(controller.deleteRedundant));

router.get("/", asyncHandler(controller.list));
router.post("/auto-resolve", asyncHandler(controller.autoResolveAll));
router.get("/:id", asyncHandler(controller.getOne));
router.post("/:id/resolve", asyncHandler(controller.resolve));

module.exports = router;
