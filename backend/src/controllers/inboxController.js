const inboxMessageRepository = require("../repositories/inboxMessageRepository");
const { parsePagination } = require("../utils/pagination");

async function list(req, res) {
  const { limit, offset } = parsePagination(req.query);
  const status = req.query.status === "deleted" ? "deleted" : "kept";
  res.json(await inboxMessageRepository.listForUser(req.user.id, { status, limit, offset }));
}

module.exports = { list };
