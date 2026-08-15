// Inbox triage classification (docs/10-email-inbox.md). Same two-tier
// philosophy as the file classifier (classifyProcessor.js / geminiClassifier.js):
// a free, instant rule-based pass handles the obvious cases, and only
// genuinely ambiguous messages cost a Gemini call.
const env = require("../../config/env");

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";

const BULK_SENDER_PATTERN = /(no-?reply|newsletter|notifications?|marketing|mailer|do-?not-?reply)@/i;
const PROMO_SUBJECT_PATTERN = /\b(unsubscribe|% off|sale ends|limited time offer|free shipping|flash sale|exclusive deal)\b/i;

/**
 * Instant, free classification from signals the provider already gave us
 * (Gmail labels, List-Unsubscribe
 * header) plus a couple of generic heuristics. Returns null ("uncertain")
 * rather than guessing when nothing here is confident either way -- that's
 * what escalates to Gemini.
 *
 * @param {object} message - normalized shape, see emailSyncProcessor.js
 */
function ruleClassify(message) {
  const subject = (message.subject || "").toLowerCase();
  const fromAddress = (message.fromAddress || "").toLowerCase();
  const labels = message.providerHints?.gmailLabels || [];
  const hasListUnsubscribe = Boolean(message.providerHints?.hasListUnsubscribe);

  if (labels.includes("SPAM")) {
    return { classification: "junk", confidenceLevel: "high", method: "rule", reason: "Provider-flagged spam." };
  }
  if (labels.includes("CATEGORY_PROMOTIONS") || labels.includes("CATEGORY_SOCIAL")) {
    return { classification: "junk", confidenceLevel: "high", method: "rule", reason: "Promotions/social category." };
  }
  if (hasListUnsubscribe && BULK_SENDER_PATTERN.test(fromAddress)) {
    return { classification: "junk", confidenceLevel: "high", method: "rule", reason: "Bulk sender address with a List-Unsubscribe header." };
  }
  if (PROMO_SUBJECT_PATTERN.test(subject) && (hasListUnsubscribe || BULK_SENDER_PATTERN.test(fromAddress))) {
    return { classification: "junk", confidenceLevel: "high", method: "rule", reason: "Promotional subject line plus a bulk-mail signal." };
  }
  if (labels.includes("IMPORTANT") || labels.includes("CATEGORY_PERSONAL")) {
    return { classification: "important", confidenceLevel: "high", method: "rule", reason: "Provider-flagged important/personal." };
  }
  return null;
}

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    classification: { type: "string", enum: ["important", "junk"] },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    reason: { type: "string", description: "One short sentence." },
  },
  required: ["classification", "confidence", "reason"],
};

const SYSTEM_INSTRUCTION = `You are triaging one email in someone's inbox. Classify it as exactly one of:

- "junk": marketing/promotional email, newsletters the person didn't specifically ask a
  question through, automated bulk notifications with no personal relevance, or spam.
- "important": anything a person would actually want to see -- personal correspondence,
  business/official correspondence, receipts or invoices, anything requiring a response or
  action, or anything you're not confident is safe to call junk.

This classification directly determines whether the email gets automatically moved to
Trash with no human review -- when genuinely unsure, classify as "important". Losing one
minute to an extra email in the inbox costs nothing; auto-deleting something that mattered
does. Respond only with the requested JSON.`;

class EmailTriageError extends Error {}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryDelayMs(bodyText) {
  const match = /retry in ([\d.]+)s/i.exec(bodyText || "");
  if (!match) return null;
  return Math.ceil(parseFloat(match[1]) * 1000) + 500;
}

const MAX_429_RETRIES = 2;

function buildInput(message) {
  return `From: ${message.fromName ? `${message.fromName} <${message.fromAddress}>` : message.fromAddress}
Subject: ${message.subject}

${(message.snippet || "").slice(0, 1000)}`;
}

function extractOutputText(interaction) {
  const steps = interaction.steps || [];
  const outputSteps = steps.filter((s) => s.type === "model_output");
  const lastOutput = outputSteps[outputSteps.length - 1];
  if (!lastOutput) return null;
  return lastOutput.content.filter((c) => c.type === "text").map((c) => c.text).join("");
}

async function callGemini(message, attempt = 1) {
  if (!env.ai.apiKey) {
    throw new EmailTriageError("GEMINI_API_KEY is not set.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.ai.timeoutMs);

  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "x-goog-api-key": env.ai.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env.ai.model,
        system_instruction: SYSTEM_INSTRUCTION,
        input: buildInput(message),
        response_format: { type: "text", mime_type: "application/json", schema: RESPONSE_SCHEMA },
        generation_config: { thinking_level: "minimal" },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") throw new EmailTriageError(`Gemini request timed out after ${env.ai.timeoutMs}ms.`);
    throw new EmailTriageError(`Gemini request failed: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    if (response.status === 429 && attempt <= MAX_429_RETRIES) {
      await sleep(parseRetryDelayMs(bodyText) ?? 10_000 * attempt);
      return callGemini(message, attempt + 1);
    }
    throw new EmailTriageError(`Gemini API returned ${response.status}: ${bodyText.slice(0, 300)}`);
  }

  const interaction = await response.json();
  const outputText = extractOutputText(interaction);
  if (!outputText) throw new EmailTriageError("Gemini response had no text output to parse.");

  try {
    return JSON.parse(outputText);
  } catch (err) {
    throw new EmailTriageError(`Gemini response was not valid JSON: ${err.message}`);
  }
}

/**
 * @param {object} message - normalized message (see emailSyncProcessor.js)
 * @returns {Promise<{classification: 'important'|'junk', confidenceLevel: 'high'|'medium'|'low', method: 'rule'|'ai', reason: string}>}
 */
async function classify(message) {
  const ruled = ruleClassify(message);
  if (ruled) return ruled;

  const result = await callGemini(message);
  return {
    classification: result.classification === "junk" ? "junk" : "important",
    confidenceLevel: ["low", "medium", "high"].includes(result.confidence) ? result.confidence : "low",
    method: "ai",
    reason: String(result.reason || "").slice(0, 300),
  };
}

module.exports = { classify, ruleClassify, EmailTriageError };
