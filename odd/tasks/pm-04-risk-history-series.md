# PM-04 — granular risk history
Backend only, additive contract; worktree based on `origin/dev`; no publication.

## Specs
- S1 — “**PM-04 historial granular** — `zone_id` sigue obligatorio (`required: true`, y el handler rechaza cualquier parámetro extra) y la ventana es fija de 100 filas; faltan hora/día/semana y el historial de todas las zonas.”
- S2 — “Una capacidad a la vez, cada una con su contrato en el OpenAPI y su prueba de contrato, como hicieron #118–#121.”
- S3 — “No inventes datos ni cambies rutas existentes: el frontend ya consume `latest`, `history`, `batches`, `zones`, `sources`, `status`, `jobs`, `models`, `audit`, `prevention/*`, `users`.”
- S4 — “Una serie por zona (recomendado)” — “Conserva la evolución de cada zona sin combinar sus niveles.”
- S5 — “Nivel del último lote (recomendado)” — “Muestra la última evaluación registrada, aunque su nivel sea desconocido.”

## Tasks
- T1 [S1–S5] Worker + parent: implement the additive series, contract and audit; done, `4713e8d`.
- T2 [S1–S5] Parent + independent verifier: validate PostgreSQL/contract, audit and unchanged legacy paths; done, `4713e8d`.

## Log
- L1 — “de momento solo trabaja en backend ya luego subimos a dev y dejamos todo listo con la sesión de front”
- L2 — User chose “Una serie por zona (recomendado)” and “Nivel del último lote (recomendado)”. Empty buckets are gaps, not unknown levels.
- L3 — Series is a sibling history read: use the existing `risk.history.read` action and same fail-closed audit behavior. Risk: item 2 (changes the gateway audit guard allow-list).
- L4 — Parent registered migration 018 and corrected two static false positives matching SQL comments. Migration/server tests passed. Job-10 exercises real PostgreSQL; job-11 runs backend checks; independent audit verification `mwwjy76y-6-f4ip` ran focused/full checks and identified malformed proxy query and implicit HEAD defects.
- L5 — Job-10 exposed a +65 minute fixture that intended +60. Corrected the fixture and added an applied-index assertion; live PostgreSQL job-12 passed hour/day/week, zero skips. Job-11 passed OpenAPI, module suites and vet. Gateway regression was RED (200, upstream hit, audit record), then GREEN independently; HEAD regression was RED (200, read), then job-13 passed HEAD refusal, final contracts, legacy compatibility, modules and vet.
- L6 — Work-unit boundary `268c893..4713e8d` (target `dev`), 2,139 insertions and 36 deletions; choose review slices before publication. Kubernetes rollout must use a risk image containing 018 and a new migration job identity (`migrate-v18-j6`); no deployment edits or checks in this backend slice. Worker-produced `backend/server.exe` excluded from staging.
