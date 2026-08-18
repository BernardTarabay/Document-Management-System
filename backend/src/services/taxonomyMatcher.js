/**
 * Keyword matching for the rule-based classification tier.
 *
 * Extracted from classifyProcessor after the document-type axis was found to
 * have collapsed: of 13 seeded types, exactly one ("Book") was ever assigned
 * by the rule tier, to a 36,000-character personal narrative, on the strength
 * of the substrings inside "playbook" and "fantasy books".
 *
 * Two things were wrong, and they compounded:
 *
 * 1. The keyword list was `[entity.name, entity.code]`, and for every
 *    single-word type the name and the code are the SAME WORD ("Book"/"Book",
 *    "Invoice"/"Invoice", "Report"/"Report", ...). The scorer added one point
 *    per keyword *present*, so a single occurrence scored 2 -- which is
 *    exactly the `totalScore >= 2` MEDIUM threshold that classifyProcessor
 *    deliberately introduced to require "at least two independent body
 *    matches". One match, counted twice, silently satisfied a guard written
 *    to demand two. Multi-word types ("AnnualBudget") were split into
 *    fragments instead and never got the same free doubling, so the bias ran
 *    consistently toward single-word types.
 *
 * 2. Matching was `haystack.includes(keyword)`, so "book" matched inside
 *    "playbook", "notebook", "Facebook"; "exam" inside "examine" and the
 *    French "examen"; "contract" inside "contracted". On a 20,000-character
 *    body excerpt an incidental substring is close to guaranteed.
 *
 * The fix is deduplicated terms plus Unicode-aware word-boundary matching.
 *
 * Deliberately NOT handled: plurals and morphology. Allowing a trailing "s"
 * would re-admit the exact false positive this module exists to stop ("her
 * fantasy books" would type a novel as Book again). The asymmetry is the same
 * one textQuality.js reasons about -- a missed type costs nothing a human
 * can't add later from the Files page, while a confident wrong type is a
 * label nobody knows to go back and check.
 *
 * A consequence worth stating plainly: this makes the rule tier assign FEWER
 * document types, not more. The seeded type codes are English and this
 * repository's content is largely French and Arabic, so honest word-boundary
 * matching against an English list mostly finds nothing. Populating the axis
 * across a French/Arabic corpus is the AI tier's job (and manual assignment's)
 * -- the rule tier's job is to stay quiet rather than to guess loudly.
 */

// Separators inside a display name that mean "these are alternative labels for
// the same thing", not "this is one phrase": "Manual / Guide" is two usable
// terms. The old code split that name on capital letters and produced the
// keyword "manual / ", with the trailing separator and space still attached,
// which could essentially never match anything.
const ALTERNATIVE_SEPARATORS = /[/,;|]+/;

/** "AnnualBudget" -> "Annual Budget"; leaves already-spaced names alone. */
function splitCamelCase(value) {
  return value
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2");
}

function normalize(value) {
  return value.normalize("NFC").toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The distinct search terms for one taxonomy entity. Accepts both shapes used
 * in this codebase: document types carry `code`, subjects carry `slug`.
 *
 * Deduplication is the whole point -- see (1) in the module header.
 */
function buildTerms(entity) {
  if (!entity) return [];
  const sources = [entity.name, entity.code, entity.slug].filter((v) => typeof v === "string" && v);

  const terms = new Set();
  for (const source of sources) {
    for (const part of splitCamelCase(source).split(ALTERNATIVE_SEPARATORS)) {
      const term = normalize(part);
      if (term) terms.add(term);
    }
  }
  return [...terms];
}

// Building a RegExp per term per entity per file is wasteful when the taxonomy
// is the same on every call; the term strings are derived from seeded taxonomy
// rows, so the cache is bounded by the size of the taxonomy.
const regexCache = new Map();

/**
 * A term matches only as a whole word. `\b` is not usable here: it is defined
 * over [A-Za-z0-9_], so it treats every Arabic and accented-French letter as a
 * boundary -- "تقرير" would match inside a longer Arabic word, and "contrat"
 * would match inside "contrats". Unicode property escapes give the real
 * boundary. Internal whitespace is relaxed so "annual budget" still matches
 * across a line break.
 */
function termRegex(term) {
  let cached = regexCache.get(term);
  if (!cached) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
    cached = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu");
    regexCache.set(term, cached);
  }
  return cached;
}

/**
 * How many DISTINCT terms appear in the haystack. Distinct is deliberate: the
 * confidence thresholds downstream are written in terms of "independent
 * matches", so the same word occurring forty times is still one signal.
 */
function matchTerms(haystack, terms) {
  const matched = [];
  if (!haystack) return { matches: 0, matched };
  for (const term of terms) {
    if (termRegex(term).test(haystack)) matched.push(term);
  }
  return { matches: matched.length, matched };
}

/**
 * Best-scoring entity out of a candidate list. A hit in the filename counts
 * triple: the name is something a person chose for this document, while a body
 * hit can be any passing mention.
 */
function bestMatch(entities, { filenameText = "", bodyText = "" } = {}) {
  let best = null;
  let bestScore = 0;
  let bestInFilename = false;
  let bestTerms = [];

  for (const entity of entities || []) {
    const terms = buildTerms(entity);
    if (!terms.length) continue;

    const inName = matchTerms(filenameText, terms);
    const inBody = matchTerms(bodyText, terms);
    const score = inName.matches * 3 + inBody.matches;

    if (score > bestScore) {
      best = entity;
      bestScore = score;
      bestInFilename = inName.matches > 0;
      bestTerms = [...new Set([...inName.matched, ...inBody.matched])];
    }
  }

  return { entity: best, score: bestScore, inFilename: bestInFilename, matchedTerms: bestTerms };
}

/**
 * Some extensions ARE the document type, definitionally -- a .pptx is a slide
 * deck no matter what it says inside. That is a stronger and cheaper signal
 * than any amount of keyword matching, and unlike prose it cannot be wrong
 * about the KIND of thing the file is.
 *
 * Deliberately minimal. Spreadsheets are the obvious omission: the seeded type
 * is "Spreadsheet Model -- structured financial/operational model", which is
 * narrower than "any .xlsx", and a shopping list is not a model. Mapping every
 * workbook to it would repopulate the axis with the same kind of confident
 * wrongness this whole change exists to remove. Extending this table is a
 * taxonomy decision for a deployment to make against its own seed data.
 */
const EXTENSION_TYPES = {
  pptx: "Presentation",
  ppt: "Presentation",
  odp: "Presentation",
};

/** The document type an extension proves, or null. */
function typeFromExtension(extension, documentTypes) {
  if (!extension) return null;
  const code = EXTENSION_TYPES[String(extension).toLowerCase().replace(/^\./, "")];
  if (!code) return null;
  return (documentTypes || []).find((d) => d.code === code) || null;
}

module.exports = { buildTerms, matchTerms, bestMatch, typeFromExtension, EXTENSION_TYPES };
