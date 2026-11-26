# PM-16 — multi-service status
Backend only; isolated worktree from `origin/dev`. No publication or frontend coordination.

## Specs
- S1 — “**PM-16 tablero multi-servicio** — prevention e inference no publican estado; nada agrega risk + jobs.”
- S2 — “Una capacidad a la vez, cada una con su contrato en el OpenAPI y su prueba de contrato, como hicieron #118–#121.”
- S3 — “No inventes datos ni cambies rutas existentes”.
- S4 — “Incluir una comprobación interna de inferencia” — “Diseñar una comprobación a través del servicio de riesgo, que ya tiene acceso. No exponer el servicio de inferencia directamente.”

## Tasks
- T1 [S1–S4] Worker: additive gateway aggregate, prevention and inference evidence, OpenAPI and tests; done; `b4a7dcc`.
- T2 [S1–S4] Parent and independent verifier: check no permission expansion, bounded fan-out, truthful evidence and old routes; done; `b4a7dcc`.

## Log
- L1 — “de momento solo trabaja en backend ya luego subimos a dev y dejamos todo listo con la sesión de front”
- L2 — User approved reachability evidence via risk only; viewer still cannot read jobs operational details. Weather remains not integrated; no overall readiness inference. Risk items 2 (auth/TLS boundary) and 4 (bounded fan-out).
- L3 — Worker `mwwmqm1d-d-unbi` completed T1 with compile-time RED and targeted GREEN, service suites and vet. Parent job-21 and independent verifier `mwwnc0ef-e-z1pv` running. No live multi-service stack proof yet.
- L4 — Job-21 and independent suites passed; verifier instead returned changes required on static inspection: scheme policy, viewer/admin gate, full inference evidence, oversized prefix, HTTP/body consistency and 503 prose. Worker correction `mwwnflux-f-8x7x` is bounded to those findings plus incoming cancellation coverage.
- L5 — Independent recheck `mwwnqarm-g-q3x2` passed five Go packages and verified role, TLS, body limit and cancellation boundaries. It found extra fields slipping through closed inference Health objects. Parent reproduced both regressions, added strict decoding preserving single-document semantics, and observed GREEN in job-23 with OpenAPI, four suites, vet and diff checks. No live-stack or race proof in this slice.
- L6 — Work-unit boundary `268c893..b4a7dcc`, 2,321 additions / 10 deletions; choose review slices before publication. No changes to the frontend or cluster.