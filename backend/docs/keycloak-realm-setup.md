# Keycloak realm setup for the separated frontend

The FireWatch page is served as its own application from `http://localhost:4173`, while the gateway stays an API on `http://localhost:8080`. Those are different origins, so the `firewatch-demo` client must accept the new origin for login, for the token exchange, and for RP-initiated logout.

## What the shipped realm declares

`backend/deploy/local/firewatch-realm.json` declares, for the public client `firewatch-demo`:

| Setting | Value |
| --- | --- |
| `redirectUris` | `http://localhost:8080/`, `http://localhost:4173/` |
| `webOrigins` | `http://localhost:8080`, `http://localhost:4173` |
| `attributes["post.logout.redirect.uris"]` | `http://localhost:8080/##http://localhost:4173/` |
| `attributes["pkce.code.challenge.method"]` | `S256` |
| `standardFlowEnabled` / `directAccessGrantsEnabled` | `true` / `true` |

Notes on the format, because both are easy to get wrong:

- `redirectUris` and `webOrigins` are JSON arrays of separate entries. Redirect URIs keep the trailing slash; web origins do not, because an origin has no path.
- `post.logout.redirect.uris` is **not** an array. Keycloak stores it inside `attributes` as one string, and multiple values are joined with `##`. Do not use a comma or a space.
- The `:8080` entries were deliberately retained rather than replaced. **Nothing in this repository requires them any more.** The page uses `:4173`, and the password-grant helper in `backend/scripts/smoke.py` performs a server-side token request that supplies no redirect URI at all, so it does not depend on them either. They are kept because narrowing an existing public client's configuration buys nothing here and would break any already-configured consumer that still points at `:8080`.

## Why editing the JSON is not enough on an existing realm

`backend/docker-compose.yml` starts Keycloak with `command: [start-dev, --import-realm]`. Keycloak import is **create-only**: if the realm `firewatch` already exists in the identity database, the file is read and ignored, and the running client keeps its previous URIs.

Consequences:

- On a **fresh** identity database, the JSON is authoritative and nothing else is needed.
- On an **already-initialized** realm, re-import does not apply the change. Use the manual steps below.

**Do not run `docker compose down -v` to force a re-import.** That deletes the identity volume and with it every local user, session and credential. The realm is persistent local state and must be updated in place instead.

## One-time manual steps on an existing realm

Keycloak listens on `http://localhost:8081` (`KC_HOSTNAME`, `backend/docker-compose.yml:81`).

1. Open `http://localhost:8081` and sign in to the Administration Console as `local-admin`. The password is the `KEYCLOAK_ADMIN_PASSWORD` you set in your local `.env`; the username comes from `KC_BOOTSTRAP_ADMIN_USERNAME`.
2. Select the realm **firewatch**.
3. Go to **Clients** and open **firewatch-demo**.
4. On **Valid redirect URIs**, add `http://localhost:4173/`. Keep `http://localhost:8080/`.
5. On **Web origins**, add `http://localhost:4173`. Keep `http://localhost:8080`.
6. On **Valid post logout redirect URIs**, add `http://localhost:4173/`. Keep `http://localhost:8080/`.
7. **Save**.

Steps 4-6 are additive. Do not replace existing entries, and do not change the client from public to confidential: the page uses Authorization Code with PKCE `S256` and holds no client secret.

## Verification

Open **Clients → firewatch-demo → Settings** and confirm all three fields show both the `:8080` and the `:4173` value. The observable end-to-end check is signing in from the page served at `http://localhost:4173` and then logging out; logout must return to `http://localhost:4173/`.

A programmatic check was **not executed** as part of this change: it needs a running Keycloak with the local `.env` credentials, which is outside what this repository can verify on its own. Treat the sign-in and logout round trip through the browser as the real acceptance check.

## Self-registration and the FireWatch login theme

The page offers two Keycloak round trips: **Iniciar sesión** opens `/protocol/openid-connect/auth` and **Crear cuenta** opens `/protocol/openid-connect/registrations`, Keycloak's sign-up entry point. Both are the same Authorization Code + PKCE `S256` flow with the same client, and both return to the same callback; the page never renders a credential field. What makes sign-up possible is the realm, not the page:

| Setting | Value | Why |
| --- | --- | --- |
| `registrationAllowed` | `true` | Without it `/registrations` answers with Keycloak's own error page |
| `defaultRole` → `default-roles-firewatch` | composite of `viewer`, `offline_access`, `uma_authorization` | A self-registered account can **read** risk data and nothing more. `admin` is never granted by registration; an administrator assigns it by hand |
| `passwordPolicy` | `length(10) and notUsername and notEmail` | Open sign-up needs a floor. The generated demo passwords (48 hex characters locally, 24 on the pitch) already satisfy it |
| `verifyEmail` / `resetPasswordAllowed` | `false` / `false` | Both need SMTP, which no environment here configures. Turn them on together with `smtpServer` |
| `rememberMe` | `false` | The page keeps tokens in memory only; a long-lived Keycloak SSO cookie would contradict that |
| `loginTheme` | `firewatch` | The sign-in and sign-up pages in the aerial night palette of the application |
| `internationalizationEnabled`, `supportedLocales`, `defaultLocale` | `true`, `["es","en"]`, `es` | Keycloak's pages in Spanish; the page also sends `ui_locales=es` |
| `displayName` / `displayNameHtml` | `FireWatch` | Window title and header text of the Keycloak pages |

**Decide before exposing it publicly.** With these settings anyone who can reach the identity provider can create an account that reads the (synthetic) risk data. That is the intended demo behaviour. If it is not wanted on a given environment, set `registrationAllowed` to `false` there, or remove `viewer` from `default-roles-firewatch` so new accounts receive `403` until an administrator grants a role. The gateway and the services remain the only authority either way: the page never decides a permission.

### The theme

`backend/deploy/local/keycloak-themes/firewatch/login/` is a login theme that extends `keycloak.v2`, the default login theme of the pinned Keycloak 26.5.7. It is **CSS and copy only**: it overrides **no template**, so every flow Keycloak ships — login, registration, required actions, errors, OTP, update password — keeps working as upstream, and a selector a future version renames simply stops applying instead of breaking the page.

The skin is the **aerial night** design the application uses (`frontend/src/styles/tokens.css`, `frontend/src/styles/auth.css`, `AuthView`): the slate/ocean surfaces, the light ink and the aqua accent are restated as literal custom properties in `resources/css/firewatch.css`, because the identity provider cannot read the frontend's stylesheet. The retired forest/cream palette is gone from every rule. The composition mirrors the delivered entrance: one atmospheric brand column with the headline and the scope statement, and one compact card with the form. On a desktop the page is a `100dvh` box that fits the login form — including an inline invalid-credentials alert — without vertical scroll, and the document is never locked (`html` and `body` keep scrolling), so taller flows such as registration and required actions scroll naturally and a 320 px phone is never clipped.

The stylesheet restates the whole PatternFly 5 surface the parent paints, not just the card: the language picker, the input group with its password reveal button, the Chrome autofill overlay, the footer band, the social-provider button and the danger/success/warning/info alerts. It also measures WCAG AA rather than assuming it: body, label, helper and alert text are at least 4.5:1 against the surface they sit on, input borders, the card boundary and the `:focus-visible` ring are at least 3:1, inputs and the primary action keep 44 px touch targets, and `prefers-reduced-motion: reduce` disables the transitions. Nothing is imported and no remote resource is fetched, so the theme works offline under the deployment's own CSP.

The theme directory is exactly four files, and that is a deployment contract, not a preference: `theme.properties`, `messages/messages_es.properties`, `messages/messages_en.properties` and `resources/css/firewatch.css`. The pitch overlay turns those four into the `keycloak-theme-firewatch` ConfigMap and rebuilds the directory layout with ConfigMap `items` (ConfigMap keys cannot contain `/`), and `overlays/pitch/up.sh` creates the ConfigMap from the same four paths. A FreeMarker template, an image or a font added to the directory would never reach the cluster, so `backend/scripts/test_keycloak_theme.py` fails if the directory and the overlay drift apart.

`docker-compose.yml`, `docker-compose.prod.yml` and `scripts/verify_synthetic.py` mount it read-only at `/opt/keycloak/themes/firewatch`. The Kubernetes **base** does not mount it: a Keycloak started from the base logs that it cannot find the theme and serves its built-in one, so the realm setting is never a login dependency. The pitch overlay carries it as an **optional** ConfigMap, which is why a missing theme degrades to the upstream look instead of blocking sign-in. `start-dev` does not cache themes, so a CSS edit shows on reload; production mode (`start`) caches them until restart — `overlays/pitch/up.sh` restarts the identity deployment only when the ConfigMap content actually changed, because that restart ends every Keycloak session.

The palette and the layout are guarded by a static check that needs no running Keycloak:

```bash
python -B -m pytest backend/scripts/test_keycloak_theme.py
```

It asserts the four-file structure against the overlay, the presence of the aerial night roles and the absence of the retired literals, WCAG 2.1 contrast computed from the declared values, the absence of imports and remote URLs, and the compact `100dvh` layout that never locks scrolling. The browser-level check is the real sign-in and sign-out round trip described under **Verification** above.

### Applying it to an existing realm

The create-only import rule above applies: an initialised realm ignores these keys. In the Administration Console, realm **firewatch**:

1. **Realm settings → General**: Display name `FireWatch`, HTML display name `FireWatch`.
2. **Realm settings → Login**: User registration **On**; Forgot password **Off**; Remember me **Off**; Verify email **Off**; Login with email **On**; Duplicate emails **Off**.
3. **Realm settings → Themes**: Login theme `firewatch` (it is listed only when the container has the theme mount; recreate it with `docker compose up -d identity` after pulling this change).
4. **Realm settings → Localization**: Internationalization **On**, supported locales `es` and `en`, default locale `es`.
5. **Authentication → Policies → Password policy**: add *Minimum length* `10`, *Not username*, *Not email*. Save.
6. **Realm settings → User registration → Default roles**: **Assign role** → `viewer`.

Verification: open the page, choose **Crear cuenta**, complete the Keycloak form, and confirm the page comes back signed in with `viewer` listed under **Sesión y permisos**; then confirm that `#jobs` answers `403` for that account.

## Sign-in and sign-up with Google

"Continuar con Google" is Keycloak brokering Google: the page sends the ordinary sign-in round trip with `kc_idp_hint=google`, Keycloak hands the browser to Google, and on a first visit creates the account from the Google profile with the realm's default roles (`viewer`). The page still receives only a Keycloak code, never a Google token. Three pieces, all needed:

1. **An OAuth client in Google Cloud** (APIs & Services → Credentials → Create credentials → OAuth client ID → *Web application*), with the authorized redirect URI `<issuer>/broker/google/endpoint`, for the pitch `https://auth.<ip-with-dashes>.sslip.io/realms/firewatch/broker/google/endpoint`. The OAuth consent screen needs only the non-sensitive `openid`, `email` and `profile` scopes. While it is in **Testing**, only the Google accounts listed as test users can sign in (up to 100); publishing it lifts that, and Google may ask to verify the domains it names.
2. **The identity provider `google` in the realm.** On the pitch, `provision-realm.py` creates or updates it from the Secret `pitch-google-idp` (keys `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`); see the pitch README. Elsewhere, by hand: **Identity providers → Google**, alias `google`, the client ID and secret, *Trust email* on. The client secret is never written to the realm file or any tracked file.
3. **The page built with `VITE_GOOGLE_LOGIN=true`.** Without it the button is not shown, because a public client cannot discover the realm's providers and a hint for a missing provider would land on the plain Keycloak form.

An e-mail already registered through the form is not merged silently: Keycloak's *first broker login* flow asks the person to confirm the existing account's password before linking Google to it.

## The directory client: `firewatch-directory`

`backend/deploy/local/firewatch-realm.json` declares a second client, the confidential one the prevention service reads the realm's users with at `GET /v1/users`:

| Setting | Value |
| --- | --- |
| `clientId` | `firewatch-directory` |
| `publicClient` | `false` |
| `serviceAccountsEnabled` | `true` |
| `standardFlowEnabled` / `directAccessGrantsEnabled` | `false` / `false` |
| `secret` | `${DIRECTORY_CLIENT_SECRET}`, expanded from the `identity` container's environment |
| service account user | `service-account-firewatch-directory` |
| `realm-management` client roles | `query-users`, `view-users` |

**The same create-only import rule applies to it.** On a realm that already exists, the file is read and ignored, so the client, its service account and its role grant are never created; the role grant is what lets the service account read users at all. Import creates them only on a **fresh** identity database.

### Symptom of a missing client

`GET /v1/users` answers **502 `directory_upstream_failed`**: the route's documented upstream failure, because the token endpoint refuses a client the realm does not have. It is deliberately **not** `200 []`, which would claim the realm has no users. A missing or empty `DIRECTORY_CLIENT_SECRET` is a different answer, **503 `directory_unavailable`**: with no credential the service never calls the identity provider at all. Prevention logs `directory_read_failed` with the request id for the 502 and `directory_not_configured` for the 503; the identity provider's own log carries the reason it refused.

### Applying it to an existing realm

One of:

- **Fresh identity volume**, only when every local account is disposable. `docker compose down -v` deletes the identity database, and the next start imports the whole realm including this client. The warning above applies with the same force: never do this on a realm whose users, sessions or credentials you want to keep.
- **By hand in the console**, which is the only in-place route:

1. Open `http://localhost:8081`, sign in, and select the realm **firewatch**.
2. **Clients → Create client**. Client ID `firewatch-directory`, type **OpenID Connect**. Next.
3. Client authentication **On**; Standard flow **Off**, Direct access grants **Off**, Service accounts roles **On**. Save.
4. **Credentials** tab: copy the generated client secret into `DIRECTORY_CLIENT_SECRET` in your local `.env`. That file is git-ignored; never paste the value into a tracked file, an issue, a commit or a command whose arguments end up in shell history.
5. **Service accounts roles** tab → **Assign role** → **Filter by clients** → `realm-management` → `query-users` and `view-users` → **Assign**.
6. Recreate the container so it reads the new environment (`docker compose up -d prevention`), then call `GET /v1/users` with an `admin` bearer and confirm `200` with the realm's users.

### The admin URL's scheme

`KEYCLOAK_ADMIN_URL` is where the client secret travels, so it follows the same rule as the OIDC endpoints: `https` is always accepted, plain `http` only when `APP_ENV=development`, which is what the compose stack sets. Outside development a plaintext admin URL is refused before any request is made and the route answers the documented **503 `directory_unavailable`** instead of sending the secret in clear text. `http://identity:8080` in `backend/docker-compose.yml` is the development default and stays valid locally.

## Forward risk: HTTPS enforcement for client URIs

Keycloak 26.6.0 introduces the `secure-client-uris` client policy executor, which requires HTTPS and makes **existing clients using `http` in "Post logout redirect URIs" fail validation when they are updated**. This repository pins `quay.io/keycloak/keycloak:26.5.7` (`backend/docker-compose.yml:72`), so the behavior does not apply today.

Before bumping the Keycloak version above 26.6.0, expect local logout to break for the plain-`http` entries above, and plan for either keeping the executor disabled or moving local development to TLS.
