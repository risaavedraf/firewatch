import { useCallback, useEffect, useRef, useState } from 'react';

import { idleCopy, rejectedSessionCopy } from '../app/sessionCopy';
import { useSessionState } from '../app/store';
import { PanelHeading } from '../components/ui';
import type { Failure } from '../core/api';
import { listRiskAlerts, type AlertOrder, type RiskAlert } from '../core/notifications';
import { levelLabel } from '../domain';
import type { SessionState } from '../core/session';

// PM-08 S1/S2 — the notification centre.
//
// The screen reuses the approved artboard's hierarchy and labels (title, order
// control, table, empty state and pager) but renders only persisted PM-07 alerts
// returned by `/v1/risk/alerts`. The artboard's eight invented preview rows and
// its "the alert entity does not exist yet" copy are deliberately not ported:
// PM-07 exists and the page does not simulate it.
//
// The cursor history is view state on purpose. The wire has no page numbers and
// no counts, so "Anterior" replays the cursor that produced the page before the
// current one. Changing the order or the session drops that history and starts a
// fresh first page in the selected direction.

type Phase = 'idle' | 'loading' | 'ready' | 'empty' | 'failure';

interface PageState {
  phase: Phase;
  items: readonly RiskAlert[];
  nextCursor: string | null;
  failure: Failure | null;
}

const EMPTY_PAGE: PageState = { phase: 'idle', items: [], nextCursor: null, failure: null };
const LOADING_PAGE: PageState = { phase: 'loading', items: [], nextCursor: null, failure: null };

interface SettledPage {
  key: string;
  page: PageState;
}

function failureMessage(failure: Failure): string {
  const request = failure.requestId !== undefined ? ` · request_id ${failure.requestId}` : '';
  const code = failure.reason !== '' ? ` · ${failure.reason}` : '';
  switch (failure.kind) {
    case 'unauthorized':
      return rejectedSessionCopy();
    case 'forbidden':
      return `La API denegó el permiso para consultar las alertas (HTTP 403${code}${request}). Solicita acceso a un administrador.`;
    case 'malformed':
      if (failure.status === 400) {
        return `La API rechazó la página solicitada (HTTP 400${code}${request}). Vuelve a la primera página.`;
      }
      return `La API devolvió un listado de alertas ilegible (HTTP ${failure.status ?? 200}${code}${request}); no se muestran filas parciales.`;
    case 'missing':
      return `No existe el listado de alertas (HTTP 404${code}${request}).`;
    case 'unavailable':
      return failure.status !== undefined
        ? `No se pudo consultar las alertas (HTTP ${failure.status}${code}${request}).`
        : 'No se pudo consultar las alertas (sin conexión).';
  }
}

function stateMessage(session: SessionState, signedIn: boolean, page: PageState, pageNumber: number): string {
  if (!signedIn) return idleCopy(session, 'consultar las alertas de cambio de nivel');
  switch (page.phase) {
    case 'idle':
      return idleCopy(session, 'consultar las alertas de cambio de nivel');
    case 'loading':
      return 'Consultando alertas…';
    case 'empty':
      return 'La API devolvió una lista vacía de alertas.';
    case 'ready':
      return `Mostrando la página ${pageNumber} del listado de alertas.`;
    case 'failure':
      return page.failure === null ? 'No se pudo consultar las alertas.' : failureMessage(page.failure);
  }
}

function sectorName(alert: RiskAlert): string {
  // `zone_name` is the real catalog label. A null label falls back to the real
  // zone code; no display name is derived from the code.
  return alert.zone_name !== null && alert.zone_name.trim() !== '' ? alert.zone_name : alert.zone_id;
}

function LevelBand({ level }: { level: RiskAlert['previous_level'] }) {
  return <span className={`notification-level notification-level-${level}`}>{levelLabel(level)}</span>;
}

function AlertRow({ alert }: { alert: RiskAlert }) {
  const previous = levelLabel(alert.previous_level);
  const next = levelLabel(alert.new_level);
  return (
    <tr>
      <td>
        <time dateTime={alert.occurred_at}>{alert.occurred_at}</time>
      </td>
      <td>
        <strong>{sectorName(alert)}</strong>
        {alert.zone_name !== null && alert.zone_name.trim() !== '' ? <small>{alert.zone_id}</small> : null}
      </td>
      <td>
        <span className="sr-only">{`Cambio de ${previous} a ${next}; umbral ${alert.threshold}.`}</span>
        <span aria-hidden="true" className="notification-change">
          <LevelBand level={alert.previous_level} />
          <span>→</span>
          <LevelBand level={alert.new_level} />
        </span>
        <small aria-hidden="true">Umbral {alert.threshold}</small>
      </td>
      <td>
        <span className={alert.demo ? 'notification-demo' : 'notification-provenance'}>
          {alert.demo ? 'Sintético' : 'Sin marca sintética'}
        </span>
      </td>
    </tr>
  );
}

function NotificationRegister({ session }: { session: SessionState }) {
  const signedIn = session.status === 'signed-in';
  const [order, setOrder] = useState<AlertOrder>('desc');
  // Each entry is the cursor used to request that page. The first page has no
  // cursor; the last entry is always the cursor of the page on screen.
  const [cursorStack, setCursorStack] = useState<readonly string[]>([]);
  const [settled, setSettled] = useState<SettledPage | null>(null);
  const [requestEpoch, setRequestEpoch] = useState(0);
  const statusRef = useRef<HTMLParagraphElement>(null);
  // Only a user-initiated page/order/retry change moves focus. The first load
  // must not steal focus from the navigation that opened the view.
  const focusOnSettle = useRef(false);

  const cursor = cursorStack.length > 0 ? cursorStack[cursorStack.length - 1] : null;
  const pageNumber = cursorStack.length + 1;
  // The request key is the state machine. A change of order, cursor or retry
  // makes the previous answer stale immediately, so `loading` is derived from
  // the mismatch instead of being written synchronously inside the effect.
  const requestKey = `${order}\u0000${cursor ?? ''}\u0000${requestEpoch}`;
  const page: PageState = !signedIn
    ? EMPTY_PAGE
    : settled !== null && settled.key === requestKey
      ? settled.page
      : LOADING_PAGE;

  useEffect(() => {
    if (!signedIn) return;
    const controller = new AbortController();
    let active = true;
    void listRiskAlerts({ order, cursor }, controller.signal).then(outcome => {
      if (!active) return;
      if (!outcome.ok) {
        setSettled({ key: requestKey, page: { phase: 'failure', items: [], nextCursor: null, failure: outcome.failure } });
        return;
      }
      setSettled({
        key: requestKey,
        page: {
          phase: outcome.data.items.length === 0 ? 'empty' : 'ready',
          items: outcome.data.items,
          nextCursor: outcome.data.next_cursor,
          failure: null,
        },
      });
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [signedIn, order, cursor, requestEpoch, requestKey]);

  useEffect(() => {
    if (!focusOnSettle.current) return;
    if (page.phase === 'idle' || page.phase === 'loading') return;
    focusOnSettle.current = false;
    statusRef.current?.focus();
  }, [page.phase, page.items, page.failure]);

  const markFocus = useCallback((): void => {
    focusOnSettle.current = true;
  }, []);

  const goNext = useCallback((): void => {
    const next = page.nextCursor;
    if (next === null || page.phase !== 'ready') return;
    markFocus();
    setCursorStack(history => [...history, next]);
    setRequestEpoch(value => value + 1);
  }, [markFocus, page.nextCursor, page.phase]);

  const goPrevious = useCallback((): void => {
    if (cursorStack.length === 0) return;
    markFocus();
    setCursorStack(history => history.slice(0, -1));
    setRequestEpoch(value => value + 1);
  }, [cursorStack.length, markFocus]);

  const changeOrder = (next: AlertOrder): void => {
    if (next === order) return;
    markFocus();
    setOrder(next);
    setCursorStack([]);
    setRequestEpoch(value => value + 1);
  };

  const retry = (): void => {
    markFocus();
    setRequestEpoch(value => value + 1);
  };

  const returnToFirstPage = (): void => {
    markFocus();
    setCursorStack([]);
    setRequestEpoch(value => value + 1);
  };

  const signedOut = !signedIn;
  const hasPreviousPage = cursorStack.length > 0;
  const showTable = signedIn && page.phase === 'ready' && page.items.length > 0;
  const showEmpty = signedIn && page.phase === 'empty';
  // The first-page empty state is the artboard's card and carries no pager. An
  // empty page reached by paging is different: "Anterior" must stay available or
  // the only way back disappears with the rows.
  const showPager =
    signedIn &&
    (page.phase === 'ready' ||
      page.phase === 'failure' ||
      page.phase === 'loading' ||
      (page.phase === 'empty' && hasPreviousPage));
  const canGoNext = page.phase === 'ready' && page.nextCursor !== null;
  const statusClass = page.phase === 'failure' ? 'status-copy risk-error' : 'status-copy';

  return (
    <section className="view" id="notifications" data-view="notifications" aria-labelledby="notifications-title">
      <div className="intro-row">
        <div>
          <p className="eyebrow">PM-08 · CENTRO DE NOTIFICACIONES</p>
          <h2 id="notifications-title">Notificaciones</h2>
          <p className="subheading">
            Alertas registradas por cambio de nivel, con su fecha y su sector. Esta página solo las lee: no las crea, no
            las marca y no las envía.
          </p>
        </div>
        <span className="neutral-tag">SOLO LECTURA</span>
      </div>

      <article className="panel notification-panel" aria-busy={page.phase === 'loading'}>
        <PanelHeading
          eyebrow="ALERTAS REGISTRADAS"
          title="Cambios de nivel"
          titleId="notifications-panel-title"
          badge={<span className="neutral-tag">/v1/risk/alerts</span>}
        />
        <div className="notification-body">
          <p className="panel-note">
            Filas devueltas por el servicio; el orden y la página los decide la consulta, no una preferencia guardada. La
            columna «Procedencia» reproduce el indicador sintético del lote de origen.
          </p>
          <div className="filter-bar notification-controls">
            <label className="filter-label" htmlFor="notifications-order">
              Orden de la lista
              <select
                id="notifications-order"
                value={order}
                disabled={signedOut}
                onChange={event => changeOrder(event.target.value === 'asc' ? 'asc' : 'desc')}
              >
                <option value="desc">Más recientes primero</option>
                <option value="asc">Más antiguas primero</option>
              </select>
            </label>
          </div>

          <p
            id="notifications-status"
            ref={statusRef}
            tabIndex={-1}
            className={statusClass}
            role="status"
            aria-live="polite"
          >
            {stateMessage(session, signedIn, page, pageNumber)}
          </p>

          {showEmpty ? (
            <div className="notification-empty">
              <p className="eyebrow">SIN DATOS · ESTADO REAL</p>
              <h3 id="notifications-empty-title">Sin notificaciones</h3>
              <p>
                No hay alertas de cambio de nivel registradas. Este estado no es un error de carga y no se rellena con
                filas de ejemplo.
              </p>
            </div>
          ) : null}

          {showTable ? (
            <div className="table-wrap">
              <table id="notifications-table" aria-describedby="notifications-status">
                <caption className="sr-only">Alertas de cambio de nivel registradas por el servicio</caption>
                <thead>
                  <tr>
                    <th scope="col">Fecha</th>
                    <th scope="col">Sector</th>
                    <th scope="col">Cambio de nivel</th>
                    <th scope="col">Procedencia</th>
                  </tr>
                </thead>
                <tbody id="notifications-rows">
                  {page.items.map(alert => (
                    <AlertRow key={alert.id} alert={alert} />
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {page.phase === 'failure' && page.failure !== null ? (
            <div className="notification-actions">
              <button id="notifications-retry" className="secondary-button" type="button" onClick={retry}>
                Reintentar
              </button>
              {hasPreviousPage ? (
                <button id="notifications-first" className="button-text" type="button" onClick={returnToFirstPage}>
                  Volver a la primera página
                </button>
              ) : null}
            </div>
          ) : null}

          {showPager ? (
            <div className="notification-pager" role="group" aria-label="Paginación de notificaciones">
              <button
                id="notifications-prev"
                className="secondary-button"
                type="button"
                disabled={!hasPreviousPage || page.phase === 'loading'}
                onClick={goPrevious}
              >
                Anterior
              </button>
              <span id="notifications-page" className="notification-page-label">
                Página {pageNumber}
              </span>
              <button
                id="notifications-next"
                className="secondary-button"
                type="button"
                disabled={!canGoNext}
                onClick={goNext}
              >
                Siguiente
              </button>
            </div>
          ) : null}
        </div>
      </article>
    </section>
  );
}

export function NotificationsView() {
  const session = useSessionState();
  // A new session remounts the register, so the cursor history, order and loaded
  // rows cannot leak from the previous session into the next one.
  return <NotificationRegister key={session.status === 'signed-in' ? 'open' : 'closed'} session={session} />;
}
