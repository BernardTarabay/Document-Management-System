
// Proves the cloud-placeholder check is both FAST and still CORRECT.
//
// These two pull against each other, which is the whole point of this
// script. inspect() used to spawn powershell.exe for every single file --
// 305.8 ms each, measured, against 0.2 ms for the stat it was gating. It now
// only pays for that subprocess when a cheap stat says the file looks like a
// placeholder. The risk of that change is obvious: make the gate too tight
// and placeholder detection quietly stops working, which on a real iCloud
// folder means downloading hundreds of gigabytes to index it.
//
// A real placeholder cannot be created on demand, so this uses the next best
// thing: an NTFS SPARSE file, which is what a placeholder is underneath --
// full logical size, nothing allocated on disk. Verified here: a 2 MB sparse
// file reports blocks 0, exactly like the real thing, while an ordinary 2 MB
// file reports 4096.
//
//   node scripts/verify-placeholder-detection.js

const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const cloudPlaceholder = require("../src/utils/cloudPlaceholder");

const FILE_ATTRIBUTE_OFFLINE = 0x1000;

let passed = 0, failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`   PASS  ${label}${detail ? ` -- ${detail}` : ""}`); }
  else { failed += 1; console.log(`   FAIL  ${label}${detail ? ` -- ${detail}` : ""}`); }
};

const ps = (script) =>
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" }).trim();

let dir;

(async () => {
  if (!cloudPlaceholder.IS_WINDOWS) {
    console.log("Not Windows -- the subprocess gate this verifies does not apply here.");
    return;
  }

  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "dms-placeholder-"));
  const ordinary = path.join(dir, "ordinary-2mb.bin");
  const sparse = path.join(dir, "sparse-2mb.bin");
  const smallFile = path.join(dir, "small.txt");

  await fsp.writeFile(ordinary, Buffer.alloc(2 * 1024 * 1024, 0x41));
  await fsp.writeFile(smallFile, "tiny");

  // A sparse file with its whole range deallocated: the shape of a real
  // cloud placeholder.
  execFileSync("fsutil", ["file", "createnew", sparse, String(2 * 1024 * 1024)], { stdio: "ignore" });
  execFileSync("fsutil", ["sparse", "setflag", sparse], { stdio: "ignore" });
  execFileSync("fsutil", ["sparse", "setrange", sparse, "0", String(2 * 1024 * 1024)], { stdio: "ignore" });
  // Mark it offline, which is what the sync client sets.
  ps(`$i = Get-Item -LiteralPath '${sparse}' -Force; $i.Attributes = [int]$i.Attributes -bor ${FILE_ATTRIBUTE_OFFLINE}`);

  console.log("fixtures:", dir);
  const statOf = (f) => { const s = fs.statSync(f); return `size=${s.size} blocks=${s.blocks}`; };
  console.log(`   ordinary  ${statOf(ordinary)}`);
  console.log(`   sparse    ${statOf(sparse)}`);
  console.log(`   small     ${statOf(smallFile)}`);

  // --- correctness --------------------------------------------------------
  console.log("\ncorrectness:");
  const sparseResult = await cloudPlaceholder.inspect(sparse);
  check("a sparse, offline-marked file IS detected as a placeholder",
    sparseResult.isPlaceholder === true, sparseResult.reason || "(no reason given)");

  const ordinaryResult = await cloudPlaceholder.inspect(ordinary);
  check("an ordinary 2 MB file is NOT a placeholder", ordinaryResult.isPlaceholder === false);

  const smallResult = await cloudPlaceholder.inspect(smallFile);
  check("a small local file is NOT a placeholder", smallResult.isPlaceholder === false);

  // The failure that would be invisible in production: a real document
  // wrongly skipped means it is never hashed, never indexed, never
  // searchable, and nothing ever says so.
  const corpusish = [];
  for (let i = 0; i < 40; i += 1) {
    const f = path.join(dir, `doc-${i}.bin`);
    await fsp.writeFile(f, Buffer.alloc(1024 * (i % 7 === 0 ? 4096 : 40), 0x42)); // mix of ~4MB and ~40KB
    corpusish.push(f);
  }
  const falsePositives = [];
  for (const f of corpusish) {
    if ((await cloudPlaceholder.inspect(f)).isPlaceholder) falsePositives.push(path.basename(f));
  }
  check("no ordinary file is wrongly skipped", falsePositives.length === 0, falsePositives.join(", "));

  // --- cost ---------------------------------------------------------------
  console.log("\ncost:");
  let t = Date.now();
  for (const f of corpusish) await fsp.stat(f);
  const statMs = Date.now() - t;

  t = Date.now();
  for (const f of corpusish) await cloudPlaceholder.inspect(f);
  const inspectMs = Date.now() - t;

  const perFile = inspectMs / corpusish.length;
  console.log(`   plain stat        ${(statMs / corpusish.length).toFixed(2)} ms/file`);
  console.log(`   inspect()         ${perFile.toFixed(2)} ms/file`);
  console.log(`   per 100k files    ${((perFile * 100000) / 1000 / 60).toFixed(1)} minutes`);

  // The old implementation was 305.8 ms/file here. Anything within an order
  // of magnitude of a bare stat means no subprocess is being spawned.
  check("ordinary files cost no subprocess", perFile < 5, `${perFile.toFixed(2)} ms/file`);

  console.log(`\n================ ${failed === 0 ? "ALL PASSED" : `${failed} FAILED`} (${passed} passed) ================`);
  if (failed > 0) process.exitCode = 1;
})()
  .catch((e) => { console.error("\nFAILED:", e); process.exitCode = 1; })
  .finally(async () => { if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); });
