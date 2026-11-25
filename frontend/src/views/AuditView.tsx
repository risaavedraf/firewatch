import { useCallback, useEffect, useState } from 'react';

import { idleCopy } from '../app/sessionCopy';
import { PanelHeading, TableWrap } from '../components/ui';
import { useSessionState } from '../app/store';
import { audit, type Outcome } from '../core/api';
import type { SessionState } from '../core/session';
import type { AuditEntry } from '../types/api';

// N8b — the activity register (S13/S17/S1/S2). `/v1/audit` is admin-only and
// accepts no parameter: the service bounds the answer itself, so the panel sends
// no limit or offset and never pages. Every entry is rendered with the durable
// fields the endpoint carries — `event_id`, `actor_id`, `actor_name`, `action`,
// `event_kind`, `detail`, `job_id`, `trace_id`, `occurred_at`. The actor column
// shows the verified display name when it was captured and falls back to the
// opaque `actor_id` otherwise; it never synthesizes a name. `detail` and
// `job_id` are nullable, so a legacy row or a query without a job is labelled in
// place instead of being hidden or filled in from another field.
//
// The view is reachable for every role on purpose: the server decides, so a
// `viewer` must be able to arrive here and read its own explicit 403. There is no
// client-side role gating anywhere.

type AuditPhase = 'idle' | 'loading' | 'read' | 'denied' | 'unavailable';

interface RegisterState {
  phase: AuditPhase;
  badge: string;
  message: string;
  entries: readonly AuditEntry[];
  showTable: boolean;
}

// The view's own action phrase; the reason branch lives in `sessionCopy`.
const AUDIT_IDLE_ACTION = 'consultar el registro de actividad';

const IDLE_STATE: RegisterState = {
  phase: 'idle',
  badge: 'SIN CONSULTAR',
  message: idleCopy({ reason: null }, AUDIT_IDLE_ACTION),
  entries: [],
  showTable: false,
};

const LOADING_STATE: RegisterState = {
  phase: 'loading',
  badge: 'CONSULTANDO',
  message: 'Consultando el registro de actividad en /v1/audit…',
  entries: [],
  showTable: false,
};

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

// actorLabel is the honest presentation of provenance: the verified name when the
// service captured one, otherwise the opaque actor_id. It never derives a name
// from the id and never hides the row when neither exists.
function actorLabel(entry: AuditEntry): string {
  if (nonempty(entry.actor_name)) return entry.actor_name;
  if (nonempty(entry.actor_id)) return entry.actor_id;
  return 'No informado';
}

// kindLabel translates the closed contract vocabulary for the Spanish UI. The
// transport has already refused any value outside mutation/query.
function kindLabel(kind: AuditEntry['event_kind']): string {
  return kind === 'query' ? 'Consulta' : 'Mutación';
}

function shown(value: string | null | undefined): string {
  return nonempty(value) ? value : 'No informado';
}

// The transport already fails closed: an entry that does not state WHAT happened
// and WHEN never reaches this function. What is left is presentation, and every
// branch below states an outcome instead of hiding one.
function registerFromOutcome(outcome: Outcome<AuditEntry[]>): RegisterState {
  if (outcome.ok) {
    const entries = outcome.data;
    if (entries.length === 0) {
      return { phase: 'read', badge: 'LEÍDO', message: 'El servicio devolvió un registro de actividad sin eventos.', entries, showTable: false };
    }
    return {
      phase: 'read',
      badge: 'LEÍDO',
      message:
        'Registro real devuelto por /v1/audit. Es un endpoint de solo administradores y no acepta parámetros: el servicio acota la respuesta por sí mismo. Cada fila muestra su identificador de evento, el actor verificado y el detalle cuando existen.',
      entries,
      showTable: true,
    };
  }
  const { failure } = outcome;
  // A denied permission is a stated outcome, never a hidden panel: the 403 body
  // itself names the reason and the request.
  if (failure.kind === 'forbidden') {
    const code = nonempty(failure.reason) ? ` · ${failure.reason}` : '';
    const request = failure.requestId !== undefined ? ` · request_id ${failure.requestId}` : '';
    return {
      phase: 'denied',
      badge: 'SIN PERMISO',
      message: `La API denegó el permiso para consultar el registro de actividad (HTTP 403${code}${request}). Es un endpoint de solo administradores: solicita acceso a un administrador; la página no oculta ni simula los eventos.`,
      entries: [],
      showTable: false,
    };
  }
  if (failure.kind === 'malformed') {
    const code = nonempty(failure.reason) ? ` · ${failure.reason}` : '';
    return {
      phase: 'unavailable',
      badge: 'NO DISPONIBLE',
      message: `La API no devolvió un registro de actividad utilizable (HTTP ${failure.status ?? 200}${code}); no se muestran eventos inventados ni parciales.`,
      entries: [],
      showTable: false,
    };
  }
  return {
    phase: 'unavailable',
    badge: 'NO DISPONIBLE',
    message: 'No fue posible consultar el registro de actividad; se muestra como no disponible.',
    entries: [],
    showTable: false,
  };
}

function AuditRegister({ session }: { session: SessionState }) {
  const signedIn = session.status === 'signed-in';
  const [state, setState] = useState<RegisterState>(signedIn ? LOADING_STATE : IDLE_STATE);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    void (async () => {
      const outcome = await audit();
      // A reply that lands after the session closed must not repaint the panel:
      // the cleanup marks it fenced and it owns nothing.
      if (cancelled) return;
      setState(registerFromOutcome(outcome));
    })();
    return () => {
      cancelled = true;
    };
  }, [signedIn, revision]);

  const refresh = useCallback((): void => {
    setState(LOADING_STATE);
    setRevision(value => value + 1);
  }, []);

  const count = state.phase === 'read' ? String(state.entries.length) : '—';
  const disabled = !signedIn || state.phase === 'loading';
  // The idle sentence is recomputed from the session, so a reason that changes
  // while no register is open is named instead of showing a stale first-visit copy.
  const message = state.phase === 'idle' ? idleCopy(session, AUDIT_IDLE_ACTION) : state.message;

  return (
    <section className="view" id="audit" data-view="audit" aria-labelledby="audit-title">
      <article className="panel audit-panel">
        <PanelHeading
          eyebrow="COORDINACIÓN"
          title="Registro de actividad"
          titleId="audit-title"
          level={2}
          badge={
            <span className="neutral-tag" id="audit-badge">
              {state.badge}
            </span>
          }
        />
        <p
          id="audit-status"
          className={state.phase === 'read' ? 'status-copy risk-good' : 'status-copy'}
          role="status"
          aria-live="polite"
        >
          {message}
        </p>
        <p className="panel-note">
          Endpoint de solo administradores. No acepta parámetros: el servicio acota la respuesta por sí mismo (hasta 100
          eventos recientes) y esta página no pagina, no filtra ni ordena. El nombre del actor proviene de la identidad
          verificada; cuando el registro no lo capturó, se muestra el <code>actor_id</code> sin inventar un nombre.
        </p>
        <TableWrap label="Eventos del registro de actividad" id="audit-table" hidden={!state.showTable}>
          <table>
            <caption className="sr-only">Registro de actividad devuelto por /v1/audit</caption>
            <thead>
              <tr>
                <th scope="col">Evento (event_id)</th>
                <th scope="col">Actor (nombre o actor_id)</th>
                <th scope="col">Acción</th>
                <th scope="col">Tipo</th>
                <th scope="col">Detalle</th>
                <th scope="col">Trabajo (job_id)</th>
                <th scope="col">Traza (trace_id)</th>
                <th scope="col">Ocurrido (occurred_at)</th>
              </tr>
            </thead>
            <tbody id="audit-rows">
              {state.entries.map(entry => (
                // The service owns the stable per-row event id, so it is the key;
                // the row position is no longer the only honest identifier.
                <tr key={entry.event_id}>
                  <td>{shown(entry.event_id)}</td>
                  <td>{actorLabel(entry)}</td>
                  <td>{shown(entry.action)}</td>
                  <td>{kindLabel(entry.event_kind)}</td>
                  <td>{shown(entry.detail)}</td>
                  <td>{shown(entry.job_id)}</td>
                  <td>{shown(entry.trace_id)}</td>
                  <td>{shown(entry.occurred_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
        <div className="audit-foot">
          <span className="count-badge" id="audit-count">
            {count}
          </span>
          <button id="audit-refresh" className="secondary-button" type="button" disabled={disabled} onClick={refresh}>
            Actualizar registro
          </button>
        </div>
      </article>
    </section>
  );
}

export function AuditView() {
  const session = useSessionState();
  const signedIn = session.status === 'signed-in';
  // The register is keyed to the session phase so a closed session remounts it
  // empty instead of painting the previous session's rows for a frame.
  return <AuditRegister key={signedIn ? 'open' : 'closed'} session={session} />;
}
