// Find a file by describing it.
//
// THREE SIGNALS, FUSED
//
//   semantic   the query and every description as vectors; near means "means
//              the same thing". Survives paraphrase and language: "kid blowing
//              out birthday candles" reaches "a child at a party with a cake",
//              and an English phrase reaches a French description.
//   lexical    the descriptions' own multilingual tsvector. Catches the exact
//              rare token -- a surname, an invoice number, a place name --
//              which is precisely what vectors are worst at.
//   existing   fileRepository.searchEverything, unchanged: filenames, canonical
//              names, and the full text of the documents themselves.
//
// None of the three subsumes the others, which is why all three run. A vector
// search alone stops finding files by exact filename, which users notice
// immediately and correctly regard as a regression.
//
// WHY RECIPROCAL RANK FUSION AND NOT A WEIGHTED SUM OF SCORES
//
// The three produce numbers that are not comparable and not even on the same
// scale. ts_rank is unbounded and corpus-dependent; searchEverything's rank is
// a hand-built 0-1.4 ladder; cosine similarity from this embedding model has a
// high floor -- measured on the live API, two unrelated texts still score 0.55
// and a good match scores 0.81. Normalising three such scales against each
// other means inventing constants that are wrong on the next corpus.
//
// RRF throws the scores away and keeps only the ORDER each signal put things
// in, which is the part that is actually meaningful, then adds 1/(k + rank).
// A file ranked well by two signals beats a file ranked brilliantly by one,
// which is the behaviour wanted: agreement between independent signals is
// stronger evidence than a high number from one of them.
//
// WHY THE CACHE IS PER OWNER
//
// The vectors have to be in memory to be scanned. Loading one account's set is
// bounded by that account's archive, and -- more importantly -- an owner-keyed
// cache cannot serve one user a hit computed from another user's vectors. The
// ownership rules are enforced in the query that fills the cache, so they hold
// for every read of it.
const fileRepository = require("../repositories/fileRepository");
const fileDescriptionRepository = require("../repositories/fileDescriptionRepository");
const embeddingService = require("./ai/embeddingService");
const { requireOwner } = require("../repositories/ownership");

/**
 * RRF's smoothing constant. 60 is the value from the original paper and the
 * one every implementation uses; it flattens the difference between ranks 1
 * and 2 enough that a single signal cannot dominate on its own.
 */
const RRF_K = 60;

/**
 * How deep each signal reports before fusion. Deep enough that a file ranked
 * mediocrely by all three can still surface on agreement, shallow enough that
 * fusion stays cheap.
 */
const CANDIDATES_PER_SIGNAL = 100;

/**
 * Below this cosine similarity a semantic "match" is not evidence.
 *
 * Measured against the live model: unrelated text pairs sit around 0.55, a
 * genuinely relevant pair around 0.81, a cross-language match around 0.72.
 * Without a floor the semantic signal returns its top 100 no matter what was
 * typed -- every query would "match" every file, and fusion would happily
 * promote whatever the vectors ranked first among the irrelevant.
 *
 * 0.62 sits below the cross-language case (which must survive) and above the
 * unrelated baseline.
 */
const MIN_SIMILARITY = Number(process.env.DESCRIPTION_SEARCH_MIN_SIMILARITY || "0.62");

// --- the vector cache ------------------------------------------------------

const caches = new Map(); // ownerUserId -> { vectors, count, latest, loadedAt }

/**
 * Rebuild an owner's cache when the stored set has changed.
 *
 * Staleness is decided by (row count, newest updated_at) rather than by a
 * timer. A timer either rebuilds constantly or serves stale results for its
 * whole interval; this pair changes exactly when a description is written, so
 * a newly described file becomes searchable on the next query rather than at
 * the next tick.
 */
async function loadCache(ownerUserId) {
  const watermark = await fileDescriptionRepository.embeddingWatermark(ownerUserId);
  const cached = caches.get(ownerUserId);

  const latest = watermark?.latest ? new Date(watermark.latest).getTime() : 0;
  const count = watermark?.count || 0;

  if (cached && cached.count === count && cached.latest === latest) return cached;

  const rows = await fileDescriptionRepository.listEmbeddingsForOwner(ownerUserId);
  const vectors = [];
  for (const row of rows) {
    const vector = embeddingService.decode(row.embedding);
    // A row embedded by a different model at a different dimensionality cannot
    // be compared with the current query vector. Skipping it is right: it
    // stays findable lexically, and it will be re-embedded by the backfill.
    if (!vector || vector.length !== embeddingService.DIMS) continue;
    vectors.push({ fileId: row.file_id, vector });
  }

  const fresh = { vectors, count, latest, loadedAt: Date.now() };
  caches.set(ownerUserId, fresh);
  return fresh;
}

/** Drop a cache. Used by tests and by anything that mass-deletes descriptions. */
function invalidate(ownerUserId = null) {
  if (ownerUserId) caches.delete(ownerUserId);
  else caches.clear();
}

// --- the three signals -----------------------------------------------------

/**
 * @returns {Promise<{results: {fileId: string, score: number}[], ran: boolean}>}
 *
 * `ran` and a non-empty `results` are deliberately separate facts. "The
 * semantic signal found nothing above the floor" is a real answer about the
 * archive; "the query could not be embedded, so the semantic signal never
 * ran" is a degraded search that happens to look identical from outside.
 * Collapsing them would let an expired API key quietly turn this back into
 * keyword search with nothing on screen to say so.
 */
async function semanticCandidates(query, ownerUserId, limit) {
  const queryVector = await embeddingService.embedQuery(query);
  if (!queryVector) return { results: [], ran: false };

  const { vectors } = await loadCache(ownerUserId);
  if (!vectors.length) return { results: [], ran: true };

  const scored = [];
  for (const entry of vectors) {
    const score = embeddingService.similarity(entry.vector, queryVector);
    if (score >= MIN_SIMILARITY) scored.push({ fileId: entry.fileId, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return { results: scored.slice(0, limit), ran: true };
}

async function lexicalDescriptionCandidates(query, ownerUserId, limit) {
  const rows = await fileDescriptionRepository.searchLexical(query, ownerUserId, { limit });
  return rows.map((row) => ({ fileId: row.file_id, score: Number(row.rank) }));
}

// --- fusion ----------------------------------------------------------------

/**
 * Reciprocal rank fusion over any number of ranked lists.
 *
 * @param {Array<{name: string, results: Array<{fileId: string, score: number}>}>} signals
 * @returns {Array<{fileId: string, score: number, matchedBy: string[], scores: object}>}
 */
function fuse(signals) {
  const combined = new Map();

  for (const { name, results } of signals) {
    results.forEach((result, index) => {
      const existing = combined.get(result.fileId) || {
        fileId: result.fileId, score: 0, matchedBy: [], scores: {},
      };
      existing.score += 1 / (RRF_K + index + 1);
      existing.matchedBy.push(name);
      existing.scores[name] = result.score;
      combined.set(result.fileId, existing);
    });
  }

  return [...combined.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // A deterministic tiebreak. Without one, two files with identical fusion
    // scores can swap places between identical queries, which reads as the
    // search being unstable.
    return a.fileId < b.fileId ? -1 : 1;
  });
}

/**
 * Why a file came back, in words the UI can show.
 *
 * Users trust a result they understand. "Matched its description" and "matched
 * text inside the document" are different claims about different evidence, and
 * a search that says which is far easier to correct when it is wrong.
 */
function explain(matchedBy) {
  const reasons = [];
  if (matchedBy.includes("semantic")) reasons.push("description");
  if (matchedBy.includes("description")) reasons.push("description wording");
  if (matchedBy.includes("content")) reasons.push("file contents or name");
  return reasons;
}

// --- the entry point -------------------------------------------------------

/**
 * Search by describing a file.
 *
 * @param {string} query - free text, as the user typed it
 * @param {object} opts
 * @param {object} opts.filters - parseFileFilters() output; carries the owner
 * @param {number} [opts.limit]
 * @param {number} [opts.offset]
 * @returns {Promise<{files: object[], semanticUsed: boolean, total: number}>}
 */
async function search(query, { filters, limit = 50, offset = 0 } = {}) {
  const ownerUserId = requireOwner(filters?.ownerUserId, "descriptionSearch.search");
  const term = String(query || "").trim();
  if (!term) return { files: [], semanticUsed: false, total: 0 };

  // The three signals are independent, so they run together. The semantic one
  // includes a network round trip for the query embedding, and waiting for it
  // before starting two database queries would make every search that much
  // slower for no reason.
  const [semantic, lexical, existing] = await Promise.all([
    semanticCandidates(term, ownerUserId, CANDIDATES_PER_SIGNAL),
    lexicalDescriptionCandidates(term, ownerUserId, CANDIDATES_PER_SIGNAL),
    fileRepository.searchEverything(term, { limit: CANDIDATES_PER_SIGNAL, offset: 0, filters }),
  ]);

  const fused = fuse([
    { name: "semantic", results: semantic.results },
    { name: "description", results: lexical },
    { name: "content", results: existing.map((row) => ({ fileId: row.id, score: Number(row.rank) })) },
  ]);

  const page = fused.slice(offset, offset + limit);
  if (!page.length) return { files: [], semanticUsed: semantic.ran, total: fused.length };

  // The two description signals return ids only, so the rows for anything the
  // existing search did not already return have to be fetched -- scoped by
  // owner, which is what makes it safe to have carried bare ids this far.
  const alreadyLoaded = new Map(existing.map((row) => [row.id, row]));
  const missingIds = page.map((hit) => hit.fileId).filter((id) => !alreadyLoaded.has(id));
  if (missingIds.length) {
    const rows = await fileRepository.listByIdsForOwner(missingIds, ownerUserId);
    for (const row of rows) alreadyLoaded.set(row.id, row);
  }

  const files = [];
  for (const hit of page) {
    const row = alreadyLoaded.get(hit.fileId);
    // A hit whose file did not come back from an owner-scoped fetch is a file
    // this user may not see. Dropping it silently is correct -- it is the last
    // line of the ownership guarantee, after the per-signal scoping.
    if (!row) continue;
    files.push({
      ...row,
      rank: hit.score,
      matched_by: hit.matchedBy,
      match_reasons: explain(hit.matchedBy),
      similarity: hit.scores.semantic ?? null,
    });
  }

  return { files, semanticUsed: semantic.ran, total: fused.length };
}

module.exports = {
  search, fuse, invalidate, loadCache,
  RRF_K, MIN_SIMILARITY, CANDIDATES_PER_SIGNAL,
};
