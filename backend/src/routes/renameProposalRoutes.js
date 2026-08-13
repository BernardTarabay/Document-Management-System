const express = require("express");
const controller = require("../controllers/renameProposalController");
const { authenticate } = require("../middleware/authenticate");
const { requirePermission } = require("../middleware/requirePermission");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();
router.use(authenticate);

router.get("/", requirePermission("document.view"), asyncHandler(controller.list));
router.get("/pending-count", requirePermission("document.view"), asyncHandler(controller.pendingCount));

// "Approve everything above 90%". The GET is the dry run the confirmation
// card uses to say how many will be affected; the POST commits.
//
// These MUST come before the "/:id/..." routes below. Express matches in
// registration order, so with "/:id/approve" first, POST
// /above-confidence/approve would bind id = "above-confidence" and fail
// looking up a proposal by that name.
router.get("/above-confidence", requirePermission("document.view"), asyncHandler(controller.countAboveConfidence));
router.post("/above-confidence/approve", requirePermission("bulk.approve"), asyncHandler(controller.approveAboveConfidence));

// "Clear out everything at 0%" -- the other end of the same dial, and
// subject to the same ordering rule as the routes above.
//
// Gated on bulk.approve rather than document.rename: rejecting changes no
// file and queues no work, but discarding several thousand suggestions in
// one request is still a bulk decision, and the weaker permission exists for
// acting on ONE proposal at a time.
router.get("/below-confidence", requirePermission("document.view"), asyncHandler(controller.countBelowConfidence));
router.post("/below-confidence/reject", requirePermission("bulk.approve"), asyncHandler(controller.rejectBelowConfidence));

router.post("/bulk-apply", requirePermission("bulk.approve"), asyncHandler(controller.bulkApply));

router.post("/:id/approve", requirePermission("document.rename"), asyncHandler(controller.approve));
router.post("/:id/reject", requirePermission("document.rename"), asyncHandler(controller.reject));
router.post("/:id/retry", requirePermission("document.rename"), asyncHandler(controller.retry));

module.exports = router;
