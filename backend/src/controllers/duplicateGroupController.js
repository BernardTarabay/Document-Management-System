const duplicateGroupService = require("../services/duplicateGroupService");

async function list(req, res) {
  res.json(await duplicateGroupService.search(req.query));
}

async function getOne(req, res) {
  res.json(await duplicateGroupService.getById(req.params.id));
}

async function resolve(req, res) {
  res.json(await duplicateGroupService.resolve(req.params.id, req.body, req.user.id));
}

async function autoResolveAll(req, res) {
  const job = await duplicateGroupService.enqueueAutoResolveAll(req.user.id);
  res.status(202).json({ processingJobId: job.id, status: job.status });
}

module.exports = { list, getOne, resolve, autoResolveAll };
