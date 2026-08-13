const express = require("express");
const controller = require("../controllers/fileController");
const { authenticate } = require("../middleware/authenticate");
const { requirePermission } = require("../middleware/requirePermission");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();
router.use(authenticate);

router.get("/", requirePermission("document.view"), asyncHandler(controller.list));
// Both registered before "/:id", or the literal path segment is read as a
// file id and answered with "Malformed id" from the Postgres uuid cast.
// (That is not hypothetical -- the Subjects map was calling a
// never-registered GET /files/search and silently swallowing the 400.)
router.get("/count", requirePermission("document.view"), asyncHandler(controller.count));
router.get("/filter-options", requirePermission("document.view"), asyncHandler(controller.filterOptions));
router.delete("/remove-all", requirePermission("document.delete"), asyncHandler(controller.removeAll));
// Read-only similarity check between any two files. Registered before
// "/:id" so "compare" is never swallowed as a file id. Only reveals how
// alike two files the user can already view are, so document.view is the
// right bar.
router.post("/compare", requirePermission("document.view"), asyncHandler(controller.compare));
router.get("/:id", requirePermission("document.view"), asyncHandler(controller.getOne));
router.get("/:id/download", requirePermission("document.download"), asyncHandler(controller.download));
// Preview streams the same bytes as download (mime-whitelisted, inline) --
// same permission bar as download since it exposes the same content.
router.get("/:id/preview", requirePermission("document.download"), asyncHandler(controller.preview));
// Field-level permission checks (document.rename / classification.modify)
// happen inside the controller, since which permission applies depends on
// which fields are actually present in the request body.
router.patch("/:id", requirePermission("document.view"), asyncHandler(controller.update));
// Same permission bar as download -- this never sends bytes over the
// network at all, it just spawns the host OS's file manager, so it isn't
// more sensitive than download, only more environment-dependent (see
// fileService.revealInFileManager).
router.post("/:id/reveal", requirePermission("document.download"), asyncHandler(controller.reveal));
router.delete("/:id", requirePermission("document.delete"), asyncHandler(controller.remove));

module.exports = router;
