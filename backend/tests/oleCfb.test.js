// Legacy Office 97-2003 extraction (.doc/.xls/.ppt), closing the gap
// documented in docs/07-supported-formats.md.
//
// The .doc and .xls fixtures are real binaries produced by LibreOffice from
// the neutral flat-ODF sources in tests/fixtures/README.md -- parsing these
// formats is entirely about byte offsets, so a hand-built mock would only
// test the mock. The .ppt records are built inline instead, because a real
// .ppt fixture is ~450KB of embedded font data for two slides of text.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const cfb = require("../src/utils/cfb");
const { decodeCp1252 } = require("../src/services/extraction/ole/cp1252");
const { extractDocText } = require("../src/services/extraction/ole/docText");
const { extractXlsText } = require("../src/services/extraction/ole/xlsText");
const { extractPptText } = require("../src/services/extraction/ole/pptText");
const { extractContent } = require("../src/services/extraction");

const FIXTURES = path.join(__dirname, "fixtures");
const readFixture = (name) => fs.readFileSync(path.join(FIXTURES, name));

// --- CP1252 -------------------------------------------------------------

test("CP1252 decodes the 0x80-0x9F range Latin-1 gets wrong", () => {
  // This range holds the curly quotes, em dash and ellipsis that real Word
  // documents are full of. Latin-1 maps them to C1 control characters,
  // which then get stripped as junk -- silently eating punctuation.
  assert.strictEqual(decodeCp1252(Buffer.from([0x93, 0x94])), "“”"); // curly double quotes
  assert.strictEqual(decodeCp1252(Buffer.from([0x91, 0x92])), "‘’"); // curly single quotes
  assert.strictEqual(decodeCp1252(Buffer.from([0x97])), "—"); // em dash
  assert.strictEqual(decodeCp1252(Buffer.from([0x85])), "…"); // ellipsis
  assert.strictEqual(decodeCp1252(Buffer.from([0x80])), "€"); // euro
});

test("CP1252 leaves ASCII and the upper Latin-1 range alone", () => {
  assert.strictEqual(decodeCp1252(Buffer.from("Hello", "latin1")), "Hello");
  assert.strictEqual(decodeCp1252(Buffer.from([0xe9, 0xe8, 0xe7])), "éèç");
});

// --- CFB container ------------------------------------------------------

test("recognizes the compound file signature", () => {
  assert.strictEqual(cfb.isCfb(readFixture("sample.doc")), true);
  assert.strictEqual(cfb.isCfb(Buffer.from("%PDF-1.7")), false);
  assert.strictEqual(cfb.isCfb(Buffer.alloc(0)), false);
});

test("parses the stream directory of a real .doc", () => {
  const container = cfb.parse(readFixture("sample.doc"));
  assert.ok(container.getStream("WordDocument"), "WordDocument stream missing");
  // Word stores the piece table in whichever of 0Table/1Table the FIB names.
  assert.ok(
    container.getStream("1Table") || container.getStream("0Table"),
    "no table stream found"
  );
  assert.ok([512, 4096].includes(container.sectorSize));
});

test("parses the stream directory of a real .xls", () => {
  const container = cfb.parse(readFixture("sample.xls"));
  assert.ok(container.getStream("Workbook"), "Workbook stream missing");
});

test("rejects non-compound input rather than returning nonsense", () => {
  assert.throws(() => cfb.parse(Buffer.from("not a compound file at all")), cfb.CfbError);
});

test("rejects a file with the right magic but a corrupt header", () => {
  const fake = Buffer.alloc(1536);
  cfb.HEADER_SIGNATURE.copy(fake, 0);
  assert.throws(() => cfb.parse(fake), cfb.CfbError);
});

// --- .doc ---------------------------------------------------------------

test("extracts prose from a real .doc via the piece table", () => {
  const container = cfb.parse(readFixture("sample.doc"));
  const { text, pieceCount } = extractDocText(container.getStream("WordDocument"), container);

  assert.ok(pieceCount >= 1);
  assert.match(text, /Legacy Extraction Test Document/);
  assert.match(text, /ordinary prose to recover/);
  assert.match(text, /Final paragraph after the table/);
});

test(".doc table cells stay separated instead of fusing together", () => {
  // Dropping the 0x07 cell mark instead of turning it into whitespace
  // produces "AlphaCellBetaCell" -- inventing words that are in no document
  // and destroying the real ones.
  const container = cfb.parse(readFixture("sample.doc"));
  const { text } = extractDocText(container.getStream("WordDocument"), container);

  for (const cell of ["AlphaCell", "BetaCell", "GammaCell", "DeltaCell", "EpsilonCell", "ZetaCell"]) {
    assert.match(text, new RegExp(`\\b${cell}\\b`), `${cell} not present as its own token`);
  }
  assert.ok(!/AlphaCellBetaCell/.test(text), "adjacent cells fused into one token");
});

test(".doc output carries no leftover control characters", () => {
  const container = cfb.parse(readFixture("sample.doc"));
  const { text } = extractDocText(container.getStream("WordDocument"), container);
  const controls = text.match(new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]", "g"));
  assert.strictEqual(controls, null, `control characters survived: ${JSON.stringify(controls)}`);
});

test(".doc extraction fails loudly when the table stream is missing", () => {
  const container = cfb.parse(readFixture("sample.doc"));
  const stripped = { getStream: (name) => (name === "WordDocument" ? container.getStream(name) : null) };
  assert.throws(() => extractDocText(container.getStream("WordDocument"), stripped), /Table stream/);
});

// --- .xls ---------------------------------------------------------------

test("extracts shared strings and sheet names from a real .xls", () => {
  const { text, sheetNames, sharedStringCount } = extractXlsText(
    cfb.parse(readFixture("sample.xls")).getStream("Workbook")
  );

  assert.deepStrictEqual(sheetNames, ["FirstSheet", "SecondSheet"]);
  assert.ok(sharedStringCount > 0);
  for (const cell of ["HeaderAlpha", "HeaderBeta", "HeaderGamma", "ValueDelta", "SecondSheetContent"]) {
    assert.match(text, new RegExp(cell), `${cell} missing from extracted text`);
  }
});

test(".xls header/footer format codes are stripped, not indexed as words", () => {
  // Stored as e.g. "&CPrinted on &D&R&P" -- layout directives, not content.
  const { text } = extractXlsText(cfb.parse(readFixture("sample.xls")).getStream("Workbook"));
  assert.ok(!/&[A-Za-z]/.test(text), `format codes leaked into text: ${JSON.stringify(text)}`);
});

test(".xls extraction rejects an empty workbook stream", () => {
  assert.throws(() => extractXlsText(Buffer.alloc(0)), /empty or truncated/);
  assert.throws(() => extractXlsText(null), /empty or truncated/);
});

// --- .ppt ---------------------------------------------------------------

// Builds a PowerPoint record: recVerAndInstance(2) recType(2) recLen(4).
function pptRecord(recType, body, { container = false } = {}) {
  const header = Buffer.alloc(8);
  header.writeUInt16LE(container ? 0x000f : 0x0000, 0);
  header.writeUInt16LE(recType, 2);
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

const TEXT_CHARS_ATOM = 0x0fa0;
const TEXT_BYTES_ATOM = 0x0fa8;
const MAIN_MASTER_CONTAINER = 0x03f8;
const SLIDE_CONTAINER = 0x03ee;

test("extracts both 16-bit and 8-bit PowerPoint text atoms", () => {
  const stream = Buffer.concat([
    pptRecord(TEXT_CHARS_ATOM, Buffer.from("Wide Slide Title", "utf16le")),
    pptRecord(TEXT_BYTES_ATOM, Buffer.from("Narrow bullet text", "latin1")),
  ]);
  const { text } = extractPptText(stream);
  assert.match(text, /Wide Slide Title/);
  assert.match(text, /Narrow bullet text/);
});

test("descends into PowerPoint container records", () => {
  const inner = pptRecord(TEXT_CHARS_ATOM, Buffer.from("Nested Slide Text", "utf16le"));
  const stream = pptRecord(SLIDE_CONTAINER, inner, { container: true });
  assert.match(extractPptText(stream).text, /Nested Slide Text/);
});

test("slide-master placeholder text is excluded", () => {
  // "Click to edit the title text format" is identical in every deck built
  // from a stock template. Including it would make every .ppt look similar
  // to every other one, feeding false positives straight into
  // probable-duplicate detection.
  const master = pptRecord(
    MAIN_MASTER_CONTAINER,
    pptRecord(TEXT_CHARS_ATOM, Buffer.from("Click to edit the title text format", "utf16le")),
    { container: true }
  );
  const slide = pptRecord(
    SLIDE_CONTAINER,
    pptRecord(TEXT_CHARS_ATOM, Buffer.from("Real Slide Content", "utf16le")),
    { container: true }
  );

  const { text } = extractPptText(Buffer.concat([master, slide]));
  assert.match(text, /Real Slide Content/);
  assert.ok(!/Click to edit/.test(text), "master placeholder text leaked into output");
});

test("PowerPoint atoms carrying no letters or digits are dropped", () => {
  const stream = Buffer.concat([
    pptRecord(TEXT_CHARS_ATOM, Buffer.from("•", "utf16le")), // lone bullet glyph
    pptRecord(TEXT_CHARS_ATOM, Buffer.from("Actual Content", "utf16le")),
  ]);
  const { text, atomCount } = extractPptText(stream);
  assert.strictEqual(atomCount, 1);
  assert.strictEqual(text, "Actual Content");
});

test("a truncated PowerPoint stream stops cleanly instead of throwing", () => {
  const good = pptRecord(TEXT_CHARS_ATOM, Buffer.from("Kept Text", "utf16le"));
  const truncated = Buffer.concat([good, Buffer.from([0x00, 0x00, 0xa0, 0x0f, 0xff, 0xff, 0x00, 0x00])]);
  assert.doesNotThrow(() => extractPptText(truncated));
  assert.match(extractPptText(truncated).text, /Kept Text/);
});

// --- registry integration ----------------------------------------------

test("extractContent dispatches legacy formats by stream, not extension", async () => {
  const doc = await extractContent(readFixture("sample.doc"), "doc");
  assert.strictEqual(doc.extractor, "doc");
  assert.strictEqual(doc.detectedSubtype, "ole-cfb");
  assert.match(doc.text, /Legacy Extraction Test Document/);

  const xls = await extractContent(readFixture("sample.xls"), "xls");
  assert.strictEqual(xls.extractor, "xls");
  assert.match(xls.text, /HeaderAlpha/);
});

test("a .doc renamed .xls still extracts as a .doc (spec §7)", async () => {
  // Detection must not rely exclusively on the extension.
  const result = await extractContent(readFixture("sample.doc"), "xls");
  assert.strictEqual(result.extractor, "doc");
  assert.match(result.text, /Legacy Extraction Test Document/);
});

test("a compound file with no Office stream reports unsupported, not empty text", async () => {
  const fake = Buffer.alloc(1536);
  cfb.HEADER_SIGNATURE.copy(fake, 0);
  const result = await extractContent(fake, "doc");
  assert.strictEqual(result.extractor, "unsupported");
  assert.ok(result.metadata.reason, "unsupported result must explain itself");
});

test("legacy extraction surfaces document metadata when present", async () => {
  const result = await extractContent(readFixture("sample.xls"), "xls");
  assert.deepStrictEqual(result.metadata.sheetNames, ["FirstSheet", "SecondSheet"]);
  assert.strictEqual(result.metadata.sheetCount, 2);
});
