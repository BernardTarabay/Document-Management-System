const documentTypeRepository = require("../repositories/documentTypeRepository");

async function list(req, res) {
  res.json(await documentTypeRepository.list({ limit: 200 }));
}

module.exports = { list };
