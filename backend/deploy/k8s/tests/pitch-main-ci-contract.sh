#!/usr/bin/env sh
# Contract for the authoritative main-CI aggregate (S5, the CI slice).
#
# What this checks and what it does not: the aggregate runs on every push to main
# with no path filter, calls the eight reusable bodies at the same SHA, and its
# `aggregate` job is fail-closed on exactly eight `success` results. It also executes
# that job's shell with simulated results — all success, one skipped, one cancelled,
# and one missing dependency — so "no neutral or skipped false-green" is observed
# rather than grepped, and it puts every `run:` block through `bash -n`.
#
# This file is the CI slice's whole offline contract: it reads only the aggregate and
# the eight bodies. It never mentions the CD workflow, the CD guide or the CD
# contract, so a CI-only landing passes without any file from the CD slice. The CD
# contract delegates here and adds its own checks on top.
#
# What it cannot check is a real Actions run or `workflow_call` resolution: those are
# an operator-visible run, and the tracking document says what stays unverified.
#
#   sh backend/deploy/k8s/tests/pitch-main-ci-contract.sh
set -eu

# From backend/deploy/k8s/tests to the repository root.
cd "$(dirname "$0")/../../../.."

agg=.github/workflows/pitch-main-ci.yml
bodies="frontend gateway inference integration jobs prevention risk training"

fail() {
	echo "FAIL: $1" >&2
	exit 1
}

count() {
	# -- so a pattern that starts with a dash is a pattern, not an option.
	grep -cE -- "$1" "$2" || true
}

[ -f "$agg" ] || fail "missing $agg"

# --- one trigger: every push to main, no path filter ------------------------
grep -qx 'on:' "$agg" || fail "the aggregate has no block \`on:\`"
grep -q '^  push:$' "$agg" || fail "the aggregate must run on push"
grep -q '^    branches: \[main\]$' "$agg" || fail "the aggregate must be main only"
if grep -qE '^ *paths(-ignore)?:' "$agg"; then
	fail "the aggregate must run on every main push, without a path filter"
fi
if grep -qE '^  (pull_request|pull_request_target|workflow_run|schedule|release|workflow_dispatch):' "$agg"; then
	fail "the aggregate is one trigger: push to main"
fi

# --- eight explicit calls at the same SHA -----------------------------------
for body in $bodies; do
	grep -qx "    uses: ./.github/workflows/$body.yml" "$agg" ||
		fail "the aggregate does not call $body.yml at the same SHA"
done
[ "$(count '^    uses: \./\.github/workflows/' "$agg")" -eq 8 ] ||
	fail "the aggregate must call exactly eight workflows"

# --- the aggregate job is fail-closed ---------------------------------------
grep -qx '  aggregate:$' "$agg" || fail "the fail-closed aggregate job is missing"
grep -q '^    if: always()$' "$agg" ||
	fail "the aggregate job must use always() so a failure or skip is visible"
grep -q 'needs: \[frontend, gateway, inference, integration, jobs_service, prevention, risk, training\]' "$agg" ||
	fail "the aggregate must depend on all eight bodies"
for name in FRONTEND GATEWAY INFERENCE INTEGRATION JOBS PREVENTION RISK TRAINING; do
	grep -q "^          $name: \${{ needs\." "$agg" ||
		fail "the aggregate does not read the $name result"
done
grep -q '\[ "\$result" = "success" \]' "$agg" ||
	fail "the aggregate must require exactly success"
grep -q '\[ "\$checked" -ne 8 \]' "$agg" ||
	fail "the aggregate must check that eight results were examined"
if grep -qE '\|\| true|continue-on-error|if: success\(\)' "$agg"; then
	fail "a skipped or failed body must not be turned into a green aggregate"
fi

# --- ceiling and scope ------------------------------------------------------
# The called bodies declare contents: read, the caller cannot elevate them, and no
# deployment credential is mapped here.
[ "$(count '^ *permissions:$' "$agg")" -eq 1 ] ||
	fail "the aggregate declares one permission floor and no job-level replacement"
grep -q '^  contents: read$' "$agg" || fail "the aggregate floor must be contents: read"
if grep -q ': write' "$agg"; then
	fail "the aggregate must not hold a write scope"
fi
if grep -qE '^ *secrets:|^ *environment:' "$agg"; then
	fail "the aggregate must not map secrets or use a deploy environment"
fi
unpinned=$(grep -nE '^ *uses: ' "$agg" | grep -vE '(\./\.github/workflows/|@[0-9a-f]{40}( |$))' || true)
[ -z "$unpinned" ] || fail "an action in the aggregate is not pinned to a 40-character SHA: $unpinned"
grep -q '^    timeout-minutes: 15$' "$agg" || fail "the aggregate job must be bounded"
grep -q 'persist-credentials: false' "$agg" || fail "the checkout must not persist credentials"
grep -q 'ref: \${{ github.sha }}' "$agg" || fail "the checkout must name the run's SHA"

# The slice marker: the aggregate runs this CI contract once. The CD contract is a
# later slice's step and is deliberately not required here.
[ "$(count 'pitch-main-ci-contract.sh' "$agg")" -eq 1 ] ||
	fail "the aggregate must exercise the main-CI contract exactly once"

# --- the eight bodies: only workflow_call was added -------------------------
for body in $bodies; do
	file=.github/workflows/$body.yml
	[ -f "$file" ] || fail "missing $file"
	[ "$(count '^  workflow_call:$' "$file")" -eq 1 ] ||
		fail "$body.yml must gain exactly one workflow_call trigger"
	first=$(awk '/^on:$/{seen=1;next} seen{print;exit}' "$file")
	[ "$first" = "  workflow_call:" ] ||
		fail "$body.yml must put workflow_call first under on:, got '$first'"
	grep -qx '  pull_request:$' "$file" ||
		fail "$body.yml must keep its pull_request trigger"
	grep -qx '  push:$' "$file" || fail "$body.yml must keep its push trigger"
	grep -qE '^ *paths:' "$file" || fail "$body.yml must keep its path filter"
	[ "$(count '^  contents: read$' "$file")" -eq 1 ] ||
		fail "$body.yml must keep declaring contents: read"
	if grep -q ': write' "$file"; then
		fail "$body.yml must keep no write scope"
	fi
done
[ -f .github/workflows/_go-service.yml ] ||
	fail "missing .github/workflows/_go-service.yml, which the body wrappers call"
[ "$(count '^  workflow_call:$' .github/workflows/_go-service.yml)" -eq 1 ] ||
	fail "_go-service.yml was already reusable and must stay that way"
if grep -q '^  push:$' .github/workflows/_go-service.yml; then
	fail "_go-service.yml is workflow_call only and must stay that way"
fi

# --- the aggregate's shell parses ------------------------------------------
# The leading-space width comes from RLENGTH, not from match()'s return value: using
# the position made the extraction empty and bash -n pass on nothing. A blank line
# stays inside the block scalar; a line at or above the key's indentation ends it.
blocks=$(grep -cE '^ *run: \|$' "$agg" || true)
[ "$blocks" -ge 1 ] || fail "expected at least 1 run block in $agg, found $blocks"
script=$(
	awk -v want=1 '
		match($0, /^ *run: \|$/) { n++; indent = RLENGTH - 6; active = 1; next }
		active {
			if ($0 ~ /^[[:space:]]*$/) { if (n == want) print ""; next }
			match($0, /^ */)
			if (RLENGTH <= indent) { active = 0; next }
			if (n == want) print substr($0, indent + 3)
		}
	' "$agg"
)
[ -n "$script" ] || fail "the aggregate's result check extracted empty"
printf '%s\n' "$script" | bash -n - || fail "the aggregate's result check does not parse"

# --- and it fails closed when actually executed -----------------------------
# The job is shell inside YAML: greps alone would not prove that a skipped or a
# missing dependency is refused. Each case runs the extracted script with the eight
# results the `needs` context would supply.
check_case() {
	label=$1
	expected=$2
	shift 2
	status=0
	env GITHUB_SHA=contract "$@" bash -c "$script" >/dev/null 2>&1 || status=$?
	[ "$status" -eq "$expected" ] ||
		fail "the aggregate with $label exited $status, want $expected"
}

check_case "all eight successful" 0 \
	FRONTEND=success GATEWAY=success INFERENCE=success INTEGRATION=success \
	JOBS=success PREVENTION=success RISK=success TRAINING=success
check_case "one skipped" 1 \
	FRONTEND=skipped GATEWAY=success INFERENCE=success INTEGRATION=success \
	JOBS=success PREVENTION=success RISK=success TRAINING=success
check_case "one cancelled" 1 \
	FRONTEND=success GATEWAY=success INFERENCE=success INTEGRATION=success \
	JOBS=cancelled PREVENTION=success RISK=success TRAINING=success
check_case "a missing dependency" 1 \
	FRONTEND=success GATEWAY=success INFERENCE=success INTEGRATION=success \
	JOBS= PREVENTION=success RISK=success TRAINING=success

echo "PASS: the aggregate runs on every main push with no path filter, calls the eight reusable bodies at the same SHA, and its fail-closed result check refuses skipped, cancelled and missing results; the eight bodies gained only workflow_call"
