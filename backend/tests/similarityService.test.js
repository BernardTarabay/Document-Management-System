// Probable-duplicate and version detection are the two relationships
// docs/01-domain-model.md §1.3 says must NEVER be auto-resolved without a
// human. So the tests that matter most are the false-positive ones: two
// different documents that look superficially alike must not be linked.
const test = require("node:test");
const assert = require("node:assert");

const {
  tokenize,
  jaccard,
  shingleSet,
  textSimilarity,
  hasEnoughTextToCompare,
  confidenceForScore,
  versionAgnosticStem,
  extractVersionNumber,
  hasVersionMarker,
  filenameVersionScore,
  versionRelationship,
  PROBABLE_DUPLICATE_THRESHOLD,
  STRONG_SIMILARITY_THRESHOLD,
} = require("../src/services/similarityService");

// A body of text long enough to clear MIN_TOKENS_FOR_COMPARISON.
const BASE = `
The Provincial Chapter convened in Beirut to review the financial position of the
province for the triennium. The treasurer presented a summary of expenditure across
each convent, noting that the cost of utilities had risen substantially while
donations remained broadly stable. The assembly approved the budget for the coming
year subject to a further review of staffing costs in the autumn session.
`;

// Same document, re-exported: whitespace and punctuation differ, wording does not.
const REEXPORTED = BASE.replace(/\s+/g, "  ").replace(/,/g, "");

// Same document plus a watermark/header line -- the classic probable duplicate.
const WATERMARKED = `CONFIDENTIAL DRAFT - NOT FOR CIRCULATION\n${BASE}`;

// A genuinely different document that shares vocabulary and boilerplate.
const DIFFERENT = `
The Provincial Chapter convened in Beirut to review the pastoral programme of the
province for the triennium. The formation director outlined the novitiate schedule,
the retreat calendar, and the plan for ongoing theological study. The assembly asked
that a report on vocations be prepared for the next session, and adjourned.
`;

// --- tokenization and scoring -------------------------------------------

test("tokenize is unicode-aware and strips punctuation", () => {
  assert.deepStrictEqual(tokenize("Hello, World!"), ["hello", "world"]);
  assert.deepStrictEqual(tokenize("Conférence Résumé"), ["conférence", "résumé"]);
  assert.deepStrictEqual(tokenize("تقرير صندوق"), ["تقرير", "صندوق"]);
  assert.deepStrictEqual(tokenize(""), []);
  assert.deepStrictEqual(tokenize(null), []);
});

test("jaccard is 0 for empty input, not 1", () => {
  // "We know nothing about either file" must never read as "identical".
  assert.strictEqual(jaccard(new Set(), new Set()), 0);
  assert.strictEqual(jaccard(new Set([1]), new Set()), 0);
});

test("jaccard computes the expected ratio", () => {
  assert.strictEqual(jaccard(new Set([1, 2, 3]), new Set([1, 2, 3])), 1);
  assert.strictEqual(jaccard(new Set([1, 2]), new Set([3, 4])), 0);
  assert.strictEqual(jaccard(new Set([1, 2, 3, 4]), new Set([3, 4, 5, 6])), 2 / 6);
});

test("identical text scores 1", () => {
  assert.strictEqual(textSimilarity(BASE, BASE), 1);
});

test("a re-export differing only in whitespace/punctuation scores ~1", () => {
  const score = textSimilarity(BASE, REEXPORTED);
  assert.ok(score > 0.99, `expected near-identical, got ${score}`);
});

test("a watermarked copy is well above the probable-duplicate threshold", () => {
  const score = textSimilarity(BASE, WATERMARKED);
  assert.ok(score > STRONG_SIMILARITY_THRESHOLD, `expected strong similarity, got ${score}`);
});

test("a different document sharing vocabulary stays below the threshold", () => {
  // This is the false-positive case that matters: same institution, same
  // boilerplate opening, genuinely different content.
  const score = textSimilarity(BASE, DIFFERENT);
  assert.ok(
    score < PROBABLE_DUPLICATE_THRESHOLD,
    `shared-vocabulary documents must not be flagged as duplicates, got ${score}`
  );
});

test("unrelated text scores near 0", () => {
  assert.ok(textSimilarity(BASE, "completely unrelated content about gardening tools") < 0.05);
});

test("similarity is symmetric", () => {
  assert.strictEqual(textSimilarity(BASE, DIFFERENT), textSimilarity(DIFFERENT, BASE));
});

test("empty or missing text never claims similarity", () => {
  assert.strictEqual(textSimilarity("", ""), 0);
  assert.strictEqual(textSimilarity(BASE, ""), 0);
  assert.strictEqual(textSimilarity(null, undefined), 0);
});

test("very short documents still shingle to something comparable", () => {
  // Shorter than the shingle size -- must not produce an empty set, which
  // would make every short file identical to every other.
  assert.strictEqual(shingleSet("two words").size, 1);
  assert.strictEqual(textSimilarity("two words", "two words"), 1);
  assert.strictEqual(textSimilarity("two words", "other text"), 0);
});

test("hasEnoughTextToCompare gates thin extractions", () => {
  assert.strictEqual(hasEnoughTextToCompare("a few words only"), false);
  assert.strictEqual(hasEnoughTextToCompare(""), false);
  assert.strictEqual(hasEnoughTextToCompare(BASE), true);
});

test("confidence never reaches high -- that is reserved for exact hashes", () => {
  assert.strictEqual(confidenceForScore(1.0), "medium");
  assert.strictEqual(confidenceForScore(0.9), "medium");
  assert.strictEqual(confidenceForScore(0.7), "low");
  assert.strictEqual(confidenceForScore(0.4), null, "below the floor is not a claim at all");
});

// --- filename / version heuristics --------------------------------------

test("versionAgnosticStem collapses version markers to the same stem", () => {
  const stem = versionAgnosticStem("Report.pdf");
  for (const variant of [
    "Report_v2.pdf", "Report v3.pdf", "Report_version_2.pdf",
    "Report (2).pdf", "Report_final.pdf", "Report - draft.pdf",
    "Report_rev4.pdf", "Report copy.pdf", "Report_latest.pdf",
  ]) {
    assert.strictEqual(versionAgnosticStem(variant), stem, `${variant} should reduce to "${stem}"`);
  }
});

test("versionAgnosticStem keeps genuinely different names apart", () => {
  assert.notStrictEqual(versionAgnosticStem("Budget_v2.pdf"), versionAgnosticStem("Report_v2.pdf"));
});

test("extractVersionNumber reads an explicit version, else null", () => {
  assert.strictEqual(extractVersionNumber("Report_v2.pdf"), 2);
  assert.strictEqual(extractVersionNumber("Report version 11.docx"), 11);
  assert.strictEqual(extractVersionNumber("Report_rev3.pdf"), 3);
  assert.strictEqual(extractVersionNumber("Report (4).pdf"), 4);
  // "final" is an ordering hint, not a number -- must not be invented into one.
  assert.strictEqual(extractVersionNumber("Report_final.pdf"), null);
  assert.strictEqual(extractVersionNumber("Report.pdf"), null);
});

test("hasVersionMarker distinguishes revisions from standalone names", () => {
  assert.strictEqual(hasVersionMarker("Report_v2.pdf"), true);
  assert.strictEqual(hasVersionMarker("Report (2).pdf"), true);
  assert.strictEqual(hasVersionMarker("Report_draft.pdf"), true);
  assert.strictEqual(hasVersionMarker("Report.pdf"), false);
});

test("filenameVersionScore requires the same stem", () => {
  assert.strictEqual(filenameVersionScore("Report_v1.pdf", "Report_v2.pdf"), 1);
  assert.strictEqual(filenameVersionScore("Report.pdf", "Budget.pdf"), 0);
  // Same stem but neither carries a marker: weaker evidence, not zero.
  assert.strictEqual(filenameVersionScore("Report.pdf", "Report.pdf"), 0.5);
});

// --- combined version judgement -----------------------------------------

const fileOf = (filename, text) => ({ filename, text });

test("a real version pair is flagged", () => {
  const result = versionRelationship(
    fileOf("Rapport_v1.docx", BASE),
    fileOf("Rapport_v2.docx", WATERMARKED)
  );
  assert.strictEqual(result.isVersionCandidate, true);
  assert.deepStrictEqual(result.versionNumbers, { a: 1, b: 2 });
  assert.ok(["low", "medium"].includes(result.confidenceLevel));
});

test("matching filenames with different content are NOT versions", () => {
  // The failure mode docs/01 §1.2 warns about: filename patterns alone
  // silently merging unrelated documents.
  const result = versionRelationship(
    fileOf("Rapport_v1.docx", BASE),
    fileOf("Rapport_v2.docx", DIFFERENT)
  );
  assert.strictEqual(result.isVersionCandidate, false);
  assert.strictEqual(result.confidenceLevel, null);
  assert.match(result.reason, /content similarity/);
});

test("different filenames are rejected before content is even considered", () => {
  const result = versionRelationship(fileOf("Budget.docx", BASE), fileOf("Rapport.docx", BASE));
  assert.strictEqual(result.isVersionCandidate, false);
  assert.strictEqual(result.score, 0);
});

test("matching filenames with no usable text are LOW confidence only", () => {
  const result = versionRelationship(fileOf("Rapport_v1.pdf", ""), fileOf("Rapport_v2.pdf", ""));
  assert.strictEqual(result.isVersionCandidate, true);
  assert.strictEqual(result.confidenceLevel, "low", "must never exceed LOW without corroborating text");
  assert.match(result.reason, /not enough extracted text/);
});

test("a version judgement never reaches HIGH confidence", () => {
  // docs/01 §1.3: probable duplicates and versions may never be
  // auto-resolved above "suggest" without a human confirming.
  const identical = versionRelationship(fileOf("R_v1.pdf", BASE), fileOf("R_v2.pdf", BASE));
  assert.notStrictEqual(identical.confidenceLevel, "high");
  assert.strictEqual(identical.confidenceLevel, "medium");
});

test("real filenames from this repository behave sensibly", () => {
  // Drawn from backend/storage/uploads -- these are near-identical report
  // titles that are genuinely separate documents.
  const a = "Rapport_au_Chapitre_Provincial_2023-2026_20232026.docx";
  const b = "Rapport_au_XIXe_Chapitre_Provincial_2023-2026_20232026.docx";
  assert.notStrictEqual(versionAgnosticStem(a), versionAgnosticStem(b), "distinct titles must not collapse");

  // Whereas an OS-copy suffix on the same file must collapse.
  assert.strictEqual(
    versionAgnosticStem("Horaire_du_Chapitre_Provincial_2026 (2).docx"),
    versionAgnosticStem("Horaire_du_Chapitre_Provincial_2026.docx")
  );
});
