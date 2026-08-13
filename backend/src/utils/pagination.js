// Shared query-param pagination parsing (spec §15/§30: paginate, never scan
// everything for an ordinary request). Caps `limit` so a client can't force
// an unbounded query.
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parsePagination(query = {}) {
  let limit = parseInt(query.limit, 10);
  let offset = parseInt(query.offset, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  return { limit, offset };
}

module.exports = { parsePagination };
