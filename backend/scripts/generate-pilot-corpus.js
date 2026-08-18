// Builds a synthetic-but-realistic corpus so the pipeline can be measured at
// thousands of files without waiting for the client to hand over his drive.
//
// DESIGN NOTE -- why this clones real files instead of only inventing them:
// a corpus of machine-written prose measures the machine, not the product.
// Real .docx and .pdf files carry the things that actually break extractors:
// embedded fonts, images, tables, revision marks, producer quirks. So the
// generator takes whatever real documents it can find in a seed folder and
// multiplies them, mutating a copy's text where the format allows it, and
// only falls back to hand-built files to cover shapes the seed folder is
// missing.
//
// What it deliberately reproduces from a real messy drive:
//   - exact byte duplicates (the same attachment saved in four places)
//   - near-duplicate versions (v1 / v2 / FINAL / FINAL_v2)
//   - accented and right-to-left filenames
//   - deep, uneven folder nesting
//   - files no extractor supports (.accdb, .fmp12, images)
//   - a handful of large files, to prove the read path doesn't fall over
//
// Usage:
//   node scripts/generate-pilot-corpus.js --count 3000
//   node scripts/generate-pilot-corpus.js --count 500 --out "D:\\somewhere"
//   node scripts/generate-pilot-corpus.js --clean

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const AdmZip = require("adm-zip");
const ExcelJS = require("exceljs");

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const TARGET = parseInt(argOf("count", "3000"), 10);
// LOCALAPPDATA, not Desktop or Documents: both of those are OneDrive-redirected
// on this machine, and uploading a few hundred MB of throwaway test files to
// the cloud is the exact opposite of what this project is for.
const OUT = argOf("out", path.join(process.env.LOCALAPPDATA, "AtlasPilotCorpus"));
const SEED = argOf("seed", path.join(process.env.USERPROFILE, "OneDrive", "Desktop", "test"));
const CLEAN = args.includes("--clean");

/**
 * --subjects N: build a large FOLDER TREE in the database, and nothing else.
 *
 * A separate job from generating files, sharing this script because it answers
 * the same question -- "does this hold up at the size the client actually
 * has?" -- for the other half of the Library. The file generator above
 * measures the pipeline; this measures the folder pane, which is what falls
 * over first: a recursive tree mounted a React node per visible folder, so the
 * page became unusable long before the pipeline did.
 *
 *   node scripts/generate-pilot-corpus.js --subjects 55000
 *   node scripts/generate-pilot-corpus.js --subjects 0        (removes them)
 *
 * Everything it creates is named with a prefix and removed by passing 0, so it
 * cannot be confused with, or delete, folders a person made.
 */
const SUBJECTS = args.includes("--subjects") ? parseInt(argOf("subjects", "55000"), 10) : null;
const SUBJECT_DEPTH = parseInt(argOf("subject-depth", "5"), 10);
const SUBJECT_PREFIX = "[pilot]";

// Deterministic PRNG: a pilot you can re-run and get the same corpus from is
// worth more than a novel one every time, because then a timing difference
// means the code changed rather than the input did.
let seedState = 0x2f6e2b1;
function rnd() {
  seedState ^= seedState << 13; seedState >>>= 0;
  seedState ^= seedState >> 17;
  seedState ^= seedState << 5;  seedState >>>= 0;
  return seedState / 0x100000000;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const between = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

// --- the shape of a real company drive ------------------------------------

const FOLDERS = [
  "Administrative/Correspondence",
  "Administrative/Government/Permits",
  "Administrative/Government/Filings/2023",
  "Administrative/Government/Filings/2024",
  "Finance/Invoices/2023",
  "Finance/Invoices/2024",
  "Finance/Invoices/2025",
  "Finance/Budgets",
  "Finance/Taxes/2023",
  "Finance/Taxes/2024",
  "Legal/Contracts/Suppliers",
  "Legal/Contracts/Clients",
  "Legal/Legal/Disputes",
  "Academic/Courses/Semester 1",
  "Academic/Courses/Semester 2",
  "Academic/Research/Drafts",
  "Academic/Exams",
  "Personal/Certificates",
  "Personal/Applications",
  "Reference/Manuals",
  "Reference/Books",
  "Reference/Guides",
  "Projects/Atlas/Specs",
  "Projects/Atlas/Meeting Notes",
  "Projects/Marina/Site Photos",
  "Old Stuff/to sort",
  "Old Stuff/to sort/misc",
  "Desktop dump",
  "Scans",
  "Scans/2024/March",
];

const SUBJECT_WORDS = ["Administrative", "Finance", "Legal", "Academic", "Personal", "Reference"];
const TYPE_WORDS = [
  "Invoice", "Contract", "Report", "Annual Budget", "Tax Return", "Certificate",
  "Presentation", "Manual", "Course Material", "Exam", "Correspondence", "Book",
];
const TOPICS = [
  "Marina Development", "Q3 Performance", "Supplier Terms", "Payroll Review",
  "Board Meeting", "Site Inspection", "Insurance Renewal", "Lease Agreement",
  "Vendor Onboarding", "Annual Audit", "Staff Handbook", "Capital Expenditure",
];
// The corpus has to be multilingual or the multilingual search index is
// never actually exercised -- migration 020 unions four text-search configs
// and until now only French had a real test case.
const FRENCH = ["Rapport Annuel", "Facture Fournisseur", "Contrat de Bail", "Budget Prévisionnel", "Procès-Verbal"];
const ARABIC = ["تقرير سنوي", "فاتورة مورد", "عقد إيجار", "محضر اجتماع"];

const MESSY_SUFFIXES = [
  "", "", "", " (1)", " - Copy", " FINAL", " FINAL_v2", " v1", " v2", " v3",
  " draft", " (conformed)", " - signed", " REVISED", "_old", " (2) - Copy",
];

function messyName(base, ext) {
  const date = rnd() < 0.35 ? ` ${between(2019, 2025)}-${String(between(1, 12)).padStart(2, "0")}` : "";
  return `${base}${date}${pick(MESSY_SUFFIXES)}.${ext}`;
}

function bodyText(title) {
  // Long enough to be worth extracting and to give the shingler something to
  // work with -- similarity over a two-sentence document is meaningless.
  const paras = [];
  const n = between(4, 14);
  for (let i = 0; i < n; i += 1) {
    paras.push(
      `${pick(TYPE_WORDS)} concerning ${pick(TOPICS)}. ` +
      `Prepared for the ${pick(SUBJECT_WORDS)} department on ${between(1, 28)}/${between(1, 12)}/${between(2019, 2025)}. ` +
      `Reference number ${between(10000, 99999)}-${between(100, 999)}. ` +
      `The parties agree that the terms set out in section ${between(1, 12)} shall apply for a period of ${between(1, 60)} months, ` +
      `subject to review by the ${pick(SUBJECT_WORDS)} committee. Total value stated as ${between(1, 900)},${between(100, 999)} EUR.`
    );
  }
  return `${title}\n\n${paras.join("\n\n")}`;
}

// --- hand-built file formats ----------------------------------------------

const xmlEscape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function coreXml(title) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/">
<dc:title>${xmlEscape(title)}</dc:title><dc:creator>M. Abdou</dc:creator><cp:lastModifiedBy>M. Abdou</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">2024-01-01T00:00:00Z</dcterms:created>
</cp:coreProperties>`;
}

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

function buildDocx(title, text) {
  const zip = new AdmZip();
  const paras = text.split("\n\n").map((p) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(p)}</w:t></w:r></w:p>`).join("");
  zip.addFile("[Content_Types].xml", Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`));
  zip.addFile("_rels/.rels", Buffer.from(RELS));
  zip.addFile("docProps/core.xml", Buffer.from(coreXml(title)));
  zip.addFile("word/document.xml", Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras}</w:body></w:document>`));
  return zip.toBuffer();
}

function buildPptx(title, text) {
  const zip = new AdmZip();
  const chunks = text.split("\n\n");
  const types = [`<Default Extension="xml" ContentType="application/xml"/>`,
                 `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`,
                 `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>`];
  // detectSignature() identifies a pptx by this exact part being present --
  // a deck of slides with no presentation.xml is just "unknown-zip" and gets
  // dropped before any extractor sees it.
  zip.addFile("ppt/presentation.xml", Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst>${chunks.map((_, i) => `<p:sldId id="${256 + i}"/>`).join("")}</p:sldIdLst></p:presentation>`));
  chunks.forEach((chunk, i) => {
    zip.addFile(`ppt/slides/slide${i + 1}.xml`, Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${xmlEscape(chunk)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`));
    types.push(`<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`);
  });
  zip.addFile("[Content_Types].xml", Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${types.join("")}</Types>`));
  zip.addFile("_rels/.rels", Buffer.from(RELS.replace("word/document.xml", "ppt/presentation.xml")));
  zip.addFile("docProps/core.xml", Buffer.from(coreXml(title)));
  return zip.toBuffer();
}

// Minimal but genuinely well-formed PDF: object offsets are tracked as the
// body is built, because a wrong xref table is exactly the sort of thing
// pdfjs tolerates in one version and rejects in the next.
function buildPdf(title, text) {
  const lines = text.split("\n\n").slice(0, 30);
  const content =
    "BT /F1 11 Tf 54 740 Td 14 TL\n" +
    lines.map((l) => `(${l.replace(/[\\()]/g, "\\$&").slice(0, 110)}) Tj T*`).join("\n") +
    "\nET";

  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>",
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
    `<</Length ${Buffer.byteLength(content)}>>\nstream\n${content}\nendstream`,
    `<</Title (${title.replace(/[\\()]/g, "\\$&")})>>`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefAt = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R/Info 6 0 R>>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

// Written by exceljs rather than hand-assembled. A first attempt built the
// zip parts directly and produced files that pass signature detection but
// that exceljs opens as zero worksheets -- silently extracting nothing.
// Since exceljs is also what the extractor reads with, generating through it
// is the only way to be sure the fixture isn't testing a fiction.
async function buildXlsx(title, text) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "M. Abdou";
  wb.title = title;
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(["Title", "Reference", "Amount", "Department"]);
  for (const line of text.split("\n\n")) {
    ws.addRow([line.slice(0, 80), `REF-${between(10000, 99999)}`, between(100, 99999), pick(SUBJECT_WORDS)]);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// Rewrites the text inside an already-real .docx so the copy is a genuine
// near-duplicate: same styles, same structure, a few words different --
// which is precisely the case Jaccard similarity has to get right and exact
// hashing has to miss.
function mutateDocx(buffer, note) {
  try {
    const zip = new AdmZip(buffer);
    const entry = zip.getEntry("word/document.xml");
    if (!entry) return null;
    let xml = zip.readAsText(entry);
    xml = xml.replace(/<w:body>/, `<w:body><w:p><w:r><w:t xml:space="preserve">${xmlEscape(note)}</w:t></w:r></w:p>`);
    zip.updateFile(entry, Buffer.from(xml));
    return zip.toBuffer();
  } catch {
    return null;
  }
}

// --- generation ------------------------------------------------------------

async function loadSeeds() {
  if (!fs.existsSync(SEED)) return [];
  const out = [];
  const walk = async (dir) => {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else {
        const stat = await fsp.stat(full);
        // Skip the huge ones: cloning a 20 MB PDF 200 times writes 4 GB and
        // measures the disk, not the pipeline.
        if (stat.size < 3 * 1024 * 1024) out.push({ name: e.name, ext: path.extname(e.name).slice(1).toLowerCase(), buffer: await fsp.readFile(full) });
      }
    }
  };
  await walk(SEED);
  return out;
}

/**
 * Folder names a real archive contains: accented French, Arabic, and the kind
 * of thing people actually invent. A vocabulary of unique ASCII words would
 * make the pane's search look faster than it is, since the cost is in how many
 * names a term matches.
 */
const FOLDER_WORDS = [
  "Factures", "Contrats", "Comptabilité", "Rapports", "Procès-verbaux",
  "مراسلات", "تقارير", "فواتير",
  "Tables", "Boat stuff", "Scans", "Inbox", "Divers", "Archive", "Photos",
  "2019", "2020 - Q3 - reconciled", "Old NAS", "À classer",
];

async function generateSubjects(count) {
  // Required lazily: the file generator above must keep working on a machine
  // with no database configured.
  require("dotenv").config();
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const owner = (await pool.query("SELECT id FROM users ORDER BY created_at LIMIT 1")).rows[0];
    if (!owner) { console.error("No user to own the folders. Seed the database first."); process.exit(1); }

    const existing = await pool.query(
      "SELECT count(*)::int AS n FROM subjects WHERE owner_user_id=$1 AND name LIKE $2",
      [owner.id, `${SUBJECT_PREFIX}%`]
    );
    if (existing.rows[0].n) {
      process.stdout.write(`Removing ${existing.rows[0].n.toLocaleString()} existing pilot folders... `);
      // Children first: the tree has a self-referencing FK.
      await pool.query(
        `DELETE FROM subjects WHERE owner_user_id=$1 AND name LIKE $2`,
        [owner.id, `${SUBJECT_PREFIX}%`]
      );
      console.log("done");
    }
    if (!count) return;

    const started = Date.now();
    // Inserted level by level so every parent exists before its children, and
    // in batches because 55,000 single-row INSERTs is minutes of round trips.
    const ROOTS = Math.max(8, Math.round(count / 2500));
    let created = 0;
    let previousLevel = [];

    for (let depth = 0; depth < SUBJECT_DEPTH && created < count; depth += 1) {
      const remaining = count - created;
      const wanted = depth === 0
        ? Math.min(ROOTS, remaining)
        : Math.min(remaining, Math.ceil(count / SUBJECT_DEPTH) + depth * 200);

      const values = [];
      const params = [];
      for (let i = 0; i < wanted; i += 1) {
        const parent = depth === 0 ? null : previousLevel[i % previousLevel.length];
        const name = `${SUBJECT_PREFIX} ${FOLDER_WORDS[(created + i) % FOLDER_WORDS.length]} ${created + i}`;
        const slug = `pilot-${created + i}`;
        const base = params.length;
        params.push(owner.id, parent, name, slug);
        values.push(`($${base + 1}, $${base + 2}, 'subject', $${base + 3}, $${base + 4}, '')`);
      }
      const { rows } = await pool.query(
        `INSERT INTO subjects (owner_user_id, parent_id, level, name, slug, materialized_path)
         VALUES ${values.join(",")} RETURNING id`,
        params
      );
      previousLevel = rows.map((r) => r.id);
      created += rows.length;
      process.stdout.write(`  depth ${depth}: ${rows.length.toLocaleString()} folders (${created.toLocaleString()} total)
`);
    }

    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`
Created ${created.toLocaleString()} folders in ${secs}s.`);
    console.log("Open the Library to profile the folder pane against them.");
    console.log(`Remove them with: node scripts/generate-pilot-corpus.js --subjects 0`);
  } finally {
    await pool.end();
  }
}

(async () => {
  if (SUBJECTS !== null) { await generateSubjects(SUBJECTS); return; }

  if (CLEAN) {
    if (fs.existsSync(OUT)) { await fsp.rm(OUT, { recursive: true, force: true }); console.log(`Removed ${OUT}`); }
    else console.log(`Nothing at ${OUT}`);
    return;
  }

  const started = Date.now();
  const seeds = await loadSeeds();
  console.log(`Seed documents found: ${seeds.length}${seeds.length ? ` (${[...new Set(seeds.map((s) => s.ext))].join(", ")})` : " -- generating everything synthetically"}`);

  for (const f of FOLDERS) await fsp.mkdir(path.join(OUT, f), { recursive: true });

  const stats = { total: 0, bytes: 0, byExt: {}, exactDupes: 0, nearDupes: 0, fromSeed: 0, synthetic: 0, large: 0 };
  const written = [];

  const record = async (dir, name, buffer, kind) => {
    const full = path.join(OUT, dir, name);
    await fsp.writeFile(full, buffer);
    stats.total += 1;
    stats.bytes += buffer.length;
    const ext = path.extname(name).slice(1).toLowerCase() || "(none)";
    stats.byExt[ext] = (stats.byExt[ext] || 0) + 1;
    if (kind) stats[kind] += 1;
    written.push({ dir, name, buffer });
  };

  while (stats.total < TARGET) {
    const dir = pick(FOLDERS);
    const roll = rnd();

    // 8% -- exact byte duplicates of something already written.
    if (roll < 0.08 && written.length > 20) {
      const src = written[Math.floor(rnd() * written.length)];
      await record(pick(FOLDERS), messyName(path.parse(src.name).name, path.extname(src.name).slice(1)), src.buffer, "exactDupes");
      continue;
    }

    // 10% -- near-duplicate: a real docx with one paragraph changed.
    if (roll < 0.18 && seeds.some((s) => s.ext === "docx")) {
      const src = pick(seeds.filter((s) => s.ext === "docx"));
      const mutated = mutateDocx(src.buffer, `Revision note ${between(1, 99)}: amended ${pick(TOPICS)} clause.`);
      if (mutated) {
        await record(dir, messyName(path.parse(src.name).name, "docx"), mutated, "nearDupes");
        continue;
      }
    }

    // 22% -- straight clones of real seed documents under new messy names.
    if (roll < 0.40 && seeds.length) {
      const src = pick(seeds);
      await record(dir, messyName(path.parse(src.name).name, src.ext), src.buffer, "fromSeed");
      continue;
    }

    // The rest is synthetic, weighted to look like an office drive.
    const title = rnd() < 0.10 ? pick(FRENCH) : rnd() < 0.06 ? pick(ARABIC) : `${pick(TYPE_WORDS)} - ${pick(TOPICS)}`;
    const text = bodyText(title);
    const r = rnd();
    let buffer, ext;
    if (r < 0.34)      { buffer = buildDocx(title, text); ext = "docx"; }
    else if (r < 0.54) { buffer = await buildXlsx(title, text); ext = "xlsx"; }
    else if (r < 0.64) { buffer = buildPptx(title, text); ext = "pptx"; }
    else if (r < 0.80) { buffer = buildPdf(title, text); ext = "pdf"; }
    else if (r < 0.88) { buffer = Buffer.from(text, "utf8"); ext = "txt"; }
    else if (r < 0.93) { buffer = Buffer.from(`title,ref,amount\n${text.split("\n\n").map((l, i) => `"${l.slice(0, 40)}",${i},${between(100, 9999)}`).join("\n")}`, "utf8"); ext = "csv"; }
    else if (r < 0.97) { buffer = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(between(20000, 400000), 0x42)]); ext = "png"; }
    else               { buffer = Buffer.alloc(between(50000, 800000), 0x00); ext = pick(["accdb", "fmp12", "dat"]); }

    await record(dir, messyName(title.replace(/[\\/:*?"<>|]/g, "-"), ext), buffer, "synthetic");
  }

  // A few deliberately large files. extractTextProcessor buffers the whole
  // file into memory, so if that is going to hurt, it should hurt here in a
  // pilot rather than on the client's machine.
  for (const mb of [12, 28, 45]) {
    const big = buildDocx(`Large Scanned Report ${mb}MB`, bodyText("Large Scanned Report").repeat(Math.ceil(mb * 900)));
    await record("Scans", `Large Scanned Report ${mb}MB.docx`, big, "large");
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\nWrote ${stats.total} files (${(stats.bytes / 1024 / 1024).toFixed(1)} MB) to ${OUT} in ${secs}s`);
  console.log(`  from real seed docs   ${stats.fromSeed}`);
  console.log(`  synthetic             ${stats.synthetic}`);
  console.log(`  exact byte duplicates ${stats.exactDupes}`);
  console.log(`  near-duplicates       ${stats.nearDupes}`);
  console.log(`  oversized             ${stats.large}`);
  console.log(`  by extension          ${Object.entries(stats.byExt).sort((a, b) => b[1] - a[1]).map(([e, n]) => `${e}:${n}`).join("  ")}`);
})().catch((e) => { console.error(e); process.exit(1); });
