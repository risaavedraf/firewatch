import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';

import { idleCopy } from '../app/sessionCopy';
import { useSessionState } from '../app/store';
import { PanelHeading, StatusCopy } from '../components/ui';
import { timing } from '../config';
import {
  createJob,
  createPreventiveAction,
  job as readJob,
  linkPreventiveReassessment,
  preventiveAction,
  preventiveActions,
  recordPreventiveEvidence,
  reviewPreventiveEvidence,
  scenarios,
  transitionPreventiveAction,
  users as readUsers,
  isConfirmedWriteRefusal,
  type DirectoryUser,
  type Failure,
  type Outcome,
} from '../core/api';
import {
  getSessionGeneration,
  getSessionSnapshot,
  subscribeSession,
  subscribeSessionGeneration,
} from '../core/session';
import {
  actionStatusLabel,
  assigneeLabel,
  declaresAdminRole,
  evidenceDecisionLabel,
  isEvidenceReference,
  parseEvidenceReferences,
  REASSESSMENT_DISCLAIMER,
  sufficiencyCopy,
  transitionAffordances,
} from '../domain';
import type { PreventiveAction, PreventiveActionDetail, Scenario } from '../types/api';

// S3 / T12 — the preventive-action view, built against the frozen contract in
// `odd/tasks/presentation-client-ready.md` §«Contrato congelado de prevention».
//
// Four rules travel with this code:
//   1. the LIST, the DETAIL with its history, the CREATION and the TRANSITIONS
//      are the four routes of the contract, and nothing is simulated: a refusal
//      (401/403/409/422) is rendered with the code and the `request_id` the
//      server sent;
//   2. the transitions offered are the valid successors of the current status
//      (`domain/prevention.ts`). The map is a transcription, so a server
//      `409 invalid_transition` is still rendered when the two disagree;
//   3. the role that enables them is the role the UNVERIFIED token declares. It
//      is an affordance, never an authorization: the server remains the only
//      authority, and the reason is stated on screen;
//   4. a closed session — by logout or by a refused token — empties the private
//      view; a 401 keeps the `request_id` on screen because that is the evidence
//      the operator needs to report it.

type Phase = 'unconsulted' | 'loading' | 'read' | 'denied' | 'unavailable';

interface ListState {
  phase: Phase;
  badge: string;
  message: string;
  actions: readonly PreventiveAction[];
}

interface DetailState {
  phase: 'loading' | 'read' | 'refused' | 'unavailable';
  message: string;
  action: PreventiveActionDetail | null;
}

const IDLE_LIST: ListState = {
  phase: 'unconsulted',
  badge: 'SIN CONSULTAR',
  message: 'Conecta un token autorizado para consultar las acciones preventivas.',
  actions: [],
};

const LIST_ACTION = 'listar las acciones preventivas';
const CREATE_ACTION = 'crear la acción preventiva';
const DIRECTORY_ACTION = 'leer el directorio de usuarios';
const DETAIL_ACTION = 'consultar el detalle de la acción';
const TRANSITION_ACTION = 'aplicar la transición';
const EVIDENCE_ACTION = 'registrar la evidencia';
const REVIEW_ACTION = 'registrar la revisión de suficiencia';
const REASSESS_ACTION = 'vincular la reevaluación sintética';

interface FormState {
  communityCode: string;
  title: string;
  description: string;
  priority: string;
  // The directory reference of a NEW assignment (V1-U-04). Empty means the
  // action is created unassigned, which the contract accepts.
  assigneeId: string;
  dueDate: string;
}

const EMPTY_FORM: FormState = {
  communityCode: '',
  title: '',
  description: '',
  priority: '',
  assigneeId: '',
  dueDate: '',
};

// V1-U-04 — the realm's user directory, read by the AUTHORIZED create UI only.
//
// `unloaded` is also "a read is in flight or was never allowed": the selector
// keeps its single unassigned option either way, and the copy states which of
// the two it is. A failed read keeps its server message (status, code and
// request id) and offers a retry; it never leaves a previously read list on
// screen, because a list the server did not just serve is not a list.
type DirectoryPhase = 'unloaded' | 'read' | 'failed';

interface DirectoryState {
  phase: DirectoryPhase;
  users: readonly DirectoryUser[];
  message: string;
}

const UNLOADED_DIRECTORY: DirectoryState = { phase: 'unloaded', users: [], message: '' };

// The one option that is always offered: creating an action without a
// responsible is valid and is not a failure state.
const UNASSIGNED_OPTION = 'Sin asignar (se crea sin responsable)';

const DIRECTORY_READING = 'Leyendo el directorio de usuarios del realm…';

// The words that accompany the assignee selector: what was read, what the write
// will mean, and what the operator can still do when the directory could not be
// read at all. It lives outside the component so the rendering branch stays one
// expression, and it never names a user the directory did not serve.
function assigneeStatusCopy(
  signedIn: boolean,
  admin: boolean,
  directory: DirectoryState,
  selected: DirectoryUser | null,
): string {
  if (!signedIn || !admin) {
    return 'El selector de responsable se llena con el directorio de usuarios del realm, que exige una sesión autorizada; esta sesión crea la acción sin responsable y el servidor decide la asignación.';
  }
  if (directory.phase === 'failed') {
    return `${directory.message} Puedes crear la acción sin responsable o reintentar la lectura; no se inventó ninguna persona ni ningún identificador.`;
  }
  if (directory.phase !== 'read') return DIRECTORY_READING;
  if (directory.users.length === 0) {
    return 'El directorio del realm no tiene usuarios: la acción se crea sin responsable.';
  }
  if (selected !== null) {
    return `Se asignaría a ${selected.display_name} (${selected.id}). El servidor resuelve el identificador antes de guardar; si el directorio no lo reconoce, rechaza el alta y no se crea nada.`;
  }
  return `Directorio leído: ${directory.users.length} usuario(s) del realm. Elige un responsable o deja «Sin asignar»; el servidor resuelve el identificador antes de guardar.`;
}

// The synthetic-reassessment cycle the view renders. A job is requested through
// the existing authenticated submission, polled with the same bounded timing, and
// only a REAL published batch is linked. A failure keeps the job id so the link
// can be retried without requesting a second job, and the view never claims an
// association the server did not confirm. `actionId` is the action that
// originated the cycle: the cycle is local observation only and belongs to that
// action, so it is cleared when another action is selected and can never be
// retried or rendered against that other action.
type ReassessmentPhase = 'idle' | 'submitting' | 'polling' | 'linking' | 'linked' | 'failed';

interface ReassessmentState {
  phase: ReassessmentPhase;
  message: string;
  jobId: string;
  actionId: string;
  retryable: boolean;
}

const IDLE_REASSESSMENT: ReassessmentState = {
  phase: 'idle',
  message: '',
  jobId: '',
  actionId: '',
  retryable: false,
};

// A 128-bit key from the platform CSPRNG, sent as the Idempotency-Key. It avoids
// `crypto.randomUUID` so the same helper works under the test crypto stub.
function idempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

// A failed create is one of two different facts, and the page may not report one
// as the other:
//   · a refusal the contract PROVES stored nothing (401/403, 429, 415, 422
//     `invalid_action_request`/`assignee_not_found`, the directory's own
//     503/502, 503 `storage_unavailable`) — "no se creó" is true there;
//   · an outcome this page cannot determine (no response, a deadline, an aborted
//     or superseded request, an unusable 2xx body, a gateway 502 `upstream_unavailable`)
//     — the write may have happened, so claiming it did not is false, and inviting
//     a blind retry could duplicate the action.
// The second names what is unknown and the check to perform instead.
function createFailureNotice(failure: Failure): string {
  const detail = failureMessage(failure, CREATE_ACTION);
  if (isConfirmedWriteRefusal(failure)) return `${detail} No se creó ninguna acción.`;
  return `${detail} No se pudo confirmar si el servidor guardó la acción: la respuesta no llegó a completarse o no es utilizable. Actualiza la lista con «Actualizar lista» antes de volver a enviar el formulario, porque un segundo envío podría duplicarla.`;
}

// One message builder for every refusal, so the list, the detail, the creation
// and the transition all name the HTTP status, the server `code` and the
// `request_id` when they have one. Nothing is swallowed into a generic failure.
function failureMessage(failure: Failure, action: string): string {
  const status = failure.status !== undefined ? `HTTP ${failure.status}` : 'sin conexión';
  const code = nonempty(failure.reason) && failure.reason !== `http_${failure.status}` ? ` · ${failure.reason}` : '';
  const request = failure.requestId !== undefined ? ` · request_id ${failure.requestId}` : '';
  const detail = `${status}${code}${request}`;
  // The frozen error vocabulary of the service, named explicitly so a refusal
  // never reads as a generic failure.
  switch (failure.reason) {
    case 'invalid_transition':
      return `La API rechazó la transición (${detail}). La acción no cambió de estado.`;
    case 'insufficient_evidence':
      return `La API rechazó la transición (${detail}): la evidencia vigente no tiene una revisión humana suficiente. La acción no cambió de estado ni de historial.`;
    case 'stale_evidence':
      return `La API rechazó la revisión (${detail}): la instantánea de evidencia dejó de ser la vigente. Revisa la evidencia actual antes de decidir.`;
    case 'invalid_evidence_state':
      return `La API rechazó la escritura de evidencia (${detail}): la acción es terminal y su evidencia quedó congelada.`;
    case 'evidence_not_found':
      return `La API no encontró la instantánea de evidencia (${detail}).`;
    case 'invalid_evidence_id':
      return `El identificador de la instantánea de evidencia no es válido (${detail}).`;
    case 'invalid_evidence_request':
      return `La API rechazó la evidencia (${detail}); el criterio debe ser no vacío y cada referencia una URL http o https sin credenciales.`;
    case 'invalid_review_request':
      return `La API rechazó la revisión (${detail}); la decisión debe ser suficiente o insuficiente.`;
    case 'invalid_reassessment_request':
      return `La API rechazó la reevaluación (${detail}); solo se envía el job_id que produjo el servidor.`;
    case 'reassessment_unavailable':
      return `La API aún no encuentra un lote publicado para el trabajo (${detail}). Puedes reintentar la vinculación; no se registró ninguna asociación.`;
    case 'reassessment_not_synthetic':
      return `La API rechazó la vinculación (${detail}): el lote no es una clasificación sintética y esta función solo admite reevaluaciones sintéticas.`;
    case 'reassessment_commune_mismatch':
      return `La API rechazó la vinculación (${detail}): el lote pertenece a otra comunidad.`;
    case 'reassessment_not_new':
      return `La API rechazó la vinculación (${detail}): el lote es anterior a la evidencia o a su última revisión, así que no puede presentarse como posterior.`;
    case 'reassessment_already_linked':
      return `La API rechazó la vinculación (${detail}): ese trabajo ya está vinculado.`;
    case 'invalid_transition_request':
      return `La API rechazó la transición (${detail}): el estado destino no está declarado por el contrato. La acción no cambió de estado.`;
    case 'invalid_action_request':
      return `La API rechazó la acción (${detail}); revisa community_code y title, que son los únicos campos requeridos.`;
    case 'assignee_not_found':
      return `La API rechazó la asignación (${detail}): el identificador no existe en el directorio del realm.`;
    case 'directory_unavailable':
      return `El directorio de usuarios del realm no está disponible o no está configurado (${detail}).`;
    case 'directory_upstream_failed':
      return `El proveedor de identidad no respondió correctamente al leer el directorio de usuarios (${detail}).`;
    case 'invalid_query':
      return `La API rechazó el filtro (${detail}); revisa los valores de comunidad y estado.`;
    case 'action_not_found':
      return `La acción consultada no existe (${detail}).`;
    case 'invalid_action_id':
      return `El identificador de la acción no es válido (${detail}).`;
    case 'storage_unavailable':
      return `El almacenamiento de prevención no está disponible (${detail}).`;
    case 'json_required':
      return `La API exige un cuerpo JSON (${detail}).`;
    default:
      break;
  }
  if (failure.kind === 'forbidden') {
    return `La API denegó el permiso para ${action} (${detail}). Solicita acceso a un administrador.`;
  }
  if (failure.kind === 'unauthorized') {
    return `La API rechazó el token (${detail}). La sesión se cerró; conecta nuevamente un token autorizado.`;
  }
  if (failure.status === 409) {
    return `La API rechazó la transición (${detail}). La acción no cambió de estado.`;
  }
  if (failure.status === 422) {
    return `La API rechazó la entrada (${detail}); revisa los campos requeridos.`;
  }
  if (failure.kind === 'missing') {
    return `La acción consultada no existe o no está disponible (${detail}).`;
  }
  if (failure.kind === 'malformed') {
    return `La API no devolvió una respuesta utilizable (${detail}); no se muestran valores parciales ni inventados.`;
  }
  return `No se pudo ${action} (${detail}).`;
}

function listFromOutcome(outcome: Outcome<PreventiveAction[]>): ListState {
  if (outcome.ok) {
    if (outcome.data.length === 0) {
      return {
        phase: 'read',
        badge: 'LEÍDO',
        message: 'El servicio no devolvió acciones preventivas para el filtro elegido.',
        actions: [],
      };
    }
    return {
      phase: 'read',
      badge: 'LEÍDO',
      message: `Acciones preventivas devueltas por /v1/prevention/actions (${outcome.data.length}).`,
      actions: outcome.data,
    };
  }
  const { failure } = outcome;
  if (failure.kind === 'forbidden') {
    return { phase: 'denied', badge: 'SIN PERMISO', message: failureMessage(failure, LIST_ACTION), actions: [] };
  }
  return { phase: 'unavailable', badge: 'NO DISPONIBLE', message: failureMessage(failure, LIST_ACTION), actions: [] };
}

function detailFromOutcome(outcome: Outcome<PreventiveActionDetail>): DetailState {
  if (outcome.ok) {
    return {
      phase: 'read',
      message: `Detalle e historial devueltos por /v1/prevention/actions/{id}; ${outcome.data.history.length} movimiento(s) de historial.`,
      action: outcome.data,
    };
  }
  const { failure } = outcome;
  return {
    phase: failure.kind === 'forbidden' ? 'refused' : 'unavailable',
    message: failureMessage(failure, DETAIL_ACTION),
    action: null,
  };
}

function field(value: string | null | undefined): string {
  return nonempty(value) ? value : 'No informado';
}

function historyMove(fromStatus: string | null | undefined, toStatus: string): string {
  return `${nonempty(fromStatus) ? fromStatus : '—'} → ${toStatus}`;
}

export function ActionsView() {
  const session = useSessionState();
  const signedIn = session.status === 'signed-in';
  // The role is a token FACT, read without verifying the signature. It only
  // decides which affordances this page shows; the server decides the action.
  const admin = signedIn && declaresAdminRole(session.roles);
  // The session INSTANCE, as a non-secret generation. The declared roles cannot
  // describe a replacement that keeps them, so the directory state of this page and
  // the ownership of an in-flight directory read are keyed on this, never on
  // `session.roles` or on the public snapshot.
  const sessionGeneration = useSyncExternalStore(
    subscribeSessionGeneration,
    getSessionGeneration,
    getSessionGeneration,
  );

  const [list, setList] = useState<ListState>(IDLE_LIST);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [transitionNote, setTransitionNote] = useState('');
  const [communityFilter, setCommunityFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [applied, setApplied] = useState<{ communityCode: string; status: string }>({ communityCode: '', status: '' });
  const [revision, setRevision] = useState(0);
  const [detailRevision, setDetailRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  // The create's own pending state, tagged with the session instance that owns it.
  // It is deliberately separate from `busy`: a session replacement releases ONLY an
  // owned create, whose completion is already fenced, while a transition, evidence
  // write, review or reassessment keeps the shared interlock until it completes.
  // Releasing that would let two writes to the same action overlap, which is what
  // the interlock exists to prevent.
  const [createPending, setCreatePending] = useState<number | null>(null);
  // What every mutation control reads: a pending create OR a pending sibling write,
  // so the two kinds still interlock with each other exactly as before.
  const writePending = busy || createPending !== null;
  const [evidenceCriterion, setEvidenceCriterion] = useState('');
  const [evidenceReferences, setEvidenceReferences] = useState('');
  const [reviewNote, setReviewNote] = useState('');
  const [catalogue, setCatalogue] = useState<readonly Scenario[] | null>(null);
  const [scenarioId, setScenarioId] = useState('');
  const [reassessment, setReassessment] = useState<ReassessmentState>(IDLE_REASSESSMENT);
  // The realm directory of the create form, the retry counter that re-reads it,
  // and the rendering fence that keeps a late answer from a previous read out.
  const [directoryState, setDirectoryState] = useState<DirectoryState>(UNLOADED_DIRECTORY);
  const [directoryRevision, setDirectoryRevision] = useState(0);

  // The reassessment cycle is fenced by a sequence number, one abortable
  // controller and the originating action id, so an answer for a previous action
  // or a closed session can never overwrite the current state.
  const mountedRef = useRef(true);
  const reassessmentSequence = useRef(0);
  const reassessmentController = useRef<AbortController | null>(null);
  // The action that owns the in-flight cycle, and the action currently selected.
  // The refs are read from async callbacks, where the rendered state is stale.
  const reassessmentAction = useRef('');
  const selectedIdRef = useRef(selectedId);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      reassessmentSequence.current += 1;
      reassessmentController.current?.abort();
    };
  }, []);

  // Selecting another action clears the local reassessment cycle and fences its
  // late callbacks. This is local observation only: it never cancels the server
  // job or the link already requested for the originating action. The cycle is
  // not restored when the user returns to that action, exactly because it was
  // never a server guarantee; the detail will show whatever the server linked.
  useEffect(() => {
    selectedIdRef.current = selectedId;
    if (reassessmentAction.current === '' || reassessmentAction.current === selectedId) return;
    reassessmentSequence.current += 1;
    reassessmentController.current?.abort();
    reassessmentController.current = null;
    reassessmentAction.current = '';
    setReassessment(IDLE_REASSESSMENT);
  }, [selectedId]);

  // The list, re-read on every session, filter and revision change. A refused
  // token closes the session from inside the transport, so the refusal is
  // captured even though this effect's cleanup has already fenced the answer:
  // the request id is the evidence the operator needs.
  useEffect(() => {
    if (!signedIn) return undefined;
    const controller = new AbortController();
    let active = true;
    void (async () => {
      const outcome = await preventiveActions(applied, controller.signal);
      if (!active) {
        if (!outcome.ok && outcome.failure.kind === 'unauthorized') {
          setNotice(failureMessage(outcome.failure, LIST_ACTION));
        }
        return;
      }
      setList(listFromOutcome(outcome));
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [signedIn, revision, applied]);

  // The detail is authored by the server (including its history), so it is
  // re-read after a transition instead of being patched locally.
  useEffect(() => {
    if (!signedIn || selectedId === '') return undefined;
    const controller = new AbortController();
    let active = true;
    void (async () => {
      const outcome = await preventiveAction(selectedId, controller.signal);
      if (!active) {
        if (!outcome.ok && outcome.failure.kind === 'unauthorized') {
          setNotice(failureMessage(outcome.failure, DETAIL_ACTION));
        }
        return;
      }
      setDetail(detailFromOutcome(outcome));
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [signedIn, selectedId, detailRevision]);

  // Closing the session empties the private view. The reset runs from the session
  // subscription callback (not synchronously inside an effect body), the same
  // shape `JobsView` uses. A refused token keeps the notice — it carries the
  // request id — while an ordinary logout clears it.
  useEffect(
    () =>
      subscribeSession(() => {
        // The directory is authenticated data of ONE session. A session change
        // discards it, so no name read here is ever retained or shown under
        // another one — not in the selector and not in a row label.
        setDirectoryState(UNLOADED_DIRECTORY);
        if (getSessionSnapshot().status === 'signed-in') return;
        const reason = getSessionSnapshot().reason;
        reassessmentSequence.current += 1;
        reassessmentController.current?.abort();
        reassessmentController.current = null;
        reassessmentAction.current = '';
        setList(IDLE_LIST);
        setSelectedId('');
        setDetail(null);
        setForm(EMPTY_FORM);
        setTransitionNote('');
        setCommunityFilter('');
        setStatusFilter('');
        setApplied({ communityCode: '', status: '' });
        setBusy(false);
        setEvidenceCriterion('');
        setEvidenceReferences('');
        setReviewNote('');
        setCatalogue(null);
        setScenarioId('');
        setReassessment(IDLE_REASSESSMENT);
        if (reason !== 'rejected') setNotice('');
      }),
    [],
  );

  function reload(): void {
    setRevision(value => value + 1);
  }

  // The synthetic-scenario catalogue is fetched once per connection and is only
  // an optional convenience: an unavailable catalogue leaves the picker empty and
  // the request simply omits scenario_id, exactly like JobsView.
  useEffect(() => {
    if (!signedIn) return undefined;
    const controller = new AbortController();
    let active = true;
    void (async () => {
      const outcome = await scenarios(controller.signal);
      if (!active) return;
      setCatalogue(outcome.ok ? outcome.data : null);
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [signedIn]);

  // V1-U-04 — everything this page holds from the directory belongs to ONE session
  // instance: a bearer can be replaced while the declared roles stay identical, and
  // the public session snapshot cannot describe that. The reset runs from the
  // instance subscription (like the session subscription below), so a replacement
  // clears the previous instance's list and the reference the operator had chosen
  // before the read effect re-runs under the new bearer.
  useEffect(
    () =>
      subscribeSessionGeneration(() => {
        // A new instance owns this panel from here. The previous one's directory,
        // its chosen reference and its notice are that instance's: keeping any of
        // them would show a result this session never produced. Its CREATE is
        // released too, because that completion is fenced below. The shared `busy`
        // interlock is NOT touched: a transition, evidence write, review or
        // reassessment still belongs to the write that is running.
        setDirectoryState(UNLOADED_DIRECTORY);
        setForm(previous => (previous.assigneeId === '' ? previous : { ...previous, assigneeId: '' }));
        setCreatePending(null);
        setNotice('');
      }),
    [],
  );

  // V1-U-04 — the realm directory behind the assignee selector. It is read only
  // while the AUTHORIZED create UI is offered (a signed-in session whose token
  // declares admin); a viewer never asks for it, and the server remains the
  // authority on whether the read is allowed at all. A failed read is rendered
  // with its status, code and request id, keeps the unassigned option and offers
  // a retry; it never keeps the identifiers of a list the server did not just
  // serve.
  useEffect(() => {
    if (!signedIn || !admin) return undefined;
    const controller = new AbortController();
    const generation = sessionGeneration;
    let active = true;
    void (async () => {
      const outcome = await readUsers(controller.signal);
      // Ownership first, before any view effect: an answer produced for another
      // instance is not this panel's — not even a 401 refusal, whose notice would
      // otherwise outlive the session that issued the read. The session reset has
      // already published the closure and cleared this panel.
      if (!active || generation !== getSessionGeneration()) return;
      if (!outcome.ok) {
        if (outcome.failure.reason === 'superseded' || outcome.failure.reason === 'aborted') return;
        setDirectoryState({
          phase: 'failed',
          users: [],
          message: failureMessage(outcome.failure, DIRECTORY_ACTION),
        });
        // A reference the operator can no longer see must not be submitted.
        setForm(previous => (previous.assigneeId === '' ? previous : { ...previous, assigneeId: '' }));
        return;
      }
      setDirectoryState({ phase: 'read', users: outcome.data, message: '' });
      setForm(previous =>
        previous.assigneeId !== '' && !outcome.data.some(user => user.id === previous.assigneeId)
          ? { ...previous, assigneeId: '' }
          : previous,
      );
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [signedIn, admin, directoryRevision, sessionGeneration]);

  function applyFilters(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setApplied({ communityCode: communityFilter.trim(), status: statusFilter.trim() });
  }

  function openDetail(id: string): void {
    setNotice('');
    setTransitionNote('');
    setSelectedId(id);
  }

  function submitCreate(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!signedIn || writePending) return;
    // The reference, the reading it came from and the write itself belong to ONE
    // session instance. A submit that starts after the instance moved would send a
    // reference this instance never read, so nothing is sent: the instance reset
    // has already cleared the choice and is about to re-render the panel.
    if (sessionGeneration !== getSessionGeneration()) return;
    const generation = sessionGeneration;
    setCreatePending(generation);
    setNotice('');
    void (async () => {
      const outcome = await createPreventiveAction({
        communityCode: form.communityCode,
        title: form.title,
        description: form.description,
        priority: form.priority,
        assigneeId: form.assigneeId,
        dueDate: form.dueDate,
      });
      // Ownership: the completion of a write belongs to the instance that started
      // it. When that instance is gone this renders NOTHING — no notice (not even
      // a refusal, whose request id belongs to a closed session), no form reset, no
      // selection and no list refresh. The instance reset already released this
      // create; this answer has no part in the new instance's state.
      if (generation !== getSessionGeneration()) return;
      setCreatePending(null);
      if (!outcome.ok) {
        // The server also decides the assignment, and an undetermined response is
        // not a refusal: `createFailureNotice` states which of the two it is and
        // never claims a write that may have been stored.
        setNotice(createFailureNotice(outcome.failure));
        return;
      }
      setForm(EMPTY_FORM);
      setNotice(
        `Acción preventiva creada (${outcome.data.id}) en estado ${outcome.data.status}; la lista se vuelve a leer del servicio.`,
      );
      setSelectedId(outcome.data.id);
      reload();
    })();
  }

  function applyTransition(to: string): void {
    if (!signedIn || writePending || selectedId === '') return;
    setBusy(true);
    setNotice('');
    void (async () => {
      const outcome = await transitionPreventiveAction(selectedId, { to, note: transitionNote });
      setBusy(false);
      if (!outcome.ok) {
        setNotice(failureMessage(outcome.failure, TRANSITION_ACTION));
        return;
      }
      setNotice(`Transición aplicada: la acción quedó en estado ${outcome.data.status}.`);
      setTransitionNote('');
      setDetailRevision(value => value + 1);
      reload();
    })();
  }

  function submitEvidence(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!signedIn || !admin || writePending || selectedId === '') return;
    const criterion = evidenceCriterion.trim();
    const references = parseEvidenceReferences(evidenceReferences);
    if (criterion === '') {
      setNotice('Registra el criterio de suficiencia antes de guardar la evidencia.');
      return;
    }
    if (references.length === 0) {
      setNotice('Registra al menos un enlace de evidencia (una URL http o https por línea).');
      return;
    }
    const invalid = references.find(reference => !isEvidenceReference(reference));
    if (invalid !== undefined) {
      setNotice(
        `El enlace «${invalid}» no es una referencia válida: debe ser http o https, con host y sin credenciales incrustadas. El servidor lo revalidará.`,
      );
      return;
    }
    setBusy(true);
    setNotice('');
    void (async () => {
      const outcome = await recordPreventiveEvidence(selectedId, { criterion, references });
      setBusy(false);
      if (!outcome.ok) {
        setNotice(failureMessage(outcome.failure, EVIDENCE_ACTION));
        return;
      }
      setEvidenceCriterion('');
      setEvidenceReferences('');
      setReviewNote('');
      setNotice(
        `Evidencia registrada (instantánea ${outcome.data.id}). Una aprobación anterior queda obsoleta hasta que se revise esta instantánea.`,
      );
      setDetailRevision(value => value + 1);
      reload();
    })();
  }

  function submitReview(decision: 'suficiente' | 'insuficiente'): void {
    if (!signedIn || !admin || writePending || selectedId === '' || currentEvidence === null) return;
    setBusy(true);
    setNotice('');
    void (async () => {
      const outcome = await reviewPreventiveEvidence(selectedId, currentEvidence.id ?? 0, {
        decision,
        note: reviewNote,
      });
      setBusy(false);
      if (!outcome.ok) {
        setNotice(failureMessage(outcome.failure, REVIEW_ACTION));
        return;
      }
      setReviewNote('');
      setNotice(
        `Decisión registrada por el servidor: la evidencia vigente quedó como ${evidenceDecisionLabel(outcome.data.decision)}.`,
      );
      setDetailRevision(value => value + 1);
      reload();
    })();
  }

  async function linkReassessment(jobId: string, actionId: string, sequence: number): Promise<void> {
    setReassessment({
      phase: 'linking',
      message: 'Lote publicado; vinculando la reevaluación…',
      jobId,
      actionId,
      retryable: false,
    });
    const outcome = await linkPreventiveReassessment(actionId, { jobId });
    // The link belongs to the originating action and was already requested from
    // the server. Only its LOCAL observation is fenced: a late answer for another
    // action must not render here, and it must not refresh the newly selected
    // action's detail either.
    if (!mountedRef.current || sequence !== reassessmentSequence.current || reassessmentAction.current !== actionId) return;
    if (!outcome.ok) {
      setReassessment({ phase: 'failed', message: failureMessage(outcome.failure, REASSESS_ACTION), jobId, actionId, retryable: true });
      return;
    }
    setReassessment({
      phase: 'linked',
      message: `Reevaluación vinculada al lote ${outcome.data.batch_id} · versión ${outcome.data.version} · riesgo ${outcome.data.risk_level}.`,
      jobId,
      actionId,
      retryable: false,
    });
    // Refresh the detail only while the originating action is still the selected
    // one, so a late success never re-reads or repaints another action.
    if (selectedIdRef.current !== actionId) return;
    setDetailRevision(value => value + 1);
    reload();
  }

  async function trackReassessment(jobId: string, actionId: string): Promise<void> {
    const sequence = reassessmentSequence.current + 1;
    reassessmentSequence.current = sequence;
    reassessmentAction.current = actionId;
    const controller = new AbortController();
    reassessmentController.current = controller;
    const owns = (): boolean =>
      mountedRef.current && sequence === reassessmentSequence.current && reassessmentAction.current === actionId;
    setReassessment({
      phase: 'polling',
      message: 'Trabajo sintético solicitado; esperando a que el servidor publique el lote…',
      jobId,
      actionId,
      retryable: false,
    });
    for (let attempt = 0; attempt < timing.maxPollAttempts; attempt += 1) {
      const read = await readJob(jobId, controller.signal);
      if (!owns()) return;
      if (!read.ok) {
        if (read.failure.kind === 'unauthorized') return;
        setReassessment({ phase: 'failed', message: failureMessage(read.failure, REASSESS_ACTION), jobId, actionId, retryable: true });
        return;
      }
      if (read.data.state === 'published' && typeof read.data.batch_id === 'string' && read.data.batch_id !== '') {
        await linkReassessment(jobId, actionId, sequence);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, timing.pollIntervalMs));
    }
    if (!owns()) return;
    setReassessment({
      phase: 'failed',
      message:
        'El trabajo no publicó un lote dentro del plazo. Puedes reintentar la vinculación sin volver a solicitarlo; no se registró ninguna asociación.',
      jobId,
      actionId,
      retryable: true,
    });
  }

  function startReassessment(): void {
    if (!signedIn || !admin || writePending || selected === null) return;
    reassessmentController.current?.abort();
    const controller = new AbortController();
    reassessmentController.current = controller;
    const actionId = selected.id;
    const zoneId = selected.community_code;
    // The cycle is bound to the action selected at this instant. A later create
    // response is only observed while that same action still owns the cycle.
    reassessmentAction.current = actionId;
    setNotice('');
    setReassessment({
      phase: 'submitting',
      message: 'Solicitando un trabajo de riesgo sintético para la comunidad de la acción…',
      jobId: '',
      actionId,
      retryable: false,
    });
    void (async () => {
      const outcome = await createJob(
        { zoneId, scenarioId: scenarioId !== '' ? scenarioId : undefined, idempotencyKey: idempotencyKey() },
        controller.signal,
      );
      if (!mountedRef.current || reassessmentAction.current !== actionId) return;
      if (!outcome.ok) {
        setReassessment({ phase: 'failed', message: failureMessage(outcome.failure, REASSESS_ACTION), jobId: '', actionId, retryable: true });
        return;
      }
      await trackReassessment(outcome.data.id, actionId);
    })();
  }

  function retryReassessment(): void {
    if (!signedIn || !admin || selected === null) return;
    // The retry belongs to the action that started the cycle and must be the one
    // currently selected; a retained job is never sent to another action.
    const actionId = reassessment.actionId;
    if (actionId === '' || actionId !== selected.id) return;
    if (reassessment.jobId === '') {
      startReassessment();
      return;
    }
    reassessmentController.current?.abort();
    void trackReassessment(reassessment.jobId, selected.id);
  }

  // V1-U-04 — the names the directory actually served under this session, or
  // `null` when it has not been read (unauthorized, failed or still in flight).
  // The label rule keeps the reference or the legacy text in that case; no name
  // is composed from an identifier.
  const assigneeNames: ReadonlyMap<string, string> | null =
    directoryState.phase === 'read'
      ? new Map(directoryState.users.map(user => [user.id, user.display_name] as const))
      : null;
  const selectedDirectoryUser = directoryState.users.find(user => user.id === form.assigneeId) ?? null;
  // The honest companion of the control: the state in words, never a name the
  // directory did not serve.
  const assigneeStatus = assigneeStatusCopy(signedIn, admin, directoryState, selectedDirectoryUser);

  // Only the detail of the action currently selected is shown: a late answer for
  // a previous selection is a mismatch, not the new action's detail.
  const selected = detail !== null && detail.action !== null && detail.action.id === selectedId ? detail.action : null;
  const detailMessage =
    selectedId === ''
      ? ''
      : selected !== null
        ? detail?.message ?? ''
        : 'Consultando el detalle y el historial…';
  const transitions = selected === null ? [] : transitionAffordances(selected.status, session.roles, signedIn);
  // The S2 facts the detail route reports. `currentEvidence` is the newest
  // snapshot; the review controls act on exactly that one, never on an older one.
  const evidence = selected?.evidence ?? [];
  const currentEvidence = evidence.length > 0 ? evidence[evidence.length - 1] : null;
  const evidenceSufficient = selected?.evidence_sufficient === true;
  const acceptanceBlocked = !evidenceSufficient && transitions.some(item => item.to === 'aceptada');
  // The reassessment panel shows only the cycle that belongs to the selected
  // action. A cycle for another action is already cleared on selection, and this
  // binding makes the rendered state independent of that timing.
  const reassessmentForSelected =
    selected !== null && reassessment.actionId === selected.id ? reassessment : IDLE_REASSESSMENT;

  const roleNote = !signedIn
    ? 'Conecta una sesión para operar: la página no concede permisos.'
    : admin
      ? 'Tu token declara el rol admin, así que esta página ofrece el alta y las transiciones válidas de la máquina de estados. La firma del token no se verifica aquí: el servidor sigue siendo la única autoridad y su respuesta se muestra tal cual.'
      : session.roles === null
        ? 'Tu token no declara un rol utilizable, así que el alta y las transiciones quedan deshabilitadas. La página no supone ningún permiso: solicita un token con rol admin. El servidor es la única autoridad y una negativa se mostraría tal cual.'
        : 'Tu token no declara el rol admin, así que el alta y las transiciones quedan deshabilitadas en esta página. La página no concede permisos: solicita un token con rol admin. El servidor es la única autoridad y una negativa se mostraría tal cual.';

  return (
    <section className="view" id="actions" data-view="actions" aria-labelledby="actions-title">
      <article className="panel actions-panel">
        <PanelHeading
          eyebrow="PREVENCIÓN"
          title="Acciones preventivas"
          titleId="actions-title"
          level={2}
          badge={
            <span className="neutral-tag" id="actions-badge">
              {signedIn ? list.badge : 'SIN CONSULTAR'}
            </span>
          }
        />
        <p
          id="actions-status"
          className={list.phase === 'read' ? 'status-copy risk-good' : 'status-copy'}
          role="status"
          aria-live="polite"
        >
          {list.phase === 'unconsulted' ? idleCopy(session, LIST_ACTION) : list.message}
        </p>
        <p id="actions-role-note" className="panel-note">
          {roleNote}
        </p>
        <p id="actions-notice" className="status-copy" role="status" aria-live="polite">
          {notice}
        </p>
        <p className="panel-note">
          El servicio acota la lista a 200 filas y ambos filtros son opcionales: un filtro vacío no acota nada. La
          prioridad es texto libre validado por el servicio. El responsable se resuelve con el directorio de usuarios del
          realm cuando la sesión puede leerlo; el texto libre heredado se muestra tal como lo guardó el servicio.
        </p>

        <form className="filter-bar actions-filters" onSubmit={applyFilters}>
          <label className="filter-label" htmlFor="actions-community-filter">
            Comunidad (CUT)
            <input
              id="actions-community-filter"
              type="text"
              value={communityFilter}
              disabled={!signedIn}
              onChange={event => setCommunityFilter(event.target.value)}
            />
          </label>
          <label className="filter-label" htmlFor="actions-status-filter">
            Estado
            <select
              id="actions-status-filter"
              value={statusFilter}
              disabled={!signedIn}
              onChange={event => setStatusFilter(event.target.value)}
            >
              <option value="">Todos</option>
              <option value="propuesta">Propuesta</option>
              <option value="asignada">Asignada</option>
              <option value="en_curso">En curso</option>
              <option value="bloqueada">Bloqueada</option>
              <option value="enviada">Enviada</option>
              <option value="aceptada">Aceptada</option>
              <option value="devuelta">Devuelta</option>
              <option value="cancelada">Cancelada</option>
            </select>
          </label>
          <button id="actions-apply-filters" className="secondary-button" type="submit" disabled={!signedIn}>
            Aplicar filtros
          </button>
          <button
            id="actions-refresh"
            className="secondary-button"
            type="button"
            disabled={!signedIn || list.phase === 'loading'}
            onClick={reload}
          >
            Actualizar lista
          </button>
        </form>

        <div className="table-wrap">
          <table id="actions-table">
            <caption className="sr-only">Acciones preventivas devueltas por el servicio</caption>
            <thead>
              <tr>
                <th scope="col">Acción</th>
                <th scope="col">Comunidad</th>
                <th scope="col">Estado</th>
                <th scope="col">Prioridad</th>
                <th scope="col">Responsable</th>
                <th scope="col">Fecha límite</th>
                <th scope="col">Detalle</th>
              </tr>
            </thead>
            <tbody id="actions-rows">
              {list.actions.map(action => (
                <tr key={action.id} className={action.id === selectedId ? 'is-selected' : undefined}>
                  <td>{action.title}</td>
                  <td>{action.community_code}</td>
                  <td>
                    <span className="chip" data-status={action.status}>
                      <span className="chip-dot" aria-hidden="true" />
                      {actionStatusLabel(action.status)}
                    </span>
                  </td>
                  <td>{field(action.priority)}</td>
                  <td>{assigneeLabel(action, assigneeNames)}</td>
                  <td>{field(action.due_date)}</td>
                  <td>
                    <button
                      type="button"
                      className="button-text"
                      data-action-id={action.id}
                      onClick={() => openDetail(action.id)}
                    >
                      Ver detalle
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>

      {selectedId !== '' ? (
        <article className="panel actions-detail" id="action-detail" aria-labelledby="action-detail-title">
          <PanelHeading
            eyebrow="ACCIÓN PREVENTIVA"
            title={selected !== null ? selected.title : 'Detalle de la acción'}
            titleId="action-detail-title"
            level={2}
          />
          <StatusCopy id="action-detail-status">{detailMessage}</StatusCopy>
          <dl className="data-list compact" id="action-detail-fields">
            <div>
              <dt>Identificador</dt>
              <dd>{selected !== null ? selected.id : 'No disponible'}</dd>
            </div>
            <div>
              <dt>Comunidad (CUT)</dt>
              <dd>{selected !== null ? selected.community_code : 'No disponible'}</dd>
            </div>
            <div>
              <dt>Estado</dt>
              <dd>{selected !== null ? selected.status : 'No disponible'}</dd>
            </div>
            <div>
              <dt>Prioridad</dt>
              <dd>{selected !== null ? field(selected.priority) : 'No disponible'}</dd>
            </div>
            <div>
              <dt>Responsable</dt>
              <dd>{selected !== null ? assigneeLabel(selected, assigneeNames) : 'No disponible'}</dd>
            </div>
            <div>
              <dt>Fecha límite</dt>
              <dd>{selected !== null ? field(selected.due_date) : 'No disponible'}</dd>
            </div>
            <div>
              <dt>Creada por</dt>
              <dd>{selected !== null ? field(selected.created_by) : 'No disponible'}</dd>
            </div>
            <div>
              <dt>Creada el</dt>
              <dd>{selected !== null ? field(selected.created_at) : 'No disponible'}</dd>
            </div>
            <div>
              <dt>Actualizada el</dt>
              <dd>{selected !== null ? field(selected.updated_at) : 'No disponible'}</dd>
            </div>
          </dl>

          <h3>Historial</h3>
          <div className="table-wrap">
            <table id="action-history">
              <caption className="sr-only">Historial de estados de la acción preventiva</caption>
              <thead>
                <tr>
                  <th scope="col">Movimiento</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Nota</th>
                  <th scope="col">Fecha</th>
                </tr>
              </thead>
              <tbody id="action-history-rows">
                {(selected?.history ?? []).map((entry, index) => (
                  <tr key={entry.id ?? `${entry.to_status}-${index}`}>
                    <td>{historyMove(entry.from_status, entry.to_status)}</td>
                    <td>{field(entry.actor_sub)}</td>
                    <td>{field(entry.note)}</td>
                    <td>{field(entry.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3>Evidencia y suficiencia</h3>
          <p id="actions-sufficiency" className="status-copy" role="status" aria-live="polite">
            {selected !== null ? sufficiencyCopy(evidenceSufficient) : ''}
          </p>
          <div className="table-wrap">
            <table id="action-evidence">
              <caption className="sr-only">Instantáneas de evidencia registradas para la acción</caption>
              <thead>
                <tr>
                  <th scope="col">Criterio</th>
                  <th scope="col">Referencias</th>
                  <th scope="col">Registrada por</th>
                  <th scope="col">Fecha</th>
                </tr>
              </thead>
              <tbody id="action-evidence-rows">
                {evidence.length === 0 ? (
                  <tr>
                    <td colSpan={4}>
                      Todavía no hay evidencia registrada. Un administrador define el criterio de suficiencia y registra
                      las referencias; la decisión de suficiencia la registra una persona autorizada.
                    </td>
                  </tr>
                ) : (
                  evidence.map((item, index) => (
                    <tr key={item.id ?? `evidence-${index}`}>
                      <td>{field(item.criterion)}</td>
                      <td>
                        {item.references.length === 0 ? (
                          'Sin referencias'
                        ) : (
                          <ul className="reference-list">
                            {item.references.map(reference => (
                              <li key={reference}>
                                {isEvidenceReference(reference) ? (
                                  <a href={reference} target="_blank" rel="noreferrer noopener">
                                    {reference}
                                  </a>
                                ) : (
                                  <span>{reference}</span>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td>{field(item.created_by)}</td>
                      <td>{field(item.created_at)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <h3>Revisión humana de suficiencia</h3>
          <div className="table-wrap">
            <table id="action-evidence-reviews">
              <caption className="sr-only">Decisiones humanas registradas sobre la evidencia</caption>
              <thead>
                <tr>
                  <th scope="col">Instantánea</th>
                  <th scope="col">Decisión</th>
                  <th scope="col">Revisor</th>
                  <th scope="col">Nota</th>
                  <th scope="col">Fecha</th>
                </tr>
              </thead>
              <tbody id="action-evidence-review-rows">
                {(selected?.evidence_reviews ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={5}>
                      Todavía no hay decisiones registradas. La decisión es humana y el servidor guarda el revisor
                      verificado y la fecha.
                    </td>
                  </tr>
                ) : (
                  (selected?.evidence_reviews ?? []).map((item, index) => (
                    <tr key={item.id ?? `review-${index}`}>
                      <td>{item.evidence_id}</td>
                      <td>{evidenceDecisionLabel(item.decision)}</td>
                      <td>{field(item.reviewer_sub)}</td>
                      <td>{field(item.note)}</td>
                      <td>{field(item.reviewed_at)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <form className="actions-form actions-evidence-form" onSubmit={submitEvidence}>
            <label htmlFor="evidence-criterion">
              Criterio de suficiencia
              <textarea
                id="evidence-criterion"
                value={evidenceCriterion}
                disabled={!admin || writePending}
                onChange={event => setEvidenceCriterion(event.target.value)}
              />
            </label>
            <label htmlFor="evidence-references">
              Referencias de evidencia (una URL http o https por línea, sin credenciales)
              <textarea
                id="evidence-references"
                value={evidenceReferences}
                disabled={!admin || writePending}
                onChange={event => setEvidenceReferences(event.target.value)}
              />
            </label>
            <button id="record-evidence" className="primary-button" type="submit" disabled={!admin || writePending}>
              Registrar evidencia
            </button>
          </form>

          <label className="filter-label" htmlFor="review-note">
            Nota de la revisión
            <input
              id="review-note"
              type="text"
              value={reviewNote}
              disabled={!admin || writePending || currentEvidence === null}
              onChange={event => setReviewNote(event.target.value)}
            />
          </label>
          <div className="actions-review" id="action-review-controls">
            <button
              id="review-suficiente"
              type="button"
              className="secondary-button"
              disabled={!admin || writePending || currentEvidence === null}
              onClick={() => submitReview('suficiente')}
            >
              Suficiente
            </button>
            <button
              id="review-insuficiente"
              type="button"
              className="secondary-button"
              disabled={!admin || writePending || currentEvidence === null}
              onClick={() => submitReview('insuficiente')}
            >
              Insuficiente
            </button>
            <p className="panel-note" id="actions-review-note">
              {currentEvidence === null
                ? 'Registra al menos una instantánea de evidencia antes de revisar.'
                : `La decisión se registrará sobre la instantánea vigente ${currentEvidence.id}. El servidor fija el revisor y la fecha.`}
            </p>
          </div>

          <h3>Reevaluación sintética</h3>
          <p className="panel-note" id="action-reassessment-disclaimer">
            {REASSESSMENT_DISCLAIMER}
          </p>
          <label className="filter-label" htmlFor="reassessment-scenario">
            Escenario sintético (opcional)
            <select
              id="reassessment-scenario"
              value={scenarioId}
              disabled={!admin || writePending}
              onChange={event => setScenarioId(event.target.value)}
            >
              <option value="">Perfil heredado del servidor</option>
              {(catalogue ?? []).map(scenario => (
                <option key={scenario.id} value={scenario.id}>
                  {scenario.id}
                </option>
              ))}
            </select>
          </label>
          <div className="actions-reassessment" id="action-reassessment-controls">
            <button
              id="request-reassessment"
              type="button"
              className="secondary-button"
              disabled={!admin || writePending || reassessmentForSelected.phase === 'submitting' || reassessmentForSelected.phase === 'polling' || reassessmentForSelected.phase === 'linking'}
              onClick={startReassessment}
            >
              Solicitar reevaluación
            </button>
            {reassessmentForSelected.retryable ? (
              <button
                id="retry-reassessment"
                type="button"
                className="secondary-button"
                disabled={!admin || writePending}
                onClick={retryReassessment}
              >
                Reintentar vinculación
              </button>
            ) : null}
          </div>
          <p id="reassessment-status" className="status-copy" role="status" aria-live="polite">
            {reassessmentForSelected.message}
          </p>
          <div className="table-wrap">
            <table id="action-reassessments">
              <caption className="sr-only">Reevaluaciones sintéticas vinculadas a la acción</caption>
              <thead>
                <tr>
                  <th scope="col">Lote</th>
                  <th scope="col">Trabajo</th>
                  <th scope="col">Versión</th>
                  <th scope="col">Riesgo</th>
                  <th scope="col">Publicado</th>
                  <th scope="col">Vinculado por</th>
                </tr>
              </thead>
              <tbody id="action-reassessment-rows">
                {(selected?.reassessments ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={6}>
                      Todavía no hay reevaluaciones vinculadas. Una reevaluación solo se guarda cuando un trabajo real
                      publica su lote y el servidor valida el lote, la comunidad y la versión.
                    </td>
                  </tr>
                ) : (
                  (selected?.reassessments ?? []).map((item, index) => (
                    <tr key={item.id ?? `reassessment-${index}`}>
                      <td>{field(item.batch_id)}</td>
                      <td>{field(item.job_id)}</td>
                      <td>{field(item.version)}</td>
                      <td>{field(item.risk_level)}</td>
                      <td>{field(item.batch_published_at)}</td>
                      <td>{field(item.linked_by)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <h3>Transiciones</h3>
          <label className="filter-label" htmlFor="transition-note">
            Nota de la transición
            <input
              id="transition-note"
              type="text"
              value={transitionNote}
              disabled={!admin}
              onChange={event => setTransitionNote(event.target.value)}
            />
          </label>
          <div className="actions-transitions" id="action-transitions">
            {transitions.length === 0 ? (
              <p className="panel-note">
                El estado actual no tiene transiciones declaradas por el contrato, o no es un estado que el contrato
                declare.
              </p>
            ) : (
              transitions.map(item => (
                <button
                  key={item.to}
                  type="button"
                  className="secondary-button"
                  data-transition-to={item.to}
                  disabled={!item.enabled || writePending || (item.to === 'aceptada' && !evidenceSufficient)}
                  aria-describedby={item.to === 'aceptada' && !evidenceSufficient ? 'actions-acceptance-note' : undefined}
                  onClick={() => applyTransition(item.to)}
                >
                  {item.label}
                </button>
              ))
            )}
          </div>
          {acceptanceBlocked ? (
            <p className="panel-note" id="actions-acceptance-note">
              Aceptar requiere una revisión de suficiencia vigente sobre la evidencia actual; el servidor rechazará la
              transición mientras no exista.
            </p>
          ) : null}
        </article>
      ) : null}

      <article className="panel actions-create" aria-labelledby="action-create-title">
        <PanelHeading eyebrow="ALTA" title="Nueva acción preventiva" titleId="action-create-title" level={2} />
        <p className="panel-note">
          El alta requiere el rol admin y crea una acción vinculada a la comunidad indicada. El servidor resuelve el
          responsable en el directorio del realm cuando se elige uno y responde con el estado real.
        </p>
        <form className="actions-form" onSubmit={submitCreate}>
          <label htmlFor="create-community">
            Comunidad (CUT)
            <input
              id="create-community"
              type="text"
              required
              value={form.communityCode}
              disabled={!admin || writePending}
              onChange={event => setForm(previous => ({ ...previous, communityCode: event.target.value }))}
            />
          </label>
          <label htmlFor="create-title">
            Título
            <input
              id="create-title"
              type="text"
              required
              value={form.title}
              disabled={!admin || writePending}
              onChange={event => setForm(previous => ({ ...previous, title: event.target.value }))}
            />
          </label>
          <label htmlFor="create-description">
            Descripción
            <textarea
              id="create-description"
              value={form.description}
              disabled={!admin || writePending}
              onChange={event => setForm(previous => ({ ...previous, description: event.target.value }))}
            />
          </label>
          <label htmlFor="create-priority">
            Prioridad (texto libre validado por el servicio)
            <input
              id="create-priority"
              type="text"
              value={form.priority}
              disabled={!admin || writePending}
              onChange={event => setForm(previous => ({ ...previous, priority: event.target.value }))}
            />
          </label>
          <label htmlFor="create-assignee">
            Responsable (usuario del directorio)
            <select
              id="create-assignee"
              value={form.assigneeId}
              disabled={!admin || writePending}
              // The state of the directory is part of the control's own
              // description: a keyboard or screen-reader user hears the same
              // thing a sighted user reads under the form.
              aria-describedby="create-assignee-status"
              onChange={event => setForm(previous => ({ ...previous, assigneeId: event.target.value }))}
            >
              <option value="">{UNASSIGNED_OPTION}</option>
              {directoryState.phase === 'read'
                ? directoryState.users.map(user => (
                    <option key={user.id} value={user.id}>
                      {user.display_name}
                    </option>
                  ))
                : null}
            </select>
          </label>
          <label htmlFor="create-due-date">
            Fecha límite
            <input
              id="create-due-date"
              type="date"
              value={form.dueDate}
              disabled={!admin || writePending}
              onChange={event => setForm(previous => ({ ...previous, dueDate: event.target.value }))}
            />
          </label>
          <button id="create-action" className="primary-button" type="submit" disabled={!admin || writePending}>
            Crear acción
          </button>
        </form>
        <p id="create-assignee-status" className="status-copy" role="status" aria-live="polite">
          {assigneeStatus}
        </p>
        {admin && directoryState.phase === 'failed' ? (
          <button
            id="retry-directory"
            className="secondary-button"
            type="button"
            disabled={writePending}
            onClick={() => setDirectoryRevision(value => value + 1)}
          >
            Reintentar lectura del directorio
          </button>
        ) : null}
      </article>
    </section>
  );
}
