#!/usr/bin/env bash
# Installs the two binaries the pitch VM needs besides Docker: kind and kubectl.
# Versions are pinned and overridable; kubectl matches the node image kind
# v0.29.0 boots (Kubernetes v1.33.1), so client and server agree. Both binaries
# are checked against the checksum published beside them before they are
# installed, so a truncated or substituted download fails here and not later.
#
# Usage (on the VM): bash install-tools.sh
set -euo pipefail

KIND_VERSION="${KIND_VERSION:-v0.29.0}"
KUBECTL_VERSION="${KUBECTL_VERSION:-v1.33.1}"
arch=amd64
[ "$(uname -m)" = aarch64 ] && arch=arm64

command -v docker >/dev/null || { echo "Docker is missing: curl -fsSL https://get.docker.com | sudo sh" >&2; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

curl -fsSLo "$tmp/kind" "https://kind.sigs.k8s.io/dl/${KIND_VERSION}/kind-linux-${arch}"
curl -fsSLo "$tmp/kind.sha256sum" "https://kind.sigs.k8s.io/dl/${KIND_VERSION}/kind-linux-${arch}.sha256sum"
curl -fsSLo "$tmp/kubectl" "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl"
curl -fsSLo "$tmp/kubectl.sha256" "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl.sha256"
# kind's checksum carries the file name it was computed for ("<hash>  kind-linux-<arch>"),
# unlike dl.k8s.io, which serves the bare hash. Only the hash field is kept, so the
# path sha256sum reads back is the temporary file actually downloaded and not the
# name the download happens to carry.
echo "$(awk '{print $1}' "$tmp/kind.sha256sum")  $tmp/kind" | sha256sum --check --quiet
echo "$(cat "$tmp/kubectl.sha256")  $tmp/kubectl" | sha256sum --check --quiet

sudo install -m 0755 "$tmp/kind" /usr/local/bin/kind
sudo install -m 0755 "$tmp/kubectl" /usr/local/bin/kubectl
kind version
kubectl version --client
