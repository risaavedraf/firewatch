# Reconciliación del plan v1 con `origin/dev` y decisiones D-A/D-B/D-D

**Qué es:** unidad documental que corrige el estado de las filas `PM-*` del plan v1 contra el árbol real de `origin/dev` y registra las decisiones del responsable que desbloquean la primera ola. Sin esta corrección el plan sigue afirmando que PM-07, PM-09 y PM-18 no tienen implementación cuando su código ya está fusionado, y sigue tratando D-A como abierta cuando ya fue resuelta.
**Base:** `origin/dev` = `268c89397cb2e6ce94c9d6b137079924322126cf` (verificado el 2026-11-25). **Ruta:** inline, solo documentación. **No cierra ninguna fila ni unidad.**

## Specs

**S1 — Pedido del responsable (textual):**

> «eso lo veremos luego, ahora enfoquemonos en terminar para el v1 plan produccion»

Consecuencia: el foco pasa del pitch al cierre de v1.0; esta unidad no implementa producto, solo pone el plan en estado verdadero.

**S2 — D-A resuelta (textual):**

> «tenemos permiso para usar datos sinteticos»

Consecuencia: D-A se resuelve a favor de fixtures sintéticos **declarados como sintéticos** en la interfaz y en el PDF. PM-11, PM-12 y PM-14 dejan de estar bloqueadas por el insumo del mandante; siguen abiertas por implementación y por D-B/D-C/D-D según corresponda. La obligación de rotular el dato sintético (R3) no se relaja.

**S3 — D-B resuelta (textual):**

> «Alto sostenido dos lotes»

Definición: una zona es **crítica** cuando sus dos últimos lotes publicados tienen nivel `alto`. Se escribe en el criterio de PM-01 y en el contrato cuando se implemente; no se inventa una definición distinta.

**S4 — D-D resuelta (textual):**

> ««Cómo lo calculó la regla»»

Consecuencia: la explicación se rotula como aritmética de la regla, no como causalidad ni pronóstico. PM-02 y PM-03 usan ese rótulo; la prueba que lo fija queda como trabajo de PM-02.

**S5 — Evidencia de `dev` que el plan no registra.** El código de PM-07, PM-09 y PM-18 está fusionado en `268c893`; PM-10, PM-11 y PM-13 tienen implementación parcial o demo; PM-02 tiene el PR #104 fusionado sin D-D. **Ninguna de estas filas se cierra:** falta aceptación humana (R6) y, en PM-01/03/04/05/08/16, la página o el despliegue. La corrección es de evidencia, no de estado.

**S6 — Conteos.** No cambiar el cómputo de 64 filas / 62 unidades / 48 abiertas / 14 cerradas salvo que una fila cambie realmente de estado. Esta unidad no cierra ninguna. Si una fila pasa de «sin implementación» a «código fusionado, aceptación pendiente», sigue abierta y el conteo no cambia.

## Evidencia verificada (leer y contrastar; no heredar a ciegas)

| PM | Qué existe en `268c893` | Evidencia |
|---|---|---|
| PM-07 | Entidad de alertas por cambio de nivel, ruta paginada y página | `backend/services/risk/migrations/017_risk_alerts.sql`; `backend/contracts/openapi/firewatch-v1.yaml:409`; `frontend/src/views/NotificationsView.tsx`; fusionado por #117 |
| PM-09 | Observaciones de campo, tipos cerrados, página | `firewatch-v1.yaml:1546`; `backend/services/prevention/migrations/015_field_observations.sql`, `016_observation_adoption.sql`; `frontend/src/views/ObservationsView.tsx`; #117 |
| PM-10 | `/v1/audit` con `actor_name`, detalle, `event_kind` y consultas | `firewatch-v1.yaml:842-884`; `frontend/src/views/AuditView.tsx:61`; #117/#118 |
| PM-11 | Catálogo de infraestructura **sintético**, score de demo, mapa | `firewatch-v1.yaml:516-541`; `backend/services/risk/internal/source/infrastructure.go`; `frontend/src/views/InfrastructureView.tsx`; #117/#119 |
| PM-13 | `GET /v1/risk/history.csv` y descarga CSV | `firewatch-v1.yaml:293`; `ddf1277` fusionado en `540fb38`; `frontend/src/views/HistoryView.tsx` |
| PM-18 | Catálogo escrito y ficha de solo lectura en el cliente | `frontend/src/domain/recommendations.ts`; panel de `frontend/src/views/OverviewView.tsx`; `odd/plan-produccion/catalogo-recomendaciones-preventivas.md`; #107 |
| PM-02 | Ficha de factores del PR #104, sin rótulo D-D | `frontend/src/views/OverviewView.tsx`; merge `cbc2aa8`; plan 16 L4 |
| PM-01 | Solo local: `GET /v1/risk/executive-summary` | `8266bc1`; `backend/services/risk/internal/handler/executive.go` |
| PM-03 | Solo local: `POST /v1/risk/simulate` | `48412f6`; `backend/services/risk/internal/handler/simulation.go` |
| PM-04 | Solo local: `/v1/risk/history/series` + migración 018 | `4713e8d`; `backend/services/risk/migrations/018_risk_history_series_index.sql` |
| PM-05 | Solo local: `/v1/risk/compare` + jobs 007 | `6790377`; `backend/services/jobs/migrations/007_comparison_audit_action.sql` |
| PM-08 | Solo local: marcas personales; centro ya en dev | `6a86ee2`; `backend/services/risk/migrations/019_risk_alert_state.sql` |
| PM-16 | Solo local: `/v1/status` agregado | `b4a7dcc`; `gateway/internal/handler/multiservice_status.go` |

Ninguna rama local está publicada ni tiene frontend. No las fusiones, no las muevas, no las uses como evidencia de `dev`.

## Tasks

**T1 — Actualizar `odd/plan-produccion/16-producto-mandante.md`.**
- Registrar S1–S4 en la sección de decisiones (D-A resuelta; D-B, D-D resueltas; D-C sigue abierta) y en el `## Log` como una entrada nueva, con las citas textuales y la fecha 2026-11-25.
- Corregir las filas de PM-07, PM-09, PM-10, PM-11, PM-13 y PM-18 para que digan «código fusionado en `268c893`, aceptación pendiente» o «parcial», con la evidencia de la tabla de arriba. No las marques cerradas.
- Corregir el encabezado `**Estado:**` si afirma que ninguna fila `PM-*` tiene ejecución; debe distinguir «fusionado» de «cerrado».
- No reescribas entradas históricas del Log; agrega una nueva.

**T2 — Actualizar `odd/tasks/v1-produccion.md`.**
- Corregir el preámbulo de `## Tasks` y las notas de G1/G3 que afirman que PM-07/09/18 no tienen implementación, con la misma evidencia y sin cambiar el estado de las filas.
- Registrar S1–S4 en el `## Log` como entrada nueva (no reescribir L1–L20) y dejar explícito que D-A ya no es una compuerta para PM-11/12/14.
- Mantener el cómputo 64/62/48/14 y decir por qué no cambia.

**T3 — Actualizar `odd/requerimientos-producto-mandante.md`.**
- Actualizar la tabla de decisiones §7: D-A resuelta con S2; D-B resuelta con S3; D-D resuelta con S4; D-C sigue abierta.
- Añadir al inicio de §3 una nota breve de vigencia: el corte de la tabla es `d4afba7`; el estado contra `268c893` y la evidencia viven en `plan-produccion/16-producto-mandante.md` y `odd/tasks/v1-produccion.md`. No reescribas la tabla histórica de 20 filas.
- No cambies la transcripción de §1 ni el conteo histórico de §3.

**T4 — Verificación.**
- `git diff --stat` y `git diff` limitados a los tres archivos.
- `python -B odd/tools/check_md_links.py` si el intérprete existe; si no, dilo y usa una comprobación de enlaces relativos con `test -f`.
- Comprobar que cada afirmación nueva tiene `archivo:línea` o commit, que ninguna fila se declara cerrada y que el conteo no cambió.
- Devolver: archivos tocados, líneas añadidas/quitadas, resultado del verificador y cualquier enlace roto.

## Log

- **L1 (2026-11-25) — Pedido y decisiones del responsable.** El responsable desplazó el foco del pitch al cierre de v1 y resolvió tres decisiones abiertas. Citas textuales: «eso lo veremos luego, ahora enfoquemonos en terminar para el v1 plan produccion»; «tenemos permiso para usar datos sinteticos»; «Alto sostenido dos lotes»; ««Cómo lo calculó la regla»». Esta unidad solo registra el estado y las decisiones; no implementa, no fusiona y no cierra.

## Non-goals

- No editar código, contratos, migraciones, pruebas ni frontend.
- No crear ni cambiar ramas o worktrees.
- No commitear: el padre revisa el diff y decide.
- No declarar aceptación R6 ni cerrar filas `PM-*` o `V1-*`.
