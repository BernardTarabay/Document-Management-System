// Content and filename similarity -- the shared engine behind
// probable-duplicate detection and version detection (docs/01-domain-model.md
// §1.3). Both relationships answer "are these two files about the same
// underlying content?"; they differ only in what a match *means*, so the
// scoring lives here once and the two processors interpret it differently.
//
// Deliberately dependency-free and entirely pure: no DB, no network, no
// state. That keeps it unit-testable (tests/similarityService.test.js) and
// cheap enough to run over every candidate pair without an API call, in the
// same spirit as the rule tier of the two AI classifiers.
//
// The technique is Jaccard similarity over word k-shingles. It is chosen
// over a diff/edit-distance because the failure mode we care about is a
// document that was re-saved, re-exported, watermarked, or had its metadata
// stripped (docs/01 §1.3) -- those change bytes and layout everywhere while
// leaving nearly all of the word sequences intact. Edit distance on raw text
// would also be O(n*m), which is not viable across a whole repository.

const SHINGLE_SIZE = 5;

// Unicode-aware for the same reason namingService.js is: this repository's
// real content is French/Arabic/Hebrew. \p{L}/\p{N} match letters/numbers in
// any script; anything else is a separator.
const NON_WORD = /[^\p{L}\p{N}]+/gu;

/**
 * Lowercase, strip punctuation, collapse whitespace, split into words.
 * Normalization is what makes a re-export comparable to its original: the
 * two files' extracted text usually differs in whitespace and punctuation
 * long before it differs in words.
 */
function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(NON_WORD, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * FNV-1a, 32-bit. Shingles are hashed to integers rather than kept as
 * strings so a large document's shingle set stays small in memory -- a
 * 50k-word document produces 50k shingles, and holding those as joined
 * strings costs far more than holding them as numbers.
 */
function hashShingle(words) {
  let hash = 0x811c9dc5;
  const joined = words.join(" ");
  for (let i = 0; i < joined.length; i += 1) {
    hash ^= joined.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * The set of overlapping k-word sequences in the text. Documents shorter
 * than k shingle to a single entry covering the whole text, so very short
 * files still compare meaningfully instead of producing an empty set (which
 * would make every short file "identical" to every other).
 */
function shingleSet(text, k = SHINGLE_SIZE) {
  const words = tokenize(text);
  if (words.length === 0) return new Set();
  if (words.length <= k) return new Set([hashShingle(words)]);

  const set = new Set();
  for (let i = 0; i + k <= words.length; i += 1) {
    set.add(hashShingle(words.slice(i, i + k)));
  }
  return set;
}

/** |A ∩ B| / |A ∪ B|. Two empty sets are defined as 0, not 1 -- "we know
 * nothing about either file" must never read as "these are identical". */
function jaccard(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  for (const value of small) {
    if (large.has(value)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Convenience wrapper: raw text in, 0..1 similarity out. */
function textSimilarity(textA, textB, k = SHINGLE_SIZE) {
  return jaccard(shingleSet(textA, k), shingleSet(textB, k));
}

// A file with almost no extractable text can trivially reach a high Jaccard
// score against another near-empty file (two scanned covers with the same
// boilerplate header, say). Requiring a floor of real words before a
// similarity claim is allowed is what stops "both files extracted 6 words"
// from being reported as a probable duplicate.
const MIN_TOKENS_FOR_COMPARISON = 40;

function hasEnoughTextToCompare(text) {
  return tokenize(text).length >= MIN_TOKENS_FOR_COMPARISON;
}

// Thresholds map a raw score onto the confidence tiers in docs/01 §1.5.
// Note what is NOT here: a tier that permits automatic action. Probable
// duplicates and versions may never be auto-resolved above "suggest"
// without a human (docs/01 §1.3), so the ceiling is deliberately MEDIUM --
// HIGH is reserved for exact SHA-256 matches, which are provable.
const PROBABLE_DUPLICATE_THRESHOLD = 0.65;
const STRONG_SIMILARITY_THRESHOLD = 0.85;

function confidenceForScore(score) {
  if (score >= STRONG_SIMILARITY_THRESHOLD) return "medium";
  if (score >= PROBABLE_DUPLICATE_THRESHOLD) return "low";
  return null; // below the floor -- not a claim worth recording at all
}

// --- Filename / version heuristics --------------------------------------

// Version markers a human actually types.
//
// These use explicit letter/number lookarounds rather than \b, because \b is
// wrong here: "_" is a word character, so in "Report_v2" there is NO word
// boundary between "_" and "v" and a \bv anchor silently never matches.
// Underscore is by far the most common separator in this repository's
// filenames, so that bug would have disabled the whole heuristic.
// (?<![\p{L}\p{N}]) means "not immediately preceded by a letter or digit",
// which treats "_" as a separator, exactly as a human reads it.
const NOT_ALNUM_BEFORE = "(?<![\\p{L}\\p{N}])";
const NOT_ALNUM_AFTER = "(?![\\p{L}\\p{N}])";
const SEP = "[_\\s(-]*";

const VERSION_MARKERS = [
  // v2, ver 2, version 2.1
  new RegExp(`${SEP}${NOT_ALNUM_BEFORE}v(?:er|ersion)?[_\\s.-]*(\\d+(?:\\.\\d+)*)${NOT_ALNUM_AFTER}\\)?`, "giu"),
  // rev3, revision 3
  new RegExp(`${SEP}${NOT_ALNUM_BEFORE}(?:rev|revision)[_\\s.-]*(\\d+)${NOT_ALNUM_AFTER}\\)?`, "giu"),
  // "Report (2)" -- the OS "copy of an existing file" suffix
  /[_\s-]*\((\d+)\)/gu,
  // "Report copy", "Report copy 2"
  new RegExp(`${SEP}${NOT_ALNUM_BEFORE}copy(?:[_\\s-]*\\d+)?${NOT_ALNUM_AFTER}`, "giu"),
  // qualitative stage words
  new RegExp(`${SEP}${NOT_ALNUM_BEFORE}(?:final|draft|clean|latest|old|new)${NOT_ALNUM_AFTER}`, "giu"),
];

// Dates/years are version-ish but also frequently part of a document's real
// identity ("Rapport 2023-2026"), so they are stripped only for the purpose
// of comparing two names, never used alone as evidence of a version bump.
const DATE_LIKE = /\b(?:19|20)\d{2}(?:[-_.]?(?:0[1-9]|1[0-2])(?:[-_.]?(?:0[1-9]|[12]\d|3[01]))?)?\b/g;

/**
 * Strip extension, version markers, dates and separators to get at what a
 * human would call "the same document's name". "Report_v2_final.pdf" and
 * "Report (3).pdf" both reduce to "report".
 */
function versionAgnosticStem(filename) {
  let name = String(filename || "");
  name = name.replace(/\.[^.]+$/, ""); // extension
  for (const marker of VERSION_MARKERS) {
    name = name.replace(marker, " ");
  }
  name = name.replace(DATE_LIKE, " ");
  return name.replace(NON_WORD, "").toLowerCase();
}

/**
 * Pull an explicit version number out of a filename, if one is stated.
 * Returns null when the name carries no numeric version -- "final"/"draft"
 * are ordering *hints*, not numbers, and are deliberately not invented into
 * one.
 */
function extractVersionNumber(filename) {
  const name = String(filename || "").replace(/\.[^.]+$/, "");
  // Same \b-vs-underscore caveat as VERSION_MARKERS above.
  for (const pattern of [
    new RegExp(`${NOT_ALNUM_BEFORE}v(?:er|ersion)?[_\\s.-]*(\\d+)`, "iu"),
    new RegExp(`${NOT_ALNUM_BEFORE}(?:rev|revision)[_\\s.-]*(\\d+)`, "iu"),
    /\((\d+)\)\s*$/u,
  ]) {
    const match = pattern.exec(name);
    if (match) return parseInt(match[1], 10);
  }
  return null;
}

/** Does this filename carry any marker suggesting it is one of several
 * revisions, rather than a standalone document? */
function hasVersionMarker(filename) {
  const name = String(filename || "").replace(/\.[^.]+$/, "");
  return VERSION_MARKERS.some((m) => {
    m.lastIndex = 0;
    return m.test(name);
  });
}

/**
 * Filename-only evidence that two files are versions of one document.
 * Returns 0..1. This is intentionally weak on its own -- versionsRelationship
 * below requires it to be corroborated by content similarity before anything
 * is recorded, because "same filename stem" alone will happily merge
 * unrelated documents that share a naming pattern (the exact failure mode
 * docs/01-domain-model.md §1.2 warns about).
 */
function filenameVersionScore(filenameA, filenameB) {
  const stemA = versionAgnosticStem(filenameA);
  const stemB = versionAgnosticStem(filenameB);
  if (!stemA || !stemB) return 0;
  if (stemA !== stemB) return 0;
  // Identical stems, but if neither name carries a version marker the two
  // are more likely just similarly-named siblings than revisions.
  return hasVersionMarker(filenameA) || hasVersionMarker(filenameB) ? 1 : 0.5;
}

/**
 * Combined judgement for the version-detection stage.
 *
 * @returns {{isVersionCandidate: boolean, score: number, confidenceLevel: string|null,
 *            versionNumbers: {a: number|null, b: number|null}, reason: string}}
 */
function versionRelationship(fileA, fileB) {
  const nameScore = filenameVersionScore(fileA.filename, fileB.filename);
  const contentScore = textSimilarity(fileA.text, fileB.text);
  const comparable = hasEnoughTextToCompare(fileA.text) && hasEnoughTextToCompare(fileB.text);

  const versionNumbers = {
    a: extractVersionNumber(fileA.filename),
    b: extractVersionNumber(fileB.filename),
  };

  if (nameScore === 0) {
    return { isVersionCandidate: false, score: 0, confidenceLevel: null, versionNumbers, reason: "Filename stems differ." };
  }
  if (!comparable) {
    // Filenames agree but there is no text to corroborate with. Per docs/01
    // §1.5 this is exactly a LOW-confidence "flag for manual investigation",
    // not something to act on.
    return {
      isVersionCandidate: true,
      score: nameScore * 0.5,
      confidenceLevel: "low",
      versionNumbers,
      reason: "Filenames match a version pattern, but there was not enough extracted text to corroborate.",
    };
  }

  // Content dominates; the filename is a supporting signal, never the whole
  // case. Weighted so a filename match alone can never clear the threshold.
  const score = contentScore * 0.7 + nameScore * 0.3;
  if (contentScore < PROBABLE_DUPLICATE_THRESHOLD) {
    return {
      isVersionCandidate: false,
      score,
      confidenceLevel: null,
      versionNumbers,
      reason: `Filenames match but content similarity is only ${contentScore.toFixed(2)}.`,
    };
  }

  return {
    isVersionCandidate: true,
    score,
    // Capped at medium on purpose -- see confidenceForScore.
    confidenceLevel: score >= STRONG_SIMILARITY_THRESHOLD ? "medium" : "low",
    versionNumbers,
    reason: `Filename stems match and content similarity is ${contentScore.toFixed(2)}.`,
  };
}

module.exports = {
  tokenize,
  shingleSet,
  jaccard,
  textSimilarity,
  hasEnoughTextToCompare,
  confidenceForScore,
  versionAgnosticStem,
  extractVersionNumber,
  hasVersionMarker,
  filenameVersionScore,
  versionRelationship,
  SHINGLE_SIZE,
  MIN_TOKENS_FOR_COMPARISON,
  PROBABLE_DUPLICATE_THRESHOLD,
  STRONG_SIMILARITY_THRESHOLD,
};
