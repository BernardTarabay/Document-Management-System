// PostgreSQL connection pool + small query/transaction helpers.
// Every repository goes through this module -- no other file should
// `require('pg')` directly (keeps connection handling in one place).
const { Pool } = require("pg");
const env = require("./env");

const pool = new Pool({
  connectionString: env.databaseUrl,
  ssl: env.pgSsl ? { rejectUnauthorized: false } : false,
  max: parseInt(process.env.PG_POOL_MAX || "10", 10),
  idleTimeoutMillis: 30000,
  // Fail rather than hang. Without these, Postgres being down means every
  // request piles up waiting for a connection that is never coming, and a
  // single runaway query holds one of only 10 pool slots indefinitely --
  // ten of those and the whole API stops answering with nothing in the logs
  // to say why.
  connectionTimeoutMillis: parseInt(process.env.PG_CONNECT_TIMEOUT_MS || "10000", 10),
  statement_timeout: parseInt(process.env.PG_STATEMENT_TIMEOUT_MS || "60000", 10),
});

pool.on("error", (err) => {
  // Idle clients emit errors on unexpected disconnects; never crash the process for this.
  // eslint-disable-next-line no-console
  console.error("[db] Unexpected error on idle PostgreSQL client", err);
});

/**
 * Run a single parameterized query.
 * @param {string} text
 * @param {Array} params
 */
async function query(text, params) {
  return pool.query(text, params);
}

/**
 * Run a callback inside a transaction. The callback receives a client with
 * the same `.query(text, params)` signature; commits on success, rolls back
 * on any thrown error.
 * @param {(client: import('pg').PoolClient) => Promise<any>} callback
 */
async function withTransaction(callback) {
  const client = await pool.connect();
  let released = false;
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    // If the ROLLBACK itself fails -- a dropped connection, a server restart
    // mid-transaction -- its error would replace the one that actually caused
    // the failure, reporting "Connection terminated" for what was really a
    // constraint violation. The original error is the one worth keeping.
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      // eslint-disable-next-line no-console
      console.error("[db] ROLLBACK failed; discarding the connection", rollbackErr);
      // Passing the error tells pg to destroy this connection rather than
      // return a client with an open transaction to the pool, where the next
      // caller would inherit it.
      released = true;
      client.release(rollbackErr);
    }
    throw err;
  } finally {
    // `finally` runs even when the catch block throws, so this must not
    // release a client that was already released above -- pg treats a double
    // release as an error.
    if (!released) client.release();
  }
}

async function healthCheck() {
  const { rows } = await pool.query("SELECT 1 AS ok");
  return rows[0]?.ok === 1;
}

module.exports = { pool, query, withTransaction, healthCheck };
