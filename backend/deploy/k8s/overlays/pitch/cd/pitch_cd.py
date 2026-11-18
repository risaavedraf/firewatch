#!/usr/bin/env python3
"""The two decisions of the pitch CD gate, and nothing that talks to the network.

`verify-run` answers one question about one exact SHA: is there exactly one push run
of the authoritative main-CI workflow, in this repository, on main, at this SHA, and
did its latest attempt conclude `success`? `tip` reads a refs/heads/main answer.
gate.sh does the HTTP, `fresh` and the bounded wait.

Why one workflow instead of inferred path rules: `pitch-main-ci.yml` calls every
main-coverage workflow on every push to main, so its run for a SHA is the single
authoritative CI result for that SHA. Nothing here reads a `paths:` filter, and no
diff is computed, so there is no window to get wrong.

Endpoint role and path forms are separate decisions. The request identifies the
workflow by **file name** (`pitch-main-ci.yml`), which is the documented string form
for `workflow_id`: "You can replace workflow_id with the workflow file name. For
example, you could use main.yaml" (docs.github.com/en/rest/actions/workflow-runs).
The run object's `path` is "the full path of the workflow", documented with the
`@ref` example `.github/workflows/build.yml@main`, and the repository-qualified form
appears in `referenced_workflows` as
`octocat/Hello-World/.github/workflows/deploy.yml@main`. So the accepted bindings are
exactly: the canonical path, the same path with `@main` or `@refs/heads/main`, and
`<repository>/` + that path with one of those refs — where `<repository>` is this
gate's canonical repository. No other ref, workflow or repository binds.

What is validated, field by field, on every returned row: the repository-scoped
answer must be about this repository, so `repository.full_name` and
`head_repository.full_name` have to be present; a row that matches the candidate
filters (workflow path, SHA, push, main) but names another repository is refused as
an identity mismatch, never read as a match. Rows for another SHA, branch, event or
workflow are ignored and counted. Two matching runs are ambiguous and refused. A
conclusion other than `success` is terminal, including `skipped`, `cancelled` and a
null conclusion on a completed run. A re-run keeps one run id and moves
`run_attempt`; the run's own status and conclusion are the latest attempt's, and no
earlier attempt is consulted.

Exit codes, shared with gate.sh:
  0  one completed, successful push run of the workflow at the exact SHA
  2  retryable: the run is queued/in progress, or has not appeared yet
  3  terminal: the run concluded something other than success
  4  refused: bad arguments, an inconsistent API page, an ambiguous or foreign run,
     or a ref that is not a commit

Structural refusals are written to stderr; the verdict line goes to stdout.

  python3 backend/deploy/k8s/overlays/pitch/cd/pitch_cd.py verify-run \
      --runs runs.json --sha <sha> --repository owner/repo \
      --workflow-path .github/workflows/pitch-main-ci.yml
  python3 backend/deploy/k8s/overlays/pitch/cd/pitch_cd.py tip < ref.json
"""

import argparse
import json
import re
import sys
from pathlib import Path

EXIT_OK = 0
EXIT_RETRY = 2
EXIT_TERMINAL = 3
EXIT_REFUSED = 4

SHA_RE = re.compile(r"^[0-9a-f]{40}$")
REPOSITORY_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
WORKFLOW_PATH_RE = re.compile(r"^\.github/workflows/[A-Za-z0-9_.-]+\.ya?ml$")

# Fields the verdict depends on. A missing one is a malformed answer, not a pass.
REQUIRED_FIELDS = (
    "id",
    "path",
    "event",
    "head_branch",
    "head_sha",
    "status",
    "conclusion",
    "run_attempt",
    "repository",
    "head_repository",
)


class Refused(Exception):
    """An answer this gate will not evaluate, with the reason in words."""


def load_json(source):
    """JSON from a file path or `-` for stdin, with the read turned into a refusal."""
    try:
        text = sys.stdin.read() if source == "-" else Path(source).read_text(encoding="utf-8")
    except OSError as error:
        raise Refused(f"cannot read {source}: {error}") from error
    try:
        return json.loads(text)
    except json.JSONDecodeError as error:
        raise Refused(f"{source} is not JSON: {error}") from error


def read_tip(payload):
    """The commit a refs/heads/main answer names, with the type checked."""
    if not isinstance(payload, dict):
        raise Refused("the ref answer is not a JSON object")
    target = payload.get("object")
    if not isinstance(target, dict):
        raise Refused("the ref answer has no object")
    if target.get("type") != "commit":
        raise Refused(f"refs/heads/main points at a {target.get('type')!r}, not a commit; refusing")
    sha = target.get("sha")
    if not isinstance(sha, str) or not SHA_RE.match(sha):
        raise Refused("the ref answer carries no 40-character commit SHA")
    return sha


def _full_name(run, key):
    """`run[key].full_name`, or a refusal: the identity field cannot be absent."""
    value = run.get(key)
    if not isinstance(value, dict) or not isinstance(value.get("full_name"), str):
        raise Refused(f"run {run.get('id')} has no {key}.full_name")
    if not value["full_name"]:
        raise Refused(f"run {run.get('id')} has an empty {key}.full_name")
    return value["full_name"]


REF_SUFFIXES = ("", "@main", "@refs/heads/main")


def binds_to(run_path, workflow_path, repository):
    """Does this run path name this workflow, this repository and this ref?"""
    if not isinstance(run_path, str):
        return False
    for suffix in REF_SUFFIXES:
        if run_path == workflow_path + suffix:
            return True
        if run_path.lower() == f"{repository}/{workflow_path}{suffix}".lower():
            return True
    return False


def verify_run(payload, sha, repository, workflow_path):
    """(exit code, report lines) for one repo-scoped workflow-runs page."""
    if not REPOSITORY_RE.match(repository or ""):
        raise Refused(f"--repository {repository!r} is not owner/repo")
    if not WORKFLOW_PATH_RE.match(workflow_path or ""):
        raise Refused(f"--workflow-path {workflow_path!r} is not under .github/workflows")
    if not isinstance(payload, dict):
        raise Refused("the workflow-runs answer is not a JSON object")
    runs = payload.get("workflow_runs")
    total = payload.get("total_count")
    if not isinstance(runs, list) or not isinstance(total, int):
        raise Refused("the workflow-runs answer has no workflow_runs list or total_count")
    if total != len(runs):
        raise Refused(
            f"total_count is {total} but the page carries {len(runs)} runs: the answer is "
            "incomplete and this gate will not decide on part of it"
        )

    for position, run in enumerate(runs):
        if not isinstance(run, dict):
            raise Refused(f"run {position} is not a JSON object")
        missing = [field for field in REQUIRED_FIELDS if field not in run]
        if missing:
            raise Refused(f"run {position} is missing {', '.join(missing)}")

    wanted = repository.lower()
    candidates = [
        run
        for run in runs
        if binds_to(run["path"], workflow_path, repository)
        and run["head_sha"] == sha
        and run["event"] == "push"
        and run["head_branch"] == "main"
    ]
    for run in candidates:
        for key in ("repository", "head_repository"):
            actual = _full_name(run, key)
            if actual.lower() != wanted:
                raise Refused(
                    f"run {run.get('id')} names {key} {actual}, not {repository}: "
                    "a shared SHA in another repository does not accredit this one"
                )

    report = []
    if len(candidates) > 1:
        report.append(
            f"refuse  {workflow_path}  more than one push run for this SHA on main "
            f"({len(candidates)}); a re-run keeps one run, so this is ambiguous"
        )
        return EXIT_REFUSED, report
    if not candidates:
        report.append(f"wait    {workflow_path}  no completed push run for this SHA on main yet")
    else:
        run = candidates[0]
        if run["status"] != "completed":
            report.append(f"wait    {workflow_path}  {run['status']}")
        elif run["conclusion"] != "success":
            report.append(f"fail    {workflow_path}  {run['conclusion']}")
        else:
            report.append(f"ok      {workflow_path}  success (attempt {run['run_attempt']})")

    # Rows that are not this workflow's push of this SHA on main are ignored and
    # counted, so the reader can see the page was wider than the question. They are
    # not a refusal: only an identity mismatch among the matches is.
    ignored_sha = ignored_branch = ignored_event = ignored_path = 0
    for run in runs:
        if run["head_sha"] != sha:
            ignored_sha += 1
        elif run["event"] != "push":
            ignored_event += 1
        elif run["head_branch"] != "main":
            ignored_branch += 1
        elif not binds_to(run["path"], workflow_path, repository):
            ignored_path += 1
    ignored = ignored_sha + ignored_branch + ignored_event + ignored_path
    if ignored:
        report.append(
            f"note    {ignored} run(s) ignored: {ignored_sha} for another head_sha, "
            f"{ignored_branch} for another branch, {ignored_event} for another event, "
            f"{ignored_path} for another workflow; this gate re-checks every field and "
            "never trusts the query filter alone"
        )

    if any(line.startswith("refuse") for line in report):
        return EXIT_REFUSED, report
    if any(line.startswith("fail") for line in report):
        return EXIT_TERMINAL, report
    if any(line.startswith("wait") for line in report):
        return EXIT_RETRY, report
    return EXIT_OK, report


def _cmd_verify_run(args):
    payload = load_json(args.runs)
    code, report = verify_run(payload, args.sha, args.repository, args.workflow_path)
    sys.stdout.write("\n".join(report) + "\n")
    return code


def _cmd_tip(args):
    sys.stdout.write(read_tip(load_json("-")) + "\n")
    return EXIT_OK


def main(argv):
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    verify = subparsers.add_parser("verify-run", help="is this exact SHA green for the aggregate")
    verify.add_argument("--runs", required=True, help="the workflow-runs JSON, or -")
    verify.add_argument("--sha", required=True)
    verify.add_argument("--repository", required=True, help="owner/repo this page must be about")
    verify.add_argument(
        "--workflow-path",
        required=True,
        help="the authoritative workflow, e.g. .github/workflows/pitch-main-ci.yml",
    )
    verify.set_defaults(handler=_cmd_verify_run)

    tip = subparsers.add_parser("tip", help="the commit refs/heads/main names, from stdin")
    tip.set_defaults(handler=_cmd_tip)

    args = parser.parse_args(argv)
    if getattr(args, "sha", None) is not None and not SHA_RE.match(args.sha):
        sys.stderr.write(f"pitch-cd: --sha {args.sha!r} is not a 40-character lowercase SHA\n")
        return EXIT_REFUSED
    try:
        return args.handler(args)
    except Refused as error:
        sys.stderr.write(f"pitch-cd: {error}\n")
        return EXIT_REFUSED
    except (OSError, json.JSONDecodeError) as error:
        sys.stderr.write(f"pitch-cd: cannot read the input: {error}\n")
        return EXIT_REFUSED


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
