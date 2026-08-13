// LLM classification escalation tier (docs/09-ai-classification.md).
//
// The rule-based classifier (jobs/processors/classifyProcessor.js) stays the
// default, always-free first pass. This module is only ever invoked when
// that pass wasn't confident, and only when GEMINI_API_KEY is set -- see
// env.ai.enabled. Nothing here changes behavior for anyone not opted in.
//
// Built against the current Gemini Interactions API
// (https://ai.google.dev/gemini-api/docs/interactions-overview):
//   POST https://generativelanguage.googleapis.com/v1beta/interactions
// Structured JSON output is requested via response_format, so the model is
// constrained to a closed choice (pick from the taxonomy we already seeded)
// plus a few short free-text fields, rather than open-ended generation --
// that's what keeps this both cheap and easy to validate.
const env = require("../../config/env");

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";

// Keep the excerpt bounded regardless of how much text extraction pulled out
// -- this is the single biggest lever on cost, and the first ~6000
// characters of a document are almost always enough to identify what it is.
const MAX_EXCERPT_CHARS = 6000;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    subject_slug: {
      type: ["string", "null"],
      description: "The slug of the single best-matching subject from the candidate list, or null if none reasonably fit.",
    },
    document_type_code: {
      type: ["string", "null"],
      description: "The code of the single best-matching document type from the candidate list, or null if none reasonably fit.",
    },
    confidence: {
      type: "string",
      enum: ["low", "medium", "high"],
      description: "Your honest confidence in the subject/document_type pick above. Use low if the content is ambiguous or you're guessing.",
    },
    short_title: {
      type: "string",
      description:
        "The title a person would actually give this file after reading it -- what they'd type into a 'rename' box. " +
        "If the document clearly has its own title (a book's title, a report's cover-page title, a letter's real subject), " +
        "use that title itself, close to verbatim -- don't paraphrase into a generic category label. If it's personal or " +
        "conversational (e.g. a letter or email), describe it the way a person would say it out loud: 'Letter from Mom', " +
        "'Email from the Landlord about Rent'. If it's a specific business document, name the specific thing: " +
        "'Q3 2024 Vendor Invoice - Acme Corp', 'Annual Returns 2024', not 'Finance Document' or 'Certificate'. " +
        "Never fall back to a vague bucket-style label like 'Report' or 'Document' if there's ANY more specific detail " +
        "available in the text. 3-10 words. WRITE THIS IN THE DOCUMENT'S OWN LANGUAGE -- if the document is in Arabic, " +
        "French, or Hebrew, the title must be in that same language and script, not translated or transliterated into " +
        "English. A French letter gets a French title ('Lettre de Maman', not 'Letter from Mom'); an Arabic certificate " +
        "keeps its Arabic title; a Hebrew document keeps its Hebrew title. Only use English if the document itself is in English.",
    },
    summary: {
      type: "string",
      description:
        "One or two plain-English... no -- one or two sentences in the SAME language as the document itself (see short_title) " +
        "describing what this specific document actually contains, so someone can tell what it is without opening it. Do not " +
        "translate the summary into English if the source document isn't in English.",
    },
    entities: {
      type: "object",
      properties: {
        party: { type: ["string", "null"], description: "The primary counterparty, vendor, client, or organization named in the document, if any. Keep the name in its original language/script exactly as written in the document -- do not translate or transliterate it." },
        date_or_period: { type: ["string", "null"], description: "The most relevant date or period referenced, e.g. '2024-Q3' or '2024-11-05', if any." },
        identifier: { type: ["string", "null"], description: "An invoice/contract/case/reference number belonging to this document, if it has one." },
      },
      required: ["party", "date_or_period", "identifier"],
    },
  },
  required: ["subject_slug", "document_type_code", "confidence", "short_title", "summary", "entities"],
};

const SYSTEM_INSTRUCTION = `You are naming and describing a file for someone who has thousands of documents and
will never remember what "Finance_Report_2024_v1" was about six months from now. Read the
excerpt like a person would, then title it the way that person would title it themselves --
by what it actually IS, not by the administrative bucket it falls into.

You will also be given a closed list of candidate subjects and document types already
defined by the organization, and, when available, the file's own embedded title metadata.
Pick the single best subject/document-type match from those exact lists (by slug/code) --
never invent a new one, and use null rather than forcing a bad match if nothing reasonably
fits (this is a separate judgment from short_title -- you can be unsure which bucket a
document belongs in while still being completely sure what the document IS and titling it
well). If an embedded title is provided and it's genuinely descriptive, prefer it (or a
light cleanup of it) over inventing your own -- it's literally what the author called it.

CRITICAL -- never translate. This repository holds documents in Arabic, French, Hebrew, and
English, often mixed together. short_title, summary, and entities.party must always stay in
whatever language and script the SOURCE DOCUMENT is actually written in -- an Arabic document
gets an Arabic title in Arabic script, a French document gets a French title, a Hebrew
document gets a Hebrew title (right-to-left script is expected and correct, don't "fix" it).
Never translate, transliterate, or romanize into English or any other language as a
convenience. The one exception: subject_slug and document_type_code are always the literal
slug/code strings from the candidate lists below (those are identifiers, not prose, and
aren't translated either way).

Respond only with the requested JSON.`;

class GeminiClassificationError extends Error {}

function truncate(text, max) {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}\n[...truncated...]` : text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Client-side rate limiting -----------------------------------------
// Paces outgoing calls to stay under env.ai.rateLimitPerMinute instead of
// firing bursts and letting Google reject the overflow with 429s. A sliding
// window of recent call timestamps; a call waits for a free slot rather
// than being denied one. Acquisition itself is serialized through a single
// promise chain -- without that, several concurrent callers (the classify
// queue's worker concurrency) could all see the same "under the limit"
// snapshot and all proceed at once, which defeats the point.
const callTimestamps = [];
let rateLimitChain = Promise.resolve();

function acquireRateLimitSlot() {
  rateLimitChain = rateLimitChain.then(async () => {
    const limit = env.ai.rateLimitPerMinute;
    if (!limit || limit <= 0) return; // 0/unset = no client-side pacing
    const windowMs = 60_000;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const now = Date.now();
      while (callTimestamps.length && now - callTimestamps[0] >= windowMs) {
        callTimestamps.shift();
      }
      if (callTimestamps.length < limit) {
        callTimestamps.push(now);
        return;
      }
      await sleep(callTimestamps[0] + windowMs - now + 50);
    }
  });
  // A rejected link would poison the chain permanently: every later
  // .then() on it inherits the rejection, so one failure inside the block
  // above would mean acquireRateLimitSlot() rejects forever for the life of
  // the process -- and since classifyProcessor catches everything around the
  // AI tier, that would silently disable AI classification with no error
  // anyone would see. Keep the CHAIN resolved; hand the caller the real
  // outcome.
  const acquired = rateLimitChain;
  rateLimitChain = rateLimitChain.then(
    () => {},
    () => {}
  );
  return acquired;
}

// Google's 429 body includes a human-readable hint like "Please retry in
// 25.054123681s." -- honor that instead of guessing, so a retry doesn't
// fire early and get rejected again.
function parseRetryDelayMs(bodyText) {
  const match = /retry in ([\d.]+)s/i.exec(bodyText || "");
  if (!match) return null;
  return Math.ceil(parseFloat(match[1]) * 1000) + 500; // small buffer
}

const MAX_429_RETRIES = 3;

function buildInput({ filename, bodyText, subjects, documentTypes, embeddedTitle }) {
  const subjectList = subjects.map((s) => `- slug: ${s.slug} | name: ${s.name}`).join("\n") || "(none defined)";
  const docTypeList = documentTypes.map((d) => `- code: ${d.code} | name: ${d.name}`).join("\n") || "(none defined)";
  const embeddedTitleLine = embeddedTitle ? `Embedded document title metadata: "${embeddedTitle}"` : "Embedded document title metadata: (none)";

  return `Filename: ${filename}
${embeddedTitleLine}

Candidate subjects:
${subjectList}

Candidate document types:
${docTypeList}

Extracted text excerpt:
"""
${truncate(bodyText, MAX_EXCERPT_CHARS)}
"""`;
}

/**
 * Pulls the JSON text out of the raw Interactions API response. The API
 * returns a `steps` array; the model's answer lives in the last
 * `model_output` step's text content block(s), which we join (mirrors what
 * the official SDK's `.output_text` convenience property does).
 */
function extractOutputText(interaction) {
  const steps = interaction.steps || [];
  const outputSteps = steps.filter((s) => s.type === "model_output");
  const lastOutput = outputSteps[outputSteps.length - 1];
  if (!lastOutput) return null;
  return lastOutput.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
}

async function callGemini({ filename, bodyText, subjects, documentTypes, embeddedTitle }, attempt = 1) {
  if (!env.ai.apiKey) {
    throw new GeminiClassificationError("GEMINI_API_KEY is not set.");
  }

  await acquireRateLimitSlot();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.ai.timeoutMs);

  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "x-goog-api-key": env.ai.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.ai.model,
        system_instruction: SYSTEM_INSTRUCTION,
        input: buildInput({ filename, bodyText, subjects, documentTypes, embeddedTitle }),
        response_format: {
          type: "text",
          mime_type: "application/json",
          schema: RESPONSE_SCHEMA,
        },
        generation_config: {
          // This is a bounded classification/extraction task, not something
          // that benefits from deep reasoning -- keep thinking minimal so
          // thought tokens (billed as output) don't inflate cost per file.
          // NOTE: the Interactions API's GenerationConfig does not support
          // `temperature` (unlike the older generateContent API) -- sending
          // it gets the request rejected outright. thinking_level is the
          // knob this API actually exposes for consistency/cost control.
          thinking_level: "minimal",
        },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new GeminiClassificationError(`Gemini request timed out after ${env.ai.timeoutMs}ms.`);
    }
    throw new GeminiClassificationError(`Gemini request failed: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const bodyText2 = await response.text().catch(() => "");
    // The rate limiter above should mostly prevent these, but a burst that
    // started before this run (another process, a just-reset window) can
    // still land one. Honor Google's own retry hint and try again a
    // bounded number of times before giving up -- much better than every
    // file in a big batch permanently losing its AI pass to one shared
    // quota window.
    if (response.status === 429 && attempt <= MAX_429_RETRIES) {
      const retryMs = parseRetryDelayMs(bodyText2) ?? 15_000 * attempt;
      await sleep(retryMs);
      return callGemini({ filename, bodyText, subjects, documentTypes, embeddedTitle }, attempt + 1);
    }
    throw new GeminiClassificationError(`Gemini API returned ${response.status}: ${bodyText2.slice(0, 500)}`);
  }

  const interaction = await response.json();
  const outputText = extractOutputText(interaction);
  if (!outputText) {
    throw new GeminiClassificationError("Gemini response had no text output to parse.");
  }

  let parsed;
  try {
    parsed = JSON.parse(outputText);
  } catch (err) {
    throw new GeminiClassificationError(`Gemini response was not valid JSON: ${err.message}`);
  }

  return { result: parsed, usage: interaction.usage || null, interactionId: interaction.id };
}

/**
 * Top-level entry point used by classifyProcessor. Validates the model's
 * picks against the actual candidate lists (structured output guarantees
 * shape, not that the model didn't hallucinate a slug outside the list) and
 * resolves them to real subject/documentType records before returning.
 */
async function classify({ filename, bodyText, subjects, documentTypes, embeddedTitle }) {
  const { result, usage, interactionId } = await callGemini({ filename, bodyText, subjects, documentTypes, embeddedTitle });

  const subject = result.subject_slug ? subjects.find((s) => s.slug === result.subject_slug) || null : null;
  const documentType = result.document_type_code
    ? documentTypes.find((d) => d.code === result.document_type_code) || null
    : null;

  return {
    subject,
    documentType,
    confidenceLevel: ["low", "medium", "high"].includes(result.confidence) ? result.confidence : "low",
    shortTitle: String(result.short_title || "").slice(0, 200),
    summary: String(result.summary || "").slice(0, 1000),
    entities: {
      party: result.entities?.party || null,
      dateOrPeriod: result.entities?.date_or_period || null,
      identifier: result.entities?.identifier || null,
    },
    usage,
    interactionId,
  };
}

module.exports = { classify, GeminiClassificationError, MAX_EXCERPT_CHARS };