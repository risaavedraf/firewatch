#!/usr/bin/env python3
"""Verify the BH-07 job recovery witness in a disposable Docker stack.

BH-07's acceptance asks for the one thing its database-side tests cannot show: a
PostgreSQL interruption *during* a valid delivery, the delivery settled against
the failed dependency, the database restored, the consumers restarted, and the
recoverable job completed afterwards without a duplicated effect.

This harness reuses ``verify_synthetic.py``'s stack - the uniquely named
PostgreSQL/PostGIS, RabbitMQ, Keycloak, jobs, risk and gateway containers, the
random loopback ports, the credentials generated in memory - and runs the
witness on top of it:

1. a control job, so "the stack works" and "the outage changed something" are
   two observations instead of one guess;
2. the interruption: the risk consumer is frozen, a job is created and the
   broker is watched until it holds a request, PostgreSQL is stopped, and the
   consumer is released against the failed dependency. It is frozen rather than
   stopped because this service verifies its classifier against the registry on
   the way up, so a restarted consumer would need the very dependency the
   scenario removes - the interruption would prove nothing about consumption;
3. the settlement: the work queue must drain and the dead-letter queue must hold
   exactly one message. Those are the broker's own totals for the two queues,
   and a total does not identify *which* delivery it counts. The delivery is
   settled by the broker's bounded delivery limit, not by the consumer's in-line
   budget, because the relay's own failure tears the session down first - the
   property BH-07 states when it says the 15-second budget cannot outlast a real
   database outage;
4. the honest negative: with PostgreSQL restored and both consumers restarted,
   the job is still ``queued`` with ``attempts`` 0 and no failure fields. The
   write that would have recorded a terminal state was served by the dependency
   that failed, so no evidence is invented;
5. the operator recovery: replay without the confirmation is refused with
   ``409 replay_confirmation_required``, a malformed body is ``400
   invalid_replay_request``, and both leave the row untouched;
6. the outcome: the confirmed replay returns the job to ``queued`` with
   ``requested_at`` unchanged, the job reaches ``published``, its zone history
   holds exactly one batch, a second replay is ``409 job_not_replayable`` with
   the batch count unchanged, and the job's audit actions are exactly one
   ``batch.published`` and two ``job.requested`` - compared as sorted counts,
   not as an order.

**Isolation is enforced, not claimed.** This harness creates its runtime network
with egress closed (``--internal``) and then *attests* it from the daemon before
any fault is injected; image builds and pulls are host egress and are outside
that network. Every fault action addresses a container **id this run recorded**
from its own create, and the id's ownership label is re-read from the daemon
immediately before acting, so an id that cannot be confirmed fails closed
without a fault. Every recorded container must also carry this run's label, use
bind mounts only (an anonymous or named volume could outlive the run) and sit
only on this run's network. Teardown is proven by id and by label instead of a
name shape, and a surviving resource is reported as a failure. What that cannot
prove is stated where it is proved: the label inventory is necessary but not
sufficient for an *unlabelled* resource, and no harness can show that something
outside its own creation did not change elsewhere on the host.

It proves the recoverable-job half of BH-07's verification sentence. It does
**not** prove that a permanent failure reaches ``failed`` with its reason and
attempt count, nor the duplicate-effect re-emit branch, nor the literal five
attempts of the in-line retry schedule. Those stay covered by the unit and
database-side evidence and remain unproven end to end. Nothing here closes
BH-07.

It reads no ``backend/.env``, changes no pre-existing container, and removes
only the resources it created.

Exit codes: ``0`` every check held, ``1`` a check failed or the harness could not
run, ``130`` interrupted.

Run ``python backend/scripts/verify_job_recovery.py --help`` for the options.
"""
from __future__ import annotations

import argparse
import base64
import http.client
import json
import socket
import sys
import time
import urllib.parse
import uuid
from pathlib import Path

# The shared disposable-stack helper lives beside this file, so the harness runs
# from the repository without an install step and reuses its lifecycle instead
# of a second, drifting copy of it.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import verify_synthetic as stack  # noqa: E402 - the shared stack helper

PROG = "verify_job_recovery.py"

# The labels the shared helper stamps on every resource it creates; they are the
# identity that authorises an action, never a generated name.
VERIFY_LABEL = "firewatch.verify"
RUN_LABEL = "firewatch.verify.run"

# The queue this witness reads is the one the risk consumer is bound to.
RISK_QUEUE = "risk.jobs.v1"
RISK_DEAD_QUEUE = "risk.jobs.v1.dead"
VHOST = "firewatch"

# The only confirmation value a queued replay accepts, pinned against the contract.
REPLAY_CONFIRMATION = "queued_may_be_in_flight"

EXIT_OK = 0
EXIT_FAILED = 1


class Harness(stack.Harness):
    """The disposable stack plus BH-07's outage and recovery witness."""

    def __init__(self, args):
        super().__init__(args)
        # The id the daemon returned for each container this run created, keyed by
        # the name this run chose. A fault addresses the id, never the name.
        self.created: dict[str, str] = {}

    # -- adapters: the only seams the witness reaches through --------------
    def http_call(self, path, **options):
        """One public HTTP call against this run's gateway."""
        return stack.http_call(self.gateway_base(), path, **options)

    def docker_ok(self, argv, timeout=240):
        """Run one docker command and raise with its output when it fails."""
        code, output = self._docker(argv, timeout=timeout)
        if code != 0:
            raise stack.HarnessError(f"docker {argv[0]} failed (exit {code}): {output.strip()[-500:]}")
        return output

    def inspect(self, container_id, template, what):
        """Read one field from the daemon, refusing when it no longer reports the id."""
        code, output = self._docker(["inspect", "-f", template, container_id], timeout=60)
        if code != 0:
            raise stack.HarnessError(f"refusing to act on {what}: the daemon does not report {container_id}")
        return output.strip()

    def broker_queue(self, name):
        """Return the broker's own counters for one queue of this run's broker."""
        url = f"http://127.0.0.1:{self.management_port}/api/queues/{VHOST}/{urllib.parse.quote(name)}"
        user = f"firewatch:{self.secrets['RABBITMQ_PASSWORD']}"
        headers = {"Authorization": "Basic " + base64.b64encode(user.encode()).decode()}
        try:
            status, raw = stack._http_exchange(url, headers=headers, timeout=10)
        except (OSError, http.client.HTTPException) as error:
            raise stack.HarnessError(f"the broker's management API is unreachable ({type(error).__name__})") from None
        counters = stack._decode(raw) if status == 200 else None
        if not isinstance(counters, dict) or not isinstance(counters.get("messages"), int):
            raise stack.HarnessError(f"the broker did not report a message count for {name} (HTTP {status})")
        return counters

    # -- isolation and ownership, enforced before a fault ------------------
    def _start_container(self, name, image, **options):
        """Record the id this run's own create returned, and keep the base bookkeeping."""
        container_id = super()._start_container(name, image, **options)
        self.created[name] = container_id
        return container_id

    def start_infrastructure(self):
        """Start the database and broker, then prove the loopback port reaches them."""
        super().start_infrastructure()
        self.attest_host_ports()

    def attest_host_ports(self, budget=60):
        """Require a published loopback port to actually reach the internal network.

        Closing egress is not free: on this daemon an ``--internal`` network also
        stops routing a published port into it, and the host is how this witness
        drives the whole scenario. Probing here refuses in seconds with the reason
        instead of failing a readiness wait much later.
        """
        deadline = time.monotonic() + min(budget, self.args.ready_timeout, max(1.0, self._remaining()))
        last = "no attempt"
        while time.monotonic() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", self.management_port), timeout=2):
                    print("PASS: a published loopback port reaches the internal runtime network")
                    return
            except OSError as error:
                last = type(error).__name__
                time.sleep(self.args.poll_interval)
        raise stack.HarnessError(
            f"refusing to run: the runtime network is internal and 127.0.0.1:{self.management_port} never "
            f"accepted a connection ({last}); this daemon does not route published ports into an internal "
            "network, so the host cannot drive this witness"
        )

    def create_network(self):
        """Create this run's network with egress closed, then attest it."""
        code, output = self._docker([
            "network", "create", "--internal",
            "--label", VERIFY_LABEL, "--label", f"{RUN_LABEL}={self.run_id}",
            self.network,
        ])
        if code != 0:
            raise stack.HarnessError(f"failed to create the internal network: {output.strip()[-500:]}")
        # Ownership begins with a successful create, never with a generated name.
        self.owned_network = self.network
        self.attest_runtime_isolation()

    def attest_runtime_isolation(self):
        """Require the runtime network to be internal before any fault is injected."""
        if not self.owned_network:
            raise stack.HarnessError("refusing to run: this run owns no network it could attest")
        code, output = self._docker(["network", "inspect", "-f", "{{.Internal}}", self.owned_network], timeout=60)
        if code != 0 or output.strip() != "true":
            raise stack.HarnessError(
                f"refusing to run: the runtime network {self.owned_network} is not internal "
                f"({output.strip() or f'exit {code}'})"
            )
        print("PASS: the runtime network is internal; image builds and pulls use the host's Docker egress, outside it")

    def attest_ownership(self):
        """Prove every recorded container is labelled, bind-mounted and network-scoped."""
        if not self.created:
            raise stack.HarnessError("refusing to run: this run recorded no container of its own")
        for name, container_id in self.created.items():
            try:
                labels = json.loads(self.inspect(container_id, "{{json .Config.Labels}}", name))
            except ValueError:
                labels = None
            if not isinstance(labels, dict) or labels.get(VERIFY_LABEL) != "1" or labels.get(RUN_LABEL) != self.run_id:
                raise stack.HarnessError(f"refusing to act on {name} ({container_id}): its ownership label is not this run's")
            mounts = self.inspect(container_id, "{{range .Mounts}}{{.Type}};{{end}}", name)
            if set(filter(None, mounts.split(";"))) - {"bind"}:
                raise stack.HarnessError(
                    f"refusing to act on {name}: it carries a managed mount ({mounts}) that could outlive the run"
                )
            attached = set(filter(None, self.inspect(
                container_id, "{{range $k, $v := .NetworkSettings.Networks}}{{$k}};{{end}}", name
            ).split(";")))
            if attached != {self.network}:
                raise stack.HarnessError(f"refusing to act on {name}: it is attached to {sorted(attached)}, not only {self.network}")
        print(f"PASS: {len(self.created)} recorded containers carry this run's label, bind mounts only, on {self.network}")

    def fault_target(self, role):
        """Return the recorded id for a role after re-confirming it is this run's."""
        name = f"{self.prefix}-{role}"
        container_id = self.created.get(name)
        if not container_id:
            raise stack.HarnessError(f"refusing to act on {role}: this run recorded no container id for it")
        try:
            labels = json.loads(self.inspect(container_id, "{{json .Config.Labels}}", role))
        except ValueError:
            labels = None
        if not isinstance(labels, dict) or labels.get(VERIFY_LABEL) != "1" or labels.get(RUN_LABEL) != self.run_id:
            raise stack.HarnessError(f"refusing to act on {role} ({container_id}): its ownership label could not be confirmed")
        return container_id

    def assert_torn_down(self):
        """Prove this run's resources are gone, by id and by label, not by name shape."""
        problems = []
        for name, container_id in self.created.items():
            code, _ = self._docker_cleanup(["container", "inspect", container_id])
            if code == 0:
                problems.append(f"container {container_id} ({name}) still exists")
        if self.owned_network:
            code, _ = self._docker_cleanup(["network", "inspect", self.owned_network])
            if code == 0:
                problems.append(f"network {self.owned_network} still exists")
        # A labelled inventory is necessary but not sufficient: an anonymous volume
        # inherits no label, which is why the containers above are required to use
        # bind mounts only - a managed volume is refused before any fault runs.
        for kind, argv in (("container", ["ps", "-a"]), ("network", ["network", "ls"]),
                           ("volume", ["volume", "ls"]), ("image", ["images"])):
            code, output = self._docker_cleanup([*argv, "--filter", f"label={RUN_LABEL}={self.run_id}", "-q"])
            if code != 0:
                problems.append(f"cannot list {kind}s by label (exit {code})")
            elif output.strip():
                problems.append(f"{kind}s still carry this run's label: {output.strip()[:200]}")
        if not problems:
            print("PASS: every recorded container id, the network, and every resource carrying this run's label is gone")
        return problems

    def cleanup(self):
        """Remove only owned resources, then prove they are gone."""
        failures = super().cleanup()
        if self.args.keep:
            return failures
        return failures + self.assert_torn_down()

    # -- observations ------------------------------------------------------
    def create_job(self, token):
        """Create one synthetic job and return the row the service answered with."""
        status, body = self.http_call(
            "/v1/jobs", method="POST", token=token,
            body={"zone_id": self.args.zone}, idem_key=str(uuid.uuid4()),
        )
        self._expect(
            status == 202 and isinstance(body, dict) and body.get("id"),
            f"creating a job answered HTTP {status} instead of 202 with a job",
        )
        return body

    def job_row(self, token, job_id):
        """Read one job through the public API."""
        status, body = self.http_call(f"/v1/jobs/{job_id}", token=token)
        self._expect(status == 200 and isinstance(body, dict), f"reading job {job_id} answered HTTP {status}")
        return body

    def wait_for_state(self, token, job_id, state):
        """Poll the job until it reports ``state``, or fail inside the budget."""
        observed = []

        def seen():
            row = self.job_row(token, job_id)
            observed.append(row)
            return row.get("state") == state

        self._wait_for(seen, f"job {job_id} to be {state}")
        return observed[-1]

    def batches(self, token, job_id):
        """Return the batches this zone's history attributes to one job."""
        zone = urllib.parse.quote(self.args.zone)
        status, history = self.http_call(f"/v1/risk/history?zone_id={zone}", token=token)
        self._expect(status == 200 and isinstance(history, list), f"reading the zone history answered HTTP {status}")
        return [batch for batch in history if batch.get("job_id") == job_id]

    def audit_actions(self, token, job_id):
        """Return this job's audit actions, sorted, as the public log reports them."""
        status, audit = self.http_call("/v1/audit", token=token)
        self._expect(status == 200 and isinstance(audit, list), f"reading the audit log answered HTTP {status}")
        return sorted(entry.get("action") for entry in audit if entry.get("job_id") == job_id)

    def wait_for_queue(self, name, predicate, description):
        """Poll the broker's counters until ``predicate`` holds."""
        observed = []

        def seen():
            counters = self.broker_queue(name)
            observed.append(counters)
            return predicate(counters)

        self._wait_for(seen, description)
        return observed[-1]

    def replay(self, token, job_id, body=None):
        """Ask the operator endpoint to re-dispatch one job."""
        status, payload = self.http_call(f"/v1/jobs/{job_id}/replay", method="POST", token=token, body=body)
        return status, payload if isinstance(payload, dict) else {}

    # -- the witness -------------------------------------------------------
    def verify(self, admin, viewer):
        """The whole witness, raising on the first observation that disagrees."""
        self.attest_runtime_isolation()
        self.attest_ownership()
        self.control(admin, viewer)
        job_id = self.interrupt(admin)
        self.restore(admin, job_id)
        self.replay_witness(admin, viewer, job_id)
        print("PASS: BH-07 recovery witness completed")
        print("NOTE: the recoverable-job half only; a permanent failure reaching 'failed' is not demonstrated.")

    def control(self, admin, viewer):
        """A job that completes normally: the baseline the outage is read against."""
        accepted = self.create_job(admin)
        self._expect(accepted.get("state") == "queued", f"a new job is not queued: {accepted.get('state')!r}")
        self._expect(accepted.get("attempts") == 0, "a new job did not start with attempts 0")
        completed = self.wait_for_state(admin, accepted["id"], "published")
        self._expect(completed.get("attempts") == 0, "the healthy job persisted a non-zero attempt count")
        self._expect("failure_reason" not in completed, "the healthy job carries a failure reason")
        batches = self.batches(viewer, accepted["id"])
        self._expect(len(batches) == 1, f"the healthy job produced {len(batches)} batches instead of one")
        self._expect(
            completed.get("batch_id") == batches[0].get("id"),
            "the healthy job does not name the batch its history holds",
        )
        print("PASS: a job triggered normally is published once, with attempts 0 and no failure state")

    def interrupt(self, admin):
        """Consume a valid request with PostgreSQL gone, and watch it settle."""
        risk = self.fault_target("risk")
        # Frozen, not stopped: this service verifies its classifier against the
        # registry on startup, which the outage makes impossible, so a restarted
        # consumer could never consume. Freezing keeps the channel open and the
        # delivery it is handed unacknowledged while the database goes away.
        self.docker_ok(["pause", risk])
        job_id = self.create_job(admin)["id"]
        # The broker's total is the observation: at least one message is on the
        # work queue while the consumer cannot settle it. A total does not name
        # the delivery, so that is all this check claims.
        queued = self.wait_for_queue(
            RISK_QUEUE, lambda q: q["messages"] >= 1, f"the accepted request to reach {RISK_QUEUE}"
        )
        print(f"in flight: {RISK_QUEUE} reports {queued['messages']} message(s) in total while its consumer is frozen")
        self.docker_ok(["stop", self.fault_target("postgres")], timeout=180)
        print("interrupted: PostgreSQL is stopped while the request is in flight")
        self.docker_ok(["unpause", risk])
        self.wait_for_queue(RISK_DEAD_QUEUE, lambda q: q["messages"] >= 1, f"the delivery to settle into {RISK_DEAD_QUEUE}")
        self.wait_for_queue(RISK_QUEUE, lambda q: q["messages"] == 0, f"{RISK_QUEUE} to drain")
        settled, live = self.broker_queue(RISK_DEAD_QUEUE), self.broker_queue(RISK_QUEUE)
        self._expect(
            settled["messages"] == 1,
            f"the dead-letter queue reports {settled['messages']} message(s) in total instead of exactly one",
        )
        self._expect(live["messages"] == 0, f"{RISK_QUEUE} still reports {live['messages']} message(s) after the settlement")
        print("PASS: the work queue drained and the dead-letter queue holds exactly one message (queues' totals)")
        return job_id

    def restore(self, admin, job_id):
        """Restore the dependency, restart both consumers, read the row honestly."""
        self.docker_ok(["start", self.fault_target("postgres")], timeout=180)
        self.wait_for_postgres()
        print("restored: PostgreSQL answers over TCP again")
        self.docker_ok(["restart", self.fault_target("jobs"), self.fault_target("risk")], timeout=240)
        row = self.wait_for_state(admin, job_id, "queued")
        self._expect(
            row.get("attempts") == 0,
            f"the interrupted job persisted attempts {row.get('attempts')}: the write that would "
            "record them was served by the dependency that failed",
        )
        self._expect(
            "failure_reason" not in row and "failed_at" not in row,
            "a terminal failure was recorded for a delivery whose terminal write could not reach the database",
        )
        print("PASS: after restore and consumer restart the interrupted job is still queued, attempts 0, no failure fields")

    def replay_witness(self, admin, viewer, job_id):
        """The operator recovery: gate, one completion, and a refused second replay."""
        status, body = self.replay(admin, job_id)
        self._expect(
            status == 409 and body.get("code") == "replay_confirmation_required",
            f"an unconfirmed replay of a queued job answered HTTP {status} instead of 409 replay_confirmation_required",
        )
        status, body = self.replay(admin, job_id, {"confirm": "yes"})
        self._expect(
            status == 400 and body.get("code") == "invalid_replay_request",
            f"a malformed replay body answered HTTP {status} instead of 400 invalid_replay_request",
        )
        refused = self.job_row(admin, job_id)
        self._expect(
            refused.get("state") == "queued" and refused.get("attempts") == 0,
            "a refused replay changed the job row",
        )
        print("PASS: the unconfirmed and the malformed replay are refused and leave the row untouched")

        status, replayed = self.replay(admin, job_id, {"confirm": REPLAY_CONFIRMATION})
        self._expect(status == 202, f"the confirmed replay answered HTTP {status} instead of 202")
        self._expect(
            replayed.get("state") == "queued" and replayed.get("attempts") == 0,
            "the confirmed replay did not return the job to queued with attempts 0",
        )
        self._expect(
            replayed.get("requested_at") == refused.get("requested_at"),
            "the replay moved requested_at, which the policy deliberately leaves alone",
        )
        completed = self.wait_for_state(admin, job_id, "published")
        batches = self.batches(viewer, job_id)
        self._expect(len(batches) == 1, f"the recovered job produced {len(batches)} batches instead of one")
        self._expect(
            completed.get("batch_id") == batches[0].get("id"),
            "the recovered job does not name the batch its history holds",
        )

        status, body = self.replay(admin, job_id, {"confirm": REPLAY_CONFIRMATION})
        self._expect(
            status == 409 and body.get("code") == "job_not_replayable",
            f"replaying a published job answered HTTP {status} instead of 409 job_not_replayable",
        )
        self._expect(len(self.batches(viewer, job_id)) == 1, "replaying a published job added a second batch")
        actions = self.audit_actions(admin, job_id)
        self._expect(
            actions == ["batch.published", "job.requested", "job.requested"],
            f"unexpected audit actions for the recovered job (sorted counts, not order): {actions!r}",
        )
        print("PASS: published once, a second replay refused, and the audit holds one completion and two requests")


def parse_args(argv=None):
    """Parse this harness's arguments; the shared helper reads the first four."""
    parser = argparse.ArgumentParser(
        prog=PROG,
        description=(
            "Verify the BH-07 job recovery witness in a disposable Docker stack: interrupt PostgreSQL "
            "during a valid delivery, restore it, restart the consumers, and check that the recoverable "
            "job completes exactly once through the confirmed operator replay."
        ),
    )
    parser.add_argument(
        "--timeout", type=stack._positive_seconds, default=stack.DEFAULT_TIMEOUT, metavar="SECONDS",
        help=f"overall deadline for the whole run (default: {stack.DEFAULT_TIMEOUT})",
    )
    parser.add_argument(
        "--ready-timeout", type=stack._positive_seconds, default=stack.DEFAULT_READY_TIMEOUT, metavar="SECONDS",
        help=f"deadline for each bounded wait, including the interrupted delivery settling (default: {stack.DEFAULT_READY_TIMEOUT})",
    )
    parser.add_argument(
        "--poll-interval", type=stack._positive_seconds, default=stack.DEFAULT_POLL_INTERVAL, metavar="SECONDS",
        help=f"seconds between polls (default: {stack.DEFAULT_POLL_INTERVAL})",
    )
    parser.add_argument(
        "--zone", default=stack.DEFAULT_ZONE, metavar="ZONE",
        help=f"catalogue zone the witness uses (default: {stack.DEFAULT_ZONE})",
    )
    parser.add_argument(
        "--keep", action="store_true",
        help="leave the created containers, network and images in place for inspection instead of proving teardown",
    )
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    harness = Harness(args)
    try:
        harness.run()
    except stack.HarnessError as error:
        print("FAIL: " + harness._redact(str(error)), file=sys.stderr)
        return EXIT_FAILED
    except KeyboardInterrupt:
        print("FAIL: interrupted", file=sys.stderr)
        return 130
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
