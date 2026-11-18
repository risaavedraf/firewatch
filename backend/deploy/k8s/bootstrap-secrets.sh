#!/usr/bin/env sh
# Creates the namespace-level material the Kubernetes base consumes: random
# credentials and an internal CA with server certificates.
#
# It never prints a secret, never writes one into the repository, and never
# rotates silently: a Secret that already exists is left untouched, because
# replacing a password under a running service breaks it at its next reconnect.
# To rotate deliberately, delete the Secret first and re-run; the dependent
# workloads then need a restart, which is the operator's decision, not this
# script's.
#
# The CA signing key is the one piece of material this script deliberately keeps
# out of the cluster: the Secret carries only ca.crt, and ca.key stays on the
# operator's machine (FIREWATCH_CA_KEY, default ~/.firewatch-internal-ca/ca.key).
#
# Usage: ./bootstrap-secrets.sh [namespace]
#
# KUBECTL overrides the client binary, the same way tests/render-contract.sh does.
# Pointing it at a recording stub shows what this script would create without a
# cluster; it takes one executable path, never extra arguments.
set -eu

# One variable for the client, so the script can be exercised against a stub.
kubectl_bin="${KUBECTL:-kubectl}"

# The namespace is declared in one place, the base manifests, and the default is
# read from there instead of repeated here: every certificate below carries
# <service>.<namespace>.svc SANs, and a namespace written by hand would leave them
# naming a Service that nothing answers for. An explicit argument still wins.
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
namespace_file="$repo_root/deploy/k8s/base/namespace.yaml"
if [ ! -f "$namespace_file" ]; then
	echo "missing $namespace_file: it declares the namespace these SANs name" >&2
	exit 1
fi
base_namespace="$(awk '/^metadata:/{m=1;next} m && /^  name:/{print $2; exit}' "$namespace_file")"
if [ -z "$base_namespace" ]; then
	echo "$namespace_file declares no metadata.name" >&2
	exit 1
fi
namespace="${1:-$base_namespace}"
workdir="$(mktemp -d)"
ca_staging_dir=""
ca_staging_key=""
cleanup() {
	if [ -n "${ca_staging_dir:-}" ]; then
		if ! rm -rf "$ca_staging_dir" 2>/dev/null; then
			echo "warning: could not remove the private staging directory at $ca_staging_dir; it is mode 0700 under the operator path." >&2
		fi
	fi
	rm -rf "$workdir"
}
trap cleanup EXIT
# The CA signing key is deliberately not cluster material: it lives on the
# operator's machine, and FIREWATCH_CA_KEY points somewhere else when it does not
# live in the default location.
ca_key_file="${FIREWATCH_CA_KEY:-$HOME/.firewatch-internal-ca/ca.key}"

exists() {
	"$kubectl_bin" --namespace "$namespace" get secret "$1" >/dev/null 2>&1
}

ca_key_present() {
	# Presence is the claim, not readability: an empty file at the operator's
	# pinned path is as destructive to overwrite as a usable key, and a symlink
	# is a path they chose. -L covers a symlink whose target is not there.
	[ -e "$ca_key_file" ] || [ -L "$ca_key_file" ]
}

abort() {
	printf 'refusing to write: %s\n' "$1" >&2
	shift
	printf '%s\n' "$@" >&2
	exit 1
}

fail_closed() {
	printf 'stopping: %s\n' "$1" >&2
	shift
	printf '%s\n' "$@" >&2
	exit 1
}

discard_ca_staging() {
	if [ -n "${ca_staging_dir:-}" ]; then
		if ! rm -rf "$ca_staging_dir" 2>/dev/null; then
			echo "warning: could not remove the private staging directory at $ca_staging_dir; it is mode 0700 under the operator path and should be removed after verification." >&2
		fi
		ca_staging_dir=""
	fi
	ca_staging_key=""
}

preflight_die() {
	discard_ca_staging
	first=$1
	shift
	abort "$first" "$@" "Nothing has been written."
}

post_credentials_die() {
	discard_ca_staging
	first=$1
	shift
	fail_closed "$first" "$@" \
		"The non-CA credentials may already have been written; no CA Secret was created and the existing local path was not replaced."
}

preflight_staging_die() {
	discard_ca_staging
	first=$1
	shift
	abort "$first" "$@" \
		"No Secret or namespace was written; the private staging area is under the operator key directory." \
		"The path at $ca_key_file was not replaced; no new CA key was published there."
}

print_ca_recipe() {
	printf '  Recovery recipe (public bytes only):\n' >&2
	printf '%s\n' '    KEY_FILE=${FIREWATCH_CA_KEY:?set FIREWATCH_CA_KEY to the preserved key path}' >&2
	printf '%s\n' '    CA_CERT=${CA_CERT:?set CA_CERT to the candidate CA certificate}' >&2
	printf '%s\n' '    recipe_dir=$(mktemp -d) || exit 1' >&2
	printf "    trap 'rm -rf \"\$recipe_dir\"' EXIT\n" >&2
	printf '%s\n' '    openssl pkey -in "$KEY_FILE" -pubout -out "$recipe_dir/key.pub" || exit 1' >&2
	printf '%s\n' '    openssl x509 -in "$CA_CERT" -pubkey -noout -out "$recipe_dir/ca.pub" || exit 1' >&2
	printf '%s\n' '    cmp -s "$recipe_dir/key.pub" "$recipe_dir/ca.pub"' >&2
}

abort_with_recipe() {
	printf 'refusing to write: %s\n' "$1" >&2
	shift
	printf '%s\n' "$@" >&2
	print_ca_recipe
	exit 1
}

fail_closed_with_recipe() {
	printf 'stopping: %s\n' "$1" >&2
	shift
	printf '%s\n' "$@" >&2
	print_ca_recipe
	exit 1
}

fail_code() {
	code=$1
	shift
	printf 'stopping: %s\n' "$1" >&2
	shift
	printf '%s\n' "$@" >&2
	exit "$code"
}

fail_code_with_recipe() {
	code=$1
	shift
	printf 'stopping: %s\n' "$1" >&2
	shift
	printf '%s\n' "$@" >&2
	print_ca_recipe
	exit "$code"
}

compare_public_keys() {
	if cmp -s "$1" "$2"; then
		return 0
	else
		status=$?
	fi
	if [ "$status" -eq 1 ]; then
		return 1
	fi
	return 2
}

refuse_existing_key_without_ca() {
	# The final line is the caller's, because only the preflight can still say
	# that nothing was written; the write-site check runs after credentials.
	abort_with_recipe "$ca_key_file already exists, but this run started with no secret/firewatch-ca in namespace/$namespace." \
		"  This key does not belong to any CA in namespace/$namespace; it may be residue from an earlier run or a key you supplied - decide which and act." \
		"  Re-running refuses while this path exists; do not delete, adopt or retry blindly." \
		"  Point FIREWATCH_CA_KEY at the key of the CA this cluster should use," \
		"  or rotate the authority deliberately if that is what you want." \
		"$1"
}

preflight_new_ca_key_staging() {
	# Create and write-probe the private staging directory before any namespace
	# or Secret is written; only a directory this run creates is chmodded.
	ca_key_dir=$(dirname "$ca_key_file")
	if [ -d "$ca_key_dir" ]; then
		if [ ! -w "$ca_key_dir" ]; then
			preflight_staging_die "the operator key directory $ca_key_dir exists but is not writable."
		fi
	else
		# The parent chain is created with -p, the leaf without it. `mkdir -p`
		# succeeds when a concurrent run has already created the leaf, so its
		# status cannot say "this run created the directory"; on that false
		# positive the 0700 below lands on a directory this run does not own
		# and replaces whatever mode its owner chose. A plain mkdir fails with
		# "already exists", which is the only local signal that distinguishes
		# the two cases.
		ca_key_parent=$(dirname "$ca_key_dir")
		if [ -n "$ca_key_parent" ] && [ "$ca_key_parent" != "$ca_key_dir" ] && [ ! -d "$ca_key_parent" ]; then
			if ! mkdir -p "$ca_key_parent" 2>"$workdir/ca-key-dir.err"; then
				preflight_staging_die "cannot create the CA key directory $ca_key_dir."
			fi
		fi
		if mkdir "$ca_key_dir" 2>"$workdir/ca-key-dir.err"; then
			if ! chmod 700 "$ca_key_dir" 2>"$workdir/ca-key-dir-chmod.err"; then
				preflight_staging_die "cannot secure the CA key directory this run created at $ca_key_dir."
			fi
		elif [ ! -d "$ca_key_dir" ]; then
			preflight_staging_die "cannot create the CA key directory $ca_key_dir."
		fi
	fi
	if ! ca_staging_dir=$(umask 077; mktemp -d "$ca_key_dir/.firewatch-ca.staging.XXXXXX" 2>"$workdir/ca-staging.err"); then
		ca_staging_dir=""
		if [ -d "$ca_key_dir" ] && [ ! -w "$ca_key_dir" ]; then
			preflight_staging_die "the operator key directory $ca_key_dir exists but is not writable."
		fi
		preflight_staging_die "cannot create a private staging directory under the operator key directory $ca_key_dir."
	fi
	if ! chmod 700 "$ca_staging_dir" 2>"$workdir/ca-staging-chmod.err"; then
		preflight_staging_die "cannot set the private staging directory at $ca_staging_dir to 0700."
	fi
	ca_staging_key="$ca_staging_dir/ca.key"
	if ! printf '%s\n' 'staging' >"$ca_staging_key" 2>"$workdir/ca-staging-probe.err"; then
		preflight_staging_die "cannot write a probe to the private staging directory under $ca_key_dir."
	fi
	if ! chmod 600 "$ca_staging_key" 2>"$workdir/ca-staging-key-chmod.err"; then
		preflight_staging_die "cannot set the private staging file at $ca_staging_key to 0600."
	fi
}

stage_existing_ca_key() {
	# Compare the operator key's derived public key first; only a matching key is
	# copied, into a private 0700 staging directory in the operator's own path.
	if ! openssl pkey -in "$ca_key_file" -pubout -out "$workdir/ca-key.pub" >/dev/null 2>"$workdir/ca-key.err"; then
		preflight_die "cannot read a public key from the CA key at $ca_key_file (verification failure)." \
			"The path at $ca_key_file was not replaced."
	fi
	if compare_public_keys "$workdir/ca-key.pub" "$workdir/ca-cert.pub"; then
		:
	else
		status=$?
		if [ "$status" -eq 1 ]; then
			preflight_die "the key at $ca_key_file does not belong to the CA in secret/firewatch-ca (verified public-key mismatch)." \
				"  Point FIREWATCH_CA_KEY at the key of that CA (the path is currently $ca_key_file)," \
				"  or rotate the authority deliberately if that is what you want." \
				"The path at $ca_key_file was not replaced."
		fi
		preflight_die "cannot compare the key at $ca_key_file with secret/firewatch-ca (verification failure)." \
			"The path at $ca_key_file was not replaced."
	fi
	ca_key_dir=$(dirname "$ca_key_file")
	if [ ! -w "$ca_key_dir" ]; then
		preflight_staging_die "the operator key directory $ca_key_dir exists but is not writable."
	fi
	if ! ca_staging_dir=$(umask 077; mktemp -d "$ca_key_dir/.firewatch-ca.staging.XXXXXX" 2>"$workdir/ca-staging.err"); then
		ca_staging_dir=""
		preflight_staging_die "cannot create a private staging directory under the operator key directory $ca_key_dir." \
			"The key directory must be writable so signing can use the same validated snapshot."
	fi
	if ! chmod 700 "$ca_staging_dir" 2>"$workdir/ca-staging-chmod.err"; then
		preflight_staging_die "cannot set the private staging directory at $ca_staging_dir to 0700."
	fi
	ca_staging_key="$ca_staging_dir/ca.key"
	if ! cat "$ca_key_file" >"$ca_staging_key" 2>"$workdir/ca-key-copy.err"; then
		preflight_staging_die "cannot copy the CA key at $ca_key_file into its private staging directory."
	fi
	if ! chmod 600 "$ca_staging_key" 2>"$workdir/ca-key-chmod.err"; then
		preflight_staging_die "cannot set the private staging key at $ca_staging_key to 0600."
	fi
	if ! openssl pkey -in "$ca_staging_key" -pubout -out "$workdir/ca-staging.pub" >/dev/null 2>"$workdir/ca-staging-key.err"; then
		preflight_staging_die "cannot read a public key from the private staging copy of the CA key at $ca_staging_key (verification failure)."
	fi
	if compare_public_keys "$workdir/ca-staging.pub" "$workdir/ca-cert.pub"; then
		:
	else
		status=$?
		if [ "$status" -eq 1 ]; then
			preflight_staging_die "the private staging copy of the CA key does not match secret/firewatch-ca (verified public-key mismatch); the operator key at $ca_key_file was not replaced."
		fi
		preflight_staging_die "cannot compare the private staging copy of the CA key with secret/firewatch-ca (verification failure)."
	fi
}

stage_new_ca_key() {
	# The key is generated into the preflighted private staging file under the
	# operator path; only the public certificate lands in workdir.
	if [ -z "$ca_staging_key" ]; then
		post_credentials_die "no private CA key staging file was prepared by the preflight."
	fi
	if ! openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -keyout "$ca_staging_key" \
		-out "$workdir/ca.crt" -subj "/CN=firewatch-internal-ca" >/dev/null 2>"$workdir/ca-generate.err"; then
		post_credentials_die "cannot generate the new CA key at the private staging file next to $ca_key_file."
	fi
	if ! chmod 600 "$ca_staging_key" 2>"$workdir/ca-staging-key-chmod.err"; then
		post_credentials_die "cannot set the new CA key staging file at $ca_staging_key to 0600."
	fi
	if ! openssl x509 -in "$workdir/ca.crt" -pubkey -noout -out "$workdir/ca-cert.pub" >/dev/null 2>"$workdir/ca-cert.err"; then
		post_credentials_die "the generated CA certificate is not readable (verification failure)."
	fi
	if ! openssl pkey -in "$ca_staging_key" -pubout -out "$workdir/ca-key.pub" >/dev/null 2>"$workdir/ca-key.err"; then
		post_credentials_die "cannot read a public key from the new CA key staging file (verification failure)."
	fi
	if compare_public_keys "$workdir/ca-key.pub" "$workdir/ca-cert.pub"; then
		:
	else
		status=$?
		if [ "$status" -eq 1 ]; then
			post_credentials_die "the new CA key and certificate do not match (verified public-key mismatch)."
		fi
		post_credentials_die "cannot compare the new CA key and certificate (verification failure)."
	fi
}

publish_ca_key() {
	# POSIX link calls link(2) with the exact destination path: it is atomic and
	# create-only, fails if any destination entry exists (including a directory,
	# symlink or FIFO), and never follows the final path.
	link "$ca_staging_key" "$ca_key_file" 2>"$workdir/ca-key-link.err"
}

ca_key_state() {
	if [ ! -f "$ca_key_file" ]; then
		printf 'verification\n'
		return
	fi
	if ! openssl pkey -in "$ca_key_file" -pubout -out "$workdir/ca-intact.pub" >/dev/null 2>"$workdir/ca-intact.err"; then
		printf 'verification\n'
		return
	fi
	if compare_public_keys "$workdir/ca-intact.pub" "$workdir/ca-cert.pub"; then
		printf 'matching\n'
		return
	else
		# $? is the comparison's own status only here, inside the branch it
		# selects. After `fi` it is the if compound's status, which is 0 when no
		# branch ran, so reading it there reports every confirmed mismatch as a
		# verification failure and cannot tell the two exits apart.
		status=$?
	fi
	if [ "$status" -eq 1 ]; then
		printf 'mismatch\n'
	else
		printf 'verification\n'
	fi
}

ca_after_state() {
	if ! ca_after_lookup="$("$kubectl_bin" --namespace "$namespace" get secret firewatch-ca --ignore-not-found --output name 2>"$workdir/ca-after-lookup.err")"; then
		printf 'unknown\n'
		return
	fi
	if [ -z "$ca_after_lookup" ]; then
		printf 'absent\n'
		return
	fi
	if ! "$kubectl_bin" --namespace "$namespace" get secret firewatch-ca --output 'jsonpath={.data.ca\.crt}' >"$workdir/ca-after.b64" 2>"$workdir/ca-after-read.err"; then
		printf 'unknown\n'
		return
	fi
	if [ ! -s "$workdir/ca-after.b64" ]; then
		printf 'verification\n'
		return
	fi
	if ! base64 --decode <"$workdir/ca-after.b64" >"$workdir/ca-after.crt" 2>"$workdir/ca-after-decode.err"; then
		printf 'verification\n'
		return
	fi
	if ! openssl x509 -in "$workdir/ca-after.crt" -pubkey -noout -out "$workdir/ca-after.pub" >/dev/null 2>"$workdir/ca-after-cert.err"; then
		printf 'verification\n'
		return
	fi
	if compare_public_keys "$workdir/ca-after.pub" "$workdir/ca-cert.pub"; then
		:
	else
		status=$?
		if [ "$status" -eq 1 ]; then
			printf 'conflict\n'
		else
			printf 'verification\n'
		fi
		return
	fi
	key_state=$(ca_key_state)
	case "$key_state" in
		matching) printf 'matching\n' ;;
		mismatch) printf 'conflict\n' ;;
		*) printf 'verification\n' ;;
	esac
}

report_ca_create_failure() {
	discard_ca_staging
	ca_after=$(ca_after_state)
	key_state=$(ca_key_state)
	case "$key_state" in
		matching) key_note="The new CA key is intact at $ca_key_file." ;;
		mismatch) key_note="The key at $ca_key_file does not match the new CA certificate (verified public-key mismatch)." ;;
		*) key_note="The key at $ca_key_file could not be verified (verification failure)." ;;
	esac
	# Recovery exits: 10 matching, 11 absent, 12 conflict, 13 unknown, 14 verification failure.
	case "$ca_after" in
		matching)
			fail_code 10 "secret/firewatch-ca create reported an error, but a read-only check found a Secret in namespace/$namespace matching the preserved key." \
				"$key_note" \
				"The local key and the target Secret are a complete verified public-key pair; verify before continuing; nothing was retried."
			;;
		absent)
			fail_code_with_recipe 11 "secret/firewatch-ca create failed and a read-only check found no matching CA in namespace/$namespace." \
				"$key_note" \
				"The preserved key may be residue from an earlier run or a key you supplied; it does not belong to any CA in the target namespace." \
				"Re-running refuses while this path exists; do not delete, adopt or retry blindly." \
				"Decide which authority the target namespace should use and act."
			;;
		conflict)
			fail_code_with_recipe 12 "secret/firewatch-ca create failed and namespace/$namespace holds a CA that does not match the preserved key." \
				"$key_note" \
				"The existing Secret was not changed or adopted; verify both authorities before continuing; nothing was deleted or retried."
			;;
		unknown)
			fail_code_with_recipe 13 "secret/firewatch-ca create failed and a read-only check could not determine whether namespace/$namespace holds a matching CA." \
				"$key_note" \
				"The API check was inconclusive; verify the Secret and key manually; nothing was deleted, adopted or retried."
			;;
		*)
			fail_code_with_recipe 14 "secret/firewatch-ca create failed and the read-only verification could not complete for namespace/$namespace (read, base64, PEM, openssl or comparison failure)." \
				"$key_note" \
				"No mismatch conclusion was drawn; verify the Secret and key manually; nothing was deleted, adopted or retried."
			;;
	esac
}

# Read-only CA preflight. It runs before the namespace or any Secret is created,
# because both #81 states are destructive only once the first write happens:
# minting a new CA would overwrite an existing key, and signing with a key that
# does not match the cluster's ca.crt would write credentials before the
# mismatch surfaced. A failed API read is not an absence; it stops here. The
# cluster certificate is a public snapshot in $workdir; the private signing
# snapshot stays under the operator path.
if namespace_lookup="$("$kubectl_bin" get namespace "$namespace" --ignore-not-found --output name 2>"$workdir/namespace-lookup.err")"; then
	if [ -n "$namespace_lookup" ]; then
		namespace_present=yes
	else
		namespace_present=no
	fi
else
	abort "cannot read namespace/$namespace; the cluster state is unknown." \
		"Nothing has been written."
fi

ca_secret_present=no
if [ "$namespace_present" = yes ]; then
	if ca_lookup="$("$kubectl_bin" --namespace "$namespace" get secret firewatch-ca --ignore-not-found --output name 2>"$workdir/firewatch-ca-lookup.err")"; then
		if [ -n "$ca_lookup" ]; then
			ca_secret_present=yes
		fi
	else
		abort "cannot read secret/firewatch-ca in namespace/$namespace; the cluster state is unknown." \
			"Nothing has been written."
	fi
fi

if [ "$ca_secret_present" = yes ]; then
	if ! "$kubectl_bin" --namespace "$namespace" get secret firewatch-ca --output 'jsonpath={.data.ca\.crt}' >"$workdir/ca.crt.b64" 2>"$workdir/firewatch-ca-read.err"; then
		abort "cannot read ca.crt from secret/firewatch-ca in namespace/$namespace (verification failure)." \
			"Nothing has been written."
	fi
	if [ ! -s "$workdir/ca.crt.b64" ]; then
		abort "secret/firewatch-ca carries no ca.crt (verification failure)." \
			"Nothing has been written."
	fi
	if ! base64 --decode <"$workdir/ca.crt.b64" >"$workdir/ca.crt" 2>"$workdir/ca.crt-decode.err"; then
		abort "the ca.crt in secret/firewatch-ca is not valid base64 (verification failure)." \
			"Nothing has been written."
	fi
	if ! openssl x509 -in "$workdir/ca.crt" -pubkey -noout -out "$workdir/ca-cert.pub" >/dev/null 2>"$workdir/ca-cert.err"; then
		abort "the ca.crt in secret/firewatch-ca is not a certificate (verification failure)." \
			"Nothing has been written."
	fi
	if ca_key_present; then
		stage_existing_ca_key
	fi
elif ca_key_present; then
	refuse_existing_key_without_ca "Nothing has been written."
else
	preflight_new_ca_key_staging
fi

random_hex() {
	# 24 bytes of hex: long enough that a password is never guessed, short enough
	# to stay readable in a connection string.
	openssl rand -hex 24
}

apply_generic() {
	# apply_generic NAME KEY=VALUE...
	name="$1"
	shift
	if exists "$name"; then
		echo "secret/$name already exists, left untouched"
		return 0
	fi
	literal_args=""
	for pair in "$@"; do
		literal_args="$literal_args --from-literal=$pair"
	done
	# shellcheck disable=SC2086 # word splitting is how kubectl receives each --from-literal
	"$kubectl_bin" --namespace "$namespace" create secret generic "$name" $literal_args
}

echo "namespace/$namespace"
"$kubectl_bin" get namespace "$namespace" >/dev/null 2>&1 || "$kubectl_bin" create namespace "$namespace"

# --- credentials -----------------------------------------------------------
# Generated once and then reused on every run: the StatefulSet reads them, so a
# changed value would be applied to a running database that has the old one.
postgres_password="$(random_hex)"
jobs_db_password="$(random_hex)"
risk_db_password="$(random_hex)"
keycloak_db_password="$(random_hex)"
apply_generic postgres-credentials \
	"POSTGRES_PASSWORD=$postgres_password" \
	"JOBS_DB_PASSWORD=$jobs_db_password" \
	"RISK_DB_PASSWORD=$risk_db_password" \
	"KEYCLOAK_DB_PASSWORD=$keycloak_db_password"

# If the secret already existed, the generated values above are not the ones in
# the cluster. Read them back so the derived URLs below match what the database
# will actually accept.
read_secret() {
	"$kubectl_bin" --namespace "$namespace" get secret "$1" --output "jsonpath={.data.$2}" | base64 --decode
}
postgres_password="$(read_secret postgres-credentials POSTGRES_PASSWORD)"
jobs_db_password="$(read_secret postgres-credentials JOBS_DB_PASSWORD)"
risk_db_password="$(read_secret postgres-credentials RISK_DB_PASSWORD)"

apply_generic broker-credentials \
	"RABBITMQ_PASSWORD=$(random_hex)" \
	"RABBITMQ_JOBS_PASSWORD=$(random_hex)" \
	"RABBITMQ_RISK_PASSWORD=$(random_hex)" \
	"RABBITMQ_ERLANG_COOKIE=$(random_hex)"

# Read back for the same reason as the database passwords: an existing Secret is
# never rewritten, so the AMQP_URL below has to carry the password the broker was
# provisioned with, not the one this run generated.
jobs_broker_password="$(read_secret broker-credentials RABBITMQ_JOBS_PASSWORD)"
risk_broker_password="$(read_secret broker-credentials RABBITMQ_RISK_PASSWORD)"

# --- internal CA and server certificates -----------------------------------
# One CA for the cluster's internal services. The certificates name the Service
# DNS entries as SANs, because a client that verifies the hostname would reject
# a certificate issued for a bare pod name.
#
# issue_certificate SECRET_BASE [SERVICE]: the Secret is <SECRET_BASE>-tls, and the
# certificate is valid for the Service name clients dial, which is not always the
# same word (Keycloak's Service is `identity`, its Secret `keycloak-tls`).
issue_certificate() {
	secret_base="$1"
	service="${2:-$1}"
	if exists "$secret_base-tls"; then
		echo "secret/$secret_base-tls already exists, left untouched"
		return 0
	fi
	openssl req -new -newkey rsa:2048 -nodes -keyout "$workdir/$secret_base.key" \
		-out "$workdir/$secret_base.csr" -subj "/CN=$service" >/dev/null 2>&1
	# localhost and 127.0.0.1 are SANs because a port-forward is how a service is
	# exercised before its Ingress exists, and a certificate that named only the
	# in-cluster DNS would fail verification there.
	cat > "$workdir/$secret_base.ext" <<EXT
subjectAltName = DNS:$service, DNS:$service.$namespace.svc, DNS:$service.$namespace.svc.cluster.local, DNS:localhost, IP:127.0.0.1
extendedKeyUsage = serverAuth
EXT
	openssl x509 -req -in "$workdir/$secret_base.csr" -CA "$workdir/ca.crt" -CAkey "$ca_staging_key" \
		-CAcreateserial -days 825 -extfile "$workdir/$secret_base.ext" \
		-out "$workdir/$secret_base.crt" >/dev/null 2>&1
	"$kubectl_bin" --namespace "$namespace" create secret generic "$secret_base-tls" \
		--from-file=tls.crt="$workdir/$secret_base.crt" \
		--from-file=tls.key="$workdir/$secret_base.key" \
		--from-file=ca.crt="$workdir/ca.crt"
}

if [ "$ca_secret_present" = yes ]; then
	if [ -n "$("$kubectl_bin" --namespace "$namespace" get secret firewatch-ca --output jsonpath='{.data.ca\.key}' 2>/dev/null)" ]; then
		echo "secret/firewatch-ca still carries ca.key: take it out of the cluster with" >&2
		echo "  kubectl --namespace $namespace patch secret firewatch-ca --type=json -p '[{\"op\":\"remove\",\"path\":\"/data/ca.key\"}]'" >&2
	fi
else
	# The preflight found no cluster CA. Check again at the write site: a path
	# that appeared during the credential writes must not turn into an overwrite
	# of the only copy of an authority.
	if ca_key_present; then
		refuse_existing_key_without_ca "The non-CA credentials may already have been written; no CA Secret or CA key was written by this run."
	fi
	stage_new_ca_key
	if ! publish_ca_key; then
		if [ -s "$workdir/ca-key-link.err" ]; then
			cat "$workdir/ca-key-link.err" >&2
		fi
		if ca_key_present; then
			post_credentials_die "cannot publish the new CA key at $ca_key_file: the destination already exists." \
				"Verify the existing path and the cluster's authority manually; nothing was deleted or adopted."
		fi
		post_credentials_die "cannot atomically publish the new CA key at $ca_key_file." \
			"The destination filesystem refused a create-only hard link; verify that it supports hard links. Nothing was overwritten."
	fi
	echo "CA private key written to $ca_key_file (0600, outside the cluster)"
	if ! "$kubectl_bin" --namespace "$namespace" create secret generic firewatch-ca \
		--from-file=ca.crt="$workdir/ca.crt"; then
		report_ca_create_failure
	fi
fi

# --- the trust anchor the Ingress verifies the gateway against -------------
# base/ingress.yaml turns upstream verification on with
# `proxy-ssl-verify: 'on'`, names the SAN the gateway certificate carries, and
# gives the controller this Secret by name. Repackaging the CA is what makes
# that hop authenticated and not only encrypted: without an anchor the
# controller verifies the gateway against its own trust store, which has never
# heard of this CA, and every request through the edge fails.
#
# The shape below is the one ingress-nginx v1.15.1 actually reads, determined by
# installing it and pointing the annotation at candidate Secrets rather than by
# reading the annotation's documentation. The controller renders
# `proxy_ssl_trusted_certificate` from the Secret's `ca.crt` and writes it at
# /etc/ingress-controller/ssl/ca-<namespace>-<name>.pem. It treats `tls.crt`
# and `tls.key` in the same Secret as a *client* key pair it presents to the
# upstream: the CA in `tls.crt` with an unrelated `tls.key` was rejected with
# "certificate and private key does not have a matching public key", and with no
# `ca.crt` the annotation renders no trusted certificate at all. This hop asks
# for no client certificate and the gateway requires none, so the Secret carries
# one key and no key pair.
#
# The CA is copied rather than referenced. firewatch-ca would be accepted as-is
# by this controller version — it carries exactly `ca.crt` — but it is the
# cluster's distributable trust anchor, read by every workload that verifies an
# outbound peer, and this is one hop's pin: the single CA the ingress accepts
# when it authenticates the gateway. Keeping them separate means a later change
# to firewatch-ca (a rotation bundle, a second CA) needs a deliberate decision
# about the edge instead of silently widening what the Ingress accepts. The
# cost is the same rotation rule as every other Secret here: replacing the CA
# means deleting this Secret too, and until it is re-created verification fails
# closed when the gateway's certificate changes.
if exists gateway-upstream-ca; then
	echo "secret/gateway-upstream-ca already exists, left untouched"
elif [ -s "$workdir/ca.crt" ]; then
	"$kubectl_bin" --namespace "$namespace" create secret generic gateway-upstream-ca \
		--from-file=ca.crt="$workdir/ca.crt"
fi

# New certificates need the signing key, which the cluster no longer holds. The
# preflight staged a copy of the operator key, or the fresh branch generated the
# new key, under the operator path; issuance uses that snapshot, never a fresh
# read of the final path.
if [ -s "$ca_staging_key" ]; then
	# The two data services, then one certificate per application service: the
	# cross-contract in odd/tasks/kubernetes-deployment.md (L10) puts TLS on every
	# service port, and a per-service certificate means one pod's key cannot answer
	# as its peer. The key and ca.crt are the validated snapshots.
	issue_certificate postgres
	issue_certificate rabbitmq
	issue_certificate gateway
	issue_certificate jobs
	issue_certificate risk
	issue_certificate prevention
	issue_certificate inference
	# Keycloak is the product; `identity` is the Service clients dial, so that is the
	# name the certificate has to carry.
	issue_certificate keycloak identity
else
	echo "no CA private key at $ca_key_file: existing certificates are kept, new ones cannot be issued" >&2
fi
discard_ca_staging

# --- connection strings ----------------------------------------------------
# sslmode=verify-full with an explicit root certificate, because verify-ca would
# accept any certificate signed by the CA for any hostname. One suffix for every
# DSN, so the trust settings cannot drift between the migration owner and the
# application: the CA is mounted at the path this names.
tls_suffix="?sslmode=verify-full&sslrootcert=/etc/tls/ca.crt"

# Migration owners are separate from the application credentials on purpose: a
# migration owner can reshape the schema, and no application pod may hold that
# authority.
apply_generic migration-credentials \
	"JOBS_DATABASE_URL=postgres://postgres:$postgres_password@postgres:5432/jobs$tls_suffix" \
	"RISK_DATABASE_URL=postgres://postgres:$postgres_password@postgres:5432/risk$tls_suffix"

# What the Deployments mount: base/workloads.yaml names these three Secrets as
# `secretRef`, so without them a pod waits in CreateContainerConfigError, and a
# plaintext DSN is refused outside development. The passwords are the roles
# postgres-init.sh creates, read back from postgres-credentials above; the trust
# settings are the same suffix the migration owner gets.
#
# Two keys, and each one has an owner that reads it at startup: DATABASE_URL, and
# AMQP_URL — jobs and risk read it before building their worker
# (services/{jobs,risk}/cmd/server/transport.go), so a pod without it starts and
# never serves. prevention owns no queue and holds no broker client, so it never
# gets one.
#
# Every part of that URL comes from the base, not from a guess: host `rabbitmq` and
# port 5671 are the Service and its only AMQP listener in base/rabbitmq.yaml
# (listeners.ssl.default), vhost `firewatch` is that StatefulSet's
# RABBITMQ_DEFAULT_VHOST, and `firewatch-jobs` / `firewatch-risk` are the two users
# deploy/local/rabbitmq-topology.sh provisions, whose passwords this script keeps in
# broker-credentials. amqps because requireSecureBrokerURL refuses any other scheme
# outside development; no verification parameter because the CA is not part of the
# URL, the pod mounts it and names it in TLS_CA_FILE, and that same guard refuses
# `verify=verify_none`.
apply_generic jobs-runtime \
	"DATABASE_URL=postgres://jobs_app:$jobs_db_password@postgres:5432/jobs$tls_suffix" \
	"AMQP_URL=amqps://firewatch-jobs:$jobs_broker_password@rabbitmq:5671/firewatch"
apply_generic risk-runtime \
	"DATABASE_URL=postgres://risk_app:$risk_db_password@postgres:5432/risk$tls_suffix" \
	"AMQP_URL=amqps://firewatch-risk:$risk_broker_password@rabbitmq:5671/firewatch"
# prevention owns the `prevention` schema inside the risk database (L8), so its DSN
# names that same database: a database of its own is never created, and a DSN
# naming one would point at nothing.
apply_generic prevention-runtime \
	"DATABASE_URL=postgres://risk_app:$risk_db_password@postgres:5432/risk$tls_suffix"

# The identity provider's first administrator. Keycloak reads these two variables
# only on a first start against an empty database; from then on the account lives
# in the `identity` database and the Secret is never read again. Without it no
# administrator exists, so no realm can be created at all and the provider serves
# an empty server - the state base/keycloak.yaml would otherwise start into.
#
# Both values are generated, username included, for the same two reasons as every
# other credential here: neither is written into the repository, and apply_generic
# leaves an existing Secret untouched, so a re-run cannot replace the account an
# operator is already using. Read them back with
#   kubectl --namespace <ns> get secret keycloak-bootstrap-admin -o yaml
# and sign in as that user to create the realm.
apply_generic keycloak-bootstrap-admin \
	"KC_BOOTSTRAP_ADMIN_USERNAME=admin_$(random_hex)" \
	"KC_BOOTSTRAP_ADMIN_PASSWORD=$(random_hex)"

# --- shared scripts and the model artifact, as ConfigMaps -------------------
# The PostgreSQL role/database script, the broker plugin list, the broker
# topology script, the development realm and the inference model already exist in
# the repository and are the single description of what those things are. They are
# loaded from there rather than copied into the Kubernetes tree, so the base cannot
# drift from the Compose stack. apply -f - makes a re-run update them, which is
# safe: none of them is mounted by a running container's decision logic, they are
# read at container start.
# The ConfigMap key is the file name the container reads, not the repository file
# name: rabbitmq.yaml mounts subPath `enabled_plugins`, which is also what
# RABBITMQ_ENABLED_PLUGINS_FILE names. Declaring the key here, per entry, keeps the
# two sides of that contract visible in one place instead of deriving it from a
# basename.
# `rabbitmq-topology` is mounted by the broker-provision Job as /topology and run
# as that Job's entrypoint, so the Job declares no topology of its own.
# `keycloak-realm` is the development realm. The file carries ${...} placeholders
# that Keycloak expands from the container's environment
# (docs/keycloak-realm-setup.md): what lands in the cluster is the shape of the
# realm, never a password. Nothing mounts it - base/keycloak.yaml imports no realm
# (see its header and deploy/k8s/README.md), because the placeholders
# DEMO_ADMIN_PASSWORD, DEMO_VIEWER_PASSWORD and DIRECTORY_CLIENT_SECRET are supplied
# by no Secret here. It stays a ConfigMap so the shape of the realm an operator
# provisions out of band is readable from the cluster, not imported.
# `inference-model` is the model artifact: services/inference/testdata/logistic.json,
# byte for byte the file the Compose stack mounts. base/inference.yaml mounts this
# ConfigMap at /models and names /models/logistic.json in FIREWATCH_MODEL_PATH, so a
# pod that starts without it stops at startup naming that variable instead of serving
# a zero model. It cannot be a kustomize configMapGenerator: the base's load
# restrictor refuses a generator file outside the kustomization root.
for entry in \
	"postgres-init:deploy/local/postgres-init.sh:postgres-init.sh" \
	"rabbitmq-plugins:deploy/local/rabbitmq-plugins:enabled_plugins" \
	"rabbitmq-topology:deploy/local/rabbitmq-topology.sh:rabbitmq-topology.sh" \
	"keycloak-realm:deploy/local/firewatch-realm.json:firewatch-realm.json" \
	"inference-model:services/inference/testdata/logistic.json:logistic.json"; do
	configmap_name="${entry%%:*}"
	rest="${entry#*:}"
	source_file="$repo_root/${rest%%:*}"
	configmap_key="${rest#*:}"
	"$kubectl_bin" --namespace "$namespace" create configmap "$configmap_name" \
		--from-file="$configmap_key=$source_file" \
		--dry-run=client --output yaml | "$kubectl_bin" --namespace "$namespace" apply -f -
done

echo
echo "done. jobs-runtime and risk-runtime carry DATABASE_URL and AMQP_URL;"
echo "prevention-runtime carries DATABASE_URL only. The TLS file mounts belong to the"
echo "workload wiring (T7.7), and its mounts must keep the paths these URLs name:"
echo "/etc/tls/ca.crt."
