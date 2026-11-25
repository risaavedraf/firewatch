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

### Populated and empty or error states

The eight active sections are compared here in their populated state and in their empty or error states. `01-vista-aerea.html:69` is a single-board page; each other file embeds one visible `section.view` — `#historial` (`05-historial-de-lotes.html:1056`), `#acciones` (`06-acciones-preventivas.html:1151`), `#fuentes` (`15-fuentes-y-servicios.html:841`), `#procesamiento` (`16-procesamiento.html:1021`), `#sesion` (`17-sesion-y-permisos.html:1157`), `#auditoria` (`18-registro-de-actividad.html:1274`) and `#pendiente` (`19-aun-no-implementado.html:1360`). The product side is the dated after set — Chromium 149.0.7827.55, 2026-11-25, 1280×720 and 390×844 — plus the current view source for states the capture did not reach. The artboards are static and illustrative: they never call the API, so their values are not service responses. The verdicts compare which state kinds exist and what each state exposes or offers; values are not compared. *Source* marks a counterpart known from `frontend/src/views` rather than from the capture.

| View | Populated state, artboard | Populated state, product | Verdict |
| --- | --- | --- | --- |
| Overview | Single-board explorer. Initial sector Quebrada del Este at the 21 nov cutoff: tag `Alto`, focus name, three municipalities, `Lote del 20 nov 2026 · 16:05 · … antes del corte`, one factor sentence (`01-vista-aerea.html:131,288–296`). | Both widths: a real published lot for Valparaíso (05101) — `BAJO`, five factor rows with values, `Cómo lo calculó la regla`, the policy id and parameter dump, synthetic provenance, and metrics (38 zones, 2 lots, 0 communes with level). | `Not comparable — illustrative Alto/Quebrada del Este and one factor line vs a real BAJO/Valparaíso lot with five factors, rationale and policy; the values and the card's depth are not equated.` |
| History | `#historial`. One-zone scope at the 18 nov cutoff: 3 illustrative lots (15, 18 and 20 nov), level chips, `Relación con el corte`, scope/range toolbar and timeline (`05-historial-de-lotes.html:1494–1500,1681–1707`). The 20 nov lot is marked `Posterior al corte`. | Both widths: 2 real `/v1/risk/history` rows, count `2`, `2 de 2`, search and data-status filter, columns `Solicitado`, `Estado` and `Lote`, and the per-zone limitation note (`HistoryView.tsx:150–230`). | `Not comparable — 3 illustrative lots with level and cutoff relation vs 2 real rows with requested, status and id; the row sets and the row content differ.` |
| Actions | `#acciones`. Four illustrative actions (`4 de 4`) and the selected ACC-1042 detail with a fictional assignee, six fields, evidence and focus link; the create form is prefilled with CUT, priority, due date and a fictional person (`06-acciones-preventivas.html:1171,1194,1232,1300–1340`). | Both widths: the list read returned zero rows (`LEÍDO`, `El servicio no devolvió acciones preventivas para el filtro elegido.`), so the table has headers only and no detail panel opens; the create form is empty with `Sin asignar`; `/v1/users` 503 renders the directory-failure block (`ActionsView.tsx:301–305,1446–1465`). | `Not comparable — the capture has no action rows and no detail; the artboard's four actions, their detail and the prefilled form are illustrative.` |
| Sources | `#fuentes`. Static maquette: illustrative provider, attribution, records, hash and cut; chips `Sin consultar`, `No integrada` and `No validado`; the services panel is marked `Sin verificar` and the PM-16 verdict states a demonstration without operational verification (`15-fuentes-y-servicios.html:862–960`). | Both widths: real `/v1/risk/sources` provenance (MOP-IDE Chile, 38 records, sha256 verified by the service), both dependent services `VERIFICADO` with a fresh checked-at, cycle `COMPLETA` (447 s at 1280, 449 s at 390), demo banner (`SourcesView.tsx:136–151`). | `Not comparable — the artboard is a permanent "Sin consultar" declaration with illustrative values; the capture is a live read with verified services and a complete cycle.` |
| Jobs | `#procesamiento`. Three illustrative job rows — `En cola`, `Publicado · verificado` with a batch id, and `Publicación sin verificar` (deadline expired; "no es publicado ni bajo") — plus the `Qué se declara` list (`16-procesamiento.html:1063–1078,1139–1148`). | Both widths: `Sin trabajo para la zona seleccionada.` with `Sin solicitud`, job id and requested `—`, and `Actualizar estado` disabled. At 1280 the scenario catalogue read failed (`No fue posible cargar el catálogo de escenarios…`); at 390 the default scenario note is shown (`JobsView.tsx:46,452–454,500–510`). | `Not comparable — the capture has no job; the artboard's queued, published and unverified rows are illustrative.` |
| Session | `#sesion`. Two maquette states: default `Sin sesión` with role `No disponible (sin sesión)`, or the toggle's `Sesión ilustrativa (maqueta)` with role `admin`; neither is a real session. The matrix is a 5-row excerpt of a stated 15 (`17-sesion-y-permisos.html:1180–1188,1606–1614`). | Both widths: `TOKEN LEÍDO`, roles `viewer, admin`, the real 15-row permission matrix with guard references and 403 outcomes, no token value, and the Keycloak account link (`SessionView.tsx:197–223`). | `Not comparable — the artboard's only session states are "none" or an illustrative admin label; the capture is a real token declaring viewer and admin.` |
| Audit | `#auditoria`. Four illustrative events with action/time/actor/job/trace and a separate `Detalle del evento` panel that prompts for a selection (`18-registro-de-actividad.html:1294–1337`). | 1280: four real `/v1/audit` rows (`actor_id`, `action`, `job_id`, `trace_id`, `occurred_at`) and count `4`, no detail panel. 390: `NO DISPONIBLE`, because the read was throttled (`AuditView.tsx:22,64–72`). | `Not comparable — four illustrative events vs four real events at 1280, and the 390 capture is a service state.` |
| Pending | `#pendiente`. Seven numbered capability cards (`7 capacidades`), each with its reason and destination (`19-aun-no-implementado.html:1383–1442`). | Both widths: the same seven capabilities in a three-column table (`Capacidad`, `Por qué no está`, `Dónde iría`), static, no read (`PendingView.tsx:22–63`). | `Aligned — both are static inventories of the same seven capabilities; no service data is involved.` |

| View | Empty or error state, artboard | Product counterpart | Verdict |
| --- | --- | --- | --- |
| Overview | No-lot sector `Interior sin lectura`: tag `Sin evaluación`, `Sin lote publicado hasta este corte.`, `No hay factores disponibles para este sector.` (`01-vista-aerea.html:104,292–296`). No service-failure state. | *Source*: a 404/no batch maps to `SIN LOTE`, `Sin lote publicado` and `La API no informa lotes publicados para esta zona.`, but the `Factores` heading keeps an empty list while rationale, policy and validity read `Sin consultar` (`OverviewView.tsx:224–243,658–675`). The capture shows the populated card. | `Differs — the product's no-lot card leaves the factor list empty under its heading and prints "Sin consultar" for rationale and policy, where the artboard writes "No hay factores disponibles para este sector."` |
| Overview | No service-failure state. | *Source*: an unreadable or failed batch maps to `NO DISPONIBLE` and a stated reason (`OverviewView.tsx:232–242`). | `Not comparable — the artboard has no service-failure state.` |
| History | Empty block: `No hay lotes en este rango para la zona.` or `Esta zona no tiene lotes ni evaluación al corte.`, `La ausencia de datos no es un nivel bajo…` and an in-place `Ver todo el periodo` (`05-historial-de-lotes.html:1136–1140,1810–1820`). | *Source*: `La API devolvió un historial vacío.` in `#history-state`; the table and filter bar are hidden and no in-panel action is offered; the shell footer carries `Restablecer filtros` (`HistoryView.tsx:72–74,201`). The capture has 2 rows. | `Differs — the product's empty state is one muted sentence; the artboard's block explains that absence is not low and offers "Ver todo el periodo" inside the panel.` |
| History | No read-failure state (the maquette never fetches). | *Source*: distinct messages for 401, 403, malformed, 404, other HTTP and no connection, plus `zone_mismatch` (`HistoryView.tsx:47–61`). | `Not comparable — the artboard has no read-failure state.` |
| Actions | Inline filter-empty block: `No hay acciones que coincidan con este filtro.` and `Limpiar filtros` (`06-acciones-preventivas.html:1224–1228`). | *Source*: a zero-row read, including a filter that matches nothing, prints `El servicio no devolvió acciones preventivas para el filtro elegido.` in the status line, with no in-panel reset. The shell's `Restablecer filtros` clears only the History query and status, not the Actions filters (`ActionsView.tsx:301–305,914–918`; `app/store.ts:179`). The capture shows a zero-row read, not a filter selection. | `Differs — the artboard has a titled empty block with an in-place "Limpiar filtros"; the product has a status sentence and no reset for the Actions filters.` |
| Actions | Directory-unavailable case: `No se pudo leer el directorio.`, simulated `503 directory_unavailable`, no invented people, the responsable selector disabled and emptied, and a retry (`06-acciones-preventivas.html:1328–1349,1872–1874`). | Both widths: real 503 copy (`El directorio de usuarios del realm no está disponible o no está configurado (HTTP 503 · directory_unavailable · request_id …)`), no fabricated person, the selector stays enabled with only `Sin asignar (se crea sin responsable)`, and `Reintentar lectura del directorio` (`ActionsView.tsx:144–152,1446–1465`). | `Differs — the artboard disables the responsable selector and empties it; the product leaves it enabled with only "Sin asignar". Both refuse to invent people, keep creating unassigned and offer a retry; the product adds the real request_id.` |
| Sources | No service error or empty state (the maquette never calls the API). | *Source*: `SIN CONSULTAR`, `CONSULTANDO`, `NO DISPONIBLE` and a per-field `No disponible`, with 403 and malformed copy (`SourcesView.tsx:40–52,136–143`). | `Not comparable — the artboard has no service error or empty state.` |
| Jobs | No no-job state; it only illustrates jobs that exist. | *Source*: `Sin trabajo para la zona seleccionada.` when no job is known (`JobsView.tsx:46,452–454`). The capture shows this empty state at both widths. | `Not comparable — the artboard has no no-job state.` |
| Jobs | `Publicación sin verificar` (deadline expired; "no es publicado ni bajo") and `403 por rol` in the states list (`16-procesamiento.html:1073–1076,1147`). | *Source*: `DEADLINE_EXPIRED` and `POLL_EXHAUSTED` say publication or reading is unverified; `PERMISSION_DENIED` names the 403 (`JobsView.tsx:63–67,281,387`). The capture has no job. | `Not comparable — the capture has no job; the artboard's unverified row is illustrative and its 403 is declarative.` |
| Session | No-session state: `Sin sesión`, `No disponible (sin sesión)` and the role note (`17-sesion-y-permisos.html:1180–1188,1606–1614`). | *Source*: `SIN SESIÓN`, `No disponible` and `Sin token en memoria…`, plus `NO INFORMADO` for a role-less token and a rejected-session copy (`SessionView.tsx:197–223`). The capture is authenticated. | `Aligned — both name the missing session and refuse to infer a role; the product adds the rejected and role-less variants.` |
| Audit | Four states declared: `Leído`, `Sin permiso · 403` with reason and request_id, `No disponible` without partial events, and `Vacío` as a non-error (`18-registro-de-actividad.html:1345–1352`). | *Source*: `LEÍDO`, `SIN PERMISO` with reason and request_id, `NO DISPONIBLE` without invented or partial rows, and a zero-event `LEÍDO` message (`AuditView.tsx:64,79–96`). The 390 capture shows `NO DISPONIBLE`; 403 and empty were not captured. | `Aligned — each declared state has a named product state with the same semantics; the artboard declares them without rendering them.` |
| Pending | No service, empty or error state. | No service, empty or error state: both widths render the static inventory (`PendingView.tsx:66–103`). | `Aligned — neither side defines such a state; both are static inventories.` |

Twenty comparisons: **4 Aligned**, **4 Differs**, **12 Not comparable**. The four `Differs` are the Overview no-lot card, the History empty state, the Actions filter-empty state and the Actions directory-failure selector.

Where the capture cannot support the comparison:

- **Actions, populated list and detail.** `/v1/prevention/actions` returned zero rows, so the artboard's four actions, their status chips, assignee labels and the ACC-1042 detail have no product sample. The directory-unavailable state itself was captured.
- **Jobs, every job state.** No job existed at either width (`Sin trabajo para la zona seleccionada.`, `Sin solicitud`), and the scenario catalogue read failed at 1280 only, so the queued, published-verified, unverified and 403 states were not rendered.
- **Session, populated.** The artboard has no real session — only `Sin sesión` or the illustrative-admin toggle — so the capture's real `viewer, admin` token and 15-row matrix have no artboard sample. The no-session comparison is source-level.
- **Audit at 390 and its non-populated states.** The 390 read was throttled to `NO DISPONIBLE`; 403 and empty were not captured. The 1280 rows are real, but their values differ from the artboard's four illustrative events.
- **Overview and History non-populated states, and the Sources read failures.** Not captured at either width; those rows compare the artboard with the view source only.

What this is and is not. Like the table above, this is a source-and-capture review of layout, hierarchy and state coverage: it records which populated, empty and error states each artboard defines, whether the product has a counterpart, and what that counterpart exposes or offers. It is not a pixel diff, it is not the artboards rendered in a browser, and it is not authority to change product contracts. No artboard data was imported: no fictional person, lot, level, timestamp, finding or identifier was copied into the product, and every illustrative value named above is cited only to identify the state it illustrates, never as a real reading.

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

## Virtual screen reader

`FW_VIRTUAL_READER` injects @guidepup/virtual-screen-reader **0.28.0** (bundled as an IIFE) over CDP and runs it inside the page. This is a DOM reader: it reports what the accessibility tree exposes in document order and whether a mutation is announced without focus moving. It is not assistive technology and cannot predict what NVDA, JAWS or VoiceOver will say. Chromium **149.0.7827.55**, 2026-11-25, disposable authenticated stack. Evidence: `tmp/g1-browser-baseline/vo-audit/virtual-reader.json`.

Seven samples: the anonymous sign-in once and History, Actions and Jobs at 1280×720 and 390×844, 45 steps from `document.body` plus 60 from the view's `main`. The body sweep ends inside the sidebar navigation on every signed-in route, so the view content was read from its own main landmark; the reader repeats the `main` landmark after `end of main`. Sampled state: one synthetic lot in History, no job for the selected zone, and `/v1/users` returning 503, so Actions showed its empty list with the assignee directory unavailable. No spoken phrase exposed a token, JWT, raw id or credential.

| View | First phrases |
| --- | --- |
| Sign-in | region, El riesgo territorial de incendio, comuna por comuna. → heading, level 1 with the same name → paragraph → list of three feature items → demo disclaimer → main → tablist, Acceso a FireWatch → tab, Iniciar sesión, selected → tab, Crear cuenta → tabpanel, Iniciar sesión → heading, Bienvenido de vuelta, level 2 → paragraph → button, Continuar con Keycloak |
| History | region, Historial de lotes → paragraph, TRAZABILIDAD → heading, Historial de lotes, level 2 → bare count `1` → article → paragraph with `code /v1/risk/history` → searchbox, Buscar en el historial de la zona → Estado del dato → combobox, Filtrar el historial por estado del dato → 0 de 1 → region, Historial de lotes de la zona → table |
| Actions | region, Acciones preventivas → article → heading, level 2 → status, El servicio no devolvió acciones preventivas para el filtro elegido. → form → Comunidad (CUT) → textbox, Comunidad (CUT) → combobox, Estado with nine options → button, Aplicar filtros → button, Actualizar lista → region, Listado de acciones preventivas → table with caption and seven column headers |
| Jobs | region, Procesamiento asíncrono → article → heading, Procesamiento asíncrono, level 2 → ACCIÓN ADMINISTRATIVA → combobox, Escenario sintético a solicitar with seven options → button, Solicitar lote de la zona → status, Sin trabajo para la zona seleccionada. → term/definition pairs → button, Actualizar estado, disabled |

Headings, landmarks and form labels are spoken. Each view exposes its level-2 heading and the sign-in its level-1 hero title; the named `region`, `article`, `table` and `main` landmarks are announced, including each table's caption and column headers; every form control is announced with its accessible name — search box, status combobox, CUT textbox. Two shape notes: the History count badge speaks only its bare number (`1`, then `0 de 1`) with no label, and the shell footer exposes `contentinfo` nested inside `main`.

Announcement test: on History the probe set the search box to a non-matching value without moving focus. The table went from 1 to 0 rows and the visible count from `1 de 1` to `0 de 1` at both widths, and the reader logged **no new phrase**. History has no live region for the count or the rows, so a reader user gets no feedback that filtering emptied the table. This is a product finding, not a harness defect. The probe now waits for the history read to settle before mutating; the first run changed the box before the table loaded and measured a meaningless empty result.

Limits: a DOM reader is not assistive technology, so announcement timing, interruption and verbosity in a real screen reader remain unverified. The reading is capped at 45 shell plus 60 view steps and stops before the Actions creation fields. Only these states were sampled; the other five views, populated actions and error states were not read, and the filter-change announcement was the only dynamic change exercised.

## Before and after capture set

Chromium **149.0.7827.55** (Playwright 1.61.1 driving the full Chromium build, headless), **2026-11-25**, disposable `firewatch-g1-audit` stack (gateway 18380, identity 18381, static web 14375) with one real admin session. Both sets use the same browser build and the same two viewports, **1280×720** and **390×844**, and each file is a full-page PNG written by `tmp/g1-browser-baseline/workspace-audit.mjs`. Every path is registered in the table below.

Run flags: `FW_PLAYWRIGHT=<playwright-core 1.61.1> FW_CHROMIUM_PATH=<scratch full Chromium, chromium-1228> FW_CAPTURE_SET=1 FW_TAG_GATE=1 FW_MAP_GATE=1 FW_POPULATED=1`. The neutral-tag gate stayed on, and the populated path published **one synthetic lot** in that disposable stack only, so Overview and History were captured with a real risk card and two history rows instead of an empty shell.

The `before-*` files come from the baseline `742e760`, before the corrections recorded above; the sign-in baseline is `auth-<width>.png` from the same Chromium and viewports. The after set is dated — `after-2026-11-25-<route>-<width>.png` — so no `before-`, `after-` or `auth-` capture is overwritten; the probe now fails the preflight instead of replacing an existing file, and `FW_CAPTURE_LABEL` shifts the date for a later run.

| View | 1280×720 before / after | 390×844 before / after |
| --- | --- | --- |
| Actions | `tmp/g1-browser-baseline/before-actions-1280.png` / `tmp/g1-browser-baseline/after-2026-11-25-actions-1280.png` | `tmp/g1-browser-baseline/before-actions-390.png` / `tmp/g1-browser-baseline/after-2026-11-25-actions-390.png` |
| Audit | `tmp/g1-browser-baseline/before-audit-1280.png` / `tmp/g1-browser-baseline/after-2026-11-25-audit-1280.png` | `tmp/g1-browser-baseline/before-audit-390.png` / `tmp/g1-browser-baseline/after-2026-11-25-audit-390.png` |
| History | `tmp/g1-browser-baseline/before-history-1280.png` / `tmp/g1-browser-baseline/after-2026-11-25-history-1280.png` | `tmp/g1-browser-baseline/before-history-390.png` / `tmp/g1-browser-baseline/after-2026-11-25-history-390.png` |
| Jobs | `tmp/g1-browser-baseline/before-jobs-1280.png` / `tmp/g1-browser-baseline/after-2026-11-25-jobs-1280.png` | `tmp/g1-browser-baseline/before-jobs-390.png` / `tmp/g1-browser-baseline/after-2026-11-25-jobs-390.png` |
| Overview | `tmp/g1-browser-baseline/before-overview-1280.png` / `tmp/g1-browser-baseline/after-2026-11-25-overview-1280.png` | `tmp/g1-browser-baseline/before-overview-390.png` / `tmp/g1-browser-baseline/after-2026-11-25-overview-390.png` |
| Pending | `tmp/g1-browser-baseline/before-pending-1280.png` / `tmp/g1-browser-baseline/after-2026-11-25-pending-1280.png` | `tmp/g1-browser-baseline/before-pending-390.png` / `tmp/g1-browser-baseline/after-2026-11-25-pending-390.png` |
| Session | `tmp/g1-browser-baseline/before-session-1280.png` / `tmp/g1-browser-baseline/after-2026-11-25-session-1280.png` | `tmp/g1-browser-baseline/before-session-390.png` / `tmp/g1-browser-baseline/after-2026-11-25-session-390.png` |
| Sources | `tmp/g1-browser-baseline/before-sources-1280.png` / `tmp/g1-browser-baseline/after-2026-11-25-sources-1280.png` | `tmp/g1-browser-baseline/before-sources-390.png` / `tmp/g1-browser-baseline/after-2026-11-25-sources-390.png` |
| Sign-in | `tmp/g1-browser-baseline/auth-1280.png` / `tmp/g1-browser-baseline/signin-1280.png` | `tmp/g1-browser-baseline/auth-390.png` / `tmp/g1-browser-baseline/signin-390.png` |

Structural validation, without inspecting the images: all 18 expected files exist, begin with the PNG signature and exceed 10 KB — 18 of 18, smallest `after-2026-11-25-audit-390.png` at 46,727 bytes, largest `after-2026-11-25-overview-1280.png` at 281,759 bytes; the 1280 files decode as 1280px wide and the 390 files as 390px wide. The run exited 0 with `pageErrors: 0` at both widths and `overflow: false` in all 16 route samples.

What the set proves: that each view, and the public sign-in, rendered in this Chromium build at both viewports at a single moment on 2026-11-25, with no page error and no horizontal page overflow.

What it does not prove:

- **Not settled asynchronous data.** A screenshot is one rendered state. History was allowed to settle on its loaded label and Overview on the published batch id, but two reads were throttled during the pass (`/v1/risk/synthetic-scenarios` at 1280, `/v1/audit` at 390) and `/v1/users` returned 503, so Actions shows its directory-unavailable state and the throttled panels show a service state rather than rows.
- **Not a pixel diff.** No image comparison was computed. The two sets come from different commits *and* different data states — the baseline set was captured before any synthetic lot existed — so a size or colour difference cannot be attributed to one change, and visual regression is not measured.
- **Not WCAG evidence by itself.** A PNG cannot demonstrate contrast thresholds, focus order, announcements, reflow or zoom behavior. Those claims rest on their own sections: measured contrast, axe scans, keyboard passes and the virtual screen reader.
