# PM-01 — Panel ejecutivo con zonas críticas y alertas

**Qué es:** unidad que completa PM-01 sobre el backend local `8266bc1`: añade al resumen ejecutivo la definición D-B de «zona crítica» y el conteo de alertas registradas, y construye la sección de panel ejecutivo en la página. Sin la página y sin D-B en el contrato, PM-01 no puede cerrarse aunque el endpoint exista.
**Base:** rama `feat/pm-01-executive-panel`, creada desde `8266bc1` (que a su vez parte de `origin/dev` = `268c893`). **No fusiona ni publica.** La aceptación humana (R6) queda fuera.

## Specs

**S1 — Criterio de PM-01 (plan 16).** El resumen por nivel, la variación reciente entre lotes y las variables predominantes se calculan en el servidor y la vista los muestra; «zona crítica» usa la definición de D-B escrita en el contrato; «alertas activas» queda fuera hasta PM-07 y la fila lo declara. PM-07 ya está fusionado en `268c893`, así que la alerta deja de ser una exclusión vigente y el panel muestra el conteo de alertas registradas.

**S2 — D-B resuelta (textual del responsable):**

> «Alto sostenido dos lotes»

Definición: una zona es **crítica** cuando sus **dos últimos lotes publicados** tienen nivel `alto`. Se calcula en el servidor, se escribe en la descripción del contrato y se muestra con esa etiqueta. No se inventa una definición distinta ni se cuenta una zona con un solo lote alto o con un lote alto seguido de otro nivel.

**S3 — Contrato.** `GET /v1/risk/executive-summary` conserva `coverage`, `levels`, `delta` y `predominant_variables` y añade:
- `critical_zones`: `{count: integer, zone_ids: [string]}`. `count` es la longitud de `zone_ids`; el orden es estable (por `zone_id`). Una zona sin dos lotes no entra. Una zona con dos lotes `alto` entra aunque el último lote sea antiguo; la frescura ya la declara `coverage`.
- `active_alerts`: `{count: integer}`. Cuenta las filas de `risk_alerts`; no inventa estado de lectura ni descarte (eso es PM-08). La descripción del contrato lo dice con esas palabras. La lectura se declara en la interfaz `Repository` de `handler/api.go` y se refleja en el doble `fakeStore` de `handler/api_test.go`: una sola fuente de verdad, sin aserciones de capacidad opcionales.

No se renombra ni se elimina ningún campo existente. Los códigos `400/401/403/429/502/503` no cambian.

**S4 — Página.** `OverviewView` gana una sección «Panel ejecutivo» al inicio, alimentada por el resumen:
- Cobertura: zonas del catálogo, sin lote, obsoletas, demo.
- Niveles: alto, medio, bajo, desconocido, con sus conteos.
- Variación: zonas comparadas, cambiadas, sin lote anterior e incomparables; las transiciones se listan con `from → to` y número de zonas.
- Variables predominantes: nombre y número de zonas, en el orden que devuelve el servidor.
- Zonas críticas: conteo, lista de zonas (nombre si el catálogo ya lo tiene; `zone_id` si no) y la etiqueta textual «Alto en los dos últimos lotes».
- Alertas registradas: conteo y enlace al centro de notificaciones (`/v1/risk/alerts`).
- Rótulos honestos: «Regla activa, no modelo» y, cuando `coverage.demo_zones > 0` o el lote lo declare, «Datos sintéticos».
- Si el resumen falla, la sección muestra un error en línea y el resto de `OverviewView` sigue funcionando. Sin `loading` infinito ni spinner permanente.
- Accesibilidad: encabezados con jerarquía, listas semánticas, texto además de color, foco visible; no se introducen controles nuevos.

**S5 — Pruebas.** Backend: unitarias del cálculo de criticidad (dos altos, alto→medio, un solo lote, sin lotes, empate/orden) y contract test contra el YAML; la integración PostgreSQL se ejecuta si `TEST_DATABASE_URL` existe y se declara omitida si no. Frontend: pruebas del componente (datos, vacío, error, rótulos) y de la vista que lo monta; `npm test`/`npm run typecheck` según lo que exista. No se inventan resultados: si una suite no corre, se reporta.

**S6 — Non-goals.** No tocar `classify`, `batches`, migraciones, `prevention`, el resto de vistas ni el diseño de G1. No implementar marcas de PM-08, D-C ni el simulador. No commitear, no fusionar, no publicar, no desplegar. No cambiar el contrato de alertas.

## Tasks

**T1 — Backend.** Extender `backend/services/risk/internal/repository/executive.go` para devolver las zonas críticas y el conteo de alertas; declarar la lectura del conteo en la interfaz `Repository` de `handler/api.go` y en `fakeStore` de `handler/api_test.go`; extender `handler/executive.go` y su respuesta; actualizar `handler/executive_test.go` y el subtest PostgreSQL de `repository/store_zone_batches_integration_test.go`. Mantener el `503 storage_unavailable` y el `Cache-Control: no-store`.

**T2 — Contrato.** Actualizar `backend/contracts/openapi/firewatch-v1.yaml` con `critical_zones`, `active_alerts` y las descripciones de D-B y del alcance del conteo de alertas; el contract test debe leer el YAML del disco.

**T3 — Página.** Añadir el cliente/tipo del resumen en `frontend/src/core/api.ts`, crear el componente `frontend/src/components/executive/ExecutivePanel.tsx` y sus estilos en `frontend/src/styles/app.css`, montarlo al inicio de `frontend/src/views/OverviewView.tsx` y cubrirlo en `frontend/tests/components/executive.test.tsx` y `frontend/tests/views/overview.test.tsx`.

**T4 — Documentación y verificación.** Actualizar la fila de rutas de `backend/README.md`, registrar la evidencia en el `## Log` de este documento y ejecutar las suites acotadas. Devolver archivos tocados, comandos, resultados, omisiones y cualquier desviación.

## Log

- **L1 (2026-11-25) — Se abre PM-01 sobre el backend local.** El responsable fijó el foco en cerrar v1.0 y resolvió D-B como «Alto sostenido dos lotes». El backend `8266bc1` ya calcula cobertura, niveles, variación y variables predominantes; esta unidad añade la definición de zona crítica, el conteo de alertas y la página. No cierra PM-01: la aceptación humana sigue pendiente.

- **L2 (2026-11-25) — T1–T4 implementados y verificados; una cita por línea del panel de permisos corregida.**
  Backend: `repository/executive.go` añade `ExecutiveAlertCount` (conteo sin filtro de `risk_alerts`) y
  `CriticalZones` (D-B: los dos últimos lotes publicados en `alto`, ordenado por `zone_id` y nunca `nil`;
  sin filtro de frescura ni de comparabilidad, porque eso lo declaran `coverage` y `delta`).
  `handler/executive.go` publica `critical_zones {count, zone_ids}` con `count = len(zone_ids)` y
  `active_alerts {count}`, lee el conteo después del snapshot y responde `503 storage_unavailable` si
  cualquiera de las dos lecturas falla, conservando `Cache-Control: no-store`. El `Repository` de
  `handler/api.go` declara la lectura nueva y el `fakeStore` de `handler/api_test.go` la implementa:
  ambos archivos entraron en las superficies por decisión del responsable (opción 1), manteniendo la
  interfaz como fuente única. Contrato: `critical_zones` y `active_alerts` son obligatorios y las
  descripciones escriben D-B con sus palabras y el alcance del conteo. Página: `ExecutivePanel` abre
  `OverviewView`, se alimenta de `GET /v1/risk/executive-summary` una vez por sesión, declara el fallo en
  línea sin tumbar el resto de la vista y no deja un spinner permanente (el plazo del transporte lo
  convierte en fallo).
  Desviaciones declaradas: (a) D-B se aplica en `buildExecutiveReport` sobre el snapshot de
  `ExecutiveBatches` mediante la función pura `repository.CriticalZones`, no con una segunda consulta;
  (b) la ruta del resumen se nombra como literal en `core/api.ts` porque `config.ts` no estaba en las
  superficies; (c) el enlace de alertas apunta a `#notifications` (el enrutado es por hash) y la nota del
  bloque nombra `/v1/risk/alerts` como origen del conteo; (d) el guard del cliente rechaza un cuerpo en el
  que `critical_zones.count` no coincide con `zone_ids.length`.
  Colateral corregido: la matriz de permisos citaba `handler/api.go` por línea fija
  (62/63/64/69/73/74/85/86) y la interfaz creció 10 líneas; las citas de `SessionView.tsx` y de
  `tests/views/session.test.tsx` se re-apuntaron a 72/73/74/79/84/85/96/97, sin cambiar ninguna aserción
  ni el constructo citado. El contrato, que llegó con CRLF del checkout, se normalizó a LF: el hash de
  contenido es idéntico y el diff siguió en 39 inserciones y 3 borrados.
  Verificación ejecutada en esta sesión (con `TEST_DATABASE_URL` sin definir):
  `go vet ./...` en `backend/services/risk`: PASS. `go test ./...` en `backend/services/risk`: PASS,
  12/12 paquetes. `go test ./internal/handler -run
  'TestRiskExecutiveSummaryContract|TestExecutiveCriticalZones|TestExecutiveSummarySerialisesEmptyCriticalZonesAsList' -v`:
  PASS (5 subtests de contrato, 9 casos D-B y 1 de forma vacía). `go test ./internal/repository -run
  TestLatestPerZoneAnswersTheNewestBatchOfEveryZone -v`: **SKIP** — «requires migrated disposable risk
  database», así que el subtest PostgreSQL con las aserciones D-B y de conteo de alertas NO se ejecutó.
  `go test ./internal/handler` en gateway y prevention: PASS (leen el mismo YAML). `npm ci` en
  `frontend/`: PASS (240 paquetes; `package-lock.json` sin cambios). `npm test`: PASS, 50 archivos y 594
  pruebas. `npm run typecheck`: PASS. `npm run lint`: PASS. `npm run build:local`: PASS (`dist/` está
  ignorado por git). No ejecutados: `npm run check`, `npm run smoke` y `npm run verify`, por estar fuera
  de las suites acotadas pedidas. No se commiteó, fusionó, publicó ni desplegó; la aceptación humana (R6)
  sigue pendiente y PM-01 no se cierra aquí.

- **L3 (2026-11-25) — Integración PostgreSQL ejecutada por el padre en un proyecto aislado.** El worker no tenía `TEST_DATABASE_URL` y la prueba quedó omitida; el padre levantó `fw-pm01-test` con volumen propio y corrió `risk-test`: 12/12 paquetes ok, incluido `repository`, que ejercitó la regla D-B y la igualdad del conteo contra `risk_alerts`. El proyecto se eliminó con `down -v`. El skip de L2 queda superado; no se re-ejecutó el resto de la suite.

- **L4 (2026-11-25) — Slices de entrega.** `7918f2f` backend/contrato (348+/32-); `9219b6c` página, pruebas y este documento (936+/22-). El segundo slice es UI más sus pruebas; al publicar, revisar como dos unidades o partir las pruebas de la página si el revisor lo pide. El aviso de «87 commits desde main» es la ascendencia de `dev`, no líneas autoradas.

## Allowed edit surfaces

- `backend/services/risk/internal/handler/api.go`
- `backend/services/risk/internal/handler/api_test.go`
- `backend/services/risk/internal/handler/executive.go`
- `backend/services/risk/internal/handler/executive_test.go`
- `backend/services/risk/internal/repository/executive.go`
- `backend/services/risk/internal/repository/store_zone_batches_integration_test.go`
- `backend/contracts/openapi/firewatch-v1.yaml`
- `backend/README.md`
- `frontend/src/views/OverviewView.tsx`
- `frontend/src/views/SessionView.tsx`
- `frontend/src/components/executive/`
- `frontend/src/core/api.ts`
- `frontend/src/styles/app.css`
- `frontend/tests/components/executive.test.tsx`
- `frontend/tests/views/overview.test.tsx`
- `frontend/tests/views/session.test.tsx`
- `odd/tasks/pm-01-executive-panel.md`
