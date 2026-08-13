// Filters have one failure mode that matters and it is silent: a filter the
// backend quietly ignored looks exactly like a filter that matched nothing.
// Someone types 2019, sees an empty list, and concludes the archive has no
// documents from 2019 -- when what actually happened is that the parameter
// never reached the query.
//
// So most of what is checked here is rejection: a malformed date, a backwards
// range, a bad id. The rest checks that a filter which IS accepted actually
// emits a predicate and binds its value as a parameter rather than pasting it
// into SQL.
const test = require("node:test");
const assert = require("node:assert");

const {
  parseFileFilters, hasAnyFilter, buildFilterClauses, buildFilterSql, escapeLike, MAX_EXTENSIONS,
} = require("../src/repositories/fileFilters");

const UUID_A = "11111111-2222-3333-4444-555555555555";
const UUID_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// --- parsing: what gets refused -------------------------------------------

test("a date that is not a date is refused, not coerced", () => {
  // new Date("last tuesday") is Invalid Date and new Date("2019") is midnight
  // on New Year -- obeying either would be obeying something nobody asked for.
  for (const bad of ["last tuesday", "2019", "31/12/2019", "2019-13-01x", ""]) {
    if (bad === "") {
      assert.equal(parseFileFilters({ dateFrom: bad }).dateFrom, null, "empty means unset");
      continue;
    }
    assert.throws(() => parseFileFilters({ dateFrom: bad }), /YYYY-MM-DD|not a real date/, bad);
  }
});

test("a backwards date range is refused with both ends named", () => {
  assert.throws(
    () => parseFileFilters({ dateFrom: "2020-01-01", dateTo: "2019-01-01" }),
    /backwards.*2020-01-01.*2019-01-01/s
  );
});

test("an equal from/to is a valid single day, not backwards", () => {
  const f = parseFileFilters({ dateFrom: "2019-05-05", dateTo: "2019-05-05" });
  assert.equal(f.dateFrom, "2019-05-05");
  assert.equal(f.dateTo, "2019-05-05");
});

test("a malformed id is refused rather than matching nothing", () => {
  assert.throws(() => parseFileFilters({ subjectId: "not-a-uuid" }), /valid id/);
  assert.throws(() => parseFileFilters({ storageLocationId: "123" }), /valid id/);
});

test("a pasted list of file types is bounded", () => {
  const tooMany = Array.from({ length: MAX_EXTENSIONS + 1 }, (_, i) => `e${i}`).join(",");
  assert.throws(() => parseFileFilters({ ext: tooMany }), /Too many file types/);
});

// --- parsing: normalisation ------------------------------------------------

test("file types normalise: leading dots, case and duplicates all collapse", () => {
  assert.deepEqual(parseFileFilters({ ext: ".PDF, pdf ,Docx,.docx" }).extensions, ["pdf", "docx"]);
});

test("file types also accept an array, as a repeated query param arrives", () => {
  assert.deepEqual(parseFileFilters({ ext: ["PDF", ".xlsx"] }).extensions, ["pdf", "xlsx"]);
});

test("an empty query yields no filters at all", () => {
  const f = parseFileFilters({});
  assert.equal(hasAnyFilter(f), false);
  assert.deepEqual(buildFilterClauses(f).clauses, []);
  assert.equal(buildFilterSql(f).sql, "");
});

test("hasAnyFilter notices each filter on its own", () => {
  assert.equal(hasAnyFilter(parseFileFilters({ ext: "pdf" })), true);
  assert.equal(hasAnyFilter(parseFileFilters({ dateFrom: "2019-01-01" })), true);
  assert.equal(hasAnyFilter(parseFileFilters({ dateTo: "2019-01-01" })), true);
  assert.equal(hasAnyFilter(parseFileFilters({ subjectId: UUID_A })), true);
  assert.equal(hasAnyFilter(parseFileFilters({ storageLocationId: UUID_A })), true);
  assert.equal(hasAnyFilter(parseFileFilters({ pathPrefix: "Finance/" })), true);
  assert.equal(hasAnyFilter(null), false);
});

// --- building: values are bound, never interpolated ------------------------

test("every filter value travels as a parameter, not as SQL text", () => {
  const filters = parseFileFilters({
    ext: "pdf", dateFrom: "2019-01-01", dateTo: "2019-12-31",
    subjectId: UUID_A, storageLocationId: UUID_B, pathPrefix: "Finance/",
  });
  const { clauses, params } = buildFilterClauses(filters, 1);
  const sql = clauses.join(" AND ");

  assert.equal(clauses.length, 6, "one clause per filter");
  // No user-supplied value appears literally in the SQL.
  for (const value of ["2019-01-01", "2019-12-31", UUID_A, UUID_B, "Finance/"]) {
    assert.ok(!sql.includes(value), `"${value}" was interpolated into SQL`);
  }
  assert.ok(params.includes(UUID_A) && params.includes(UUID_B));
});

test("placeholders start where the caller says and run without gaps", () => {
  // The callers splice these into queries that already use $1..$n; an
  // off-by-one here is a wrong-parameter bug, not a syntax error, so it would
  // run and return the wrong rows.
  const filters = parseFileFilters({ ext: "pdf", storageLocationId: UUID_A });
  const { clauses, params } = buildFilterClauses(filters, 4);
  const used = clauses.join(" ").match(/\$\d+/g).map((p) => Number(p.slice(1)));
  assert.deepEqual(used, [4, 5]);
  assert.equal(params.length, 2);
});

test("the date upper bound covers the whole final day", () => {
  // "to 2019-12-31" must include a document dated that afternoon, so the
  // bound is exclusive on the NEXT day rather than inclusive at midnight.
  const { clauses } = buildFilterClauses(parseFileFilters({ dateTo: "2019-12-31" }));
  assert.match(clauses[0], /document_date < .*interval '1 day'/);
  assert.ok(!clauses[0].includes("<="), "an inclusive midnight bound would drop that whole day");
});

test("both date bounds are calendar days, not UTC instants", () => {
  // document_date is timestamptz. Casting the bound to `date` lets Postgres
  // apply its own timezone -- the same conversion that stored the value.
  // Pinning a UTC instant instead is off by the server's offset, which drops
  // every document dated ON the first day of the range wherever the server
  // is ahead of UTC. That was a real bug, not a hypothetical one.
  const { clauses, params } = buildFilterClauses(
    parseFileFilters({ dateFrom: "2019-01-01", dateTo: "2019-12-31" })
  );
  for (const clause of clauses) assert.match(clause, /::date/);
  assert.deepEqual(params, ["2019-01-01", "2019-12-31"]);
  assert.ok(!clauses.join(" ").includes("T00:00:00Z"), "a pinned UTC midnight is the bug");
});

test("dates filter on document_date, never on when the bytes were copied here", () => {
  const { clauses } = buildFilterClauses(
    parseFileFilters({ dateFrom: "2019-01-01", dateTo: "2019-12-31" })
  );
  const sql = clauses.join(" ");
  assert.ok(sql.includes("f.document_date"));
  assert.ok(!sql.includes("imported_at") && !sql.includes("modified_at_fs"),
    "this archive's filesystem dates record the day of the backup, not the document");
});

test("the subject filter includes descendants, latest-classification-wins", () => {
  const { clauses } = buildFilterClauses(parseFileFilters({ subjectId: UUID_A }));
  const sql = clauses[0];
  assert.match(sql, /materialized_path LIKE root\.materialized_path \|\| '\.%'/,
    "picking a parent must include its categories");
  assert.match(sql, /ORDER BY cr\.created_at DESC LIMIT 1/,
    "a reclassified file belongs where it is now, not everywhere it has been");
});

test("files with no extension are reachable via the 'none' sentinel", () => {
  const { clauses } = buildFilterClauses(parseFileFilters({ ext: "none" }));
  assert.match(clauses[0], /extension IS NULL OR f\.extension = ''/);
});

test("'none' combines with real types as an OR, not an impossible AND", () => {
  const { clauses, params } = buildFilterClauses(parseFileFilters({ ext: "pdf,none" }));
  assert.match(clauses[0], / OR /);
  assert.deepEqual(params[0], ["pdf"]);
});

// --- building: LIKE safety -------------------------------------------------

test("a folder path containing LIKE wildcards matches literally", () => {
  // A real folder can be called "100%_scans" or "report_2019". Left
  // unescaped, "_" matches any character and "%" matches anything at all, so
  // the filter would quietly return more than was asked for.
  assert.equal(escapeLike("100%_scans"), "100\\%\\_scans");
  const { params } = buildFilterClauses(parseFileFilters({ pathPrefix: "100%_scans" }));
  assert.equal(params[0], "100\\%\\_scans%");
});

test("the path filter declares its escape character", () => {
  // Backslash is already LIKE's default escape in Postgres; saying so
  // explicitly means the clause does not depend on that staying true.
  const { clauses } = buildFilterClauses(parseFileFilters({ pathPrefix: "Finance" }));
  assert.match(clauses[0], /ESCAPE '\\'/);
});

// --- the assembled fragment ------------------------------------------------

test("buildFilterSql produces an AND-prefixed fragment ready to splice in", () => {
  const { sql, params } = buildFilterSql(parseFileFilters({ ext: "pdf" }), 3);
  assert.match(sql, /^ AND /);
  assert.match(sql, /\$3/);
  assert.equal(params.length, 1);
});
