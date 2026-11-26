# PM-05 — multi-zone risk comparison
Backend only; stacked locally on PM-04 (`4713e8d`). Publishing and frontend coordination deferred.

## Specs
- S1 — “**PM-05 comparador multi-zona** — ninguna ruta acepta lista de zonas.”
- S2 — “Dos o tres zonas se comparan en riesgo, variables e historial por una sola llamada; la prioridad se suma cuando exista PM-11 y la fila lo dice; la vista no ofrece un cuarto eje vacío.” Backend portion only.
- S3 — “Una capacidad a la vez, cada una con su contrato en el OpenAPI y su prueba de contrato, como hicieron #118–#121.”
- S4 — “No inventes datos ni cambies rutas existentes”.
- S5 — “Último lote anterior al fin del período (recomendado)” — “Todas las zonas se comparan al mismo corte. Si la zona no publicó dentro del período, puede mostrar una evaluación anterior con su fecha.”
- S6 — “Registrar un evento propio de comparación (recomendado)” — “La auditoría distingue el comparador del historial. Requiere una migración adicional del servicio de trabajos.”

## Tasks
- T1 [S1–S6] Worker (context backstop): additive comparator, contract, named audit action and tests; done; `6790377`.
- T2 [S1–S6] Parent + independent verifier: verify risk SQL and audit migration/control; done; `6790377`.

## Log
- L1 — “de momento solo trabaja en backend ya luego subimos a dev y dejamos todo listo con la sesión de front”
- L2 — User selected the latest batch strictly before the common cutoff and a named audit action, one record without filters. Preserve catalogue zones without evaluation; omit unsupported priority. Risk item 2 (gateway audit guard and narrow SQL writer).
- L3 — Worker `mwwkswp0-9-1tn3` implemented S1–S6 including jobs migration 007 registration; Go tests and vet passed, DB tests skipped without DSNs. Jobs are independent of the shared risk ledger. Parent jobs 14 (risk snapshot) and 15 (narrow audit writer) and verifier `mwwlcje8-a-yq9r` provided evidence.
- L4 — Job-14 passed initial risk snapshot. Job-15 exposed a syntax typo in the privilege test; job-17 passed migrated PostgreSQL new and existing action tests after correcting the assertion. Independent review passed audit scope and found assessment cutoff and OpenAPI nullability defects. Job-18 RED selected a batch published exactly at `to`; job-19 GREEN proved it remains in request-time history but not in the as-of assessment. Job-20 passed final OpenAPI and module suites/vet.
- L5 — Work-unit boundary `4713e8d..6790377` (stacked on PM-04), 2,241 additions and 20 deletions. Choose review slices before publication. Future combined rollout requires risk 018/jobs 007 and migration Job identity `migrate-v18-j7`; no cluster check or rollout was performed.
