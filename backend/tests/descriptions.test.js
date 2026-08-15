// The parts of describe-and-find that can be wrong without anything failing.
//
// The network halves are covered by scripts/verify-descriptions.js, which
// drives the real model and the real database. What is here is everything that
// can be checked without either, and every case is one where a bug produces a
// plausible wrong answer rather than an error:
//
//   * an embedding that decodes as a different vector than was stored ranks
//     files by noise, and looks exactly like search working badly
//   * a metadata description that reads as a claim about contents is a lie the
//     UI cannot detect
//   * rank fusion that lets one signal dominate silently undoes the reason
//     there are three
const test = require("node:test");
const assert = require("node:assert");

const embeddingService = require("../src/services/ai/embeddingService");
const { fuse, RRF_K } = require("../src/services/descriptionSearchService");
const {
  buildMetadataDescription, buildEmbeddingInput, humaniseFilename, describeKind, formatBytes, usableText,
} = require("../src/services/descriptionService");
const { extractOutputText } = require("../src/services/ai/interactionResponse");

// ---------------------------------------------------------------------------
// Embeddings: storage layout and similarity
// ---------------------------------------------------------------------------

test("normalise makes a unit vector, so a dot product is a cosine", () => {
  const values = embeddingService.normalise([3, 4]);
  assert.ok(Math.abs(Math.hypot(...values) - 1) < 1e-9);
  assert.ok(Math.abs(values[0] - 0.6) < 1e-9);
});

test("normalise leaves a zero vector alone rather than dividing by zero", () => {
  const values = embeddingService.normalise([0, 0, 0]);
  assert.deepStrictEqual([...values], [0, 0, 0]);
});

test("a vector survives the round trip through the bytea layout", () => {
  const original = embeddingService.normalise([0.5, -0.25, 0.125, 1]);
  const decoded = embeddingService.decode(embeddingService.encode(original));

  assert.strictEqual(decoded.length, original.length);
  for (let i = 0; i < original.length; i++) {
    // float32, so exact equality is not the property -- round-trip fidelity is.
    assert.ok(Math.abs(decoded[i] - original[i]) < 1e-6, `index ${i}`);
  }
  // The layout migration 035 documents: 4 bytes per dimension, no header.
  assert.strictEqual(embeddingService.encode(original).length, original.length * 4);
});

test("decode honours byteOffset, so one row cannot read another's bytes", () => {
  // node-postgres hands back Buffers that are VIEWS into a shared pool. A
  // decoder that ignored byteOffset would silently return whichever row was
  // allocated first -- every search result subtly wrong, nothing thrown.
  const a = embeddingService.encode(embeddingService.normalise([1, 0, 0, 0]));
  const b = embeddingService.encode(embeddingService.normalise([0, 1, 0, 0]));
  const shared = Buffer.concat([a, b]);
  const view = shared.subarray(a.length); // same ArrayBuffer, non-zero offset

  const decoded = embeddingService.decode(view);
  assert.ok(Math.abs(decoded[0] - 0) < 1e-6);
  assert.ok(Math.abs(decoded[1] - 1) < 1e-6);
});

test("decode refuses a buffer that is not a whole number of floats", () => {
  assert.strictEqual(embeddingService.decode(Buffer.alloc(5)), null);
  assert.strictEqual(embeddingService.decode(null), null);
});

test("similarity is 1 for a vector with itself and 0 for an orthogonal pair", () => {
  const a = Float32Array.from(embeddingService.normalise([1, 1, 0]));
  const b = Float32Array.from(embeddingService.normalise([0, 0, 1]));
  assert.ok(Math.abs(embeddingService.similarity(a, a) - 1) < 1e-6);
  assert.ok(Math.abs(embeddingService.similarity(a, b)) < 1e-6);
});

test("similarity refuses mismatched dimensionality instead of comparing garbage", () => {
  // A row embedded by an older model at a different size must not silently
  // contribute a meaningless score to the ranking.
  assert.strictEqual(
    embeddingService.similarity(Float32Array.from([1, 0]), Float32Array.from([1, 0, 0])),
    0
  );
});

// ---------------------------------------------------------------------------
// Rank fusion
// ---------------------------------------------------------------------------

test("fusion rewards agreement between signals over a single strong hit", () => {
  // "alpha" is second-best according to two independent signals; "solo" is the
  // outright winner of one and unranked by the others. Agreement should win --
  // that is the entire reason three signals are run instead of one.
  const fused = fuse([
    { name: "semantic", results: [{ fileId: "solo", score: 0.99 }, { fileId: "alpha", score: 0.8 }] },
    { name: "description", results: [{ fileId: "beta", score: 0.5 }, { fileId: "alpha", score: 0.4 }] },
    { name: "content", results: [{ fileId: "gamma", score: 0.3 }, { fileId: "alpha", score: 0.2 }] },
  ]);

  assert.strictEqual(fused[0].fileId, "alpha");
  assert.deepStrictEqual(fused[0].matchedBy, ["semantic", "description", "content"]);
});

test("fusion scores by rank, not by the incomparable raw scores", () => {
  // ts_rank is unbounded, cosine has a 0.55 floor, and searchEverything's rank
  // is a hand-built ladder. If raw scores leaked into the fusion, the signal
  // with the largest numbers would always win.
  const fused = fuse([
    { name: "a", results: [{ fileId: "x", score: 1000 }] },
    { name: "b", results: [{ fileId: "y", score: 0.0001 }] },
  ]);
  assert.strictEqual(fused[0].score, fused[1].score, "same rank in one signal each = same fused score");
  assert.ok(Math.abs(fused[0].score - 1 / (RRF_K + 1)) < 1e-12);
});

test("fusion keeps each signal's own score for display without ranking by it", () => {
  const fused = fuse([{ name: "semantic", results: [{ fileId: "x", score: 0.83 }] }]);
  assert.strictEqual(fused[0].scores.semantic, 0.83);
});

test("fusion breaks ties deterministically", () => {
  // Without a tiebreak, two files with identical fused scores can swap places
  // between identical queries, which reads as the search being unstable.
  const signals = [{ name: "a", results: [{ fileId: "bbb", score: 1 }] }, { name: "b", results: [{ fileId: "aaa", score: 1 }] }];
  const first = fuse(signals).map((r) => r.fileId);
  const second = fuse(signals).map((r) => r.fileId);
  assert.deepStrictEqual(first, second);
  assert.deepStrictEqual(first, ["aaa", "bbb"]);
});

test("fusion of nothing is nothing", () => {
  assert.deepStrictEqual(fuse([{ name: "semantic", results: [] }]), []);
});

// ---------------------------------------------------------------------------
// Descriptions built from facts alone
// ---------------------------------------------------------------------------

test("humaniseFilename keeps the words and drops the machinery", () => {
  // The date and the time go; "WhatsApp Video" is the only part anyone could
  // search by, and leaving the digits in makes every clip from one afternoon
  // look alike to the embedding.
  assert.strictEqual(humaniseFilename("WhatsApp Video 2026-07-16 at 00.16.15.mp4"), "WhatsApp Video at");
  assert.strictEqual(humaniseFilename("WIN_20260611_13_20_57_Pro.jpg"), "WIN Pro");
  assert.strictEqual(humaniseFilename("Screenshot 2026-04-26 211704.png"), "Screenshot");
});

test("humaniseFilename keeps numbers that are part of a word", () => {
  // A standalone counter is noise; "cv2" and "Q3" are how someone tells two
  // otherwise identical files apart.
  assert.strictEqual(humaniseFilename("Quarterly_Report-2024.pdf"), "Quarterly Report 2024");
  assert.strictEqual(humaniseFilename("cv2.txt"), "cv2");
  assert.strictEqual(humaniseFilename("Q3_budget_v2.xlsx"), "Q3 budget v2");
});

test("humaniseFilename keeps short but meaningful names", () => {
  // "cv" is two characters and is the single most identifying thing about
  // cv.txt. A minimum-length guard threw it away, which is how a CV ended up
  // described purely by its file size.
  assert.strictEqual(humaniseFilename("cv.txt"), "cv");
});

test("humaniseFilename returns null when nothing survives", () => {
  assert.strictEqual(humaniseFilename("20240613_101500.jpg"), null);
  assert.strictEqual(humaniseFilename(""), null);
  assert.strictEqual(humaniseFilename(null), null);
});

test("a metadata description never claims to know the contents", () => {
  const file = {
    extension: "zip", size_bytes: 4404019,
    filename_current: "Backup_of_scans_June.zip",
    document_date: null,
  };
  const { description, caption } = buildMetadataDescription(file, { folder: "Backups/2024" });

  assert.match(description, /ZIP archive/);
  assert.match(description, /4\.2 MB/);
  assert.match(description, /Backups\/2024/);
  assert.match(description, /Backup of scans June/);
  // The load-bearing sentence: the reader must be able to tell this apart from
  // a description of what a document says.
  assert.match(description, /Nothing could read its contents/i);
  assert.match(caption, /^ZIP archive/);
});

test("a metadata description prefers the subject it was filed under to the raw folder", () => {
  const file = { extension: "zip", size_bytes: 1024, filename_current: "x.zip" };
  const { description } = buildMetadataDescription(file, {
    subjectPath: "Finance > Statements", folder: "raw/path",
  });
  assert.match(description, /filed under Finance > Statements/);
  assert.doesNotMatch(description, /raw\/path/);
});

test("a metadata description survives a file with nothing to say about it", () => {
  const { description, caption } = buildMetadataDescription(
    { extension: "", size_bytes: 0, filename_current: "0000.bin" }, {}
  );
  assert.ok(description.length > 0);
  assert.ok(caption.length > 0);
});

test("the embedded text drops the metadata boilerplate", () => {
  // Every metadata description ends with the same sentence. Embedded, that
  // makes all of those files neighbours of each other and of every query --
  // a cluster that matches everything equally, which is worse than not
  // matching at all.
  const file = { extension: "zip", size_bytes: 2048, filename_current: "Tax_Returns_2019.zip" };
  const built = buildMetadataDescription(file, { folder: "Docs" });
  const input = buildEmbeddingInput(file, {
    caption: built.caption, description: built.description,
    source: "metadata", subjectPath: "Finance",
  });

  assert.doesNotMatch(input, /Nothing could read its contents/i);
  // What DOES survive is what makes the file findable.
  assert.match(input, /Tax Returns/);
  assert.match(input, /Finance/);
});

test("the embedded text keeps a real description in full", () => {
  const file = { extension: "pdf", size_bytes: 2048, filename_current: "scan01.pdf" };
  const input = buildEmbeddingInput(file, {
    caption: "Electricity bill, June",
    description: "An itemised bill from the utility company covering June.",
    source: "document_text",
    subjectPath: "Finance > Utilities",
    keywords: ["EDL", "meter reading"],
  });

  assert.match(input, /Electricity bill, June/);
  assert.match(input, /itemised bill from the utility company/);
  assert.match(input, /EDL, meter reading/);
});

test("describeKind names formats plainly and falls back honestly", () => {
  assert.strictEqual(describeKind({ extension: "docx" }), "Word document");
  assert.strictEqual(describeKind({ extension: "mp4" }), "MP4 video");
  assert.strictEqual(describeKind({ extension: "jpg" }), "JPG image");
  assert.strictEqual(describeKind({ extension: "qqq" }), "QQQ file");
  assert.strictEqual(describeKind({ extension: "" }), "File");
});

test("formatBytes scales, and refuses to describe a size it does not have", () => {
  assert.strictEqual(formatBytes(512), "512 bytes");
  assert.strictEqual(formatBytes(2048), "2 KB");
  assert.strictEqual(formatBytes(5 * 1048576), "5.0 MB");
  assert.strictEqual(formatBytes(0), null);
  assert.strictEqual(formatBytes(null), null);
});

// ---------------------------------------------------------------------------
// The text quality gate
// ---------------------------------------------------------------------------

test("text the extractor judged unusable is treated as absent", () => {
  // The whole reason textQuality.js exists: a fluent description invented from
  // mojibake is worse than no description, because it is stored AND embedded
  // and becomes what the search matches on forever.
  assert.strictEqual(usableText({ extracted_text: "Ã©Ã¨Ã", text_quality: "gibberish" }), "");
  assert.strictEqual(usableText({ extracted_text: "", text_quality: "empty" }), "");
  assert.strictEqual(usableText({ extracted_text: "  real text  ", text_quality: "ok" }), "real text");
  // No verdict recorded is not the same as a bad verdict.
  assert.strictEqual(usableText({ extracted_text: "real text" }), "real text");
  assert.strictEqual(usableText(null), "");
});

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

test("the model's answer is read, not its thoughts", () => {
  // A `thought` step also carries content. Reading it instead of the answer is
  // a silent wrong-answer bug, not a parse failure -- the caption would just
  // be the model reasoning out loud.
  const text = extractOutputText({
    steps: [
      { type: "thought", content: [{ text: "let me consider the image" }] },
      { type: "model_output", content: [{ type: "text", text: '{"caption":"real"}' }] },
    ],
  });
  assert.strictEqual(text, '{"caption":"real"}');
});

test("every observed envelope shape parses", () => {
  assert.strictEqual(extractOutputText({ output: [{ content: "plain string" }] }), "plain string");
  assert.strictEqual(
    extractOutputText({ candidates: [{ content: { parts: [{ text: "older shape" }] } }] }),
    "older shape"
  );
  assert.strictEqual(extractOutputText({}), null);
  assert.strictEqual(extractOutputText({ steps: [{ type: "model_output", content: [] }] }), null);
});
