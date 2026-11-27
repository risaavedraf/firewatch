# BH-07 — Recover jobs after consumer retry exhaustion

**Status:** implemented — the database rules ran green in CI (run 38970472793); the recoverable path is observed end to end (2026-11-20, functional) and again on 2026-11-27 **under proven isolation**, together with the permanent-failure half and the durable retry count that the earlier runs left unobserved. The stored-batch re-emit branch and `-race` remain unobserved, so the unit is **not** satisfied | **Priority:** P1 | **Dependencies:** BH-01; recovery/terminal-state product decision; coordinate BH-10.

## Evidence and scope

The reviewed jobs `broker.go:96-113` exhausts failures with `Reject(false)` while jobs can remain queued. Actual dead-letter handling depends on broker configuration; no successful replay path is established by that call alone.

Define transient versus permanent failures, bounded delayed retries, dead-letter handling, idempotent replay, and reconciliation or terminal-state transitions. Avoid permanent queued jobs without an accountable recovery path.

## Agreed recovery policy (2026-10-16)

Decided before implementation, so these states are a specification rather than a post-hoc description of whatever the consumer happened to do.

**Terminal state.** A job whose event exhausted its delivery budget becomes `failed`, with `failure_reason` and `attempts` persisted on the row and exposed by `GET /v1/jobs/{id}`. `attempts` moves out of process memory into the row: today a consumer restart silently resets the count, so the budget is not what the code claims it is.

**When `failed` is assigned — only on real evidence, never on a clock.**

1. The `jobs` consumer fails permanently (`Permanent() bool`) over its own row. `jobs` owns that row, so it writes the transition directly.
2. A delivery exists in a dead-letter queue tied to that `job_id`. There are two queues today — `v1.RiskQueue + ".dead"` and `v1.JobsQueue + ".dead"` — and a job can die in either without anything reaching its row.

A job that simply never receives an answer stays `queued`. It stops being invisible by observable means instead: a queued-age metric, an alert, and the replay below. A time-based sweep is rejected because it would mark legitimate backlog as failed — with prefetch 1 and a 15-minute cycle, a slow but healthy queue would produce false terminal states.

**Retry budget (unchanged).** Five attempts, `retryBackoff = {1,2,4,8}` seconds, in line. A permanent error skips every retry. The 15-second in-line budget cannot outlast a real database outage, which is precisely why replay is required rather than optional.

**Replay.** An explicit action taken by an authenticated operator, idempotent by `job_id` against the existing inbox unique constraint. Nothing is replayed automatically.

**Observability.** Dead-letter depth and queued-job age are alerted, and the runbook covers exhausted retries, dead letters and stuck jobs.

## Mechanism (2026-10-16)

The policy above is delivered by the pieces below, fixed here so both halves of the flow are built against one design instead of two guesses.

**The cross-service failure report.** A job can die in either consumer and, today, nothing reaches its row. `risk` cannot write that row — it does not own it — so it reports the terminal failure as an event:

- A new wire type `JobFailedType = "risk.job.failed.v1"` in `backend/contracts/gen/events/v1`, carried in the existing `Event` envelope with two additive optional fields: `failure_reason` and `attempts`. Additive and optional so a legacy message keeps the shape it always had.
- `risk` does **not** publish from its consumer hot path. On give-up it inserts the failure event into its own `outbox` in one statement, and the existing relay publishes it with the same publisher confirms and mandatory routing every other event already uses. If that insert fails the code still rejects the delivery and logs: the dead letter stays the record, and no evidence is invented.
- `jobs` binds its own queue to the new routing key and dispatches on the event type: `batch.published` still completes the job, `risk.job.failed.v1` writes the terminal failure through the writer this unit already introduced. An unrecognised type is rejected rather than silently accepted.
- Topology must therefore carry more than one binding per queue. Both services currently declare exactly one key per queue, so the declaration changes shape in **both** consumers — which the local-adapter decision already requires, and which is why the rule is stated on both sides.

**Operator replay.** `POST /v1/jobs/{id}/replay`, admin-only through the existing authorization, is the only way work comes back: nothing is replayed automatically.

- Only a `failed` job is replayable. The transition is one guarded update (`WHERE id=$1 AND state='failed'`), so two concurrent replays cannot both enqueue; the loser is answered `409` instead of being silently accepted.
- The replay returns the row to `queued` and clears the terminal fields, and writes the audit record and the outgoing `jobs.requested.v1` event in the same transaction, exactly as job creation does.
- Duplicate effects are prevented downstream by the inbox unique constraint that already exists, never by trusting the replay itself.

**Replaying a queued job (2026-10-16, session A closure).** The declared gap was that a job whose delivery could not be traced had no repair path, because the guard above is `failed`-only. The human decision taken was to **extend the replay**, not to accept the gap, and it is delivered by two coupled rules:

- **An explicit confirmation, not an inferred one.** A `queued` job may still be in flight, and the service cannot see the broker, so the re-dispatch has to be asked for: the request body must be exactly `{"confirm":"queued_may_be_in_flight"}`, and without it the answer is `409 replay_confirmation_required` with nothing written. A malformed body is `400 invalid_replay_request` before the store is reached. A `published` job stays `409 job_not_replayable`. The transition is still one guarded update, and `attempts` returns to 0 while `requested_at` is deliberately left alone: a replayed job older than the freshness window produces a batch that is already `stale`, which is the honest answer, because nobody observed the zone again.
- **A re-dispatch that can actually settle the job.** A replay publishes `jobs.requested.v1` under a fresh event id, so `risk`'s inbox gate cannot recognise it and its batch insert conflicts. Committing silently there is what made the replay useless in the "assessment stored but the result was lost" case, so the conflict branch now re-emits `risk.batch.published.v1` for the **stored** batch id. No second batch is ever created, and a broker redelivery with the same event id is still stopped by the inbox gate before that branch.

**Residual limit, stated rather than implied.** The confirmation is an operator attestation, not proof: a duplicate dispatch is bounded to one extra assessment, and duplicate *effects* are prevented by the re-emitted completion. Whether a copy really was in flight cannot be decided by the service.

**Observability.** Dead-letter depth is already alerted. Stuck jobs gain a queued-age signal and an alert, and the runbook covers exhausted retries, dead letters and stuck jobs.

## Acceptance checklist

- [x] Agree retry budgets, backoff, permanent-failure handling, and product-visible terminal/recovery states — agreed and delivered: five attempts with the literal 1/2/4/8 schedule, permanent errors skipping every retry, a persisted `failed` state with its reason and attempt count, and an explicit operator recovery. The literal schedule is pinned against the agreed policy rather than against the implementation.
- [~] Implement durable recovery/reconciliation and replay without duplicate effects — the failures of both consumers now reach the row, and the replay is a single guarded transaction that also writes the audit record and the outgoing request event. Duplicate safety is structural: the replay updates only the state it may match, so only one of two concurrent replays can enqueue, and downstream duplication is stopped by the existing inbox and batch uniqueness. A `queued` job is now recoverable too, behind the explicit confirmation described above. CI ran the database-side rules green (run 38970472793); the replay transition was observed functionally on 2026-11-20; and on 2026-11-27 the same path was observed **under proven isolation** (internal network attested, egress measured closed from inside, probes executed in-network) together with a permanent failure reaching `failed` with its reason and attempt count. The duplicate-effect re-emit branch is still unobserved, so this stays partial rather than satisfied.
- [~] Handle restart and duplicate/reordered delivery safely across persistence and acknowledgment boundaries — a duplicate or reordered delivery can no longer rewrite a terminal row (both the terminal write and the replay transition are guarded), and the attempt count is durable on the row: on 2026-11-27 retry exhaustion was observed end to end as `attempts=5` on the stored row exposed by `GET /v1/jobs/{id}`. Resuming an interrupted retry budget across a restart is deliberately **not** implemented: the policy keeps the in-line budget unchanged.
- [x] Provide alerts and an operator runbook for exhausted retries, dead letters, and stuck jobs — the dead-letter backlog rule now names the propagated terminal state and the replay, a stuck-job rule alerts on the oldest queued job with a concrete action, and the operations runbook covers all three cases. The rules are not loaded by a running Prometheus here, so their semantics are unexecuted.

## Verification — partially run

**Checks status:** partially run, and materially advanced on 2026-11-27. The recoverable half was observed **functionally** on 2026-11-20 (two runs, exit 0) with the earlier version of the harness, and again on 2026-11-27 **under proven isolation** (two runs, exit 0). The permanent-failure half and the durable attempt count, which that first evidence left undemonstrated, are now observed too. What remains undemonstrated is the duplicate-effect re-emit branch, and `-race` still runs only in CI. Whether any of that approves risk item 5 is the reviewer's decision, not this document's, and this document does not record it as approved.

**Observed in this session (2026-10-16):** unit 1 only. The classification of a give-up as `permanent_error` or `retries_exhausted`, the terminal write on the job's own row with the persisted attempt count, a job with no delivery staying `queued`, and the exposed `failed` shape are covered by passing tests, with the RED captured first. `gofmt` and `go vet` are clean and the OpenAPI document validates. **Not verified:** the migration executing against PostgreSQL, the store SQL, the live AMQP path, and everything the scenario above needs — a database and a broker are required and the Docker daemon is not available.

**Observed at the session A closure (2026-10-16), units 2-4:** the `queued` re-dispatch, its confirmation vocabulary and the completion re-emit. The RED of the transport rules was observed first (`503 storage_unavailable` where the answer had to be `409 replay_confirmation_required`, and `202` where a malformed body had to be `400 invalid_replay_request`), then green: the `jobs` suite (5 packages), the `risk` suite (10 packages), `gofmt`, `go vet` and the contract validator are clean, and the replay tests pass. The pure policy seams (`replayGate`, `redispatchCompletion`) are pinned by runnable tests. **Not verified here:** the same database-side rules as above, plus `-race` (no C compiler on this host); they are integration tests that skip locally. CI **did** execute them on the pushed branch and they passed (the `compose` job is green, run 38970472793): the test image receives `TEST_DATABASE_URL` and its entrypoint does not use `-short`, so those tests cannot skip, and the packages that hold them report `ok`. The end-to-end interrupt/restore scenario above was not executed in that session; it was executed on 2026-11-27 under proven isolation — see *Isolated end-to-end witness* at the end of this document — and `-race` still runs only in CI. No independent verifier ran: the runtime refused the verifier launch for a candidate that declares no Task Size high-risk item, so this is a writer-side self-verification with its limits stated.

## Execution route and next action

**Proposed route:** delegated for recovery-policy preparation and coordinated consumer, persistence, broker, and test changes.

**Next action:** implement the agreed policy with tests that fail first — a permanent consumer failure writes `failed` with its reason, a dead letter tied to a `job_id` does too, a job with no answer stays `queued`, and a replay of the same `job_id` produces no duplicate effect. **Historical at 2026-10-16:** at that date the end-to-end check (interrupt PostgreSQL, exhaust retries, restore, restart consumers) was deferred because it needed a broker and a database and the Docker daemon was not available. That check ran on 2026-11-27 under proven isolation — see *Isolated end-to-end witness* — and with it the permanent-failure half and the durable attempt count. The only part of this unit still open is `redispatchCompletion`, the stored-batch re-emit branch.

**Status of that next action (2026-10-16, closure — historical at that date):** the four rules above are implemented. At that date the end-to-end check was still deferred on the same dependency and was the only thing keeping this unit from "satisfied". It is no longer the only thing open: the isolated witness ran on 2026-11-27, and `redispatchCompletion` is what remains unobserved. The `queued` gap that was the last product decision is delivered, not accepted.

## Log

- **2026-10-16** — Agreed the recovery policy before implementing, then delivered units 1-3 through the session A2 run: the terminal state on the job row, the cross-service failure report through `risk`'s outbox, and the admin-only operator replay with its guarded transition. At that date the end-to-end check stayed deferred on PostgreSQL and a broker — historical; it was executed on 2026-11-27 under proven isolation, and `redispatchCompletion` is what remains unobserved.
- **2026-10-16 (session A closure)** — The last open product decision was taken: extend the replay to a `queued` job behind an explicit confirmation, and make a re-dispatched request whose batch already exists re-emit that batch's completion instead of being swallowed (`90f48a6`). The runbook replaced "no repair available today" with the attested re-dispatch and its bound, and the OpenAPI contract documents the body, the two `409` codes and the stale-batch consequence. Status moves from `pending` to implemented for the whole unit; the single remaining gap is the end-to-end run that needs a database and a broker.

## End-to-end witness (2026-11-20)

**What was observed, and with what isolation.** `backend/scripts/verify_job_recovery.py` (new here) subclasses the disposable stack `backend/scripts/verify_synthetic.py` already owns instead of a second copy of it. Two runs on Docker 29.5.3 at `desktop-linux` reported the same sequence, `exit 0` both times:

```
PASS: built isolated gateway, jobs and risk images from the repository context
PASS: forward migrations applied as the ephemeral PostgreSQL administrator
PASS: a job triggered normally is published once, with attempts 0 and no failure state
in flight: risk.jobs.v1 holds the accepted request and its consumer is frozen
interrupted: PostgreSQL is stopped while the request is in flight
PASS: the interrupted delivery settled into exactly one dead letter and its queue drained
restored: PostgreSQL answers over TCP again
PASS: after restore and consumer restart the interrupted job is still queued, attempts 0, no failure fields
PASS: the unconfirmed and the malformed replay are refused and leave the row untouched
PASS: the recovered job is published exactly once, a second replay is refused, and the audit holds one completion
PASS: BH-07 recovery witness completed
NOTE: the recoverable-job half only; a permanent failure reaching 'failed' is not demonstrated.
```

Those two runs are **functional** evidence only. An independent review of the first version of this harness found its isolation was asserted rather than proven: the runtime bridge was created without `--internal`, fault actions addressed containers by generated **name** instead of a recorded id, the mocked ownership checks compared a name prefix rather than a label the daemon reports, and teardown was called proven from an empty label inventory alone — which says nothing about anonymous volumes or about anything outside the run's own creation. Risk item 5 (verification infrastructure and dependency outage orchestration) is therefore **not approved**, and neither run may be cited as isolation evidence.

**What the harness now enforces.** Every clause fails closed, and each has a mocked regression test that was seen failing first:

* the runtime network is created `--internal` and then **attested** by reading `.Internal` from the daemon before any fault; image builds and pulls are reported separately as host egress, outside that network;
* every fault action (`pause`, `unpause`, `stop`, `start`, `restart`) addresses a container **id this run recorded from its own create**, and that id's `firewatch.verify.run` label is re-read immediately before acting — an id the daemon no longer reports, or whose label is not this run's, aborts without injecting anything;
* every recorded container must carry this run's label, use bind mounts **only** (a managed volume could outlive the run) and sit only on this run's network;
* cleanup is followed by a proof that each recorded id is gone, the network is gone, and no container, network, volume or image still carries this run's label. The limit is stated where it is proved: a labelled inventory cannot see an *unlabelled* resource — which is why managed mounts are refused before a fault runs — and no harness can show that something outside its own creation did not change elsewhere on the host.

**Where isolation stops on this surface.** One bounded trial was run with the network closed:

```
PASS: built isolated gateway, jobs and risk images from the repository context
PASS: the runtime network is internal; image builds and pulls use the host's Docker egress, outside it
PASS: forward migrations applied as the ephemeral PostgreSQL administrator
FAIL: timed out after 240s waiting for Keycloak realm discovery at http://127.0.0.1:50960/realms/firewatch/.well-known/openid-configuration
PASS: every recorded container id, the network, and every resource carrying this run's label is gone
```

The daemon attested `--internal`, the migrations ran and the teardown proof passed, but the host never reached the published loopback port. Docker Desktop does not route a published port into an internal network, and this witness is driven from the host (tokens, job creation, replay), so an internal runtime network and this harness are mutually exclusive without either changing the shared helper's single-bridge, host-driven model or adding a container-side HTTP client. The harness now refuses that configuration in seconds by probing the published port (`attest_host_ports`) instead of failing a readiness wait later, and no further live runs were made. **The isolated witness has not been executed**, so BH-07 takes no end-to-end evidence from it.

**What the functional runs do pin** (tested code, not an isolation claim):

* a job accepted while its consumer cannot settle it;
* the broker reporting at least one message on the work queue while the consumer is frozen — the queue's **total**, which does not identify the delivery;
* the work queue draining and the dead-letter queue reporting exactly one message in total — again totals, not delivery identity;
* the interrupted row coming back `queued` with `attempts` 0 and no `failure_reason`/`failed_at`, because the write that would have recorded a terminal state was served by the dependency that failed;
* `409 replay_confirmation_required` and `400 invalid_replay_request`, both asserted on status **and** `code`, leaving the row untouched;
* the confirmed replay returning the job to `queued` with `requested_at` unchanged, then one `published` job with exactly one batch;
* `409 job_not_replayable` on a second replay with the batch count unchanged;
* the job's audit actions compared as **sorted counts** — one `batch.published` and two `job.requested` — not as an order.

**Two properties of the implementation the runs made explicit, neither of them a defect.**

1. `risk` verifies its classifier against the models registry at startup — `service_stopped`, `verify classifier "academic-rule-v1" against the models registry: failed to connect …` — so it cannot be restarted while the database is down. An outage can only hit a consumer that is already running, which is why the harness **freezes** it (`docker pause`) instead of stopping it before the interruption.
2. Under a full database outage the in-line budget is **not** what settles the delivery: the relay's own failure tears the session down first (`services/risk/internal/messaging/broker.go`, `runSession`/`relay`), the delivery is requeued, and the broker's `x-delivery-limit: 5` on the quorum queue dead-letters it. The runs therefore observed the bounded path, but on the broker's side; the literal five-attempt `1/2/4/8` schedule stays pinned by the unit tests only.

**Not proven, so the unit stays partial.** A permanent failure reaching `failed` with `failure_reason` and `attempts`; the **retries** half of the scenario as a durable attempt count; and the duplicate-effect branch where an assessment is already stored and only its result was lost — the re-emit inside `risk`'s `Publish`. `-race` still runs only in CI. **Nothing here closes BH-07.**

**Harness's own tests.** `python -m unittest discover -s backend/scripts -p test_verify_job_recovery.py -v` → 32 tests, OK, after a RED captured first (`ModuleNotFoundError`, then the new safety attributes missing). One is the positive policy trace and seven are differential recoveries — a persisted attempt count, a second message on the dead-letter queue, a delivery left on the work queue, a duplicated batch, an unexpected audit action, a replay that never completes, a replay answering the wrong state — each required to fail at the check that must catch it. The rest pin isolation, ownership, fault targeting, teardown and the argument surface. The stack helper's own suite is untouched by this change and still carries its two pre-existing failures in `ResourceOwnershipTests`, confirmed present at `813322b`: the fake injects the failure at the broker's attached start rather than at the migration.

## Isolated end-to-end witness (2026-11-27)

**The constraint the earlier run hit, and how it was removed.** L4 records it: this daemon does not route a published loopback port into an `--internal` network, so a host-driven witness and a closed network were mutually exclusive. The witness now runs entirely **inside** the run's own network:

* one helper container (`curlimages/curl:8.12.1`, `--entrypoint sleep`) is created on the run's network only, recorded by the container id the create returned, labelled `firewatch.verify.run=<run>`, and every HTTP and AMQP-management probe is a `docker exec` into that id - so teardown and ownership cover it like any other container of the run;
* a URL naming `127.0.0.1`, `localhost` or `::1` is refused before a probe is spawned, so the host route cannot come back silently;
* a second attestation probes `https://1.1.1.1/` and `http://example.com/` from inside and **fails the run if either is reachable**, so "egress closed" is measured from inside this network instead of inferred from the `--internal` flag;
* the network is created `--internal` and attested `.Internal=true` by the daemon. Because this host's daemon has exhausted its predefined address pools, the create falls back to the first accepted subnet from a fixed candidate list, and no ownership is claimed until one succeeds.

**Two teardown defects the new attestation caught, both now closed.**

1. `--label firewatch.verify` without `=1` sets an **empty** value, which is a different label, so the ownership check refused the container the run had just created. Every label now carries its value and a test pins the shape; the in-memory fake could not have caught this, and the live run did.
2. `postgis/postgis` declares `VOLUME /var/lib/postgresql/data`, so the inherited stack always creates an **anonymous volume**, and `docker rm` without `--volumes` leaves it behind - invisibly, because an anonymous volume inherits no label and so cannot appear in a label inventory. The harness records those names before the containers go, removes them by name, and proves them gone. A **named** volume is refused before any fault.

**Result: `exit 0` on two consecutive runs of the final artifact**, Docker 29.5.3 at `desktop-linux`.

```text
$ DOCKER_CONTEXT=desktop-linux python -B backend/scripts/verify_job_recovery.py --timeout 1800
PASS: built isolated gateway, jobs and risk images from the repository context
NOTE: the daemon's predefined address pools are exhausted; ...-net was created with the explicit subnet 10.213.64.0/24
PASS: the runtime network is internal; image builds and pulls use the host's Docker egress, outside it
PASS: the HTTP and AMQP witness runs inside ...-witness, on ...-net only
PASS: the witness 038b7df87cb8 carries this run's label, safe mounts, on ...-net only
PASS: external egress is closed from inside the runtime network; the witness needs no host route
PASS: forward migrations applied as the ephemeral PostgreSQL administrator
PASS: 7 recorded containers carry this run's label, safe mounts, on ...-net, and 2 anonymous volume(s) it must remove
PASS: a job triggered normally is published once, with attempts 0 and no failure state
in flight: risk.jobs.v1 reports 1 message(s) in total while its consumer is frozen
interrupted: PostgreSQL is stopped while the request is in flight
PASS: the work queue drained and the dead-letter queue holds exactly one message (queues' totals)
restored: PostgreSQL answers over TCP again
PASS: after restore and consumer restart the interrupted job is still queued, attempts 0, no failure fields
PASS: the unconfirmed and the malformed replay are refused and leave the row untouched
PASS: published once, a second replay refused, and the audit holds one completion and two requests
injected: the risk catalogue no longer holds 05804, so a job for it can only fail its reference
PASS: a permanent failure reaches failed with failure_reason=permanent_error, attempts=1 (a permanent error skips every retry) and exactly one dead letter
PASS: retry exhaustion reaches failed with failure_reason=retries_exhausted and the durable attempts=5 the agreed budget fixes, plus exactly one dead letter
PASS: BH-07 recovery witness completed
PASS: every recorded container id, the transient migration and topology containers, the network id, every anonymous volume and every resource carrying this run's label is gone
```

**Correction batch after independent review (2026-11-27), all of it observed live.** The review asked that "unreachable" and "absent" stop being inferred from an exit code, and it was right on both counts. The corrections, each with a mocked regression test that was seen failing first:

* **Egress is a reachability observation.** Only `curl` exit `6` (cannot resolve), `7` (cannot connect) or `28` (timed out) count as a closed network. `125`/`126`/`127` or any other nonzero code now fail the run loudly - a probe that never executed proves nothing about egress - and the helper's `.State.Running` is re-attested immediately before the probes, so the answer cannot come from a stopped container.
* **Absence is a statement, not an exit code.** A `docker inspect` that fails proves nothing unless the daemon says the id does not exist, and the exit-0 labelled inventory is required alongside it. The live run then produced a wording this harness did not yet accept - `[]` followed by `network <id> not found` - so the accepted vocabulary now covers that form, scoped to a resource kind so an unrelated "plugin not found" is not mistaken for absence.
* **The network is removed by the id it was created with**, after re-reading its `firewatch.verify.run` label from the daemon. The generated name never authorises a removal, and the id's absence is proved separately.
* **The helper's one-shot containers are proved gone too.** Migrations and broker topology are created by the shared helper, so they never reached the recorded-container map; their ids now have their own registry, and the ownership attestation **fails closed** when that registry is empty, so the proof cannot become vacuously true. The live run passing that assertion is what proves the registry is actually populated.
* **Volume ownership is decided by metadata, not by name shape.** A volume is accepted only when its mount destination is one an image declares as `VOLUME` (the 64-hex name is one signal, not the rule), the daemon reports it, and its labels do not name another run. Collection re-reads each container's label first, so a container this run did not create can never contribute a volume, and a volume that fails its checks is reported as a teardown problem instead of being skipped.
* **One real defect the live run exposed was redaction corrupting structured output.** The shared helper registers every value of its secret map, and one of those values is the literal, public database username. That masked `postgres` inside a mount destination (`@/var/lib/<redacted>ql/data`), so the harness refused its own volume and then failed its own absence proof. The public username is no longer redacted; every generated credential still is, and both behaviours now have tests.

**The two halves that were unobserved, now measured.**

* **Permanent failure.** One comuna reference (`05804`, Villa Alemana) is deleted from the **risk** copy of the catalogue inside this run's own container. The two services keep separate copies, so `jobs` still accepts the job while `risk`'s batch insert fails a real foreign key; nothing is simulated. `risk` classifies the `23503` as permanent, reports it through its outbox, and `jobs` writes `failed` with `failure_reason='permanent_error'` and **`attempts=1`** - the "a permanent error skips every retry" rule observed end to end instead of only in a unit test.
* **Retry exhaustion.** A job asking for the `partial-retrieval` profile can never complete. The consumer spends its whole budget, and `jobs` records `failed` with `failure_reason='retries_exhausted'` and the durable **`attempts=5`**: the five-attempt policy and the row-durable count observed together.
* Each give-up also added exactly one message to `risk.jobs.v1.dead`. That is asserted as a **delta** inside the run's own budget, because the broker's management API republishes its counters on a stats interval and a single read straight after the give-up can still see the previous depth.

**Harness tests.** `python -B -m pytest backend/scripts/test_verify_job_recovery.py` → **102 passed**, 6 subtests. The suite grew from 32 to 102, and every new safety clause is shown to fail when its observation is wrong: open egress, a `docker exec` failure masquerading as closed egress, a stopped helper, a host-loopback probe, a label whose value is empty, a named volume, a volume outside a declared destination, a volume another run claims, a surviving anonymous volume, a dead daemon or a failed inventory offered as absence proof, a network removed by name instead of id, a network whose label is not this run's, a surviving transient container, an empty transient registry, a permanent failure classified as exhaustion, an exhaustion that spent four attempts, a missing dead letter, and a helper attached to a foreign network. The RED for each was captured first; the label-value and the `network <id> not found` cases are the two the live run found before the fake could, and both now have regression tests.

**Still not proven, and why.** The **stored-batch re-emit** branch - an assessment already stored whose completion was lost - is not demonstrated end to end here. Reaching it requires holding the `jobs` consumer back while `risk` stores the batch, and this harness can only freeze whole containers, which would also stop the endpoint the witness drives. It stays covered by the repository test for `redispatchCompletion` and remains unproven here. `-race` still runs only in CI: this host has no cgo toolchain (`go: -race requires cgo; enable cgo by setting CGO_ENABLED=1`).

**Risk item 5.** The isolation objection recorded in L4 is answered by construction **and** by measurement: the network is attested internal, egress is measured closed from inside, every probe executes in-network, every fault addresses an id this run recorded, and teardown is proven by id, label and volume name. Whether that approves the item is a reviewer's decision, not this document's, and this document does not record it as approved.
