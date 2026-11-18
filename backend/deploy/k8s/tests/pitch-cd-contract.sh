#!/usr/bin/env sh
# Contract for the dormant pitch CD workflow and the guide that activates it.
#
# What this checks and what it does not: it reads the CD workflow and CD.md as text
# and asserts the properties the CD design rests on — the CD consumes one exact-SHA
# push run of the aggregate, validated field by field, and never infers path rules;
# the CA pin is a certificate check; the reviewed bootstrap script is pinned; the
# deploy checkout and its canonical origin are checked; and no job has a write scope
# or a secret mapping. It extracts the CD's `run:` blocks and the heredoc that runs on
# the VM and puts them through `bash -n`, because a YAML file that parses says nothing
# about the shell inside it. Then it runs the unit tests for the gate's decisions.
#
# The aggregate and the eight reusable bodies belong to the CI slice and are checked
# by pitch-main-ci-contract.sh, which this contract invokes: one implementation, and
# that slice keeps its own checks when it lands without the CD.
#
# What it does not check is anything observed: no Actions run, no workflow_call
# resolution, no SSH, no VM, no network, no credential. That the aggregate executes,
# that the API honours its query parameters, and that up.sh brings the cluster up are
# the operator's first manual run; CD.md says what to watch and what stays unverified.
#
#   sh backend/deploy/k8s/tests/pitch-cd-contract.sh
set -eu

# From backend/deploy/k8s/tests to the repository root.
cd "$(dirname "$0")/../../../.."

agg=.github/workflows/pitch-main-ci.yml
wf=.github/workflows/pitch-vm-cd.yml
overlay=backend/deploy/k8s/overlays/pitch
guide=$overlay/CD.md
readme=$overlay/README.md
gate=$overlay/cd/gate.sh
decisions=$overlay/cd/pitch_cd.py
unit=backend/deploy/k8s/tests/pitch_cd_contract_test.py
obsolete=$overlay/cd/window.sh

fail() {
	echo "FAIL: $1" >&2
	exit 1
}

for file in "$agg" "$wf" "$guide" "$gate" "$decisions" "$unit"; do
	[ -f "$file" ] || fail "missing $file"
done
# The path-rule inference is retired: the gate reads one authoritative workflow.
[ ! -e "$obsolete" ] ||
	fail "$obsolete must be gone: the CD no longer derives which workflows should have run"

# The line a phrase first appears on, for the ordering assertions. A phrase that
# begins with ^ is an anchored regular expression; anything else is a fixed string,
# because several of them contain shell syntax that a regex would reinterpret.
line_of() {
	if [ "$(printf '%s' "$1" | cut -c1)" = '^' ]; then
		grep -nE "$1" "$2" | head -n 1 | cut -d: -f1 || true
	else
		grep -nF "$1" "$2" | head -n 1 | cut -d: -f1 || true
	fi
}

before() {
	a=$(line_of "$1" "$3")
	b=$(line_of "$2" "$3")
	[ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ] ||
		fail "\`$1\` must appear above \`$2\` in $3 (line $a vs $b)"
}

count() {
	# -- so a pattern that starts with a dash is a pattern, not an option.
	grep -cE -- "$1" "$2" || true
}

# --- syntax of the helpers --------------------------------------------------
sh -n "$gate" || fail "gate.sh does not parse"
python3 - "$decisions" <<'PY' || fail "pitch_cd.py does not parse"
import ast
import sys

ast.parse(open(sys.argv[1], encoding="utf-8").read(), filename=sys.argv[1])
PY
# The CD contract runs inside main CI: no runner dependency may sneak in through the
# gate. The unit tests assert the exact stdlib import list; this is the same claim.
if grep -qE '^(import|from) ' "$decisions" | grep -vE '^(import|from) (argparse|json|re|sys|pathlib)\b'; then
	fail "pitch_cd.py must stay stdlib-only so the aggregate needs no extra runner dependency"
fi

# --- the CI slice's contract, delegated -------------------------------------
# The aggregate and the eight reusable bodies are checked by the CI slice's own
# contract: one implementation, and that slice keeps its checks when it lands
# without this one.
sh backend/deploy/k8s/tests/pitch-main-ci-contract.sh ||
	fail "the main-CI contract failed"

# The aggregate is the CI slice's file; this contract only asserts the one step
# this slice adds to it.
[ "$(count 'pitch-cd-contract.sh' "$agg")" -eq 1 ] ||
	fail "the aggregate must exercise the CD contract exactly once"

# --- the CD is dormant, main only, read-only and serialized ----------------
grep -qx 'on:' "$wf" || fail "the CD workflow has no block \`on:\`"
grep -q '^  push:$' "$wf" || fail "the automatic path must be a push trigger"
grep -q '^    branches: \[main\]$' "$wf" || fail "the push trigger must be main only"
grep -q '^  workflow_dispatch:$' "$wf" || fail "the manual path must be workflow_dispatch"
if grep -qE '^  (pull_request|pull_request_target|workflow_run|schedule|release):' "$wf"; then
	fail "a trigger other than push/workflow_dispatch would reach a branch or a PR"
fi
[ "$(count 'vars.PITCH_CD_ENABLE_MANUAL' "$wf")" -ge 3 ] ||
	fail "PITCH_CD_ENABLE_MANUAL must gate the gate job twice and the deploy job once"
[ "$(count 'vars.PITCH_CD_ENABLE_AUTO' "$wf")" -ge 2 ] ||
	fail "PITCH_CD_ENABLE_AUTO must gate both jobs"
grep -q "vars.PITCH_CD_ENABLE_MANUAL == 'true' &&" "$wf" ||
	fail "the automatic path must require the manual opt-in first"
if grep -qE '^    inputs:$|github\.event\.inputs' "$wf"; then
	fail "an operator-supplied input would bypass the exact-SHA gate"
fi
[ "$(count '^    environment:$' "$wf")" -eq 1 ] ||
	fail "exactly one job may carry an environment (the deploy job)"
grep -q '^      name: pitch-cd$' "$wf" || fail "the environment must be named pitch-cd"
before '^  deploy:$' '^    environment:$' "$wf"
grep -q '^    concurrency:$' "$wf" || fail "concurrency must be a job-level group on deploy"
grep -q '^      group: pitch-vm-cd-deploy$' "$wf" || fail "the deploy concurrency group is not named"
grep -q '^      cancel-in-progress: false$' "$wf" ||
	fail "a deploy in progress must never be cancelled by a newer run"
[ "$(count '^    timeout-minutes:' "$wf")" -eq 2 ] ||
	fail "both CD jobs must be bounded by timeout-minutes"
[ "$(count '^  contents: read$' "$wf")" -eq 1 ] || fail "the workflow floor must be contents: read"
[ "$(count '^ *permissions:$' "$wf")" -eq 3 ] ||
	fail "the floor plus one replacement per job is 3 permission blocks"
# Both jobs read the run list; a deploy-only re-run re-verifies instead of inheriting.
[ "$(count '^      actions: read$' "$wf")" -eq 2 ] ||
	fail "both jobs read runs and must grant actions: read"
if grep -q ': write' "$wf"; then
	fail "no job in the CD workflow needs a write scope"
fi
unpinned=$(grep -nE '^ *uses: ' "$wf" | grep -vE '@[0-9a-f]{40}( |$)' || true)
[ -z "$unpinned" ] || fail "an action is not pinned to a 40-character SHA: $unpinned"
[ "$(count 'persist-credentials: false' "$wf")" -eq 2 ] ||
	fail "both checkouts must leave the token out of .git/config"
if grep -qE 'upload-artifact|download-artifact|actions/artifact' "$wf"; then
	fail "the CD workflow must not upload anything"
fi
if grep -qiE 'gcloud|firewall|0\.0\.0\.0|kubectl proxy|nodeport' "$wf"; then
	fail "opening the network or the cluster API is not this workflow's decision"
fi
if grep -qiE 'wrangler|pages deploy|build:pages' "$wf"; then
	fail "frontend Pages is out of scope for the pitch CD"
fi

# --- the gate consumes one exact-SHA run of the aggregate -------------------
[ "$(count 'CD_WORKFLOW_PATH: \.github/workflows/pitch-main-ci\.yml' "$wf")" -eq 2 ] ||
	fail "both jobs must name the authoritative aggregate"
[ "$(count 'gate\.sh fresh' "$wf")" -eq 2 ] ||
	fail "both jobs must re-check that main is still the run's SHA"
[ "$(count 'gate\.sh wait' "$wf")" -eq 2 ] ||
	fail "both jobs must wait for the aggregate's run"
if grep -qE 'window\.sh|expected\.txt|CD_EXPECTED_FILE|exclude pitch-vm-cd' "$wf"; then
	fail "the path-rule inference is retired and must not reappear in the CD workflow"
fi
# Canonical identity is pinned as literals in both privileged entry points, so a
# fork, a rename or another GitHub host must edit the file under review.
[ "$(count "github.repository == 'risaavedraf/firewatch-dev'" "$wf")" -eq 2 ] ||
	fail "both jobs must pin the canonical repository"
[ "$(count "github.server_url == 'https://github.com'" "$wf")" -eq 2 ] ||
	fail "both jobs must pin the canonical GitHub host"
[ "$(count 'CD_REPOSITORY: risaavedraf/firewatch-dev' "$wf")" -eq 2 ] ||
	fail "both jobs must query the pinned repository, not the event's"
grep -q '^      CD_CANONICAL_HOST: github.com$' "$wf" ||
	fail "the canonical host must be a pinned literal"
if grep -q 'CD_SERVER_URL' "$wf"; then
	fail "the host is pinned; it must not be derived from the event"
fi
if grep -q 'needs.gate.result' "$wf"; then
	fail "a deploy-only re-run must re-verify, not inherit the gate's result"
fi
grep -q '^    needs: gate$' "$wf" || fail "the deploy job must still order after the gate"
[ "$(count 'ref: \$\{{ github\.sha \}}' "$wf")" -eq 2 ] ||
	fail "both checkouts must name the SHA the run was created for"
grep -q 'actions/workflows/\$workflow_file/runs' "$gate" ||
	fail "the gate must send the workflow file name in the repo-scoped endpoint"
if grep -q 'actions/workflows/\$workflow/runs' "$gate"; then
	fail "the request must send the file name, not the full path"
fi
grep -q 'workflow_file=$(printf' "$gate" ||
	fail "the request must derive the workflow file name"
[ "$(count 'python3 "\$client"' "$gate")" -eq 2 ] ||
	fail "the gate must invoke Python through python3, once per decision"
bare=$(grep -nE '^[[:space:]]*"\$client"' "$gate" || true)
[ -z "$bare" ] || fail "a bare interpreter-less invocation remains: $bare"
# The documented path forms: canonical, @main/@refs/heads/main, and the
# repository-qualified form bound to this repository.
grep -q 'REF_SUFFIXES' "$decisions" || fail "the documented path forms are not modelled"
grep -q 'refs/heads/main' "$decisions" || fail "the @refs/heads/main form is missing"
grep -q 'f"{repository}/{workflow_path}{suffix}"' "$decisions" ||
	fail "the repository-qualified form must bind to this repository"
# A first-landing 404 is a registration lag inside the deadline; any other
# non-200 is a refusal, never green.
grep -q '\[ "\$status" = 404 \]' "$gate" || fail "a 404 must be retried inside the deadline"
grep -q '\[ "\$status" != 200 \]' "$gate" || fail "a non-200 must be refused"
grep -q 'never green' "$gate" || fail "the non-200 refusal must say it is never green"
for filter in 'head_sha=\$sha' 'branch=main' 'event=push' 'per_page=100'; do
	grep -q -- "$filter" "$gate" || fail "the gate query is missing $filter"
done
grep -q -- '--repository "\$repo"' "$gate" ||
	fail "the gate must check the repository identity of the answer"

# --- the reviewed bootstrap script is pinned before any SSH ----------------
grep -q 'PITCH_CD_BOOTSTRAP_SHA256: \${{ vars.PITCH_CD_BOOTSTRAP_SHA256 }}' "$wf" ||
	fail "the approved bootstrap-script pin is not part of the deploy"
grep -q 'actual=$(sha256sum backend/deploy/k8s/bootstrap-secrets.sh' "$wf" ||
	fail "the runner must hash the candidate's bootstrap-secrets.sh"
grep -q 'script_sha=$(sha256sum "\$deploy_dir/backend/deploy/k8s/bootstrap-secrets.sh"' "$wf" ||
	fail "the VM must hash the script that is about to run"
[ "$(count 'sha256sum .*bootstrap-secrets\.sh' "$wf")" -eq 2 ] ||
	fail "the reviewed-bytes pin must be checked on the runner and on the VM"
before 'bootstrap script must be the reviewed one' 'Run up.sh on the VM' "$wf"
before 'script_sha=$(sha256sum' '^ *bash up\.sh$' "$wf"
if grep -q 'PITCH_CD_APPROVED\|approved=true\|::add-mask::' "$wf"; then
	fail "no fabricated approval marker: the pin is the evidence"
fi

# --- SSH: key only, pinned host, no forwarding, no password ----------------
for option in BatchMode=yes IdentitiesOnly=yes StrictHostKeyChecking=yes \
	PasswordAuthentication=no KbdInteractiveAuthentication=no \
	ForwardAgent=no ForwardX11=no ClearAllForwardings=yes \
	PermitLocalCommand=no UpdateHostKeys=no; do
	grep -q -- "-o $option" "$wf" || fail "the SSH call is missing -o $option"
done
grep -q -- '-o UserKnownHostsFile=' "$wf" || fail "the pinned known_hosts file is not passed"
if grep -qE 'StrictHostKeyChecking=(no|accept-new)|ssh-keyscan|sshpass|ssh-agent|ForwardAgent=yes' "$wf"; then
	fail "host-key verification must not be weakened and no agent may be forwarded"
fi
grep -q 'ssh-keygen -y -f "\$dir/id"' "$wf" ||
	fail "the supplied key must be checked before the connection is attempted"
[ "$(count '"\$PITCH_CD_SSH_KEY"' "$wf")" -eq 1 ] ||
	fail "the private key must be expanded exactly once, into the key file"
[ "$(count 'secrets.PITCH_CD_SSH_KEY' "$wf")" -eq 2 ] ||
	fail "the secret is bound twice: a presence check and the key file"
awk '/remote_status" -eq 255/{inside=1} inside{print; lines++} lines>8{exit}' "$wf" |
	grep -q 'remote state is unknown' ||
	fail "the exit-255 branch must say the remote state is unknown"
if awk '/remote_status" -eq 255/{inside=1} inside{print; lines++} lines>8{exit}' "$wf" |
	grep -q 'Nothing was deployed'; then
	fail "the exit-255 branch must not claim nothing was deployed: a remote 255 is ambiguous"
fi

# --- the CA pin is a certificate check, before and after up.sh -------------
grep -q 'PITCH_CD_CA_SHA256' "$wf" || fail "the active CA pin is not part of the deploy"
grep -q '#81' "$wf" || fail "the workflow must name the #81 boundary it enforces"
grep -q 'the active CA certificate must be the approved one' "$wf" ||
	fail "the CA pin must be described as a certificate check before up.sh"
grep -q 'the active CA certificate must still be the approved one' "$wf" ||
	fail "the CA pin must be described as a certificate check after up.sh"
before 'before_ca=$(ca_now)' '^ *bash up\.sh$' "$wf"
before '^ *bash up\.sh$' 'after_ca=$(ca_now)' "$wf"
grep -q '\[ "\$before_ca" = "\$ca_pin" \]' "$wf" ||
	fail "the CA must be refused before up.sh when it is not the approved one"
grep -q '\[ "\$after_ca" = "\$ca_pin" \]' "$wf" ||
	fail "the CA must be re-checked after up.sh"
if grep -qE 'kubectl .*rollout undo|git revert' "$wf"; then
	fail "a partial rollout must not be rolled back automatically"
fi

# --- operator values, canonical origin, clean checkout ---------------------
grep -qE '^ *check_params$' "$wf" || fail "the VM must validate the reused parameters"
for key in API_HOST AUTH_HOST WEB_ORIGIN ACME_EMAIL; do
	grep -q "param $key" "$wf" || fail "the VM does not read $key from the params file"
done
before '^ *check_params$' '^ *bash up\.sh$' "$wf"
grep -q 'git remote get-url origin' "$wf" || fail "the VM must read the effective origin"
grep -q 'git config --get remote.origin.url' "$wf" ||
	fail "the VM must read the configured origin"
grep -q 'effective_origin=$(git remote get-url origin)' "$wf" ||
	fail "the VM must compare the effective origin"
for form in 'canonical_https="https://$host/$repo"' \
	'canonical_scp="git@$host:$repo"' 'canonical_ssh="ssh://git@$host/$repo"'; do
	grep -qF -- "$form" "$wf" || fail "the canonical origin forms are incomplete: $form"
done
[ "$(count 'for origin in "\$configured_origin" "\$effective_origin"' "$wf")" -eq 1 ] ||
	fail "both the configured and the effective URL must be checked"
grep -q 'git config --get http.sslVerify' "$wf" ||
	fail "the VM must refuse sslVerify=false"
grep -q 'GIT_SSL_NO_VERIFY' "$wf" ||
	fail "the VM must refuse a session that disables certificate verification"
grep -q 'is not one of' "$wf" || fail "a non-canonical origin must be refused"
if grep -qE 'origin_host|slug=' "$wf"; then
	fail "a tail match is not a complete-URL check"
fi
grep -q 'git status --porcelain --ignored' "$wf" ||
	fail "the deploy checkout must be checked clean, untracked and ignored files included"
grep -q 'FETCH_HEAD' "$wf" || fail "the VM must compare the fetch through FETCH_HEAD"
grep -q 'git checkout --detach "\$sha"' "$wf" ||
	fail "the deploy checkout must be detached at the candidate SHA"
[ "$(count '^ *bash up\.sh$' "$wf")" -eq 1 ] ||
	fail "bash up.sh must be the only deployment path, exactly once"
if grep -qE 'git (pull|push|reset|clean|rebase|stash)|checkout -- |--force' "$wf"; then
	fail "the deploy checkout is updated with fetch + checkout --detach only; no destructive git"
fi
grep -q 'deploy_dir=\$HOME/firewatch-cd/checkout' "$wf" ||
	fail "the deploy checkout must be the dedicated \$HOME/firewatch-cd/checkout"
# The canonical repository slug contains `firewatch-dev`; what must never appear is
# the operator's working checkout path.
if grep -qE 'HOME/firewatch-dev|~/firewatch-dev|firewatch-dev/backend' "$wf"; then
	fail "the workflow must never name the operator's working checkout"
fi

# --- read-only verification against an explicit kind context ---------------
grep -q 'context=kind-firewatch' "$wf" || fail "the kind context is not explicit"
without_context=$(grep -nE '(^|[[:space:]])kubectl +(-|get |rollout |apply |delete |patch |scale |edit |create )' "$wf" |
	grep -v -- '--context' || true)
[ -z "$without_context" ] || fail "a kubectl call does not name its context: $without_context"
if grep -q 'kubectl config use-context' "$wf"; then
	fail "this workflow must not switch the operator's current context"
fi
if grep -qE 'kubectl .*\b(apply|delete|scale|edit|patch|create)\b' "$wf"; then
	fail "the wrapper verifies read-only; only up.sh changes the cluster"
fi
grep -q 'rollout status' "$wf" || fail "the rollout must be read back after up.sh"
grep -q 'health/ready' "$wf" || fail "the public edge must be read back after up.sh"
grep -q 'last-deployed' "$wf" || fail "the informational state marker is missing"

# --- shell inside the CD workflow: every run block and the remote script ----
blocks=$(grep -cE '^ *run: \|$' "$wf" || true)
[ "$blocks" -ge 1 ] || fail "expected at least 1 run block in $wf, found $blocks"
block=1
while [ "$block" -le "$blocks" ]; do
	# The leading-space width comes from RLENGTH, not from match()'s return
	# value: using the position made the extraction empty and bash -n pass on
	# nothing. A blank line stays inside the block scalar; a line at or above
	# the key's indentation ends it.
	script=$(awk -v want="$block" '
		match($0, /^ *run: \|$/) { n++; indent = RLENGTH - 6; active = 1; next }
		active {
			if ($0 ~ /^[[:space:]]*$/) { if (n == want) print ""; next }
			match($0, /^ */)
			if (RLENGTH <= indent) { active = 0; next }
			if (n == want) print substr($0, indent + 3)
		}
	' "$wf")
	[ -n "$script" ] || fail "run block $block of $wf extracted empty"
	printf '%s\n' "$script" | bash -n - || fail "run block $block of $wf does not parse"
	block=$((block + 1))
done
# The heredoc body is a program of its own, and it only ever runs on the VM.
remote=$(awk "/<<'REMOTE'/ { body = 1; next } /^ *REMOTE *$/ { body = 0 } body" "$wf")
[ "$(printf '%s\n' "$remote" | wc -l)" -gt 20 ] ||
	fail "the remote script did not extract; the VM-side program was not checked"
printf '%s\n' "$script" | bash -n - || fail "run block $block of $workflow does not parse"
remote_other=$(printf '%s\n' "$remote" | grep -nE '^ *(bash|sh) [A-Za-z0-9_./-]+\.sh' | grep -v 'bash up\.sh' || true)
[ -z "$remote_other" ] || fail "the VM-side script runs a second shell path: $remote_other"

# --- the guide the teammate follows ---------------------------------------
for phrase in 'PITCH_CD_ENABLE_MANUAL' 'PITCH_CD_ENABLE_AUTO' 'PITCH_CD_SSH_KEY' \
	'PITCH_CD_KNOWN_HOSTS' 'PITCH_CD_CA_SHA256' 'PITCH_CD_BOOTSTRAP_SHA256' \
	'pitch-cd' '~/.firewatch-pitch.env' 'firewatch-cd/checkout' '#81' 'up.sh' \
	'known_hosts' '[host]:puerto' 'docker start firewatch-control-plane' \
	'~/.firewatch-internal-ca/ca.key' 'docker compose down' \
	'runner alojado por GitHub' 'revisores' 'no cancela' \
	'pitch-main-ci.yml' 'workflow_call' 'aggregate' 'dos veces' \
	'alias' 'espejo' 'GIT_SSL_NO_VERIFY' 'certificado público' \
	'nombre de archivo' '@refs/heads/main' 'calificada por' 'HTTP 404' \
	'smoke de preactivación' 'risaavedraf/firewatch-dev' \
	'URL completa' 'git config --get remote.origin.url' 'url.*.insteadOf' \
	'http.sslVerify' 'comprobación de configuración' 'python3' \
	'política del' 'solo se ejecuta' 'creación posterior' \
	'run_attempt' 'skipped' 'irreductible' 'desconocido' 'esté sirviendo el SHA' \
	'events-that-trigger-workflows' 'rest/actions/workflow-runs' \
	'No se revierte'; do
	grep -qF "$phrase" "$guide" || fail "CD.md does not mention \`$phrase\`"
done
grep -qF 'CD.md' "$readme" || fail "README.md does not point at CD.md"
grep -qF 'Lo que no se ha ejecutado' "$guide" ||
	fail "CD.md must declare what was not observed"

# --- the gate's decisions, on their own -------------------------------------
python3 "$unit" -q || fail "the pitch CD gate contract tests failed"

echo "PASS: the CD consumes one validated exact-SHA aggregate run with no path inference; the CA and bootstrap pins hold; the guide documents activation, limits and what was not observed; the CI contract's checks passed by delegation"
