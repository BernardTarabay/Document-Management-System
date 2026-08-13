// Does the shortcut writer survive the characters real French and Arabic
// filenames actually contain?
//
// One malformed line kills the WHOLE batch: every shortcut is written by a
// single generated .ps1, so a parse error on file 1,858 means none of the
// several thousand shortcuts in that run get created. The failure surfaced
// on "Historique_de_la_Maison_d'accueil...".
//
//   node scripts/check-shortcut-quoting.js

const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { writeShortcuts } = require("../src/services/mirror/shortcutWriter");

// U+2019, the typographic apostrophe. Word inserts this automatically via
// autocorrect, so French titles pulled out of .doc metadata are full of it --
// and PowerShell accepts it as a STRING DELIMITER, exactly like a plain
// quote. Escaping only the ASCII one is therefore not enough.
const SMART_QUOTE = String.fromCharCode(0x2019);

const NAMES = [
  `Maison_d${SMART_QUOTE}accueil_smartquote.doc`, // the one that breaks the batch
  "Projet_d'accueil_du_Centre.docx",              // ASCII apostrophe
  "Historique_de_la_Maison_d'accueil_-_Kobayat.doc",
  "Conference_Carmelitain_de_Spiritualite.docx",  // accents
  "Rapport (final) [2024].pdf",                   // brackets and parentheses
  "compte-rendu_100%_definitif.doc",              // percent
  "note; avec, ponctuation.doc",                  // semicolon and comma
  "fichier `avec` backtick.doc",                  // PowerShell's escape char
  "prix_$500_budget.xlsx",                        // dollar (PS variable sigil)
  "تقرير_سنوي.doc",                                // Arabic
];

(async () => {
  const src = await fsp.mkdtemp(path.join(os.tmpdir(), "dms-quote-src-"));
  const out = await fsp.mkdtemp(path.join(os.tmpdir(), "dms-quote-out-"));
  const target = path.join(src, "real file.doc");
  await fsp.writeFile(target, "content");

  const entries = NAMES.map((n) => ({
    shortcutPath: path.join(out, `${n}.lnk`),
    targetPath: target,
    description: `shortcut for ${n}`,
  }));

  console.log(`Writing ${entries.length} shortcuts with awkward names...\n`);
  let result;
  try {
    result = await writeShortcuts(entries);
  } catch (err) {
    console.log("THE WHOLE BATCH FAILED -- one bad name takes every shortcut with it:");
    console.log(`  ${String(err.message).split("\n")[0]}`);
    console.log(`\nfixtures left at ${out} for inspection`);
    process.exitCode = 1;
    return;
  }

  const written = (await fsp.readdir(out)).filter((f) => f.endsWith(".lnk"));
  console.log(`written: ${result.written}, errors: ${result.errors.length}`);
  for (const e of result.errors) console.log(`  FAILED ${path.basename(e.shortcutPath)} -- ${e.message}`);

  for (const n of NAMES) {
    const ok = written.includes(`${n}.lnk`);
    console.log(`  ${ok ? "ok    " : "MISSING"} ${n}`);
  }

  const allThere = NAMES.every((n) => written.includes(`${n}.lnk`));
  console.log(`\n${allThere ? "ALL PASSED" : "SOME MISSING"}`);
  if (!allThere) process.exitCode = 1;

  await fsp.rm(src, { recursive: true, force: true });
  await fsp.rm(out, { recursive: true, force: true });
})();
