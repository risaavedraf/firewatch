#!/usr/bin/env python3
"""Offline contract tests for the pitch CD gate and the exact-SHA aggregate it reads.

What this checks and what it does not: the gate's two decisions — is there exactly one
completed, successful push run of the aggregate workflow for this SHA, in this
repository, on main; and what does refs/heads/main name now — plus the bounded-wait
wiring around them, against fixtures and a stub for curl. It never talks to GitHub,
never reads a credential and never reaches the VM. What it cannot check is that Actions
parses or runs the aggregate, that the API honours its query parameters, or that the
SSH side works; those are the operator's first manual run, and CD.md says so.

   python3 backend/deploy/k8s/tests/pitch_cd_contract_test.py -v
"""

import importlib.util
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

# This contract is also run inside main CI; leaving bytecode behind in the checkout
# would be a build input that is not the candidate.
sys.dont_write_bytecode = True

K8S = Path(__file__).resolve().parents[1]  # backend/deploy/k8s
REPO = K8S.parents[2]
MODULE = K8S / "overlays/pitch/cd/pitch_cd.py"
GATE = K8S / "overlays/pitch/cd/gate.sh"

REPOSITORY = "owner/repo"
WORKFLOW_PATH = ".github/workflows/pitch-main-ci.yml"
SHA = "0" * 39 + "1"
OTHER_SHA = "0" * 39 + "2"

EXIT_OK = 0
EXIT_RETRY = 2
EXIT_TERMINAL = 3
EXIT_REFUSED = 4


def load_module():
    spec = importlib.util.spec_from_file_location("pitch_cd", MODULE)
    assert spec and spec.loader, f"cannot load {MODULE}"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_module(*args, stdin_text=None):
    return subprocess.run(
        [sys.executable, str(MODULE), *args],
        capture_output=True,
        text=True,
        input=stdin_text,
        cwd=str(REPO),
    )


# Names the gate reads and names that carry a caller's credential. Everything else is
# inherited, because an environment is not a place to substitute values: on Windows a
# child whose environment lacks SYSTEMDRIVE makes the app-compat/StateRepository path
# resolution expand `%SystemDrive%\ProgramData\Microsoft\Windows\Caches` with the token
# left literal. That result is not an absolute path, so the child creates it relative to
# its own cwd -- which for this contract is the checkout. Pin the gate's inputs; never
# replace the environment that tells the platform where its own files are.
DROPPED_PREFIXES = ("CD_",)
DROPPED_NAMES = ("CURL", "GITHUB_TOKEN", "GH_TOKEN")


def controlled_environment(**pinned):
    env = {
        name: value
        for name, value in os.environ.items()
        if name.upper() not in DROPPED_NAMES
        and not name.upper().startswith(DROPPED_PREFIXES)
    }
    env.update(pinned)
    return env


def run_object(**over):
    data = {
        "id": 1,
        "name": "Pitch main CI",
        "path": WORKFLOW_PATH,
        "event": "push",
        "head_branch": "main",
        "head_sha": SHA,
        "status": "completed",
        "conclusion": "success",
        "run_attempt": 1,
        "repository": {"full_name": REPOSITORY},
        "head_repository": {"full_name": REPOSITORY},
    }
    data.update(over)
    return data


def runs_payload(*items, total_count=None):
    return {
        "total_count": len(items) if total_count is None else total_count,
        "workflow_runs": list(items),
    }


def verify(runs, *extra, sha=SHA, path=WORKFLOW_PATH, repository=REPOSITORY):
    with tempfile.TemporaryDirectory() as tmp:
        runs_file = Path(tmp) / "runs.json"
        runs_file.write_text(
            runs if isinstance(runs, str) else json.dumps(runs), encoding="utf-8"
        )
        return run_module(
            "verify-run",
            "--runs",
            str(runs_file),
            "--sha",
            sha,
            "--repository",
            repository,
            "--workflow-path",
            path,
            *extra,
        )


# ---------------------------------------------------------------------------
# One exact SHA, one authoritative workflow, no permissive answer.
# ---------------------------------------------------------------------------


class TestVerifyRun(unittest.TestCase):
    def test_a_green_run_is_ok(self):
        result = verify(runs_payload(run_object()))
        self.assertEqual(result.returncode, EXIT_OK, result.stdout + result.stderr)
        self.assertIn("ok", result.stdout)
        self.assertIn(WORKFLOW_PATH, result.stdout)

    def test_no_run_yet_is_retryable(self):
        result = verify(runs_payload())
        self.assertEqual(result.returncode, EXIT_RETRY)
        self.assertIn("no completed push run", result.stdout)

    def test_an_in_progress_run_is_retryable(self):
        result = verify(runs_payload(run_object(status="in_progress", conclusion=None)))
        self.assertEqual(result.returncode, EXIT_RETRY)
        self.assertIn("in_progress", result.stdout)

    def test_a_queued_run_is_retryable(self):
        result = verify(runs_payload(run_object(status="queued", conclusion=None)))
        self.assertEqual(result.returncode, EXIT_RETRY)
        self.assertIn("queued", result.stdout)

    def test_a_failed_run_is_terminal(self):
        result = verify(runs_payload(run_object(conclusion="failure")))
        self.assertEqual(result.returncode, EXIT_TERMINAL)
        self.assertIn("failure", result.stdout)

    def test_a_cancelled_run_is_not_green(self):
        result = verify(runs_payload(run_object(conclusion="cancelled")))
        self.assertEqual(result.returncode, EXIT_TERMINAL)
        self.assertIn("cancelled", result.stdout)

    def test_a_skipped_run_is_not_green(self):
        # The aggregate must never let a skipped job read as success; nor does this.
        result = verify(runs_payload(run_object(conclusion="skipped")))
        self.assertEqual(result.returncode, EXIT_TERMINAL)
        self.assertIn("skipped", result.stdout)

    def test_a_run_that_is_not_completed_is_not_green(self):
        result = verify(runs_payload(run_object(status="completed", conclusion=None)))
        self.assertEqual(result.returncode, EXIT_TERMINAL)
        self.assertIn("None", result.stdout)

    def test_two_matching_runs_are_ambiguous(self):
        result = verify(runs_payload(run_object(id=1), run_object(id=2)))
        self.assertEqual(result.returncode, EXIT_REFUSED)
        self.assertIn("more than one", result.stdout)

    def test_a_rerun_is_judged_by_its_latest_attempt(self):
        # A re-run keeps one run id and moves run_attempt; the run's conclusion is
        # the latest attempt's, and no earlier green is read.
        result = verify(runs_payload(run_object(run_attempt=2)))
        self.assertEqual(result.returncode, EXIT_OK, result.stdout)
        self.assertIn("attempt 2", result.stdout)

    def test_a_rerun_whose_latest_attempt_failed_is_terminal(self):
        result = verify(runs_payload(run_object(run_attempt=3, conclusion="failure")))
        self.assertEqual(result.returncode, EXIT_TERMINAL)

    def test_a_run_for_a_fork_is_refused(self):
        result = verify(
            runs_payload(run_object(head_repository={"full_name": "owner/fork"}))
        )
        self.assertEqual(result.returncode, EXIT_REFUSED)
        self.assertIn("head_repository", result.stdout + result.stderr)

    def test_a_run_from_another_repository_is_refused(self):
        result = verify(runs_payload(run_object(repository={"full_name": "owner/other"})))
        self.assertEqual(result.returncode, EXIT_REFUSED)
        self.assertIn("owner/other", result.stdout + result.stderr)

    def test_a_run_for_another_sha_is_ignored_and_counted(self):
        result = verify(runs_payload(run_object(head_sha=OTHER_SHA)))
        self.assertEqual(result.returncode, EXIT_RETRY)
        self.assertIn("1 for another head_sha", result.stdout)

    def test_a_run_for_another_branch_is_ignored_and_counted(self):
        result = verify(runs_payload(run_object(head_branch="release")))
        self.assertEqual(result.returncode, EXIT_RETRY)
        self.assertIn("1 for another branch", result.stdout)

    def test_a_pull_request_run_is_ignored_and_counted(self):
        result = verify(runs_payload(run_object(event="pull_request")))
        self.assertEqual(result.returncode, EXIT_RETRY)
        self.assertIn("1 for another event", result.stdout)

    def test_a_run_for_another_workflow_is_ignored_and_counted(self):
        result = verify(
            runs_payload(run_object(path=".github/workflows/frontend.yml"))
        )
        self.assertEqual(result.returncode, EXIT_RETRY)
        self.assertIn("1 for another workflow", result.stdout)

    def test_an_incomplete_page_is_refused(self):
        result = verify(runs_payload(run_object(), total_count=2))
        self.assertEqual(result.returncode, EXIT_REFUSED)
        self.assertIn("total_count", result.stderr)

    def test_malformed_json_is_refused(self):
        self.assertEqual(verify("{not json").returncode, EXIT_REFUSED)

    def test_a_run_object_missing_a_field_is_refused(self):
        broken = run_object()
        del broken["head_repository"]
        result = verify(runs_payload(broken))
        self.assertEqual(result.returncode, EXIT_REFUSED)
        self.assertIn("head_repository", result.stderr)

    def test_a_workflow_path_outside_the_workflow_directory_is_refused(self):
        result = verify(runs_payload(), path="backend/scripts/up.sh")
        self.assertEqual(result.returncode, EXIT_REFUSED)
        self.assertIn(".github/workflows", result.stderr)


# ---------------------------------------------------------------------------
# The documented `path` forms, each bound to this repository and this ref.
# ---------------------------------------------------------------------------


class TestWorkflowPathForms(unittest.TestCase):
    """The request sends the file name; the run object's path is validated."""

    def test_the_documented_forms_bind(self):
        for path in (
            WORKFLOW_PATH,
            WORKFLOW_PATH + "@main",
            WORKFLOW_PATH + "@refs/heads/main",
            f"{REPOSITORY}/{WORKFLOW_PATH}@main",
            f"{REPOSITORY}/{WORKFLOW_PATH}@refs/heads/main",
        ):
            with self.subTest(path=path):
                result = verify(runs_payload(run_object(path=path)))
                self.assertEqual(result.returncode, EXIT_OK, result.stdout + result.stderr)

    def test_an_arbitrary_ref_suffix_does_not_bind(self):
        for path in (
            WORKFLOW_PATH + "@release",
            WORKFLOW_PATH + "@main-extra",
            WORKFLOW_PATH + "@",
            WORKFLOW_PATH + "@main@main",
        ):
            with self.subTest(path=path):
                result = verify(runs_payload(run_object(path=path)))
                self.assertEqual(result.returncode, EXIT_RETRY)
                self.assertIn("1 for another workflow", result.stdout)

    def test_another_repository_in_the_qualified_form_does_not_bind(self):
        result = verify(runs_payload(run_object(path=f"owner/fork/{WORKFLOW_PATH}@main")))
        self.assertEqual(result.returncode, EXIT_RETRY)
        self.assertIn("1 for another workflow", result.stdout)

    def test_another_workflow_in_the_qualified_form_does_not_bind(self):
        result = verify(
            runs_payload(run_object(path=f"{REPOSITORY}/.github/workflows/other.yml@main"))
        )
        self.assertEqual(result.returncode, EXIT_RETRY)
        self.assertIn("1 for another workflow", result.stdout)


# ---------------------------------------------------------------------------
# The main ref, read from the API answer rather than from a ref name.
# ---------------------------------------------------------------------------


class TestTip(unittest.TestCase):
    def tip(self, payload):
        text = payload if isinstance(payload, str) else json.dumps(payload)
        return run_module("tip", stdin_text=text)

    def test_a_branch_ref_yields_its_commit(self):
        result = self.tip({"ref": "refs/heads/main", "object": {"type": "commit", "sha": SHA}})
        self.assertEqual(result.returncode, EXIT_OK, result.stderr)
        self.assertEqual(result.stdout.strip(), SHA)

    def test_a_non_commit_ref_is_refused(self):
        self.assertEqual(self.tip({"object": {"type": "tag", "sha": SHA}}).returncode, EXIT_REFUSED)

    def test_a_nested_or_absent_object_is_refused(self):
        self.assertEqual(self.tip({"object": {"sha": SHA}}).returncode, EXIT_REFUSED)
        self.assertEqual(self.tip({}).returncode, EXIT_REFUSED)
        self.assertEqual(self.tip("nope").returncode, EXIT_REFUSED)


# ---------------------------------------------------------------------------
# Bounded wait: retry what can change, stop on what cannot, and stay fresh.
# ---------------------------------------------------------------------------


class TestGateWiring(unittest.TestCase):
    """Drives cd/gate.sh through a stub in place of curl (the repo's KUBECTL pattern)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.calls = self.dir / "calls"
        self.calls.write_text("", encoding="utf-8")
        self.stub = self.dir / "curl"
        self.stub.write_text(
            textwrap.dedent(
                """\
                #!/bin/sh
                # Stub for curl: one call per line, one body and one status per call.
                echo "$*" >> "$STUB_CALLS"
                n=$(wc -l < "$STUB_CALLS" | tr -d ' ')
                body=""
                while [ $# -gt 0 ]; do
                    case $1 in
                        -o) shift; body=$1 ;;
                        -w) shift ;;
                    esac
                    shift
                done
                if [ -n "$body" ]; then
                    if [ -f "$STUB_DIR/$n.json" ]; then
                        cat "$STUB_DIR/$n.json" > "$body"
                    else
                        cat "$STUB_DIR/last.json" > "$body"
                    fi
                fi
                if [ -f "$STUB_DIR/$n.status" ]; then
                    cat "$STUB_DIR/$n.status"
                elif [ -f "$STUB_DIR/status" ]; then
                    cat "$STUB_DIR/status"
                else
                    printf '200'
                fi
                """
            ),
            encoding="utf-8",
        )
        self.stub.chmod(self.stub.stat().st_mode | stat.S_IEXEC)

    def tearDown(self):
        self.tmp.cleanup()

    def fixture(self, name, payload):
        (self.dir / name).write_text(json.dumps(payload), encoding="utf-8")

    def status(self, name, code):
        (self.dir / name).write_text(str(code), encoding="utf-8")

    def gate(self, mode, cwd=None, **env):
        base = {
            "CURL": str(self.stub),
            "STUB_CALLS": str(self.calls),
            "STUB_DIR": str(self.dir),
            "CD_API_URL": "https://api.example.invalid",
            "CD_REPOSITORY": REPOSITORY,
            "CD_TOKEN": "not-a-real-token",
            "CD_SHA": SHA,
            "CD_WORKFLOW_PATH": WORKFLOW_PATH,
            "CD_MAX_SECONDS": "5",
            "CD_POLL_SECONDS": "0",
        }
        base.update(env)
        return subprocess.run(
            ["sh", str(GATE), mode],
            capture_output=True,
            text=True,
            env=controlled_environment(**base),
            cwd=str(cwd or REPO),
        )

    def test_the_gate_environment_is_the_callers_plus_the_pinned_inputs(self):
        pinned = {"CD_TOKEN": "not-a-real-token", "CD_SHA": SHA}
        env = controlled_environment(**pinned)
        for name, value in pinned.items():
            self.assertEqual(env[name], value, name)
        # The platform keeps the variables it needs to resolve its own paths.
        for name in ("PATH", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP"):
            if name in os.environ:
                self.assertEqual(env[name], os.environ[name], name)
        # A caller's gate inputs and credentials never reach the gate.
        for name in ("CD_SHA", "CD_REPOSITORY", "GITHUB_TOKEN", "GH_TOKEN"):
            if name in os.environ:
                self.assertNotIn(name, env, name)

    def test_driving_the_gate_creates_nothing_in_the_directory_it_runs_in(self):
        # The gate's Python children inherit the environment the caller gives the gate.
        # Whatever such a child resolves for the platform's own cache directories must
        # land where the platform put them, never in a relative `%SystemDrive%` tree in
        # the process's cwd -- which is why the run is observed in a cwd this test owns
        # instead of the checkout, where an earlier unfixed run can leave the tree behind.
        work = Path(self.tmp.name) / "cwd"
        work.mkdir()
        self.fixture("last.json", runs_payload(run_object()))
        result = self.gate("wait", cwd=work)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(sorted(p.name for p in work.iterdir()), [])

    def test_tip_prints_the_sha_from_the_ref_api(self):
        self.fixture(
            "last.json", {"ref": "refs/heads/main", "object": {"type": "commit", "sha": SHA}}
        )
        result = self.gate("tip")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout.strip(), SHA)
        call = self.calls.read_text().splitlines()[0]
        self.assertIn("git/ref/heads/main", call)
        self.assertNotIn("actions/", call)

    def test_fresh_accepts_the_run_sha(self):
        self.fixture(
            "last.json", {"object": {"type": "commit", "sha": SHA}}
        )
        result = self.gate("fresh")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(SHA, result.stdout)

    def test_fresh_refuses_a_stale_run(self):
        self.fixture("last.json", {"object": {"type": "commit", "sha": OTHER_SHA}})
        result = self.gate("fresh")
        self.assertEqual(result.returncode, 1)
        self.assertIn("stale", result.stderr)

    def test_a_green_set_passes_on_the_first_call(self):
        self.fixture("last.json", runs_payload(run_object()))
        result = self.gate("wait")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len(self.calls.read_text().splitlines()), 1)

    def test_a_pending_run_is_retried_until_it_is_green(self):
        self.fixture("1.json", runs_payload(run_object(status="in_progress", conclusion=None)))
        self.fixture("2.json", runs_payload(run_object()))
        result = self.gate("wait", CD_MAX_SECONDS="30")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len(self.calls.read_text().splitlines()), 2)

    def test_a_failed_run_stops_without_waiting_for_the_deadline(self):
        self.fixture("last.json", runs_payload(run_object(conclusion="failure")))
        result = self.gate("wait", CD_MAX_SECONDS="3600")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(len(self.calls.read_text().splitlines()), 1)
        self.assertIn("failure", result.stdout + result.stderr)

    def test_the_deadline_is_bounded(self):
        self.fixture("last.json", runs_payload(run_object(status="queued", conclusion=None)))
        result = self.gate("wait", CD_MAX_SECONDS="0")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(len(self.calls.read_text().splitlines()), 1)
        self.assertIn("deadline", (result.stdout + result.stderr).lower())

    def test_a_green_answer_arriving_after_the_deadline_is_refused(self):
        # A negative bound puts the deadline in the past: the only deterministic
        # way to reach the late-green path without sleeping.
        self.fixture("last.json", runs_payload(run_object()))
        result = self.gate("wait", CD_MAX_SECONDS="-1")
        self.assertEqual(result.returncode, 1)
        self.assertIn("deadline", (result.stdout + result.stderr).lower())

    def test_the_request_sends_the_workflow_filename_not_its_path(self):
        self.fixture("last.json", runs_payload(run_object()))
        self.gate("wait")
        call = self.calls.read_text().splitlines()[0]
        self.assertIn("/actions/workflows/pitch-main-ci.yml/runs", call)
        self.assertNotIn("workflows/.github", call)

    def test_a_404_is_retried_like_a_missing_run(self):
        self.status("1.status", 404)
        self.fixture("2.json", runs_payload(run_object()))
        result = self.gate("wait", CD_MAX_SECONDS="30")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len(self.calls.read_text().splitlines()), 2)

    def test_a_404_that_never_resolves_is_a_deadline_refusal(self):
        self.status("status", 404)
        result = self.gate("wait", CD_MAX_SECONDS="0")
        self.assertEqual(result.returncode, 1)
        self.assertIn("deadline", (result.stdout + result.stderr).lower())

    def test_a_permission_answer_is_refused_immediately_and_never_green(self):
        self.status("status", 403)
        result = self.gate("wait", CD_MAX_SECONDS="3600")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(len(self.calls.read_text().splitlines()), 1)
        self.assertIn("403", result.stderr)

    def test_a_malformed_answer_with_status_200_is_refused(self):
        (self.dir / "last.json").write_text("{not json", encoding="utf-8")
        result = self.gate("wait", CD_MAX_SECONDS="3600")
        self.assertEqual(result.returncode, 1)
        self.assertIn("not JSON", result.stderr)

    def test_the_gate_invokes_python_by_interpreter_not_by_file_mode(self):
        source = GATE.read_text(encoding="utf-8")
        # Two decisions: the main ref and the aggregate's run.
        self.assertGreaterEqual(source.count('python3 "$client"'), 2)
        bare = [line for line in source.splitlines() if line.strip().startswith('"$client"')]
        self.assertEqual(bare, [], f"a bare interpreter-less invocation remains: {bare}")

    def test_the_runs_query_names_the_repo_scoped_workflow_and_filters(self):
        self.fixture("last.json", runs_payload(run_object()))
        self.gate("wait")
        call = self.calls.read_text().splitlines()[0]
        # The request names the workflow by file name; the full path is what the
        # response's `path` is validated against in the module.
        self.assertIn(f"/repos/{REPOSITORY}/actions/workflows/pitch-main-ci.yml/runs", call)
        self.assertIn("head_sha=" + SHA, call)
        self.assertIn("branch=main", call)
        self.assertIn("event=push", call)
        self.assertIn("per_page=100", call)


class TestModuleContract(unittest.TestCase):
    def test_exit_codes_are_the_documented_ones(self):
        module = load_module()
        self.assertEqual(module.EXIT_OK, 0)
        self.assertEqual(module.EXIT_RETRY, 2)
        self.assertEqual(module.EXIT_TERMINAL, 3)
        self.assertEqual(module.EXIT_REFUSED, 4)

    def test_the_gate_has_no_third_party_imports(self):
        # The CD contract may run inside main CI, so this file must stay stdlib-only.
        source = MODULE.read_text(encoding="utf-8")
        imports = sorted(set(re.findall(r"^(?:import|from) ([A-Za-z_][A-Za-z0-9_]*)", source, re.M)))
        self.assertEqual(imports, ["argparse", "json", "pathlib", "re", "sys"])


if __name__ == "__main__":
    unittest.main()
