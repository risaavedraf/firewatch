# Backup and restore — local drill and operator runbook

This document is the runbook of `backend/scripts/verify_db_backup_restore.py`,
the harness that turns the backup policy of
[`../../odd/entrega/acta-cierre.md`](../../odd/entrega/acta-cierre.md) §7 from a
written promise into one measured restore. It records the guards that make the
drill safe to run on a developer machine, the commands that run it, how to read
its verdict, and what a green run does **not** prove.

The policy it exercises is the acta's, unchanged:

| Parameter | Value (acta §7) |
| --- | --- |
| Method | full logical backup (`pg_dump`) towards object storage |
| Verification | one complete restore on an isolated instance, timed and recorded |
| Test cadence | monthly, and after any major schema change |
| RPO | **15 minutes** |
| RTO | **1 hour** |
| Not promised | per-second PITR; the chosen RPO does not need it |

## What the drill implements, and what it does not

Implemented and measured by the drill:

1. `pg_dump -Fc` of every service database. The dump is **streamed to stdout** and written by
   the host into a file this run claimed exclusively with `O_CREAT | O_EXCL`, so no process
   inside the container ever writes into the bind-mounted directory.
2. `pg_restore --list` on that archive, verified against every table the source
   database reported.
3. One scratch database **this run creates and names**, then
   `pg_restore --clean --if-exists --no-owner` into it.
4. Two separate assertions: the **schema** (relations, columns, constraints,
   indexes and extensions) and the **rows** (per-table row count plus a SHA-256
   over the table's ordered row hashes), with a PostGIS `ST_AsBinary` digest for
   every geometry column.
5. The **measured** dump duration, backup age and restore-plus-verification
   duration, contrasted with RPO `900 s` and RTO `3600 s`.

**Not** implemented by the drill, and therefore not measured by it: the delivery
to Cloud Storage, the 30-day retention, the encryption at rest and the scheduled
`CronJob` inside the cluster. A green drill is evidence about dump, restore and
timing; it is not evidence that a backup reached a bucket, that an old one is
still there, or that anything runs on a schedule. The monthly cadence is
likewise a policy statement, not an automated schedule.

## Preconditions

| Requirement | Why it fails closed without it |
| --- | --- |
| Docker CLI on `PATH` and its daemon running | every command runs through `docker exec` inside the ephemeral container |
| `postgis/postgis:17-3.5` reachable (present locally, or pullable) | it is the image `backend/docker-compose.yml` and the [schema inventory](schema-inventory.md) were taken with |
| a scratch directory: an **existing** one passed as `--workdir`, or the default run-owned one | the archives live there. An explicit directory must already exist and is never deleted; the default one is derived, created after every guard passes and removed in teardown |
| free loopback port | the container publishes `127.0.0.1::5432`, so the host port is ephemeral |
| nothing else named `fw-v1f14-<run id>` | the container name is unique per run so parallel worktrees cannot collide |

`--workdir` is optional, and the two modes behave differently on purpose. With
an explicit directory the drill requires it to exist, keeps it, and unlinks only
the archives it wrote. Without it the drill derives `fw-v1f14-<run id>` inside
the system temporary directory: preflight proves only that the parent exists, is
a real directory and crosses no symbolic link, and that the derived name is still
free — the directory itself is created after every guard has passed, never during
`--dry-run`, and removed in teardown on the failure path as well as on the
success path. `--keep` skips both removals so a failed run can be inspected.

Ownership is what makes that cleanup safe. Preflight refuses any planned archive
path that already exists, and the write itself is an exclusive claim
(`os.O_CREAT | os.O_EXCL`): a file that appears at the planned path between
preflight and the dump makes the claim fail, so it is neither overwritten nor
recorded as this run's, and teardown cannot delete it. The record is taken only
after the claim succeeds, and teardown unlinks only the archives in that record,
so a file that was never the drill's is left untouched.

The derived directory is inspected **before** any resolution: a dangling
symlink at `fw-v1f14-<run id>` resolves to its absent target, so checking after
`resolve` would pass and the create would make the target instead of refusing the
entry. The leaf is therefore checked unresolved, the creation is an atomic
`os.mkdir` (which fails with `FileExistsError` on a link and never follows it),
and the directory is recorded as created only after that call succeeds, so
teardown can only remove a directory this run actually made.

`--workdir` may be given as a relative path. It is canonicalised during preflight
and the canonical absolute path is what the plan stores, so the archive paths,
their containment check and their `relative_to` computation all speak about the
same directory.

No host `pg_dump`, `pg_restore` or `psql` is needed: the drill runs them inside
the container it created.

## Destructive-target guards

The guards run **before** the container is created, and `--dry-run` runs the very
same functions instead of skipping them, so a dry run cannot become a way to
approve a plan the live run would refuse.

| Guard | Refuses | Function |
| --- | --- | --- |
| Restore target | any name that does not match `^firewatch_restore_drill_[a-z0-9_]{6,32}$`, and `firewatch`, `postgres`, `template0`, `template1`, and any source database | `validate_scratch_database` |
| Host | any non-loopback host; only `127.0.0.1`, `localhost`, `::1` and `127.x.y.z` are accepted, and the published port mapping is re-checked | `validate_host`, `parse_published_port` |
| Container name | anything outside `^fw-v1f14-[a-z0-9]{6,32}$` | `validate_container_name` |
| Archive path | paths that escape `--workdir`, contain `..`, are the directory itself, or cross a symbolic link | `resolve_archive_path` |
| Archive file | missing files, directories, symbolic links, zero-byte files, files below 1024 bytes, and files without the `PGDMP` custom-format magic | `validate_archive_file` |
| Archive destination | a planned archive path that already exists (or is a symlink), checked at preflight **and** again at write time: the file is claimed with `O_CREAT \| O_EXCL`, so a file that appears between the two is refused instead of overwritten, and teardown can never delete operator data | `build_plan`, `dump` |
| Archive contents | an empty table of contents, or one that does not name a `TABLE` and a `TABLE DATA` entry for every source table | `summarise_toc`, `evaluate_toc` |
| Restore target state | a scratch database that already exists: the drill only ever drops a database **it created in this run** | `create_scratch` |
| Ledger | a `schema_migrations` range that does not match the repository (`risk` 1..19, `jobs` 1..7) | `check_ledger` |

Failures are reported as a `FAIL:` line with the reason and a non-zero exit
code; a partially created container is removed by container id with `docker rm
--force --volumes`, so the anonymous `/var/lib/postgresql/data` volume it created
does not outlive the run, and every scratch database this run created is dropped,
on the failure path as well as on the success path.

## Commands

From the repository root. The dry run first, always:

```bash
mkdir -p /tmp/fw-drill
python backend/scripts/verify_db_backup_restore.py --workdir "$(cygpath -w /tmp/fw-drill)" --dry-run
```

`DRY-RUN: every structural guard passed; no container was created and no database
was touched.` and exit `0` mean the plan is admissible. Any other outcome prints
`FAIL: <reason>` and exits `1`.

The live drill. `--workdir` is optional: without it the drill derives
`fw-v1f14-<run id>` under the system temporary directory, creates it once the
guards pass and removes it afterwards, so a one-off run needs no preparation:

```bash
python backend/scripts/verify_db_backup_restore.py --run-id verify02
```

To keep the archives somewhere stable, pass an existing directory instead — the
drill then keeps the directory and unlinks only the archives it wrote:

```bash
mkdir -p /tmp/fw-drill
python backend/scripts/verify_db_backup_restore.py \
  --workdir "$(cygpath -w /tmp/fw-drill)" \
  --run-id drill006 \
  --timeout 900 --ready-timeout 240
```

`--run-id` is optional; when omitted it is derived from a random token and the
container and scratch names follow it. The flags that change behaviour:

| Flag | Effect |
| --- | --- |
| `--workdir DIR` | scratch/output directory that already exists; the drill keeps it and removes only its own archives. Omitted: `fw-v1f14-<run id>` under the system temp directory, created and removed by the run |
| `--run-id ID` | `[a-z0-9]{6,16}`; derived from a random token when omitted |
| `--database NAME` (repeatable) | source database to dump and restore (default `risk`, `jobs`) |
| `--scratch-database NAME` (repeatable) | restore target, validated by the scratch guard; one per `--database` |
| `--archive PATH` (repeatable) | dump path inside `--workdir`, validated for containment (default `<database>.dump`) |
| `--expect-ledger DATABASE=FROM-TO` (repeatable) | expected contiguous ledger range (default `risk=1-19`, `jobs=1-7`) |
| `--max-rpo-seconds`, `--max-rto-seconds` | the thresholds the measurement is contrasted with. Both are **ceilings** (`900`, `3600`): a flag may tighten them for a quicker run and is refused above the acta §7 value or at `0` |
| `--image` | the PostGIS image (default `postgis/postgis:17-3.5`) |
| `--host` | target host; must be loopback |
| `--keep` | leave the container in place for inspection instead of removing it |
| `--dry-run` | structural guards and plan only |

The drill applies the migrations it finds in the repository, in ledger order, in
one transaction per database, mirroring `cmd/server migrate`: `risk` and
`prevention` into the `risk` database's shared `schema_migrations` ledger, and
`jobs` into its own. It reads `risk`'s and `prevention`'s `embed.go` and jobs'
inline registration in `services/jobs/cmd/server/main.go`, and refuses to run
when a file name disagrees with the version registered for it, when a `.sql` file
is not registered at all, or when `risk` and `prevention` claim the same version.
The version rule itself lives in [migration-ledger.md](migration-ledger.md).

It then seeds deterministic literals — zones with `geometry(Polygon/MultiPolygon,
4326)`, a batch with a point, readings, alerts and their per-subject state,
outbox/inbox, jobs including a failed one, audit events, preventive actions with
evidence, history and reassessment, field observations and an adoption.

## Reading the verdict

A passing run prints this block and exits `0`. The numbers below are the
measured run recorded in the next section, not a template:

```text
PASS: the restore matched its backup and both objectives held.
  container:      fw-v1f14-drill006 (127.0.0.1:53426 while it existed)
  workdir:        /tmp/fw-drill
  dump duration:  0.594s       (RPO ceiling 900s)
  backup age:     1.750s       (RPO ceiling 900s)
  restore:        8.031s
  verification:   4.828s
  recovery total: 12.859s       (RTO ceiling 3600s)
  risk: 17 tables, ledger 1..19, 49744 bytes, 119 TOC entries, scratch firewatch_restore_drill_drill006_risk
  jobs: 6 tables, ledger 1..7, 13477 bytes, 33 TOC entries, scratch firewatch_restore_drill_drill006_jobs
  limits: local isolated container only; Cloud Storage delivery, 30-day retention, encryption at rest and the scheduled CronJob remain unimplemented and are not measured here.
```

| Field | Meaning |
| --- | --- |
| `dump duration` | wall-clock `pg_dump` time for the slowest source database. Also checked against the RPO: a dump slower than 15 min cannot sustain a 15-min RPO |
| `backup age` | time between the **oldest** archive finishing and the restore starting — the data-loss window the restored backup would represent |
| `restore` | wall-clock `pg_restore` time for all source databases |
| `verification` | wall-clock time to read both censuses and compare them |
| `recovery total` | `restore` + `verification`, contrasted with the RTO |
| `<database>: N tables` | tables compared, i.e. one row count and one SHA-256 per table |
| `ledger A..B` | observed `schema_migrations` range, checked against the repository |
| `TOC entries` | entries in the archive's table of contents |

A `FAIL:` line names the exact step and the observation that broke it: an
archive that is empty or truncated, a TOC that does not hold a table, a scratch
database that already existed, a table whose row count or digest differs, a
geometry digest that differs, a ledger that does not match, or a duration above
its objective with the measured number in the message.

## Measured evidence

| Item | Value |
| --- | --- |
| Date (UTC) | 2026-11-20 |
| Docker engine | Docker Desktop, server `29.5.3` (linux containers) on Windows |
| Image | `postgis/postgis:17-3.5` (PostgreSQL 17, PostGIS 3.5) |
| Host | one developer machine, single Docker engine, no orchestrator |
| Container | `fw-v1f14-drill006`, published on `127.0.0.1:53426` while it existed, removed afterwards |
| Migrations applied | `risk` + `prevention` 1..19, `jobs` 1..7, from the repository's registered files |
| Tables compared | `risk` 17, `jobs` 6 |
| Archive sizes | `risk` 49 744 bytes (119 TOC entries), `jobs` 13 477 bytes (33 TOC entries) |
| Dump duration | **0.594 s** (RPO ≤ 900 s) |
| Backup age at recovery | **1.750 s** (RPO ≤ 900 s) |
| Restore duration | **8.031 s** |
| Verification duration | **4.828 s** |
| Recovery total | **12.859 s** (RTO ≤ 3600 s) |
| Schema, rows and geometry | 100 % equal: every table's row count and SHA-256 matched, both geometry digests matched, both ledgers matched |
| Second run, same conditions (`drill008`) | dump **0.891 s**, backup age **3.062 s**, restore **4.625 s**, verification **3.641 s**, recovery total **8.266 s**; same 17 + 6 tables, same 100 % equality, no container left behind |
| Run with the streaming `O_EXCL` dump (`verify04`) | dump **0.250 s**, backup age **1.062 s**, restore **1.516 s**, verification **1.500 s**, recovery total **3.016 s**; `risk` 17 tables / ledger 1..19 / 49 742 B / 119 TOC entries, `jobs` 6 tables / ledger 1..7 / 13 477 B / 33 TOC entries, 100 % equality, zero leftover containers, zero temp dirs and a **volume delta of 0** |
| Run with the dump streamed straight into the claimed descriptor (`verify06`) | dump **0.281 s**, backup age **1.078 s**, restore **1.516 s**, verification **1.406 s**, recovery total **2.922 s**; `risk` 17 tables / ledger 1..19 / 49 744 B / 119 TOC entries, `jobs` 6 tables / ledger 1..7 / 13 477 B / 33 TOC entries (the same byte counts as the earlier buffered runs), 100 % equality, zero leftovers and a **volume delta of 0** |
| Run with no `--workdir` (`verify02`, after the teardown fixes) | dump **0.375 s**, backup age **1.672 s**, restore **2.656 s**, verification **2.563 s**, recovery total **5.219 s**; same 17 + 6 tables and same equality, with the derived scratch directory created after the guards and removed afterwards, **zero** leftover containers and a **volume delta of 0** |

Two honest notes about this evidence:

* The **timings are local**: one developer machine, an image already present, and
  no network. They measure the mechanics, not the cluster. The RTO figure a
  production restore would have also includes provisioning, secret handling and
  the object-storage download, none of which this drill performs.
* The **first green run** of the drill reported `verification: 0.000s`. That was
  not a measurement: the restore and the verification clocks were read on
  consecutive lines, so the reported verification was zero by construction and
  the real verification time was folded into `restore`. The drill now times the
  two phases apart (`restore` loop, then census-and-compare loop) and the numbers
  above are from after that correction. A value the harness did not observe is
  not reported as one.

## Negative verification

A comparator that never fails proves nothing, so the drill's refusals are
exercised instead of assumed. The unit suite
([`../scripts/test_verify_db_backup_restore.py`](../scripts/test_verify_db_backup_restore.py))
drives them without Docker; the two live checks below were run by hand.

| Observation | Expected result | Where it is exercised |
| --- | --- | --- |
| one table's digest differs after the restore (a corrupted row) | `row verification failed` naming the table | unit suite |
| one table has fewer rows after the restore (a missing row) | `row verification failed` naming the table and both counts | unit suite |
| a column, constraint, index or extension is missing | `schema verification failed` listing the object | unit suite |
| a geometry digest differs | `PostGIS geometry digest differs` naming the relation | unit suite |
| a zero-byte or truncated archive | `the backup archive … is empty` / TOC check, **before** any scratch database exists | unit suite |
| a scratch database that already exists | refusal naming it; no restore attempted | unit suite |
| a non-loopback host or published mapping | refusal; container removed by id | unit suite |
| `--expect-ledger risk=1-20` on the live local PostGIS container | `FAIL: the risk schema_migrations ledger does not match the repository: observed [1 … 19], expected 1..20; missing [20]` | run live on 2026-11-20 |
| `--scratch-database firewatch` | `FAIL: refusing to restore into the reserved database 'firewatch'` | run live (`--dry-run`) |

## What to do when it fails

| Failure | What it means | Action |
| --- | --- | --- |
| `refusing to restore into …` | the target name is not a scratch database | fix the name; never widen the guard |
| `the backup archive … is empty` / `below the … minimum` | the dump did not produce a usable archive | treat the backup as failed; do not attempt a restore |
| `pg_restore --list could not read …` | the archive is truncated or not custom format | re-take the dump; investigate disk space and `pg_dump` exit status |
| `the archive … does not hold the tables it must restore` | the TOC lacks a table's definition or data | the dump was partial: do not restore it |
| `the restore target … already exists` | a leftover scratch database from an earlier run | drop it yourself after confirming it is a drill target, or change `--run-id` |
| `schema verification failed for …` / `row verification failed for …` | the restored database is not the backed-up one | the restore is not usable; keep the archives and investigate the `pg_restore` output |
| `ledger … does not match the repository` | the drill migrated a different set of versions than the tree registers | fix the registration, do not edit a version that is already recorded |
| `RPO not met` / `RTO not met` | the measured number exceeded the acta's objective | record the breach as a breach, with its number; do not round it away |

## Limits, stated so a green run is not over-read

* **Nothing reaches object storage.** No bucket, no upload, no credential, no
  Workload Identity. The archives live in the run's scratch directory: the
  derived default is removed by the drill, an explicit `--workdir` keeps its
  directory and loses only the archives it wrote, and `--keep` preserves
  everything. The container's anonymous data volume is removed with it.
* **No retention and no encryption at rest.** The 30 days of the acta §7 policy
  and its encryption are not implemented here, so nothing in this document
  proves them.
* **No scheduled `CronJob`.** There is no backup Job in `backend/deploy/k8s/`
  and this drill does not create one; the monthly cadence is a policy line, not
  an automated schedule.
* **No restore in the authorised environment.** Every figure comes from an
  isolated container on a developer machine.
* **No signing.** The drill produces a measurement; it does not close the
  human decision the acta reserves.
* The dump is written straight to disk: `pg_dump`'s stdout is connected to the
  file descriptor this run claimed, so the archive is never buffered in the
  drill's memory. Only `stderr` is captured, for the failure message.
* `spatial_ref_sys` is excluded from the row digests: it is PostGIS extension
  reference data, re-created by `CREATE EXTENSION`, not application data. The
  extension itself is compared as part of the schema assertion.

## References

* Backup policy, RPO/RTO and the restore-test method:
  [`../../odd/entrega/acta-cierre.md`](../../odd/entrega/acta-cierre.md) §7.
* What the front records as measured, and what stays pending:
  [`../../odd/plan-produccion/14-motor-datos-continuidad.md`](../../odd/plan-produccion/14-motor-datos-continuidad.md).
* The migration version rule the ledger check enforces:
  [migration-ledger.md](migration-ledger.md).
* The catalog the schema assertion is compared against:
  [schema-inventory.md](schema-inventory.md).
* The open item this run reduces but does not close:
  [verification.md](verification.md).
* The drill and its unit suite:
  [`../scripts/verify_db_backup_restore.py`](../scripts/verify_db_backup_restore.py),
  [`../scripts/test_verify_db_backup_restore.py`](../scripts/test_verify_db_backup_restore.py).
