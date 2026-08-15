# Phase 6 — Processing Pipeline Design

This defines the pipeline every ingested file moves through, how stages hand off to
each other, and the failure/idempotency rules that make it safe to run against a very
large, pre-existing repository without ever blocking an HTTP request (spec §18, §30).

## 6.1 Stage sequence

```
Discovery
  -> Ingestion
  -> Hashing
  -> Metadata extraction
  -> Content extraction
  -> Classification
  -> Duplicate detection
  -> Naming proposal
  -> Human review
  -> Optional filesystem operation (rename / move / archive)
```

Each stage is a distinct `job_type` (see `backend/src/models/enums.js` / migration 001)
and a distinct row-producing operation — nothing here is a single monolithic "process
the file" function. That separation is deliberate: a repository scan can discover
50,000 files and enqueue 50,000 hash jobs without any single job needing to know about
metadata extraction, classification, or naming.

| Stage | Job type | Reads | Writes | Implemented in Phase 7? |
|---|---|---|---|---|
| Discovery + Ingestion | `scan` | Storage Location filesystem | `files`, `filesystem_scans` | Yes |
| Hashing | `hash` | File bytes (streamed) | `files.sha256_hash`, `file_hashes` | Yes |
| Metadata extraction | `extract_metadata` | File bytes | `file_metadata` | Yes |
| Content extraction | `extract_text` | File bytes | `file_content` | Yes |
| Classification | `classify` | `file_metadata`, `file_content`, filename | `classification_results` | Yes |
| Duplicate detection (exact) | `detect_duplicates` (default `phase: 'exact'`) | `files.sha256_hash` | `duplicate_groups` (type `exact`), `duplicate_group_members` | Yes |
| Duplicate detection (probable) | `detect_duplicates` with `phase: 'probable'` | `file_content.extracted_text` | `duplicate_groups` (type `probable`, always OPEN) | Yes — content similarity, MEDIUM confidence ceiling, never auto-resolved |
| Version detection | `detect_versions` | filenames + `file_content.extracted_text` | `audit_logs` (`version.suggested`) — **not** `document_versions` | Yes — suggestion only; writing a version row is a human action (docs/01 §1.3) |
| Naming proposal | `generate_names` | `documents`, `subjects`, `document_types`, taxonomy | `rename_proposals` | Yes |
| Human review | (no job — UI/API) | `rename_proposals`, `classification_results` | approval/rejection status | Phase 9/11 |
| Filesystem operation | `bulk_rename` | Approved proposals | physical file + `files.current_path` | yes -- a proposal can rename, move (`proposed_relative_dir`), or both; `bulk_move` as a separate job type was superseded by this and still has no processor |
| Reprocessing | `reindex` | existing `files` rows | re-enqueues extraction/classification/naming stages | Yes — re-runs analysis without re-walking the filesystem |

### Duplicate and version detection — why they run where they do

Exact detection chains off `hash`, because a SHA-256 match is knowable the moment
hashing finishes. Probable-duplicate and version detection chain off `extract_text`
instead, because both need extracted text that does not exist yet at hashing time.
They share one scoring engine (`services/similarityService.js`): Jaccard similarity
over 5-word shingles, chosen because the failure mode being detected — a re-saved,
re-exported, watermarked or metadata-stripped copy — changes bytes and layout
everywhere while leaving nearly every word sequence intact.

Two rules constrain both, from docs/01-domain-model.md §1.3 and §1.5:

- **Confidence is capped at MEDIUM.** HIGH is reserved for exact hash matches, which
  are provable. `autoResolveDuplicatesProcessor` therefore filters to `exact` groups,
  and `duplicateGroupService.autoResolveGroup` refuses non-exact groups independently
  — its canonical-pick heuristic assumes byte-identical members, which is only true
  for exact groups.
- **A filename is never sufficient evidence.** Version detection weights content at
  0.7 and the filename at 0.3 specifically so a name match alone cannot clear the
  threshold. docs/01 §1.2 warns that filename-pattern rules "silently merge unrelated
  documents"; requiring corroborating text is what prevents that. Files with too
  little extracted text to compare are reported LOW confidence, never acted on.

## 6.2 Why stages are separate jobs, not one pipeline function

1. **Incremental processing (spec §6, §30).** A 500,000-file repository cannot be
   walked and fully processed in one pass held in memory. Discovery enqueues one `scan`
   job; that job enqueues one `hash` job per newly-discovered file and returns
   immediately. Nothing waits on anything else synchronously.
2. **Independent retry.** If content extraction fails for a corrupt PDF, that failure
   is isolated to one `extract_text` job/`processing_job_item` row. Hashing,
   metadata, and classification for that same file are unaffected and are not
   re-run.
3. **Confidence gating happens between stages, not inside them.** Classification and
   naming both read already-committed results from earlier stages (metadata, content,
   hash) rather than re-deriving them, so a low-confidence classification never
   silently degrades a high-confidence hash.

## 6.3 Idempotency rules

Every job processor in `backend/src/jobs/processors/` follows the same contract:

- **Re-running a stage for the same file must converge, not duplicate.** Hashing
  upserts on `(file_id, algorithm)`. Metadata extraction upserts on `file_id` (1:1).
  Content extraction upserts on `file_id`. Classification *inserts* a new
  `classification_results` row per run (history is kept — see 6.5) but never mutates
  a previous result.
- **A job never assumes the file still exists.** Every processor re-reads the `files`
  row at the top of its handler; if `status` is no longer `active` (deleted/missing
  since the job was queued), the processor marks its `processing_job_items` row
  `skipped` rather than erroring.
- **A job never blocks on another job type.** Chaining (e.g., "after hash, run
  metadata extraction") is done by explicitly enqueuing the next stage's job at the
  end of a successful processor run, not by one processor calling another's logic
  in-process. This keeps each queue independently scalable and inspectable.

## 6.4 Confidence gating recap (Phase 1 §1.5, made concrete here)

`classify` and `generate_names` are the two stages that produce user-facing automated
decisions. Both write a `confidence_level`. What happens next is a policy decision made
above the job layer (Phase 9/10 services), but the pipeline guarantees the data needed
to enforce it is always present:

- HIGH → eligible for auto-apply *if* policy allows (still logged to `audit_logs`,
  still reversible).
- MEDIUM → written as a proposal (`rename_proposals` / `classification_results`,
  status `pending`/`proposed`); never applied by a job.
- LOW → written and left for manual triage; the pipeline does not retry indefinitely
  or escalate on its own.

## 6.5 Why classification keeps history instead of overwriting

A `classification_results` row is never updated in place by automation — a new row is
inserted per classification attempt (e.g., after a re-extraction improves text quality).
`documents.document_type_id` and `document_subjects` are only ever updated by an
explicit review action (human, or a policy-permitted high-confidence auto-apply), which
is recorded in `audit_logs` with the previous and new state. This means "why does this
document have this type" is always answerable from the audit trail plus the
classification history, never just "the algorithm said so once."

## 6.6 Failure handling

- A processor throwing marks its `processing_jobs.status = 'failed'` (single-file jobs)
  or the specific `processing_job_items.status = 'failed'` (bulk jobs) with
  `error_message` populated — the job/item is never silently dropped.
- BullMQ's built-in retry/backoff (Phase 7) is used for transient failures (e.g., a
  storage location briefly unreachable); it is not used to paper over deterministic
  failures like a corrupt file, which fail once, get recorded, and wait for human
  triage rather than retrying forever.
- `processing_job_items` gives bulk operations the "96 high-confidence / 3 review / 1
  unable to classify" reporting shape required by spec §22 for free — it's a per-file
  status row, not a derived count.

## 6.7 Storage access in the pipeline

Every processor that needs file bytes goes through the `StorageService` interface
fixed in Phase 4 (`docs/04-storage-architecture.md` §4.3), never through a raw `fs`
call scattered in job code. Phase 7 ships `LocalStorageService` (direct filesystem
access — used when the backend host can already reach the Storage Location). The
`AgentStorageService` implementation (routing through a Filesystem Agent) is Phase 12
work; the interface is already shaped to accommodate it without changing any job
processor.

