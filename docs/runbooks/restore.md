# Runbook: restore the database from a backup

How to bring SmartDoc's Postgres back from a backup onto a server that starts empty, and how the
procedure was tested. The drill is scripted, so it can be repeated after any schema change:

```bash
make restore-drill                 # the dev database (smartdoc)
make restore-drill DB=smartdoc_eval
```

## Targets

| | Target | Measured (2026-10-27, local) |
|---|---|---|
| **RPO** (data that can be lost) | 24 h locally (no scheduled backup), 5 min in the production design (Aurora point-in-time recovery) | not applicable locally |
| **RTO** (time to a verified copy) | ≤ 1 h | **8–11 s**, plus the time to fetch the dump |

## Procedure

`scripts/restore-drill.sh` runs these steps; on a real incident, run the same commands by hand.

1. **Back up** with `pg_dump -Fc` as the owner role, the same way a nightly job would. On the local
   stack the dump comes from the running `db` container.
2. **Start an empty server**:
   - the same image as `compose.yaml` (`pgvector/pgvector:0.8.6-pg18`);
   - the same bootstrap (`deploy/db/init-roles.sh`): the roles `smartdoc_owner` and `smartdoc_app`,
     the databases, the `vector` and `btree_gist` extensions, the grants.
3. **Restore** as the owner role, in one transaction, leaving out the extension entries:
   ```bash
   pg_restore -l backup.dump | grep -v " EXTENSION " > toc.list
   pg_restore -U smartdoc_owner -d smartdoc --single-transaction --exit-on-error -L toc.list backup.dump
   ```
   The extensions already exist (step 2), and only a superuser may comment on them; without the
   list, `pg_restore` stops at `COMMENT ON EXTENSION btree_gist`.
4. **Verify** before pointing the app at it:
   - exact `count(*)` of every table in `public` and `drizzle`, compared with the source;
   - `smartdoc_app` can read (the grants came back with the dump);
   - a nearest-neighbour query on `chunks.embedding` returns rows (the vector type and index came
     back).
5. **Switch** the app's `DATABASE_URL` to the restored server and restart `api`, `ai` and
   `ai-worker`.

## Drill results (2026-10-27)

| Database | Dump | Tables | Largest tables | Server ready | Restore | RTO |
|---|---|---|---|---|---|---|
| `smartdoc` (dev) | 1.5 MB | 17, all equal | 275 retrievals, 218 chunks | 6.9 s | 2.3 s | **10.6 s** |
| `smartdoc_eval` | 7.6 MB | 17, all equal | 1,755 ledger rows, 1,002 chunks | 4.0 s | 2.1 s | **8.2 s** |

The restore includes rebuilding the HNSW and GIN indexes. Most of the RTO is the new server's first
start; the restore itself scales with the data: at the capacity table's 50k chunks (≈ 0.6 GB), expect
minutes, not seconds.

## In production (when deployed)

Aurora keeps 7 days of automated backups with point-in-time recovery, so steps 1–3 become "restore to
a new cluster at time T" ([DEPLOY_PLAN.md](../DEPLOY_PLAN.md), Step 5). The verification in step 4
stays the same.
