// Re-reads the embedded titles out of real legacy Office files on disk and
// reports whether any still look mis-decoded.
//
// The unit tests prove the decoder against constructed input; this proves it
// against the actual documents that produced the bug report. Read-only --
// it opens files and prints, and changes nothing.
//
//   node scripts/check-ole-titles.js "C:\path\to\folder" [maxFiles]

const fs = require("fs");
const path = require("path");
const { readSummaryInformation } = require("../src/services/extraction/oleCfbExtractor");
const cfb = require("../src/utils/cfb");
const { looksLikeMojibake } = require("../src/services/extraction/ole/codePageString");

const ROOT = process.argv[2];
const MAX = parseInt(process.argv[3] || "40", 10);
if (!ROOT || !fs.existsSync(ROOT)) {
  console.error("Usage: node scripts/check-ole-titles.js <folder> [maxFiles]");
  process.exit(1);
}

const LEGACY = new Set([".doc", ".xls", ".ppt"]);
const found = [];

(function walk(dir) {
  if (found.length >= MAX) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (found.length >= MAX) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (LEGACY.has(path.extname(e.name).toLowerCase())) found.push(full);
  }
})(ROOT);

console.log(`Inspecting ${found.length} legacy Office file(s)\n`);

let withTitle = 0;
let broken = 0;

for (const file of found) {
  let title = null;
  try {
    const buf = fs.readFileSync(file);
    const container = cfb.parse(buf);
    const stream = container.getStream(String.fromCharCode(5) + "SummaryInformation");
    title = readSummaryInformation(stream).title;
  } catch {
    continue; // not a readable compound file; the extractor reports that separately
  }
  if (!title) continue;
  withTitle += 1;
  const bad = looksLikeMojibake(title);
  if (bad) broken += 1;
  console.log(`${bad ? "BROKEN " : "ok     "} ${path.basename(file).slice(0, 34).padEnd(34)} ${title.slice(0, 60)}`);
}

console.log(`\n${withTitle} file(s) carry an embedded title; ${broken} still look mis-decoded.`);
if (withTitle > 0 && broken === 0) console.log("No mojibake remaining.");
