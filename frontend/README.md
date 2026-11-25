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
| `src/components/Shell.tsx` | Sidebar, topbar, update bar and footer |
| `src/components/ui.tsx` | Presentation primitives: `Icon`, `Chip`, `Metric`, `PanelHeading`, `DataList`, `StatusCopy`, `EmptyState`, the "not implemented" markers |
| `src/components/map/` | Territorial map projection and level colouring |
| `src/core/api.ts` | Transport: one function per consumed route, absolute gateway URLs, sequence fences, deadlines |
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
