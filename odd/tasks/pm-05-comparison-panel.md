# PM-05 — Comparador de zonas

**Qué es:** unidad que completa PM-05 sobre el backend local `6790377`: una vista propia `#compare` que consulta `GET /v1/risk/compare` con 2–3 zonas y muestra riesgo, variables e historial en una sola llamada, sin ofrecer un cuarto eje vacío. El backend y el contrato ya existen; esta unidad no los reimplementa.
**Base:** rama `feat/pm-05-comparison-panel`, creada desde `6790377` (PM-05, apilada sobre PM-04, que parte de `origin/dev` = `268c893`). **No fusiona, no publica, no despliega.** La aceptación humana (R6) queda fuera.

## Specs

**S1 — Criterio de PM-05 (plan 16, textual).** «Dos o tres zonas se comparan en riesgo, variables e historial por una sola llamada; la prioridad se suma cuando exista PM-11 y la fila lo dice; la vista no ofrece un cuarto eje vacío.»

**S2 — Backend ya entregado.** `6790377` añade `GET /v1/risk/compare` con `zone_ids` (2–3 distintas, separadas por coma), `from`, `to`, `granularity ∈ {hour,day,week}`; devuelve `{from,to,granularity,zones:[{zone_id,assessment|null,history:[bucket]}]}` conservando el orden pedido. Límites: 48 h para `hour`, 31 días para `day`/`week`; `[from,to)` sobre `requested_at`; errores `invalid_comparison_query`/`invalid_zone`; viewer/admin. No se modifica el backend ni el contrato; si la página descubre una discrepancia, se detiene y la reporta.

**S3 — Vista.** Nueva ruta `#compare` («Comparador», grupo Prevención) y `CompareView`:
- Selección de 2–3 zonas del catálogo, sin duplicados; el orden elegido se conserva en la comparación.
- Selector de granularidad `hour`/`day`/`week`; la ventana es la del tope del endpoint (48 h/31 d) y se declara en texto; no se interpolan buckets ni se rellenan huecos.
- Por zona: nivel de riesgo, variables/factores que el `assessment` traiga, e historial de intervalos con `bucket_start`, nivel, lote y marca sintética. Si `assessment` es `null`, se dice «sin evaluación publicada», no se inventa un nivel.
- Estados: sin sesión, cargando, menos de 2 zonas, vacío real, error de transporte y éxito. Un fallo no rompe el resto de la aplicación.
- **Sin prioridad**: PM-11 solo tiene un demo sintético sin pesos aceptados, así que no se ofrece un cuarto eje vacío. La vista dice por escrito que la prioridad llega cuando PM-11 tenga pesos aceptados.
- Accesibilidad: selección etiquetada, tablas/listas semánticas, foco visible, texto además de color.

**S4 — Contrato de la página.** La llamada se hace una sola vez por comparación (no una por zona); el cliente valida 2–3 zonas distintas antes de leer, rechaza un cuerpo inválido y un eco de otra ventana/granularidad/zonas. No se toca `HistoryView`, el CSV ni el panel ejecutivo.

**S5 — Pruebas.** Cliente: 2 y 3 zonas, orden, duplicados rechazados sin leer, granularidad inválida, cuerpo inválido y eco distinto. Vista: 2/3 zonas, orden, `assessment:null`, vacío, error, etiqueta de prioridad ausente y navegación. Router: la nueva ruta aparece y resuelve. Ejecutar `npm test`, `npm run typecheck`, `npm run lint` y `npm run build:local`. **Pin de sesión:** la base `6790377` volvió a desplazar `handler/api.go`; si la suite completa falla por las citas de `SessionView.tsx`/`session.test.tsx`, actualizarlas mecánicamente a las líneas reales, sin cambiar regex ni aserciones. Reportar cada resultado y omisión.

**S6 — Non-goals.** No tocar backend, contrato, migraciones, `classify`, alertas, el Job de migración ni el despliegue. No implementar PM-08, PM-11 ni PM-14. No commitear, fusionar, publicar ni desplegar.

## Tasks

**T1 — Cliente.** Añadir a `frontend/src/core/api.ts` los tipos y la lectura de `/v1/risk/compare`, con guard fail-closed de 2–3 zonas, cuerpo cerrado y eco de ventana/granularidad/zonas.

**T2 — Vista y ruta.** Crear `frontend/src/views/CompareView.tsx`, registrarla en `routes.ts` y `App.tsx`, y añadir los estilos en `app.css`. Reutilizar el patrón de estados y el lenguaje visual existentes.

**T3 — Pruebas.** Cubrir S5 en `compare.test.tsx` y `router.test.tsx`; corregir el pin de sesión si la base lo desplazó. No relajar aserciones.

**T4 — Verificación y Log.** Ejecutar las suites y el build; registrar en el `## Log` comandos, resultados, omisiones y desviaciones. Devolver archivos tocados y evidencia.

## Log

- **L1 (2026-11-25) — Se abre PM-05 sobre `6790377`.** El backend de comparación ya está implementado y probado en su rama; falta la vista que lo consume y la decisión de no ofrecer prioridad mientras PM-11 no tenga pesos aceptados. Esta unidad no cierra PM-05: la aceptación humana sigue pendiente.

- **L2 (2026-11-25) — T1–T4 ejecutadas: cliente, vista, pruebas y verificación.** Sin tocar backend, contrato, migraciones ni despliegue.
  - **T1 — Cliente (`frontend/src/core/api.ts`).** Tipos `ComparisonGranularity`/`ComparisonAssessment`/`ComparisonPoint`/`ComparisonZone`/`ComparisonCollection`/`ComparisonRequest`, vocabulario cerrado `COMPARISON_GRANULARITIES`, límites `COMPARISON_MIN_ZONES`/`COMPARISON_MAX_ZONES`, `comparisonWindow()` (48 h para `hour`, 31 días para `day` y `week`, reloj inyectable) y `compare()`. Guard previo a cualquier lectura: 2–3 zonas no vacías y distintas, granularidad del catálogo cerrado y ventana ordenada; un rechazo local devuelve `invalid_comparison_request` sin emitir petición. Cuerpo **cerrado**: cada nivel exige exactamente los miembros declarados (`additionalProperties: false` del contrato), niveles dentro del enum de cuatro tokens, instantes legibles y `factors` como objetos; cualquier desvío invalida el cuerpo completo (`invalid_shape`). Eco verificado por valor de instante, granularidad y posición de cada zona; un eco distinto es `comparison_echo_mismatch`. Una sola llamada por comparación. **Desviación declarada:** `frontend/src/config.ts` no está en la superficie de edición, así que la ruta `/v1/risk/compare` se nombra una vez en `api.ts` (`COMPARE_ROUTE`), siguiendo el precedente de `JOBS_ROUTE`, en lugar de añadirse a `config.routes`.
  - **T2 — Vista y ruta (`CompareView.tsx`, `routes.ts`, `App.tsx`, `app.css`).** `#compare` («Comparador», grupo Prevención, icono de zonas, título «Comparador de zonas») con selección ordenada de 2–3 zonas (la lista `<ol>` es el eje; un duplicado no se puede elegir y la cuarta zona no se ofrece), selector de granularidad, ventana del tope declarada en texto junto con la ventana aceptada por la API, y estados sin sesión / menos de dos zonas / cargando / vacío real / error / éxito. El catálogo del selector es `GET /v1/prevention/observations/zones` porque lista **todas** las zonas del catálogo `zones` —el mismo que la ruta de comparación valida— incluidas las que no tienen geometría, mientras `/v1/risk/zones` excluye estas últimas. Por zona: nivel con texto y color, variables del `assessment` leídas verbatim (una variable sin nombre se declara omitida), historial con `bucket_start`, nivel, lote y marca sintética; sin interpolación ni relleno de huecos. `assessment: null` se dice «Sin evaluación publicada» sin inventar nivel. Sin eje de prioridad: `unimplemented-note` dice por escrito que se sumará cuando PM-11 tenga pesos aceptados. Accesibilidad: controles etiquetados, foco visible global, listas y tablas semánticas con `caption`, texto además de color.
  - **T3 — Pruebas.** `frontend/tests/views/compare.test.tsx` (19 pruebas): 2 y 3 zonas con orden y una sola llamada por comparación, `assessment:null`, vacío, error 503, etiqueta de prioridad ausente con la nota de PM-11, catálogo fallido, y del lado del cliente duplicados/tamaño inválido/granularidad inválida/ventana invertida rechazados sin leer, cuerpo no declarado (incluido un miembro `priority` inyectado) y eco de otra ventana, otra granularidad, otro orden o zona faltante, además del tope de ventana 48 h/31 d. `frontend/tests/app/router.test.tsx`: se declaran doce vistas y la nueva ruta aparece, resuelve y marca su entrada de navegación. **Pin de sesión reparado mecánicamente** (sin tocar regex ni aserciones): `backend/services/risk/internal/handler/api.go` se desplazó por `6790377` — `62→73` (status), `63→74` (latest), `64→75` (history), `69→98` (batches), `73→102` (zones), `74→103` (synthetic-scenarios), `85→114` (sources), `86→115` (Authorize), en `SessionView.tsx` (matriz y nota) y `session.test.tsx` (`GUARD_LINES` y la nota). Los pines de `jobs` no se movieron.
  - **T4 — Verificación.** `npm ci` en `frontend/` (los `node_modules` no existían; `package-lock.json` sin cambios) informó 10 vulnerabilidades ya presentes en el lock (9 moderadas, 1 alta), no introducidas aquí. `npm test`: 50 archivos, 601 pruebas, todas en verde (antes de esta unidad: 49 archivos, 581 pruebas con 1 fallo de pin de sesión). `npm run typecheck`: limpio. `npm run lint`: limpio. `npm run build:local`: correcto (68 módulos; `dist/` está en `.gitignore`). **Omisiones:** R6 (aceptación humana) sigue fuera; no se modificó backend, contrato, migraciones, `classify`, alertas ni despliegue; no se implementó PM-08/PM-11/PM-14; nada se commiteó, fusionó, publicó ni desplegó.

- **L3 (2026-11-25) — Slices de entrega.** `f3a18e7` vista, cliente y pruebas (1444+/9-); `9875d8c` citas de sesión (19+/19-); `a173832` este documento. El slice de 1444 líneas incluye la vista y sus pruebas; al publicar, revisar como dos unidades o partir las pruebas si el revisor lo pide. El aviso de «89 commits desde main» es la ascendencia de `dev`, no líneas autoradas.
- **L4 (2026-11-26) — T4: dos hallazgos de la verificación independiente corregidos (S4).** Hallazgo textual: «reañadir la última zona puede reusar resultado previo; formato fecha/UUID no estricto (el eco por instante sí se valida)». Cambios: (a) `CompareView` descarta el snapshot en `addZone` y `removeZone`, así que reañadir una zona entra en carga y no repinta números anteriores; (b) `api.ts` exige RFC 3339 con desplazamiento obligatorio en `instant` y UUID en `batch_id` de `ComparisonAssessment` y `ComparisonPoint`; `zone_id` sigue admitiendo cualquier código del catálogo, como declara el contrato. Fixtures: los `batch_id` de las pruebas pasan a UUID deterministas porque los alias `batch-<código>` eran cuerpos que el contrato rechaza. Pruebas nuevas (4): reañadir sin repintar, ventana no RFC 3339 rechazada sin lectura, `batch_id` no UUID rechazado con `zone_id` slug aceptado, e instantes del cuerpo no RFC 3339 rechazados. Evidencia: `vitest run tests/views/compare.test.tsx` → 23/23; `npx tsc --noEmit` limpio; `npx vitest run` → 50 archivos, 605 pruebas. Sin cambios en contrato ni backend; R6 sigue pendiente y PM-05 no se cierra.

## Allowed edit surfaces

- `frontend/src/app/routes.ts`
- `frontend/src/App.tsx`
- `frontend/src/views/CompareView.tsx`
- `frontend/src/core/api.ts`
- `frontend/src/styles/app.css`
- `frontend/tests/views/compare.test.tsx`
- `frontend/tests/app/router.test.tsx`
- `frontend/src/views/SessionView.tsx`
- `frontend/tests/views/session.test.tsx`
- `odd/tasks/pm-05-comparison-panel.md`
