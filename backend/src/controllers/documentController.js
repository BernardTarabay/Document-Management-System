const documentService = require("../services/documentService");

async function list(req, res) {
  res.json(await documentService.search(req.query));
}

async function getOne(req, res) {
  res.json(await documentService.getById(req.params.id));
}

async function update(req, res) {
  res.json(await documentService.update(req.params.id, req.body, req.user.id));
}

module.exports = { list, getOne, update };
