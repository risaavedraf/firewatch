#!/usr/bin/env sh
# Contract for the CA preflight in bootstrap-secrets.sh.
#
# What this checks and what it does not: it runs the public bootstrap command
# against a strict kubectl stub and synthetic OpenSSL material, and asserts that
# the two #81 states are refused before any persistent write:
#
#   * a file (or symlink) already at FIREWATCH_CA_KEY while the cluster has no
#     firewatch-ca Secret, and
#   * an existing firewatch-ca whose ca.crt does not match the local key.
#
# It also asserts that an unreadable Secret is not mistaken for an absence, that
# invalid key/certificate material fails closed, that signing uses a private
# staging snapshot under the operator path rather than a later read, that an
# atomic create-only link never replaces an existing file, symlink or directory,
# that staging directory writeability is preflighted before namespace/Secret
# writes and leaves no partial key, and that a rejected CA Secret create is
# reported as matching, absent in the target namespace, conflict or unknown
# without deleting or adopting either authority, with a public-key-only
# comparison recipe on recovery exits. The stub never connects to a cluster: reads are
# answered from fixture files and every mutation is recorded, then either
# refused (rejection cases) or emulated in the case's own state directory. No
# container, namespace, Secret, key or certificate outside the scratch tree is
# touched. What it does not prove is kubectl's real `--ignore-not-found`
# semantics against a live API server, or cross-system atomicity between the
# local key and the Secret; neither is claimed.
#
#   sh backend/deploy/k8s/tests/bootstrap-ca-preflight-contract.sh
set -eu

cd "$(dirname "$0")/.."
script="${BOOTSTRAP_SCRIPT:-$PWD/bootstrap-secrets.sh}"
[ -f "$script" ] || {
	echo "FAIL: $script not found" >&2
	exit 1
}
command -v openssl >/dev/null 2>&1 || {
	echo "FAIL: openssl is required" >&2
	exit 1
}

fail() {
	echo "FAIL: $1" >&2
	exit 1
}

# The script resolves repo_root from its own location, so run the committed
# script rather than a copy at a different depth. Only the scratch tree is
# writable: the key path is always inside it, and the stub answers every kubectl
# call without a cluster.
native_path() {
	if command -v cygpath >/dev/null 2>&1; then
		cygpath -m "$1"
	else
		printf '%s\n' "$1"
	fi
}

scratch=$(native_path "$(mktemp -d)") || fail "mktemp -d: cannot create the scratch tree"
trap 'rm -rf "$scratch"' EXIT

stub="$scratch/kubectl"
# A mktemp wrapper lets a case fail staging creation without a production hook;
# it also gives Git Bash a Windows-shaped workdir native openssl can open. The
# openssl wrapper lets a case make the local key appear at publication. Both
# delegate to the real tools.
shim_dir="$scratch/bin"
case "$(uname -s 2>/dev/null || echo unknown)" in
	MINGW*|MSYS*|CYGWIN*)
		shim_dir="$(cygpath -u "$scratch")/bin"
		;;
esac
mkdir -p "$shim_dir"
real_mktemp=$(command -v mktemp)
cat >"$shim_dir/mktemp" <<'MKTEMP'
#!/usr/bin/env sh
if [ "${STUB_FAIL_STAGING:-0}" = 1 ]; then
	case "$*" in
		*"firewatch-ca.staging"*|*"firewatch-ca.key"*) exit 1 ;;
	esac
fi
if [ "${1:-}" = "-d" ] && [ "$#" -eq 1 ]; then
	dir=$("$REAL_MKTEMP" -d) || exit 1
	if command -v cygpath >/dev/null 2>&1; then
		cygpath -m "$dir"
	else
		printf '%s\n' "$dir"
	fi
	exit 0
fi
exec "$REAL_MKTEMP" "$@"
MKTEMP
chmod +x "$shim_dir/mktemp"
real_openssl=$(command -v openssl)
cat >"$shim_dir/openssl" <<'OPENSSL'
#!/usr/bin/env sh
if [ "${STUB_APPEAR_STAGE:-}" = openssl ] && [ -n "${STUB_APPEAR_KEY:-}" ]; then
	case "$*" in
		*"req -x509"*)
			"$REAL_OPENSSL" "$@" || exit $?
			printf '%s\n' 'APPEARED-KEY-MATERIAL' >"$STUB_APPEAR_KEY"
			exit 0
			;;
	esac
fi
if [ "${STUB_APPEAR_STAGE:-}" = openssl-dir ] && [ -n "${STUB_APPEAR_KEY:-}" ]; then
	case "$*" in
		*"req -x509"*)
			"$REAL_OPENSSL" "$@" || exit $?
			mkdir "$STUB_APPEAR_KEY"
			exit 0
			;;
	esac
fi
exec "$REAL_OPENSSL" "$@"
OPENSSL
chmod +x "$shim_dir/openssl"

# A mkdir shim plays a concurrent winner and a chmod shim records every mode
# change. Together they demonstrate, without depending on this host honouring
# directory modes, whether a run secures a directory it did not create.
real_mkdir=$(command -v mkdir)
real_chmod=$(command -v chmod)
race_bin="$scratch/race-bin"
case "$(uname -s 2>/dev/null || echo unknown)" in
	MINGW*|MSYS*|CYGWIN*)
		race_bin="$(cygpath -u "$scratch")/race-bin"
		;;
esac
mkdir -p "$race_bin"
cat >"$race_bin/mkdir" <<'RACEMKDIR'
#!/usr/bin/env sh
# Plays the concurrent winner: when the script asks to create the operator
# directory, another process is taken to have created it a moment earlier, so
# the delegated call reports "already exists" exactly as a lost race does.
target=""
for arg in "$@"; do
	case "$arg" in
		-p) ;;
		*) target=$arg ;;
	esac
done
if [ -n "${RACE_DIR:-}" ] && [ "$target" = "$RACE_DIR" ] && [ ! -d "$RACE_DIR" ]; then
	"$REAL_MKDIR" -p "$RACE_DIR" || exit 1
	"$REAL_CHMOD" 750 "$RACE_DIR" || exit 1
	if [ -n "${RACE_WINNER_MARKER:-}" ]; then
		: >"$RACE_WINNER_MARKER"
	fi
fi
exec "$REAL_MKDIR" "$@"
RACEMKDIR
cat >"$race_bin/chmod" <<'RACECHMOD'
#!/usr/bin/env sh
printf '%s\n' "$*" >>"$RACE_CHMOD_LOG"
exec "$REAL_CHMOD" "$@"
RACECHMOD
chmod +x "$race_bin/mkdir" "$race_bin/chmod"

make_ca() {
	ca_prefix=$1
	common_name=$2
	MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
		-keyout "$(native_path "$ca_prefix.key")" \
		-out "$(native_path "$ca_prefix.crt")" \
		-subj "/CN=$common_name" >/dev/null 2>&1 ||
		fail "cannot generate the synthetic CA at $ca_prefix"
}

make_ca "$scratch/ca-a" firewatch-test-ca-a
make_ca "$scratch/ca-b" firewatch-test-ca-b
[ -s "$scratch/ca-a.key" ] || fail "the synthetic CA key ca-a.key was not created"
[ -s "$scratch/ca-b.key" ] || fail "the synthetic CA key ca-b.key was not created"
printf '%s\n' 'not a certificate' >"$scratch/not-a-cert.pem"

# The stub is a client, not a cluster. Reads come from the case fixture; writes
# are appended to mutations.log and refused with exit 97 when
# STUB_REFUSE_MUTATIONS=1, so a missing guard is observed without any write
# reaching the filesystem or a server.
cat >"$stub" <<'STUB'
#!/usr/bin/env sh
set -eu

log=${STUB_LOG:?STUB_LOG is required}
state=${STUB_STATE:?STUB_STATE is required}
mkdir -p "$state/secrets" "$state/data"

record() { printf '%s\n' "$*" >>"$log"; }

mutate() {
	if [ -n "${STUB_REPLACE_KEY_TARGET:-}" ] && [ ! -f "$state/replaced-key" ] &&
		[ "$*" = "create secret generic postgres-credentials" ]; then
		cp "$STUB_REPLACE_KEY_SOURCE" "$STUB_REPLACE_KEY_TARGET"
		: >"$state/replaced-key"
	fi
	if [ -n "${STUB_APPEAR_KEY:-}" ] && [ "${STUB_APPEAR_STAGE:-}" = credentials ] &&
		[ ! -f "$state/appeared-key" ] &&
		[ "$*" = "create secret generic postgres-credentials" ]; then
		printf '%s\n' 'APPEARED-KEY-MATERIAL' >"$STUB_APPEAR_KEY"
		: >"$state/appeared-key"
	fi
	if [ "${STUB_REFUSE_MUTATIONS:-0}" = 1 ]; then
		record "REFUSED $*"
		exit 97
	fi
	record "WRITE $*"
}

output=""
ignore=0
positional=""
literals=""
files=""
while [ "$#" -gt 0 ]; do
	case "$1" in
		--namespace|-n)
			shift 2
			;;
		--output|-o)
			output=$2
			shift 2
			;;
		--ignore-not-found)
			ignore=1
			shift
			;;
		--from-literal=*)
			literals="$literals
${1#*=}"
			shift
			;;
		--from-file=*)
			files="$files
${1#*=}"
			shift
			;;
		*)
			positional="$positional $1"
			shift
			;;
	esac
done
# shellcheck disable=SC2086 # the parser above only admits space-free words here
set -- $positional
verb=${1:-}
object=${2:-}

secret_present() {
	if [ -f "$state/secrets/$1" ]; then
		return 0
	fi
	if [ "$1" = firewatch-ca ] && [ "${STUB_CA_PRESENT:-no}" = yes ]; then
		return 0
	fi
	return 1
}

case "$verb" in
	get)
		case "$object" in
			namespace)
				name=$3
				if [ "${STUB_NAMESPACE_ERROR:-0}" = 1 ]; then
					echo "Error from server (Forbidden): namespaces is forbidden" >&2
					exit 1
				fi
				if [ "${STUB_NAMESPACE_PRESENT:-yes}" = yes ]; then
					printf 'namespace/%s\n' "$name"
					exit 0
				fi
				if [ "$ignore" = 1 ]; then
					exit 0
				fi
				printf 'Error from server (NotFound): namespaces "%s" not found\n' "$name" >&2
				exit 1
				;;
			secret)
				if [ -f "$state/ca-read-error" ]; then
					echo "Error from server (ServiceUnavailable): secrets read failed for test" >&2
					exit 1
				fi
				name=$3
				if [ "${STUB_LOOKUP_ERROR:-0}" = 1 ]; then
					printf 'Error from server (Forbidden): secrets "%s" is forbidden\n' "$name" >&2
					exit 1
				fi
				if ! secret_present "$name"; then
					if [ "$ignore" = 1 ]; then
						exit 0
					fi
					printf 'Error from server (NotFound): secrets "%s" not found\n' "$name" >&2
					exit 1
				fi
				case "$output" in
					jsonpath=*)
						key=${output#*data.}
						key=${key%\}}
						key=$(printf '%s' "$key" | tr -d '\\')
						if [ "$name" = firewatch-ca ] && [ "$key" = ca.crt ] &&
							[ -n "${STUB_CA_CERT:-}" ]; then
							reads=0
							if [ -f "$state/ca-cert-reads" ]; then
								reads=$(cat "$state/ca-cert-reads")
							fi
							reads=$((reads + 1))
							printf '%s\n' "$reads" >"$state/ca-cert-reads"
							cert=$STUB_CA_CERT
							if [ "$reads" -gt 1 ] && [ -n "${STUB_CA_CERT_SECOND:-}" ]; then
								cert=$STUB_CA_CERT_SECOND
							fi
							base64 <"$cert" | tr -d '\n'
							printf '\n'
							exit 0
						fi
						if [ -f "$state/data/$name/$key" ]; then
							base64 <"$state/data/$name/$key" | tr -d '\n'
							printf '\n'
							exit 0
						fi
						if [ "$name" = firewatch-ca ] && [ "$key" = ca.key ]; then
							exit 0
						fi
						printf 'stub: key %s missing from secret/%s\n' "$key" "$name" >&2
						exit 1
						;;
					name)
						printf 'secret/%s\n' "$name"
						exit 0
						;;
					*)
						printf '{}\n'
						exit 0
						;;
				esac
				;;
		esac
		;;
	create)
		case "$object" in
			namespace)
				mutate "create namespace $3"
				exit 0
				;;
			secret)
				name=$4
				if [ "$name" = firewatch-ca ] && [ -n "${STUB_FAIL_CA_CREATE:-}" ]; then
					case "$STUB_FAIL_CA_CREATE" in
						matching)
							mkdir -p "$state/secrets" "$state/data/firewatch-ca"
							: >"$state/secrets/firewatch-ca"
							printf '%s\n' "$files" | while IFS= read -r pair; do
								[ -n "$pair" ] || continue
								if [ "${pair%%=*}" = ca.crt ]; then
									cat "${pair#*=}" >"$state/data/firewatch-ca/ca.crt"
								fi
							done
							;;
						conflict)
							mkdir -p "$state/secrets" "$state/data/firewatch-ca"
							: >"$state/secrets/firewatch-ca"
							cp "$STUB_CA_CONFLICT_CERT" "$state/data/firewatch-ca/ca.crt"
							;;
						unknown)
							: >"$state/ca-read-error"
							;;
						malformed)
							mkdir -p "$state/secrets" "$state/data/firewatch-ca"
							: >"$state/secrets/firewatch-ca"
							cp "$STUB_BAD_CERT" "$state/data/firewatch-ca/ca.crt"
							;;
					esac
				if [ -n "${STUB_SWAP_KEY_SOURCE:-}" ] && [ -n "${STUB_SWAP_KEY_TARGET:-}" ]; then
					cp "$STUB_SWAP_KEY_SOURCE" "$STUB_SWAP_KEY_TARGET"
				fi
			record "FAILED create secret generic firewatch-ca"
					echo "stub: create secret generic firewatch-ca rejected for test" >&2
					exit 1
				fi
				mutate "create secret generic $name"
				mkdir -p "$state/secrets" "$state/data/$name"
				: >"$state/secrets/$name"
				printf '%s\n' "$literals" | while IFS= read -r pair; do
					[ -n "$pair" ] || continue
					key=${pair%%=*}
					value=${pair#*=}
					printf '%s' "$value" >"$state/data/$name/$key"
				done
				printf '%s\n' "$files" | while IFS= read -r pair; do
					[ -n "$pair" ] || continue
					key=${pair%%=*}
					path=${pair#*=}
					cat "$path" >"$state/data/$name/$key" || exit 1
				done
				exit 0
				;;
			configmap)
				printf 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: %s\n' "$3"
				exit 0
				;;
		esac
		;;
	apply)
		cat >/dev/null
		mutate "apply -f -"
		exit 0
		;;
esac

echo "stub: unsupported kubectl invocation: $*" >&2
exit 1
STUB
chmod +x "$stub"

case_dir=""
out=""
key_path=""
refuse=1
ca_present=no
ca_cert=""
ca_cert_second=""
replace_key_source=""
replace_key_target=""
swap_key_source=""
swap_key_target=""
run_path_prefix=""
race_dir=""
race_chmod_log=""
race_winner_marker=""
appear_key=""
appear_stage=""
fail_staging=0
fail_ca_create=""
ca_conflict_cert=""
lookup_error=0
namespace_present=yes
namespace_error=0

reset_stub_env() {
	refuse=1
	ca_present=no
	ca_cert=""
	ca_cert_second=""
	replace_key_source=""
	replace_key_target=""
	swap_key_source=""
	swap_key_target=""
	run_path_prefix=""
	race_dir=""
	race_chmod_log=""
	race_winner_marker=""
	appear_key=""
	appear_stage=""
	fail_staging=0
	fail_ca_create=""
	ca_conflict_cert=""
	lookup_error=0
	namespace_present=yes
	namespace_error=0
}

new_case() {
	case_dir="$scratch/$1"
	mkdir -p "$case_dir/state/secrets" "$case_dir/state/data"
	: >"$case_dir/mutations.log"
	out="$case_dir/output.txt"
	reset_stub_env
}

run_bootstrap() {
	if [ -n "$run_path_prefix" ]; then
		run_path="$shim_dir:$run_path_prefix:$PATH"
	else
		run_path="$shim_dir:$PATH"
	fi
	set +e
	KUBECTL="$stub" \
		FIREWATCH_CA_KEY="$key_path" \
		REAL_MKTEMP="$real_mktemp" \
		REAL_OPENSSL="$real_openssl" \
		STUB_LOG="$case_dir/mutations.log" \
		STUB_STATE="$case_dir/state" \
		STUB_REFUSE_MUTATIONS="$refuse" \
		STUB_CA_PRESENT="$ca_present" \
		STUB_CA_CERT="$ca_cert" \
		STUB_CA_CERT_SECOND="$ca_cert_second" \
		STUB_REPLACE_KEY_SOURCE="$replace_key_source" \
		STUB_REPLACE_KEY_TARGET="$replace_key_target" \
		STUB_SWAP_KEY_SOURCE="$swap_key_source" \
		STUB_SWAP_KEY_TARGET="$swap_key_target" \
		RACE_DIR="$race_dir" \
		RACE_CHMOD_LOG="$race_chmod_log" \
		RACE_WINNER_MARKER="$race_winner_marker" \
		REAL_MKDIR="$real_mkdir" \
		REAL_CHMOD="$real_chmod" \
		STUB_APPEAR_KEY="$appear_key" \
		STUB_APPEAR_STAGE="$appear_stage" \
		STUB_FAIL_STAGING="$fail_staging" \
		STUB_FAIL_CA_CREATE="$fail_ca_create" \
		STUB_CA_CONFLICT_CERT="$ca_conflict_cert" \
		STUB_BAD_CERT="$scratch/not-a-cert.pem" \
		STUB_LOOKUP_ERROR="$lookup_error" \
		STUB_NAMESPACE_PRESENT="$namespace_present" \
		STUB_NAMESPACE_ERROR="$namespace_error" \
		MSYS_NO_PATHCONV=1 \
		PATH="$run_path" \
		sh "$script" firewatch >"$out" 2>&1
	run_status=$?
	set -e
}

assert_status() {
	[ "$run_status" -eq "$1" ] ||
		fail "$2: expected exit $1, got $run_status; output was:
$(cat "$out")"
}

assert_contains() {
	grep -qF -- "$2" "$1" ||
		fail "$3: expected to find '$2' in:
$(cat "$1")"
}

assert_not_contains() {
	# Neither the pattern nor the asserted file is printed on failure: the
	# pattern may be private material and the asserted file is the output being
	# checked for it, so a diagnostic that dumps either turns a caught leak into
	# a logged one. The count locates the failure without reproducing anything.
	if grep -qF -- "$2" "$1"; then
		matches=$(grep -cF -- "$2" "$1" 2>/dev/null || true)
		fail "$3: $1 holds $matches line(s) matching the protected pattern; neither the pattern nor the file is printed"
	fi
}

assert_no_key_material() {
	# Proves a file does not reproduce a private key without capturing or
	# printing a body line: each non-header line is tested in turn, and a
	# failure names the source file and the line number only. The trailing CR is
	# stripped from the pattern because the shell's read keeps it while grep
	# removes it in text mode, so a CR-carrying pattern matches neither spelling
	# and every check against a CRLF key would pass without looking.
	key_file=$1
	checked_file=$2
	key_label=$3
	key_line=0
	key_cr=$(printf '\r')
	while IFS= read -r key_body || [ -n "$key_body" ]; do
		key_line=$((key_line + 1))
		key_body=${key_body%"$key_cr"}
		case "$key_body" in
			''|-----BEGIN*|-----END*) continue ;;
		esac
		if grep -qF -- "$key_body" "$checked_file"; then
			fail "$key_label: $checked_file reproduces line $key_line of the private key at $key_file (the line is deliberately not printed)"
		fi
	done <"$key_file"
}

assert_no_mutations() {
	if [ -s "$case_dir/mutations.log" ]; then
		printf '%s\n' "--- $case_dir/mutations.log ---" >&2
		cat "$case_dir/mutations.log" >&2
		fail "$1: a persistent write was attempted before the guard refused"
	fi
}

assert_same() {
	cmp -s "$1" "$2" || fail "$3: the file at $1 changed"
}

assert_key_unchanged() {
	assert_same "$key_path" "$case_dir/original.key" "$1"
}

assert_no_ca_staging() {
	found=$(find "$case_dir" \( -name '.firewatch-ca.staging.*' -o -name '.firewatch-ca.key.*' \) -print 2>/dev/null || true)
	[ -z "$found" ] || fail "$1: private staging path left at $found"
}

# --- 0) the contract's own failure messages never reproduce material -------
# A guard that prints what it caught turns a caught leak into a logged one, so
# the diagnostics are asserted too: a failing negative assertion may name the
# file and the count, never the pattern it matched, and a private-key guard may
# name the source line, never the bytes.
new_case assertion-diagnostic-hygiene
needle='-SYNTHETIC-PROTECTED-VALUE-'
assert_input="$case_dir/asserted-file.txt"
assert_message="$case_dir/assertion-message.txt"
printf '%s\n' 'context line before' "$needle" 'context line after' >"$assert_input"
set +e
(
	assert_not_contains "$assert_input" "$needle" "diagnostic hygiene"
) >"$assert_message" 2>&1
meta_status=$?
set -e
[ "$meta_status" -ne 0 ] ||
	fail "diagnostic hygiene: the negative assertion accepted a present pattern"
if grep -qF -- "$needle" "$assert_message"; then
	fail "diagnostic hygiene: the failure message reproduced the pattern it matched"
fi
if grep -qF -- 'context line after' "$assert_message"; then
	fail "diagnostic hygiene: the failure message dumped the asserted file"
fi
echo "PASS: a failing negative assertion names the file and the count, never the pattern or the asserted file"

new_case assertion-private-material
leak_output="$case_dir/leaked.txt"
private_message="$case_dir/private-message.txt"
# A script that printed the key is simulated by copying the fixture into the
# output file; the guard has to fail without reproducing any of it.
cp "$scratch/ca-b.key" "$leak_output"
set +e
(
	assert_no_key_material "$scratch/ca-b.key" "$leak_output" "private material"
) >"$private_message" 2>&1
meta_status=$?
set -e
[ "$meta_status" -ne 0 ] ||
	fail "private material: the guard accepted an output that reproduces the private key"
grep -qF "reproduces line 2 of the private key" "$private_message" ||
	fail "private material: the failure did not name the reproduced source line (message not printed)"
assert_no_key_material "$scratch/ca-b.key" "$private_message" "private material message"
echo "PASS: a private-key guard reports the source line without reproducing the key"

# --- A) preflight staging directory writeability ----------------------------
new_case staging-failure
key_path="$case_dir/ca.key"
namespace_present=no
fail_staging=1
run_bootstrap
assert_status 1 "staging failure"
assert_contains "$out" "cannot create a private staging" "staging failure"
assert_contains "$out" "No Secret or namespace was written" "staging failure"
assert_not_contains "$out" "may already have been written" "staging failure"
assert_not_contains "$out" "Nothing has been written" "staging failure"
assert_no_mutations "staging failure"
[ ! -e "$key_path" ] || fail "staging failure: a key was created at $key_path"
assert_no_ca_staging "staging failure"

# --- B) existing-key staging failure stops before any write -----------------
new_case existing-staging-failure
key_path="$case_dir/ca.key"
cp "$scratch/ca-a.key" "$key_path"
cp "$key_path" "$case_dir/original.key"
ca_present=yes
ca_cert="$scratch/ca-a.crt"
fail_staging=1
run_bootstrap
assert_status 1 "existing staging failure"
assert_contains "$out" "cannot create a private staging" "existing staging failure"
assert_contains "$out" "No Secret or namespace was written" "existing staging failure"
assert_no_mutations "existing staging failure"
assert_key_unchanged "existing staging failure"
assert_no_ca_staging "existing staging failure"


# --- C) an existing operator directory keeps its mode -----------------------
new_case operator-dir-mode
operator_dir="$case_dir/operator"
mkdir -p "$operator_dir"
chmod 750 "$operator_dir"
before_mode=$(stat -c %a "$operator_dir" 2>/dev/null || true)
key_path="$operator_dir/ca.key"
namespace_present=no
refuse=0
run_bootstrap
assert_status 0 "operator directory mode"
[ -s "$key_path" ] || fail "operator directory mode: the key was not created at $key_path"
after_mode=$(stat -c %a "$operator_dir" 2>/dev/null || true)
if [ -n "$before_mode" ] && [ "$before_mode" = 750 ] && [ -n "$after_mode" ]; then
	[ "$after_mode" = 750 ] || fail "operator directory mode: the existing directory mode changed from 750 to $after_mode"
	echo "PASS: existing operator directory mode preserved (750)"
else
	echo "SKIP: operator directory mode preservation (stat/chmod mode not effective on this host)"
fi
assert_no_ca_staging "operator directory mode"

# --- D) a non-writable operator directory aborts before any write -----------
new_case operator-dir-readonly
operator_dir="$case_dir/operator"
mkdir -p "$operator_dir"
chmod 550 "$operator_dir"
before_mode=$(stat -c %a "$operator_dir" 2>/dev/null || true)
key_path="$operator_dir/ca.key"
namespace_present=no
if [ -w "$operator_dir" ]; then
	echo "SKIP: read-only operator directory (effective user can write)"
else
	run_bootstrap
	assert_status 1 "read-only operator directory"
	assert_contains "$out" "exists but is not writable" "read-only operator directory"
	assert_contains "$out" "No Secret or namespace was written" "read-only operator directory"
	assert_no_mutations "read-only operator directory"
	[ ! -e "$key_path" ] || fail "read-only operator directory: a key was created at $key_path"
	after_mode=$(stat -c %a "$operator_dir" 2>/dev/null || true)
	if [ -n "$before_mode" ] && [ -n "$after_mode" ]; then
		[ "$after_mode" = "$before_mode" ] || fail "read-only operator directory: the mode changed from $before_mode to $after_mode"
	fi
	assert_no_ca_staging "read-only operator directory"
	echo "PASS: non-writable operator directory aborted before namespace/Secret writes"
fi

# --- 1) local path present, cluster CA absent -------------------------------
# The marker is not valid key material on purpose: presence alone is the
# ambiguous state, and the guard must not need to read the file to refuse. The
# namespace is absent as well, so a guard placed after namespace creation would
# be caught by the mutation log before anything reached the key path. The empty
# variant proves presence is `-e`, not `-s`.
for variant in marker empty; do
	new_case "key-present-$variant"
	key_path="$case_dir/ca.key"
	if [ "$variant" = marker ]; then
		printf '%s\n' 'SENTINEL-PRIVATE-KEY-MATERIAL' >"$key_path"
	else
		: >"$key_path"
	fi
	cp "$key_path" "$case_dir/original.key"
	namespace_present=no
	run_bootstrap
	label="local path present ($variant), CA absent"
	assert_status 1 "$label"
	assert_contains "$out" "already exists" "$label"
	assert_contains "$out" "secret/firewatch-ca" "$label"
	assert_contains "$out" "$key_path" "$label"
	assert_contains "$out" "rotate the authority deliberately" "$label"
	assert_contains "$out" "Nothing has been written" "$label"
	assert_contains "$out" "does not belong to any CA" "$label"
	assert_contains "$out" "residue from an earlier run or a key you supplied" "$label"
	assert_contains "$out" "Re-running refuses while this path exists" "$label"
	assert_contains "$out" "do not delete, adopt or retry blindly" "$label"
	assert_contains "$out" "openssl pkey" "$label"
	assert_contains "$out" "-pubout" "$label"
	assert_contains "$out" "openssl x509" "$label"
	assert_contains "$out" "-pubkey" "$label"
	assert_contains "$out" "cmp -s" "$label"
	assert_not_contains "$out" "delete secret/firewatch-ca" "$label"
	assert_not_contains "$out" "README.md:196" "$label"
	assert_not_contains "$out" "README.md:190-196" "$label"
	if [ "$variant" = marker ]; then
		assert_not_contains "$out" "SENTINEL-PRIVATE-KEY-MATERIAL" "$label"
	fi
	assert_no_mutations "$label"
	assert_key_unchanged "$label"
done

# --- 2) a symlink is still the operator's path ------------------------------
# A dangling symlink is only visible to -L, not to -e.
new_case symlink-key-ca-absent
key_path="$case_dir/ca.key"
ln -s "$case_dir/no-such-target" "$key_path" 2>/dev/null || true
if [ -L "$key_path" ]; then
	run_bootstrap
	assert_status 1 "symlink at the local path, CA absent"
	assert_contains "$out" "already exists" "symlink at the local path, CA absent"
	assert_no_mutations "symlink at the local path, CA absent"
	[ -L "$key_path" ] || fail "symlink at the local path, CA absent: the symlink was replaced"
else
	echo "SKIP: symlink at the local path (this host cannot create one); the empty-file case covers presence"
fi

# --- 3) cluster CA present, local key from a different authority -----------
new_case mismatched-key
key_path="$case_dir/ca.key"
cp "$scratch/ca-b.key" "$key_path"
cp "$key_path" "$case_dir/original.key"
MSYS_NO_PATHCONV=1 openssl pkey -in "$(native_path "$key_path")" -noout >/dev/null 2>&1 ||
	fail "test fixture: the copied key at $key_path is not readable by openssl"
ca_present=yes
ca_cert="$scratch/ca-a.crt"
run_bootstrap
assert_status 1 "key/cert mismatch"
assert_contains "$out" "does not belong" "key/cert mismatch"
assert_contains "$out" "$key_path" "key/cert mismatch"
assert_contains "$out" "secret/firewatch-ca" "key/cert mismatch"
assert_contains "$out" "rotate the authority deliberately" "key/cert mismatch"
assert_contains "$out" "Nothing has been written" "key/cert mismatch"
assert_no_key_material "$key_path" "$out" "key/cert mismatch"
assert_no_mutations "key/cert mismatch"
assert_key_unchanged "key/cert mismatch"
assert_no_ca_staging "key/cert mismatch"

# --- 4) invalid local key with a cluster CA --------------------------------
new_case invalid-key
key_path="$case_dir/ca.key"
printf '%s\n' 'SENTINEL-PRIVATE-KEY-MATERIAL' >"$key_path"
cp "$key_path" "$case_dir/original.key"
ca_present=yes
ca_cert="$scratch/ca-a.crt"
run_bootstrap
assert_status 1 "invalid local key"
assert_contains "$out" "cannot read a public key" "invalid local key"
assert_contains "$out" "Nothing has been written" "invalid local key"
assert_not_contains "$out" "SENTINEL-PRIVATE-KEY-MATERIAL" "invalid local key"
assert_no_mutations "invalid local key"
assert_key_unchanged "invalid local key"
assert_no_ca_staging "invalid local key"

# --- 5) invalid ca.crt with a local key ------------------------------------
new_case invalid-ca-cert
key_path="$case_dir/ca.key"
cp "$scratch/ca-a.key" "$key_path"
cp "$key_path" "$case_dir/original.key"
ca_present=yes
ca_cert="$scratch/not-a-cert.pem"
run_bootstrap
assert_status 1 "invalid ca.crt"
assert_contains "$out" "is not a certificate" "invalid ca.crt"
assert_contains "$out" "Nothing has been written" "invalid ca.crt"
assert_no_mutations "invalid ca.crt"
assert_key_unchanged "invalid ca.crt"
assert_no_ca_staging "invalid ca.crt"

# --- 6) an API read error is not an absence --------------------------------
# The local path is absent, so a script that treats the failed read as "no CA"
# would mint an authority. The error must stop it instead.
new_case lookup-error
key_path="$case_dir/ca.key"
lookup_error=1
run_bootstrap
assert_status 1 "failed Secret lookup"
assert_contains "$out" "cannot read secret/firewatch-ca" "failed Secret lookup"
assert_contains "$out" "cluster state is unknown" "failed Secret lookup"
assert_no_mutations "failed Secret lookup"
[ ! -e "$key_path" ] || fail "failed Secret lookup: a key was created at $key_path"

# --- 7) a namespace read error is not an absence -------------------------
new_case namespace-lookup-error
key_path="$case_dir/ca.key"
namespace_error=1
run_bootstrap
assert_status 1 "failed namespace lookup"
assert_contains "$out" "cannot read namespace/firewatch" "failed namespace lookup"
assert_contains "$out" "cluster state is unknown" "failed namespace lookup"
assert_no_mutations "failed namespace lookup"
[ ! -e "$key_path" ] || fail "failed namespace lookup: a key was created at $key_path"

# --- 8) the preflight snapshot is what signs -------------------------------
# The cluster CA changes to ca-b on any second read, and an external actor
# replaces the local key with ca-b during credential creation. A script that
# re-reads either after the preflight signs with the wrong authority; one that
# uses the validated ca-a key/cert snapshot succeeds.
new_case snapshot-consistency
key_path="$case_dir/ca.key"
cp "$scratch/ca-a.key" "$key_path"
ca_present=yes
ca_cert="$scratch/ca-a.crt"
ca_cert_second="$scratch/ca-b.crt"
replace_key_target="$key_path"
replace_key_source="$scratch/ca-b.key"
refuse=0
run_bootstrap
assert_status 0 "preflight snapshot"
assert_contains "$out" "done." "preflight snapshot"
assert_no_ca_staging "preflight snapshot"
assert_same "$case_dir/state/data/postgres-tls/ca.crt" "$scratch/ca-a.crt" "preflight snapshot: signing used a freshly read cluster CA"
assert_same "$key_path" "$scratch/ca-b.key" "preflight snapshot: the script overwrote the externally replaced local key"
[ "$(cat "$case_dir/state/ca-cert-reads")" = 1 ] ||
	fail "preflight snapshot: the cluster ca.crt was read more than once"
assert_no_key_material "$key_path" "$out" "preflight snapshot"

# --- 9) a local path appearing after the preflight is refused accurately --
# Credentials have already been written by this stage, so the message must not
# claim that nothing was written. The modes cover the write-site guard, a path
# appearing during CA generation, and a directory appearing at the destination.
for stage in credentials openssl openssl-dir; do
	new_case "late-local-key-$stage"
	appear_stage=$stage
	key_path="$case_dir/ca.key"
	appear_key="$key_path"
	printf '%s\n' 'APPEARED-KEY-MATERIAL' >"$case_dir/appeared.key"
	refuse=0
	run_bootstrap
	assert_status 1 "local key appeared ($stage)"
	case "$stage" in
		credentials) assert_contains "$out" "already exists" "local key appeared (credentials)" ;;
		openssl|openssl-dir) assert_contains "$out" "cannot publish the new CA key" "local key appeared ($stage)" ;;
	esac
	assert_contains "$out" "may already have been written" "local key appeared ($stage)"
	assert_not_contains "$out" "Nothing has been written" "local key appeared ($stage)"
	if [ "$stage" = openssl-dir ]; then
		[ -d "$key_path" ] || fail "local key appeared ($stage): the destination directory was replaced"
		[ -z "$(find "$key_path" -mindepth 1 -print -quit)" ] ||
			fail "local key appeared ($stage): the publication created an entry inside the destination directory"
	else
		assert_same "$key_path" "$case_dir/appeared.key" "local key appeared ($stage): the appeared key was replaced"
	fi
	assert_contains "$case_dir/mutations.log" "WRITE create secret generic postgres-credentials" "local key appeared ($stage)"
	assert_not_contains "$case_dir/mutations.log" "firewatch-ca" "local key appeared ($stage)"
	assert_no_ca_staging "local key appeared ($stage)"
done

# --- 12) CA Secret create failures are classified read-only -----------------
# The publish succeeded, so the key exists; the create fails and the script
# distinguishes matching, absent, conflict and unknown without deleting or
# adopting either authority.
for mode in absent matching conflict unknown malformed; do
	new_case "ca-create-$mode"
	key_path="$case_dir/ca.key"
	fail_ca_create=$mode
	ca_conflict_cert="$scratch/ca-b.crt"
	refuse=0
	run_bootstrap
	label="CA create ($mode)"
	case "$mode" in
		absent) expected=11 ;;
		matching) expected=10 ;;
		conflict) expected=12 ;;
		unknown) expected=13 ;;
		malformed) expected=14 ;;
	esac
	assert_status "$expected" "$label"
	assert_contains "$out" "rejected for test" "$label"
	case "$mode" in
		absent)
			assert_contains "$out" "no matching CA in namespace/firewatch" "$label"
			assert_contains "$out" "does not belong to any CA" "$label"
			assert_contains "$out" "residue from an earlier run or a key you supplied" "$label"
			assert_contains "$out" "Re-running refuses while this path exists" "$label"
			assert_contains "$out" "do not delete, adopt or retry blindly" "$label"
			assert_contains "$out" "openssl pkey" "$label"
			assert_contains "$out" "-pubout" "$label"
			assert_contains "$out" "openssl x509" "$label"
			assert_contains "$out" "-pubkey" "$label"
			assert_contains "$out" "cmp -s" "$label"
			;;
		matching) assert_contains "$out" "matching the preserved key" "$label" ;;
		conflict) assert_contains "$out" "does not match the preserved key" "$label" ;;
		unknown) assert_contains "$out" "could not determine" "$label" ;;
		malformed)
			assert_contains "$out" "verification could not complete" "$label"
			assert_contains "$out" "No mismatch conclusion was drawn" "$label"
			;;
	esac
	assert_contains "$out" "new CA key is intact at $key_path" "$label"
	assert_not_contains "$out" "Nothing has been written" "$label"
	assert_not_contains "$out" "delete secret/firewatch-ca" "$label"
	assert_contains "$case_dir/mutations.log" "FAILED create secret generic firewatch-ca" "$label"
	assert_not_contains "$case_dir/mutations.log" "WRITE create secret generic firewatch-ca" "$label"
	[ -s "$key_path" ] || fail "$label: the published key is missing at $key_path"
	MSYS_NO_PATHCONV=1 openssl pkey -in "$(native_path "$key_path")" -noout >/dev/null 2>&1 ||
		fail "$label: the published key at $key_path is not a private key"
	if [ "$mode" = matching ] || [ "$mode" = conflict ]; then
		MSYS_NO_PATHCONV=1 openssl pkey -in "$(native_path "$key_path")" -pubout \
			-out "$(native_path "$case_dir/local.pub")" >/dev/null 2>&1 ||
			fail "$label: cannot derive the local public key"
		MSYS_NO_PATHCONV=1 openssl x509 -in "$(native_path "$case_dir/state/data/firewatch-ca/ca.crt")" \
			-pubkey -noout -out "$(native_path "$case_dir/secret.pub")" >/dev/null 2>&1 ||
			fail "$label: cannot derive the Secret public key"
		if [ "$mode" = matching ]; then
			cmp -s "$case_dir/local.pub" "$case_dir/secret.pub" ||
				fail "$label: the local key and Secret certificate are not a verified pair"
		elif cmp -s "$case_dir/local.pub" "$case_dir/secret.pub"; then
			fail "$label: the conflicting Secret unexpectedly matches the local key"
		fi
	fi
	assert_no_ca_staging "$label"
done
echo "PASS: CA create recovery exits matching=10 absent=11 conflict=12 unknown=13 verification=14"

# --- 12b) a replaced local key against a matching Secret is a conflict -----
# The failed create leaves a Secret carrying the new ca.crt, so the read-only
# check finds a cluster CA matching the new certificate, while an external
# actor has replaced the published operator key with a key from another
# authority. That is a confirmed mismatch and must exit 12; only a comparison
# that could not be completed is exit 14. Reporting the mismatch as 14 makes
# the two outcomes indistinguishable, which is the same as having no exit code.
new_case ca-create-key-replaced
key_path="$case_dir/ca.key"
fail_ca_create=matching
swap_key_source="$scratch/ca-b.key"
swap_key_target="$key_path"
refuse=0
run_bootstrap
label="CA create with a replaced local key"
assert_status 12 "$label"
assert_contains "$out" "does not match the preserved key" "$label"
assert_contains "$out" "does not match the new CA certificate" "$label"
assert_contains "$out" "verified public-key mismatch" "$label"
assert_not_contains "$out" "could not be verified" "$label"
assert_not_contains "$out" "No mismatch conclusion was drawn" "$label"
assert_same "$key_path" "$scratch/ca-b.key" "$label: the replaced key was overwritten"
assert_no_key_material "$key_path" "$out" "$label"
assert_not_contains "$out" "delete secret/firewatch-ca" "$label"
assert_contains "$case_dir/mutations.log" "FAILED create secret generic firewatch-ca" "$label"
assert_no_ca_staging "$label"
echo "PASS: a local key replaced under a Secret matching the new CA exits 12 as a confirmed mismatch, not 14"

# --- 13) recovery recipe is private and short-circuited ---------------------
new_case recovery-recipe
key_path="$case_dir/ca.key"
fail_ca_create=absent
refuse=0
run_bootstrap
assert_status 11 "recovery recipe"
assert_contains "$out" "Recovery recipe (public bytes only)" "recovery recipe"
sed -n '/Recovery recipe (public bytes only):/,$p' "$out" | sed '1d; s/^    //' >"$case_dir/recipe.sh"
[ -s "$case_dir/recipe.sh" ] || fail "recovery recipe: no recipe was emitted"
assert_contains "$case_dir/recipe.sh" "mktemp -d" "recovery recipe"
assert_contains "$case_dir/recipe.sh" "trap 'rm -rf" "recovery recipe"
assert_not_contains "$case_dir/recipe.sh" "/tmp/firewatch-" "recovery recipe"
recipe_bin="$case_dir/recipe-bin"
if command -v cygpath >/dev/null 2>&1; then
	recipe_bin="$(cygpath -u "$case_dir")/recipe-bin"
fi
mkdir -p "$recipe_bin"
real_cmp=$(command -v cmp)
cat >"$recipe_bin/cmp" <<'CMP'
#!/usr/bin/env sh
printf 'cmp
' >>"$CMP_MARKER"
exec "$REAL_CMP" "$@"
CMP
chmod +x "$recipe_bin/cmp"
: >"$case_dir/cmp-marker"
set +e
FIREWATCH_CA_KEY="$scratch/ca-a.key" CA_CERT="$scratch/ca-a.crt" 	CMP_MARKER="$case_dir/cmp-marker" REAL_CMP="$real_cmp" PATH="$recipe_bin:$PATH" 	sh "$case_dir/recipe.sh" >"$case_dir/recipe-ok.out" 2>&1
recipe_status=$?
set -e
[ "$recipe_status" -eq 0 ] || fail "recovery recipe: matching synthetic key/cert failed with exit $recipe_status; output:
$(cat "$case_dir/recipe-ok.out")"
[ -s "$case_dir/cmp-marker" ] || fail "recovery recipe: comparison did not run after both derivations succeeded; recipe:
$(cat "$case_dir/recipe.sh")
output:
$(cat "$case_dir/recipe-ok.out")"
: >"$case_dir/cmp-marker"
set +e
FIREWATCH_CA_KEY="$scratch/ca-a.key" CA_CERT="$case_dir/no-such-cert.pem" 	CMP_MARKER="$case_dir/cmp-marker" REAL_CMP="$real_cmp" PATH="$recipe_bin:$PATH" 	sh "$case_dir/recipe.sh" >"$case_dir/recipe-failed.out" 2>&1
recipe_status=$?
set -e
[ "$recipe_status" -ne 0 ] || fail "recovery recipe: missing CA_CERT unexpectedly succeeded"
[ ! -s "$case_dir/cmp-marker" ] || fail "recovery recipe: comparison ran after failed extraction"
assert_no_ca_staging "recovery recipe"
echo "PASS: recovery recipe used per-invocation scratch and short-circuited cmp on failed extraction"

# --- E) a directory this run did not create is not chmodded ---------------
# Two runs starting against the same operator path both see it missing; one
# creates it, and `mkdir -p` then reports success for the loser as well. A run
# that cannot tell "I created it" from "it exists now" applies 0700 to a
# directory it does not own, replacing the mode its owner chose. The mkdir shim
# plays the winner deterministically and the chmod shim records every mode
# change, so the assertion does not depend on this host honouring modes.
new_case operator-dir-race
operator_dir="$case_dir/operator"
key_path="$operator_dir/ca.key"
namespace_present=no
refuse=0
race_chmod_log="$case_dir/chmod.log"
: >"$race_chmod_log"
race_winner_marker="$case_dir/winner.marker"
run_path_prefix="$race_bin"
race_dir="$operator_dir"
run_bootstrap
label="operator directory created concurrently"
assert_status 0 "$label"
[ -d "$operator_dir" ] || fail "$label: the operator directory is missing"
[ -s "$key_path" ] || fail "$label: the key was not published at $key_path"
# Positive controls: an absent chmod line only means something if the race was
# actually played and the log is actually being written.
[ -f "$race_winner_marker" ] ||
	fail "$label: the mkdir shim never played the winner, so the race was not exercised"
[ -s "$race_chmod_log" ] ||
	fail "$label: no chmod invocation was recorded, so the chmod shim did not fire"
# Any mode spelling counts: compare the last field so `700`, `0700` or a
# symbolic mode aimed at the same directory all fail this case.
if awk -v d="$operator_dir" '{ p = $0; sub(/^[^ ]+ /, "", p); if (p == d) found = 1 } END { exit(found ? 0 : 1) }' "$race_chmod_log"; then
	fail "$label: the run changed the mode of a directory it did not create; chmod log was:
$(cat "$race_chmod_log")"
fi
assert_no_ca_staging "$label"
echo "PASS: a directory created concurrently by another process was not chmodded by this run"

# The run that does create the directory still secures it: the guard is "not
# mine to change", not "never chmod", so dropping the 0700 entirely would also
# fail this case.
new_case operator-dir-created
operator_dir="$case_dir/operator"
key_path="$operator_dir/ca.key"
namespace_present=no
refuse=0
race_chmod_log="$case_dir/chmod.log"
: >"$race_chmod_log"
run_path_prefix="$race_bin"
run_bootstrap
label="operator directory created by this run"
assert_status 0 "$label"
[ -s "$key_path" ] || fail "$label: the key was not published at $key_path"
grep -qxF "700 $operator_dir" "$race_chmod_log" ||
	fail "$label: a directory this run created was not set to 0700; chmod log was:
$(cat "$race_chmod_log")"
assert_no_ca_staging "$label"
echo "PASS: a directory this run creates is still secured to 0700"

# --- 14) fresh initialisation with no local path is preserved ---------------
# No namespace, no Secret and no key: the preflight reports true absence, and
# the script creates the namespace, the CA Secret and the operator key as it did
# before. The stub emulates those writes in the case directory.
new_case fresh-init
key_path="$case_dir/ca.key"
ca_present=no
namespace_present=no
refuse=0
run_bootstrap
assert_status 0 "fresh initialisation"
assert_contains "$out" "CA private key written to $key_path" "fresh initialisation"
assert_no_ca_staging "fresh initialisation"
[ -s "$key_path" ] || fail "fresh initialisation: the CA key was not created at $key_path"
MSYS_NO_PATHCONV=1 openssl pkey -in "$(native_path "$key_path")" -noout >/dev/null 2>&1 ||
	fail "fresh initialisation: the file at $key_path is not a private key"
assert_contains "$case_dir/mutations.log" "WRITE create namespace firewatch" "fresh initialisation"
assert_contains "$case_dir/mutations.log" "WRITE create secret generic firewatch-ca" "fresh initialisation"
assert_no_key_material "$key_path" "$out" "fresh initialisation"

echo "PASS: bootstrap-secrets.sh preflights writable operator-path staging before namespace/Secret writes, refuses a present local key without a cluster CA, refuses a mismatched key/cert pair and invalid material before any write, signs with the private staging snapshot, refuses staging failure and any existing destination type, classifies rejected CA Secret creates with confirmed matching/absent/conflict/unknown diagnostics and a public-key-only recipe, survives lookup errors, and preserves the fresh path"
