// Verifies full-text search against the REAL document set, in the languages
// it is actually written in.
//
// Registers the test folder read-only, ingests and extracts text (no AI
// calls -- classification is not needed to prove search works), then runs
// queries and reports what comes back. Cleans up after itself.
const fsp = require("fs/promises");
const path = require("path");
const env = require("../src/config/env");
const { Pool } = require("pg");
const storageLocationService = require("../src/services/storageLocationService");
const scanProcessor = require("../src/jobs/processors/scanProcessor");
const hashProcessor = require("../src/jobs/processors/hashProcessor");
const extractTextProcessor = require("../src/jobs/processors/extractTextProcessor");
const fileRepository = require("../src/repositories/fileRepository");
const { closeAllQueues } = require("../src/queues");
const { closeRedisConnection } = require("../src/config/redis");

const SOURCE = process.argv[2] || "C:\\Users\\user\\OneDrive\\Desktop\\test";
const KEEP = process.argv.includes("--keep");

const p = new Pool({ connectionString: env.databaseUrl });
let locId;
// Only ever tear down a location THIS script registered. The folder may
// already be registered because the user set it up themselves -- deleting
// that, along with its files and their classifications, because a
// verification script happened to reuse it would be indefensible.
let createdByThisRun = false;

async function cleanup() {
  if (!createdByThisRun) {
    if (locId) console.log("\nleft the pre-existing location alone (this script did not create it).");
  } else if (KEEP) {
    console.log(`\n(--keep) Left the location registered: ${locId}`);
  } else if (locId) {
    try {
      await p.query("DELETE FROM file_content WHERE file_id IN (SELECT id FROM files WHERE storage_location_id=$1)", [locId]);
      await p.query("DELETE FROM file_hashes WHERE file_id IN (SELECT id FROM files WHERE storage_location_id=$1)", [locId]);
      await p.query("DELETE FROM files WHERE storage_location_id=$1", [locId]);
      await p.query("DELETE FROM filesystem_scans WHERE storage_location_id=$1", [locId]);
      await p.query("DELETE FROM processing_jobs WHERE storage_location_id=$1", [locId]);
      await p.query("DELETE FROM storage_locations WHERE id=$1", [locId]);
      console.log("\ncleaned up (pass --keep to leave the folder registered).");
    } catch (e) { console.log("cleanup warning:", e.message); }
  }
  await p.end(); await closeAllQueues(); await closeRedisConnection();
}

(async () => {
  await fsp.access(SOURCE);
  console.log("source folder:", SOURCE);

  const admin = await p.query("SELECT id FROM users ORDER BY created_at LIMIT 1");
  const existing = await p.query("SELECT id FROM storage_locations WHERE root_path = $1", [path.resolve(SOURCE)]);
  if (existing.rows.length) {
    locId = existing.rows[0].id;
    console.log("(already registered, reusing)");
  } else {
    const loc = await storageLocationService.create(
      { name: "Test Folder", type: "local", rootPath: SOURCE, accessMode: "direct" }, admin.rows[0].id);
    locId = loc.id;
    createdByThisRun = true;
    console.log(`registered read-only=${loc.is_read_only}`);
  }

  const scan = await scanProcessor.handle({ storageLocationId: locId });
  console.log(`scan: discovered=${scan.discovered} new=${scan.new}`);

  const files = await p.query("SELECT id FROM files WHERE storage_location_id=$1", [locId]);
  console.log(`\nextracting text from ${files.rows.length} file(s)...`);
  let extracted = 0, empty = 0;
  for (const { id } of files.rows) {
    try {
      await hashProcessor.handle({ fileId: id });
      const r = await extractTextProcessor.handle({ fileId: id });
      if (r.textLength > 0) extracted += 1; else empty += 1;
    } catch { empty += 1; }
  }
  console.log(`  ${extracted} with text, ${empty} without`);

  const queries = [
    ["conférence", "French, singular -> should match plural 'Conférences'"],
    ["Carmélites", "French, accented"],
    ["chapitre provincial", "French, multi-word"],
    ["رسالة", "Arabic"],
    ["invoice", "English"],
    ["Liban", "proper noun"],
  ];

  console.log("\n================ SEARCH RESULTS ================");
  for (const [q, why] of queries) {
    const rows = await fileRepository.searchEverything(q, { limit: 4 });
    console.log(`\n"${q}"  (${why})`);
    console.log(`   ${rows.length} hit(s)`);
    for (const r of rows) {
      const how = [
        r.matched_filename ? "name" : null,
        r.matched_content ? "content" : null,
        r.matched_ai ? "ai" : null,
      ].filter(Boolean).join("+");
      console.log(`     [${Number(r.rank).toFixed(2)} ${how}] ${r.filename_current}`);
      if (r.snippet) {
        console.log(`        …${r.snippet.replace(/\s+/g, " ").slice(0, 150)}`);
      }
    }
  }

  console.log("\n--- a query that should find NOTHING ---");
  const none = await fileRepository.searchEverything("zzzzqqqxyz", { limit: 5 });
  console.log(`   ${none.length} hit(s) ${none.length === 0 ? "(correct)" : "(unexpected)"}`);
})().catch((e) => console.error("\nFAILED:", e.message)).finally(cleanup);
