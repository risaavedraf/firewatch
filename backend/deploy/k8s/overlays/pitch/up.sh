#!/usr/bin/env bash
# Brings the pitch deployment up on this VM, or updates it after a `git pull`.
#
# Usage (on the VM, from anywhere):
#   bash up.sh <static-ip> <page-origin> <email>     first run
#   bash up.sh                                       later runs (reuses the values)
#
# Example:
#   bash up.sh 34.176.10.20 https://firewatch-pitch.pages.dev equipo@example.com
#
# Every step is idempotent: the cluster, the Secrets, the realm and the edge are
# created once and reused; images are rebuilt and the five Deployments restarted
# on every run so a `git pull` reaches the pods.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
backend=$(cd "$here/../../../.." && pwd)
k8s="$backend/deploy/k8s"
params="$HOME/.firewatch-pitch.env"
cluster=firewatch
ns=firewatch
services="gateway jobs risk prevention inference"

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'up.sh: %s\n' "$*" >&2; exit 1; }

# --- parameters ---------------------------------------------------------------
if [ $# -eq 3 ]; then
	ip=$1 page=${2%/} email=$3
	[[ $ip =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "not an IPv4 address: $ip"
	# These values are written to $params, which is sourced on this run and on every
	# later one, and into a sed replacement. Only characters that mean nothing to a
	# quoted assignment or to sed are accepted, and the file quotes them anyway.
	[[ $page =~ ^https://[A-Za-z0-9.-]+$ ]] ||
		die "the page origin must be https:// plus a host of letters, digits, dots and hyphens, like https://name.pages.dev; got $page"
	[[ $email =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "not an email address: $email"
	dashed=${ip//./-}
	cat >"$params" <<-EOF
	API_HOST='api.$dashed.sslip.io'
	AUTH_HOST='auth.$dashed.sslip.io'
	WEB_ORIGIN='$page'
	ACME_EMAIL='$email'
	EOF
elif [ $# -ne 0 ]; then
	sed -n '2,12p' "$0" >&2; exit 1
fi
[ -f "$params" ] || die "first run needs: bash up.sh <static-ip> <page-origin> <email>"
# shellcheck disable=SC1090
. "$params"
export API_HOST AUTH_HOST WEB_ORIGIN ACME_EMAIL

for tool in docker kind kubectl openssl python3; do
	command -v "$tool" >/dev/null || die "$tool is missing (see install-tools.sh)"
done
if [ -n "$(docker ps -q --filter label=com.docker.compose.project=firewatch)" ]; then
	die "the Docker Compose stack is still running; stop it first: cd $backend && docker compose down"
fi

# --- cluster and addons ---------------------------------------------------------
say "kind cluster '$cluster'"
if ! kind get clusters 2>/dev/null | grep -qx "$cluster"; then
	kind create cluster --config "$here/kind-config.yaml" --wait 120s
fi
kubectl config use-context "kind-$cluster" >/dev/null
# kind-config.yaml already labels the node; labelling it here keeps the run independent of how that configuration is rendered.
kubectl label node --all ingress-ready=true --overwrite >/dev/null
kubectl apply -f "$k8s/base/namespace.yaml"

say "metrics-server and ingress-nginx"
sh "$k8s/local/metrics-server.sh"
sh "$k8s/local/ingress.sh"

say "Secrets and internal CA"
sh "$k8s/bootstrap-secrets.sh"

# --- images ---------------------------------------------------------------------
say "building and loading images"
for svc in $services; do
	docker build -q -f "$backend/services/$svc/Dockerfile" -t "firewatch/$svc:pitch" "$backend" >/dev/null
	kind load docker-image "firewatch/$svc:pitch" --name "$cluster" >/dev/null
	echo "  firewatch/$svc:pitch"
done

# --- manifests ------------------------------------------------------------------
render() {
	kubectl kustomize "$here" | sed \
		-e "s|PITCH_API_HOST|$API_HOST|g" \
		-e "s|PITCH_AUTH_HOST|$AUTH_HOST|g" \
		-e "s|PITCH_WEB_ORIGIN|$WEB_ORIGIN|g"
}
say "applying the pitch overlay"
render | kubectl apply -f -

say "waiting for the data plane"
for r in $(kubectl -n "$ns" get statefulset -o name); do
	kubectl -n "$ns" rollout status "$r" --timeout=600s
done

# The bootstrap Jobs can race a cold database on the first run (the k8s README
# records it on kind). A failed Job is deleted and applied again once.
say "waiting for the bootstrap Jobs"
for job in $(kubectl -n "$ns" get jobs -o name); do
	if ! kubectl -n "$ns" wait "$job" --for=condition=complete --timeout=600s; then
		echo "  $job did not complete; retrying it once"
		kubectl -n "$ns" delete "$job"
		render | kubectl apply -f -
		kubectl -n "$ns" wait "$job" --for=condition=complete --timeout=600s
	fi
done

say "restarting the application on the freshly loaded images"
for svc in $services; do kubectl -n "$ns" rollout restart "deployment/$svc" >/dev/null; done
for r in $(kubectl -n "$ns" get deployment -o name); do
	kubectl -n "$ns" rollout status "$r" --timeout=600s
done

# --- realm and edge -------------------------------------------------------------
say "realm firewatch"
python3 "$here/provision-realm.py" "$WEB_ORIGIN"

say "public edge (Caddy on the host)"
docker rm -f firewatch-edge >/dev/null 2>&1 || true
docker run -d --name firewatch-edge --restart unless-stopped --network host \
	-e API_HOST -e AUTH_HOST -e ACME_EMAIL \
	-v "$here/Caddyfile:/etc/caddy/Caddyfile:ro" \
	-v firewatch-edge-data:/data -v firewatch-edge-config:/config \
	caddy:2.10-alpine >/dev/null

say "checking https://$API_HOST/health/ready (the first certificate can take a minute)"
answer=nothing
for _ in $(seq 1 30); do
	# --max-time bounds each attempt, so a hung connection cannot stall the loop.
	if code=$(curl -s --connect-timeout 5 --max-time 15 -o /dev/null -w '%{http_code}' \
		"https://$API_HOST/health/ready"); then
		answer=$code
	fi
	if [ "$answer" = 204 ]; then
		break
	fi
	sleep 5
done
echo "  answered $answer"
[ "$answer" = 204 ] || die "https://$API_HOST/health/ready never answered 204 (last answer: $answer).
Look at: docker logs --tail 50 firewatch-edge  (Caddy and the certificate)
         kubectl -n firewatch get ingress,pods    (routes and readiness)
         kubectl -n firewatch logs deploy/gateway --tail 50
Ports 80 and 443 must be open on the VM; the first certificate takes a minute."

cat <<EOF

Done.
  API:    https://$API_HOST
  Login:  https://$AUTH_HOST/realms/firewatch/.well-known/openid-configuration
  Page:   $WEB_ORIGIN   (build the frontend with these three lines in frontend/.env.production)

VITE_GATEWAY_ORIGIN=https://$API_HOST
VITE_ISSUER=https://$AUTH_HOST/realms/firewatch
VITE_REDIRECT_URI=$WEB_ORIGIN/
EOF
