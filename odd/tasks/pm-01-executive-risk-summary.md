# PM-01 — executive risk summary
Backend-only worktree from `origin/dev`; continue other capabilities separately.
CSV audit is already merged via #120; do not duplicate it.

## Specs
- S1 — “**PM-01 agregado ejecutivo** — no existe endpoint de conteos por nivel, variación entre lotes ni variables predominantes; el frontend tendría que abrir una lectura por zona. Necesita agregado en servidor.”
- S2 — “Una capacidad a la vez, cada una con su contrato en el OpenAPI y su prueba de contrato, como hicieron #118–#121.”
- S3 — “No inventes datos ni cambies rutas existentes: el frontend ya consume `latest`, `history`, `batches`, `zones`, `sources`, `status`, `jobs`, `models`, `audit`, `prevention/*`, `users`. Un cambio incompatible en esas rompe la rama G1.”
- S4 — “Comparar los dos últimos lotes por zona solo si coinciden la versión del modelo, el modo y el escenario. Informar las exclusiones.”
- S5 — “Cuando una capacidad quede fusionada en `origin/dev`, avísame por intercom con la ruta exacta, los parámetros y la forma de la respuesta; yo la aplico en el frontend.”

## Tasks
- T1 [S1–S4] Inline: implement and verify the additive executive summary, OpenAPI and contract tests; done; `8266bc1` (base `268c893`, target `dev`).
- T2 [S5] Parent: notify frontend after merge is observed; pending separate delivery authorization; no commit.

## Log
- L1 — “inicia el trabajo porfa”
- L2 — User selected “Comparar solo lotes equivalentes (recomendado)”.
- L3 — `origin/dev` at `268c893` contains #120 CSV auditing and PM-07 alert events. Critical-zone semantics (D-B) and active-alert lifecycle are outside the three aggregate metrics in S1; no field is fabricated for either.
- L4 — HTTP contract RED job-1 (404 without the route), GREEN job-2 (including suite and vet); OpenAPI validator passed in job-3 before Windows race failed without cgo. PostgreSQL job-4 exposed fixture assumptions; job-5 passed with corrected persisted demo flag and both fixture batches newer than prior data. Linux race job-6 passed in isolation without a database; PostgreSQL coverage is from job-5. Staged diff check passed.
