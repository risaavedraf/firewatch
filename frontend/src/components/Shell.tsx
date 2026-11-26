import { useEffect, useRef, useState, type ReactNode } from 'react';

import type { RouteDefinition } from '../app/routes';
import { sessionDetailCopy } from '../app/sessionCopy';
import { resetHistoryFilters, useSelectedZoneLabel, useSessionState } from '../app/store';
import { ready, type Outcome } from '../core/api';
import { signOut } from '../core/session';
import { ProductNav } from './ProductNav';
import { Icon } from './ui';

// The application shell: sidebar, topbar, update bar and footer, ported from the
// page that was already reviewed. Every element identifier the retired page
// exposed survives here, because the behaviour that reads them is ported with it.
//
// One thing deliberately does *not* survive: the demonstration strip is no
// longer a full-width headline above everything. The honesty statement it carried
// is still made — as a discreet, always-visible technical notice that leads to the
// data-status view, where the whole declaration lives (S15).

interface Readiness {
  state: 'checking' | 'ready' | 'down';
  message: string;
}

const CHECKING = 'Consultando disponibilidad del gateway…';

// The last probe that actually settled, or `null` before the first one. It is
// the only fact `#update-checked` may state: a failed re-check leaves the
// previous settled answer on screen until the new one lands, so the bar never
// claims a review that did not happen and never contradicts the availability
// card (S5).
interface SettledReview {
  ok: boolean;
  at: string;
}

function nowLabel(): string {
  return new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
}

// `#update-checked` used to be a fixed literal that contradicted the card next
// to it. It now reports only what the page knows: no settled review yet, or the
// outcome of the last one that settled.
function updateCheckedText(lastSettled: SettledReview | null): string {
  if (lastSettled === null) return 'sin verificar todavía; la barra informa solo disponibilidad del gateway';
  return lastSettled.ok
    ? `el gateway respondió en la última revisión (${lastSettled.at})`
    : `el gateway no respondió en la última revisión (${lastSettled.at})`;
}

// The card's probe travels on its own lane. The sources view probes the same
// route inside its bounded cycle, and one shared sequence let the probe started
// last discard this card's healthy answer — a false outage on a working gateway.
function probeGateway(signal?: AbortSignal): Promise<Outcome<null>> {
  return ready(signal, 'shell');
}

// The gateway probe proves gateway availability and nothing else: the page says so
// in the card itself, because a superficial readiness answer is not pipeline proof
// and the verifiable pipeline state lives in its own panel.
function readinessFrom(outcome: Outcome<null>): Readiness {
  if (outcome.ok) {
    return {
      state: 'ready',
      message: 'Gateway disponible; solo disponibilidad del gateway, no acredita el pipeline.',
    };
  }
  const status = outcome.failure.status;
  return status === undefined
    ? {
        state: 'down',
        message: 'No fue posible consultar el gateway; su disponibilidad no acredita el pipeline.',
      }
    : {
        state: 'down',
        message: `Gateway no disponible (HTTP ${status}); solo disponibilidad del gateway.`,
      };
}

export function Shell({ route, children }: { route: RouteDefinition; children: ReactNode }) {
  const session = useSessionState();
  const zoneLabel = useSelectedZoneLabel();
  const signedIn = session.status === 'signed-in';
  const [readiness, setReadiness] = useState<Readiness>({ state: 'checking', message: CHECKING });
  const [lastSettled, setLastSettled] = useState<SettledReview | null>(null);
  // The content region is a focus target, never a Tab stop: `tabIndex={-1}` below
  // makes it programmatically focusable while keeping it out of the sequential
  // order, so the only way in is the skip link itself.
  const contentRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void probeGateway(controller.signal).then((outcome) => {
      if (!active) return;
      setReadiness(readinessFrom(outcome));
      setLastSettled({ ok: outcome.ok, at: nowLabel() });
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  const checkReadiness = () => {
    setReadiness({ state: 'checking', message: CHECKING });
    void probeGateway().then((outcome) => {
      setReadiness(readinessFrom(outcome));
      setLastSettled({ ok: outcome.ok, at: nowLabel() });
    });
  };

  const dotClass = readiness.state === 'ready' ? 'health-dot ready' : readiness.state === 'down' ? 'health-dot down' : 'health-dot';

  return (
    <>
      {/* A fragment link in a hash-routed page is a trap: `#content` is not a
          declared route, so the browser's own navigation wrote it into the address
          bar and the router replaced it with the default view — the reader was
          moved to Overview and never reached the content. The link therefore keeps
          its anchor role, its name and its keyboard activation (Enter fires the
          same click) but stops the browser's navigation and moves focus itself,
          which leaves the open view's fragment where it was. */}
      <a
        className="skip-link"
        href="#content"
        onClick={event => {
          // A modified click is the browser's to handle — the shell takes over only
          // the plain activation the skip link exists for.
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          contentRef.current?.focus();
        }}
      >
        Saltar al contenido
      </a>
      <ProductNav route={route} />
      <div className="app-shell">
        <aside className="sidebar">
          <a className="brand" href="#overview" aria-label="FireWatch, inicio">
            <span className="brand-mark" aria-hidden="true">
              F
            </span>
            <span>
              <strong>FireWatch</strong>
              <small>Prevención territorial</small>
            </span>
          </a>
          <div className="workspace">
            <span className="workspace-mark" aria-hidden="true">
              V
            </span>
            <div>
              Valparaíso
              <small>Ámbito regional</small>
            </div>
            <Icon name="territory" />
          </div>
          <div className="sidebar-bottom">
            <section className="health-card" aria-labelledby="health-title">
              <div className="health-head">
                <strong id="health-title">Gateway</strong>
                <span className={dotClass} aria-hidden="true" />
              </div>
              <p id="readiness-status" role="status" aria-live="polite">
                {readiness.message}
              </p>
              <button
                id="readiness-refresh"
                className="side-action"
                type="button"
                disabled={readiness.state === 'checking'}
                onClick={checkReadiness}
              >
                Actualizar estado
              </button>
            </section>
            <div className="session-card">
              <span className="session-mark" aria-hidden="true">
                ●
              </span>
              <div>
                <strong id="session-state">{signedIn ? 'Sesión conectada' : 'Sin conexión'}</strong>
                <small id="session-detail">
                  {signedIn ? 'Permisos evaluados por el servidor' : sessionDetailCopy(session)}
                </small>
              </div>
              {/* Kept in the document exactly once and hidden while signed out, which
                  is the contract the retired page had: one control, never a duplicate. */}
              <button id="logout" type="button" hidden={!signedIn} onClick={signOut}>
                Cerrar sesión
              </button>
            </div>
          </div>
        </aside>

        <div className="main-area">
          <header className="topbar">
            <div>
              <span className="breadcrumbs">
                FireWatch <span>/</span> {route.group}
              </span>
              <h1>{route.title}</h1>
            </div>
            <div className="zone-chip">
              <span aria-hidden="true">⌖</span>
              <div>
                <small>ZONA</small>
                <strong id="zone-chip-name">{zoneLabel === '' ? 'Sin zona' : zoneLabel}</strong>
              </div>
            </div>
          </header>
          <div className="update-bar">
            <Icon name="refresh" />
            <span>
              Información revisada:{' '}
              <strong id="update-checked">{updateCheckedText(lastSettled)}</strong>
            </span>
            <a
              className="technical-notice"
              id="data-status-notice"
              href="#sources"
              aria-label="Aviso de alcance: el servicio entrega entrada sintética de demostración, sin calibración ni uso operativo. Ver el estado de datos para el detalle completo."
            >
              Entrada sintética · aviso de alcance
            </a>
          </div>
          <main id="content" ref={contentRef} tabIndex={-1}>
            {children}
          </main>
          {/* The footer is its own landmark. Inside `main` it belonged to the main
              region, so a reader navigating by landmark reached it as content and
              never as the page's footer. It stays where it looks, after the view. */}
          <footer>
            <span>FireWatch · La API no realiza predicciones ni recomendaciones operativas.</span>
            <button id="reset-filters" type="button" onClick={resetHistoryFilters}>
              <Icon name="refresh" />
              Restablecer filtros
            </button>
          </footer>
        </div>
      </div>
    </>
  );
}
