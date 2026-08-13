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
const { ValidationError } = require("../validators/validationError");

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
 * Query string -> a validated filter object, or a ValidationError explaining
 * exactly which parameter was wrong.
 *
 * @param {object} query - req.query
 * @returns {{extensions: string[], dateFrom: string|null, dateTo: string|null,
 *            subjectId: string|null, storageLocationId: string|null,
 *            pathPrefix: string|null}}
 */
function parseFileFilters(query = {}) {
  const filters = {
    extensions: parseExtensions(query.ext),
    dateFrom: parseDate(query.dateFrom, "dateFrom"),
    dateTo: parseDate(query.dateTo, "dateTo"),
    subjectId: parseUuid(query.subjectId, "subjectId"),
    storageLocationId: parseUuid(query.storageLocationId, "storageLocationId"),
    pathPrefix: query.pathPrefix ? String(query.pathPrefix).trim() || null : null,
  };

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
    filters.subjectId || filters.storageLocationId || filters.pathPrefix
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

/** `buildFilterClauses` as a single `AND ...` string, or "" when empty. */
function buildFilterSql(filters, startIndex = 1) {
  const { clauses, params } = buildFilterClauses(filters, startIndex);
  return { sql: clauses.length ? ` AND ${clauses.join(" AND ")}` : "", params };
}

module.exports = {
  NO_EXTENSION,
  MAX_EXTENSIONS,
  parseFileFilters,
  hasAnyFilter,
  buildFilterClauses,
  buildFilterSql,
  escapeLike,
};
