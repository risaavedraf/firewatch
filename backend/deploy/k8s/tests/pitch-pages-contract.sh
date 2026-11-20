#!/usr/bin/env sh
# Offline contract for .github/workflows/pitch-pages-cd.yml, the workflow that
# publishes the frontend of the SHA the pitch VM CD just deployed.
#
# What this checks: the triggers (a completed "Pitch VM CD" run, or a manual
# dispatch, nothing else); that only a successful main run of this repository is
# followed; the dormant switch; one environment of its own; no write scope and no
# artifact; actions and wrangler pinned exactly; the checkout and the gate both
# bound to the SHA being published; the Cloudflare token expanded only for the
# upload; that the upload names its Pages project from PITCH_PAGES_PROJECT with a
# declared-clean tree, the only place that destination can come from; and that the
# publish is verified against the production URL with redirects followed, the status
# read apart from the hashed body, and curl's exit status kept so an incomplete read
# cannot pass. It also checks that the VM CD still keeps Pages out (its own contract
# says so) and still carries the name this workflow follows.
#
# What it does not: run the workflow, reach Cloudflare or prove the upload. Those
# are observed on a real run (CD.md, Frontend en Cloudflare Pages).
set -eu

cd "$(dirname "$0")/../../../.."
wf=.github/workflows/pitch-pages-cd.yml
vm=.github/workflows/pitch-vm-cd.yml
agg=.github/workflows/pitch-main-ci.yml

fail() {
	printf 'FAIL: %s\n' "$*" >&2
	exit 1
}
count() {
	grep -cE -- "$1" "$2" || true
}

for file in "$wf" "$vm" "$agg"; do
	[ -f "$file" ] || fail "missing $file"
done

# ── Triggers ────────────────────────────────────────────────────────────────
grep -qx 'on:' "$wf" || fail "the Pages CD has no block \`on:\`"
grep -q '^  workflow_run:$' "$wf" || fail "the automatic path must follow a workflow_run"
grep -q '^    workflows: \[Pitch VM CD\]$' "$wf" || fail "the automatic path must follow \"Pitch VM CD\" only"
grep -q '^    types: \[completed\]$' "$wf" || fail "the automatic path must fire on completed runs"
grep -q '^  workflow_dispatch:$' "$wf" || fail "the manual path must be workflow_dispatch"
if grep -qE '^  (push|pull_request|pull_request_target|schedule|release):' "$wf"; then
	fail "a trigger other than workflow_run/workflow_dispatch would publish a branch or a PR"
fi
if grep -qE '^    inputs:$|github\.event\.inputs' "$wf"; then
	fail "an operator-supplied input would bypass the exact-SHA gate"
fi
grep -q '^name: Pitch VM CD$' "$vm" ||
	fail "the VM CD is no longer named \"Pitch VM CD\": the Pages CD would never fire"

# ── Who may run it ──────────────────────────────────────────────────────────
grep -q "github.repository == 'risaavedraf/firewatch-dev'" "$wf" || fail "the canonical repository is not pinned"
grep -q "github.server_url == 'https://github.com'" "$wf" || fail "the canonical host is not pinned"
grep -q "vars.PITCH_PAGES_CD_ENABLE == 'true'" "$wf" || fail "the Pages CD must be dormant without PITCH_PAGES_CD_ENABLE"
grep -q "github.event.workflow_run.conclusion == 'success'" "$wf" ||
	fail "only a successful VM deploy may be followed: a skipped or failed one must publish nothing"
grep -q "github.event.workflow_run.head_branch == 'main'" "$wf" || fail "only a main VM run may be followed"
grep -q "github.event.workflow_run.head_repository.full_name == 'risaavedraf/firewatch-dev'" "$wf" ||
	fail "a VM run from a fork must not be followed"
grep -q "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'" "$wf" ||
	fail "a manual publish must be from main"

# ── Scope ───────────────────────────────────────────────────────────────────
[ "$(count '^    environment:$' "$wf")" -eq 1 ] || fail "exactly one environment"
grep -q '^      name: pitch-pages$' "$wf" || fail "the environment must be pitch-pages, apart from the VM's pitch-cd"
if grep -q 'name: pitch-cd$' "$wf"; then
	fail "the Pages job must not enter pitch-cd, where the VM's SSH key lives"
fi
if grep -q 'PITCH_CD_SSH_KEY' "$wf"; then
	fail "the Pages job must never read the VM's SSH key"
fi
grep -q '^      group: pitch-pages-cd$' "$wf" || fail "the publish concurrency group is not named"
grep -q '^      cancel-in-progress: false$' "$wf" || fail "a publish in progress must never be cancelled"
grep -qE '^    timeout-minutes: [0-9]+$' "$wf" || fail "the publish job must be bounded"
[ "$(count '^  contents: read$' "$wf")" -eq 1 ] || fail "the workflow floor must be contents: read"
grep -q '^      actions: read$' "$wf" || fail "the gate reads runs and needs actions: read"
if grep -q ': write' "$wf"; then
	fail "the Pages CD needs no write scope"
fi
if grep -qE 'upload-artifact|download-artifact|actions/artifact' "$wf"; then
	fail "the Pages CD must not upload an artifact"
fi
if grep -qE 'ssh -i|kubectl |bash up\.sh' "$wf"; then
	fail "the Pages CD must not touch the VM or the cluster"
fi

# ── Pins ────────────────────────────────────────────────────────────────────
unpinned=$(grep -nE '^ *(- )?uses: ' "$wf" | grep -vE '@[0-9a-f]{40}( |$)' || true)
[ -z "$unpinned" ] || fail "an action is not pinned to a 40-character SHA: $unpinned"
grep -qE 'npx --yes wrangler@[0-9]+\.[0-9]+\.[0-9]+ pages deploy dist' "$wf" ||
	fail "wrangler must be an exact version"
[ "$(count 'wrangler@' "$wf")" -eq 1 ] || fail "exactly one wrangler invocation"

# ── The SHA ─────────────────────────────────────────────────────────────────
grep -q "CD_SHA: \${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha || github.sha }}" "$wf" ||
	fail "the SHA must be the VM run's head SHA, or the dispatch's own"
grep -q 'ref: \${{ env.CD_SHA }}' "$wf" || fail "the checkout must name the SHA being published"
grep -q 'persist-credentials: false' "$wf" || fail "the checkout must leave the token out of .git/config"
grep -q 'CD_WORKFLOW_PATH: .github/workflows/pitch-main-ci.yml' "$wf" || fail "the gate must ask the authoritative aggregate"
grep -q 'CD_REPOSITORY: risaavedraf/firewatch-dev' "$wf" || fail "the gate must query the pinned repository"
grep -q 'gate.sh fresh' "$wf" || fail "the publish must refuse a SHA main has moved past"
grep -q 'gate.sh wait' "$wf" || fail "the publish must require a green aggregate for the SHA"
grep -q -- '--commit-hash "\$CD_SHA"' "$wf" || fail "the upload must record the SHA it publishes"
grep -q -- '--branch main' "$wf" || fail "the upload must target the production branch"

# ── The upload's destination ────────────────────────────────────────────────
# There is no frontend/wrangler.toml, so --project-name is the only thing naming the
# Cloudflare Pages project: without it the upload has no destination, and a literal
# would publish into a project no variable configures.
if grep -qE -- '--project-name [^"$]' "$wf"; then
	fail "a literal --project-name would publish into a project no variable configures"
fi
grep -q -- '--project-name "\$PITCH_PAGES_PROJECT"' "$wf" ||
	fail "the upload must take its Pages project from PITCH_PAGES_PROJECT: with no wrangler config naming one, its absence leaves the upload without a destination"
grep -q 'PITCH_PAGES_PROJECT: \${{ vars.PITCH_PAGES_PROJECT }}' "$wf" ||
	fail "the job env must read PITCH_PAGES_PROJECT from the repository variables, or the upload names no operator-configured project"
grep -q -- '--commit-dirty=false' "$wf" ||
	fail "the upload must declare --commit-dirty=false: a dirty tree would otherwise be recorded against the SHA being published"

# ── Secrets ─────────────────────────────────────────────────────────────────
[ "$(count 'secrets\.CLOUDFLARE_API_TOKEN \}\}' "$wf")" -eq 1 ] ||
	fail "the Cloudflare token must be expanded exactly once, for the upload"
grep -q "secrets.CLOUDFLARE_API_TOKEN != ''" "$wf" || fail "the token's presence must be checked before anything runs"
if grep -qiE 'VITE_[A-Z_]*(SECRET|TOKEN|KEY)' "$wf"; then
	fail "a VITE_* value is inlined into the public bundle and can never be a credential"
fi

# ── Build and verification ──────────────────────────────────────────────────
grep -q 'npm ci' "$wf" || fail "dependencies must come from the lockfile"
grep -q 'npm run build:pages' "$wf" || fail "the bundle must be the Pages build, with its _headers"
grep -q 'test -f dist/_headers' "$wf" || fail "the CSP headers file must exist before the upload"
grep -q 'sha256sum dist/index.html' "$wf" || fail "the publish must be verified against the production URL"

# ── The production URL check ────────────────────────────────────────────────
# A redirect (apex -> www, "Always Use HTTPS", a custom domain) is not a wrong build:
# the status is read separately and must be 200, while the bytes that are hashed are
# the response body only, never the status line nor a redirect page.
if ! grep -qE 'curl -[a-zA-Z]*L|curl --location' "$wf"; then
	fail "the production URL check must follow redirects (-L): a 301/302 from an apex, www or HTTPS rule is not a body mismatch"
fi
grep -q '%{http_code}' "$wf" ||
	fail "the production URL check must report the HTTP status, so a non-200 names its own cause instead of blaming the body"
grep -q -- '-o "\$body"' "$wf" || fail "the URL check must write the response body to a file of its own"
grep -q 'sha256sum "\$body"' "$wf" ||
	fail "the URL check must hash that file, keeping the status out of the hashed bytes"
# The exit status is part of the check, not a detail to swallow: a read cut short by
# --max-time can equal the build byte for byte when the served resource is larger, so
# status 200 plus a matching hash does not prove the read finished.
grep -q 'if reply=\$(curl ' "$wf" ||
	fail "the URL check must capture curl's exit code (if reply=\$(curl ...); then rc=0; else rc=\$?; fi): a read cut short can equal this build byte for byte"
grep -q 'rc=\$?' "$wf" ||
	fail "the URL check must keep curl's exit code in rc instead of discarding it"
grep -qE '\[ "\$rc" -eq 0 \] && \[ "\$status" = "200" \] && \[ "\$got" = "\$want" \]' "$wf" ||
	fail "an attempt may pass only when curl exited 0, the answer was 200 and the body matches: any one of those alone is not proof"
grep -qE '\[ "\$rc" -ne 0 \]' "$wf" ||
	fail "an incomplete transfer must fail as itself, ahead of the non-200 and body checks, or the operator is sent to the wrong cause"
grep -q 'curl exit code' "$wf" ||
	fail "the incomplete-transfer error must name curl's exit code"
if grep -q '|| true' "$wf"; then
	fail "a swallowed exit status (|| true) would let a truncated read pass as this build"
fi
if grep -qE 'curl [^|]*\| *(sha256sum|tee)' "$wf"; then
	fail "piping the response into sha256sum hashes whatever came back, a redirect or an error page included"
fi

# ── Neighbours ──────────────────────────────────────────────────────────────
if grep -qiE 'wrangler|pages deploy|build:pages' "$vm"; then
	fail "Pages must stay out of the VM CD; it lives in $wf"
fi
[ "$(count 'pitch-pages-contract.sh' "$agg")" -eq 1 ] ||
	fail "the aggregate must exercise this contract exactly once"

# Every run block must parse.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
awk -v dir="$tmp" '
	/^ *run: \|$/ { n++; match($0, /^ */); indent = RLENGTH; active = 1; next }
	active {
		if ($0 ~ /^[[:space:]]*$/) { print "" >> (dir "/" n ".sh"); next }
		match($0, /^ */)
		if (RLENGTH > indent) { print substr($0, indent + 3) >> (dir "/" n ".sh"); next }
		active = 0
	}
' "$wf"
blocks=0
for block in "$tmp"/*.sh; do
	[ -f "$block" ] || continue
	blocks=$((blocks + 1))
	bash -n "$block" || fail "a run block in $wf does not parse ($(basename "$block"))"
done
[ "$blocks" -ge 5 ] || fail "expected at least 5 run blocks in $wf, found $blocks"

printf 'PASS: the Pages CD follows only a successful main VM deploy (or a manual main dispatch), is dormant without PITCH_PAGES_CD_ENABLE, publishes the exact SHA through the same fresh/wait gate, keeps its token in its own environment apart from the SSH key, pins its actions and wrangler, names its Pages project from PITCH_PAGES_PROJECT with a declared-clean tree, and verifies the production URL serves the build by following redirects, reading the status apart from the hashed body, and requiring the transfer to complete; the VM CD still keeps Pages out\n'
