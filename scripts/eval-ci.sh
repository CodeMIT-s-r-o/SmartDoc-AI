#!/usr/bin/env bash
# Tier-1 eval the way CI runs it: a fresh database, migrations, the committed corpus fixture
# (eval/fixtures/eval_corpus.dump) and cached question embeddings. No OpenAI call is made.
#   make eval-ci [ARGS=--include-pending]
set -euo pipefail

DB=smartdoc_evalci
SU=$(docker compose exec -T db sh -c 'echo "${POSTGRES_USER:-postgres}"')
psql_su() { docker compose exec -T db psql -q -v ON_ERROR_STOP=1 -U "$SU" "$@"; }

psql_su -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB OWNER smartdoc_owner"
# Same setup as deploy/db/init-roles.sh: extensions need a superuser; the app role gets DML only.
psql_su -d "$DB" <<SQL
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS btree_gist;
REVOKE CONNECT ON DATABASE $DB FROM PUBLIC;
GRANT CONNECT ON DATABASE $DB TO smartdoc_app;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO smartdoc_app;
ALTER DEFAULT PRIVILEGES FOR ROLE smartdoc_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO smartdoc_app;
SQL

docker compose run --rm -T \
  -e MIGRATE_DATABASE_URL="postgresql://smartdoc_owner:${DB_OWNER_PASSWORD:-smartdoc_owner_dev}@db:5432/$DB" \
  migrate >/dev/null
docker compose exec -T db pg_restore -U smartdoc_owner -d "$DB" --data-only --single-transaction \
  < eval/fixtures/eval_corpus.dump

cd services/ai
EVAL_DATABASE_URL="postgresql://smartdoc_app:${DB_APP_PASSWORD:-smartdoc_app_dev}@127.0.0.1:${DB_PORT:-5432}/$DB" \
  uv run python -m evals.run --offline "$@"
