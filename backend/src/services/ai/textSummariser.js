// One plain-language description of a document, from its text.
//
// WHY THIS IS NOT geminiClassifier
//
// The classifier already produces a summary, and where it has run, that
// summary is reused rather than paid for twice (see descriptionService). But
// it produces one as a BY-PRODUCT of choosing a subject and a document type,
// which means it only runs when classification runs, needs the full taxonomy
// passed in, and stops entirely once the daily cap is reached. Files that fell
// through those gaps -- and on this corpus that is most of the unreadable
// half -- ended with no description at all.
//
// This asks the narrow question on its own: what IS this document, in a
// sentence someone could recognise it by. No taxonomy, no classification, no
// rename proposal downstream.
//
// WHAT IT MUST NOT DO
//
// It must not describe text that could not be read. The caller is responsible
// for only passing text that textQuality.js judged usable -- descriptionService
// enforces that -- because a fluent description invented from mojibake is the
// exact failure this project has repeatedly decided to avoid, and it is
// especially dangerous HERE: a wrong description is not just wrong on screen,
// it gets embedded and becomes the thing search matches against forever.
const env = require("../../config/env");
const { acquireRateLimitSlot, parseRetryDelayMs, sleep } = require("./rateLimiter");
const { extractOutputText } = require("./interactionResponse");

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";

/**
 * How much of the document the model sees.
 *
 * A description is about what a document IS, and that is established in its
 * opening -- a letterhead, a title, an addressee, the first paragraph. Reading
 * forty pages to write two sentences costs input tokens on every file in the
 * archive and changes almost nothing about the answer. 6,000 characters is
 * roughly the first two pages.
 */
const MAX_EXCERPT_CHARS = 6000;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    caption: {
      type: "string",
      description:
        "A short, specific label for this document, 3-12 words. What it IS, not what it is about in general: " +
        "'Electricity bill, June 2024, EDL' rather than 'A utility document'. No filename extension.",
    },
    summary: {
      type: "string",
      description:
        "One or two plain sentences describing this document so someone could recognise it and decide where " +
        "to file it. Say who it is from or to, what it concerns, and any date or period it covers, IF those " +
        "are actually stated. Do not speculate about anything that is not in the text.",
    },
    keywords: {
      type: "array",
      items: { type: "string" },
      description:
        "3 to 8 words or short phrases someone might plausibly search for to find this document later, " +
        "including any names, places, organisations or reference numbers that appear in it. Keep them in " +
        "the document's own language.",
    },
    documentLanguage: {
      type: ["string", "null"],
      description: "The main language the document is written in, as an English name ('French', 'Arabic').",
    },
    confidence: {
      type: "number",
      description:
        "0 to 1, how confident you are that this description is right. Be honest: if the text is fragmentary " +
        "or you cannot tell what the document is, say so with a low number rather than writing a confident guess.",
    },
  },
  required: ["caption", "summary", "keywords", "confidence"],
};

const INSTRUCTION =
  "You are describing one document from someone's personal archive so they can find it again later by " +
  "describing it from memory.\n\n" +
  "Write the description in the SAME language the document is written in -- someone searching for a French " +
  "letter is most likely to remember French words from it.\n\n" +
  "Be concrete. Names, organisations, dates and subject matter are what make a document findable; " +
  "'an official document' makes it invisible.\n\n" +
  "Describe ONLY what the text actually says. If the excerpt is too fragmentary to tell what the document " +
  "is, say exactly that in the summary and give a low confidence. An honest 'a partial scan of what appears " +
  "to be a form, too fragmentary to identify' is far more useful than a confident invention, because the " +
  "user can act on it.";

/**
 * @param {string} text - text already judged usable by the caller
 * @param {object} [context] - facts that help, all optional
 * @param {string} [context.filename]
 * @param {string} [context.embeddedTitle]
 * @returns {Promise<{ok: boolean, caption?, summary?, keywords?, documentLanguage?,
 *   confidence?, usage?, reason?, permanent?, unavailable?}>}
 */
async function summarise(text, { filename = "", embeddedTitle = "" } = {}) {
  if (!env.ai.enabled || !env.ai.apiKey) {
    return { ok: false, unavailable: true, reason: "AI is disabled or no GEMINI_API_KEY is set." };
  }
  const body = String(text || "").trim();
  if (!body) return { ok: false, permanent: true, reason: "There was no usable text to describe." };

  const input =
    `Filename: ${filename || "(unknown)"}\n` +
    `Embedded title metadata: ${embeddedTitle || "(none)"}\n\n` +
    `Text excerpt:\n"""\n${body.slice(0, MAX_EXCERPT_CHARS)}\n"""`;

  return call(input, 1);
}

async function call(input, attempt) {
  await acquireRateLimitSlot();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.ai.timeoutMs);

  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "x-goog-api-key": env.ai.apiKey, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: env.ai.model,
        system_instruction: INSTRUCTION,
        input,
        response_format: { type: "text", mime_type: "application/json", schema: RESPONSE_SCHEMA },
        generation_config: { thinking_level: "minimal" },
      }),
    });
  } catch (err) {
    if (err.name === "AbortError") {
      return { ok: false, reason: `Timed out after ${env.ai.timeoutMs}ms waiting for the description.` };
    }
    return { ok: false, reason: `Could not reach Gemini: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    if (response.status === 429 && attempt <= 2) {
      await sleep(parseRetryDelayMs(bodyText) ?? 15_000 * attempt);
      return call(input, attempt + 1);
    }
    return {
      ok: false,
      permanent: response.status >= 400 && response.status < 500 && response.status !== 429,
      reason: `Gemini returned ${response.status}: ${bodyText.slice(0, 300)}`,
    };
  }

  let payload;
  try {
    payload = await response.json();
    const text = extractOutputText(payload);
    if (!text) return { ok: false, reason: "The response contained no description." };
    return { ok: true, usage: payload.usage || null, ...JSON.parse(text) };
  } catch (err) {
    return { ok: false, reason: `Could not parse the description: ${err.message}` };
  }
}

module.exports = { summarise, MAX_EXCERPT_CHARS };
