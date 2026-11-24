import { useEffect, useRef, useState, type FormEvent } from 'react';

import { useSessionState } from '../app/store';
import { adoptObservation, preventiveActions, type Failure, type Outcome } from '../core/api';
import { getAccessToken, getSessionSnapshot, subscribeSession } from '../core/session';
import { actionStatusLabel } from '../domain/prevention';
import type { Observation, PreventiveAction } from '../types/api';

// PM-10 / S4 — the one authorized link of the decision log, inside the PM-09
// observation screen (`odd/tasks/pm-10-decision-log.md`, S4 + L3).
//
// Four properties travel with this code:
//   1. the confirmation is EXPLICIT: a chosen existing action is not enough, the
//      person has to state that the observation justifies the work and that it is
//      still needed. Only then can the link be requested;
//   2. the link is not an assignment: this operation never assigns personnel,
//      never moves the action, never marks it finished and never reviews
//      evidence. The copy says so, and no control here can do any of it;
//   3. the candidate actions are READ ON DEMAND from the existing list endpoint:
//      the panel mounts only when the operator asks for it, so opening the
//      observations screen reads no action list at all;
//   4. what is displayed afterwards is what the SERVICE returned. The stored link
//      arrives as the operation's answer and again on the re-read list, and a
//      cancelled action is not offered as a new candidate — the server refuses a
//      fresh link to it — while an existing link stays visible as the historical
//      record it is.

const CANDIDATES_ACTION = 'consultar los trabajos preventivos existentes';
const ADOPT_ACTION = 'registrar el vínculo de la observación';

// The one status the service refuses for a FRESH link. Naming it is an
// affordance, not an authority: the server still decides, and its refusal is
// rendered as the answer if the two ever disagree.
const CANCELLED_STATUS = 'cancelada';

type Phase = 'loading' | 'read' | 'denied' | 'unavailable';

interface CandidatesState {
  phase: Phase;
  message: string;
  actions: readonly PreventiveAction[];
}

const LOADING_CANDIDATES: CandidatesState = {
  phase: 'loading',
  message: 'Consultando los trabajos preventivos existentes en /v1/prevention/actions…',
  actions: [],
};

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

// One builder for every refusal, so the candidate read and the link request both
// name the HTTP status, the server `code` and the `request_id` when they have one.
function failureMessage(failure: Failure, action: string): string {
  const status = failure.status !== undefined ? `HTTP ${failure.status}` : 'sin conexión';
  const code = nonempty(failure.reason) && failure.reason !== `http_${failure.status}` ? ` · ${failure.reason}` : '';
  const request = failure.requestId !== undefined ? ` · request_id ${failure.requestId}` : '';
  const detail = `${status}${code}${request}`;
  switch (failure.reason) {
    case 'invalid_adoption_request':
      return `La API rechazó la solicitud de vínculo (${detail}); el cuerpo solo puede llevar un trabajo preventivo existente.`;
    case 'action_not_found':
      return `El trabajo preventivo elegido no existe en el servicio (${detail}). Elige uno de la lista devuelta.`;
    case 'action_cancelled':
      return `El trabajo preventivo elegido está cancelado (${detail}); el servidor no admite un vínculo nuevo con él. Elige otro trabajo vigente.`;
    case 'observation_already_adopted':
      return `La observación ya tiene un vínculo registrado (${detail}); un vínculo distinto no reemplaza al primero.`;
    case 'observation_not_found':
      return `El servicio no encontró la observación consultada (${detail}).`;
    case 'storage_unavailable':
      return `El almacenamiento de prevención no está disponible (${detail}).`;
    default:
      break;
  }
  if (failure.kind === 'forbidden') {
    return `La API denegó el permiso para ${action} (${detail}). El servidor decide los permisos; solicita acceso a un administrador.`;
  }
  if (failure.kind === 'unauthorized') {
    return `La API rechazó el token (${detail}). La sesión se cerró; conecta nuevamente un token autorizado.`;
  }
  if (failure.kind === 'missing') {
    return `La API no encontró el recurso consultado (${detail}).`;
  }
  if (failure.kind === 'malformed') {
    return `La API no devolvió una respuesta utilizable (${detail}); no se muestran valores parciales ni inventados.`;
  }
  return `No se pudo ${action} (${detail}).`;
}

// The option label is built only from fields the service served: its title, its
// own status label and nothing invented. A title-less action never reaches this
// point, because the transport refuses one.
function actionOptionLabel(action: PreventiveAction, status: string): string {
  return `${action.title} · ${status}`;
}

// The real non-cancelled actions of the service answer, in the order it sent them.
function linkable(actions: readonly PreventiveAction[]): PreventiveAction[] {
  return actions.filter(action => action.status !== CANCELLED_STATUS);
}

function candidatesFromOutcome(outcome: Outcome<PreventiveAction[]>): CandidatesState {
  if (outcome.ok) {
    if (outcome.data.length === 0) {
      return {
        phase: 'read',
        message: 'El servicio no devolvió trabajos preventivos: todavía no hay ninguno para vincular.',
        actions: [],
      };
    }
    const actions = linkable(outcome.data);
    if (actions.length === 0) {
      return {
        phase: 'read',
        message: 'El servicio solo devolvió trabajos cancelados; el servidor no admite un vínculo nuevo con ellos.',
        actions: [],
      };
    }
    return {
      phase: 'read',
      message: `El servicio devolvió ${actions.length} ${actions.length === 1 ? 'trabajo preventivo vigente' : 'trabajos preventivos vigentes'} para vincular.`,
      actions,
    };
  }
  return {
    phase: outcome.failure.kind === 'forbidden' ? 'denied' : 'unavailable',
    message: failureMessage(outcome.failure, CANDIDATES_ACTION),
    actions: [],
  };
}

export interface ObservationAdoptionProps {
  readonly observation: Observation;
  // The declared-role affordance the parent already decided; the server decides
  // the permission and its refusal is rendered as the answer.
  readonly canConfirm: boolean;
  readonly onCancel: (showStoredLink?: boolean) => void;
  // The observation the service returned after storing the link, so the parent
  // re-reads the list instead of stitching a local row into it.
  readonly onLinked: (observation: Observation) => void;
}

export function ObservationAdoption({ observation, canConfirm, onCancel, onLinked }: ObservationAdoptionProps) {
  const session = useSessionState();
  const active = session.status === 'signed-in' && canConfirm;
  const id = observation.id;

  const [candidates, setCandidates] = useState<CandidatesState | null>(null);
  const [selectedActionId, setSelectedActionId] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [linked, setLinked] = useState<Observation | null>(null);
  const [retryRevision, setRetryRevision] = useState(0);
  const selectRef = useRef<HTMLSelectElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const pendingWrite = useRef<AbortController | null>(null);
  const cancelRef = useRef(onCancel);
  const linkedRef = useRef(onLinked);

  useEffect(() => {
    cancelRef.current = onCancel;
    linkedRef.current = onLinked;
  }, [onCancel, onLinked]);

  // The candidate actions are read when this panel opens (it only mounts on
  // demand), and again after a retry. The read is fenced: a closed panel or a
  // replacement read cannot paint an older answer.
  useEffect(() => {
    if (!active) return undefined;
    const controller = new AbortController();
    let settled = true;
    void (async () => {
      const outcome = await preventiveActions({}, controller.signal);
      if (!settled) return;
      setCandidates(candidatesFromOutcome(outcome));
    })();
    return () => {
      settled = false;
      controller.abort();
    };
  }, [active, retryRevision]);

  // A closed session, or another session's token, ends this confirmation. The
  // candidate list, the choice and the explicit confirmation belong to the
  // session that opened them, and the panel closes instead of showing a stale
  // draft that could be submitted with the new token.
  useEffect(() => {
    const openedToken = getAccessToken();
    const unsubscribe = subscribeSession(() => {
      if (getSessionSnapshot().status === 'signed-in' && getAccessToken() === openedToken) return;
      pendingWrite.current?.abort();
      setCandidates(null);
      setSelectedActionId('');
      setConfirmed(false);
      setBusy(false);
      setNotice('');
      setLinked(null);
      cancelRef.current();
    });
    return () => {
      unsubscribe();
      pendingWrite.current?.abort();
    };
  }, []);

  // One focus anchor per state: the picker once the real actions land, and the
  // close control once the stored link is on screen. Both are native controls, so
  // the visible focus ring is the one the page already uses.
  useEffect(() => {
    if (candidates === null || candidates.phase !== 'read' || candidates.actions.length === 0) return;
    selectRef.current?.focus();
  }, [candidates]);

  useEffect(() => {
    if (linked === null) return;
    closeRef.current?.focus();
  }, [linked]);

  useEffect(() => {
    if (notice !== '' && !busy) selectRef.current?.focus();
  }, [notice, busy]);

  function retry(): void {
    setCandidates(null);
    setNotice('');
    setRetryRevision(value => value + 1);
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!active || pendingWrite.current !== null || linked !== null) return;
    if (selectedActionId === '' || !confirmed) {
      setNotice('Elige un trabajo preventivo de la lista y marca la confirmación antes de registrar el vínculo.');
      return;
    }
    const controller = new AbortController();
    pendingWrite.current = controller;
    setBusy(true);
    setNotice('');
    void (async () => {
      const outcome = await adoptObservation(observation.id, selectedActionId, controller.signal);
      pendingWrite.current = null;
      if (controller.signal.aborted) return;
      setBusy(false);
      if (!outcome.ok) {
        // Every choice stays in place: a refusal is not a reason to make the
        // operator pick the action and confirm it again.
        setNotice(failureMessage(outcome.failure, ADOPT_ACTION));
        return;
      }
      setLinked(outcome.data);
      linkedRef.current(outcome.data);
    })();
  }

  if (linked !== null) {
    return (
      <div
        className="observation-adoption"
        id={`observation-adoption-${id}`}
        data-observation-id={id}
        aria-label={`Vínculo registrado de la observación ${id}`}
      >
        <h4 className="observation-adoption-title" id={`observation-adoption-title-${id}`}>
          Vínculo registrado por el servicio
        </h4>
        <p className="observation-adoption-result" id={`observation-adoption-linked-${id}`} role="status" aria-live="polite">
          La observación {linked.id} quedó asociada al trabajo preventivo {linked.adopted_action_id}. No se asignó a
          ninguna persona y el estado del trabajo no cambió; el servidor guardó la confirmación con el actor del token
          verificado.
        </p>
        <div className="observation-adoption-actions">
          <button
            ref={closeRef}
            id={`observation-adoption-close-${id}`}
            className="secondary-button"
            type="button"
            onClick={() => cancelRef.current(true)}
          >
            Cerrar
          </button>
        </div>
      </div>
    );
  }

  const state = candidates ?? LOADING_CANDIDATES;
  // No linkable action means nothing to choose: the submit stays disabled and the
  // service's own message explains why (no actions, only cancelled ones, or a
  // refused read).
  const noCandidates = state.actions.length === 0;
  const retryable = state.phase === 'unavailable' || state.phase === 'denied';

  return (
    <form
      className="observation-adoption"
      id={`observation-adoption-${id}`}
      data-observation-id={id}
      aria-labelledby={`observation-adoption-title-${id}`}
      onSubmit={submit}
    >
      <h4 className="observation-adoption-title" id={`observation-adoption-title-${id}`}>
        Confirmar que el trabajo se necesita
      </h4>
      <p className="observation-adoption-effect" id={`observation-adoption-effect-${id}`}>
        Este vínculo deja registrado que la observación respalda un trabajo preventivo que ya existe. No asigna a
        ninguna persona, no cambia el estado del trabajo, no lo marca como terminado y no revisa evidencia. El servidor
        toma el actor del token verificado y decide el permiso.
      </p>
      <p
        className="observation-adoption-candidates"
        id={`observation-adoption-candidates-${id}`}
        role="status"
        aria-live="polite"
      >
        {state.message}
      </p>
      {retryable ? (
        <button
          id={`observation-adoption-retry-${id}`}
          className="secondary-button"
          type="button"
          onClick={retry}
        >
          Reintentar trabajos preventivos
        </button>
      ) : null}

      <div className="field">
        <label htmlFor={`observation-adoption-action-${id}`}>Trabajo preventivo existente</label>
        <select
          ref={selectRef}
          id={`observation-adoption-action-${id}`}
          value={selectedActionId}
          disabled={busy || noCandidates || state.phase !== 'read'}
          aria-describedby={`observation-adoption-action-note-${id}`}
          onChange={event => {
            setSelectedActionId(event.target.value);
            setConfirmed(false);
            setNotice('');
          }}
        >
          <option value="">Selecciona un trabajo preventivo del servicio</option>
          {state.actions.map(action => (
            <option key={action.id} value={action.id}>
              {actionOptionLabel(action, actionStatusLabel(action.status))}
            </option>
          ))}
        </select>
        <p className="field-note" id={`observation-adoption-action-note-${id}`}>
          La lista viene de <code>/v1/prevention/actions</code> y se lee al abrir esta confirmación. Los trabajos
          cancelados no se ofrecen: el servidor no admite un vínculo nuevo con ellos.
        </p>
      </div>

      <div className="observation-adoption-confirm">
        <input
          id={`observation-adoption-confirm-${id}`}
          type="checkbox"
          checked={confirmed}
          disabled={busy || selectedActionId === ''}
          onChange={event => setConfirmed(event.target.checked)}
        />
        <label htmlFor={`observation-adoption-confirm-${id}`}>
          Confirmo que la observación respalda el trabajo elegido y que el trabajo todavía se necesita
        </label>
      </div>

      <div className="observation-adoption-actions">
        <button
          id={`observation-adoption-submit-${id}`}
          className="primary-button"
          type="submit"
          disabled={busy || noCandidates || selectedActionId === '' || !confirmed}
        >
          {busy ? 'Registrando…' : 'Registrar vínculo'}
        </button>
        <button
          id={`observation-adoption-cancel-${id}`}
          className="secondary-button"
          type="button"
          disabled={busy}
          onClick={() => cancelRef.current()}
        >
          Cancelar
        </button>
      </div>

      <p id={`observation-adoption-feedback-${id}`} className="status-copy" role="status" aria-live="polite">
        {notice}
      </p>
    </form>
  );
}
