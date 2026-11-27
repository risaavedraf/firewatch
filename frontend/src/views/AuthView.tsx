import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { rejectedSessionCopy } from '../app/sessionCopy';
import { useSessionState } from '../app/store';
import { googleLoginEnabled } from '../config';
import {
  startGoogleLogin,
  startLogin,
  startRegistration,
  type AuthorizationIntent,
  type SessionState,
} from '../core/session';

// The sign-in and sign-up screen, shown instead of the workspace while there is
// no established session.
//
// Both modes are the same thing underneath: a button that opens a Keycloak page
// through Authorization Code + PKCE. The page renders no credential field of any
// kind — no username, no password, no e-mail — because the identity provider is
// the only place a credential is typed. What this screen owns is the explanation
// and the state of the round trip, nothing else.
//
// What a new account may do is NOT decided here either: the realm assigns its
// roles and the server verifies them on every request. The screen says so instead
// of promising a permission it cannot grant.
//
// "Continuar con Google" is the same Keycloak round trip with a hint that sends
// the browser straight to Google; Keycloak brokers it and creates the account on
// a first visit. It is shown only when the build enables it (`googleLoginEnabled`).

// Which button started the round trip: one of the two tabs, or Google.
type Launch = AuthorizationIntent | 'google';

const TABS: readonly { id: AuthorizationIntent; label: string }[] = [
  { id: 'login', label: 'Iniciar sesión' },
  { id: 'register', label: 'Crear cuenta' },
];

// `#registro` opens the sign-up tab directly, so a link to it can be shared. The
// hash is read once, on arrival; it is not a workspace route and the router never
// sees it while this screen is mounted.
export const REGISTER_HASH = '#registro';

function initialIntent(): AuthorizationIntent {
  return window.location.hash === REGISTER_HASH ? 'register' : 'login';
}

function tabIndexForKey(key: string, index: number): number | null {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (index + 1) % TABS.length;
    case 'ArrowLeft':
    case 'ArrowUp':
      return (index - 1 + TABS.length) % TABS.length;
    case 'Home':
      return 0;
    case 'End':
      return TABS.length - 1;
    default:
      return null;
  }
}

// `launched` is which button on this screen started the round trip, if any. It is
// only read while the session is `signing-in`; a stale value after a round trip
// ended is harmless because only those same buttons can start the next one.
function statusCopy(session: SessionState, launched: Launch | null): string {
  if (session.status === 'signing-in') {
    if (launched === 'google') return 'Abriendo el acceso con Google…';
    if (launched === 'register') return 'Abriendo el registro seguro de Keycloak…';
    if (launched === 'login') return 'Abriendo el acceso seguro de Keycloak…';
    // Not launched from this screen: the page has just come back from Keycloak
    // and is exchanging the code for a session.
    return 'Completando el acceso con Keycloak…';
  }
  if (session.reason === 'rejected') return rejectedSessionCopy();
  if (session.reason === 'login-failed') {
    return 'No se completó el acceso: Keycloak no devolvió una sesión válida o el intento se canceló. Puedes intentarlo de nuevo.';
  }
  return '';
}

// The entrance's own state, in the words the screen can honestly use. It is not
// a session: this screen only exists while there is no established one, so the
// label reports the round trip this component observed and nothing else.
function entranceState(session: SessionState): string {
  if (session.status === 'signing-in') return 'Regresando de Keycloak';
  if (session.reason === 'rejected') return 'Sesión rechazada';
  if (session.reason === 'login-failed') return 'Acceso no completado';
  return 'Sin sesión';
}

export function AuthView({ googleLogin = googleLoginEnabled }: { googleLogin?: boolean } = {}) {
  const session = useSessionState();
  const [intent, setIntent] = useState<AuthorizationIntent>(initialIntent);
  const [launched, setLaunched] = useState<Launch | null>(null);
  const tabRefs = useRef<Record<AuthorizationIntent, HTMLButtonElement | null>>({ login: null, register: null });

  const busy = session.status === 'signing-in';
  const status = statusCopy(session, launched);
  const failed = !busy && session.reason !== null;

  useEffect(() => {
    document.title = `${intent === 'register' ? 'Crear cuenta' : 'Iniciar sesión'} | FireWatch`;
  }, [intent]);

  const launch = (next: Launch) => {
    setLaunched(next);
    if (next === 'google') startGoogleLogin();
    else if (next === 'register') startRegistration();
    else startLogin();
  };

  // Rendered at the top of each tab: the quick path first, then the Keycloak form.
  const googleOption = (id: string, label: string, divider: string) =>
    googleLogin ? (
      <>
        <button id={id} className="auth-google" type="button" disabled={busy} onClick={() => launch('google')}>
          <GoogleGlyph />
          {label}
        </button>
        <p className="auth-divider">
          <span>{divider}</span>
        </p>
      </>
    ) : null;

  // WAI-ARIA tabs: arrows move between the two tabs, Home/End jump to the ends,
  // and the selection follows focus.
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = TABS.findIndex(tab => tab.id === intent);
    const next = tabIndexForKey(event.key, index);
    if (next === null) return;
    event.preventDefault();
    const target = TABS[next].id;
    setIntent(target);
    tabRefs.current[target]?.focus();
  };

  return (
    <div className="auth-page" data-view="auth">
      <section className="auth-hero" aria-labelledby="auth-hero-title">
        <div className="auth-brand">
          <span className="brand-mark" aria-hidden="true">
            F
          </span>
          <span>
            <strong>FireWatch</strong>
            <small>Prevención territorial</small>
          </span>
        </div>

        <div className="auth-hero-copy">
          <p className="auth-kicker">Región de Valparaíso · Ámbito regional</p>
          <h1 id="auth-hero-title">El riesgo territorial de incendio, comuna por comuna.</h1>
          {/* Board 14 states the entrance's state before the explanation. These
              chips report the round trip this screen actually observes; neither
              of them claims a session, a role or a permission. */}
          <div className="auth-chips" id="auth-state" role="group" aria-label="Estado de la entrada">
            <span className="auth-chip">{entranceState(session)}</span>
            <span className="auth-chip">Entrada sin credenciales</span>
          </div>
          <p>
            Consulta el estado de cada zona, el historial de lotes publicados, la procedencia de las fuentes y las
            acciones preventivas, con cada permiso validado por el servidor.
          </p>
          <ul className="auth-features">
            <li>
              <span aria-hidden="true">01</span>
              Mapa de la región con el último lote vigente de cada comuna.
            </li>
            <li>
              <span aria-hidden="true">02</span>
              Historial de lotes y procedencia de cada fuente.
            </li>
            <li>
              <span aria-hidden="true">03</span>
              Acciones preventivas con evidencia y revisión humana.
            </li>
          </ul>
        </div>

        <p className="auth-scope" id="auth-scope">
          Entorno de demostración: entrada sintética, sin calibración y no oficial. No reemplaza a CONAF ni a SENAPRED.
        </p>
      </section>

      <main className="auth-main" id="content">
        <div className="auth-main-stack">
        <div className="auth-card">
          <div className="auth-tabs" role="tablist" aria-label="Acceso a FireWatch">
            {TABS.map(tab => {
              const selected = tab.id === intent;
              return (
                <button
                  key={tab.id}
                  ref={node => {
                    tabRefs.current[tab.id] = node;
                  }}
                  id={`auth-tab-${tab.id}`}
                  className={selected ? 'auth-tab is-selected' : 'auth-tab'}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={`auth-panel-${tab.id}`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setIntent(tab.id)}
                  onKeyDown={onTabKeyDown}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          <div
            id="auth-panel-login"
            className="auth-panel-body"
            role="tabpanel"
            aria-labelledby="auth-tab-login"
            hidden={intent !== 'login'}
          >
            <h2>Bienvenido de vuelta</h2>
            <p className="auth-lead">
              Inicia sesión con tu cuenta del centro de monitoreo. El acceso se realiza en Keycloak, el proveedor de
              identidad de FireWatch.
            </p>
            {googleOption('google-login', 'Continuar con Google', 'o con tu usuario y contraseña')}
            <button id="login" className="auth-primary" type="button" disabled={busy} onClick={() => launch('login')}>
              <LockGlyph />
              Continuar con Keycloak
            </button>
            <p className="auth-switch">
              ¿Aún no tienes cuenta?{' '}
              <button type="button" className="auth-link" onClick={() => setIntent('register')}>
                Crear una cuenta
              </button>
            </p>
          </div>

          <div
            id="auth-panel-register"
            className="auth-panel-body"
            role="tabpanel"
            aria-labelledby="auth-tab-register"
            hidden={intent !== 'register'}
          >
            <h2>Crea tu cuenta</h2>
            <p className="auth-lead">
              El registro se completa en Keycloak. Al terminar vuelves aquí con la sesión ya iniciada.
            </p>
            {googleOption('google-register', 'Registrarse con Google', 'o crea un usuario con contraseña')}
            <ol className="auth-steps">
              <li>Completa nombre, correo, usuario y contraseña en el formulario de Keycloak.</li>
              <li>Keycloak crea la cuenta y te devuelve a FireWatch con una sesión.</li>
              <li>
                Los permisos de la cuenta nueva los asigna el reino de Keycloak, no esta página; el servidor los verifica
                en cada petición.
              </li>
            </ol>
            <button
              id="register"
              className="auth-primary"
              type="button"
              disabled={busy}
              onClick={() => launch('register')}
            >
              <LockGlyph />
              Crear cuenta con Keycloak
            </button>
            <p className="auth-switch">
              ¿Ya tienes cuenta?{' '}
              <button type="button" className="auth-link" onClick={() => setIntent('login')}>
                Iniciar sesión
              </button>
            </p>
          </div>

          <p
            id="auth-status"
            className={failed ? 'auth-status-line is-error' : 'auth-status-line'}
            role="status"
            aria-live="polite"
          >
            {status}
          </p>

          <p className="auth-privacy">
            FireWatch nunca ve tu contraseña: se escribe solo en Keycloak. El token de acceso permanece en memoria
            mientras la página está abierta; no se guardan tokens ni se envían cookies.
          </p>
        </div>

        {/* Board 14's side column: the contract this screen cannot change and the
            states it can really show. Both blocks are reference text — no
            credential field, no control and no simulated round trip. */}
        <aside className="auth-aside" aria-label="Contrato y estados del acceso">
          <section className="auth-facts-panel" id="auth-facts" aria-labelledby="auth-facts-title">
            <p className="auth-aside-eyebrow">CONTRATO ACTUAL</p>
            <h2 id="auth-facts-title">Qué hace el producto real</h2>
            <dl className="auth-facts">
              <div>
                <dt>Proveedor de identidad</dt>
                <dd>Keycloak · Authorization Code + PKCE</dd>
              </div>
              <div>
                <dt>Credenciales</dt>
                <dd>Se escriben solo en Keycloak; FireWatch nunca las pide</dd>
              </div>
              <div>
                <dt>Token</dt>
                <dd>En memoria; no se persiste ni viaja en cookie</dd>
              </div>
              <div>
                <dt>Roles</dt>
                <dd>Los asigna el reino y el servidor los verifica en cada petición</dd>
              </div>
              <div>
                <dt>Límite de la página</dt>
                <dd>Es una puerta de presentación, no una frontera de autorización</dd>
              </div>
            </dl>
          </section>

          <section className="auth-facts-panel" id="auth-states" aria-labelledby="auth-states-title">
            <p className="auth-aside-eyebrow">ESTADOS DE LA ENTRADA</p>
            <h2 id="auth-states-title">Qué se puede ver</h2>
            <ul className="auth-state-list">
              <li>
                <strong>Sin sesión</strong> <span>· esta pantalla, con los dos recorridos disponibles.</span>
              </li>
              <li>
                <strong>Regresando de Keycloak</strong>{' '}
                <span>· «Completando el acceso…» mientras se canjea el código.</span>
              </li>
              <li>
                <strong>Sesión rechazada</strong>{' '}
                <span>· vuelve a la entrada con el motivo y sin conservar el token.</span>
              </li>
              <li>
                <strong>Cancelado</strong> <span>· el intento no se completó; puedes intentarlo de nuevo.</span>
              </li>
              <li>
                <strong>Error de credenciales</strong>{' '}
                <span>· no se muestra: la página nunca recibe la credencial.</span>
              </li>
            </ul>
            <p className="auth-aside-note">
              La pantalla no simula los estados del producto; los nombra para que el diseño no los oculte.
            </p>
          </section>
        </aside>
        </div>
      </main>
    </div>
  );
}

// The Google "G", as Google's sign-in branding guidelines ask a "Sign in with
// Google" button to show it. Inline, so the page still loads nothing from
// another origin.
function GoogleGlyph() {
  return (
    <svg className="icon" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

function LockGlyph() {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    </svg>
  );
}
