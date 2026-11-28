#!/usr/bin/env python3
"""Verify the BH-07 job recovery witness in a disposable Docker stack.

BH-07's acceptance asks for the things its database-side tests cannot show: a
PostgreSQL interruption *during* a valid delivery, the delivery settled against
the failed dependency, the database restored, the consumers restarted, and the
recoverable job completed afterwards without a duplicated effect - plus the two
halves the earlier functional runs left unproven, a **permanent** failure
reaching ``failed`` on its first attempt and **retry exhaustion** recorded as a
durable attempt count.

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
3. the settlement: the work queue must drain and the dead-letter queue must grow
   by exactly one message. Those are the broker's own counters, and a counter
   does not identify *which* delivery it counts. The delivery is settled by the
   broker's bounded delivery limit, not by the consumer's in-line budget,
   because the relay's own failure tears the session down first - the property
   BH-07 states when it says the 15-second budget cannot outlast a real database
   outage;
4. the honest negative: with PostgreSQL restored and both consumers restarted,
   the job is still ``queued`` with ``attempts`` 0 and no failure fields. The
   write that would have recorded a terminal state was served by the dependency
   that failed, so no evidence is invented;
5. the operator recovery: replay without the confirmation is refused with ``409
   replay_confirmation_required``, a malformed body is ``400
   invalid_replay_request``, and both leave the row untouched;
6. the outcome: the confirmed replay returns the job to ``queued`` with
   ``requested_at`` unchanged, the job reaches ``published``, its zone history
   holds exactly one batch, a second replay is ``409 job_not_replayable`` with
   the batch count unchanged, and the job's audit actions are exactly one
   ``batch.published`` and two ``job.requested`` - compared as sorted counts,
   not as an order;
7. the **permanent** failure: one comuna reference is removed from the *risk*
   copy of the catalogue inside this run's own container, and a job is created
   for it. ``risk`` classifies the resulting foreign-key refusal as permanent,
   reports it through its outbox, and ``jobs`` writes ``failed`` with
   ``failure_reason='permanent_error'`` and ``attempts=1`` - a permanent error
   skips every retry, which is asserted rather than assumed;
8. the **retry exhaustion**: a job asking for the ``partial-retrieval`` profile
   can never complete, so the consumer spends its whole budget and ``jobs``
   records ``failed`` with ``failure_reason='retries_exhausted'`` and the
   durable ``attempts=5``. That is the five-attempt policy observed end to end
   instead of only in unit tests.

**Isolation is enforced, not claimed - including the way it is measured.** This
harness creates its runtime network with egress closed (``--internal``) and then
*attests* it from the daemon before any fault is injected. Image builds and
pulls are host egress and are outside that network.

The witness does **not** run from the host. This daemon does not route a
published loopback port into an internal network, so an earlier version of this
harness could not execute its own scenario: readiness waited on
``127.0.0.1:<port>`` forever and the run failed without a witness. Every HTTP and
AMQP-management observation now executes **inside** the run's own network,
through one helper container attached only to it:

* the helper is created ``--entrypoint sleep`` from the curl image this stack
  already requires, recorded by container id, labelled with this run's
  ``firewatch.verify.run`` label, and every probe is a ``docker exec`` into that
  id - so teardown, ownership and the label inventory cover it like any other
  container of the run;
* a URL that names ``127.0.0.1`` or ``localhost`` is refused before a probe is
  spawned, so the harness cannot silently fall back to host routing;
* a second attestation probes external targets from inside the helper and
  **fails the run if they are reachable**, so "no internet egress" is a
  measurement of this network rather than a claim about the ``--internal`` flag;
* because this host's daemon exhausts its predefined address pool, the network is
  created with an explicit subnet from a fixed candidate list as a documented
  fallback. A candidate the daemon refuses is skipped, no ownership is claimed
  until a create succeeds, and the network is attested ``--internal`` in either
  path.

Every fault action addresses a container **id this run recorded** from its own
create, and the id's ownership label is re-read from the daemon immediately
before acting, so an id that cannot be confirmed fails closed without a fault.
Every recorded container must also carry this run's label, stay off shared
storage and sit only on this run's network. Shared storage means: bind mounts,
plus the **anonymous** volume an image declares for itself - ``postgis`` declares
``VOLUME /var/lib/postgresql/data``, which ``docker rm`` leaves behind unless it
is named and removed, so this harness records those names before the containers
go and proves them gone. A **named** volume is refused before any fault, because
a name is shared state that may predate the run and could outlive it.
Teardown is proven by id, by volume name and by label instead of a name shape,
and a surviving resource is reported as a failure. What that cannot prove is
stated where it is proved: the label inventory is necessary but not sufficient
for an *unlabelled* resource, and no harness can show that something outside its
own creation did not change elsewhere on the host.

It does **not** prove the duplicate-effect re-emit branch - an assessment already
stored whose completion was lost - because nothing here can hold that write back
without also stopping the service the witness drives from. That branch stays
covered by the repository tests and remains unproven end to end. Nothing here
closes BH-07; it records what was observed.

It reads no ``backend/.env``, changes no pre-existing container, and removes
only the resources it created. The one destructive act is inside this run's own
disposable PostgreSQL container: a single comuna row is deleted from the *risk*
copy of the catalogue so a reference failure is real rather than simulated. The
container is destroyed with the rest of the stack.

Exit codes: ``0`` every check held, ``1`` a check failed or the harness could not
run, ``130`` interrupted.

Run ``python backend/scripts/verify_job_recovery.py --help`` for the options.
"""
from __future__ import annotations

import argparse
import base64
import json
import re
import sys
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

# -- the in-network witness ------------------------------------------------
# Services are addressed by the network aliases the shared helper gives their
# containers, from inside the network. A host port is never a route here: this
# daemon does not forward a published loopback port into an internal network.
GATEWAY_ALIAS = "gateway"
IDENTITY_ALIAS = "identity"
BROKER_ALIAS = "rabbitmq"
GATEWAY_IN_NETWORK_PORT = 8080
IDENTITY_IN_NETWORK_PORT = 8080
BROKER_MANAGEMENT_IN_NETWORK_PORT = 15672

# Host names that would silently reintroduce the routing dependency this harness
# removed. A probe naming any of them is refused before it is spawned.
PUBLISHED_HOSTS = ("127.0.0.1", "localhost", "::1")

# The helper container runs from the curl image the stack already requires, so a
# witness run pulls nothing new. ``sleep`` keeps it alive between probes.
WITNESS_ROLE = "witness"
WITNESS_IMAGE = stack.TOPOLOGY_IMAGE
WITNESS_COMMAND = ("sleep", "86400")

# curl appends the status after the body, so one exec returns both without the
# harness having to read a file out of the container.
STATUS_SUFFIX = "\n%{http_code}"

# How one container's mounts are read: type, volume name and destination. The
# destination is what makes "an image declared this VOLUME" decidable; the name
# alone says nothing about who owns it.
MOUNT_TEMPLATE = "{{range .Mounts}}{{.Type}}={{.Name}}@{{.Destination}};{{end}}"
# Anonymous volumes are named with the container's own 64-hex id by the daemon.
ANONYMOUS_VOLUME = re.compile(r"^[0-9a-f]{64}$")
# The mount points the stack's images declare as VOLUME. A volume anywhere else
# is not the image's own storage and is refused before a fault runs.
DECLARED_VOLUME_DESTINATIONS = ("/var/lib/postgresql/data", "/var/lib/rabbitmq")

# curl's exit codes for "the transport or the resolver failed": 6 cannot
# resolve, 7 cannot connect, 28 timed out. Those prove a closed network. Any
# other nonzero code means the probe itself did not run, which proves nothing.
EGRESS_UNREACHABLE_CODES = (6, 7, 28)
# docker's codes for "the command could not be executed at all".
DAEMON_FAILURE_CODES = (125, 126, 127)
# The resource kinds the daemon states non-existence about. The kind is a whole
# token in every accepted statement; ``volume-driver`` is not ``volume``.
ABSENT_KINDS = ("container", "network", "volume", "object")
# What the daemon says when an id genuinely does not exist, and the only shapes
# accepted. A non-zero exit alone is not absence: a dead daemon also exits
# non-zero. Each shape must match a **whole trimmed stderr line**, so nothing can
# precede the statement and nothing can trail after the kind, the identifier or
# ``not found``: ``network driver not found for <id>``, ``lookup <id>: no such
# volume-driver`` and ``network <id> not found in driver cache`` all quote the kind
# and the id without ever being the daemon's statement that our resource is gone.
# The three statements, with the only decoration Docker adds - an optional
# ``Error:``/``Error response from daemon:`` prefix:
#   1) ``No such <kind>: <id>``
#   2) ``<kind> <id> not found``
#   3) ``get <id>: no such <kind>``   (how a removed volume surfaces)
# Shapes 1 and 3 end on the kind or the identifier, and a trailing period is
# refused there on purpose: ``.`` is a legal character in Docker names, so
# ``No such volume: fw-test.`` is a statement about ``fw-test.`` and not about
# ``fw-test``. Only shape 2 allows a trailing period, because it follows
# ``not found`` and can never belong to the name.
# ``{ref}`` is replaced by the inspected identifier, regex-escaped.
ABSENT_LINE_GRAMMAR = (
    r"(?:error(?: response from daemon)?:\s*)?no such (?:{kinds}):\s*{ref}",
    r"(?:error(?: response from daemon)?:\s*)?(?:{kinds})\s+{ref}\s+not found\.?",
    r"(?:error(?: response from daemon)?:\s*)?get\s+{ref}:\s*no such (?:{kinds})",
)

# Targets proven unreachable from inside the network before any fault is
# injected. An IP literal needs no resolver, a name exercises the resolver.
EGRESS_PROBES = ("https://1.1.1.1/", "http://example.com/")

# This daemon has exhausted its predefined address pools, so a plain
# ``network create`` is refused here. These candidates are tried in order and the
# first the daemon accepts wins; nothing claims ownership until one succeeds.
NETWORK_SUBNET_POOL = (
    "10.213.64.0/24",
    "10.213.65.0/24",
    "10.213.66.0/24",
    "10.213.67.0/24",
    "10.213.68.0/24",
    "10.213.69.0/24",
    "10.213.70.0/24",
    "10.213.71.0/24",
)
POOL_EXHAUSTED_MARKER = "all predefined address pools have been fully subnetted"

# -- the two unproven halves ----------------------------------------------
# A comuna whose reference is removed from the risk catalogue inside this run's
# container. It must differ from the zone the rest of the witness drives.
PERMANENT_FAILURE_ZONE = "05804"
# The catalogue code shape (a CUT_COM). The deletion below is parameterised in
# psql as well; this pattern is the second lock, so no caller can widen it into a
# statement of its own.
ZONE_CODE = re.compile(r"^[0-9]{5}$")
# The profile whose retrieval never completes, so the consumer spends its whole
# budget. The classification is transient by policy, so the give-up is
# ``retries_exhausted`` rather than ``permanent_error``.
RETRY_EXHAUSTION_SCENARIO = "partial-retrieval"
# The agreed retry budget: five attempts separated by 1, 2, 4 and 8 seconds.
EXPECTED_RETRY_ATTEMPTS = 5

EXIT_OK = 0
EXIT_FAILED = 1


class Harness(stack.Harness):
    """The disposable stack plus BH-07's outage and recovery witness."""

    def __init__(self, args):
        super().__init__(args)
        # The shared helper registers EVERY value of its secret map for redaction,
        # and one of them is the literal, public database username. Masking a public
        # username rewrites the mount destinations and container names this harness
        # parses - a live run refused its own postgres volume as
        # ``@/var/lib/<redacted>ql/data`` - so the username is dropped here and every
        # remaining entry is a generated credential. Redaction still applies to every
        # diagnostic this harness prints.
        username = self.secrets.get("POSTGRES_USER")
        if username:
            self.redactions = [value for value in self.redactions if value != username]
        # The id the daemon returned for each container this run created, keyed by
        # the name this run chose. A fault addresses the id, never the name.
        self.created: dict[str, str] = {}
        # The helper container every probe executes inside. None until created.
        self.witness_id: str | None = None
        # The id the daemon returned for this run's network. The name is never the
        # identity a removal is authorised by.
        self.network_id: str | None = None
        self.subnet: str | None = None
        # Short-lived containers the shared helper creates (migrations, broker
        # topology). They are not in ``created``, so their absence needs its own
        # registry or it is simply never proved.
        self.transient_containers: list[str] = []
        # Image-declared anonymous volumes this run's containers created. They are
        # removed by name after the containers go, because ``docker rm`` without
        # ``--volumes`` leaves them behind and no label inventory can see them.
        self.owned_volumes: list[str] = []
        # Volume ownership or readability failures found while collecting. They are
        # reported by the teardown proof instead of being skipped silently.
        self.volume_problems: list[str] = []

    # -- adapters: the only seams the witness reaches through --------------
    def http_call(self, path, **options):
        """One public HTTP call against this run's gateway, from inside the network."""
        return self.witness_http(self.gateway_url(path), **options)

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

    # -- the in-network witness -------------------------------------------
    def gateway_url(self, path) -> str:
        """Return the in-network URL of one gateway path."""
        return f"http://{GATEWAY_ALIAS}:{GATEWAY_IN_NETWORK_PORT}{path}"

    def identity_url(self, path) -> str:
        """Return the in-network URL of one identity path."""
        return f"http://{IDENTITY_ALIAS}:{IDENTITY_IN_NETWORK_PORT}{path}"

    def witness_container(self) -> str:
        """Return this run's recorded helper id, refusing when there is none."""
        if not self.witness_id:
            raise stack.HarnessError(
                "refusing to probe: this run recorded no helper container inside the runtime network"
            )
        return self.witness_id

    def require_witness_running(self) -> str:
        """Require the helper the probes run in to be running right now.

        A stopped container answers nothing, and "no answer" must never be read as
        "nothing was reachable". This is re-attested immediately before the egress
        measurement so the conclusion cannot come from a container that is not up.
        """
        container_id = self.witness_container()
        code, output = self._docker(["inspect", "-f", "{{.State.Running}}", container_id], timeout=60)
        if code != 0:
            detail = output.strip()[-200:] if output.strip() else f"exit {code}"
            raise stack.HarnessError(
                f"refusing to probe: the daemon does not report the witness {container_id} ({detail})"
            )
        if output.strip() != "true":
            raise stack.HarnessError(
                f"refusing to probe: the witness {container_id} is not running "
                f"({output.strip() or 'no state reported'}), so an empty answer would mean nothing"
            )
        return container_id

    def witness_exec(self, argv, timeout=stack.HTTP_TIMEOUT + 5):
        """Run one command inside this run's helper, addressed by its recorded id."""
        return self._docker(["exec", self.witness_container(), *argv], timeout=timeout)

    def _require_in_network(self, url: str) -> None:
        """Refuse a probe that would depend on host routing instead of the network."""
        host = urllib.parse.urlsplit(url).hostname
        if not host or host in PUBLISHED_HOSTS:
            raise stack.HarnessError(
                f"refusing to probe {url}: every witness probe must run inside the runtime network, "
                "and a published loopback port is not routed into an internal one"
            )

    def witness_http(self, url, *, method="GET", token=None, body=None, form=None,
                     idem_key=None, headers=None, timeout=stack.HTTP_TIMEOUT):
        """Perform one HTTP exchange from inside the runtime network.

        Returns ``(status, decoded_body_or_none)``. A transport failure raises, so
        a readiness probe can retry it through its own bounded loop. Credentials
        and tokens travel in the exec argv, the same way the shared helper already
        passes every generated database and broker password to ``docker run``;
        error messages never echo them and only the method and path are printed.
        """
        self._require_in_network(url)
        argv = ["curl", "-sS", "--max-time", str(timeout), "--request", method, "--write-out", STATUS_SUFFIX]
        for name, value in (headers or {}).items():
            argv += ["--header", f"{name}: {value}"]
        if token:
            argv += ["--header", "Authorization: Bearer " + token]
        if idem_key:
            argv += ["--header", "Idempotency-Key: " + idem_key]
        if form is not None:
            argv += [
                "--header", "Content-Type: application/x-www-form-urlencoded",
                "--data-raw", urllib.parse.urlencode(form),
            ]
        elif body is not None:
            argv += ["--header", "Content-Type: application/json", "--data-raw", json.dumps(body)]
        argv.append(url)
        code, output = self.witness_exec(argv, timeout=timeout + 5)
        if code != 0:
            path = urllib.parse.urlsplit(url).path or "/"
            detail = output.strip().splitlines()[-1][:200] if output.strip() else f"exit {code}"
            raise stack.HarnessError(f"{method} {path} could not reach the stack from inside the network ({detail})")
        payload, separator, status_text = output.rpartition("\n")
        try:
            # ``str.isdigit`` accepts digits ``int`` rejects, so the parse itself
            # decides; curl only ever emits ASCII here, but the guard is exact.
            status: int | None = int(status_text.strip()) if separator else None
        except ValueError:
            status = None
        if status is None:
            raise stack.HarnessError(f"{method} {url} returned no usable status from the helper container")
        return status, stack._decode(payload.encode("utf-8"))

    def broker_queue(self, name):
        """Return the broker's own counters for one queue, read inside the network."""
        url = (
            f"http://{BROKER_ALIAS}:{BROKER_MANAGEMENT_IN_NETWORK_PORT}"
            f"/api/queues/{VHOST}/{urllib.parse.quote(name)}"
        )
        user = f"firewatch:{self.secrets['RABBITMQ_PASSWORD']}"
        basic = base64.b64encode(user.encode()).decode()
        try:
            status, counters = self.witness_http(
                url, headers={"Authorization": "Basic " + basic}, timeout=10
            )
        except stack.HarnessError as error:
            raise stack.HarnessError(f"the broker's management API is unreachable ({error})") from None
        if not isinstance(counters, dict) or not isinstance(counters.get("messages"), int):
            raise stack.HarnessError(f"the broker did not report a message count for {name} (HTTP {status})")
        return counters

    # -- readiness, all of it from inside the network ----------------------
    def wait_for_keycloak(self):
        """Require the realm discovery document, read from inside the network."""
        url = self.identity_url(stack.KEYCLOAK_DISCOVERY_PATH)
        expected = stack.keycloak_issuer(self.identity_port)

        def ready():
            try:
                status, payload = self.witness_http(url, timeout=5)
            except stack.HarnessError:
                return False
            return status == 200 and isinstance(payload, dict) and payload.get("issuer") == expected

        self._wait_for(ready, f"Keycloak realm discovery at {url} from inside the runtime network")

    def wait_for_gateway(self):
        """Require the gateway readiness endpoint, read from inside the network."""
        url = self.gateway_url("/health/ready")

        def ready():
            try:
                status, _ = self.witness_http(url, timeout=5)
            except stack.HarnessError:
                return False
            return status == 204

        self._wait_for(ready, f"gateway health endpoint at {url} from inside the runtime network")

    def fetch_token(self, user, password) -> str:
        """Fetch one access token from inside the network. Never printed or logged."""
        status, payload = self.witness_http(
            self.identity_url(f"/realms/{stack.REALM}/protocol/openid-connect/token"),
            method="POST",
            form={
                "grant_type": "password",
                "client_id": stack.CLIENT_ID,
                "username": user,
                "password": password,
            },
        )
        if status != 200:
            raise stack.HarnessError(f"token request for {user} was rejected with HTTP {status}")
        if not isinstance(payload, dict) or not payload.get("access_token"):
            raise stack.HarnessError(f"the token response for {user} carried no access token")
        token = payload["access_token"]
        self.redactions.append(token)
        return token

    def wait_for_api(self, admin: str):
        self._wait_for(
            lambda: self.http_call("/v1/risk/synthetic-scenarios", token=admin)[0] == 200,
            "risk service through the gateway",
        )
        self._wait_for(
            lambda: self.http_call("/v1/audit", token=admin)[0] == 200,
            "jobs service through the gateway",
        )

    # -- isolation and ownership, enforced before a fault ------------------
    def _start_container(self, name, image, **options):
        """Record the id this run's own create returned, and keep the base bookkeeping."""
        container_id = super()._start_container(name, image, **options)
        self.created[name] = container_id
        return container_id

    def start_infrastructure(self):
        """Start the database and broker, then put the witness inside the network."""
        super().start_infrastructure()
        self.start_witness()
        self.attest_witness_scope()
        self.attest_egress_closed()

    def start_witness(self):
        """Create the helper container every probe executes inside."""
        name = f"{self.prefix}-{WITNESS_ROLE}"
        argv = [
            "run", "--detach", "--name", name,
            "--label", f"{VERIFY_LABEL}=1", "--label", f"{RUN_LABEL}={self.run_id}",
            "--network", self.network,
            "--entrypoint", WITNESS_COMMAND[0], WITNESS_IMAGE, *WITNESS_COMMAND[1:],
        ]
        code, output = self._docker(argv)
        if code != 0:
            raise stack.HarnessError(
                f"failed to start the in-network witness container: {output.strip()[-600:]}"
            )
        container_id = stack.Harness._extract_container_id(output, name)
        self.created[name] = container_id
        self.owned_container_ids.append(container_id)
        self.witness_id = container_id
        print(f"PASS: the HTTP and AMQP witness runs inside {name}, on {self.network} only")

    def attest_witness_scope(self):
        """Prove the helper is this run's, minimal, and attached only to this run's network."""
        if not self.witness_id:
            raise stack.HarnessError(
                "refusing to run: this run recorded no helper container inside the runtime network"
            )
        name = f"{self.prefix}-{WITNESS_ROLE}"
        self._require_owned(name, self.witness_id)
        print(
            f"PASS: the witness {self.witness_id[:12]} carries this run's label, safe mounts, "
            f"on {self.network} only"
        )

    def attest_egress_closed(self, budget=5):
        """Prove from inside that the runtime network has no external egress.

        Closed egress is a *reachability* observation, and only a transport or
        resolver failure is that observation: curl exits 6 (cannot resolve), 7
        (cannot connect) or 28 (timed out). Any other nonzero code - 125/126/127
        for a failed ``docker exec`` or a missing binary, or an unexpected curl
        failure - means the probe never ran, and a probe that never ran proves
        nothing about the network. Those fail the run loudly instead of being
        counted as a closed network. The helper's running state is re-attested
        first, so the answer cannot come from a stopped container.
        """
        self.require_witness_running()
        for target in EGRESS_PROBES:
            code, output = self.witness_exec(
                ["curl", "-sS", "--max-time", str(budget), "--output", "/dev/null", target],
                timeout=budget + 5,
            )
            if code in EGRESS_UNREACHABLE_CODES:
                continue
            if code == 0:
                raise stack.HarnessError(
                    f"refusing to run: the runtime network reached {target} from inside, "
                    "so external egress is not closed"
                )
            detail = output.strip().splitlines()[-1][:200] if output.strip() else "no output"
            raise stack.HarnessError(
                f"refusing to run: the egress probe to {target} could not run "
                f"(curl exit {code}, {detail}); a probe that did not execute is not evidence "
                "that egress is closed"
            )
        print("PASS: external egress is closed from inside the runtime network; the witness needs no host route")

    def create_network(self):
        """Create this run's network with egress closed, then attest it."""
        base = [
            "network", "create", "--internal",
            "--label", f"{VERIFY_LABEL}=1", "--label", f"{RUN_LABEL}={self.run_id}",
        ]
        code, output = self._docker([*base, self.network])
        if code != 0:
            if POOL_EXHAUSTED_MARKER not in output:
                raise stack.HarnessError(f"failed to create the internal network: {output.strip()[-500:]}")
            code, output = self._create_with_explicit_subnet(base)
        # Ownership begins with a successful create, and the identity that authorises
        # a removal is the ID the daemon returned - never the generated name, which a
        # concurrent run could in principle share.
        self.network_id = stack.Harness._extract_container_id(output, self.network)
        self.owned_network = self.network
        self.attest_runtime_isolation()

    def _create_with_explicit_subnet(self, base):
        """Retry the create with a subnet when the daemon's default pool is spent.

        Candidate subnets are tried in order and a refused one is skipped without
        claiming anything. A daemon that accepts none fails the run: the harness
        would rather refuse than run on an unknown, possibly shared network.
        """
        refused = []
        for subnet in NETWORK_SUBNET_POOL:
            code, output = self._docker([*base, "--subnet", subnet, self.network])
            if code == 0:
                self.subnet = subnet
                print(
                    f"NOTE: the daemon's predefined address pools are exhausted; "
                    f"{self.network} was created with the explicit subnet {subnet}"
                )
                return code, output
            refused.append(f"{subnet} ({output.strip().splitlines()[-1][:100] if output.strip() else 'refused'})")
        raise stack.HarnessError(
            "refusing to run: no internal network could be created - the daemon's predefined address "
            "pools are exhausted and no candidate subnet was accepted: " + "; ".join(refused)
        )

    def attest_runtime_isolation(self):
        """Require the network this run created to be internal and still its own."""
        if not self.owned_network or not self.network_id:
            raise stack.HarnessError("refusing to run: this run owns no network id it could attest")
        code, output = self._docker(["network", "inspect", "-f", "{{.Internal}}", self.network_id], timeout=60)
        if code != 0 or output.strip() != "true":
            raise stack.HarnessError(
                f"refusing to run: the runtime network {self.network_id} is not internal "
                f"({output.strip() or f'exit {code}'})"
            )
        self.require_network_owned()
        print("PASS: the runtime network is internal; image builds and pulls use the host's Docker egress, outside it")

    def require_network_owned(self) -> str:
        """Return the network id after re-reading this run's label from the daemon.

        A removal is authorised by an id whose ownership label was just read back,
        exactly like a fault action. A network whose label is not this run's is
        never removed, whatever its name says.
        """
        if not self.network_id:
            raise stack.HarnessError(
                "refusing to remove a network this run never created: no network id was recorded"
            )
        code, output = self._docker_cleanup(["network", "inspect", "-f", "{{json .Labels}}", self.network_id])
        if code != 0:
            detail = output.strip()[-200:] if output.strip() else f"exit {code}"
            raise stack.HarnessError(
                f"refusing to remove network {self.network_id}: the daemon does not report it ({detail})"
            )
        try:
            labels = json.loads(output)
        except ValueError:
            labels = None
        if not isinstance(labels, dict) or labels.get(VERIFY_LABEL) != "1" or labels.get(RUN_LABEL) != self.run_id:
            raise stack.HarnessError(
                f"refusing to remove network {self.network_id}: its ownership label is not this run's"
            )
        return self.network_id

    @staticmethod
    def _is_absent(output: str, identifier: str) -> bool:
        """Report whether the daemon says THIS identifier does not exist.

        Two conditions, both required: a **whole trimmed stderr line** is one of
        the daemon's absence statements (``ABSENT_LINE_GRAMMAR``), **and** that
        statement names the identifier that was inspected - either the id itself or
        its leading 12-hex prefix, the form Docker shortens ids to. Anchoring to the
        whole line is what keeps a sentence that merely quotes the kind and the id
        from proving anything: ``network driver not found for <id>``, ``lookup <id>:
        no such volume-driver`` and ``network <id> not found in driver cache`` are
        all rejected, as is a statement about another id with ours in prose. An id a
        longer id extends or ends with is likewise not ours, and a trailing period
        after the name is part of the name.
        """
        text = output.lower()
        ident = (identifier or "").strip().lower()
        if not ident:
            return False
        candidates = [ident]
        if re.fullmatch(r"[0-9a-f]{13,64}", ident):
            candidates.append(ident[:12])
        kinds = "|".join(ABSENT_KINDS)
        # Empty lines carry nothing, and the ``[]`` Docker prints before a daemon
        # error is not a statement; each remaining line must be the whole statement.
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        for candidate in candidates:
            ref = re.escape(candidate)
            for line in lines:
                for template in ABSENT_LINE_GRAMMAR:
                    if re.fullmatch(template.format(kinds=kinds, ref=ref), line):
                        return True
        return False

    @staticmethod
    def _labels_or_none(output: str) -> dict | None:
        """Parse a ``{{json .Labels}}`` answer; ``None`` means it could not be read.

        Valid JSON ``null`` means "no labels" and is not the same observation as
        an answer that is not JSON at all. Only the first is usable.
        """
        try:
            labels = json.loads(output)
        except ValueError:
            return None
        if labels is None:
            return {}
        return labels if isinstance(labels, dict) else None

    def _absence_problem(self, argv, what) -> str | None:
        """Return a problem unless the daemon proves ``what`` does not exist.

        ``docker inspect`` exits non-zero for both "gone" and "I could not ask",
        so a non-zero exit is only absence when the output says so.
        """
        code, output = self._docker_cleanup(argv)
        if code == 0:
            return f"{what} still exists"
        if self._is_absent(output, argv[-1]):
            return None
        detail = output.strip()[-200:] if output.strip() else f"exit {code}"
        return f"{what} could not be proved gone ({detail})"

    def _remove_owned_network(self) -> list[str]:
        """Remove this run's network by id, after re-reading its ownership label."""
        try:
            network_id = self.require_network_owned()
        except stack.HarnessError as error:
            return [f"network not removed: {error}"]
        code, output = self._docker_cleanup(["network", "rm", network_id])
        if code != 0 and not self._is_absent(output, network_id):
            return [f"network {network_id}: {output.strip()[-200:] or f'exit {code}'}"]
        return []

    def _run_owned_container(self, name, image, **options):
        """Record the short-lived container ids the shared helper creates itself.

        Migrations and broker topology run through the helper's own one-shot
        containers, so they never reach ``created``. Without this registry their
        absence is simply never proved, and a leaked migration container would go
        unnoticed. ``finally`` is deliberate: a create that succeeds and then fails
        to start is still this run's resource to remove and to prove gone.
        """
        before = len(self.owned_container_ids)
        try:
            super()._run_owned_container(name, image, **options)
        finally:
            self.transient_containers.extend(self.owned_container_ids[before:])

    def _require_owned(self, name, container_id):
        """Prove one recorded container is labelled, mount-safe and network-scoped.

        Bind mounts are the norm. A volume is accepted only when it sits on a mount
        point an image declares as VOLUME **and** the daemon reports no ownership
        label from another run; the name shape is one signal, never the rule. A
        volume anywhere else is refused because it is shared state that could
        outlive the run.
        """
        try:
            labels = json.loads(self.inspect(container_id, "{{json .Config.Labels}}", name))
        except ValueError:
            labels = None
        if not isinstance(labels, dict) or labels.get(VERIFY_LABEL) != "1" or labels.get(RUN_LABEL) != self.run_id:
            raise stack.HarnessError(f"refusing to act on {name} ({container_id}): its ownership label is not this run's")
        anonymous = []
        mounts = self.inspect(container_id, MOUNT_TEMPLATE, name)
        for entry in filter(None, mounts.split(";")):
            kind, _, rest = entry.partition("=")
            if kind == "bind":
                continue
            if kind != "volume":
                raise stack.HarnessError(
                    f"refusing to act on {name}: it carries a mount of unknown type ({entry})"
                )
            volume, _, destination = rest.partition("@")
            anonymous.append(self.volume_owned(volume, destination, name))
        attached = set(filter(None, self.inspect(
            container_id, "{{range $k, $v := .NetworkSettings.Networks}}{{$k}};{{end}}", name
        ).split(";")))
        if attached != {self.network}:
            raise stack.HarnessError(
                f"refusing to act on {name}: it is attached to {sorted(attached)}, not only {self.network}"
            )
        return anonymous

    def volume_owned(self, volume: str, destination: str, container: str) -> str:
        """Return ``volume`` after proving it is unclaimed or this run's own.

        Three checks, and the 64-hex name shape is only the last of them: the
        volume must sit on a mount point an image declares as VOLUME, the daemon
        must report it at all, and its labels must not name another run. A named
        volume is refused unless this run's own label is on it, because a name is
        shared state that may predate the run.
        """
        if destination not in DECLARED_VOLUME_DESTINATIONS:
            raise stack.HarnessError(
                f"refusing to act on {container}: it carries a managed mount ({volume}@{destination}) "
                "that could outlive the run"
            )
        code, output = self._docker_cleanup(["volume", "inspect", "-f", "{{json .Labels}}", volume])
        if code != 0:
            detail = output.strip()[-200:] if output.strip() else f"exit {code}"
            raise stack.HarnessError(
                f"refusing to act on {container}: the daemon does not report volume {volume} ({detail})"
            )
        labels = self._labels_or_none(output)
        if labels is None:
            raise stack.HarnessError(
                f"refusing to act on {container}: the labels of volume {volume} could not be read, "
                "so its ownership cannot be decided"
            )
        owner = labels.get(RUN_LABEL)
        if owner is not None and owner != self.run_id:
            raise stack.HarnessError(
                f"refusing to act on {container}: volume {volume} belongs to another run ({owner})"
            )
        if owner is None and not ANONYMOUS_VOLUME.fullmatch(volume):
            raise stack.HarnessError(
                f"refusing to act on {container}: volume {volume} is named but no run of this "
                "harness owns it, so it may predate this run"
            )
        return volume

    def attest_ownership(self):
        """Prove every recorded container is labelled, mount-safe and network-scoped."""
        if not self.created:
            raise stack.HarnessError("refusing to run: this run recorded no container of its own")
        # By the time this runs the helper has already created the migration and
        # broker-topology containers. An empty registry would make their teardown
        # proof vacuous instead of merely incomplete, so it fails closed here.
        if not self.transient_containers:
            raise stack.HarnessError(
                "refusing to run: this run recorded no transient migration or topology container, "
                "so their absence could never be proved"
            )
        volumes: set[str] = set(self.owned_volumes)
        for name, container_id in self.created.items():
            volumes.update(self._require_owned(name, container_id))
        self.owned_volumes = sorted(volumes)
        suffix = f", and {len(self.owned_volumes)} anonymous volume(s) it must remove" if self.owned_volumes else ""
        print(f"PASS: {len(self.created)} recorded containers carry this run's label, safe mounts, on {self.network}{suffix}")

    def collect_owned_volumes(self):
        """Record this run's volumes from containers that are still standing.

        A run can fail before the ownership attestation ever runs, and cleanup is
        then the last moment the containers are readable. Each container's label is
        re-read first, so a container this run did not create can never contribute a
        volume name the cleanup would then remove. A volume that fails its own
        ownership check is recorded as a teardown problem instead of being skipped:
        skipping it would hide the leak the check exists to find.
        """
        volumes = set(self.owned_volumes)
        targets = list(self.created.items())
        # The helper's one-shot migration and topology containers are this run's too;
        # if one of their images ever declared a VOLUME, scanning only ``created``
        # would let it leak.
        targets.extend((f"transient {container_id}", container_id) for container_id in self.transient_containers)
        for name, container_id in targets:
            code, output = self._docker_cleanup(["inspect", "-f", "{{json .Config.Labels}}", container_id])
            if code != 0:
                if self._is_absent(output, container_id):
                    # Already gone: there is nothing left to collect from it.
                    continue
                self.volume_problems.append(
                    f"container {container_id} ({name}): its labels could not be read, so any volume it "
                    "created was not removed"
                )
                continue
            labels = self._labels_or_none(output)
            if labels is None:
                self.volume_problems.append(
                    f"container {container_id} ({name}): its labels could not be read, so any volume it "
                    "created was not removed"
                )
                continue
            if labels.get(VERIFY_LABEL) != "1" or labels.get(RUN_LABEL) != self.run_id:
                # Not this run's container: its volumes are not this run's to remove.
                continue
            code, output = self._docker_cleanup(["inspect", "-f", MOUNT_TEMPLATE, container_id])
            if code != 0:
                self.volume_problems.append(
                    f"container {container_id} ({name}): its mounts could not be read, so any volume it "
                    "created was not removed"
                )
                continue
            for entry in filter(None, output.strip().split(";")):
                kind, _, rest = entry.partition("=")
                if kind != "volume":
                    continue
                volume, _, destination = rest.partition("@")
                try:
                    volumes.add(self.volume_owned(volume, destination, name))
                except stack.HarnessError as error:
                    self.volume_problems.append(str(error))
        self.owned_volumes = sorted(volumes)
        return self.owned_volumes

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
        """Prove this run's resources are gone, by id, by name and by label.

        A non-zero ``docker inspect`` is not absence: a dead daemon, a permission
        error and a missing id all exit non-zero, and only the last one proves
        anything. Every absence below therefore requires one of the daemon's own
        absence statements naming the inspected identifier, and the labelled
        inventory that follows requires an exit-0 daemon query rather than accepting
        a failed query as an empty result.
        """
        problems = list(self.volume_problems)
        for name, container_id in self.created.items():
            problem = self._absence_problem(
                ["container", "inspect", container_id], f"container {container_id} ({name})"
            )
            if problem:
                problems.append(problem)
        # The helper's one-shot migration and topology containers are not in
        # ``created``; without this loop their absence would never be proved.
        for transient in self.transient_containers:
            problem = self._absence_problem(
                ["container", "inspect", transient], f"transient container {transient}"
            )
            if problem:
                problems.append(problem)
        if self.owned_network:
            if not self.network_id:
                problems.append("network: this run recorded no id, so its absence cannot be proved")
            else:
                problem = self._absence_problem(
                    ["network", "inspect", self.network_id], f"network {self.network_id}"
                )
                if problem:
                    problems.append(problem)
        # Volumes are proved by the name the daemon gave them: an anonymous volume
        # inherits no label and so cannot appear in the inventory below.
        for volume in self.owned_volumes:
            problem = self._absence_problem(["volume", "inspect", volume], f"anonymous volume {volume}")
            if problem:
                problems.append(problem)
        # A labelled inventory is necessary but not sufficient: a named volume is
        # shared state, which is why one is refused before any fault runs.
        for kind, argv in (("container", ["ps", "-a"]), ("network", ["network", "ls"]),
                           ("volume", ["volume", "ls"]), ("image", ["images"])):
            code, output = self._docker_cleanup([*argv, "--filter", f"label={RUN_LABEL}={self.run_id}", "-q"])
            if code != 0:
                problems.append(f"cannot list {kind}s by label (exit {code})")
            elif output.strip():
                problems.append(f"{kind}s still carry this run's label: {output.strip()[:200]}")
        if not problems:
            print(
                "PASS: every recorded container id, the transient migration and topology containers, the "
                "network id, every anonymous volume and every resource carrying this run's label is gone"
            )
        return problems

    def cleanup(self):
        """Remove only owned resources, then prove they are gone."""
        if self.args.keep:
            return super().cleanup()
        # Collected first: after ``docker rm`` the containers that describe these
        # volumes no longer exist, and ``docker rm`` without ``--volumes`` leaves an
        # image-declared volume behind.
        self.collect_owned_volumes()
        # The helper removes containers, then the network - by NAME. This run removes
        # its network by the id it created, after re-reading the label, so the helper
        # is handed no network to delete.
        owned_name, self.owned_network = self.owned_network, None
        try:
            failures = super().cleanup()
        finally:
            self.owned_network = owned_name
        failures.extend(self._remove_owned_network())
        for volume in self.owned_volumes:
            code, output = self._docker_cleanup(["volume", "rm", volume])
            if code != 0 and not self._is_absent(output, volume):
                failures.append(f"volume {volume}: {output.strip()[-200:] or f'exit {code}'}")
        return failures + self.assert_torn_down()

    # -- observations ------------------------------------------------------
    def create_job(self, token, zone=None, scenario=None):
        """Create one synthetic job and return the row the service answered with."""
        payload = {"zone_id": zone or self.args.zone}
        if scenario is not None:
            payload["scenario_id"] = scenario
        status, body = self.http_call(
            "/v1/jobs", method="POST", token=token, body=payload, idem_key=str(uuid.uuid4()),
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
        self.attest_witness_scope()
        self.attest_egress_closed()
        self.attest_ownership()
        self.control(admin, viewer)
        job_id = self.interrupt(admin)
        self.restore(admin, job_id)
        self.replay_witness(admin, viewer, job_id)
        self.permanent_failure_witness(admin)
        self.retries_witness(admin)
        print("PASS: BH-07 recovery witness completed")
        print(
            "NOTE: the recoverable-job half, the permanent failure reaching 'failed' on its first attempt, "
            "and retry exhaustion recorded as five durable attempts. The stored-batch re-emit branch is "
            "still not demonstrated end to end."
        )

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

    # -- the two halves the functional runs left unproven -------------------
    def remove_risk_zone_reference(self, zone):
        """Delete one zone from the risk copy of the catalogue, in this run's container.

        The two services keep separate copies of the catalogue, so this makes a
        reference failure real for ``risk`` while ``jobs`` still accepts the job.
        It touches only this run's disposable container.
        """
        postgres = self.fault_target("postgres")
        if not ZONE_CODE.fullmatch(zone):
            raise stack.HarnessError(
                f"refusing to remove a reference for {zone!r}: a catalogue code is five digits"
            )
        # The statement is a constant and the code travels as a shell positional
        # argument, so no statement text is ever built from a value here. The
        # pattern above is the second lock: it is what keeps a quote out of $1.
        # ``psql -c`` does not interpolate ``-v`` variables, so the value is
        # spliced by the shell inside a single SQL literal instead.
        statement = 'psql -U postgres -d risk -tAc "DELETE FROM zones WHERE code = \'$1\'"'
        code, output = self._docker(
            ["exec", postgres, "sh", "-c", statement, "_", zone], timeout=60
        )
        if code != 0 or "DELETE 1" not in output:
            detail = output.strip()[-300:] if output.strip() else f"exit {code}"
            raise stack.HarnessError(
                f"refusing to run: the risk-side zone reference {zone} could not be removed ({detail})"
            )
        print(f"injected: the risk catalogue no longer holds {zone}, so a job for it can only fail its reference")

    def permanent_failure_witness(self, admin):
        """A permanent failure reaches failed on its first attempt, durably."""
        signal = self.broker_queue(RISK_DEAD_QUEUE)["messages"]
        self.remove_risk_zone_reference(PERMANENT_FAILURE_ZONE)
        accepted = self.create_job(admin, zone=PERMANENT_FAILURE_ZONE)
        self._expect(
            accepted.get("state") == "queued",
            f"a job for the unreferenced zone was not accepted as queued: {accepted.get('state')!r}",
        )
        row = self.wait_for_state(admin, accepted["id"], "failed")
        self._expect_terminal(
            row, reason="permanent_error", attempts=1, what="the permanent failure"
        )
        self._expect_dead_letter_delta(
            signal, what="the permanent failure"
        )
        print(
            "PASS: a permanent failure reaches failed with failure_reason=permanent_error, attempts=1 "
            "(a permanent error skips every retry) and exactly one dead letter"
        )

    def retries_witness(self, admin):
        """Retry exhaustion is recorded as five durable attempts on the row."""
        signal = self.broker_queue(RISK_DEAD_QUEUE)["messages"]
        accepted = self.create_job(admin, scenario=RETRY_EXHAUSTION_SCENARIO)
        self._expect(
            accepted.get("state") == "queued",
            f"the {RETRY_EXHAUSTION_SCENARIO} job was not accepted as queued: {accepted.get('state')!r}",
        )
        row = self.wait_for_state(admin, accepted["id"], "failed")
        self._expect_terminal(
            row, reason="retries_exhausted", attempts=EXPECTED_RETRY_ATTEMPTS, what="retry exhaustion"
        )
        self._expect_dead_letter_delta(
            signal, what="retry exhaustion"
        )
        print(
            f"PASS: retry exhaustion reaches failed with failure_reason=retries_exhausted and the durable "
            f"attempts={EXPECTED_RETRY_ATTEMPTS} the agreed budget fixes, plus exactly one dead letter"
        )

    def _expect_terminal(self, row, *, reason, attempts, what):
        """Require the terminal row the recovery policy describes."""
        self._expect(
            row.get("failure_reason") == reason,
            f"{what}: the recorded failure reason is {row.get('failure_reason')!r} instead of {reason!r}",
        )
        self._expect(
            row.get("attempts") == attempts,
            f"{what}: the durable attempt count is {row.get('attempts')!r} instead of the "
            f"{attempts} attempt(s) the policy fixes",
        )
        self._expect(row.get("failed_at"), f"{what}: the terminal row carries no failed_at")

    def _expect_dead_letter_delta(self, signal, *, what):
        """Require one give-up to raise the dead-letter queue's depth by one.

        The broker's management API republishes its counters on a stats interval,
        so a single read straight after the give-up can still see the previous
        depth. This waits inside the run's own budget and reports the depth it
        actually ends at, so a real extra or missing dead letter still fails. What
        is asserted is the queue's **depth delta** - not the identity or payload of
        the message that was added.
        """
        try:
            self._wait_for(
                lambda: self.broker_queue(RISK_DEAD_QUEUE)["messages"] == signal + 1,
                f"{what} to leave exactly one dead letter on {RISK_DEAD_QUEUE}",
            )
        except stack.HarnessError:
            after = self.broker_queue(RISK_DEAD_QUEUE)["messages"]
            raise stack.HarnessError(
                f"{what}: the dead-letter queue grew by {after - signal} message(s) instead of exactly one"
            ) from None


def parse_args(argv=None):
    """Parse this harness's arguments; the shared helper reads the first four."""
    parser = argparse.ArgumentParser(
        prog=PROG,
        description=(
            "Verify the BH-07 job recovery witness in a disposable Docker stack: interrupt PostgreSQL "
            "during a valid delivery, restore it, restart the consumers, check that the recoverable "
            "job completes exactly once through the confirmed operator replay, and observe a permanent "
            "failure and retry exhaustion on the durable job row. Every probe runs inside the run's "
            "own internal network, never through a host-published port."
        ),
    )
    parser.add_argument(
        "--timeout", type=stack._positive_seconds, default=stack.DEFAULT_TIMEOUT, metavar="SECONDS",
        help=f"overall deadline for the whole run (default: {stack.DEFAULT_TIMEOUT})",
    )
    parser.add_argument(
        "--ready-timeout", type=stack._positive_seconds, default=stack.DEFAULT_READY_TIMEOUT, metavar="SECONDS",
        help=(
            "deadline for each bounded wait, including the interrupted delivery settling and the "
            f"15-second retry budget being spent (default: {stack.DEFAULT_READY_TIMEOUT})"
        ),
    )
    parser.add_argument(
        "--poll-interval", type=stack._positive_seconds, default=stack.DEFAULT_POLL_INTERVAL, metavar="SECONDS",
        help=f"seconds between polls (default: {stack.DEFAULT_POLL_INTERVAL})",
    )
    parser.add_argument(
        "--zone", default=stack.DEFAULT_ZONE, metavar="ZONE",
        help=f"catalogue zone the recoverable witness uses (default: {stack.DEFAULT_ZONE})",
    )
    parser.add_argument(
        "--keep", action="store_true",
        help="leave the created containers, network and images in place for inspection instead of proving teardown",
    )
    args = parser.parse_args(argv)
    if args.zone == PERMANENT_FAILURE_ZONE:
        parser.error(f"--zone must differ from {PERMANENT_FAILURE_ZONE}, which the permanent-failure witness removes")
    return args


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
