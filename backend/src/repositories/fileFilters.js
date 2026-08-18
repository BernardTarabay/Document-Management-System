// Search filters (task #44): file type, date range, subject, location.
//
// WHY A SHARED BUILDER RATHER THAN PREDICATES PER QUERY
//
// A filter that only works when you have also typed a search term is not a
// filter -- "show me every PDF from 2019" has no search term in it. So the
// same predicates have to apply to four different queries: full-text search,
// the Files page's default listing, the file list inside a subject, and the
// per-subject counts the taxonomy tree is drawn from. Four hand-written
// copies of "is this file a PDF from 2019" is four chances for the tree to
// disagree with the list it links to.
//
// This module is deliberately free of any database handle so the predicate
// building and the input parsing can be unit-tested directly
// (tests/fileFilters.test.js). It emits SQL fragments against the alias `f`
// (the `files` table) and the parameter array they refer to; nothing here
// ever interpolates a user value into SQL.
//
// OWNERSHIP RIDES ALONG WITH THE FILTERS, AND IS NOT OPTIONAL
//
// The paragraph above -- "four hand-written copies is four chances to
// disagree" -- applies with far more force to `owner_user_id` than to file
// type. A file-type filter that goes missing shows the user too many of their
// OWN files, which they will notice immediately. An owner predicate that goes
// missing shows them somebody else's, which looks exactly like working
// software.
//
// So the owner is part of the filter object, it is validated at parse time,
// and buildFilterClauses emits it first and unconditionally. There is no code
// path through this module that produces SQL without it.
const { ValidationError } = require("../validators/validationError");
const { requireOwner } = require("./ownership");

/**
 * What counts as a file the user is currently working with.
 *
 * Archive and Trash are lifecycle statuses (migration 037), so a file in either
 * has to vanish from every ordinary listing, count and search -- not be styled
 * differently, not appear with a badge. Written once here because the three
 * queries that must agree about this (the listing, the count beside it, and the
 * id sweep behind "select all") are in three different functions, and a
 * definition repeated three times is a definition that will eventually differ
 * three ways. That already happened once with `status != 'deleted'`, which is
 * why "select all N" quietly selected fewer than N.
 *
 * Written against the alias `f`, like everything else in this module.
 */
const LISTABLE_STATUS = "f.status NOT IN ('deleted', 'archived')";

/**
 * Hide the losing copy of a duplicate the user has already settled.
 *
 * WHY THIS IS A DEFAULT AND NOT A FILTER
 *
 * Once a duplicate group is RESOLVED, a canonical copy has been chosen -- the
 * question "which of these is the one I keep" has an answer. Continuing to list
 * the other copies means a library of 16 documents reports 31, the same
 * photograph appears twice in the grid, and every count is inflated by however
 * many backup folders happen to be registered. The system knows they are the
 * same document and shows them as two anyway.
 *
 * UNRESOLVED groups are deliberately untouched. Nobody has decided which copy
 * is the keeper, so hiding one would be picking for them, silently.
 *
 * Nothing is deleted and nothing is hidden permanently: the Duplicates page
 * lists every group, and the reclaimable-bytes figure is still built on all the
 * copies. This governs only the views that answer "what documents do I have".
 *
 * This predicate already existed, written out by hand in seven separate
 * queries, and was missing from every query the Library, the Photos grid and
 * the dashboard actually read -- which is exactly how the two halves of the app
 * came to disagree about how many documents there are. One definition now.
 *
 * Written against the alias `f`, like everything else here.
 */
const NOT_A_DUPLICATE_COPY = `NOT EXISTS (
  SELECT 1 FROM duplicate_group_members dgm
  JOIN duplicate_groups dg ON dg.id = dgm.duplicate_group_id
  WHERE dgm.file_id = f.id
    AND dg.canonical_file_id IS NOT NULL
    AND dg.canonical_file_id <> f.id
)`;

/** What an ordinary "my documents" query means: live, and not a settled copy. */
const LISTABLE_FILE = `${LISTABLE_STATUS} AND ${NOT_A_DUPLICATE_COPY}`;

/** The sentinel for "files with no extension at all" -- see parseExtensions. */
const NO_EXTENSION = "none";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Bounded so a pasted list cannot turn one request into a thousand-element
// array comparison.
const MAX_EXTENSIONS = 40;

/**
 * ".PDF", "pdf", " Pdf " all mean the same filter.
 *
 * `files.extension` is stored without a leading dot and with whatever case
 * the filesystem had, which is why every count in dashboardRepository lowers
 * it. The `none` sentinel exists because a file with no extension is
 * otherwise unreachable: it appears in the facet list (as "(none)") and an
 * option you can see but cannot select is worse than no option.
 */
function parseExtensions(raw) {
  if (raw === undefined || raw === null || raw === "") return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(",");
  const cleaned = list
    .map((e) => String(e).trim().replace(/^\.+/, "").toLowerCase())
    .filter(Boolean);
  if (cleaned.length > MAX_EXTENSIONS) {
    throw new ValidationError(`Too many file types selected (max ${MAX_EXTENSIONS}).`);
  }
  return [...new Set(cleaned)];
}

/**
 * A calendar day, refused rather than coerced if it is not one.
 *
 * new Date("last tuesday") is Invalid Date and new Date("2019") is midnight
 * on New Year -- both would be obeyed as if they were what the user meant.
 * A filter that silently ignores what you typed is how you conclude there
 * are no documents from 2019.
 */
function parseDate(raw, label) {
  if (raw === undefined || raw === null || raw === "") return null;
  const value = String(raw).trim();
  if (!ISO_DATE.test(value)) {
    throw new ValidationError(`${label} must be a date in YYYY-MM-DD form (got "${value}").`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError(`${label} is not a real date (got "${value}").`);
  }
  return value;
}

function parseUuid(raw, label) {
  if (raw === undefined || raw === null || raw === "") return null;
  const value = String(raw).trim();
  if (!UUID.test(value)) throw new ValidationError(`${label} must be a valid id.`);
  return value;
}

/**
 * A query-string boolean. Refused rather than coerced, for the same reason
 * parseDate refuses "last tuesday": `Boolean("false")` is true, so a typo in
 * a flag that HIDES most of the repository would silently do the opposite of
 * what was asked.
 */
function parseBool(raw, label) {
  if (raw === undefined || raw === null || raw === "") return false;
  const value = String(raw).trim().toLowerCase();
  if (["true", "1", "yes"].includes(value)) return true;
  if (["false", "0", "no"].includes(value)) return false;
  throw new ValidationError(`${label} must be true or false (got "${raw}").`);
}

/**
 * Query string -> a validated filter object, or a ValidationError explaining
 * exactly which parameter was wrong.
 *
 * @param {object} query - req.query
 * @param {string} ownerUserId - req.user.id. Required: see the header note.
 * @returns {{ownerUserId: string, extensions: string[], dateFrom: string|null,
 *            dateTo: string|null, subjectId: string|null,
 *            storageLocationId: string|null, pathPrefix: string|null}}
 */
function parseFileFilters(query = {}, ownerUserId) {
  const filters = {
    ownerUserId: requireOwner(ownerUserId, "parseFileFilters"),
    extensions: parseExtensions(query.ext),
    dateFrom: parseDate(query.dateFrom, "dateFrom"),
    dateTo: parseDate(query.dateTo, "dateTo"),
    subjectId: parseUuid(query.subjectId, "subjectId"),
    documentTypeId: parseUuid(query.documentTypeId, "documentTypeId"),
    unfiled: parseBool(query.unfiled, "unfiled"),
    storageLocationId: parseUuid(query.storageLocationId, "storageLocationId"),
    pathPrefix: query.pathPrefix ? String(query.pathPrefix).trim() || null : null,
  };

  // "Everything under Finance" and "everything filed nowhere" are contrary
  // instructions, and the only ways to reconcile them are to return nothing
  // or to quietly obey one of them. Both are worse than saying so.
  if (filters.unfiled && filters.subjectId) {
    throw new ValidationError("unfiled and subjectId cannot be combined — a file is either filed somewhere or nowhere.");
  }

  // Caught here rather than returning an empty list with no explanation --
  // a reversed range is a typo every time, and "0 results" is the least
  // useful way to report one.
  if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) {
    throw new ValidationError(
      `The date range is backwards: dateFrom (${filters.dateFrom}) is after dateTo (${filters.dateTo}).`
    );
  }

  return filters;
}

/** True when nothing was asked for -- lets callers skip the work entirely. */
function hasAnyFilter(filters) {
  if (!filters) return false;
  return Boolean(
    filters.extensions?.length ||
    filters.dateFrom || filters.dateTo ||
    filters.subjectId || filters.documentTypeId || filters.unfiled ||
    filters.storageLocationId || filters.pathPrefix
  );
}

/** LIKE metacharacters in a value that is meant to match literally. */
function escapeLike(value) {
  return value.replace(/([\\%_])/g, "\\$1");
}

/**
 * SQL predicates for a validated filter set.
 *
 * @param {object} filters - the output of parseFileFilters
 * @param {number} startIndex - the next unused $n in the caller's query
 * @returns {{clauses: string[], params: any[]}} - AND these clauses together
 */
function buildFilterClauses(filters, startIndex = 1) {
  const clauses = [];
  const params = [];
  let n = startIndex;
  const bind = (value) => { params.push(value); return `$${n++}`; };

  // First, always, and with no `if`. Every other clause in this function
  // narrows a set the user is already entitled to see; this one is what makes
  // that true. It throws rather than defaulting, because the only two
  // possible defaults -- match nothing, or match everything -- are a broken
  // page and a data breach respectively.
  clauses.push(`f.owner_user_id = ${bind(requireOwner(filters?.ownerUserId, "buildFilterClauses"))}`);

  if (filters?.extensions?.length) {
    const real = filters.extensions.filter((e) => e !== NO_EXTENSION);
    const wantsNone = filters.extensions.includes(NO_EXTENSION);
    const parts = [];
    if (real.length) parts.push(`lower(f.extension) = ANY(${bind(real)}::text[])`);
    if (wantsNone) parts.push(`(f.extension IS NULL OR f.extension = '')`);
    clauses.push(`(${parts.join(" OR ")})`);
  }

  // document_date, not imported_at: this repository was assembled from
  // backups, so the filesystem timestamps mostly record the day of the copy
  // (see migration 024). Filtering by those would be filtering by when
  // someone ran a backup.
  //
  // A NULL document_date matches no range, deliberately -- it is not that
  // the document is outside the range, it is that nothing is known about
  // when it is from, and quietly including undated files in "2019" would be
  // a claim the data does not support. The UI says so next to the control.
  // BOUNDARIES ARE CALENDAR DAYS, NOT UTC INSTANTS
  //
  // document_date is timestamptz and the user picked a day out of a date
  // picker, so the two ends have to be converted the same way the values
  // were stored: casting `date` -> timestamptz applies the database's own
  // timezone. Binding UTC midnight instead is off by the server's offset,
  // which on this deployment (Asia/Jerusalem, UTC+2) silently dropped every
  // document dated ON the first day of the range -- a date-only source like
  // EXIF or a PDF header normalises to local midnight, which is 22:00 the
  // previous day in UTC. Caught by verify-search-filters.js.
  if (filters?.dateFrom) {
    clauses.push(`f.document_date >= ${bind(filters.dateFrom)}::date`);
  }
  if (filters?.dateTo) {
    // Exclusive upper bound on the NEXT day, so "to 2019-12-31" includes
    // everything that happened during the 31st rather than only its
    // midnight boundary.
    clauses.push(`f.document_date < (${bind(filters.dateTo)}::date + interval '1 day')`);
  }

  /**
   * Subject, including everything beneath it.
   *
   * Picking "Finance" in a filter means Finance and its categories -- a
   * parent usually holds nothing directly (see subjectService.list, which
   * rolls counts up the same way for exactly this reason), so an exact-match
   * subject filter would report most branches as empty.
   *
   * "Latest wins": a file that has been reclassified belongs where it is
   * now, not everywhere it has ever been -- the same rule listBySubject and
   * countsBySubject already use.
   *
   * materialized_path is a dot-joined chain of slugs (letters, digits and
   * hyphens only -- see subjectService.slugify), so it carries no LIKE
   * metacharacters; the concatenation below is still built from a column
   * rather than a user value, so there is nothing to escape.
   */
  if (filters?.subjectId) {
    clauses.push(`EXISTS (
      SELECT 1
        FROM (
          SELECT cr.classified_subject_id
            FROM classification_results cr
           WHERE cr.file_id = f.id
           ORDER BY cr.created_at DESC LIMIT 1
        ) latest
        JOIN subjects s    ON s.id = latest.classified_subject_id
        JOIN subjects root ON root.id = ${bind(filters.subjectId)}
       WHERE s.id = root.id
          OR s.materialized_path LIKE root.materialized_path || '.%'
    )`);
  }

  /**
   * Everything filed nowhere.
   *
   * This is the pile someone has after pointing Atlas at a drive full of
   * twenty years of accumulated files, and until now it was the one set the
   * app could count (the dashboard's `attention.unfiled`) but could not show
   * you. A number you cannot click is a reproach, not a feature.
   *
   * Matches a file with NO classification row at all as well as one whose
   * latest row names no subject -- both mean "nobody, human or machine, has
   * said where this belongs", which is the question being asked.
   */
  if (filters?.unfiled) {
    clauses.push(`NOT EXISTS (
      SELECT 1
        FROM (
          SELECT cr.classified_subject_id
            FROM classification_results cr
           WHERE cr.file_id = f.id
           ORDER BY cr.created_at DESC LIMIT 1
        ) latest
       WHERE latest.classified_subject_id IS NOT NULL
    )`);
  }

  /**
   * Document type: the second classification axis (docs/03-taxonomy.md §3.4).
   *
   * Flat, so unlike subject there is no descendant roll-up -- "Invoice" means
   * Invoice, and that is the whole point of the axis. It reads the same latest
   * row the subject filter does, which is only correct because every writer
   * now goes through classificationResultRepository.createPartial and leaves a
   * complete snapshot behind. Before that, a subject move wrote a newer row
   * with a null type and this filter would have reported the file as untyped.
   */
  if (filters?.documentTypeId) {
    clauses.push(`EXISTS (
      SELECT 1
        FROM (
          SELECT cr.classified_document_type_id
            FROM classification_results cr
           WHERE cr.file_id = f.id
           ORDER BY cr.created_at DESC LIMIT 1
        ) latest
       WHERE latest.classified_document_type_id = ${bind(filters.documentTypeId)}
    )`);
  }

  if (filters?.storageLocationId) {
    clauses.push(`f.storage_location_id = ${bind(filters.storageLocationId)}`);
  }

  // Folder within the location. current_path is stored relative to the
  // location root, so this is a prefix match on that relative path -- see
  // the note in fileService about what "location" was taken to mean.
  if (filters?.pathPrefix) {
    clauses.push(`f.current_path LIKE ${bind(`${escapeLike(filters.pathPrefix)}%`)} ESCAPE '\\'`);
  }

  return { clauses, params };
}

/**
 * Sorting, as a closed set.
 *
 * WHY A WHITELIST AND NOT A COLUMN NAME
 *
 * Every other value in this module travels as a bound parameter, but ORDER BY
 * cannot be parameterised -- it has to be text in the SQL. So the only safe
 * design is one where user input never becomes SQL at all: the request names a
 * SORT, not a column, and the mapping from name to expression lives here. An
 * unknown name falls back to the default rather than erroring, because a stale
 * bookmark with an old sort key should show you your files, not a 400.
 *
 * The expressions are written against the `f` alias like the filter clauses.
 * NULLS LAST on document_date is deliberate: sorting by date and getting a
 * screen of undated files first is the least useful possible answer, and this
 * archive has thousands of them (see the note on the date filter above).
 */
const SORTS = Object.freeze({
  // The default everywhere before sorting existed, kept as the default so
  // nothing reorders under anyone who never asks for a sort.
  imported: "f.imported_at",
  name: "COALESCE(NULLIF(f.ai_short_title, ''), f.filename_current)",
  date: "f.document_date",
  size: "f.size_bytes",
  extension: "lower(f.extension)",
});

const DEFAULT_SORT = "imported";
// Sorted newest/largest first, because for these that is the interesting end.
const DESC_BY_DEFAULT = new Set(["imported", "date", "size"]);

/**
 * @returns {{sortBy: string, sortDir: 'ASC'|'DESC'}} always valid, never user text
 */
function parseSort(query = {}) {
  const requested = String(query.sortBy || "").trim().toLowerCase();
  const sortBy = Object.prototype.hasOwnProperty.call(SORTS, requested) ? requested : DEFAULT_SORT;

  const dir = String(query.sortDir || "").trim().toLowerCase();
  const sortDir = dir === "asc" ? "ASC" : dir === "desc" ? "DESC" : (DESC_BY_DEFAULT.has(sortBy) ? "DESC" : "ASC");

  return { sortBy, sortDir };
}

/**
 * The ORDER BY body for a parsed sort. Built only from the table above and the
 * two literal direction strings, so there is no path by which a request value
 * reaches the query text.
 *
 * `f.id` is appended as a tiebreaker on every sort. Without it, rows with
 * equal values (all the undated files, all the 0-byte ones) have no defined
 * order between them, and Postgres is free to return them differently on each
 * page -- which shows up as a file appearing on page 2 and again on page 3
 * while another is never seen at all. Pagination over a non-deterministic sort
 * silently loses rows, and at a few thousand files nobody would notice.
 */
function buildOrderBy(sort) {
  // Destructured in the body rather than in the signature: a `= {}` default
  // only fires on `undefined`, and every caller in this repository defaults
  // its own `sort` parameter to `null` (`listNotDeleted`, `listBySubject`),
  // so `buildOrderBy(null)` threw a TypeError on what the signature advertised
  // as an optional argument. The two production callers happen to always pass
  // a parsed sort, which is the only reason this was not a live 500.
  const { sortBy, sortDir } = sort || {};
  const expr = SORTS[sortBy] || SORTS[DEFAULT_SORT];
  const dir = sortDir === "ASC" ? "ASC" : "DESC";
  // NULLS LAST in BOTH directions, which is not the SQL default and is the
  // reason this is stated rather than left implicit: Postgres treats NULLs as
  // larger than any value, so a DESC sort would lead with them. Sorting by
  // date and getting a screen of undated files first is the least useful
  // answer available, and this archive has thousands of them.
  return `${expr} ${dir} NULLS LAST, f.id ${dir}`;
}

/** `buildFilterClauses` as a single `AND ...` string, or "" when empty. */
function buildFilterSql(filters, startIndex = 1) {
  const { clauses, params } = buildFilterClauses(filters, startIndex);
  return { sql: clauses.length ? ` AND ${clauses.join(" AND ")}` : "", params };
}

module.exports = {
  LISTABLE_STATUS,
  NOT_A_DUPLICATE_COPY,
  LISTABLE_FILE,
  NO_EXTENSION,
  MAX_EXTENSIONS,
  SORTS,
  DEFAULT_SORT,
  parseFileFilters,
  parseSort,
  buildOrderBy,
  hasAnyFilter,
  buildFilterClauses,
  buildFilterSql,
  escapeLike,
};
