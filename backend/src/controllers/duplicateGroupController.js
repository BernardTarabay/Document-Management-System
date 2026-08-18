const duplicateGroupService = require("../services/duplicateGroupService");
const redundantCopyService = require("../services/redundantCopyService");

async function list(req, res) {
  res.json(await duplicateGroupService.search(req.query, req.user.id));
}

async function getOne(req, res) {
  res.json(await duplicateGroupService.getById(req.params.id, req.user.id));
}

async function resolve(req, res) {
  res.json(await duplicateGroupService.resolve(req.params.id, req.body, req.user.id));
}

async function autoResolveAll(req, res) {
  const job = await duplicateGroupService.enqueueAutoResolveAll(req.user.id);
  res.status(202).json({ processingJobId: job.id, status: job.status });
}


/**
 * The dry run. Always available, never destructive -- this is what the
 * confirmation dialog is written against, and what a cautious user runs first.
 */
async function redundantPreview(req, res) {
  const result = await redundantCopyService.listRedundant(req.user.id);
  res.json({
    deletable: result.deletable.map((r) => ({
      fileId: r.copy_id, path: r.copy_path, name: r.copy_name,
      location: r.copy_location, sizeBytes: Number(r.size_bytes),
      keptPath: r.canonical_path, keptLocation: r.canonical_location,
    })),
    blocked: result.blocked.map((r) => ({ path: r.copy_path, location: r.copy_location, reason: r.reason })),
    reclaimableBytes: result.reclaimableBytes,
  });
}

/**
 * DELETES FILES FROM DISK. The only route in this application that does.
 *
 * Two-step, like the Trash purge and for a stronger reason: the Trash purge
 * removes a database row and leaves your file alone, while this removes the
 * file itself. The phrase has to be typed, so no mis-wired button and no stray
 * click can reach it.
 */
async function deleteRedundant(req, res) {
  const { fileIds, confirm } = req.body || {};
  if (String(confirm || "").trim().toLowerCase() !== "delete redundant copies") {
    return res.status(400).json({
      error: 'This deletes files from your disk and cannot be undone. Send confirm: "delete redundant copies" to proceed.',
      requiresConfirmation: true,
    });
  }
  res.json(await redundantCopyService.deleteRedundant(req.user.id, {
    fileIds: Array.isArray(fileIds) && fileIds.length ? fileIds : null,
  }));
}

module.exports = { list, getOne, resolve, autoResolveAll, redundantPreview, deleteRedundant };