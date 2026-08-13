// namingService decides what files get physically renamed to on disk, and
// this repository's real content is heavily French/Arabic/Hebrew -- the
// Unicode behavior here is load-bearing, not theoretical (see the module's
// own note about the old [a-zA-Z0-9] filter deleting Arabic names outright).
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const {
  buildCanonicalName,
  extractPeriod,
  sanitizeSegment,
  sanitizeTitle,
  sanitizeFolderSegment,
  buildTargetRelativeDir,
} = require("../src/services/namingService");
const { resolveWithinRoot } = require("../src/utils/pathSafety");

test("a real title is used almost verbatim", () => {
  const name = buildCanonicalName({
    subject: { name: "Personal" },
    documentType: { code: "Letter" },
    filenameOriginal: "scan001.pdf",
    extension: "pdf",
    shortTitle: "Letter from Mom",
  });
  assert.strictEqual(name, "Letter_from_Mom.pdf");
});

test("title wins over the subject/documentType bucket scheme", () => {
  const name = buildCanonicalName({
    subject: { name: "Finance" },
    documentType: { code: "AnnualBudget" },
    filenameOriginal: "x.pdf",
    extension: "pdf",
    shortTitle: "Annual Returns",
  });
  assert.strictEqual(name, "Annual_Returns.pdf");
  assert.ok(!name.includes("Finance"), "bucket naming must not be appended to a real title");
});

test("a date is appended only when the title does not already contain it", () => {
  const redundant = buildCanonicalName({
    subject: null, documentType: null,
    filenameOriginal: "x.pdf", extension: "pdf",
    shortTitle: "Annual Returns 2024",
    entities: { dateOrPeriod: "2024" },
  });
  assert.strictEqual(redundant, "Annual_Returns_2024.pdf", "2024 must appear once, not twice");

  const added = buildCanonicalName({
    subject: null, documentType: null,
    filenameOriginal: "x.pdf", extension: "pdf",
    shortTitle: "Annual Returns",
    entities: { dateOrPeriod: "2024" },
  });
  assert.strictEqual(added, "Annual_Returns_2024.pdf");
});

test("an identifier is appended only when not already in the title", () => {
  const already = buildCanonicalName({
    subject: null, documentType: null,
    filenameOriginal: "x.pdf", extension: "pdf",
    shortTitle: "Invoice EMP001",
    entities: { identifier: "EMP001" },
  });
  assert.strictEqual(already, "Invoice_EMP001.pdf");
});

test("falls back to the bucket scheme with no AI signal at all", () => {
  const name = buildCanonicalName({
    subject: { name: "Finance" },
    documentType: { code: "AnnualBudget" },
    filenameOriginal: "budget_2024_final.pdf",
    extension: "pdf",
  });
  assert.strictEqual(name, "Finance_AnnualBudget_2024.pdf");
});

test("bucket scheme dedupes a subject/documentType that say the same thing", () => {
  const name = buildCanonicalName({
    subject: { name: "Certificates" },
    documentType: { code: "Certificate" },
    filenameOriginal: "x.pdf",
    extension: "pdf",
  });
  assert.strictEqual(name, "Certificates.pdf", "must not produce Certificates_Certificate");
});

test("a version suffix appears only for an actual version bump", () => {
  const base = { subject: { name: "Finance" }, documentType: null, filenameOriginal: "x.pdf", extension: "pdf" };
  assert.strictEqual(buildCanonicalName({ ...base, versionNumber: 1 }), "Finance.pdf");
  assert.strictEqual(buildCanonicalName({ ...base, versionNumber: 3 }), "Finance_v3.pdf");
});

test("non-Latin scripts survive naming (the bug this module was rewritten for)", () => {
  // Arabic
  const ar = buildCanonicalName({
    subject: null, documentType: null, filenameOriginal: "x.pdf", extension: "pdf",
    shortTitle: "تقرير صندوق المعاشات",
  });
  assert.strictEqual(ar, "تقرير_صندوق_المعاشات.pdf");

  // Hebrew
  const he = buildCanonicalName({
    subject: null, documentType: null, filenameOriginal: "x.xlsx", extension: "xlsx",
    shortTitle: "תשלומי הורים",
  });
  assert.strictEqual(he, "תשלומי_הורים.xlsx");

  // French accents must not be stripped ("Résumé" -> "Rsum" was the old bug)
  const fr = buildCanonicalName({
    subject: null, documentType: null, filenameOriginal: "x.docx", extension: "docx",
    shortTitle: "Conférence sur l'Espérance",
  });
  assert.ok(fr.includes("Conférence"), `accents lost: ${fr}`);
  assert.ok(fr.includes("Espérance"), `accents lost: ${fr}`);
});

test("sanitizeSegment keeps letters/numbers of any script and drops punctuation", () => {
  assert.strictEqual(sanitizeSegment("Ré-su/mé 2024"), "Résumé2024");
  assert.strictEqual(sanitizeSegment("دارين كيروز"), "دارينكيروز");
  assert.strictEqual(sanitizeSegment("!!!"), "");
  assert.strictEqual(sanitizeSegment(null), "");
});

test("sanitizeTitle removes filesystem-illegal characters", () => {
  // These are exactly the characters Windows rejects in a filename; a name
  // containing them would fail at the fs.rename() call.
  assert.strictEqual(sanitizeTitle('Re: A/B "test" <draft>|v2'), "Re_AB_test_draftv2");
  assert.strictEqual(sanitizeTitle("  spaced   out  "), "spaced_out");
  assert.strictEqual(sanitizeTitle("___leading and trailing___"), "leading_and_trailing");
});

test("generated names contain no path separators", () => {
  // A separator in a filename would silently redirect the rename into a
  // different directory.
  const name = buildCanonicalName({
    subject: null, documentType: null, filenameOriginal: "x.pdf", extension: "pdf",
    shortTitle: "Reports/2024/Final",
  });
  assert.ok(!name.includes("/") && !name.includes("\\"), `separator leaked: ${name}`);
});

test("extractPeriod pulls a 20xx year, or null", () => {
  assert.strictEqual(extractPeriod("Rapport_2026_final.docx"), "2026");
  assert.strictEqual(extractPeriod("no year here.pdf"), null);
  assert.strictEqual(extractPeriod("1999_old.pdf"), null, "only 20xx is recognized");
});

test("buildTargetRelativeDir joins an ancestor chain", () => {
  assert.strictEqual(buildTargetRelativeDir([{ name: "Finance" }, { name: "Reports" }]), "Finance/Reports");
  assert.strictEqual(buildTargetRelativeDir([]), null);
  assert.strictEqual(buildTargetRelativeDir(null), null);
  assert.strictEqual(buildTargetRelativeDir([{ name: "///" }]), null, "empty after sanitizing -> null, not ''");
});

test("a subject named '..' cannot escape the storage root", () => {
  // Subject names are user-editable, so they are untrusted input to folder
  // path construction. sanitizeFolderSegment does not itself strip dot
  // segments -- resolveWithinRoot is the authoritative guard, so what
  // matters is that the composition is safe.
  const dir = buildTargetRelativeDir([{ name: ".." }, { name: ".." }]);
  const root = path.resolve("/srv/repo");
  if (dir !== null) {
    assert.throws(() => resolveWithinRoot(root, dir), /escapes storage root/);
  }
});
