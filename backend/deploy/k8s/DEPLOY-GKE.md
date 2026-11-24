# Deploying FireWatch on GKE — an executable runbook

**Status: none of this has been executed.** `gcloud` is not installed on the machine this file was written on, there is no Google Cloud project, no cluster and no credentials, so every command below is transcribed from the CLI's documented surface or from this tree's own scripts, and every "Expected" line is a criterion somebody still has to observe rather than a recorded output. Where a flag is provider knowledge and not a measurement, the step says so.

The reader is an agent, not a person. Execute the phases in order. Do not reorder them, and do not fill a gap with a plausible value.

Each step gives its literal commands first, then **Expected** (what must be observed), **If it fails** (where to look), and **Do not continue unless** (the hard condition). A step without all three is an omission, not a step with less to check.

## Values

| Value | What it identifies | Default or source |
| --- | --- | --- |
| `PROJECT_ID` | The Google Cloud project every other name lives in | Supplied by the receiving team. No default. |
| `REGION` | Region of the cluster, the registry and the bucket | `southamerica-west1` |
| `CLUSTER` | GKE cluster name | Supplied by the receiving team. No default. |
| `REPO` | Artifact Registry Docker repository name | Supplied by the receiving team. No default. |
| `BUCKET` | Cloud Storage bucket name for backup dumps, without the `gs://` prefix | Supplied by the receiving team. No default. |
| `DOMAIN` | Public DNS name the edge certificate certifies | Supplied by the receiving team. No default. |
| `COMMIT` | Full 40-character commit SHA of the release being deployed | Supplied by the receiving team. No default. |

**No other value may be invented.** If a step needs an input that is not in this table and not derived from it, the input is missing: stop and ask for it instead of choosing one.

Two values are derived, never asked for, and are computed here exactly once:

```sh
REGISTRY_PATH="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}"
NAMESPACE=firewatch          # base/namespace.yaml:4, the namespace every object and SAN carries
```

Hold the seven values in the shell that runs these steps:

```sh
export PROJECT_ID=<project> REGION=southamerica-west1 CLUSTER=<cluster> REPO=<repository> \
       BUCKET=<bucket> DOMAIN=<domain> COMMIT=<40-hex-sha>
export REGISTRY_PATH="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}" NAMESPACE=firewatch
```

## Preconditions the agent cannot supply

Each item below is outside this runbook and outside the repository. Any missing item is a **STOP**: ask the receiving team, do not substitute, and do not continue to the next phase.

1. **A Google Cloud project with billing enabled.** No command here attaches a billing account.
2. **Authority over `DOMAIN` and a certificate that certifies it.** The repository owns no DNS name and holds no public certificate: `base/ingress.yaml:52-53` names `firewatch.example.invalid` and the Secret `firewatch-tls`, and `bootstrap-secrets.sh` deliberately does not create that Secret.
3. **`gcloud`, `docker` and `kubectl` on `PATH`**, authenticated as an identity allowed to create the cluster, the repository and the bucket.
4. **The internal CA signing key, at `FIREWATCH_CA_KEY`, when this run reuses the authority already in the cluster.** 4.1a decides which case this is. **Reuse:** the key is a precondition — without it `bootstrap-secrets.sh` keeps existing certificates and cannot issue new ones (`bootstrap-secrets.sh:207-211`). **Fresh:** the key is an *output*, not a precondition — it must not exist at the pinned path, and `bootstrap-secrets.sh` creates it there when the `firewatch-ca` Secret is absent (`:146-165`, the `cp` at `:162`). A second authority beside the first breaks every certificate and the edge anchor at once, so 4.1b stops when the key and the Secret disagree and 4.1c stops when a key already sits on the fresh path. The script itself compares neither: it does not look at the `ca.crt` the cluster holds, and it does not check the path before writing.

Do not invent a domain, do not skip authentication, and do not treat a missing item as a later task: every gate below is designed to catch a substituted value, and none of them reports the substitution kindly.

## Phase 0 — Prove the tree is the release (no cloud access)

### 0.1 Confirm the commit

```sh
cd "$(git rev-parse --show-toplevel)"
test "$(git rev-parse HEAD)" = "$COMMIT" && echo "commit ok"
```

**Expected:** `commit ok`.

**If it fails:** check out `$COMMIT`. A clean working tree is not required for the render, but a modified `base/` or `overlays/` makes every later gate meaningless.

**Do not continue unless** `HEAD` equals `$COMMIT`.

### 0.2 Run the two contract checks

```sh
sh backend/deploy/k8s/tests/pin-images-contract.sh
bash backend/deploy/k8s/tests/render-contract.sh
```

**Expected:** exactly these two lines.

```text
PASS: pin-images.sh accepts an Artifact Registry path and a single-segment registry host, and rejects a name that does not end in /firewatch/<service>
PASS: render contract holds for the bootstrap Jobs, the application workloads and the delivery overlay
```

**If it fails:** the tree is not the release. `render-contract.sh` reads `base/` and both renders; a failure is a manifest defect, not an environment one. Do not repair a manifest to get past it — deploy the release that passes, or stop.

**Do not continue unless** both lines are printed and both exit statuses are `0`.

## Phase 1 — Provision (project, APIs, cluster, registry, bucket, permissions)

### 1.1 Select the project and enable the three APIs

```sh
gcloud config set project "$PROJECT_ID"
gcloud services enable container.googleapis.com artifactregistry.googleapis.com storage.googleapis.com
```

**Expected:** `Updated property [core/project]`, then a silent success from `services enable`.

**If it fails:** with `PERMISSION_DENIED`, the authenticated identity lacks `serviceusage.services.enable` on the project — ask, do not retry with another account. With billing errors, precondition 1 is unmet.

**Do not continue unless** both commands exit `0`.

### 1.2 Create the cluster

```sh
gcloud container clusters create "$CLUSTER" \
  --region "$REGION" \
  --release-channel regular \
  --workload-pool="${PROJECT_ID}.svc.id.goog" \
  --enable-network-policy
```

Three flags are the load-bearing ones, and all three are unexecuted provider knowledge rather than observations:

- `--workload-pool` enables Workload Identity. It is a create-time decision because a cluster created without it cannot be patched into the binding the backup identity needs.
- `--enable-network-policy` is what makes `base/network.yaml` behaviour instead of objects the API stores. On GKE Standard's default network the policies are accepted and none of them is applied, so this flag plus the gate in step 5.5 is the whole of the enforcement claim.
- `--release-channel regular` pins the upgrade channel; the tree pins no Kubernetes version because the APIs it uses are GA.

Machine type, node count and autoscaling are sizing decisions this runbook does not make. Which machine types `$REGION` offers is confirmed at contracting.

**Expected:** a cluster in `RUNNING`, and `kubectl config current-context` naming it after step 1.3.

**If it fails:** `--enable-network-policy` or `--workload-pool` rejected by the API version means the flags changed — read the error and stop; do not drop the flag to make creation succeed, because the gate in 5.5 will then fail on a cluster that has no way to pass it.

**Do not continue unless** the cluster exists with both flags set. Verify, rather than assume:

```sh
gcloud container clusters describe "$CLUSTER" --region "$REGION" \
  --format='yaml(workloadIdentityConfig,addonsConfig.networkPolicyConfig)'
```

**Expected:** `networkPolicyConfig` with `disabled: false` (or the field absent, which is the same state) and a `workloadIdentityConfig.workloadPool` of `${PROJECT_ID}.svc.id.goog`.

### 1.3 Point `kubectl` at it

```sh
gcloud container clusters get-credentials "$CLUSTER" --region "$REGION"
kubectl -n kube-system get pods | head -5
```

**Expected:** a context is fetched and the control-plane pods are listed. This replaces the `kind` context every observation in `README.md` came from.

**If it fails:** an authorisation plugin error means precondition 3 is only half met — `gcloud` is authenticated but `kubectl` is not reading the same credential.

**Do not continue unless** `kubectl` answers and `kubectl config current-context` names `$CLUSTER`.

### 1.4 Create the Artifact Registry repository, and a push credential

```sh
gcloud artifacts repositories create "$REPO" \
  --repository-format=docker --location="$REGION"
gcloud auth configure-docker "${REGION}-docker.pkg.dev"
```

**Expected:** the repository exists, and `configure-docker` writes the `${REGION}-docker.pkg.dev` entry into the Docker config, so `docker push` is authenticated.

**If it fails:** `ALREADY_EXISTS` is not a failure — read the repository back with `gcloud artifacts repositories describe "$REPO" --location="$REGION"` and continue only if it is a Docker repository in `$REGION`.

**Do not continue unless** the repository is Docker-format and its location is `$REGION`.

### 1.5 Create the bucket

```sh
gcloud storage buckets create "gs://${BUCKET}" --location="$REGION"
gcloud storage buckets describe "gs://${BUCKET}" --format='value(location)'
```

**Expected:** the bucket reports `$REGION`.

**If it fails:** a bucket name collision is global — do not pick another name yourself; the name is part of `$BUCKET` and belongs to the receiving team.

**Do not continue unless** the bucket exists at `$REGION`. The 30-day lifecycle rule that enforces retention belongs to the backup policy (`odd/entrega/acta-cierre.md` §7) and is **not** set here.

### 1.6 Grant the nodes pull permission

An image pull is the kubelet's, so the credential is the node's identity and no NetworkPolicy governs it. Read which principal that is, then grant it:

```sh
NODE_SA="$(gcloud container clusters describe "$CLUSTER" --region "$REGION" \
  --format='value(nodeConfig.serviceAccount)')"
echo "$NODE_SA"
gcloud artifacts repositories add-iam-policy-binding "$REPO" --location="$REGION" \
  --member="serviceAccount:${NODE_SA}" --role=roles/artifactregistry.reader
```

**Expected:** `${NODE_SA}` names the node service account, and the binding is added for `roles/artifactregistry.reader`. Which principal that is differs between Standard and Autopilot, which is why it is read and not assumed.

**If it fails:** a value of `default` (or an empty one) means the cluster reports the Compute Engine default account; read the real email from `gcloud container clusters describe "$CLUSTER" --region "$REGION" --format='yaml(nodeConfig,nodePools[].config.serviceAccount)'` and grant the role to that account. Do not grant the role to a broad group.

**Do not continue unless** the binding reads back:

```sh
gcloud artifacts repositories get-iam-policy "$REPO" --location="$REGION" --format=json | grep -c "$NODE_SA"
```

**Expected:** a count of at least `1`.

### 1.7 Confirm what GKE already supplies

```sh
kubectl get storageclass
kubectl get apiservice v1beta1.metrics.k8s.io \
  -o jsonpath='{.status.conditions[?(@.type=="Available")].status}{"\n"}'
kubectl top nodes
```

**Expected:** a default StorageClass of `standard-rwo` (Compute Engine persistent disks, `ReadWriteOnce`); `True` from the aggregated metrics API; and `kubectl top nodes` printing one row per node instead of an error. Neither claim names a class (`base/postgres.yaml:200-207`, `base/rabbitmq.yaml:205-212`), so the cluster default is the choice, and both defaults are exactly what the two claims need.

**If it fails:** a default class of `standard` means a cluster created before the CSI driver became the default — read the class and stop if neither binds `ReadWriteOnce`. `kubectl top` failing means the metrics pipeline is not serving, and the four HPAs of `base/autoscaling.yaml` would never compute a ratio.

**Do not continue unless** a default StorageClass exists, the APIService reports `True`, and `kubectl top nodes` answers.

## Phase 2 — Build and publish the five images

### 2.1 Build

The build context is `backend/`, which is what CI uses (`.github/workflows/_go-service.yml:49-55`) and what each Dockerfile copies from (`services/<service>/`).

```sh
cd backend
for service in gateway jobs risk prevention inference; do
  docker build --platform linux/amd64 \
    -f "services/${service}/Dockerfile" \
    -t "${REGISTRY_PATH}/firewatch/${service}:${COMMIT}" . || exit 1
done
```

**Expected:** five successful builds. The runtime stage is `gcr.io/distroless/static-debian12:nonroot`, so the images carry no shell — that is expected and is what makes the next phases use `kubectl exec` on nothing.

**If it fails:** `--platform` needs BuildKit (`DOCKER_BUILDKIT=1`, or the containerd image store CI enables). A builder without it is not a reason to drop the flag: build on an amd64 machine, because a non-amd64 image is pulled by the nodes and fails to start.

**Do not continue unless** all five builds exit `0`.

### 2.2 Publish

```sh
for service in gateway jobs risk prevention inference; do
  docker push "${REGISTRY_PATH}/firewatch/${service}:${COMMIT}" || exit 1
done
```

**Expected:** five pushes, each printing a digest line ending in `digest: sha256:<64 hex>`.

**If it fails:** `denied` means the push credential of step 1.4 is not in effect; `not found` means the tag built in 2.1 does not exist under this name.

**Do not continue unless** all five pushes exit `0`.

### 2.3 Record the digests

```sh
for service in gateway jobs risk prevention inference; do
  printf '%s %s\n' "$service" \
    "$(docker inspect --format='{{index .RepoDigests 0}}' "${REGISTRY_PATH}/firewatch/${service}:${COMMIT}")"
done
```

**Expected:** five lines of the shape

```text
gateway southamerica-west1-docker.pkg.dev/<project>/<repository>/firewatch/gateway@sha256:<64 lowercase hex digits>
```

The tag names a mutable pointer; the digest names one artifact. Everything after this point uses the digest, and the tag is never referenced again.

**If it fails:** an empty `RepoDigests` means the image was never pushed (2.2), not that it was built wrong.

**Do not continue unless** you hold five digests of 64 lowercase hex digits each.

## Phase 3 — Pin the digests into the overlay

### 3.1 Write the image list

The base renders `firewatch/<service>:replace-before-deploy` on purpose; the overlay is what the cluster applies, and it is where a digest belongs.

```sh
cd "$(git rev-parse --show-toplevel)"
cat > images.txt <<EOF
gateway ${REGISTRY_PATH}/firewatch/gateway@sha256:<gateway digest>
jobs ${REGISTRY_PATH}/firewatch/jobs@sha256:<jobs digest>
risk ${REGISTRY_PATH}/firewatch/risk@sha256:<risk digest>
prevention ${REGISTRY_PATH}/firewatch/prevention@sha256:<prevention digest>
inference ${REGISTRY_PATH}/firewatch/inference@sha256:<inference digest>
EOF
```

**Expected:** five lines, one per service the base declares. Blank lines and `#` comments are allowed; nothing else is.

**If it fails:** the script rejects a malformed line, a repeated service, a service the base does not declare, and a base service the list omits, naming the offending line or service and leaving the overlay untouched.

**Do not continue unless** the file has exactly one line per service and `$REGISTRY_PATH` appears in every one.

### 3.2 Pin

```sh
sh backend/deploy/k8s/overlays/delivery/pin-images.sh images.txt
```

**Expected:** exit `0`, no output, and a rewritten `overlays/delivery/kustomization.yaml`. The script is plain `awk` over the list and the overlay: no `docker`, no registry access, no `yq`, and it is idempotent — a second run with the same list leaves the file byte for byte identical.

**If it fails:** read the message; it names the line or the service. Fix the list, never the overlay.

**Do not continue unless** the command exits `0`.

### 3.3 Review what changed, and render

```sh
git diff --stat
git diff backend/deploy/k8s/overlays/delivery/kustomization.yaml
kubectl kustomize backend/deploy/k8s/overlays/delivery | grep -E '^ +image: ' | sort
```

**Expected:** the diff touches only `newName` and `digest` in the five `images` entries, and the render's five application images are `.../firewatch/<service>@sha256:<digest>` — the digests from 2.3, with no `replace-before-deploy` and no `REPLACE_WITH_REGISTRY_HOST` left.

**If it fails:** a placeholder still present in the render means the overlay was not rewritten (3.2). A digest that differs from 2.3 means the list was mistyped; re-run 3.2 from a corrected list.

**Do not continue unless** all five rendered images are pinned by the digests recorded in 2.3.

## Phase 4 — Secrets, the CA and the edge certificate

### 4.1 Pin the client, the work path and exclusive control

`bootstrap-secrets.sh` has two CA paths and no guard between them. When `firewatch-ca` exists it reads `ca.crt` out of that Secret (`bootstrap-secrets.sh:146-151`); when it does not, it mints a new authority and copies the new key over `$FIREWATCH_CA_KEY` without asking (`:152-165`, the `cp` at `:162`). On the reuse path it copies whatever key sits at that path into its work directory (`:207-208`) and signs with it — it never compares that key with the `ca.crt` the cluster holds. The script also takes no `--context` and no `--kubeconfig`: it follows the current context of the `kubectl` it is given.

So the runbook pins the client and one work directory before anything is read, and every later step reuses them verbatim. Writing here means writing outside the repository, so no command below changes the working directory.

```sh
RUNBOOK_WORK="$HOME/.firewatch-runbook"                 # absolute, outside the repository
KUBECTL="$(command -v kubectl)"                         # absolute: the checks and the script use this binary
KUBE_CONTEXT="$("$KUBECTL" config current-context)"     # pinned: every check passes --context
mkdir -p "$RUNBOOK_WORK"
export RUNBOOK_WORK KUBECTL KUBE_CONTEXT
# openssl here is a native binary on Git Bash: it needs a Windows-shaped path there and the POSIX one elsewhere.
NATIVE="$(cygpath -m "$RUNBOOK_WORK" 2>/dev/null || printf '%s' "$RUNBOOK_WORK")"
export NATIVE
printf 'kubectl=%s\ncontext=%s\nwork=%s\n' "$KUBECTL" "$KUBE_CONTEXT" "$RUNBOOK_WORK"
```

**Expected:** three lines — an absolute `kubectl=`, the context this deployment targets, and an absolute `work=` outside the repository. On a POSIX host, run `chmod 700 "$RUNBOOK_WORK"` and confirm `ls -ld "$RUNBOOK_WORK"` shows `drwx------`; Git Bash does not enforce the mode, so there the directory is private by location and holds nothing but this run's files.

Then the control this phase needs, which is not a lock file:

**Exclusive control of the namespace, for the whole phase.** One identity, one kubeconfig, one operator: no second session and no automation with write access to `firewatch` until 4.2 finishes. A lock on this machine cannot bind another host, so the runbook does not pretend to lock anything; 4.2 re-reads the cluster state immediately before the bootstrap and stops when it is not the state 4.1 validated. Requiring the control and observing the state are the two halves — neither is a guarantee.

**Do not continue unless** the block above printed its three lines and exclusive control holds.

#### 4.1a Read the cluster: reuse or fresh

Two commands, no branch and no loop. The namespace comes first because its absence answers the mode question on its own.

```sh
"$KUBECTL" --context "$KUBE_CONTEXT" get namespace firewatch -o name
```

**Expected:** `namespace/firewatch`. **If it fails** with `Error from server (NotFound): namespaces "firewatch" not found`, the namespace does not exist, so no Secret can exist and the mode is **fresh with no material**: skip the next command and go to 4.1c. Any other failure is a stop — a failed call is not evidence of absence.

```sh
"$KUBECTL" --context "$KUBE_CONTEXT" -n firewatch get secret -o name
```

**Expected:** the namespace's inventory, one `secret/<name>` per line. Decide from the list, and only from it:

| The list contains | Mode | Next |
| --- | --- | --- |
| `secret/firewatch-ca` | reuse | 4.1b |
| no `secret/firewatch-ca`, no `<service>-tls`, no `secret/gateway-upstream-ca` | fresh | 4.1c |
| no `secret/firewatch-ca`, but a `<service>-tls` or `secret/gateway-upstream-ca` | stop | — |

Names are matched whole: `secret/firewatch-ca-old` is not the authority and `secret/gateway-tls-backup` is not an issued certificate, so neither makes the run a reuse. The third row is a refusal, not a decision point: a new authority beside old certificates splits the chain (4.1c says why), and nothing is removed to reach "fresh".

**Do not continue unless** the row you observed names exactly one mode.

#### 4.1b Reuse: the pinned key signs for `secret/firewatch-ca`

```sh
CA_KEY="${CA_KEY:-${FIREWATCH_CA_KEY:-$HOME/.firewatch-internal-ca/ca.key}}"
case "$CA_KEY" in /*|[A-Za-z]:/*) ;; *) echo "STOP: CA_KEY must be absolute: $CA_KEY"; exit 1 ;; esac
export CA_KEY
: > "$NATIVE/ca.crt"
"$KUBECTL" --context "$KUBE_CONTEXT" -n firewatch get secret firewatch-ca \
  -o jsonpath='{.data.ca\.crt}' > "$RUNBOOK_WORK/ca.b64" \
  && test -s "$RUNBOOK_WORK/ca.b64" && echo "ca.crt read and non-empty" \
  || { echo "STOP: secret/firewatch-ca has no ca.crt, or the read failed"; exit 1; }
base64 --decode < "$RUNBOOK_WORK/ca.b64" > "$NATIVE/ca.crt"
openssl x509 -in "$NATIVE/ca.crt" -noout -subject \
  || { echo "STOP: ca.crt is not a certificate"; exit 1; }
```

**Expected:** `ca.crt read and non-empty`, then a `subject=` line. The decoded file is truncated first, so a previous run’s certificate cannot stand in for this one.

```sh
: > "$NATIVE/key.pub"; : > "$NATIVE/ca.pub"
test -f "$CA_KEY" && test -s "$CA_KEY" || { echo "STOP: no CA key at $CA_KEY"; exit 1; }
openssl pkey -in "$(cygpath -m "$CA_KEY" 2>/dev/null || printf '%s' "$CA_KEY")" \
  -pubout -out "$NATIVE/key.pub" || { echo "STOP: cannot derive a public key from $CA_KEY"; exit 1; }
openssl x509 -in "$NATIVE/ca.crt" -noout -pubkey > "$NATIVE/ca.pub" \
  || { echo "STOP: cannot read the public key out of ca.crt"; exit 1; }
test -s "$RUNBOOK_WORK/key.pub" && test -s "$RUNBOOK_WORK/ca.pub" || { echo "STOP: empty public-key output"; exit 1; }
cmp -s "$RUNBOOK_WORK/key.pub" "$RUNBOOK_WORK/ca.pub" && echo "key matches firewatch-ca"
```

**Expected:** no output from either `openssl` command, then `key matches firewatch-ca`. Both output files are truncated before use and each `openssl` call stops on its own failure, so a previous run's public key cannot be compared against this one's. A missing key stops (`STOP: no CA key`), and so does a read or derivation failure — `bootstrap-secrets.sh` would otherwise keep the certificates that already exist and issue none (`:207-211`), so a missing `<service>-tls` stays missing and the pod that mounts it stays in `CreateContainerConfigError`. `cmp` exiting `1` — no output — also stops: the key at `$CA_KEY` is not the authority in the Secret, and signing with it would produce certificates that every `TLS_CA_FILE` consumer and the edge anchor reject. Nothing has been written at that point.

**If it fails:** change `CA_KEY` to the right absolute path and re-run this block, or stop and ask which authority the cluster should have; do not mint a replacement to make the comparison pass. `Could not open file or uri` is the Git Bash path constraint the `NATIVE` form exists to avoid; `Could not find private key` means the file at that path is not a private key (a certificate copied to the wrong name is the usual cause).

**Do not continue unless** the match line is printed.

#### 4.1c Fresh: a dedicated parent with no output, and an approval

A new authority invalidates every certificate the previous one signed. `issue_certificate` skips Secrets that already exist (`:124-126`), and the edge anchor is only created when it is absent (`bootstrap-secrets.sh:197-201`), so a fresh CA in a namespace that still holds issued certificates does not replace the chain — it splits it. `firewatch-ca` becomes the new root, every `<service>-tls` and the `gateway-upstream-ca` copy stay on the old one, and the split is invisible from 6.3: the Ingress still verifies the old gateway leaf and still answers `401` while every workload that mounts `ca.crt` as its `TLS_CA_FILE` rejects the peers it used to trust. `README.md:196` calls this what it is — a CA *replacement*, not a rotation — and `README.md:192-194` names the material that has to be reissued and overlapped together, none of which this runbook does. So this mode accepts only a parent that holds no output yet, and requires the operator's approval first.

```sh
CA_KEY="${CA_KEY:-${FIREWATCH_CA_KEY:-$RUNBOOK_WORK/ca/ca.key}}"
case "$CA_KEY" in /*|[A-Za-z]:/*) ;; *) echo "STOP: CA_KEY must be absolute: $CA_KEY"; exit 1 ;; esac
CA_KEY_DIR="$(dirname "$CA_KEY")"
mkdir -p "$CA_KEY_DIR"
export CA_KEY CA_KEY_DIR
test -n "${FRESH_CA_CONFIRMED:-}" && echo "fresh CA approved: $FRESH_CA_CONFIRMED"
test -d "$CA_KEY_DIR" && echo "dedicated parent: $CA_KEY_DIR"
test ! -e "$CA_KEY" && test ! -L "$CA_KEY" && echo "no key at $CA_KEY"
ls -A "$CA_KEY_DIR"
```

**Expected:** `fresh CA approved: <who and where>`, `dedicated parent: <absolute path>`, `no key at <path>`, and no output at all from `ls -A` — the parent is private and holds no prior output. **If it fails:** a key at the path stops the run, because `bootstrap-secrets.sh` would overwrite it (`:160-163`) and it may be the only copy of an authority another cluster still trusts; point `CA_KEY` at a new absolute path, re-run 4.1 and this block, and leave the old key where it is. A parent that is not empty is the same stop for a different reason: it is no longer a dedicated parent. On a POSIX host `chmod 700 "$CA_KEY_DIR"` as well.

`FRESH_CA_CONFIRMED` is the operator's approval, not a formality: "it has not started yet" is a reason to stop here and wait, and nothing has been written when this block refuses.

**Do not continue unless** all three lines are printed and `ls -A` printed nothing. Then 4.2 mints the authority and writes the key there; re-running 4.1a's inventory (it now holds `secret/firewatch-ca`) and 4.1b gives the post-condition.

### 4.2 Create the namespace material

Same client, same context, same absolute key path, and the cluster still in the state 4.1 validated. These checks are what makes an environment change stop the bootstrap instead of racing it:

```sh
test "$(command -v kubectl)" = "$KUBECTL" || { echo "STOP: kubectl resolves to $(command -v kubectl), not $KUBECTL"; exit 1; }
test "$("$KUBECTL" config current-context)" = "$KUBE_CONTEXT" || { echo "STOP: the current context is not $KUBE_CONTEXT"; exit 1; }
echo "client and context: $KUBECTL @ $KUBE_CONTEXT"
```

Then the re-read that belongs to the mode 4.1a chose, immediately before the call. **Reuse:**

```sh
test -f "$CA_KEY" && test -s "$CA_KEY" || { echo "STOP: the reuse key is no longer at $CA_KEY"; exit 1; }
"$KUBECTL" --context "$KUBE_CONTEXT" -n firewatch get secret firewatch-ca \
  -o jsonpath='{.data.ca\.crt}' > "$RUNBOOK_WORK/ca.now.b64" \
  && cmp -s "$RUNBOOK_WORK/ca.b64" "$RUNBOOK_WORK/ca.now.b64" \
  && echo "authority, key and context unchanged since 4.1b" \
  || { echo "STOP: secret/firewatch-ca changed since 4.1b, or the read failed; the key cannot be checked against the authority this call would sign from"; exit 1; }
# The last check before the call: the freshly read certificate's public key against the key the call will pass.
base64 --decode < "$RUNBOOK_WORK/ca.now.b64" > "$RUNBOOK_WORK/ca.now.crt"
openssl x509 -in "$(cygpath -m "$RUNBOOK_WORK/ca.now.crt" 2>/dev/null || printf '%s' "$RUNBOOK_WORK/ca.now.crt")" \
  -noout -pubkey > "$RUNBOOK_WORK/ca.now.pub" \
  || { echo "STOP: the ca.crt read from secret/firewatch-ca is not a certificate (kept at $RUNBOOK_WORK/ca.now.crt)"; exit 1; }
openssl pkey -in "$(cygpath -m "$CA_KEY" 2>/dev/null || printf '%s' "$CA_KEY")" -pubout > "$RUNBOOK_WORK/ca.key.pub" \
  || { echo "STOP: cannot read a public key from the operator key at $CA_KEY"; exit 1; }
cmp -s "$RUNBOOK_WORK/ca.key.pub" "$RUNBOOK_WORK/ca.now.pub" \
  && echo "key at $CA_KEY matches the ca.crt now in secret/firewatch-ca" \
  || { echo "STOP: the key at $CA_KEY does not belong to the CA in secret/firewatch-ca (that certificate is kept at $RUNBOOK_WORK/ca.now.crt, and the bootstrap has not been invoked). Point FIREWATCH_CA_KEY at the key of that CA — the path is currently $CA_KEY — or rotate the authority deliberately (README.md:192-196) if that is what you want. Nothing has been written."; exit 1; }
rm -f "$RUNBOOK_WORK/ca.now.b64" "$RUNBOOK_WORK/ca.now.crt" "$RUNBOOK_WORK/ca.now.pub" "$RUNBOOK_WORK/ca.key.pub"
```

**Expected:** `client and context: ...`, then `authority, key and context unchanged since 4.1b`, then `key at <path> matches the ca.crt now in secret/firewatch-ca`. A missing `authority, key and context unchanged since 4.1b` means the key moved, the Secret changed, or the read failed — another writer touched the authority between the check and the call, so stop without invoking. A missing `key at ... matches ...` is the mismatch this block exists for: the key at `$CA_KEY` and the `ca.crt` the Secret holds are not a pair, and the bootstrap is **not** invoked — the message names both paths and the two ways forward. The next block that runs on this mode is the call itself.

**Fresh:**

```sh
test -n "$CA_KEY" && test ! -e "$CA_KEY" && test ! -L "$CA_KEY" || { echo "STOP: CA_KEY is unset or no longer absent: '$CA_KEY'"; exit 1; }
"$KUBECTL" --context "$KUBE_CONTEXT" -n firewatch get secret -o name
```

**Expected:** `client and context: ...`, and an inventory with no `secret/firewatch-ca`, no `<service>-tls` and no `secret/gateway-upstream-ca` — or the `NotFound` namespace 4.1a saw. A new CA Secret means a rotation started elsewhere: stop.

Then the call, with the pinned client and the pinned absolute key path in its environment:

```sh
FIREWATCH_CA_KEY="$CA_KEY" KUBECTL="$KUBECTL" sh backend/deploy/k8s/bootstrap-secrets.sh firewatch
```

**Expected:** a `namespace/firewatch` line and the Secrets and ConfigMaps of `README.md` ("Configure before applying", step 4). The script never prints a secret, never writes one into the repository, and never rewrites an existing one. `KUBECTL` is the absolute binary 4.1 pinned — the script takes one executable path, never extra arguments — and `FIREWATCH_CA_KEY` is the absolute path 4.1b or 4.1c pinned, so the script cannot fall back to `$HOME`. The script takes no `--context`; it follows the current context, which the assertion above tied to `$KUBE_CONTEXT`.

**If it fails:** `missing .../namespace.yaml` means the script was run outside the tree. On Git Bash/MSYS the CA step dies without a message — `README.md`, "Running the bootstrap on Windows", is the workaround and it is a host constraint, not a defect.

**Do not continue unless** these objects exist (same context):

```sh
"$KUBECTL" --context "$KUBE_CONTEXT" -n firewatch get secret firewatch-ca gateway-upstream-ca firewatch-tls 2>&1
```

**Expected:** `firewatch-ca` and `gateway-upstream-ca` exist. `firewatch-tls` **must not** — it is created in 4.3, and a `firewatch-tls` the script produced would be a certificate for a name nobody owns.

Then close the phase: re-run 4.1b with the same client, context and key path. Its match line is the post-condition for either mode — on a fresh run it proves the key the script wrote is the signing key of the `ca.crt` the cluster now holds; on a reuse run it proves nothing changed under the run.

### 4.3 The edge certificate

The gateway is HTTPS-only behind the Ingress, and the edge certificate certifies `$DOMAIN`; the repository cannot supply either.

```sh
kubectl -n firewatch create secret tls firewatch-tls \
  --cert="tls/${DOMAIN}.crt" --key="tls/${DOMAIN}.key"
openssl x509 -in "tls/${DOMAIN}.crt" -noout -ext subjectAltName
```

**Expected:** the Secret is created, and the SAN list contains `DNS:$DOMAIN`. `base/ingress.yaml:52-53` serves this Secret for that host.

**If it fails:** `error: tls: private key does not match public key` means the pair is wrong — ask for the right pair; do not generate a self-signed one for a public name.

**Do not continue unless** the Secret exists and the certificate's SAN carries `$DOMAIN`.

### 4.4 The identity realm is out of band — do not import one

The only realm file in the tree is the development one, whose `${DEMO_ADMIN_PASSWORD}`, `${DEMO_VIEWER_PASSWORD}` and `${DIRECTORY_CLIENT_SECRET}` placeholders no Secret here supplies. `bootstrap-secrets.sh` renders it as the `keycloak-realm` ConfigMap and **no Deployment mounts or imports it**.

**Expected:** a Keycloak that answers with no `firewatch` realm after its pod starts. That is the correct state, not a silent failure.

**Do not continue to any authenticated test** until the receiving team says the realm exists. Read the first administrator out of the cluster and hand it over; it is the one Secret whose values an operator must read:

```sh
kubectl -n firewatch get secret keycloak-bootstrap-admin \
  -o jsonpath='{.data.KC_BOOTSTRAP_ADMIN_USERNAME}{"\n"}{.data.KC_BOOTSTRAP_ADMIN_PASSWORD}{"\n"}'
```

**Expected:** two non-empty base64 lines. Decode the first as the username and the second as the password, and hand over **both**: the username alone cannot create the realm. The handoff goes over the secure channel the receiving team already uses — never into this repository, a commit, a ticket, or a log.

The startup options create a **temporary** admin account only on the initial start, when the master realm does not exist yet (Keycloak 26.5.7, `docs/guides/server/bootstrap-admin-recovery.adoc` L9-L27: <https://github.com/keycloak/keycloak/blob/26.5.7/docs/guides/server/bootstrap-admin-recovery.adoc#L9-L27>). The account does not expire by itself: the receiving team creates a permanent administrator, then removes the temporary one manually. If the receiving team provisions its own administrator instead, do not read this Secret at all.

**Do not continue** until the receiving team has received both values through that channel, or has confirmed it provisions its own administrator. If either key is missing from the Secret, stop the handoff: it does not prove the bootstrap never happened — the Secret may be incomplete or the account may already exist — so establish the actual state with the receiving team before any authenticated test.

### 4.5 Set the public host in the Ingress

`base/ingress.yaml` is a template and names `firewatch.example.invalid` twice; the public host is one of the two values the base cannot know (the other is the registry).

```sh
sed -n '52p;55p' backend/deploy/k8s/base/ingress.yaml
```

**Expected:** two lines containing `firewatch.example.invalid` — `spec.tls[0].hosts` and `spec.rules[0].host`.

Replace **both** occurrences with `$DOMAIN`. This is the only manifest edit this runbook asks for; record it, because it is a difference between this deployment and the tree.

**Do not continue unless** `grep -c firewatch.example.invalid backend/deploy/k8s/base/ingress.yaml` prints `0`.

## Phase 5 — Apply

### 5.1 Apply the overlay

This is the step the whole file exists for, and it must not run before Phase 3.

```sh
kubectl apply -k backend/deploy/k8s/overlays/delivery
```

**Expected:** the objects created or configured — namespace, ConfigMaps, StatefulSets, Deployments, Services, PodDisruptionBudgets, HPAs, NetworkPolicies, the Ingress, and the two Jobs `migrate-v17-j6` and `broker-provision`. Kustomize renders a list and guarantees no order; `base/kustomization.yaml` lists the data plane first because the application cannot become ready before it, and that intent is honoured by the retries below, not by the apply.

**If it fails:** `violates PodSecurity "restricted"` means a field the base already satisfies was changed. `firewatch-tls not found` is not an apply failure — that is 4.3.

**Do not continue unless** the apply exits `0`.

### 5.2 Count what is running, per workload

`kubectl wait --for=condition=Ready pod --all` is **not** a gate here: a finished Job's pod stays `Ready=False` forever and the command fails on a healthy rollout (`README.md`, "What differs from kind").

```sh
kubectl -n firewatch get deployments
kubectl -n firewatch get statefulsets
```

**Expected:** `gateway`, `jobs`, `risk`, `prevention`, `inference` at `2/2`; `keycloak` at `1/1`; `postgres` and `rabbitmq` at `1/1`.

**If it fails:** read the pod, not the Deployment. `CreateContainerConfigError` is a missing Secret (4.2). `Pending` on a data service is a StorageClass or volume problem (1.7). `CrashLoopBackOff` on `risk` with a model-address error is `inference` not answering yet.

**Do not continue unless** every count above matches.

### 5.3 The two bootstrap Jobs must be complete

```sh
kubectl -n firewatch get jobs
```

**Expected:** `migrate-v17-j6` `Complete 1/1` and `broker-provision` `Complete 1/1`. The migration Job runs `migrate-risk`, then `migrate-prevention`, then `migrate-jobs` as one ordered unit (`base/jobs-migrate.yaml:90-179`), because the prevention schema takes the next versions of the risk database's ledger.

**If it fails:** `migrate-v17-j6` backs off six times by design, because a cold cluster starts the Job before PostgreSQL answers; a `Failed` Job after that is a schema or credential problem a human reads. `broker-provision` failing means the broker topology was not provisioned and every service will fail its next reconnect.

**Do not continue unless** both named Jobs report `Complete 1/1`. An older `migrate-v17` is not evidence for jobs migration 006 and need not be deleted. For an existing volume, complete the [query-audit credential upgrade](README.md#configure-before-applying). The database operator should confirm version `6` exists in the `jobs` database's `schema_migrations` table. Once the realm is configured, confirm an authenticated `GET /v1/prevention/observations` returns `200`, then as an administrator confirm `/v1/audit` contains the new `prevention.observations.read` query with the matching request ID as `trace_id`. A `503` is a failed readiness check even if pods are ready.

### 5.4 The nodes pulled the pinned digests

You do not need shell access to a node: the kubelet's pull is observable as the container's `imageID`.

```sh
for app in gateway jobs risk prevention inference; do
  kubectl -n firewatch get pods -l app="$app" \
    -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.status.containerStatuses[*].imageID}{"\n"}{end}'
done
```

**Expected:** every line's `imageID` ends with the digest recorded in 2.3 — that string is the artifact the node resolved and pulled.

**If it fails:** `ErrImagePull` or `ImagePullBackOff` means the node's identity cannot read the repository (1.6) or the digest does not exist there. A digest from the registry on the operator's machine proves nothing about the node: the pull is the kubelet's, with the node's credential.

**Do not continue unless** every running pod's `imageID` carries the pinned digest.

### 5.5 A denied connection tests `NetworkPolicy` on one path

An accepted connection proves nothing on a cluster whose policy set is inert. The gate is a pair: one pod the data plane admits, one it does not, both from inside `firewatch`.

Both probes carry a `restricted`-compliant security context, because the namespace enforces `restricted` (`base/namespace.yaml:6`), and both end their command with `exit 0`: the pod has to reach `Succeeded` for the wait below to return, and the criterion is the `status=` the probe prints, not the pod's phase.

Of the fields these two blocks set, the [restricted profile](https://kubernetes.io/docs/concepts/security/pod-security-standards/#restricted) constrains `runAsNonRoot`, `allowPrivilegeEscalation`, `capabilities.drop`, `seccompProfile.type` and `runAsUser`: it requires `runAsNonRoot: true`, `allowPrivilegeEscalation: false` and a `drop` list containing `ALL`, it accepts `RuntimeDefault` or `Localhost` as the seccomp type, and it accepts any non-zero `runAsUser` or none at all — `65532` is this probe's choice inside that range, not a value the standard names. `readOnlyRootFilesystem: true` is not one of its controls. That page is the authority, and its controls span pod and container scope, so those five are the ones this context touches, not the profile's whole list.

`-U` and `-d` are connection arguments, not admission fields, and they are not credentials: no password is supplied, and libpq counts a server that asked for authentication as accepting connections ([fe-connect.c:4488-4498](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/interfaces/libpq/fe-connect.c#L4488-L4498)). Without `-U`, the libpq defaults apply — the user is the operating-system name of the running process, and the database defaults to that same name ([libpq parameters](https://www.postgresql.org/docs/17/libpq-connect.html#LIBPQ-PARAMKEYWORDS)) — and with no user supplied through options or defaults, libpq resolves it from the effective UID; if that lookup fails, it fails while resolving its options, before a socket exists, and `pg_isready` reports `no attempt` and exit `3` instead of a network result ([fe-connect.c:1274-1293](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/interfaces/libpq/fe-connect.c#L1274-L1293)). The explicit pair keeps the probe off that path, and it is what the StatefulSet's own probes pass, readiness at `base/postgres.yaml:160` and liveness at `:170`.

```sh
kubectl -n firewatch apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata: {name: np-deny, labels: {app: netprobe}}
spec:
  restartPolicy: Never
  securityContext: {runAsNonRoot: true, runAsUser: 65532, seccompProfile: {type: RuntimeDefault}}
  containers:
    - name: probe
      image: postgis/postgis:17-3.5
      command: ["sh", "-c", "pg_isready -h postgres -p 5432 -U postgres -d postgres -t 10; echo status=$?; exit 0"]
      securityContext:
        allowPrivilegeEscalation: false
        capabilities: {drop: [ALL]}
        readOnlyRootFilesystem: true
EOF
kubectl -n firewatch wait --for=jsonpath='{.status.phase}'=Succeeded pod/np-deny --timeout=180s
kubectl -n firewatch logs np-deny
```

**Expected:** `postgres:5432 - no response` and `status=2`.

`pg_isready` returns `0` when the server is accepting connections, `1` when it is rejecting them, `2` when there was no response to the attempt, and `3` when no attempt was made, for example because the parameters were invalid ([exit status](https://www.postgresql.org/docs/17/app-pg-isready.html)). No single code decides the policy question: `2` is what a blocked path looks like, and it is equally what an unresolved `postgres` name looks like, or a database that is down, or a wrong address; `1` says a server answered and refused for reasons of its own; `3` means no connection was attempted, so nothing about the network follows from it. The pair is the observation this step asks for, and it is evidence about this pair of paths only — `app: netprobe` denied and `app: migrate` admitted, both to PostgreSQL on TCP 5432 — not proof that `NetworkPolicy` is enforced anywhere else. It is also still an observation somebody has to make on the destination: the status line at `:3` still applies.

`app: netprobe` has no route to PostgreSQL on TCP 5432: `postgres-entry` (`base/network.yaml:190-202`) admits only `app` in `jobs`, `risk`, `prevention`, `keycloak` and `migrate` to that port, and `default-deny` (`:5-6`) closes what no other policy opens. That is a statement about 5432 and not about the pod's egress in general — `dns-and-oidc` (`:8-23`) gives every pod name resolution through `kube-system` and TCP 443 out, so an answer from some other destination would say nothing about PostgreSQL.

Then the other half of the pair, the connection that must be **allowed**, which is what catches an over-blocking policy:

```sh
kubectl -n firewatch apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata: {name: np-allow, labels: {app: migrate}}
spec:
  restartPolicy: Never
  securityContext: {runAsNonRoot: true, runAsUser: 65532, seccompProfile: {type: RuntimeDefault}}
  containers:
    - name: probe
      image: postgis/postgis:17-3.5
      command: ["sh", "-c", "pg_isready -h postgres -p 5432 -U postgres -d postgres -t 10; echo status=$?; exit 0"]
      securityContext:
        allowPrivilegeEscalation: false
        capabilities: {drop: [ALL]}
        readOnlyRootFilesystem: true
EOF
kubectl -n firewatch wait --for=jsonpath='{.status.phase}'=Succeeded pod/np-allow --timeout=180s
kubectl -n firewatch logs np-allow
```

**Expected:** `postgres:5432 - accepting connections` and `status=0`. `app: migrate` is admitted by `postgres-entry` and has egress to 5432 through `migrate-egress` (`base/network.yaml:242-251`).

`app: migrate` is chosen over the documented `app: jobs` pair on purpose: the `jobs` Service selects `{app: jobs}` (`base/workloads.yaml:317`), so a probe pod carrying that label would be added as an endpoint and the gateway would route real traffic into it for as long as it lives. `app: migrate` selects no Service.

**If it fails:** `status=3` on either probe is not a verdict — no attempt was made, so the policies were not exercised, and the fault is in the invocation or in the pod's environment. `status=0` on `np-deny` contradicts the pair: a server answered at `postgres:5432` for a pod that no policy in this tree admits to that port, which is the failure `--enable-network-policy` (`:104`) exists to prevent. The probe does not rank the causes — a CNI that does not apply these objects, an allowing rule applied outside this tree, and an address that does not lead where this file assumes are all consistent with it — and `kubectl get networkpolicy` lists objects without showing which are enforced. `status=1` on `np-deny` is the same contradiction in another shape: a server answered and refused for its own reasons. `status=2` on `np-allow` contradicts the other half without naming the cause — an over-blocking rule, a `postgres` name that did not resolve, a database that is down and a wrong address are all consistent with it. `status=1` there points at the server's state rather than at the policy, since something answered while refusing connections. Neither half is read alone, and the pair — run against the destination — is evidence about this path only, not proof that `NetworkPolicy` is enforced in general.

**Do not continue unless** the deny pod prints `status=2` **and** the allow pod prints `status=0`. Then delete both probes:

```sh
kubectl -n firewatch delete pod np-deny np-allow
```

### 5.6 The metrics pipeline answers

```sh
kubectl -n firewatch get hpa
kubectl top nodes
```

**Expected:** each HPA prints a live target such as `1%/70%` rather than `<unknown>`, and `kubectl top nodes` prints a row per node. Only CPU is measurable this early; what the gate proves is that the pipeline the four HPAs read is serving, not that 70 % is reachable (`README.md`, "Still unverified").

**If it fails:** `<unknown>` with `unable to fetch metrics` means the aggregated API is not answering (1.7). The HPAs never scale without it, and no replica count is an availability claim either way.

**Do not continue unless** every HPA reports a percentage.

## Phase 6 — Ingress and TLS

### 6.1 Install the controller the Ingress names

GKE's own Ingress is class `gce` (`base/ingress.yaml:50`, `base/network.yaml:33-36`), and `gateway-entry` admits only the `ingress-nginx` namespace into the gateway pod. The controller is therefore installed by the operator on either GKE flavor, pinned to the version the tree's edge observations were taken against (`deploy/k8s/local/ingress.sh:28-33`), from that release's own cloud-flavoured static manifest:

```sh
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.15.1/deploy/static/provider/cloud/deploy.yaml
kubectl -n ingress-nginx rollout status deployment/ingress-nginx-controller --timeout=300s
kubectl get ingressclass nginx
```

**Expected:** the controller converges, `IngressClass nginx` exists, and the `ingress-nginx-controller` Service is type `LoadBalancer` with an external address assigned.

**If it fails:** a `Pending` LoadBalancer is a quota or subnet problem in the project, not a manifest one. A different controller version is a new measurement, and its failure mode is not partial: an annotation it rejects removes the whole `ProxySSL` block, leaving the hop encrypted and unverified with nothing saying so.

**Do not continue unless** `kubectl get ingressclass nginx` prints `nginx`.

### 6.2 Reserve the address and point `DOMAIN` at it

```sh
gcloud compute addresses create "${CLUSTER}-ingress" --region "$REGION"
gcloud compute addresses describe "${CLUSTER}-ingress" --region "$REGION" --format='value(address)'
```

**Expected:** one IPv4 address. Announce it, then set it on the controller's Service:

```sh
kubectl -n ingress-nginx patch svc ingress-nginx-controller \
  -p '{"spec":{"loadBalancerIP":"<the address from above>"}}'
```

This patches the controller's own `LoadBalancer` Service, not a GKE Ingress: the native `gce` class stays out of this deployment entirely (see the hard stops). The exact field that binds a reserved regional address is provider surface and this step is unexecuted; if the Service keeps an address different from the one reserved above, read `kubectl -n ingress-nginx describe svc ingress-nginx-controller` before changing anything else.

Now `$DOMAIN` must resolve to that address. Creating or changing the DNS record is outside this runbook and outside the repository.

**If it fails:** an address that never resolves to `$DOMAIN` fails at the next step with a TLS or connection error, not here.

**Do not continue unless** `getent hosts "$DOMAIN"` (or `nslookup "$DOMAIN"`) resolves to the reserved address.

### 6.3 The edge routes to the gateway: the `401` is the routing gate

```sh
"$KUBECTL" --context "$KUBE_CONTEXT" -n firewatch get ingress firewatch
curl -sS -o /dev/null -w '%{http_code}\n' "https://${DOMAIN}/v1/jobs"
curl -sS "https://${DOMAIN}/v1/jobs"
```

**Expected:** `401`, and a body of the shape `{"code":"unauthorized","request_id":"..."}`. The `401` is produced by the gateway itself, which is the observed behaviour of the local evidence cluster (`odd/tasks/k8s-delivery-closure.md:70`) and the only unauthenticated request this runbook can assert end to end.

**What that `401` proves, and what it does not.** It proves the request crossed DNS, the reserved address, the controller, the edge certificate and the `gateway` backend port, and was answered by the gateway's own auth middleware. It does **not** prove the hop was *verified*: the gateway answers `401` to any request that reaches it, so an unverified hop returns the same status. The hop's configuration is `backend-protocol: HTTPS`, `proxy-ssl-verify: 'on'`, `proxy-ssl-name: gateway` and `proxy-ssl-secret: firewatch/gateway-upstream-ca` (`base/ingress.yaml:14-37`); `proxy-ssl-server-name` is not set, and its default in the controller version this runbook installs is `off`, so the controller verifies the certificate's name but sends **no SNI** to the gateway (`kubernetes/ingress-nginx@controller-v1.15.1`, `internal/ingress/annotations/proxyssl/main.go`).

`gateway-upstream-ca` carries `ca.crt` alone, and the reason is the pinned template rather than a preference: the whole `proxy_ssl_*` block, `proxy_ssl_verify` included, is rendered only when the Secret supplied a CA file (`internal/ingress/controller/store/backend_ssl.go:148-159` sets `CAFileName` for a `ca.crt`-only Secret; `rootfs/etc/nginx/template/nginx.tmpl:1431-1438` gates the block on it). A pair is a different shape, and neither direction may be assumed: `CreateSSLCert` requires `tls.crt` and `tls.key` to match (`internal/net/ssl/ssl.go:100`), a matching pair is accepted and becomes a *client* certificate pair this hop does not use and the gateway does not request (`backend_ssl.go:95-141`, `nginx.tmpl:1447-1450`), and only a mismatch is refused. What a refused or absent anchor then does to the location is not one outcome either: the local v1.15.1 run recorded the mismatched pair as `AnnotationParsingFailed` with the `ProxySSL` block missing from the render — requests reaching the gateway over an unverified connection instead of failing closed — while a `proxy-ssl-secret` value that is not `namespace/name` produced a denied location answering `503` (`deploy/k8s/local/README.md:182-194`; the parser and `internal/ingress/annotations/annotations.go:200-215`). Configuration is not observation, and neither failure direction may be inferred. Two steps turn it into one: 6.5 compares the leaf the gateway serves with the leaf `gateway-tls` holds, and 6.6 is an acceptance checklist for a separate disposable deployment — the negative control is not produced on this deployment.

**If it fails:** `502` with `upstream SSL certificate verify error: (21:unable to verify the first certificate)` in the controller log means verification is on and refusing the upstream — the direction 6.6 reproduces on purpose, and not the only thing a wrong anchor can do (see above). `503` means the annotation failed to parse, which is what a bare Secret name instead of `namespace/name` produces. `404` means the controller is not the one the Ingress names.

**Do not continue unless** the status is `401` and the body carries `unauthorized`. This is a routing pass: do not record the hop as verified from it.

### 6.4 The certificate on the wire is the one you supplied

```sh
openssl s_client -connect "${DOMAIN}:443" -servername "$DOMAIN" </dev/null 2>/dev/null \
  | openssl x509 -noout -issuer -subject -dates
```

**Expected:** the issuer is the public authority that signed `tls/${DOMAIN}.crt`, **not** `firewatch-internal-ca` — the internal CA never leaves the cluster's trust chain.

**If it fails:** the fake default certificate ingress-nginx serves when `firewatch-tls` is absent is the usual cause; read `kubectl -n firewatch get secret firewatch-tls` (4.3).

**Do not continue unless** the issuer names your public authority and the validity window covers today.

### 6.5 The gateway serves the leaf `gateway-tls` holds

Read-only: nothing is written to the cluster. The step samples one gateway pod by name, connects to its TLS listener through `kubectl port-forward`, verifies the leaf against the exact Secret the Ingress names as its anchor, and compares its SHA-256 fingerprint with the certificate `bootstrap-secrets.sh` issued into `gateway-tls`. A port-forward reaches the pod through the API server, so it needs no `NetworkPolicy` exception and it does **not** traverse the Ingress: it answers "which leaf does the pod serve, and does the edge anchor verify it", not "does NGINX accept it". 6.6 is the acceptance checklist for that second answer, on a separate disposable deployment. Both replicas mount the same `gateway-tls` Secret at `/etc/tls` (`base/workloads.yaml:102`), so the sampled pod is representative; name it in the report. The values pinned in 4.1 (`KUBECTL`, `KUBE_CONTEXT`, `RUNBOOK_WORK`, `NATIVE`) are still exported in this shell; if this is a new shell, re-run 4.1's first block first.

The loopback port is `18443`; the pod port is `8080`, which the Service publishes as `port: 8080, targetPort: https` (`base/workloads.yaml:311`) with the port *name* `https` making it TLS. `8443` is the kind cluster's host mapping for the edge (`deploy/k8s/local/README.md:125`), so `port-forward ... 18443:8443` reaches nothing (`:74`).

**Checkpoint 1 — the live annotation names the anchor this step will read.**

```sh
"$KUBECTL" --context "$KUBE_CONTEXT" -n firewatch get ingress firewatch -o jsonpath='{.metadata.annotations.nginx\.ingress\.kubernetes\.io/proxy-ssl-secret}{"\n"}'
```

**Expected:** `firewatch/gateway-upstream-ca`, exactly. Anything else stops: the rest of the step would compare against an anchor the live Ingress does not use.

**Checkpoint 2 — both Secrets read, and both decode to certificates.**

```sh
"$KUBECTL" --context "$KUBE_CONTEXT" -n firewatch get secret gateway-upstream-ca -o jsonpath='{.data.ca\.crt}' > "$RUNBOOK_WORK/anchor.b64" && echo "anchor read"
"$KUBECTL" --context "$KUBE_CONTEXT" -n firewatch get secret gateway-tls -o jsonpath='{.data.tls\.crt}' > "$RUNBOOK_WORK/leaf.b64" && echo "leaf read"
test -s "$RUNBOOK_WORK/anchor.b64" && test -s "$RUNBOOK_WORK/leaf.b64" && echo "both non-empty"
base64 --decode < "$RUNBOOK_WORK/anchor.b64" > "$RUNBOOK_WORK/anchor.crt" && base64 --decode < "$RUNBOOK_WORK/leaf.b64" > "$RUNBOOK_WORK/leaf.crt"
openssl x509 -in "$NATIVE/anchor.crt" -noout -subject
openssl x509 -in "$NATIVE/leaf.crt" -noout -fingerprint -sha256
```

**Expected:** `anchor read`, `leaf read`, `both non-empty`, an anchor `subject=` line, and the intended fingerprint. Each read has its own exit status and its own file: a failed `kubectl` call is not allowed to look like an empty certificate, and a file that `openssl` refuses is not a certificate.

**Checkpoint 3 — sample one pod, and own the tunnel.**

```sh
"$KUBECTL" --context "$KUBE_CONTEXT" -n firewatch get pod -l app=gateway -o name
```

**Expected:** two `pod/gateway-...` lines. Record one as `GATEWAY_POD` and continue — the pod you sampled is the pod named in the report.

```sh
GATEWAY_POD="<one pod/name from above>"
"$KUBECTL" --context "$KUBE_CONTEXT" -n firewatch port-forward "$GATEWAY_POD" 18443:8080 > "$RUNBOOK_WORK/forward.log" 2>&1 &
FORWARD_PID=$!
sleep 2
kill -0 "$FORWARD_PID" && echo "forward alive: pid $FORWARD_PID"
grep -F 'Forwarding from 127.0.0.1:18443' "$RUNBOOK_WORK/forward.log"
```

**Expected:** `forward alive: pid <pid>` and `Forwarding from 127.0.0.1:18443`. The first proves the process is the one this shell started, the second that it had bound the loopback port before anything is measured. If either line is missing, `kill "$FORWARD_PID"` and stop: a later connection refusal must not be read as a verification result.

From here on, a failure is cleaned up before it is reported: `kill "$FORWARD_PID"` and `rm` the files this step wrote, then stop. Nothing is left holding the port and no session dump is kept.

**Checkpoint 4 — the handshake succeeds on its own, before any fingerprint is read.**

```sh
openssl s_client -connect 127.0.0.1:18443 -verify_hostname gateway -verify_return_error \
  -CAfile "$NATIVE/anchor.crt" </dev/null > "$RUNBOOK_WORK/session.txt" 2> "$RUNBOOK_WORK/session.err"
echo "s_client exit: $?"
grep -F 'Verify return code: 0 (ok)' "$RUNBOOK_WORK/session.txt"
```

**Expected:** `s_client exit: 0` and `Verify return code: 0 (ok)`. The handshake result is checked before the certificate is parsed, so a failed chain cannot produce a fingerprint that looks like an answer. `-verify_hostname gateway` is the mirror of `proxy-ssl-name: gateway` (`base/ingress.yaml:27`), `-CAfile` is the anchor the annotation names, and `-verify_return_error` turns a chain failure into an exit instead of a footnote — measured: without it the client exits `0` and prints the certificate while reporting `Verify return code: 20`. No `-servername` is passed: `proxy-ssl-server-name` is unset and defaults to `off` (`internal/ingress/annotations/proxyssl/main.go`), so the Ingress sends no SNI to this hop and imposing it here would test a handshake production never performs. A `verify error:num=` line in `session.err` stops the step: nothing was changed, and there is nothing to restore.

**Checkpoint 5 — the served leaf is the intended leaf.**

```sh
openssl x509 -in "$NATIVE/session.txt" -noout -fingerprint -sha256
```

**Expected:** the same line checkpoint 2 printed. Two different lines stop: the pod is not serving `gateway-tls` — it mounted another Secret, or the Secret was replaced without a rollout (`README.md`, "What a CA rotation touches"). Kill the tunnel and remove the files before reporting it.

**Checkpoint 6 — close the tunnel and leave nothing behind.**

```sh
kill "$FORWARD_PID"
sleep 1
kill -0 "$FORWARD_PID" 2>/dev/null && echo "STILL RUNNING" || echo "forward closed"
rm "$RUNBOOK_WORK/session.txt" "$RUNBOOK_WORK/session.err" "$RUNBOOK_WORK/anchor.b64" "$RUNBOOK_WORK/leaf.b64"
rm "$RUNBOOK_WORK/anchor.crt" "$RUNBOOK_WORK/leaf.crt" "$RUNBOOK_WORK/forward.log"
ls -A "$RUNBOOK_WORK"
```

**Expected:** `forward closed`, and a listing with only the CA-check files 4.1b left behind (`ca.b64`, `ca.crt`, `ca.pub`, `key.pub`) — no session dump, no forward log and no decoded copy of the leaf. `STILL RUNNING` means the port is still held by a process this step started: kill it by that pid before leaving the phase.

**Do not continue unless** checkpoint 1 printed the expected anchor, checkpoint 4 printed both lines, checkpoint 5 matched, and checkpoint 6 printed `forward closed`.

### 6.6 The anchor is enforced — acceptance checklist for a separate disposable deployment

This runbook does not produce the negative control on this deployment, and nothing below is run against its cluster, namespace or CA material: the test needs an environment that can be broken on purpose. The sequence is the one the local evidence cluster was taken through (`deploy/k8s/local/README.md:198-207`: anchor pointed at a CA that did not sign the gateway, one request answered `502` with `upstream SSL certificate verify error: (21:unable to verify the first certificate)`, the anchor restored, the same request back at `401`).

**The environment has to be separate in all three parts:** its own ingress controller (its own installation or class), its own edge address and host, and its own gateway workload. A deployment that shares any of the three with the target is not disposable, and this checklist does not apply to it.

**No such environment means not executed.** Record the negative control as `not executed` with that reason and do not describe the hop as verified: 6.3's `401` is routing, 6.5 checks the leaf, and neither shows that a wrong anchor is refused.

The checklist, in order:

1. **Baseline.** One request on the test route answers `401`, the gateway's own response as in 6.3. Record the command and the code.
2. **Switch the anchor deliberately.** Point the disposable deployment's `proxy-ssl-secret` at a CA that did not sign its gateway: one generated for this test, never a Secret of the target and never a copy of its key material. Record the value that was there before the switch.
3. **One fresh request, correlated.** Send a request on the same test route carrying a value that cannot appear in an earlier log line (the UTC time is enough), and require both: `502` for that request, and a controller error line in the disposable deployment's own log carrying the same value together with `upstream SSL certificate verify error:`. A `502` without that line is another failure, not this proof.
4. **Restore on abort as well as on success.** Any stop after step 2 — request, log, any check in between — begins with restoring the anchor the recorded value names. Restoration is the first action of an abort, not an afterthought.
5. **Read back and re-measure before cleanup.** The disposable deployment's annotation reads the recorded value again and the same test route answers `401`. Both are required before anything is removed.
6. **Remove only what the test created.** The throwaway CA, the probe Secret and the temporary annotation change are this run's; delete exactly those and verify each is gone. Do not delete, re-create or "repair" anything in the target deployment as part of this checklist.

**Do not continue past step 4** unless the anchor is restored and both step-5 observations are in hand. A disposable deployment abandoned with a wrong anchor is discarded, not left half-restored: it exists to be thrown away.

## Hard stops

These are not warnings. Each one produces a deployment that reads as working and is not.

1. **Do not apply the overlay before Phase 3.** The base renders `firewatch/<service>:replace-before-deploy`, a tag no cluster can pull; skipping the pin produces pods in `ErrImagePull` and a Job that never migrates.
2. **Do not use GKE's native Ingress (class `gce`).** `gateway-entry` admits only the `ingress-nginx` namespace into the gateway (`base/network.yaml:33-36`), so a `gce` Ingress routes to an Ingress the network policy does not permit, and the tree's edge configuration (`backend-protocol`, `proxy-ssl-*`) is written for NGINX.
3. **Do not use `backend/docker-compose.prod.yml`.** It was retired as the delivery path on 2026-11-17 (`acta-cierre.md` §7.3) and carries its own banner. It has no registry, no immutable tag, no rollback path and no inference service.
4. **Backups are not delivered.** There is no CronJob, no writer identity and no restore procedure in this tree. Provisioning the bucket creates a destination, not a backup: the upload gate this runbook would need cannot be run today, and the policy of `acta-cierre.md` §7 stays "written, not implemented".
5. **Signing and promotion are not delivered.** Front 7 owns them (`odd/plan-produccion/07-firma-registry-rollout.md:19-22`): no signature is verified before promotion and nothing is automated. Do not describe a push as a signed release.
6. **The realm is provisioned out of band.** Do not import the development realm, and do not read a missing `firewatch` realm as a failed deployment (4.4).
7. **Keep `gateway-upstream-ca` to `ca.crt` alone.** `tls.crt`/`tls.key` in the same Secret become a *client* certificate pair this hop does not use (`internal/ingress/controller/store/backend_ssl.go:95-141`, `nginx.tmpl:1447-1450`), and the pair must match (`internal/net/ssl/ssl.go:100`). A mismatched pair was *measured* ending with the hop unverified rather than closed (`deploy/k8s/local/README.md:182-190`), not with a clean refusal, so do not treat "the controller will reject it" as the outcome.
8. **Do not delete `firewatch-ca`, `gateway-upstream-ca` or `firewatch-tls` to "fix" TLS.** `bootstrap-secrets.sh` never rotates in silence: a deleted Secret is a deliberate rotation, and deleting `firewatch-ca` is a CA *replacement* that leaves every `<service>-tls` chained to the authority that no longer exists.
9. **Do not read the `401` in 6.3 as proof that the hop is verified.** The gateway answers `401` for any request that reaches it, so the same status arrives over a hop whose verification is off or whose `ProxySSL` block never rendered. Verification is observed in 6.5 (the served leaf is the intended one, against the anchor the Ingress names) and on the separate disposable deployment 6.6 describes, and nowhere else.

## Rollback

**Rolling back a Deployment is rolling the overlay back.** The mechanism is the previous digest list, not `kubectl rollout undo`, which edits the Deployment and is overwritten by the next `apply -k`.

```sh
cat > images.previous.txt <<EOF
gateway ${REGISTRY_PATH}/firewatch/gateway@sha256:<previous gateway digest>
...
EOF
sh backend/deploy/k8s/overlays/delivery/pin-images.sh images.previous.txt
kubectl kustomize backend/deploy/k8s/overlays/delivery | grep -E '^ +image: ' | sort
kubectl apply -k backend/deploy/k8s/overlays/delivery
```

**Expected:** the render carries the previous digests and the rollout replaces the pods.

**If it fails:** a digest that no longer exists in the registry cannot be rolled back to. Retention and tag immutability of the artefacts a release replaces are part of rollback, not housekeeping.

**The schema does not roll back.** The migration runner applies the versions the code carries and records them; there is no down path, and a version recorded in a deployed ledger can never be renumbered or moved (`backend/docs/migration-ledger.md:39-41`). A rollback that crosses a migration is a restore, not a rollback: the older image would run against a schema it does not know. Rolling forward with a fixed image is the only reversible direction, and the overlay is what makes that a one-file change.

**No restore has been rehearsed anywhere**, so there is no measured RTO and no verified restore procedure to reach for. That is the state the acta records, not a gap this runbook closes.

## What this runbook does not do

- It does not implement backups, restore or retention: no CronJob, no writer identity, no lifecycle rule, nothing measured.
- It does not implement signing, SBOM verification or promotion between environments.
- It does not create the Keycloak realm, and it does not mint a token.
- It does not own DNS or the public certificate, and it cannot create either.
- It does not choose machine types, node counts, autoscaling or a cost figure; every cost dimension is "confirm at contracting".
- It does not target GKE Autopilot specifically. Both flavors admit this tree, and Standard is the recommended shape because node-level work — an egress proxy, a backup agent — has nowhere to run on Autopilot.
- It does not measure availability, load or recovery: replicas are not an SLA, and no failover has been exercised.
- It does not touch the managed-data substitution. The data plane stays in the cluster, decided and documented, not adopted.
- It proves nothing about a cluster by itself: every "Expected" line above is an observation somebody still has to make.
- It does not make `bootstrap-secrets.sh` compare the key it signs with against the `ca.crt` the cluster already holds. The CA-mode gate is 4.1a-4.1c and it lives in this file only (`bootstrap-secrets.sh:146-165` has no equivalent check); that gap in the script is a declared risk, not something this runbook changes.

## Why these steps, without repeating them

- `backend/deploy/k8s/README.md` — "Configure before applying" (what the manifests need in order to render), "Path to a real production cluster" (what a target cluster must bring, what GKE supplies and refuses, Artifact Registry, Cloud Storage with Workload Identity, the `gcloud` checklist, promotion by digest, secret and CA lifecycle, the data plane, rollback, and "Still unverified"), and "What differs from kind" (why `kubectl wait --all` is not a gate and why `--kubelet-insecure-tls` never travels).
- `backend/deploy/k8s/README.md` → "Rollback" — the digest-list mechanism and the forward-only schema.
- `odd/entrega/acta-cierre.md` §7 (policy, SLA and what it does not close), §7.3 (`:161-175`, the Kubernetes substrate) and §7.4 (`:214-242`, Google Cloud with GKE, which closes the cluster-flavor question).
- `odd/tasks/gcp-gke-delivery.md` — the specification of this target, and the state of each task.
- `odd/plan-produccion/07-firma-registry-rollout.md:19-22` — the signing and promotion gap, owned there and not here.
- `backend/docs/migration-ledger.md:39-41` — why the ledger forbids moving a recorded version.
