# FireWatch — global design navigation

**Scope:** `design/firewatch-v1-vuelo/`; design only, no changes to production application code. **State:** T1 verified and handed off; T2 owned by the dashboard session.

## Specs

- **S1.** «no está diseñado que cuando estés en la otra vista fuera del mapa puedas volver al mapa, ni puedas acceder a ninguna de las otras opciones y tienes que volver al mapa a un acceso medio forro la verdad»
- **S2.** «y por  dentro quizás usar alguna skill que tengamos para front, hablale a la sesión 01a1fe41-682c-72c0-b5d1-095db7c1e7b3 para que está en ricky-skills en caso de que haya alguna skill la puede encontrar el allá»; «y de dashboard»; «si no que busque alguna en internet que aprezca confiable»

- **S3.** «un dashboard bonito, si hay que usar alguna weá como bi o parecido, algun otro framework para react no sé dile al de skills que busque en internet cosas así para mejorar el dashboard, eso lo diseñas tu y se lo pasas al agente que lo haga»

## Tasks

- **T1** — S1–S2 — Shared navigation across the aerial map and complementary screens; apply relevant frontend guidance and verify. Route: implementation + checks; verified in the shared worktree, no commit.
- **T2** — S3 — Redesign `21-lecturas-por-sector.html` as a sector-reading dashboard and validate it. Route: handed off to the user-designated dashboard session; T1 no longer blocks editing.

## Log

- **L1.**

  > estaba probando la app y encuentro que está bien, pero no está diseñado que cuando estés en la otra vista fuera del mapa puedas volver al mapa, ni puedas acceder a ninguna de las otras opciones y tienes que volver al mapa a un acceso medio forro la verdad C:\Users\rikar\AppData\Local\Temp\orca-paste-1795267032060-20b14500-10b3-498c-95bc-2118fec2e2b6.png
  >
  > y por  dentro quizás usar alguna skill que tengamos para front, hablale a la sesión 01a1fe41-682c-72c0-b5d1-095db7c1e7b3 para que está en ricky-skills en caso de que haya alguna skill la puede encontrar el allá

- **L2.** «y de dashboard»
- **L3.** «si no que busque alguna en internet que aprezca confiable»

- **L4.**

  > de acuerdo, pero también está la pagina de lecturas por sector y se vé así C:\Users\rikar\AppData\Local\Temp\orca-paste-1795267877545-dcbc9815-4985-4782-8770-8dd05240da31.png
  >
  > un dashboard bonito, si hay que usar alguna weá como bi o parecido, algun otro framework para react no sé dile al de skills que busque en internet cosas así para mejorar el dashboard, eso lo diseñas tu y se lo pasas al agente que lo haga

- **Design handoff for T2.** Replace the documentation-first hierarchy with a monitoring view. Keep the shared navigation. The top strip answers “which sector, what date, how complete?” with a sector selector, communes/date, and coverage, without a second context table. The visual centerpiece is a weather summary with paired minimum/maximum temperatures, then humidity, wind speed and direction together, seven-day precipitation total, and solar irradiance, each in its own units. Show the temperature pair and wind direction visually where readings support it, with an equivalent text label. Keep exact readings, estimator definitions, source metadata and terrain context reachable in secondary sections. Cover complete/partial/no-reading using the existing three sectors, preserve measured 0 mm vs missing, and do not invent a historical series, geographic overlay, risk score, or alerts. Keep production-style Spanish copy, aerial palette, keyboard selection, responsive layout, and the original embedded fixture unchanged. Static HTML/inline CSS and SVG for the artboard; the React/BI comparison informs future implementation, not this prototype's dependencies.

- **L5 — T1 verified and handed off.** Chrome checked Mapa → Historial → Notificaciones → Mapa with keyboard at desktop and 390 px, legacy hash navigation, and 63 board loads at 1440/390/320 px; no horizontal overflow, external requests or console errors. The offline checks confirm all 21 navigation blocks and all 16 generated boards. The direct-board checker does not rewrite files; the removed `--write` option exits with code 2 and leaves the five direct boards unchanged. The dashboard session received explicit clearance to edit board 21. Independent verification passed S1 and S2 (S2 consultation evidence observed by the parent); it confirmed the existing overwrite guard and legacy in-page navigation code are unchanged. The canvas could not refresh from the primary worktree. No production code or deployment changes.
