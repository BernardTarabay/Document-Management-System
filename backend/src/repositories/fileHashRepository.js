const db = require("../config/database");

async function upsert(fileId, algorithm, hashValue) {
  const { rows } = await db.query(
    `INSERT INTO file_hashes (file_id, algorithm, hash_value)
     VALUES ($1, $2, $3)
     ON CONFLICT (file_id, algorithm) DO UPDATE SET hash_value = EXCLUDED.hash_value, computed_at = now()
     RETURNING *`,
    [fileId, algorithm, hashValue]
  );
  return rows[0];
}

async function findByFile(fileId) {
  const { rows } = await db.query("SELECT * FROM file_hashes WHERE file_id = $1", [fileId]);
  return rows;
}

async function findByAlgorithmAndValue(algorithm, hashValue) {
  const { rows } = await db.query(
    "SELECT * FROM file_hashes WHERE algorithm = $1 AND hash_value = $2",
    [algorithm, hashValue]
  );
  return rows;
}

module.exports = { upsert, findByFile, findByAlgorithmAndValue };
