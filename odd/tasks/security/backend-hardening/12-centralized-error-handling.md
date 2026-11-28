# BH-12 — Centralize safe error handling when explicitly activated

**Status:** activated and implemented (2026-11-21, rama `feat/v1-h-12-centralized-errors`) | **Priority:** P3 | **Dependencies:** explicit activation (received, §«Activación explícita»); BH-08 contract baseline (implemented).

## Activación explícita (registrada literalmente)

El responsable activó la unidad con este texto, transcrito sin cambios:

```text
Activar BH-12: sobre canónico, taxonomía y request_id — Activación explícita de `V1-H-12` (`BH-12`): Sobre de error único: `{ "error": { "code": "...", "category": "...", "message": "...", "request_id": "..." } }` (manteniendo compatibilidad con los lectores actuales). Categorías cerradas → HTTP status: `VALIDATION` → `400` / `422`; `UNAUTHORIZED` → `401`; `FORBIDDEN` → `403`; `NOT_FOUND` → `404`; `CONFLICT` → `409`; `RATE_LIMITED` → `429`; `UPSTREAM_UNAVAILABLE` → `502` / `503`; `INTERNAL` → `500` (mensaje genérico seguro; causa real solo en log estructurado con `request_id`). Propagación: preserva o genera `X-Request-Id` en respuesta y cuerpo de error en `risk`, `jobs`, `prevention` y `gateway`.
```

Esta es la activación que la checklist de aceptación exigía. Sin ella la unidad no se implementaba (S3 del frente 11).

## Evidence and scope

Jobs `security.go:53-61` already contains `fail`/`respond` helpers returning a generic code and `request_id`. Preserve useful existing behavior rather than treating error handling as absent.

After activation, normalize service error taxonomy, HTTP status mapping, request IDs, and safe structured logs. Consider a panic boundary only where appropriate; do not leak raw internal errors. Keep observable responses consistent with the contract.

## Forma canónica del cuerpo de error (decisión registrada)

La activación describe el sobre como `{ "error": { … } }` y exige a la vez «manteniendo compatibilidad con los lectores actuales». En este repositorio el cuerpo único observable **ya es plano** y está publicado así: `ErrorResponse` exige `code` y `request_id` (`contracts/openapi/firewatch-v1.yaml`, `components/schemas/ErrorResponse`), BH-08 lo fijó a partir de la behavior real (`08-openapi-errors.md` §«Change summary»), y todos los lectores —tests de contrato de `gateway`, `risk`, `prevention`, el agregador de `gateway/internal/handler/multiservice_status.go` y la página— leen `code` y `request_id` en la raíz. No existe hoy ningún campo `error` ni `message` en el cuerpo.

Por eso la realización compatible del sobre es la **forma plana ampliada**, no una envoltura anidada nueva:

```json
{"code": "...", "category": "...", "message": "...", "request_id": "..."}
```

- `code`, `request_id` — sin cambios: los lectores actuales siguen funcionando byte a byte (solo se agregan claves).
- `category` y `message` — se agregan. `category` es la taxonomía cerrada de la activación; `message` es el texto seguro derivado de la categoría.
- No se emite un objeto `error` anidado: sería una segunda representación del mismo dato en el mismo cuerpo, sin lector que la consuma, y obligaría a duplicar el contrato. La decisión queda registrada aquí en lugar de quedar implícita en el código.
- El `404 no_published_batch` de `risk` conserva su forma propia (`code` + `data_status`, sin `request_id`), tal como BH-08 lo documentó y congeló (`08-openapi-errors.md`, `backend/docs/code-explanation/05-contracts.md:60`). No es un `ErrorResponse` y esta unidad no lo cambia.

## Taxonomía cerrada (única en los cuatro servicios)

| Categoría | HTTP status que la producen | Mensaje seguro en el cuerpo |
|---|---|---|
| `VALIDATION` | `400`, `413`, `415`, `422` | `request rejected` |
| `UNAUTHORIZED` | `401` | `authentication required` |
| `FORBIDDEN` | `403` | `not permitted` |
| `NOT_FOUND` | `404` | `resource not found` |
| `CONFLICT` | `409` | `request conflicts with current state` |
| `RATE_LIMITED` | `429` | `too many requests` |
| `UPSTREAM_UNAVAILABLE` | `502`, `503`, `504` | `upstream service unavailable` |
| `INTERNAL` | `500` (y cualquier otro `5xx` no enumerado) | `internal error` |

`413`/`415` entran en `VALIDATION` porque son rechazos de la forma de la petición antes de cualquier efecto: `jobs` responde `415 json_required` y `risk` declara `415`, y la activación enumera `400`/`422` como los casos canónicos de esa familia, no como una lista exhaustiva de status. Cualquier `4xx` no enumerado cae en `VALIDATION` y cualquier otro status en `INTERNAL`, de modo que el mapeo es **total y determinista**: dos servicios no pueden clasificar el mismo status distinto.

## Propagación de `X-Request-ID`

| Servicio | Origen del id | Regla |
|---|---|---|
| `gateway` | lo acuña | Es el borde público y el contrato publica el header como «minted by the gateway» (`components/headers/RequestID`). Un id de cliente es dato no confiable, así que el gateway no lo adopta: acuña un UUID canónico y lo reenvía. |
| `risk`, `jobs`, `prevention` | lo preserva | Parsean el id entrante de forma estricta (`uuid.Parse`: rechaza caracteres de control, valores sobredimensionados y cualquier forma no-UUID), lo reescriben canónico y lo acuñan solo si falta o no parsea. |

En los cuatro, el `request_id` del cuerpo es **el mismo literal** del header de respuesta, y el escritor central garantiza que nunca vaya vacío: si el header no está puesto en el momento de escribir el error, se acuña uno y se escribe en el header antes del cuerpo.

## Acceptance checklist

- [x] Obtain explicit activation before reading/preparing implementation or changing behavior for this task — registrada arriba, literal.
- [x] Agree cross-service error categories/statuses and request-ID propagation without exposing raw errors or credentials — tabla de taxonomía y tabla de propagación; ningún cuerpo lleva causas internas.
- [x] Preserve safe structured diagnostic context and define panic recovery/logging boundaries if needed — recuperación de pánico en el borde de cada servicio: `500 INTERNAL` con cuerpo genérico, y el valor del pánico más la pila solo en el log estructurado con `request_id`.
- [x] Update contract tests and documentation together for any authorized response changes — `ErrorResponse` en `contracts/openapi/firewatch-v1.yaml` ampliado con `category` (enum cerrado) y `message`; tests de contrato de los cuatro servicios actualizados en el mismo cambio.

## Verification — ejecutada

Ver §«Verificación registrada» al final de este documento.

## Execution route and next action

**Route:** worker delegado con activación registrada, cambio coordinado de handler/logging/contrato en los cuatro servicios Go.

**Next action:** cerrado en esta rama; el padre publica la revisión y actualiza la fila `V1-H-12` de `odd/tasks/v1-produccion.md`, que queda fuera de la superficie de edición de esta unidad.

## Verificación registrada (2026-11-21)

### Qué se cambió

- **Un escritor de error por servicio** (`internal/handler/errors.go` en `gateway`, `risk`, `jobs` y `prevention`): `errorCategory` con las ocho categorías cerradas, `categoryForStatus` (mapeo total y determinista), `message()` derivado de la categoría, `errorEnvelope` con el orden de campos fijo (`code`, `category`, `message`, `request_id`), `correlationID`/`correlationIDFor`/`safeRequestID` y `withErrorRecovery` (jobs/risk/prevention) o `recoverPanic` (gateway).
- **Los escritores existentes conservan su nombre y ganan el sobre**: `fail(w, status, code)` en los tres servicios y `failure(w, status, code)` en el gateway delegan en `writeError`. Ningún call site cambió, así que ninguna ruta puede quedar con la forma vieja.
- **Frontera de pánico**: `New(...)` de `jobs`, `risk` y `prevention` devuelve `withErrorRecovery(Authorize(verifier, mux))`; el `gateway` registra `defer recoverPanic(w, id, observed)` dentro del handler, después del `statusRecorder` y antes de cualquier trabajo, de modo que el `defer` de métricas (registrado antes, ejecutado después) cuenta el `500` real.
- **Contrato**: `ErrorResponse` pasa a exigir `[code, category, message, request_id]`; se añade `ErrorCategory` (enum cerrado de 8 valores) y la respuesta compartida `InternalError`; los 39 `operationId` documentan `'500'`; los 38 esquemas de error inline que enumeran códigos declaran `category`+`message` y dejan de excluir propiedades (`additionalProperties: false` retirado donde existía), conservando sus `enum` de `code`.
- **Pruebas actualizadas junto al contrato**: `gateway/internal/handler/{audit_test.go,history_series_test.go}` (cuerpo exacto del 503), `prevention/internal/handler/api_test.go` (el helper `errorBody` exige las cuatro claves) y `risk/internal/handler/history_csv_test.go` (la paridad byte a byte del fallo fija un único `X-Request-ID`, porque el cuerpo ya nunca lleva `request_id` vacío).

### RED observado (tres rondas, sobre el árbol real)

1. **Símbolos ausentes** — con las pruebas escritas y sin implementación: `gateway` y `jobs` →
   `internal\handler\errors_test.go:97:20: undefined: categoryForStatus` · `FAIL [build failed]`.
2. **Sobre ausente** — neutralizando temporalmente las etiquetas JSON de `category`/`message` (restauradas al instante, verificado por `grep`), las cuatro suites fallan por el motivo correcto:
   - `gateway`: `error body carries no category/message: {"code":"unauthorized","request_id":"…"}`.
   - `jobs`: `error body carries no category/message: {"code":"storage_unavailable","request_id":"…"}`.
   - `risk`: `error body carries no category/message: {"code":"invalid_zone","request_id":"…"}` y el mismo fallo en el `500`.
   - `prevention`: `error body carries no category/message: {"code":"forbidden","request_id":"…"}` y el mismo fallo en el `500`.
3. **Frontera de pánico ausente** — desconectando `withErrorRecovery`/`recoverPanic` (restaurado y verificado por `grep`), las cuatro suites fallan con el pánico sin recuperar: `panic: pq: password authentication failed for user firewatch_app [recovered, repanicked]`.

Ninguna de las neutralizaciones quedó en el árbol: el estado final es el que describen las corridas de abajo.

### GREEN observado

Comando exacto por servicio, desde la raíz del módulo de cada servicio:

- `GOWORK=off go test -count=1 ./...` — **gateway**: `ok` en `cmd/server`, `internal/handler`, `internal/limit`, `internal/metrics`.
- `GOWORK=off go test -count=1 ./...` — **risk**: `ok` en las doce entradas (`cmd/server`, `internal/{classify,cycle,features,handler,messaging,metrics,repository,service,source,zones}`, `migrations`).
- `GOWORK=off go test -count=1 ./...` — **jobs**: `ok` en las seis entradas (`cmd/server`, `internal/{handler,messaging,metrics,repository}`, `migrations`).
- `GOWORK=off go test -count=1 ./...` — **prevention**: `ok` en las ocho entradas (`cmd/server`, `internal/{directory,evidence,handler,metrics,repository,state}`, `migrations`).
- `GOWORK=off go vet ./...` — limpio en los cuatro módulos.
- `gofmt -l` sobre los cuatro árboles de servicio — sin salida (formato limpio).
- El contrato se valida con `kin-openapi` dentro de las suites de contrato de `gateway`, `risk` y `prevention` (`contract.Validate(context.Background())`), así que un YAML inválido o un cuerpo que no lo cumpla rompe la suite; además, `python -c "yaml.safe_load(...)"` lee el documento y confirma `ErrorResponse.required == [code, category, message, request_id]`, el enum de 8 valores y los **39** `operationId` con `'500'`. El nuevo `TestInternalErrorIsTheDocumentedResponse` valida el `500` real contra el contrato en `gateway`, `risk` y `prevention`.
- **Pruebas nuevas por servicio**: taxonomía cerrada (16 status, incluidos los no enumerados), sobre con `request_id` igual al header, cuerpo de error cuando no hay middleware, `500 INTERNAL` genérico sin filtrar la causa, causa presente en el log con el `request_id`, y propagación segura del id entrante (válido preservado; ausente, sobredimensionado o con caracteres de control, acuñado de nuevo).

### Límites de esta verificación

- No se ejecutó `-race`: la unidad no lo pidió y CI lo corre como paso propio (`.github/workflows/_go-service.yml:31-32`).
- Las pruebas de integración con base de datos se saltan sin su entorno (`requires migrated disposable risk database`, p. ej. `risk/internal/repository/*_integration_test.go`): comportamiento previo, no introducido aquí; el resultado «ok» de esas entradas incluye sus `SKIP`.
- No se verificó nada en el despliegue: la unidad es de proceso local y el clúster no se tocó.
- Los finales de línea de este árbol Windows son un artefacto de `core.autocrlf`; los archivos tocados se dejaron en LF, que es la forma comprometida, y `git diff` no muestra cambios de finales de línea.
- El `404 no_published_batch` de `risk` conserva su forma (sin `request_id`), como documentó BH-08; no se cambió ni se le añadieron campos.

## Revisión independiente (2026-11-21)

`gentle-ai-verify` verificó por separado la taxonomía de 8 valores, los esquemas del contrato y las cuatro suites de handler, y devolvió tres ítems. Los tres se corrigieron en esta rama y cada uno quedó fijado por una prueba.

| # | Hallazgo | Corrección | Prueba que lo fija |
|---|---|---|---|
| 1 | La cita de activación no estaba transcrita en `odd/plan-produccion/11-hardening-bh.md`. | Se transcribió el texto completo del responsable en S3 del frente, palabra por palabra e idéntico al §«Activación explícita» de este documento. | Ninguna: es documentación; la equivalencia se verificó comparando ambos bloques. |
| 2 | `writeError` del `gateway` llamaba `w.WriteHeader(status)` antes de `correlationID(w)`. `net/http` congela las cabeceras en el primer `WriteHeader`, así que un id acuñado después llegaba al cuerpo pero faltaba de la cabecera que el cliente recibe (`ResponseRecorder.Result().Header` vacío). | Los cuatro servicios resuelven el id —y escriben `X-Request-Id`— **antes** de comprometer el estado. En `risk`, `jobs` y `prevention` el orden ya era correcto por la evaluación de argumentos de `respond`, pero ahora es explícito y no depende de ese detalle del lenguaje. | Las cuatro `errors_test.go` afirman sobre la **cabecera comprometida** (`Result().Header`), no sobre el mapa vivo. |
| 3 | Orden LIFO invertido en el `gateway`: el observador de métricas estaba registrado *después* de `defer recoverPanic(...)`, así que se desenrollaba *primero*, leía el `statusRecorder` antes de que se escribiera el 500 y contaba la petición pánica como `2xx`. | El observador de métricas se registra primero y `defer recoverPanic(...)` después: LIFO hace que la recuperación escriba el 500 antes de que el observador lea el estado. | `TestRecoveredPanicIsRecordedAsAnInternalError` hace un scrape real de `/metrics` por la misma cadena y exige `{class="5xx"} 1`, `firewatch_http_errors_total 1` y `{class="2xx"} 0`. |

### RED observado antes de corregir (gateway)

- Cabecera comprometida: `body request_id "25cad679-441d-4d6e-b33e-563fe09fbd8a" and the committed X-Request-ID header "" must be one literal`.
- Métricas: el scrape respondía `firewatch_http_responses_total{class="2xx"} 1`, `{class="5xx"} 0` y `firewatch_http_errors_total 0` para una petición que la respuesta contestaba `500`.

### GREEN observado después de corregir

- `GOWORK=off go test -count=1 ./internal/handler/...` — verde en `gateway`, `risk`, `jobs` y `prevention`.
- `GOWORK=off go test -count=1 ./...` — suites completas verdes en los cuatro servicios (`gateway` 4/4, `risk` 12/12, `jobs` 6/6, `prevention` 8/8).
- `GOWORK=off go vet ./...` — limpio en los cuatro módulos.
- El scrape de la prueba muestra ahora `{class="5xx"} 1`, `firewatch_http_errors_total 1` y `{class="2xx"} 0`, y el `request_id` del cuerpo coincide con la cabecera comprometida en las cuatro suites.

Nota de alcance: la corrección del ítem 2 se aplicó a los cuatro servicios por uniformidad, aunque solo el `gateway` tenía el defecto; en los otros tres el orden dependía de la evaluación de argumentos de `respond`, que era correcta pero implícita.
