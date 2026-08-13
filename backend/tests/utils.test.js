const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const AdmZip = require("adm-zip");

const { parsePagination } = require("../src/utils/pagination");
const { detectSignature } = require("../src/utils/fileSignature");
const { resolveAvailableFilename } = require("../src/utils/resolveAvailableFilename");

// --- pagination ---------------------------------------------------------

test("parsePagination applies defaults and caps", () => {
  assert.deepStrictEqual(parsePagination({}), { limit: 50, offset: 0 });
  assert.deepStrictEqual(parsePagination({ limit: "25", offset: "100" }), { limit: 25, offset: 100 });
  assert.deepStrictEqual(parsePagination({ limit: "10000" }), { limit: 200, offset: 0 }, "must cap at MAX_LIMIT");
});

test("parsePagination rejects junk without producing an unbounded query", () => {
  for (const q of [
    { limit: "abc" }, { limit: "-5" }, { limit: "0" },
    { limit: null }, { limit: undefined }, { limit: "1e9" },
  ]) {
    const { limit } = parsePagination(q);
    assert.ok(limit > 0 && limit <= 200, `limit escaped bounds for ${JSON.stringify(q)}: ${limit}`);
  }
  assert.strictEqual(parsePagination({ offset: "-10" }).offset, 0, "negative offset would break SQL");
  assert.strictEqual(parsePagination({ offset: "abc" }).offset, 0);
});

// --- file signature detection ------------------------------------------

function ooxml(entryName) {
  const zip = new AdmZip();
  zip.addFile("[Content_Types].xml", Buffer.from("<Types/>"));
  zip.addFile(entryName, Buffer.from("<xml/>"));
  return zip.toBuffer();
}

test("detects a PDF by magic bytes", () => {
  const buf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64)]);
  assert.deepStrictEqual(detectSignature(buf), { family: "pdf", subtype: "pdf" });
});

test("detects legacy OLE-CFB (.doc/.xls/.ppt)", () => {
  const buf = Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.alloc(64),
  ]);
  assert.strictEqual(detectSignature(buf).family, "ole-cfb");
});

test("disambiguates the OOXML zip family by entry names", () => {
  assert.strictEqual(detectSignature(ooxml("word/document.xml")).subtype, "docx");
  assert.strictEqual(detectSignature(ooxml("xl/workbook.xml")).subtype, "xlsx");
  assert.strictEqual(detectSignature(ooxml("ppt/presentation.xml")).subtype, "pptx");
});

test("a pbix is not mistaken for a spreadsheet", () => {
  // Called out explicitly in spec §8: a PBIX is a zip, but structurally
  // unlike an xlsx -- treating it as one is the trap.
  assert.strictEqual(detectSignature(ooxml("DataModel")).subtype, "pbix");
  assert.strictEqual(detectSignature(ooxml("Report/Layout")).subtype, "pbix");
});

test("content wins over a lying extension", () => {
  // Spec §7: detection must not rely exclusively on the extension.
  const pdfBytes = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64)]);
  assert.strictEqual(detectSignature(pdfBytes, "xlsx").family, "pdf");
});

test("an unrecognized file falls back to the extension hint and says so", () => {
  const result = detectSignature(Buffer.from("just some plain text"), ".txt");
  assert.strictEqual(result.family, "unknown");
  assert.strictEqual(result.subtype, "txt");
  assert.strictEqual(result.fallbackToExtension, true);
});

test("a truncated or empty buffer does not throw", () => {
  assert.doesNotThrow(() => detectSignature(Buffer.alloc(0)));
  assert.doesNotThrow(() => detectSignature(Buffer.from([0x25, 0x50])), "shorter than the PDF signature");
});

test("a corrupt zip is reported, not thrown", () => {
  const badZip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("not really a zip")]);
  const result = detectSignature(badZip);
  assert.strictEqual(result.family, "zip");
  assert.strictEqual(result.subtype, "unreadable-zip");
});

// --- filename collision handling ---------------------------------------

function fakeStorage(existingRelativePaths) {
  const taken = new Set(existingRelativePaths.map((p) => p.split(/[/\\]/).join(path.sep)));
  return {
    async stat(relativePath) {
      return { exists: taken.has(relativePath.split(/[/\\]/).join(path.sep)) };
    },
  };
}

test("a free filename is returned unchanged", async () => {
  const got = await resolveAvailableFilename(fakeStorage([]), "Finance", "Report.pdf");
  assert.strictEqual(got, "Report.pdf");
});

test("a colliding filename gets a numeric suffix before the extension", async () => {
  // fs.rename() silently overwrites, so this is the only thing standing
  // between a bulk rename and real data loss.
  const storage = fakeStorage([path.join("Finance", "Report.pdf")]);
  assert.strictEqual(await resolveAvailableFilename(storage, "Finance", "Report.pdf"), "Report (2).pdf");
});

test("suffixes keep climbing past an existing chain of collisions", async () => {
  const storage = fakeStorage([
    path.join("Finance", "Report.pdf"),
    path.join("Finance", "Report (2).pdf"),
    path.join("Finance", "Report (3).pdf"),
  ]);
  assert.strictEqual(await resolveAvailableFilename(storage, "Finance", "Report.pdf"), "Report (4).pdf");
});

test("collision checks are scoped to the target directory", async () => {
  // The same name in a different folder is not a collision.
  const storage = fakeStorage([path.join("Academic", "Report.pdf")]);
  assert.strictEqual(await resolveAvailableFilename(storage, "Finance", "Report.pdf"), "Report.pdf");
});

test("works at the storage root", async () => {
  const storage = fakeStorage(["Report.pdf"]);
  assert.strictEqual(await resolveAvailableFilename(storage, null, "Report.pdf"), "Report (2).pdf");
});

test("a dotless filename still gets a suffix", async () => {
  const storage = fakeStorage(["README"]);
  assert.strictEqual(await resolveAvailableFilename(storage, null, "README"), "README (2)");
});

test("a non-Latin filename collides and suffixes correctly", async () => {
  const name = "تقرير_صندوق_المعاشات.pdf";
  const storage = fakeStorage([name]);
  assert.strictEqual(await resolveAvailableFilename(storage, null, name), "تقرير_صندوق_المعاشات (2).pdf");
});

test("gives up rather than spinning forever", async () => {
  const alwaysTaken = { async stat() { return { exists: true }; } };
  await assert.rejects(
    () => resolveAvailableFilename(alwaysTaken, null, "Report.pdf"),
    /Could not find an available filename/
  );
});
