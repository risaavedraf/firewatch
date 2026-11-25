# FireWatch production visual audit

Baseline: `742e760`; the existing prototype at `docs/pitch-g1-design` (`d651459`) is a design reference, not the runtime. This first pass compares sampled production styles against the [visual baseline](VISUAL-BASELINE.md). It does not describe the entire prototype-to-product delta.

Chromium rendered the eight production routes after a real admin sign-in on the disposable stack at 1280×720 and 390×844. No horizontal page overflow or uncaught page errors were observed. The sixteen before captures are under ignored `tmp/g1-browser-baseline/before-<route>-<width>.png`. Captures establish that each view rendered, not that every asynchronous data state settled before the screenshot.

| View | Baseline observation |
| --- | --- |
| Actions | Sampled neutral tag uses the existing Actions override, 10.51:1 (`src/styles/app.css:388`). Keep it unchanged. |
| Audit | Neutral tag is 4.27:1 at 8 px, below 4.5:1 (`src/styles/app.css:117`, `src/views/AuditView.tsx:147`). |
| History | Route rendered; no targeted contrast selector was sampled. Populated, empty and filter states still need inspection. |
| Jobs | Sampled primary button text is 11.65:1. Job progress, error and completion states not audited. |
| Overview | Neutral tag is 4.27:1 at 8 px, below 4.5:1 (`src/styles/app.css:117`, `src/views/OverviewView.tsx:608`). |
| Pending | Sampled table header uses `#5c6c65` on `#f3f4ed`; the pair is documented in the baseline. No deviation established for this sample. |
| Session | Neutral tag is 4.27:1 at 8 px, below 4.5:1 (`src/styles/app.css:117`, `src/views/SessionView.tsx:297`). |
| Sources | Neutral tag is 4.27:1 at 8 px, below 4.5:1 (`src/styles/app.css:117`, `src/views/SourcesView.tsx:204`). |

## Existing design alignment

Reference locations are under `design/firewatch-v1-vuelo/` at `d651459`. Compare the active artboard section only: most files embed multiple hidden views. This is a source-based hierarchy comparison, not a pixel-diff or approval to change product contracts.

| Production view | Reference and implication |
| --- | --- |
| Overview | `01-vista-aerea.html:69` opens a map-first explorer; `src/views/OverviewView.tsx:601` opens with zone status. This is a structural gap. Do not copy the artboard's terrain or fictional data into the runtime. |
| History | `05-historial-de-lotes.html:1056` and `src/views/HistoryView.tsx:155` both lead with lot history. Keep this separate from the PM-04 aggregation contract. |
| Actions | `06-acciones-preventivas.html:1151` presents list, detail and creation. `src/views/ActionsView.tsx:694,818,1162` already provides those sections with real evidence and lifecycle controls. Do not replace them with illustrative states. |
| Sources | `15-fuentes-y-servicios.html:841` emphasizes provenance and explicit gaps. `src/views/SourcesView.tsx:202,257,289` has separate provenance, dependencies and freshness sections; assess PM-16's real operational verdict separately rather than duplicating it. |
| Jobs | `16-procesamiento.html:1021` emphasizes the server's publication and confirmation. `src/views/JobsView.tsx:459` provides the asynchronous workspace. Verify loading and publication-result hierarchy with an actual disposable job before restyling. |
| Session | `17-sesion-y-permisos.html:1157` separates account and permission information. `src/views/SessionView.tsx:239,294,317` already has that structure. Navigation and presentation changes must not grant permissions. |
| Audit | `18-registro-de-actividad.html:1274` shows example recent events and detail. `src/views/AuditView.tsx:140,144` is the actual activity route. Inspect a populated result before proposing detail changes; never copy illustrative fields. |
| Pending | `19-aun-no-implementado.html:1360` is a visual inventory. `src/views/PendingView.tsx:69,73` is the real inventory. Its content follows shipped capabilities, not the artboard's frozen count. |

## First correction: neutral tag contrast

The shared neutral tag now uses `--muted` on the same `#edf1f2` background. Before the change, the browser contrast gate failed for eight samples (four views at two sizes). After the change, all ten samples passed: Audit, Overview, Session and Sources measured **4.87:1** at both widths; Actions stayed at **10.51:1**. The sixteen corresponding after captures use `tmp/g1-browser-baseline/after-<route>-<width>.png`. The regression check targets the computed colors, not the data returned by each route; some requests were throttled during the checks.

## Territory: map-first layout

The existing map and risk panel now precede session metrics and model details in both rendered and DOM order. No product data, controls, or routes were replaced. An Overview regression test failed on the previous order and passed after the move. Authenticated Chromium confirmed the map and its zone selector lead the metrics and model at 1280×720 and 390×844, with no horizontal overflow or uncaught page errors. Captures: `tmp/g1-browser-baseline/map-first-1280.png` and `map-first-390.png`. The initial captures used a zone without a published lot. A second Chromium run then created one synthetic lot through Jobs in the disposable stack. Jobs confirmed it in latest and history; Territory displayed the same lot with populated level, five factors, rationale and policy at both widths. The map stayed ahead of the metrics and model, with no horizontal overflow or uncaught page errors. Captures: `tmp/g1-browser-baseline/map-first-populated-1280.png` and `map-first-populated-390.png`. This is a single synthetic scenario, not validation of all risk states.

## Keyboard focus on the workspace canvas

In Chromium, the outlines for **Saltar al contenido**, **Entrada sintética · aviso de alcance**, and **Restablecer filtros** measured 2.86:1 against the workspace canvas. The targeted `:focus-visible` override in `src/styles/app.css:19` keeps the same outline width and offset, reuses `--terracotta` and leaves other outlines untouched. All 44 measured instances across the eight routes and two widths passed at 5.11:1 after the change. This is a focus-color check, not a full keyboard or WCAG audit.

## History search hint

With a published synthetic lot loaded, the History search placeholder measured 3.05:1 on paper at 1280×720 and 390×844. The `#history-query::placeholder` override reuses `--muted` and brings the contrast to 5.49:1 without changing the general placeholder rule. At both widths, a nonmatching query removed the row and clearing it restored the row. Captures: `tmp/g1-browser-baseline/history-search-1280.png` and `history-search-390.png`.

## Cross-view accessibility samples

Chromium 149.0.7827.55, 2026-11-25, authenticated disposable stack:

- **Reflow, 320×800:** eight routes measured a 320px document scroll width, with no sampled page overflow. See `tmp/g1-browser-baseline/reflow-320-<route>.png`. This does not cover every state, text resize, or browser zoom.
- **Bypass link, 1280×720 and 390×844:** Enter on **Saltar al contenido** now focuses the visible main region without switching views (16 of 16 route/width samples; `2eff579`). The old build switched nondefault routes back to Overview.
- **Accessibility tree, both widths:** each of the 16 snapshots exposed one main landmark, one navigation landmark and no unnamed controls in the sampled roles. Actions, Audit, Pending and Session exposed a jump from heading level 1 to 3. The targeted correction promoted those view headings to level 2. The follow-up (`job-41`) confirmed no skipped levels in the four affected views at either width. A separate Chromium run (`job-43`, directory-enabled disposable stack) opened the persisted Actions detail at both widths and found all five level-3 subsections under the level-2 action title. The sampled Historial heading retained 11px type, weight 700, 7px bottom margin and −0.1px tracking. This is not a WCAG verdict. Some data requests were throttled, so dynamic states and announcements are outside this sample.

- **Primary navigation by keyboard, both widths:** `job-46` reached and activated all eight destinations using Tab and Enter. In each of the 16 samples, the route and `aria-current` settled correctly, and the link's center was not obscured and had a solid outline. This does not measure focus contrast for every menu state or keyboard workflows inside the views.

- **History workflow by keyboard, both widths:** `job-47` used one published synthetic lot. After bypassing navigation, Tab reached the search; typing a nonmatching value hid the row and changed the visible count to zero. The status selector was keyboard-operable without changing the total; Enter on **Restablecer filtros** restored both defaults and the row, with focus on the reset button. This did not independently exercise a multi-status result set or screen-reader announcements.

- **Actions required-field validation, both widths:** `job-48` tabbed through the create form after focusing the commune field. Enter on submit with an empty title returned focus to the title and exposed the browser's validation message. No POST was sent. Screen-reader announcement was not exercised.

- **Territory map selection, both widths:** `job-49` activated two visible map shapes with Enter and Space, using Tab between them. The native commune selector and each shape's pressed state agreed; the second shape retained keyboard focus and a dashed stroke. This verifies two shapes, not every map or inset state.

- **Native Chromium tab zoom at 200%:** `job-52` verified browser zoom factor 2, with CSS viewport width changing from 1280 to 640px. The document scroll width was 640px in all eight routes. Pending, Session and Audit each exposed one internal horizontal scroller; after the wrappers became named, focusable regions, `job-62` reached them with Tab and scrolled each with ArrowRight. This does not judge visual clipping or table access in all states. Captures: `tmp/g1-browser-baseline/zoom-200-<route>.png`.

- **Automated accessibility:** axe-core 4.10.3 scanned all eight views at both widths (`job-55`). The targeted section labels in Territory, History and Sources improved from 3.71:1 to 6.79:1; the Jobs result label improved from 4.03:1 to 7.36:1 (`job-57`). The default palette and other labels are unchanged. The scrollable-table warnings were fixed by making each wrapper a named, focusable region. A re-scan (`job-60`) reported **zero violations** in all eight views at both widths. The remaining *incomplete* items are heuristic: decorative glyphs, a field whose background is partly obscured, and an actions table with no data rows. No automated scan replaces manual review.

- **Navigation contrast during route changes:** before the fix, the active state changed text immediately but animated the background; the sampled transition from Actions to History briefly reached 1:1 (`job-58`). Removing only the background transition kept the minimum at 7.93:1 with no failing frames at either width (`job-59`). The settled colors, routes and focus styles did not change.

Other source-level findings, the remaining prototype alignment, full keyboard and WCAG checks stay open.

## Mixed surfaces (rendered pixels)

The baseline declares sign-in gradients and translucent surfaces unmeasured. `FW_MIXED_SURFACES` now measures them from rendered pixels instead of token pairs: for each text element it captures the element twice — painted, then with its own glyphs masked (`color` and `-webkit-text-fill-color` transparent) — derives a glyph mask from the difference between the two captures, dilates it by one pixel to keep the antialiased rim, and computes 1.4.3 contrast against every backdrop pixel behind the text. Chromium 149.0.7827.55, 2026-11-25, 93 samples over the public sign-in and the eight signed-in views at 1280×720 and 390×844. Evidence: `tmp/g1-browser-baseline/mixed-surfaces.json`.

Method check: the probe reproduces the independently computed source pairs it must — active navigation label 10.32:1 on `#f0eee0`, table header 5.01:1 on `#f3f4ed`, neutral tag 4.87:1 (10.51:1 in Actions), sign-in button 11.65:1 and selected auth tab 11.92:1.

| Surface | Minimum measured | Note |
| --- | --- | --- |
| Sign-in hero title | 10.44:1 | Over the two radial gradients and the contour overlay. |
| Sign-in brand name | 9.39:1 | Lightest hero text, darkest sampled backdrop. |
| Sign-in brand caption | 5.29:1 | 9 px; the flat `--forest-900` pair would have overstated it at 6.34:1. |
| Sign-in kicker / hero paragraph | 6.49:1 | `#d7aa73` and `#b9cfc6` over the composited hero. |
| Sign-in feature item | 8.16:1 | Translucent 3% feature surface. |
| Sign-in primary button | 11.65:1 | Button label on its own fill. |
| Selected auth tab | 11.92:1 | Paper chip on the soft track. |
| Health card (sidebar) | 6.79:1 | 3% white over `--forest-900`; composited, not the flat token. |
| Sidebar footer | 6.79:1 | Same composited surface. |
| Active navigation label | 10.32:1 | Matches the documented pair. |
| View eyebrow | 5.07:1 | Worst of the four eyebrow contexts. |
| Neutral tag | 4.87:1 | Matches the post-correction value. |
| Table header | 5.01:1 | Matches the documented pair. |
| Session lock mark | 4.03:1 | `⌑` with `aria-hidden="true"`: decorative, outside 1.4.3. |

Every measured text surface meets its 1.4.3 threshold. The only sub-threshold sample is the decorative `⌑` glyph, which conveys nothing and is removed from the accessibility tree; it would still clear 1.4.11's 3:1 if it were informative.

### Axe *incomplete* contrast items, resolved

The re-scan left four contrast items as *incomplete* heuristics. Each is now judged, not approved by default:

| Axe target | Resolution |
| --- | --- |
| `.session-mark` | `●` with `aria-hidden="true"` (`Shell.tsx:194`): decorative status dot, outside 1.4.3. |
| `.zone-chip > span[aria-hidden="true"]` | Decorative zone glyph, removed from the accessibility tree. |
| `.lock-mark` | `⌑` with `aria-hidden="true"` (`SessionView.tsx:247`): decorative; measured 4.03:1. |
| `#create-description` | Empty `textarea` in the sampled state (`ActionsView.tsx:1399`); no text is rendered inside the control, and its label sits on paper outside it. |
| `#actions-table` (`th-has-data-cells`) | No data rows existed in the audit stack at scan time; the assertion needs a populated table. |

This does not close keyboard, zoom, text-spacing or assistive-technology coverage, and it is not a WCAG conformance statement.
