# BH-07 — Recover jobs after consumer retry exhaustion

**Status:** implemented — the database rules ran green in CI (run 38970472793), and the recoverable recovery path is observed **functionally** end to end (2026-11-20) but not under proven isolation, so risk item 5 is not approved; the permanent-failure half is unobserved and the unit is **not** satisfied | **Priority:** P1 | **Dependencies:** BH-01; recovery/terminal-state product decision; coordinate BH-10.

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
- [~] Implement durable recovery/reconciliation and replay without duplicate effects — the failures of both consumers now reach the row, and the replay is a single guarded transaction that also writes the audit record and the outgoing request event. Duplicate safety is structural: the replay updates only the state it may match, so only one of two concurrent replays can enqueue, and downstream duplication is stopped by the existing inbox and batch uniqueness. A `queued` job is now recoverable too, behind the explicit confirmation described above, and a re-dispatch whose batch already exists re-emits the stored batch's completion instead of being swallowed. CI ran the database-side rules green (run 38970472793), and on 2026-11-20 the replay transition was observed functionally — an interrupted job still `queued` returned to `queued`, completed exactly once, and a second replay was refused — but not under proven isolation, and a permanent failure reaching `failed` was **not** observed, so this stays partial rather than satisfied.
- [~] Handle restart and duplicate/reordered delivery safely across persistence and acknowledgment boundaries — a duplicate or reordered delivery can no longer rewrite a terminal row (both the terminal write and the replay transition are guarded), and the attempt count is durable on the row. Resuming an interrupted retry budget across a restart is deliberately **not** implemented: the policy keeps the in-line budget unchanged.
- [x] Provide alerts and an operator runbook for exhausted retries, dead letters, and stuck jobs — the dead-letter backlog rule now names the propagated terminal state and the replay, a stuck-job rule alerts on the oldest queued job with a concrete action, and the operations runbook covers all three cases. The rules are not loaded by a running Prometheus here, so their semantics are unexecuted.

## Verification — partially run

**Checks status:** partially run. The recoverable half of the scenario below was observed **functionally** on 2026-11-20 (two runs, exit 0) with the earlier version of the harness — see *End-to-end witness* at the end of this document — but not under proven isolation: the isolated witness was not executed, so the evidence is partial and risk item 5 is not approved. The permanent-failure half, the durable attempt count and the duplicate-effect re-emit remain undemonstrated.

**Observed in this session (2026-10-16):** unit 1 only. The classification of a give-up as `permanent_error` or `retries_exhausted`, the terminal write on the job's own row with the persisted attempt count, a job with no delivery staying `queued`, and the exposed `failed` shape are covered by passing tests, with the RED captured first. `gofmt` and `go vet` are clean and the OpenAPI document validates. **Not verified:** the migration executing against PostgreSQL, the store SQL, the live AMQP path, and everything the scenario above needs — a database and a broker are required and the Docker daemon is not available.

**Observed at the session A closure (2026-10-16), units 2-4:** the `queued` re-dispatch, its confirmation vocabulary and the completion re-emit. The RED of the transport rules was observed first (`503 storage_unavailable` where the answer had to be `409 replay_confirmation_required`, and `202` where a malformed body had to be `400 invalid_replay_request`), then green: the `jobs` suite (5 packages), the `risk` suite (10 packages), `gofmt`, `go vet` and the contract validator are clean, and the replay tests pass. The pure policy seams (`replayGate`, `redispatchCompletion`) are pinned by runnable tests. **Not verified here:** the same database-side rules as above, plus `-race` (no C compiler on this host); they are integration tests that skip locally. CI **did** execute them on the pushed branch and they passed (the `compose` job is green, run 38970472793): the test image receives `TEST_DATABASE_URL` and its entrypoint does not use `-short`, so those tests cannot skip, and the packages that hold them report `ok`. The end-to-end interrupt/restore scenario above is still not executed, and `-race` still runs only in CI. No independent verifier ran: the runtime refused the verifier launch for a candidate that declares no Task Size high-risk item, so this is a writer-side self-verification with its limits stated.

## Execution route and next action

**Proposed route:** delegated for recovery-policy preparation and coordinated consumer, persistence, broker, and test changes.

**Next action:** implement the agreed policy with tests that fail first — a permanent consumer failure writes `failed` with its reason, a dead letter tied to a `job_id` does too, a job with no answer stays `queued`, and a replay of the same `job_id` produces no duplicate effect. The end-to-end check (interrupt PostgreSQL, exhaust retries, restore, restart consumers) stays deferred: it needs a broker and a database, and the Docker daemon is not available.

**Status of that next action (2026-10-16, closure):** the four rules above are implemented; the end-to-end check is still deferred on the same dependency, and it is the only thing keeping this unit from "satisfied". Nothing else on this unit is open: the `queued` gap that was the last product decision is delivered, not accepted.

## Log

- **2026-10-16** — Agreed the recovery policy before implementing, then delivered units 1-3 through the session A2 run: the terminal state on the job row, the cross-service failure report through `risk`'s outbox, and the admin-only operator replay with its guarded transition. The end-to-end check stays deferred on PostgreSQL and a broker.
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
