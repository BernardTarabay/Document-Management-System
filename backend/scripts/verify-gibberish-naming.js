// Proves the reported bug is fixed: "I was getting a bunch of gibberish
// because of pictures".
//
// A scanned page extracts to noise, the AI tier reads the noise, and a
// confident invented title replaces a name a human chose. The guard has to
// hold at the naming stage specifically, because that is the last point
// before a real document gets a made-up name -- and it has to hold WITHOUT
// suppressing legitimate renames, which is the harder half.
//
//   node scripts/verify-gibberish-naming.js

const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { Pool } = require("pg");
const env = require("../src/config/env");
const storageLocationService = require("../src/services/storageLocationService");
const scanProcessor = require("../src/jobs/processors/scanProcessor");
const generateNamesProcessor = require("../src/jobs/processors/generateNamesProcessor");
const fileContentRepository = require("../src/repositories/fileContentRepository");
const fileMetadataRepository = require("../src/repositories/fileMetadataRepository");
const classificationResultRepository = require("../src/repositories/classificationResultRepository");
const subjectRepository = require("../src/repositories/subjectRepository");
const { closeAllQueues } = require("../src/queues");
const { closeRedisConnection } = require("../src/config/redis");

const p = new Pool({ connectionString: env.databaseUrl });
let passed = 0, failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`   PASS  ${label}${detail ? ` -- ${detail}` : ""}`); }
  else { failed += 1; console.log(`   FAIL  ${label}${detail ? ` -- ${detail}` : ""}`); }
};

let root, locId;

async function cleanup() {
  try {
    if (locId) {
      const ids = `(SELECT id FROM files WHERE storage_location_id='${locId}')`;
      await p.query(`DELETE FROM rename_proposals      WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM classification_results WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM file_content          WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM file_metadata         WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM file_hashes           WHERE file_id IN ${ids}`);
      await p.query(`DELETE FROM audit_logs WHERE entity_type='file' AND entity_id IN ${ids}`);
      await p.query(`DELETE FROM processing_jobs  WHERE storage_location_id=$1`, [locId]);
      await p.query(`DELETE FROM filesystem_scans WHERE storage_location_id=$1`, [locId]);
      await p.query(`DELETE FROM files            WHERE storage_location_id=$1`, [locId]);
      await p.query(`DELETE FROM storage_locations WHERE id=$1`, [locId]);
    }
    if (root) await fsp.rm(root, { recursive: true, force: true });
    console.log("\ncleaned up.");
  } catch (e) { console.log("cleanup warning:", e.message); }
  await p.end(); await closeAllQueues(); await closeRedisConnection();
}

const proposalsFor = async (fileId) =>
  (await p.query("SELECT * FROM rename_proposals WHERE file_id=$1", [fileId])).rows;

(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "dms-gibberish-"));
  const NAMES = ["scan_0042.pdf", "IMG_1234.pdf", "real_report.pdf", "titled_scan.pdf"];
  for (const n of NAMES) await fsp.writeFile(path.join(root, n), "x".repeat(2048));

  const admin = (await p.query("SELECT id FROM users ORDER BY created_at LIMIT 1")).rows[0];
  const loc = await storageLocationService.create(
    { name: "Gibberish Test", type: "local", rootPath: root, accessMode: "direct" }, admin.id);
  locId = loc.id;
  await scanProcessor.handle({ storageLocationId: locId });

  const files = {};
  for (const r of (await p.query("SELECT * FROM files WHERE storage_location_id=$1", [locId])).rows) {
    files[r.filename_current] = r;
  }

  const subject = (await subjectRepository.list({ limit: 1 }))[0];
  const classify = (fileId) =>
    classificationResultRepository.create({
      fileId,
      classifiedSubjectId: subject.id,
      classifiedDocumentTypeId: null,
      confidenceLevel: "medium",
      confidenceScore: 0.6,
      method: "rule",
      rawOutput: { fixture: true },
    });

  // 1. A scan whose extraction produced noise, and no embedded title.
  await fileContentRepository.upsert(files["scan_0042.pdf"].id, {
    extractedText: "T h i s i s n o t r e a l t e x t a t a l l b r o k e n f o n t",
    textQuality: "gibberish",
    needsOcr: true,
  });
  await classify(files["scan_0042.pdf"].id);

  // 2. A scan with NO text layer at all.
  await fileContentRepository.upsert(files["IMG_1234.pdf"].id, {
    extractedText: "",
    textQuality: "no_text_layer",
    needsOcr: true,
  });
  await classify(files["IMG_1234.pdf"].id);

  // 3. A genuinely readable document -- this one MUST still be renamed, or
  //    the guard has broken the feature it was protecting.
  await fileContentRepository.upsert(files["real_report.pdf"].id, {
    extractedText:
      "Annual report of the provincial council covering the financial year, including the audited " +
      "accounts and the schedule of properties held by the community.",
    textQuality: "ok",
    needsOcr: false,
  });
  await classify(files["real_report.pdf"].id);

  // 4. Unreadable page content, but the file carries an embedded title the
  //    author wrote. That is real metadata and should still be used.
  await fileContentRepository.upsert(files["titled_scan.pdf"].id, {
    extractedText: "",
    textQuality: "no_text_layer",
    needsOcr: true,
  });
  await fileMetadataRepository.upsert(files["titled_scan.pdf"].id, {
    extractor: "pdf",
    extractorVersion: "test",
    metadata: { title: "Convention de Bail 2024" },
    extractionStatus: "completed",
  });
  await classify(files["titled_scan.pdf"].id);

  console.log("\nrunning the naming stage on all four:\n");
  for (const n of NAMES) await generateNamesProcessor.handle({ fileId: files[n].id });

  const gibberish = await proposalsFor(files["scan_0042.pdf"].id);
  check("a gibberish scan gets NO rename proposal", gibberish.length === 0,
    gibberish.map((x) => x.proposed_filename).join(", "));

  const noLayer = await proposalsFor(files["IMG_1234.pdf"].id);
  check("an image-only PDF gets NO rename proposal", noLayer.length === 0,
    noLayer.map((x) => x.proposed_filename).join(", "));

  const real = await proposalsFor(files["real_report.pdf"].id);
  check("a readable document IS still proposed for renaming", real.length === 1,
    real.map((x) => x.proposed_filename).join(", ") || "(none -- the guard is too aggressive)");

  const titled = await proposalsFor(files["titled_scan.pdf"].id);
  check("an unreadable file with an embedded title IS still named from that title",
    titled.length === 1 && /Bail/i.test(titled[0]?.proposed_filename || ""),
    titled.map((x) => x.proposed_filename).join(", ") || "(none)");

  // The names on disk and in the database must be untouched for the skipped
  // ones -- "keep the PDF's name as it is" is the actual requirement.
  const stillNamed = (await p.query(
    "SELECT filename_current, canonical_filename FROM files WHERE id = ANY($1)",
    [[files["scan_0042.pdf"].id, files["IMG_1234.pdf"].id]]
  )).rows;
  check("skipped files keep their original filename",
    stillNamed.every((r) => ["scan_0042.pdf", "IMG_1234.pdf"].includes(r.filename_current)),
    JSON.stringify(stillNamed.map((r) => r.filename_current)));
  check("skipped files have no canonical name written",
    stillNamed.every((r) => r.canonical_filename === null),
    JSON.stringify(stillNamed.map((r) => r.canonical_filename)));

  // And the reason has to be discoverable, not silent.
  const audit = (await p.query(
    `SELECT count(*)::int n FROM audit_logs
      WHERE action='rename.skipped_unreadable' AND entity_id = ANY($1)`,
    [[files["scan_0042.pdf"].id, files["IMG_1234.pdf"].id]]
  )).rows[0].n;
  check("the skip is recorded in the audit log, not silent", audit === 2, `${audit} entries`);

  const flagged = (await p.query(
    `SELECT count(*)::int n FROM file_content fc JOIN files f ON f.id=fc.file_id
      WHERE f.storage_location_id=$1 AND fc.needs_ocr`, [locId])).rows[0].n;
  check("the three unreadable files are flagged as needing OCR", flagged === 3, `${flagged}`);

  console.log(`\n================ ${failed === 0 ? "ALL PASSED" : `${failed} FAILED`} (${passed} passed) ================`);
  if (failed > 0) process.exitCode = 1;
})().catch((e) => { console.error("\nFAILED:", e); process.exitCode = 1; }).finally(cleanup);
