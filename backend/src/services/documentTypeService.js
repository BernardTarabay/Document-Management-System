const documentTypeRepository = require("../repositories/documentTypeRepository");
const fileRepository = require("../repositories/fileRepository");
const { parseFileFilters } = require("../repositories/fileFilters");
const { requireOwner } = require("../repositories/ownership");

/**
 * The document-type axis with a file count against each type.
 *
 * Mirrors subjectService.list on purpose, including the part that matters
 * most: the counts honour the SAME filters as the list they link to. A type
 * that says "412" and then opens to 3 files because a filter is on is worse
 * than showing no number at all.
 *
 * `untyped` is returned alongside rather than being left for the caller to
 * derive. On this corpus most files legitimately have no type -- the rule tier
 * only assigns one from a filename or an extension, deliberately (see
 * docs/03-taxonomy.md §3.4) -- and a page that showed only the populated types
 * would quietly imply the archive is smaller than it is.
 */
async function list(query = {}, ownerUserId) {
  requireOwner(ownerUserId, "documentTypeService.list");
  const filters = parseFileFilters(query, ownerUserId);

  const [types, counts, untyped] = await Promise.all([
    documentTypeRepository.list({ limit: 200 }),
    fileRepository.countsByDocumentType({ filters }),
    fileRepository.countUntyped({ filters }),
  ]);

  return {
    documentTypes: types.map((type) => ({ ...type, fileCount: counts[type.id] || 0 })),
    untypedCount: untyped,
  };
}

module.exports = { list };
