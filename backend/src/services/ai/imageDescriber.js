// What is actually IN this picture?
//
// WHY THIS IS NOT OCR, AND WHY BOTH EXIST
//
// OCR reads TEXT out of an image. It is the right tool for a scanned invoice
// and useless for a photograph of a beach -- it returns zero characters, which
// is a correct answer to the wrong question. That is exactly what happened on
// this corpus: six WhatsApp photos, OCR ran perfectly, found nothing, and the
// user was left looking at "WhatsApp Image 2026-07-20 at 23.43.54.jpeg" with
// no idea what it was.
//
// This asks the other question. It sends the image to Gemini, which is
// multimodal, and gets back a short description of the SUBJECT MATTER -- "a
// group of people at a restaurant table", "a printed electricity bill", "a
// selfie taken outdoors". That is what makes a photo findable and namable.
//
// The two are complementary and this module says which produced what:
//   OCR         -> file_ocr.text        (words that are in the picture)
//   description -> files.ai_summary     (what the picture is of)
//
// WHAT IT DELIBERATELY DOES NOT DO
//
// It does not identify people. The prompt asks for what is depicted, not who
// -- "two people at a table" and never a name, even if the model believes it
// recognises someone. Naming individuals from photographs is a different
// product with different consequences, and nothing here needs it to be useful.
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const env = require("../../config/env");

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";

// Images are resized by nobody here, so a very large photo is sent as-is.
// 12MB is comfortably above a phone photo and below the request limits.
const MAX_BYTES = 12 * 1024 * 1024;

const MIME_BY_EXT = {
  jpg: "image/jpeg", jpeg: "image/jpeg", jpe: "image/jpeg", jfif: "image/jpeg",
  png: "image/png", gif: "image/gif", webp: "image/webp",
  bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff",
  heic: "image/heic", heif: "image/heif",
};

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    caption: {
      type: "string",
      description:
        "A short, concrete description of what the picture shows, 3-12 words, suitable as a filename. " +
        "Describe the SUBJECT, not the medium: 'Sunset over a rocky beach', not 'A photograph of a beach'. " +
        "Never name or identify individual people -- say 'two people', 'a child', 'a group at a table'.",
    },
    summary: {
      type: "string",
      description:
        "One or two plain sentences describing the picture in more detail, for someone deciding where to file it.",
    },
    kind: {
      type: "string",
      enum: ["document", "photo", "screenshot", "artwork", "diagram", "other"],
      description:
        "What KIND of image this is. 'document' means a photographed or scanned page of text -- a receipt, " +
        "a letter, a form, an ID card. 'photo' means an ordinary photograph of people, places or things.",
    },
    containsText: {
      type: "boolean",
      description: "True if there is readable text in the image worth running OCR on.",
    },
    suggestedSubject: {
      type: ["string", "null"],
      description:
        "The single best-fitting folder from the provided list, given as its exact path. Null if none of " +
        "them genuinely fit -- do NOT force a picture into the closest available folder.",
    },
    confidence: {
      type: "number",
      description: "0 to 1, how sure you are about the caption and the suggested folder.",
    },
  },
  required: ["caption", "summary", "kind", "containsText", "confidence"],
};

function mimeFor(extension) {
  return MIME_BY_EXT[String(extension || "").toLowerCase().replace(/^\./, "")] || "image/jpeg";
}

/**
 * Describe one image.
 *
 * @param {string} imagePath - absolute path to a real image on this disk
 * @param {object} [opts]
 * @param {string} [opts.extension]
 * @param {string[]} [opts.folders] - materialized paths the model may choose from
 * @returns {Promise<{ok: boolean, caption?, summary?, kind?, containsText?,
 *   suggestedSubject?, confidence?, reason?}>}
 */
async function describe(imagePath, { extension = "", folders = [] } = {}) {
  if (!env.ai.enabled || !env.ai.apiKey) {
    return { ok: false, reason: "AI is disabled or no GEMINI_API_KEY is set.", unavailable: true };
  }

  let bytes;
  try {
    const stat = await fsp.stat(imagePath);
    if (stat.size > MAX_BYTES) {
      return {
        ok: false,
        permanent: true,
        reason: `Image is ${(stat.size / 1024 / 1024).toFixed(1)}MB, above the ${MAX_BYTES / 1024 / 1024}MB limit for description.`,
      };
    }
    bytes = await fsp.readFile(imagePath);
  } catch (err) {
    return { ok: false, reason: `Could not read the image: ${err.message}` };
  }

  const folderList = folders.length
    ? `\n\nThe user's existing folders, by path:\n${folders.map((f) => `- ${f}`).join("\n")}\n\n` +
      "Pick the one that genuinely fits, or null. Forcing a picture into the closest available folder " +
      "is worse than leaving it unfiled -- the user can create a better folder, but only if you are " +
      "honest that none of these match."
    : "";

  const instruction =
    "You are looking at an image from someone's personal document archive. Describe what it shows so " +
    "they can recognise and file it.\n\n" +
    "Be concrete and specific. 'Sunset over a rocky beach' is useful; 'an image' is not. If it is a " +
    "photographed or scanned document, say what document it appears to be.\n\n" +
    "NEVER identify or name individual people. Describe them generically -- 'two people', 'a child', " +
    "'a group at a table'. This matters: guessing at identities from photographs is not something " +
    "this application does." +
    folderList;

  let response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.ai.timeoutMs || 20000);
    try {
      response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.ai.apiKey },
        signal: controller.signal,
        // The Interactions API's shapes, confirmed empirically against the
        // live endpoint rather than guessed: content parts are a flat array of
        // {type}, an image is {type:"image", data, mime_type}, and structured
        // output is response_format {type:"text", mime_type, schema} -- the
        // same shape geminiClassifier already uses successfully.
        body: JSON.stringify({
          model: env.ai.model,
          input: [
            { type: "text", text: instruction },
            { type: "image", mime_type: mimeFor(extension), data: bytes.toString("base64") },
          ],
          response_format: {
            type: "text",
            mime_type: "application/json",
            schema: RESPONSE_SCHEMA,
          },
          generation_config: { thinking_level: "minimal" },
        }),
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return {
      ok: false,
      reason: err.name === "AbortError"
        ? "Timed out waiting for the image description."
        : `Could not reach Gemini: ${err.message}`,
    };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return {
      ok: false,
      // 4xx other than rate-limiting is a request the model will never accept
      // -- retrying burns quota to reach the same answer.
      permanent: response.status >= 400 && response.status < 500 && response.status !== 429,
      reason: `Gemini returned ${response.status}: ${body.slice(0, 300)}`,
    };
  }

  let parsed;
  try {
    const payload = await response.json();
    const text = extractText(payload);
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: `Could not parse the description: ${err.message}` };
  }

  return { ok: true, ...parsed };
}

/**
 * Pull the model's text out of the response envelope.
 *
 * Mirrors geminiClassifier's handling of the same endpoint -- the shape is a
 * list of steps and the useful one is the model's output.
 */
function extractText(payload) {
  const steps = payload?.output || payload?.steps || [];
  for (const step of Array.isArray(steps) ? steps : []) {
    const content = step?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part?.text === "string") return part.text;
      }
    }
  }
  // Older/simpler shapes.
  const direct = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof direct === "string") return direct;
  throw new Error("no model output in the response");
}

module.exports = { describe, MAX_BYTES, mimeFor };
