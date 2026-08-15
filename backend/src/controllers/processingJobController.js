const processingJobService = require("../services/processingJobService");

async function list(req, res) {
  res.json(await processingJobService.search(req.query, req.user.id));
}

async function count(req, res) {
  res.json(await processingJobService.count(req.query, req.user.id));
}

async function getOne(req, res) {
  res.json(await processingJobService.getById(req.params.id, req.user.id));
}

module.exports = { list, count, getOne };
