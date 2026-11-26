# PM-02 — Rótulo D-D de la ficha de factores

**Qué es:** unidad pequeña que aplica en la ficha de zona el rótulo de la decisión D-D —«Cómo lo calculó la regla»— y lo fija con una prueba, cerrando el último hueco textual de PM-02. No cambia clasificación, contrato, datos ni la lista de variables.
**Base:** rama `feat/pm-02-dd-label`, creada desde `origin/dev` = `268c893` (que ya contiene el PR #104). **No fusiona, no publica, no despliega.** La aceptación humana (R6) queda fuera.

## Specs

**S1 — Criterio de PM-02 (plan 16, textual).** «La ficha de zona muestra las cinco variables canónicas con su contribución, marca las que no tienen lectura en vez de ocultarlas y no usa ninguna palabra que afirme causalidad; una prueba fija el rótulo y la lista de variables.»

**S2 — D-D resuelta (textual del responsable).**

> ««Cómo lo calculó la regla»»

La ficha usa ese rótulo y dice, en la misma nota, que la contribución es aritmética de la regla sobre el lote publicado: **no una causa del incendio ni un pronóstico**.

**S3 — Alcance.** Solo `frontend/src/views/OverviewView.tsx`, `frontend/tests/views/overview.test.tsx` y este documento. No se toca la lista de cinco variables, la presentación de «sin lectura», el contrato, `classify`, `batches` ni el backend.

## Tasks

**T1 — Rótulo.** Añadir junto a «Factores» la nota `#factor-rule-note` con el texto D-D y la negación de causalidad/pronóstico.

**T2 — Prueba.** Extender la prueba PM-02 para fijar el rótulo y la negación, además de la lista canónica y las lecturas ausentes que ya fijaba.

**T3 — Verificación.** Ejecutar `npm test`, `npm run typecheck`, `npm run lint` y `npm run build:local`; registrar resultados y omisiones.

## Log

- **L1 (2026-11-25) — Se abre la unidad.** PM-02 tiene la ficha de factores fusionada (PR #104) y D-D resuelto; falta aplicar el rótulo y la prueba que lo fija. Esta unidad no cierra PM-02: la aceptación humana sigue pendiente.

## Allowed edit surfaces

- `frontend/src/views/OverviewView.tsx`
- `frontend/tests/views/overview.test.tsx`
- `odd/tasks/pm-02-dd-label.md`
