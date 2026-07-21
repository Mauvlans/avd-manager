#!/bin/sh
# Runs pending DB migrations then execs whatever command was passed to the
# container (used as the api service's entrypoint in docker-compose.yml).
# This keeps db/migrate.js as the single source of truth for schema state —
# no duplicate SQL baked into a postgres init script that could drift.
set -e

echo "[entrypoint] waiting for postgres to accept connections..."
until node -e "
const { Client } = require('pg');
const c = new Client({ connectionString: process.env.DATABASE_URL });
c.connect().then(() => c.end()).then(() => process.exit(0)).catch(() => process.exit(1));
"; do
  sleep 1
done

echo "[entrypoint] running migrations..."
node /repo/db/migrate.js

echo "[entrypoint] starting app..."
exec "$@"
