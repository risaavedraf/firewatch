# V1-P-06 — Publicar lote, avance manual y reevaluación

**Objetivo:** `V1-P-06` — `Publicar lote, avance manual y reevaluación` ([`v1-produccion.md:196`](v1-produccion.md), G6): las tres acciones existen como endpoints autenticados con autorización por rol, una prueba cubre el rechazo por rol y el estado resultante, la página las ofrece y la entrada sale de `NOT_IMPLEMENTED`.
**Rama:** `feat/v1-p-06-manual-publish`, `chain_strategy=feature-branch-chain`, integrando `feat/firewatch-design-migration` `8c147a3` y `feat/pm-06-actor-evaluation` `658b864`. Runners: `cd frontend && npm run verify`; `cd backend/services/risk && GOWORK=off go test -count=1 ./internal/handler`; `cd backend/services/prevention && GOWORK=off go test -count=1 ./internal/handler`.

## Specs

**S1 — Autorización del responsable (textual).**

> «terminemos con lo que necesite codigo mientras no llego a mi casa aún»

**S2 — Criterio de cierre (textual, `V1-P-06`).** [`v1-produccion.md:196`](v1-produccion.md):

> «Las tres acciones existen como endpoints autenticados con autorización por rol, una prueba cubre el rechazo por rol y el estado resultante, la página las ofrece, y la entrada sale de `NOT_IMPLEMENTED`.»

Las tres acciones y el punto en que ya están:

- **Avance manual.** `POST /v1/prevention/actions/{id}/transitions` ya existe en el contrato ([`firewatch-v1.yaml:1755`](../../backend/contracts/openapi/firewatch-v1.yaml)), en el cliente ([`api.ts:1649`](../../frontend/src/core/api.ts)) y en la página, que ofrece solo las transiciones válidas del estado actual ([`ActionsView.tsx:1444`](../../frontend/src/views/ActionsView.tsx)).
- **Reevaluación.** `POST /v1/prevention/actions/{id}/reassessments` ya existe en el contrato ([`firewatch-v1.yaml:2096`](../../backend/contracts/openapi/firewatch-v1.yaml)), en el cliente ([`api.ts:1748`](../../frontend/src/core/api.ts)) y en la página, que lista las reevaluaciones registradas ([`ActionsView.tsx:1397`](../../frontend/src/views/ActionsView.tsx)).
- **Publicación manual de lote.** `POST /v1/risk/cycle/run` ya existe en el backend, admin-only (`requireAdmin`, [`api.go:153`](../../backend/services/risk/internal/handler/api.go); [`cycle.go:33`](../../backend/services/risk/internal/handler/cycle.go)) y documentado ([`firewatch-v1.yaml:1279`](../../backend/contracts/openapi/firewatch-v1.yaml)). `PM-06` ([`pm-06-actor-evaluation.md`](pm-06-actor-evaluation.md), [`020_batch_evaluation_actor.sql`](../../backend/services/risk/migrations/020_batch_evaluation_actor.sql)) hace que cada lote publicado por esa ruta persista `evaluation_trigger='manual'` y `evaluated_by` igual al sujeto verificado del token; `BatchCore` declara ambos miembros ([`firewatch-v1.yaml:3313`](../../backend/contracts/openapi/firewatch-v1.yaml)). La ruta no acepta cuerpo con miembros: el actor nunca viene del cliente.

Lo que esta unidad entrega, sin ampliar el criterio — `T1`:

- **Cliente.** `frontend/src/core/api.ts` gana la llamada a `POST /v1/risk/cycle/run` con cuerpo explícitamente vacío y guard fail-closed de la respuesta, en la misma forma que las lecturas ya existentes.
- **Página.** `frontend/src/views/JobsView.tsx` ofrece la publicación manual y muestra el resultado del ciclo; los lotes leídos de `BatchCore` muestran su procedencia (`evaluation_trigger`, `evaluated_by`) en vez de dejarla invisible. Los `font-size` que añada quedan en `rem`, como el resto de la hoja.
- **Autorización probada.** Una prueba cubre el rechazo por rol de las tres acciones —`viewer` → `403` y sin sesión → `401`— y, para cada una, el estado resultante publicado: la transición aplicada, la reevaluación registrada y el lote publicado con su procedencia.
- **`NOT_IMPLEMENTED`.** La entrada «Publicar lote, avance manual y reevaluación» de [`PendingView.tsx:61`](../../frontend/src/views/PendingView.tsx) sale de la lista y de su prueba ([`pending.test.tsx`](../../frontend/tests/views/pending.test.tsx)), cuyo conteo pasa al número real; no se retira ninguna otra fila.

## Tasks

**T1 — Publicación manual, procedencia y retiro de la entrada.** `S1`–`S2`. `done` at `adc19d8`, no push/PR yet.

- **Cliente** `frontend/src/core/api.ts`: operación de `POST /v1/risk/cycle/run` con cuerpo vacío, rechazo de `401`/`403`/`503` como estados distintos y guard fail-closed del `CycleRunResult`; tipos de `BatchCore` con `evaluation_trigger` y `evaluated_by`.
- **Página** `frontend/src/views/JobsView.tsx`: control de publicación manual, resultado por zona y estado del ciclo, y la procedencia del lote publicado en texto; estilos nuevos con `font-size` en `rem`.
- **Autorización y estado resultante:** prueba del rechazo por rol en las tres acciones (`viewer` `403`, sin sesión `401`) y del estado publicado que deja cada una.
- **Retiro:** «Publicar lote, avance manual y reevaluación» sale de `frontend/src/views/PendingView.tsx` y de `frontend/tests/views/pending.test.tsx`, con el conteo de filas real.
- **Validación:** los tres runners del encabezado, reportando cada resultado y toda omisión. No se commiteará, fusionará ni publicará en esta unidad.
- **Ruta:** escritor full-stack acotado, con la superficie de edición que declara esta unidad.
- **Riesgo 2 y 3:** toca la interfaz y el cliente de una operación con autorización por rol —donde un fallo se lee como permiso concedido— y comparte `frontend/src/core/api.ts` y el contrato de `PendingView`/`pending.test.tsx` con otras unidades de la cadena.

## Log

- **L1 (2026-11-27) — Se abre `V1-P-06` con este registro, antes de la primera escritura de código fuente.** Autorización del responsable, textual: «terminemos con lo que necesite codigo mientras no llego a mi casa aún». Este archivo es solo Markdown: no hay cambio de cliente, de página, de prueba ni de backend, y las tres suites de los runners no se ejecutaron. La unidad queda `in_progress` y sin commit; la rama `feat/v1-p-06-manual-publish` integra `feat/firewatch-design-migration` `8c147a3` y `feat/pm-06-actor-evaluation` `658b864` con `chain_strategy=feature-branch-chain`. Nada se cierra por escribir este documento: `V1-P-06` sigue abierta hasta que la página ofrezca las tres acciones y la entrada haya salido de `NOT_IMPLEMENTED`.
  - **Verificación de este archivo.** `git diff --no-index --check /dev/null odd/tasks/v1-p-06-manual-publish.md` no informó errores de espacios —solo el aviso de Git sobre LF→CRLF y el `exit 1` propio de comparar contra `/dev/null`—; `python -B odd/tools/check_md_links.py --self-test` pasó `22/22`. Los enlaces relativos de este documento resuelven; el chequeo global informa cuatro hallazgos preexistentes en otros archivos `odd/tasks` y en `frontend/VISUAL-AUDIT.md`, ninguno de este documento.

- **L2 (2026-11-27) — `T1` cerrada en `adc19d8`; `V1-P-06` no cambia de estado por esta entrega.** Commit `adc19d8` —«feat(product): wire manual batch publication and retire V1-P-06 pending row»—, 14 archivos, +1342/−35, sin `push` ni PR. El corte se mantuvo cohesivo a propósito: el contrato de tipos y lecturas (`types/api.ts`, `core/api.ts`, `domain/batch.ts`, `domain/cycle.ts`), el panel de ciclo manual de `JobsView.tsx`, el retiro de la fila de `PendingView.tsx` —de 5 a 4 entradas, con `pending.test.tsx` al conteo real— y las pruebas Go de rechazo por rol con relectura HTTP con estado, en `risk` y `prevention`, entran en un solo commit, porque un cliente nuevo sin su prueba de autorización o una fila retirada sin su conteo se leerían como entregados sin estarlo.
  - **Qué quedó entregado.** `POST /v1/risk/cycle/run` se ejerce desde la página con cuerpo vacío, `401`/`403`/`503` como estados distintos y guard fail-closed del resultado; los lotes leídos de `BatchCore` muestran `evaluation_trigger` y `evaluated_by`; y la entrada «Publicar lote, avance manual y reevaluación» salió de `NOT_IMPLEMENTED`. Las pruebas Go de `risk` y `prevention` cubren el rechazo por rol de las tres acciones con el estado resultante releído por HTTP, no solo el código de estado.
  - **Evidencia de la ejecución (parent y worker; no re-ejecutada en esta sesión).** RED: `5 files / 24 failed` en la primera corrida del cliente y la página, más `2 failed` en la doble implicación de tipos y en la relectura con estado de `evidence_test.go`. GREEN: `62 files / 888 tests` en `npm run verify`, y las suites de handler de `risk` y `prevention` en `ok`. Una verificación independiente `gentle-ai-verify` dio PASS en `S1` y `S2`. Este registro no las repite ni las convierte en propias.
  - **Lo que falta para cerrar la fila.** `V1-P-06` sigue **abierta**: falta la aceptación humana (`R6`, G6) y el cierre formal en `v1-produccion.md`. Nada se empujó, fusionó ni desplegó, y este documento no declara `R6` satisfecho.
