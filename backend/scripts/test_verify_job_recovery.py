"""Scenario and safety contracts for ``verify_job_recovery.py``, without Docker.

The harness under test subclasses ``verify_synthetic.Harness``, so the stack
lifecycle - image builds, the isolated network, ownership, teardown - is not
re-tested here; ``test_verify_synthetic.py`` already pins it. What is tested is
the part this harness adds, and the safety rules it must enforce before it is
allowed to inject a fault:

* the runtime network is created with egress closed and then **attested**
  internal by the daemon, while image builds and pulls are reported separately
  as host egress;
* every fault action (``pause``, ``unpause``, ``stop``, ``start``, ``restart``)
  addresses a container **id this run recorded**, never a name, and the id's
  ownership label is re-confirmed immediately before acting - an uncertain id
  fails closed and no fault is injected;
* every container this run recorded carries its own label, keeps bind mounts
  only (so no anonymous or named volume can outlive the run) and sits only on
  the run's own network;
* teardown is proven by id and by label rather than by a name prefix, and a
  surviving resource is reported as a failure.

The tests drive the witness in-process against a fake stack that models the job
rows, the zone history, the audit log, the broker queue counters and the
daemon's inspection answers. Each check is also shown to *fail* when its
observation is wrong, so a green run means the witness can tell a recovery from
a duplicate effect, and an owned resource from a foreign one, instead of
passing on any trace at all.

Run with::

    python -m unittest discover -s backend/scripts -p test_verify_job_recovery.py -v
"""
from __future__ import annotations

import argparse
import contextlib
import io
import json
import socket
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import verify_job_recovery as recovery  # noqa: E402  (the harness under test)
import verify_synthetic as stack  # noqa: E402  (the shared stack helper)

JOB = "6f1d0f8e-3a2b-4c5d-8e9f-0a1b2c3d4e5f"
CONTROL = "1c1d0f8e-3a2b-4c5d-8e9f-0a1b2c3d4e5f"
BATCH = "aa1d0f8e-3a2b-4c5d-8e9f-0a1b2c3d4e5f"
REQUESTED_AT = "2026-11-20T12:00:00Z"
ZONE = "valparaiso-demo"
ROLES = ("postgres", "rabbitmq", "identity", "jobs", "risk", "gateway")
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


class FakeStack(recovery.Harness):
    """A ``Harness`` whose Docker, HTTP and broker seams are an in-memory model.

    The model follows the policy rather than the tests: the first job created is
    the healthy control, the second is the one the outage interrupts, a job is
    ``queued`` until its consumer records a completion, completions are
    asynchronous, and every container carries this run's labels, bind mounts and
    network. Each keyword widens the model to one wrong trace.
    """

    def __init__(self, *, attempts_kept=0, dead_letters=1, queue_left=0, publish_on_replay=True,
                 batches_on_completion=1, extra_audit=(), replayed_state="queued",
                 internal=True, keep=False, survives=False, mounted="bind;", attached=None,
                 labels=None):
        args = argparse.Namespace(timeout=120, ready_timeout=2, poll_interval=1, zone=ZONE, keep=keep)
        super().__init__(args)
        self.gateway_port, self.management_port = 1, 2
        self.attempts_kept = attempts_kept
        self.dead_letters = dead_letters
        self.queue_left = queue_left
        self.publish_on_replay = publish_on_replay
        self.batches_on_completion = batches_on_completion
        self.extra_audit = list(extra_audit)
        self.replayed_state = replayed_state
        self.internal = internal
        self.survives = survives
        self.calls: list[list[str]] = []
        self.rows: dict[str, dict] = {}
        self.history: list[dict] = []
        self.audit: list[dict] = []
        self.queues = {recovery.RISK_QUEUE: {"messages": 0}, recovery.RISK_DEAD_QUEUE: {"messages": 0}}
        self.postgres_up = True
        self.risk_running = True
        self.settled = False
        self.torn_down = False
        # The recorded ids a successful create would have produced, one per role.
        self.roles = {f"id-{role}": role for role in ROLES}
        self.created = {f"{self.prefix}-{role}": f"id-{role}" for role in ROLES}
        own = labels if labels is not None else {recovery.VERIFY_LABEL: "1", recovery.RUN_LABEL: self.run_id}
        self.labels = dict.fromkeys(self.roles, own)
        self.mounts = dict.fromkeys(self.roles, mounted)
        self.attached = dict.fromkeys(self.roles, attached or f"{self.network};")
        # As if ``create_network`` had already run: the witness attests it before a fault.
        self.owned_network = self.network

    # -- seams -------------------------------------------------------------
    def _docker(self, argv, *, env=None, timeout=None):
        self.calls.append(list(argv))
        if argv[0] == "network":
            return self._network(argv)
        if argv[0] == "inspect":
            return self._inspect_fake(argv)
        if argv[0] == "container":
            return (1, "no such object") if self.torn_down and not self.survives else (0, "{}")
        for target in argv[1:]:
            role = self.roles.get(target)
            if role == "risk":
                self.risk_running = argv[0] in {"start", "restart", "unpause"}
            elif role == "postgres":
                self.postgres_up = argv[0] in {"start", "restart", "unpause"}
        if argv[0] in {"rm", "rmi"} or argv[:2] == ["network", "rm"]:
            self.torn_down = self.torn_down or argv[:2] == ["network", "rm"]
            return 0, ""
        if "-q" in argv and any(token.startswith("label=") for token in argv):
            return (0, "") if self.torn_down else (0, "leftover-id")
        return 0, ""

    def _network(self, argv):
        if argv[1] == "create":
            return 0, "network-id"
        if argv[1] == "inspect" and "-f" in argv:
            return 0, "true" if self.internal else "false"
        if argv[1] == "inspect":
            return (1, "no such network") if self.torn_down else (0, "{}")
        return 0, ""

    def _inspect_fake(self, argv):
        template, target = argv[2], argv[3]
        if target not in self.roles:
            return 1, "no such object"
        if "Labels" in template:
            return 0, json.dumps(self.labels[target])
        if "Mounts" in template:
            return 0, self.mounts[target]
        return 0, self.attached[target]

    def _docker_cleanup(self, argv, timeout=60):
        return self._docker(argv)

    def broker_queue(self, name):
        return dict(self.queues[name])

    def wait_for_postgres(self):
        if not self.postgres_up:
            raise stack.HarnessError("postgres is still down")

    # -- what the public API answers ---------------------------------------
    def http_call(self, path, **options):
        method, body = options.get("method", "GET"), options.get("body")
        if path == "/v1/jobs" and method == "POST":
            job_id = CONTROL if not self.rows else JOB
            self.rows[job_id] = {"id": job_id, "state": "queued", "attempts": 0, "requested_at": REQUESTED_AT}
            self.queues[recovery.RISK_QUEUE]["messages"] += 1
            self.audit.append({"action": "job.requested", "job_id": job_id})
            accepted = dict(self.rows[job_id])
            self.deliver(job_id)
            return 202, accepted
        if path.startswith("/v1/jobs/") and path.endswith("/replay"):
            job_id = path.split("/")[3]
            row = self.rows[job_id]
            if body is not None and body.get("confirm") != recovery.REPLAY_CONFIRMATION:
                return 400, {"code": "invalid_replay_request"}
            if row["state"] == "published":
                return 409, {"code": "job_not_replayable"}
            if row["state"] == "queued" and body is None:
                return 409, {"code": "replay_confirmation_required"}
            row.update(state=self.replayed_state, attempts=0)
            self.audit.append({"action": "job.requested", "job_id": job_id})
            replayed = dict(row)
            self.deliver(job_id)
            return 202, replayed
        if path.startswith("/v1/jobs/"):
            return 200, dict(self.rows[path.split("/")[3]])
        if path.startswith("/v1/risk/history"):
            return 200, list(self.history)
        if path == "/v1/audit":
            return 200, self.audit + [{"action": action, "job_id": JOB} for action in self.extra_audit]
        raise AssertionError(f"the fake stack was asked for an unknown path: {path}")

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
        harness.roles.pop("id-risk")
        with self.assertRaises(stack.HarnessError) as caught:
            harness.fault_target("risk")
        self.assertIn("does not report", str(caught.exception))


class OwnershipAttestationTest(unittest.TestCase):
    """Every recorded container must be labelled, bind-mounted and network-scoped."""

    def test_an_owned_stack_passes(self):
        harness = FakeStack()
        quiet(harness.attest_ownership)
        self.assertEqual(len(harness.created), len(ROLES))

    def test_a_managed_mount_is_refused(self):
        harness = FakeStack(mounted="bind;volume;")
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


class HostPortAttestationTest(unittest.TestCase):
    """Egress closed must still leave the loopback port the witness drives."""

    def test_an_unreachable_published_port_is_refused(self):
        harness = FakeStack()
        harness.management_port = closed_loopback_port()
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(stack.HarnessError) as caught:
            harness.attest_host_ports()
        self.assertIn("does not route published ports", str(caught.exception))

    def test_a_reachable_published_port_is_attested(self):
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        harness = FakeStack()
        harness.management_port = int(listener.getsockname()[1])
        try:
            quiet(harness.attest_host_ports)
        finally:
            listener.close()


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
