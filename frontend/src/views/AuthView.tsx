import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { rejectedSessionCopy } from '../app/sessionCopy';
import { useSessionState } from '../app/store';
import { startLogin, startRegistration, type AuthorizationIntent, type SessionState } from '../core/session';

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
function statusCopy(session: SessionState, launched: AuthorizationIntent | null): string {
  if (session.status === 'signing-in') {
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

export function AuthView() {
  const session = useSessionState();
  const [intent, setIntent] = useState<AuthorizationIntent>(initialIntent);
  const [launched, setLaunched] = useState<AuthorizationIntent | null>(null);
  const tabRefs = useRef<Record<AuthorizationIntent, HTMLButtonElement | null>>({ login: null, register: null });

  const busy = session.status === 'signing-in';
  const status = statusCopy(session, launched);
  const failed = !busy && session.reason !== null;

  useEffect(() => {
    document.title = `${intent === 'register' ? 'Crear cuenta' : 'Iniciar sesión'} | FireWatch`;
  }, [intent]);

  const launch = (next: AuthorizationIntent) => {
    setLaunched(next);
    if (next === 'register') startRegistration();
    else startLogin();
  };

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
      </main>
    </div>
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
