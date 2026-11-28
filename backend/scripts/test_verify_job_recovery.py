"""Scenario and safety contracts for ``verify_job_recovery.py``, without Docker.

The harness under test subclasses ``verify_synthetic.Harness``, so the stack
lifecycle - image builds, the isolated network, ownership, teardown - is not
re-tested here; ``test_verify_synthetic.py`` already pins it. What is tested is
the part this harness adds, and the safety rules it must enforce before it is
allowed to inject a fault:

* the runtime network is created with egress closed (``--internal``), the daemon
  attests that, and the witness reaches the services **from inside** that
  network through a helper container attached only to it - never through a
  host-published loopback port, which this daemon does not route into an
  internal network;
* a second attestation proves the same helper cannot reach the internet, so
  "isolated" is a measurement instead of a claim;
* every fault action (``pause``, ``unpause``, ``stop``, ``start``, ``restart``)
  addresses a container **id this run recorded**, never a name, and the id's
  ownership label is re-confirmed immediately before acting - an uncertain id
  fails closed and no fault is injected;
* every container this run recorded - the helper included - carries its own
  label, keeps bind mounts only (so no anonymous or named volume can outlive the
  run) and sits only on the run's own network;
* teardown is proven by id and by label rather than by a name prefix, and a
  surviving resource is reported as a failure;
* the three BH-07 scenarios that the functional runs left unproven are now
  asserted and shown to be **discriminating**: a permanent failure reaching
  ``failed`` on its first attempt, retry exhaustion recorded as a durable
  attempt count of five, and the dead-letter depth those give-ups add.

The tests drive the witness in-process against a fake stack that models the job
rows, the zone history, the audit log, the broker queue counters, the daemon's
inspection answers and the helper container's HTTP answers - the last one keyed
by URL, so a probe that addressed the host instead of the network would not be
answered at all. Each check is also shown to *fail* when its observation is
wrong, so a green run means the witness can tell a recovery from a duplicate
effect, an isolated probe from a host probe, and an owned resource from a
foreign one, instead of passing on any trace at all.

Run with::

    python -m pytest backend/scripts/test_verify_job_recovery.py
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import json
import socket
import sys
import unittest
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import verify_job_recovery as recovery  # noqa: E402  (the harness under test)
import verify_synthetic as stack  # noqa: E402  (the shared stack helper)

JOB = "6f1d0f8e-3a2b-4c5d-8e9f-0a1b2c3d4e5f"
CONTROL = "1c1d0f8e-3a2b-4c5d-8e9f-0a1b2c3d4e5f"
PERMANENT_JOB = "2f1d0f8e-3a2b-4c5d-8e9f-0a1b2c3d4e5f"
RETRIES_JOB = "3f1d0f8e-3a2b-4c5d-8e9f-0a1b2c3d4e5f"
BATCH = "aa1d0f8e-3a2b-4c5d-8e9f-0a1b2c3d4e5f"
REQUESTED_AT = "2026-11-20T12:00:00Z"
FAILED_AT = "2026-11-20T12:05:00Z"
ZONE = "valparaiso-demo"
SPARE_ZONE = recovery.PERMANENT_FAILURE_ZONE
RETRY_SCENARIO = recovery.RETRY_EXHAUSTION_SCENARIO
ROLES = ("postgres", "rabbitmq", "identity", "jobs", "risk", "gateway")
WITNESS_ROLE = recovery.WITNESS_ROLE
ALL_ROLES = (*ROLES, WITNESS_ROLE)
FAULT_VERBS = {"pause", "unpause", "stop", "start", "restart"}


def quiet(call, *args, **options):
    """Run ``call`` with the harness's progress output silenced."""
    with contextlib.redirect_stdout(io.StringIO()):
        return call(*args, **options)


def closed_loopback_port() -> int:
    """Return a loopback port nothing listens on: bound, read, then released."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])
    finally:
        probe.close()


def container_id(role: str) -> str:
    """Return a deterministic 64-hex id, the shape the daemon returns."""
    return hashlib.sha256(f"firewatch-test-{role}".encode()).hexdigest()


class FakeStack(recovery.Harness):
    """A ``Harness`` whose Docker, helper-container and broker seams are a model.

    The model follows the policy rather than the tests: the first job created is
    the healthy control, the second is the one the outage interrupts, a job for
    the spare zone fails permanently on its first attempt, and a job asking for
    the partial-retrieval profile spends the whole retry budget. A job is
    ``queued`` until its consumer records a completion, completions are
    asynchronous, and every container carries this run's labels, bind mounts and
    network. Each keyword widens the model to one wrong trace.
    """

    def __init__(self, *, attempts_kept=0, dead_letters=1, queue_left=0, publish_on_replay=True,
                 batches_on_completion=1, extra_audit=(), replayed_state="queued",
                 internal=True, keep=False, survives=False, mounted="bind=;", attached=None,
                 labels=None, witness_attached=None, witness_labels=None,
                 witness_mounted="bind=;", egress_open=False, pool_exhausted=False,
                 accept_subnet=None, permanent_state="failed", permanent_reason="permanent_error",
                 permanent_attempts=1, retries_state="failed", retries_reason="retries_exhausted",
                 retries_attempts=5, permanent_dead_letters=1, retries_dead_letters=1,
                 egress_code=7, witness_running=True, network_labels=None, daemon_down=False,
                 absent_marker="No such object", volume_labels=None, surviving_ids=(),
                 surviving_networks=(), inventory_fails=False, unreadable_volumes=(),
                 malformed_volume_labels=(), unreadable_label_containers=()):
        args = argparse.Namespace(timeout=120, ready_timeout=2, poll_interval=1, zone=ZONE, keep=keep)
        super().__init__(args)
        self.gateway_port, self.identity_port, self.management_port = 1, 2, 3
        self.egress_code = egress_code
        self.witness_running = witness_running
        self.daemon_down = daemon_down
        self.absent_marker = absent_marker
        self.surviving_ids = set(surviving_ids)
        self.surviving_networks = set(surviving_networks)
        self.inventory_fails = inventory_fails
        self.unreadable_volumes = set(unreadable_volumes)
        self.malformed_volume_labels = set(malformed_volume_labels)
        self.unreadable_label_containers = set(unreadable_label_containers)
        self.volume_labels = dict(volume_labels or {})
        self.network_id: str | None = container_id("network")
        self.removed_network: str | None = None
        self.network_labels = (
            network_labels if network_labels is not None
            else {recovery.VERIFY_LABEL: "1", recovery.RUN_LABEL: self.run_id}
        )
        self.transient_containers: list[str] = [container_id("migrate")]
        self.attempts_kept = attempts_kept
        self.dead_letters = dead_letters
        self.queue_left = queue_left
        self.publish_on_replay = publish_on_replay
        self.batches_on_completion = batches_on_completion
        self.extra_audit = list(extra_audit)
        self.replayed_state = replayed_state
        self.internal = internal
        self.survives = survives
        self.egress_open = egress_open
        self.pool_exhausted = pool_exhausted
        self.accept_subnet = accept_subnet
        self.permanent_state = permanent_state
        self.permanent_reason = permanent_reason
        self.permanent_attempts = permanent_attempts
        self.retries_state = retries_state
        self.retries_reason = retries_reason
        self.retries_attempts = retries_attempts
        self.permanent_dead_letters = permanent_dead_letters
        self.retries_dead_letters = retries_dead_letters
        self.calls: list[list[str]] = []
        self.rows: dict[str, dict] = {}
        self.history: list[dict] = []
        self.audit: list[dict] = []
        self.queues = {recovery.RISK_QUEUE: {"messages": 0}, recovery.RISK_DEAD_QUEUE: {"messages": 0}}
        self.postgres_up = True
        self.risk_running = True
        self.settled = False
        self.torn_down = False
        self.removed_volumes: list[str] = []
        # The recorded ids a successful create would have produced, one per role.
        self.roles = {container_id(role): role for role in ALL_ROLES}
        self.created = {f"{self.prefix}-{role}": container_id(role) for role in ALL_ROLES}
        self.witness_id = container_id(WITNESS_ROLE)
        own = labels if labels is not None else {recovery.VERIFY_LABEL: "1", recovery.RUN_LABEL: self.run_id}
        self.labels = dict.fromkeys(self.roles, own)
        if witness_labels is not None:
            self.labels[self.witness_id] = dict(witness_labels)
        self.mounts = dict.fromkeys(self.roles, mounted)
        self.mounts[self.witness_id] = witness_mounted
        network = attached or f"{self.network};"
        self.attached = dict.fromkeys(self.roles, network)
        self.attached[self.witness_id] = witness_attached or f"{self.network};"
        # As if ``create_network`` had already run: the witness attests it first.
        self.owned_network = self.network
    # -- seams -------------------------------------------------------------
    def _daemon_error(self):
        return 1, "Cannot connect to the Docker daemon at npipe:////./pipe/docker_engine"

    def _docker(self, argv, *, env=None, timeout=None):
        self.calls.append(list(argv))
        if argv[0] == "network":
            return self._network(argv)
        if argv[0] == "inspect":
            return self._inspect_fake(argv)
        if argv[0] == "container":
            if self.daemon_down:
                return self._daemon_error()
            target = argv[-1]
            if target in self.surviving_ids:
                return 0, "{}"
            return (0, "{}") if (self.survives and not self.torn_down) else (1, f"{self.absent_marker}: {target}")
        if argv[0] == "exec":
            return self._exec_fake(argv)
        if argv[0] in {"run", "create"}:
            name = argv[argv.index("--name") + 1]
            role = name[len(self.prefix) + 1:]
            return 0, container_id(role) + "\n"
        for target in argv[1:]:
            role = self.roles.get(target)
            if role == "risk":
                self.risk_running = argv[0] in {"start", "restart", "unpause"}
            elif role == "postgres":
                self.postgres_up = argv[0] in {"start", "restart", "unpause"}
        if argv[:2] == ["volume", "inspect"]:
            if self.daemon_down:
                return self._daemon_error()
            if len(argv) > 3 and argv[2] == "-f":
                if argv[4] in self.unreadable_volumes:
                    return 1, f"Error: No such volume: {argv[4]}"
                if argv[4] in self.malformed_volume_labels:
                    return 0, "{ not json"
                return 0, json.dumps(self.volume_labels.get(argv[4], {}))
            return (0, "{}") if (argv[-1] in self.volume_labels or not self.torn_down) else (1, f"Error: No such volume: {argv[-1]}")
        if argv[:2] == ["volume", "rm"]:
            self.removed_volumes.append(argv[2])
            return 0, ""
        if argv[0] in {"rm", "rmi"}:
            return 0, ""
        if "-q" in argv and any(argument.startswith("label=") for argument in argv):
            if self.inventory_fails or self.daemon_down:
                return self._daemon_error()
            return (0, "") if self.torn_down else (0, "leftover-id")
        return 0, ""

    def _network(self, argv):
        if argv[1] == "create":
            # The id the daemon returns; the fake keeps it non-None for any create.
            created_id = self.network_id or container_id("network")
            subnets = [argv[index + 1] for index, argument in enumerate(argv) if argument == "--subnet"]
            if subnets:
                if self.accept_subnet is not None and subnets[0] != self.accept_subnet:
                    return 1, "Error response from daemon: Pool overlaps with other one on this address space"
                return 0, created_id + "\n"
            if self.pool_exhausted:
                return 1, "Error response from daemon: all predefined address pools have been fully subnetted"
            return 0, created_id + "\n"
        if argv[1] == "inspect" and "-f" in argv:
            if self.daemon_down:
                return self._daemon_error()
            template, target = argv[3], argv[4]
            if target not in {self.network_id, self.network}:
                return 1, f"Error: No such network: {target}"
            if "Labels" in template:
                return 0, json.dumps(self.network_labels)
            return 0, "true" if self.internal else "false"
        if argv[1] == "inspect":
            if self.daemon_down:
                return self._daemon_error()
            target = argv[-1]
            return (0, "{}") if (target in self.surviving_networks or not self.torn_down) else (1, f"Error: No such network: {target}")
        if argv[1] == "rm":
            self.removed_network = argv[2]
            self.torn_down = True
            return 0, ""
        return 0, ""

    def _inspect_fake(self, argv):
        template, target = argv[2], argv[3]
        if self.daemon_down:
            return self._daemon_error()
        if target not in self.roles:
            return 1, f"{self.absent_marker}: {target}"
        if "Labels" in template:
            if target in self.unreadable_label_containers:
                return 0, "{ not json"
            return 0, json.dumps(self.labels[target])
        if "Mounts" in template:
            return 0, self.mounts[target]
        if "State.Running" in template:
            return 0, "true" if self.witness_running else "false"
        return 0, self.attached[target]

    # -- the helper container's answers ------------------------------------
    def _exec_fake(self, argv):
        target, rest = argv[1], argv[2:]
        if target not in self.roles:
            return 1, f"unexpected exec target {target}: this run recorded no such container"
        if not rest:
            return 1, "empty exec"
        if rest[0] in {"psql", "sh"}:
            return 0, "DELETE 1\n"
        if rest[0] != "curl":
            return 1, f"unexpected exec command {rest[0]}"
        if target != self.witness_id:
            # An HTTP probe that did not run in the helper container is exactly
            # the trace this harness must never produce.
            return 1, f"an HTTP probe ran outside this run's helper container ({target})"
        method, url, headers, data = self._parse_curl(rest[1:])
        status, payload = self._serve(method, url, headers, data)
        if status is None:
            return self.egress_code, f"curl: ({self.egress_code}) the requested transport failed"
        body = "" if payload is None else json.dumps(payload)
        return 0, f"{body}\n{status}"

    @staticmethod
    def _parse_curl(args):
        method, url, headers, data = "GET", None, [], None
        index = 0
        while index < len(args):
            token = args[index]
            if token in ("--request", "-X"):
                method, index = args[index + 1], index + 2
            elif token in ("--header", "-H"):
                headers.append(args[index + 1])
                index += 2
            elif token in ("--data-raw", "--data-binary", "--data", "-d"):
                data, index = args[index + 1], index + 2
            elif token in ("--write-out", "-w", "--max-time", "-m", "--output", "-o", "--url"):
                index += 2
            elif token.startswith("-"):
                index += 1
            else:
                url, index = token, index + 1
        return method, url, headers, data

    def _serve(self, method, url, headers, data):
        parsed = urllib.parse.urlsplit(url or "")
        host, path = parsed.hostname or "", parsed.path or "/"
        if host == recovery.GATEWAY_ALIAS:
            return self._serve_gateway(method, path, data)
        if host == recovery.IDENTITY_ALIAS:
            if path.endswith("/.well-known/openid-configuration"):
                return 200, {"issuer": stack.keycloak_issuer(self.identity_port)}
            if path.endswith("/protocol/openid-connect/token"):
                return 200, {"access_token": "fake-access-token"}
            return 404, {"code": "not_found"}
        if host == recovery.BROKER_ALIAS:
            name = urllib.parse.unquote(path.rsplit("/", 1)[-1])
            return 200, dict(self.queues[name])
        if host in recovery.PUBLISHED_HOSTS:
            return 404, {"code": "not_found"}
        # Anything else is the egress probe: closed by default on an internal
        # network, reachable only when the model is told egress leaked.
        if self.egress_open:
            return 200, None
        return None, None

    def _serve_gateway(self, method, path, data):
        body = json.loads(data) if data else None
        if path == "/health/ready":
            return 204, None
        if path == "/v1/jobs" and method == "POST":
            return self._serve_create(body or {})
        if path.startswith("/v1/jobs/") and path.endswith("/replay") and method == "POST":
            return self._serve_replay(path.split("/")[3], body)
        if path.startswith("/v1/jobs/"):
            return 200, dict(self.rows[path.split("/")[3]])
        if path.startswith("/v1/risk/history"):
            return 200, list(self.history)
        if path == "/v1/audit":
            return 200, self.audit + [{"action": action, "job_id": JOB} for action in self.extra_audit]
        raise AssertionError(f"the fake stack was asked for an unknown path: {path}")

    def _serve_create(self, body):
        zone, scenario = body.get("zone_id"), body.get("scenario_id")
        if zone == SPARE_ZONE:
            job_id = PERMANENT_JOB
        elif scenario == RETRY_SCENARIO:
            job_id = RETRIES_JOB
        else:
            job_id = CONTROL if not self.rows else JOB
        row = {"id": job_id, "state": "queued", "attempts": 0, "requested_at": REQUESTED_AT}
        self.rows[job_id] = row
        self.queues[recovery.RISK_QUEUE]["messages"] += 1
        self.audit.append({"action": "job.requested", "job_id": job_id})
        accepted = dict(row)
        if zone == SPARE_ZONE:
            self._apply_terminal(row, self.permanent_state, self.permanent_reason,
                                 self.permanent_attempts, self.permanent_dead_letters)
        elif scenario == RETRY_SCENARIO:
            self._apply_terminal(row, self.retries_state, self.retries_reason,
                                 self.retries_attempts, self.retries_dead_letters)
        else:
            self.deliver(job_id)
        return 202, accepted

    def _apply_terminal(self, row, state, reason, attempts, dead_letters):
        """Model one give-up: the terminal row plus the dead letter it leaves."""
        row.update(state=state, attempts=attempts, failure_reason=reason, failed_at=FAILED_AT)
        self.queues[recovery.RISK_DEAD_QUEUE]["messages"] += dead_letters

    def _serve_replay(self, job_id, body):
        row = self.rows[job_id]
        if body is not None and body.get("confirm") != recovery.REPLAY_CONFIRMATION:
            return 400, {"code": "invalid_replay_request"}
        if row["state"] in ("published", "failed"):
            return 409, {"code": "job_not_replayable"}
        if row["state"] == "queued" and body is None:
            return 409, {"code": "replay_confirmation_required"}
        row.update(state=self.replayed_state, attempts=0)
        self.audit.append({"action": "job.requested", "job_id": job_id})
        replayed = dict(row)
        self.deliver(job_id)
        return 202, replayed

    def deliver(self, job_id):
        """Complete the request if a consumer is running and the store answers."""
        if not (self.risk_running and self.postgres_up):
            return
        if job_id == JOB and not self.publish_on_replay:
            return
        self.rows[job_id].update(state="published", batch_id=BATCH, attempts=0)
        self.audit.append({"action": "batch.published", "job_id": job_id})
        if job_id != JOB:
            self.history.append({"id": BATCH, "job_id": job_id})
            return
        for index in range(self.batches_on_completion):
            self.history.append({"id": BATCH if index == 0 else f"bb{index}{BATCH[2:]}", "job_id": job_id})

    def _docker_cleanup(self, argv, timeout=60):
        return self._docker(argv)

    def wait_for_postgres(self):
        if not self.postgres_up:
            raise stack.HarnessError("postgres is still down")

    def wait_for_queue(self, name, predicate, description):
        """Settle the interrupted delivery the way the broker's delivery limit does."""
        if name == recovery.RISK_DEAD_QUEUE and not self.settled:
            self.settled = True
            self.queues[recovery.RISK_QUEUE] = {"messages": self.queue_left}
            self.queues[recovery.RISK_DEAD_QUEUE] = {"messages": self.dead_letters}
            # The wrong trace this models: an attempt count that survived a write
            # the failed dependency could not have served.
            self.rows[JOB]["attempts"] = self.attempts_kept
        return super().wait_for_queue(name, predicate, description)


class RecoveryWitnessTest(unittest.TestCase):
    """The witness passes on a recovery trace and fails on a wrong one."""

    def run_witness(self, **options):
        harness = FakeStack(**options)
        quiet(harness.verify, "admin-token", "viewer-token")
        return harness

    def assert_refused(self, fragment, **options):
        """Require the witness to refuse, naming the check that caught the trace."""
        harness = FakeStack(**options)
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(stack.HarnessError) as caught:
            harness.verify("admin-token", "viewer-token")
        self.assertIn(fragment, str(caught.exception))
        return harness

    def test_the_policy_trace_is_accepted(self):
        harness = self.run_witness()
        self.assertEqual(harness.rows[JOB]["state"], "published")
        self.assertEqual([batch["id"] for batch in harness.history if batch["job_id"] == JOB], [BATCH])
        self.assertEqual(
            sorted(entry["action"] for entry in harness.audit if entry["job_id"] == JOB),
            ["batch.published", "job.requested", "job.requested"],
        )

    def test_a_persisted_attempt_count_is_refused(self):
        self.assert_refused("persisted attempts", attempts_kept=5)

    def test_a_second_message_on_the_dead_letter_queue_is_refused(self):
        self.assert_refused("dead-letter queue reports 2", dead_letters=2)

    def test_a_delivery_left_on_the_queue_is_refused(self):
        self.assert_refused("to drain", queue_left=1)

    def test_a_duplicated_batch_is_refused(self):
        self.assert_refused("batches instead of one", batches_on_completion=2)

    def test_an_unexpected_audit_action_is_refused(self):
        self.assert_refused("unexpected audit", extra_audit=["job.failed"])

    def test_a_replay_that_never_completes_is_refused(self):
        self.assert_refused("to be published", publish_on_replay=False)

    def test_a_replay_that_answers_the_wrong_state_is_refused(self):
        self.assert_refused("did not return the job to queued", replayed_state="published")


class PermanentFailureWitnessTest(unittest.TestCase):
    """BH-07's unobserved half: a permanent failure reaching ``failed``."""

    def run_witness(self, **options):
        harness = FakeStack(**options)
        quiet(harness.verify, "admin-token", "viewer-token")
        return harness

    def assert_refused(self, fragment, **options):
        harness = FakeStack(**options)
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(stack.HarnessError) as caught:
            harness.verify("admin-token", "viewer-token")
        self.assertIn(fragment, str(caught.exception))
        return harness

    def test_a_permanent_failure_reaches_failed_on_its_first_attempt(self):
        harness = self.run_witness()
        row = harness.rows[PERMANENT_JOB]
        self.assertEqual(row["state"], "failed")
        self.assertEqual(row["failure_reason"], "permanent_error")
        self.assertEqual(row["attempts"], 1, "a permanent error must skip every retry")

    def test_the_risk_zone_reference_is_removed_before_the_permanent_job_exists(self):
        harness = self.run_witness()
        sql = [call for call in harness.calls
               if call[0] == "exec" and any("psql" in argument for argument in call)]
        self.assertTrue(sql, "the witness never removed the risk-side zone reference")
        creates = [index for index, call in enumerate(harness.calls)
                   if call[0] == "exec" and "curl" in call
                   and any(SPARE_ZONE in token for token in call)]
        self.assertTrue(creates, "no witness call named the spare zone")
        self.assertLess(harness.calls.index(sql[0]), creates[0],
                        "the permanent job was created before its reference was removed")
        self.assertTrue(any(SPARE_ZONE in token for token in sql[0]), sql[0])

    def test_a_permanent_failure_classified_as_retry_exhaustion_is_refused(self):
        self.assert_refused("permanent", permanent_reason="retries_exhausted")

    def test_a_permanent_failure_that_spent_more_than_one_attempt_is_refused(self):
        self.assert_refused("attempt", permanent_attempts=5)

    def test_a_permanent_failure_that_never_reached_a_terminal_state_is_refused(self):
        self.assert_refused("failed", permanent_state="queued")

    def test_a_missing_dead_letter_for_the_permanent_failure_is_refused(self):
        self.assert_refused("dead", permanent_dead_letters=0)


class RetriesExhaustionWitnessTest(unittest.TestCase):
    """BH-07's second unobserved half: the durable attempt count of a give-up."""

    def run_witness(self, **options):
        harness = FakeStack(**options)
        quiet(harness.verify, "admin-token", "viewer-token")
        return harness

    def assert_refused(self, fragment, **options):
        harness = FakeStack(**options)
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(stack.HarnessError) as caught:
            harness.verify("admin-token", "viewer-token")
        self.assertIn(fragment, str(caught.exception))
        return harness

    def test_retry_exhaustion_is_recorded_as_five_durable_attempts(self):
        harness = self.run_witness()
        row = harness.rows[RETRIES_JOB]
        self.assertEqual(row["state"], "failed")
        self.assertEqual(row["failure_reason"], "retries_exhausted")
        self.assertEqual(row["attempts"], 5, "the agreed budget is five attempts")

    def test_a_job_that_spent_fewer_attempts_is_refused(self):
        self.assert_refused("attempt", retries_attempts=4)

    def test_retry_exhaustion_classified_as_permanent_is_refused(self):
        self.assert_refused("retries_exhausted", retries_reason="permanent_error")

    def test_a_missing_dead_letter_for_the_exhaustion_is_refused(self):
        self.assert_refused("dead", retries_dead_letters=0)


class InNetworkWitnessTest(unittest.TestCase):
    """Every probe runs inside the run's own network, never through the host."""

    def test_every_witness_call_executes_inside_the_recorded_container(self):
        harness = FakeStack()
        quiet(harness.verify, "admin-token", "viewer-token")
        probes = [call for call in harness.calls if call[0] == "exec" and "curl" in call]
        self.assertTrue(probes, "the witness issued no HTTP probe")
        for call in probes:
            self.assertEqual(call[1], harness.witness_id,
                             "a probe ran outside this run's recorded helper container")

    def test_no_witness_url_addresses_a_host_loopback_port(self):
        harness = FakeStack()
        harness.management_port = 15672
        quiet(harness.verify, "admin-token", "viewer-token")
        quiet(harness.wait_for_keycloak)
        quiet(harness.fetch_token, "demo-admin", "pw")
        for call in harness.calls:
            if call[0] != "exec" or "curl" not in call:
                continue
            for token in call:
                if not token.startswith("http"):
                    continue
                host = urllib.parse.urlsplit(token).hostname
                self.assertNotIn(host, recovery.PUBLISHED_HOSTS,
                                 f"a probe addressed the host at {token}, which the internal network never routes")

    def test_a_loopback_url_is_refused_by_the_witness(self):
        harness = FakeStack()
        for url in ("http://127.0.0.1:8080/v1/jobs", "http://localhost:8080/v1/jobs"):
            with self.assertRaises(stack.HarnessError) as caught:
                harness.witness_http(url)
            self.assertIn("inside", str(caught.exception))

    def test_the_gateway_is_reached_by_network_alias(self):
        harness = FakeStack()
        quiet(harness.verify, "admin-token", "viewer-token")
        urls = [token for call in harness.calls if call[0] == "exec" and "curl" in call
                for token in call if token.startswith("http")]
        self.assertTrue(any(urllib.parse.urlsplit(url).hostname == recovery.GATEWAY_ALIAS for url in urls), urls)

    def test_the_broker_counters_are_read_from_inside_the_network(self):
        harness = FakeStack()
        quiet(harness.broker_queue, recovery.RISK_QUEUE)
        probes = [call for call in harness.calls if call[0] == "exec" and "curl" in call]
        self.assertTrue(probes, "the broker counters were not read through the helper container")
        url = [token for token in probes[-1] if token.startswith("http")][0]
        self.assertEqual(urllib.parse.urlsplit(url).hostname, recovery.BROKER_ALIAS)

    def test_keycloak_discovery_is_read_from_inside_the_network(self):
        harness = FakeStack()
        quiet(harness.wait_for_keycloak)
        probes = [call for call in harness.calls if call[0] == "exec" and "curl" in call]
        self.assertTrue(probes, "the discovery document was not read through the helper container")
        url = [token for token in probes[-1] if token.startswith("http")][0]
        self.assertEqual(urllib.parse.urlsplit(url).hostname, recovery.IDENTITY_ALIAS)

    def test_the_token_is_fetched_from_inside_the_network(self):
        harness = FakeStack()
        token = quiet(harness.fetch_token, "demo-admin", "pw")
        self.assertTrue(token)
        probes = [call for call in harness.calls if call[0] == "exec" and "curl" in call]
        self.assertEqual(urllib.parse.urlsplit(
            [value for value in probes[-1] if value.startswith("http")][0]).hostname, recovery.IDENTITY_ALIAS)

    def test_the_gateway_readiness_is_read_from_inside_the_network(self):
        harness = FakeStack()
        quiet(harness.wait_for_gateway)
        probes = [call for call in harness.calls if call[0] == "exec" and "curl" in call]
        url = [value for value in probes[-1] if value.startswith("http")][0]
        self.assertEqual(urllib.parse.urlsplit(url).hostname, recovery.GATEWAY_ALIAS)
        self.assertTrue(url.endswith("/health/ready"), url)


class WitnessScopeTest(unittest.TestCase):
    """The helper container is owned, minimal and network-scoped."""

    def test_the_helper_container_is_recorded_and_owned(self):
        harness = FakeStack()
        quiet(harness.attest_witness_scope)
        self.assertIn(f"{harness.prefix}-{WITNESS_ROLE}", harness.created)
        self.assertEqual(harness.witness_id, harness.created[f"{harness.prefix}-{WITNESS_ROLE}"])

    def test_a_helper_on_a_foreign_network_is_refused(self):
        harness = FakeStack(witness_attached="someone-elses-network;")
        with self.assertRaises(stack.HarnessError) as caught:
            quiet(harness.attest_witness_scope)
        self.assertIn("not only", str(caught.exception))

    def test_an_unlabelled_helper_is_refused(self):
        harness = FakeStack(witness_labels={recovery.VERIFY_LABEL: "1", recovery.RUN_LABEL: "someone-elses-run"})
        with self.assertRaises(stack.HarnessError) as caught:
            quiet(harness.attest_witness_scope)
        self.assertIn("ownership label", str(caught.exception))

    def test_a_helper_with_a_managed_mount_is_refused(self):
        harness = FakeStack(witness_mounted="bind=;volume=;")
        with self.assertRaises(stack.HarnessError) as caught:
            quiet(harness.attest_witness_scope)
        self.assertIn("managed mount", str(caught.exception))

    def test_a_missing_helper_is_refused_before_any_probe(self):
        harness = FakeStack()
        harness.witness_id = None
        with self.assertRaises(stack.HarnessError) as caught:
            quiet(harness.attest_witness_scope)
        self.assertIn("helper container", str(caught.exception))


class EgressClosedTest(unittest.TestCase):
    """Egress closed is measured from inside, not assumed from the flag."""

    def test_closed_egress_is_attested(self):
        harness = FakeStack()
        quiet(harness.attest_egress_closed)
        probes = [call for call in harness.calls if call[0] == "exec" and "curl" in call]
        self.assertGreaterEqual(len(probes), 1, "no egress probe ran")
        hosts = {urllib.parse.urlsplit(value).hostname
                 for call in probes for value in call if value.startswith("http")}
        self.assertTrue(hosts - {recovery.GATEWAY_ALIAS, recovery.IDENTITY_ALIAS, recovery.BROKER_ALIAS},
                        "no probe left the run's own services")

    def test_open_egress_is_refused(self):
        harness = FakeStack(egress_open=True)
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(stack.HarnessError) as caught:
            harness.attest_egress_closed()
        self.assertIn("egress", str(caught.exception))

    def test_open_egress_stops_the_witness_before_the_first_fault(self):
        harness = FakeStack(egress_open=True)
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(stack.HarnessError):
            harness.verify("admin-token", "viewer-token")
        self.assertEqual([call for call in harness.calls if call[0] in FAULT_VERBS], [],
                         "a fault was injected into a network whose egress was not closed")

    def test_egress_is_attested_before_the_first_fault(self):
        harness = FakeStack()
        quiet(harness.verify, "admin-token", "viewer-token")
        egress = [index for index, call in enumerate(harness.calls)
                  if call[0] == "exec" and "curl" in call
                  and any(value.startswith("https://1.1.1.1") for value in call)]
        faults = [index for index, call in enumerate(harness.calls) if call[0] in FAULT_VERBS]
        self.assertTrue(egress, "the witness never probed external egress")
        self.assertTrue(faults, "the witness injected no fault")
        self.assertLess(egress[0], faults[0], "a fault was injected before egress was attested")


class HostPortIndependenceTest(unittest.TestCase):
    """The witness no longer depends on a published loopback port."""

    def test_the_witness_runs_with_every_published_port_closed(self):
        harness = FakeStack()
        harness.management_port = closed_loopback_port()
        harness.identity_port = closed_loopback_port()
        harness.gateway_port = closed_loopback_port()
        quiet(harness.verify, "admin-token", "viewer-token")
        self.assertEqual(harness.rows[JOB]["state"], "published")

    def test_the_host_port_probe_is_gone(self):
        self.assertFalse(hasattr(recovery.Harness, "attest_host_ports"),
                         "the host-port probe is what refused the isolated run; it must not come back")

    def test_no_host_url_is_constructed_for_a_service(self):
        source = Path(recovery.__file__).read_text(encoding="utf-8")
        for host in recovery.PUBLISHED_HOSTS:
            self.assertNotIn(f'"http://{host}:', source,
                             f"the harness still builds a host URL for {host}")


class NetworkSubnetTest(unittest.TestCase):
    """A daemon whose default pool is exhausted still gets a closed network."""

    def test_an_exhausted_pool_falls_back_to_an_explicit_subnet(self):
        harness = FakeStack(pool_exhausted=True)
        harness.owned_network = None
        quiet(harness.create_network)
        creates = [call for call in harness.calls if call[:2] == ["network", "create"]]
        self.assertGreaterEqual(len(creates), 2, "the pool exhaustion was not retried with a subnet")
        self.assertIn("--internal", creates[0])
        self.assertTrue(any("--subnet" in call for call in creates), creates)
        self.assertEqual(harness.owned_network, harness.network)

    def test_the_layout_stays_internal_after_the_fallback(self):
        harness = FakeStack(pool_exhausted=True)
        harness.owned_network = None
        quiet(harness.create_network)
        attested = [call for call in harness.calls if call[:2] == ["network", "inspect"]]
        self.assertTrue(attested, "the fallback network was never attested internal")

    def test_every_candidate_refused_claims_no_ownership(self):
        harness = FakeStack(pool_exhausted=True, accept_subnet="10.255.254.0/24")
        harness.owned_network = None
        with self.assertRaises(stack.HarnessError) as caught:
            quiet(harness.create_network)
        self.assertIn("internal", str(caught.exception).lower())
        self.assertIsNone(harness.owned_network, "a failed create must never claim ownership")


class LabelValueTest(unittest.TestCase):
    """A bare ``--label key`` sets an empty value, which is a *different* label.

    The shared helper writes ``firewatch.verify=1``; a bare key produces ``""``
    and the ownership check then refuses the container this run just created.
    That is invisible to an in-memory daemon unless it is asserted directly.
    """

    def test_every_label_the_harness_sets_carries_a_value(self):
        harness = FakeStack()
        harness.owned_network = None
        quiet(harness.create_network)
        quiet(harness.start_witness)
        labels = [call[index + 1] for call in harness.calls
                  for index, argument in enumerate(call[:-1]) if argument == "--label"]
        self.assertTrue(labels, "the harness set no label at all")
        for label in labels:
            self.assertIn("=", label, f"a bare --label {label!r} sets an empty value, not the helper's")
        self.assertIn(f"{recovery.VERIFY_LABEL}=1", labels)


class AnonymousVolumeTest(unittest.TestCase):
    """An image-declared anonymous volume is removed by name, never leaked.

    ``postgis/postgis`` declares ``VOLUME /var/lib/postgresql/data``, so the
    inherited stack always creates one. ``docker rm`` without ``--volumes``
    leaves it behind, and a label inventory cannot see it because it inherits no
    label - which is why the harness records the name and proves it gone.
    """

    VOLUME = "b" * 64
    DESTINATION = "/var/lib/postgresql/data"

    def test_an_anonymous_volume_is_recorded(self):
        harness = FakeStack(mounted=f"bind=;volume={self.VOLUME}@{self.DESTINATION};")
        quiet(harness.attest_ownership)
        self.assertEqual(harness.owned_volumes, [self.VOLUME])

    def test_an_anonymous_volume_is_removed_by_name_on_cleanup(self):
        harness = FakeStack(mounted=f"bind=;volume={self.VOLUME}@{self.DESTINATION};")
        harness.owned_network = harness.network
        quiet(harness.cleanup)
        self.assertIn(self.VOLUME, harness.removed_volumes)

    def test_a_surviving_anonymous_volume_is_reported(self):
        harness = FakeStack()
        harness.owned_network = harness.network
        harness.owned_volumes = [self.VOLUME]
        harness.torn_down = False
        problems = quiet(harness.assert_torn_down)
        self.assertTrue(any("anonymous volume" in problem for problem in problems), problems)

    def test_a_gone_anonymous_volume_is_proven(self):
        harness = FakeStack()
        harness.owned_network = harness.network
        harness.owned_volumes = [self.VOLUME]
        harness.torn_down = True
        self.assertEqual(quiet(harness.assert_torn_down), [])

    def test_cleanup_collects_volumes_even_when_attestation_never_ran(self):
        harness = FakeStack(mounted=f"bind=;volume={self.VOLUME}@{self.DESTINATION};")
        harness.owned_network = harness.network
        quiet(harness.cleanup)
        self.assertIn(self.VOLUME, harness.removed_volumes)


class EgressCodeTest(unittest.TestCase):
    """Unreachable is a measurement; "the probe could not run" is not.

    curl exit 6 (cannot resolve), 7 (cannot connect) and 28 (timeout) are the
    transport and DNS failures that prove this network has no route out. Any
    other nonzero code - 125/126/127 for a missing binary or a failed exec, or a
    daemon error - says nothing about egress and must fail the run instead of
    being counted as a closed network.
    """

    def test_the_curl_unreachability_codes_are_accepted(self):
        for code in recovery.EGRESS_UNREACHABLE_CODES:
            with self.subTest(code=code):
                quiet(FakeStack(egress_code=code).attest_egress_closed)

    def test_a_missing_curl_or_failed_exec_is_not_closed_egress(self):
        for code in recovery.DAEMON_FAILURE_CODES:
            with self.subTest(code=code):
                harness = FakeStack(egress_code=code)
                with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(stack.HarnessError) as caught:
                    harness.attest_egress_closed()
                message = str(caught.exception)
                self.assertIn("could not run", message)
                self.assertIn(str(code), message)

    def test_an_unexpected_nonzero_code_is_not_closed_egress(self):
        harness = FakeStack(egress_code=1)
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(stack.HarnessError) as caught:
            harness.attest_egress_closed()
        self.assertIn("could not run", str(caught.exception))

    def test_a_witness_that_is_not_running_is_refused(self):
        harness = FakeStack(witness_running=False)
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(stack.HarnessError) as caught:
            harness.attest_egress_closed()
        self.assertIn("not running", str(caught.exception))

    def test_a_stopped_witness_stops_the_witness_before_the_first_fault(self):
        harness = FakeStack(witness_running=False)
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(stack.HarnessError):
            harness.verify("admin-token", "viewer-token")
        self.assertEqual([call for call in harness.calls if call[0] in FAULT_VERBS], [],
                         "a fault was injected while the witness could not be shown to be running")


class AbsenceProofTest(unittest.TestCase):
    """A resource is gone when the daemon says so, not when a command fails."""

    def test_no_such_object_is_absence_proof(self):
        harness = FakeStack()
        harness.owned_network = harness.network
        harness.torn_down = True
        self.assertEqual(quiet(harness.assert_torn_down), [])

    def test_a_failure_without_the_no_such_marker_is_not_proof(self):
        harness = FakeStack(absent_marker="Error response from daemon: something else went wrong")
        harness.owned_network = harness.network
        harness.torn_down = True
        problems = quiet(harness.assert_torn_down)
        self.assertTrue(any("could not be proved gone" in problem for problem in problems), problems)

    def test_a_dead_daemon_is_not_absence_proof(self):
        harness = FakeStack(daemon_down=True)
        harness.owned_network = harness.network
        harness.torn_down = True
        problems = quiet(harness.assert_torn_down)
        self.assertTrue(problems, "a dead daemon was accepted as proof that resources are gone")

    def test_a_failed_label_inventory_is_not_absence_proof(self):
        harness = FakeStack(inventory_fails=True)
        harness.owned_network = harness.network
        harness.torn_down = True
        problems = quiet(harness.assert_torn_down)
        self.assertTrue(any("cannot list" in problem for problem in problems), problems)


class NetworkIdentityTest(unittest.TestCase):
    """The network is removed by the id it was created with, after its label."""

    def test_the_network_is_created_with_the_id_the_daemon_returned(self):
        harness = FakeStack()
        harness.owned_network = None
        quiet(harness.create_network)
        self.assertEqual(harness.network_id, container_id("network"))

    def test_the_network_is_removed_by_id_never_by_name(self):
        harness = FakeStack()
        harness.owned_network = harness.network
        quiet(harness.cleanup)
        removals = [call for call in harness.calls if call[:2] == ["network", "rm"]]
        self.assertEqual(removals, [["network", "rm", harness.network_id]])

    def test_the_label_is_rechecked_before_the_network_is_removed(self):
        harness = FakeStack(network_labels={recovery.VERIFY_LABEL: "1", recovery.RUN_LABEL: "someone-elses-run"})
        harness.owned_network = harness.network
        problems = quiet(harness.cleanup)
        self.assertTrue(any("network" in problem for problem in problems), problems)
        self.assertEqual([call for call in harness.calls if call[:2] == ["network", "rm"]], [],
                         "a network whose label is not this run's was removed")

    def test_a_network_the_run_never_created_is_refused(self):
        harness = FakeStack()
        harness.owned_network = harness.network
        harness.network_id = None
        problems = quiet(harness.cleanup)
        self.assertTrue(any("network" in problem for problem in problems), problems)

    def test_a_surviving_network_id_is_reported(self):
        harness = FakeStack()
        harness.owned_network = harness.network
        harness.torn_down = False
        harness.surviving_networks = {harness.network_id}
        problems = quiet(harness.assert_torn_down)
        self.assertTrue(any("network" in problem and "still exists" in problem for problem in problems), problems)

    def test_the_isolation_attestation_reads_the_created_network_id(self):
        harness = FakeStack()
        harness.owned_network = None
        quiet(harness.create_network)
        inspected = [call[-1] for call in harness.calls if call[:2] == ["network", "inspect"]]
        self.assertIn(harness.network_id, inspected)


class TransientContainerTest(unittest.TestCase):
    """The migration and topology containers are proved gone by id too."""

    def test_a_transient_create_is_recorded_for_the_teardown_proof(self):
        harness = FakeStack()
        harness.transient_containers.clear()
        quiet(harness._run_owned_container, f"{harness.prefix}-migrate", "image", command=["migrate"])
        self.assertEqual(harness.transient_containers, [container_id("migrate")])

    def test_an_empty_transient_registry_is_refused(self):
        harness = FakeStack()
        harness.transient_containers.clear()
        with self.assertRaises(stack.HarnessError) as caught:
            quiet(harness.attest_ownership)
        self.assertIn("transient", str(caught.exception))

    def test_every_transient_id_is_inspected_for_the_teardown_proof(self):
        harness = FakeStack()
        harness.owned_network = harness.network
        harness.torn_down = True
        harness.transient_containers = ["a" * 64, "b" * 64]
        self.assertEqual(quiet(harness.assert_torn_down), [])
        inspected = [call[-1] for call in harness.calls if call[0] == "container"]
        for transient in harness.transient_containers:
            self.assertIn(transient, inspected, "a transient container id was never proved gone")

    def test_a_surviving_transient_container_is_reported(self):
        harness = FakeStack()
        harness.owned_network = harness.network
        harness.torn_down = True
        survivor = "c" * 64
        harness.transient_containers = [survivor]
        harness.surviving_ids = {survivor}
        problems = quiet(harness.assert_torn_down)
        self.assertTrue(any(survivor in problem for problem in problems), problems)


class VolumeOwnershipTest(unittest.TestCase):
    """A volume is accepted only on a declared destination and only if unclaimed."""

    VOLUME = "d" * 64
    DESTINATION = "/var/lib/postgresql/data"

    def test_a_volume_outside_a_declared_destination_is_refused(self):
        harness = FakeStack(mounted=f"bind=;volume={self.VOLUME}@/etc/elsewhere;")
        with self.assertRaises(stack.HarnessError) as caught:
            quiet(harness.attest_ownership)
        self.assertIn("managed mount", str(caught.exception))

    def test_a_volume_another_run_claims_is_refused(self):
        harness = FakeStack(mounted=f"bind=;volume={self.VOLUME}@{self.DESTINATION};")
        harness.volume_labels[self.VOLUME] = {recovery.RUN_LABEL: "someone-elses-run"}
        with self.assertRaises(stack.HarnessError) as caught:
            quiet(harness.attest_ownership)
        self.assertIn("another run", str(caught.exception))

    def test_a_volume_this_run_claims_is_accepted(self):
        harness = FakeStack(mounted=f"bind=;volume={self.VOLUME}@{self.DESTINATION};")
        harness.volume_labels[self.VOLUME] = {recovery.VERIFY_LABEL: "1", recovery.RUN_LABEL: harness.run_id}
        quiet(harness.attest_ownership)
        self.assertIn(self.VOLUME, harness.owned_volumes)

    def test_a_volume_the_daemon_does_not_report_is_refused(self):
        harness = FakeStack(mounted=f"bind=;volume={self.VOLUME}@{self.DESTINATION};")
        harness.unreadable_volumes = {self.VOLUME}
        with self.assertRaises(stack.HarnessError) as caught:
            quiet(harness.attest_ownership)
        self.assertIn("does not report volume", str(caught.exception))

    def test_a_foreign_container_contributes_no_volume(self):
        harness = FakeStack(mounted=f"bind=;volume={self.VOLUME}@{self.DESTINATION};")
        harness.labels = {
            container: {recovery.VERIFY_LABEL: "1", recovery.RUN_LABEL: "someone-elses-run"}
            for container in harness.roles
        }
        quiet(harness.collect_owned_volumes)
        self.assertEqual(harness.owned_volumes, [], "a container that is not this run's contributed a volume")

    def test_the_declared_destinations_cover_the_stack_images(self):
        self.assertIn("/var/lib/postgresql/data", recovery.DECLARED_VOLUME_DESTINATIONS)


class RedactionSafetyTest(unittest.TestCase):
    """Redaction is for messages; it must never corrupt structured output.

    The shared helper registers every entry of its ``secrets`` map for redaction,
    and one of those entries is the literal database *username*. Masking a public
    username rewrites the mount destinations and container names the harness has
    to parse, which is how a live run refused its own postgres volume.
    """

    def test_the_public_database_username_is_not_redacted(self):
        harness = FakeStack()
        self.assertNotIn(harness.secrets["POSTGRES_USER"], harness.redactions)

    def test_a_mount_destination_containing_the_username_is_left_intact(self):
        harness = FakeStack()
        destination = "/var/lib/postgresql/data"
        self.assertEqual(harness._redact(destination), destination)

    def test_a_generated_credential_is_still_redacted(self):
        harness = FakeStack()
        password = harness.secrets["POSTGRES_PASSWORD"]
        self.assertNotIn(password, harness._redact(f"password is {password}"))


class AbsenceWordingTest(unittest.TestCase):
    """Absence needs the daemon's own grammar with the inspected identifier in it.

    The daemon states non-existence in exactly two shapes: ``No such <kind>: <id>``
    and ``<kind> <id> not found``. Naming a resource *kind* somewhere and the id
    somewhere else is not that statement -- ``network driver not found for <id>``
    and ``container runtime failed while attaching <id>`` are failures *about* the
    kind, not the daemon saying our resource is gone. The identifier also has to be
    a whole token, so an id another id merely extends or ends with is not ours.
    """

    IDENT = "6bd0d2d11cd8" + "0" * 52

    def test_the_network_not_found_wording_naming_the_id_is_absence(self):
        output = f"[]\nError response from daemon: network {self.IDENT} not found"
        self.assertTrue(recovery.Harness._is_absent(output, self.IDENT))

    def test_the_no_such_object_wording_naming_the_id_is_absence(self):
        self.assertTrue(recovery.Harness._is_absent(f"Error: No such object: {self.IDENT}", self.IDENT))

    def test_the_no_such_container_wording_naming_the_id_is_absence(self):
        self.assertTrue(recovery.Harness._is_absent(f"Error: No such container: {self.IDENT}", self.IDENT))

    def test_the_daemon_prefixed_no_such_container_wording_is_absence(self):
        output = f"Error response from daemon: No such container: {self.IDENT}"
        self.assertTrue(recovery.Harness._is_absent(output, self.IDENT))

    def test_the_no_such_network_wording_is_absence(self):
        self.assertTrue(recovery.Harness._is_absent(f"Error: No such network: {self.IDENT}", self.IDENT))

    def test_the_no_such_volume_wording_is_absence(self):
        self.assertTrue(recovery.Harness._is_absent(f"Error: No such volume: {self.IDENT}", self.IDENT))

    def test_the_kind_id_not_found_wording_is_absence(self):
        for kind in ("container", "network", "volume"):
            with self.subTest(kind=kind):
                self.assertTrue(
                    recovery.Harness._is_absent(f"Error response from daemon: {kind} {self.IDENT} not found", self.IDENT)
                )

    def test_the_daemon_get_no_such_volume_wording_is_absence(self):
        # The wording the live daemon produced for a removed anonymous volume:
        # ``[]`` then ``get <name>: no such volume``. The identifier is still bound
        # to the statement, so this is absence and not a driver failure.
        volume = "a" * 64
        output = f"[]\nError response from daemon: get {volume}: no such volume"
        self.assertTrue(recovery.Harness._is_absent(output, volume))

    def test_the_get_wording_for_another_volume_is_not_absence(self):
        ours = "a" * 64
        other = "b" * 64
        output = f"Error response from daemon: get {other}: no such volume\nthe daemon also reports {ours}"
        self.assertFalse(recovery.Harness._is_absent(output, ours))

    def test_a_get_wording_about_another_kind_is_not_absence(self):
        volume = "a" * 64
        self.assertFalse(
            recovery.Harness._is_absent(f"Error response from daemon: get {volume}: no such plugin", volume)
        )

    def test_a_get_wording_where_a_longer_token_extends_ours_is_not_absence(self):
        volume = "a" * 64
        output = f"Error response from daemon: get {volume}ff: no such volume"
        self.assertFalse(recovery.Harness._is_absent(output, volume))

    def test_the_lookup_no_such_volume_driver_wording_is_not_absence(self):
        # ``volume-driver`` is a different token than the kind ``volume``, so this
        # is a driver failure quoting the id, not the daemon saying it is gone.
        output = f"Error response from daemon: lookup {self.IDENT}: no such volume-driver"
        self.assertFalse(recovery.Harness._is_absent(output, self.IDENT))

    def test_the_not_found_wording_with_a_trailing_clause_is_not_absence(self):
        output = f"Error response from daemon: network {self.IDENT} not found in driver cache"
        self.assertFalse(recovery.Harness._is_absent(output, self.IDENT))

    def test_a_hyphenated_kind_after_no_such_is_not_absence(self):
        output = f"Error: No such container-shim: {self.IDENT}"
        self.assertFalse(recovery.Harness._is_absent(output, self.IDENT))

    def test_the_get_wording_with_a_compound_kind_is_not_absence(self):
        output = f"Error response from daemon: get {self.IDENT}: no such network-driver"
        self.assertFalse(recovery.Harness._is_absent(output, self.IDENT))

    def test_a_trailing_clause_after_the_identifier_is_not_absence(self):
        output = f"Error: No such container: {self.IDENT} (driver cache stale)"
        self.assertFalse(recovery.Harness._is_absent(output, self.IDENT))

    def test_a_trailing_clause_after_not_found_is_not_absence(self):
        output = f"Error response from daemon: volume {self.IDENT} not found in the catalogue"
        self.assertFalse(recovery.Harness._is_absent(output, self.IDENT))

    def test_a_trailing_period_after_the_name_is_not_absence(self):
        # ``.`` is legal in Docker names, so ``fw-test.`` names a different volume
        # than ``fw-test``. Only the statement without the period is about ours.
        self.assertFalse(recovery.Harness._is_absent("Error: No such volume: fw-test.", "fw-test"))
        self.assertTrue(recovery.Harness._is_absent("Error: No such volume: fw-test", "fw-test"))
        # A period after ``not found`` cannot belong to the name, so it stays allowed.
        self.assertTrue(
            recovery.Harness._is_absent("Error response from daemon: network fw-test not found.", "fw-test")
        )

    def test_crlf_line_endings_do_not_hide_the_diagnostic(self):
        self.assertTrue(recovery.Harness._is_absent(f"Error: No such container: {self.IDENT}\r\n", self.IDENT))

    def test_a_shortened_id_prefix_is_absence(self):
        self.assertTrue(recovery.Harness._is_absent(f"Error: No such container: {self.IDENT[:12]}", self.IDENT))

    def test_a_kind_only_not_found_is_not_absence(self):
        self.assertFalse(
            recovery.Harness._is_absent("Error response from daemon: network driver not found", self.IDENT)
        )

    def test_a_kind_driver_not_found_for_the_id_is_not_absence(self):
        output = f"Error response from daemon: network driver not found for {self.IDENT}"
        self.assertFalse(recovery.Harness._is_absent(output, self.IDENT))

    def test_a_container_runtime_failure_naming_the_id_is_not_absence(self):
        output = f"Error response from daemon: container runtime failed while attaching {self.IDENT}"
        self.assertFalse(recovery.Harness._is_absent(output, self.IDENT))

    def test_a_volume_driver_error_naming_the_id_is_not_absence(self):
        output = f"Error response from daemon: volume driver error on {self.IDENT}"
        self.assertFalse(recovery.Harness._is_absent(output, self.IDENT))

    def test_a_kind_not_found_with_the_id_on_another_line_is_not_absence(self):
        output = f"Error response from daemon: volume driver not found\nwhile removing {self.IDENT}"
        self.assertFalse(recovery.Harness._is_absent(output, self.IDENT))

    def test_absence_stated_for_another_id_while_naming_ours_is_not_absence(self):
        other = "f" * 64
        output = f"Error: No such container: {other}\nthe daemon also reports {self.IDENT}"
        self.assertFalse(recovery.Harness._is_absent(output, self.IDENT))

    def test_an_id_a_longer_one_extends_is_not_our_id(self):
        output = f"Error: No such container: {self.IDENT}deadbeef"
        self.assertFalse(recovery.Harness._is_absent(output, self.IDENT))

    def test_an_id_a_longer_one_ends_with_is_not_our_id(self):
        output = f"Error: No such container: ff{self.IDENT}"
        self.assertFalse(recovery.Harness._is_absent(output, self.IDENT))

    def test_a_shortened_prefix_inside_a_longer_token_is_not_absence(self):
        output = f"Error: No such container: {self.IDENT[:12]}deadbeef"
        self.assertFalse(recovery.Harness._is_absent(output, self.IDENT))

    def test_a_name_a_longer_one_extends_is_not_absence(self):
        name = "firewatch-verify-3f9a2c"
        self.assertFalse(recovery.Harness._is_absent(f"Error: No such container: {name}-2", name))

    def test_the_wording_for_a_different_id_is_not_absence(self):
        other = "f" * 64
        self.assertFalse(
            recovery.Harness._is_absent(f"Error response from daemon: network {other} not found", self.IDENT)
        )

    def test_an_unrelated_not_found_is_not_absence(self):
        self.assertFalse(recovery.Harness._is_absent("Error: plugin not found", self.IDENT))

    def test_a_dead_daemon_is_not_absence(self):
        self.assertFalse(recovery.Harness._is_absent("Cannot connect to the Docker daemon", self.IDENT))

    def test_an_empty_identifier_never_proves_absence(self):
        self.assertFalse(recovery.Harness._is_absent("Error: No such object: abc", ""))


class VolumeCollectionFailureTest(unittest.TestCase):
    """An unreadable volume or container is a teardown problem, never a skip."""

    VOLUME = "f" * 64
    DESTINATION = "/var/lib/postgresql/data"

    def mounted(self):
        return f"bind=;volume={self.VOLUME}@{self.DESTINATION};"

    def test_malformed_volume_labels_are_refused(self):
        harness = FakeStack(mounted=self.mounted())
        harness.malformed_volume_labels = {self.VOLUME}
        with self.assertRaises(stack.HarnessError) as caught:
            quiet(harness.attest_ownership)
        self.assertIn("labels of volume", str(caught.exception))

    def test_malformed_volume_labels_become_a_teardown_problem_on_collection(self):
        harness = FakeStack(mounted=self.mounted())
        harness.malformed_volume_labels = {self.VOLUME}
        harness.owned_network = harness.network
        problems = quiet(harness.cleanup)
        self.assertTrue(any("labels of volume" in problem for problem in problems), problems)

    def test_an_unreadable_container_label_is_a_teardown_problem(self):
        harness = FakeStack(mounted=self.mounted())
        harness.unreadable_label_containers = {container_id("postgres")}
        harness.owned_network = harness.network
        problems = quiet(harness.cleanup)
        self.assertTrue(any("labels could not be read" in problem for problem in problems), problems)

    def test_a_container_proved_absent_contributes_no_problem(self):
        harness = FakeStack(mounted=self.mounted())
        harness.owned_network = harness.network
        harness.torn_down = True
        quiet(harness.collect_owned_volumes)
        self.assertEqual(harness.volume_problems, [], "an absent container was reported as unreadable")

    def test_a_container_that_is_not_this_runs_is_never_attributed_a_volume(self):
        harness = FakeStack(mounted=self.mounted())
        harness.labels = {
            container: {recovery.VERIFY_LABEL: "1", recovery.RUN_LABEL: "someone-elses-run"}
            for container in harness.roles
        }
        quiet(harness.collect_owned_volumes)
        self.assertEqual(harness.owned_volumes, [])
        self.assertEqual(harness.volume_problems, [], "a foreign container must not be called unreadable")


class OutageOrderingTest(unittest.TestCase):
    """The database is only interrupted once the request is provably in flight,
    and no fault is injected through a name this run did not create."""

    def test_postgres_is_never_stopped_before_the_request_is_queued(self):
        harness = FakeStack()
        harness.queues[recovery.RISK_QUEUE]["messages"] = -2
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(stack.HarnessError) as caught:
            harness.verify("admin-token", "viewer-token")
        self.assertIn(f"to reach {recovery.RISK_QUEUE}", str(caught.exception))
        stopped = [call for call in harness.calls if call[0] == "stop" and not call[1].startswith("id-")]
        self.assertEqual(stopped, [], "the database was interrupted before the request was in flight")

    def test_every_fault_action_addresses_a_recorded_container_id(self):
        harness = FakeStack()
        quiet(harness.verify, "admin-token", "viewer-token")
        actions = [call for call in harness.calls if call[0] in FAULT_VERBS]
        self.assertTrue(actions, "the scenario never acted on a container")
        recorded = set(harness.created.values())
        for call in actions:
            self.assertGreater(len(call), 1, f"a fault action named no container: {call}")
            for target in call[1:]:
                self.assertIn(target, recorded, f"a fault action addressed {target}, which this run never recorded")
                self.assertFalse(
                    target.startswith(harness.prefix + "-"),
                    f"a fault action addressed the container name {target} instead of its recorded id",
                )


class RuntimeIsolationTest(unittest.TestCase):
    """Egress is closed at runtime and proven from the daemon, not asserted."""

    def test_the_network_is_created_internal_and_attested(self):
        harness = FakeStack()
        harness.owned_network = None
        quiet(harness.create_network)
        created = [call for call in harness.calls if call[:2] == ["network", "create"]]
        self.assertEqual(len(created), 1, "the harness created no network of its own")
        self.assertIn("--internal", created[0], "the runtime network was created with egress open")
        self.assertEqual(harness.owned_network, harness.network, "ownership was not recorded after the create")
        self.assertTrue([call for call in harness.calls if call[:2] == ["network", "inspect"]],
                        "the harness never attested the network it created")

    def test_a_network_that_is_not_internal_is_refused(self):
        harness = FakeStack(internal=False)
        harness.owned_network = harness.network
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(stack.HarnessError) as caught:
            harness.attest_runtime_isolation()
        self.assertIn("not internal", str(caught.exception))

    def test_the_witness_attests_isolation_before_the_first_fault(self):
        harness = FakeStack()
        quiet(harness.verify, "admin-token", "viewer-token")
        attested = [index for index, call in enumerate(harness.calls) if call[:2] == ["network", "inspect"]]
        faults = [index for index, call in enumerate(harness.calls) if call[0] in FAULT_VERBS]
        self.assertTrue(attested, "the witness never attested the runtime network")
        self.assertTrue(faults, "the witness injected no fault")
        self.assertLess(attested[0], faults[0], "a fault was injected before isolation was attested")


class FaultTargetTest(unittest.TestCase):
    """A fault is injected only into an id whose ownership this run can confirm."""

    def test_an_unrecorded_role_is_refused(self):
        harness = FakeStack()
        harness.created.clear()
        with self.assertRaises(stack.HarnessError) as caught:
            harness.fault_target("risk")
        self.assertIn("recorded no container id", str(caught.exception))

    def test_a_foreign_ownership_label_is_refused(self):
        harness = FakeStack(labels={recovery.VERIFY_LABEL: "1", recovery.RUN_LABEL: "someone-elses-run"})
        with self.assertRaises(stack.HarnessError) as caught:
            harness.fault_target("risk")
        self.assertIn("could not be confirmed", str(caught.exception))

    def test_a_foreign_label_stops_the_witness_before_any_fault(self):
        harness = FakeStack(labels={recovery.VERIFY_LABEL: "1", recovery.RUN_LABEL: "someone-elses-run"})
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(stack.HarnessError):
            harness.verify("admin-token", "viewer-token")
        self.assertEqual([call for call in harness.calls if call[0] in FAULT_VERBS], [],
                         "a fault was injected into a container whose ownership was not confirmed")

    def test_a_target_the_daemon_no_longer_reports_is_refused(self):
        harness = FakeStack()
        harness.roles.pop(container_id("risk"))
        with self.assertRaises(stack.HarnessError) as caught:
            harness.fault_target("risk")
        self.assertIn("does not report", str(caught.exception))


class OwnershipAttestationTest(unittest.TestCase):
    """Every recorded container must be labelled, bind-mounted and network-scoped."""

    def test_an_owned_stack_passes(self):
        harness = FakeStack()
        quiet(harness.attest_ownership)
        self.assertEqual(len(harness.created), len(ALL_ROLES))

    def test_a_managed_mount_is_refused(self):
        harness = FakeStack(mounted="bind=;volume=;")
        with self.assertRaises(stack.HarnessError) as caught:
            quiet(harness.attest_ownership)
        self.assertIn("managed mount", str(caught.exception))

    def test_a_named_volume_is_refused(self):
        harness = FakeStack(mounted="bind=;volume=firewatch-shared-data;")
        with self.assertRaises(stack.HarnessError) as caught:
            quiet(harness.attest_ownership)
        self.assertIn("managed mount", str(caught.exception))

    def test_a_foreign_network_attachment_is_refused(self):
        harness = FakeStack(attached="someone-elses-network;")
        with self.assertRaises(stack.HarnessError) as caught:
            quiet(harness.attest_ownership)
        self.assertIn("not only", str(caught.exception))

    def test_an_unreadable_label_is_refused(self):
        harness = FakeStack()
        harness.labels = {container: [] for container in harness.roles}
        with self.assertRaises(stack.HarnessError) as caught:
            quiet(harness.attest_ownership)
        self.assertIn("ownership label", str(caught.exception))


class TeardownProofTest(unittest.TestCase):
    """Teardown is proven by id and by label, and never assumed from a name."""

    def test_a_clean_teardown_is_proven(self):
        harness = FakeStack()
        harness.owned_network = harness.network
        harness.torn_down = True
        self.assertEqual(quiet(harness.assert_torn_down), [])
        inventories = {
            call[0] for call in harness.calls
            if "-q" in call and any(token.startswith("label=") for token in call)
        }
        self.assertEqual(
            inventories, {"ps", "network", "volume", "images"},
            "the proof did not inventory containers, networks, volumes and images by label",
        )

    def test_a_surviving_container_is_reported(self):
        harness = FakeStack()
        harness.owned_network = harness.network
        harness.survives = True
        problems = quiet(harness.assert_torn_down)
        self.assertTrue(any("still exists" in problem for problem in problems), problems)

    def test_a_surviving_labelled_resource_is_reported(self):
        harness = FakeStack()
        harness.torn_down = False
        problems = quiet(harness.assert_torn_down)
        self.assertTrue(any("still carry this run's label" in problem for problem in problems), problems)

    def test_the_teardown_proof_runs_after_the_helper_cleanup(self):
        harness = FakeStack()
        harness.owned_network = harness.network
        quiet(harness.cleanup)
        proofs = [call for call in harness.calls if call[0] == "container" and call[1] == "inspect"]
        self.assertTrue(proofs, "cleanup returned without proving the recorded ids are gone")

    def test_a_kept_project_skips_the_proof_on_purpose(self):
        harness = FakeStack(keep=True)
        harness.owned_network = harness.network
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(quiet(harness.cleanup), [])
        self.assertEqual([call for call in harness.calls if call[0] == "container"], [],
                         "the kept project was still inspected as if it had been removed")


class InheritedLifecycleTest(unittest.TestCase):
    """The lifecycle this harness does not need to change stays the helper's."""

    def test_the_untouched_lifecycle_is_still_the_helpers(self):
        for name in ("run", "check_environment", "build_images", "start_services",
                     "provision_broker", "run_migrations"):
            self.assertIs(
                getattr(recovery.Harness, name),
                getattr(stack.Harness, name),
                f"{name} must stay the shared helper's so its lifecycle cannot drift here",
            )

    def test_the_overridden_hooks_all_delegate_to_the_helper(self):
        for name in ("create_network", "cleanup", "_start_container", "start_infrastructure"):
            self.assertIsNot(getattr(recovery.Harness, name), getattr(stack.Harness, name))
            self.assertIn("super().", Path(recovery.__file__).read_text(encoding="utf-8"))

    def test_the_arguments_the_shared_helper_reads_are_offered(self):
        args = recovery.parse_args([])
        for name in ("timeout", "ready_timeout", "poll_interval", "zone", "keep"):
            self.assertTrue(hasattr(args, name), f"--{name.replace('_', '-')} is missing")
        self.assertEqual(args.zone, stack.DEFAULT_ZONE)

    def test_a_non_positive_timeout_is_rejected(self):
        with self.assertRaises(SystemExit):
            recovery.parse_args(["--timeout", "0"])


if __name__ == "__main__":
    unittest.main()
