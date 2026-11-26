# PM-03 — Simulador contrafactual

**Qué es:** unidad que completa PM-03 sobre el backend local `48412f6`: una vista `#simulator` que sustituye variables sobre el último lote de una zona, llama a `POST /v1/risk/simulate` y muestra el antes/después sin publicar ningún lote. El backend y el contrato ya existen; esta unidad no los reimplementa.
**Base:** rama `feat/pm-03-simulator-panel`, creada desde `48412f6` (que parte de `origin/dev` = `268c893`). **No fusiona, no publica, no despliega.** La aceptación humana (R6) queda fuera.

## Specs

**S1 — Criterio de PM-03 (plan 16, textual).** «Un endpoint autenticado recalcula con variables sustituidas y devuelve el resultado sin escribir ninguna fila; dos pruebas cubren la sustitución y el no-efecto sobre `batches`; la página lo ofrece y explica que es la regla, no un pronóstico.»

**S2 — D-D resuelta (textual del responsable).**

> ««Cómo lo calculó la regla»»

La página usa ese rótulo y **nunca** presenta el resultado como pronóstico, predicción ni «qué pasaría si se quema». El simulador aplica la misma regla pura con otra entrada.

**S3 — Backend ya entregado.** `48412f6` añade `POST /v1/risk/simulate` con `{zone_id, variables:{temperatura|humedad_relativa|viento|cobertura_vegetal|incendios_historicos: number|null}}`, al menos una variable y cuerpo ≤4096 bytes. Devuelve `batch_id`, `zone_id`, `model_version`, `stored_level`, `policy`, `computation_instant`, `freshness:"not_evaluated"`, `before`, `after` y `notice`; no escribe `batches`. Errores: `415 json_required`, `400 invalid_simulation`, `400 invalid_zone`, `404 no_published_batch`, `422 unsupported_original_rule`, `503 storage_unavailable`; viewer/admin. No se modifica el backend ni el contrato; si la página descubre una discrepancia, se detiene y la reporta.

**S4 — Vista.** Nueva ruta `#simulator` («Simulador», grupo Prevención) y `SimulatorView`:
- Selección de zona del catálogo; al cambiarla se lee el último lote (`/v1/risk/latest`) para precargar las cinco variables canónicas con su valor y su nota. Una variable sin lectura se muestra como «sin lectura» y no se envía hasta que el usuario escriba un valor.
- Por variable: casilla «sustituir» y campo numérico; solo las sustituidas viajan en `variables`. Al menos una sustitución para habilitar «Simular»; el envío es explícito, no por tecleo.
- Resultado: nivel antes/después, factores/contribuciones si el contrato los trae, `stored_level`, política (`policy_id`, `params_hash`), `model_version`, `freshness` y `notice`. Se dice con texto que **no se publicó ningún lote** y que el cálculo es la regla, no un pronóstico.
- Estados: sin sesión, zona sin lote (`404 no_published_batch`), regla no reproducible (`422`), cargando, error de transporte y éxito. Un fallo no rompe el resto de la aplicación.
- Accesibilidad: etiquetas por campo, agrupación semántica, foco visible, texto además de color; sin controles fuera de zona, variables y botón.

**S5 — Pruebas.** Cliente: cuerpo con solo las variables sustituidas, una zona, rechazo de cuerpo inválido/eco y códigos `404/422/415`. Vista: precarga, sustitución de una y de varias variables, resultado antes/después, `404`, `422`, error de transporte, rótulo D-D y ausencia de lenguaje de pronóstico. Router: `#simulator` aparece y resuelve. Ejecutar `npm test`, `npm run typecheck`, `npm run lint` y `npm run build:local`. **Pin de sesión:** la base `48412f6` desplazó `handler/api.go`; si la suite falla por las citas de `SessionView.tsx`/`session.test.tsx`, actualizarlas mecánicamente a las líneas reales, sin cambiar regex ni aserciones.

**S6 — Non-goals.** No tocar backend, contrato, migraciones, `classify`, `batches`, alertas, el Job de migración ni el despliegue. No implementar PM-06, PM-16 ni PM-14. No commitear, fusionar, publicar ni desplegar.

## Tasks

**T1 — Cliente.** Añadir a `frontend/src/core/api.ts` los tipos y la lectura de `POST /v1/risk/simulate`, con guard fail-closed del cuerpo, de las cinco variables canónicas y del eco de zona/lote; una sustitución mínima antes de leer.

**T2 — Vista y ruta.** Crear `frontend/src/views/SimulatorView.tsx`, registrarla en `routes.ts` y `App.tsx`, y añadir los estilos en `app.css`. Reutilizar el patrón de estados y el lenguaje visual existentes.

**T3 — Pruebas.** Cubrir S5 en `simulator.test.tsx` y `router.test.tsx`; corregir el pin de sesión si la base lo desplazó. No relajar aserciones.

**T4 — Verificación y Log.** Ejecutar las suites y el build; registrar en el `## Log` comandos, resultados, omisiones y desviaciones. Devolver archivos tocados y evidencia.

## Log

- **L1 (2026-11-25) — Se abre PM-03 sobre `48412f6`.** El backend de simulación ya está implementado y probado en su rama; falta la página que lo ofrece y el rótulo D-D. Esta unidad no cierra PM-03: la aceptación humana sigue pendiente.

- **L2 (2026-11-25) — T1: cliente de `POST /v1/risk/simulate`.** `frontend/src/core/api.ts` gana los tipos (`SimulationResult`, `SimulationAssessment`, `SimulationFactor`, `SimulationPolicy`, `SimulationInput`), la lista canónica `SIMULATION_VARIABLES` y `simulateRisk`. Propiedades que viajan con el código: (a) el cuerpo nombra **una** zona y **solo** las variables sustituidas — una petición sin sustitución se rechaza en el cliente (`invalid_simulation`) **antes del fetch**, porque el contrato ya contestaría 400 por `minProperties: 1`; (b) el guard del cuerpo es fail-closed: exige `batch_id`, `zone_id`, `model_version`, `stored_level`, `policy{policy_id,params_hash}`, `computation_instant`, `notice` no vacíos, `freshness === 'not_evaluated'` y exactamente las cinco variables canónicas **en orden canónico** en `before` y `after`, con `value`/`contribution` solo cuando `known === true`; (c) se rechaza el eco de otra zona (`zone_mismatch`) y de otro lote (`batch_mismatch`) comparando contra la zona y el `batch_id` que la página precargó — ese `batchId` **no** viaja en el cuerpo. `null` se conserva como «forzar la variable a ausente», que no es cero. La ruta se declara como constante en `api.ts` (`SIMULATION_ROUTE`) porque `frontend/src/config.ts` queda fuera de las superficies editables.

- **L3 (2026-11-25) — T2: `#simulator`, `SimulatorView` y estilos.** `routes.ts` declara `simulator` en el grupo **Prevención** (entre «Observaciones de campo» y «Fuentes y servicios», icono `refresh`) y `App.tsx` lo registra en el mapa de vistas. La vista lee el catálogo real (`/v1/risk/zones`), y al cambiar de zona lee `/v1/risk/latest` para **precargar** las cinco variables canónicas con su valor y su nota; una variable con `known: false` se rotula «sin lectura», queda vacía y no se envía hasta que se escriba un valor. Solo las variables marcadas y con valor numérico finito entran en `variables`; el envío es explícito (un botón, nada por tecleo) y «Simular» queda deshabilitado sin al menos una sustitución. El resultado muestra nivel **antes/después**, la tabla de factores/aportes de cada recálculo, `stored_level`, `policy_id`, `params_hash`, `model_version`, `computation_instant`, `freshness` y `notice`, bajo el rótulo D-D **«Cómo lo calculó la regla»**, con texto que afirma que **no se publicó ningún lote** y que el cálculo **es la regla, no un pronóstico**. Estados cubiertos: sin sesión, zona sin lote (`404 no_published_batch`), regla no reproducible (`422 unsupported_original_rule`), cargando, error de transporte y éxito; cada fallo se asienta en su panel y deja la zona, las variables y el resto de la aplicación usables. Si el `batch_id` del eco no coincide con el lote precargado se vuelve a leer `/v1/risk/latest` en lugar de mostrar un antes/después de un lote que nadie leyó. Accesibilidad: `fieldset`/`legend` para el grupo de variables, `<label>` por casilla y por campo numérico, texto de nivel además del chip de color y el anillo de foco nativo de la hoja. Los estilos van a `frontend/src/styles/app.css` (los dos modificadores `simulator-panel`/`simulator-result-panel` se añaden a la regla compartida de padding que lee `tests/styles/layout-padding.test.tsx`) porque una hoja nueva quedaría fuera de las superficies editables; no se añadieron controles fuera de zona, variables y botón (sin «reintentar»: el catálogo fallido se declara y se recarga la página).

- **L4 (2026-11-25) — T3: pruebas.** `frontend/tests/views/simulator.test.tsx` cubre S5 en dos mitades. Transporte: cuerpo con solo las variables sustituidas y una zona (sin `batch_id`), `null` conservado, rechazo **sin red** de cuerpo vacío/inválido, rechazo de cuerpo ilegible, de `freshness` distinta de `not_evaluated`, de eco de zona y de eco de lote, y los códigos `404`/`422`/`415` con su `code` y su `request_id`. Vista: identificadores propios y ausencia de oferta sin sesión, precarga de las cinco variables con valor y nota más «sin lectura» y «Simular» deshabilitado, sustitución de **una** y de **varias** variables con el cuerpo exacto, resultado antes/después con política, versión, frescura y aviso, `404`, `422`, error de transporte con la página intacta, la casilla como interruptor de la sustitución, rótulo D-D y ausencia de lenguaje de pronóstico (cada aparición de «pronóstico/predicción/probabilidad» queda dentro de una negación y «qué pasaría si se quema» no aparece). `frontend/tests/app/router.test.tsx` pasa de once a doce vistas declaradas (con `simulator` en el orden real) y añade la prueba de que `#simulator` tiene entrada de navegación, resuelve y lleva el rótulo D-D. Las pruebas de cliente viven en ese mismo archivo porque `frontend/tests/core/` no está entre las superficies editables.

- **L5 (2026-11-25) — T3 (pin de sesión): desplazamiento mecánico.** La base `48412f6` desplazó `backend/services/risk/internal/handler/api.go`: `zones` pasó de la línea 73 a la 78, `synthetic-scenarios` de la 74 a la 79, `sources` de la 85 a la 90 y el `return Authorize(verifier, mux)` de la 86 a la 91. Se actualizaron **solo** las citas en `frontend/src/views/SessionView.tsx` (matriz, nota y comentario) y las claves de `GUARD_LINES` en `frontend/tests/views/session.test.tsx`; ninguna regex ni aserción cambió. Las demás citas (`status` 62, `latest` 63, `history` 64, `batches` 69, `security.go` 59/64, `jobs/api.go` 86/87/170/228/236, `jobs/security.go` 44/49, `gateway.go` 126/216/240/246) se verificaron contra el disco y no se movieron.

- **L6 (2026-11-25) — T4: verificación.** `npm ci` se ejecutó porque `frontend/node_modules` no existía; `package-lock.json` quedó sin cambios. Línea base **antes** de tocar código: `npm test` → 49 archivos, 580 pruebas pasan y **1 falla** (`session.test.tsx`, la cita `api.go:86`), es decir, el pin ya estaba desplazado por la base. Después de los cambios, ejecutado en `frontend/`:
  - `npm test` → **50 archivos, 596 pruebas, todas pasan** (14 nuevas de simulador y 1 nueva de router, además del recuento de vistas declaradas actualizado de once a doce).
  - `npm run typecheck` → sin errores.
  - `npm run lint` → sin avisos.
  - `npm run build:local` → `tsc --noEmit` limpio y `vite build --mode development` construye (`dist/index.html`, `index-*.css`, `index-*.js`).
  - Enfoque previo: `vitest run tests/views/simulator.test.tsx` (14/14), `tests/app/router.test.tsx tests/styles/layout-padding.test.tsx tests/views/session.test.tsx` (24/24).
  Sin omisiones de suites: no se saltó ninguna prueba y no se relajó ninguna aserción. No se tocó backend, contrato, migraciones, `classify`, `batches` ni despliegue, no se hace commit, merge, publish ni deploy. Desviaciones de forma, todas dentro de las superficies permitidas: la ruta de simulación vive en `api.ts` (no en `config.ts`), los estilos en `app.css` (no en una hoja nueva) y las pruebas de transporte en `tests/views/simulator.test.tsx` (no en `tests/core/`). La aceptación humana (R6) sigue fuera de esta unidad.

- **L7 (2026-11-25) — Slices de entrega.** `2a62fee` vista, cliente, estilos y pruebas (1627+/6-); `24f85aa` citas de sesión (11+/11-); `2903deb` este documento. El slice de 1627 líneas es grande: al publicar, revisar en dos unidades —cliente/tipos y vista/estilos/pruebas— o partir las pruebas si el revisor lo pide. El aviso de «88 commits desde main» es la ascendencia de `dev`, no líneas autoradas.
- **L8 (2026-11-26) — T4: dos hallazgos de la verificación independiente corregidos (S4/S5).** Hallazgo textual: «la precarga pierde la nota de ausencia con `known:false`; el guard acepta niveles fuera del enum cerrado». Cambios: (a) `frontend/src/core/api.ts` valida `level` y `stored_level` contra `RISK_LEVELS` y los rechaza como `invalid_shape`; (b) `SimulatorView` conserva la nota del factor `known:false` (`Reading.value` pasa a `number | null`) y la muestra como «sin lectura en el lote guardado · <nota>», sin inventar valor ni contribución. Pruebas nuevas (2): nivel `extremo` rechazado en `stored_level`, en `after` y en `before`; nota de ausencia presente en la precarga. Evidencia: `vitest run tests/views/simulator.test.tsx` → 16/16; `npx tsc --noEmit` limpio; `npx vitest run` → 50 archivos, 598 pruebas, todas pasan. Sin cambios en contrato, backend ni despliegue; la aceptación humana (R6) sigue pendiente y PM-03 no se cierra.

## Allowed edit surfaces

- `frontend/src/app/routes.ts`
- `frontend/src/App.tsx`
- `frontend/src/views/SimulatorView.tsx`
- `frontend/src/core/api.ts`
- `frontend/src/styles/app.css`
- `frontend/tests/views/simulator.test.tsx`
- `frontend/tests/app/router.test.tsx`
- `frontend/src/views/SessionView.tsx`
- `frontend/tests/views/session.test.tsx`
- `odd/tasks/pm-03-simulator-panel.md`
