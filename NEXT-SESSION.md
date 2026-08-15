# Where things stand

Written at the end of a long session so the next one can start without
re-deriving anything. Delete it once it's stale.

## How to run the app

The dev server (`npm run dev` in `backend/`, plus Vite) is what's normally
running — UI on **http://localhost:5173**, API on **:5000**.

`scripts\restart-atlas.bat` is for PRODUCTION mode only. It now refuses to run
while a dev server is up, because starting both makes two APIs fight over port
5000 and two workers double the Gemini request rate (the limiter is
per-process). Use `restart-atlas.bat force` only if you genuinely want to
stop the dev server and switch.

**The worker is not managed by nodemon.** `npm run dev` only watches the API,
so after changing anything the worker runs (extraction, naming, classification)
you must restart `node src/workers/runner.js` by hand. This bit us: the worker
spent part of a session running a stale decoder and re-corrupting metadata.

## Outstanding work, in the user's priority order

1. ~~**Triage folder** (task #42)~~ — **DONE.** `/triage` (page, `GET /api/triage`,
   `GET /api/triage/summary`, `POST /api/triage/:id/retry`). Six reasons, most
   serious first: `missing`, `job_failed`, `extraction_failed`, `stalled`,
   `needs_ocr`, `unreadable`. A file appears once, under its worst reason.
   Files with a queued/running job are excluded on purpose (they aren't stuck)
   and counted separately as `inFlight`. Rename/move are `PATCH /files/:id`,
   not new endpoints. `node scripts/verify-triage.js` covers it.
2. ~~**Inspect/compare files in the Duplicates tab** (task #45)~~ — **DONE.**
   `GET /duplicate-groups/:id` members now carry size, location (+read-only),
   subject, text quality/length, placeholder and `is_canonical`, so an exact
   group — where the bytes are identical and the names usually are too — is
   decidable. Per copy: preview, full detail, rename. Tick any two and
   "Compare these two" opens the existing compare modal pre-seeded and runs it
   straight away; the group's other copies are one-click picks in the picker.
   `node scripts/verify-duplicate-compare.js` covers it.
3. ~~**Search filters** (task #44)~~ — **DONE.** `ext`, `dateFrom`/`dateTo`,
   `subjectId` (descendant-inclusive), `storageLocationId`, `pathPrefix` — one
   builder (`repositories/fileFilters.js`) spliced into the plain listing, the
   full-text search, the in-subject list and the tree counts, so all four
   agree. Filters work WITHOUT a search term, which is the point. Plus
   `GET /files/count` and `GET /files/filter-options`. Bad input is a 400, never
   a silently-dropped parameter. `node scripts/verify-search-filters.js`.
4. ~~**Show date/location in the listings** (task #43)~~ — **DONE.** Shared
   `components/DocumentDate.jsx` renders a date read out of the document
   plainly and an inferred (`filesystem`) one muted with a `~`, so a guess
   never looks like a fact. Added to the Files table (replacing "Imported",
   which sorted at random on a backup-assembled archive), the Subjects file
   panel, Duplicates members and Triage. Location travels with it.

All four listed tasks are now done. Open work below.

Landed since, not from the numbered list:

- **Known-content skip.** Adding a second, overlapping storage location used
  to push every file through the whole pipeline again. Now `hashProcessor`
  looks for a byte-identical twin that has already been processed and adopts
  its text, metadata, date, classification and AI enrichment instead of
  re-running extract_metadata / extract_text / classify / generate_names.
  Only genuinely new files do real work. Duplicate detection still runs (the
  group is the honest record); the copy keeps its own filename and produces
  no rename proposal. `services/knownContentService.js`,
  `node scripts/verify-known-content-skip.js`.
- **Reset actually resets.** `db:reset-data` now drains the BullMQ queues
  (a real reset left 15,759 jobs in Redis grinding against truncated tables),
  sweeps rows written by jobs that were mid-flight, and removes the mirror's
  shortcuts (only `.lnk`/`.url`, never anything else a user put there).
Also open:

- **Task #46 — 93 mirror shortcuts fail on Windows MAX_PATH.** WScript.Shell
  says "Value does not fall within the expected range" for paths over 260
  chars. Cap canonical-name length or use `\\?\` extended paths.
- **Task #36 — OCR is NOT implemented.** Only the detection half is: unreadable
  files are flagged `needs_ocr` and keep their original names. Real OCR needs a
  new dependency (tesseract.js WASM, or Windows.Media.Ocr) plus a PDF page
  rasteriser. That's an install decision for the user to make.
- **Re-run `node scripts/repair-mojibake-titles.js --apply`** once the metadata
  backfill drains, since the worker ran the old decoder for part of a session.

## Things that will bite you if you don't know them

- **"Location"** = storage location + folder path, not EXIF GPS. This was
  still flagged "confirm with the user" and was BUILT that way anyway, on the
  note's own reasoning: GPS is on phone photos and essentially never on
  scanned church documents, so a GPS filter would match nothing. Say so if the
  user meant GPS — it would be a second filter (`storageLocationId` /
  `pathPrefix` are the shipped ones), not a rewrite of this one.
- **The database runs in `Asia/Jerusalem`, and `document_date` is
  `timestamptz`.** A date-only source (EXIF, a PDF header) normalises to LOCAL
  midnight, i.e. 22:00 the previous day in UTC. So any date comparison has to
  go through `::date`, not a pinned UTC instant, or it silently drops the
  whole first day of a range — 232 real files sit in that window. Already fixed
  in `fileFilters.js`; the trap is live for anything else that filters or
  buckets by date.
- **The corpus is French and Arabic.** Any text handling has to survive both.
  Several bugs came from exactly this: OLE titles decoded as latin1 instead of
  the declared code page, PowerShell treating U+2019 as a string delimiter,
  WScript.Shell refusing non-ANSI paths, NUL bytes killing Postgres inserts.
- **Never let the AI name a file from unreadable text.** `textQuality.js`
  decides; `generateNamesProcessor` keeps the original filename when it says no.
- **Boilerplate titles.** 403 files share the organisation's name as their
  embedded title. A title shared by 5+ files is ignored for naming.
- **Originals are never renamed, moved or deleted.** Canonical names live in
  the database; the shortcut mirror is disposable and regenerable.
- **A rejected rename is a FINISHED state, not a problem.** Rejecting says
  "the name this file already has is the right one". The file is still filed
  under its subject and still appears in the mirror under that original name.
  The Files page labels it "original name kept" — don't reintroduce anything
  that sends the user back to re-decide it.
- **`AI_ESCALATE_BELOW_CONFIDENCE=always`**, so every file with usable text
  calls Gemini unless it has a byte-identical twin. Measured cost on the real
  corpus: 516 calls, ~$0.12, ≈$0.00023/call — a full 9,398-file run is about
  **$2.20**. `AI_DAILY_CALL_CAP=500` is the real brake, and at 500/day a full
  import takes ~2.5 weeks to finish classifying. Raise the cap deliberately;
  don't raise it and walk away.

## Verification scripts (all in `backend/scripts/`)

Run these rather than trusting a summary — several of them have caught real
bugs after a change looked fine:

    node scripts/verify-triage.js               the triage queue's reasons
    node scripts/verify-duplicate-compare.js    duplicate group inspect/compare
    node scripts/verify-search-filters.js       filters on all four query paths
    node scripts/verify-known-content-skip.js   2nd overlapping folder is cheap

The four newest scripts PAUSE the BullMQ queues while they set fixtures up
(scripts/_fixtureQueue.js) and resume on the way out. Without that a live
worker hashes the fixtures out from under the assertions -- which is invisible
while the worker has a backlog, and breaks the moment it is idle. The older
scripts do not do this yet; run those with the worker stopped.
    node scripts/verify-mirror.js               shortcut mirror end to end
    node scripts/verify-scan-recovery.js        self-healing scan
    node scripts/verify-bulk-reject.js          bulk proposal rejection
    node scripts/verify-gibberish-naming.js     unreadable files keep their names
    node scripts/verify-title-quality.js        boilerplate titles ignored
    node scripts/verify-placeholder-detection.js  cloud placeholders
    node scripts/verify-file-search-routing.js  search results carry subject_id
    node scripts/check-shortcut-quoting.js      awkward filenames -> shortcuts
    node scripts/check-ole-titles.js <folder>   real .doc titles decode cleanly
    node scripts/check-document-dates.js <folder>  where dates come from

Plus `npm test` in `backend/` (200 tests).

## Backups

Nightly at 02:00 via the "Atlas Database Backup" scheduled task, into
`Documents\Atlas Backups`, 14-day retention. `scripts\verify-backup-restore.ps1`
proves a dump actually restores. The database is the only irreplaceable thing —
the original files are never modified.
