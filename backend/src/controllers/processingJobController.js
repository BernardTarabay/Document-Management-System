const processingJobService = require("../services/processingJobService");

async function list(req, res) {
  res.json(await processingJobService.search(req.query));
}

async function getOne(req, res) {
  res.json(await processingJobService.getById(req.params.id));
}

module.exports = { list, getOne };
