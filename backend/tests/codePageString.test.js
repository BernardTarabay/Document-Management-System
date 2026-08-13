// Reported from real use: Arabic documents were being proposed for renaming
// to things like "U+00D9 U+0085 U+00D8 U+00AF ..." rendered as garbage. The
// cause was VT_LPSTR strings in the OLE property set being decoded as latin1
// regardless of the code page the property set itself declared.
//
// Broken strings here are CONSTRUCTED rather than pasted. Pasting mojibake
// into a source file is unreliable -- half of it is C1 control characters
// that editors normalise or drop, which is the same class of problem the code
// under test exists to fix.
//
// The false-positive tests matter most. A repair that fires on text that was
// never broken would corrupt correct titles -- notably French, which is full
// of legitimate accented characters.
const test = require("node:test");
const assert = require("node:assert");

const {
  decodeCodePageString, repairMojibake, looksLikeMojibake, labelForCodePage, normalizeCodePage,
} = require("../src/services/extraction/ole/codePageString");

const ARABIC = "مدخل الى الروح";
const HEBREW = "הדוח השנתי של המנזר";

/** What the old code did: UTF-8 bytes read one at a time as Latin-1. */
const brokenAsLatin1 = (s) => Buffer.from(s, "utf8").toString("latin1");

/** The same bytes read as CP1252 -- what a browser actually renders. */
const brokenAsCp1252 = (s) => new TextDecoder("windows-1252").decode(Buffer.from(s, "utf8"));

// --- the exact reported failure --------------------------------------------

test("UTF-8 Arabic declared as code page 65001 decodes correctly", () => {
  assert.equal(decodeCodePageString(Buffer.from(ARABIC, "utf8"), 65001), ARABIC);
});

test("the old latin1 path is what produced the reported mojibake", () => {
  // Guards the diagnosis: if this stops reproducing, the bug report and the
  // fix no longer describe the same thing.
  const broken = brokenAsLatin1("مدخل");
  assert.notEqual(broken, "مدخل");
  assert.equal(broken.charCodeAt(0), 0xd9, "expected the UTF-8 lead byte to survive as a character");
  assert.equal(looksLikeMojibake(broken), true);
});

test("latin1-flavoured mojibake is repaired", () => {
  assert.equal(repairMojibake(brokenAsLatin1(ARABIC)), ARABIC);
});

test("cp1252-flavoured mojibake is repaired too", () => {
  // Same underlying bytes, different lens. Both occur in the wild.
  assert.equal(repairMojibake(brokenAsCp1252(ARABIC)), ARABIC);
});

test("Hebrew survives the same round trip", () => {
  assert.equal(repairMojibake(brokenAsLatin1(HEBREW)), HEBREW);
  assert.equal(repairMojibake(brokenAsCp1252(HEBREW)), HEBREW);
});

test("UTF-8 mislabelled as 1252 is still recovered by the repair pass", () => {
  // Real Office files lie about their code page; the declared value is what
  // the authoring app believed, not a guarantee.
  const s = "هوية جماعة الصلاة";
  assert.equal(decodeCodePageString(Buffer.from(s, "utf8"), 1252), s);
});

// --- genuine single-byte code pages ----------------------------------------

test("windows-1256 Arabic decodes", () => {
  const bytes = Buffer.from([0xe3, 0xcf, 0xce, 0xe1]); // "madkhal" in cp1256
  assert.equal(decodeCodePageString(bytes, 1256), "مدخل");
});

test("windows-1252 Western text decodes", () => {
  const bytes = Buffer.from([0x54, 0x68, 0xe9, 0x6f]); // "Theo" with an acute e
  assert.equal(decodeCodePageString(bytes, 1252), "Théo");
});

test("an unknown or absent code page falls back to windows-1252", () => {
  assert.equal(labelForCodePage(99999), "windows-1252");
  assert.equal(labelForCodePage(null), "windows-1252");
});

// --- the signed-int16 trap -------------------------------------------------

test("65001 stored as a signed int16 is read back as 65001", () => {
  // PID_CODEPAGE is VT_I2, so UTF-8 does not fit and is written negative.
  // Missing this sends every UTF-8 property set to the fallback decoder.
  const asInt16 = Buffer.alloc(2);
  asInt16.writeUInt16LE(65001);
  assert.equal(normalizeCodePage(asInt16.readInt16LE(0)), 65001);
  assert.equal(normalizeCodePage(1256), 1256);
});

// --- must NOT fire on correct text -----------------------------------------

test("French accented text is left alone", () => {
  for (const s of [
    "Théologie spirituelle",
    "Cursus Diplôme de Spiritualité Carmélitaine",
    "Conférences des Carmélites déchaussées au Liban",
    "Procès-verbal de l'assemblée générale",
    "Compte complet - Construction Eglise N.D. Carmel",
  ]) {
    assert.equal(looksLikeMojibake(s), false, `wrongly flagged: ${s}`);
    assert.equal(repairMojibake(s), s, `wrongly altered: ${s}`);
  }
});

test("correct Arabic and Hebrew are left alone", () => {
  for (const s of ["تقرير سنوي عن أنشطة الدير", HEBREW]) {
    assert.equal(looksLikeMojibake(s), false, `wrongly flagged: ${s}`);
    assert.equal(repairMojibake(s), s);
  }
});

test("plain English is left alone", () => {
  const s = "Annual Report 2024 - Construction Church N.D. Carmel";
  assert.equal(looksLikeMojibake(s), false);
  assert.equal(repairMojibake(s), s);
});

test("a repair that cannot be verified is not applied", () => {
  // High characters that are not valid UTF-8 underneath must survive
  // untouched rather than becoming replacement characters.
  const s = String.fromCharCode(0xd9, 0xd9, 0xd9);
  const out = repairMojibake(s);
  assert.ok(!out.includes("�"), `repair introduced replacement characters: ${escape(out)}`);
});

test("repairing is idempotent -- running it twice changes nothing", () => {
  const once = repairMojibake(brokenAsLatin1(ARABIC));
  assert.equal(repairMojibake(once), once);
});
