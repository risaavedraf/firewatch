# FireWatch WCAG 2.1 AA criterion report

Unit V1-D-04. The eight production views are Overview, History, Actions, Sources, Jobs, Pending, Session and Audit, plus the public sign-in screen. This report lists every WCAG 2.1 A and AA criterion that applies to them, the tool and version that decided it, the date, and the verdict.

**This is not a conformance statement.** It records what was measured, what was only sampled, and what remains unevaluated. A criterion is `Meets` only where a deterministic check covered it and no failure was observed; everything else is qualified.

## Environment

| Item | Value |
| --- | --- |
| Baseline | `742e760` (`origin/dev`), branch `feat/g1-production-frontend` |
| Date | 2026-11-25 |
| Environment | Disposable Compose project `firewatch-g1-audit` (gateway 18380, identity 18381, static web 14375), real admin session through the local Keycloak realm |
| Viewports | 1280×720, 390×844; 320×800 for reflow; 640 CSS px for 200% zoom |
| Verification assets | Ignored scratch under `tmp/g1-browser-baseline/`; no repository dependency was added for any of them |

## Tools

| Tool | Version | Date | Decides |
| --- | --- | --- | --- |
| axe-core | 4.10.3 | 2026-11-25 | Automated rule subset `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`; 16 scans (eight views × two widths) |
| Chromium | 149.0.7827.55 | 2026-11-25 | Rendered evidence: contrast, focus, keyboard, zoom, reflow, accessibility tree |
| Rendered-pixel backdrop probe (`FW_MIXED_SURFACES`) | Repo harness, ignored | 2026-11-25 | 1.4.3 on composited and gradient surfaces; 93 samples |
| @guidepup/virtual-screen-reader | 0.28.0 | 2026-11-25 | Document-order exposure and dynamic announcements |
| Manual source review | — | 2026-11-25 | Token arithmetic, `aria-hidden` judgement, document metadata |
| Vitest · jsdom (programmatic WCAG 2.1 gates) | 5.0.4 · 29.1.1 | 2026-11-27 | `tests/a11y/wcag-conformance.test.ts`: relative-unit gate over the 12 shipped stylesheets and `src/components/map/*.tsx` (SC 1.4.4), a 16 px-vs-32 px root size evaluator for every declared size, and relative-luminance contrast over every commune state × three surface roles, with translucent paint composited (SC 1.4.11) |
| Chrome over the DevTools Protocol (rendered resize matrix) | 158.0.8127.38 | 2026-11-27 | Rendered 1.4.4 evidence: the built application at a 16 px and a 32 px root, 15 routes × 3 viewports plus the sign-in screen × 3, 756 text samples and the document's horizontal overflow at both roots. Served on an ephemeral 127.0.0.1 port from a temporary directory; `window.fetch` replaced by an empty-payload fixture table |

The rendered-pixel probe validates itself against independent arithmetic: it reproduces the documented active-navigation label at 10.32:1, table header at 5.01:1, neutral tag at 4.87:1 (10.51:1 in Actions), sign-in button at 11.65:1 and selected auth tab at 11.92:1.

## Perceivable

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| 1.1.1 Non-text Content (A) | Partly met | 16 accessibility-tree snapshots exposed no unnamed control in the sampled roles; decorative glyphs (`.session-mark`, `.lock-mark`, `.zone-chip` glyph) carry `aria-hidden="true"`. Icon-only controls were not exhaustively enumerated. |
| 1.2.1–1.2.5 Time-based Media (A/AA) | Not applicable | No prerecorded audio or video, no captions, no audio description. |
| 1.3.1 Info and Relationships (A) | Partly met | One `main`, one `navigation` and one `contentinfo` landmark per route, with the footer outside `main` so its landmark role survives; heading hierarchy corrected to h1→h2→h3; tables use `th` with a caption. axe leaves `th-has-data-cells` *incomplete* on `#actions-table` because the sampled state had no data rows. The corrected T1 navigation was confirmed in Chromium on 2026-11-26: exactly one `navigation`, named `Navegación del producto FireWatch`, a `button` disclosure (`aria-expanded`, `aria-controls`) and each group list labelled by its own visible group name. |
| 1.3.2 Meaningful Sequence (A) | Meets (sampled) | Territory leads with the map in both rendered and DOM order, asserted by a public DOM test; reading order recorded by the virtual-screen-reader pass. |
| 1.3.3 Sensory Characteristics (A) | Meets (source review) | Every instruction was reviewed for reliance on shape, size, position or colour, and none relies on one alone: the map legend names each level in text, the risk card states the level in words, and no copy points at a control by position. Colours never carry a meaning the text does not repeat. |
| 1.3.4 Orientation (AA) | Meets (sampled) | No orientation lock and no orientation-conditioned style exists in the application; the audited widths cover the landscape and portrait layouts, and both rendered without restriction. |
| 1.3.5 Identify Input Purpose (AA) | Partly met | Every audited input has a visible label; no `autocomplete` token audit was performed. |
| 1.4.1 Use of Color (A) | Partly met | Risk levels, statuses and action states pair colour with text. Map fills encode level and the level is also stated in the risk card; the legend and inset text were not reviewed for colour-only reliance. |
| 1.4.3 Contrast (Minimum) (AA) | Meets (sampled) | axe-core 4.10.3: zero violations across eight views at two widths. Rendered-pixel probe: 93 samples over the sign-in gradients, translucent sidebar surfaces, tags, table headers, eyebrows and navigation; every text surface meets 4.5:1, or 3:1 for large text. The single sub-threshold sample is the decorative `aria-hidden` `⌑` at 4.03:1. The corrected T1 navigation's rendered pairs measured 6.08:1–11.11:1 in Chromium on 2026-11-26; the panel is opaque, so the measured pair is the rendered pair (see the T1 table below). |
| 1.4.4 Resize Text (AA) | Meets (Chromium 32 px-root pass + source gate) | Chromium tab zoom at 200% (1280→640 CSS px) passed on all eight routes on 2026-11-25. Text-only resizing is now measured, not argued: headless **Chrome 158.0.8127.38** rendered the built application at a 16 px and a 32 px root on 15 routes × 3 viewports plus the sign-in screen × 3 viewports, and **756 of 756 text samples doubled**, minimum ratio exactly `2.0000`, with **0 px horizontal overflow at either root in all 48 runs**. The type scale is **295** `font-size` declarations (293 baseline → 295 stepped `rem` declarations), none absolute and none fluid: the six `clamp()` headings became `rem` steps, because a `vw`/`dvh` preferred term cannot answer a root-font change (the sign-in hero computed 38.4 px at a 16 px root and only 48 px at 32 px — 1.25×; it now computes 38.4 → 76.8). `tests/a11y/wcag-conformance.test.ts` evaluates every declared size at both roots and fails below 2×, rejects any `px`/`pt`/`pc`/`in`/`cm`/`mm`/`q` token in a `font-size` or `font` value (including `13px !important` and `13 px`), and rejects an inline `fontSize` in `src/components/map/*.tsx`. |
| 1.4.5 Images of Text (AA) | Meets (sampled) | No raster text in the shell or the audited views; the brand mark is a text glyph, and headings are real text. |
| 1.4.10 Reflow (AA) | Meets (sampled) | At 320 CSS px all eight routes measured a 320 px document scroll width, and at 200% zoom a 640 px width. Pending, Session and Audit expose one internal horizontal scroller each, reachable with Tab and movable with ArrowRight. The T1 navigation was measured at 1440, 1280, 1024, 720, 390 and 320 CSS px on 2026-11-26 and produced no horizontal page overflow at any of them. |
| 1.4.11 Non-text Contrast (AA) | Meets (measured arithmetic over every state) | Focus indicators pass (5.11:1, 44 instances). Every commune risk/state plate and its outline is now computed against the three surface roles the map composites on — `--canvas #0f1922`, `--aerial-water #152934` and the inset thumbnails' lightest gradient stop `--surface-raised #243341` — by `tests/a11y/wcag-conformance.test.ts`. Aerial stage, fill on canvas / water / raised: `bajo` 5.46 / 4.73 / 4.19, `medio` 6.54 / 5.65 / 4.98, `alto` 4.45 / 3.85 / 3.40, `desconocido` 10.83 / 9.16 / 7.88, `neutral` 4.76 / 4.03 / 3.47; outlines 4.99–13.71 for the level families, and 4.49 / 3.79 / 3.27 for the `--edge-strong` boundary the neutral and unread plates share (the lowest figure in the map, still above 3:1). The 2D map paints the same tokens opaque (`bajo` 7.20 / 6.09 / 5.24 … `neutral` 4.76 / 4.03 / 3.47), and the reserved `extreme` role measures 5.38 / 4.55 / 3.91. The two former gaps are closed: `.zone-neutral` measured 1.62 / 1.60 / 1.55 at `fill-opacity: .34` and `.level-desconocido` 1.68 / 1.71 / 1.67 at `.22`, and both now paint the measured token plate (T9). The corrected T1 navigation's disclosure boundary measures 4.84:1, its focus ring 5.66:1 on the bar and 5.17:1 on the panel; all were read from rendered pixels in Chromium on 2026-11-26. |
| 1.4.12 Text Spacing (AA) | Meets (sampled) | The 1.4.12 override (line height 1.5, letter spacing 0.12em, word spacing 0.16em, paragraph spacing 2em) was applied in Chromium 149.0.7827.55 to the eight views at 1280×720 and 390×844: 16 of 16 samples kept `scrollWidth` equal to the viewport width and lost no content in any element that hides its overflow. Method limit: elements of 4 px or less, `sr-only` nodes and nodes inside a declared scroll container are excluded. |
| 1.4.13 Content on Hover or Focus (AA) | Meets (source review) | No content appears on hover or on keyboard focus: there is no tooltip, popover or hover-revealed content in `src/`. The product navigation's grouped destinations are a native `<details>` disclosure that opens only on activation (pointer, Enter or Space), so it is not hover- or focus-triggered content. The only `title` attribute is the native tooltip on the map container, which the page does not position or dismiss. |

## Operable

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| 2.1.1 Keyboard (A) | Partly met | Verified: the T1 product navigation (three shortcuts, a native disclosure opened with Enter, and a grouped destination activated with Enter — Chromium, 2026-11-26), skip link, History search/status/reset, Territory map shapes (Enter and Space), table scrollers, create-form validation. Not verified: every control on every view. |
| 2.1.2 No Keyboard Trap (A) | Meets (sampled) | Tab cycles completed in each audited route without trapping focus; the skip link always returns to the top of the shell. |
| 2.1.4 Character Key Shortcuts (A) | Meets (source review) | The binding surface is enumerated: two keyboard handlers exist, map shapes activated with `Enter` and `Space` (button activation, not a shortcut) and the `Tab` cycle in the sign-in form. No handler maps a single character, printable or not, so there is no shortcut to disable. |
| 2.2.1 Timing Adjustable (A) | Not evaluated | Session and token expiry behaviour was not exercised. |
| 2.2.2 Pause, Stop, Hide (A) | Partly met | The navigation background animation was removed to keep menu labels readable mid-route-change. No other auto-moving or auto-updating content was audited. |
| 2.3.1 Three Flashes or Below Threshold (A) | Not applicable | No flashing content. |
| 2.4.1 Bypass Blocks (A) | Meets (sampled) | **Saltar al contenido** focuses the visible `main` without changing the route, in 16 of 16 route/width samples. |
| 2.4.2 Page Titled (A) | Meets (source) | `index.html` declares `FireWatch \| Centro de monitoreo`; `App.tsx:47` sets `${route.title} \| FireWatch` per route and `AuthView.tsx:95` for the public screens. |
| 2.4.3 Focus Order (A) | Partly met | Skip link, primary navigation and the History workflow preserve a sensible order. Full route-by-route focus order was not asserted. In Chromium on 2026-11-26, at 1024×720, the corrected T1 order was: skip link → **Mapa · Territorio** → **Historial de lotes** → **Acciones preventivas** → **Más destinos** → brand → gateway refresh, with the closed panel's links out of the tab order. |
| 2.4.4 Link Purpose (A) | Partly met | Navigation labels are textual and `aria-current` settles per route. In-page link purpose was not reviewed. T1: all fourteen navigation links expose their route's Spanish label as the accessible name (Chromium accessibility tree, 2026-11-26), and the current one is marked `aria-current="page"`. |
| 2.4.5 Multiple Ways (AA) | Not evaluated | No second navigation mechanism (search, sitemap) exists; whether the inventory views require one is a product decision. |
| 2.4.6 Headings and Labels (AA) | Meets (sampled) | No skipped heading levels in the four previously affected views; the Actions detail exposes a level-2 title with five level-3 subsections; section labels are text. |
| 2.4.7 Focus Visible (AA) | Meets (sampled) | 44 measured focus indicators at 5.11:1 with a solid outline, including the canvas overrides. Settled and mid-transition menu states both keep a solid outline. |
| 2.5.1 Pointer Gestures (A) | Not evaluated | No multi-point or path gesture exists in the audited views; the map was operated by keyboard only. |
| 2.5.2 Pointer Cancellation (A) | Not evaluated | Pointer down/up behaviour was not tested. |
| 2.5.3 Label in Name (A) | Not evaluated | Accessible names were compared to visible labels only for unnamed-control detection, not for containment. The T1 navigation is a sample: the three shortcuts and eleven grouped links use their visible label as the accessible name, and the disclosure is named by its visible **Más destinos** text. |
| 2.5.4 Motion Actuation (A) | Not applicable | No device-motion or user-motion input. |

## Understandable

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| 3.1.1 Language of Page (A) | Meets (source) | `index.html:2` declares `<html lang="es">`; no route overrides it. |
| 3.1.2 Language of Parts (AA) | Not applicable | No passage in a language other than the page language was identified in the audited views. |
| 3.2.1 On Focus (A) | Meets (sampled) | Focusing a map shape does not change the selection; activation requires Enter or Space. Focusing the skip link does not navigate. |
| 3.2.2 On Input (A) | Partly met | The History query filters results and the status selector does not change the total; native validation returns focus to the invalid field without submitting. Other form controls were not exercised. |
| 3.2.3 Consistent Navigation (AA) | Meets (sampled) | The same fourteen destinations appear in the same order on every authenticated route — three shortcuts plus eleven grouped links in the out-of-flow panel — with a single settled `aria-current="page"`. The corrected T1 navigation was measured in Chromium on 2026-11-26: menu selection closes the panel on arrival, Back to a different grouped route reopens it on the new current destination, and a same-route re-render does not reopen what the reader closed. The full fourteen-route loop is asserted by the router suite. |
| 3.2.4 Consistent Identification (AA) | Partly met | Repeated controls reuse the same labels across views; no systematic comparison was run. |
| 3.3.1 Error Identification (A) | Meets (sampled) | Submitting the create form with an empty title returned focus to the field and exposed the browser's validation message, with zero requests sent. |
| 3.3.2 Labels or Instructions (A) | Partly met | Audited create-form fields have visible labels; the directory-unavailable state shows the failure and a retry action. Instruction copy on the remaining views was not reviewed. |
| 3.3.3 Error Suggestion (AA) | Not evaluated | Server-rejection copy was not collected across the error states. |
| 3.3.4 Error Prevention (AA) | Not evaluated | No confirmation or reversal path was tested for lifecycle transitions. |

## Robust

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| 4.1.1 Parsing (A) | Meets (sampled) | axe-core reports no parsing, duplicate-id or ARIA misuse violation in 16 scans. Obsolete in WCAG 2.2. |
| 4.1.2 Name, Role, Value (A) | Meets (sampled) | 16 accessibility-tree snapshots: one named `main`, one named `navigation`, no unnamed control among the sampled roles; axe-core zero violations. Custom controls expose `role="button"` with `aria-pressed` and a name. T1 added a `button` disclosure named `Más destinos`, with `aria-expanded` true/false and `aria-controls` resolving to the panel; its links are ordinary `link` nodes named by their route labels. |
| 4.1.3 Status Messages (AA) | Meets (sampled) | The filtered-result count in History exposes itself as `role="status" aria-live="polite"`; with one row and a non-matching query the virtual reader logged `polite: 0 de 1` at 1280×720 and 390×844 while focus stayed put, and the harness reported no unannounced change. The same pattern already covers shell readiness, map progress, Actions notices and Audit status copy. Only the History filter change was exercised as a dynamic announcement. T1 added a polite live region on the `Estás en` navigation line so a hash route change names the new location; the attribute and its text are asserted by the DOM test, and the announcement itself was not read by a screen reader or the virtual reader. |

## T1 evidence — global product navigation (2026-11-26, corrected)

The corrected T1 change puts the navigation in a thin horizontal bar above and outside the workspace, with three always-visible shortcuts, an out-of-flow **Más destinos** panel for the other eleven destinations, and an **Estás en** line naming the open route. (T4 later added the fourth shortcut, `Panel` → `#executive`, and the route it points at; the table below records the T1 state that was measured.) Routing, titles, the session gate, the store and the role policy did not change. The evidence below is scoped to that navigation; it does not restate or replace the earlier per-criterion measurements.

**Environment.** Chromium **158.0.8127.38**, headless, against the locally built application, driven over the DevTools protocol. The workspace is behind Keycloak, so the run used an isolated local fixture: the token response and every gateway read were intercepted in the browser session with a locally generated unsigned token declaring `viewer`, and gateway reads answered `403`. No real credential, realm or gateway was used, and nothing was installed.

| Measurement | Result |
| --- | --- |
| Arrangement | 1440×900: bar `x=0 y=0 1425×48`, sticky, outside `.app-shell`; sidebar and topbar start at `y=49`. Opening the panel left `topbar`, `main`, the logout control and `document.scrollHeight` unchanged |
| Landmarks | One `navigation` named `Navegación del producto FireWatch`; the disclosure is a `button` named `Más destinos` with `aria-expanded` true/false and `aria-controls` resolving to the panel |
| Destinations | Three shortcuts (`Mapa · Territorio`, `Historial de lotes`, `Acciones preventivas`) and eleven grouped links; exactly one `aria-current="page"`, on the open route; the `Estás en` line names the same route |
| Keyboard | 1024×720, Tab: skip link → three shortcuts → **Más destinos** → brand → gateway refresh. Enter opened the panel; the first and last grouped links were reachable with a visible ring and no trap |
| Dismiss | Escape closed the panel and returned focus to its button; a pointer press outside closed it without moving focus; a same-route gateway re-render did not reopen it |
| History | Menu selection closed the panel on arrival; Back reopened it on the previous grouped route with that entry current; Forward did the same for the next |
| Focus ring | Bar controls: `3px` `rgb(215, 170, 115)` (`#d7aa73`), offset `0`, outline box `1..47` inside the `0..48` bar. Panel rows: offset `2px`, no clipping at either end (measured) |
| Disclosure boundary | `#90aaa0` border on `#173c3b`, 4.84:1 |
| Text pairs (rendered) | Bar shortcuts `#c3d6cf` on `#173c3b` 7.93:1; bar labels `#a5c8bf` 6.65:1; summary and location value `#e7faf5` 11.11:1; panel items `#c3d6cf` on `#1e4241` 7.24:1; panel labels `#a5c8bf` 6.08:1; current grouped item `#f0eee0` 9.43:1; current shortcut `#173c3b` on `#f0eee0` 10.32:1. The former translucent panel measured `#90aaa0` at 4.42:1 and was corrected |
| Target size | Shortcuts and the disclosure control measured 40px high; grouped items 32px |
| Reflow | 1440×900, 1024×720 and 390×800: no horizontal page overflow. At 390 the panel measured `x=8 y=51 359×480`, inside the viewport, with bounded internal scrolling (`scrollHeight 537`, `clientHeight 478`) and `window.scrollY` unchanged |

**Not measured for T1.** No axe scan, virtual screen reader, text-spacing override, browser zoom pass or real assistive technology was run on this change, and no screenshot was written. The fixture answers `403` to every gateway read, so navigation was exercised over permission-denied states. The button disclosure's announcement and the `Estás en` live region in NVDA, JAWS, VoiceOver or TalkBack remain unverified, as does the tab order inside the panel on every view. These gaps are additions to, not subtractions from, the open items below.

## T2 evidence — aerial workspace (2026-11-26)

The overview now composes the map as its canvas, a workstation rail beside it and the published-batch card as the reading; the stylesheet is [`src/styles/aerial-workspace.css`](src/styles/aerial-workspace.css) and every selector is scoped to `#overview`. Structure, names and focus were measured in Chromium **158.0.8127.38** (headless) against the locally built application with an isolated fixture — a locally generated unsigned token and every gateway read intercepted in the browser session. No real credential, realm or gateway was used. The DOM contract is additionally pinned by `tests/views/overview.test.tsx`.

| Criterion | Measurement | Result |
| --- | --- | --- |
| 1.3.1 Info and Relationships | One new `complementary` landmark, named **Estación de trabajo**; the canvas is a labelled `section` (**Mapa de trabajo del territorio**) that contains the unchanged map panel. No existing landmark, id or ARIA attribute was renamed | Meets (sampled) |
| 1.3.2 Meaningful Sequence | Rendered heading order: `h2` Estado de la zona → `h3` Vista territorial de las comunas → `h3` Estación de trabajo → `h4` Solicitud de lote → `h4` Lecturas y resultados → `h3` Último lote publicado → … → `h3` Panel ejecutivo. DOM order is map → workstation → reading, and at 1440/1280 the grid places the rail to the right of the canvas without reordering the DOM | Meets (sampled) |
| 1.4.3 Contrast (Minimum) | Rails text from declared tokens: links `--forest-700` on `--paper` 7.36:1; notes `--muted` on `--paper` 5.49:1; state, block titles and reading values `--ink` on `--paper` 11.85:1 | Meets (source arithmetic) |
| 1.4.10 Reflow | `#overview` at 1440×900, 1280×900, 1024×768 and 390×844: `0` descendants exceeded the viewport width; the composition becomes one column below `1100px` | Meets (sampled) |
| 1.4.11 Non-text Contrast | Rail link focus ring `3px solid #cf7d4f`, offset `2px`, on `--paper` = 3.11:1, read from the rendered computed style. The card boundary is `--line` (1.29:1) and is a surface edge, not a control; the map's fill and boundary pairs are unchanged from the values already recorded above | Partly met (unchanged map finding) |
| 2.1.1 Keyboard | Tab order from `#content` at 1280×900: zone selector → three map shapes → four rail links → executive alert link → reset filters → skip link → navigation. Every rail link is a native `a[href]` with a declared route; the rail contains no `button` | Meets (sampled) |
| 2.4.3 Focus Order | The four rail links follow the canvas they work beside and precede the reading card; pre-existing controls keep their relative order (the server summary now follows the workspace) | Meets (sampled) |
| 2.4.4 / 2.5.3 Link Purpose and Label in Name | Each rail link's visible text is its accessible name (`Pedir y seguir un lote`, `Ver el estado del gateway y las fuentes`, `Abrir los lotes publicados de la zona`, `Comparar esta zona con otra`). The labels deliberately differ from the navigation destinations' labels, and a public DOM test asserts every `href` is one of the fourteen declared hashes | Meets (sampled) |
| 2.5.8 Target Size (Minimum) | Rail links `min-height: 36px` (`40px` at `≤720px`), full rail width for the hit area | Meets |
| 4.1.3 Status Messages | The rail's `#aerial-request-state` carries `role="status" aria-live="polite"` only while the map is not announcing progress for the same zone; when the inflight batch belongs to the selected zone the map's `#map-job-progress` is the single announcement. Asserted by a public DOM test | Meets (source + DOM) |

**Not measured for T2.** No axe scan, text-spacing override, browser-zoom pass, virtual screen reader or real assistive technology was run for this change. The type scale is still absolute, so the **1.4.4** gap this report already records is unchanged, and the map's non-text contrast findings are untouched: T2 grew the canvas but kept its `#eef2e8` surface and its fills. The 390 px first screen still begins with the shell chrome the T1/T2 scope leaves in place, and whether the sticky rail reads well with a long real catalogue was not tested.

## T3 evidence — territorial coverage board (2026-11-26)

`#infrastructure` now composes the catalogue map as the canvas of a coverage stage, a comuna rail beside it and two reading panels under the unchanged table; the stylesheet is [`src/styles/territorial-coverage.css`](src/styles/territorial-coverage.css) and every selector is scoped to `#infrastructure`. Structure, names, focus and contrast were measured in Chromium **148.0.7778.96** (headless) against the locally built application with an isolated fixture — a locally generated unsigned token and every gateway answer intercepted in the browser session. No real credential, realm or gateway was used. The DOM contract is additionally pinned by `tests/views/infrastructure.test.tsx`.

| Criterion | Measurement | Result |
| --- | --- | --- |
| 1.3.1 Info and Relationships | One new `complementary` landmark, named **Cobertura por comuna**; the map stays inside the shipped `figure` with its own `<title>`/`<desc>` and legend; the per-type table keeps its named, focusable `.table-wrap` region (**Desglose por zona de infraestructura**) and there is still exactly one of them. No shipped id or ARIA attribute was renamed | Meets (sampled) |
| 1.3.2 Meaningful Sequence | Rendered heading order: `h2` Infraestructura prioritaria → `h3` Zonas, desglose y geometrías ficticias → `h3` Mapa de los elementos declarados → `h3` Cobertura por comuna → `h3` Desglose y geometrías por zona → four `h4` zones → `h3` Granularidad, cobertura y puntaje son cosas distintas → `h3` Dónde sigue la lectura real. No level is skipped, and DOM order is canvas → rail → table → breakdown → reading row | Meets (sampled) |
| 1.4.3 Contrast (Minimum) | Rendered computed-style pairs: rail figure `--forest-700`/`--paper` 7.36:1; rail type names `--muted`/`--paper` 5.49:1; coverage line 7.36:1; reading descriptions 5.49:1; reading links 7.36:1; granularity badge `--muted` on `#edf1f2` 4.87:1 | Meets (measured) |
| 1.4.10 Reflow | `#infrastructure` at 1440×900, 1280×900, 1024×768 and 390×844: no descendant of the new composition exceeded the viewport width. The only over-wide nodes at 390 are the pre-existing table cells inside `.table-wrap`, identical before and after the change. The stage folds to one column below `1180px` | Meets (sampled; the table keeps its own scroll inside `.table-wrap`) |
| 1.4.11 Non-text Contrast | Rail button and opened-breakdown focus ring `3px solid #cf7d4f`, offset `2px`, on `--paper` = 3.11:1, read from the rendered computed style after the keyboard pass. The five coverage marks are `aria-hidden` decoration and the sentence beside them carries the meaning; the selected state pairs colour with `aria-pressed` and an inset border. The map's fill and boundary findings are unchanged from the values already recorded above | Partly met (unchanged map finding) |
| 2.1.1 Keyboard | Tab order from `#content` at 1440×900: print → four rail buttons → table scroll region → three reading links → reset filters → skip link → navigation. Every new control is a native `button` or `a[href]`; no `tabindex` above `0` was added | Meets (sampled) |
| 2.4.3 Focus Order | The rail follows the canvas it summarises and precedes the table; the reading links follow the breakdown they continue; pre-existing controls keep their relative order | Meets (sampled) |
| 2.4.4 / 2.5.3 Link and Button Purpose, Label in Name | Each rail button's visible text is its accessible name (`Zona 05101`, `5 de 5 tipos`, the declared type names); each reading link's visible text names its destination and deliberately differs from the navigation labels | Meets (sampled) |
| 3.2.5 Change on Request | Activating a rail button does not change the route: the measured hash stayed `#infrastructure`, focus moved to the chosen `article` and `aria-pressed` changed. A public DOM test pins that the router hash is untouched | Meets (source + DOM) |
| 2.5.8 Target Size (Minimum) | Rail buttons `min-height: 44px` and full rail width; reading links `36px` (`44px` at `≤720px`) | Meets |
| 4.1.2 Name, Role, Value | Rail controls expose `button` + `aria-pressed`; the coverage marks are hidden from assistive technology; the breakdown target receives focus and is labelled by its `h4` | Meets (source + DOM) |

**A finding from this pass.** The rail first shipped as in-page `#infrastructure-zone-…` anchors, the artboards' pattern. The product's hash router owns the address bar, so choosing a comuna navigated the whole view to the fallback route (measured: `hash="#overview"`, focus `BODY`). The rail now uses `button type="button"` with `aria-pressed` and moves focus itself; the DOM suite pins both the focus target and the unchanged hash.

**Not measured for T3.** No axe scan, text-spacing override, browser-zoom pass, virtual screen reader or real assistive technology was run for this change. The type scale is still absolute, so the **1.4.4** gap this report already records is unchanged, and the map's non-text contrast findings are untouched. The hover and selected surfaces of the rail were not re-measured (their declared pairs are recorded in [`design/system.md`](../design/system.md)). The 390 px first screen still begins with the shell chrome the T1/T2 scope leaves in place, and print preview was not rendered. These gaps are additions to, not subtractions from, the open items below.

## T4 evidence — decision workspace (2026-11-26)

T4 adds the `#executive` route with the bar's fourth shortcut and recomposes `#compare` and `#notifications` as the approved decision boards (07/08/09). The evidence below is scoped to those three screens and the overview's unchanged executive section. It does not restate or replace the earlier per-criterion measurements, and it is not a conformance claim.

**Environment.** An isolated **Chromium** headless shell (the locally present Playwright `chromium_headless_shell-1223` build) over `file://` fixtures. Each fixture is the real component output rendered in jsdom by a temporary harness with the suites' fixtures, written beside the real stylesheets: `ExecutivePanel` with a served summary, `CompareView` with two answered zones, `NotificationsView` with two rows and with an empty page, and `ExecutiveView` after the change. No network, gateway, Keycloak, credential or backend state was used; nothing was installed; the temporary harness was removed before handoff. Evidence: `tmp/t4-fix/{before,after}/measure.json` plus screenshots at 1440×900, 1280×900, 1024×768 and 390×844.

| Criterion | Measurement | Result |
| --- | --- | --- |
| 1.3.1 Info and Relationships | The executive counts band is a `ul` of four `li` cells, each labelling its count in text (`ALTO`, `MEDIO`, `BAJO`, `INFORMACIÓN INSUFICIENTE`, the domain's own labels) and holding the same `#executive-level-*` identifier other suites read. The limits are three native `<details>`/`<summary>` disclosures in a labelled band, closed by default. Each comparator column is its own `article` panel with its own `h3`. No shipped id, landmark or ARIA attribute was renamed, and the related-readings list is a labelled `section` rather than a second `navigation`, so each route still exposes one navigation landmark (the product bar). The `#overview` keeps rendering the same panel | Meets (sampled + DOM) |
| 1.3.2 Meaningful Sequence | Rendered heading order: `#executive` `h2` Panel ejecutivo → `h3` Panel ejecutivo → `h4` Niveles → `h4` Cobertura → `h4` Variación reciente → `h4` Variables predominantes → `h4` Zonas críticas → `h4` Alertas registradas → `h3` Lecturas relacionadas; the `headingsIn` descent rule (never more than one level down at a time) is pinned by `tests/a11y/heading-hierarchy.test.tsx`. In `#compare` the selection panel precedes the reading panel in DOM order at every width; the CSS folds them to one column without reordering | Meets (DOM test) |
| 1.4.1 Use of Color | Each counts-band cell pairs its level mark with the written level label, and the marks reuse the map legend's fills; a reader who cannot see the marks still reads the level and the number. The disclosures' open/closed state is carried by the native `details` marker plus the visible summary text | Meets (source) |
| 1.4.3 Contrast (Minimum) | Rendered computed-style pairs at 1440: band label 5.49:1, band count 11.85:1, band hint 5.49:1, limit title 11.85:1, limit copy 5.49:1, related link 7.36:1, related note 5.49:1, view title 10.93:1, empty eyebrow 7.08:1, empty title 11.39:1, empty copy and points 5.28:1, empty `code` 7.08:1, comparator status 5.49:1, `Quitar` 6.51:1, scope chip 4.87:1 (the shipped neutral-tag pair). Lowest new pair 5.28:1 | Meets (measured) |
| 1.4.11 Non-text Contrast | Painted focus ring `3px solid rgb(207, 125, 79)` on every new focus target: related links and the three disclosures on `--paper` = 3.11:1 (meets 3:1). The same ring on `--soft` measures 2.75:1 on the pre-existing `Quitar` control, a shipped pair already recorded above. The dashed empty mark (`#c8d2c6` on `#f8faf7`, 1.48:1) is `aria-hidden` decoration; the eyebrow, title and copy carry the state | Partly met (shipped ring-on-`--soft` pair) |
| 1.4.10 Reflow | All four fixtures at 1440×900, 1280×900, 1024×768 and 390×844: `document.documentElement.scrollWidth` equals `window.innerWidth`, before and after. The counts band folds from four columns to two at `≤900px`; the comparator folds from two columns to one at `≤1000px`; the executive panel head stacks at `≤560px`. The only over-wide element remains the pre-existing `#notifications-table` inside its shipped `.table-wrap` scroll region at 390 px (`433×154` in a `330` px card, identical before and after) | Meets (sampled; the table keeps its own scroll) |
| 2.1.1 Keyboard | Tab sequence, page order: `#executive` alert link → three disclosure summaries → four related links; `#compare` zone picker → granularity → `Quitar` → `Quitar` (then the two history scroll regions at 390); `#notifications` order select, then the table scroll region and `Siguiente`. No `tabindex` above `0` was added; the disclosures are native `<summary>` | Meets (sampled) |
| 2.4.3 Focus Order | The band, the limits and the related links follow the panel they belong to; the comparator's controls stay in the selection column before the reading column; pre-existing controls keep their relative order in both screens (the full Tab sequence is identical to the baseline in `#compare` and `#notifications`) | Meets (sampled) |
| 2.4.4 / 2.5.3 Link Purpose, Label in Name | The four related links say where they go (`Estado de la zona`, `Comparador de zonas`, `Notificaciones`, `Acciones preventivas`), and a public DOM test asserts every `href` in `#executive` is one of the fifteen declared hashes. The bar's fourth shortcut shows `Panel` with the accessible name `Panel ejecutivo`, which begins with the visible word | Meets (DOM test) |
| 2.5.8 Target Size (Minimum) | New controls: disclosure `summary` rows `67px` high and full panel width; related links and the executive alert link `min-height: 24px` (the link's text box was 14–17 px before). The counts cells are not interactive, so no target is implied. Pre-existing comparator selects (`38px`), `Quitar` (`25px`) and pager (`33px`) keep their shipped sizes | Meets for the new controls (pre-existing sizes unchanged) |
| 3.2.5 Change on Request | No new control changes the route: the disclosures expand in place, and the related links are native `a[href]` to declared hashes. The `#executive` route is reachable by hash and by the bar shortcut; the router normalises unknown hashes exactly as before | Meets (DOM + source) |
| 4.1.2 Name, Role, Value | The three disclosures expose `details`/`summary` with their visible title as the name; the counts are list items with text; the executive panel keeps its `region` labelled by its `h3` and its `role="status" aria-live="polite"` summary line; no pressed state or filter is invented for the counts | Meets (DOM) |
| 4.1.3 Status Messages | `#executive-status` stays a `role="status"` live region in both views, and the notification/compare status lines are unchanged. The executive route's read is one request; a failure is stated in the same live region with no counts | Meets (DOM) |

**States.** The fixture set covers the served summary, the comparator with two answered zones and the empty and populated notification pages. Failure, pending and signed-out states of `#executive` carry DOM tests only (one request; inline failure copy; no numbers when idle), and the `#compare` / `#notifications` failure and paging states are covered by their pre-existing suites.

**Verifier correction (2026-11-26).** Three blockers were corrected inside T4's surface; the evidence below is scoped to them.

| Criterion | Measurement | Result |
| --- | --- | --- |
| 1.3.1 Info and Relationships | The D-B limits disclosure now names the shipped status (`Definición acordada · D-B`) in both consumers of the panel (`#overview`, `#executive`); the rule, its literal and the count explanation are unchanged. The notification empty card distinguishes the empty register (first page) from an empty page reached by paging, using its own eyebrow and title inside the same card. No id, heading level or ARIA attribute changed | Meets (DOM) |
| 2.4.11 Focus Not Obscured (Minimum) (AA, WCAG 2.2) | Built fixture (`Shell` + `ProductNav` + `InfrastructureView`, local token/catalogue), Chromium headless. Focused commune breakdown vs the sticky bar: baseline `bb8a956` — 320 px `targetTop 62` / `barBottom 89` (**27 px obscured**, pre-existing), 340/360/390/1440 unobscured; current before the correction — 320, 340 and 360 px obscured by 27 px; current after — 320/340/360 px `targetTop 103` / `barBottom 89`, 390/1440 `targetTop 62` / `barBottom 48`, **0 obscured at every measured width**. No T3 file was edited: the coverage `scroll-margin-top` follows the published `--product-nav-h` (`103px` when the bar wraps, `62px` on one row), which is written on `body` while the bar keeps its own `48px` minimum | Meets at the measured widths (was failing at 320/340/360) |
| 1.4.10 Reflow | The same fixture at 320, 340, 360, 390 and 1440: `document.documentElement.scrollWidth` equals `window.innerWidth` in both builds; the wrapped bar is two `40px` control rows inside the bar, not a horizontal scroller | Meets (sampled) |
| 2.1.1 Keyboard / 2.4.3 Focus Order | Tab from the document start at 340 and 390: skip link → the four shortcuts → `Más destinos` → brand → logout → technical notice → print, each stop visible, inside the viewport and painting a `3px` ring (bar `rgb(215, 170, 115)`, skip link `rgb(167, 77, 52)`, shell `rgb(207, 125, 79)`). Selecting the second commune kept `#coverage-entry-05102` `aria-pressed="true"`, focused `#infrastructure-zone-05102` (`outline: 3px solid rgb(207, 125, 79)`) and left the hash at `#infrastructure` | Meets (sampled) |
| 3.2.5 Change on Request | The out-of-flow menu still opens without moving the document: opening it kept `document.scrollHeight` constant and the panel stayed inside the viewport at 320, 340, 360, 390 and 1440 | Meets (sampled) |

**Copy corrections.** The later-page notification card no longer asserts "no hay alertas registradas" after a populated page: it names the page, says the previous pages had rows and points at `Anterior`, while the initial page keeps the global statement. `#notifications-status` stays a `role="status"` live region, stays focused after a page change and now names the page it describes. Both behaviours are pinned by public DOM tests.

**Not measured for T4.** No axe scan, text-spacing override, browser-zoom pass, virtual screen reader or real assistive technology ran for this change, and the workspace was not opened with a live authenticated session: the composition fixtures carry the real components' markup but not the shell, the gate or a real token (the verifier correction below adds a shell-level fixture that runs the real gate against a local token fixture; no identity provider or gateway was contacted). **1.4.4** is unchanged (the type scale is still absolute and this change adds `font-size` declarations in absolute units). The shell's link targets and the map's fill contrast are untouched by this task. The executive panel was not rendered with a long real critical-zone list, and the notification table's own scroll region at 390 px is unchanged rather than fixed here.

## T5 evidence — history, export and model data (2026-11-26)

T5 ports boards 05/12/20 into `#history` and the model panel `#overview` already renders. The evidence below is
scoped to those two screens and does not restate or replace earlier per-criterion measurements; it is not a
conformance claim. Environment: isolated Chromium headless shell against `file://` fixtures rendered from the real
components, base tree (`8e8324c`) and working tree, same stubbed data; no network, credential, gateway or backend.
Evidence: `tmp/t5/{before,after}/`, `measure.json`, `keyboard.json`, `columns.json`, `csv.json`, `shots/`.

| Criterion | Measurement | Result |
| --- | --- | --- |
| 1.3.1 Info and Relationships | The rows stay a real `<table>` inside the shipped named scroll region (`role="region"`, `aria-label="Historial de lotes de la zona"`, `tabindex="0"`), with five `<th>` and the `#history-rows` tbody. The panel is an `article` whose heading (now `h3` under the view's only `h2`) names it; the delivery block is a `<section aria-labelledby="history-export-title">` with a `<dl>` of facts; the level is text (`levelLabel`) inside a `span`, the dot `aria-hidden`. The model panel keeps its `article`, `h3` heading and `<dl>`, and the scope block is an `h4` + `ul`. No id, landmark or ARIA attribute was renamed (12 shipped ids kept, 3 added) | Meets (DOM + sampled) |
| 1.3.2 Meaningful Sequence | DOM order is head → panel heading → scope toolbar → search/filter → status line → table → delivery block; the 390 px CSS only stacks the head and the delivery head, it never reorders. The series branch keeps state → window facts → per-zone list → note | Meets (sampled) |
| 1.4.1 Use of Color | Every level is a written label (`BAJO`/`MEDIO`/`ALTO`/`INFORMACIÓN INSUFICIENTE`/`SIN CLASIFICAR`) with a decorative dot; a reader without colour still gets the level. The synthetic mark stays the word `Dato sintético` / `Sin marca sintética`. The empty card states absence in text, not by tint | Meets (measured + DOM) |
| 1.4.3 Contrast (Minimum) | Rendered computed pairs at 1440: panel heading 11.85:1, scope tag 4.87:1 (the shipped neutral-tag pair), toolbar label 5.49:1, table header 5.01:1, level mark 11.85:1, delivery title 11.85:1, fact label 5.49:1, fact value 11.85:1, hint/note/status 5.49:1, empty title 11.39:1, empty copy 5.28:1, model scope title 11.85:1, scope item 5.49:1, view title 10.93:1, lede 5.07:1. Lowest measured pair **4.87:1** | Meets |
| 1.4.11 Non-text Contrast | The painted focus ring `3px solid rgb(207, 125, 79)` on `--paper` measures **3.11:1** on every stop; the level dots are `aria-hidden` decoration repeating a text label, so nothing depends on their fill | Meets for the focus indicator |
| 1.4.10 Reflow | `document.documentElement.scrollWidth === window.innerWidth` at 1440, 1280, 1024, 390, 360 and 320 px, before and after. The five-column table does not fit a phone and keeps its own **one-direction** scroll region (390 px: `330` client / `576` scroll, 246 px internal; 360: 276 px; 320: 316 px). Tables are the explicit exception 1.4.10 allows; no page-level horizontal scrolling is introduced, and the width is intrinsic (removing the declared `min-width` still lays the table out at 576 px) | Meets (sampled) |
| 2.1.1 Keyboard | Tab order at 390 and 320 is unchanged: `#history-scope` → `#history-query` → `#history-status-filter` → the named table region (4th stop in both builds) → `#history-csv-download`. Six `ArrowRight` presses moved the region `79px` at both widths while `window.scrollX` stayed `0`. No `tabindex` above `0` was added | Meets (sampled) |
| 2.4.3 Focus Order | The sequence is identical to the baseline; the new delivery block adds no stop before the table and its single button keeps the existing position after the region. Every stop painted a `3px` ring | Meets (sampled) |
| 2.4.11 Focus Not Obscured (AA, WCAG 2.2) | The fixtures do not include the sticky product bar, so this was **not re-measured**; the view adds no fixed or sticky element of its own and the delivery block sits below the table in normal flow | Not measured (unchanged by this task) |
| 2.5.8 Target Size (Minimum) | New control: `Descargar CSV` `34px` high × `92px` (shipped secondary-button scale, above the 24 px minimum, below the 44 px recommendation); the table region is `117px` tall; the shipped selects are `37px`, the search input `38px`. No new small icon target was added | Meets the absolute minimum; 44 px not met for the shipped button scale |
| 3.2.5 Change on Request | The scope and granularity selects change the read inside the view (pre-existing behaviour); the export runs only on click; no link or control changes the route | Meets (source + DOM) |
| 4.1.2 Name, Role, Value | The selects keep their visible labels and accessible names; the download button keeps `aria-describedby="history-csv-note"` and its name; the region keeps its name; the delivery `<dl>` is read as a description list; no new widget or pressed state was invented | Meets (DOM) |
| 4.1.3 Status Messages | `#history-visible-count`, the series `#history-state` and `#history-csv-status` remain `role="status" aria-live="polite"`; the delivery block adds no second live region and reuses the existing export status for the saved/failed states | Meets (DOM) |

**The a11y test adaptation is not waived evidence.** `tests/a11y/table-scroll-regions.test.tsx` used to snapshot
the legacy three-column table (`toHaveLength(3)`). With five served columns it was replaced by an ordered assertion
of the visible header names (`Solicitado, Publicado, Nivel, Estado, Lote`) scoped to the history table. The named
scroll region, wrapper class, `tabindex`, `role`, `aria-label`, hidden-until-rows state and row count are unchanged
and still asserted; no other test in the file was touched. RED with the five-column table and the old count: the
test failed (`expected 3, got 5`), full suite `57` files / `1 failed | 772 passed (773)`. GREEN after: that suite
`6 passed (6)`; the six focused suites plus it `7 files / 151 passed (151)`; `npm run verify` exit 0 with
`57` files / `773` tests.

**Not measured for T5.** No axe scan, text-spacing override, browser-zoom pass, virtual screen reader or real
assistive technology ran for this change; no live authenticated session was used. **1.4.4** is unchanged and not
improved: the change adds `font-size` declarations in absolute `px`, as the rest of the scale does. Hover, active,
disabled and print states were not re-measured. The table's touch-drag scrolling was not exercised, and long real
content (a 100-row history, many series zones, a 64-character zone id) was not rendered.

## Open findings from the reader pass

Three defects were found by reading the live accessibility tree, not by automated rules:

1. **4.1.3 — the History result count was not announced.** Filtering from one row to none changed the count from `1 de 1` to `0 de 1` with no live region and no focus change, so a reader user received no confirmation that the action emptied the table. **Fixed and verified:** the view now exposes the count as a status message, matching the `role="status" aria-live="polite"` convention the shell, map, Actions and Audit views already use, and the reader logs `polite: 0 de 1` at both widths.
2. **Landmark nesting.** The shell footer rendered `contentinfo` inside `main`, which is not a valid landmark structure and made the footer part of the main region for navigation. **Fixed and verified:** the footer now sits after `main`, and the Chromium accessibility tree exposes exactly one `contentinfo` on all eight routes at both widths (16 of 16 samples).
3. **Unlabelled count.** The History count badge spoke only its bare number, so its meaning depended on visual position rather than on an accessible name. **Fixed and verified:** a visually hidden label precedes the badge in document order, and the virtual screen reader records `Lotes devueltos:` before the number at both widths.
4. **4.1.3 — the History result count was not announced.** Filtering from one row to none changed the count from `1 de 1` to `0 de 1` with no live region and no focus change, so a reader user received no confirmation that the action emptied the table. **Fixed and verified:** the view now exposes the count as a status message, matching the `role="status" aria-live="polite"` convention the shell, map, Actions and Audit views already use, and the reader logs `polite: 0 de 1` at both widths.

All four findings are closed. The shell controls the three that share markup; none of them changed a route or a contract.

## What still blocks a conformance claim

Both code conditions this report used to carry are closed (T9, 2026-11-27): the type scale is relative and
gated against absolute units (**1.4.4**), and every commune plate and outline measures at least 3:1 against
the surfaces it composites on (**1.4.11**). No code failure remains open against an applicable A or AA
criterion. What remains is evidence breadth, not a defect:

1. **State coverage.** Population, loading, error and partial-failure states were sampled, not enumerated. Of the four empty and filter states corrected on 2026-11-25, two have rendered evidence: the History panel filtered to zero offers and restores `Ver todo el periodo` at both widths, and the Actions selector is disabled while `/v1/users` returned 503, with the create control still enabled. The Overview no-lot sentence and the Actions filtered-empty block carry public-DOM tests only.
2. **Scope and the state behind it.** The criterion table was written for the eight views the application routed then. The three views the merge added — `InfrastructureView`, `ObservationsView` and `NotificationsView` — were scanned on 2026-11-25: 22 axe scans with zero violations, 22 structure samples, 22 text-spacing samples and 6 virtual-reader samples, all passing, after fixing one eyebrow contrast defect each (3.71:1, now the readable token) and the decorative Session glyph (4.03:1). The disposable stack was then rebuilt from the merged tree and the three views were measured again with data — nine alerts, the synthetic catalogue and two observations created through the page — with zero axe violations, no text-spacing loss across six samples and 44 rendered surfaces meeting 1.4.3. Two defects were fixed to get there: the infrastructure breakdown became a named, focusable scroll region, and the base eyebrow token became the readable one. Every other workflow behind those views rests on the merged suites, not on rendered evidence.
3. **No assistive technology.** A DOM virtual screen reader shows what the accessibility tree exposes and what a mutation announces; it is not NVDA, JAWS, VoiceOver or TalkBack. The same boundary applies to the T9 contrast arithmetic: it is the WCAG 2.1 formula applied to the shipped declarations, not a pixel sample of a composited canvas.
4. **Rendered text-only resize.** 1.4.4 is now closed on rendered evidence: Chrome 158.0.8127.38 measured every route at a 16 px and a 32 px root (T9), 756 of 756 samples doubling with no horizontal overflow. The fixture set behind that pass answers the gateway with empty payloads, so the views render their empty/unknown states rather than populated tables — a populated, long-content run at a 32 px root has not been made. Browser zoom at 200% was measured in Chromium on 2026-11-25 and is unaffected by this change.

## How to reproduce

Every row above is backed by an ignored probe in `tmp/g1-browser-baseline/workspace-audit.mjs`, gated by an `FW_*` environment variable (`FW_AXE_AUDIT`, `FW_MIXED_SURFACES`, `FW_VIRTUAL_READER`, `FW_KEYBOARD_NAV`, `FW_SKIP_AUDIT`, `FW_REFLOW_AUDIT`, `FW_BROWSER_ZOOM`, `FW_ZOOM_TABLES`, `FW_STRUCTURE_AUDIT`, `FW_FOCUS_GATE`, `FW_NAV_CONTRAST`, `FW_HISTORY_KEYBOARD`, `FW_MAP_KEYBOARD`, `FW_POPULATED`). Reports land beside it as `axe-*.json`, `mixed-surfaces.json` and `vo-audit/virtual-reader.json`. The probes need a disposable Compose stack and a Chromium build; they are deliberately not part of the repository test suite. The T1 navigation table was produced by a separate inline DevTools-protocol script against the local build and its intercepted fixture; it is not one of these probes and left no report file.

## T6 evidence — prevention, simulation and observations (2026-11-26)

T6 ports boards 06/10/11 into `#actions`, `#simulator` and `#observations`. The evidence below is scoped to those
three screens and does not restate or replace earlier per-criterion measurements; it is not a conformance claim.
Environment: isolated Chromium headless shell against `file://` fixtures rendered from the real components, base
tree (`7bf567f`) and working tree, same stubbed data; no network, credential, gateway or backend. Evidence:
`tmp/t6/{before,after}/`, `measure.json`, `preserve.json`, `keyboard.json`, `contrast.json`, `shots/`.

| Criterion | Measurement | Result |
| --- | --- | --- |
| 1.3.1 Info and Relationships | The alta is now two `<fieldset>`s with `<legend>`s (`Datos de la acción`, `Responsable y plazo`) around the same controls, in the same DOM order, with one `<button type="submit">` outside both. The selected action keeps its `<dl id="action-detail-fields">` (label/value pairs, now one pair per grid cell) and gains a `<p>` identity strip and a description block whose label is text, not a placeholder. The state cards are plain `<div>`s with a `<strong>` sentence; the observation list keeps `<ul>/<li>` and gains `aria-label="Observaciones registradas, más reciente primero"`; the record's type is text in a `<span>`. No id, landmark or ARIA attribute was renamed (19 + 22 actions ids, 13 + 13 simulator ids and 20 observations ids kept) | Meets (DOM + sampled) |
| 1.3.2 Meaningful Sequence | DOM order is unchanged: for `#actions` queue → detail → alta; for `#simulator` controls → result; for `#observations` register → list. The two-column workbench is CSS only and collapses to the shipped single column below 1280 px, so the order never depends on the layout | Meets (sampled) |
| 1.4.1 Use of Color | The state cards differ by words as well as surface (each carries its own eyebrow and sentence); the detail state is a chip with its label in the identity strip; the observation type is written text (`Vegetación seca`) inside a bordered mark; the `Sustituida` flag is the word itself. Removing colour leaves every state readable | Meets (DOM + measured) |
| 1.4.3 Contrast (Minimum) | Rendered computed pairs at 1440: actions lede 5.49:1, queue count 5.44:1, empty card 11.39 / 5.28 / 7.08:1 (title/body/eyebrow), error card 11.16 / 5.18 / 5.84:1, filtered card 11.85 / 5.49 / 7.36:1, detail identifier 11.85:1, deadline 5.49:1, description label 4.86:1, description text 10.47:1, detail fact label/value 5.49 / 11.85:1, alta legend 7.36:1, state chip 10.47:1, applied substitution 11.85:1, substituted flag 6.51:1, factor note 5.49:1, observation type mark 10.47:1, zone 11.85:1, error title 11.16:1. Lowest measured pair **4.86:1** | Meets |
| 1.4.10 Reflow | `document.documentElement.scrollWidth === window.innerWidth` at 1440, 1280, 1024, 390 and 320 px, before and after, in all twelve sampled states. The actions fact grid and both alta groups stack to one column (560 / 720 px); the workbench stacks below 1280 px because the seven-column queue would otherwise scroll inside a primary surface. The queue table and the detail tables keep their shipped one-direction scroll regions (390 px queue: `330` client / `892` scroll, identical to the base) | Meets (sampled) |
| 1.4.11 Non-text Contrast | The painted focus ring `3px solid rgb(207, 125, 79)` measures **3.11:1** on `--paper` and **2.99:1** on the `#f8faf7` empty surface. The one card that carries a control (the filtered queue's reset) therefore keeps the `--paper` fill and is separated by its dashed mark; the tinted cards carry no focusable control. The `Sustituida` flag and the type mark are text, so nothing depends on their border or fill | Meets for the focus indicator (the 2.99:1 surface is measured and not used behind a control) |
| 2.1.1 Keyboard | Tab order at 390 px is identical to the baseline in the four sampled states; the two fieldsets add no stop and reorder none. The list table region remains a named, focusable scroll region. No `tabindex` above `0` was added | Meets (sampled) |
| 2.4.3 Focus Order | The same sequence before and after: filters → queue region → `Ver detalle` → detail tables and evidence fields → review → reassessment → transitions → alta → submit. Every stop paints a `3px` ring | Meets (sampled) |
| 2.4.7 Focus Visible | A measured gap was corrected inside the task's own surface: the shipped `:focus-visible` rule lists `input`, `select`, `a` and `[tabindex]` but not `textarea`, so Chromium painted its own `1px auto` ring on `#evidence-criterion`, `#evidence-references` and `#observation-description`. The scoped sheet now gives the three views' textareas the shipped `3px solid #cf7d4f` ring with a `2px` offset (measured before `1px auto rgb(16, 16, 16)`, after `3px solid rgb(207, 125, 79)`) | Meets (measured) |
| 2.4.11 Focus Not Obscured (AA, WCAG 2.2) | The fixtures do not include the sticky product bar, so this was **not re-measured**; the change adds no fixed or sticky element of its own | Not measured (unchanged by this task) |
| 2.5.8 Target Size (Minimum) | No new control was added: the alta keeps its six shipped controls and one submit, the filtered card keeps the same reset button, and the simulator keeps its shipped controls. The shipped button scale is `34px` high (above the 24 px minimum, below the 44 px recommendation) and the checkboxes are the shipped native size with their labels | Meets the absolute minimum via the shipped scale; 44 px not met for the shipped button scale |
| 3.2.5 Change on Request | The filter form, the simulation submit and the observation write still run only on request; no control changes the route and no new automatic navigation was added | Meets (source + DOM) |
| 4.1.2 Name, Role, Value | Every control keeps its visible label and accessible name (`#create-assignee` keeps `aria-describedby="create-assignee-status"`, now inside the same group); the groups add native `fieldset`/`legend` names; the state cards are not widgets and expose no role; the row flag is text inside the row header, so the table keeps three columns | Meets (DOM) |
| 4.1.3 Status Messages | Each panel keeps exactly one live region: `#actions-status`, `#actions-notice`, `#action-detail-status`, `#reassessment-status`, `#create-assignee-status`, `#simulator-status`, `#simulator-run-status`, `#simulator-feedback`, `#observations-status`, `#observation-adoption-status`, `#observation-feedback` remain `role="status" aria-live="polite"`. The new state cards carry no `role="status"` and repeat no request id, so a refusal is announced once (pinned by `tests/a11y/actions-accessibility.test.tsx`) | Meets (DOM + test) |

**Test evidence.** Four tests were added to `tests/a11y/actions-accessibility.test.tsx` (group legends and
accessible names, one announcement per refusal with a card that has no live region, the textarea ring, the
filtered card's paper surface); no existing accessibility assertion was weakened. RED before the product edit:
`10 failed | 69 passed (79)`. GREEN after: the required seven suites `7 files / 108 passed (108)`; `npm run verify`
exit 0 with `57` files / `787` tests.

**Not measured for T6.** No axe scan, text-spacing override, browser-zoom pass, virtual screen reader or real
assistive technology ran for this change, and the workspace was not opened with a live authenticated session.
**1.4.4** was unchanged by T7 (the change added `font-size` declarations in absolute `px`, as the rest of the scale
did). **Superseded by T9 (2026-11-27), which converted the whole scale to `rem` and gates it.**
Long real content and the touch-drag gesture on the internal scroll regions were not exercised, and 2.4.11 was not
re-measured because the fixtures carry no shell.

## T7 evidence — access and operations (2026-11-26)

T7 ports boards 14–19 into the AUTH gate and `#sources`, `#status`, `#jobs`, `#session`, `#audit` and `#pending`.
The evidence below is scoped to those screens; it does not restate or replace earlier per-criterion measurements
and is not a conformance claim. Environment: isolated **Chromium 148.0.7778.96** (locally present Playwright build)
driving the real `App`/`Shell`/views/session module through a Vite fixture whose only substitution is `window.fetch`
(local token exchange and twelve gateway answers). No live gateway, Keycloak, credential or backend write. Evidence:
ignored `frontend/tmp/t7-evidence/` and `frontend/tmp/t7-evidence-base/` (base `dbcd7a9`), 27 samples each
(9 scenes × 1440×900, 1024×768, 390×844), `report.json` plus screenshots.

| Criterion | Measurement | Result |
| --- | --- | --- |
| 1.3.1 Info and Relationships | The seven screens keep their landmarks and ids (0 lost in 27 samples) and gain only structural text: a head `<div>` with `<p class="eyebrow">`, `<h2>` and lede, step lists as `<ol>/<li>`, state vocabularies as `<ul>/<li>`, and the auth contract as `<dl>` (label/value pairs). The step number is `aria-hidden` text, so the sentence carries the meaning. No table column, caption or `scope` changed; the register kept its eight columns and the permissions matrix its four | Meets (DOM + sampled) |
| 1.3.2 Meaningful Sequence | DOM order follows reading order: head → scope banner → main column → side column, with the side column moving under the main one at 1200 px (CSS only). `#audit` keeps register → legend because the eight-column table needs the full width. `#session` puts the matrix in the main column and the account at the side, so the wider answer comes first in both DOM and visual order | Meets (sampled) |
| 1.4.1 Use of Color | Every state is a word: the legend lists `Listo · Degradado · Desconocido · Requiere admin · No configurado`; the register legend names `Leído · Sin permiso · 403 · No disponible · Vacío`; the auth chip says `Sin sesión` / `Regresando de Keycloak` / `Sesión rechazada` / `Acceso no completado`; the pending count states the number. Removing colour leaves every state readable | Meets (DOM + measured) |
| 1.4.3 Contrast (Minimum) | Rendered computed colours against the declared background: `.ops-chip` 10.47:1, `.ops-lede`/`.ops-step p`/`.ops-states span`/`.ops-note` 5.49:1, step number 6.51:1, state labels and auth fact values 11.85:1, auth chip 8.95:1 (hero base token; its 4% white overlay only lightens), auth aside eyebrow 5.16:1, auth fact labels and state details 5.49:1. Lowest measured pair **5.16:1** | Meets |
| 1.4.10 Reflow | `document.documentElement.scrollWidth − clientWidth === 0` in all 27 samples at 1440, 1024 and 390 px (base tree: also 0). The two-column composition collapses to one column at 1200 px and the side reflows by width; nothing is clipped. Internal scroll is unchanged and named: the 390 px register `330/1001`, status table `330/1028`, pending inventory `330/1217` and permissions matrix `330/2256`; the matrix now needs **no** internal scroll at 1024+ (`730/730`, `744/744`) where the base had `389/520` | Meets (sampled) |
| 1.4.11 Non-text Contrast | No new interactive control, border-only state or colour-only mark was introduced: the new chips are text on `--soft`, the step numbers are text, and the legends are text lists. The existing controls keep the shipped `3px solid rgb(207, 125, 79)` ring; no new focus indicator was declared | Meets by construction (shipped indicator retained) |
| 1.4.4 Resize Text | The head title is `clamp(22px, 2.2vw, 24px)` and every other new size is the shipped absolute `px` scale (9, 10, 11, 15px), exactly as the rest of the product declares type. No new `vh`/`vw` text, no truncation was added; 200% text resize was **not exercised** | Not measured |
| 2.1.1 Keyboard | Sixteen `Tab` presses per scene and viewport: the new blocks add no stop (control counts identical to the base in all 27 samples). Reachable in order: `#audit-table` and the session matrix (named scroll regions), `#scenario-select`, `#create-job`, `#account-console`, `#audit-refresh`, `#readiness-refresh`, `#logout`, `#data-status-notice`, `#reset-filters`, the two auth tabs, `#register`/`#login` and the inline switch. `#refresh-job` is absent while the job is unknown because it is honestly disabled. No `tabindex` above `0` was added | Meets (sampled) |
| 2.4.3 Focus Order | The measured sequence matches the base tree: the added content sits between existing regions and adds no control, so no stop changed place. The auth gate keeps one tab stop for the selected tab (roving tabindex) | Meets (sampled) |
| 2.4.7 Focus Visible | Every recorded stop except the document body painted `solid 3px`: `rgb(207, 125, 79)` on paper, `rgb(215, 170, 115)` in the product bar, `rgb(167, 77, 52)` on the canvas/skip link. The new elements are non-focusable and inherit the shipped rule | Meets (measured) |
| 2.4.11 Focus Not Obscured (AA, WCAG 2.2) | The fixture includes the real sticky product bar. No new sticky or fixed element was added and the new heads sit in normal flow, so the change adds no occlusion of its own. A geometric check of a focused control against the sticky bar was **not** performed | Not measured (unchanged by this task) |
| 2.5.8 Target Size (Minimum) | No new control: the auth gate keeps its two tabs, two primary buttons (one per tab), optional Google buttons and inline switches; the other six screens keep exactly their shipped controls (identical counts in 27 samples). The shipped button scale stays as it was | Meets the absolute minimum via the shipped scale; 44 px not met for the shipped scale |
| 3.2.5 Change on Request | The state chips, legends, steps and facts are static text. Nothing new requests, navigates or refreshes; the job request, audit refresh, sign-in and sign-up still run only on request | Meets (source + DOM) |
| 4.1.2 Name, Role, Value | No ARIA role was added except the auth state group's existing label pattern (`role="group" aria-label="Estado de la entrada"`), the lists and headings are native, and the auth screen still renders **no** `input`, `textarea`, `select` or `form`. The register table keeps its caption and column headers; the matrix keeps its four columns and named region; `#audit-badge`, `#sources-badge`, `#pipeline-badge`, `#job-status`, `#session-roles` and the pending ids keep their roles and ids | Meets (DOM) |
| 4.1.3 Status Messages | The live regions are unchanged: `#auth-status`, `#sources-status`, `#pipeline-status`, `#cycle-status`, `#operational-verdict-announcement`, `#status-verdict`, `#job-status`, `#session-roles-status`, `#auth-status` (session), `#audit-status` and the existing shell regions stay `role="status" aria-live="polite"`. The new heads, steps and legends carry no live role, so no state is announced twice; the sources verdict announcement test still pins one announcement per transition | Meets (DOM + test) |

**Test evidence.** Eight public-behaviour tests were added (two auth, one per remaining view) and seven existing
a11y assertions in `tests/a11y/heading-hierarchy.test.tsx` and `tests/a11y/table-scroll-regions.test.tsx` were
extended; no existing accessibility assertion was weakened. RED before the product edit: `11 failed | 121 passed
(132)` across the nine touched suites. GREEN after: the required focused command `11 files / 176 passed (176)`;
`npm run verify` exit 0 with `57` files / `795` tests.

**Not measured for T7.** No axe scan, text-spacing override, browser-zoom or 200% text-resize pass, virtual screen
reader or real assistive technology ran for this change, and no live authenticated session, gateway or Keycloak was
used. Only 1440×900, 1024×768 and 390×844 were sampled. Long real content, hover/active/print surfaces of the new
blocks and landscape phones were not exercised. **1.3.4 Orientation**, **1.4.12 Text Spacing** and **1.4.13 Content
on Hover or Focus** are unchanged by this presentation-only change and were not re-run.

## T8 evidence — integrated proof and the retired sidebar rule (2026-11-27)

T8 removes the dead `.sidebar nav` rule from the shared stylesheet, replaces the source-gate assertion that read it
with the active product-bar/menu contract, and re-measures the whole built application. The evidence below is
scoped to the shell and the five read screens it exercises; it does not restate or replace earlier per-criterion
measurements and is not a conformance claim. Environment: isolated **Chromium 148.0.7778.96** driving the real
built `dist/` through the shipped code path, with `window.fetch` replaced by a synthetic fixture table and the
identity provider's document navigation replaced by a 302 that echoes the app's own `state` and `redirect_uri`. No
live gateway, Keycloak, credential or backend write. Evidence: ignored `frontend/tmp/t8-evidence/` (`report.json`,
`preserve.json`, 25 screenshots). The probe, fixture server and fixture table were run from OS-temp scratch
(`fw-t8-probe/`) because `eslint .` lints the whole project, and the before tree (`git archive 8d1951e`) was
extracted and built there too (`fw-t8-base-8d1951e/`), not in a worktree. OS temp is ephemeral; the recorded
artifacts are the durable evidence. The matrix was not repeated for the gate/documentation correction, which
changes no runtime file.

60 samples per tree (15 hashes × 1440×900, 1024×768, 390×844, 320×800): 0 console errors, 0 page errors, 0 failed
requests, 0 px page overflow, 0 unmatched fixture calls, and **0 structural or geometric differences against
`8d1951e`**. The served CSS is byte-identical to the before asset once the removed rule is stripped.

| Criterion | Measurement | Result |
| --- | --- | --- |
| 1.3.1 Info and Relationships | The shell keeps one `<nav>` landmark (`nav.product-nav`, `aria-label="Navegación del producto FireWatch"`), one `<aside>` column with no list inside it, one `<main id="content">` and one `contentinfo`; the 15-view id set is identical to `8d1951e` in all 60 samples. Removing a CSS rule adds or renames no element and no ARIA attribute | Meets (DOM + sampled) |
| 1.4.3 Contrast (Minimum) | No colour declaration changed. The bar's labels, the panel's labels and the two focus rings were already measured (`#d7aa73` 5.66:1 on the bar and 5.17:1 on the panel; `#cf7d4f` 3.11:1 on paper); the dead rule declared no colour | Not re-measured (unchanged by this task) |
| 1.4.10 Reflow | `documentElement.scrollWidth − innerWidth === 0` in all 60 samples at 1440, 1024, 390 and 320 px, on every one of the 15 hashes, in both trees. The 320 px bar wraps to `89 px` and the column starts below it; the menu stays inside the viewport (`92–572` at 320×800). The 640×450 CSS-px sample (the layout of a 1280×900 window at 200 % browser zoom) has page overflow `0` on five screens | Meets (sampled) |
| 1.4.11 Non-text Contrast | No boundary, icon or focus indicator changed: the removed rule had no rendered consumer, and the bar, panel, chip and control boundaries keep their measured values | Not re-measured (unchanged by this task) |
| 1.4.4 Resize Text | The change declares no `font-size` and no viewport-relative text. 200 % **text** resize was not exercised; the 640×450 reflow substitute above is a layout sample, not a text-resize pass | Not measured |
| 2.1.1 Keyboard | First Tab is `Saltar al contenido`; Enter moves focus to `main#content` without changing the hash. Tab reaches the four shortcuts and `Más destinos`; Enter opens the panel, Tab reaches its 11 destinations, Escape closes it and returns focus to the button. `#logout` is reachable, enabled, `tabIndex 0`, inside the viewport and hit-testable at all four viewports | Meets (measured) |
| 2.4.3 Focus Order | Visual and DOM order agree: skip link → bar shortcuts → disclosure → column → view. Back returns to `#overview` with the panel closed; Forward returns to `#status` and reveals the current destination inside the panel. The order matched `8d1951e` member by member | Meets (measured) |
| 2.4.7 Focus Visible | Every recorded stop except the document body painted a solid `3px` ring: `rgb(207, 125, 79)` on paper and for `#logout`, `rgb(215, 170, 115)` in the product bar, and `rgb(167, 77, 52)` on the skip link and canvas controls (the terracotta override). No stop in any of the four journeys was unringed | Meets (measured) |
| 2.4.11 Focus Not Obscured (AA, WCAG 2.2) | **Closed menu:** `#logout` is inside the viewport and hit-testable at all four viewports. **Open menu:** the panel is out of flow, so opening it moves neither the shell nor the column (`48 → 48` at 1440/1024/390, `89 → 89` at 320), and Escape closes it and returns focus to the disclosure. But non-movement is not non-occlusion: the measured panel box overlaps the sign-out control at 320 and 390 — panel `y 51–531` at 390 (`x 8–382` from `right: 8px; width: calc(100% - 16px)`) against `#logout` at `x 300–368, y 246–271`, and panel `y 92–572`, `x 8–312` at 320 against `x 230–298, y 287–312`. At 1440/1024 the panel's `y 51–376` does not reach the logout row | Partly measured — closed state meets; open overlay at 320/390 not established |
| 2.5.8 Target Size (Minimum) | No control changed. The bar's five controls keep `min-height: 40px`; the panel rows keep `32px`; `#logout` measured `39 px` tall at 1440 and `25.5 px` at 390/320, above the 24 px absolute minimum | Meets the absolute minimum; 44 px not met for the shipped scale |
| 4.1.2 Name, Role, Value | No ARIA attribute was added, removed or renamed. The disclosure keeps `aria-expanded`/`aria-controls`/`aria-current`; the skip link keeps its link role and name; the four keyboard journeys and the back/forward sequence change neither | Meets (DOM + measured) |
| 4.1.3 Status Messages | The live regions are unchanged (`#readiness-status`, `.product-nav__where`, `#history-state`, `#notifications-status`, `#audit-status` …); 24 fixture calls were answered with no duplicate announcement path added by this change | Meets (DOM) |

**Test evidence.** One layout test was added (`tests/styles/layout-padding.test.tsx`): it pins that the column renders
no `<nav>`, that `.sidebar nav` is gone from the shipped stylesheet, and that the column keeps `overflow-y: auto`,
the bar offset and the viewport-bounded height. RED before the cleanup: `1 failed | 4 passed (5)` in that file,
failing only on the dead-rule assertion. GREEN after: `4 files / 46 passed (46)` in the required focused command;
`npm run verify` exit 0 with `57` files / `796` tests and the source gate over `78` shipped files. No existing
assertion was weakened or removed. The gate's §7 was then hardened and proven by mutation on isolated copies: it
now removes comments, collapses whitespace and compares exact intended values (`top: 0`/`0px`,
`min(70dvh, 520px)`, and `min(72dvh, 480px)` at `≤720px`). The shipped declarations pass; `top: 0.5rem` and a
desktop or mobile `max-height: 9999px` fail their own invariants; and the values the previous guard accepted by
token matching — `top: 0foo` and `min(9999px, 9999px /* 70dvh */)` in either rule — now fail too. Each mutation ran
on its own copy, so no tracked CSS was written. That correction edits only `scripts/check.mjs` and documentation; no
runtime file changed, so the measurements above remain current and the browser matrix was not repeated.

**Not measured for T8.** No axe scan (`@axe-core/*` is not installed and installing it was out of scope), no
text-spacing override, no browser-zoom control, no virtual screen reader or real assistive technology, no live
gateway/Keycloak session and no real token. Signed-out access is the fixture's gate, not a live realm
configuration. Landscape phones, 768 px and 1280 px were not sampled. **1.3.4 Orientation**, **1.4.12 Text
Spacing**, **1.4.13 Content on Hover or Focus**, forced colors and print were not re-run: this is a
presentation-only removal in a rule with no rendered consumer.

## T9 evidence — relative type scale and measured map contrast (2026-11-27)

T9 closes the two code conditions §«What still blocks a conformance claim» carried. It changes no markup, no
route, no id and no ARIA attribute: it converts the type scale and lifts two map plates, and it adds the gate
that keeps both measurable. Environment: the repository's own runner — **Vitest 5.0.4** on **jsdom 29.1.1**,
TypeScript 6.0.3, no browser, no credential, no gateway and no backend. Base branch
`feat/firewatch-design-migration` at `8c147a3`.

**Tooling, precisely.** `tests/a11y/wcag-conformance.test.ts` reads the shipped `src/styles/*.css` with a brace
walker that strips comments, keeps `@media` wrappers apart from the rules inside them and merges repeated
selectors the way the cascade does, and it reads `src/components/map/*.tsx` as source. Contrast is the WCAG 2.1
relative-luminance formula (`0.2126 R + 0.7152 G + 0.0722 B` over `((c/255 + 0.055) / 1.055) ^ 2.4`) with the
`(L1 + 0.05) / (L2 + 0.05)` ratio; a translucent plate is composited with `alpha · F + (1 − alpha) · B` in sRGB
bytes. Nothing is eyeballed and nothing is sampled from a screenshot.

| Criterion | Measurement | Result |
| --- | --- | --- |
| 1.4.4 Resize Text | `src/styles/*.css` declared **293** `font-size` declarations, every one in absolute `px` (`rem` appeared only inside the word "removed"). All 12 stylesheets were converted at exactly `px / 16`: 287 single values (`10px` → `0.625rem`, `9px` → `0.5625rem`, `7px` → `0.4375rem`, `9.5px` → `0.59375rem`); the 6 remaining `clamp()` headings kept a `vw`/`dvh` middle in the first pass and were then found by the browser pass to miss 200% — the type scale has **no `clamp()` and no viewport unit left**, and the six are `rem` steps (`.auth-hero h1` 1.5 → 2.2 → 2.4 rem at 600/960 px, `h1` 1.6875 → 2 → 2.3125 rem at 1080/1480 px, `.auth-panel-body h2` 1.1875 rem, `.ops-view-head h2` 1.5 rem), which is where the two extra declarations come from: the stepped scale ends at **295** `font-size` declarations (293 baseline → 295 stepped `rem`). No other property changed: spacing, tracking, radii and borders keep their `px`. The gate evaluates every declared size at a 16 px and a 32 px root on two reference viewports and fails below 2×, rejects any `px`/`pt`/`pc`/`in`/`cm`/`mm`/`q` token in a `font-size` **or `font`** value — `13px !important`, `13 px` and a `font:` shorthand included — and rejects an inline `fontSize` in `src/components/map/*.tsx`. Headless Chrome 158.0.8127.38 then confirmed it on the built app: 15 routes × 3 viewports + the sign-in screen × 3 viewports, 756/756 samples doubled, 0 px horizontal overflow at either root | Meets (gate + rendered 32 px-root pass) |
| 1.4.11 Non-text Contrast | Every commune state is measured on both maps against the three surface roles it actually composites on: `--canvas #0f1922`, `--aerial-water #152934` and `--surface-raised #243341` (the lightest stop of the inset thumbnails' radial gradient, the hardest surface in the scene). **Before:** `.zone-neutral` at `fill-opacity: .34` measured 1.62 / 1.60 / 1.55 and `.level-desconocido` at `.22` measured 1.68 / 1.71 / 1.67. **After** — aerial stage fill, canvas / water / raised: `bajo` 5.46 / 4.73 / 4.19, `medio` 6.54 / 5.65 / 4.98, `alto` 4.45 / 3.85 / 3.40, `desconocido` 10.83 / 9.16 / 7.88, `neutral` 4.76 / 4.03 / 3.47; the 2D map paints the same tokens opaque (`bajo` 7.20 / 6.09 / 5.24, `medio` 8.78 / 7.43 / 6.39, `alto` 5.80 / 4.91 / 4.22, `neutral` 4.76 / 4.03 / 3.47); the reserved `extreme` role measures 5.38 / 4.55 / 3.91. The **outline** is measured as paint, not as a colour name: the level outlines are `--level-*-line` at **4.99–13.71**, and the two plates that share the system boundary carry `--edge-strong #6b8395`, which measures **4.49 on `--canvas`, 3.79 on `--aerial-water` and 3.27 on `--surface-raised`** — 3.27 is the lowest outline figure anywhere in the map and it clears the 3:1 minimum on every measured surface. Both parts are required to clear 3:1 — the stricter reading of "fill **or** stroke", and the only one that makes the state itself perceivable: the shared `--edge-strong` outline cannot tell `neutral` from `desconocido`, and those two plates still differ from each other by 2.27:1 | Meets (33 measurements, all ≥ 3.0:1, compared unrounded) |
| 1.4.3 Contrast (Minimum) | The plate fix must not be paid for by text. Every `--level-*-text` on its own `--level-*-surface` and every `--level-*-ink` on its own `--level-*-fill` pair was re-measured: 8.83 / 9.31 / 8.32 / 7.67 / 9.49 / 9.11 and 7.11 / 8.67 / 5.73 / 5.31 / 10.69 / 4.70. No token changed | Meets (12 pairs, all ≥ 4.5:1) |
| 1.4.10 Reflow | No box, width, padding or border changed — the conversion touches `font-size` only, and `rem` at a 16 px root resolves to the same computed value. No view's content was re-flowed | Not re-measured (unchanged by this task) |
| 2.5.8 Target Size (Minimum) | No control gained or lost a target: `min-height`/`min-width`/`padding` declarations are untouched | Not re-measured (unchanged by this task) |

**Two map plates changed, and the design record moves with them.** The aerial stage used to dim the unread and
`desconocido` plates so the illustrative canvas relief showed through. A 3:1 minimum against a near-black
backdrop is arithmetically impossible for a dark translucent wash — it requires a mid-tone plate — so the dimming
was removed rather than tuned: `#overview .map-3d .zone-neutral` and `#overview .map-3d .level-desconocido` now
paint their measured token fill at full strength and keep the `--edge-strong` outline. The three severe levels
keep `fill-opacity: .84`, so the relief still shows under every published severity. This is a deliberate,
measured design change, recorded in `VISUAL-BASELINE.md`; it is not a silent restyle.

**Test evidence.** The suite is new (`frontend/tests/a11y/wcag-conformance.test.ts`, 6 tests). RED before the
product edit: `4 failed | 2 passed (6)`, failing only on the intended contracts — the `293` absolute font sizes the scale
then carried (the pre-step count; the stepped scale ends at 295), the
six `clamp()` bounds, the `10px` SVG label and six sub-3:1 plate measurements (`1.55:1`–`1.71:1`). GREEN after:
`6 passed (6)`; the neighbouring `tests/styles/aerial-workspace.test.tsx` still passes with its opacity guard
rewritten from `fill-opacity < 0.5` to the measured `>= 0.88` contract, and the two literal px assertions in
`tests/a11y/heading-hierarchy.test.tsx` were updated to their exact `rem` equivalents (`0.9375rem`,
`0.6875rem`) — no assertion was weakened or removed. Whole suite: `63 files / 870 passed (870)`;
`npm run verify` exit 0.

### Correction pass — what the browser found that the source gate could not (2026-11-27)

An independent verification pass ran the built application in Chromium at a 32 px root and reported four
blockers. All four were reproduced, fixed here, and are now regression-tested.

**1. The `clamp()` headings failed 200% text resize.** The first pass had made only the two *bounds* of each
`clamp()` relative; a `vw`/`dvh` preferred term does not move when the root font does, so the used size stalled.
Measured at 1280×800 with the gate's own evaluator: the sign-in hero `clamp(1.5rem, min(3vw, 4.8dvh), 2.5rem)`
went **38.40 px → 48.00 px (1.25×)**; `clamp(1.5rem, 4.4dvh, 2.5rem)` 35.20 → 48.00 (1.36×); `h1`
`clamp(1.6875rem, 2.5vw, 2.3125rem)` 32.00 → 54.00 (1.69×); `.ops-view-head h2` `clamp(1.375rem, 2.2vw, 1.5rem)`
24.00 → 44.00 (1.83×); the phone hero 25.74 → 46.00 (1.79×). The type scale has **no `clamp()` and no viewport
unit left**: each of the six became `rem` steps at the widths where the clamp used to reach those values, so the
16 px-root geometry is unchanged and every step doubles. The gate no longer pattern-matches units — it evaluates
every declared size at a 16 px and a 32 px root on two reference viewports (1280×800, 390×844) and fails anything
below 2×.

**2. Three mutation escapes in the gate itself.** Each is now a test that fails if the gate regresses:

- a `font-size: 13px !important` (and `13 px`, `12pt`, a `font:` shorthand, a size inside `@media print` or
  `@supports`) escaped because the scan shared the rule walker and stripped `!important` first. It now reads the
  raw comment-stripped text for `font-size` **and** `font`, and matches a number-unit pair with optional whitespace.
- a **2.9999:1** ratio passed because the comparison rounded to two decimals first. `contrast()` now returns the
  raw float and the gate compares `ratio >= 3`; the fixture pair `#606565` on `--canvas` (2.99946:1, prints as
  3.00) is asserted to fail.
- a translucent stroke passed because the gate read the named colour and ignored `stroke-opacity`, `rgba()`,
  `hsla()` and 8-digit hex. Every paint is now resolved to colour **and** alpha, multiplied by `fill-opacity` /
  `stroke-opacity`, and composited over the backdrop before the ratio; a 20%-opaque `--edge-strong` outline is
  asserted to be reported (it measures ~1.13:1, not the 5.79:1 of the opaque colour).

RED was observed before the fix: with the pre-correction gate logic restored and the new tests in place the suite
reported `4 failed | 6 passed (10)` — the clamp sweep, the spaced unit, the rounded 2.9999 and the translucent
outline; after the gate and the type scale were corrected it reports `10 passed (10)`.

**3. Doubling the text exposed horizontal overflow, and the fix is measured.** With the headings finally doubling,
30 of 45 route/viewport runs scrolled horizontally at a 32 px root (101 px at 390, 171 px at 320; none at 1280).
The offenders were found by walking the live layout in Chromium and each is fixed where it was measured: `nowrap`
chips that could not break (`.neutral-tag`/`.dataset-badge`/`.admin-tag`/`.count-badge`/`.small-label`,
`.technical-notice`, `.ops-chip`), a no-wrap shell lead row (`.topbar-lead` — the brand and route block now stack
the same way they already did at every 16 px-root width), and inline `code` tokens with no break opportunity
(`overflow-wrap: anywhere`, kept as a safeguard: the measured cause of the last 19 px was `.ops-chip`). Final run:
**45 of 45 runs with 0 px horizontal overflow at 16 px and at 32 px root.**

**4. Browser environment for the resize evidence.** Headless **Chrome 158.0.8127.38** driven over the Chrome
DevTools Protocol, serving the built `dist/` on an **ephemeral 127.0.0.1 port** (never the dev server's pinned
4173) from a per-run `mktemp -d` scratch under the OS temp directory, removed on exit (one Chrome profile
directory was still locked by an orphaned headless renderer; the process tree was stopped and the scratch then
removed, leaving no browser process or temp directory behind). The only substitution is `window.fetch`: the token endpoint
answers a syntactically valid JWT and every gateway call answers `{}`, so the 15 authenticated routes render their
honest empty/unknown states and the sign-in screen renders signed-out. No credential, gateway, Keycloak or backend
write was involved. Result: **15 routes × 3 viewports (1280×800, 390×844, 320×800) = 606 text samples and the
sign-in screen × 3 viewports = 150 samples; 756 of 756 doubled, minimum ratio 2.0000, 0 overflow.**

**Not measured for T9.** No axe scan, no text-spacing override, no virtual screen reader and no real assistive
technology ran for this change, and the resize matrix used empty gateway payloads, so populated long-content views
were not re-measured at a 32 px root (the independent pass had richer fixtures and 1,267 samples; this pass has
756). The 1.4.11 numbers are the WCAG formula applied to the shipped declarations, not a pixel sample of the
composited canvas: the illustrative relief painted under a plate is genuinely lighter than the measured backdrop,
so a rendered sample can only read *higher* than the composite measured here, which is why the measurement uses
the darkest two roles and the lightest inset stop as its bounds. Forced colors, print, landscape phones and the
views the merge added beyond the eight in the criterion table were not re-sampled.
