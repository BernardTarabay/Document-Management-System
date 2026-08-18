// The failure this module was extracted to fix is pinned first, verbatim from
// the real row that exposed it: a 36,000-character personal narrative typed as
// document type "Book" at MEDIUM confidence, because "playbook" and "fantasy
// books" contain the substring "book" and the keyword list contained "Book"
// twice (name and code are the same word for every single-word type).
//
// As in textQuality.test.js the two error directions are not symmetric. A type
// this module declines to assign costs nothing -- a human can set it from the
// Files page, and the AI tier still gets its turn. A type it assigns wrongly
// is a confident label on a document nobody knows to re-check. So the negative
// assertions matter more than the positive ones.
const test = require("node:test");
const assert = require("node:assert");

const { buildTerms, matchTerms, bestMatch, typeFromExtension } = require("../src/services/taxonomyMatcher");

// The seeded document types, as they actually exist in seeds/002.
const BOOK = { code: "Book", name: "Book" };
const INVOICE = { code: "Invoice", name: "Invoice" };
const CONTRACT = { code: "Contract", name: "Contract" };
const EXAM = { code: "Exam", name: "Exam" };
const ANNUAL_BUDGET = { code: "AnnualBudget", name: "Annual Budget" };
const MANUAL = { code: "Manual", name: "Manual / Guide" };
const COURSE_MATERIAL = { code: "CourseMaterial", name: "Course Material" };

// --- the regression -------------------------------------------------------

test('"playbook" and "fantasy books" do not make a narrative a Book', () => {
  const body =
    "she tells him her playbook — how to approach a girl, use eye contact, " +
    "and he says it's not that different from her fantasy books. he says he's broken.";
  const r = bestMatch([BOOK, INVOICE, CONTRACT], { filenameText: "the architecture of almost.docx", bodyText: body });
  assert.equal(r.entity, null, `expected no type, got ${r.entity?.code} (score ${r.score})`);
  assert.equal(r.score, 0);
});

test("a single-word type yields ONE term, so one occurrence cannot score two", () => {
  assert.deepEqual(buildTerms(BOOK), ["book"]);
  const { matches } = matchTerms("this is a book about ships", buildTerms(BOOK));
  assert.equal(matches, 1, "one occurrence must be one independent signal, not two");
});

test("the same term occurring many times is still one signal", () => {
  const { matches } = matchTerms("book book book book book", buildTerms(BOOK));
  assert.equal(matches, 1);
});

// --- substring bleed, the general case ------------------------------------

test("substrings inside longer words do not match", () => {
  for (const [haystack, entity] of [
    ["please examine the attached", EXAM],
    ["the work was subcontracted", CONTRACT],
    ["see the notebook on the desk", BOOK],
    ["posted on facebook last week", BOOK],
  ]) {
    const { matches } = matchTerms(haystack, buildTerms(entity));
    assert.equal(matches, 0, `"${entity.code}" wrongly matched in: ${haystack}`);
  }
});

test("French and Arabic words are not split by the ASCII word-boundary rule", () => {
  // "examen" is French for exam; the English term must not match inside it.
  assert.equal(matchTerms("le calendrier des examens", buildTerms(EXAM)).matches, 0);
  // A French contract is "contrat" -- close, but not the English term.
  assert.equal(matchTerms("contrat de bail signé", buildTerms(CONTRACT)).matches, 0);
  // Arabic must not throw and must not produce phantom matches.
  assert.equal(matchTerms("هذا التقرير السنوي يوضح أنشطة الدير", buildTerms(BOOK)).matches, 0);
});

test("a real whole-word hit still matches, including next to punctuation", () => {
  assert.equal(matchTerms("attached: invoice.", buildTerms(INVOICE)).matches, 1);
  assert.equal(matchTerms("(invoice)", buildTerms(INVOICE)).matches, 1);
  assert.equal(matchTerms("accented café, then invoice", buildTerms(INVOICE)).matches, 1);
});

// --- multi-word types were the ones being starved -------------------------

test("a camelCase code and its spaced name collapse to one phrase term", () => {
  assert.deepEqual(buildTerms(ANNUAL_BUDGET), ["annual budget"]);
  assert.deepEqual(buildTerms(COURSE_MATERIAL), ["course material"]);
});

test("the phrase matches as a phrase, and a bare fragment does not", () => {
  const terms = buildTerms(ANNUAL_BUDGET);
  assert.equal(matchTerms("the annual budget for 2024", terms).matches, 1);
  assert.equal(matchTerms("the annual general meeting", terms).matches, 0, '"annual" alone is not a budget');
  assert.equal(matchTerms("annual\n  budget", terms).matches, 1, "a line break inside the phrase still matches");
});

test('"Manual / Guide" produces two usable terms, not the unmatchable "manual / "', () => {
  const terms = buildTerms(MANUAL);
  assert.deepEqual(terms.sort(), ["guide", "manual"]);
  assert.equal(matchTerms("installation guide", terms).matches, 1);
});

// --- scoring --------------------------------------------------------------

test("a filename hit outweighs a body hit", () => {
  const inName = bestMatch([INVOICE], { filenameText: "invoice-2024-114.pdf", bodyText: "" });
  const inBody = bestMatch([INVOICE], { filenameText: "scan001.pdf", bodyText: "the invoice is attached" });
  assert.equal(inName.score, 3);
  assert.equal(inBody.score, 1);
  assert.equal(inName.inFilename, true);
  assert.equal(inBody.inFilename, false);
});

test("the best-scoring candidate wins and reports why", () => {
  const r = bestMatch([BOOK, INVOICE, CONTRACT], {
    filenameText: "acme-invoice-2024-114.pdf",
    bodyText: "invoice number INV-2024-114, payment due within 30 days",
  });
  assert.equal(r.entity.code, "Invoice");
  assert.deepEqual(r.matchedTerms, ["invoice"]);
});

test("no candidates and empty text are handled without throwing", () => {
  assert.equal(bestMatch([], {}).entity, null);
  assert.equal(bestMatch(null, {}).entity, null);
  assert.deepEqual(buildTerms(null), []);
  assert.deepEqual(buildTerms({}), []);
});

// --- the extension route --------------------------------------------------
//
// The processor withholds body text from the document-type axis entirely (see
// the comment in classifyProcessor): prose says what a document is ABOUT, not
// what KIND of thing it is. The narrative that broke this axis says
// "presentation" four times, every one of them about a person giving one --
// real words, correctly matched, wrong conclusion. So type comes from the
// filename or from an extension that settles it outright.

const TYPES = [BOOK, INVOICE, { code: "Presentation", name: "Presentation" }];

test("a .pptx is a Presentation whatever it says inside", () => {
  assert.equal(typeFromExtension("pptx", TYPES)?.code, "Presentation");
  assert.equal(typeFromExtension(".PPTX", TYPES)?.code, "Presentation", "leading dot and case are tolerated");
  assert.equal(typeFromExtension("odp", TYPES)?.code, "Presentation");
});

test("extensions that do not settle the question map to nothing", () => {
  // .docx and .pdf are containers, not kinds -- a PDF is any document at all.
  for (const ext of ["docx", "pdf", "txt", "jpg", ""]) {
    assert.equal(typeFromExtension(ext, TYPES), null, `${ext} must not imply a type`);
  }
  // Spreadsheets are the deliberate omission: the seeded type is "Spreadsheet
  // Model", which is narrower than "any workbook".
  assert.equal(typeFromExtension("xlsx", TYPES), null);
});

test("an extension maps to nothing when that type is not seeded", () => {
  assert.equal(typeFromExtension("pptx", [BOOK, INVOICE]), null);
  assert.equal(typeFromExtension("pptx", []), null);
  assert.equal(typeFromExtension(null, TYPES), null);
});

// --- subjects use the same matcher, with slug instead of code -------------

test("subjects match on name and slug without double-counting", () => {
  const finance = { name: "Finance", slug: "finance" };
  assert.deepEqual(buildTerms(finance), ["finance"]);
  assert.equal(matchTerms("the finance committee met", buildTerms(finance)).matches, 1);

  const courses = { name: "Courses", slug: "courses" };
  assert.equal(matchTerms("courses offered this term", buildTerms(courses)).matches, 1);
});
