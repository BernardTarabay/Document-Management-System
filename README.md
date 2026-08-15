# Document Management & Intelligent File Organization Platform

Status: **Phases 1–12 complete** (Domain Analysis → Terminology → Taxonomy →
Storage Architecture → Database Model → Processing Pipeline → Background Jobs →
Auth/RBAC → API Contracts → Controllers/Services/Routes → React Frontend →
Electron Filesystem Agent), plus several post-Phase-11 additions:

- **AI classification escalation tier** (`docs/09-ai-classification.md`) — when the
  rule-based classifier isn't confident and `GEMINI_API_KEY` is set, a Gemini pass
  produces a specific title, one-line summary and extracted entities. Entirely
  opt-in; unset the key and the pipeline behaves exactly as it did before.
- **Email inbox triage** (`docs/10-email-inbox.md`) — connect Gmail, auto-trash
  clutter, surface the rest on a read-only Inbox page.
- **Probable-duplicate and version detection** — content similarity short of a hash
  match, as reviewable suggestions that are never auto-applied.
- **Legacy Office extraction** — `.doc`/`.xls`/`.ppt` are now fully extracted.

Phase 13 (integration) and Phase 14 (broader testing) are next.

## What's here

```
docs/
  01-domain-model.md          File vs Document vs Version vs Metadata vs Identity
  02-terminology.md           Controlled vocabulary for the whole project
  03-taxonomy.md              Subject/Category/Subcategory + naming convention
  04-storage-architecture.md  Storage Location / Filesystem Agent design
  05-database-schema.md       ERD + rationale for the schema
  06-processing-pipeline.md   Stage sequence, idempotency, retry/failure rules
  07-supported-formats.md     What's actually extractable per format, and why
  08-api-contracts.md         Resource/endpoint map, permission per route
  09-ai-classification.md     The optional Gemini escalation tier
  10-email-inbox.md           Gmail triage design

backend/
  migrations/     17 numbered, forward-only SQL files
  seeds/          Reference data (RBAC roles/permissions, starter taxonomy)
  scripts/        verify-agent-e2e.js -- live end-to-end check of the agent protocol
  tests/          node --test, no new dependencies (see tests/README.md)
  src/
    config/       env validation, pg Pool, Redis connection
    db/           migrate.js / seed.js / resetData.js / Reclassify.js runners
    models/       enums.js -- JS mirror of the Postgres enum types
    repositories/ one file per entity group -- the only layer that talks to pg
    services/
      storage/      StorageService interface + LocalStorageService (direct)
                    + AgentStorageService (brokered through a Filesystem Agent)
      extraction/   per-format extractors (pdf/xlsx/docx/pptx/pbix)
                    + ole/ for legacy .doc/.xls/.ppt
      email/        Gmail OAuth and API client (raw fetch, no SDK)
      ai/           geminiClassifier, geminiChatService, emailTriageClassifier
      preview/      LibreOffice-backed thumbnails
      similarityService.js  shingle/Jaccard engine for duplicates + versions
      agentService.js       Filesystem Agent lifecycle and operation brokering
      hashingService.js, namingService.js, authService.js, and one service
      per API resource
    utils/        fileSignature.js, cfb.js (OLE container), pathSafety.js,
                  tokenCrypto.js, jwt.js, passwords.js, pagination.js, ...
    middleware/   authenticate.js (user JWT), authenticateAgent.js (agent JWT),
                  requirePermission.js (RBAC), rateLimiters.js, asyncHandler.js
    controllers/  thin HTTP-shaping layer, one per resource
    routes/       one file per resource, mounted in app.js under /api/*
    queues/       BullMQ registry + enqueueJob() (always backed by a processing_jobs row)
    jobs/         job_type -> processor registry, runProcessingJob() lifecycle wrapper
      processors/ scan, hash, extract_metadata, extract_text, classify,
                  detect_duplicates, detect_versions, generate_names,
                  bulk_rename, bulk_delete, auto_resolve_duplicates,
                  email_sync, reindex
    workers/      runner.js -- separate worker process, `npm run worker`

frontend/         React 18 + Vite + Tailwind v4 SPA
  src/
    services/apiClient.js   thin fetch wrapper, attaches JWT, retries once on 401
    context/                AuthContext, ToastContext
    components/             Sidebar, Topbar, Layout, Modal, ConfirmDialog, preview
                            and folder-import components, SubjectChatPanel, ...
    pages/                  Login, Register, Dashboard, Files, Documents, Subjects,
                            DuplicateGroups, RenameProposals, ProcessingJobs,
                            StorageLocations, AuditLog, Users, Inbox

desktop-agent/    Electron Filesystem Agent (Phase 12) -- see its own README
  src/            main/preload/renderer + the poll-execute-report runner
  tests/          path-guard and operation tests (no Electron needed)
```

## Running it

Two processes: the API and the worker pool. Both need Postgres and Redis reachable.

```bash
cd backend
cp .env.example .env         # DATABASE_URL, REDIS_URL, JWT secrets
npm install
npm run db:migrate           # applies backend/migrations/*.sql
npm run db:seed              # loads backend/seeds/*.sql (idempotent)

npm run dev                  # terminal 1: API on :5000, GET /api/health checks the DB
npm run worker               # terminal 2: starts all 13 job workers against Redis
```

```bash
cd frontend
npm install
npm run dev                  # terminal 3: UI on :5173, proxies /api to :5000 in dev
```

Register through the UI at `/register`. A brand-new database has no users with
elevated permissions — the first registered user gets the `User` role only. To grant
`Admin`, run once against your database:

```sql
INSERT INTO user_roles (user_id, role_id)
SELECT '<your-user-id>', id FROM roles WHERE name = 'Admin';
```

**Seeds are not auto-applied on migrate.** Permissions added after your database was
first seeded — `subject.manage`, `email.manage`, `agent.manage` — require re-running
`npm run db:seed` before the corresponding nav items and endpoints become reachable.

To try the pipeline end to end through the API (see `docs/08-api-contracts.md` for
the full route list):

```bash
curl -X POST http://localhost:5000/api/storage-locations \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"name":"My Repo","type":"local","rootPath":"/path/to/folder","accessMode":"direct"}'

curl -X POST http://localhost:5000/api/storage-locations/<id>/scan \
  -H "Authorization: Bearer <token>"
# -> discovers files, which cascade through hash -> metadata/text extraction ->
#    duplicate + version detection -> classification -> naming proposal
```

## Tests

```bash
cd backend && npm test          # 138 tests
cd desktop-agent && npm test    # 16 tests
```

Node's built-in runner, no new dependencies. All pure unit tests — no live Postgres,
Redis or network — so they run in under a second and can't fail for environmental
reasons. `backend/tests/README.md` explains what's covered, what deliberately isn't
(the AI tiers, repositories, the job pipeline, the frontend), and why.

Two live end-to-end checks need real services:

```bash
cd backend && npm run verify:agent   # full Filesystem Agent loop against a real DB
```

## What was verified against real services

Nothing here was verified in the abstract — everything was run against real
PostgreSQL and Redis, not mocks:

- All migrations apply cleanly on an empty database; re-running is a no-op. Seeds are
  idempotent (this caught a real bug: a `UNIQUE(parent_id, slug)` constraint doesn't
  dedupe root-level taxonomy rows, since SQL never treats two `NULL`s as equal —
  fixed with a partial unique index in `005_taxonomy.sql`).
- Every repository was smoke-tested through a realistic flow.
- All content extractors were run against real generated files. This caught a real
  bug: `pdf-parse` failed with "bad XRef entry" on a perfectly valid PDF; swapped to
  `pdfjs-dist` directly.
- The legacy `.doc`/`.xls` extractors were verified by round-tripping the *same*
  document through both the modern and legacy paths — 99% word-level recall for
  `.doc`, 100% for `.xls`. That comparison caught a real bug: dropping Word's `0x07`
  cell mark fused adjacent table cells into invented tokens (`DateÉvénementSection`).
- The full BullMQ pipeline was run end-to-end against a test repository: one `scan`
  fanned out to 41 downstream jobs across all queues, zero failures.
- `bulk_rename` was verified by approving a real proposal and confirming the physical
  file was renamed on disk through the `StorageService` abstraction.
- The full HTTP API was exercised with real `curl` requests, including RBAC denials
  (401/403) at every step.
- Probable-duplicate detection was validated against this repository's real content:
  34 comparable files, two genuine near-duplicate pairs found (0.99 and 0.93), zero
  false positives.
- The Filesystem Agent protocol was verified end-to-end (`npm run verify:agent`):
  every operation type through `AgentStorageService`, plus confirmation that path
  traversal and out-of-scope paths are refused on both sides.

## Frontend verification

- `npm run build` produces a clean production bundle. This caught a real Tailwind v4
  incompatibility: `@apply` cannot reference another custom component class defined
  in the same `@layer components` block — fine in v3, rejected by v4 as an "unknown
  utility class". Fixed by inlining the shared utility list into each variant.
- A corrupted `node_modules` from an interrupted install caused a raw `Bus error` on
  `vite build`; isolated by testing a bare Vite install elsewhere, then fixed by a
  clean reinstall.
- No automated component tests exist yet — `npm run build` is the only automated
  check on the frontend.

## Known gaps (documented, not hidden)

- **`bulk_move`** is the one `job_type` with no processor — superseded by
  `bulk_rename`, which already carries a new folder via `proposed_relative_dir`
  (docs/06 §6.1).
- **Version detection suggests, never applies.** It records a `version.suggested`
  audit entry rather than writing `document_versions` rows, because docs/01 §1.3
  forbids resolving a Version relationship without a human confirming.
- **Probable duplicates are capped at MEDIUM confidence** and are excluded from
  auto-resolve for the same reason. HIGH is reserved for provable hash matches.
- **Similarity candidate selection is bounded** (300 same-extension files per check),
  a deliberate recall/cost trade-off documented in `fileRepository`.
- **The desktop agent has no installer**, no code signing and no auto-update, and
  transfers file bytes base64-encoded in one operation result (64 MB cap) rather than
  in chunks. See `desktop-agent/README.md`.
- **The AI tiers have no automated tests** — they need a live `GEMINI_API_KEY`. Only
  the free rule tiers are unit-tested.
- **pbix data models are not parsed** — the xVelocity blob would need the Analysis
  Services engine (docs/07).
