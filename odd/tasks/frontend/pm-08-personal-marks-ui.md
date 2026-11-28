# PM-08 — Marcas personales de lectura y revisión en el centro de notificaciones

Objetivo: que cada alerta del centro de notificaciones muestre y actualice la marca personal de quien consulta —`unread`, `read` o `dismissed`— leída y escrita contra `GET` y `PUT /v1/risk/alerts/{id}/state`, con retroalimentación accesible inline y sin persistencia en el cliente.

Rama `feat/pm-08-personal-marks-ui` desde `feat/firewatch-design-migration` `9226d87`; runner `cd frontend && npm test`.

---

## Specs

### S1 — El usuario autoriza empezar por PM-08

> «ataquemos primero lo que marcaste como 1 porfa, luego vemos el resto»

La marca «1» de la lista que el usuario numeró es **PM-08**, y esta autorización cubre solo esa fila: la ejecuta primero y deja «el resto» para después. Este documento no adelanta ninguna otra fila `PM-*`, no cierra `PM-07` —que ya está fusionado y es la dependencia— y no cambia el criterio de cierre de [`../../plan-produccion/16-producto-mandante.md`](../../plan-produccion/16-producto-mandante.md), que sigue siendo el punto de referencia de `PM-08`.

### S2 — Alcance y contrato congelado

Criterio de cierre de `PM-08`, citado verbatim de [`../../plan-produccion/16-producto-mandante.md:48`](../../plan-produccion/16-producto-mandante.md) (la celda incluye enlaces relativos a su propia ubicación, por eso se transcribe sin reinterpretar):

```text
| PM-08 | Centro de notificaciones (ítem 18). | R1, R6 | La página lista las alertas de PM-07 con su cambio de riesgo y su fecha, ordenadas y paginadas; sin alertas que mostrar el estado vacío lo dice; depende de PM-07 y no lo simula. Estado en `268c893`: **centro fusionado, aceptación pendiente** —[`NotificationsView.tsx:14`](../../frontend/src/views/NotificationsView.tsx) lista las alertas con su cambio y fecha sobre `/v1/risk/alerts`; las marcas personales son alcance local aprobado (`6a86ee2`), no fusión. | worker |
```

El contrato que rige la implementación es el de [`../../../backend/contracts/openapi/firewatch-v1.yaml`](../../../backend/contracts/openapi/firewatch-v1.yaml), líneas 934-1090 y los esquemas `Alert`, `AlertCollection`, `AlertState` y `AlertStateMarkRequest`. Se transcribe lo que la implementación **no** puede reinterpretar:

**`GET /v1/risk/alerts`** — `operationId: listRiskAlerts`. Viewer/admin. Una página de las alertas persistidas de PM-07, orden estable `(occurred_at, id)` en la dirección elegida; una línea de tiempo vacía es `200` con arreglo vacío y `next_cursor` nulo, nunca `404`.

- `limit`: entero `int32`, mínimo `1`, máximo `100`, por defecto `50`; fuera de `1..100`, no entero, vacío o repetido se rechaza `400 invalid_alert_query` antes de leer nada.
- `order`: enum exacto `[desc, asc]`, por defecto `desc`; cualquier otra grafía, incluida una en mayúsculas, se rechaza `400`.
- `cursor`: opaco, copiado verbatim desde `next_cursor` de la respuesta anterior; sin cursor se lee la primera página; un valor vacío, indescifrable, de forma errada o codificado para la otra dirección se rechaza `400 invalid_alert_query` en vez de leerse como primera página.
- Respuestas: `200` `AlertCollection`; `400` con cuerpo de solo `code: invalid_alert_query` y `request_id`, y `Cache-Control: no-store`; `401`; `403`; `429`; `502`; `503`.

**`GET /v1/risk/alerts/{id}/state`** — `operationId: getRiskAlertState`. Viewer/admin. La marca personal explícita de quien consulta sobre una alerta almacenada. El parámetro de ruta `id` es `string`/`uuid` y **solo la grafía canónica en minúsculas con guiones** direcciona una fila; cualquier otra es `404 alert_not_found`, decidido antes de consultar el almacenamiento. Una alerta que el sujeto nunca marcó es `unread` con `marked_at: null`, y leerla no crea fila. Una alerta no almacenada es `404`, nunca una respuesta `unread` fabricada. Respuestas: `200` `AlertState`; `401`; `403`; `404` `alert_not_found`; `429`; `502`; `503`.

**`PUT /v1/risk/alerts/{id}/state`** — `operationId: markRiskAlertState`. **Admin only, para el propio llamante.** Añade una marca personal explícita a una alerta almacenada.

- Cuerpo: `AlertStateMarkRequest`, obligatorio, `application/json`, exactamente un documento JSON con exactamente un miembro, `state`, cuyo valor es `read` o `dismissed`. Un cuerpo vacío, un miembro ausente o desconocido —incluido un intento de nombrar un actor—, un segundo documento, un cuerpo de más de 512 bytes o cualquier otro valor se rechaza `400 invalid_alert_state` antes del almacenamiento.
- Vocabulario cerrado: `state` es enum `[read, dismissed]`; `unread` **no es una marca y se rechaza**.
- Marcas monótonas: `read` y después `dismissed`, y `dismissed` domina a `read` sin importar el orden en que llegaron las peticiones. La escritura es idempotente: repetir la marca efectiva, o enviar `read` después de una desestimación, no añade nada y responde el estado realmente almacenado con su instante original, así que `200` cubre «aplicada» y «ya estaba» y `409` **no** se usa a propósito.
- Respuestas: `200` `AlertState`; `400` `invalid_alert_state`; `401`; `403`; `404` `alert_not_found`; `415` `json_required` cuando la petición no declara cuerpo `application/json` y no se escribe nada; `429`; `502`; `503`.

**Aislamiento por actor.** El actor es exclusivamente el sujeto verificado del token bearer: la ruta no acepta parámetro de actor y el cuerpo de escritura no puede nombrar uno; un miembro desconocido se rechaza, no se ignora. Un viewer y un admin leen, y **cada uno lee solo su propia marca**. No se registra entrega, acuse ni transporte: la fila añadida es la traza, y la ruta no es un transporte de notificaciones.

**Esquemas, campo por campo** (todos `additionalProperties: false`):

- `Alert`: `required: [id, zone_id, zone_name, previous_level, new_level, threshold, occurred_at, demo]`; `id` uuid; `zone_id` string sin enum —el conjunto aceptado es el del catálogo—; `zone_name` string **nullable**, nulo cuando el catálogo ya no nombra la zona y el rótulo no se inventa; `previous_level` y `new_level` son `AlertLevel`, enum `[bajo, medio, alto]`, con `desconocido` deliberadamente ausente; `threshold` entero con mínimo `1`, el umbral acordado guardado con la fila; `occurred_at` `date-time`; `demo` boolean leído del lote de origen.
- `AlertCollection`: `required: [items, next_cursor]`; `items` es arreglo de `Alert`, nunca nulo; `next_cursor` string nullable, opaco, ligado a la dirección que codifica, así que cambiar el orden reinicia el historial de cursores.
- `AlertState`: `required: [alert_id, state, marked_at]`; `alert_id` uuid; `state` enum `[unread, read, dismissed]`; `marked_at` `date-time` nullable, nulo exactamente cuando `state` es `unread`, canonizado a UTC y nunca reescrito.
- `AlertStateMarkRequest`: `required: [state]`; `state` enum `[read, dismissed]`; **sin miembro de actor**, y los miembros desconocidos se rechazan.

**Contrato que se preserva intacto.** `ExecutivePanel.tsx` muestra `active_alerts.count`, y ese miembro conserva verbatim su semántica de [`../../../backend/contracts/openapi/firewatch-v1.yaml:914-918`](../../../backend/contracts/openapi/firewatch-v1.yaml):

```text
active_alerts:
  description: >-
    Rows stored in risk_alerts, unfiltered. Not an unread or
    undismissed count: no read or dismissed state exists yet, so
    the member reports only how many alerts were recorded.
```

Es decir: `count` son las filas almacenadas en `risk_alerts`, **sin filtrar**, y nunca un conteo de no leídas ni de no desestimadas. La marca personal que agrega `PM-08` no se resta ni se suma a ese número, y la vista ejecutiva no se toca.

### S3 — Contrato de interfaz y de preservación

`NotificationsView` (`frontend/src/views/NotificationsView.tsx`) y su transporte (`frontend/src/core/notifications.ts`) pasan a cumplir, en este orden:

1. **Mostrar la marca que devuelve la API.** Cada fila de la tabla muestra el estado personal vigente de esa alerta —`unread`, `read` o `dismissed`— y `marked_at` cuando existe, leídos de `GET /v1/risk/alerts/{id}/state`. El valor mostrado sale de la respuesta; nunca se deduce de la fila, del orden, de otra sesión ni de una suposición local. Un `marked_at` nulo solo se pinta cuando el estado es `unread`.
2. **Actualizar por la ruta congelada.** El usuario autenticado actualiza o alterna su marca con `PUT /v1/risk/alerts/{id}/state` y un cuerpo con exactamente el miembro `state`, valor `read` o `dismissed`. `unread` no se envía nunca, porque es ausencia de marca y el contrato la rechaza. Ninguna marca se pierde ni se inventa localmente: si el servidor responde la marca dominante —replay idempotente, o `read` después de `dismissed`—, la interfaz pinta la que el servidor devolvió, no la que se pidió. Como el contrato declara la escritura **admin only**, un `403` de un viewer se comunica inline como permiso denegado y nunca se dibuja como si la marca se hubiera aplicado; la vista no adelanta la autorización con una conjetura de rol.
3. **Retroalimentación inline y accesible.** El estado de carga y el error son texto en la región viva que la vista ya usa —`#notifications-status` con `role="status"` y `aria-live="polite"`— o en una región viva equivalente acotada a la fila, con el botón de la fila deshabilitado y `aria-busy` mientras la escritura está en vuelo y el foco devuelto al control que la disparó. Nada de diálogos bloqueantes, de un estado de carga global que oculte las demás filas, ni de un error que reemplace la tabla. El mensaje de error conserva el `code` y el `request_id` que el contrato devuelve, como ya hace el resto de la vista.
4. **Diseño aéreo nocturno, sin paleta nueva.** El estado personal y su retroalimentación se estilan con los tokens ya declarados en `frontend/src/styles/tokens.css` —`--paper`, `--line`, `--ink`, `--muted`, `--accent`, `--focus` y los tokens de nivel `--level-*`— y con las clases de `frontend/src/styles/decision-workspace.css`, sin valores de color literales y sin contraste por debajo de lo que ya fija el sistema de diseño. Se preservan los identificadores que las pruebas fijan (`#notifications`, `#notifications-table`, `#notifications-status`, `#notifications-prev`, `#notifications-next`, `#notifications-page`).
5. **Filtro o rótulo personal opcional, sin persistencia de cliente.** Se permite filtrar o rotular por estado personal solo sobre la página ya devuelta, declarando que el alcance es esa página y nunca el registro completo —el contrato no ofrece un parámetro de filtro por marca y la ruta de alertas no sirve conteos—. **`localStorage` y `sessionStorage` quedan prohibidos**, igual que cualquier otra forma de persistencia en el cliente: la marca vive en el servidor y se relee, no se cachea. El historial de cursores sigue siendo estado de vista, como hoy.
6. **Preservar el contrato de `active_alerts.count` verbatim.** `frontend/src/components/executive/ExecutivePanel.tsx:228-229` y su lectura en `frontend/src/core/api.ts:856,916-917` no cambian: el panel ejecutivo sigue mostrando el conteo sin filtrar de `firewatch-v1.yaml:914-918`, y la marca personal no lo altera, no lo filtra y no lo reemplaza por un conteo de no leídas.
7. **La copia de solo lectura deja de ser cierta.** El subtítulo y los chips actuales de la vista afirman «Esta página solo las lee: no las crea, no las marca y no las envía» y «SOLO LECTURA · SIN ENVÍO DE AVISOS». Con la marca personal habilitada, la parte «no las marca» y el chip «SOLO LECTURA» se corrigen: la página sigue sin crear alertas y sin enviar avisos, pero sí registra la marca personal del usuario. La copia nueva conserva en español neutro que la marca es del sujeto autenticado y que no es una entrega ni un aviso.
8. **Sin regresión de lo ya probado.** `frontend/tests/views/notifications.test.tsx` se extiende con la marca —lectura, actualización, replay idempotente, `403`, `404`, `400`, error de red y estado de carga—, y `frontend/tests/views/executive.test.tsx` debe seguir en verde sin cambios de su contrato. La suite se ejecuta con `cd frontend && npm test`.

## Tasks

| ID | Tarea | S# | Ruta | Estado | Commit |
| --- | --- | --- | --- | --- | --- |
| T1 | Mostrar y actualizar la marca personal de cada alerta del centro de notificaciones contra `GET` y `PUT /v1/risk/alerts/{id}/state`, con retroalimentación accesible inline en los tokens del diseño aéreo nocturno y sin persistencia de cliente, preservando `active_alerts.count` sin filtrar. | S1, S2, S3 | worker | done | 0839583 |

## Log

**L1** (usuario, verbatim):

> «ataquemos primero lo que marcaste como 1 porfa, luego vemos el resto»

Registrado como S1: la autorización nombra la fila 1 de la lista marcada, que es `PM-08`, y deja «el resto» para después. Esta entrada registra un paso **solo de Markdown**, anterior a la primera escritura de código: no cambia comportamiento ejecutable, así que la exención de evidencia RED/GREEN aplica aquí y la primera escritura de fuente es la que debe llevarla. Archivos tocados hasta este punto: únicamente este documento.

**L2** (worker, T1 · S1–S3). Contrato verificado antes de escribir: `GET /v1/risk/alerts` **no** embebe la marca personal; `GET /v1/risk/alerts/{id}/state` (viewer/admin) y `PUT /v1/risk/alerts/{id}/state` (**solo admin, para el propio llamante**) son rutas por alerta. `AlertState` = `{alert_id, state: unread|read|dismissed, marked_at}` con `marked_at` nulo exactamente cuando `state` es `unread`; `AlertStateMarkRequest` = `{"state": read|dismissed}`, sin miembro de actor; `unread` se rechaza como escritura. Estados de respuesta cubiertos en el cliente: `200/400/401/403/404/415/429/502/503`.

Evidencia observada (focused = `npx vitest run tests/core/notifications-state.test.ts tests/views/notifications.test.tsx`):

- **RED**: 23 fallos / 12 pasados (35), exit 1 — el módulo aún no exportaba el seam ni la vista mostraba marca.
- **GREEN**: 35 pasados (2 archivos), exit 0.
- **TRIANGULATE**: payloads malformados y enum desconocido rechazados enteros; `alert_id` distinto al pedido rechazado; `unread` nunca enviado (0 peticiones); replay/dominancia (`read` pedido, `dismissed` servido) pintado como el servidor respondió; `403`, `404`, `400`, `415`, `503`, error de red y `401` con `code`/`request_id`; filtro acotado a la página; cero escrituras en `localStorage`/`sessionStorage`.
- **PRESERVE**: `npm test` → **885 pasados (63 archivos), exit 0**; `npm run typecheck` exit 0; `npm run lint` exit 0. Chequeo diferencial: `tests/views/executive.test.tsx` + `tests/a11y` + `tests/styles` → 64 pasados (10 archivos), exit 0, y `git diff --quiet` confirma `ExecutivePanel.tsx` y `core/api.ts` **sin cambios** (`active_alerts.count` sigue sin filtrar). Dos corridas previas de la suite completa tuvieron 2 timeouts de 5 s en `source-gate.test.ts` y `actions-evidence.test.tsx`, ambos ajenos a esta tarea y verdes en aislamiento.

Archivos: `frontend/src/config.ts` (ruta `riskAlertStateRoute`), `frontend/src/core/notifications.ts` (lectura/escritura + validación estricta), `frontend/src/views/NotificationsView.tsx` (columna «Marca personal», PUT por fila, regiones vivas por fila, filtro de página y copia corregida), `frontend/src/styles/notifications.css` (tokens existentes medidos: 7.76:1 / 8.81:1 / 9.11:1 / 9.41:1, borde 4.08:1), `frontend/tests/core/notifications-state.test.ts` (nuevo), `frontend/tests/views/notifications.test.tsx` (extendido). Sin commit, sin push: el commit queda `pending` para el orquestador.

**L3** (worker, corrección tras verificación independiente · S2/S3). El verificador `gentle-ai-verify` devolvió S1 PASS · S2 FAIL · S3 FAIL con seis hallazgos concretos; los seis se corrigieron con RED primero.

- **S2-1 · `200` exacto.** `askState` acepta únicamente `response.status === 200`. `201`, `202`, `204` y cualquier otro `2xx` se rechazan como `malformed · unexpected_status` en lugar de leerse con `response.ok`.
- **S2-2 · UUID canónico e instante RFC 3339 completo.** `isRiskAlertState` exige `alert_id` con forma `format: uuid` **y** igual al `id` pedido (una respuesta con id que coincide pero no es uuid se rechaza), y `marked_at` debe ser un instante completo: fecha, `T`, hora y `Z` u offset explícito, con calendario validado hacia atrás (se rechazan `2026-11-27`, `2026-02-30T10:00:00Z`, `2026-11-20T25:00:00Z`, `+25:00`). Los fixtures de prueba pasaron a uuids canónicos mediante alias, sin cambiar el contrato.
- **S2-3 · Copia honesta de `429`/`503`.** Esas dos respuestas dicen que la marca **no se registró** («La API limitó las solicitudes y no atendió el registro…», «El servicio no pudo almacenar la marca… el estado guardado no cambió»). La incertidumbre («pudo haberse guardado») queda solo para `502`, red y plazo, donde la completitud es genuinamente desconocida.
- **S3-4 · Anuncio persistente y foco al retirar una fila filtrada.** La confirmación vive en una región `#notifications-mark-status` con `role="status"` + `aria-live="polite"` montada siempre (el texto de fila ya no es región viva, así que se anuncia una sola vez). Si la marca exitosa deja de coincidir con el filtro activo, el foco pasa a la fila siguiente, o a la anterior si era la última, o al encabezado de la tarjeta de filtro vacío (`#notifications-filter-empty-title`), o a la región de estado; nunca queda en `document.body`.
- **S3-5 · `PUT` tardío entre páginas.** Todas las mezclas del `PUT` (`pending`, `feedback`, anuncio y `settledMarks`) están acotadas al `pageKey` que inició la escritura: un `PUT` de la página A que responde estando en B no sobrescribe las marcas de B ni la deja en «Consultando marca…», y su solicitud de foco se descarta.
- **S3-6 · Sobre `401` parseado.** `askState` lee el cuerpo del `401` igual que el resto de errores (`code` + `request_id`, con el `request_id` del cuerpo cuando no hay cabecera `X-Request-ID`), sigue llamando a `resetSession('rejected')` y el mensaje se conserva en `NotificationsView` (que no se remonta) para renderizarse inline en la región persistente aun cuando el registro se remonta desconectado.

Evidencia observada (focused = `npx vitest run tests/core/notifications-state.test.ts tests/views/notifications.test.tsx`):

- **RED**: 12 fallos / 34 pasados (46), exit 1 — los 12 fallos cubren los seis ítems (estado/forma, uuid e instante, copia `429`/`503`, región persistente + foco con filtro, `PUT` entre páginas y sobre `401`).
- **GREEN focused**: 46 pasados (2 archivos), exit 0; con `tests/views/executive.test.tsx`: 52 pasados (3 archivos), exit 0.
- **PRESERVE**: `npm test` → **896 pasados (63 archivos), exit 0** (885 previos + 11 nuevos); `npm run typecheck` exit 0; `npm run lint` exit 0. `ExecutivePanel.tsx` y `core/api.ts` siguen sin cambios (`git diff --quiet`).

Archivos: `frontend/src/core/notifications.ts` (`askState` con `200` exacto y sobre `401`/`403`, validadores uuid/RFC 3339), `frontend/src/views/NotificationsView.tsx` (región persistente, foco con reserva por página, copia `429`/`503`, mensaje de `401` conservado en la vista), `frontend/src/styles/notifications.css` (región persistente y anillo de foco del encabezado del filtro), `frontend/tests/core/notifications-state.test.ts` (+5), `frontend/tests/views/notifications.test.tsx` (+6, fixtures uuid). Sin commit, sin push.

**L4** (worker, tercera ronda de verificación · S2/S3). `gentle-ai-verify` confirmó 52/52 y aisló cinco casos límite; los cinco se corrigieron con RED primero.

- **S2-1 · UUID solo en minúsculas.** La regex de `alert_id` perdió el flag `/i` (`firewatch-v1.yaml:1025-1029`) y `readRiskAlertState`/`markRiskAlertState` rechazan cualquier `id` que no sea la grafía canónica **antes** de construir la petición (`malformed · invalid_shape`, cero peticiones). Una respuesta cuyo `alert_id` difiere solo en mayúsculas también se rechaza.
- **S2-2 · `Z` obligatoria y segundos `0..59`.** `isRfc3339Instant` exige el sufijo UTC `Z` en mayúscula (se rechazan `-03:00`, `+02:00` y la grafía relajada `t`/`z`) y descarta el segundo `60`; el calendario se sigue validando hacia atrás. El caso `-03:00` que antes se aceptaba pasó a la lista de rechazo.
- **S3-3 · Guarda de bearer antes de `resetSession`.** `askState` solo llama `resetSession('rejected')` cuando el token enviado no está vacío **y** sigue siendo el token en memoria (`getAccessToken()`); un `401` tardío de un bearer reemplazado ya no baja la sesión nueva (la respuesta se reporta igual como `unauthorized` de esa petición).
- **S3-4 · `401` de lectura por fila reenviado.** El efecto de lectura reenvía el sobre (`code` + `request_id`) vía `onRefusedMark` por fila, no por el agregado, porque el remontaje por cierre de sesión desmonta el efecto antes de la respuesta agregada; la guarda exige la misma página (`marksKeyRef.current === key`) y que la sesión haya quedado realmente cerrada (un `401` de token reemplazado no la cierra).
- **S3-5 · `onRefusedMark` después de las guardas.** En el `PUT`, el aviso de `401` se emite solo después de comprobar la página y el cierre real de la sesión, así que un `401` de un `PUT` iniciado en la página A no se convierte en el aviso de la página B.

Evidencia observada (focused = `npx vitest run tests/core/notifications-state.test.ts tests/views/notifications.test.tsx`):

- **RED**: 6 fallos / 45 pasados (51), exit 1 — dos por la grafía canónica (uuid no canónico y mayúsculas), uno por UTC/segundos, uno por bearer reemplazado y dos por el reenvío del `401` (lectura por fila y `PUT` de página abandonada).
- **GREEN**: 51 pasados (2 archivos), exit 0; con `tests/views/executive.test.tsx`: 57 pasados (3 archivos), exit 0.
- **PRESERVE**: `npm test` → **901 pasados (63 archivos), exit 0** (896 previos + 5 nuevos); `npm run typecheck` exit 0; `npm run lint` exit 0. `ExecutivePanel.tsx` y `core/api.ts` siguen sin cambios.

Archivos: `frontend/src/core/notifications.ts` (regex UUID sin `/i`, instante UTC con `Z` y `0..59`, guarda de página para el `id`, guarda de bearer en el `401`), `frontend/src/views/NotificationsView.tsx` (mensaje de `401` de lectura, reenvío por fila del sobre, aviso de `PUT` detrás de las guardas), `frontend/tests/core/notifications-state.test.ts` (+2 y dos casos actualizados), `frontend/tests/views/notifications.test.tsx` (+2). Sin commit, sin push.

**L5** (cierre de unidad de trabajo). Commit **`0839583`** — `feat(frontend): wire personal alert marks in NotificationsView` — registrado en `feat/pm-08-personal-marks-ui`, con la re-verificación independiente `gentle-ai-verify` en **S1 PASS · S2 PASS · S3 PASS**. Evidencia citada por esa revisión: **57/57** pruebas focused (`tests/core/notifications-state.test.ts` + `tests/views/notifications.test.tsx` + `tests/views/executive.test.tsx`), **901/901** en la suite completa, y `typecheck` y `lint` con exit 0. `T1` queda `done` con commit `0839583`. Todavía **no** hay push, PR ni merge, y **R6 no se cierra**: este paso solo registra la unidad de trabajo ya verificada.

