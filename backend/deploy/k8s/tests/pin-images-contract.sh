#!/usr/bin/env sh
# Contract for overlays/delivery/pin-images.sh.
#
# What this checks and what it does not: it runs the script over a scratch copy
# of the delivery overlay and asserts which image names it accepts and which it
# refuses — an Artifact Registry path, where three segments precede
# `/firewatch/<service>`, a single-segment kind registry host, and three names
# that have to be turned away. It cannot check a registry: no image is pulled,
# pushed or resolved, so a name this script accepts is only a name the registry
# may later answer for. That answer is T9's, on the target cluster.
#
# The scratch tree is not a convenience. The script rewrites the file it sits
# next to, so a test that ran it in place would edit the committed overlay and
# the next render would depend on the order this file was run in. Each case gets
# its own copy at the depth the script resolves: `overlays/delivery` names
# `../../base` for the services it validates against, and the copy carries both.
#
# The acceptance cases assert the rewrite and not only the exit status: a script
# that exited 0 without writing anything would satisfy the status alone.
#
#   sh backend/deploy/k8s/tests/pin-images-contract.sh
set -eu

cd "$(dirname "$0")/.."

fail() {
	echo "FAIL: $1" >&2
	exit 1
}

# One service's digest stands in for all five: the script validates each digest
# but never compares two services' digests, so repeating one keeps the cases
# about names. It is the gateway digest the overlay already pins.
digest=01d650caaf98f61a3be7a21b82f7c62e49fad993d007917733bb68229a0f262a

scratch=$(mktemp -d) || fail "mktemp -d: cannot create the scratch tree"
trap 'rm -rf "$scratch"' EXIT

# A copy of the overlay and the base at the depth `../../base` names. The script
# is copied with them so it reads the copy's `base` and writes the copy's
# `kustomization.yaml`; the committed files are never opened for writing.
scratch_copy() {
	mkdir -p "$1/overlays/delivery" || fail "cannot create the scratch tree $1"
	cp -R base "$1/base" || fail "cannot copy base into the scratch tree"
	cp overlays/delivery/kustomization.yaml overlays/delivery/pin-images.sh \
		"$1/overlays/delivery/" || fail "cannot copy the overlay into the scratch tree"
}

# The five services the base declares, one line each, under one prefix. The
# gateway's repository slug is the argument, because two cases are about that
# one line and the other four have to stay well formed or the list is rejected
# for the wrong reason.
write_list() {
	cat >"$1" <<EOF
# One line per service the base declares.
gateway $2/firewatch/$3@sha256:$digest
jobs $2/firewatch/jobs@sha256:$digest
risk $2/firewatch/risk@sha256:$digest
prevention $2/firewatch/prevention@sha256:$digest
inference $2/firewatch/inference@sha256:$digest
EOF
}

# --- a) an Artifact Registry path, three segments before firewatch ----------
# `<location>-docker.pkg.dev/<project>/<repository>/firewatch/<service>` is the
# shape the target registry serves. A check that admits only one segment before
# `firewatch` rejects the first command of the GKE path.
arcase=$scratch/artifact
scratch_copy "$arcase"
ar=southamerica-west1-docker.pkg.dev/firewatch-project/firewatch-images
write_list "$arcase/images.txt" "$ar" gateway
if out=$(sh "$arcase/overlays/delivery/pin-images.sh" "$arcase/images.txt" 2>&1); then
	:
else
	printf '%s\n' "$out" >&2
	fail "pin-images.sh rejected an Artifact Registry image name, which carries three segments before /firewatch/gateway"
fi
ar_overlay=$arcase/overlays/delivery/kustomization.yaml
pinned=$(grep -cF "    newName: $ar/firewatch/" "$ar_overlay" || true)
[ "$pinned" = 5 ] ||
	fail "the Artifact Registry prefix reached $pinned of the 5 newName lines, want all five"
grep -qxF "    newName: $ar/firewatch/gateway" "$ar_overlay" ||
	fail "the gateway entry does not carry the full Artifact Registry path $ar/firewatch/gateway"
# The placeholder is left in the file's own comment block by design, so the
# claim is about the field the script rewrites and not about the text.
if grep -q "    newName: REPLACE_WITH_REGISTRY_HOST" "$ar_overlay"; then
	fail "the committed placeholder survived a pin in the scratch copy: the rewrite did not happen where it was measured"
fi

# --- b) a single-segment registry host still works --------------------------
# The kind registry is the form every digest in this repository was verified
# against, and widening the check for Artifact Registry must not drop it.
kindcase=$scratch/kind
scratch_copy "$kindcase"
kind_registry=kind-registry:5000
write_list "$kindcase/images.txt" "$kind_registry" gateway
if out=$(sh "$kindcase/overlays/delivery/pin-images.sh" "$kindcase/images.txt" 2>&1); then
	:
else
	printf '%s\n' "$out" >&2
	fail "pin-images.sh rejected the single-segment kind registry host $kind_registry: the form the evidence cluster pulls"
fi
kind_overlay=$kindcase/overlays/delivery/kustomization.yaml
grep -qxF "    newName: $kind_registry/firewatch/gateway" "$kind_overlay" ||
	fail "the kind registry host did not reach the gateway's newName"
kind_pinned=$(grep -cF "    newName: $kind_registry/firewatch/" "$kind_overlay" || true)
[ "$kind_pinned" = 5 ] ||
	fail "the kind registry host reached $kind_pinned of the 5 newName lines, want all five"

# --- c) a name that ends somewhere other than /firewatch/<service> ---------
# Any number of segments is admitted; the last two are not negotiable. The line
# says `gateway` and the image ends in `/firewatch/other-service`, so the entry
# would pin the wrong artifact under a service name. The overlay must stay
# byte-identical, because the script promises a rejected list changes nothing.
wrongcase=$scratch/wrong-suffix
scratch_copy "$wrongcase"
wrong_name=registry.example.com/firewatch/other-service
write_list "$wrongcase/images.txt" registry.example.com other-service
cp overlays/delivery/kustomization.yaml "$wrongcase/original.yaml"
if out=$(sh "$wrongcase/overlays/delivery/pin-images.sh" "$wrongcase/images.txt" 2>&1); then
	fail "pin-images.sh accepted $wrong_name for the gateway line, whose final segment is not the service"
fi
printf '%s\n' "$out" | grep -qF "$wrong_name" ||
	fail "the rejection of $wrong_name did not name the offending image; it said: $out"
printf '%s\n' "$out" | grep -qF "firewatch/gateway" ||
	fail "the rejection of $wrong_name did not say which repository the line had to end in; it said: $out"
cmp -s "$wrongcase/overlays/delivery/kustomization.yaml" "$wrongcase/original.yaml" ||
	fail "a rejected list rewrote the overlay: the script must leave the file as it found it"

# --- d) a doubled slash is still a name with an empty segment ----------------
# Widening to any number of segments must not turn into accepting any string:
# `//` names no repository, and a check built only on the ending would take it.
emptycase=$scratch/empty-segment
scratch_copy "$emptycase"
empty_prefix=southamerica-west1-docker.pkg.dev//firewatch-images
empty_name=$empty_prefix/firewatch/gateway
write_list "$emptycase/images.txt" "$empty_prefix" gateway
cp overlays/delivery/kustomization.yaml "$emptycase/original.yaml"
if out=$(sh "$emptycase/overlays/delivery/pin-images.sh" "$emptycase/images.txt" 2>&1); then
	fail "pin-images.sh accepted $empty_name, which carries an empty path segment"
fi
printf '%s\n' "$out" | grep -qF "does not name firewatch/gateway under a registry host" ||
	fail "the empty-segment rejection does not carry the diagnostic callers match; it said: $out"
cmp -s "$emptycase/overlays/delivery/kustomization.yaml" "$emptycase/original.yaml" ||
	fail "a list with an empty segment rewrote the overlay: the script must leave the file as it found it"

# --- e) no registry path at all -------------------------------------------
# `firewatch/gateway` names a repository relative to whatever registry the
# runtime defaults to, which is not a pin: the check needs at least one segment
# in front of `firewatch/`, and that is the case that fails if the `+` in the
# prefix is ever loosened to `*`.
barecase=$scratch/bare-repository
scratch_copy "$barecase"
cat >"$barecase/images.txt" <<EOF
gateway firewatch/gateway@sha256:$digest
jobs firewatch/jobs@sha256:$digest
risk firewatch/risk@sha256:$digest
prevention firewatch/prevention@sha256:$digest
inference firewatch/inference@sha256:$digest
EOF
cp overlays/delivery/kustomization.yaml "$barecase/original.yaml"
if out=$(sh "$barecase/overlays/delivery/pin-images.sh" "$barecase/images.txt" 2>&1); then
	fail "pin-images.sh accepted firewatch/gateway with no registry path in front of it"
fi
cmp -s "$barecase/overlays/delivery/kustomization.yaml" "$barecase/original.yaml" ||
	fail "a list with no registry path rewrote the overlay: the script must leave the file as it found it"

echo "PASS: pin-images.sh accepts an Artifact Registry path and a single-segment registry host, and rejects a name that does not end in /firewatch/<service>"
