// Reports where document dates are actually coming from, against real files.
//
// The unit tests prove each parser in isolation. This answers the question
// that decides whether the feature is worth anything: on THIS repository, how
// many files get a date read out of the document itself, versus how many fall
// back to a filesystem timestamp that mostly records when the file was copied?
//
//   node scripts/check-document-dates.js "C:\path\to\folder" [maxFiles]

const fs = require("fs");
const path = require("path");
const { extractContent } = require("../src/services/extraction");
const { resolveDocumentDate } = require("../src/services/extraction/documentDate");

const ROOT = process.argv[2];
const MAX = parseInt(process.argv[3] || "60", 10);
if (!ROOT || !fs.existsSync(ROOT)) {
  console.error("Usage: node scripts/check-document-dates.js <folder> [maxFiles]");
  process.exit(1);
}

const files = [];
(function walk(dir) {
  if (files.length >= MAX) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (files.length >= MAX) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (fs.statSync(full).size < 25 * 1024 * 1024) files.push(full);
  }
})(ROOT);

(async () => {
  const bySource = {};
  const examples = [];

  for (const file of files) {
    let metadata = {};
    try {
      const buf = fs.readFileSync(file);
      metadata = (await extractContent(buf, path.extname(file).slice(1))).metadata || {};
    } catch { /* unreadable: still resolves via the filesystem below */ }

    const st = fs.statSync(file);
    const { date, source } = resolveDocumentDate(metadata, {
      createdAtFs: st.birthtime,
      modifiedAtFs: st.mtime,
    });

    bySource[source] = (bySource[source] || 0) + 1;
    if (source !== "filesystem" && source !== "none" && examples.length < 12) {
      examples.push({ name: path.basename(file), date, source, fsDate: st.mtime });
    }
  }

  console.log(`Sampled ${files.length} file(s)\n`);
  console.log("date source        files   share");
  const total = files.length || 1;
  for (const [src, n] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${src.padEnd(18)}${String(n).padStart(4)}   ${Math.round((n / total) * 100)}%`);
  }

  const real = total - (bySource.filesystem || 0) - (bySource.none || 0);
  console.log(`\n${real} of ${total} (${Math.round((real / total) * 100)}%) have a date read from the document itself.`);

  if (examples.length) {
    console.log("\nWhere it differs from the filesystem timestamp:");
    for (const e of examples) {
      const doc = e.date.toISOString().slice(0, 10);
      const fsd = e.fsDate.toISOString().slice(0, 10);
      const flag = doc !== fsd ? "  <- filesystem would have been wrong" : "";
      console.log(`  ${e.name.slice(0, 30).padEnd(30)} ${doc} (${e.source})  fs=${fsd}${flag}`);
    }
  }
})();
