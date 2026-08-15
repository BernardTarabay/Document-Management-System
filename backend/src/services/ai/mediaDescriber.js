// What happens in this video, and what is on this recording?
//
// WHY THIS EXISTS
//
// A phone archive is not only documents. On the current corpus, "WhatsApp
// Video 2026-07-16 at 00.16.15.mp4" is all anybody had to go on -- OCR has
// nothing to read, imageDescriber cannot open it, and the classifier skips it
// for having no text, so it reached the end of the pipeline with no
// description of any kind. A filename with a timestamp in it is not a record
// of what you filmed.
//
// Gemini is multimodal over video AND audio, so the honest answer for these
// files is to actually watch and listen to them rather than describe the
// container. This module does that and returns the same shape imageDescriber
// returns, so descriptionService treats all three the same way.
//
// WHAT IT DELIBERATELY DOES NOT DO
//
// It does not identify people, exactly as imageDescriber does not -- "two
// people talking at a table", never a name, even where the model believes it
// recognises someone. It also does not transcribe: a description is for
// finding the file, and a full transcript is a different feature with
// different storage and different privacy questions. If speech carries the
// meaning, the description says what it is ABOUT.
//
// SHAPES CONFIRMED AGAINST THE LIVE API
//
//   inline    { type: "video"|"audio", mime_type, data: <base64> }
//   uploaded  { type: "video"|"audio", mime_type, uri: <files API uri> }
//
// The uploaded form is `uri`. It is NOT `file_uri` and NOT the
// `file_data: { file_uri }` wrapper that generateContent uses -- both are
// rejected by this endpoint with "Unknown parameter". That was established by
// trying all three against the live API, not by reading for it.
const fs = require("fs");
const fsp = fs.promises;
const env = require("../../config/env");
const { acquireRateLimitSlot, parseRetryDelayMs, sleep } = require("./rateLimiter");
const { extractOutputText } = require("./interactionResponse");

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const UPLOAD_ENDPOINT = "https://generativelanguage.googleapis.com/upload/v1beta/files";
const FILES_BASE = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Above this, the bytes go via the Files API instead of inline.
 *
 * base64 inflates by 4/3 and the whole request has to fit the endpoint's
 * ~20MB body limit, so 14MB of source is the safe inline ceiling. Most phone
 * video is comfortably above it, which is why the upload path is implemented
 * here rather than deferred -- a video feature that only handles clips under
 * 14MB does not handle video.
 */
const MAX_INLINE_BYTES = 14 * 1024 * 1024;

/**
 * Above this, the file is not described at all.
 *
 * Video is billed by DURATION, not by file size: the API samples frames, and a
 * long recording turns into a very large number of input tokens (a two-second
 * clip measured at 224 video tokens). A feature-length video would cost more
 * than every document in the archive combined, to produce one sentence. The
 * ceiling is a size proxy for that, and configurable for anyone who decides
 * otherwise.
 */
const MAX_UPLOAD_BYTES = parseInt(process.env.AI_MEDIA_MAX_BYTES || String(200 * 1024 * 1024), 10);

/**
 * The exact MIME types this endpoint accepts, as reported BY the endpoint --
 * sending an unsupported one gets a 400 that lists the supported set, which is
 * where these came from. Anything not listed here is refused locally rather
 * than spending a request to be told no.
 */
const VIDEO_MIME_BY_EXT = {
  mp4: "video/mp4", m4v: "video/mp4", mpeg: "video/mpeg", mpg: "video/mpg",
  mov: "video/mov", qt: "video/mov", avi: "video/avi", flv: "video/x-flv",
  webm: "video/webm", wmv: "video/wmv", "3gp": "video/3gpp", "3gpp": "video/3gpp",
};

const AUDIO_MIME_BY_EXT = {
  wav: "audio/wav", mp3: "audio/mp3", aiff: "audio/aiff", aif: "audio/aiff",
  aac: "audio/aac", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/opus",
  flac: "audio/flac", m4a: "audio/m4a", mpga: "audio/mpeg",
};

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    caption: {
      type: "string",
      description:
        "A short, concrete description of what this recording shows or contains, 3-12 words, suitable as a filename. " +
        "Describe the SUBJECT, not the medium: 'Children singing at a birthday party', not 'A video of people'. " +
        "Never name or identify individual people -- say 'two people', 'a child', 'a group'.",
    },
    summary: {
      type: "string",
      description:
        "One or two plain sentences describing the recording in more detail, for someone deciding where to file it. " +
        "If people are speaking, say what the conversation is ABOUT rather than transcribing it. Mention the setting " +
        "and anything that would help someone recognise this particular recording later.",
    },
    kind: {
      type: "string",
      enum: ["home_video", "screen_recording", "voice_note", "music", "meeting", "document_scan", "other"],
      description: "What kind of recording this is.",
    },
    hasSpeech: { type: "boolean", description: "True if anyone speaks audibly in it." },
    spokenLanguage: {
      type: ["string", "null"],
      description: "The main language spoken, if any, as an English name ('French', 'Arabic'). Null if there is no speech.",
    },
    suggestedSubject: {
      type: ["string", "null"],
      description:
        "The single best-fitting folder from the provided list, given as its exact path. Null if none of them " +
        "genuinely fit -- do NOT force a recording into the closest available folder.",
    },
    confidence: { type: "number", description: "0 to 1, how sure you are about the caption." },
  },
  required: ["caption", "summary", "kind", "hasSpeech", "confidence"],
};

/**
 * @returns {{mediaType: 'video'|'audio', mimeType: string}|null} null when this
 *   extension is not something the API accepts.
 */
function classifyExtension(extension) {
  const ext = String(extension || "").toLowerCase().replace(/^\./, "");
  if (VIDEO_MIME_BY_EXT[ext]) return { mediaType: "video", mimeType: VIDEO_MIME_BY_EXT[ext] };
  if (AUDIO_MIME_BY_EXT[ext]) return { mediaType: "audio", mimeType: AUDIO_MIME_BY_EXT[ext] };
  return null;
}

function isMedia(extension) {
  return Boolean(classifyExtension(extension));
}

/**
 * Push bytes through the Files API's resumable protocol and wait until the
 * service has finished processing them.
 *
 * Video arrives in state PROCESSING and cannot be referenced until it turns
 * ACTIVE -- referencing it early fails with an unhelpful error, so the poll is
 * load-bearing rather than defensive.
 */
async function uploadFile(filePath, mimeType, sizeBytes) {
  const start = await fetch(UPLOAD_ENDPOINT, {
    method: "POST",
    headers: {
      "x-goog-api-key": env.ai.apiKey,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(sizeBytes),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: "description-source" } }),
  });

  if (!start.ok) {
    throw new Error(`Files API refused the upload: ${start.status} ${(await start.text().catch(() => "")).slice(0, 200)}`);
  }
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Files API did not return an upload URL.");

  // Streamed rather than read into memory: this path exists precisely for the
  // files too big to hold, and buffering a 200MB video to upload it would
  // reintroduce the OOM that the extraction size ceiling was added to stop.
  const upload = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(sizeBytes),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: fs.createReadStream(filePath),
    duplex: "half", // required by undici when the body is a stream
  });

  if (!upload.ok) {
    throw new Error(`Upload failed: ${upload.status} ${(await upload.text().catch(() => "")).slice(0, 200)}`);
  }

  const body = await upload.json();
  const file = body.file || body;
  if (!file?.uri || !file?.name) throw new Error("Upload response carried no file URI.");

  let state = file.state;
  const deadline = Date.now() + Math.max(env.ai.timeoutMs, 120_000);
  while (state === "PROCESSING" && Date.now() < deadline) {
    await sleep(2000);
    const meta = await fetch(`${FILES_BASE}/${file.name}`, { headers: { "x-goog-api-key": env.ai.apiKey } });
    if (!meta.ok) break;
    state = (await meta.json())?.state;
  }
  if (state === "FAILED") throw new Error("The service could not process this media file.");
  if (state === "PROCESSING") throw new Error("Timed out waiting for the upload to become usable.");

  return file;
}

async function deleteUploadedFile(name) {
  if (!name) return;
  // Best effort. Uploads expire on their own after 48 hours, so a failed
  // cleanup costs nothing but quota that would have been reclaimed anyway --
  // and reporting it as a description failure would be a lie about the result.
  await fetch(`${FILES_BASE}/${name}`, {
    method: "DELETE",
    headers: { "x-goog-api-key": env.ai.apiKey },
  }).catch(() => {});
}

async function callModel(part, instruction, attempt = 1) {
  await acquireRateLimitSlot();

  const controller = new AbortController();
  // Watching a video takes longer than reading a page. The configured AI
  // timeout is tuned for text and is too tight here; media gets its own floor.
  const timeoutMs = Math.max(env.ai.timeoutMs, 90_000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "x-goog-api-key": env.ai.apiKey, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: env.ai.model,
        input: [{ type: "text", text: instruction }, part],
        response_format: { type: "text", mime_type: "application/json", schema: RESPONSE_SCHEMA },
        generation_config: { thinking_level: "minimal" },
      }),
    });
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`Timed out after ${timeoutMs}ms waiting for the description.`);
    throw new Error(`Could not reach Gemini: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    if (response.status === 429 && attempt <= 2) {
      await sleep(parseRetryDelayMs(body) ?? 15_000 * attempt);
      return callModel(part, instruction, attempt + 1);
    }
    const error = new Error(`Gemini returned ${response.status}: ${body.slice(0, 300)}`);
    // 4xx other than rate-limiting is a request the model will never accept --
    // retrying burns quota to reach the same answer.
    error.permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
    throw error;
  }

  const payload = await response.json();
  const text = extractOutputText(payload);
  if (!text) throw new Error("The response contained no description.");
  return { parsed: JSON.parse(text), usage: payload.usage || null };
}

function buildInstruction(mediaType, folders) {
  const folderList = folders.length
    ? `\n\nThe user's existing folders, by path:\n${folders.map((f) => `- ${f}`).join("\n")}\n\n` +
      "Pick the one that genuinely fits, or null. Forcing a recording into the closest available folder is " +
      "worse than leaving it unfiled -- the user can create a better folder, but only if you are honest that " +
      "none of these match."
    : "";

  const medium = mediaType === "video"
    ? "You are watching a video from someone's personal archive."
    : "You are listening to an audio recording from someone's personal archive.";

  return (
    `${medium} Describe what it contains so they can recognise and file it.\n\n` +
    "Be concrete and specific. 'Children singing at a birthday party' is useful; 'a recording' is not. " +
    "If people are speaking, say what it is ABOUT -- do not transcribe it.\n\n" +
    "NEVER identify or name individual people. Describe them generically -- 'two people', 'a child', " +
    "'a group'. This matters: guessing at identities from recordings is not something this application does." +
    folderList
  );
}

/**
 * Describe one video or audio file.
 *
 * @param {string} mediaPath - absolute path to a real file on this disk
 * @param {object} [opts]
 * @param {string} [opts.extension]
 * @param {string[]} [opts.folders] - materialized paths the model may choose from
 * @returns {Promise<{ok: boolean, mediaType?: string, caption?: string, summary?: string,
 *   kind?: string, hasSpeech?: boolean, spokenLanguage?: string|null,
 *   suggestedSubject?: string|null, confidence?: number, usage?: object|null,
 *   reason?: string, permanent?: boolean, unavailable?: boolean}>}
 */
async function describe(mediaPath, { extension = "", folders = [] } = {}) {
  if (!env.ai.enabled || !env.ai.apiKey) {
    return { ok: false, reason: "AI is disabled or no GEMINI_API_KEY is set.", unavailable: true };
  }

  const kind = classifyExtension(extension);
  if (!kind) {
    return { ok: false, permanent: true, reason: `${extension || "This format"} is not a video or audio type the model accepts.` };
  }

  let stat;
  try {
    stat = await fsp.stat(mediaPath);
  } catch (err) {
    return { ok: false, reason: `Could not read the file: ${err.message}` };
  }

  if (stat.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      permanent: true,
      reason:
        `${kind.mediaType === "video" ? "Video" : "Audio"} is ${(stat.size / 1048576).toFixed(0)}MB, above the ` +
        `${Math.round(MAX_UPLOAD_BYTES / 1048576)}MB ceiling for description (AI_MEDIA_MAX_BYTES).`,
    };
  }
  if (stat.size === 0) {
    return { ok: false, permanent: true, reason: "The file is empty." };
  }

  let uploadedName = null;
  try {
    let part;
    if (stat.size <= MAX_INLINE_BYTES) {
      const bytes = await fsp.readFile(mediaPath);
      part = { type: kind.mediaType, mime_type: kind.mimeType, data: bytes.toString("base64") };
    } else {
      const uploaded = await uploadFile(mediaPath, kind.mimeType, stat.size);
      uploadedName = uploaded.name;
      part = { type: kind.mediaType, mime_type: kind.mimeType, uri: uploaded.uri };
    }

    const { parsed, usage } = await callModel(part, buildInstruction(kind.mediaType, folders));
    return { ok: true, mediaType: kind.mediaType, usage, ...parsed };
  } catch (err) {
    return { ok: false, permanent: Boolean(err.permanent), reason: err.message };
  } finally {
    await deleteUploadedFile(uploadedName);
  }
}

module.exports = {
  describe, isMedia, classifyExtension,
  MAX_INLINE_BYTES, MAX_UPLOAD_BYTES,
  VIDEO_MIME_BY_EXT, AUDIO_MIME_BY_EXT,
};
