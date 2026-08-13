// Decides whether extracted text is REAL TEXT or extraction noise.
//
// WHY THIS EXISTS
//
// A scanned document is a picture of words. Run it through a PDF text
// extractor and you do not get nothing -- which would be easy to handle --
// you get a little garbage: stray ligatures, page furniture, OCR-ish
// fragments from an embedded text layer that was never any good, or a
// character-per-token spray from a broken CID font encoding. That garbage
// then flows downstream as if it were content:
//
//   - the AI tier reads it and confidently invents a title from noise
//   - that title becomes a rename proposal
//   - the user sees their scanned letter proposed as "Ph ot o 00 12 sc an"
//
// Reported from real use as "a bunch of gibberish because of pictures". The
// fix is to judge the text BEFORE anything trusts it, and when it fails, to
// leave the file's existing name alone rather than replace a human's name
// with a machine's hallucination.
//
// DESIGN: SCRIPT-AWARE, AND BIASED TOWARD SAYING "OK"
//
// Latin heuristics do not transfer. Arabic and Hebrew are written without
// most vowels, so a "too few vowels" rule would condemn every Arabic
// document in this repository -- which is a large share of it. So the
// dominant script is detected first and only the checks valid for that
// script run.
//
// Every threshold is deliberately loose. A false "gibberish" verdict costs
// a real document its automatic name (recoverable, and the file keeps the
// name it already had). A false "fine" verdict is what we already have. When
// genuinely unsure, this says usable.

const MIN_TOKENS = 5;
const MIN_LETTER_RATIO = 0.35;
const MAX_SINGLE_CHAR_TOKEN_RATIO = 0.55;
const MIN_LATIN_VOWEL_RATIO = 0.12;
const MAX_REPLACEMENT_RATIO = 0.03;
// Bytes of file per extracted character. A 4 MB PDF that yields 60
// characters has no usable text layer; it is a stack of images.
const NO_TEXT_LAYER_BYTES_PER_CHAR = 20000;

const VERDICTS = {
  OK: "ok",
  EMPTY: "empty",
  TOO_SHORT: "too_short",
  NO_TEXT_LAYER: "no_text_layer",
  GIBBERISH: "gibberish",
};

function dominantScript(text) {
  const counts = { arabic: 0, hebrew: 0, cjk: 0, cyrillic: 0, latin: 0 };
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if ((c >= 0x0600 && c <= 0x06ff) || (c >= 0x0750 && c <= 0x077f)) counts.arabic += 1;
    else if (c >= 0x0590 && c <= 0x05ff) counts.hebrew += 1;
    else if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3040 && c <= 0x30ff)) counts.cjk += 1;
    else if (c >= 0x0400 && c <= 0x04ff) counts.cyrillic += 1;
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0xc0 && c <= 0x24f)) counts.latin += 1;
  }
  let best = null;
  let bestN = 0;
  for (const [script, n] of Object.entries(counts)) {
    if (n > bestN) { bestN = n; best = script; }
  }
  return bestN === 0 ? null : best;
}

/**
 * @param {string} text - the extracted text
 * @param {{sizeBytes?: number}} [context] - the source file's size, used only
 *   to tell "a scan with no text layer" apart from "a genuinely short note".
 * @returns {{usable: boolean, verdict: string, reason: string|null, stats: object}}
 */
function assessText(text, { sizeBytes = 0 } = {}) {
  const raw = typeof text === "string" ? text : "";
  const trimmed = raw.trim();

  const stats = {
    chars: trimmed.length,
    tokens: 0,
    letterRatio: 0,
    singleCharTokenRatio: 0,
    vowelRatio: null,
    replacementRatio: 0,
    script: null,
  };

  if (trimmed.length === 0) {
    return {
      usable: false,
      verdict: VERDICTS.EMPTY,
      reason: "No text could be extracted from this file.",
      stats,
    };
  }

  // A big file that produced almost nothing is a scan, not a short note.
  if (sizeBytes > 0 && sizeBytes / trimmed.length > NO_TEXT_LAYER_BYTES_PER_CHAR) {
    return {
      usable: false,
      verdict: VERDICTS.NO_TEXT_LAYER,
      reason:
        `Only ${trimmed.length} characters came out of a ${Math.round(sizeBytes / 1024)} KB file, ` +
        "so this is almost certainly a scan or photo with no real text layer. It needs OCR to be readable.",
      stats,
    };
  }

  const letters = (trimmed.match(/\p{L}/gu) || []).length;
  stats.letterRatio = letters / trimmed.length;
  stats.replacementRatio = (trimmed.match(/�/g) || []).length / trimmed.length;
  stats.script = dominantScript(trimmed);

  const tokens = trimmed.split(/[^\p{L}\p{N}'’-]+/u).filter(Boolean);
  stats.tokens = tokens.length;
  stats.singleCharTokenRatio = tokens.length
    ? tokens.filter((t) => t.length === 1).length / tokens.length
    : 0;

  // ORDER MATTERS. "Is this text at all?" is asked before "is there enough
  // of it?", because both questions reject the same inputs but only one of
  // them gives the user a true reason. Punctuation soup and mojibake both
  // tokenize to almost nothing, so a token-count check placed first would
  // label them "only 1 word extracted" -- accurate but misleading, and it
  // hides the real problem, which is that the file's encoding did not
  // survive.

  // The mojibake tell: the decoder produced replacement characters.
  if (stats.replacementRatio > MAX_REPLACEMENT_RATIO) {
    return {
      usable: false,
      verdict: VERDICTS.GIBBERISH,
      reason: "The extracted text is full of undecodable characters, so the file's encoding was not readable.",
      stats,
    };
  }

  // Mostly punctuation and symbols rather than words.
  if (stats.letterRatio < MIN_LETTER_RATIO) {
    return {
      usable: false,
      verdict: VERDICTS.GIBBERISH,
      reason:
        `Only ${Math.round(stats.letterRatio * 100)}% of the extracted characters are letters, ` +
        "so this looks like extraction noise rather than text.",
      stats,
    };
  }

  if (tokens.length < MIN_TOKENS) {
    return {
      usable: false,
      verdict: VERDICTS.TOO_SHORT,
      reason: `Only ${tokens.length} word(s) of text were extracted -- not enough to describe the document.`,
      stats,
    };
  }

  // "T h i s   i s   n o t   t e x t" -- a broken font encoding losing the
  // word boundaries, which reads as prose to a language model and is
  // useless as a name.
  if (stats.singleCharTokenRatio > MAX_SINGLE_CHAR_TOKEN_RATIO) {
    return {
      usable: false,
      verdict: VERDICTS.GIBBERISH,
      reason:
        `${Math.round(stats.singleCharTokenRatio * 100)}% of the extracted "words" are single characters, ` +
        "which means the file's character encoding did not survive extraction.",
      stats,
    };
  }

  // Latin only. Arabic and Hebrew omit vowels by design, and applying this
  // to them would reject most of the real documents in this repository.
  if (stats.script === "latin") {
    const vowels = (trimmed.match(/[aeiouyàâäéèêëïîôöùûüœæ]/gi) || []).length;
    stats.vowelRatio = letters ? vowels / letters : 0;
    if (stats.vowelRatio < MIN_LATIN_VOWEL_RATIO) {
      return {
        usable: false,
        verdict: VERDICTS.GIBBERISH,
        reason:
          `The extracted Latin-script text has almost no vowels (${Math.round(stats.vowelRatio * 100)}%), ` +
          "which is characteristic of a failed character-encoding rather than real words.",
        stats,
      };
    }
  }

  return { usable: true, verdict: VERDICTS.OK, reason: null, stats };
}

/** True when the file has no usable text but plausibly contains words in an
 *  image -- i.e. OCR would actually help, as opposed to a .dat file that was
 *  never text at all. */
function wouldBenefitFromOcr(assessment, extension) {
  if (assessment.usable) return false;
  const ocrable = ["pdf", "png", "jpg", "jpeg", "tif", "tiff", "bmp", "gif", "webp", "heic"];
  if (!ocrable.includes(String(extension || "").toLowerCase())) return false;
  return [VERDICTS.EMPTY, VERDICTS.NO_TEXT_LAYER, VERDICTS.TOO_SHORT, VERDICTS.GIBBERISH].includes(assessment.verdict);
}

module.exports = { assessText, wouldBenefitFromOcr, VERDICTS };
