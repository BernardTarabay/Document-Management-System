const express = require("express");
const deviceService = require("../services/deviceService");
const { authenticate } = require("../middleware/authenticate");
const { requirePermission } = require("../middleware/requirePermission");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();
router.use(authenticate);

// Devices are the machines whose disks hold this account's files. Listing
// them exposes hostnames and platforms, which is repository information about
// the caller's own setup -- document.view is the right bar, and every query
// behind it is scoped to the caller.
router.get("/", requirePermission("document.view"), asyncHandler(async (req, res) => {
  res.json(await deviceService.list(req.user.id));
}));

// Registered before "/:id" so the literal segment is never read as a device id.
router.get("/replication", requirePermission("document.view"), asyncHandler(async (req, res) => {
  res.json(await deviceService.replicationStatus(req.user.id));
}));

// Where one file's bytes are and whether they are reachable right now. Lives
// under /devices rather than /files because it is a question about machines.
router.get("/availability/:fileId", requirePermission("document.view"), asyncHandler(async (req, res) => {
  res.json(await deviceService.availabilityFor(req.params.fileId, req.user.id));
}));

router.patch("/:id", requirePermission("device.manage"), asyncHandler(async (req, res) => {
  res.json(await deviceService.rename(req.params.id, req.body?.name, req.user.id));
}));

module.exports = router;
