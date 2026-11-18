# Frente 4 — Propagación de fallos terminales y replay de DLQ

- **Grupo de entrega:** G3 — Robustez de backend.
- **Estado:** **Implementado y verificado (2026-10-16).** S1–S6 entregados: estado terminal `failed` con `failure_reason`/`attempts`/`failed_at`, reporte del fallo cruzado por el outbox de `risk` (`risk.job.failed.v1`), replay de operador admin-only, replay de un job `queued` con confirmación explícita y completion re-emitido para el lote ya almacenado. **Falta:** el escenario end-to-end del documento de la unidad (interrumpir PostgreSQL, agotar reintentos, restaurar y reiniciar consumidores) y `-race` en este host; el resto corre en CI. Detalle en [`../tasks/security/backend-hardening/07-job-recovery.md`](../tasks/security/backend-hardening/07-job-recovery.md).
- **Riesgo (Task Size):** alto al implementar — ítem 4 (orden/duplicados en el consumo), ítem 1 (estado persistido del job) e ítem 3 (el replay `queued` cambia el contrato publicado: cuerpo, `409` y descripción).
- **Depende de:** BH-01 (toolchain/baseline); política de recuperación acordada; coordinar con BH-10 (idempotencia concurrente).
- **Seam / superficie:** consumidor (`broker.go`), persistencia/ACK, broker DLQ y estado terminal del job.

**Objetivo.** Hacer observables los fallos terminales y permitir recuperación/replay **idempotente** de trabajos fallidos sin duplicar efectos.

**Documentación real (redirección).**
- [`../../backend/docs/architecture.md:42-46`](../../backend/docs/architecture.md) — la DLQ conserva fallos; el estado terminal `failed` y el replay de operador están implementados (ver *Estado* arriba); falta el replay automático de los mensajes que ningún job puede reclamar.
- [`../../backend/README.md:96-98`](../../backend/README.md) — estado operativo.
- [`../tasks/security/backend-hardening/07-job-recovery.md:7-20`](../tasks/security/backend-hardening/07-job-recovery.md) — criterios de aceptación.

## Estado operativo y umbrales de readiness (H19)

Los dos consumidores de este frente —`jobs` y `risk`— publican estado por dos vías distintas, y confundirlas convierte un broker degradado en un pod que no recibe tráfico.

| Qué | `jobs` | `risk` |
| --- | --- | --- |
| Ruta autenticada, admin-only en `jobs`, con la decisión **completa** (base, broker y profundidad de DLQ) | `GET /v1/jobs/status` (`backend/services/jobs/internal/handler/api.go:86`; `backend/contracts/openapi/firewatch-v1.yaml:29-46`) | `GET /v1/risk/status` (`backend/services/risk/internal/handler/api.go:58`; `firewatch-v1.yaml:11-22`) |
| Sonda `/health/ready` sin autenticar, decidida **solo** por el ping a la base | `backend/services/jobs/cmd/server/main.go:281-290` | `backend/services/risk/cmd/server/main.go:553-566` |
| Umbrales al arranque: `DLQ_READY_MAX_DEPTH` (default `0`) y `DLQ_READY_MAX_AGE` (default `6s`) | `main.go:207-232` | `main.go:417-442` |
| Evaluación compartida: profundidad > máximo → `dead_letter_backlog`; profundidad desconocida → `dead_letter_depth_unknown` | `backend/services/jobs/internal/messaging/broker.go:80-93` | `backend/services/risk/internal/messaging/broker.go:75-88` |

Como la sonda decide por la base sola, un DLQ con un mensaje o un broker caído **no** cambia el código de `200`/`503` del probe: se ve en el cuerpo (`dependencies.broker`, `dead_letter.state`) y en `/metrics`, que es lo que `backend/docs/code-explanation/07-deployment.md:44` afirma al decir que los dos umbrales «no cambian el código de readiness». Un valor mal formado no cae a un default silencioso: es error de arranque (`main.go:216-232`; `risk/cmd/server/main.go:427-442`). **Es lectura de código y contrato**: no se llamó ninguna de las dos rutas ni se provocó un DLQ en esta pasada.

## Specs

- **S1** — **Acordado (2026-10-16).** Transitorio = error que no implementa `Permanent() bool`; presupuesto de **5 intentos** con backoff `{1,2,4,8}` s en línea, sin cambios respecto del `retryBackoff` vigente. Permanente = implementa `Permanent() bool` y salta todo reintento. Estado terminal visible: el job pasa a **`failed`**, con `failure_reason` y `attempts` persistidos, expuesto en `GET /v1/jobs/{id}`.
- **S2** — **Acordado.** `failed` se asigna **solo con evidencia real**: (i) el consumidor de `jobs` falla de forma permanente sobre su propia fila, o (ii) existe una entrega en la DLQ ligada a ese `job_id`. **Nunca por vencimiento de plazo** — un job sin respuesta se queda `queued`, con métrica de edad de cola y alerta. El replay es una acción **explícita de operador autenticado**, idempotente por `job_id` sobre el `inbox` único existente.
- **S3** — Se cubren reinicios y entregas duplicadas o reordenadas en los límites de persistencia/ACK.
- **S4** — Hay alertas y *runbook* para reintentos agotados, DLQ y trabajos atascados.
- **S5** — **Acordado (2026-10-16, cierre de la sesión A).** El replay de operador se extiende a un job **`queued`** con *guard* explícito: la petición debe llevar `{"confirm":"queued_may_be_in_flight"}` porque un job encolado puede seguir en vuelo. Sin confirmación el replay responde `409 replay_confirmation_required` y **no escribe nada**; un job `published` sigue respondiendo `409 job_not_replayable`; un cuerpo malformado responde `400 invalid_replay_request` antes de llegar al almacén. La transición sigue siendo **una única escritura guardada** con la fila, la auditoría y el evento de salida en la misma transacción. `attempts` vuelve a 0 y **`requested_at` no se reescribe**: el instante observado no se inventa, así que un job viejo re-despachado produce un lote ya vencido (`stale`) a propósito.
- **S6** — Una solicitud re-despachada cuyo lote **ya existe** se responde con el *completion* de ese lote: `risk` re-emite `risk.batch.published.v1` para el `batch_id` persistido en lugar de omitirlo, para que el replay también repare el caso «el lote se persistió pero el resultado se perdió». Nunca crea un segundo lote, y una reentrega con el **mismo** `id` de evento sigue siendo un no-op (la compuerta de deduplicación sigue siendo el `inbox`).

## Tasks

| ID | Spec | Ruta | Descripción | Commit |
| --- | --- | --- | --- | --- |
| T1 | S1 | inline | Acordar y documentar la política de reintentos/backoff/estado terminal. | Hecho — política en S1/S2 (`29811ef`) |
| T2 | S2 | inline | Implementar replay idempotente de la DLQ y reconciliación. | Hecho: estado terminal en la fila (migración 004), reporte de fallo `risk`→`jobs` (`risk.job.failed.v1` vía outbox) y replay de operador `POST /v1/jobs/{id}/replay`. |
| T3 | S3 | inline | Probar reinicios y entregas duplicadas/reordenadas. | **Parcial**: cubierto a nivel unitario (escrituras guardadas en ambos consumidores). La prueba con DB y broker sigue pendiente — Docker caído |
| T4 | S4 | inline | Alertas y runbook para reintentos agotados, DLQ y trabajos atascados. | Hecho: regla `FireWatchStuckJobs` + acción de la regla de DLQ + runbook en `backend/docs/operations.md` |
| T5 | S5 | inline | Extender el replay a `queued` con confirmación explícita, vocabulario de error y contrato. | Hecho: `90f48a6` — `jobs/internal/{handler,repository}`, contrato OpenAPI y runbook |
| T6 | S6 | inline | Re-emitir el completion del lote existente en la rama de conflicto de `risk`. | Hecho: `90f48a6` — `risk/internal/repository` y sus pruebas de integración |

Ruta por defecto: **inline**. Delegar escritura solo por disparador.

## Dependencias y bloqueos humanos

- **Bloqueo humano:** acordar estados observables y política de recuperación **antes** de implementar.
- Depende de BH-01; coordinar con BH-10.

## Criterios de cierre

- `../tasks/security/backend-hardening/07-job-recovery.md:11-20`.

## Log

- **L1 (2026-10-16)** — Creación del desglose por spec a partir de [`README.md`](README.md) §1 (frente 4). Documento de planificación; sin implementación.
- **L2 (2026-10-16)** — Política de recuperación acordada en la sesión grill y escrita en S1/S2. Queda desbloqueada la implementación (T2–T4). La verificación end-to-end del criterio de cierre sigue **diferida**: exige PostgreSQL y broker, y el daemon de Docker no está disponible.
- **L3 (2026-10-16)** — Cierre de la sesión A: el hueco declarado (un job `queued` sin camino de replay) se resuelve por decisión humana **extendiendo el replay**, con el *guard* explícito de S5 y el re-emisión de completion de S6. La primera mitad es un cambio de contrato publicado (ítem 3) y la segunda, una regla nueva en la compuerta de conflicto de `risk`: ambas con pruebas propias, y las que exigen PostgreSQL quedan cubiertas por los perfiles `test` de CI (`jobs-test`, `risk-test`).
- **L4 (2026-10-16)** — Implementado y verificado en `90f48a6`: suites de `jobs` (5 paquetes) y `risk` (10) verdes, `gofmt`/`go vet` limpios, contrato valida con el validador de CI, y las pruebas de replay y de paridad de contrato pasan. El RED de la regla se observó en el límite del transporte (`503 storage_unavailable` donde debía ser `409 replay_confirmation_required`, y `202` donde debía ser `400 invalid_replay_request`); la regla de S6 no tiene RED ejecutable aquí porque su única superficie es la rama SQL, que exige PostgreSQL y **salta** sin `TEST_DATABASE_URL` — CI la ejecuta de verdad. **Límite de rebanada para la revisión:** esta rebanada es la unidad `BH-07 u4` (confianza de replay + compuerta de `risk`) y se revisa junto con el historial del frente 4; el detalle de las rebanadas de la rama vive en [`README.md`](README.md) §9.5.
- **L5 (2026-10-16, post-publicación)** — El PR #29 quedó con CI verde, y el job `compose` confirmó lo que no se podía ejecutar aquí: las pruebas de integración con PostgreSQL **corrieron y pasaron** (la imagen de pruebas recibe `TEST_DATABASE_URL` y su `ENTRYPOINT` no usa `-short`, así que no pueden saltar). Queda como único faltante del frente el escenario end-to-end de la verificación y `-race` local; **ninguna decisión humana sigue abierta en este frente**.
- **L6 (2026-11-18) — Estado operativo y umbrales de los dos consumidores (H19 de la auditoría de producción).** El documento describía el estado terminal del job y el replay, y no nombraba la ruta ni los umbrales con los que se observa el consumidor. `GET /v1/jobs/status` existe y es admin-only con la decisión completa (base, broker y DLQ) (`backend/services/jobs/internal/handler/api.go:86`; `backend/contracts/openapi/firewatch-v1.yaml:29-46`), con su gemela en `risk` (`backend/services/risk/internal/handler/api.go:58`; `firewatch-v1.yaml:11-22`); la sonda `/health/ready` de ambos decide **solo** por la base (`jobs/cmd/server/main.go:281-290`; `risk/cmd/server/main.go:553-566`), y los umbrales `DLQ_READY_MAX_DEPTH=0` y `DLQ_READY_MAX_AGE=6s` se leen al arranque en los dos servicios (`jobs/cmd/server/main.go:207-232`; `risk/cmd/server/main.go:417-442`) y no mueven el código del probe, que es lo que `backend/docs/code-explanation/07-deployment.md:44` ya decía. Se añadió la tabla con los dos lados por fila. Es lectura de código y contrato: no se llamó ninguna ruta, no se provocó un DLQ y no se ejecutó ningún consumidor.
