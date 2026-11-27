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

The shell now renders [`ProductNav`](src/components/ProductNav.tsx) as the approved canvas' arrangement: a thin horizontal bar above and outside the workspace, with three shortcuts and an out-of-flow **Más destinos** panel. Routing, the document title, the session gate, the store, the role handling and the gateway polling are untouched; the same fourteen hashes are the only destinations. The canvas' fourth shortcut, `Panel ejecutivo`, was not implemented because no route serves it; that decision is T4's.

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

`#overview` now opens as the aerial workspace of the approved board: the map is the canvas, the workstation rail stands beside it, and the published-batch card is the reading below. Only the composition, the rail and the scoping stylesheet are new — [`src/styles/aerial-workspace.css`](src/styles/aerial-workspace.css), every selector under `#overview`. `MapPanel`, the `ui` primitives, the store, the routes, the API, auth and the eleven other views are untouched, and the board's experimental aerial palette was not adopted.

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
