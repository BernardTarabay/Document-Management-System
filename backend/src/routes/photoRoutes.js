const express = require("express");
const controller = require("../controllers/photoController");
const { authenticate } = require("../middleware/authenticate");
const { requirePermission } = require("../middleware/requirePermission");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();
router.use(authenticate);

// Reads sit at document.view -- a photo is a document, and this page shows
// the same files the Files page already does, arranged for looking at rather
// than reading.
//
// The IMAGE ITSELF is not served from here. It comes from
// GET /files/:id/preview, which is owner-scoped, mime-whitelisted, and
// returns a rasterised picture rather than the file's own bytes. Keeping one
// image endpoint means there is one place where "may this account see these
// pixels" is decided, instead of two that can drift.
router.get("/", requirePermission("document.view"), asyncHandler(controller.list));
// Before "/:id" so the literal segment is never read as a file id.
router.get("/summary", requirePermission("document.view"), asyncHandler(controller.summary));
router.post("/ocr/run-pending", requirePermission("scan.run"), asyncHandler(controller.runOcrForPending));
// Bulk actions for the grid. Each is gated exactly as the equivalent
// single-file action elsewhere, because each IS the equivalent single-file
// action, looped -- there is no bulk fast path that skips a check.
router.post("/move", requirePermission("document.move"), asyncHandler(controller.moveMany));
router.post("/archive", requirePermission("document.delete"), asyncHandler(controller.archiveMany));
router.patch("/:id/rename", requirePermission("document.rename"), asyncHandler(controller.rename));
router.get("/:id", requirePermission("document.view"), asyncHandler(controller.detail));

// Running OCR is real background work against the user's files, so it is
// gated like the other "make the pipeline run" action rather than like a read.
router.post("/:id/ocr", requirePermission("scan.run"), asyncHandler(controller.runOcr));

module.exports = router;
