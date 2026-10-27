#!/usr/bin/env bash
# Restore drill (docs/runbooks/restore.md): back up a database of the running stack, restore it into
# a scratch Postgres that starts empty like a new host, and prove the copy is whole. Prints the
# timings; the RTO is the time from starting the scratch server to a verified restore.
#   make restore-drill [DB=smartdoc]
set -euo pipefail

DB=${DB:-smartdoc}
IMAGE=pgvector/pgvector:0.8.6-pg18 # the image compose.yaml runs
SCRATCH=smartdoc-restore-drill
WORK=$(mktemp -d)
trap 'docker rm -f "$SCRATCH" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

now() { python3 -c 'import time; print(time.time())'; }
since() { python3 -c "print(f'{$(now) - $1:.1f} s')"; }
counts() { # one "table rows" line per table in public and drizzle, exact counts
  "$@" -At -v ON_ERROR_STOP=1 <<'SQL'
SELECT format('SELECT %L || '' '' || count(*) FROM %I.%I', schemaname || '.' || tablename,
              schemaname, tablename)
  FROM pg_tables WHERE schemaname IN ('public', 'drizzle') ORDER BY 1 \gexec
SQL
}

echo "1. Backup: pg_dump -Fc of $DB (as the owner role, as the nightly job would)"
started=$(now)
docker compose exec -T db pg_dump -U smartdoc_owner -d "$DB" -Fc -Z 6 >"$WORK/backup.dump"
counts docker compose exec -T db psql -U smartdoc_owner -d "$DB" >"$WORK/source.txt"
echo "   $(du -h "$WORK/backup.dump" | cut -f1), $(wc -l <"$WORK/source.txt" | tr -d ' ') tables, $(since "$started")"

echo "2. Scratch server: an empty $IMAGE with the same role bootstrap as compose"
rto=$(now)
docker run -d --name "$SCRATCH" \
  -e POSTGRES_PASSWORD=drill -e DB_OWNER_PASSWORD=drill -e DB_APP_PASSWORD=drill \
  -v "$PWD/deploy/db/init-roles.sh:/docker-entrypoint-initdb.d/10-init-roles.sh:ro" \
  "$IMAGE" >/dev/null
# During the init scripts the server listens on its socket only; TCP answers once they are done.
until docker exec "$SCRATCH" pg_isready -U postgres -d smartdoc -h 127.0.0.1 >/dev/null 2>&1; do
  sleep 0.5
done
echo "   ready after $(since "$rto")"

echo "3. Restore: pg_restore into the empty $DB database, one transaction"
restore=$(now)
docker exec -i "$SCRATCH" sh -c "cat > /tmp/backup.dump" <"$WORK/backup.dump"
docker exec "$SCRATCH" psql -q -U postgres -d postgres -c "CREATE DATABASE $DB OWNER smartdoc_owner" \
  2>/dev/null || true
# Extensions belong to the superuser bootstrap (init-roles.sh), as on a new host, so their
# entries (CREATE and COMMENT ON EXTENSION) are left out of what the owner role restores.
docker exec "$SCRATCH" sh -c 'pg_restore -l /tmp/backup.dump | grep -v " EXTENSION " > /tmp/toc.list'
docker exec "$SCRATCH" pg_restore -U smartdoc_owner -d "$DB" --single-transaction --exit-on-error \
  -L /tmp/toc.list /tmp/backup.dump
echo "   restored in $(since "$restore")"

echo "4. Verify: exact row counts, the app role's access, and a vector query"
counts docker exec -i "$SCRATCH" psql -U smartdoc_owner -d "$DB" >"$WORK/restored.txt"
if ! diff -u "$WORK/source.txt" "$WORK/restored.txt"; then
  echo "FAIL: row counts differ" >&2
  exit 1
fi
docker exec "$SCRATCH" psql -U smartdoc_app -d "$DB" -v ON_ERROR_STOP=1 -Atc \
  "SELECT count(*) FROM documents" >/dev/null
nearest=$(docker exec "$SCRATCH" psql -U smartdoc_app -d "$DB" -v ON_ERROR_STOP=1 -Atc \
  "SELECT count(*) FROM (SELECT id FROM chunks ORDER BY embedding <=> (SELECT embedding FROM chunks LIMIT 1) LIMIT 5) t")
total=$(since "$rto")

echo
column -t "$WORK/restored.txt" | sed 's/^/   /'
echo
echo "PASS: $(wc -l <"$WORK/restored.txt" | tr -d ' ') tables match, app role can read, vector query returned $nearest rows"
echo "RTO (scratch server start → verified restore): $total"
