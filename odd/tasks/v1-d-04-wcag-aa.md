# V1-D-04 — WCAG AA as a measurable target

Objective: close the two open code conditions of `V1-D-04` and leave one registered report that evaluates the applicable WCAG AA criteria for the eight production views, with tool, version, date and a pass/fail verdict per criterion, on the global aerial night design.
Branch: `feat/v1-d-04-wcag-aa`, stacked on `feat/firewatch-design-migration` at `8c147a3` (`chain_strategy=feature-branch-chain`; commits stay local, and push, PR and merge are the user's decisions).
Runner: `cd frontend && npm run verify`.

## Specs

- **S1** — User verbatim: «terminemos con lo que necesite codigo mientras no llego a mi casa aún».
- **S2** — The `V1-D-04` criterion in [`v1-produccion.md`](v1-produccion.md), verbatim: «Un informe registrado evalúa los criterios WCAG AA aplicables a las ocho vistas, con herramienta, versión y fecha declaradas, y cada criterio tiene resultado pasa/falla; los fallos quedan corregidos.» Two code conditions remain open in the report's §«What still blocks a conformance claim» ([`../../frontend/WCAG-AA-CONFORMANCE.md`](../../frontend/WCAG-AA-CONFORMANCE.md)), and closing them is this unit:
  - **SC 1.4.4 Resize Text.** Convert every absolute `px` `font-size` declaration in `frontend/src/styles/*.css` to relative `rem` units, so a browser default-font-size change resizes the text without zooming the layout, and enforce the relative scale through a test or the source gate.
  - **SC 1.4.11 Non-text Contrast.** Make the commune map fills and strokes measure at least `3.0:1` against the adjacent dark water/canvas background `#0f1922` (and `--aerial-water #152934`), without touching `OverviewView.tsx` JSX.
  - **Report.** Update `frontend/WCAG-AA-CONFORMANCE.md` so the eight views — Overview, History, Actions, Sources, Jobs, Pending, Session and Audit, plus the public sign-in screen — are evaluated with declared tool, version, date and a pass/fail verdict per criterion.

## Tasks

- **T1** — S1–S2 — Relative `rem` type scale across `frontend/src/styles/*.css`, `>= 3.0:1` map non-text contrast tokens/styles, `frontend/tests/a11y/` regression suite, and the synced `frontend/WCAG-AA-CONFORMANCE.md` — done at `7a5ab76`, no push/PR yet — route: bounded frontend writer. Risk: item 3 — modifies shared CSS tokens and stylesheets consumed across all routes.

## Log

- **L1** — «terminemos con lo que necesite codigo mientras no llego a mi casa aún». This Markdown-only tracking creation precedes the first source write for `V1-D-04`.
  - **Starting condition, measured before that first write.** `frontend/src/styles/*.css` declares **293**
    `font-size` declarations, all in absolute `px` and none in `rem` (the 21 `rem` occurrences in those files
    are other properties); the report still records the pre-migration figure of 123 and no longer matches the
    tree. The map's opaque level tokens already clear 3:1 on both dark backgrounds (lowest
    `--level-neutral-fill` `#71879a`: 4.76:1 on `#0f1922`, 4.03:1 on `#152934`), but the aerial view composites
    two of them — `.zone-neutral` at `fill-opacity: 0.34` and `.level-desconocido` at `0.22` — and those
    composites measure between 1.60:1 and 1.71:1 on either background, which is the open 1.4.11 case. The
    criterion table was written for the eight routed views; the application now mounts fifteen, and the report
    already records the added views in their own evidence sections rather than in that table.
- **L2** — T1 closed at `7a5ab76`, no push/PR yet: +1345/−327 lines across 16 files — the mechanical `px`→`rem`
  conversion and stepped headings across the 12 stylesheets of `frontend/src/styles/` (11 of them carry type, and
  all 295 `font-size` declarations in the tree are now `rem`), plus `frontend/tests/a11y/wcag-conformance.test.ts`
  and the synced `frontend/WCAG-AA-CONFORMANCE.md` and `frontend/VISUAL-BASELINE.md`.
  - **RED → GREEN.** `wcag-conformance.test.ts` failed before the product edit and passes after: `10/10` in that
    file, and `npm run verify` green at `63 files / 874 tests`.
  - **Rendered 1.4.4 pass.** Headless Chrome 158, 16 px → 32 px root, across the 15 routes plus the sign-in screen
    at three viewports: `756/756` text runs doubled at `>= 2.0000×`, with `0 px` horizontal overflow in `48/48`
    runs.
  - **Independent verification.** `gentle-ai-verify` `S1` PASS and `S2` prose sync: outline minimums of `3.79:1`
    on water and `4.49:1` on canvas, and `295` stepped `rem` declarations.
  - This entry and the tracker itself stay uncommitted.
