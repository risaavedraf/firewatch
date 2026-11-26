# PM-03 — counterfactual risk simulation
Backend-only; independent branch from `origin/dev`. Publication and frontend coordination are deferred.

## Specs
- S1 — “**PM-03 simulador contrafactual** — no hay ruta de cálculo sin escritura; solo `/v1/risk/cycle/run`, que sí escribe lote.”
- S2 — “Una capacidad a la vez, cada una con su contrato en el OpenAPI y su prueba de contrato, como hicieron #118–#121.”
- S3 — “No inventes datos ni cambies rutas existentes: el frontend ya consume `latest`, `history`, `batches`, `zones`, `sources`, `status`, `jobs`, `models`, `audit`, `prevention/*`, `users`. Un cambio incompatible en esas rompe la rama G1.”
- S4 — “Usar la regla del lote original (recomendado)” — “Simular solo si está disponible la misma regla con los mismos parámetros. Si no, indicar que el lote no se puede simular.”
- S5 — “Un endpoint autenticado recalcula con variables sustituidas y devuelve el resultado sin escribir ninguna fila; dos pruebas cubren la sustitución y el no-efecto sobre `batches`; la página lo ofrece y explica que es la regla, no un pronóstico.” Backend portion only.

## Tasks
- T1 [S1–S5] Worker (context backstop): implement and test one read-only simulation endpoint and OpenAPI; done; `48412f6`.
- T2 [S1–S5] Parent: verify HTTP contract and PostgreSQL no-write evidence, then record local commit; done; `48412f6`.

## Log
- L1 — “de momento solo trabaja en backend ya luego subimos a dev y dejamos todo listo con la sesión de front”
- L2 — User selected original batch rule and exact policy fingerprint; no fallback to the currently active model.
- L3 — RED absent route (404); GREEN service/contract suite. Job-8 validated full OpenAPI, module tests and vet. Job-7 failed during setup (stale fixture); after aligning fixture clocks, job-9 ran both real PostgreSQL cases with zero skips and verified identical `batches` contents. No full-stack gateway smoke in this slice.
- L4 — Work-unit boundary `268c893..48412f6` (target `dev`), 1,760 inserted lines across implementation, contract, docs and tests. Review workload exceeds the approximately 400-line target; choose a review shape before publication. Publication remains deferred.
