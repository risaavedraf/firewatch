# FireWatch frontend

The FireWatch web application: a React 19 + TypeScript client built with Vite, served as
static assets on its own origin, and talking to the backend API on another. It replaced a
single-file, framework-free page; the reasons and the parity obligations are recorded in
[`odd/urgent/rediseno-pagina/app-react-vite.md`](../odd/urgent/rediseno-pagina/app-react-vite.md).

## Layout

| Path | Responsibility |
| --- | --- |
| `index.html` | Vite entry: the document and the `#root` mount point. No page content lives here |
| `src/config.ts` | The two external origins, the identity provider, the consumed routes and the timing bounds |
| `src/types/api.ts` | Declared payload shapes. Declarations, not guarantees: consumers validate at the boundary |
| `src/app/routes.ts` | The ten workspace views and their four navigation groups |
| `src/views/AuthView.tsx` | The sign-in and sign-up screen shown instead of the workspace while there is no session. Both buttons open Keycloak; the page renders no credential field |
| `src/app/useHashRoute.ts` | Hash routing: reads the view from the address bar, follows back/forward, normalises an unknown hash |
| `src/components/Shell.tsx` | Sidebar, topbar, update bar and footer, and the workspace skip link that moves focus into `#content` |
| `src/components/ui.tsx` | Presentation primitives: `Icon`, `Chip`, `Metric`, `PanelHeading`, `DataList`, `StatusCopy`, `EmptyState`, the "not implemented" markers |
| `src/components/map/` | Territorial map projection and level colouring |
| `src/core/api.ts` | Transport: one function per consumed route, absolute gateway URLs, sequence fences, deadlines |
| `src/core/history-csv.ts` | The CSV export read: the same bearer and fences as the JSON transport, but the served bytes are downloaded as-is |
| `src/core/session.ts` | OIDC PKCE, the in-memory token, the unverified role claim, logout |
| `src/domain/` | Pure rules: validity, level mapping, fail-closed batch and provenance acceptance, readiness, history filters, the PM-18 recommendation catalogue |
| `src/views/` | The workspace views and the unauthenticated screen |
| `src/styles/` | `tokens.css` (palette, level colours, type), `app.css` (layout, components, responsive), `auth.css` (sign-in), `observations.css` (PM-09) and `notifications.css` (PM-08) |
| `scripts/serve.mjs` | Static server for the build output: explicit allowlist, CSP, no directory listing, no SPA fallback |
| `scripts/smoke.mjs` | Loopback check of that server against the build |
| `scripts/check.mjs` | Source gate: requires the honesty statement, forbids invented data, requires the real endpoints |
| `tests/` | Vitest suites (domain, core, map, app, views) |

## Running it

The app needs the **backend running**: the gateway API on `http://localhost:8080` and Keycloak
on `http://localhost:8081`. See [`backend/README.md`](../backend/README.md#quick-start).

```sh
npm install
npm run dev        # Vite dev server on http://localhost:4173
```

Then open **`http://localhost:4173`**.

> **Open it as `localhost`, never as `127.0.0.1`.** Both the Keycloak redirect URI and the
> gateway's allowed origin are registered for the `localhost` spelling. To a browser those are
> two different origins, so `http://127.0.0.1:4173` will fail login and cross-origin requests
> even though the server answers. Both the dev server and the preview server pin that exact
> origin and fail rather than move to another port.

The dev server is **not** the CSP witness: it injects its own scripts and sends no policy. Use
the built path below when the policy matters.

```sh
npm run build:local  # type-check, then build into dist/ with the localhost origins
npm run serve        # serve dist/ on http://localhost:4173 with the real headers
```

## Where it points

`src/config.ts` holds the only origin constants. None of them is a secret — a bundled client
has none — and all three are registered in services this repository does not own:

| Constant | Value | Purpose |
| --- | --- | --- |
| `gatewayOrigin` | `http://localhost:8080` | Prefixes every gateway call. Every API URL is absolute |
| `issuer` | `http://localhost:8081/realms/firewatch` | Identity provider. `/token`, `/auth` and `/logout` resolve against this, never the gateway |
| `redirectURI` | `http://localhost:4173/` | Must match the realm client's valid redirect URI |

`WEB_ORIGIN` on the gateway must be exactly `http://localhost:4173`, or the browser's
cross-origin calls are refused. `backend/docker-compose.yml` already sets it.

Without a session the page shows only the sign-in screen (`src/views/AuthView.tsx`): every
workspace route needs a bearer, so there is nothing true to show before one exists. It offers two
Keycloak round trips — **Iniciar sesión** (`/protocol/openid-connect/auth`) and **Crear cuenta**
(`/protocol/openid-connect/registrations`) — and `#registro` opens the second tab directly. Both
pages are Keycloak's own, styled by the `firewatch` login theme; registration must be enabled in
the realm, see [`backend/docs/keycloak-realm-setup.md`](../backend/docs/keycloak-realm-setup.md#self-registration-and-the-firewatch-login-theme).
The screen is a presentation gate, not an authorization boundary: it asks whether a token exists,
never which role it declares.

Login uses the public `firewatch-demo` client with Authorization Code and PKCE `S256`. Access
and ID tokens live in page memory only and are never written to cookies or to `localStorage`.
Exactly one non-token value touches browser storage: the PKCE transaction — `state` and
`code_verifier` — under `firewatch.pkce.transaction`, removed both when the callback consumes
it and on logout.

## Content Security Policy

`scripts/serve.mjs` sends this policy on every asset:

```text
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
connect-src http://localhost:8080 http://localhost:8081; object-src 'none'; base-uri 'none';
form-action 'none'; frame-ancestors 'none'
```

Read it as written, not as stricter than it is:

- `script-src` allows only the app's own scripts, with **no** `'unsafe-inline'`.
- `style-src` **does** allow `'unsafe-inline'`.
- `img-src` allows the app's own images **and** `data:` URIs.
- `connect-src` allows exactly two origins. No wildcard, and nothing else is reachable.
- `default-src 'self'` covers every directive not named above.

The server answers only `GET` and `HEAD`, from an allowlist derived from the built entry
document — so a hashed filename is not a hole and a stray file in `assets/` is not reachable —
with no directory listing, no SPA fallback (routing is hash-based) and `Referrer-Policy:
no-referrer`. A real deployment must send an equivalent policy.

## Preventive evidence, review and reassessment

The actions view (`src/views/ActionsView.tsx`) carries the S2 half of the
prevention contract. It is a transcription of the server rules, never a second
authority:

- An **admin-only** form records an evidence snapshot: a sufficiency criterion
  and one http(s) reference per line. References are validated in the page for
  immediate feedback and revalidated by the server; nothing is uploaded and no
  URL is fetched.
- The detail renders the append-only evidence snapshots and the human decisions.
  The reviewer and the date come from the server (`reviewer_sub`, `reviewed_at`);
  the page never sends an identity.
- The **acceptance** transition is disabled while the server reports
  `evidence_sufficient: false`, with the reason stated next to it. The server
  remains the authority: a refusal is still rendered with its HTTP status, code
  and `request_id`, including `409 insufficient_evidence`.
- A **synthetic reassessment** reuses the existing authenticated job submission
  and polling (`createJob` + the bounded `job` read). Only after a real published
  batch does the page link the `job_id`; the batch, version and risk level are
  server-derived. The panel states in Spanish that the classification is
  synthetic and **not** causal proof of risk reduction. If the submission or the
  link fails, the page keeps the job id and renders a retryable state instead of
  claiming an association the server did not confirm.

Viewers get the same read-only panels with every write control disabled. The
transport validators fail closed on a malformed snapshot, review or reassessment,
and refuse a reassessment that claims `causal_proof: true`.

The backend rules are documented in
[`backend/docs/preventive-evidence.md`](../backend/docs/preventive-evidence.md).

## Assignment from the user directory (V1-U-04)

The actions view offers a **responsible** for a new action from the realm's own
user directory, not from a typed name:

- The selector is filled by `GET /v1/users`, which is **admin-only** and
  read-only. It is read only while the authorized create UI is offered; a viewer
  never asks for it and creates nothing. Each option is the `display_name` the
  service resolved (first and last name, else the username, else the identifier)
  and its value is the directory `id`.
- A create sends `assignee_id` — never the legacy free-text `assignee`, which is
  kept only for compatibility with rows created before the reference existed. The
  server resolves the identifier before storing anything: an identifier the
  directory does not know is refused `422 assignee_not_found` and no action is
  created, so the page renders the refusal with its status, code and
  `request_id` and does not clear the form or claim a creation.
- **Unassigned is always offered.** Omitting `assignee_id` creates a valid
  unassigned action, and a row with no responsible is shown as `Sin asignar`
  rather than left blank.
- An **unreadable directory** (`503 directory_unavailable`, `502
directory_upstream_failed`, a malformed body or a network failure) is stated
  with its server message and offers a retry; the selector keeps the unassigned
  option and no person is invented to fill it. `200 []` is different and is
  rendered as a realm that really has no users.
- The list and the detail show a row's responsible as the directory name when
  the directory has been read under this session, otherwise the legacy free text
  the server stored, otherwise the identifier itself — never a composed name.
- **The directory belongs to one session INSTANCE.** The page keys it on
  `getSessionGeneration()` (`src/core/session.ts`), a monotonic count that moves
  whenever the in-memory bearer is adopted or dropped — never the token itself,
  and never a new field on `SessionState`, which keeps its shape so every other
  consumer is unaffected. A replacement that declares the same roles is
  indistinguishable in the public snapshot, and it is exactly the case the
  generation covers: the previous instance's list, the chosen reference and any
  in-flight answer are discarded, and the directory is read again under the new
  bearer. An answer produced under another instance is dropped, not rendered as a
  failure — the ownership check runs before any view effect, so a 401 from that
  read is not published as the notice of a session that did not issue it.
- **A failed create is reported as what it actually is, and the write boundary
  belongs to one session instance.** `isConfirmedWriteRefusal` (`src/core/api.ts`)
  is true only for the pairs the OpenAPI document and the handler actually define:
  401/403, 429, 415 `json_required`, 422 `invalid_action_request` /
  `assignee_not_found`, 502 `directory_upstream_failed`, 503
  `directory_unavailable` and 503 `storage_unavailable`. A documented code on an
  undocumented status (a `500 assignee_not_found`, say) proves nothing, and
  neither does any of: no response, a deadline, an aborted or superseded request,
  an unusable 2xx body, a gateway 502 `upstream_unavailable`, or a status without
  one of those codes. Those leave the write **undetermined**, and the page says it
  could not confirm whether the action was stored, keeps the form, and points at
  **Actualizar lista** before any resubmission because a second POST could
  duplicate the action.
- A create is fenced by the session instance at both ends. A submit whose instance
  already moved sends nothing at all (it would carry a reference that instance
  never read), and a completion whose instance is gone renders nothing — no
  notice, no form reset, no selection, no list refresh. The instance reset clears
  the notice and releases **only the create it owns**, because that completion is
  fenced. The shared write interlock (`busy`) is untouched by a replacement: a
  transition, evidence write, review or reassessment keeps every mutation control
  disabled until that write completes, so a session change cannot let two writes
  to the same action overlap. A pending create and a pending sibling write still
  block each other, exactly as before.
- A read's `assignee_id` is validated as a **nullable UUID**: the contract types
  it `format: uuid` / nullable and the service always serializes it, so a present
  value that is neither `null` nor a dashed UUID rejects the whole read as
  `invalid_shape` instead of rendering an unverified reference. An absent field is
  still accepted, so payloads and fixtures that predate the reference keep
  working.

The pure label rule lives in `src/domain/assignment.ts`; the transport guard,
route and write-outcome classification in `src/core/api.ts` (`users`,
`isConfirmedWriteRefusal`); the session instance in `src/core/session.ts`
(`getSessionGeneration`); the view cases in `tests/views/actions.test.tsx` and the
transport/session cases in `tests/core/prevention-api.test.ts` and
`tests/core/session.test.ts`.

## Preventive recommendations on the zone card (PM-18)

The zone card suggests from the written catalogue in
[`odd/plan-produccion/catalogo-recomendaciones-preventivas.md`](../odd/plan-produccion/catalogo-recomendaciones-preventivas.md).
The composition is a pure rule in `src/domain/recommendations.ts`, not view logic:

- The canonical level picks a base pair (R-01/R-02 for `bajo`, R-01/R-03 for `medio`,
  R-03/R-04 for `alto`). Up to two of the five canonical variables with `known: true`
  and `contribution > 0` add one item each, ordered by contribution and tie-broken by
  the canonical variable order the contract already fixes.
- An identifier appears once and the gap a duplicate leaves is **not** filled, so a list
  of three is shown as three. Four is the presentation budget, not a risk threshold.
- `desconocido`, `null` and any value outside the four identifiers take the same closed
  branch: only R-01 and R-02, the level labelled `INFORMACIÓN INSUFICIENTE` or
  `SIN CLASIFICAR`, and no factor item even when a contribution is positive. Variables
  without a reading are named (`Sin lectura: …`); a batch with none says so. `data_status`
  never changes the catalogue — the card states freshness on its own side.
- R-05 is rendered as a consultable item outside the composition, never as a finding:
  the system does not know whether vegetation touches power lines where the card points.

The panel states its own state when there is nothing to compose from (no zone selected, a
read in flight, no published batch, a failed or rejected read, a closed session). Showing
suggestions issues no request, writes nothing and creates no action — creating one remains
item 11 — and the copy says that the measures paraphrase public SENAPRED and MINVU guidance,
that mapping each measure to our levels and variables is FireWatch's own decision, and that
no item is an official alert, an official risk classification or an order. The composition
and its fallbacks are pinned by `tests/domain/recommendations.test.ts`; the rendered list,
its states and the no-mutating-request assertion by the PM-18 cases in
`tests/views/overview.test.tsx`.

The PM-09 observation screen is exercised with mocked HTTP in jsdom; the real cross-origin
observation write was not run in a browser for this change.

## Field observations (PM-09)

The observations view (`src/views/ObservationsView.tsx`, `#observations`) is the client
half of the PM-09 seam: `GET|POST /v1/prevention/observations` and
`GET /v1/prevention/observations/zones`.

- The **zone** picker is the real catalogue read from `/zones`, including zones without
  map geometry; the page never contributes a sector of its own. An unavailable catalogue
  empties the picker, disables the form and offers a retry instead of a fallback list.
- The **type** is the closed catalogue of S2 — `vegetacion_seca`, `microbasural`, `quema`,
  `acceso_bloqueado`, `otro` — shown with the Spanish labels of S3. There is no free-text
  type control.
- The **date** is chosen by the operator: the page declares no fixed calendar bounds, and
  the description is bounded at the contract's 240 characters with a live count.
- The **author** is server-authored. The creation body carries only `zone_id`, `type`,
  `observed_on` and `description`; `created_by` is the verified token `sub`, and every row
  names the attribution the server stored.
- The **list** is read from the service newest first and re-read after a saved record. The
  type filter is a server query (`?type=`), and the empty state distinguishes "the service
  has no observations" from "this filter matched none", keeping the filter with an explicit
  way out.
- A **refusal** keeps every entered value and names the HTTP status, the server `code`
  (`invalid_observation_request`, `invalid_query`, `zone_not_found`, `forbidden`,
  `storage_unavailable`) and the `request_id`. The submit control is disabled while a save
  is in flight, and a token without `admin` reads the list while the form stays disabled.
  The server remains the only authority.

The transport validators fail closed on a malformed list, catalogue or creation record,
including a creation that does not echo the selected zone. The cases are pinned by
`tests/core/observations-api.test.ts` and `tests/views/observations.test.tsx`.

## History CSV export (PM-13)

The history view (`src/views/HistoryView.tsx`) carries the S1–S2 export: the
**Descargar CSV** control downloads the history of the **selected zone** from
`GET /v1/risk/history.csv?zone_id=<selected>` (`src/core/history-csv.ts`).

- The request carries the selection and the session bearer, and nothing else —
  no `limit`, no `offset`, no search term and no data-status filter. The export
  is the zone's bounded 100-row window in the server's order; the in-memory
  search and status filter narrow the table only.
- The served bytes are saved unchanged. The page does not parse and rebuild the
  document, so a CRLF inside a quoted cell and the server's spreadsheet guard
  reach the file exactly as the route wrote them. It downloads only a `200`
  `text/csv` document: a failure is the route's shared JSON error body, never a
  file, and a `200` that is not CSV (a proxy login page, an empty body) is
  refused instead of being saved under a `.csv` name. A `206 Partial Content` —
  or any other 2xx — is a failure too, because a partial document is not the
  export the contract describes.
- An empty history is a valid export: the file is the header row alone, the
  control stays available, and the status sentence says it carries no rows. The
  table keeps its own, separate statement that the API returned no history.
- The file is named locally and deterministically from the selected zone
  (`risk-history-<zone>.csv`, reduced to a filename-safe alphabet). The page does
  not read the server's `Content-Disposition`: it is not a CORS-exposed header
  and no CORS exposure is needed or requested. The zone, the publication instant
  and the synthetic flag are declared inside the file, per row.
- The lifecycle is the JSON transport's: 401 lowers the session and returns the
  panel to its connect state, a 403 is named as a denied permission, and a lost
  or refused read never saves anything. Switching the zone, signing out or
  unmounting aborts the in-flight export and discards a late answer, so no file
  can be saved for a selection that is no longer current. The export state
  belongs to the selection/session instance it was started in — leaving a zone
  and returning starts from idle instead of restoring an abandoned request's
  busy state — and the save re-checks the selected zone and the signed-in
  session against the stores, not against the render that started it.
- Accessibility: the control is a labelled button described by the note that
  states the scope; its loading, failure and header-only sentences are announced
  through a `role="status"` `aria-live="polite"` region. While a read is in
  flight the button keeps focus through `aria-busy`/`aria-disabled` instead of
  being disabled mid-interaction, and without a session or a selected zone it is
  disabled with the reason stated rather than hidden.

The format claim itself, the header-only answer and the parity between the CSV
and the JSON handler are backend contract, pinned by
`backend/services/risk/internal/handler/history_csv_test.go` and
`backend/contracts/openapi/firewatch-v1.yaml`. This client's half is pinned by
`tests/core/history-csv.test.ts` (transport, bytes, failures, abort/supersede,
filename) and the PM-13 cases in `tests/views/history.test.tsx` (accessible
control, downloaded bytes and name, filters not applied, header-only answer,
errors and stale-context discards). No test here opens a browser: the download
is observed at the Blob and the anchor's `download` name, which is the seam the
browser uses, not a real save dialog.

## Sources and services: the operational verdict (PM-16)

`src/views/SourcesView.tsx` is the **only** screen for this: it shows the geographic
provenance, the authenticated service snapshots, the live gateway probe, the cycle
freshness and one explicit operational verdict. It opens no second health screen and
issues no metrics or telemetry scrape; the transport calls are exactly
`/v1/risk/sources`, `/v1/risk/status`, `/v1/jobs/status`, `/v1/models` and
`/health/ready`, in the same bounded 30 s cycle.

The "model" row states the **effective rule**, not a model the product does not have.
Its version and parameter hash come only from the additive `effective` object of
`GET /v1/models` (frozen backend contract, L6), and the client validates the claim
before showing it:

- `effective` is `{status:"rule", version, params_hash}` only when the service
  resolved a rule through the publisher's own classifier source. The row accepts it
  only with a non-empty version and exactly one canonical lowercase SHA-256
  (`^[0-9a-f]{64}$`, length checked because JavaScript's `$` also matches before a
  trailing newline).
- `{status:"non_rule"}` means the resolved classifier is not a rule. The screen says
  so (`No es una regla`, `No aplica`) and never prints an identity for it, even if a
  hostile payload carries one.
- `{status:"unavailable"}`, an absent `effective`, an unknown status or an invalid
  version/hash are the same truthful unknown (`No verificable` / `No acreditado`) and
  never borrow a version or a hash. A 401/403/503 keeps its normal error meaning.
- **No registry row is an identity source.** `models` remains in the envelope for the
  overview panel, but an `active` row, a seeded row or even a row carrying an
  activation record cannot verify the rule on this screen. `GET /v1/models` itself
  reports resolution **at read time**; it is not proof of a published classification
  or of inference availability, and the copy says so.

`src/core/active-rule.ts` owns that validation; the additive transport read is
`modelRegistry` in `src/core/api.ts`, while `modelVersions` keeps serving
`src/domain/model.ts` and the overview panel unchanged. The verdict composition is
`src/domain/operational-status.ts`, and the gateway probe rule is
`evaluateGatewayProbe` in `src/domain/readiness.ts`.

The verdict keeps apart what is often conflated:

| Evidence | What it proves |
| --- | --- |
| Live gateway probe (`/health/ready`) | The gateway process answered. A 204 does **not** accredit the risk or jobs pipeline |
| Authenticated snapshots (`/v1/risk/status`, `/v1/jobs/status`) | Each service earns `ready`, a fresh `checked_at`, a known dead-letter depth inside its bound and three consistent dependencies, or it is unknown |
| Provenance (`/v1/risk/sources`) | The published provider, attribution, restriction and declared hash match; a failed or mismatched read blocks the verdict |
| Weather source | **Not integrated**: no consumed contract publishes a weather provider or reading, so the row says so and shows no invented weather |
| Effective classifier (`/v1/models`) | A validated `rule` only; `non_rule` and `unavailable`/invalid are named as such, never as a rule |

A demo/synthetic input, an unverified or non-rule classifier, a failed gateway probe
or the missing weather integration keep the verdict out of the verified branch even
when both services report healthy, so the screen never claims production readiness
from a green health check.

Session and announcement boundaries are part of the honesty of the panel:

- Evidence is stored with the `SessionState` instance that produced it. A logout and
  a later login on the same mounted view cannot render the previous session's
  readings, even before the first new response lands. A superseded or aborted read
  (including a late completion from the abandoned session) abandons the whole cycle
  instead of painting a partial snapshot, and the next cycle re-reads under the
  current session. Shared auth code is untouched.
- The verdict has one dedicated visually-hidden `role="status"` region that names
  only the verdict title. Its text is derived from the verdict state, so a same-verdict
  30 s refresh produces no DOM mutation (no repeated announcement), while a
  transition updates it once. The visible verdict paragraph is not a live region
  and the service/provenance paragraphs keep their own regions for their own facts.

The automated suites in `tests/core/active-rule.test.ts`,
`tests/domain/operational-status.test.ts`, `tests/domain/readiness.test.ts` and
`tests/views/sources.test.tsx` pin all of the above, including hostile payloads,
missing/malformed `effective`, logout→login on the same view, late completions and
the announcement mutation count. They use a stubbed `fetch` and jsdom: **no browser
was executed for this unit**, so visual and assistive-technology behaviour remains
unverified here.

## Quality gates

```sh
npm run verify     # lint → typecheck → tests → source gate → build → smoke
```

| Command | What it establishes |
| --- | --- |
| `npm run lint` | ESLint, flat config, TypeScript and React hooks rules |
| `npm run typecheck` | `tsc --noEmit`, strict |
| `npm test` | Vitest: domain rules, transport, session, map projection, routing and the views |
| `npm run check` | The honesty statement is present, no fixture or frozen clock ships, the real endpoints are there, no client-side role guard, no persisted token, no secret, no external asset, and the sidebar keeps the scroll that makes its controls reachable |
| `npm run build:local` | The demo bundle: the same build, resolving the localhost origins |
| `npm run build` | The production bundle; it requires the three `VITE_*` origins and fails with `FAIL: missing required build variable(s)` without them. [`env.example`](env.example) and [`env.production.example`](env.production.example) document them |
| `npm run smoke` | Loopback: the built assets, MIME types, CSP, `HEAD`/`405`/`404`, traversal confinement |

## What is not verified

Automated checks do **not** establish visual correctness or full accessibility. The cross-origin round trip — signing in from `http://localhost:4173` through Keycloak and logging out back to it — **has** been executed end to end in a browser ([L14/L23](../odd/tasks/presentation-client-ready.md#log): PKCE for admin and viewer, RP logout, 401/403 with `request_id`), so the remaining limits are narrower and explicit: there is **no WCAG certification**, the automated 390 px focus assertion closes on **BODY** when the actions list is empty (the real controls still show a 3 px outline), and no screen reader or other assistive technology was exercised. See [`backend/docs/keycloak-realm-setup.md`](../backend/docs/keycloak-realm-setup.md) for the realm settings the round trip depends on.

One layout property sits in that category deliberately, and it is the reason the sidebar carries
its own scrollbar: whether the lower controls of the sidebar — the session card with **Cerrar
sesión**, and the Gateway card with **Actualizar estado** — are reachable at a given window
height. Two different things are true about it, and they are worth keeping apart. **Removing the
declaration that makes the column scroll is caught**: `npm run check` reads the shipped stylesheet
and fails if `.sidebar` stops declaring its own vertical scroll, if it loses its bounded height,
or if the 720 px breakpoint stops dropping that height. **The geometry itself is caught by
nothing**: jsdom has no layout engine, so no suite here can tell whether the controls actually
fit. That part is measured in a browser. The sign-in control's `disabled` state is the contrast:
it is ordinary rendered behaviour, and it is asserted in `tests/views/session.test.tsx`.

The workspace **Saltar al contenido** link is pinned in exactly two halves. The content region is a
focus target and never a Tab stop — `tests/a11y/shell-sidebar-accessibility.test.tsx` walks the whole
shell with Tab and then activates the link from the keyboard; and the activation must leave the open
view alone — `tests/app/router.test.tsx` asserts that the fragment still names the view that was open,
for a non-default view and for the default one, since a fallback to Overview is invisible from Overview.
Both halves exist because the link used to be a plain fragment link: `#content` is not a declared
route, so the browser wrote it into the address bar and the router replaced it with the default view.
What no suite here can establish is the rendered half — that Chromium scrolls the region into view and
paints the shared focus ring on it — because jsdom has neither layout nor fragment scrolling.

The horizontally scrollable tables are the same kind of split, and they are the reason `.table-wrap` is now
rendered by a primitive instead of a bare `div`. `.table-wrap` is the element that scrolls (it carries
`overflow: auto`), so a keyboard user has to be able to reach it. `components/ui.tsx`'s `TableWrap` renders it
as a Tab stop (`tabindex="0"`) exposed as a region with its own accessible name, and it passes `id` and
`hidden` through so no consumer loses a state. `tests/a11y/table-scroll-regions.test.tsx` pins that contract
for the nine wrappers in Actions, Audit, History, Pending and Session, including the actions detail and the
register that stays hidden until the service returns events, and it fails if a wrapper loses its name or two
wrappers share one. The class is unchanged, so the shipped focus ring and the `has-rows` hiding rule still
apply. Chromium made those scrollers focusable through its own scroll-container heuristic, which no other
engine owes the page; axe-core 4.10.3 reported `scrollable-region-focusable` until the DOM stated it. What no
suite here can establish is the rendered half — that the browser paints the ring and moves the region with
arrow keys — which is a browser measurement, not a jsdom one.

## History

This directory used to hold one self-contained page (`index.html`, `proposal.css`,
`proposal.js`) with no framework, no bundler and no build step, tested by a `node:vm` harness with
a toy DOM. That page and that harness are gone from the working tree: every one of the harness's
**60 assertions** was ported to the Vitest suites first, and the port is recorded assertion by
assertion in
[`odd/urgent/rediseno-pagina/ledger-aserciones.md`](../odd/urgent/rediseno-pagina/ledger-aserciones.md)
(60 rows, every cited test name checked to exist). The old page remains readable in the history of
the `frontend/react-vite` branch at `f4d99b7`. The retired mockup that preceded *that* page is kept
at `odd/urgent/rediseno-pagina/referencia-mockup/`, and the history of its retirement is in
[`odd/tasks/architecture/gateway-frontend-separation.md`](../odd/tasks/architecture/gateway-frontend-separation.md).
