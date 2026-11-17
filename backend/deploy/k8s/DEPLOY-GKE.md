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
4. **The internal CA signing key, at `FIREWATCH_CA_KEY`** (default `~/.firewatch-internal-ca/ca.key`). Without it `bootstrap-secrets.sh` keeps existing certificates and cannot issue new ones (`bootstrap-secrets.sh:204-211`), and when the `firewatch-ca` Secret is absent it mints a *new authority* and overwrites the key path (`:146-165`). A second authority breaks every certificate and the edge anchor at once, so the key is a precondition, not something to generate on the target.

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

### 4.1 Prove the CA key is in place

```sh
test -s "${FIREWATCH_CA_KEY:-$HOME/.firewatch-internal-ca/ca.key}" && echo "ca key present"
```

**Expected:** `ca key present`.

**If it fails:** stop. `bootstrap-secrets.sh` will mint a new authority when the `firewatch-ca` Secret is absent (`:146-165`) and will silently overwrite the key path; on a second run against a namespace that already has a CA but no local key it keeps the existing certificates and issues none (`:204-211`), which leaves every `<service>-tls` Secret missing and every pod that mounts one in `CreateContainerConfigError`. Neither outcome is recoverable by re-running.

**Do not continue unless** the key file exists and is non-empty.

### 4.2 Create the namespace material

```sh
sh backend/deploy/k8s/bootstrap-secrets.sh firewatch
```

**Expected:** a `namespace/firewatch` line, then the Secrets and ConfigMaps of `README.md` ("Configure before applying", step 4). The script never prints a secret, never writes one into the repository, and never rewrites an existing one.

**If it fails:** `missing .../namespace.yaml` means the script was run outside the tree. On Git Bash/MSYS the CA step dies without a message — `README.md`, "Running the bootstrap on Windows", is the workaround and it is a host constraint, not a defect.

**Do not continue unless** these objects exist:

```sh
kubectl -n firewatch get secret firewatch-ca gateway-upstream-ca firewatch-tls 2>&1
```

**Expected:** `firewatch-ca` and `gateway-upstream-ca` exist. `firewatch-tls` **must not** — it is created in 4.3, and a `firewatch-tls` the script produced would be a certificate for a name nobody owns.

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

**Do not continue to any authenticated test** until the receiving team says the realm exists. Read the first administrator out of the cluster and hand it over; it is the one Secret whose value an operator must read:

```sh
kubectl -n firewatch get secret keycloak-bootstrap-admin -o jsonpath='{.data.KC_BOOTSTRAP_ADMIN_USERNAME}{"\n"}'
```

**Expected:** a base64 value to decode and hand over. Keycloak reads this Secret only on a first start against an empty `identity` database.

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

**Expected:** the objects created or configured — namespace, ConfigMaps, StatefulSets, Deployments, Services, PodDisruptionBudgets, HPAs, NetworkPolicies, the Ingress, and the two Jobs `migrate-v14` and `broker-provision`. Kustomize renders a list and guarantees no order; `base/kustomization.yaml` lists the data plane first because the application cannot become ready before it, and that intent is honoured by the retries below, not by the apply.

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

**Expected:** `migrate-v14` `Complete 1/1` and `broker-provision` `Complete 1/1`. The migration Job runs `migrate-risk`, then `migrate-prevention`, then `migrate-jobs` as one ordered unit (`base/jobs-migrate.yaml:89-178`), because the prevention schema takes the next versions of the risk database's ledger.

**If it fails:** `migrate-v14` backs off six times by design, because a cold cluster starts the Job before PostgreSQL answers; a `Failed` Job after that is a schema or credential problem a human reads. `broker-provision` failing means the broker topology was not provisioned and every service will fail its next reconnect.

**Do not continue unless** both Jobs report `Complete 1/1`.

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

### 5.5 A denied connection proves `NetworkPolicy` is applied

An accepted connection proves nothing on a cluster whose policy set is inert. The gate is a pair: one pod the data plane admits, one it does not, both from inside `firewatch`.

Both probes carry a `restricted`-compliant security context, because the namespace enforces `restricted` (`base/namespace.yaml:6`), and both end their command with `exit 0`: the pod has to reach `Succeeded` for the wait below to return, and the criterion is the `status=` the probe prints, not the pod's phase.

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
      command: ["sh", "-c", "pg_isready -h postgres -p 5432 -t 10; echo status=$?; exit 0"]
      securityContext:
        allowPrivilegeEscalation: false
        capabilities: {drop: [ALL]}
        readOnlyRootFilesystem: true
EOF
kubectl -n firewatch wait --for=jsonpath='{.status.phase}'=Succeeded pod/np-deny --timeout=180s
kubectl -n firewatch logs np-deny
```

**Expected:** `postgres:5432 - no response` and `status=2`. `pg_isready` exits `2` when nothing answered.

`app: netprobe` is admitted by no policy: `postgres-entry` admits only `app` in `jobs`, `risk`, `prevention`, `keycloak` and `migrate` on 5432 (`base/network.yaml:196-201`), and `default-deny` (`:5-6`) closes everything else.

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
      command: ["sh", "-c", "pg_isready -h postgres -p 5432 -t 10; echo status=$?; exit 0"]
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

**If it fails:** `status=0` on `np-deny` means `default-deny` is inert and the cluster is not what this file describes, whatever `kubectl get networkpolicy` prints — the database's own authentication would be the only thing in the way, and this is the observation `--enable-network-policy` exists to produce. `status=2` on `np-allow` means the pair of policies is wrong in the other direction and no service could reach the database either.

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

### 6.3 The edge answers `401`, and that is the pass

```sh
kubectl -n firewatch get ingress firewatch
curl -sS -o /dev/null -w '%{http_code}\n' "https://${DOMAIN}/v1/jobs"
curl -sS "https://${DOMAIN}/v1/jobs"
```

**Expected:** `401`, and a body of the shape `{"code":"unauthorized","request_id":"..."}`. The `401` is produced by the gateway itself, which is the observed behaviour of the local evidence cluster and the only unauthenticated request this runbook can assert end to end.

It is also the only cheap proof that the hop is *verified* and not merely encrypted: the Ingress carries `backend-protocol: HTTPS`, `proxy-ssl-verify: 'on'`, `proxy-ssl-name: gateway` and `proxy-ssl-secret: firewatch/gateway-upstream-ca` (`base/ingress.yaml:14-37`), and `gateway-upstream-ca` must carry `ca.crt` **alone** — `bootstrap-secrets.sh` writes exactly that, and a `tls.crt`/`tls.key` pair in the same Secret is read as a client key pair this hop does not use and is rejected.

**If it fails:** `502` with `upstream SSL certificate verify error: (21:unable to verify the first certificate)` in the controller log means the anchor is wrong or missing — the fail-closed direction. `503` means the annotation failed to parse, which is what a bare Secret name instead of `namespace/name` produces. `404` means the controller is not the one the Ingress names.

**Do not continue unless** the status is `401` and the body carries `unauthorized`.

### 6.4 The certificate on the wire is the one you supplied

```sh
openssl s_client -connect "${DOMAIN}:443" -servername "$DOMAIN" </dev/null 2>/dev/null \
  | openssl x509 -noout -issuer -subject -dates
```

**Expected:** the issuer is the public authority that signed `tls/${DOMAIN}.crt`, **not** `firewatch-internal-ca` — the internal CA never leaves the cluster's trust chain.

**If it fails:** the fake default certificate ingress-nginx serves when `firewatch-tls` is absent is the usual cause; read `kubectl -n firewatch get secret firewatch-tls` (4.3).

**Do not continue unless** the issuer names your public authority and the validity window covers today.

## Hard stops

These are not warnings. Each one produces a deployment that reads as working and is not.

1. **Do not apply the overlay before Phase 3.** The base renders `firewatch/<service>:replace-before-deploy`, a tag no cluster can pull; skipping the pin produces pods in `ErrImagePull` and a Job that never migrates.
2. **Do not use GKE's native Ingress (class `gce`).** `gateway-entry` admits only the `ingress-nginx` namespace into the gateway (`base/network.yaml:33-36`), so a `gce` Ingress routes to an Ingress the network policy does not permit, and the tree's edge configuration (`backend-protocol`, `proxy-ssl-*`) is written for NGINX.
3. **Do not use `backend/docker-compose.prod.yml`.** It was retired as the delivery path on 2026-11-17 (`acta-cierre.md` §7.3) and carries its own banner. It has no registry, no immutable tag, no rollback path and no inference service.
4. **Backups are not delivered.** There is no CronJob, no writer identity and no restore procedure in this tree. Provisioning the bucket creates a destination, not a backup: the upload gate this runbook would need cannot be run today, and the policy of `acta-cierre.md` §7 stays "written, not implemented".
5. **Signing and promotion are not delivered.** Front 7 owns them (`odd/plan-produccion/07-firma-registry-rollout.md:19-22`): no signature is verified before promotion and nothing is automated. Do not describe a push as a signed release.
6. **The realm is provisioned out of band.** Do not import the development realm, and do not read a missing `firewatch` realm as a failed deployment (4.4).
7. **`proxy-ssl-secret` carries `ca.crt` alone.** Adding `tls.crt`/`tls.key` to `gateway-upstream-ca` turns it into a client key pair this hop does not use and the controller rejects it outright.
8. **Do not delete `firewatch-ca`, `gateway-upstream-ca` or `firewatch-tls` to "fix" TLS.** `bootstrap-secrets.sh` never rotates in silence: a deleted Secret is a deliberate rotation, and deleting `firewatch-ca` is a CA *replacement* that leaves every `<service>-tls` chained to the authority that no longer exists.

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

**The schema does not roll back.** The migration runner applies the versions the code carries and records them; there is no down path, and a version recorded in a deployed ledger can never be renumbered or moved (`backend/docs/migration-ledger.md:30-32`). A rollback that crosses a migration is a restore, not a rollback: the older image would run against a schema it does not know. Rolling forward with a fixed image is the only reversible direction, and the overlay is what makes that a one-file change.

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

## Why these steps, without repeating them

- `backend/deploy/k8s/README.md` — "Configure before applying" (what the manifests need in order to render), "Path to a real production cluster" (what a target cluster must bring, what GKE supplies and refuses, Artifact Registry, Cloud Storage with Workload Identity, the `gcloud` checklist, promotion by digest, secret and CA lifecycle, the data plane, rollback, and "Still unverified"), and "What differs from kind" (why `kubectl wait --all` is not a gate and why `--kubelet-insecure-tls` never travels).
- `backend/deploy/k8s/README.md` → "Rollback" — the digest-list mechanism and the forward-only schema.
- `odd/entrega/acta-cierre.md` §7 (policy, SLA and what it does not close), §7.3 (`:161-175`, the Kubernetes substrate) and §7.4 (`:214-242`, Google Cloud with GKE, which closes the cluster-flavor question).
- `odd/tasks/gcp-gke-delivery.md` — the specification of this target, and the state of each task.
- `odd/plan-produccion/07-firma-registry-rollout.md:19-22` — the signing and promotion gap, owned there and not here.
- `backend/docs/migration-ledger.md:30-32` — why the ledger forbids moving a recorded version.
