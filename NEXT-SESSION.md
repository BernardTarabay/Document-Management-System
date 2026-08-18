# Where things stand

Written at the end of a long session so the next one can start without
re-deriving anything. Delete it once it's stale.

## How to run the app

Migrations 036-039 landed today (deletable folders, archive/trash, the
purge_trash job type, quick identity). Run `npm run db:migrate` before anything
else if you are picking this up on another machine.

The dev server (`npm run dev` in `backend/`, plus Vite) is what's normally
running — UI on **http://localhost:5173**, API on **:5000**. Vite will take
**5174** instead if something else already holds 5173 (a leftover dev server
from an unrelated project will do it), so check the port Vite prints rather
than assuming.

`scripts\restart-atlas.bat` is for PRODUCTION mode only. It now refuses to run
while a dev server is up, because starting both makes two APIs fight over port
5000 and two workers double the Gemini request rate (the limiter is
per-process). Use `restart-atlas.bat force` only if you genuinely want to
stop the dev server and switch.

**`npm run dev` now refuses to start if something already owns port 5000**
(`scripts/preflight-dev.js`). This is the other half of the guard above, and it
exists because the reverse case cost a whole session: a `node src/server.js`
started the previous day still held 5000, nodemon lost the race, printed
EADDRINUSE and then sat waiting for a file change. There *was* an API on the
right port answering `/api/health` with `status: ok` — it was simply the other
one, frozen at day-old code. The symptom is a feature that exists in the
source, has a registered route and passing tests, and 404s in the browser;
editing files fixes nothing, because nothing is reading them.

The check names the process holding the port, when it started, and whether it
reloads — a second nodemon is a harmless mistake you can just use, while a bare
`node src/server.js` is the one that serves stale code indefinitely. It is a
refusal rather than a warning on purpose: a warning scrolls past in the same
noise that hid the original crash, and the whole failure mode is that
everything looks fine. Escape hatches are `npm run dev:only`, or
`$env:SKIP_PREFLIGHT=1` if you really do want two APIs.

If the browser is showing something the code says should work, **check which
process is actually serving :5000 before debugging the code.**

**The worker is not managed by nodemon.** `npm run dev` only watches the API,
so after changing anything the worker runs (extraction, naming, classification)
you must restart `node src/workers/runner.js` by hand.

THIS HAS NOW BITTEN TWICE. First a stale decoder re-corrupting metadata. Then
the quick-identity shortcut (migration 039) was written, tested and reported as
working while the worker ran three-hour-old code -- so it silently did nothing,
and the symptom was "it failed spectacularly" with no errors anywhere, no failed
jobs, and correct-looking output. **After touching anything under
`src/jobs/processors/`, `src/services/` or `src/repositories/`, restart the
worker before concluding anything about whether it worked.** Compare the worker
process start time against the file mtime if in doubt:

    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
      Where-Object { $_.CommandLine -like '*workers/runner*' } |
      Select-Object ProcessId, CreationDate

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
- **Every file has a description, and you can find it by describing it.**
  New `describe` stage (migrations 034/035, `services/descriptionService.js`).
  `files.ai_summary` existed but was a by-product of classification, so it was
  missing wherever the AI tier had not run, and it was only searchable by
  `ILIKE '%<your whole phrase>%'` — the entire query had to appear verbatim.
  Now: every active file ends with a `file_descriptions` row carrying either a
  description or a written reason it has none. Videos and audio are described
  for real (Gemini is multimodal — the two WhatsApp clips came back as "a child
  cheering at a soccer match" and "a person in an Argentina jersey dancing").
  Files nothing can read get a facts-only description, built in code with no
  model involved, that says so rather than inventing contents.
  Search fuses three signals (meaning, description wording, existing
  content/filename) with reciprocal rank fusion. No pgvector — it is not
  available on this Postgres and is not needed at this size; 768-dim vectors
  live in `bytea` and are scanned in memory in single-digit ms.
  `node scripts/verify-descriptions.js`, `node scripts/backfill-descriptions.js`.

- **The document-type axis was empty, and not for the reason it looked like.**
  13 types seeded, exactly one ever assigned — "Book", to a personal narrative,
  on the substrings inside "playbook" and "fantasy books". Three compounding
  causes, all fixed: the keyword list was `[name, code]`, which is the SAME
  WORD TWICE for every single-word type, so one occurrence scored 2 and cleared
  a MEDIUM threshold documented as needing two independent matches; matching
  was `includes()`, so "book" hit inside "playbook"; and every writer that
  touched one axis passed `null` for the other, which under "latest row wins"
  DELETED it — filing a document under a subject erased its type, and setting a
  type dropped its subject. Now: `services/taxonomyMatcher.js` (deduped terms,
  Unicode word boundaries), `classificationResultRepository.createPartial`
  (undefined = keep, null = clear), and the type axis no longer reads body text
  at all — prose says what a document is ABOUT, not what KIND it is, and the
  narrative that broke this says "presentation" four times about people giving
  them. Expect FEWER rule-tier types, which is the point.
  `node scripts/verify-document-type-axis.js`.

- **The Subjects page is now the Library, and it is the landing page.**
  `/` renders `LibraryPage.jsx` (git-renamed from `SubjectsPage.jsx`);
  the Dashboard kept everything and moved to `/dashboard`, behind "More" in the
  nav. `/subjects` redirects, so old links still work. The name changed because
  "Subjects" named the table it reads rather than the job it does — this is the
  front door of a document management system, and the taxonomy is only how you
  get around it.
  Built around one loop: *see how much is unsorted → open that pile → select a
  stack → file it in one action → watch the number drop.*
  - **Overview strip** (`LibraryOverview.jsx`) — documents, filed, unfiled,
    in-flight, from the same `/dashboard/summary` the Dashboard uses so the two
    can't disagree. The unfiled tile is a **button**, not a statistic.
  - **The unfiled pile is a destination**, pinned above the tree and
    deep-linkable at `/?unfiled=1`. Backed by a new `unfiled` filter in
    `fileFilters.js` (matches both "latest row names no subject" and "never
    classified at all"); combining it with `subjectId` is a 400, not an empty
    list.
  - **Multi-select + bulk filing** — checkboxes, shift-click ranges, select-all,
    and a selection bar. Files via `POST /files/move`, which is a thin entry
    point onto the **existing** `fileOrganizeService.moveManyToSubject` that
    Photos and Triage already call, reusing `MoveManyModal` unchanged. Nothing
    was forked: a second bulk implementation is exactly the "four callers, four
    implementations" failure that module's header warns about.
  - **Keyboard**: `j/k` move, `x` select (`shift-x` range), `a` all, `f` file,
    `Enter` open, `/` search, `Esc` clear. `?` shows the sheet.
  - **What's open lives in the URL** (`?subject=…`), so Back steps through
    branches and a folder can be linked to.

- **Library, round two — the UX pass, and built for scale.**
  - **One search box, and it searches DOCUMENTS.** This was the page's worst
    problem: the prominent input filtered *subject names* in list view but
    searched *files* in map view, from an identical-looking box, and a second
    look-alike box inside the panel searched within one subject. Typing
    "plumber invoice" on the front door of a document system returned "no
    subject matches". Now one box searches documents everywhere, in every
    view, and results say which folder each hit lives in. Finding a *folder*
    by name is a rarer job and got its own small input inside the tree pane,
    next to the thing it affects.
  - **Drag-to-file worked only in map view.** Rows were `draggable` but only
    `SubjectGraph` had a drop handler — in the default view you could pick a
    file up and there was nowhere to put it. Tree nodes are drop targets now,
    with a hover highlight and a `cursor-grab` so the gesture is discoverable.
  - **Table view** (`LibraryTable.jsx`) — third mode beside List and Map. No
    tree; full width, 100 rows a page, server-side sortable columns. For when
    the archive is too big to browse a hierarchy and the question becomes
    "biggest files" or "what came in last week", which a tree cannot answer.
  - **Sorting is server-side against a whitelist** (`fileFilters.parseSort`).
    ORDER BY can't be parameterised, so the request names a *sort*, never a
    column. Every sort appends `f.id` as a tiebreaker — without it, rows with
    equal values have undefined order and pagination silently repeats and
    loses rows, which at a few thousand files nobody would notice.
  - **Select all N**, not just the page (`GET /files/ids`, capped at 5,000 and
    the cap is *reported*, never silently applied). Real totals from
    `GET /subjects/:id/documents/count`.
  - **Tree opens one level deep**, not fully expanded; the view toggle is no
    longer gated on `subject.manage` (read-only users couldn't reach the map
    or table at all). Pane heights derive from one `CHROME_HEIGHT` constant
    instead of three hand-tuned magic numbers that all silently broke when the
    overview strip was added above them.

- **Browse by Document Type** (`/document-types`, `DocumentTypesPage.jsx`).
  The second classification axis finally has a browse surface — a flat list of
  types with filtered counts, click one to see every file of that kind
  *wherever it is filed*, which is the question a tree cannot answer. Backed by
  `GET /document-types/browse` (types + counts + `untypedCount`) and the plain
  `GET /files?documentTypeId=`, so the list obeys the same one filter builder
  as everything else. `documentTypeId` is now part of `fileFilters.js` and of
  the shared `FileFilters` bar, so it composes with subject, date, extension
  and location — "every Invoice under Finance from 2019" is expressible.
  A "No type yet" row is shown deliberately rather than hidden: on this corpus
  it is currently *every* file, and a page that omitted it would imply the
  archive is smaller than it is.

- **The assistant could not find a file by what is in it.** Asking for "the
  photo of two people hugging in a kitchen" failed while asking for "WhatsApp
  Image 2026-07-29" worked. That looked like a search-quality problem and was
  not one: `descriptionSearchService` finds both files from a paraphrase and
  always could. **The assistant never called it.** Its entire world was the
  page context plus the triage/photo backlog — a couple of hundred files out of
  thousands — and each one reached the model as `id | filename | path` with the
  path always empty, because the controller set `path` and the template read
  `currentPath`. The filename was the only string it could match on, and on
  this archive the filenames are camera exports that say nothing.
  Now: `aiChatController` runs the user's message through the hybrid search and
  merges the top 30 hits, descriptions are fetched in one batch and rendered on
  the line, and fields are omitted rather than emitted empty. Retrieval leads
  the list, because `buildInput` trims from the end.
  Watch the dedup: the first version filtered retrieved files against a `seen`
  set primed from the backlog, and since every unfiled photo is in the backlog,
  the top hit was demoted out of the retrieval block and re-listed in backlog
  order. **Position is the signal — a "dedup" that drops a file from the front
  of the list is a re-ranking.** `node scripts/verify-assistant-retrieval.js`.

- **"Select all N" selected fewer than N, silently.** Three queries described
  the same scope and only two agreed. `idsMatching` applied the SUBJECT rule
  (active only, resolved-duplicate losers excluded) to every scope, while the
  table and the unfiled pile are drawn by `listNotDeleted` (everything not
  deleted). A `missing`, `moved`, `changed` or `archived` file was listed,
  counted, then left out of the selection with no message — `capped` is false,
  so nothing fired. The symptom was the unfiled pile refusing to empty: file
  "all 40", the tile still reads 3, nothing says why. `idsMatching` is now
  scope-aware and mirrors whichever list it is selecting from.
  **This cannot reproduce on an all-active database**, which is why it
  survived; the fixture in `verify-library.js` §5 creates a `missing` file on
  purpose.

- **Filters did not narrow a search.** The hybrid search fuses three ranked
  signals and only one — `searchEverything` — is SQL carrying the filter
  clauses. The semantic signal scores in-memory vectors and the description
  signal ranks another table; both return bare ids no filter had ever seen, so
  fusing them put back exactly what the user had excluded. A search scoped to
  one subject returned documents filed elsewhere. Now gated after fusion by
  `fileRepository.idsPassingFilters`, which keeps RRF's ranking (it decides
  membership, never order) and also applies `status <> 'deleted'` to the two
  id-only signals, neither of which reads a table that knows a file is deleted.
  Found by repairing `verify-search-filters.js` — it failed on its first run
  back.

- **`buildOrderBy(null)` threw.** A `= {}` default only fires on `undefined`,
  and both list functions default `sort` to `null`. Not reachable today (both
  production callers pass a parsed sort) but the signature advertised an
  optional argument that was not.

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

Opened or still open after today:

- ~~**A live Gemini API key in `backend/.env.example`**~~ — **REVERTED.** The
  placeholder is restored and the file matches HEAD. It never reached git
  history (`git log --all -S` finds nothing) and appears in no other tracked
  file; the only remaining copy is the gitignored `backend/.env`, which is the
  working key. **Still worth rotating** — it sat in plaintext in a file whose
  entire purpose is to be shared, and `.gitignore` deliberately tracks it
  (`!.env.example`), so it was one `git commit -a` from being published. If you
  ever need to check again: `git grep "AQ.Ab8" -- .`
- ~~**`adm-zip` high CVE**~~ — **FIXED.** Upgraded 0.5.18 -> 0.6.0
  (GHSA-xcpc-8h2w-3j85, a crafted ZIP triggering a 4 GB allocation). It runs on
  EVERY ingested file via `utils/fileSignature.js`, so a malformed archive
  anywhere in a scanned drive could OOM the worker. `npm audit --omit=dev` is
  now clear of high severity.
  It is a semver-MAJOR bump, so the API was checked rather than assumed: the
  write path (`new AdmZip`/`addFile`/`toBuffer`), the read path
  (`new AdmZip(buffer)`/`getEntries`/`getEntry`/`readAsText`), docx and pptx
  text extraction with accents and Arabic intact, all four OOXML subtypes
  disambiguated, and a corrupt zip still reported rather than thrown. Then
  end-to-end on 13 real Office files written by `generate-pilot-corpus.js`:
  13/13 identified, 13/13 extracted, 0 errors.
  **`npm install` kills a running nodemon** — the API was down until restarted.
  Check `/api/health` after any dependency change.
- **`uuid`/`exceljs` still carry a MODERATE** (GHSA-w5hq-g745-h8pq, missing
  buffer bounds check in uuid v3/v5/v6 when `buf` is supplied). Left alone
  deliberately: the only fix npm offers is downgrading exceljs 4.4 -> 3.4, a
  major step BACKWARD in the library that reads every spreadsheet, to close a
  bug in a code path this codebase never calls (nothing here passes `buf` to
  uuid). Revisit when exceljs ships a build on a patched uuid.
- **`GET /subjects` returns 22 MB for 46,000 folders.** 0.63s server-side is
  fine; that is a heavy parse on a slow client. Fixing it means trimming columns
  or lazy-loading branches -- a real architectural change, not a tweak.
- **The document-type axis is empty on a personal corpus, correctly.** The 13
  seeded types are institutional (Invoice, Tax Return, Annual Budget...). The
  rule tier cannot match camera filenames, and the AI tier is asked and answers
  null -- `raw_output.picks` records that it was asked. Not a bug. If the target
  is a personal archive rather than the church one, reseed with types the other
  signals cannot already give you (CV, Receipt, ID Document) and NOT ones that
  restate the extension (Photo, Video).
- **"2026" as a folder name will not file by date.** The rule tier matches the
  literal string in the filename, so `WhatsApp Image 2026-07-29` matches by
  accident while a PDF dated 2026 with no "2026" in its text does not.
  `document_date` is extracted and filterable but the classifier never reads it.
  The honest fix is rule-based folders -- a folder carrying a saved filter --
  which is `move_by_filter` inverted and mostly already built.
- **Nothing built today has been seen in a running browser.** Everything is
  verified at the service, API, build and box-model layers; the Library has been
  behind a login the whole session. The windowed tree, the drag gestures, the
  Trash countdown badges and the onboarding are the pieces most worth a human
  look.

## Landed today, and what it cost to learn

In the order it happened, because several of these only make sense as
consequences of the one before.

### The Library at scale

- **`GET /subjects` took 114 seconds.** `subjectService.list` rolled counts up
  with a `reduce` nested inside a `map` doing a string `startsWith` per pair --
  O(n^2), 2.1 billion comparisons at 46,000 folders. `materialized_path` is
  dot-joined, so a folder's ancestors ARE its own path truncated at each dot;
  one pass, O(n x depth). **114.5s -> 0.63s.** Invisible on a demo taxonomy and
  fatal on a real one.
- **The folder tree is windowed** (`react-window`, new dependency). Shaping moved
  to `frontend/src/lib/subjectTree.js` as plain functions so it can be measured
  outside a browser: `node scripts/bench-subject-tree.mjs`. Per keystroke
  22ms -> 2.5ms; DOM rows 13,706 -> ~40.
  The forcing constraint: **a windowed list unmounts rows that scroll away**, so
  per-node `useState(open)` silently reset every branch the user had opened.
  Expansion state lives above the list as one Set. That is the whole reason the
  row component is a leaf that renders one line.
- **Search results are capped at 2,000 rows** (`MAX_FILTER_ROWS`), and the cap is
  reported. Uncapped, one letter typed into a 55,000-folder tree allocated a row
  object per folder and was measurably SLOWER than the recursion it replaced.
- **The file panel is windowed too**, and `FILES_LIMIT` went 20 -> 100. The
  complaint was "at best you see five files then scroll forever"; a big page is
  only affordable because the DOM holds a screenful either way.
- **The map/graph view is gone.** `SubjectGraph.jsx` deleted, toggle entry
  removed, `atlas.subjectView` repurposed so a stored `"graph"` falls back to
  `"list"` rather than loading a view that no longer renders.
- **Never hardcode one element's height inside another.** The tree list used
  `h-[calc(100%-2.75rem)]` -- the pane minus a guess at the header. Adding
  Archive and Trash to that header took it to ~110px and folders ran off the
  bottom of the card. Worse, a percentage height against an auto-height parent
  does not clamp AT ALL, so the list grew to its full content: measured 13,600px
  of list inside a 600px card at 400 folders. Now measured with a ResizeObserver,
  `min(contentHeight, availableHeight)`. `CHROME_HEIGHT`'s comment already
  recorded this exact failure -- and it happened again anyway.

### The tree is the user's, not the software's

- **New accounts start with NO folders.** `authService.register` no longer seeds
  twelve, and `seedStarterTree`/`STARTER_TREE` are deleted. The old comment
  defended seeding as avoiding "an empty tree with a create-your-first-folder
  dead end" -- right about the risk, wrong about the fix. A structure handed over
  before the user has said anything is derived from nothing, and it BECAME the
  taxonomy, because rearranging someone else's structure costs more than
  accepting it. The dead end is answered by `LibraryOnboarding` instead.
- **The assistant's system prompt was lying about the taxonomy.** It said "a
  strict 3-level hierarchy: Subject -> Category -> Subcategory" and "never
  propose creating a child under a Subcategory", but migration 029 made depth
  unlimited (capped at 12 as a guard rail, not a shape). That prompt WAS the
  locking mechanism the user kept describing. Rewritten, plus an explicit note
  that document type and folder are independent axes.
- **Folders can be deleted** (migration 036). `classification_results` referenced
  subjects with NO ACTION, so a folder that had EVER held a file was permanently
  undeletable and the app suggested renaming it instead. Now ON DELETE SET NULL:
  historical rows keep method, confidence and timestamps, only the pointer to a
  dead folder is dropped, and the files become unfiled. Deleting a branch or
  filed documents is CONFIRMED with counts rather than refused.
- **Folders can be dragged into each other.** `subjectRepository.reparent`
  rewrites the whole branch's `materialized_path`/`depth`/`level` in one
  transaction -- the migration-029 trigger only fixes the row being written, so a
  naive `UPDATE ... SET parent_id` leaves every descendant claiming an ancestry
  it no longer has. That does not throw; it silently breaks the descendant
  filter, the count rollup and the tree. **The test checks the GRANDCHILD after
  every move.**
- **Duplicate folder names warn rather than refuse** in the create dialog, with a
  suggested alternative. A drag that would create a same-name sibling IS refused:
  a clash you can see in a dialog is a warning, one created silently by a drop is
  a mess.

### Finding things

- **The assistant could not find a file by what is in it.** `descriptionSearch`
  finds "two people hugging in a kitchen" from a paraphrase and always could; the
  assistant never called it. Its whole world was the current page plus the
  triage/photo backlog, each file rendered as `id | filename | path` with the
  path ALWAYS EMPTY -- the controller set `path`, the template read `currentPath`.
  Now: retrieval on the user's message, descriptions attached, fields omitted
  rather than emitted blank.
- **Watch the dedup direction.** The first version filtered retrieved files
  against a `seen` set primed from the backlog -- and every unfiled photo is in
  the backlog, so the top hit was demoted below cryptography screenshots.
  **Position is the signal; a "dedup" that drops a file from the front of the
  list is a re-ranking.**
- **Filters did not narrow a search.** The hybrid search fuses three ranked
  signals and only one carried the filter clauses; the other two returned bare
  ids no filter had ever seen. Gated after fusion by `idsPassingFilters`, which
  keeps RRF's ranking -- it decides membership, never order.
- **Folder descriptions now reach the classifier.** `subjects.description` existed
  in the schema and in the dialog and was never sent. Each candidate carries a
  "for:" note which the prompt says OUTRANKS the folder name. This is the closest
  the system gets to being taught. **It does NOT learn from corrections** -- file
  a hundred documents by hand and the hundred-and-first is classified exactly as
  the first would have been.
- **Classification candidates were unscoped.** `subjectRepository.list({limit:1000})`
  is the base repository's `SELECT * FROM subjects` -- every account's folders
  offered as candidates for every file, and their names sent to Gemini inside a
  stranger's prompt. Now `listForOwnerTree(file.owner_user_id)`.

### Bulk operations

- **`move_by_filter`** files everything MATCHING criteria, not everything in one
  folder. Uses the existing `bulk_move` JobType -- it was in both the JS and
  Postgres enums with no processor, so no migration was needed. The filter shape
  is byte-for-byte what `FileFilters.jsx` sends to `GET /files`; there is no
  second filter language. The match set is **snapshotted before work starts**:
  `unfiled=true` stops matching a file the instant it is filed, so a paging
  implementation skips whatever moved out from under its OFFSET.

### Archive, Trash, and deletion

- **Archive and Trash are STATUSES, not folders** (migration 037). A subject says
  what a document is ABOUT; these say where it is in its LIFE. As folders, every
  listing query would need "...and not filed under Trash" bolted on, and the
  first that forgot would show deleted documents as live. Being statuses also
  makes "undeletable and unrenameable" free -- there is no row to delete.
- **Trash empties itself** after `TRASH_RETENTION_DAYS` (default 30) via a
  scheduled `purge_trash` job (migration 038). Purging removes Atlas's ROW; the
  file on disk is untouched, so a purged file that still exists is re-imported by
  the next scan -- correct, because it IS still there.
- **Permanent deletion is two-step and the API enforces it**: the literal phrase
  `permanently delete` must be in the body, so the server and the dialog agree on
  what counts as confirmation rather than the UI being the only guard.
- **Redundant copies can be deleted from disk** -- the only thing in Atlas that
  removes a user's file. Safe only because the argument is CHECKED rather than
  assumed: before anything is deleted the SURVIVOR is re-opened and re-hashed. A
  stale row claiming a twin exists is exactly how this would destroy the last
  copy of something. Ran on the real corpus: 15 copies, 27.1 MB, 0 skipped, all
  15 survivors verified byte-for-byte afterwards.

### Ingest cost

- **Duplicates are recognised without being read** (migration 039). Candidates by
  exact size + mtime from an index with nothing opened, then 64 KB from each end.
  Measured on a real 25.5 MB video: **128 KB instead of 26,067 KB, 204x less**.
  An adopted hash is marked `hash_source = 'inferred'` rather than written
  silently into the column duplicate detection is built on;
  `scripts/verify-inferred-hashes.js` settles them on demand.
- **THE FINGERPRINT IS STORED ON EVERY FULL HASH, needed or not.** The first
  version computed one only when a candidate already existed -- so the original
  never stored one, so no copy ever had anything to match, so the shortcut never
  fired for anyone. A feature exactly as fast as not having it. It is now derived
  from the hash stream in one pass at zero extra I/O, and
  `scripts/backfill-fingerprints.js` catches up an existing corpus (128 KB per
  file, not a re-read).

### Counting

- **Settled duplicates are hidden from every "what do I have" view.** The
  exclusion existed, written by hand in SEVEN subject-scoped queries, and was
  missing from the listing, the count, the id sweep, the search, the photo grid
  and the dashboard. So the Library said 31 while a folder said 16, and the
  Photos badge said 18 for 9 pictures. One definition now:
  `fileFilters.LISTABLE_FILE`. Only RESOLVED groups are hidden -- an undecided
  group still shows both copies, because hiding one would be picking for the
  user.
- **The list, the count and the "select all" sweep have drifted apart TWICE.**
  First on `status != 'deleted'` (select-all silently selected fewer than the
  page showed), then on duplicate exclusion. They are now one constant, and
  `verify-known-content-skip` asserts all three plus the dashboard agree.

### Deleting originals -- the client's actual request, NOT built

The client wants files deleted from their source folder once Atlas has organised
them. **This is data loss, and the reason is stronger than "what if the pipeline
has a bug".**

Atlas holds no bytes. `getDownloadStream` streams from the ORIGINAL file where it
lies, and the organized folder is `.lnk` shortcuts pointing at it. Delete the
source and the document is gone, the shortcut dangles, download and preview 404,
and the name/subject/description survive describing a file that no longer exists.
A file can complete every pipeline stage perfectly and still be destroyed this
way, because finishing the pipeline never produces a second copy. This codebase
deliberately moved AWAY from holding bytes -- `folderImportService` and the
upload zones were removed for exactly that reason.

What exists instead is redundant-copy deletion (above), which is provably
lossless. The full request needs one of:

  vault      Atlas copies each file into storage it owns, verifies by SHA-256,
             THEN deletes the source. `node scripts/vault-sizing.js` costs it out
             -- 1.6-11 GB of vault for 9,398 documents depending on average size,
             ~1.2 GB of database, migration peak roughly raw + deduplicated.
             Storage is NOT the reason to hesitate. The real change is that the
             vault becomes the ONLY copy: today the client's own drives provide
             durability and the 26 MB database is the sole irreplaceable thing;
             afterwards a failed disk loses the archive.
  export     Atlas writes a real folder tree with real copied files, named and
             filed. He inspects it and deletes the sources himself. No
             irreversible action taken by software.

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
    node scripts/verify-descriptions.js         every file describable + findable
    node scripts/verify-document-type-axis.js   type assigned on signal, never erased
    node scripts/verify-library.js              unfiled is listable, bulk filing is safe
    node scripts/verify-assistant-retrieval.js  the assistant finds files by description

**Three of these were dead and nobody knew.** `verify-search-filters`,
`verify-triage` and `verify-duplicate-compare` all threw on their first line of
setup — the per-owner ownership commit made `ownerUserId` a required argument
(`repositories/ownership.js` throws rather than defaulting) and their fixtures
were never updated. They have been repaired, but the lesson generalises: a
verification script that is not run is not a guardrail, and these had been red
for long enough that two real bugs accumulated behind them. **Run the whole
list after any change to ownership, filtering or search**, not just the script
whose feature you touched.

`verify-assistant-retrieval` drives the REAL controller with the Gemini call
stubbed, rather than reimplementing its context assembly. That distinction
caught an ordering bug the reimplementation had gotten right — a script that
rebuilds the logic it checks passes happily while the shipped path is broken.
It needs no API key and makes no model call.

The newest scripts PAUSE the BullMQ queues while they set fixtures up
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

New today:

    node scripts/verify-move-by-filter.js          bulk move by criteria
    node scripts/verify-subject-deletion.js        folders can actually be deleted
    node scripts/verify-subject-move.js            drag a folder, branch and all
    node scripts/verify-archive-trash.js           the two destinations
    node scripts/verify-folder-descriptions.js     descriptions reach the model
    node scripts/verify-empty-start.js             new accounts start empty
    node scripts/verify-quick-identity.js          recognised without being read
    node scripts/verify-redundant-copy-deletion.js the only on-disk deletion
    node scripts/verify-assistant-retrieval.js     the assistant can find things

One-off / operational, not part of the suite:

    node scripts/backfill-fingerprints.js --apply  catch up an existing corpus
    node scripts/verify-inferred-hashes.js --apply prove the inferred hashes
    node scripts/vault-sizing.js                   cost the "Atlas keeps files" option
    node scripts/generate-pilot-corpus.js --subjects 55000   load-test the tree
    node scripts/preflight-dev.js                  is anything on port 5000
    cd frontend && node scripts/bench-subject-tree.mjs       folder pane at 55k
    cd frontend && node scripts/check-nav-layout.mjs         header layout

Plus `npm test` in `backend/` (310 tests).

**Two scripts drive the REAL code with one collaborator stubbed**, rather than
reimplementing what they check -- `verify-assistant-retrieval` (stubs the Gemini
call, drives the controller) and `verify-quick-identity` (instruments the storage
layer and counts bytes). Both caught bugs a reimplementation would have missed:
the retrieval one caught an ordering bug the reimplementation had right, and the
byte counter caught a "working" shortcut that read MORE than before. Prefer this
shape for anything where the failure is "it ran but did nothing".

## Backups

Nightly at 02:00 via the "Atlas Database Backup" scheduled task, into
`Documents\Atlas Backups`, 14-day retention. `scripts\verify-backup-restore.ps1`
proves a dump actually restores. The database is the only irreplaceable thing —
the original files are never modified.

That last sentence is now ALMOST true rather than true, and the exception is
worth knowing: `redundantCopyService` deletes redundant copies from disk. It only
ever removes a file whose exact bytes exist elsewhere and only after re-reading
and re-hashing the survivor, so no document is lost — but Atlas is no longer a
strictly read-only observer of the filesystem. If the vault option is ever built,
this sentence stops being true altogether and the backup story becomes the
product working at all.
