const express = require("express");
const controller = require("../controllers/subjectController");
const { authenticate } = require("../middleware/authenticate");
const { requirePermission } = require("../middleware/requirePermission");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();
router.use(authenticate, requirePermission("document.view"));

// POST /import is gone along with the other byte-upload routes. Like
// /storage-locations/upload, it copied file bytes into the managed upload
// folder -- see routes/storageLocationRoutes.js for why that whole approach
// was removed. Registering a folder indexes it in place instead, and the
// taxonomy is built from classification rather than from folder names.

router.get("/", asyncHandler(controller.list));
// Before "/:id/..." so the literal segment is never read as a subject id.
router.get("/recent", asyncHandler(controller.recentDestinations));
router.get("/:id/documents", asyncHandler(controller.documentsForSubject));
// Structural taxonomy changes (create/rename/delete a Subject/Category/
// Subcategory) are gated behind subject.manage, distinct from
// classification.modify which only governs assigning an existing subject
// to a file (see fileController.update / PATCH /files/:id).
router.post("/", requirePermission("subject.manage"), asyncHandler(controller.create));
router.patch("/:id", requirePermission("subject.manage"), asyncHandler(controller.update));
router.delete("/:id", requirePermission("subject.manage"), asyncHandler(controller.remove));

module.exports = router;
