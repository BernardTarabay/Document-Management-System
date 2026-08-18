const documentTypeRepository = require("../repositories/documentTypeRepository");
const documentTypeService = require("../services/documentTypeService");

/**
 * The plain list, unchanged: this is what the type dropdowns in EditFileModal
 * and DocumentsPage bind to, and they want an array, not an envelope.
 */
async function list(req, res) {
  res.json(await documentTypeRepository.list({ limit: 200 }));
}

/**
 * The browse surface: the same types with a filtered file count each, plus how
 * many files carry no type at all. Separate from `list` so a dropdown does not
 * pay for two aggregate queries every time a modal opens.
 */
async function browse(req, res) {
  res.json(await documentTypeService.list(req.query, req.user.id));
}

module.exports = { list, browse };
