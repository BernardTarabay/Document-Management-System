// Reads and writes for file_descriptions (migration 035).
//
// Every read here takes an owner, for the reason ownership.js sets out: the
// leak in a multi-tenant schema is in the QUERIES, not the routes. A
// description is a sentence about the contents of somebody's private document,
// so an unscoped read of this table is a worse disclosure than an unscoped
// read of `files` -- the row IS the sensitive part, not a pointer to it.
const db = require("../config/database");
const { tsQueryExpression } = require("./fileContentRepository");
const { requireOwner } = require("./ownership");

/**
 * Write (or rewrite) one file's description.
 *
 * Deliberately does NOT touch the embedding columns. The description and its
 * vector are produced by two different calls to two different APIs, and the
 * second can fail while the first succeeded -- collapsing them into one write
 * would mean either discarding a good description because its embedding failed
 * or storing an embedding of text that was never saved. setEmbedding() is the
 * separate second step.
 */
async function upsert(fileId, {
  ownerUserId, description = null, caption = null, source,
  detail = {}, failureReason = null,
}) {
  requireOwner(ownerUserId, "fileDescriptions.upsert");
  const { rows } = await db.query(
    `INSERT INTO file_descriptions
       (file_id, owner_user_id, description, caption, source, detail, failure_reason, generated_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())
     ON CONFLICT (file_id) DO UPDATE SET
       description    = EXCLUDED.description,
       caption        = EXCLUDED.caption,
       source         = EXCLUDED.source,
       detail         = EXCLUDED.detail,
       failure_reason = EXCLUDED.failure_reason,
       generated_at   = now(),
       updated_at     = now()
     RETURNING *`,
    [fileId, ownerUserId, description, caption, source, JSON.stringify(detail || {}), failureReason]
  );
  return rows[0];
}

/**
 * Attach the vector for a description that has already been stored.
 *
 * The WHERE clause is not redundant: an embedding written against a row whose
 * description has since been regenerated would index text that no longer
 * exists there, and the search would then return files for phrases their
 * description does not contain. Matching on the exact input that was embedded
 * makes a late-arriving embedding a no-op instead of a lie.
 */
async function setEmbedding(fileId, { buffer, dims, model, input }) {
  const { rows } = await db.query(
    `UPDATE file_descriptions
        SET embedding = $2, embedding_dims = $3, embedding_model = $4,
            embedding_input = $5, embedded_at = now(), updated_at = now()
      WHERE file_id = $1
      RETURNING file_id`,
    [fileId, buffer, dims, model, input]
  );
  return rows[0] || null;
}

async function findByFile(fileId) {
  const { rows } = await db.query("SELECT * FROM file_descriptions WHERE file_id = $1", [fileId]);
  return rows[0] || null;
}

async function findByFileForOwner(fileId, ownerUserId) {
  requireOwner(ownerUserId, "fileDescriptions.findByFileForOwner");
  const { rows } = await db.query(
    "SELECT * FROM file_descriptions WHERE file_id = $1 AND owner_user_id = $2",
    [fileId, ownerUserId]
  );
  return rows[0] || null;
}

/**
 * Every embedded description belonging to one account, for the search cache.
 *
 * Joined to `files` and filtered to non-deleted rows here rather than in the
 * caller: a removed file must not be a search hit, and a cache that holds it
 * would keep returning it until the process restarts.
 *
 * Returns the raw bytea Buffers -- decoding into Float32Arrays is the search
 * layer's job, because it is the thing that knows how long it wants to keep
 * them alive.
 */
async function listEmbeddingsForOwner(ownerUserId) {
  requireOwner(ownerUserId, "fileDescriptions.listEmbeddingsForOwner");
  const { rows } = await db.query(
    `SELECT d.file_id, d.embedding, d.embedding_dims, d.updated_at
       FROM file_descriptions d
       JOIN files f ON f.id = d.file_id
      WHERE d.owner_user_id = $1
        AND d.embedding IS NOT NULL
        AND f.status <> 'deleted'`,
    [ownerUserId]
  );
  return rows;
}

/** The newest updated_at in one owner's set, used to decide if a cache is stale. */
async function embeddingWatermark(ownerUserId) {
  requireOwner(ownerUserId, "fileDescriptions.embeddingWatermark");
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS count, MAX(d.updated_at) AS latest
       FROM file_descriptions d
       JOIN files f ON f.id = d.file_id
      WHERE d.owner_user_id = $1 AND d.embedding IS NOT NULL AND f.status <> 'deleted'`,
    [ownerUserId]
  );
  return rows[0];
}

/**
 * Lexical match against the description text.
 *
 * The semantic half of the search handles paraphrase; this half handles the
 * opposite case, where someone remembers an exact word -- a surname, an
 * invoice number, a place -- that appears in the description verbatim. Vectors
 * are notably bad at exact rare tokens, which is precisely why both halves
 * exist rather than one replacing the other.
 */
async function searchLexical(query, ownerUserId, { limit = 50 } = {}) {
  requireOwner(ownerUserId, "fileDescriptions.searchLexical");
  const tsQuery = tsQueryExpression(1);
  const { rows } = await db.query(
    `SELECT d.file_id, ts_rank(d.search_vector, ${tsQuery}) AS rank
       FROM file_descriptions d
       JOIN files f ON f.id = d.file_id
      WHERE d.owner_user_id = $2
        AND f.status <> 'deleted'
        AND d.search_vector @@ (${tsQuery})
      ORDER BY rank DESC
      LIMIT $3`,
    [query, ownerUserId, limit]
  );
  return rows;
}

/**
 * Descriptions for a batch of files, as a Map of file id -> description text.
 *
 * The listing queries decorate a file with its subject, location and naming
 * state (fileRepository.FILE_DECORATION_COLUMNS) but deliberately not with its
 * description -- it is long, and no table view has room for it. Anything that
 * needs the description for a set of files it already has therefore has to ask
 * for it, and asking once for the whole set beats a query per file.
 *
 * The assistant is the caller this exists for: it was describing files to the
 * user with nothing but a filename to go on (see aiChatController), which is
 * why it could not find a photo by what is in it.
 *
 * Rows with no description text are omitted rather than returned as null --
 * "this file has no description" and "this file was not asked about" are the
 * same thing to every caller, and a Map that only holds real values makes the
 * absent case impossible to render as the string "null".
 */
async function descriptionsForFiles(fileIds, ownerUserId) {
  requireOwner(ownerUserId, "fileDescriptions.descriptionsForFiles");
  if (!Array.isArray(fileIds) || fileIds.length === 0) return new Map();
  const { rows } = await db.query(
    `SELECT file_id, description
       FROM file_descriptions
      WHERE file_id = ANY($1::uuid[])
        AND owner_user_id = $2
        AND description IS NOT NULL
        AND description <> ''`,
    [fileIds, ownerUserId]
  );
  return new Map(rows.map((r) => [r.file_id, r.description]));
}

/**
 * Files that have no description row at all, or whose description failed and
 * is worth another attempt. The backfill script's work list.
 *
 * 'failed' rows are included and 'metadata' rows are not: a metadata
 * description is a finished, correct outcome for a file nothing can read, and
 * re-running it would spend the daily cap re-deriving the same sentence from
 * the same unchanged facts.
 */
async function listNeedingDescription(ownerUserId, { limit = 500, includeFailed = true } = {}) {
  requireOwner(ownerUserId, "fileDescriptions.listNeedingDescription");
  const { rows } = await db.query(
    `SELECT f.id, f.filename_current, f.extension, f.is_image
       FROM files f
       LEFT JOIN file_descriptions d ON d.file_id = f.id
      WHERE f.owner_user_id = $1
        AND f.status NOT IN ('deleted', 'missing')
        AND (d.file_id IS NULL OR ($2::boolean AND d.source = 'failed'))
      ORDER BY f.imported_at DESC
      LIMIT $3`,
    [ownerUserId, includeFailed, limit]
  );
  return rows;
}

/** Coverage, by evidence type. What verify-descriptions.js reports. */
async function countBySource(ownerUserId) {
  requireOwner(ownerUserId, "fileDescriptions.countBySource");
  const { rows } = await db.query(
    `SELECT COALESCE(d.source, '(none)') AS source,
            COUNT(*)::int AS files,
            COUNT(d.embedding)::int AS embedded
       FROM files f
       LEFT JOIN file_descriptions d ON d.file_id = f.id
      WHERE f.owner_user_id = $1 AND f.status NOT IN ('deleted', 'missing')
      GROUP BY 1
      ORDER BY 2 DESC`,
    [ownerUserId]
  );
  return rows;
}

/**
 * Adopt a byte-identical twin's description.
 *
 * Same reasoning as classifyProcessor's sibling reuse and knownContentService:
 * identical bytes are the same document, so a second API call would spend
 * money to arrive at the same sentence. Scoped to one owner, because identical
 * bytes in two accounts are two unrelated documents that happen to match.
 */
async function findDescribedTwin(sha256Hash, excludeFileId, ownerUserId) {
  if (!sha256Hash) return null;
  requireOwner(ownerUserId, "fileDescriptions.findDescribedTwin");
  const { rows } = await db.query(
    `SELECT d.*
       FROM file_descriptions d
       JOIN files f ON f.id = d.file_id
      WHERE f.sha256_hash = $1
        AND f.id <> $2
        AND f.owner_user_id = $3
        AND f.status <> 'deleted'
        AND d.description IS NOT NULL
        AND d.source NOT IN ('failed', 'metadata')
      ORDER BY d.generated_at DESC
      LIMIT 1`,
    [sha256Hash, excludeFileId, ownerUserId]
  );
  return rows[0] || null;
}

module.exports = {
  upsert, setEmbedding, findByFile, findByFileForOwner,
  listEmbeddingsForOwner, embeddingWatermark, searchLexical,
  descriptionsForFiles,
  listNeedingDescription, countBySource, findDescribedTwin,
};
