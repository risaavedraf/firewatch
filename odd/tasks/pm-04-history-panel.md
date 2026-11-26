# PM-04 — Historial por granularidad y todas las zonas

**Qué es:** unidad que completa PM-04 (`V1-P-04`) sobre el backend local `4713e8d`: la página consume `GET /v1/risk/history/series` con granularidad y `zone_id` opcional, muestra el historial de todas las zonas y retira la entrada correspondiente de `NOT_IMPLEMENTED`. El backend y el contrato ya existen; esta unidad no los reimplementa.
**Base:** rama `feat/pm-04-history-panel`, creada desde `4713e8d` (que parte de `origin/dev` = `268c893`). **No fusiona, no publica, no despliega.** La aceptación humana (R6) queda fuera.

## Specs

**S1 — Criterio de PM-04 (plan 16, textual).** «La serie se puede pedir por zona y por granularidad declarada (horas, días, semanas), el historial sin `zone_id` existe como endpoint documentado, y la entrada «Historial de todas las zonas» sale de `NOT_IMPLEMENTED`.»

**S2 — Backend ya entregado.** `4713e8d` añade `GET /v1/risk/history/series` con `from`, `to`, `granularity ∈ {hour,day,week}` y `zone_id` opcional; devuelve `{from,to,granularity,series:[{zone_id,buckets:[…]}]}`, el último lote por intervalo y **sin rellenar huecos**. Límites: 48 h para `hour`, 31 días para `day`/`week`; `[from,to)` sobre `requested_at`. No se modifica el backend ni el contrato en esta unidad; si la página descubre una discrepancia, se detiene y la reporta.

**S3 — Página.** `HistoryView` gana un modo «Todas las zonas» y un selector de granularidad (`hour`, `day`, `week`) que consulta la serie:
- «Por zona» conserva el comportamiento actual (`/v1/risk/history` con la zona seleccionada) y el CSV; no se rompe ninguna ruta existente.
- «Todas las zonas» omite `zone_id` y muestra una lista compacta por zona con sus intervalos; el rango se declara en texto y respeta los topes del endpoint (48 h/31 d). No se inventan intervalos vacíos ni se interpola entre buckets.
- Estados: sin sesión, cargando, vacío real, error de transporte y éxito. Un fallo de la serie no rompe el historial por zona ni el CSV.
- Etiquetas honestas: «último lote publicado por intervalo», «sin relleno de huecos» y la marca de dato sintético/demo cuando el bucket lo declare.
- Accesibilidad: controles etiquetados, tablas/listas semánticas, foco visible, texto además de color; sin controles nuevos fuera del modo y la granularidad.

**S4 — `NOT_IMPLEMENTED`.** La fila «Historial de todas las zonas» sale de `frontend/src/views/PendingView.tsx`; su prueba de número de filas se actualiza al nuevo conteo real. No se retiran otras filas.

**S5 — Pruebas.** `frontend/tests/views/history.test.tsx`: carga por zona, todas las zonas, las tres granularidades, vacío, error y que el CSV sigue funcionando. `frontend/tests/views/pending.test.tsx`: la fila ya no está y el conteo coincide. Ejecutar `npm test`, `npm run typecheck`, `npm run lint` y `npm run build:local`; reportar cada resultado y toda omisión. La base `4713e8d` desplazó `handler/api.go`: si la matriz de permisos falla por sus citas fijas, actualizar `frontend/src/views/SessionView.tsx` y `frontend/tests/views/session.test.tsx` a las líneas nuevas (67/68/69/83/87/88/99/100), manteniendo regex y aserciones sin cambios. No se re-ejecuta el backend salvo que se toque; si se toca, se justifica y se corre su suite.

**S6 — Non-goals.** No tocar backend, contrato, migraciones, `classify`, `risk_alerts`, el Job de migración ni el despliegue. No implementar PM-05, PM-08 ni PM-14. No commitear, fusionar, publicar ni desplegar.

## Tasks

**T1 — Cliente y tipos.** Añadir a `frontend/src/core/api.ts` los tipos y la lectura de `/v1/risk/history/series` con `from`, `to`, `granularity` y `zone_id` opcional, con un guard fail-closed de la respuesta.

**T2 — Vista.** Extender `frontend/src/views/HistoryView.tsx` con el modo «Todas las zonas» y el selector de granularidad, reutilizando los estados y el lenguaje visual existentes; añadir los estilos necesarios en `frontend/src/styles/app.css`.

**T3 — Pending y pruebas.** Retirar la fila de `PendingView.tsx`, actualizar `pending.test.tsx` y cubrir los casos de S5 en `history.test.tsx`.

**T4 — Verificación y Log.** Ejecutar las suites y el build; registrar en el `## Log` de este documento comandos, resultados, omisiones y desviaciones. Devolver archivos tocados y evidencia.

## Log

- **L1 (2026-11-25) — Se abre PM-04 sobre `4713e8d`.** El backend de series ya está implementado y probado en su rama; falta la página que lo consume y retirar la fila de `NOT_IMPLEMENTED`. Esta unidad no cierra PM-04: la aceptación humana sigue pendiente.
- **L2 (2026-11-25) — T1–T4 implementadas y verificadas; la suite completa conserva un fallo previo ajeno a la unidad.**
  - **Archivos.** `frontend/src/core/api.ts`: tipos de la serie (`HistoryBucket`, `HistoryZoneSeries`, `HistorySeriesCollection`, `HistoryGranularity`), vocabulario `HISTORY_GRANULARITIES`, `historySeriesWindow` (ventana de exactamente el tope: 48 h en `hour`, 31 d en `day`/`week`) y `historySeries` con guard fail-closed: rechaza granularidad fuera del vocabulario antes de leer, cuerpo inutilizable como `invalid_shape`, zona vacía o sin `buckets` como serie inexistente, y un eco de otra ventana/granularidad (`window_mismatch`) u otra zona (`zone_mismatch`). `frontend/src/views/HistoryView.tsx`: modo «Todas las zonas» que omite `zone_id` y selector de granularidad horas/días/semanas; la ventana se declara en texto con su tope, cada zona es una lista semántica de intervalos con `bucket_start`, nivel como texto (`levelLabel`), lote, modelo y marca sintética; «Por zona» conserva tabla, búsqueda, filtro y CSV. `frontend/src/views/PendingView.tsx`: fila «Historial de todas las zonas» retirada. `frontend/src/styles/app.css`: barra de alcance y listas de serie. `frontend/tests/views/history.test.tsx`: doble de `fetch` que hace eco de la ventana pedida y cubre todas las zonas, las tres granularidades con sus topes, vacío, 503, eco de otra ventana, cuerpo inutilizable, sin sesión, fallo de serie que no rompe el historial por zona ni el CSV, y el cliente (`zone_id` solo cuando se pide, granularidad desconocida rechazada sin leer, cuerpo inutilizable rechazado). `frontend/tests/views/pending.test.tsx`: fila retirada y conteo real de 5.
  - **Comandos y resultados.** `npm run typecheck` → exit 0. `npm run lint` → exit 0. `npx vitest run tests/views/history.test.tsx tests/views/pending.test.tsx tests/styles/layout-padding.test.tsx` → 3 archivos, 51 pruebas, 51 pasan. `npm test` → 49 archivos, 595 pruebas: **594 pasan y 1 falla**. `npm run build:local` → exit 0 (67 módulos transformados; `dist/` regenerado).
  - **Fallo ajeno a la unidad.** `frontend/tests/views/session.test.tsx` fija `backend/services/risk/internal/handler/api.go:62` a `"GET /v1/risk/status"`, pero el commit base `4713e8d` desplazó esa línea (en `4713e8d^` la línea 62 era exactamente esa ruta y hoy es un comentario del constructor). No se corrigió: la prueba y el backend están fuera de las superficies de edición de esta unidad, y no se modificó backend, contrato, migraciones ni despliegue (`git diff --name-only` solo muestra los siete archivos permitidos y este documento). No se re-ejecutó el backend porque no se tocó.
  - **Desviaciones.** (1) El worktree no tenía árbol de dependencias; para ejecutar los comandos pedidos se enlazó `frontend/node_modules` por junction al checkout principal, cuyos `package.json` y `package-lock.json` son idénticos (mismo md5), sin instalar ni cambiar ninguna versión; el enlace está ignorado por git y no se versionó. (2) La ventana que pide la página termina en «ahora» y dura exactamente el tope (48 h / 31 d) en lugar de alinearse a medianoche civil: el corte civil de días y semanas es del servidor, el panel lo declara y advierte que el primer intervalo puede empezar antes de `from`. (3) Se añadió `role="status"`/`aria-live` solo a la región de la serie (superficie nueva); la región del modo «Por zona» conserva su marcado previo. (4) El aviso del LSP sobre `@types/react` era estado obsoleto de su servidor de tipos antes del enlace de dependencias: `tsc --noEmit` resuelve `react/jsx-runtime` y sale 0.
  - **Límites.** Sin commit, merge, publicación ni despliegue. La aceptación humana (R6) y el cierre de PM-04 siguen fuera.
- **L3 (2026-11-25) — Se corrige el pin de líneas del servicio `risk` y `npm test` queda en 595/595.** Cierra el fallo ajeno registrado en L2: era el pin desactualizado por el commit base `4713e8d`, no una regresión de PM-04.
  - **Qué se tocó.** `frontend/tests/views/session.test.tsx` y `frontend/src/views/SessionView.tsx` (superficies autorizadas por el orquestador para esta continuación). Las ocho citas de `backend/services/risk/internal/handler/api.go` se desplazan a las líneas reales de `4713e8d` — 62→67, 63→68, 64→69, 69→83, 73→87, 74→88, 85→99, 86→100 — en las claves de `GUARD_LINES`, en la fila de matriz que cita el `Authorize`, en la nota renderizada `#permissions-matrix-note`, en el comentario de cabecera del módulo y en la aserción `toContain` del `matrixNote`. No cambió ningún regex, ningún texto de aserción ni la semántica: solo el número de línea. Las citas de `jobs` y de `gateway` se verificaron línea por línea contra el árbol y no requerían cambio.
  - **Entorno de validación.** El worktree no traía árbol de dependencias. Para ejecutar los comandos pedidos se enlazó `frontend/node_modules` por junction NTFS al checkout principal, cuyos `package.json` y `package-lock.json` son idénticos (mismo md5); no se instaló ni se cambió ninguna versión. El enlace está ignorado por git (`git status` no lo muestra) y `package-lock.json` sigue sin modificaciones.
  - **Comandos y resultados finales.** `npm run typecheck` → exit 0. `npm run lint` → exit 0. `npx vitest run tests/views/session.test.tsx` → 11/11. `npm test` → **49 archivos, 595 pruebas, 595 pasan, 0 fallan** (exit 0). `npm run build:local` → exit 0 (67 módulos transformados; `dist/` regenerado).
  - **Omisiones.** Ninguna prueba omitida ni saltada en la corrida completa. No se re-ejecutó el backend porque no se tocó. Sin commit, merge, publicación ni despliegue.

- **L4 (2026-11-25) — Slices de entrega.** `6d95dc5` historial y pruebas (1029+/106-); `ad420d5` citas de sesión (19+/19-); `a30fd07` este documento. El slice de 1029 líneas incluye página y pruebas; al publicar, revisar como dos unidades o partir las pruebas si el revisor lo pide. El aviso de «88 commits desde main» es la ascendencia de `dev`, no líneas autoradas.
- **L5 (2026-11-26) — T3: tres hallazgos de la verificación independiente corregidos (S3).** Hallazgo textual: «el guard del cliente acepta timestamps inválidos y campos no declarados; `zoneId` vacío se omite y amplía a todas las zonas; al volver a «Todas las zonas» se ven ventana/datos anteriores mientras carga la nueva». Cambios: (a) `frontend/src/core/api.ts` valida `from`/`to` y los instantes de cada bucket como RFC 3339 con desplazamiento y campos civiles reales, rechaza miembros no declarados en bucket, serie y colección —los tres son `additionalProperties: false` en el contrato— y rechaza `zoneId: ''` como `invalid_shape` antes de cualquier lectura, sin dejar de omitir `zone_id` cuando está ausente; (b) `HistoryView` invalida el snapshot al inicio del efecto de «Todas las zonas», así que reentrar el alcance o cambiar la granularidad muestra carga sin ventana ni serie previas. Pruebas nuevas (3): `zoneId` vacío sin lectura, instantes inválidos y miembro no declarado, y reentrada a «Todas las zonas» sin pintar el snapshot anterior. Evidencia: `vitest run tests/views/history.test.tsx` → 45/45; `npx tsc --noEmit` limpio; `npx vitest run` → 49 archivos, 598 pruebas, todas pasan. Sin cambios en contrato ni backend; la aceptación humana (R6) sigue pendiente y PM-04 no se cierra.

## Allowed edit surfaces

- `frontend/src/views/HistoryView.tsx`
- `frontend/src/views/PendingView.tsx`
- `frontend/src/core/api.ts`
- `frontend/src/styles/app.css`
- `frontend/tests/views/history.test.tsx`
- `frontend/tests/views/pending.test.tsx`
- `frontend/src/views/SessionView.tsx`
- `frontend/tests/views/session.test.tsx`
- `odd/tasks/pm-04-history-panel.md`
