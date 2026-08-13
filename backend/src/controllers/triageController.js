const triageService = require("../services/triageService");

async function list(req, res) {
  res.json(await triageService.list(req.query));
}

async function summary(req, res) {
  res.json(await triageService.summary());
}

async function retry(req, res) {
  res.json(await triageService.retry(req.params.id, req.user.id));
}

module.exports = { list, summary, retry };
