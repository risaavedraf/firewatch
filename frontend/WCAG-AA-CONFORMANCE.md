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
| 1.4.4 Resize Text (AA) | Partly met | Chromium tab zoom at 200% (1280→640 CSS px) passed on all eight routes. Text-only resizing — the actual 1.4.4 condition — is not supported by the current type scale: `src/styles/*.css` carries 123 `font-size` declarations in absolute units and `rem` appears twice, so a browser default-font-size change cannot scale the text. Meeting 1.4.4 means moving the type scale to relative units, which is a design-system change, not a local fix. |
| 1.4.5 Images of Text (AA) | Meets (sampled) | No raster text in the shell or the audited views; the brand mark is a text glyph, and headings are real text. |
| 1.4.10 Reflow (AA) | Meets (sampled) | At 320 CSS px all eight routes measured a 320 px document scroll width, and at 200% zoom a 640 px width. Pending, Session and Audit expose one internal horizontal scroller each, reachable with Tab and movable with ArrowRight. The T1 navigation was measured at 1440, 1280, 1024, 720, 390 and 320 CSS px on 2026-11-26 and produced no horizontal page overflow at any of them. |
| 1.4.11 Non-text Contrast (AA) | Partly met | Focus indicators pass (5.11:1, 44 instances). Several map boundaries and fills are documented below 3:1 against the map surface: medium fill 1.75:1, neutral fill 1.45:1, low fill 2.26:1, unknown fill 1.45:1, medium boundary 2.54:1, neutral boundary 1.95:1. Whether a fill is "required to identify" the level in context is a product judgement this pass does not settle. The corrected T1 navigation's disclosure boundary measures 4.84:1, its focus ring 5.66:1 on the bar and 5.17:1 on the panel; all were read from rendered pixels in Chromium on 2026-11-26. |
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

The corrected T1 change puts the navigation in a thin horizontal bar above and outside the workspace, with three always-visible shortcuts, an out-of-flow **Más destinos** panel for the other eleven destinations, and an **Estás en** line naming the open route. Routing, titles, the session gate, the store and the role policy did not change. The evidence below is scoped to that navigation; it does not restate or replace the earlier per-criterion measurements.

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

## Open findings from the reader pass

Three defects were found by reading the live accessibility tree, not by automated rules:

1. **4.1.3 — the History result count was not announced.** Filtering from one row to none changed the count from `1 de 1` to `0 de 1` with no live region and no focus change, so a reader user received no confirmation that the action emptied the table. **Fixed and verified:** the view now exposes the count as a status message, matching the `role="status" aria-live="polite"` convention the shell, map, Actions and Audit views already use, and the reader logs `polite: 0 de 1` at both widths.
2. **Landmark nesting.** The shell footer rendered `contentinfo` inside `main`, which is not a valid landmark structure and made the footer part of the main region for navigation. **Fixed and verified:** the footer now sits after `main`, and the Chromium accessibility tree exposes exactly one `contentinfo` on all eight routes at both widths (16 of 16 samples).
3. **Unlabelled count.** The History count badge spoke only its bare number, so its meaning depended on visual position rather than on an accessible name. **Fixed and verified:** a visually hidden label precedes the badge in document order, and the virtual screen reader records `Lotes devueltos:` before the number at both widths.
4. **4.1.3 — the History result count was not announced.** Filtering from one row to none changed the count from `1 de 1` to `0 de 1` with no live region and no focus change, so a reader user received no confirmation that the action emptied the table. **Fixed and verified:** the view now exposes the count as a status message, matching the `role="status" aria-live="polite"` convention the shell, map, Actions and Audit views already use, and the reader logs `polite: 0 de 1` at both widths.

All four findings are closed. The shell controls the three that share markup; none of them changed a route or a contract.

## What still blocks a conformance claim

1. **Text-only resize (1.4.4).** The type scale is absolute: 123 `font-size` declarations in `src/styles/*.css`, `rem` twice. Browser zoom at 200% passes, but the criterion's own condition — text resized without zooming the layout — is not supported. Scope of a fix: move the type scale to relative units and re-verify every view at both widths.
2. **Map non-text contrast (1.4.11).** Fill and boundary pairs remain below 3:1 (medium 1.75:1, neutral 1.45:1, low 2.26:1). Whether each pair is essential or decorative is a product decision that changes the map palette, not a local style fix.
3. **State coverage.** Population, loading, error and partial-failure states were sampled, not enumerated. Of the four empty and filter states corrected on 2026-11-25, two have rendered evidence: the History panel filtered to zero offers and restores `Ver todo el periodo` at both widths, and the Actions selector is disabled while `/v1/users` returned 503, with the create control still enabled. The Overview no-lot sentence and the Actions filtered-empty block carry public-DOM tests only.
4. **Scope and the state behind it.** The criterion table was written for the eight views the application routed then. The three views the merge added — `InfrastructureView`, `ObservationsView` and `NotificationsView` — were scanned on 2026-11-25: 22 axe scans with zero violations, 22 structure samples, 22 text-spacing samples and 6 virtual-reader samples, all passing, after fixing one eyebrow contrast defect each (3.71:1, now the readable token) and the decorative Session glyph (4.03:1). The disposable stack was then rebuilt from the merged tree and the three views were measured again with data — nine alerts, the synthetic catalogue and two observations created through the page — with zero axe violations, no text-spacing loss across six samples and 44 rendered surfaces meeting 1.4.3. Two defects were fixed to get there: the infrastructure breakdown became a named, focusable scroll region, and the base eyebrow token became the readable one. Every other workflow behind those views rests on the merged suites, not on rendered evidence.
5. **No assistive technology.** A DOM virtual screen reader shows what the accessibility tree exposes and what a mutation announces; it is not NVDA, JAWS, VoiceOver or TalkBack.

## How to reproduce

Every row above is backed by an ignored probe in `tmp/g1-browser-baseline/workspace-audit.mjs`, gated by an `FW_*` environment variable (`FW_AXE_AUDIT`, `FW_MIXED_SURFACES`, `FW_VIRTUAL_READER`, `FW_KEYBOARD_NAV`, `FW_SKIP_AUDIT`, `FW_REFLOW_AUDIT`, `FW_BROWSER_ZOOM`, `FW_ZOOM_TABLES`, `FW_STRUCTURE_AUDIT`, `FW_FOCUS_GATE`, `FW_NAV_CONTRAST`, `FW_HISTORY_KEYBOARD`, `FW_MAP_KEYBOARD`, `FW_POPULATED`). Reports land beside it as `axe-*.json`, `mixed-surfaces.json` and `vo-audit/virtual-reader.json`. The probes need a disposable Compose stack and a Chromium build; they are deliberately not part of the repository test suite. The T1 navigation table was produced by a separate inline DevTools-protocol script against the local build and its intercepted fixture; it is not one of these probes and left no report file.
