#!/usr/bin/env node
// Minimal migration runner: applies db/migrations/*.sql in order, tracked in a
// schema_migrations table. Used by docker-compose init and can be run manually.
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

async function main() {
  const connectionString =
    process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/avdmanager";
  const client = new Client({ connectionString });
  await client.connect();

  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       filename TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  );

  const dir = path.join(__dirname, "..", "db", "migrations");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const { rows } = await client.query(
      "SELECT 1 FROM schema_migrations WHERE filename = $1",
      [file]
    );
    if (rows.length > 0) {
      console.log(`skip (already applied): ${file}`);
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    console.log(`applying: ${file}`);
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  }

  await client.end();
  console.log("migrations complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
