// Canonical filename generation.
//
// Redesigned after real-world feedback: the original scheme was
// [Subject]_[DocumentType]_[Period]_[Version] (docs/03-taxonomy.md §3.6) --
// e.g. "Finance_AnnualBudget_2024_v1". That's a fine SORTING key, but a
// terrible NAME once someone has hundreds of finance files: it tells you
// the bucket, not what the document actually is, and it re-states
// information that (once folder-based organization exists) is already
// captured by where the file lives. What a person actually wants from a
// filename is what they'd type if they were naming it themselves after
// reading it: "Letter from Mom", "Annual Returns 2024", the book's actual
// title. That's exactly what Gemini's short_title is for (or, better, the
// document's own embedded title if it has one -- see geminiClassifier.js
// and the pdf/docx/pptx/xlsx extractors, which now surface `title` from
// file metadata).
//
// New priority, most to least preferred:
//   1. A real title (embedded metadata title or Gemini's own read of the
//      content) -- used almost verbatim, lightly disambiguated with a date
//      or identifier ONLY if that specific fact isn't already in the title.
//   2. AI-extracted entities alone (party/date/identifier), if a title
//      genuinely couldn't be produced but Gemini still found structured
//      facts -- rare in practice now, kept as a defensive fallback.
//   3. The old Subject_DocumentType_Period bucket scheme -- ONLY when
//      there's no AI signal at all (no GEMINI_API_KEY configured, or the
//      call failed), so the system still degrades usefully rather than
//      refusing to name anything.
// A version suffix is only added when it's an actual version bump
// (versionNumber > 1) -- stamping every first-time rename with "_v1" was
// pure noise nothing downstream currently uses.
// Unicode-aware: keeps any script's letters/numbers (Arabic, Hebrew, French
// accents, CJK, etc.) and strips only punctuation/whitespace/separators.
// The old version restricted to [a-zA-Z0-9] -- fine for English, but it
// silently deleted every character of an Arabic or Hebrew party name/
// identifier and mangled French accents ("Résumé" -> "Rsum"), which is
// exactly the kind of unwanted transformation the title-preservation
// requirement below is about. \p{L}/\p{N} match "letter"/"number" in ANY
// script (requires the "u" flag).
const { capFilenameLength } = require("../utils/filenameSafety");

function sanitizeSegment(text) {
  return String(text || "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

/**
 * Like sanitizeSegment, but for natural-language titles where word
 * boundaries matter for readability: "Letter from Mom" must not collapse
 * into "LetterfromMom". Spaces/punctuation become single underscores
 * instead of being deleted outright.
 */
function sanitizeTitle(text) {
  return String(text || "")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function extractPeriod(filename) {
  const match = filename.match(/(20\d{2})/);
  return match ? match[1] : null;
}

/**
 * @param {object} params
 * @param {{name:string}|null} params.subject
 * @param {{code:string}|null} params.documentType
 * @param {string} params.filenameOriginal
 * @param {string} params.extension
 * @param {number} [params.versionNumber]
 * @param {{party:?string, dateOrPeriod:?string, identifier:?string}|null} [params.entities]
 * @param {string|null} [params.shortTitle]
 *   The best available real title for this document -- either the AI
 *   tier's understanding of the content, or an embedded document title
 *   metadata field, whichever generateNamesProcessor decided was better.
 */
function buildCanonicalName({
  subject,
  documentType,
  filenameOriginal,
  extension,
  versionNumber = 1,
  entities = null,
  shortTitle = null,
}) {
  const segments = [];
  const hasEntities = entities && (entities.party || entities.dateOrPeriod || entities.identifier);
  const cleanTitle = shortTitle ? sanitizeTitle(shortTitle) : "";

  if (cleanTitle) {
    segments.push(cleanTitle);

    // Only append a date/identifier if it isn't already effectively part
    // of the title -- Gemini's title often already says "Annual Returns
    // 2024", and appending "2024" again would be exactly the kind of
    // redundant noise this redesign is trying to get rid of.
    const period = entities?.dateOrPeriod || extractPeriod(filenameOriginal);
    if (period && !cleanTitle.toLowerCase().includes(String(period).toLowerCase().replace(/[^a-z0-9]/g, ""))) {
      segments.push(sanitizeSegment(String(period)));
    }
    if (entities?.identifier && !cleanTitle.toLowerCase().includes(String(entities.identifier).toLowerCase())) {
      segments.push(sanitizeSegment(entities.identifier));
    }
  } else if (hasEntities) {
    if (documentType) segments.push(sanitizeSegment(documentType.code));
    else if (subject) segments.push(sanitizeSegment(subject.name));

    if (entities.party) segments.push(sanitizeSegment(entities.party));

    if (entities.dateOrPeriod) {
      segments.push(sanitizeSegment(entities.dateOrPeriod));
    } else {
      const period = extractPeriod(filenameOriginal);
      if (period) segments.push(period);
    }

    if (entities.identifier) segments.push(sanitizeSegment(entities.identifier));
  } else {
    // Last-resort bucket naming -- only reached when there's no AI signal
    // at all. Dedupe subject/documentType if they'd otherwise repeat the
    // same word (e.g. subject "Certificates" + document type "Certificate").
    const subjectSeg = subject ? sanitizeSegment(subject.name) : null;
    const docTypeSeg = documentType ? sanitizeSegment(documentType.code) : null;

    if (subjectSeg) segments.push(subjectSeg);
    const isDuplicateOfSubject =
      docTypeSeg && subjectSeg && docTypeSeg.toLowerCase().replace(/s$/, "") === subjectSeg.toLowerCase().replace(/s$/, "");
    if (docTypeSeg && !isDuplicateOfSubject) segments.push(docTypeSeg);

    const period = extractPeriod(filenameOriginal);
    if (period) segments.push(period);
  }

  if (versionNumber > 1) segments.push(`v${versionNumber}`);

  const base = segments.filter(Boolean).join("_");
  const ext = (extension || "").replace(/^\./, "");
  const composed = ext ? `${base}.${ext}` : base;

  // Bounded length (task #46). A canonical name built from a long AI title
  // plus a subject, a document type and a period can run well past 200
  // characters, and the mirror then tries to create
  //   <MIRROR_ROOT>\<Subject>\<Category>\<that name>.lnk
  // which blows through Windows' 260-char MAX_PATH. WScript.Shell reports
  // that as "Value does not fall within the expected range", so the visible
  // symptom is a handful of shortcuts silently missing from the organized
  // folder with an error that names neither the file nor the cause.
  //
  // Capping here rather than in the shortcut writer fixes it at the source:
  // the name in the database, the name in the UI and the name of the
  // shortcut stay the same string, which is the property that makes the
  // mirror browsable. Truncation keeps the extension (see capFilenameLength)
  // because the extension is what decides how the file opens.
  return capFilenameLength(composed);
}

/** Folder-safe version of sanitizeTitle -- same illegal-character stripping,
 * but keeps spaces as spaces (real folders like "Program Files" are fine
 * with spaces; underscore-joining a folder name is unnecessary noise). */
function sanitizeFolderSegment(name) {
  return String(name || "")
    .replace(/[\\/:*?"<>|]/g, "")
    .trim();
}

/**
 * Turns a Subject's root-to-leaf ancestor chain (subjectRepository.getAncestorChain)
 * into a relative folder path, e.g. [{name:"Finance"},{name:"Budgets"}] ->
 * "Finance/Budgets". Returns null for an empty/invalid chain rather than
 * an empty string, so callers can treat "no folder" and "root folder"
 * unambiguously.
 */
function buildTargetRelativeDir(ancestorChain) {
  if (!Array.isArray(ancestorChain) || ancestorChain.length === 0) return null;
  const segments = ancestorChain.map((a) => sanitizeFolderSegment(a.name)).filter(Boolean);
  return segments.length ? segments.join("/") : null;
}

module.exports = {
  buildCanonicalName, extractPeriod, sanitizeSegment, sanitizeTitle,
  sanitizeFolderSegment, buildTargetRelativeDir,
};
