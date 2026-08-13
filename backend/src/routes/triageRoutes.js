const express = require("express");
const controller = require("../controllers/triageController");
const { authenticate } = require("../middleware/authenticate");
const { requirePermission } = require("../middleware/requirePermission");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();
router.use(authenticate);

// Reading the queue exposes nothing beyond what the Files page already shows
// about the same files -- name, path, and why the pipeline gave up on them --
// so it sits at the same bar as viewing a file.
router.get("/", requirePermission("document.view"), asyncHandler(controller.list));
// Registered before "/:id/..." would matter if a GET on an id existed; kept
// above the retry route anyway so "summary" can never be read as a file id.
router.get("/summary", requirePermission("document.view"), asyncHandler(controller.summary));
// Retry enqueues real background work (hashing, re-extraction, whatever
// stage failed), so it is gated like the other "make the pipeline run"
// action -- scan.run -- rather than like a read.
router.post("/:id/retry", requirePermission("scan.run"), asyncHandler(controller.retry));

module.exports = router;
