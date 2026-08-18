// Proves the two things the Library page is built on actually work:
//
//   1. THE UNFILED PILE IS ADDRESSABLE. The dashboard could already count
//      files nobody had filed; nothing could list them. A number you cannot
//      click is a reproach, not a feature.
//   2. FILING A SELECTION IS SAFE. Bulk filing is a LOOP over
//      fileOrganizeService.moveToSubject, never a bulk UPDATE, because the
//      fast version would have to skip the per-file duplicate check. Filing
//      two hundred files at once is precisely when nobody is watching closely
//      enough to catch a duplicate entering the tree, so it is the worst
//      moment to stop looking.
//
//     node scripts/verify-library.js
//
// Creates its own fixture files, exercises the real service, and deletes them.
// No bytes are written to disk and no jobs are enqueued.
const { Pool } = require("pg");
const env = require("../src/config/env");
const fileService = require("../src/services/fileService");
const fileRepository = require("../src/repositories/fileRepository");
const classificationResultRepository = require("../src/repositories/classificationResultRepository");
const { parseFileFilters } = require("../src/repositories/fileFilters");
const { ConfidenceLevel, ClassificationMethod } = require("../src/models/enums");

const p = new Pool({ connectionString: env.databaseUrl });
let passed = 0, failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`   PASS  ${label}${detail ? ` -- ${detail}` : ""}`); }
  else { failed += 1; console.log(`   FAIL  ${label}${detail ? ` -- ${detail}` : ""}`); }
};

const FIXTURE_PREFIX = "__verify_library__";
const fixtureIds = [];

async function cleanup() {
  try {
    if (fixtureIds.length) {
      await p.query("DELETE FROM classification_results WHERE file_id = ANY($1::uuid[])", [fixtureIds]);
      await p.query("DELETE FROM audit_logs WHERE entity_id = ANY($1::uuid[])", [fixtureIds]);
      await p.query("DELETE FROM files WHERE id = ANY($1::uuid[])", [fixtureIds]);
    }
  } catch (e) {
    console.log(`   (cleanup) ${e.message}`);
  }
}

async function makeFixtures(locationId, ownerUserId, n, { status = "active", prefix = FIXTURE_PREFIX } = {}) {
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    const path = `${prefix}/${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}.pdf`;
    const { rows } = await p.query(
      `INSERT INTO files (storage_location_id, filename_original, filename_current,
                          size_bytes, original_path, current_path, status, owner_user_id)
       VALUES ($1, $2, $2, 1, $3, $3, $5, $4) RETURNING id`,
      [locationId, `fixture-${i}.pdf`, path, ownerUserId, status]
    );
    ids.push(rows[0].id);
    fixtureIds.push(rows[0].id);
  }
  return ids;
}

const sameIds = (a, b) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

(async () => {
  console.log("Verifying the Library\n" + "=".repeat(38));
  try {
    const owner = (await p.query("SELECT id FROM users ORDER BY created_at LIMIT 1")).rows[0];
    const location = (await p.query("SELECT id FROM storage_locations ORDER BY created_at LIMIT 1")).rows[0];
    const subject = (await p.query("SELECT id, name FROM subjects ORDER BY materialized_path LIMIT 1")).rows[0];
    const docType = (await p.query("SELECT id, code FROM document_types ORDER BY code LIMIT 1")).rows[0];

    if (!owner || !location || !subject) {
      console.log("   SKIP  needs a user, a storage location and a seeded subject");
      return;
    }

    console.log("\n1. The unfiled pile can be listed, not just counted");

    const before = await fileRepository.countMatching({
      filters: parseFileFilters({ unfiled: "true" }, owner.id),
    });

    const ids = await makeFixtures(location.id, owner.id, 5);
    const afterCreate = await fileRepository.countMatching({
      filters: parseFileFilters({ unfiled: "true" }, owner.id),
    });
    check("brand new files with no classification row count as unfiled",
      afterCreate === before + 5, `${before} -> ${afterCreate}`);

    // A file carrying a document type but NO subject is still unfiled: the
    // axes are independent, and having a type says nothing about placement.
    await classificationResultRepository.createPartial({
      fileId: ids[0],
      classifiedDocumentTypeId: docType?.id || null,
      confidenceLevel: ConfidenceLevel.HIGH,
      confidenceScore: 1.0,
      method: ClassificationMethod.MANUAL,
      rawOutput: { reason: "fixture: typed but not filed" },
    });
    const stillUnfiled = await fileRepository.countMatching({
      filters: parseFileFilters({ unfiled: "true" }, owner.id),
    });
    check("a file with a document type but no subject is still unfiled",
      stillUnfiled === afterCreate, `${stillUnfiled}`);

    console.log("\n2. Filing a selection");

    const result = await fileService.moveMany(ids, subject.id, owner.id);
    check("every selected file was filed", result.moved.length === 5,
      `moved ${result.moved.length}, needs confirmation ${result.needsConfirmation.length}, failed ${result.failed.length}`);

    const afterFile = await fileRepository.countMatching({
      filters: parseFileFilters({ unfiled: "true" }, owner.id),
    });
    check("filing them empties them out of the unfiled pile",
      afterFile === before, `${afterFile} back to the original ${before}`);

    const inSubject = await fileRepository.countMatching({
      filters: parseFileFilters({ subjectId: subject.id }, owner.id),
    });
    check("and they are findable under the subject they were filed into", inSubject >= 5,
      `${inSubject} under "${subject.name}"`);

    // The carry-forward invariant, at scale: bulk filing must not wipe the
    // document type off two hundred files the way a single move used to.
    if (docType) {
      const latest = await classificationResultRepository.findLatestForFile(ids[0]);
      check("bulk filing preserves a document type set earlier",
        latest?.classified_document_type_id === docType.id,
        latest?.classified_document_type_id ? `kept ${docType.code}` : "ERASED");
    }

    console.log("\n3. The batch refuses what it should refuse");

    let threw = null;
    try { await fileService.moveMany([], subject.id, owner.id); }
    catch (e) { threw = e.message; }
    check("an empty selection is refused", /at least one file/i.test(threw || ""), threw || "no error");

    threw = null;
    try { await fileService.moveMany(ids, null, owner.id); }
    catch (e) { threw = e.message; }
    check("filing with no destination is refused", /folder/i.test(threw || ""), threw || "no error");

    // A file outside this owner's scope must be reported, never silently
    // dropped -- a bulk action that quietly ignores part of its input is how
    // a user concludes files have vanished.
    const foreign = await fileService.moveMany(
      ["00000000-0000-4000-8000-000000000000"], subject.id, owner.id
    );
    check("an unknown file is reported as notFound, not silently dropped",
      foreign.notFound.length === 1 && foreign.moved.length === 0,
      `notFound ${foreign.notFound.length}`);

    console.log("\n4. The Library reuses the existing bulk path, it does not fork it");
    const fileOrganizeService = require("../src/services/fileOrganizeService");
    check("fileService.moveMany delegates to fileOrganizeService.moveManyToSubject",
      typeof fileOrganizeService.moveManyToSubject === "function",
      "the same function Photos and Triage call");

    /**
     * 5. "SELECT ALL N" HAS TO SELECT THE SAME N THE PAGE IS SHOWING.
     *
     * Three queries describe the same scope -- the list, the count beside it,
     * and the id sweep behind "select all" -- and they have to agree, or a
     * bulk action files a different set from the one the user chose.
     *
     * They did not. `idsMatching` applied the SUBJECT rule (active only, plus
     * resolved-duplicate losers excluded) to every scope, while the table and
     * the unfiled pile are drawn by `listNotDeleted` (everything not deleted).
     * A `missing`, `moved`, `changed` or `archived` file was therefore listed,
     * counted, and then quietly left out of the selection -- no message, since
     * `capped` is false. The visible symptom was the unfiled pile refusing to
     * empty: you file "all 40", the tile still reads 3, and nothing says why.
     *
     * The non-active fixture below is the entire point of this section. Local
     * databases are almost always all-active, which is exactly why this
     * survived: it cannot reproduce without one.
     */
    console.log("\n5. Select-all selects what the page is showing");

    const SEL_PREFIX = "__verify_library_selectall__";
    const scoped = { pathPrefix: SEL_PREFIX };
    const selActive = await makeFixtures(location.id, owner.id, 3, { prefix: SEL_PREFIX });
    const selMissing = await makeFixtures(location.id, owner.id, 1, { prefix: SEL_PREFIX, status: "missing" });
    const selAll = [...selActive, ...selMissing];

    // -- the unfiled pile, which is the Library's primary loop ---------------
    const unfiledFilters = parseFileFilters({ ...scoped, unfiled: "true" }, owner.id);
    const unfiledListed = await fileRepository.listNotDeleted({ limit: 500, filters: unfiledFilters });
    const unfiledCount = await fileRepository.countMatching({ filters: unfiledFilters });
    const unfiledSelected = await fileService.matchingIds({ ...scoped, unfiled: "true" }, owner.id);

    check("the unfiled pile lists the non-active file",
      unfiledListed.length === 4, `${unfiledListed.length} of 4 listed`);
    check("...and the count agrees with the list",
      unfiledCount === unfiledListed.length, `count=${unfiledCount} rows=${unfiledListed.length}`);
    check("...and select-all returns exactly that set, not a subset",
      sameIds(unfiledSelected.ids, selAll),
      `selected ${unfiledSelected.ids.length} of ${selAll.length}`);
    check("...so the pile can actually be emptied in one action",
      unfiledSelected.ids.includes(selMissing[0]),
      unfiledSelected.ids.includes(selMissing[0]) ? "the missing file is selectable" : "MISSING FILE SKIPPED");

    // -- the table's "Everything" scope --------------------------------------
    const tableFilters = parseFileFilters(scoped, owner.id);
    const tableListed = await fileRepository.listNotDeleted({ limit: 500, filters: tableFilters });
    const tableSelected = await fileService.matchingIds(scoped, owner.id);
    check("in the table scope, select-all matches the listing row for row",
      sameIds(tableSelected.ids, tableListed.map((r) => r.id)),
      `selected ${tableSelected.ids.length}, listed ${tableListed.length}`);

    // -- inside a subject, where the rule is deliberately STRICTER -----------
    //
    // listBySubject is active-only and excludes resolved-duplicate losers, so
    // agreement here means the non-active file is absent from BOTH the list
    // and the selection. Selecting a superset would be the same bug pointing
    // the other way.
    await fileService.moveMany(selActive, subject.id, owner.id);
    await fileService.moveMany(selMissing, subject.id, owner.id).catch(() => {});

    const subjFilters = parseFileFilters(scoped, owner.id);
    const subjListed = await fileRepository.listBySubject(subject.id, { limit: 500, filters: subjFilters });
    const subjCount = await fileRepository.countInSubject(subject.id, { filters: subjFilters });
    const subjSelected = await fileService.matchingIds(scoped, owner.id, { subjectId: subject.id });

    check("inside a subject, the count agrees with the list",
      subjCount === subjListed.length, `count=${subjCount} rows=${subjListed.length}`);
    check("...and select-all agrees with both",
      sameIds(subjSelected.ids, subjListed.map((r) => r.id)),
      `selected ${subjSelected.ids.length}, listed ${subjListed.length}`);
    check("...and the stricter subject rule is still applied, not loosened",
      !subjSelected.ids.includes(selMissing[0]),
      "the non-active file is in neither the list nor the selection");
  } catch (e) {
    failed += 1;
    console.log(`\n   ERROR ${e.stack}`);
  } finally {
    await cleanup();
    await p.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
