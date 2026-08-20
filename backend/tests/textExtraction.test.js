// Plain-text extraction. The format that needs no parsing was the one format
// with no extractor, so these tests pin both halves: that text comes out, and
// that a mislabelled binary still does not.
process.env.JWT_ACCESS_SECRET = "test-access-secret";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret";
process.env.DATABASE_URL = "postgresql://localhost:5432/test";

const test = require("node:test");
const assert = require("node:assert");

const { extractContent } = require("../src/services/extraction");
const textExtractor = require("../src/services/extraction/textExtractor");

const NUL = "\u0000";

test("a plain .txt yields its own bytes as text", async () => {
  const body = "Bernard Tarabay\nSoftware engineer\nFive years of experience.\n";
  const result = await extractContent(Buffer.from(body, "utf8"), "txt");

  assert.strictEqual(result.extractor, "text");
  assert.strictEqual(result.text, body);
  assert.strictEqual(result.metadata.encoding, "utf-8");
});

test("the formats that used to extract nothing all extract something", async () => {
  const cases = [
    ["csv", "name,amount\nInvoice,42\n"],
    ["md", "# Title\n\nBody text here."],
    ["json", '{"invoice": 42}'],
    ["log", "2026-08-19 ERROR something happened"],
    ["yml", "key: value"],
  ];

  for (const [ext, body] of cases) {
    const result = await extractContent(Buffer.from(body, "utf8"), ext);
    assert.notStrictEqual(result.extractor, "unsupported", `${ext} was still unsupported`);
    assert.ok(result.text.length > 0, `${ext} extracted no text`);
  }
});

test("markup is indexed as prose, not as tags", async () => {
  const html = "<html><body><h1>Quarterly Report</h1><p>Revenue rose.</p></body></html>";
  const result = await extractContent(Buffer.from(html, "utf8"), "html");

  assert.strictEqual(result.extractor, "text-markup");
  assert.ok(result.text.includes("Quarterly Report"));
  assert.ok(result.text.includes("Revenue rose"));
  assert.ok(!result.text.includes("<h1>"), "tags leaked into the indexed text");
});

test("Arabic and French survive the round trip", async () => {
  const body = "دير الكرمل في حيفا\nMaison d'accueil, Conférence 2019\n";
  const result = await extractContent(Buffer.from(body, "utf8"), "txt");

  assert.strictEqual(result.text, body);
  assert.ok(result.text.includes("الكرمل"));
  assert.ok(result.text.includes("Conférence"));
});

test("a CP1252 file is not silently turned into mojibake", async () => {
  // 0x92 is the CP1252 curly apostrophe -- invalid as UTF-8, which is exactly
  // the byte that separates a real UTF-8 read from a wrong one.
  const bytes = Buffer.from([0x4d, 0x61, 0x69, 0x73, 0x6f, 0x6e, 0x20, 0x64, 0x92, 0x61, 0x63, 0x63]);
  const result = await extractContent(bytes, "txt");

  assert.strictEqual(result.metadata.encoding, "cp1252");
  assert.ok(result.text.includes("’"), "the curly apostrophe was lost");
  assert.ok(!result.text.includes("�"), "text was decoded as UTF-8 and corrupted");
});

test("a UTF-8 BOM is consumed rather than indexed", async () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Report", "utf8")]);
  const result = await extractContent(bytes, "txt");

  assert.strictEqual(result.text, "Report");
  assert.strictEqual(result.metadata.encoding, "utf-8-bom");
});

test("UTF-16 in both byte orders decodes, despite being full of NUL bytes", async () => {
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Rapport", "utf16le")]);
  const leResult = await extractContent(le, "txt");
  assert.strictEqual(leResult.text, "Rapport");
  assert.strictEqual(leResult.metadata.encoding, "utf-16le");

  const beBody = Buffer.from("Rapport", "utf16le");
  beBody.swap16();
  const be = Buffer.concat([Buffer.from([0xfe, 0xff]), beBody]);
  const beResult = await extractContent(be, "txt");
  assert.strictEqual(beResult.text, "Rapport");
  assert.strictEqual(beResult.metadata.encoding, "utf-16be");
});

test("a binary file wearing a .txt extension is refused, not indexed as words", async () => {
  const binary = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfd, 0x00, 0x7f, 0x01]);
  const result = await extractContent(binary, "txt");

  assert.strictEqual(result.extractor, "unsupported");
  assert.strictEqual(result.text, "");
  assert.match(result.metadata.reason, /not text/);
});

test("CRLF and LF files with the same content produce identical text", async () => {
  const crlf = await extractContent(Buffer.from("line one\r\nline two\r\n", "utf8"), "txt");
  const lf = await extractContent(Buffer.from("line one\nline two\n", "utf8"), "txt");

  assert.strictEqual(crlf.text, lf.text);
});

test("an empty text file is a text file, not an unsupported one", async () => {
  const result = await extractContent(Buffer.alloc(0), "txt");

  assert.strictEqual(result.extractor, "text");
  assert.strictEqual(result.text, "");
  assert.strictEqual(result.metadata.lineCount, 0);
});

test("oversized text is truncated and says so", async () => {
  const huge = "a".repeat(2_000_050);
  const result = await extractContent(Buffer.from(huge, "utf8"), "log");

  assert.strictEqual(result.metadata.truncated, true);
  assert.strictEqual(result.text.length, 2_000_000);
});

test("an extension outside the allowlist is still unsupported", async () => {
  // The guard against turning this into a catch-all: an unknown binary must
  // not be decoded as text just because it has no magic bytes.
  const result = await extractContent(Buffer.from("whatever", "utf8"), "dat");
  assert.strictEqual(result.extractor, "unsupported");
});

test("the binary guard runs on decoded text, so UTF-16 is not mistaken for binary", () => {
  assert.strictEqual(textExtractor.looksLikeText("Rapport annuel"), true);
  assert.strictEqual(textExtractor.looksLikeText("Rapport" + NUL + "annuel"), false);
});
