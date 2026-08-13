// Shared ioredis connection for BullMQ (spec §7: "Redis, BullMQ, Node.js
// workers"). BullMQ requires maxRetriesPerRequest: null on the connection it
// manages -- documented BullMQ requirement, not optional tuning.
const IORedis = require("ioredis");
const env = require("./env");

let connection;

function getRedisConnection() {
  if (!connection) {
    connection = new IORedis(env.redisUrl, {
      maxRetriesPerRequest: null,
    });
    connection.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("[redis] Connection error", err.message);
    });
  }
  return connection;
}

/**
 * Close the shared connection so a short-lived process can exit.
 *
 * An ioredis connection keeps the Node event loop alive indefinitely. That
 * is correct for the API and worker, which are meant to run forever, but it
 * silently hangs one-shot CLI scripts (backend/scripts/*, src/db/*) after
 * their work is done -- they finish, print, and then just sit there.
 */
async function closeRedisConnection() {
  if (!connection) return;
  const open = connection;
  connection = null;
  try {
    await open.quit();
  } catch {
    open.disconnect();
  }
}

module.exports = { getRedisConnection, closeRedisConnection };
