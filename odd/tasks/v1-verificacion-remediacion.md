# v1-verificacion-remediacion — Corrección de los hallazgos de la verificación independiente

Base: `origin/dev` = `268c893`. Siete ramas ya publicadas en `origin`, sin PR. Esta unidad corrige cinco hallazgos en sus **mismas ramas**, corre las suites, commitea y hace push. **No fusiona, no abre PR, no despliega y no cierra filas ni unidades** (64 filas / 62 unidades / 48 abiertas / 14 cerradas).

## Specs

- **S1 — PM-01, empate del lote ejecutivo.** La selección del lote por zona conserva el desempate `requested_at DESC, id DESC` cuando dos lotes comparten `requested_at`, y una prueba PostgreSQL lo fija: dos lotes con el mismo `requested_at` y `id` distintos se resuelven por `id` descendente. El Log de la unidad no puede afirmar «once per session» si volver a Overview remonta y relee; se corrige a lo observado.
- **S2 — PM-03, enum cerrado y nota de ausencia.** `frontend/src/core/api.ts` valida `level` y `stored_level` contra el conjunto cerrado `RISK_LEVELS`; un valor fuera del conjunto es `invalid_shape` (fail-closed). La precarga del simulador conserva la nota de ausencia cuando el factor llega `known:false`: no inventa valor ni contribución y la fila sigue diciendo «sin lectura».
- **S3 — PM-04, guard, `zoneId` vacío y cambio de alcance.** (a) `historySeries` rechaza `from`/`to` que no sean instantes válidos y rechaza miembros no declarados en cada bucket; (b) un `zoneId` vacío se rechaza de forma explícita en vez de omitirse, de modo que nunca se amplía a todas las zonas; (c) al cambiar de zona o volver a «Todas las zonas», la vista no muestra la ventana ni las filas de la selección anterior mientras carga: el snapshot previo se invalida al cambiar la clave.
- **S4 — PM-05, caché al reañadir y formatos estrictos.** (a) retirar una zona y volver a añadir la última no reutiliza el resultado anterior: la vista entra en carga y descarta el snapshot previo; (b) fechas y `batch_id` se validan con el formato que declara el contrato de la rama (RFC 3339 y `format: uuid`), sin imponer UUID a `zone_id` salvo que el contrato lo declare.
- **S5 — PM-16, normalización y `not_configured`.** (a) `aggregateStatus` acepta solo 200 y 503 como códigos coherentes; cualquier otro 2xx se rechaza en vez de normalizarse a 200; (b) `not_configured` solo es válido para `inference`; en cualquier otro servicio es `invalid_shape`.
- **S6 — Límites de la unidad.** No fusionar, no abrir PR, no desplegar, no cerrar filas; los conteos 64/62/48/14 no cambian. No usar el stack Compose compartido `firewatch`: las pruebas de backend usan un proyecto aislado y lo eliminan. No editar el worktree raíz.

## Tasks

- **T1 — PM-01** (S1): prueba PostgreSQL del empate y corrección del Log de la unidad. Rama `feat/pm-01-executive-panel`. Commit: `66f6807`.
- **T2 — PM-03** (S2): enum cerrado en el guard y nota de ausencia en la precarga. Rama `feat/pm-03-simulator-panel`. Commit: `9b70838`.
- **T3 — PM-04** (S3): guard de instantes y miembros, `zoneId` vacío e invalidación de la ventana al cambiar de alcance. Rama `feat/pm-04-history-panel`. Commit: `bef322e`.
- **T4 — PM-05** (S4): invalidación al reañadir zona y formatos estrictos. Rama `feat/pm-05-comparison-panel`. Commit: `513b64f`.
- **T5 — PM-16** (S5): solo 200/503 y `not_configured` restringido a inferencia. Rama `feat/pm-16-status-panel`. Commit: `41e5798`.
- **T6 — Matriz y documentación** (S6): matriz hallazgo → fix → prueba → commit y estado de reverificación. Rama `docs/v1-reconciliacion`. Commit: `a8586e4`.
- **T7 — Reverificación read-only** (S1-S6): pasada corta sobre las siete ramas ya publicadas. Sin edición. Commit: no aplica.

## Pendiente

- **Fusión y PRs:** ninguna rama se fusionó ni abrió PR. El orden de merge sigue sin definir; la última comprobación de `git merge-tree` —previa a esta remediación— registró conflictos PM-01↔PM-03 (OpenAPI), PM-03↔PM-16, PM-03↔PM-04 y PM-16↔PM-04 (README/OpenAPI), y limpios PM-01↔PM-16 y PM-01↔PM-04. Debe re-ejecutarse al ordenar; los puntos calientes son `frontend/src/core/api.ts`, `app/routes.ts`, `App.tsx`, `OverviewView.tsx` y los pins de `session.test.tsx`.
- **R6:** cada unidad sigue abierta hasta que una persona acepte contrato, backend probado y página. Ninguna fila ni unidad cambió de estado: 64/62/48/14.
- **Fuera de este ciclo:** `PM-08` sigue solo local (`6a86ee2`); `PM-14` no tiene implementación; `D-C` (rol `analista`) sigue abierta.
- **Compuerta de despliegue:** publicar PM-04/05/08 exige renombrar el Job de migración y construir imágenes de risk/jobs/gateway; ningún manifiesto lo hace y un CI verde no lo detecta.

## Log

- **L4 (2026-11-26) — T7 ejecutada: reverificación read-only y cierre del residuo de S4.** La pasada encontró las siete ramas limpias y con tip igual a `origin`; `feat/pm-02-dd-label` sigue en `dc91222` y ningún S# le aplica. Veredictos: **S1 PARTIAL** (prueba PostgreSQL no re-ejecutada; `go vet` y el fixture verificados, corrida aislada previa registrada en el Log de `pm-01`), **S2 PASS** (16/16), **S3 PASS** (45/45 con caché de escritura deshabilitada por la unión de `node_modules` con la raíz), **S5 PASS** (48/48), **S6 PASS** (matriz y conteos 64/62/48/14 intactos) y **S4 PARTIAL**: `instant()` aceptaba `2026-02-31T00:00:00Z` porque `Date.parse` lo desplaza a marzo. Ese residuo se corrigió en `feat/pm-05-comparison-panel` con validación civil (mes, día con año bisiesto, hora/minuto/segundo) y una prueba nueva: 24/24 en el archivo, 606/606 en la suite, `tsc --noEmit` limpio, commit `0d1b0be`. Se retira el riesgo de guard compartido: el endurecimiento es solo del comparador y esa rama no tiene `historySeries`. Sin fusión, PR ni despliegue.

- **L3 (2026-11-26) — T1–T5 corregidas y publicadas en sus mismas ramas; T6 y T7 en curso.** Las cinco unidades se corrigieron test-first, con `tsc --noEmit` limpio y suite completa en verde por rama; los commits se empujaron a `origin` sin fusión, PR ni despliegue.

  | Rama | Hallazgo (L2) | Fix | Prueba | Commit |
  | --- | --- | --- | --- | --- |
  | `feat/pm-01-executive-panel` | falta prueba del empate; el Log dice «once per session» | prueba PG del empate y corrección del alcance releído; sin cambio de producción | `TestExecutiveBatchesBreakATieOnTheHigherID` (PG aislado) | `66f6807` |
  | `feat/pm-03-simulator-panel` | nota perdida con `known:false`; niveles fuera del enum | enum cerrado `RISK_LEVELS` + nota de ausencia conservada | 2 casos en `simulator.test.tsx`; 598/598 | `9b70838` |
  | `feat/pm-04-history-panel` | instantes/campos sin guard; `zoneId` vacío amplía; snapshot previo al volver | RFC 3339 + registros cerrados; `zoneId` vacío rechazado; snapshot invalidado | 3 casos en `history.test.tsx`; 598/598 | `bef322e` |
  | `feat/pm-05-comparison-panel` | reañadir zona reusa resultado; fecha/UUID laxos | snapshot descartado al cambiar la selección; RFC 3339 y UUID de `batch_id` | 4 casos en `compare.test.tsx`; 605/605 | `513b64f` |
  | `feat/pm-16-status-panel` | 2xx normalizado a 200; `not_configured` fuera de inference | solo 200/503; estado posicional por servicio | 2 casos en `status.test.tsx`; 605/605 | `41e5798` |

  - **PM-02 y `docs/v1-reconciliacion`**: sin hallazgos en L2; no cambian. PM-08 y PM-14 siguen fuera de este ciclo.
  - **Límites respetados**: no se fusionó, no se abrió PR, no se desplegó y no cambió ninguna fila ni unidad de ODD (64/62/48/14). Las pruebas de backend usaron proyectos Compose aislados (`fw-pm01-tiebreak`) eliminados con `down -v`; el proyecto compartido `firewatch` no se tocó. El worktree raíz no se editó.
  - **Pendiente**: la pasada de reverificación read-only de T7 y su estado en este documento.

- **L2 (2026-11-26) — Hallazgos de la verificación independiente, textuales.** Esta unidad los toma como enunciado del defecto; no los reescribe.
  - **PM-01** — S5 parcial: falta prueba PostgreSQL del empate `requested_at DESC, id DESC` (el fixture usa timestamps distintos). El Log dice «once per session»; volver a Overview remonta y relee.
  - **PM-04** — S3 parcial: el guard del cliente acepta timestamps inválidos y campos no declarados; `zoneId` vacío se omite y amplía a todas las zonas; al volver a «Todas las zonas» se ven ventana/datos anteriores mientras carga la nueva.
  - **PM-05** — S3/S4 con caveats: reañadir la última zona puede reusar resultado previo; formato fecha/UUID no estricto (el eco por instante sí se valida).
  - **PM-03** — S4/S5 parciales: la precarga pierde la nota de ausencia con `known:false`; el guard acepta niveles fuera del enum cerrado.
  - **PM-16** — S4 parcial: cualquier 2xx se normaliza a 200 en vez de rechazarse; acepta `not_configured` fuera de inference.
- **L1 (2026-11-26) — Autorización del responsable, textual:** «Corregir todo, commit y push a las mismas ramas». Alcance confirmado: los cinco hallazgos en sus mismas ramas, suites, commit y push; sin fusión, sin PR y sin despliegue.
