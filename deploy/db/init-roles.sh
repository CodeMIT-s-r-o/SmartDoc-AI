#!/usr/bin/env bash
# Runs once, on the first start of an empty Postgres data directory (docker-entrypoint-initdb.d).
#   smartdoc_owner: owns the databases, runs migrations (DDL).
#   smartdoc_app:   DML only; used by api, ai and ai-worker.
set -euo pipefail

: "${DB_OWNER_PASSWORD:?DB_OWNER_PASSWORD is required}"
: "${DB_APP_PASSWORD:?DB_APP_PASSWORD is required}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v owner_pw="$DB_OWNER_PASSWORD" -v app_pw="$DB_APP_PASSWORD" <<'SQL'
CREATE ROLE smartdoc_owner LOGIN PASSWORD :'owner_pw';
CREATE ROLE smartdoc_app LOGIN PASSWORD :'app_pw';
CREATE DATABASE smartdoc OWNER smartdoc_owner;
CREATE DATABASE smartdoc_eval OWNER smartdoc_owner;
-- Target of `make test-db`, so tests never race the dev worker on the dev database.
CREATE DATABASE smartdoc_test OWNER smartdoc_owner;
-- Application roles have no business in the maintenance database.
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
SQL

for db in smartdoc smartdoc_eval smartdoc_test; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" <<SQL
-- Extensions need a superuser; migrations only repeat them with IF NOT EXISTS.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS btree_gist;

REVOKE CONNECT ON DATABASE $db FROM PUBLIC;
GRANT CONNECT ON DATABASE $db TO smartdoc_app;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO smartdoc_app;

-- Tables created by the owner (migrations) are readable and writable by the app role, nothing more.
ALTER DEFAULT PRIVILEGES FOR ROLE smartdoc_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO smartdoc_app;
SQL
done
