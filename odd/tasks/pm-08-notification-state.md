# PM-08 — personal in-app notification state
Backend only; local base `6790377` (PM-04/PM-05); no publication or frontend coordination.

## Specs
- S1 — “**PM-08 estado de notificación** — la alerta no tiene marca de leída/descartada ni entrega.”
- S2 — “Una capacidad a la vez, cada una con su contrato en el OpenAPI y su prueba de contrato, como hicieron #118–#121.”
- S3 — “No inventes datos ni cambies rutas existentes”.
- S4 — “Solo administradores, para sí mismos” — “El estado sigue siendo personal, pero los viewers conservan acceso de solo lectura.”
- S5 — “Solo dentro de la aplicación (recomendado)” — “La cronología muestra las alertas disponibles; no se registra una entrega ficticia. Solo se guarda la marca explícita si se autoriza arriba.”

## Tasks
- T1 [S1–S5] Worker: additive self-scoped state, contract and tests; done, `6a86ee2`.
- T2 [S1–S5] Parent + independent verifier: validate policy, immutability, concurrency and real migration; done, `6a86ee2`.

## Log
- L1 — “de momento solo trabaja en backend ya luego subimos a dev y dejamos todo listo con la sesión de front”
- L2 — User chose admin-only self marks and in-app-only availability. No transport and no delivery receipt. Existing alerts remain immutable and byte-compatible. Risk items 2 and 4 (identity and idempotent concurrent writes).
- L3 — Job-24 proved initial real PostgreSQL behavior. Job-25 exposed the inherited CRLF-sensitive audit-SQL assertion; job-26 passed after normalization, recorded separately in `f0b963d`.
- L4 — Independent verifiers identified strict JSON and narrow preflight issues and timestamp semantics. Observed RED/GREEN for duplicate and case-variant keys, canonical PUT preflight, insertion-time clock and encoded delimiter preflight. Job-27 observed live lock-wait, concurrent marks and grants; job-28 passed full backend/OpenAPI; job-29 passed final gateway/risk, vet and encoded-path regression.
- L5 — Work-unit boundary `f0b963d..6a86ee2` (stacked on PM-04/PM-05), 2,435 additions and 28 deletions. Choose review slices before publication. Kubernetes rollout needs risk 019/jobs 007 and a `migrate-v19-j7` migration Job; no cluster rollout, frontend change or publication performed.
- L6 — User requested additional PM-08 verification only, not Kubernetes changes. Linux `-race` jobs: job-30 repeated real PostgreSQL tests 10 times (110 top-level passes, lock-wait test passed 10 times); job-31 repeated HTTP authorization and contract tests three times (30 top-level passes, admin-only subject-isolation test passed three times). Both exited 0 with no skips or race reports. No source changes.