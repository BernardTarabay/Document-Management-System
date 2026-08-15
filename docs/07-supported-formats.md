# Phase 6/8 addendum — Supported File Formats (finalized after investigation)

Spec §7 asks for the supported-format list to be finalized only after investigating what
can reliably be extracted from each format, not assumed up front. Here's what that
investigation concluded, and why. Formats are detected by content signature first,
extension second (`backend/src/utils/fileSignature.js`) -- see spec §7's explicit
requirement not to rely on extensions alone.

| Format | Signature detection | Extraction status | Notes |
|---|---|---|---|
| `.pdf` | `%PDF` magic bytes | **Full** — text + metadata (`pdfExtractor.js`) | Scanned/image-only PDFs yield little/no text; that's a content limitation, not a bug — classification will see empty text and score accordingly. |
| `.xlsx` / `.xlsm` | zip + `xl/workbook.xml` entry | **Full** — sheet names, headers, bounded cell sample, formula count (`xlsxExtractor.js`) | Cell sampling is capped (20 rows x 20 cols per sheet) so a huge workbook doesn't blow up a worker process; this is a deliberate bound, documented in the module. |
| `.docx` | zip + `word/document.xml` entry | **Full** — body text + docProps metadata (`docxExtractor.js`) | Lightweight regex-based text strip rather than a full OOXML parser — fast, sufficient for search/classification, not a layout-faithful export. |
| `.pptx` | zip + `ppt/presentation.xml` entry | **Full** — per-slide text + slide count (`pptxExtractor.js`) | Same lightweight approach as docx. |
| `.pbix` | zip + `DataModel`/`Report/Layout` entries | **Investigation-only** — container metadata + Report/Layout visible strings; the actual data model (measures/tables/relationships) is a proprietary xVelocity/SSAS binary blob and is deliberately **not** parsed (`pbixExtractor.js`) | This is the case spec §8 specifically warns about: a pbix is a zip, like xlsx, but is not structurally a spreadsheet — treating it as one would silently produce garbage. Full data-model introspection would require the Analysis Services engine and is out of scope. |
| `.doc` / `.xls` / `.ppt` (legacy OLE-CFB) | `D0 CF 11 E0 A1 B1 1A E1` magic bytes | **Full** — text + `SummaryInformation` metadata (`oleCfbExtractor.js`) | All three share one container signature, so dispatch is by *which document stream the container holds* (`WordDocument` / `Workbook` / `PowerPoint Document`), not by extension — a `.doc` renamed `.xls` still extracts correctly. See "Legacy formats" below for what each parser does. |
| Anything else | no known signature match | **Ingested, flagged unsupported** | `extractContent()` never throws for an unrecognized format — it returns a structured "unsupported" result so the file still gets a File row, a hash, and is browsable; it simply has no extracted text/metadata to search on yet. |

## Legacy formats (OLE-CFB)

`utils/cfb.js` reads the compound-file container itself (FAT, mini-FAT, directory),
hand-written rather than via SheetJS's `cfb` package — same "well-documented format,
no vendor dependency" reasoning as using raw `fetch` instead of the Google
SDKs. Three format readers sit on top of it:

- **`.doc`** (`ole/docText.js`) reads the **piece table** (FIB → Clx → PlcPcd) rather
  than scanning the stream for printable runs. This matters: the WordDocument stream
  also contains *deleted* text still sitting in the file, plus field codes and
  formatting structures. A printable-run scan — what most quick "doc to text" hacks
  do — therefore produces text the document does not actually say, and that text
  would feed straight into classification, naming and duplicate detection. Table cell
  marks (`0x07`) become whitespace, not nothing, so adjacent cells don't fuse into
  invented tokens.
- **`.xls`** (`ole/xlsText.js`) parses the BIFF record stream: the shared string
  table, sheet names, and inline label cells. It handles strings split across
  `CONTINUE` record boundaries, where the encoding can flip between 8-bit and 16-bit
  *mid-string* — the thing a naive SST parser gets wrong on the first large workbook.
  Header/footer format codes (`&C`, `&P`, …) are stripped as layout directives.
- **`.ppt`** (`ole/pptText.js`) walks the record tree collecting text atoms, and
  **skips the slide master**. Master placeholder prompts ("Click to edit the title
  text format") are identical in every deck built from a stock template, so indexing
  them would make every `.ppt` look similar to every other one — feeding false
  positives directly into probable-duplicate detection.

Text is decoded as **CP1252**, not Latin-1. The two agree everywhere except
`0x80`–`0x9F`, which is exactly where curly quotes, the em dash and the ellipsis
live; decoding those as Latin-1 yields C1 control characters that then get stripped,
silently eating punctuation from real documents.

Verified against genuine LibreOffice-produced binaries (`tests/oleCfb.test.js`,
fixtures documented in `tests/fixtures/README.md`) — round-tripping the same source
document through both the modern and legacy extractors gave 99% word-level recall for
`.doc` and 100% for `.xls`.

## Why this shape

- **Never block ingestion on extraction.** A file that can't be parsed is still hashed,
  still has a `files` row, still shows up in search-by-filename. Extraction failure is
  local to the `file_content`/`file_metadata` rows, per the Phase 6 idempotency rules.
- **Modular by construction.** `extraction/index.js` is a subtype → module map. Adding
  a format is one line there plus a module exposing `extract(buffer)` — that's exactly
  how OLE-CFB was added, with no change to any job processor or service. A real
  xVelocity parser for pbix would be the same shape.
- **Bounded work per file.** Every extractor caps what it reads (xlsx row/col sampling,
  pbix string-walk cap of 500 strings) so a single pathological file can't stall a
  worker indefinitely or exhaust memory — consistent with the scalability requirements
  in spec §30.
