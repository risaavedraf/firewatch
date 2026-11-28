# PM-06 — Evaluación con actor verificado

**Objetivo:** PM-06 — Evaluación con actor verificado y distinción programador (`scheduler`) vs manual (`manual`), ítem 9 del mandante.
**Rama:** `feat/pm-06-actor-evaluation`, base `dev` `bfd3c8a`. Runner: `cd backend/services/risk && GOWORK=off go test ./...`.

## Specs

**S1 — Autorización del responsable (textual).**

> «terminemos con lo que necesite codigo mientras no llego a mi casa aún»

**S2 — Criterio de cierre (textual, `PM-06` y `V1-M-04`).**

`PM-06` ([`../plan-produccion/16-producto-mandante.md:46`](../plan-produccion/16-producto-mandante.md)):

> «Cada evaluación registra fecha, variables, resultado y actor; el actor es el sujeto verificado del token y nunca uno enviado por el cliente; una evaluación del programador se distingue de una manual y una prueba cubre ambos casos.»

`V1-M-04` ([`v1-produccion.md:122`](v1-produccion.md)):

> «La regla está escrita junto al migrador, con el rango de versiones que usa cada servicio, y una prueba falla cuando dos servicios reclaman la misma versión, como el guard existente; la versión de la próxima migración de `prevention` queda determinada por esa regla.»

Lo que esta unidad acepta, sin ampliarlo:

- **Actor verificado.** Toda evaluación de riesgo persistida registra fecha, variables, resultado y actor, y el actor es exclusivamente el sujeto verificado del token (`Principal.Subject`), leído de la identidad que el gate ya probó. El precedente en el árbol es `Authorize`, que guarda `token.Subject` en el contexto ([`security.go:79`](../../backend/services/risk/internal/handler/security.go)) y lo expone con `subjectFrom` ([`security.go:39`](../../backend/services/risk/internal/handler/security.go)); el comentario del contexto dice por qué «un sujeto que el cliente puede nombrar no es identidad» ([`security.go:22-26`](../../backend/services/risk/internal/handler/security.go)). Ningún campo del cuerpo, header o query puede fijar el actor, y el contrato no declara uno.
- **Procedencia del disparador.** La evaluación programada (`scheduler`) y la manual (`manual`) quedan distinguidas en el registro persistido. El origen lo decide el seam que ya separa ambos caminos —`Publish` para el pedido explícito y `PublishScheduled` para el ciclo automático ([`publisher.go:164,184`](../../backend/services/risk/internal/service/publisher.go))—, no el string `ActorID` que el ciclo escribe como metadato descriptivo ([`runner.go:184,190-191`](../../backend/services/risk/internal/cycle/runner.go)); el disparador manual es `POST /v1/risk/cycle/run`, admin-only ([`api.go:153`](../../backend/services/risk/internal/handler/api.go)). Una prueba cubre cada caso y los contract tests fijan el contrato.
- **Migración.** `batches` tiene hoy 15 columnas y ninguna de actor ni de procedencia ([`schema-inventory.md:137-162`](../../backend/docs/schema-inventory.md), [`domain-model.md:107`](../../backend/docs/domain-model.md)). La migración nueva de `risk` reclama la **versión 020** del ledger compartido, no la siguiente de su lista propia ([`migration-ledger.md:17,50`](../../backend/docs/migration-ledger.md); [`embed.go:87`](../../backend/services/risk/migrations/embed.go)), se aplica y se reaplica sin error sobre una base aislada, y actualiza `backend/docs/migration-ledger.md`, `backend/docs/schema-inventory.md` y `backend/docs/domain-model.md`. La fila de G2 lo sujeta a la regla de `V1-M-04` ([`v1-produccion.md:102`](v1-produccion.md)).
- **Contrato probado, no solo escrito.** Los contract tests leen el contrato publicado desde disco ([`contract_test.go:23-36`](../../backend/services/risk/internal/handler/contract_test.go)), así que un miembro nuevo en `firewatch-v1.yaml` que la respuesta real no sirva falla la prueba.

## Tasks

**T1 — Migración 020, actor verificado y procedencia del disparador.** `S1`–`S2`. `done` at `a04de59`, no push/PR yet. `PM-06` ([`../plan-produccion/16-producto-mandante.md:46`](../plan-produccion/16-producto-mandante.md)) sigue **abierto**: falta la aceptación humana (`R6`) y, si se decide, la visualización del actor y del disparador en la página, que el criterio no exige.

- **Migración compartida** `backend/services/risk/migrations/020_batch_evaluation_actor.sql`: columnas de actor y de procedencia sobre `batches`, aditivas y compatibles con las filas existentes; registro en `embed.go` con la versión `020` y el reclamo anotado en el ledger.
- **Repositorio y ciclo:** persistir el actor verificado y el origen `manual`/`scheduler` derivado del seam de publicación; ningún valor del request decide la procedencia.
- **Handler:** el actor se lee de la identidad verificada (`Principal.Subject`); el cuerpo no declara ni acepta un actor; un intento de nombrarlo se rechaza.
- **Contrato:** `backend/contracts/openapi/firewatch-v1.yaml` (`BatchCore`, `:3216`) declara el actor y la procedencia en las lecturas de lote, y los contract tests los comparan contra la respuesta real.
- **Pruebas:** unitarias y PostgreSQL para los dos casos —programada y manual—, actor tomado del token, actor no aceptado desde el payload, y migración aplicada y reaplicada.
- **Documentación:** `backend/docs/migration-ledger.md` (reclamo 020 y próxima versión libre), `backend/docs/schema-inventory.md` (columna y conteo de `batches`) y `backend/docs/domain-model.md` (entidad y ERD).
- **Validación:** `cd backend/services/risk && GOWORK=off go test ./...`.
- **Ruta:** escritor backend acotado, con la superficie declarada arriba.
- **Riesgo 1 y 3:** migración SQL nueva sobre `batches` y actualización del contrato OpenAPI. Ambos son recursos compartidos —ledger y contrato—, así que un número o un miembro mal reclamado rompe más de un servicio.

## Log

- **L1 (2026-11-26) — Se abre PM-06 con este registro, antes de la primera escritura de código fuente.** Autorización del responsable, textual: «terminemos con lo que necesite codigo mientras no llego a mi casa aún». Este archivo es solo Markdown: no hay migración, cambio de contrato, código ni suite de `risk` ejecutada; la unidad queda `in_progress` y sin commit. Base `dev` `bfd3c8a` en la rama `feat/pm-06-actor-evaluation`; el runner de la unidad está en el encabezado. Nada se cierra por escribir este documento.
  - **Verificación de este archivo.** `git diff --no-index --check /dev/null odd/tasks/pm-06-actor-evaluation.md` no informó errores de espacios (solo el aviso de Git sobre LF→CRLF); `python -B odd/tools/check_md_links.py --self-test` pasó 22/22. Los enlaces relativos del documento resuelven; el chequeo global informa tres anclas rotas preexistentes en otros documentos `PM-*`, ajenas a este archivo.

- **L2 (2026-11-27) — T1 cerrada en `a04de59`; `PM-06` sigue abierto.** Commit `a04de59ce0f81432ed9d1cd4744bba0f194650c9`, 20 archivos, +1384/−97, sin `push` ni PR. El corte se mantuvo cohesivo a propósito: la migración SQL `020`, los seams Go, el contrato OpenAPI, las pruebas de contrato e integración y los tres documentos de ledger, inventario y ERD entran en un solo commit, porque un contrato nuevo sin su migración o su ledger se leería como aplicado sin estarlo.
  - **Qué quedó persistido.** `batches` gana `evaluation_trigger ∈ {scheduler, manual}` y `evaluated_by`: el sujeto verificado del token en una evaluación manual y `NULL` en una programada. El `CHECK` escribe las dos mitades de la regla en el esquema —una programada no puede declarar actor y una manual no existe sin uno no blanco— y usa la clase POSIX `[[:space:]]`, no solo espacios, para que la base y el escritor Go coincidan en qué actor está en blanco. El ledger queda en `risk` 1–20 y la próxima versión libre es **21**.
  - **Evidencia de la ejecución (parent y worker; no re-ejecutada en esta sesión).** RED → GREEN en los 12 paquetes de `risk`, más las suites de handler y contrato de `gateway` y `prevention`. Comprobaciones en PostgreSQL desechable `postgis/postgis:17-3.5`, hechas por el parent y por el worker: `SHARED_LEDGER=1..20`, reaplicación idempotente, 0 diferencias de catálogo y SQLSTATE `23514` al intentar actores de solo espacios, tabulador o salto de línea. Una verificación independiente `gentle-ai-verify` dio PASS en `S1` y `S2` después de cerrar los hallazgos del límite de cuerpo `cap+1`, el `CHECK` POSIX `[[:space:]]`, el ERD Mermaid y la redacción del `400` en OpenAPI. `-race` no se ejecutó en Windows porque no hay `gcc`/cgo.
  - **Lo que falta para cerrar la fila.** La aceptación humana (`R6`) y, si se decide, mostrar el actor y el disparador en la página; el criterio de `PM-06` no exige interfaz. Nada se empujó, fusionó ni desplegó, y este registro no declara `R6` satisfecho.
