# FireWatch — operational screens

**Scope:** Gentle Design only, in the existing aerial collection; no production frontend, backend or dependency changes.
**Delivery:** Acciones preventivas is the priority. Preserve existing data, state meanings, and global navigation.

## Specs

- **S1.** «y lo de acciones preventivas representa lo más importante que te dije
no quiero que sea una pagina gubernamental qdonde tengas que scrollear para acceder a todo, algo interactivo, más nuevo, de facil acceso, botones grandes que vayan cambiando mediante se necesiten, menos información en pantalla más interactuar»
- **S2.** «lo de panel ejecutivo tambien po C:\Users\rikar\AppData\Local\Temp\orca-paste-1795271033987-23ef7751-53e2-4466-947a-29d3f658badf.png»
- **S3.** «comparar sectores también, mira, numeros minusculos C:\Users\rikar\AppData\Local\Temp\orca-paste-1795271053332-26c92eb0-0a9b-46d5-ab8f-ff7e9a8425fd.png»
- **S4.** «este tambien se ve raro C:\Users\rikar\AppData\Local\Temp\orca-paste-1795271076758-a98c402b-02a1-415a-b1d9-d3eac8a52ee1.png»

## Tasks

- **T1** — S1 — Redesign Acciones preventivas; canonical source and scoped browser checks. Route: delegated writer; verified; commit: pending shared navigation baseline.
- **T2** — S2–S4 — Redesign Panel ejecutivo, Comparar sectores and Notificaciones; canonical shared source and scoped browser checks. Route: delegated writer; verified; commit: pending shared navigation baseline.
- **T3** — S1–S4 — Regenerate deliverables while preserving navigation and unrelated work; check desktop, mobile and keyboard; refresh canvas. Route: isolated integration + independent verification; verified; commit: pending shared navigation baseline.

## Log

- **L1.**

  > lo de panel ejecutivo tambien po C:\Users\rikar\AppData\Local\Temp\orca-paste-1795271033987-23ef7751-53e2-4466-947a-29d3f658badf.png
  >
  > comparar sectores también, mira, numeros minusculos C:\Users\rikar\AppData\Local\Temp\orca-paste-1795271053332-26c92eb0-0a9b-46d5-ab8f-ff7e9a8425fd.png
  >
  > este tambien se ve raro C:\Users\rikar\AppData\Local\Temp\orca-paste-1795271076758-a98c402b-02a1-415a-b1d9-d3eac8a52ee1.png
  >
  > y lo de acciones preventivas representa lo más importante que te dije
  > no quiero que sea una pagina gubernamental qdonde tengas que scrollear para acceder a todo, algo interactivo, más nuevo, de facil acceso, botones grandes que vayan cambiando mediante se necesiten, menos información en pantalla más interactuar

- **Design handoff for T1.** Start with the selected sector and a compact evidence summary, followed by a work area with a clear next action. Use large task choices and dynamically surface only the inputs and buttons relevant to the current task, sector, and data state. Persistent navigation and a clear way back; keyboard-accessible focus and feedback. Keep explanatory, source and history details available on demand instead of as prerequisites. Keep existing capabilities, fixtures, and constraints: do not imply an action was sent, persisted, executed, or calculated when it was not. Use the existing aerial visual language, larger legible values and a narrow layout that stacks naturally without requiring users to scroll through documentation to reach their first task. Aim for an interaction pattern that is demonstrable in the autonomous HTML.
- **Design handoff for T2.** Panel: front-load large existing counts and recent changes; keep the sector list or selected sector reachable without scrolling past explanation panels. Compare: increase significance and legibility of the actual numbers; preserve direct comparison of two or three sectors; use detail on demand for history and methodology, and preserve missing vs low and the exact values. Notifications: one clear empty state by default, and a deliberately separate, explicitly illustrative preview with its existing controls. Move redundant dependency and method explanations out of the primary path. Keep existing data and meaning; no fake live alerts, scores, or new business behavior. Use aerial palettes, accessible native controls, responsive markup and inline-only assets.

- **T3 integration evidence.** Canonical source checks: T1 42/42; T2 31/31. Isolated regeneration changed exactly 04–09, preserving product-navigation markup/CSS and visible 04/05 behavior. Catalog, navigation, Chromium and `git diff --check` passed. Final browser integration found two usability gaps to correct within T3: the first action choice starts at y=755 on a 320×720 viewport (fully visible at 390×844), and the Notificaciones preview can lose keyboard focus when the active pager button disables itself. Keep the correction scoped to these views; verify publicly against the regenerated boards.
- **T3 final evidence.** Narrow-screen evidence now opens on demand: the first task button is fully visible at 320 × 720 (y=623–707) and the task switch works with real Tab/Enter. The notifications pager now keeps focus on the complementary enabled control at either end and preserves the page announcement. The generator ran in a temporary copy and only 04–09 were updated; shared navigation was preserved and visible behavior in 04/05 remained unchanged in the Chromium comparison. Catalog, navigation (including browser round trip), and whitespace checks passed. The independent verifier passed the shared source/generated contract for S1–S4 structurally; it did not repeat browser interaction. The canvas was refreshed. No staging or commit: the generated files still contain earlier uncommitted navigation, so committing the complete tested slice would mix changes owned by the previous task.
