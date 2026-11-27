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

## Empty and filter states aligned with the artboards

Four product-side differences recorded in *Populated and empty or error states* were corrected in the view sources, using the artboard copy as the reference. No new capture was taken: each rule rests on its public DOM test.

| State | Before | After |
| --- | --- | --- |
| Overview, no published lot | `Factores` heading over an empty list | No heading and no list; one muted sentence, `No hay factores disponibles para este sector.` (`01-vista-aerea.html`) |
| History, the API returned no row | One sentence | `Esta zona no tiene lotes ni evaluación al corte.` and `La ausencia de datos no es un nivel bajo. Cambia de zona o revisa el corte compartido.` (`05-historial-de-lotes.html`) |
| History, the filters hid every returned row | Nothing offered a way back | `No hay lotes que coincidan con los filtros.` plus `Ver todo el periodo`, which clears both filters through the same reset the shell calls |
| Actions, the filtered read returned no row | Status sentence only | `No hay acciones que coincidan con este filtro.` plus `Limpiar filtros`, which clears both inputs and the applied pair |
| Actions, the directory read failed | Selector enabled with only `Sin asignar` | Selector disabled; creating without a responsible stays possible and the retry re-enables it |

Artboard copy that only describes the prototype was not imported: the Actions body sentence `El filtro no cambió los datos: son cuatro acciones de ejemplo.` describes a mock, and `Respuesta simulada: 503 directory_unavailable.` names a simulation. The product keeps its own service-truthful copy, including the status, code and request id the server returned.

The History reset is offered only when the filters are what hid rows. A zone that returned no row at all gets the explanation and no control, because there would be nothing to reveal.

What this does not cover:

- **No rendered evidence.** No capture was retaken, so nothing here shows geometry, wrapping or contrast at either width. Each rule rests on its public DOM test plus the focused and full suites.
- **The shell reset still owns History only.** `#reset-filters` in the footer calls `resetHistoryFilters`, so it does not clear the Actions filters. A global reset that owns per-view state needs a product decision; the in-panel `Limpiar filtros` is the control this slice adds, and the shell control keeps its current meaning.
- **The virtual screen reader was not re-run** over the new states. `#history-visible-count` is unchanged and remains the panel's only live region; the new History block is static text plus a native button, and it is not announced on its own.

### Rendered evidence for the new states

Probe runs on the disposable `firewatch-g1-audit` stack, Chromium 149.0.7827.55, 2026-11-25, 1280×720 and 390×844. Every run exited 0 with `pageErrors: 0`.

| Probe | What it observed |
| --- | --- |
| `FW_HISTORY_GATE=1 FW_HISTORY_KEYBOARD=1` | Filtering to zero rows renders `No hay lotes que coincidan con los filtros` and `#history-show-period` labelled `Ver todo el periodo`; the keyboard path still reaches the shell reset and restores both rows. |
| `FW_HISTORY_GATE=1` | The in-panel control itself: clicking it clears the search and the status filter and brings the two rows back. |
| `FW_DIRECTORY_FAILURE=1` | With `/v1/users` returning 503, `#create-assignee` is disabled at both widths, keeps only `Sin asignar (se crea sin responsable)`, fits the viewport, and `#create-action` stays enabled. |
| `FW_TEXT_SPACING=1 FW_TEXT_SPACING_GATE=1` | The 1.4.12 override applied to the eight views: 16 of 16 samples stayed at viewport width with no clipped content, so text spacing no longer blocks the report. |

What remains without rendered evidence: the Overview no-lot sentence and the Actions filtered-empty block, which rest on their public DOM tests.

### Reader findings closed

Two defects the virtual-screen-reader pass recorded were fixed and verified in Chromium 149.0.7827.55 on 2026-11-25:

| Finding | Fix | Evidence |
| --- | --- | --- |
| The shell footer rendered `contentinfo` inside `main`, so it was read as page content and had no landmark of its own. | The footer moved after `main`, where it already looked; no layout rule changed, since the stylesheet targets the `footer` element. | `FW_STRUCTURE_AUDIT=1` asserts exactly one `contentinfo` per route through the Chromium accessibility tree: 16 of 16 route and width samples passed, with one `main`, one `navigation` and the heading hierarchy unchanged. |
| The History count badge spoke a bare number. | A visually hidden label precedes the badge in document order, so the reader hears the noun before the number. | The virtual reader records `Lotes devueltos:` in the History reading at both widths; the visible number and its tests are unchanged. |

Both fixes keep their public DOM test (`the footer is a landmark outside the main region`, `the count badge is named for a reader before its number`), and `FW_HISTORY_GATE` still reaches the shell reset by keyboard after the footer moved. The reader probe samples 45 body phrases plus 60 from `main`, so the footer now falls outside that sweep by design; its landmark presence is asserted in the accessibility tree instead.

### Scope after the merge with `origin/dev`

The merge added three routed views — `InfrastructureView`, `ObservationsView` and `NotificationsView` — plus `ObservationAdoption` and the CSV export control inside History. The harness route list now names all eleven routed views, and the three new ones were sampled for the first time on 2026-11-25.

| Probe | Result on the eleven routes | What it proves |
| --- | --- | --- |
| `FW_STRUCTURE_AUDIT` | 22 of 22 samples, exit 0 | One `main`, one `navigation` and one `contentinfo` per route, heading hierarchy unchanged |
| `FW_AXE_AUDIT` with `FW_EYEBROW_GATE` | 22 scans, exit 0, **zero violations** | The three new views had one contrast defect each, now fixed (below) |
| `FW_TEXT_SPACING` with its gate | 22 of 22 samples, exit 0 | No overflow and no clipped content under the 1.4.12 override |
| `FW_MIXED_SURFACES` with its gate | 118 samples, exit 0, **zero failing** | Every rendered text surface meets 1.4.3, including the merged views |
| `FW_VIRTUAL_READER` with `FW_VO_ROUTES` | 6 samples, exit 0, no unannounced mutation | The three new views expose a readable document order |

Two product changes came out of it. The eyebrow colour rule was scoped to the views that existed when it landed, so the merged views inherited `#638579` at **3.71:1**; the selector now targets `.intro-row .eyebrow` structurally and the per-view list is gone. The decorative `⌑` in Session (`.lock-mark`, `aria-hidden`) measured **4.03:1** against the canvas, so it now uses the same readable token: the mixed-surface gate no longer needs an exception that could one day hide real text.

**The stack was rebuilt and the populated states measured.** The disposable project's gateway, risk, prevention and jobs images were rebuilt from the merged tree, the new migrations applied, and the narrow audit writer's principal finally provisioned (`AUDIT_DATABASE_URL` had no local value and `audit_query_app` was created `NOLOGIN`, so every audited read answered 503). After that, all nine reads behind those three views answered 200 at both widths, and the views were measured **with data**: nine alerts, an infrastructure catalogue, and two observations created through the page's own form (201 each, one per width).

| Measurement with populated states | Result |
| --- | --- |
| `FW_AXE_AUDIT` | 6 of 6 scans, **zero violations** |
| `FW_TEXT_SPACING` with its gate | 6 of 6 samples, no overflow and no clipped content |
| `FW_MIXED_SURFACES` with its gate | 44 samples, **zero failing** |

Two more product fixes came from the populated pass. The infrastructure breakdown arrived from the merge using the plain `div.table-wrap` the audit had already flagged elsewhere, so it was a scroll container no keyboard user could reach: it now uses `TableWrap` as a named, focusable region. And the notifications empty state exposed an eyebrow outside `.intro-row` at **3.87:1**; the base eyebrow token is now the readable one and no view re-colours it, which removes the whole class of defect instead of adding a fourth selector to a list.

**What remains unmeasured.** The populated states are the ones these probes could reach: the alert list, the synthetic catalogue and a created observation. Every other workflow behind them — transitions, adoption, paging, the CSV download, the print path — is covered by the merged test suites, not by a rendered capture.

## T1 — global product navigation (2026-11-26, corrected)

The shell now renders [`ProductNav`](src/components/ProductNav.tsx) as the approved canvas' arrangement: a thin horizontal bar above and outside the workspace, with three shortcuts and an out-of-flow **Más destinos** panel. Routing, the document title, the session gate, the store, the role handling and the gateway polling are untouched; the same fourteen hashes are the only destinations. The canvas' fourth shortcut, `Panel ejecutivo`, was not implemented because no route serves it; that decision is T4's, and T4 implemented it: `#executive` now serves the executive panel and the bar carries `Panel` as its fourth shortcut.

**Environment.** Chromium **158.0.8127.38**, headless, against the locally built application (`npm run build:local` served by `scripts/serve.mjs`), driven over the DevTools protocol. The workspace sits behind Keycloak, so the run used an isolated fixture: the identity token response and every gateway read were intercepted inside the browser session — a locally generated, unsigned token payload declaring `viewer`, and gateway reads answered `403` so no view could claim data. No real credential, realm or gateway was used, and nothing was installed. No screenshot was written; the evidence is rendered geometry, computed styles and the accessibility tree.

**Before the correction.** The first T1 implementation kept the navigation inside the vertical sidebar and expanded the menu in flow. Measured in the same browser method:

| Viewport | Before |
| --- | --- |
| 1440×900 | Bar/sidebar list at `x=19 y=184`, inside `aside.sidebar`; panel `position: static`, `196×629`, starting at `y=439`; `main` began at `x=234` |
| 1024×720 | Navigation inside the sidebar at `y=196`; panel `169×633`, extending to `y=1084`, below the 720px viewport; logout at `y=658` |
| 390×800 | Panel in flow inserted eleven links before the shell content: `topbar` pushed to `y=1084`, `main` to `y=1211`, logout to `y=1047`; document height `4478` |

**After the correction.**

| Sample | Result |
| --- | --- |
| Arrangement, 1440×900 | Bar `x=0 y=0 1425×48`, `position: sticky`, outside `.app-shell`; sidebar and topbar start at `y=49`; panel opens at `x=649 y=52 760×325` with `position: absolute` and three group columns |
| Out of flow | Opening the panel left `topbar`, `main`, the logout control and `document.scrollHeight` byte-for-byte unchanged at 1440×900 (`2097`) and at 390×800 (`858`); the panel is not inside `.app-shell` or the sidebar |
| Sticky | At `scrollY=400` the bar stayed at `y=0`, the sidebar stuck at `y=48`, and the topbar scrolled under the bar; the logout control stayed at `y=838` inside the 900px viewport |
| 390×800 overlay | Bar `48px`; panel `x=8 y=51 359×480`, fully inside the viewport, `scrollHeight 537 > clientHeight 478`; scrolling the panel to its end left `window.scrollY` at `0` |
| Landmark and control | One `navigation`, name `Navegación del producto FireWatch`; the disclosure is a `button` named `Más destinos` with `aria-expanded` true/false and `aria-controls` resolving to the panel |
| Keyboard, 1024×720 | Tab: skip link → **Mapa · Territorio** → **Historial de lotes** → **Acciones preventivas** → **Más destinos** → brand. Enter on the button opened the panel; the first and last grouped links kept a visible `3px rgb(215, 170, 115)` outline with `outline-offset 0` fully inside the 48px bar, and the panel's rows were not clipped (`clipped: false` for both ends) |
| Dismiss | Escape closed the panel and returned focus to the **Más destinos** button; a pointer press on the sidebar brand closed it without moving focus; the panel stayed closed after a same-route gateway re-render |
| History | Choosing **Notificaciones** and then **Registro de actividad** from the menu closed it on arrival (`aria-expanded=false` each time); Back reopened it on `#notifications` with that link `aria-current="page"`; Forward reopened it on `#audit` |
| Focus ring | Bar controls: `3px rgb(215, 170, 115)`, offset `0`, outline box `1..47` inside the `0..48` bar. Panel rows: offset `2px`, first and last rows inside the panel box |
| Rendered colours | Bar `#173c3b`, panel `#1e4241` (opaque); panel labels `rgb(165, 200, 191)` = `#a5c8bf` (6.08:1); grouped items `#c3d6cf` (7.24:1); current grouped item `#f0eee0` (9.43:1); current shortcut `#173c3b` on `#f0eee0` (10.32:1); bar labels `#a5c8bf` on `#173c3b` (6.65:1) |
| Reflow | 1440×900, 1024×720 and 390×800: no horizontal page overflow. The bar wraps below 480px instead of scrolling horizontally |

**Automated.** `npm run verify` passed after the correction: lint, typecheck, 56 test files / 734 tests, the source gate over 64 shipped files, the local build and the HTTP smoke. The focused correction suites produced a RED run before the source edit (4 files, 12 failed of 39) and a GREEN run after it (4 files, 39 passed). The previously passing T1 focused baseline (4 files, 39 tests) was preserved.

**Not measured.** No axe scan, text-spacing override, virtual screen reader, browser zoom pass or real assistive technology ran for this change; the earlier passes in this document predate it. The fixture answers 403 to every gateway read, so the navigation was exercised over permission-denied view states, not populated ones. Whether NVDA, JAWS or VoiceOver announce the bar's disclosure and the `Estás en` live region as expected was not tested.

**Known follow-up.** `scripts/check.mjs` still asserts the retired `.sidebar nav` declaration set and is outside this unit's edit surface; `app.css` keeps that rule with no rendered consumer until the gate is retired with it.

## T2 — aerial workspace (2026-11-26)

`#overview` now opens as the aerial workspace of the approved board: the map is the canvas, the workstation rail stands beside it, and the published-batch card is the reading below. Only the composition, the rail and the scoping stylesheet are new — [`src/styles/aerial-workspace.css`](src/styles/aerial-workspace.css), every selector under `#overview`. `MapPanel`, the `ui` primitives, the store, the routes, the API, auth and the eleven other views are untouched. **Superseded on 2026-11-27 (S3):** the board's aerial palette was later adopted, but only as a route-scoped role set under `#overview` — see [T2 follow-up — dark slate console](#t2-follow-up--dark-slate-console-s3-2026-11-27). As of that change this section's “palette was not adopted” and its `#eef2e8` map surface no longer describe the shipped route; the rest of it (composition, rail contract, preserved behaviour) still does.

**Environment.** Chromium **158.0.8127.38**, headless, against the locally built application. The signed-in run used an isolated fixture: a locally generated unsigned token plus every gateway read intercepted in the browser session (`/v1/risk/zones`, `/batches`, `/latest`, `/history`, `/executive-summary`, `/v1/jobs`, `/health/ready`). No real credential, realm, gateway or listener was reused, nothing was installed, and the fixture state lives only in that browser context. The baseline was rebuilt from `HEAD` (`d9ae71e`) in ignored scratch and served on a second loopback port, so "before" and "after" are the same probe against two builds.

### Composition, before and after

Document-relative top (`y`) and the rendered box of the measured elements. `map` is `.map-viewport`, `rail` is `.aerial-rail`, `reading` is `.risk-panel`, `summary` is `.executive-panel`.

| Viewport | Map before | Map after | Rail after | Reading after | Server summary |
| --- | --- | --- | --- | --- | --- |
| 1440×900 | `y=1075.1`, `466.5×300` | `y=502.5`, `764×442` | beside the canvas, `320×495`, `y=280` | `y=1142.5`, `802×899.3` | `y=280` → `y=2061.7` |
| 1280×900 | `y=1090.5`, `366×300` | `y=502.5`, `604×442` | beside the canvas, `320×495`, `y=280` | `y=1154.8`, `642×913.7` | `y=280` → `y=2088.5` |
| 1024×768 | `y=1119.9`, `213.8×300` | `y=502.5`, `730×404.3` | stacked below the canvas, `768×447.5` | `y=1568.3`, `768×899.3` | `y=280` → `y=2487.5` |
| 390×844 | `y=1941.5`, `330×222` | `y=823`, `330×262` | stacked below the canvas, `360×488.5` | `y=1887.8`, `360×1013.6` | `y=552` → `y=2917.4` |

The map surface grew 141–143 % in area at desktop widths (1440: `139 950 → 337 688` px²; 1280: `109 800 → 266 968` px²) and 18 % at 390 (`73 260 → 86 460` px²), and on both desktop widths it now begins at `y=502.5` instead of `y≈1075–1090`, i.e. on the first screen. The stale empty 190 px map-insets track was collapsed, which is what moved the `1024×768` canvas from `213.8` to `730` px wide. The server summary moved after the workspace; that placement is T4's to revisit, and its data, read and failure copy did not change.

No horizontal overflow at any of the four widths: `0` elements exceeded the viewport in `#overview` at 390, 1024, 1280 and 1440. Document height grew (1440: `2947 → 3727`; 1280: `3013 → 3784`; 390: `5303 → 5825`) because the reading card, which used to sit beside the map, is now a full-width card below it.

### PRESERVE — differential against the baseline

The same probe ran against both builds and compared eight states (loaded, 404 empty, 503 error, held-pending loading, settled result, narrow, 1440, 1024) across twelve observable keys each — selected zone, zone chip, `#map-svg` hidden flag, shape count, painted level classes per shape, `#risk-pill`, `#risk-level`, `#risk-status`, `#zone-count`, `#metric-batches`, `#metric-high` and `#map-job-progress`: **96 comparisons, 0 differences**. The one-inflight job round trip (`#jobs` request → back to `#overview`) produced the same `#map-job-progress` sentence in both builds and no document reload in either.

### States and one inflight batch

| State | Rail reading | Map pill / level (identical in both builds) |
| --- | --- | --- |
| Request held pending | `Consultando el último lote` | `SIN CONSULTAR` / `Sin consultar` |
| Latest answers 404 | `Sin lote publicado` | `SIN LOTE` / `Sin lote publicado` |
| Latest answers 503 | `No disponible` | `NO DISPONIBLE` / `Sin datos` |
| Latest answers a valid batch | `Lote publicado` | `ALTO` / `ALTO` |
| No session (DOM suite) | idle copy names the connection requirement | `SIN CONSULTAR` |

The workstation reports the session's single inflight batch, not a queue: one `#aerial-request-state` line, `role="status"` only while the map is not announcing the same zone's progress. A job requested for the selected zone reads `Lote solicitado para Valparaíso (05101) sin confirmación de publicación.` in the rail while `#map-job-progress` states the map's own sentence about the same fact.

### Keyboard

Tab order from `#content` at 1280×900, after: `#zone-select` → three map shapes → the four rail links → the executive alert link → `#reset-filters` → body → skip link → the three navigation shortcuts. Before the change the executive alert link came first and the map followed; the relative order of the pre-existing controls is unchanged. Enter on the second map shape selected `05102` in both builds with the same painted level classes. A rail link reached with Tab computed `outline: solid 3px rgb(207, 125, 79)` with `outline-offset: 2px`.

### Automated

`npm run verify` passed on the final tree: lint, typecheck, 56 test files / 742 tests, the source gate over 66 shipped files, the local build and the HTTP smoke. The focused command from the task — `tests/views/overview.test.tsx tests/map/map-panel.test.tsx tests/a11y/heading-hierarchy.test.tsx tests/styles/eyebrow-contrast.test.tsx` — went from `4 files / 77 tests` on the baseline to `4 files / 82 tests` after T2; the RED run of the new public-DOM tests was `5 failed | 47 passed` before the implementation.

### Not measured for T2

No axe scan, text-spacing override, browser-zoom pass, virtual screen reader or real assistive technology ran for this change; the earlier passes in this document predate it. The screenshots are viewport captures at 1440, 1280, 1024 and 390 of the populated state, plus the desktop empty/error/loading/inflight states — not of every route. The 390 px first screen is still dominated by the shell the T1/T2 scope leaves in place (stacked sidebar, update bar), so the aerial workspace starts at `y=552` there. Whether the sticky rail should remain sticky while the reading card scrolls under it on a tall desktop was not tested with long real catalogues. Evidence files: `tmp/t2-aerial/{before,after}/` (ignored scratch), probe `tmp/t2-aerial-workspace-probe.mjs`.

## T2 follow-up — dark slate console (S3, 2026-11-27)

The confirmed design decision («dejemoslo viendose como el diseNo confirmado porfa», S3) reopened T2 with one target: the actual `#overview` route has to look like the confirmed board ([`design/firewatch-v1-vuelo/01-vista-aerea.html`](../design/firewatch-v1-vuelo/01-vista-aerea.html)) instead of a light card page with an aerial block inside it. The slice is styling only: [`src/styles/aerial-workspace.css`](src/styles/aerial-workspace.css) and one new contract suite, [`tests/styles/aerial-workspace.test.tsx`](tests/styles/aerial-workspace.test.tsx). `OverviewView`, `AerialWorkstation`, `MapPanel`, the store, the routes, the API, auth, the eleven other views and every source gate are unchanged, and the suite that pins the view's DOM (`tests/views/overview.test.tsx`, 55 tests) was not edited.

**What changed.** The route now declares the board's four roles — water `#152934`, panel `#17222b`, raised `#243341`, accent `#94dfda` — plus `--aerial-ink`, `--aerial-muted`, `--aerial-edge`, `--aerial-warm` and `--aerial-gold`, on `body:has(#overview)`: the same route anchor the stylesheet already used for print rules, because the console's own selector cannot reach the header, the update bar or the footer above it. The six neutral roles are re-pointed inside that anchor (`--canvas`, `--paper`, `--soft`, `--ink`, `--muted`, `--line`), so the shell rows and every card on this route share one surface family, while `tokens.css` stays `color-scheme: light` and the product bar and sidebar keep their forest colours. The map card became the canvas of the route: water surface, 480 px floor, compact heading and single-row toolbar, so the whole canvas lands inside a 1440×900 first fold. The rail moved to the raised surface with accent labels, the state surfaces (pill, risk state, symbol, factor bars, scope badges, attention metric) were re-based, and three shell literals that are not tokens (the breadcrumb separator, the zone chip glyph, the footer link) were re-pointed. `--aerial-edge` is the board's `#647b8a` one step lighter — that value measures 2.92:1 against the raised surface it also borders, below the 3:1 boundary minimum, and `#6b8395` clears panel, water and raised without changing family.

**Measured (Chromium, headless, locally built application).** Contrast is computed from the colours the browser actually applied, not from the source:

| Pair | Ratio | Minimum |
| --- | --- | --- |
| Rail state on the console | 13.32:1 | 4.5:1 |
| Rail note on the console | 8.74:1 | 4.5:1 |
| Rail link on the rail | 8.51:1 | 4.5:1 |
| Risk pill on its surface | 8.51:1 | 4.5:1 |
| Scope badge on its surface | 7.53:1 | 4.5:1 |
| Risk level on the card | 14.33:1 | 4.5:1 |
| Map border on the map surface | 3.79:1 | 3:1 |
| Focus ring (zone shape, rail link) | `rgb(148, 223, 218)`, `3px` | 3:1 vs panel (10.63), water (9.89) |

**Composition, measured.** At 1440×900 the map viewport is `712×482` at `y=416…898` — the entire canvas, not a slice of it, sits inside the first fold — the rail is `336×508` at `y=288` beside it, and the reading card (`742×913`) follows under the canvas at `y=1093`. The map is therefore 2.01× the rail's area (`343 184` vs `170 688` px²) and 26 % of the screen. At 390×844 the map is `308×302` at `y=777`, its top edge inside the first fold (it was `y=870` before this compaction), stacked above the rail (`334×518`) and the reading card (`334×1093`). Horizontal overflow is `0` at both widths. The board itself is full-bleed (`1440×900`, 100 % of the screen at desktop; `374×460`, 52 % at 390); the product keeps the persistent sidebar and topbar, which is where the two layouts still differ.

**Controls and keyboard.** Three zone shapes with `aria-pressed` (one pressed), the `#zone-select` combobox, five legend items, four rail links and no rail button — the rail still creates nothing. Focusing the first zone gives the measured route ring, `Enter` really selects it (the zone chip and `#zone-name` follow), and the first rail link takes the same ring with `outline-style: solid`. Six live regions remain on the route, and the browser console reported **no errors** across the run.

**Route isolation (item 3) — differential on the same build and session.** `#history` was loaded in the same browser context: `#overview` is absent, so `body:has(#overview)` does not match and every measured shell value stayed on the light declarations — body `rgb(245, 245, 239)`, topbar and panel `rgb(255, 254, 250)`, breadcrumbs and footer `rgb(92, 108, 101)`, product bar `rgb(23, 60, 59)`. The same probe on `#overview` reads `rgb(21, 41, 52)` / `rgb(23, 34, 43)`, so the anchor is live rather than dead CSS. The new suite also pins the rule set at source level: no `:root` block, every selector anchored to the route, the palette declared on exactly one selector, and the shell targets limited to an explicit allowlist.

**Test-first.** The new contract suite was written first and failed `6/6` (`exit 1`) before the stylesheet change: no route palette, no measured pairs, no reduced-motion block, the old `var(--paper)` rail. After the implementation it passed `6/6` (`exit 0`). Three mutants were rejected by the same suite — the accent replaced by a dim tone, a `.panel` selector leaked outside the route anchor, and the light theme's `--muted` reused on the dark panel (measured `2.91:1`, below the `4.5:1` floor) — and the shipped file was restored to its exact hash (`1d7649a3…`) after each. `npm run verify` passed on the final tree: 57 test files / 798 tests, the source gate over 78 shipped files with all nine honesty statements, the local build and the HTTP smoke.

**Not measured for this change.** The browser run used a fixture session and a fixture gateway — a locally generated unsigned token and intercepted `/v1/risk/zones`, `/latest`, `/history`, `/batches`, `/executive-summary`, `/v1/models` and `/health/ready` answers — so the populated states are *fixture* states, labelled test-only, with no real credential, realm or gateway (the gateway was absent: `:8080/health/ready` answered `404`, and no Docker stack was started or restarted). The map geometry in the captures is three synthetic communes, not the served catalogue; the density of a real regional map was not observed here. No axe scan, virtual screen reader, browser-zoom pass or real assistive technology ran, and the mobile first fold is still shell-heavy: the stacked sidebar, the topbar and the update bar consume the 390 px first screen before the route begins, which is shared chrome this slice is not authorized to restructure. The board's floating panels are deliberately not reproduced: the product's panels stay in flow, so the verified no-occlusion contract holds.

**Evidence.** Screenshots and measurements: `tmp/t2-fidelity/{board-1440,board-390,route-1440,route-390,route-1440-full,route-390-full,other-route-history-1440}.png` and `tmp/t2-fidelity/browser-report.json` (git-ignored). Repro: build the frontend, `npm run serve` on `:4173`, then `node tmp/t2-fidelity/probe.mjs http://localhost:4173`.

### S3 acceptance correction — fold and chrome (2026-11-27)

Review of the previous capture found S3 still short of the promised composition: at 390×844 the map began at `y=777`, so the first screen was almost all chrome, and the product bar and sidebar were still forest green against the slate console. Both were route-visibility defects, not a new brief, so the correction is the smallest one that changes what a reader sees: re-palette the chrome this route renders, and compact the air above the canvas without removing, hiding or reordering a single row.

**Narrow probe, written first.** [`tmp/t2-fidelity/fold-probe.mjs`](../tmp/t2-fidelity/fold-probe.mjs) measures the fold and the chrome in Chromium and exits non-zero on failure. Before the correction it reported **10/17, exit 1** with exactly the defects under review: `mobile/map-present` (67 px of map visible of 844), `mobile/geometry-present` (0/3 shapes), `chrome/nav-slate` and `chrome/sidebar-slate` on both widths (`rgb(23, 60, 59)`), and `desktop/canvas-up` (`y=416`, budget 360). After the correction: **17/17, exit 0**. The probe's PRESERVE half passed in both runs — logout in viewport, hit-testing to itself and focused; the product bar reached at Tab stop 1 («Mapa»); the rail link ring measured `rgb(148, 223, 218)` `3px solid`; 3 shapes, 1 pressed, the `#zone-select` enabled, 5 legend items, 4 rail links and 0 rail buttons; `Enter` on a zone still selects it; `#history` still light; no console errors.

| Observation | Before | After |
| --- | --- | --- |
| 390×844 map position | `y=777`, 67 px visible, 0/3 shapes | `y=537`, 302 px visible (whole canvas), 3/3 shapes |
| 1440×900 map position | `y=416` | `y=346` (budget 360), 482 px visible |
| Product bar background | `rgb(23, 60, 59)` (forest) | `rgb(23, 34, 43)` (route panel) |
| Sidebar background | `rgb(23, 60, 59)` (forest) | `rgb(21, 41, 52)` (route water) |
| Logout control | 26 px tall | 28 px tall, `28px` minimum declared in the narrow block |
| `#history` shell | light canvas, forest bar and column | unchanged (same values) |
| Horizontal overflow | 0 at 1440 and 390 | 0 at 1440 and 390 |

**Chrome contrast, measured in the browser on this route.** Rail link on the bar `9.41:1`; current page item on its raised surface `8.51:1`; brand mark glyph on its aqua block `9.89:1`; session label on the column `13.32:1`; logout label on the column `13.32:1`; logout border on the column `3.79:1`. The grouped panel items, health card and workspace frame are declared through the same roles and pinned at source level (`14.33:1`, `7.97:1` and `3.79:1`) by the contract suite, not measured through an open menu in this run.

**Parent observation on the built route.** Chromium on the built route at 1273×797, 1440×900 and 390×844, with the repo's real Valparaíso GeoJSON normalized to API fields in isolated fixture responses, showed 38 named options and 36 visible mainland paths in the first fold at each size, the historic route stayed light, and no real network or authentication was used.

**Nothing hidden, nothing reordered.** The narrow block turns the column into a wrapping row of the same landmarks in the same DOM order — brand, regional scope, session state, logout — and the health card keeps its existing `≤720px` behaviour from `app.css` (the T7 decision that gives it up for the session control, unchanged here). The route stylesheet contains no `display: none` at all, and the contract suite now fails if one is added. The map's SVG, its `role="button"` shapes, the legend, the select, the rail links and the four live regions are the shipped ones; no source gate was relaxed and no shared stylesheet was edited.

**Contract suite, strengthened.** [`tests/styles/aerial-workspace.test.tsx`](tests/styles/aerial-workspace.test.tsx) grew from 6 to 7 tests: the shell re-base is now checked against an explicit root allowlist (a bare `.panel`, element or wildcard fails), the bar and column must bind to the measured roles, the file may declare no `display: none`, the narrow column must be a wrapping row with no pinned height, and the logout must keep a `≥24px` target. The view suite (`tests/views/overview.test.tsx`, 55 tests) was not touched. `npm run verify` passed on the final tree: 58 test files / 803 tests, the source gate over 78 shipped files, the local build and the HTTP smoke.

**Still unavailable.** The browser run is a fixture session over a fixture gateway (synthetic unsigned token, intercepted reads), so the final screenshots are fixture state, not an independently live-verified run: the real gateway was absent and no Docker stack was started. The map geometry is three synthetic communes. No axe scan, virtual screen reader, browser-zoom pass or real assistive technology ran, and the desktop column still has a large empty middle because its layout belongs to the shared shell, not to this route. The board's full-bleed canvas is still not reproduced — the product keeps its persistent bar and column.

**Evidence.** `tmp/t2-fidelity/fold-{before,after}.json`, `tmp/t2-fidelity/{route-1440,route-390,route-1440-full,route-390-full,other-route-history-1440}.png` (recaptured), and the previous captures preserved under `tmp/t2-fidelity/before/`. Repro: build the frontend, `npm run serve` on `:4173`, then `node tmp/t2-fidelity/fold-probe.mjs after http://localhost:4173` and `node tmp/t2-fidelity/probe.mjs http://localhost:4173`.

## T3 — territorial coverage board (2026-11-26)

`#infrastructure` now opens as the coverage board of the approved territorial artboards ([`04-cobertura-territorial.html`](../design/firewatch-v1-vuelo/04-cobertura-territorial.html) and [`21-lecturas-por-sector.html`](../design/firewatch-v1-vuelo/21-lecturas-por-sector.html)): the real catalogue map is the canvas of a stage, a rail beside it lists every zone with the type coverage the payload actually declares, and two reading panels close the board under the unchanged per-type table and breakdown. Only the composition, the rail, the reading panels and the scoping stylesheet are new — [`src/styles/territorial-coverage.css`](src/styles/territorial-coverage.css), every selector under `#infrastructure` — plus [`CoverageRail`](src/components/territory/CoverageRail.tsx) and its pure [`zone-coverage`](src/components/territory/zone-coverage.ts) helper. `InfrastructureMap`, `TableWrap`, the `ui` primitives, the store, the routes, the API, auth and the twelve other views are untouched.

**The real granularity, not the board's.** The catalogue serves one zone per comuna, identified by its CUT code. The board's "sector readings", its cut-off slider, its per-sector environment and its contextual priority have no served data and are not simulated: the view states the comuna granularity in three places (header badge, stage note, reading panel) and presents the only coverage the payload supports — how many of the five declared types each comuna declares. `/v1/risk/infrastructure` is still the only read this view issues.

**Environment.** Chromium **148.0.7778.96**, headless, against two locally built trees on loopback: the working tree on `127.0.0.1:4176` and a baseline rebuilt from `HEAD` (`9021164`) with `git archive` into ignored scratch on `127.0.0.1:4175`. The signed-in run used an isolated fixture: a locally generated unsigned token plus every gateway answer intercepted in the browser session. No real credential, realm, gateway or listener was reused, nothing was installed, and the fixture state lives only in that browser context.

### Composition, before and after

Document-relative top (`y`) and the rendered box of the measured elements. `map` is the catalogue figure, `svg` the map drawing, `rail` the new commune rail, `detail` the two reading panels.

| Viewport | Map figure before | Map figure after | Rail after | Detail after | Document height before → after |
| --- | --- | --- | --- | --- | --- |
| 1440×900 | `y=765`, `1100×601.1` | `y=886`, `826×471.3` | beside the canvas, `258×406.7`, `y=765` | `y=2364.4`, `1100×250.9` | `2389` → `2753` |
| 1280×900 | `y=780.5`, `940×525.3` | `y=937.5`, `666×409` | beside the canvas, `258×406.7`, `y=816.5` | `y=2353.6`, `940×250.9` | `2329` → `2742` |
| 1024×768 | `y=823.6`, `730×425.9` | `y=944.6`, `730×425.9` | stacked below the canvas, `730×342.2` | `y=2749.6`, `730×265.3` | `2273` → `3153` |
| 390×844 | `y=1422.1`, `330×361.5` | `y=1613.1`, `330×361.5` | stacked below the canvas, `330×404.7` | `y=3618.7`, `330×583.8` | `2991` → `4349` |

At 1440 and 1280 the 258 px rail takes its column from the map, which is the board's own proportion (a wide canvas and a narrow reading rail): the drawing falls from `1078×510.6` to `804×380.8` at 1440 and from `918×434.8` to `644×305` at 1280. At 1024 and 390 the map keeps its exact previous width and only moves down. The per-type table keeps its `1100/940/730/330` width and its `218.9` height above 720 px. Below 1180 px the stage becomes one column so the map never shrinks to make room for the rail.

**Overflow.** The only descendants that exceed the viewport at 390 are the pre-existing table cells inside `.table-wrap` (`#infrastructure-zones` keeps its shipped `min-width: 620px` and its own scroll region); the list is identical before and after. At 1024, 1280 and 1440 no descendant of `#infrastructure` exceeded the viewport in either build.

### PRESERVE — differential against the baseline

The same probe ran against both builds and compared the data-bearing keys of five states — loaded catalogue, read held pending, 403, and the `#overview` loaded state — across **47 comparisons: 0 differences**. The keys were: `#infrastructure-zone-count`, `#infrastructure-element-count`, `#infrastructure-point-total`, `#infrastructure-status`, `#infrastructure-empty`, the print button's disabled state, every table row (`data-zone`, five `data-count` cells, `data-total`), the breakdown title, every breakdown article (heading, counts line, element ids, geometry text), the `.table-wrap` count, and for `#overview`: selected zone, zone chip, map hidden flag, shape count, painted level classes, `#risk-pill`, `#risk-status`, `#risk-level`, `#zone-count`, `#metric-batches`, `#metric-high`, `#map-job-progress`, the four `#aerial-*` readings and `#executive-status`.

Two strings changed on purpose, and only in `#overview`: the empty-factor sentence now says `No hay factores disponibles para esta comuna.` (the card reads one comuna by CUT code) and the coverage limitation now reads `Cobertura por sector: la API no publica lecturas ni un porcentaje de cobertura por sector. Su unidad es la comuna (código CUT), así que esta ficha no muestra un porcentaje de cobertura.` Both are pinned by `tests/views/overview.test.tsx`.

### States

| State | Coverage stage | Rail | Status / empty copy |
| --- | --- | --- | --- |
| Catalogue loaded (4 zones) | present | 4 entries, `5`, `3`, `2`, `2` de 5 tipos, `aria-pressed="false"` | `Catálogo sintético recibido: 4 zonas y 12 elementos…`, print enabled |
| Read held pending | absent | absent | `Consultando el catálogo sintético de infraestructura…`, `Sin catálogo cargado todavía: no se muestran filas, conteos ni geometrías.`, print disabled |
| 403 | absent | absent | `La API denegó el permiso para consultar la infraestructura (403)…`, `Sin catálogo disponible: no se muestran filas, conteos ni geometrías.`, print disabled |

The stage is never rendered without a catalogue: a failed or pending read owns its own sentence instead of an empty rail.

### Keyboard

Tab order from `#content` at 1440×900. **Before:** `#infrastructure-print` → table scroll region → `#reset-filters` → body → skip link → `#nav-overview` → `#nav-history` → `#nav-actions`. **After:** `#infrastructure-print` → `#coverage-entry-05101` → `#coverage-entry-05109` → `#coverage-entry-05801` → `#coverage-entry-05401` → the table scroll region → `#infrastructure-history-link` → `#infrastructure-compare-link` → `#infrastructure-sources-link` → `#reset-filters` → body → skip link → the product navigation. The pre-existing controls keep their relative order; the new rail and the reading links sit between the print control and the table.

Enter on `#coverage-entry-05801` (focused with Tab, `outline: 3px solid rgb(207, 125, 79)`, `outline-offset: 2px`) opened the commune's breakdown: the hash stayed `#infrastructure`, focus landed on `ARTICLE#infrastructure-zone-05801`, `aria-pressed` became `true`, the target painted `rgb(238, 241, 233)`, showed `outline: 3px solid rgb(207, 125, 79)` with offset `2px`, and was inside the viewport. The three reading links stayed native `a[href]` to declared routes.

**A finding from this pass.** The rail first shipped as in-page `#infrastructure-zone-…` anchors, which is the board's pattern. The product's hash router owns the address bar: a hash that is not a declared route falls back to `#overview`, so Enter on a commune link left the view entirely (measured: `hash="#overview"`, focus `BODY`). The rail now uses `button type="button"` with `aria-pressed` and moves focus itself; a public DOM test pins that the router hash is untouched.

### Contrast (measured in Chromium, rendered computed styles)

| Pair | Ratio | Read |
| --- | --- | --- |
| Rail coverage figure `--forest-700` on `--paper`, 9 px/800 | 7.36:1 | meets 4.5:1 |
| Rail type names `--muted` on `--paper`, 9 px/400 | 5.49:1 | meets 4.5:1 |
| Zone coverage line `--forest-700` on `--paper`, 10 px/600 | 7.36:1 | meets 4.5:1 |
| Reading description `--muted` on `--paper`, 10 px/400 | 5.49:1 | meets 4.5:1 |
| Reading link `--forest-700` on `--paper`, 11 px/700 | 7.36:1 | meets 4.5:1 |
| Granularity badge `--muted` on `#edf1f2`, 8 px/850 | 4.87:1 | meets 4.5:1 (shipped neutral-tag pair) |

The five coverage marks are `aria-hidden` decoration; the sentence beside them carries the meaning, so nothing depends on the `--forest-700` / `--line` bar colours. On the selected entry the same pairs sit on `--soft`, whose declared values are recorded in [`design/system.md`](../design/system.md) (`--forest-700` 6.57:1, `--muted` 4.86:1); the rendered hover and selected surfaces were not re-measured in this pass.

### Automated

`npm run verify` passed on the final tree: lint, typecheck, 56 test files / 749 tests, the source gate over 69 shipped files, the local build and the HTTP smoke. The focused command from the task — `tests/views/infrastructure.test.tsx tests/views/overview.test.tsx tests/map/map-panel.test.tsx tests/a11y/heading-hierarchy.test.tsx` — went from `4 files / 89 tests` on the baseline to `4 files / 96 tests` after T3. The RED run of the new public-DOM tests was `8 failed | 58 passed (66)` across the two view suites before the implementation. The drill-through test (`T3 opens the chosen commune breakdown…`) was written after the browser pass exposed the router finding above, so it passed on its first run instead of starting from a RED.

### Not measured for T3

No axe scan, text-spacing override, browser-zoom pass, virtual screen reader or real assistive technology ran for this change; the earlier passes in this document predate it. The screenshots are viewport and full-page captures at 1440, 1280, 1024 and 390 of the populated state plus the desktop pending and 403 states — not of every route, and not of the print preview: the print rules added here were not rendered to paper, and the existing print contract (`#infrastructure-zones`, `.infrastructure-synthetic` and `.infrastructure-formula` kept; `.infrastructure-print-action` hidden) is still asserted against `app.css` by the DOM suite. The 390 px first screen is still dominated by the shell the T1/T2 scope leaves in place, so the coverage stage begins at `y=1456` there. The fixture carries four comunas; a long real catalogue was not rendered. Evidence files: `tmp/t3-coverage/{before,after}/` (ignored scratch, `report.json` plus screenshots), probe `tmp/t3-coverage/probe.mjs`, comparison `tmp/t3-coverage/compare.mjs`.

## T4 — decision workspace (2026-11-26)

`#executive` is a new real route: the canvas bar's fourth shortcut (`Panel`, `#executive`) now points at a view that reads the same `GET /v1/risk/executive-summary` the overview already read, through one shared hook. `#compare` and `#notifications` keep their routes, reads, filters, mutations, ARIA and states; only their view-scoped composition changed. The three screens share [`src/styles/decision-workspace.css`](src/styles/decision-workspace.css); the notification empty card is styled in [`src/styles/notifications.css`](src/styles/notifications.css). Auth, the backend, shared stores and the domain contract were not touched.

**Environment.** An isolated **Chromium** headless shell (the Playwright `chromium_headless_shell-1223` build already present locally), driven over CDP against `file://` fixture pages. Each fixture is the **real component output**: a temporary jsdom harness rendered `ExecutivePanel`, `CompareView`, `NotificationsView` and (after the change) `ExecutiveView` with the same fixtures their suites use, and the resulting view markup was written beside the real stylesheets. No network, no gateway, no Keycloak, no credential, no backend state and nothing installed. The before/after pair uses the same fixtures, the same viewports and the same probe; the *before* pages link a snapshot of the base commit's stylesheets (`git show bb8a956:frontend/src/styles/*`, written under `tmp/t4-fix/base-css/`), so the base markup is measured against the base CSS rather than against this change's stylesheet. Evidence: `tmp/t4-fix/{before,after}/` (`measure.json` plus screenshots at 1440×900, 1280×900, 1024×768 and 390×844) and probes `tmp/t4-fixture-probe.mjs` / `tmp/t4-contrast.mjs` (ignored scratch).

**Scope of the comparison.** The fixtures cover the states that carry the ported hierarchy: the executive panel with a served summary, the comparator with two answered zones, the notification list with two rows and the notification empty page. Focus/hover/drag-transient states, a live authenticated session and a real-length catalogue are **not** in the fixture set, so the screenshots establish composition and target geometry, not every state.

### Composition, before and after

Boxes are the rendered `getBoundingClientRect` of the element named. The left column is the base tree (`bb8a956`), the right one is this change.

| View / viewport | Before | After |
| --- | --- | --- |
| `executive-panel` 1440 | one panel `1372×539`, heading `h3`, level counts inside a data list | same panel `1372×895`, `h3` with a counts band of 4 cells `328×72` and three limit disclosures (67px summary rows) |
| `executive-view` 1440 | route does not exist | `h2 Panel ejecutivo` at `y=48`, panel `1372×895` at `y=121`, band cells `328×72` |
| `executive-view` 390 | route does not exist | `h2` at `y=41`, panel `360×1395` at `y=176`, band 2×2 of `161×72` / `161×84` cells |
| `compare` 1440 | one panel `1372×834`; history table `630×117` | two panels side by side: selection `360×437`, reading `996×647`; history table `442×147` inside the reading column |
| `compare` 1024 | one panel `976×878` | two panels: selection `360×437`, reading `600×674` |
| `compare` 390 | one panel `360×1485`, history table at `y=968` | stacked panels: selection `360×429` at `y=176`, reading `360×1087` at `y=621`; history table at `y=1069` |
| `notifications-empty` 1440 | empty block `1334×129`, panel `1372×381` | designed card `1334×288`, panel `1372×539` (58px dashed mark, eyebrow, title, copy, two points) |
| `notifications-list` 1440/390 | panel `1372×454` / `360×547`, table `1334×154` / `433×154` | identical |
| `notifications-empty` 390 | card `330×146`, panel `360×418` | card `330×296`, panel `360×569` |

**Overflow.** `document.documentElement.scrollWidth` equals `window.innerWidth` on every measured fixture at all four widths, before and after; the only element wider than its column is the pre-existing `#notifications-table` inside its shipped `.table-wrap` scroll region at 390 px (`433×154` in a `330` px card, identical before and after).

### PRESERVE — differential against the baseline

The same probe ran against both trees and compared the data-bearing keys of four fixtures across four viewports (`docScrollWidth`, `innerWidth`, horizontal overflow, view title text/size, panel count and boxes, panel heading text/level/size, control counts, every focusable target's tag/id/height, and the Tab sequence):

- **Notifications, populated list: 0 differences** in all four viewport comparisons. Same panel box (`1372×454` / `360×547`), table box, control counts (`1 select`, `3 buttons`), tab order and focus ring at 1440, 1280, 1024 and 390.
- **Notifications, empty page: intended geometry only** — the card grows `129 → 288` px at 1440 and `146 → 296` px at 390, and the panel with it (`381 → 539` and `418 → 569`), because the design card adds the mark and the two points; the status line, control counts, tab order and the card's `16px` title are unchanged.
- **Comparator: intended composition only** — panel count `1 → 2`, the headings become the board's two (`Elige 2 o 3 zonas`, `Riesgo, variables e historial`), and the history table is `188` px narrower at 1440 (it moves into the reading column). The two selects, both `Quitar` buttons and the window/status copy are identical at every viewport. At 1280 and 1024 the narrower reading column makes the two **pre-existing** history `.table-wrap` regions overflow horizontally, so they enter the Tab sequence as focusable scroll regions; at 1440 and 390 the sequence is unchanged.
- **Executive panel: headings and counts identical**, with two additions — the 4-cell counts band (3 `details` in the DOM, 3 new Tab stops) and the panel's own growth (`539 → 895` px at 1440, `1089 → 1395` at 390). `#executive-coverage-*`, `#executive-level-*`, `#executive-delta-*`, `#executive-critical-*`, `#executive-alerts-*`, `#executive-alert-link` and `#executive-panel-note` render with the same values as before.

**Contracts kept.** The public DOM contract was additionally pinned before the CSS existed: the focused suite went from `8 failed` / `10 failed | 126 passed (136)` (with two suites failing at the import of the not-yet-created `ExecutiveView`) to `8 passed (8)` / `149 passed (149)`. `tests/app/router.test.tsx` now pins all fifteen hashes and the four shortcuts; the T1 Back/Forward, modified-activation and skip-link history tests are unchanged and still pass on the grouped routes.

### Keyboard

Tab sequence measured from the document start in the isolated browser; the repeating tail is the headless shell handing focus to browser chrome and back, not a page trap.

| Fixture | Sequence (page order) | Focus ring |
| --- | --- | --- |
| `executive-view` 1440 | `#executive-alert-link` → three limit `summary` rows → `#overview` → `#compare` → `#notifications` → `#actions` | `3px solid rgb(207, 125, 79)` on every stop |
| `executive-panel` 1440 | `#executive-alert-link` → three `summary` rows (before: the link alone) | as above |
| `compare` 1440 | `#compare-zone-picker` → `#compare-granularity` → `Quitar` → `Quitar` (before: identical) | as above |
| `compare` 390 | the same four, then the two history scroll regions, then the same order (before: identical) | as above |
| `notifications-empty` 390 | `#notifications-order` only (before: identical) | as above |
| `notifications-list` 390 | `#notifications-order` → table scroll region → `#notifications-next` (before: identical) | as above |

Target heights measured for the new controls: limit `summary` `67px` (≥44), related-reading links `24px` (`min-height`, up from a 17px text box), the executive alert link `24px`, the count cells are not interactive. The pre-existing comparator selects (`38px`), `Quitar` (`25px`) and pager (`33px`) keep their shipped sizes.

### The shared bar (fourth shortcut)

The bar is a shared component, so its fourth shortcut was measured on its own fixture at four widths. `Panel` renders as a fourth native `a[href]` to `#executive`, keeps the accessible name `Panel ejecutivo` (the DOM suites pin it), and is the only `aria-current="page"` entry when that route is open. At 1440 and 1280 the bar stays one `48px` row with the four shortcuts at `x=16..270`; at 390 it also stays one `48px` row (`x=12..250`, `Estás en` visually hidden below 560 px) with no horizontal overflow. The three T1 shortcuts keep their exact order and labels; the fourth is appended after them. **Corrected after verification:** the fourth shortcut moves the wrap earlier than this section first recorded — at 340 and 360 px the bar wraps to `89px`, and the reserved offset stayed `48px`, so a focused commune breakdown was painted over by the second row. The measured before/after table and the fix are in ["T4 correction — verifier blockers"](#t4-correction--verifier-blockers-2026-11-26).

### Contrast (rendered computed styles)

Ratios computed in the page from each element's `color` and its nearest painted background.

| Pair | Ratio | Read |
| --- | --- | --- |
| Count label `--muted` on `--paper`, 9px/800 | 5.49:1 | meets 4.5:1 |
| Count value `--ink` on `--paper`, 25px/550 | 11.85:1 | meets 4.5:1 |
| Band hint `--muted` on `--paper`, 9px/400 | 5.49:1 | meets 4.5:1 |
| Limit title `--ink` on `--paper`, 11px/700 | 11.85:1 | meets 4.5:1 |
| Limit copy `--muted` on `--paper`, 10px/400 | 5.49:1 | meets 4.5:1 |
| Related link `--forest-700` on `--paper`, 11px/700 | 7.36:1 | meets 4.5:1 |
| View title `--ink` on `--canvas`, 24px/600 | 10.93:1 | meets 4.5:1 (large text) |
| Empty eyebrow `--forest-700` on `#f8faf7`, 9px/800 | 7.08:1 | meets 4.5:1 |
| Empty title `--ink` on `#f8faf7`, 16px/650 | 11.39:1 | meets 4.5:1 |
| Empty copy and points `--muted` on `#f8faf7`, 10px/400 | 5.28:1 | meets 4.5:1 |
| Empty `code` `--forest-700` on `#f8faf7`, 10px/400 | 7.08:1 | meets 4.5:1 |
| Comparator status `--muted` on `--paper`, 10px/400 | 5.49:1 | meets 4.5:1 |
| `Quitar` `--forest-700` on `--soft`, 10px/400 | 6.51:1 | meets 4.5:1 |

Non-text: the painted focus ring `#cf7d4f` is `3.11:1` on `--paper` (meets 3:1) and `2.75:1` on `--soft`, a shipped pair the earlier passes already recorded. The dashed empty mark `#c8d2c6` on `#f8faf7` is `1.48:1`; it is `aria-hidden` decoration and the eyebrow, title and copy carry the state, so nothing depends on it. Level marks in the counts band repeat the map legend's fills; each sits beside its written label, never alone.

### States

| Screen | States the fixture set covers | Result |
| --- | --- | --- |
| `#executive` | served summary | band + six reading blocks + three limits; one request |
| `#executive` | failure (`503`), pending, signed out | stated inline, no counts; covered by DOM tests, not screenshotted |
| `#compare` | two zones answered; catalogue loaded; <2 zones; catalogue 403; comparison failure; empty answer | the split panels keep every state in the panel that owns it; all covered by the existing suite |
| `#notifications` | two-row page (pager) and empty first page | table and pager unchanged; empty page uses the designed card |
| `#overview` | the executive section unchanged | it renders the same panel, one request, same identifiers |

### Automated

`npm run verify` passed on the final tree: lint, typecheck, `57` test files / `762` tests, the source gate over `72` shipped files, the local build and the loopback HTTP smoke. The T3 record names `56` files / `749` tests for the base tree, so this change adds one suite and thirteen tests and removes none. The focused command from the task — `tests/app/router.test.tsx tests/app/shell.test.tsx tests/components/executive.test.tsx tests/views/executive.test.tsx tests/views/overview.test.tsx tests/views/compare.test.tsx tests/views/notifications.test.tsx tests/a11y/heading-hierarchy.test.tsx` — finished at `8 files / 149 tests` passed.

### Not measured for T4

No axe scan, text-spacing override, browser-zoom pass, virtual screen reader or real assistive technology ran for this change. The composition measurements above used view-level fixture pages — the real components' markup, but not the shell, the gate or a real token; the correction below adds a shell-level fixture with the real gate, while still no live identity provider or gateway was contacted. The 1440/1280/1024/390 captures are of the four fixtures listed above; the 390 px first fold is dominated by the shell the T1/T2 scope leaves in place, so only the view's own composition is described. The comparator's history and the notification table still scroll horizontally inside their shipped `.table-wrap` at 390 px, unchanged by this task. The executive panel's behaviour with a much longer critical-zone list was not rendered.

## T4 correction — verifier blockers (2026-11-26)

Three blockers from the independent verification were corrected inside T4's own edit surface. No scope was added: auth, the backend, the shared APIs and stores, the domain contract and the design/tracker files were not touched.

### 1. D-B was labelled as an open decision

`odd/tasks/pm-01-executive-panel.md` records D-B as **resolved** by the responsible — a zone is critical when its two last published lots are `alto` — and the server applies it. The panel's limits band nevertheless carried the eyebrow `Definición abierta · D-B`, which is the one thing the record says it is not.

Both consumers of `ExecutivePanel` (`#overview` and `#executive`) now render the same corrected copy:

| Element | Before | After |
| --- | --- | --- |
| Limits summary eyebrow | `Definición abierta · D-B` | `Definición acordada · D-B` |
| Limits body | "…es la definición con la que esta página cuenta zonas críticas" | "…es la definición acordada (D-B): una zona es crítica cuando sus dos últimos lotes publicados tienen nivel alto. El servidor la aplica y esta página reproduce su conteo." (alert-count and CUT-naming limits kept) |
| `#executive-panel-note` | "La etiqueta … es D-B" | "La etiqueta … es la definición acordada (D-B) y el servidor la aplica" |

The rule, its literal `Alto en los dos últimos lotes`, the count and the "regla propia activa, no un modelo entrenado ni una predicción" sentence are unchanged. `Definición abierta` and `sin decidir` appear nowhere in the panel's rendered text.

**Pinned by** `tests/components/executive.test.tsx` (rendered copy, both forbidden strings, the explanation and the count label) plus one rendered-copy test in each consumer: `tests/views/overview.test.tsx` and `tests/views/executive.test.tsx`. RED before the change: those three tests failed; GREEN after: the same five focused suites ran `103 passed (103)`.

### 2. The later-page empty state claimed the whole register was empty

`showEmpty` covers any empty page, and the card said "No hay alertas de cambio de nivel registradas". The list is cursor-paginated, so an empty page after a populated one is a fact about **that page**: the rows before it exist. The card is now state-dependent:

| State | Eyebrow | Title | Body / points |
| --- | --- | --- | --- |
| First page empty (true global empty) | `SIN DATOS · ESTADO REAL` | `Sin notificaciones` | "No hay alertas de cambio de nivel registradas…" plus what would fill the list and what the page does not do (unchanged) |
| Later page empty | `PÁGINA VACÍA` | `Esta página no tiene alertas` | "La página *n* no devolvió alertas. La lista se pagina por cursor y las páginas anteriores sí tenían filas, así que este vacío no afirma que no haya alertas registradas." plus "Usa «Anterior» para volver a la página que tenía filas" and the no-writes point |

The status line is now page-scoped ("…una lista vacía de alertas en la página *n*") while staying `role="status" aria-live="polite"`. `Anterior` remains enabled on a later empty page, the settle-focus contract still lands on `#notifications-status`, and going back restores the real rows.

**Pinned by** `tests/views/notifications.test.tsx`: a new test asserts the later-page card does not contain the global sentence, says this page is empty, names `Anterior`, keeps the page-scoped status and focus, and restores page 1; the pre-existing later-page test now expects the page-scoped title. RED before the change: both failed; GREEN after.

### 3. The fourth shortcut moved the wrap earlier while the reserved offset stayed 48px

T4's fourth shortcut (`Panel`) makes the bar wrap at **340 and 360 px** as well as 320 px. Every rule that reserves the bar reads `--product-nav-h` (shell height, sticky sidebar top, the aerial rail offset and `#infrastructure .infrastructure-zone { scroll-margin-top: calc(var(--product-nav-h) + 14px) }`), and the fixed 48px left the second row painting over content — including a commune breakdown that T3 scrolls to the top and focuses.

**Environment.** An isolated Chromium headless shell against a locally built fixture served on loopback: the real `entry` mounts the real `Shell` (which owns `ProductNav`) around the real `InfrastructureView`, signs in through the real PKCE round trip against a local fixture token endpoint, and reads a local fixture catalogue. The baseline build serves the **same entry, CSS and views** and replaces only the two navigation modules with their `bb8a956` copies (`ProductNav.tsx` and the route table it reads), so the comparison isolates the navigation change. No live credential, realm, gateway, backend write or network egress; nothing installed. Evidence: `tmp/t4-nav/{baseline,current}*`, `occlusion.json`, screenshots, probe `tmp/t4-nav-occlusion.mjs`, server `tmp/t4-nav-server.mjs` (ignored scratch).

The reserved value is the effective `--product-nav-h` an element inherits; the correction publishes it on `body` while `:root` keeps the `48px` fallback and the bar itself shadows it with its own `48px`.

| Width | Baseline `bb8a956` | Current, before the correction | Current, after the correction |
| --- | --- | --- | --- |
| 320 | bar `89px`, reserved `48px`, focused breakdown top `62` vs bar bottom `89` → **27 px occluded** | same as baseline | bar `89px`, reserved `89px`, `scroll-margin-top 103px`, target top `103` → **0 occluded** |
| 340 | bar `48px`, reserved `48px`, target top `62` → 0 | bar `89px`, reserved `48px`, target top `62` → **27 px occluded** | bar `89px`, reserved `89px`, margin `103px`, target top `103` → 0 |
| 360 | bar `48px` → 0 | bar `89px`, reserved `48px` → **27 px occluded** | bar `89px`, reserved `89px` → 0 |
| 390 | bar `48px`, reserved `48px`, margin `62px` → 0 | identical to baseline | identical (reserved `48px`, margin `62px`) |
| 1440 | bar `48px`, reserved `48px`, margin `62px` → 0 | identical to baseline | identical (reserved `48px`, margin `62px`) |

**Fix.** `ProductNav` now publishes the box the bar actually occupies to `--product-nav-h` (on mount, on `resize`, and through a `ResizeObserver` when the box changes), keeps the stylesheet's `48px` until it can measure (jsdom or a hidden document), and removes the property on unmount. The property is written on `body`, and `product-nav.css` gives the bar its own `--product-nav-h: 48px`, so the bar never sizes itself from the offset it publishes: a self-sizing bar would have deadlocked at two rows instead of returning to one when the viewport grows. The measured values confirm it — at 320/340/360 the inherited offset is `89px` and the bar's own value stays `48px`; at 390/1440 both are `48px`. No T3 file was edited: the coverage view's `scroll-margin-top` follows the published value (`103px` wrapped, `62px` on one row).

**PRESERVE.** At 390 and 1440 the published value is `48px`, so the shell height, the sticky sidebar top, the aerial rail offset and the coverage scroll margin are exactly the baseline values. The drill-through at those widths measured `targetTop 62` / `barBottom 48` before and after. No horizontal page overflow at any measured width (`scrollWidth == innerWidth` at 320, 340, 360, 390 and 1440, baseline and current). The out-of-flow menu is unchanged: opening it kept `document.scrollHeight` constant and the panel stayed inside the viewport at every width. Keyboard order in the bar is the four shortcuts then `Más destinos`; every stop painted `3px` rings (`rgb(215, 170, 115)` on the bar, skip link `rgb(167, 77, 52)`) and stayed visible and inside the viewport. The drill-through itself is unchanged: `#coverage-entry-05102` keeps `aria-pressed="true"`, `#infrastructure-zone-05102` receives focus with `outline: 3px solid rgb(207, 125, 79)`, and the hash stays `#infrastructure`. No page errors were logged by either build at any width.

**Pinned by** `tests/app/shell.test.tsx`: the bar publishes the measured height (`89px`), follows a viewport change back to `48px`, keeps the fallback when nothing is measurable (`0`), and removes the property on unmount. RED before the change: the test read an empty property; GREEN after.

### Limits of this correction

The nav measurement used the real components in an isolated local fixture, not the live authenticated application, and the fixture catalogue is four synthetic communes rather than a real region; the drill-through target was the second commune, which is tall enough to be scrolled under the bar. The narrow widths measured are 320, 340, 360, 390 and 1440 CSS px; 375, 414 and zoom-driven widths were not sampled. The keyboard pass covers the bar and the first stops after it, not the whole commune rail. No axe scan, text-spacing override, browser-zoom pass, virtual screen reader or real assistive technology ran for this correction.

## T5 — history, export and model data (2026-11-26)

T5 ports boards 05 (historial de lotes), 12 (exportación CSV) and 20 (datos del modelo) into the routes the
product has: the history panel and its real CSV delivery in `#history`, and board 20's status-first hierarchy in
the model panel `#overview` already renders. No route, backend, auth, shared store, domain contract or `app.css`
rule changed. The new stylesheet is [`src/styles/history-workspace.css`](src/styles/history-workspace.css), every
selector scoped to `#history` or `#overview .model-panel`.

**Environment.** An isolated **Chromium** headless shell (the locally present Playwright
`chromium_headless_shell-1223` build) driven over CDP against `file://` fixtures. Each fixture is the **real
component output**: a temporary jsdom harness rendered `HistoryView` and `OverviewView` with the same stubbed
`fetch` the shipped suites use, and wrote the markup beside the real stylesheets. The *before* pair is the base
tree (`8e8324c`, checked out detached under the ignored `tmp/` and redirected a snapshot of the base stylesheets),
so base markup runs against base CSS; the *after* pair is this working tree. Same states, same data. No network,
gateway, Keycloak, credential or backend state; nothing installed. Evidence: `tmp/t5/{before,after}/` (`*.html`,
`csv.json`), `tmp/t5/measure.json`, `tmp/t5/keyboard.json`, `tmp/t5/columns.json` and `tmp/t5/shots/`. The base
worktree and the junctions that let it resolve `node_modules` are ignored scratch and are named under "Limits".

### Composition, before and after

Boxes are the rendered `getBoundingClientRect` of the element named, in CSS px. Left column is `8e8324c`, right
column is this change, populated state with the same two served batches.

| Element / viewport | Before | After |
| --- | --- | --- |
| History head 1440 | title `165.7×36` at `y=47.5`, no lede | title `438.8×36` at `y=47.5`, lede `438.8×34.1` at `y=87.5`, count badge at the right |
| History panel 1440 | `1372×427.9` at `y=100.5`, no named head | `1372×667.8` at `y=138.6`; panel head `Lotes publicados de la zona` (`15px/650`, `248.3×22.5`), scope tag `POR ZONA` |
| Rows table 1440 | `1334×116.5`, 3 columns | `1334×116.5`, 5 columns |
| Delivery block 1440 | `1334×74` (button + note + status) | `1334×255.4` at `y=532`: head, 4 fact rows (capped at `640`), action row with hint, note, status |
| History panel 390 | `360×538.5` at `y=122` | `360×846.7` at `y=161.1`; table region `330` client / `576` scroll |
| Delivery block 390 | `330×142.6` | `330×392.3` |
| Empty state 1440 | status block `1334×74`, no card | card `1334×129` (`history-empty-card`, dashed `#c8d2c6` on `#f8faf7`) |
| Empty state 390 | `330×104` | card `330×153` |
| Unavailable 1440 | status block `1334×47` | status line `1334×38` with the shipped `risk-error` colour, no card (a refusal is not an empty period) |
| Every-zone series 1440 | panel `423.8`, list `1334×103` | panel `490.3`, list `1334×112`, level marks in words |
| Model panel 1440 | `1372×281.7`; heading inset at `x=75`, `y=3354.2` | `1372×407.6`; heading at `x=53`, `y=3334.2`; scope block `463.6×108.4` naming the one read and what the panel does not claim |
| Model panel 390 | `360×360` | `360×515.9`; scope block `330×108.4` |

### PRESERVE — differential against the baseline

The same probe ran against both trees at 1440, 1280, 1024, 390, 360 and 320 px.

- **Identifiers.** The populated page keeps all 12 shipped history identifiers (`history`, `history-title`,
  `history-count`, `history-scope`, `history-query`, `history-status-filter`, `history-visible-count`,
  `history-state`, `history-rows`, `history-csv-download`, `history-csv-note`, `history-csv-status`). Three are
  added (`history-scope-tag`, `history-export-title`, `history-csv-absence`); none is removed or renamed.
  `#overview` keeps `model-panel`, `model-panel-title`, `model-synthetic`, `model-status`,
  `model-active-version`, `model-batch-version` and `model-panel-note` with the same values (`academic-rule-v1`,
  `NO DECLARADO`, `Sin consultar`).
- **Controls.** Populated desktop and mobile: 0 links, 1 button, 2 selects, 1 search input — identical counts.
  The empty state still hides the table and the filter bar through the shipped `has-rows` rule while the export
  stays enabled.
- **Keyboard.** At 390 and 320 the Tab sequence is identical in both builds: `#history-scope` →
  `#history-query` → `#history-status-filter` → the table region (`role="region"`,
  `aria-label="Historial de lotes de la zona"`, `tabindex="0"`) → `#history-csv-download`. Every stop painted
  `outline: 3px solid rgb(207, 125, 79)`; the download button is `33px` before and `34px` after.
- **Reflow.** `document.documentElement.scrollWidth === window.innerWidth` at all six widths in both builds. No
  page-level horizontal scroll is introduced.
- **States.** The empty, unavailable and export messages are byte-identical before and after; the export's
  `aria-describedby` still points at `history-csv-note`, and the copy the suites pin
  (`sin aplicar la búsqueda ni el filtro de estado`, `no se recodifica`) is unchanged.

### The narrow internal scroll, explained

The five columns do not fit a phone, and the table does not shrink them. Measured at 390 px:

| Metric | Before | After |
| --- | --- | --- |
| Table width | `330` (3 columns: 156 / 93 / 81) | `576` (Solicitado 127, Publicado 127, Nivel 181, Estado 76, Lote 66) |
| Region client / scroll width | `330 / 330` | `330 / 576` (`246` px of internal scroll) |
| Region internal scroll at 360 / 320 | `0` / `9` px | `276` / `316` px |
| Page scroll width vs viewport | equal | equal |

The width is intrinsic, not a declared preference: with the table's `min-width: 560px` removed in the browser the
table still lays out at `576` px, because two ISO 8601 instants (unbreakable, and printed exactly as served) plus
the longest domain level label (`INFORMACIÓN INSUFICIENTE`, 181 px) are each wider than a phone column. The
alternatives were dropping a served fact or truncating an instant, and both would hide data the board exists to
show. Instead the table keeps the shipped `.table-wrap`: a named, focusable scroll region, the fourth Tab stop,
which responds to the arrow keys — six `ArrowRight` presses moved it `79px` at 390 and 320 while
`window.scrollX` stayed `0` and the page never overflowed. `Lote` wraps inside its cell; no column is hidden at any
measured width.

### Export identity — the served document, not a preview

The fixture serves the real frozen header plus two rows, one with a CRLF inside a quoted cell, and captures the
save at the browser seams.

| Check | Result |
| --- | --- |
| Request | `GET http://localhost:8080/v1/risk/history.csv?zone_id=05102` — the only parameter is the selection |
| Served document | `463` bytes, header + 2 rows |
| Saved bytes | `463` bytes, byte-for-byte equal to the served text; the quoted `"primera\r\nsegunda"` survives |
| Saved file name | `risk-history-05102.csv` (before and after) |
| Displayed file name | `risk-history-05102.csv` — the panel names the name the save really uses; the baseline displayed none |
| Preview artefacts | 0 tables and 0 `<pre>` blocks inside the delivery block (before and after); exactly 1 download button |
| Status copy | `Descarga iniciada: risk-history-05102.csv — las mismas filas que la API devuelve para la zona.` unchanged |

### Contrast (rendered computed styles, Chromium)

Ratios computed in the page from each element's `color` and its nearest opaque painted background.

| Pair | Ratio | Read |
| --- | --- | --- |
| View title `--ink` on `--canvas`, 24px/600 | 10.93:1 | Meets |
| Lede `--muted` on `--canvas`, 11px/400 | 5.07:1 | Meets |
| Panel heading `--ink` on `--paper`, 15px/650 | 11.85:1 | Meets |
| Scope tag `--muted` on `#edf1f2`, 8px/850 | 4.87:1 | Meets (shipped neutral-tag pair) |
| Toolbar label `--muted` on `--paper`, 9px/800 | 5.49:1 | Meets |
| Table header `--muted` on `#f3f4ed`, 9px/550 | 5.01:1 | Meets |
| Level mark `--ink` on `--paper`, 10px/700 | 11.85:1 | Meets (the level is a word; the dot is decorative) |
| Delivery title `--ink` on `--paper`, 13px/650 | 11.85:1 | Meets |
| Fact label `--muted` on `--paper`, 9px/400 | 5.49:1 | Meets |
| Fact value `--ink` on `--paper`, 9px/700 | 11.85:1 | Meets |
| Delivery hint and note `--muted` on `--paper`, 9px/400 | 5.49:1 | Meets |
| Delivery status `--muted` on `--paper`, 10px/400 | 5.49:1 | Meets |
| Empty title `--ink` on `#f8faf7`, 15px/650 | 11.39:1 | Meets |
| Empty copy and status `--muted` on `#f8faf7`, 10px/400 | 5.28:1 | Meets |
| Model scope title `--ink` on `--paper`, 11px/800 | 11.85:1 | Meets |
| Model scope item `--muted` on `--paper`, 10px/400 | 5.49:1 | Meets |
| Model fact label / value, 9px | 5.49:1 / 11.85:1 | Meets |
| Focus ring `#cf7d4f` on `--paper`, 3px | 3.11:1 | Meets non-text 3:1 |

The level dots are `aria-hidden` decoration and repeat a label that is already text, so no meaning depends on
their colour; their fills are the shipped `--level-*-line` tokens.

### States

| Screen | State | Result |
| --- | --- | --- |
| `#history` zone | populated (2 rows, `alto` + `desconocido`) | panel head + scope tag, 5 served columns, level words, delivery block; 1 history read |
| `#history` zone | empty (`[]`) | card states absence is not a low level; table and filter bar hidden by `has-rows`; export remains enabled and states the header-only outcome |
| `#history` zone | unavailable (503) | shipped terracotta status line, no rows, no invented level; delivery block still names the document |
| `#history` zone | export saved | served bytes saved under the real name; status names the file |
| `#history` all zones | series (2 intervals, 1 zone) | scope head `TODAS LAS ZONAS`, window list, interval rows with level words and provenance |
| `#overview` | model panel | heading, status, two version facts, scope block; no table, no inventory, no mock row |

Filter-hidden, filter-restore, retry, sign-out and header-only download states are covered by the DOM suites and
were not screenshotted.

### Automated

The obsolete three-column snapshot in `tests/a11y/table-scroll-regions.test.tsx` was replaced with an ordered
assertion of the visible header names (`Solicitado, Publicado, Nivel, Estado, Lote`) scoped to the history table;
the named-region, wrapper, tabindex, hidden-until-rows and row-count assertions and every other test in that file
are untouched. RED with the five-column table and the old count: that test failed (`expected 3, got 5`) and the
full suite reported `57` files / `1 failed | 772 passed (773)`. GREEN with the name assertion:
`tests/a11y/table-scroll-regions.test.tsx` `6 passed (6)`; the original six focused suites plus it,
`7 files / 151 passed (151)`; `npm run verify` on the final tree passed lint, typecheck,
`57` files / `773` tests, the source gate over `74` shipped files, the local build and the loopback smoke
(exit 0).

### Not measured for T5

No axe scan, text-spacing override, browser-zoom pass, virtual screen reader or real assistive technology ran for
this change. The workspace was not opened with a live authenticated session: the fixtures carry the real
components' markup but not the shell, the gate or a real token, and the catalogue is one synthetic feature. Hover,
active and disabled surfaces of the new blocks were not re-measured (their declared pairs are the shipped ones),
and the history table's reflow was sampled at 1440/1280/1024/390/360/320 only. The table's internal scroll is
described above but the touch-drag gesture itself was not exercised. Long real data — many zones in the series, a
100-row history, a 64-character zone id — was not rendered. Print preview was not produced.

## T6 — prevention, simulation and observations (2026-11-26)

T6 ports boards 06 (acciones preventivas), 10 (simulación contrafactual) and 11 (observaciones de campo) into the
routes the product has: the queue, detail, alta, evidence, review and reassessment in `#actions`, the substitution
and its comparison in `#simulator`, and the register and its list in `#observations`. No route, backend, auth,
shared store, domain contract, dependency or `app.css` rule changed. The new stylesheet is
[`src/styles/field-workspace.css`](src/styles/field-workspace.css), every selector scoped to one of the three ids,
and the one new component is
[`src/components/field-work/FieldStateCard.tsx`](src/components/field-work/FieldStateCard.tsx).

**Environment.** An isolated **Chromium** headless shell (the locally present Playwright
`chromium_headless_shell-1223` build) driven over CDP against `file://` fixtures. Each fixture is the **real
component output**: a temporary jsdom harness rendered the three views with the same stubbed `fetch` the shipped
suites use, and wrote the markup beside the real stylesheets. The *before* pair is the base tree (`7bf567f`,
extracted with `git archive` into ignored `tmp/t6/base`) linked to its own stylesheets, so base markup runs against
base CSS; the *after* pair is this working tree. Same states, same payloads, same stubbed transport. No network,
gateway, Keycloak, credential or backend state; nothing installed. Evidence: `tmp/t6/{before,after}/` (12 states
each), `tmp/t6/measure.json`, `preserve.json`, `keyboard.json`, `contrast.json`, `tmp/t6/shots/`, probe scripts
`probe.mjs`, `tables.mjs`, `factors.mjs`, `focuscheck.mjs` and the fixture renderer `fixtures.test.tsx` (ignored
scratch).

### Composition, before and after

Boxes are the rendered `getBoundingClientRect` of the element named, in CSS px. Left column is `7bf567f`, right
column is this change; the actions row is the populated state with the same two served actions and one open detail.

| Element / viewport | Before | After |
| --- | --- | --- |
| `#actions` view 1440 | `1372×2386` at `y=27`, panels stacked | `1372×2040`; lede `451×35` at `y=100` under the title |
| Actions queue panel 1440 | `1372×476` at `34,27` | `753×579` at `34,27`, head carries `LEÍDO` + `2 acciones` |
| Action detail 1440 | `1372×1379` at `y=519` below the queue | `603×1419` at `803,27`: identity strip `565×23`, description `565×55`, facts `565×108` in two columns |
| Alta panel 1440 | `1372×499` at `y=1914` | `1372×605` at `y=1462`: two groups (`record` `1334×287`, `owner` `1334×135`) and one submit |
| Actions queue panel 390 | `360×702` | `360×754`, one column; the detail follows at `y=806` |
| Action detail 390 | `360×1588` | `360×1694`: strip `322×23`, description `322×71`, facts stacked `322×223` |
| Empty queue card 1440 | none (status block only) | card `1334×106` at `53,382`; the empty table region is hidden |
| Empty queue card 390 | none | card `330×122` at `30,623` |
| Refused queue card 1440 | none | card `1334×104` at `53,382`, tinted `#fdf6ef` |
| Filtered queue card 1440 | `.empty-state` text block | card on `--paper` with the dashed mark and the reset inside |
| Simulator factor block 1440 | table `657×238` at `y=437` | eyebrow + table `657×263` at `y=466` + note `657×29` at `y=710`; `Sustitución aplicada` `132×12` at `y=759` |
| Simulator factor block 390 | table `327` wide | table `327` wide (block flag keeps the baseline width), note `322×43` |
| Observation record 1440 | `687×122` | `687×135`: type mark `105×22`, emphasized zone |
| Observation list 1440 | `725×514` (populated) / `725×229` (unavailable) | `725×539` / `725×333` with the error card `687×104` |
| Observation record 390 | `330×122` | `330×135`, one column (shipped layout) |

### PRESERVE — differential against the baseline

The same probe ran against both trees at 1440, 1280, 1024, 390 and 320 px.

- **Identifiers.** No shipped identifier is lost in any state (`lost vs base: none` in all twelve). `#actions`
  keeps 19 ids plus 22 detail ids; the queue table and its tbody stay in the DOM when the region is hidden
  (`hidden` is on the shipped `.table-wrap`, not on `#actions-table` or `#actions-rows`).
  `#simulator` keeps 13 ids plus 13 result ids; `#observations` keeps 20. Eleven ids are added to `#actions`
  (lede, count, the two state cards, the filters label, the strip plus its two values, the description and the two
  alta groups), four to `#simulator` (applied, delta, factors eyebrow, factors note) and one to `#observations`
  (`observation-list-state`); none is renamed.
- **Controls.** Visible control counts are identical to the baseline in every state and viewport: actions
  populated `6` text inputs / `3` selects / `11` buttons / `1` link / `3` textareas / `1` date; actions empty and
  refused `4` / `2` / `3` / `0` / `1` / `1`; simulator `1` select, `5` checkboxes, `5` number inputs, `1` button;
  observations `3` selects, `1` date, `1` textarea and the same button count per state. Label counts are identical.
- **Copy.** Every pre-existing measured text is byte-identical before and after: both action statuses, the detail
  status, every simulator status and run message, and every observations status and count. The only text
  differences are the new elements (`2 acciones`, `Sustitución aplicada`, `Nivel antes → después`).
- **Keyboard.** At 390 px the Tab sequence is identical in both builds for the sampled states
  (`actions-populated`, `actions-empty`, `simulator-result`, `observations-populated`): filters → the list table
  region → `Ver detalle` → the detail's tables and evidence fields → review → reassessment → transitions → the alta
  in its shipped order. Every stop paints `3px solid rgb(207, 125, 79)`; the three textareas were the exception
  in both builds (`1px auto`, the browser's own ring) before the correction below.
- **Reflow.** `document.documentElement.scrollWidth === window.innerWidth` at 1440, 1280, 1024, 390 and 320 in all
  twelve states and in both builds; no page error was logged by either build.
- **Queue table.** The seven-column table keeps its shipped scroll region and its measured width where the
  composition changed: 1440 `715/715` (fits), 1280 `626/626` (fits, exactly its min-content), 1024 `938/938`
  (stacked, full width), 390 `330/892` and 320 unchanged from the baseline. The detail's five tables fit their
  column at 1440 (`565/565`), 1280 (`494/494`), 1024 (`938/938`) and keep the baseline scroll at 390.
- **Simulator factor table.** Block-placing the flag keeps the baseline table width: 390 client `322` / scroll
  `327` before **and** after, 320 `252/327` before and after. The flag adds height, not width.
- **Observations list.** The shipped `<ul>/<li>` structure, the server-side filter, the adoption disclosure and
  the two empty cards keep their ids, copy and focus behaviour; the list gains an `aria-label` and the record head
  a type mark.

### The two-column decision, measured

Board 06 runs the queue and the selected action side by side from 1000 px. Its queue is a card list; the
production queue is a seven-column `<table>`. Measured with the balanced `1.02fr/.98fr` columns and a `1000px`
collapse, the queue table showed an internal scroll of `43` px at 1280 (`615` vs `572`) and `163` px at 1024
(`615` vs `452`) — the primary surface would have needed a scrollbar to reach `Ver detalle`. Two corrections
followed: the columns became `1.25fr/1fr`, and the pair only sits side by side from **1280 px**, where both
columns fit (`626/626` and `494/494`). Below that the view keeps the shipped single-column order.

### Contrast (measured in Chromium, rendered computed styles)

Ratios computed in the page from each element's `color` and its nearest opaque painted background.

| Pair | Ratio | Read |
| --- | --- | --- |
| Actions lede `--muted` on `--paper`, 11px | 5.49:1 | Meets |
| Queue count `#52646b` on `#edf1f2`, 8px/850 | 5.44:1 | Meets |
| Empty card title `--ink` on `#f8faf7`, 13px/650 | 11.39:1 | Meets |
| Empty card body `--muted` on `#f8faf7`, 10px | 5.28:1 | Meets |
| Empty card eyebrow `--forest-700` on `#f8faf7`, 9px/800 | 7.08:1 | Meets |
| Error card title `--ink` on `#fdf6ef`, 13px/650 | 11.16:1 | Meets |
| Error card body `--muted` on `#fdf6ef`, 10px | 5.18:1 | Meets |
| Error card eyebrow `#9c472f` on `#fdf6ef`, 9px/800 | 5.84:1 | Meets |
| Filtered card title / body / reset on `--paper` | 11.85 / 5.49 / 7.36:1 | Meets |
| Detail identifier `--ink` on `--paper`, 10px/650 | 11.85:1 | Meets |
| Detail deadline `--muted` on `--paper`, 10px | 5.49:1 | Meets |
| Description label `--muted` on `--soft`, 9px/800 | 4.86:1 | Meets (lowest measured pair) |
| Description text `--ink` on `--soft`, 10px | 10.47:1 | Meets |
| Detail fact label / value, 9px / 10px | 5.49 / 11.85:1 | Meets |
| Alta legend `--forest-700` on `--paper`, 9px/800 | 7.36:1 | Meets |
| Detail state chip `--ink` on `--soft`, 10px | 10.47:1 | Meets (shipped `#actions` override) |
| Applied substitution `--ink` on `--paper`, 9px/700 | 11.85:1 | Meets |
| Substituted flag `--forest-700` on `--soft`, 8px/850 | 6.51:1 | Meets |
| Factor note `--muted` on `--paper`, 9px | 5.49:1 | Meets |
| Observation type mark `--ink` on `--soft`, 9px/800 | 10.47:1 | Meets |
| Observation zone `--ink` on `--paper`, 11px/650 | 11.85:1 | Meets |
| Observation error title `--ink` on `#fdf6ef`, 13px/650 | 11.16:1 | Meets |
| Focus ring `#cf7d4f` on `--paper`, 3px | 3.11:1 | Meets non-text 3:1 |
| Focus ring `#cf7d4f` on `#f8faf7` (measured, not used behind a control) | 2.99:1 | Below 3:1 — why the filtered tone uses `--paper` |

### States

| Screen | State | Result |
| --- | --- | --- |
| `#actions` | populated + open detail | workbench, count badge, identity strip, description, fact grid, alta groups; 2 rows, 2 history rows |
| `#actions` | empty (`[]`) | card states the response carried no row; the table region is hidden; no reset is offered |
| `#actions` | filtered to zero | its own card on `--paper` with `Limpiar filtros` inside |
| `#actions` | refused (403) | tinted card naming the denial; the status line keeps `HTTP 403 · forbidden · request_id` |
| `#actions` | directory 503 | the alta's responsible group keeps the unassigned option, the retry and the refusal text |
| `#simulator` | prefilled | shipped layout; no result block, no substitution summary |
| `#simulator` | result | before/after pair, factor eyebrow, two `Sustituida` flags, factor note, applied substitution and level delta |
| `#simulator` | refused (422) | shipped `run-status` refusal; no result and no factor block |
| `#observations` | populated | two records with type mark, date, emphasized zone, description, attribution and the stored adoption block |
| `#observations` | empty (`[]`) | shipped empty card; no error card |
| `#observations` | unavailable (503) | tinted card; status line keeps `HTTP 503 · storage_unavailable · request_id` |
| `#observations` | filtered to zero | shipped filter-empty card with `Quitar el filtro` |

Sign-out, retry, form validation, write-uncertainty and session-replacement states remain covered by the DOM
suites rather than screenshots.

### Keyboard and focus (measured)

At 390 px the sampled sequences are identical to the baseline (see PRESERVE). Every stop painted the shipped
`3px solid rgb(207, 125, 79)` except the textareas, which the shipped `:focus-visible` rule does not list. Focused
directly in both builds: `#evidence-criterion` and `#create-description` measured `1px auto rgb(16, 16, 16)` before
and `3px solid rgb(207, 125, 79)` after; `#create-title` and `#create-due-date` measured the shipped ring in both.
The `Sustituida` flag is plain text inside the row header, so it adds no Tab stop, and the state cards add no
control except the reset the filtered card already had.

### Automated

Fourteen public-behaviour tests were added and no existing assertion was weakened or removed: seven in
`tests/views/actions.test.tsx` (lede and count, unfiltered empty card, filtered card separation, refused card,
identity strip plus description, alta groups, hidden table region), one in `tests/views/simulator.test.tsx`
(applied substitution, level delta, substituted flags, factor note), two in `tests/views/observations.test.tsx`
(record head and list name, unavailable card), and four in `tests/a11y/actions-accessibility.test.tsx` (group
legends and names, one announcement per refusal, textarea ring, filtered card surface). RED before the product
edit: `10 failed | 69 passed (79)`. GREEN after: the required seven suites `7 files / 108 passed (108)`.
`npm run verify` on the final tree passed lint, typecheck, `57` files / `787` tests, the source gate over `76`
shipped files, the local build and the loopback smoke (exit 0).

### Not measured for T6

No axe scan, text-spacing override, browser-zoom pass, virtual screen reader or real assistive technology ran for
this change. The workspace was not opened with a live authenticated session: the fixtures carry the real
components' markup but not the shell, the gate or a real token. The composition was sampled at 1440, 1280, 1024,
390 and 320 CSS px; 375, 414 and 768 were not sampled, and the 390 px first fold is dominated by the shell the
T1/T2 scope leaves in place. Hover, active and disabled surfaces of the new blocks were not re-measured (their
declared pairs are the shipped ones). Long real content — an action titled well past 120 characters, 200 queue
rows, many observations, a 64-character identifier — was not rendered. The simulator's factor flag was measured
in the two-substitution state only. Print preview and the touch-drag gesture on the internal scroll regions were
not exercised.

## T7 — access and operations (2026-11-26)

T7 ports boards 14–19 into the seven screens the product already has: the AUTH gate and `#sources`, `#status`,
`#jobs`, `#session`, `#audit`, `#pending`. No route, backend call, auth step, role decision, protocol, store,
domain contract, shared UI, `app.css` rule or dependency changed. The new stylesheet is
[`src/styles/operations-workspace.css`](src/styles/operations-workspace.css) (imported by the six workspace views)
and the auth rules appended to [`src/styles/auth.css`](src/styles/auth.css); the new component file is
[`src/components/operations/OperationsPrimitives.tsx`](src/components/operations/OperationsPrimitives.tsx).

**Environment.** An isolated **Chromium 148.0.7778.96** (the locally present Playwright-managed
`chromium-1223` build, launched headless through Playwright from the npx cache) against a Vite dev fixture that
imports the **real `App`, `Shell`, `ProductNav`, views, stylesheets and session module**. The only substitution is
`window.fetch`: the token exchange and the twelve gateway reads are answered by a local stub, so a session is
established through the shipped Authorization Code code path without Keycloak, and every view renders the state its
own domain code derives from the payload. No credential, cookie, live gateway, live Keycloak, backend write or
database access; nothing installed. Fixture and probe live in the OS temp directory; evidence is ignored scratch:
`frontend/tmp/t7-evidence/` (after) and `frontend/tmp/t7-evidence-base/` (base `dbcd7a9` extracted with
`git archive`, 28 files each), screenshots `*.png`, measurements `report.json`.

**Samples.** 9 scenes × 3 viewports = **27 samples** per tree: `auth`, `sources`, `status`, `jobs`, `session`,
`audit`, `pending`, plus `audit403` (register answers 403) and `sources503` (provenance answers 503), at
1440×900, 1024×768 and 390×844. **0 console errors, 0 uncaught page errors and 0 px page-level horizontal overflow
in all 27** (base tree: same).

### Composition, before and after

Boxes are `getBoundingClientRect` in CSS px. Left is `dbcd7a9`, right is this change.

| Element / viewport | Before | After |
| --- | --- | --- |
| Sources view 1440 | `1138×1496`, title + banner + three stacked panels | `1138×1682`; head `1138×118` at `y=186`, banner at `y=320`, stack `782` + side `340` at `y=398` |
| Sources side facts 1440 | full-width panels | side `340`; facts stated as rows (`8px 0`, value left, `100%`) |
| Status view 1440 | `1138×852`, title + verdict + table | `1138×931`; head `1138×156`, stack `782` + side `340`; table `744/744` (no internal scroll) |
| Status states 1440 | none | five rows in the side block, in the contract's order |
| Jobs view 1440 | `1138×335`, one panel | `1138×662`; in-card head `1100×100`, stack `744` + side `340`, four-step flow block |
| Session view 1440 | `1138×2109`; matrix `389` wide, `520` scroll width | `1138×1995`; head `1138×136`, matrix column `744` wide and `744` scroll width (no internal scroll), account at side `340`, two documentation blocks below |
| Audit view 1440 | `1138×375`; register full width `1100/1100` | `1138×612`; in-card head `1100×101`, register still `1100/1100`, legend under it in two columns |
| Audit 403 1440 | `1138×246` | `1138×484`; badge `SIN PERMISO`, `HTTP 403 · forbidden` copy, table region stays hidden `0/0` |
| Pending view 1440 | `1138×467` | `1138×512`; in-card head `1100×100` with the real count `5`, table `1100/1100`, closing note |
| Auth gate 1440 | page `1440×900`; card `420×583` at `879,159` (vertically centred) | page `1440×1224`; card `420×583` at `879,40` (the stack is taller than the viewport, so `align-content: safe center` pins it to the top and the primary action moves **up**); the two reference panels (`420` wide, `545` tall together) follow from `y=639` |
| Auth gate 390 | card `358×569` at `16,407`; sign-up panel from `500`; primary action `771–817` | page `390×1690`; card at `16,431`; sign-up panel from `524`; primary action `794–840`, still fully inside 844 after the mobile chip spacing; panels `358` from `y=1030` |
| Any view 1024 | single shipped layouts | `.ops-layout` one column; side reflows by width (`sources` two `376` columns, single-block sides full width `730/768`) |
| Any view 390 | single column | single column `360` (or `330` inside a panel); no page overflow |

The first fold at 390 px is still dominated by the shell (T1/T2 scope), so the new heads start below it. On the
sign-in gate the primary action is above the fold at 1440 and 1024, and stays inside it at 390×844: measured
`794–840` against an 844 px viewport (base `771–817`). The `+24px` at 390 is the new state-chip row after its
mobile spacing, which was reduced to keep the button visible.

### PRESERVE — differential against the baseline

The same 27 samples ran against `dbcd7a9` (`git archive`, own stylesheets) and this tree.

- **Identifiers: 0 lost in all 27 samples.** Added ids, identical in each of the three viewports per scene:
  `auth` +5 (`auth-state`, `auth-facts`, `auth-facts-title`, `auth-states`, `auth-states-title`), `sources` +1
  (`sources-head`), `status` +3 (`status-head`, `status-states`, `status-states-title`), `jobs` +3 (`jobs-head`,
  `jobs-flow`, `jobs-flow-title`), `session` +5 (`session-head`, `session-verification`,
  `session-verification-title`, `session-limits`, `session-limits-title`), `audit` +3 (`audit-head`,
  `audit-states`, `audit-states-title`) and `pending` +3 (`pending-head`, `pending-count`, `pending-note`). No id
  was renamed or removed.
- **Controls: identical counts in all 27 samples** — `main`/auth `button`, `a`, `select` and `input` counts match
  the base tree exactly. The new heads, steps and legends are `section`/`ol`/`ul`/`dl`/`span`, so they add no
  control, no tab stop and no disabled affordance.
- **Behaviour: the shipped suites are unchanged.** The 168 pre-existing tests in the focused command
  (`auth`, `sources`, `status`, `jobs`, `session`, `audit`, `pending`, `core/session`, `app/router`,
  `a11y/heading-hierarchy`, `a11y/table-scroll-regions`) pass before and after without a single edited assertion;
  the extensions are additive. The full suite is `57 files / 795 tests` (base `787`), all passing.

### States

| Screen | State | Observed |
| --- | --- | --- |
| `#sources` | provenance read | badge `PUBLICADA`, integrity sentence names the service's own verification |
| `#sources` | provenance 503 | badge `NO DISPONIBLE`; `Procedencia geográfica no disponible (HTTP 503 · unavailable)…`; no green mark, no invented rule identity |
| `#status` | all services ready | badge `OPERATIVO`; legend lists `Listo · Degradado · Desconocido · Requiere admin · No configurado`; table `744/744` |
| `#jobs` | no job yet | `Sin trabajo para la zona seleccionada.` / `Sin solicitud`; `Actualizar estado` is disabled and therefore not in the Tab order |
| `#session` | token read | badge `TOKEN LEÍDO`, roles `viewer, admin` verbatim; limits block states the deliberate absences |
| `#audit` | read | badge `LEÍDO`, two rows, count `2` |
| `#audit` | 403 | badge `SIN PERMISO`, `HTTP 403 · forbidden` sentence, count `—`, table region hidden |
| `#pending` | inventory | count `5` (the exported list's length), `NO IMPLEMENTADO` badge, closing note, no control |
| AUTH | no session / registering | chip `Sin sesión` + `Entrada sin credenciales`; `#registro` opens the sign-up tab; no credential field |

No scene reports a success it did not observe: the pending and 403 states are the served state, and the jobs idle
state keeps the disabled refresh.

### Keyboard and focus (measured)

Sixteen sequential `Tab` presses were recorded per scene and viewport. Every stop except the document body (the
cycle point) painted a `solid 3px` outline: the shipped `rgb(207, 125, 79)` on paper, `rgb(215, 170, 115)` in the
product bar and `rgb(167, 77, 52)` on the canvas/skip link. The new blocks add no stop. Reachable in the recorded
order: `#audit-table` (the named scroll region, with its ring), the session matrix wrapper, `#scenario-select`,
`#create-job`, `#account-console`, `#audit-refresh`, `#readiness-refresh`, `#logout`, `#data-status-notice`,
`#reset-filters` and the two auth tabs plus `#register`/`#login` and the inline switch. The page cycles rather
than trapping focus, and the auth gate keeps its roving tabindex (one tab stop for the selected tab).

### Contrast (rendered computed styles, Chromium)

Font colours were read from the rendered element and ratios computed against the declared background token. The
auth chip sits on a gradient; its own `rgba(255 255 255 / 4%)` overlay is reported, and the ratio uses the hero's
`--forest-900` base (the overlay only lightens it).

| Element | Size | Rendered colour | Background | Ratio |
| --- | --- | --- | --- | --- |
| `.ops-chip` | 9px | `rgb(35, 59, 57)` | `--soft` | 10.47:1 |
| `.ops-lede`, `.ops-step p`, `.ops-states span`, `.ops-note` | 9–11px | `rgb(92, 108, 101)` | `--paper` | 5.49:1 |
| `.ops-step-num` | 9px | `rgb(40, 94, 86)` | `--soft` | 6.51:1 |
| `.ops-states strong`, `.auth-facts dd` | 10px | `rgb(35, 59, 57)` | `--paper` | 11.85:1 |
| `.auth-chip` | 9px | `rgb(213, 225, 219)` | hero base `#173c3b` | 8.95:1 |
| `.auth-aside-eyebrow` | 9px | `rgb(133, 105, 30)` | `--paper` | 5.16:1 |
| `.auth-facts dt`, `.auth-state-list span`, `.auth-aside-note` | 9–10px | `rgb(92, 108, 101)` | `--paper` | 5.49:1 |

All new text pairs meet 4.5:1. The focus ring was not re-declared: every new element is non-interactive, and the
existing controls keep the shipped ring.

### Automated

Eight public-behaviour tests were added (two in `tests/views/auth.test.tsx`; one each in `sources`, `status`,
`jobs`, `session`, `audit` and `pending`), and four existing `a11y/heading-hierarchy` cases plus three existing
`a11y/table-scroll-regions` cases were extended with assertions; no existing assertion was weakened or removed.
**RED before the product edit:** the nine touched suites ran `11 failed | 121 passed (132)`, each failure the
missing head/legend/count contract (for example `expected null not to be null` on `#sources-head`). **GREEN after:**
the required focused command runs `11 files / 176 passed (176)`. `npm run verify` on the final tree passed lint,
typecheck, `57` files / `795` tests, the source gate over `78` shipped files, the local build and the loopback
smoke (exit 0). `git diff --check` is clean.

### Not measured for T7

No axe scan, text-spacing override, browser-zoom or 200% text-resize pass, virtual screen reader or real assistive
technology ran for this change. The fixture carries the real shell and the real session module, but not a live
authenticated gateway, a live Keycloak or a real token; the auth round trip is the shipped code against a local
stub. Only 1440×900, 1024×768 and 390×844 were sampled — 1280, 768, 375, 320 and landscape phones were not. Long
real content (100 audit events, dozens of scenario options, a 64-character action id) was not rendered. Hover,
active and print surfaces of the new blocks were not re-measured (they declare the shipped ones); the product has
no dark mode, so none was checked. The register's legend was moved below the table after measurement showed a
horizontal scrollbar beside it at 1440; the 1024 audit table still scrolls internally (`730/833`) inside its named,
focusable region.

## T8 — integrated proof and the retired sidebar rule (2026-11-27)

T8 closes the migration with a whole-app proof and the one carry-forward cleanup C1 authorised: the
`.sidebar nav` rule in [`src/styles/app.css`](src/styles/app.css), whose only reader was a source-gate
assertion, is removed, and the gate now asserts the live contract instead (§7 of
[`scripts/check.mjs`](scripts/check.mjs)): the column keeps `position: sticky`, `top:
var(--product-nav-h, 48px)`, `height: calc(100vh - var(--product-nav-h, 48px))` and its own `overflow-y`;
`.product-nav` stays `sticky` at `top: 0` with `min-height: var(--product-nav-h…)`; and
`.product-nav__panel` stays `position: absolute`, `max-height: min(70dvh, 520px)` and `overflow-y: auto`.
The 720 px rule that releases the column's fixed height is unchanged. No route, view, session, API, store or
dependency changed. The gate reads each declaration at its own boundary, removes comments the way CSS
parsers do, collapses whitespace, and then compares **exact intended values**: `top: 0` (or strictly `0px`)
for the bar, `min(70dvh, 520px)` for the base menu rule and `min(72dvh, 480px)` inside the
`max-width: 720px` override. It accepts no grammar: `0.5rem`, `0foo` or a `dvh` token hidden in a comment is a
different value, and a design change to any of them updates the guard deliberately in the same change.

**The served stylesheet is the same bytes minus that rule.** The before build (`8d1951e`) and the after build
produce `84,017` and `83,924` bytes of CSS; removing
`.sidebar nav{flex:auto;align-content:start;gap:3px;min-height:0;display:grid;overflow-y:auto}` from the before
asset makes the two files byte-identical. That rule never matched rendered markup: `Shell` renders no `<nav>`
inside `aside.sidebar`, and the only navigation is `nav.product-nav`. The layout test now pins both halves — the
markup and the rule's absence.

**Environment.** An isolated **Chromium 148.0.7778.96** (the locally present Playwright-managed `chromium-1223`
headless shell, driven from the npx cache; nothing installed) against the **real built application**
(`npm run build:local`, `dist/`) served by a fixture server on loopback **:4199** (after) and **:4198** (base),
with the shipped Content-Security-Policy. The only substitution is `window.fetch`, installed before any app module
runs and answered from a synthetic fixture table (the token endpoint and 20 gateway route entries); the identity
provider's document navigation is intercepted with a **302 that echoes the app's own `state` and `redirect_uri`**.
No live gateway, Keycloak, credential, cookie, backend write, external network or install; the user's `:4173`
listener was not touched. Evidence is ignored repo scratch `frontend/tmp/t8-evidence/` (`report.json`,
`preserve.json`, 25 screenshots). The probe, fixture server and fixture table were run from an OS-temp copy
(`fw-t8-probe/`) because `eslint .` lints everything inside the project, and the `8d1951e` tree was extracted and
built there too (`fw-t8-base-8d1951e/`) rather than in a worktree or a second `tsconfig.json` under `frontend/`.
OS temp is ephemeral; the artifacts above are the durable evidence. The invocation used was
`node "<OS temp>/fw-t8-probe/t8-probe.mjs" dist "<OS temp>/fw-t8-base-8d1951e/frontend/dist" tmp/t8-evidence`.
The matrix was not repeated for the gate/documentation correction: no runtime file changed, so these measurements
still describe the product.

**Samples.** 15 hashes × 4 viewports = **60 samples per tree**, 120 total: `1440×900`, `1024×768`, `390×844`
and `320×800`. **0 console errors, 0 uncaught page errors, 0 failed requests and 0 px page-level horizontal
overflow in all 60** after samples (base tree: same). Every sample rendered its own view: 41–343 content nodes,
one `aria-current="page"` destination, and identical control/tab-stop counts in both trees. The fixture answered
every call the sessions made: 24 calls and **0 unmatched paths** per viewport, one token exchange each.

| Shell measurement (after, `#overview`) | 1440×900 | 1024×768 | 390×844 | 320×800 |
| --- | --- | --- | --- | --- |
| `.product-nav` box | `1440×48` at `y=0` | `1024×48` at `y=0` | `390×48` at `y=0` | `320×89` at `y=0` (wrapped) |
| `.sidebar` box / computed | `234×852` at `y=48`, `sticky` | `208×720` at `y=48`, `sticky` | `390×234.5` at `y=48`, `static` | `320×234.5` at `y=89`, `static` |
| `#logout` | `838–877`, fully visible | `706–745`, fully visible | `246–271`, fully visible | `287–312`, fully visible |
| document `scrollWidth` / `innerWidth` | `1440/1440` | `1024/1024` | `390/390` | `320/320` |

The 320 px sample shows the offset contract doing its job: the bar wraps to `89 px`, `ProductNav` publishes the
measured height, and the static column starts at `89 px` instead of under the bar.

### PRESERVE — differential against `8d1951e`

The same 60 samples ran against the base tree. Compared per sample: id set, control counts, tab stops, content
node count, route hash, document title, live-region ids, page overflow and the `.product-nav`, `.sidebar` and
`main` boxes to 0.1 px. **Differences: 0.** The four keyboard journeys (below) also matched member by member:
skip-link result, menu control and box, 11 panel rows, `#logout` geometry, sign-out result and the
back/forward hash states.

### Integrated journeys (measured, all four viewports)

- **Signed out.** `/`, `#audit` with no session renders only the AUTH gate (`auth-page` present, no `.app-shell`,
  no sidebar, `Sin sesión` chip); `sessionStorage` is empty. The primary action (`Continuar con Keycloak`,
  `#login`) navigates to the identity provider with `client_id=firewatch-demo`, `response_type=code`,
  `scope=openid`, `code_challenge_method=S256`, a `state`, a `code_challenge` and
  `redirect_uri=http://localhost:4199/` — the registered spelling class. The
  intercepted 302 returns the callback, the token exchange runs through the stubbed transport, the page returns
  signed in (`Sesión conectada`), and the PKCE transaction is removed.
- **Skip link and focus.** Tab focuses `Saltar al contenido` first, with `solid 3px rgb(167, 77, 52)` — the
  terracotta `:focus-visible` override the skip link shares with the canvas controls, not the paper ring; Enter
  moves focus to `main#content` and leaves `#overview` in the address bar.
- **Product menu.** **Más destinos** is reached by Tab (focus ring `solid 3px rgb(215, 170, 115)` = the bar's
  `#d7aa73`); Enter opens the panel (`aria-expanded="true"`) with 11 destinations, `position: absolute`, fully
  inside the viewport (`51–376`, `51–376`, `51–531`, `92–572`), scrollable inside itself at 390 and 320 px, and
  **the shell and column tops do not move** (`48 → 48` at 1440/1024/390, `89 → 89` at 320). Escape closes it and
  returns focus to the button. Tab reaches the grouped destinations; Enter on `Estado de servicios` changes the
  hash, closes the panel and marks `aria-current`. Back returns to `#overview` (panel closed); Forward returns to
  `#status` and reveals the current destination in the panel.
- **Overlay geometry while open.** Out of flow means the page does not move; it does not mean the panel cannot
  cover a control. The measured panel box overlaps the sign-out control at the two phone widths: at 390×844 the
  panel occupies `y 51–531` and the `≤720px` rule paints it `right: 8px; width: calc(100% - 16px)` (x 8–382),
  while `#logout` is at `x 300–368, y 246–271`; at 320×800 the panel is `y 92–572`, x 8–312, and `#logout` is at
  `x 230–298, y 287–312`. With the overlay open at those widths the sign-out control is geometrically covered.
  Escape closes the panel and returns focus to the disclosure; the hit-test recorded above is the closed state.
  No occlusion compensation (scroll-into-view, z-index, a focus guard) was added or measured.
- **Sign-out control.** Present, enabled, `tabIndex 0`, inside the viewport and hit-testable at all four
  viewports; Tab reaches it and paints `solid 3px rgb(207, 125, 79)`. Activating it runs the shipped RP-initiated
  logout URL (`client_id`, `id_token_hint`, `post_logout_redirect_uri`) and lands back on the gate.
- **Read journeys.** History renders the two fixture rows; typing a nonmatching query empties the table (`0`) with
  the shipped filtered copy, and clearing it restores both rows (identical at 1440 and 390; the 390 table keeps
  its named, focusable scroll region `330/560`). Notifications render 2 alerts with `Mostrando la página 1`;
  Audit renders 3 rows with badge `LEÍDO` and count `3`; Overview paints all 3 map comunas and the published batch
  as `ALTO` with its factors, rationale and policy.

**Text scale.** No browser-zoom or text-spacing control exists in this headless build without installing tooling,
so neither was run. What was sampled is the layout a `1280×900` window presents at 200 % browser zoom — a
**`640×450` CSS-px viewport** — on `#overview`, `#history`, `#status`, `#audit` and `#pending`: page overflow `0`
in all five, tab-stop counts unchanged. That is a reflow sample, **not** a text-resize or zoom pass.

**Automated.** RED before the cleanup: the new layout assertion failed alone — `1 failed | 4 passed (5)` in
`tests/styles/layout-padding.test.tsx`, on the dead-rule pattern — while its live markup and scroll assertions
passed. GREEN after: the required focused command runs `4 files / 46 passed (46)`.
`npm run check` passes over `78` shipped files with the new bar/menu assertions. `npm run verify` passes lint,
typecheck, `57` files / `796` tests, the source gate, the local build and the loopback smoke (exit 0).
`git diff --check` is clean.

**Gate hardening, proven by mutation.** Both verifier corrections were proven against isolated copies (the shipped
`src/**` and `index.html` copied to OS temp; one mutation per copy; the working tree never touched), running the
previous gate and the current gate over the same input. *First round:* shipped desktop + mobile `PASS` in both;
bar `top: 0` → `top: 0.5rem` passed the previous gate (`/top:\s*0/` matched the substring) and fails now; desktop and
mobile `max-height` → `9999px` passed the previous gate (it never read the 720 px override) and fail now.
*Second round:* the then-current gate accepted `top: 0foo` (a zero-prefix pattern) and
`min(9999px, 9999px /* 70dvh */)` in both the desktop and the 720 px rules (a token search found `dvh` inside the
comment); the current exact-value guard rejects all three, each on its own invariant, while the unchanged
declarations still `PASS`. `npm run check` on the real tree is `PASS`.

**Runtime unchanged.** This correction edits only `scripts/check.mjs` and the T8/VISUAL/WCAG prose. The product
stylesheet, views, routes, auth, data and every other gate section are untouched, so the recorded matrix and the
`8d1951e` PRESERVE differential remain the product's evidence; the browser run was not repeated.

### Not measured for T8

No axe scan: `@axe-core/*` is not installed and installing it was out of scope. No real browser-zoom control, no
text-spacing override, no print or forced-colors pass, no virtual screen reader and no real assistive technology.
The fixture carries the real built bundle, the real shell, router, views and session module, but not a live
authenticated gateway, a live Keycloak or a real token; the round trip is the shipped code against local stubs and
a 302 standing in for the provider's document. Signed-out access is that fixture gate, not a live realm
configuration. Screenshots are Chromium 148 only; `1440`, `1024`, `390` and `320` were sampled, and landscape
phones, `768` and `1280` were not. Hover, active and print surfaces of the shell were not re-measured (no rule that
paints them changed).

### Board to production, and what stayed out

| Boards | Landed in | State |
| --- | --- | --- |
| 01 vista aérea, 04 cobertura territorial, 21 lecturas por sector | `#overview`, `#infrastructure` | real map, catalogue and published batch |
| 05 historial, 12 exportación CSV, 20 datos del modelo | `#history` (+ export block), `#overview` model panel | real reads, exact served CSV bytes, public metadata only |
| 06 acciones, 10 simulación, 11 observaciones | `#actions`, `#simulator`, `#observations` | real list/detail/alta, rule application, observations |
| 07 panel ejecutivo, 08 comparador, 09 notificaciones | `#executive`, `#compare`, `#notifications` | real server summary, real catalogue comparator, stored alerts |
| 14 acceso, 15 fuentes, 16 procesamiento, 17 sesión, 18 registro, 19 no implementado | AUTH gate, `#sources`, `#jobs`, `#session`, `#audit`, `#pending` | real states and refusals, stated absences |
| 02 vista regional, 03 acciones en el mapa, 13 ficha de zona | — | **out of scope:** no route or served capability; no PDF/ficha or map action was invented |

**Out of scope, deliberately.** Every prototype-only affordance stayed in the boards: mock sectors and coordinates,
the camera poses, the cutoff slider, the illustrative queue and job controls (publish/advance/reevaluate), the
simulated Keycloak opener and illustrative sessions, the role picker, the PDF zone sheet, per-event detail
selection, the record "incorporate" action, the theme toggle and the prototype links. No endpoint was invented,
no registration or operations capability was faked, and no board value was copied into the product. Every state
the product shows is one the server answered, or an explicit statement that it could not be answered.
