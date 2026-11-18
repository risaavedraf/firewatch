#!/usr/bin/env sh
# The HTTP and the bounded wait around the decisions in pitch_cd.py.
#
# Three modes, nothing else:
#   sh gate.sh tip     the commit refs/heads/main names right now
#   sh gate.sh fresh   refuse unless refs/heads/main is still the run's own SHA
#   sh gate.sh wait    poll until the aggregate's run for that SHA is green
#
# What this checks and what it does not: it asks the documented repo-scoped endpoint
# for one exact answer and hands it to pitch_cd.py, which refuses anything it cannot
# read whole. The request names the workflow by **file name** (the documented string
# form for workflow_id), while the module validates the run object's `path` against
# the documented full-path/`@ref`/repository-qualified forms. Those are separate
# decisions on purpose.
#
# It never trusts the server-side filters on their own: `head_sha`, `branch` and
# `event` narrow the page, and every run object is re-checked field by field, because
# a query parameter the API silently ignored returns a superset and a gate built on
# the query alone would read it as a pass.
#
# A 404 from the workflow-runs endpoint is treated like a missing run, inside the
# deadline: the first push of a new workflow can be visible to Actions before the
# workflow is registered for the API. Every other non-200 answer (401/403 for
# permissions, 5xx, anything else) is a refusal, never a green, and a malformed 200
# is a refusal too. The deadline is checked before a green is accepted.
#
# Exit status is 0 or 1: the workflow only needs "deployed or refused", and the
# reason is on stderr. The distinction between a retryable and a terminal answer is
# made by pitch_cd.py (2 vs 3 vs 4) and is what decides whether this loop waits.
#
# The two Python calls go through `python3`, never through the file's executable bit,
# so a checkout without the mode bits still runs and the interpreter is explicit.
#
# Inputs, all required except where a default is shown:
#   CD_API_URL        https://api.github.com
#   CD_REPOSITORY     owner/repo (the pinned canonical repository)
#   CD_TOKEN          a token with actions: read and contents: read
#   CD_SHA            the SHA this run was created for (fresh, wait)
#   CD_WORKFLOW_PATH  the canonical workflow path (wait); the file name is derived
#   CD_MAX_SECONDS    how long the wait may last, default 1800
#   CD_POLL_SECONDS   pause between requests, default 30
#   CURL              the client binary, for a stub in a test
set -eu

here=$(cd "$(dirname "$0")" && pwd)
client="$here/pitch_cd.py"
curl_bin="${CURL:-curl}"
api="${CD_API_URL:-https://api.github.com}"
repo="${CD_REPOSITORY:?CD_REPOSITORY is required}"
token="${CD_TOKEN:?CD_TOKEN is required}"

refuse() {
	printf 'pitch-cd: %s\n' "$*" >&2
	exit 1
}

# One request: the body goes to $1, the HTTP status is printed, and the token stays in
# a header rather than on the command line of a process another user could read.
# --max-time bounds a hung connection; no -f, because the status is part of the answer.
api_get() {
	"$curl_bin" -sS --max-time 30 --retry 2 \
		-o "$1" -w '%{http_code}' \
		-H "Authorization: Bearer $token" \
		-H 'Accept: application/vnd.github+json' \
		-H 'X-GitHub-Api-Version: 2022-11-28' \
		"$2"
}

tip() {
	answer=$(mktemp) || refuse "mktemp failed"
	# shellcheck disable=SC2064 # expand the temporary path now, not at exit
	trap "rm -f '$answer'" EXIT
	status=$(api_get "$answer" "$api/repos/$repo/git/ref/heads/main") ||
		refuse "cannot reach $api for refs/heads/main (the token needs contents: read)"
	[ "$status" = 200 ] ||
		refuse "refs/heads/main answered HTTP $status (the token needs contents: read)"
	python3 "$client" tip <"$answer" || exit 1
}

fresh() {
	sha="${CD_SHA:?CD_SHA is required}"
	current=$(tip) || exit 1
	[ "$current" = "$sha" ] ||
		refuse "stale: main is at $current and this run was created for $sha. Nothing was deployed; start a new run for the current main."
	printf 'pitch-cd: main is still at %s\n' "$sha"
}

wait_green() {
	sha="${CD_SHA:?CD_SHA is required}"
	workflow="${CD_WORKFLOW_PATH:?CD_WORKFLOW_PATH is required}"
	# The documented request form is the file name; the full path is what the
	# response's `path` is validated against, in pitch_cd.py.
	workflow_file=$(printf '%s' "$workflow" | sed 's#^.*/##')
	[ -n "$workflow_file" ] || refuse "cannot derive a workflow file name from $workflow"
	max="${CD_MAX_SECONDS:-1800}"
	poll="${CD_POLL_SECONDS:-30}"

	deadline=$(( $(date +%s) + max ))
	attempt=0
	while :; do
		attempt=$((attempt + 1))
		answer=$(mktemp) || refuse "mktemp failed"
		status=$(api_get "$answer" \
			"$api/repos/$repo/actions/workflows/$workflow_file/runs?head_sha=$sha&branch=main&event=push&per_page=100") || {
			rm -f "$answer"
			refuse "cannot reach $api for the workflow runs (network failure)"
		}
		if [ "$status" = 404 ]; then
			# Registration lag, not a permission problem: same treatment as a run
			# that has not appeared yet, and the deadline still bounds it.
			rm -f "$answer"
			printf 'pitch-cd: HTTP 404 for %s; treating it like a missing run (attempt %s)\n' \
				"$workflow_file" "$attempt"
			code=2
		elif [ "$status" != 200 ]; then
			rm -f "$answer"
			refuse "the workflow-runs request answered HTTP $status; a permission or server answer is never green"
		else
			code=0
			python3 "$client" verify-run --runs "$answer" --sha "$sha" --repository "$repo" \
				--workflow-path "$workflow" || code=$?
			rm -f "$answer"
		fi
		case $code in
		0)
			# A green answer is only accepted inside the window it was waited for:
			# one that lands after the bound is not evidence the CI was green in time.
			if [ "$(date +%s)" -le "$deadline" ]; then
				echo "pitch-cd: the aggregate is green for $sha"
				return 0
			fi
			refuse "deadline: the green answer for $sha arrived after ${max}s and is not accepted; start a new run"
			;;
		2)
			# Retryable: the run is queued, in progress, has not appeared, or the
			# workflow is not registered yet. Only the deadline ends this.
			;;
		*)
			refuse "the CI gate refused after attempt $attempt; the report above says why"
			;;
		esac
		if [ "$(date +%s)" -ge "$deadline" ]; then
			refuse "deadline: ${max}s passed and the aggregate is still not green for $sha"
		fi
		sleep "$poll"
	done
}

case "${1:-}" in
tip) tip ;;
fresh) fresh ;;
wait) wait_green ;;
*) refuse "usage: sh gate.sh tip|fresh|wait" ;;
esac
