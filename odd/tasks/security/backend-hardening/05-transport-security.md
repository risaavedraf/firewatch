# BH-05 — Enforce secure internal and data-service transport

**Status:** enforced at startup in all four services and covered by tests; `main` issues one server certificate per service, signed by the internal CA, the runtime Secret bundles the Deployments mount, and `8556c66` (T7.7) mounts each `<service>-tls` at `/etc/tls` and points the gateway upstreams at `https://`. What remains is the target runtime: the base has been applied to a local kind cluster only, with the transport evidence recorded there (T9) | **Priority:** P1 | **Dependencies:** BH-01; coordinate BH-04 and BH-06.

## Evidence and scope

Before this unit, the OIDC endpoints were the only transport that anything refused to reach in clear. Everything else ran plaintext with no guard:

| Transport | Before |
| --- | --- |
| service → PostgreSQL | `sslmode=disable` in every compose file, nothing checked at startup |
| `jobs`/`risk` → RabbitMQ | `amqp://`, nothing checked at startup |
| gateway → `jobs`/`risk`/`prevention` | `http://`, nothing checked at startup |
| browser / IdP | already HTTPS, terminated by Caddy with ACME |
| `prevention` → Keycloak Admin API | already refused plaintext outside development |

## Transport paths and trust ownership

| Path | Terminates at | Trust source | Who owns the certificate |
| --- | --- | --- | --- |
| Browser → edge | Caddy | public CA via ACME | the deployment, renewed automatically |
| Edge → gateway | Caddy | internal | the deployment |
| Gateway → services | each service | internal CA | the deployment: `bootstrap-secrets.sh` issues one server certificate per service, naming the Service and its `<name>.<namespace>.svc` forms as SANs, and the gateway loads that CA from `TLS_CA_FILE`. Every application Deployment in `backend/deploy/k8s/base/workloads.yaml` mounts its own `<service>-tls` Secret at `/etc/tls` and sets the three variables (`:72-84`, `:99-102`; one block per service at `:145-155`, `:167-170`, `:207-218`, `:230-233`, `:273-284`, `:296-299`), so this hop is TLS in the base as written (T7.7, `8556c66`) |
| Services → PostgreSQL | PostgreSQL | internal CA | the deployment |
| `jobs`/`risk` → RabbitMQ (AMQP) | RabbitMQ | internal CA | the deployment |
| Services → IdP (OIDC, JWKS, Admin API) | Keycloak | public CA via the ingress | the identity deployment |

## The exception

`APP_ENV` must be exactly `development`. That is the same predicate the OIDC checks already use, so there is one way to express the exception and no second one can drift from it. An unset, empty, `Production` or `Development` value is a deployment and fails closed.

## What is enforced now

- **Database.** `requireTLSOutsideDevelopment` tests `cfg.ConnConfig.TLSConfig`, not the URL text: pgx leaves it nil for every mode that negotiates no TLS, so `sslmode=disable` cannot slip through a spelling the guard does not recognise. Error: `DATABASE_URL must require TLS outside development`.
- **Broker.** `requireSecureBrokerURL` requires the `amqps` scheme, and additionally refuses `verify=verify_none`. A TLS connection with verification off protects nothing against an active attacker, and it is what someone reaches for when a certificate check starts failing.
- **Gateway upstreams.** `requireSecureUpstreams` requires `https` for each non-empty upstream and names the offending variable. The names are sorted so two replicas of the same misconfiguration print the same message.

Each guard sits on a small seam (`startupBrokerURL`, `startupTransport`) so the refusal is testable without a database, a broker, or a listener. The broker guard runs after the migrate branch on purpose: a migration job holds only `DATABASE_URL` and never dials the broker.

Tests cover, per guard: production with the insecure form returns the exact message; production with the secure form passes; development with the insecure form passes; an empty `APP_ENV` fails; `Development` capitalised fails; `amqps` with `verify_none` fails.

## What is not done

- **The certificates are issued and mounted.** `backend/deploy/k8s/base/workloads.yaml` sets `TLS_CERT_FILE`, `TLS_KEY_FILE` and `TLS_CA_FILE` for the gateway (`:72-80`), jobs (`:145-151`), risk (`:207-214`) and prevention (`:273-280`), and mounts each service's own `*-tls` Secret at `/etc/tls` (`:99-102`, `:167-170`, `:230-233`, `:296-299`); `8556c66` (T7.7 in `odd/tasks/kubernetes-deployment.md`). A pod with neither `TLS_CERT_FILE` nor `TLS_KEY_FILE` set refuses to start outside `APP_ENV=development` rather than listen in clear, so the base cannot serve these hops in plaintext by omission. What is not proven is the target runtime: the base was applied once, to a local kind cluster, where the material was mounted and read with `fsGroup: 65532` over `defaultMode: 0440` and the HTTPS probes answered, and that cluster was then deleted — no handshake has run in the authorised environment (T9, L20 in `odd/tasks/kubernetes-deployment.md`). The production compose file is fail-closed for the same reason and is kept as superseded history, not as a deployment target: under `APP_ENV: production` its DSNs still carry `sslmode=disable` and its broker URLs `amqp://`, so it would refuse to start until they point at TLS endpoints with a root certificate, which is the intended behaviour of a guard and not a working deployment. The development compose file keeps the plaintext forms under `APP_ENV: development`, which is the exception above and not a contradiction of this section.
- The Kubernetes manifests carry the TLS wiring for the **data plane** (PostgreSQL and RabbitMQ server certificates from an internal CA, `amqps` only, plaintext AMQP listener disabled) and for the application plane: `backend/deploy/k8s/base/config.yaml:20-23` points `JOBS_URL`, `RISK_URL` and `PREVENTION_URL` at `https://`, and each application Deployment mounts its certificate as described above. Earlier revisions of this document said the opposite — "They carry nothing for the gateway's upstreams", "no application Deployment mounts a certificate" and "that base cannot start the gateway as written" — and all three were false against those files: the base started in the kind run recorded in L20 of `odd/tasks/kubernetes-deployment.md`. What survives from that bullet is the boundary, not the wiring: nothing here has been applied to the target runtime.
- Of the four verification cases that need a live environment, two have been run and two have not. A secure connection succeeding and an untrusted certificate rejected were observed in the local kind cluster on 2026-11-10 (a `risk` → `inference:8080` probe with the internal CA returned `http=200`; the same request without it failed with `curl: (60) SSL certificate problem: unable to get local issuer certificate`). An expired certificate and a hostname mismatch have no recorded check in that deployment record. None of the four has been observed in the target runtime, and none can be claimed from a manifest.
- mTLS was considered and not chosen: inside a single-cluster network the client would have to be identified by a certificate the same cluster issued, and service identity is already carried by the bearer token and, for the broker, by the AMQP user whose permissions BH-04 measures. Revisit it if services ever span networks the project does not control.

## Acceptance checklist

- [x] Transport paths, termination points, trust sources and certificate ownership are documented above.
- [x] Insecure configurations are refused at startup outside development.
- [x] The development-only exception is explicit and fails closed for any other value.
- [x] Application settings and deployment configuration are aligned: no longer blocked on provisioning the certificates. `fcbabaf` (T7.6), now in `main`, emits one certificate per service and wires the runtime environment that consumes them, and `8556c66` (T7.7) mounts each `<service>-tls` at `/etc/tls` and moves the gateway upstreams to `https://`.
- [ ] The deployment security verification is complete in the target runtime: pending, because the base has only been applied to a local kind cluster — see T9 in `odd/tasks/kubernetes-deployment.md`.

## Log

- **L1 (2026-11-09)** — Guards added to `jobs`, `risk`, `prevention` and the gateway with tests for the false cases. The database guard checks pgx's negotiated TLS state rather than the URL text, because a string match would accept a spelling it did not anticipate. Full suites pass: jobs 6 packages, risk 12, prevention 8, gateway 4.
- **L2 (2026-11-17)** — Corrected the claims that the manifests contradicted. This document said no Deployment mounts a certificate and that `config.yaml` still pointed at `http://`; `backend/deploy/k8s/base/workloads.yaml:72-84, 99-102` (and the same blocks at `:145-155`, `:207-218`, `:273-284`, `:296-299`) plus `backend/deploy/k8s/base/config.yaml:20-23` say otherwise, and they landed in `8556c66` (T7.7). It also said nothing had been applied to a cluster; the base was applied to a local kind cluster on 2026-11-10, with the handshake evidence in L20 of `odd/tasks/kubernetes-deployment.md`, while the target runtime remains untouched (T9). What the older text got right: the data plane wiring was described correctly, a manifest is not evidence of a handshake, and no record exists here of an expired-certificate or hostname-mismatch check.
