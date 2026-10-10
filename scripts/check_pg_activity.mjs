import pg from "pg";

const cs = process.env.DATABASE_URL;
if (!cs) {
  console.error("Missing DATABASE_URL env var");
  process.exit(1);
}
const client = new pg.Client({ connectionString: cs, connectionTimeoutMillis: 30000 });
await client.connect();

const { rows } = await client.query(`
  SELECT pid,
         state,
         wait_event_type,
         wait_event,
         now() - xact_start AS xact_age,
         now() - query_start AS query_age,
         left(query, 120) AS query
  FROM pg_stat_activity
  WHERE datname = current_database()
    AND pid <> pg_backend_pid()
  ORDER BY query_start
`);
console.log(JSON.stringify(rows, null, 2));

await client.end();
