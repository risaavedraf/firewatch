import { useCallback, useEffect, useRef, useState } from 'react';

import { idleCopy, rejectedSessionCopy } from '../app/sessionCopy';
import { useSessionState } from '../app/store';
import { PanelHeading } from '../components/ui';
import type { Failure } from '../core/api';
import {
  listRiskAlerts,
  markRiskAlertState,
  readRiskAlertState,
  type AlertOrder,
  type AlertStateMark,
  type PersonalAlertState,
  type RiskAlert,
  type RiskAlertState,
} from '../core/notifications';
import { levelLabel } from '../domain';
import { getSessionSnapshot, type SessionState } from '../core/session';
import '../styles/decision-workspace.css';

// PM-08 S1/S2/S3 — the notification centre.
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
//
// PM-08's personal mark adds a second read per visible row, `GET
// /v1/risk/alerts/{id}/state`, and one write, `PUT` on the same path. Three rules
// travel with that seam:
//   1. the mark shown is the one the service served, never a default. A row whose
//      mark could not be read says so and offers no control, because "Sin leer" is
//      a stored fact and not the absence of an answer;
//   2. the write is ack: the row paints the state the PUT answered, which may
//      dominate what was requested (replay, or `read` after `dismissed`). Nothing
//      is applied locally before the service answers;
//   3. the contract declares the write admin-only and this page does not guess a
//      role: a viewer's `403` is stated inline as a denial, never as an applied
//      mark.
//
// No mark is kept in browser storage. It lives on the server and is re-read, so
// the only stored value in the whole flow remains the PKCE transaction of the
// sign-in round trip.

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

// One row's mark read. `loading` exists so the cell can say the mark is being
// read instead of painting a state the service has not served yet.
type MarkPhase = 'loading' | 'ready' | 'failure';

interface MarkEntry {
  phase: MarkPhase;
  state: RiskAlertState | null;
  failure: Failure | null;
}

type MarkTable = Readonly<Record<string, MarkEntry>>;
type MarkFilter = 'all' | PersonalAlertState;

// A read of one page's marks, tagged with the page key that asked for it. The tag
// is what makes a row `loading` without writing state from an effect: marks whose
// key does not match the page on screen were never read FOR this page.
interface SettledMarks {
  key: string;
  marks: MarkTable;
}

interface KeyedFeedback {
  key: string;
  entries: Readonly<Record<string, string>>;
}

interface KeyedPending {
  key: string;
  entries: Readonly<Record<string, AlertStateMark>>;
}

// The page's single mark announcement, tagged with the page it belongs to.
interface KeyedNotice {
  key: string;
  text: string;
}

// A focus move requested by a settled action. It is applied after the commit that
// changed the row, and carries the page key that asked for it so a settle from a
// page the user already left cannot move focus.
interface FocusRequest {
  key: string | null;
  buttonId: string;
  cellId: string;
  ordinal: number;
}

const NO_MARKS: MarkTable = {};

const MARK_FILTERS: ReadonlyArray<{ value: MarkFilter; label: string }> = [
  { value: 'all', label: 'Todas' },
  { value: 'unread', label: 'Sin leer' },
  { value: 'read', label: 'Leídas' },
  { value: 'dismissed', label: 'Revisadas' },
];

const PERSONAL_STATE_LABELS: Record<PersonalAlertState, string> = {
  unread: 'Sin leer',
  read: 'Leída',
  dismissed: 'Revisada',
};

const PERSONAL_STATE_NOTES: Record<PersonalAlertState, string> = {
  unread: 'Tu marca no registra nada todavía: puedes marcarla como leída o como revisada, y revisada domina a leída.',
  read: 'La marca leída ya está registrada; solo puedes avanzar a revisada, que la domina.',
  dismissed: 'Revisada es la marca final de esta alerta y no se revierte.',
};

function markCellId(alertId: string): string {
  return `notifications-mark-${alertId}`;
}

function markFeedbackId(alertId: string): string {
  return `notifications-mark-feedback-${alertId}`;
}

function markNoteId(alertId: string): string {
  return `notifications-mark-note-${alertId}`;
}

function markButtonId(alertId: string, mark: AlertStateMark): string {
  return `notifications-mark-${mark}-${alertId}`;
}

function filterLabel(filter: MarkFilter): string {
  return MARK_FILTERS.find(option => option.value === filter)?.label ?? 'Todas';
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

// The write's own copy. A refusal states what the contract proves; a fault does
// not claim the mark was applied OR that it was not, because a lost answer leaves
// the stored state unknown until the row is re-read.
function markFailureMessage(failure: Failure): string {
  const request = failure.requestId !== undefined ? ` · request_id ${failure.requestId}` : '';
  const code = failure.reason !== '' ? ` · ${failure.reason}` : '';
  switch (failure.kind) {
    case 'unauthorized':
      // The envelope the service served on the 401 is kept: a rejected token is a
      // stated refusal with its own code and request id, not a generic logout.
      return `La API rechazó el token al registrar la marca (HTTP 401${code}${request}). ${rejectedSessionCopy()} La marca no se registró en esta sesión.`;
    case 'forbidden':
      return `La API denegó el permiso para registrar tu marca personal (HTTP 403${code}${request}). Solo un administrador puede marcar sus propias alertas; la fila no se muestra como marcada.`;
    case 'missing':
      return `La API no encontró la alerta (HTTP 404${code}${request}); la marca no se registró y la fila conserva la que ya tenía.`;
    case 'malformed':
      return failure.status === 400 || failure.status === 415
        ? `La API rechazó la marca solicitada (HTTP ${failure.status}${code}${request}); no se registró nada y la fila conserva su marca.`
        : `La API respondió la marca con un documento ilegible (HTTP ${failure.status ?? 200}${code}${request}); la fila no la muestra como aplicada.`;
    case 'unavailable':
      // 429 and 503 are stopped before the mark is stored: the contract's own
      // words are "nothing was written" and "the operation has no effect". Only a
      // 502 (and a lost connection) leaves completion genuinely unknown.
      if (failure.status === 429) {
        return `La API limitó las solicitudes y no atendió el registro (HTTP 429${code}${request}). La marca no se registró y la fila conserva su marca.`;
      }
      if (failure.status === 503) {
        return `El servicio no pudo almacenar la marca (HTTP 503${code}${request}). La marca no se registró y el estado guardado no cambió.`;
      }
      return failure.status !== undefined
        ? `No se pudo confirmar el registro de la marca (HTTP ${failure.status}${code}${request}). La marca pudo haberse guardado: la fila no se muestra como aplicada.`
        : 'No se pudo confirmar el registro de la marca (sin conexión). La marca pudo haberse guardado: la fila no se muestra como aplicada.';
  }
}

function markReadFailureMessage(failure: Failure): string {
  const request = failure.requestId !== undefined ? ` · request_id ${failure.requestId}` : '';
  const code = failure.reason !== '' ? ` · ${failure.reason}` : '';
  return `La API rechazó el token al leer tu marca personal (HTTP 401${code}${request}). ${rejectedSessionCopy()} La marca no se pudo leer en esta sesión.`;
}

function markAppliedMessage(requested: AlertStateMark, served: RiskAlertState): string {
  const instant = served.marked_at !== null ? ` · ${served.marked_at}` : '';
  if (served.state !== requested) {
    // Monotonic marks: the service may answer a dominant stored mark for a
    // replayed or superseded request. What it answered is what the row shows.
    return `El servidor ya tenía la marca dominante «${PERSONAL_STATE_LABELS[served.state]}»${instant}; se muestra la que el servicio devolvió.`;
  }
  return `Marca registrada: «${PERSONAL_STATE_LABELS[served.state]}»${instant}.`;
}

interface MarkTally {
  total: number;
  loading: number;
  failed: number;
  unread: number;
  read: number;
  dismissed: number;
}

function tallyMarks(items: readonly RiskAlert[], marks: MarkTable): MarkTally {
  const tally: MarkTally = { total: items.length, loading: 0, failed: 0, unread: 0, read: 0, dismissed: 0 };
  for (const alert of items) {
    const entry = marks[alert.id];
    if (entry === undefined || entry.phase === 'loading') {
      tally.loading += 1;
      continue;
    }
    if (entry.phase === 'failure' || entry.state === null) {
      tally.failed += 1;
      continue;
    }
    tally[entry.state.state] += 1;
  }
  return tally;
}

function stateMessage(session: SessionState, signedIn: boolean, page: PageState, pageNumber: number, tally: MarkTally): string {
  if (!signedIn) return idleCopy(session, 'consultar las alertas de cambio de nivel');
  switch (page.phase) {
    case 'idle':
      return idleCopy(session, 'consultar las alertas de cambio de nivel');
    case 'loading':
      return 'Consultando alertas…';
    case 'empty':
      // The list is cursor-paginated, so an empty page is a fact about THIS page.
      // Only the first page can speak for the whole register.
      return `La API devolvió una lista vacía de alertas en la página ${pageNumber}.`;
    case 'ready':
      if (tally.loading > 0) {
        return `Mostrando la página ${pageNumber} del listado de alertas. Leyendo tu marca personal de esta página…`;
      }
      if (tally.failed > 0) {
        return `Mostrando la página ${pageNumber} del listado de alertas. ${tally.failed} de las ${tally.total} marcas personales de esta página no se pudieron leer.`;
      }
      return `Mostrando la página ${pageNumber} del listado de alertas, con tu marca personal leída del servicio.`;
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

interface AlertRowProps {
  alert: RiskAlert;
  entry: MarkEntry | undefined;
  pending: boolean;
  feedback: string;
  onMark: (alertId: string, mark: AlertStateMark) => void;
}

function AlertRow({ alert, entry, pending, feedback, onMark }: AlertRowProps) {
  const previous = levelLabel(alert.previous_level);
  const next = levelLabel(alert.new_level);
  const served = entry !== undefined && entry.phase === 'ready' ? entry.state : null;
  const personalState = served === null ? null : served.state;
  const markedAt = served === null ? null : served.marked_at;
  const canRead = personalState === 'unread';
  const canDismiss = personalState !== null && personalState !== 'dismissed';
  const note = personalState !== null
    ? PERSONAL_STATE_NOTES[personalState]
    : entry !== undefined && entry.phase === 'failure'
      ? 'La marca de esta alerta no se pudo leer del servicio; no se ofrece registrar una marca sin conocer la actual.'
      : 'La marca de esta alerta se está leyendo del servicio; todavía no se ofrece registrarla.';

  return (
    <tr aria-busy={pending ? 'true' : 'false'} data-alert-id={alert.id}>
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
      <td className="notification-mark-cell">
        {/* The mark itself is ordinary text, not a control: it can hold focus so a
            completed write never loses it when the trigger retires. */}
        <div className="notification-mark" id={markCellId(alert.id)} tabIndex={-1}>
          {entry === undefined || entry.phase === 'loading' ? (
            <span className="notification-mark-pending">Consultando marca…</span>
          ) : entry.phase === 'failure' || served === null ? (
            <span className="notification-mark-unknown">
              Marca no disponible
              <code>{` · ${entry.failure?.reason ?? 'invalid_shape'}`}</code>
              {entry.failure?.requestId !== undefined ? ` · request_id ${entry.failure.requestId}` : null}
            </span>
          ) : (
            <>
              <span className={`notification-mark-chip notification-mark-chip-${personalState ?? 'unread'}`}>
                {personalState === null ? '' : PERSONAL_STATE_LABELS[personalState]}
              </span>
              {markedAt !== null ? (
                <time className="notification-mark-time" dateTime={markedAt}>
                  {markedAt}
                </time>
              ) : null}
            </>
          )}
        </div>
        <div className="notification-mark-actions" aria-busy={pending ? 'true' : 'false'}>
          <button
            id={markButtonId(alert.id, 'read')}
            className="button-text"
            type="button"
            disabled={pending || !canRead}
            aria-describedby={markNoteId(alert.id)}
            onClick={() => onMark(alert.id, 'read')}
          >
            Marcar como leída
          </button>
          <button
            id={markButtonId(alert.id, 'dismissed')}
            className="button-text"
            type="button"
            disabled={pending || !canDismiss}
            aria-describedby={markNoteId(alert.id)}
            onClick={() => onMark(alert.id, 'dismissed')}
          >
            Marcar como revisada
          </button>
        </div>
        <span className="sr-only" id={markNoteId(alert.id)}>
          {note}
        </span>
        {/* The row's visible record of its last write. The announcement itself
            belongs to the page's persistent region, so this text can leave with a
            filtered row without losing the confirmation. */}
        <p className="notification-mark-feedback" id={markFeedbackId(alert.id)}>
          {feedback}
        </p>
      </td>
    </tr>
  );
}

interface NotificationRegisterProps {
  session: SessionState;
  // A 401 on a mark lowers the session, so this register is remounted signed out.
  // The refusal text lives in `NotificationsView`, which stays mounted, and is
  // rendered here so the contract's code and request id are still inline.
  refusedNotice: string;
  onRefusedMark: (text: string) => void;
}

function NotificationRegister({ session, refusedNotice, onRefusedMark }: NotificationRegisterProps) {
  const signedIn = session.status === 'signed-in';
  const [order, setOrder] = useState<AlertOrder>('desc');
  // Each entry is the cursor used to request that page. The first page has no
  // cursor; the last entry is always the cursor of the page on screen.
  const [cursorStack, setCursorStack] = useState<readonly string[]>([]);
  const [settled, setSettled] = useState<SettledPage | null>(null);
  const [requestEpoch, setRequestEpoch] = useState(0);
  const [settledMarks, setSettledMarks] = useState<SettledMarks | null>(null);
  const [marksEpoch, setMarksEpoch] = useState(0);
  // Feedback and in-flight marks are keyed by the same page key as the reads, so
  // a message about the page just left cannot hang under a row of the next one.
  const [feedback, setFeedback] = useState<KeyedFeedback>({ key: '', entries: {} });
  const [pending, setPending] = useState<KeyedPending>({ key: '', entries: {} });
  const [filter, setFilter] = useState<MarkFilter>('all');
  // The page's persistent mark announcement: one region, mounted before any
  // update, so a confirmation still lands when the active filter removes the row
  // it belongs to.
  const [announcement, setAnnouncement] = useState<KeyedNotice>({ key: '', text: '' });
  // Focus requests are applied after the commit that changed the row, so the
  // element that must receive focus exists by then.
  const pendingFocus = useRef<FocusRequest | null>(null);
  // The parent's refusal sink is held in a ref so the page-keyed read effect does
  // not depend on its identity, which changes on every parent render.
  const onRefusedMarkRef = useRef(onRefusedMark);
  useEffect(() => {
    onRefusedMarkRef.current = onRefusedMark;
  }, [onRefusedMark]);
  const [focusTick, setFocusTick] = useState(0);
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
  // The marks of the page on screen: the ones read for this exact page and retry,
  // and nothing else. A row with no entry here is loading, never "Sin leer".
  const marksKey = page.phase === 'ready' ? `${requestKey}\u0000${marksEpoch}` : '';
  const marks: MarkTable = settledMarks !== null && settledMarks.key === marksKey ? settledMarks.marks : NO_MARKS;
  const feedbackFor = (alertId: string): string =>
    feedback.key === marksKey ? (feedback.entries[alertId] ?? '') : '';
  const pendingFor = (alertId: string): AlertStateMark | undefined =>
    pending.key === marksKey ? pending.entries[alertId] : undefined;

  // The key of the page on screen, readable from a promise that started on
  // another page: a late settle must not move focus that belongs elsewhere.
  const marksKeyRef = useRef(marksKey);
  useEffect(() => {
    marksKeyRef.current = marksKey;
  }, [marksKey]);

  const tally = tallyMarks(page.items, marks);
  const filteredView = filter !== 'all';
  const visibleItems = filteredView
    ? page.items.filter(alert => {
        const entry = marks[alert.id];
        return entry !== undefined && entry.phase === 'ready' && entry.state !== null && entry.state.state === filter;
      })
    : page.items;
  // A refused mark outlives this register (the 401 remounts it), so the view's
  // message fills the region when this instance has none of its own.
  const liveText = announcement.key === marksKey && announcement.text !== '' ? announcement.text : refusedNotice;

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

  // One mark read per visible row, in parallel and bounded by the same abort. A
  // failure belongs to its row only: the other rows keep their served marks and
  // the table is never replaced by an error.
  useEffect(() => {
    if (!signedIn || page.phase !== 'ready' || page.items.length === 0) return;
    const items = page.items;
    const key = marksKey;
    const controller = new AbortController();
    let active = true;
    // A 401 on one row's read is the session's refusal, not that row's mark. It is
    // forwarded per row because the remount that follows tears this effect down
    // before the aggregate answer would be handled.
    const reportRefusal = (failure: Failure): void => {
      if (marksKeyRef.current !== key) return;
      // The transport lowers the session only when the rejected bearer is still the
      // session's; a still-signed-in session means this 401 is a superseded token's
      // and must not become this page's notice.
      if (getSessionSnapshot().status === 'signed-in') return;
      onRefusedMarkRef.current(markReadFailureMessage(failure));
    };
    void Promise.all(
      items.map(async alert => {
        const outcome = await readRiskAlertState(alert.id, controller.signal);
        if (!outcome.ok && outcome.failure.kind === 'unauthorized') reportRefusal(outcome.failure);
        return [alert.id, outcome] as const;
      }),
    ).then(results => {
      if (!active) return;
      const next: Record<string, MarkEntry> = {};
      for (const [id, outcome] of results) {
        next[id] = outcome.ok
          ? { phase: 'ready', state: outcome.data, failure: null }
          : { phase: 'failure', state: null, failure: outcome.failure };
      }
      setSettledMarks({ key, marks: next });
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [signedIn, page, marksKey]);

  useEffect(() => {
    if (!focusOnSettle.current) return;
    if (page.phase === 'idle' || page.phase === 'loading') return;
    focusOnSettle.current = false;
    statusRef.current?.focus();
  }, [page.phase, page.items, page.failure]);

  useEffect(() => {
    const request = pendingFocus.current;
    if (request === null) return;
    pendingFocus.current = null;
    // A settle that belongs to a page the user already left must not move focus.
    if (request.key !== null && request.key !== marksKeyRef.current) return;
    const button = document.getElementById(request.buttonId);
    if (button instanceof HTMLButtonElement && !button.disabled) {
      button.focus();
      return;
    }
    // A disabled control cannot hold focus, so when the served mark retired the
    // control that fired, focus lands on the row's mark instead of being lost.
    const cell = document.getElementById(request.cellId);
    if (cell !== null) {
      cell.focus();
      return;
    }
    // The row left the visible set because the active filter no longer matches
    // it: focus the row that took its place, else the previous one, else the
    // card that explains the empty page, else this page's mark status. It never
    // stays on `document.body`.
    const cells = [
      ...document.querySelectorAll<HTMLElement>('#notifications-rows tr[data-alert-id] .notification-mark'),
    ];
    const neighbour = cells.length === 0 ? null : (cells[Math.min(request.ordinal, cells.length - 1)] ?? null);
    if (neighbour !== null) {
      neighbour.focus();
      return;
    }
    const cardTitle = document.getElementById('notifications-filter-empty-title');
    if (cardTitle !== null) {
      cardTitle.focus();
      return;
    }
    const markStatus = document.getElementById('notifications-mark-status');
    if (markStatus !== null) {
      markStatus.focus();
      return;
    }
    document.getElementById('notifications-mark-filter')?.focus();
  }, [focusTick]);

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

  const retryMarks = (): void => {
    // The retry control retires itself while the rows re-read, so focus moves to
    // the page's own mark status rather than being dropped. The request is not
    // page-keyed because this action changes the key it would carry.
    pendingFocus.current = {
      key: null,
      buttonId: 'notifications-marks-retry',
      cellId: 'notifications-mark-status',
      ordinal: 0,
    };
    setMarksEpoch(value => value + 1);
    setFocusTick(value => value + 1);
  };

  // The write handler is a plain function because it reads the visible rows to
  // remember where the marked row stood; that position is what focus falls back
  // to when an active filter removes it.
  const markAlert = (alertId: string, mark: AlertStateMark): void => {
    const key = marksKey;
    const ordinal = Math.max(
      0,
      visibleItems.findIndex(alert => alert.id === alertId),
    );
    const inFlight = `Registrando la marca «${PERSONAL_STATE_LABELS[mark]}»…`;
    setPending(current => ({ key, entries: { ...(current.key === key ? current.entries : {}), [alertId]: mark } }));
    setFeedback(current => ({
      key,
      entries: { ...(current.key === key ? current.entries : {}), [alertId]: inFlight },
    }));
    setAnnouncement({ key, text: inFlight });
    void markRiskAlertState(alertId, mark).then(outcome => {
      const message = outcome.ok ? markAppliedMessage(mark, outcome.data) : markFailureMessage(outcome.failure);
      // Every merge below is scoped to the page key that started this write: a
      // late PUT from a page the user already left must never overwrite the marks
      // of the page on screen, nor leave it waiting on a read that already landed.
      setPending(current => {
        if (current.key !== key) return current;
        const entries = { ...current.entries };
        delete entries[alertId];
        return { key, entries };
      });
      setFeedback(current =>
        current.key === key ? { key, entries: { ...current.entries, [alertId]: message } } : current,
      );
      setAnnouncement(current => (current.key === key ? { key, text: message } : current));
      if (outcome.ok) {
        // The row takes the answer, including a dominant mark it did not ask for.
        setSettledMarks(current =>
          current !== null && current.key === key
            ? { key, marks: { ...current.marks, [alertId]: { phase: 'ready', state: outcome.data, failure: null } } }
            : current,
        );
      }
      // Everything below speaks for the page and the session that started the
      // write: a stale settle must not report a refusal for the page on screen, nor
      // move focus that belongs to it.
      if (marksKeyRef.current !== key) return;
      if (!outcome.ok && outcome.failure.kind === 'unauthorized' && getSessionSnapshot().status !== 'signed-in') {
        // The transport already lowered the session, so this register is about to
        // be remounted signed out. The view keeps the refusal — with its code and
        // request id — where it stays mounted.
        onRefusedMark(message);
      }
      pendingFocus.current = { key, buttonId: markButtonId(alertId, mark), cellId: markCellId(alertId), ordinal };
      setFocusTick(value => value + 1);
    });
  };

  const signedOut = !signedIn;
  const hasPreviousPage = cursorStack.length > 0;
  const showAlerts = signedIn && page.phase === 'ready' && page.items.length > 0;
  // While the marks are still being read the table holds the page's rows without
  // claiming the filter matched nothing; the empty filter card waits for answers.
  const showTable = showAlerts && (visibleItems.length > 0 || (filteredView && tally.loading > 0));
  const showFilterEmpty = showAlerts && filteredView && tally.loading === 0 && visibleItems.length === 0;
  const showEmpty = signedIn && page.phase === 'empty';
  // An empty page reached by paging is not the empty register: the rows before it
  // exist, and the card must not claim there are no registered alerts. Only a
  // first page can say that, because the first page is where the list starts.
  const emptyIsLaterPage = showEmpty && hasPreviousPage;
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
      <div className="intro-row decision-head">
        <div>
          <p className="eyebrow">PM-08 · CENTRO DE NOTIFICACIONES</p>
          <h2 id="notifications-title">Notificaciones</h2>
          <p className="subheading">
            Alertas registradas por cambio de nivel, con su fecha y su sector. Esta página no crea alertas ni envía
            avisos: registra tu marca personal de lectura —sin leer, leída o revisada— sobre las alertas que el
            servicio ya guardó, y esa marca es tuya, no una entrega ni un aviso.
          </p>
        </div>
        {/* The page's two true scope chips: it reads with the caller's own mark,
            and it sends nothing. */}
        <div className="decision-head__chips">
          <span className="neutral-tag">MARCA PERSONAL</span>
          <span className="neutral-tag">SIN ENVÍO DE AVISOS</span>
        </div>
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
            columna «Procedencia» reproduce el indicador sintético del lote de origen, y «Marca personal» muestra la
            marca que el servicio devuelve para tu usuario en cada alerta: no se guarda en el navegador.
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
            <label className="filter-label" htmlFor="notifications-mark-filter">
              Marca personal (solo esta página)
              <select
                id="notifications-mark-filter"
                value={filter}
                disabled={signedOut}
                onChange={event => {
                  const value = event.target.value;
                  setFilter(MARK_FILTERS.some(option => option.value === value) ? (value as MarkFilter) : 'all');
                }}
              >
                {MARK_FILTERS.map(option => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
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
            {stateMessage(session, signedIn, page, pageNumber, tally)}
          </p>

          {/* The page's own mark announcement. It is mounted before any update, so
              a row that leaves the table (an active filter) cannot take the
              confirmation with it, and a 401 remount still renders it. */}
          <p
            id="notifications-mark-status"
            className="status-copy notification-mark-status"
            role="status"
            aria-live="polite"
            tabIndex={-1}
          >
            {liveText}
          </p>

          {showAlerts ? (
            <p className="panel-note" id="notifications-mark-scope">
              {`El filtro por marca se aplica solo a las ${page.items.length} alertas cargadas en la página ${pageNumber}: el contrato de /v1/risk/alerts no ofrece filtrar por marca en el registro completo, así que este filtro no dice nada sobre el resto.`}
              {filteredView && tally.failed > 0
                ? ` ${tally.failed} ${tally.failed === 1 ? 'alerta de esta página no se clasifica' : 'alertas de esta página no se clasifican'} porque su marca no se pudo leer.`
                : ''}
            </p>
          ) : null}

          {showAlerts ? (
            <p className="panel-note" id="notifications-mark-counts">
              {`En las ${page.items.length} alertas de esta página · Sin leer: ${tally.unread} · Leídas: ${tally.read} · Revisadas: ${tally.dismissed}`}
              {tally.failed > 0 ? ` · Marca no disponible: ${tally.failed}` : ''}
            </p>
          ) : null}

          {showAlerts && tally.failed > 0 ? (
            <div className="notification-actions">
              <p className="panel-note" id="notifications-marks-note">
                {`No se pudo leer tu marca personal en ${tally.failed} ${tally.failed === 1 ? 'alerta' : 'alertas'} de esta página. Esas filas no se muestran como «Sin leer»: la marca que el servicio no devolvió no se supone.`}
              </p>
              <button id="notifications-marks-retry" className="secondary-button" type="button" onClick={retryMarks}>
                Releer las marcas de esta página
              </button>
            </div>
          ) : null}

          {showFilterEmpty ? (
            <div className="notification-filter-empty" id="notifications-filter-empty">
              <p className="eyebrow">FILTRO DE ESTA PÁGINA</p>
              {/* The heading is the focus target when the filter empties the page,
                  so focus lands on the card that explains it rather than being lost. */}
              <h3 id="notifications-filter-empty-title" tabIndex={-1}>
                Esta página no tiene alertas con esa marca
              </h3>
              <p className="notification-filter-empty-copy" id="notifications-filter-empty-copy">
                {`Ninguna alerta de la página ${pageNumber} tiene la marca «${filterLabel(filter)}». El filtro no afirma nada sobre el registro completo: cambia de página o vuelve a «Todas».`}
                {tally.failed > 0
                  ? ` ${tally.failed} ${tally.failed === 1 ? 'alerta de esta página no se clasifica' : 'alertas de esta página no se clasifican'} porque su marca no se pudo leer.`
                  : ''}
              </p>
              <button
                id="notifications-mark-filter-clear"
                className="secondary-button"
                type="button"
                onClick={() => setFilter('all')}
              >
                Ver todas las marcas de esta página
              </button>
            </div>
          ) : null}

          {showEmpty ? (
            <div className="notification-empty">
              {/* The board's empty card: a dashed mark, the honest eyebrow, the
                  title and what would fill the list. Decorative on purpose — the
                  text below carries the whole meaning. */}
              <span className="notification-empty-mark" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} focusable="false">
                  <path d="M6 9a6 6 0 0 1 12 0c0 4 1.5 5.5 1.5 5.5H4.5S6 13 6 9Z" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M10 18.5a2 2 0 0 0 4 0" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M3.5 3.5 20.5 20.5" strokeDasharray="2 3" strokeLinecap="round" />
                </svg>
              </span>
              <p className="eyebrow">{emptyIsLaterPage ? 'PÁGINA VACÍA' : 'SIN DATOS · ESTADO REAL'}</p>
              <h3 id="notifications-empty-title">
                {emptyIsLaterPage ? 'Esta página no tiene alertas' : 'Sin notificaciones'}
              </h3>
              <p className="notification-empty-copy">
                {emptyIsLaterPage
                  ? `La página ${pageNumber} no devolvió alertas. La lista se pagina por cursor y las páginas anteriores sí tenían filas, así que este vacío no afirma que no haya alertas registradas.`
                  : 'No hay alertas de cambio de nivel registradas. Este estado no es un error de carga y no se rellena con filas de ejemplo.'}
              </p>
              <ul className="notification-empty-points">
                {emptyIsLaterPage ? (
                  <li>Usa «Anterior» para volver a la página que tenía filas.</li>
                ) : (
                  <li>
                    Qué llenaría la lista: cada alerta por cambio de nivel que el servicio registre en{' '}
                    <code>/v1/risk/alerts</code>, con su sector, su umbral y su fecha.
                  </li>
                )}
                <li>
                  Qué no hace esta página: no crea alertas y no envía avisos, y tampoco registra entregas. Tu marca
                  personal de lectura solo se guarda sobre alertas ya almacenadas y requiere permiso de administrador; no
                  es una entrega ni un aviso.
                </li>
              </ul>
            </div>
          ) : null}

          {showTable ? (
            <div className="table-wrap">
              <table id="notifications-table" aria-describedby="notifications-status">
                <caption className="sr-only">
                  Alertas de cambio de nivel registradas por el servicio, con la marca personal que el servicio devuelve
                  para cada una
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Fecha</th>
                    <th scope="col">Sector</th>
                    <th scope="col">Cambio de nivel</th>
                    <th scope="col">Procedencia</th>
                    <th scope="col">Marca personal</th>
                  </tr>
                </thead>
                <tbody id="notifications-rows">
                  {visibleItems.map(alert => (
                    <AlertRow
                      key={alert.id}
                      alert={alert}
                      entry={marks[alert.id]}
                      pending={pendingFor(alert.id) !== undefined}
                      feedback={feedbackFor(alert.id)}
                      onMark={markAlert}
                    />
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
  // A 401 on a mark lowers the session, so the register is remounted signed out
  // and its own row state goes with it. The refusal is kept here, where the view
  // stays mounted, so the contract's code and request id are still rendered inline.
  const [refusedMark, setRefusedMark] = useState<{ status: SessionState['status']; text: string }>({
    status: 'signed-out',
    text: '',
  });
  const refusedNotice = refusedMark.status === session.status ? refusedMark.text : '';
  // A new session remounts the register, so the cursor history, order and loaded
  // rows cannot leak from the previous session into the next one.
  return (
    <NotificationRegister
      key={session.status === 'signed-in' ? 'open' : 'closed'}
      session={session}
      refusedNotice={refusedNotice}
      onRefusedMark={text => setRefusedMark({ status: 'signed-out', text })}
    />
  );
}
