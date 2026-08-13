require("dotenv").config();
const { Client } = require("pg");

(async () => {
  const c = new Client({
    connectionString: process.env.DATABASE_URL
  });

  await c.connect();

  const r = await c.query(`
    SELECT status, COUNT(*)::int AS count
    FROM processing_jobs
    GROUP BY status
    ORDER BY status
  `);

  console.table(r.rows);

  await c.end();
})().catch(e => {
  console.error(e);
  process.exit(1);
});
