#!/usr/bin/env node
/**
 * Proves per-user isolation is real, not a matter of the frontend hiding
 * buttons.
 *
 * WHAT THIS EXISTS TO CATCH
 *
 * Ownership has exactly one failure mode and it is silent. A query that
 * forgot its owner predicate returns another account's rows with no error, no
 * empty list and no 403 -- it looks like the feature working. Unit tests do
 * not catch it because the leak is in SQL, not in logic. So this drives the
 * real services against the real database with TWO accounts and asserts that
 * each one sees exactly its own rows and nothing else.
 *
 * It creates its own fixtures under a temp directory and removes them and the
 * two accounts on the way out, so it is safe to run against a live database.
 *
 *   node scripts/verify-ownership.js
 */
require("dotenv").config();

const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");

const db = require("../src/config/database");
const authService = require("../src/services/authService");
const storageLocationService = require("../src/services/storageLocationService");
const subjectService = require("../src/services/subjectService");
const fileService = require("../src/services/fileService");
const fileOrganizeService = require("../src/services/fileOrganizeService");
const duplicateGuard = require("../src/services/duplicateGuard");
const triageService = require("../src/services/triageService");
const pipelineState = require("../src/services/pipelineState");
const dashboardService = require("../src/services/dashboardService");
const duplicateGroupService = require("../src/services/duplicateGroupService");
const fileRepository = require("../src/repositories/fileRepository");
const subjectRepository = require("../src/repositories/subjectRepository");
const { parseFileFilters } = require("../src/repositories/fileFilters");

let passed = 0;
let failed = 0;

function ok(label) {
  passed += 1;
  console.log(`  ✓ ${label}`);
}
function bad(label, detail) {
  failed += 1;
  console.log(`  ✗ ${label}`);
  if (detail) console.log(`      ${detail}`);
}
function check(condition, label, detail) {
  if (condition) ok(label);
  else bad(label, detail);
}

/** Asserts a call is refused, and that it is refused for the RIGHT reason. */
async function refuses(label, fn, pattern = /not found|Ownership scope missing|not yours/i) {
  try {
    const result = await fn();
    // Returning null/[] is also a legitimate refusal for a scoped read.
    if (result === null || (Array.isArray(result) && result.length === 0)) {
      ok(`${label} (returned nothing)`);
      return;
    }
    bad(label, `expected a refusal, got: ${JSON.stringify(result).slice(0, 160)}`);
  } catch (err) {
    if (pattern.test(err.message)) ok(`${label} (${err.message.split(".")[0].slice(0, 60)})`);
    else bad(label, `refused, but for the wrong reason: ${err.message}`);
  }
}

async function main() {
  const stamp = Date.now();
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "atlas-verify-"));
  const aliceDir = path.join(tmpRoot, "alice");
  const bobDir = path.join(tmpRoot, "bob");
  await fsp.mkdir(aliceDir, { recursive: true });
  await fsp.mkdir(bobDir, { recursive: true });

  // Same bytes in both folders -- this is what proves content-addressed
  // lookups (twin adoption, duplicate grouping) do not cross accounts.
  const shared = "Facture EDF 2025 -- montant total 412,50 EUR. Reference client 998877.\n".repeat(20);
  await fsp.writeFile(path.join(aliceDir, "facture.txt"), shared, "utf8");
  await fsp.writeFile(path.join(bobDir, "facture.txt"), shared, "utf8");
  await fsp.writeFile(path.join(aliceDir, "notes-alice.txt"), "Notes privees d'Alice.\n".repeat(30), "utf8");

  let alice;
  let bob;

  try {
    console.log("\nRegistering two accounts");
    alice = (await authService.register({
      email: `verify-alice-${stamp}@example.test`, password: "Sup3rSecret!pass", fullName: "Alice Verify",
    })).user;
    bob = (await authService.register({
      email: `verify-bob-${stamp}@example.test`, password: "Sup3rSecret!pass", fullName: "Bob Verify",
    })).user;
    check(alice.id && bob.id && alice.id !== bob.id, "two distinct accounts created");

    // ---------------------------------------------------------------------
    console.log("\nStarter data is per-account");
    const aliceSubjects = await subjectRepository.listForOwnerTree(alice.id);
    const bobSubjects = await subjectRepository.listForOwnerTree(bob.id);
    check(aliceSubjects.length > 0, `Alice got a starter tree (${aliceSubjects.length} folders)`);
    check(bobSubjects.length > 0, `Bob got a starter tree (${bobSubjects.length} folders)`);
    check(
      aliceSubjects.every((s) => !bobSubjects.some((b) => b.id === s.id)),
      "the two starter trees share no rows"
    );
    // The old schema had a GLOBAL unique index on root slugs, so the second
    // account could not have had a "Personal" of its own at all.
    const aliceRoots = aliceSubjects.filter((s) => !s.parent_id).map((s) => s.slug).sort();
    const bobRoots = bobSubjects.filter((s) => !s.parent_id).map((s) => s.slug).sort();
    check(
      aliceRoots.length > 0 && JSON.stringify(aliceRoots) === JSON.stringify(bobRoots),
      "both accounts hold the SAME root slugs independently (per-owner uniqueness)",
      `alice=${aliceRoots} bob=${bobRoots}`
    );

    // ---------------------------------------------------------------------
    console.log("\nA regular user can register a storage location");
    // Neither account is an Admin -- both hold the plain `User` role, which is
    // exactly the account that previously could not do this at all.
    const aliceLoc = await storageLocationService.create(
      { name: "Alice docs", type: "local", rootPath: aliceDir, isReadOnly: true },
      alice.id
    );
    check(Boolean(aliceLoc.id), "Alice registered a folder as a plain User");
    check(aliceLoc.owner_user_id === alice.id, "the location is owned by Alice");
    check(Boolean(aliceLoc.device_id), "it was attached to a device (the server)");

    const bobLoc = await storageLocationService.create(
      { name: "Bob docs", type: "local", rootPath: bobDir, isReadOnly: true },
      bob.id
    );
    check(bobLoc.owner_user_id === bob.id, "Bob registered his own folder");

    console.log("\nStorage locations are isolated");
    const aliceList = await storageLocationService.list(alice.id);
    check(aliceList.length === 1 && aliceList[0].id === aliceLoc.id,
      "Alice sees exactly one location -- her own", `saw ${aliceList.length}`);
    check(!aliceList.some((l) => l.id === bobLoc.id), "Alice does not see Bob's location");

    await refuses("Alice cannot read Bob's location by id",
      () => storageLocationService.getById(bobLoc.id, alice.id));
    await refuses("Alice cannot scan Bob's location",
      () => storageLocationService.triggerScan(bobLoc.id, alice.id));
    await refuses("Alice cannot edit Bob's location",
      () => storageLocationService.update(bobLoc.id, { isReadOnly: false }, alice.id));
    await refuses("Alice cannot remove Bob's location",
      () => storageLocationService.remove(bobLoc.id, alice.id));

    // Two accounts may point at the same path; each gets its OWN row.
    const aliceOnBobsPath = await storageLocationService.create(
      { name: "shared folder", type: "local", rootPath: bobDir, isReadOnly: true },
      alice.id
    );
    check(aliceOnBobsPath.id !== bobLoc.id,
      "registering the same PATH as another account creates a separate location, not a shared one");

    // ---------------------------------------------------------------------
    console.log("\nFiles are isolated");
    // Ingest directly rather than running the scan worker: this script must
    // not depend on a worker process being up.
    const aliceFile = await fileRepository.create({
      storageLocationId: aliceLoc.id, filenameOriginal: "facture.txt", filenameCurrent: "facture.txt",
      extension: "txt", mimeTypeDeclared: "text/plain", mimeTypeDetected: "text/plain",
      sizeBytes: shared.length, originalPath: "facture.txt", currentPath: "facture.txt",
      createdAtFs: new Date(), modifiedAtFs: new Date(), sha256Hash: "a".repeat(64),
    });
    const aliceNote = await fileRepository.create({
      storageLocationId: aliceLoc.id, filenameOriginal: "notes-alice.txt", filenameCurrent: "notes-alice.txt",
      extension: "txt", mimeTypeDeclared: "text/plain", mimeTypeDetected: "text/plain",
      sizeBytes: 600, originalPath: "notes-alice.txt", currentPath: "notes-alice.txt",
      createdAtFs: new Date(), modifiedAtFs: new Date(), sha256Hash: "b".repeat(64),
    });
    const bobFile = await fileRepository.create({
      storageLocationId: bobLoc.id, filenameOriginal: "facture.txt", filenameCurrent: "facture.txt",
      extension: "txt", mimeTypeDeclared: "text/plain", mimeTypeDetected: "text/plain",
      sizeBytes: shared.length, originalPath: "facture.txt", currentPath: "facture.txt",
      // DELIBERATELY the same hash as Alice's: byte-identical content in two
      // different archives.
      createdAtFs: new Date(), modifiedAtFs: new Date(), sha256Hash: "a".repeat(64),
    });

    check(aliceFile.owner_user_id === alice.id,
      "the trigger set the file's owner from its location (Alice)");
    check(bobFile.owner_user_id === bob.id,
      "the trigger set the file's owner from its location (Bob)");

    const aliceFiles = await fileService.search({}, alice.id);
    check(aliceFiles.length === 2, `Alice's file list has 2 entries`, `got ${aliceFiles.length}`);
    check(!aliceFiles.some((f) => f.id === bobFile.id), "Bob's identical file is absent from Alice's list");

    await refuses("Alice cannot open Bob's file detail",
      () => fileService.getFileDetail(bobFile.id, alice.id));
    await refuses("Alice cannot download Bob's file",
      () => fileService.getDownloadStream(bobFile.id, alice.id));
    await refuses("Alice cannot compare against Bob's file",
      () => fileService.compareFiles(aliceFile.id, bobFile.id, alice.id));
    await refuses("Alice cannot rename Bob's file",
      () => fileService.updateFile(bobFile.id, { filename: "stolen.txt" }, alice.id));
    await refuses("Alice cannot delete Bob's file",
      () => fileService.removeFile(bobFile.id, alice.id));

    // The content-addressed lookups are the subtle ones.
    const sameHash = await fileRepository.findBySha256("a".repeat(64), alice.id);
    check(sameHash.length === 1 && sameHash[0].id === aliceFile.id,
      "a hash lookup returns only the caller's copy, though the bytes are identical",
      `got ${sameHash.length} rows`);
    const twin = await fileRepository.findProcessedTwinByHash("a".repeat(64), aliceFile.id, alice.id);
    check(twin === null,
      "twin adoption cannot reach across accounts (Bob's copy is not offered to Alice)");

    // ---------------------------------------------------------------------
    console.log("\nFiling a document is owner-checked on BOTH sides");
    const aliceTarget = aliceSubjects.find((s) => s.parent_id) || aliceSubjects[0];
    const bobTarget = bobSubjects.find((s) => s.parent_id) || bobSubjects[0];

    await refuses("Alice cannot file her file into Bob's folder",
      () => fileOrganizeService.moveToSubject({
        fileId: aliceFile.id, subjectId: bobTarget.id, ownerUserId: alice.id,
      }));
    await refuses("Alice cannot file Bob's file into her own folder",
      () => fileOrganizeService.moveToSubject({
        fileId: bobFile.id, subjectId: aliceTarget.id, ownerUserId: alice.id,
      }));
    // The same call an AI-proposed action would make -- the source label
    // changes nothing about authorization.
    await refuses("an AI-sourced move is refused identically",
      () => fileOrganizeService.moveToSubject({
        fileId: bobFile.id, subjectId: aliceTarget.id, ownerUserId: alice.id,
        source: fileOrganizeService.PlacementSource.AI_AUTO,
      }));

    const filed = await fileOrganizeService.moveToSubject({
      fileId: aliceNote.id, subjectId: aliceTarget.id, ownerUserId: alice.id,
    });
    check(filed.moved === true, "Alice CAN file her own file into her own folder");
    check(filed.file.placement_source === "user",
      "the placement records who decided it", `got ${filed.file?.placement_source}`);

    // ---------------------------------------------------------------------
    console.log("\nThe duplicate guard fires before a document enters the tree");
    // Alice now has a second copy of the same bytes as aliceFile.
    const aliceDupe = await fileRepository.create({
      storageLocationId: aliceLoc.id, filenameOriginal: "facture-copie.txt", filenameCurrent: "facture-copie.txt",
      extension: "txt", mimeTypeDeclared: "text/plain", mimeTypeDetected: "text/plain",
      sizeBytes: shared.length, originalPath: "copies/facture-copie.txt", currentPath: "copies/facture-copie.txt",
      createdAtFs: new Date(), modifiedAtFs: new Date(), sha256Hash: "a".repeat(64),
    });

    const guarded = await fileOrganizeService.moveToSubject({
      fileId: aliceDupe.id, subjectId: aliceTarget.id, ownerUserId: alice.id,
    });
    check(guarded.moved === false && guarded.requiresConfirmation === true,
      "an exact duplicate is NOT silently filed -- the move stops and asks");
    check((guarded.findings || []).some((f) => f.kind === "exact"),
      "the finding is reported as an exact match, not a guess");
    check((guarded.findings || []).every((f) => Array.isArray(f.actions) && f.actions.length > 0),
      "each finding carries the actions the user can take");

    const confirmed = await fileOrganizeService.moveToSubject({
      fileId: aliceDupe.id, subjectId: aliceTarget.id, ownerUserId: alice.id, confirmDuplicate: true,
    });
    check(confirmed.moved === true, "confirming lets it through -- the guard advises, it does not trap");
    check((confirmed.findings || []).length > 0,
      "the findings come back even on success, so the UI can say it was filed anyway");

    // Once dismissed, the same pair stops being raised.
    await duplicateGuard.dismiss(aliceDupe.id, aliceFile.id, alice.id, { relationship: "distinct" });
    const afterDismiss = await duplicateGuard.check(aliceDupe.id, alice.id);
    check(!afterDismiss.findings.some((f) => f.existing.id === aliceFile.id),
      "a dismissed pair is not raised again");

    await refuses("Bob cannot dismiss a pair of Alice's files",
      () => duplicateGuard.dismiss(aliceDupe.id, aliceFile.id, bob.id));

    // ---------------------------------------------------------------------
    console.log("\nTriage is scoped, and resolving a file removes it from the queue");
    const aliceTriage = await triageService.list({}, alice.id);
    const bobTriage = await triageService.list({}, bob.id);
    check(!aliceTriage.some((r) => r.id === bobFile.id), "Alice's triage queue excludes Bob's files");
    check(!bobTriage.some((r) => r.id === aliceFile.id), "Bob's triage queue excludes Alice's files");

    const stalled = aliceTriage.find((r) => r.id === aliceFile.id);
    if (stalled) {
      check(Array.isArray(stalled.actions) && stalled.actions.includes("move"),
        "a triaged file offers the actions that resolve it");
      await triageService.keepOriginalName(aliceFile.id, alice.id);
      const after = await triageService.list({}, alice.id);
      check(!after.some((r) => r.id === aliceFile.id),
        "after 'keep the original name', the file LEAVES the queue and does not bounce back");
      const reloaded = await fileRepository.findById(aliceFile.id);
      check(reloaded.filename_current === "facture.txt",
        "and it kept its original filename", `got ${reloaded.filename_current}`);
      check(reloaded.pipeline_state !== "failed_terminal",
        "keeping a name is not a failure state", `got ${reloaded.pipeline_state}`);
    } else {
      console.log("      (no stalled row for the fixture file; skipped the resolve check)");
    }

    // ---------------------------------------------------------------------
    console.log("\nRetries are bounded");
    let terminal = null;
    for (let i = 0; i < 5; i += 1) {
      terminal = await pipelineState.markFailed(aliceNote.id, "extract_text", "fixture failure");
    }
    check(terminal.terminal === true,
      "a stage that keeps failing eventually becomes terminal instead of recycling forever");
    check(/gave up after/.test(terminal.reason),
      "and the reason says so in words", terminal.reason);

    // ---------------------------------------------------------------------
    console.log("\nThe dashboard counts only your own archive");
    const aliceDash = await dashboardService.summary(alice.id);
    const bobDash = await dashboardService.summary(bob.id);
    check(aliceDash.totals.files === 3,
      "Alice's dashboard counts her 3 files, not every account's",
      `got ${aliceDash.totals.files}`);
    check(bobDash.totals.files === 1,
      "Bob's dashboard counts his 1 file", `got ${bobDash.totals.files}`);
    check(aliceDash.locations.every((l) => l.name !== "Bob docs"),
      "Alice's per-location breakdown does not list Bob's folder");

    console.log("\nDuplicate groups do not span accounts");
    const aliceGroups = await duplicateGroupService.search({}, alice.id);
    const bobGroups = await duplicateGroupService.search({}, bob.id);
    const aliceGroupIds = new Set(aliceGroups.map((g) => g.id));
    check(!bobGroups.some((g) => aliceGroupIds.has(g.id)),
      "Alice and Bob share no duplicate group, though they hold identical bytes");
    if (aliceGroups.length) {
      await refuses("Bob cannot open Alice's duplicate group",
        () => duplicateGroupService.getById(aliceGroups[0].id, bob.id));
    }

    // ---------------------------------------------------------------------
    console.log("\nThe filter builder refuses to run unscoped");
    let threw = false;
    try { parseFileFilters({ ext: "pdf" }, undefined); } catch { threw = true; }
    check(threw, "parseFileFilters without an owner throws rather than matching every account");

  } finally {
    console.log("\nCleaning up");
    for (const user of [alice, bob]) {
      if (user?.id) {
        // Everything cascades from users(id): locations, files, subjects,
        // replicas, conversations, dismissals.
        await db.query("DELETE FROM users WHERE id = $1", [user.id]).catch((e) =>
          console.log(`      could not remove ${user.email}: ${e.message}`));
      }
    }
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    console.log("  fixtures removed");
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exitCode = failed === 0 ? 0 : 1;
  await db.pool.end();
}

main().catch(async (err) => {
  console.error("\nverify-ownership crashed:", err);
  process.exitCode = 1;
  await db.pool.end().catch(() => {});
});
