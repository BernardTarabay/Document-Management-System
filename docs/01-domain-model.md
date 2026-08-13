# Phase 1 — Domain Analysis

This document defines the core domain concepts for the platform and how they relate to
each other. Every later phase (taxonomy, storage, database, API) is built on these
definitions, so they are treated as load-bearing, not decorative.

## 1.1 The five core concepts

### Physical File
A physical file is a concrete sequence of bytes at a specific path on some storage
location, at some point in time. It has an OS-level identity: path, size, timestamps,
extension. Two physical files can be byte-for-byte identical (same hash) while still
being two separate rows in the system, because they occupy two separate locations and
can independently disappear, move, or be corrupted.

A physical file, by itself, carries **no knowledge of meaning**. It does not know what
subject it belongs to or whether it is "the same document" as another file.

### Document
A Document is a logical, human-meaningful identity: "the 2025 annual budget", "my
passport", "the Smith contract". A Document is an organizing concept, not a file. It
persists even if every physical file that ever represented it is deleted, moved, or
replaced. A Document is what a user searches for, browses to, and reasons about.

A Document has zero or more **Document Versions**. A brand-new, unclassified file is not
yet a Document — it is a File awaiting review. Documents are created (explicitly or via
confirmed automation) once a file has been understood.

### Document Version
A Document Version is one point-in-time representation of a Document. "Budget_2025.xlsx"
and "Budget_2025_v2.xlsx" may be two versions of the same Document ("2025 Annual
Budget"), or they may turn out to be two different Documents entirely (see 1.3). A
Version is backed by exactly one primary File. A Document has at most one *current*
Version at a time; older versions are retained, not deleted.

### Document Metadata
Metadata is everything the system knows *about* a File or Document without necessarily
understanding its full content: MIME type, author, page count, worksheet names, creation
date, extracted keywords, detected language, embedded document properties, etc. Metadata
is extracted mechanically and is always provisional — it feeds classification and naming,
but it is not itself the Document's identity.

### Document Identity
Document Identity is the answer to "is this the same document as that one?" Identity is
established through a combination of signals (hash, extracted text similarity, metadata,
filename heuristics, user confirmation) and is never assumed from a single weak signal
such as filename similarity alone. Identity decisions have a confidence level and, below
a threshold, require human review (see Phase 9 human-review workflow, built in a later
phase).

## 1.2 Why these must stay distinct

Conflating File and Document is the single most common design mistake in naive file
managers, and it is exactly what this project must avoid:

- If "File" and "Document" are the same row, you cannot represent two identical files in
  two locations without either duplicating the Document or losing one File.
- If "Version" is not separate from "Document," you cannot keep history — a rename or
  re-save destroys the past.
- If "Identity" is not modeled as a deliberate, confidence-scored decision, the system
  will silently merge unrelated documents that merely share a filename pattern.

## 1.3 Duplicate, Probable Duplicate, Related, Version — disambiguated

These four relationships are frequently confused in casual file management and must be
kept semantically and structurally distinct:

| Relationship | Definition | Primary signal | Structural home |
|---|---|---|---|
| **Exact Duplicate** | Identical byte content | SHA-256 match | `duplicate_groups` (type=exact) |
| **Probable Duplicate** | Strong evidence of the same content despite non-identical bytes (re-saved, re-exported, watermark added, metadata stripped) | Content/text similarity, size/structure proximity, perceptual hash | `duplicate_groups` (type=probable) |
| **Related Document** | Same subject, intentionally separate documents (e.g., an invoice and its supporting receipt) | Shared subject/tag + explicit or inferred relationship, never content identity | `related_documents` |
| **Version** | Same underlying Document at different points in time | Combination of filename pattern, metadata, date, content diff, explicit confirmation | `document_versions` |

A pair of files can only ever occupy **one** of these relationships at a time for a given
pair, and the system must never auto-resolve Probable Duplicate or Version relationships
above the "suggest" confidence tier without a human confirming (see 1.5).

## 1.4 Storage semantics

A File's bytes live in exactly one **Storage Location** (local disk, NAS, server volume,
future cloud/object storage) at a time. The database never stores file bytes — only the
path within that location, plus enough hash/metadata to detect drift. Storage Locations
that are not directly reachable by the backend (e.g., a user's home machine) require a
**Filesystem Agent** to broker operations; Storage Locations directly reachable by the
backend (e.g., an attached server volume) do not require an agent. This is a property of
the Storage Location, not a global architectural assumption — the system may have some
locations with agents and some without, simultaneously.

## 1.5 Confidence as a first-class concept

Every automated decision this system makes — classification, naming, duplicate
detection, version detection, subject assignment — produces a **confidence level**
(HIGH / MEDIUM / LOW) plus a raw numeric score. Confidence determines what the system is
allowed to do unattended:

- **HIGH** — may be auto-applied if organizational policy allows it, but the action and
  its evidence are still recorded in the audit log and remain reversible.
- **MEDIUM** — surfaced to a user as a suggestion; never applied without explicit
  approval.
- **LOW** — never auto-applied or even strongly suggested; flagged for manual
  investigation.

This is why `confidence_level` and `confidence_score` appear on nearly every "result"
table in the Phase 5 schema (classification_results, rename_proposals, document_versions,
duplicate_groups, document_subjects).

## 1.6 Tag vs Subject vs Category

- **Subject/Category/Subcategory** form a hierarchy (see Phase 3) and represent *where a
  document lives* in the primary organizational tree. A document has one primary subject
  placement (with optional secondary placements).
- **Tags** are flat, non-hierarchical, many-to-many labels layered on top for
  cross-cutting concerns that don't fit a single branch of the hierarchy (e.g.,
  `needs-signature`, `confidential`, `2025`).

## 1.7 Summary of entities implied by this analysis

Independent identity (own table, own lifecycle): User, Role, Permission, StorageLocation,
FilesystemAgent, File, FileHash, FileMetadata, FileContent(text), Document,
DocumentVersion, Subject (hierarchical), Tag, DocumentType, DuplicateGroup,
ProcessingJob, RenameProposal, ClassificationResult, AuditLog, RefreshToken.

Relationship-only (junction) tables: document_subjects, document_tags,
duplicate_group_members, related_documents, role_permissions, user_roles,
processing_job_items.

This list is carried forward and formalized as the Phase 5 schema.
