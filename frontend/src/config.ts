// Public configuration of the browser client. A bundled client has no secrets:
// every value here is visible to any visitor and none of them is a credential.
//
// The three origins are build-time variables rather than literals, because they
// are the three values that change between a development machine and a deployed
// host, and a bundle that points at the wrong origin fails in the browser as an
// opaque network error. Vite inlines every `VITE_`-prefixed variable it finds in
// `frontend/.env*`; `frontend/env.example` and `frontend/env.production.example`
// document the values they must satisfy.
//
// Development keeps the historical local values as fallbacks, so a fresh
// checkout runs with no `.env` file at all. A production build does not fall
// back: it throws at module load instead, because a bundle that quietly keeps
// talking to `localhost` looks healthy while login and every API call are gone.

// The declarations sit next to the only module that reads them: this project has
// no `vite-env.d.ts`, and these three variables are optional in the environment
// and required in the exported configuration below.
declare global {
  interface ImportMetaEnv {
    readonly VITE_GATEWAY_ORIGIN?: string;
    readonly VITE_ISSUER?: string;
    readonly VITE_REDIRECT_URI?: string;
    readonly VITE_GOOGLE_LOGIN?: string;
  }
}

function environmentOrigin(name: string, value: string | undefined, developmentValue: string): string {
  const configured = value?.trim();
  if (configured) return configured;
  // Gated on `MODE`, not on `PROD`: Vite sets `PROD` for every build including
  // `npm run build:local`, so the demo bundle would throw as well.
  if (import.meta.env.MODE === 'production') {
    throw new Error(
      `Missing required build variable ${name}: a production build must set it instead of falling back to ${developmentValue}. See the production runbook.`,
    );
  }
  return developmentValue;
}

// Prefixes every gateway call. Locally the page is served from its own origin
// (:4173) while the gateway stays on :8080, so every API URL is absolute.
export const gatewayOrigin = environmentOrigin('VITE_GATEWAY_ORIGIN', import.meta.env.VITE_GATEWAY_ORIGIN, 'http://localhost:8080');
// The identity provider is NOT the gateway: `/token`, `/auth` and `/logout`
// resolve against this issuer and must never receive `gatewayOrigin`.
export const issuer = environmentOrigin('VITE_ISSUER', import.meta.env.VITE_ISSUER, 'http://localhost:8081/realms/firewatch');
// Must match the realm client's registered valid redirect URI, and the gateway's
// `WEB_ORIGIN` must be exactly this string. The spelling is load-bearing:
// `127.0.0.1:4173` is a different origin to a browser than `localhost:4173` and
// fails both the login round trip and the cross-origin API calls.
export const redirectURI = environmentOrigin('VITE_REDIRECT_URI', import.meta.env.VITE_REDIRECT_URI, 'http://localhost:4173/');
export const clientID = 'firewatch-demo';

// Whether the sign-in screen offers "Continuar con Google". It is a build flag,
// not a discovery: the realm's identity providers are not published to a public
// client, and a button for a provider the realm does not have would land on the
// plain Keycloak form instead of Google. Set `VITE_GOOGLE_LOGIN=true` only for a
// realm whose `google` identity provider is configured
// (backend/docs/keycloak-realm-setup.md). Off by default and in development.
export const googleLoginEnabled = import.meta.env.VITE_GOOGLE_LOGIN?.trim() === 'true';

// The alias of that identity provider in the realm. Keycloak's `kc_idp_hint`
// names it so the round trip skips the Keycloak form and goes straight to Google.
export const googleIdentityProvider = 'google';

// The PKCE transaction (`state` + `code_verifier`) is the only value the app
// writes to browser storage. It lives just long enough to survive the redirect
// and is removed both when the callback consumes it and on logout. No token is
// ever persisted.
export const pkceTransactionKey = 'firewatch.pkce.transaction';

export const routes = {
  ready: '/health/ready',
  zones: '/v1/risk/zones',
  latest: '/v1/risk/latest',
  history: '/v1/risk/history',
  // The export is the same bounded read as `history`, rendered as a CSV
  // document. It is a separate route because it is a separate representation:
  // the page downloads it as-is and never re-encodes it.
  historyCsv: '/v1/risk/history.csv',
  // The aggregate read that colours the whole territory on load: the newest
  // published batch of every zone that has one, answered in a single request.
  batches: '/v1/risk/batches',
  // PM-11 — the embedded fictional infrastructure catalogue. Read-only and
  // authenticated by the existing risk prefix; there is no mutation route.
  infrastructure: '/v1/risk/infrastructure',
  sources: '/v1/risk/sources',
  // PM-08's frozen read: persisted PM-07 risk alerts, newest first by default,
  // keyset-paginated through the opaque `cursor` the previous page returned.
  // The server owns the default page size (50); the client sends no `limit`.
  alerts: '/v1/risk/alerts',
  riskStatus: '/v1/risk/status',
  jobsStatus: '/v1/jobs/status',
  scenarios: '/v1/risk/synthetic-scenarios',
  audit: '/v1/audit',
  // The frozen `prevention` contract (T12) and the model registry (T13). Both
  // are reached through the gateway, the only origin the page's `connect-src`
  // allows besides the identity provider.
  preventiveActions: '/v1/prevention/actions',
  // PM-09 field observations. Both routes are served by the prevention service
  // through the gateway; the zones read is the REAL catalogue, including zones
  // without map geometry, so the form never invents a sector.
  observations: '/v1/prevention/observations',
  observationZones: '/v1/prevention/observations/zones',
  models: '/v1/models',
  // The realm's user directory (V1-U-04). Admin-only and read-only: it is what
  // fills the assignee selector, and what an `assignee_id` is resolved against.
  // An unreadable directory is answered 503/502, never with an empty list, so the
  // page can tell "nobody could ask" from "the realm has no users".
  users: '/v1/users',
} as const;

export function jobRoute(id: string): string {
  return `/v1/jobs/${encodeURIComponent(id)}`;
}

export function preventiveActionRoute(id: string): string {
  return `/v1/prevention/actions/${encodeURIComponent(id)}`;
}

export function preventiveTransitionRoute(id: string): string {
  return `${preventiveActionRoute(id)}/transitions`;
}

// PM-10: the one link operation of S4. The observation is addressed by the path
// and the existing action by the body, so neither can be exchanged for the other.
export function observationAdoptionRoute(id: string): string {
  return `${routes.observations}/${encodeURIComponent(id)}/adoption`;
}

// Bounds and deadlines the retired page enforced. They are policy, not
// decoration: they are what keeps a stale or superseded answer from being shown
// as current, so they travel with the code that honours them.
export const timing = {
  // Job polling.
  pollIntervalMs: 2000,
  pollDeadlineMs: 65_000,
  maxPollAttempts: 30,
  // Gateway readiness refresh.
  pipelineRefreshMs: 30_000,
  pipelineDeadlineMs: 10_000,
  // A batch is treated as expired this long before its own `valid_until`, so the
  // page never claims validity it has just lost.
  validitySkewMs: 1000,
  // Upper bound for the single re-evaluation timer; a longer remaining lifetime
  // is re-checked on the next tick instead of scheduling one huge timer.
  validityMaxDelayMs: 3_600_000,
  // Age after which a snapshot without its own freshness bound is not trusted.
  fallbackStatusMaxAgeSeconds: 30,
} as const;
