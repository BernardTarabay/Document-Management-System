# Phase 2 — Standardized Terminology

This is the controlled vocabulary for the entire project. Code, database columns, API
fields, UI copy, and documentation must all use these terms consistently. Where a term
has a tempting synonym, the synonym is listed explicitly as "do not use" so the codebase
doesn't drift into inconsistent naming the same way the source file repository did.

## 1.1 Filename / naming vocabulary

| Term | Definition |
|---|---|
| **Original Filename** | The filename exactly as found on disk at ingestion time. Immutable historical fact, retained forever even after renaming. |
| **Canonical Filename** | The deterministic, system-generated filename following the naming convention (Phase 3/9). Applied to the physical file only after a Rename Proposal is approved. |
| **Display Name** | A free-text, human-friendly label shown in the UI. May differ from the canonical filename (e.g., "2025 Annual Budget" vs `Finance_Budget-Annual_2025_v1.xlsx`). Editable by users without touching the physical file. |
| **Document Identity** | See Phase 1 §1.1 — the logical "sameness" of a document across versions/files. |

*Do not use:* "real name," "actual name," "true filename" — ambiguous, avoid in code and docs.

## 1.2 File / Document vocabulary

| Term | Definition |
|---|---|
| **File** | A physical, byte-level artifact at a path on a Storage Location. |
| **Document** | The logical entity a File (or several Files, over time) represents. |
| **Document Version** | One point-in-time state of a Document, backed by one primary File. |
| **Current Version** | The Document Version considered up to date / authoritative right now. |
| **Superseded Version** | A Version that has been replaced by a newer Current Version but is retained for history. |

*Do not use:* "file" and "document" interchangeably in code — this is the exact
conflation Phase 1 exists to prevent.

## 1.3 Duplicate vocabulary

| Term | Definition |
|---|---|
| **Exact Duplicate** | Byte-identical content (SHA-256 match). |
| **Probable Duplicate** | Very likely the same content, not byte-identical. |
| **Related Document** | Same subject, deliberately distinct documents. |
| **Duplicate Group** | The set of Files considered exact or probable duplicates of one another. |
| **Canonical File** | Within a Duplicate Group, the File chosen (by policy or user) as the one to keep active; others are archived, not deleted, unless the user explicitly deletes them. |

## 1.4 Classification vocabulary

| Term | Definition |
|---|---|
| **Subject** | Top-level branch of the organizational hierarchy (e.g., Finance, Academic). |
| **Category** | Second-level branch under a Subject (e.g., Finance → Budgets). |
| **Subcategory** | Third-level branch under a Category. |
| **Tag** | Flat, non-hierarchical, many-to-many label. |
| **Document Type** | What kind of document this is, independent of subject (e.g., Invoice, Report, Certificate, Spreadsheet Model). A Document Type can appear under many Subjects. |
| **Classification Result** | A single automated attempt to assign Subject/Category/Document Type to a File, with a confidence score. |

## 1.5 Processing vocabulary

| Term | Definition |
|---|---|
| **Ingestion** | The act of registering a previously-unknown physical file into the system (creating a File row) without yet interpreting its meaning. |
| **Processing Job** | An asynchronous, trackable unit of background work (hash, extract, classify, etc.), always represented as a row, never as a bare in-memory task. |
| **Job Status** | One of: `queued`, `running`, `completed`, `failed`, `cancelled`, `retrying`. |
| **Rename Proposal** | A system-generated suggestion to change a File's on-disk name to its Canonical Filename. Never applied automatically without meeting policy + confidence requirements. |
| **Confidence Level** | Coarse bucket — `high`, `medium`, `low` — governing what automation is allowed to do unattended. |
| **Confidence Score** | The underlying numeric value (0.0–1.0) a Confidence Level is derived from. |

## 1.6 Storage vocabulary

| Term | Definition |
|---|---|
| **Storage Location** | A registered place where physical files live (local disk, NAS, server volume, future cloud/object storage). |
| **Filesystem Agent** | An authenticated Electron process that brokers filesystem operations on a Storage Location the backend cannot reach directly. |
| **Repository Scan** | A pass over a Storage Location (full or incremental) that reconciles database state with actual filesystem state (new, missing, moved, changed files). |
| **Sync State** | The reconciliation status of a File relative to the filesystem: `active` (confirmed present), `missing` (expected, not found), `moved`, `changed` (hash/size/mtime drift detected). |

## 1.7 Access / security vocabulary

| Term | Definition |
|---|---|
| **Role** | A named bundle of Permissions assigned to Users (e.g., Admin, Manager, User, Viewer). |
| **Permission** | A single, independently checkable capability (e.g., `document.rename`, `duplicate.merge`). |
| **Audit Log Entry** | An immutable record of a state-changing action: who, what, on which entity, previous/new state, when, and result. |

This glossary is the single source of truth for naming; if a future phase needs a new
term, it is added here before it is used in code.
