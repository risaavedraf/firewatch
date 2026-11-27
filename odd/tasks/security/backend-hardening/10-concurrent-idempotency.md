# BH-10 — Prove idempotency under concurrent and reordered work

**Status:** pending | **Priority:** P2 | **Dependencies:** BH-01; isolated test databases/broker resources; coordinate BH-07.

## Evidence and scope

The reviewed repository tests are sequential. They do not prove concurrency safety. Earlier application-database tests emitted events, so this task must not reuse the application database or production-connected event resources.

Test simultaneous requests and event processing at the persistence boundary, including unique constraints and atomic rollback. Do not assume an existing defect from the coverage gap.

## Acceptance checklist

- [ ] Require isolated test databases and event infrastructure with explicit safeguards against application targets.
  - **Database half exercised 2026-11-20 and again 2026-11-27, behind a fail-closed guard** (see *Target guard* below): the DSN is parsed and validated **before any connection**, every parsed host including fallbacks must be loopback or the exact compose alias, the database must be exactly `jobs_test` and the role exactly `jobs_app`, and the connected session must report `current_database()=jobs_test` and `current_user=jobs_app` before the first write. A malformed DSN gets a fixed message, never the driver text. The guard **rejects accidental configuration; it is not ownership proof** — the owned fixture was attested separately by the runner (per-run label, tmpfs-only storage, daemon-reported loopback port), and nothing here claims that arbitrary targets are safe. **Event-infrastructure half is not exercised:** the effect asserted is the persisted `outbox`/`audit`/`inbox` row, not a broker delivery, and no broker is claimed.
- [x] Verify simultaneous same-actor/same-key requests produce the agreed single logical result/effect.
  - Measured at the `Create` boundary on 2026-11-20 (`TestConcurrentCreateSameIdentityConvergesOnOneJobAndOneEffect`). Not measured for event processing or a broker; see *Session evidence* below.
- [x] Verify distinct actors and keys remain independent under concurrency.
  - Measured at the `Create` boundary on 2026-11-20 (`TestConcurrentCreateKeepsActorAndKeyIndependent`), in **one** wave: one identity asked four times, three other keys of the same actor, and three other actors asking the same key. Actor-only and key-only coupling are therefore both excluded by tests, not by construction. The wave gate releases all requests together; it does not prove they overlapped inside the server (see the limitation below). Same event-side caveat.
- [~] Cover duplicate/reordered events, uniqueness conflicts, and rollback with no partial state or duplicate effects.
  - **Persistence half measured 2026-11-27** (`event_idempotency_integration_test.go`, five cases, all at the persistence boundary): the same completion delivered twice and eight concurrent copies of it apply one effect; eight concurrent distinct events naming the stored batch still apply one; a reordered completion naming a foreign batch is permanent and leaves the stored row and the audit untouched; an unknown job is permanent; and in both permanent cases the `inbox` gate row inserted first is **rolled back with the transaction**. The uniqueness conflict beyond the request key is the `inbox` primary key. The rollback half of `Create` was measured separately on 2026-11-20 (`TestCreateRollsBackEveryWriteWhenTheAuditInsertFails`). **The AMQP transport half — broker-driven redelivery, reordering and publish/consume ordering — remains unmeasured**, so this item stays partial rather than satisfied.

## Verification

**Checks status:** partially run — the `Create`-boundary concurrency slice and its target guard ran on 2026-11-20, and the **event-side persistence slice** ran on 2026-11-27, both against a password-authenticated disposable container. Broker redelivery, publish/consume ordering and connection-level failure remain pending, and no broker is claimed anywhere below.

Run synchronized concurrency scenarios and controlled transaction failures against isolated infrastructure. Assert persisted records and emitted effects, not only response codes; capture repeatability and cleanup evidence.

### Session evidence — `Create` boundary only (2026-11-20)

**What was added.** `backend/services/jobs/internal/repository/concurrent_idempotency_integration_test.go`, test-only: no production file, migration or schema was changed. It carries a target guard, three `Create` cases — (a) eight simultaneous `Create` calls for the same actor and key, half asking a different scenario; (b) **one wave of ten requests over seven identities**: one identity asked four times, three more keys of that same actor, and three more actors asking that same key; (c) one `Create` whose audit insert fails in the server, followed by a retry on the same identity — and the guard's own test. The file is 433 lines; the same-actor/different-key and different-actor/same-key cases were added by reshaping the existing wave, not by adding a new test.

**Cross-field independence (the review finding).** The earlier mixed wave changed actor and key together, so it could not distinguish a conflict rule coupled on the actor alone from one coupled on the key alone. The wave now holds one field fixed and varies the other, and the assertions are per identity: every response must equal the row its own identity persisted, no two identities may own the same job, and each identity must have exactly one job under its own `(actor_id, idempotency_key)`, one effect whose payload carries that job id **and** that actor, and one `job.requested` audit row for that job and actor. An actor-only coupling would collapse the three same-actor keys to one job (the other two identities would have zero jobs and the owner would be claimed twice); a key-only coupling does the same to the three distinct actors sharing the key.

**Test-first, reported honestly.** The new assertions were written before any run. Their first execution **failed for a test-side reason, not a behaviour one**: the job-scoped effect check compared `jsonb` text against a parameter the driver had typed as `uuid`, and PostgreSQL answered `operator does not exist: text = uuid (SQLSTATE 42883)`. The cast was made explicit (`(payload->>'job_id')::uuid`), the same assertions then **passed against the unchanged `Create`**, and repeated green afterwards. So: **no RED of behaviour was observed — the baseline already satisfies the rule** — and no destructive counterfactual was used to manufacture one. The only RED in this session remains the guard's, recorded below.

**Fixture.** Unique disposable Docker Desktop container (`--context desktop-linux`, `--tmpfs` data directory, `mounts=[]`, per-run label, random loopback port) of `postgis/postgis:17-3.5` (`sha256:01a6a70e41e6…`), addressed only by the **full ID returned by `docker run`** after the runner attested it: the ID is 64 hex, `inspect .Id` equals it, the run label resolves to exactly that ID, `HostConfig.Tmpfs` holds `/var/lib/postgresql/data`, no `volume`/`bind` mount exists, and the published mapping is the daemon-reported `127.0.0.1:<random port>` for that ID. The DSN was derived only from those attested values plus a fresh per-run password; ambient `TEST_DATABASE_URL`, `DATABASE_URL` and `PGPASSWORD` were unset and reported unused. This run used **password authentication, not trust**: random `POSTGRES_PASSWORD` with `--auth-host=scram-sha-256`, roles and databases initialised with the repository's own `backend/deploy/local/postgres-init.sh` and a real `JOBS_DB_PASSWORD`, migrations applied as the owner with a password, tests connected as `jobs_app` with a password. Passwordless loopback psql failed for both roles with `fe_sendauth: no password supplied`. The first attempt was **refused by the ownership gate itself** because `docker ps --format '{{.ID}}'` truncates IDs; no write had happened, and `--no-trunc` made the label resolve to the full ID. No application database, broker, VM or Kubernetes was involved.

**Observed properties.** All eight same-identity answers equalled each other and the persisted row, including the stored scenario and evaluation instant for the requests that lost the insert race; exactly one `jobs` row, one `outbox` row and one `job.requested` audit row existed for the identity; the single outbox message carried the converged job id and the same winning trace as the single audit row; a later retry with a different scenario returned the stored job and left those matching counts unchanged. In the ten-request wave the seven identities produced seven distinct jobs, every response equalled its own stored row, the four identities sharing one actor kept four different jobs, and the four sharing one key did too; each identity kept exactly one job, one actor-attributed effect for that job and one audit row. In the rollback case the error was the server's `22P02` data exception, the identity kept zero job/effect/audit rows, and the retry on the same identity succeeded with exactly one of each.

**Overlap limitation.** The wave releases every goroutine from one closed channel, so the requests are concurrent *in intent*, but nothing in the test proves the statements were in flight in the server at the same time: there is no database-side barrier, no admission control and no instrumentation of concurrent backends. The proof is that the persisted outcome is correct when all requests are admitted together, not that a specific interleaving occurred. A run could in principle serialise them and still pass.

**Commands and results.**

```bash
# roles with real passwords, migrations as the owner (password authenticated)
DATABASE_URL='postgres://postgres:<pw>@127.0.0.1:<port>/jobs_test?sslmode=disable' APP_ENV=development \
  GOWORK=off GOTOOLCHAIN=go1.27.4 go run -mod=readonly ./cmd/server migrate   # zones_seeded count=38, exit 0

# guard + slice, two bounded repetitions on the final artifact, as jobs_app (password authenticated)
TEST_DATABASE_URL='postgres://jobs_app:<pw>@127.0.0.1:<port>/jobs_test?sslmode=disable' \
  GOWORK=off GOTOOLCHAIN=go1.27.4 go test -mod=readonly -count=2 -v \
  -run 'TestDisposableTarget|TestConcurrentCreateSameIdentityConvergesOnOneJobAndOneEffect|TestConcurrentCreateKeepsActorAndKeyIndependent|TestCreateRollsBackEveryWriteWhenTheAuditInsertFails' \
  ./internal/repository/                                                     # 8/8 PASS, exit 0
# the same four cases had also run 12/12 PASS at -count=3 before the file was reformatted

# existing repository integration subset (Create/Complete/Replay)
TEST_DATABASE_URL=… go test -mod=readonly -count=1 -v -run 'TestTransactionalIdempotencyAndAudit|TestCompleteEnforcesStoredZoneRelationship|TestSyntheticScenarioMetadataIsAssignedOnceAndSurvivesRetries|TestReplayEventUsesTheStoredIdentity|TestReplayRestoresFailedJobAndEnqueuesOnce|TestReplayQueuedJobRequiresConfirmation' ./internal/repository/  # 6/6 PASS, exit 0

# whole package, with the DSN, on the final artifact: ok, exit 0 (per-case counts are above)
# no DSN, on the final artifact: 13 PASS + 9 SKIP, exit 0 (the guard test still runs; DB cases skip)
```

Also observed: `gofmt -l` listed nothing and `go vet ./internal/repository/` exited 0. `-race` was **not run**: the host has no cgo toolchain (`go: -race requires cgo`). `TestCatalogueMatchesRiskReference` was not run: it needs a second, risk-side database and is outside this slice.

**Assertion sensitivity for the `Create` rule.** The baseline already satisfied the concurrency rule, so no RED of that behaviour was observed — its first run passed. The non-vacuousness evidence already recorded was not repeated and no further destructive counterfactual was run: the earlier constraint-drop probe (scratch database only, restored immediately) and the non-transactional probe (`jobs=1 effects=1 audits=0`, so the aborted `Create`'s `0/0/0` is rollback evidence) stand as observed history, not as a rerun. The only new RED/GREEN lifecycle in this correction belongs to the guard, described above.

**What remains unproven, and is broker- and ordering-dependent.** Duplicate and reordered completion events; broker redelivery; a uniqueness conflict on any key other than `(actor_id, idempotency_key)`; a failure that kills the connection mid-transaction (the induced failure is a server-side data exception inside the same transaction); publish/consume ordering; and any consumer-side `inbox`/batch effect. The guard is test-side: it protects these tests, not the service binary, which still trusts its own configuration. None of this asserts event processing, and no defect was assumed or found.

**Repeatability and cleanup.** The final artifact was validated against a password-authenticated container: 8/8 over two repetitions on the exact final file (the same four cases had run 12/12 at `-count=3` before a formatting-only reflow), 6/6 on the existing subset, and the whole package green. The ownership gate refused one attempt before any write. A separate run in the attested fixture reached `Create` but failed in the follow-up assertion with the test-side SQL typing error described above; that failure does not imply that the scratch database had no writes. The corrected assertion passed against the same type of attested fixture. Containers were removed at the end, `docker inspect` on the removed ID exited non-zero, and a label filter showed none left (`label_leftovers=0`); the pre-existing local containers — including the compose stack already running on this daemon — were untouched, and the daemon container count was unchanged (25). The earlier sensitivity probe's two rows were deleted and verified gone, and the three temporary capture files this correction wrote under `/tmp` were deleted. No application database, broker, repository schema or production file was touched, and nothing was staged or committed.

### Target guard — the correction this slice needed

**What it is, and what it is not.** The guard **rejects accidental configuration** — a wrong database name, a superuser or foreign role, an unrelated network host, a malformed DSN, or a DSN that names the test database but lands elsewhere. It is **not a standalone proof of ownership**: it cannot know who created a server or whether a `jobs_test` on a loopback port belongs to this run. For the bounded live run, ownership was established separately by the runner attesting the exact container (full ID, per-run label, tmpfs-only storage, daemon-reported loopback mapping) before any write. Nothing here should be read as a claim that arbitrary targets are safe, and it does not make arbitrary use supported.

**Why it exists.** `jobs_app` is a role on the operational databases too, and the earlier fixture only pinged whatever URL was set and compared `current_user` **after** connecting. A reachable server, or a superuser DSN, therefore satisfied it. The guard now fails closed in two places:

- **Pre-connect**, on the parsed `pgxpool` configuration: the database must be exactly `jobs_test`, the user exactly `jobs_app`, and every host — primary and each fallback — must be loopback (`127.0.0.1`, `::1`, `localhost`) or the exact compose test-profile alias `postgres`. Nothing else is accepted, and there is no environment switch that widens it: another host requires a code change and review. A malformed DSN returns a fixed message, because a driver parse error can quote the raw URL, password included.
- **Post-connect, before any write**: the session must report `current_database()=jobs_test` and `current_user=jobs_app`.

**Test-first evidence (observed).** `TestDisposableTargetFailsClosed` was written first against a stub that returned `nil` — the pre-existing permissive behaviour — and the run failed on exactly the refusal rows: `refuses application database`, `refuses application database on the CI alias`, `refuses unrelated network host`, `refuses superuser role`, `refuses other service role`, `refuses network host in a fallback` and the DSN-level `application database` row, exit 1. Implementing the guard turned the same test green; it now also asserts that every refusal message omits the canary password and that the refused-fallback row is rejected for the host, not because the host list failed to parse (the accepted row proves the list parses).

**Live fail-closed behaviour, observed.** Against the disposable container: `TEST_DATABASE_URL` pointing at that same server's **application** database `jobs` failed with `refusing database "jobs": these tests require the disposable "jobs_test" database` (0.00 s test time, exit 1); a `192.0.2.1` host failed with `refusing host "192.0.2.1": only loopback or the compose alias "postgres" is disposable here` (exit 1, no dial — the guard runs before the connection is created, while the pool connect timeout is 5 s); a malformed DSN carrying a canary password failed with `TEST_DATABASE_URL is not a usable PostgreSQL URL`, exit 1, and the canary appeared **0** times in the output. The compose test profile's shape (`postgres` alias, `jobs_test`, `jobs_app`) stays accepted, so the repository's existing integration suite keeps its behaviour.

### Event-side slice — completion and inbox boundary (2026-11-27)

**What was added.** `backend/services/jobs/internal/repository/event_idempotency_integration_test.go`, test-only: no production file, migration or schema was changed. Five cases, all at `Store.Complete`, plus the helpers they share with the `Create` slice (same package, same target guard, same fixture). The effect asserted is persisted state — the job row, the `audit` row and the `inbox` gate row — so no broker is involved and none is claimed.

- `TestDuplicateCompletionEventIsAbsorbedByTheInboxGate` — the same event id delivered twice applies one completion: one `published` row with the event's batch, **one** `batch.published` audit row, one `inbox` row.
- `TestConcurrentDuplicateCompletionsProduceOneEffect` — eight goroutines release the same delivery at once over one closed channel; every call returns nil and the effect is still single. The `inbox` primary key is the only arbiter, so this is the duplicate-delivery rule measured under concurrency rather than sequentially.
- `TestConcurrentDistinctCompletionsForOneBatchLeaveOneEffect` — eight **distinct** event ids naming the batch already stored. This is the redelivery the inbox cannot stop: each delivery commits its own gate row (eight `inbox` rows), while the guarded update plus the matching-published check keep the audit at **one**. It is the case that distinguishes "deduplicated by event id" from "deduplicated by effect".
- `TestCompletionForAForeignBatchIsPermanentAndLeavesNoPartialState` — a reordered completion naming a different batch for a job already `published` returns a **permanent** error, the stored row keeps its original batch, the audit count is unchanged, and the `inbox` row inserted first is **absent**: the gate row is written before the update, so its absence is the rollback evidence, not an assumption.
- `TestCompletionForAnUnknownJobIsPermanentAndLeavesNoInboxRow` — a completion for a job this service never stored is permanent and leaves neither an `inbox` row nor a `jobs` row.

**Uniqueness conflict beyond the request key.** The `Create` slice covers `(actor_id, idempotency_key)`. This slice covers the other one the consumer actually depends on: the `inbox` primary key, which is what stops a redelivered event from writing a second effect. Both are now exercised, and neither is assumed.

**Fixture.** Unique disposable Docker Desktop container (`--context desktop-linux`, `--tmpfs /var/lib/postgresql/data`, `--rm`, per-run `firewatch.verify.run` label, random loopback port, no bind mounts and no named volume) of `postgis/postgis:17-3.5` (`sha256:01a6a70e41e6c4467c8f55f6063555ed72db2d6662cd0d571040d42eadaeb6f6`). Roles and databases were created by the repository's own `backend/deploy/local/postgres-init.sh`, fed to `sh -s` on the container's stdin so no host file was mounted and no temporary directory was needed. Migrations were applied as the owner with a password, the zone seed reported `zones_seeded count=38` (39 rows including the historical `valparaiso-demo`), and the tests connected as `jobs_app` with a password. Ambient `TEST_DATABASE_URL`, `DATABASE_URL` and `PGPASSWORD` were unset; no application database, broker, VM or Kubernetes was involved.

**Commands and results.**

```bash
# the five event-side cases, as jobs_app against the disposable container
TEST_DATABASE_URL='postgres://jobs_app:<pw>@127.0.0.1:<port>/jobs_test?sslmode=disable' \
  GOWORK=off GOTOOLCHAIN=go1.27.4 go test -mod=readonly -count=1 -v \
  -run 'TestDuplicateCompletionEventIsAbsorbedByTheInboxGate|TestConcurrentDuplicateCompletionsProduceOneEffect|TestConcurrentDistinctCompletionsForOneBatchLeaveOneEffect|TestCompletionForAForeignBatchIsPermanentAndLeavesNoPartialState|TestCompletionForAnUnknownJobIsPermanentAndLeavesNoInboxRow' \
  ./internal/repository/            # 5/5 PASS, ok 0.562s, exit 0

# the same set at -count=2, on the final artifact
  … -count=2 … ./internal/repository/  # ok 0.732s, exit 0

# whole module without the DSN: DB cases skip, nothing fails
GOWORK=off GOTOOLCHAIN=go1.27.4 go test -count=1 ./...   # 6 packages ok, exit 0

# whole module with the DSN
TEST_DATABASE_URL=… GOWORK=off GOTOOLCHAIN=go1.27.4 go test -count=1 ./...  # 6 packages ok, exit 0
```

**Test-first, reported honestly.** The five cases were written before they ran, and their first execution **passed** against an unchanged `Store.Complete`. So no RED of behaviour was observed: the baseline already satisfies these rules, and no destructive counterfactual was used to manufacture one. The sensitivity of the assertions is nonetheless concrete rather than nominal — the distinct-id case expects eight `inbox` rows and one audit row, so an implementation that deduplicated by effect instead of by event, or by event instead of by effect, fails one of the two concurrency cases; the permanent cases assert the gate row is **absent**, so a transaction that committed the gate before failing fails them. The only RED captured in this slice is the label-value defect recorded in BH-07, which the live harness found.

**Not proven, and broker-dependent.** Broker-side redelivery, publish/consume ordering, prefetch behaviour, a failure that kills the connection mid-transaction (the induced failure here is a server-side permanent error inside the same transaction), and any consumer-side `inbox`/batch effect at the wire level. `-race` was **not run**: this host has no cgo toolchain (`go: -race requires cgo; enable cgo by setting CGO_ENABLED=1`), so it remains a CI-only check. No defect was assumed or found.

**Cleanup.** The container ran with `--rm`, so stopping it removed it; `docker container inspect` on the removed name exited non-zero, the per-run label inventory reported `labelled_left=0`, and no volume, network or image was created. The pre-existing local containers — including the compose stack already running on this daemon — were untouched and were never inspected.

## Execution route and next action

**Proposed route:** delegated for isolated fixture preparation and coordinated repository/event tests.

**Next action:** the `Create`-boundary slice is recorded above, including the cross-field independence cases and the ownership attestation. The event-side **persistence** slices are now recorded above and were run on 2026-11-27: duplicate completion events (same id, and eight concurrent copies), distinct-id redelivery of an already stored batch, reordered/foreign-batch completion, an unknown job, and the rollback proof that the `inbox` gate row does not survive a refused transaction. What remains is the **AMQP transport** half — broker-driven redelivery, reordering, publish/consume ordering and a publication rollback when the broker refuses — which depends on broker infrastructure, is outside this slice, and is coordinated with BH-05/BH-07. BH-10 stays open on that transport half.
