// Turning descriptions, and the phrases people search with, into vectors.
//
// WHAT THIS IS FOR
//
// Someone looking for a document types what they REMEMBER about it, not what
// it is called and not a phrase that appears inside it: "the photo of the kid
// blowing out birthday candles". Lexical search cannot answer that. The stored
// description may read "a child at a party with a cake" and share not one
// content word with the query.
//
// Embedding both sides puts them near each other in the same space, so the
// match survives paraphrase. It also survives LANGUAGE, which matters more
// here than paraphrase does: this corpus is French and Arabic, its
// descriptions are often written in the document's own language, and the
// person searching writes in English. A multilingual embedding model puts
// "facture d'électricité" and "electricity bill" in nearly the same place;
// no amount of stemming ever will.
//
// SHAPES CONFIRMED AGAINST THE LIVE API, NOT GUESSED
//
//   POST /v1beta/models/{model}:embedContent
//   { model, content: { parts: [{ text }] }, task_type, output_dimensionality }
//   -> { embedding: { values: number[] } }
//
// NORMALISATION IS REQUIRED, NOT COSMETIC
//
// gemini-embedding-001 returns unit vectors ONLY at its full 3072 dimensions.
// Truncated outputs come back un-normalised -- measured against the live
// endpoint, a 768-dimension vector came back with ‖v‖ = 0.5936. Cosine
// similarity between un-normalised vectors is not what a dot product computes,
// so anything skipping this step ranks partly by vector length, which means
// partly by nothing. Normalising once on the way in makes every later
// comparison a plain dot product, which is the whole reason the search can
// afford to be brute force.
const env = require("../../config/env");
const { acquireRateLimitSlot, parseRetryDelayMs, sleep } = require("./rateLimiter");

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * 768 rather than the model's full 3072.
 *
 * The cache holds every embedding in memory, so dimensionality is a direct
 * multiplier on both RAM and search time: at 3072 a 9,400-file corpus is
 * 115MB and ~29M multiply-adds per query; at 768 it is 29MB and ~7M. Google's
 * own MTEB figures put the quality difference between the two at well under a
 * point, which is far smaller than the difference between having semantic
 * search and not having it.
 */
const DIMS = 768;

const MODEL = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";

/**
 * The API rejects very long input. Descriptions are a sentence or two, so this
 * only ever bites on the embedding_input we assemble around them (filename,
 * folder path, entities); truncating is the right response because everything
 * that matters is at the front of that string by construction.
 */
const MAX_INPUT_CHARS = 8000;

const MAX_429_RETRIES = 2;

class EmbeddingError extends Error {}

/**
 * Task types tell the model which side of the asymmetry it is embedding.
 *
 * This is not a detail to skip. A stored description and a search phrase are
 * different KINDS of text -- one describes, the other asks -- and a model told
 * which is which places them closer together than one embedding both as
 * generic text. Using RETRIEVAL_DOCUMENT for both is a measurable quality
 * loss, and it is invisible: search simply gets a little worse forever.
 */
const TaskType = Object.freeze({
  DOCUMENT: "RETRIEVAL_DOCUMENT",
  QUERY: "RETRIEVAL_QUERY",
});

function available() {
  return Boolean(env.ai.enabled && env.ai.apiKey);
}

/**
 * L2-normalise in place and return the same array.
 *
 * A zero vector (which the API should never return, but a malformed response
 * could) is left alone rather than divided by zero -- it will simply score 0
 * against everything, which is the correct behaviour for "no information".
 */
function normalise(values) {
  let sumSquares = 0;
  for (const v of values) sumSquares += v * v;
  const norm = Math.sqrt(sumSquares);
  if (!norm || !Number.isFinite(norm)) return values;
  for (let i = 0; i < values.length; i++) values[i] /= norm;
  return values;
}

/**
 * Pack a normalised vector into the bytea layout migration 035 documents:
 * little-endian float32, one after another, no header.
 */
function encode(values) {
  const buffer = Buffer.allocUnsafe(values.length * 4);
  for (let i = 0; i < values.length; i++) buffer.writeFloatLE(values[i], i * 4);
  return buffer;
}

/**
 * Unpack straight into a Float32Array.
 *
 * Buffers from node-postgres are views into a larger pooled ArrayBuffer, so
 * byteOffset must be honoured; a Float32Array over `buffer.buffer` alone reads
 * whichever row happened to be allocated first. Also why the length is taken
 * from byteLength rather than assumed to be DIMS -- a row embedded by an
 * earlier model with different dimensionality must decode as itself and be
 * skipped by the caller, not silently misread.
 */
function decode(buffer) {
  if (!buffer || buffer.byteLength % 4 !== 0) return null;
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
}

/** Dot product. Both sides normalised, so this IS cosine similarity. */
function similarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

async function callEmbed(text, taskType, attempt = 1) {
  await acquireRateLimitSlot();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.ai.timeoutMs);

  let response;
  try {
    response = await fetch(`${BASE}/${MODEL}:embedContent`, {
      method: "POST",
      headers: { "x-goog-api-key": env.ai.apiKey, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: `models/${MODEL}`,
        content: { parts: [{ text: text.slice(0, MAX_INPUT_CHARS) }] },
        task_type: taskType,
        output_dimensionality: DIMS,
      }),
    });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new EmbeddingError(`Embedding request timed out after ${env.ai.timeoutMs}ms.`);
    }
    throw new EmbeddingError(`Embedding request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    if (response.status === 429 && attempt <= MAX_429_RETRIES) {
      await sleep(parseRetryDelayMs(body) ?? 10_000 * attempt);
      return callEmbed(text, taskType, attempt + 1);
    }
    throw new EmbeddingError(`Embedding API returned ${response.status}: ${body.slice(0, 300)}`);
  }

  const payload = await response.json();
  const values = payload?.embedding?.values || payload?.embeddings?.[0]?.values;
  if (!Array.isArray(values) || !values.length) {
    throw new EmbeddingError("Embedding response contained no vector.");
  }
  return normalise(values);
}

/**
 * Embed a file's description for storage.
 *
 * @returns {Promise<{ok: true, buffer: Buffer, dims: number, model: string}
 *   | {ok: false, reason: string, unavailable?: boolean}>}
 *
 * Returns a result rather than throwing, for the same reason imageDescriber
 * does: this runs inside a pipeline stage, and an embedding that could not be
 * computed is a file that is still findable by keyword. Degrading the search
 * is the correct response; failing the job is not.
 */
async function embedDocument(text) {
  const input = String(text || "").trim();
  if (!input) return { ok: false, reason: "Nothing to embed." };
  if (!available()) {
    return { ok: false, unavailable: true, reason: "AI is disabled or no GEMINI_API_KEY is set." };
  }
  try {
    const values = await callEmbed(input, TaskType.DOCUMENT);
    return { ok: true, buffer: encode(values), dims: values.length, model: MODEL };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * Embed a search phrase.
 *
 * @returns {Promise<Float32Array|null>} null whenever the query cannot be
 *   embedded -- the search layer treats that as "no semantic half this time"
 *   and returns lexical results alone, so an unreachable API degrades search
 *   instead of breaking it.
 */
async function embedQuery(text) {
  const input = String(text || "").trim();
  if (!input || !available()) return null;
  try {
    return Float32Array.from(await callEmbed(input, TaskType.QUERY));
  } catch {
    return null;
  }
}

module.exports = {
  embedDocument, embedQuery,
  encode, decode, normalise, similarity, available,
  DIMS, MODEL, TaskType, EmbeddingError,
};
