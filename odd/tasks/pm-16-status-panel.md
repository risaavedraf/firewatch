# PM-16 — Tablero de estado de servicios

**Qué es:** unidad que completa PM-16 sobre el backend local `b4a7dcc`: una vista `#status` que muestra el veredicto operativo del agregado `/v1/status`, la fuente meteorológica y la regla activa con su versión y hash, sin fingir un modelo entrenado. El backend ya existe; esta unidad no lo reimplementa.
**Base:** rama `feat/pm-16-status-panel`, creada desde `b4a7dcc` (que parte de `origin/dev` = `268c893`). **No fusiona, no publica, no despliega.** La aceptación humana (R6) queda fuera.

## Specs

**S1 — Criterio de PM-16 (plan 16, textual).** «Una sola vista muestra API, fuente meteorológica y servicios con un veredicto operativo explícito; la fila del «modelo» dice lo que corresponde —regla activa con su versión y su hash— y no finge un modelo que no existe.»

**S2 — Backend ya entregado.** `b4a7dcc` añade `GET /v1/status` en el gateway: responde `{checked_at, gateway:{state}, services:[{service,state}]}` con orden fijo `risk, jobs, prevention, inference`; estados `ready|degraded|unknown|unauthorized|not_configured`; `200` si todo está listo, `503` con **el mismo cuerpo** si algo está degradado o desconocido; viewer/admin, 403 antes de sondear. Añade además `GET /v1/risk/inference/status` y `GET /v1/prevention/status`. No incluye meteorología ni una fila de modelo: la vista los compone con `/v1/risk/sources` y `/v1/models`, que ya existen. Jobs sigue siendo admin-only; un viewer puede ver `unauthorized` en esa fila. No se modifica el backend ni el contrato.

**S3 — Vista.** Nueva ruta `#status` («Estado de servicios», grupo Información) y `StatusView`:
- Veredicto explícito: «Operativo» solo si todos los servicios están `ready`; «Operación degradada» si alguno es `degraded`, `unknown`, `unauthorized` o `not_configured`, con el motivo por fila. Un `503` del agregado **no** es un error genérico: se muestran sus filas y el veredicto.
- Servicios: API/gateway, risk, jobs, prevention, inference, en el orden del servidor; cada uno con su estado y una explicación legible. `unauthorized` se rotula como «requiere admin», no como caído.
- Fuente meteorológica: se lee de `/v1/risk/sources`; si no hay fuente meteorológica configurada, se dice «no configurada» y no se inventa una.
- Fila del modelo: «Regla activa» con versión y hash de la política que devuelve `/v1/models`; si no hay regla activa, «sin regla activa». Nunca se escribe «modelo entrenado» ni se presenta la regla como modelo.
- Estados: sin sesión, cargando, éxito, `503` con cuerpo, error de transporte, fuentes/modelos no disponibles (degradación parcial sin romper el tablero).
- Accesibilidad: encabezados, lista/tabla semántica, texto además de color, foco visible.

**S4 — Cliente.** `frontend/src/core/api.ts` gana la lectura de `/v1/status` que **conserva el cuerpo en 503** (si el helper actual lo descarta, se extiende de forma acotada), un guard fail-closed de los cuatro servicios y sus estados, y lecturas de fuentes y modelos reutilizando lo existente. Una respuesta con servicios desconocidos o un eco incoherente se rechaza; no se inventa `ready`.

**S5 — Pruebas.** Cliente: cuerpo 200, cuerpo 503 conservado, servicios fuera de orden/estado desconocido rechazados, roles. Vista: todo listo, degradado, `503` con filas, jobs `unauthorized`, fuente meteorológica presente/ausente, regla activa con versión/hash, sin lenguaje de «modelo entrenado», error de transporte. Router: `#status` aparece y resuelve. Ejecutar `npm test`, `npm run typecheck`, `npm run lint` y `npm run build:local`. **Pin de sesión:** si la base desplazó `handler/api.go`, actualizar `SessionView.tsx`/`session.test.tsx` mecánicamente, sin cambiar regex ni aserciones; si la base cambió la forma de la sentencia que la cita verifica (por ejemplo `return Authorize(...)` → `authorized := Authorize(...)`), actualizar solo esa regex para que siga verificando el mismo constructo, sin relajar ninguna otra.

**S6 — Non-goals.** No tocar backend, contrato, migraciones, gateway, `classify`, `batches`, alertas, el Job de migración ni el despliegue. No replicar el scrape de Prometheus (V1-F-05). No implementar PM-08 ni PM-14. No commitear, fusionar, publicar ni desplegar.

## Tasks

**T1 — Cliente.** Añadir a `frontend/src/core/api.ts` los tipos y la lectura de `/v1/status` con cuerpo en 503, guard cerrado y lectura de fuentes/modelos; reutilizar los tipos existentes cuando existan.

**T2 — Vista y ruta.** Crear `frontend/src/views/StatusView.tsx`, registrarla en `routes.ts` y `App.tsx`, y añadir los estilos en `app.css`. Reutilizar el patrón de estados y el lenguaje visual existentes.

**T3 — Pruebas.** Cubrir S5 en `status.test.tsx` y `router.test.tsx`; corregir el pin de sesión si la base lo desplazó. No relajar aserciones.

**T4 — Verificación y Log.** Ejecutar las suites y el build; registrar en el `## Log` comandos, resultados, omisiones y desviaciones. Devolver archivos tocados y evidencia.

## Log

- **L1 (2026-11-25) — Se abre PM-16 sobre `b4a7dcc`.** El agregado `/v1/status` ya está implementado y probado en su rama; falta la vista que lo interpreta, la fuente meteorológica y la fila de regla activa. Esta unidad no cierra PM-16: la aceptación humana sigue pendiente.
- **L2 (2026-11-25) — T1/T2/T3 ejecutados.** `frontend/src/core/api.ts` gana `aggregateStatus` con `SERVICE_ORDER`/`SERVICE_STATES` (catálogo cerrado), guard cerrado de los cuatro servicios y sus estados, y una lectura que **conserva el cuerpo en 503** (`{ok:true,status:200|503,data}`): un 503 documentado ya no es un error genérico, mientras que un 200 con una fila no lista o un 503 sin ninguna se rechaza como eco incoherente (`status_mismatch`). Fuentes y regla activa se leen reutilizando `sources()` y `modelRegistry()`; no se añade ninguna lectura nueva para ellas. `StatusView` compone el tablero: veredicto explícito («Operativo» solo con los cuatro `ready`; «Operación degradada» con cualquier otro estado, nombrando fila y motivo), tabla semántica con gateway + los cuatro servicios en el orden del servidor, `unauthorized` rotulado «Requiere admin» como hecho de permiso, fuente meteorológica desde `risk_input` de `/v1/risk/sources` («No configurada» si no la publica) y fila «Regla activa» con versión y hash del objeto `effective` de `/v1/models` («Sin regla activa» si resuelve un no-regla). El tablero no usa la palabra «modelo» en ninguna rama. `#status` queda registrado en `routes.ts`/`App.tsx` (grupo Información) con estilos propios en `app.css`. Pruebas nuevas en `status.test.tsx` (cliente + vista) y `router.test.tsx` ampliado con la ruta y su entrada de navegación.
- **L3 (2026-11-25) — Pin de sesión desplazado por la base: actualizado salvo una cita.** En `268c893` las citas de la matriz coincidían; `b4a7dcc` movió `risk/internal/handler/api.go` (nuevo `newRiskHandler`) y `gateway/internal/handler/gateway.go`. Se actualizaron **solo números de línea**, sin tocar ningún regex ni ninguna aserción: gateway `216→224`, `240→248`, `246→254`; risk `api.go` `62→70`, `63→71`, `64→72`, `69→77`, `73→81`, `74→82`, `85→98`, `86→99` (también en los comentarios y en la nota `permissions-matrix-note`). Queda **una** cita sin poder cumplirse: su regex `/return Authorize\(verifier, mux)/` describe una sentencia que la base ya no contiene — la línea 99 ahora es `authorized := Authorize(verifier, mux)` y el retorno es `return authorized` —, así que apuntarla a la línea correcta no basta mientras el regex siga intacto. Decisión pendiente (ver L4).
- **L4 (2026-11-25) — Verificación y desviaciones.** `frontend/node_modules` no existía: `npm ci` (240 paquetes, `package-lock.json` sin cambios). `npm run typecheck`: sin errores. `npm run lint`: sin avisos. `npm run build:local`: correcto (68 módulos). `npm test`: 602 pasan, **1 falla** — `tests/views/session.test.tsx`, la cita de L3. Esa prueba ya fallaba en la base sin tocar nada (primera cita incorrecta observada: `gateway.go:216`), así que no la introduce esta unidad; el resto de las citas quedan corregidas y verificadas contra el árbol real. No se modificó backend, contrato, migraciones, gateway ni despliegue; no se commiteó, fusionó, publicó ni desplegó. Desviación pendiente de decisión: (a) actualizar ese único regex a `/authorized := Authorize\(verifier, mux)/` conservando la misma cita y la misma fuerza, o (b) dejar el pin rojo y documentarlo como defecto heredado.
- **L5 (2026-11-25) — Excepción aprobada: un solo regex, misma cita y misma fuerza.** Se autorizó la opción (a). El único cambio en `session.test.tsx` es la entrada `'backend/services/risk/internal/handler/api.go:99'`, cuyo regex pasa de `/return Authorize\(verifier, mux)/` a `/authorized := Authorize\(verifier, mux)/`; la cita sigue en 99 y ningún otro regex ni aserción se toca. Motivo registrado: la base `b4a7dcc` convirtió la sentencia fijada en `authorized := Authorize(verifier, mux)` con `return authorized`, así que el regex anterior no podía coincidir con ninguna línea del archivo; el nuevo fija la misma llamada, el mismo `mux` y el mismo verificador, sin rebajar la comprobación. Verificación: `npm test` → 50 archivos, **603/603** pruebas; `npm run typecheck` sin errores; `npm run lint` sin avisos; `npm run build:local` correcto. `frontend/package-lock.json` sigue sin cambios (`npm ci` no lo reescribe). No se commiteó, fusionó, publicó ni desplegó.

- **L6 (2026-11-25) — Slices de entrega.** `a79a274` tablero, cliente y pruebas (1179+/9-); `1c2b27a` citas de sesión (27+/27-); `d669ce2` este documento. El slice de 1179 líneas incluye vista y pruebas; al publicar, revisar como dos unidades o partir las pruebas si el revisor lo pide. El aviso de «88 commits desde main» es la ascendencia de `dev`, no líneas autoradas.
- **L7 (2026-11-26) — T5: dos hallazgos de la verificación independiente corregidos (S4).** Hallazgo textual: «cualquier 2xx se normaliza a 200 en vez de rechazarse; acepta `not_configured` fuera de inference». Cambios en `frontend/src/core/api.ts`: (a) `aggregateStatus` acepta solo 200 y 503 y rechaza cualquier otro 2xx con la taxonomía existente (`malformed`/`invalid_shape`), en vez de reescribirlo a 200; (b) `isMultiserviceStatus` valida el estado contra el servicio de su posición y `not_configured` queda restringido a `inference`, único productor en el gateway (`parseInferenceEvidence`), como declara el contrato en `firewatch-v1.yaml:132,136`. `StatusView.tsx` no necesitó cambios. Pruebas nuevas (2): 201/202 y 204 rechazados, y `not_configured` rechazado en risk/jobs/prevention y aceptado en inference. Evidencia: `vitest run tests/views/status.test.tsx` → 23/23; `vitest run tests/views/status.test.tsx tests/core/api.test.ts` → 48/48; `npx tsc --noEmit` limpio; `npx vitest run --no-file-parallelism` → 50 archivos, 605 pruebas, reproducido dos veces. La corrida paralela conserva el timeout conocido de `tests/views/actions*.test.tsx` bajo carga, archivos que no importan este diff. R6 sigue pendiente y PM-16 no se cierra.

## Allowed edit surfaces

- `frontend/src/app/routes.ts`
- `frontend/src/App.tsx`
- `frontend/src/views/StatusView.tsx`
- `frontend/src/core/api.ts`
- `frontend/src/styles/app.css`
- `frontend/tests/views/status.test.tsx`
- `frontend/tests/app/router.test.tsx`
- `frontend/src/views/SessionView.tsx`
- `frontend/tests/views/session.test.tsx`
- `odd/tasks/pm-16-status-panel.md`
