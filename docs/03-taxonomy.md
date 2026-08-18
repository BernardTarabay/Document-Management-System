# Phase 3 — Document Taxonomy & Naming Convention

## 3.1 Design constraint

The spec is explicit: **the domain of a document must not affect the architecture.**
Concretely, this means the taxonomy is not modeled as separate tables per domain
(`finance_documents`, `academic_documents`, ...). It is modeled once, generically, as a
self-referential hierarchy (`subjects`, see Phase 5), and every domain — Finance,
Academic, Administrative, Legal, Religious, Personal, whatever a given repository
contains — is simply *data* inside that same structure. New domains never require a
schema change or new code path.

## 3.2 Hierarchy shape

```
Subject
  └── Category
        └── Subcategory
              └── Document (via document_subjects, many-to-many)
```

Implementation notes:

- One table (`subjects`) with `parent_id` (self-referential) and a `level` enum
  (`subject | category | subcategory`) rather than three separate tables. This keeps the
  depth flexible — a repository that only needs Subject → Category can leave
  Subcategory unused; a future need for a 4th level is a data change, not a migration.
- A `materialized_path` column (e.g. `finance.budgets.annual`) is maintained alongside
  `parent_id` so subtree queries don't require recursive CTEs on the hot path (search,
  browse). `parent_id` remains the source of truth; `materialized_path` is denormalized
  and rebuilt on write.
- A Document's placement in the hierarchy is **many-to-many** (`document_subjects`), not
  a foreign key on `documents`, because the spec explicitly requires documents to
  optionally carry multiple relevant subjects. Exactly one row per document may be
  flagged `relevance = 'primary'`; this is what drives the canonical filename and default
  browse location. Others are `secondary`.

## 3.3 Example taxonomies (illustrative only — not hard-coded)

```
Finance            Academic           Administrative
├── Budgets        ├── Courses        ├── Government
├── Taxes          ├── Research       ├── Applications
├── Invoices       ├── Exams          ├── Certificates
└── Reports        └── Projects       └── Legal
```

These are seed data (see `backend/seeds/`), not schema. A deployment for a law firm, a
church, or a personal archive seeds an entirely different tree with zero code changes.

## 3.4 Document Type — orthogonal to Subject

`document_types` (Invoice, Report, Certificate, Budget, Exam, Contract, Spreadsheet
Model, Presentation, ...) is a **separate** dimension from Subject. The same Document
Type ("Report") can appear under Finance, Academic, or Administrative. This avoids
duplicating "Report" as a leaf under every branch and lets naming/classification reason
about "what kind of thing is this" independently of "whose business area is it."

**How the type is assigned — revised after real-world use.** The rule tier deliberately
does **not** read document type out of the body text, and this asymmetry with Subject is
the point rather than an oversight. Subject asks *what is this about*, which prose
answers honestly. Document type asks *what kind of thing is this*, which prose does not
answer at all: the file that exposed this says "presentation" four times, every one of
them about a person giving one, and a novel matched type "Book" on the substrings inside
"playbook" and "fantasy books". No lexical rule separates "mentions a presentation" from
"is a presentation". So the rule tier reads only two signals — the filename a person
chose, and an extension that settles the question outright (`.pptx` **is** a slide deck;
`.pdf` and `.docx` are containers and imply nothing, and spreadsheets are deliberately
unmapped because the seeded type is the narrower "Spreadsheet Model"). Everything else
comes from the AI tier, which actually reads the document, or from a human setting it on
the Files page. The rule tier assigning *no* type is the expected outcome on a
French/Arabic corpus with an English seed list, and is preferred to a confident wrong one.

**Orthogonal axes must be independently writable.** Both axes live on one
`classification_results` row and every reader resolves a file's classification as the
*latest* row, so a writer that touched one axis and passed `null` for the other was not
adding information — it was deleting the other axis. Filing a document under a Subject
erased its Document Type; setting a Document Type dropped its Subject. Writers that
speak to only one axis now go through `classificationResultRepository.createPartial`,
where `undefined` means "keep what is there" and `null` still means "clear this".
Every row is therefore a complete snapshot, which is what "latest row wins" already
assumed everywhere downstream.

## 3.5 Tags

Tags are the escape hatch for anything that doesn't belong in the hierarchy or the
type system: temporal markers, workflow state, sensitivity, ad hoc project labels.
Flat, many-to-many, no approval workflow beyond normal edit permissions.

## 3.6 Naming convention

**Revised after real-world use.** The original scheme (below, kept as the fallback)
concatenated taxonomy fields:

```
[Subject]_[DocumentType]_[Period]_[Version].[Extension]
```

This is a good *sort key* but a bad *name*: once a repository has hundreds of Finance
documents, `Finance_AnnualBudget_2024_v1` doesn't tell a person which one this is any
better than the bucket it's already filed under would. It also produced genuinely wrong
names when a document coincidentally triggered two overlapping taxonomy matches (e.g. an
unrelated manual that happened to mention "certificate" once, renamed to
`Certificates_Certificate_v1` — see `classifyProcessor.js`/`namingService.js`).

The naming priority is now:

1. **A real title** — the document's own embedded title metadata (PDF `Title`, OOXML
   `dc:title`) when it's genuinely descriptive, or otherwise the AI tier's own read of
   the content (`file.ai_short_title`, docs/09-ai-classification.md). This is meant to be
   the equivalent of a person opening the file, reading it, and naming it themselves —
   "Letter from Mom", "Annual Returns 2024", a book's actual title — not a category
   label. Lightly disambiguated with a date or identifier only if that specific fact
   isn't already part of the title text.
2. **AI-extracted entities alone** (party/date/identifier), if the AI tier ran but
   couldn't produce a usable title — rare, kept as a defensive fallback.
3. **The bucket scheme above** — used only when there is no AI signal at all (no
   `GEMINI_API_KEY` configured, or the call failed), so the system still degrades to
   something useful rather than refusing to name the file.

Subject/category classification (`document_subjects`) still happens on every file
regardless of which naming tier fired — it's just no longer baked into the filename
text. It now drives folder placement instead: a classified Subject's ancestor chain
(subjectRepository.getAncestorChain) becomes a target folder (e.g. `Finance/Budgets`),
proposed via `rename_proposals.proposed_relative_dir` (migration 013) and applied
together with the rename by the same `bulk_rename` job -- see
docs/06-processing-pipeline.md §6.1. "Stored under Finance" and "named what it actually
is" are now two independent, complementary facts about a file rather than the same fact
said twice.

This convention is still deliberately data/service-driven (`NamingService`,
`services/namingService.js`) rather than hard-coded per caller, so it can be revised
again by changing the service rather than every call site.

## 3.7 Human review boundary

Taxonomy assignment (`document_subjects`) and Document Type assignment
(`classification_results` → `documents.document_type_id`) are both confidence-scored
per Phase 1 §1.5. Nothing here mandates full automation — low-confidence documents sit
in an "unclassified" state indefinitely until a human assigns them, which the schema
supports by making `document_type_id` and `document_subjects` nullable/optional at the
database level.
