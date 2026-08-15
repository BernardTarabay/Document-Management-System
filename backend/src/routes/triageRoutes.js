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
// Registered before "/:id/..." so "summary" can never be read as a file id.
router.get("/summary", requirePermission("document.view"), asyncHandler(controller.summary));
// Bulk file, and delete. Registered BEFORE "/:id" so the literal segments are
// never read as a file id.
//
// There is no bulk "retry" here on purpose -- see triageService.actionsFor.
// Retrying sends a file through a stage that already reached the right
// conclusion, so it lands straight back in the queue; what actually clears
// triage is filing the document or removing it.
router.post("/move", requirePermission("document.move"), asyncHandler(controller.moveMany));
router.post("/delete", requirePermission("document.delete"), asyncHandler(controller.removeMany));
router.delete("/:id", requirePermission("document.delete"), asyncHandler(controller.remove));
router.get("/:id", requirePermission("document.view"), asyncHandler(controller.inspect));

// Retry enqueues real background work (hashing, re-extraction, whatever
// stage failed), so it is gated like the other "make the pipeline run"
// action -- scan.run -- rather than like a read.
router.post("/:id/retry", requirePermission("scan.run"), asyncHandler(controller.retry));

// The actions that make triage a workspace rather than a list.
//
// Each is permissioned as the SAME action performed anywhere else in the app,
// because each is literally the same service call -- filing from triage and
// filing from the Files page are one implementation
// (fileOrganizeService.moveToSubject), so they cannot have different bars
// without one of them being wrong.
router.post("/:id/move", requirePermission("document.move"), asyncHandler(controller.moveToSubject));
router.post("/:id/rename", requirePermission("document.rename"), asyncHandler(controller.rename));
// Keeping the existing name changes no file and queues no work; it records a
// decision. Gated on rename because it is the other half of that decision --
// whoever may accept a suggested name may decline one.
router.post("/:id/keep-name", requirePermission("document.rename"), asyncHandler(controller.keepOriginalName));
router.post("/:id/archive", requirePermission("document.delete"), asyncHandler(controller.archive));
// Read-only: reports what the guard would say, changes nothing.
router.get("/:id/duplicates", requirePermission("document.view"), asyncHandler(controller.checkDuplicates));

module.exports = router;
