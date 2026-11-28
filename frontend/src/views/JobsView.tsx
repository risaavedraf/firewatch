import { useCallback, useEffect, useRef, useState } from 'react';

import { idleCopy } from '../app/sessionCopy';
import {
  getJobProgress,
  getSelectedZone,
  rememberZoneLevel,
  reportJobProgress,
  subscribeZoneState,
  useSelectedZone,
  useSessionState,
} from '../app/store';
import { StatusCopy } from '../components/ui';
import { OperationsSteps, OperationsViewHead } from '../components/operations/OperationsPrimitives';
import { timing } from '../config';
import { createJob, cycleRun, history, job as readJob, latest, scenarios } from '../core/api';
import type { Failure } from '../core/api';
import { getAccessToken, getSessionSnapshot, subscribeSession } from '../core/session';
import {
  batchProvenance,
  declaresTacticalRole,
  expectedBatchInHistory,
  matchesBatch,
  presentBatch,
  summariseCycleRun,
} from '../domain';
import type { JobProgressKind } from '../domain/job-progress';
import type { Job, Scenario } from '../types/api';
import '../styles/operations-workspace.css';

// The processing view: request one synthetic batch for the selected zone, then
// read the job back with a bounded poll. Three rules travel with this code.
//
//   1. The request is administrative. The server decides whether the token may
//      create a job, so the view states the admin-only nature and renders a 403
//      as a permission denial instead of a missing service.
//   2. A job is only "published" for this view when its own batch is present and
//      valid in BOTH the latest read and the history, correlated by zone, job and
//      batch. A slow answer for another zone or a superseded request is discarded
//      whole, never rendered as the current job.
//   3. Polling is bounded twice: at most `maxPollAttempts` reads at
//      `pollIntervalMs`, and never past `pollDeadlineMs`. An expiry is an
//      UNCONFIRMED completion — never a published batch and never low risk. A
//      manual refresh is always offered so the operator can retry by hand.
//
// The synthetic-scenario selector survives (the user kept it by name): the
// served catalogue comes from `/v1/risk/synthetic-scenarios`, the chosen id
// travels only when one was chosen, and a refused or failed catalogue is NOT
// replaced by an invented one — the selector disables and the note says why.
//
// V1-P-06 — the three G6 actions exist as authenticated endpoints with a role
// gate, so this view no longer declares them missing. It offers the one that
// belongs to it: `POST /v1/risk/cycle/run`, an admin-only manual publication of
// the whole cycle. The route declares no body — the operator is the verified
// token subject — so this view never sends an actor, and it states the 403 a
// `viewer` receives and the 401 an unauthenticated request receives as two
// different outcomes. Manual advance (`transitions`) and reassessment
// (`reassessments`) live in `#actions`, which the note beside the control names.
//
// State ownership: the zone and the session are external stores, so this view
// *subscribes* to them and resets in the callback. The job snapshot is nulled
// exactly when the zone or the session changes, which is what makes a late
// answer from another zone impossible to display.

const NO_JOB_STATUS = 'Sin trabajo para la zona seleccionada.';
// A 202 is an ACCEPTANCE. `POST /v1/jobs` answers it with the stored job while its
// `batch_id` is still null, and that job is processed asynchronously: the page
// states the acceptance and the progress, never the HTTP status and never the
// bare `queued` token as the whole sentence.
const ACCEPTED_STATUS = 'Trabajo aceptado · el lote se está procesando; el servidor decide cuándo lo publica.';
const ACCEPTED_POLLING_STATUS = 'Trabajo aceptado · el lote se está procesando; consultando su estado…';
const POLLING_STATUS = 'Consultando estado del trabajo…';
const SERVER_FAILED_STATUS =
  'El servidor informó que el trabajo falló; solicita un lote nuevo para reintentar.';
const DEFAULT_SCENARIO_NOTE =
  'El escenario se elige en esta página. El servidor asigna su instante de evaluación en UTC, una sola vez por trabajo; son perfiles de prueba, no condiciones observadas.';
const CATALOGUE_REJECTED =
  'La API denegó el permiso para listar escenarios (403); el trabajo usaría el fixture analítico heredado.';
const CATALOGUE_INVALID =
  'La API no devolvió un catálogo de escenarios válido; el trabajo usaría el fixture analítico heredado.';
const CATALOGUE_FAILED = 'No fue posible cargar el catálogo de escenarios; el trabajo usaría el fixture analítico heredado.';
const PERMISSION_DENIED = 'La API denegó el permiso para esta acción (403). Solicita acceso a un administrador.';
const OTHER_JOB = 'La API devolvió otro trabajo o zona; se descartó.';
const POLL_EXHAUSTED = 'Se agotó la consulta automática; publicación o lectura sin verificar. Puedes actualizar manualmente.';
const DEADLINE_EXPIRED =
  'Tiempo de consulta automática agotado; publicación o lectura sin verificar. Puedes actualizar manualmente.';

// V1-P-06 — the manual publication of the cycle. The route is admin-only and
// declares no body, so these are the four answers the operator has to be able to
// tell apart: it ran, the role was refused, there is no cycle configured, and the
// request itself was refused.
const NO_CYCLE_STATUS =
  'Sin publicación manual en esta vista. El ciclo automático lo ejecuta el servidor por su cuenta.';
const CYCLE_RUNNING_STATUS =
  'Ejecutando el ciclo y publicando el lote de cada zona configurada…';
const CYCLE_PERMISSION_DENIED =
  'La API denegó el permiso para publicar el lote ahora (403): esta acción requiere admin y un viewer no puede ejecutarla. No se publicó ningún lote.';
const CYCLE_UNAVAILABLE =
  'El servicio no tiene un ciclo configurado (503 cycle_unavailable); no se publicó ningún lote.';
const CYCLE_BODY_REFUSED =
  'La API rechazó la solicitud de publicación (400): esta página no envía cuerpo y el contrato tampoco lo declara. No se ejecutó ningún ciclo.';
const NO_PROVENANCE_READ =
  'Procedencia sin leer: esta vista muestra quién evaluó un lote cuando lo lee, y todavía no lo hizo.';
const PROVENANCE_UNREAD =
  'Procedencia sin verificar: la lectura del último lote no respondió, así que esta página no afirma quién evaluó.';
const NO_PUBLISHED_BATCH = 'La zona no tiene un lote publicado, así que no hay evaluación que atribuir.';

interface JobSnapshot {
  status: string;
  state: string;
  id: string;
  requested: string;
  // True once a job has actually been read back from the API, which is when the
  // manual refresh becomes meaningful.
  known: boolean;
}

// The provenance of the batch this view actually read, and the zone it belongs to.
// Storing the zone is what makes a stale reading impossible to display after the
// selection moves.
interface ProvenanceReading {
  zone: string;
  batchId: string;
  label: string;
}

function scenarioFallback(failure: Failure): string {
  if (failure.kind === 'forbidden') return CATALOGUE_REJECTED;
  if (failure.reason === 'invalid_shape') return CATALOGUE_INVALID;
  return CATALOGUE_FAILED;
}

// `null` means "leave the panel as it is": an unauthorized answer already reset
// the session, and the session callback owns the copy in that case. The reason
// branch that copy needs now lives in `sessionCopy` (S2).
function failureCopy(failure: Failure, action: string): string | null {
  if (failure.kind === 'unauthorized') return null;
  if (failure.kind === 'forbidden') return PERMISSION_DENIED;
  if (failure.reason === 'zone_mismatch' || failure.reason === 'job_mismatch') return OTHER_JOB;
  const status = failure.status !== undefined && failure.status > 0 ? String(failure.status) : 'sin conexión';
  return `No se pudo ${action} (HTTP ${status}).`;
}

// The manual publication's failure copy. 401 is left to the session copy (the
// transport already closed the session, and `idleCopy` names the rejection), 403
// is a role decision the operator can act on, 503 `cycle_unavailable` means the
// deployment has no cycle wired at all, and 400 is a contract change this page
// must not describe as a publication.
function cycleFailureCopy(failure: Failure): string | null {
  if (failure.kind === 'unauthorized') return null;
  if (failure.kind === 'forbidden') return CYCLE_PERMISSION_DENIED;
  if (failure.status === 400) return CYCLE_BODY_REFUSED;
  if (failure.status === 503 || failure.reason === 'cycle_unavailable') return CYCLE_UNAVAILABLE;
  const status = failure.status !== undefined && failure.status > 0 ? String(failure.status) : 'sin conexión';
  return `No se pudo publicar el lote ahora (HTTP ${status}).`;
}

// What the map is told about the batch this job stands for. `queued` is a batch
// being produced, a server-reported `failed` is a failed request, and
// `published` — or a state this view does not know — stops claiming progress
// instead of guessing one.
function jobProgressKind(state: string): JobProgressKind {
  if (state === 'queued') return 'processing';
  if (state === 'failed') return 'failed';
  return 'idle';
}

function scenarioLabel(scenario: Scenario): string {
  return scenario.description === '' ? scenario.id : `${scenario.id} — ${scenario.description}`;
}

// The sentence for a job the server has not published yet. `queued` is what the
// acceptance always answers, so it carries the acceptance copy; a state this view
// does not know is shown as the server spelled it rather than translated into a
// guess, and a server-reported failure is named as a failure.
function jobStateCopy(state: string, scenario: string): string {
  if (state === 'queued') return `${ACCEPTED_STATUS}${scenario}`;
  if (state === 'failed') return `${SERVER_FAILED_STATUS}${scenario}`;
  return `Trabajo ${state}${scenario}; el servidor controla su procesamiento.`;
}

export function JobsView() {
  const selectedZone = useSelectedZone();
  const session = useSessionState();
  const signedIn = session.status === 'signed-in';
  // PM-15 (D-C): dispatching a job is the TACTICAL half of the ratified matrix —
  // «evalúa y gestiona acciones, sin admin» — so analista and admin may request a
  // batch and a viewer reads. The role is a token FACT read without verifying the
  // signature: it only decides the affordance, and the server decides the answer.
  const tactical = signedIn && declaresTacticalRole(session.roles);

  const [catalogue, setCatalogue] = useState<Scenario[] | null>(null);
  const [scenarioNote, setScenarioNote] = useState(DEFAULT_SCENARIO_NOTE);
  const [scenarioId, setScenarioId] = useState('');
  const [requesting, setRequesting] = useState(false);
  const [job, setJob] = useState<JobSnapshot | null>(null);
  // The manual cycle's own state. It is separate from the job snapshot on purpose:
  // a cycle run publishes a batch for every configured zone and is not a job, so
  // mixing the two would let one action claim the other's result. `null` means no
  // manual publication was attempted in this view.
  const [cycleStatus, setCycleStatus] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [provenance, setProvenance] = useState<ProvenanceReading | null>(null);

  const mountedRef = useRef(true);
  const zoneRef = useRef(selectedZone);
  const signedInRef = useRef(signedIn);
  const lastZoneRef = useRef(selectedZone);
  const lastSessionStatusRef = useRef(session.status);
  const sequenceRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deadlineRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptsRef = useRef(0);
  const currentJobIdRef = useRef('');
  // The manual publication's own fence, independent of the job cycle's: a cycle
  // run is not a job and must not cancel, or be cancelled by, the poll for one.
  const cycleSequenceRef = useRef(0);

  // The async callbacks read the zone and the session at the moment an answer
  // lands, not when the request started, so they are mirrored into refs after
  // every commit. The refs are read inside callbacks and effects only.
  useEffect(() => {
    zoneRef.current = selectedZone;
    signedInRef.current = signedIn;
  });

  // One job cycle's external teardown: fence its answers and clear both timers.
  // Kept out of the `setState` path so it is safe to call from any transition.
  const fenceJob = useCallback((abort: boolean): void => {
    sequenceRef.current += 1;
    if (abort && controllerRef.current) controllerRef.current.abort();
    controllerRef.current = null;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (deadlineRef.current !== null) {
      clearTimeout(deadlineRef.current);
      deadlineRef.current = null;
    }
    attemptsRef.current = 0;
    currentJobIdRef.current = '';
  }, []);

  // Unmount is a hard stop: no poll may outlive the view. The map must not keep
  // claiming progress nobody is watching, so a batch still being produced becomes
  // an unconfirmed publication instead of an eternal "en proceso".
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      fenceJob(true);
      const current = getJobProgress();
      if (current.kind === 'processing') reportJobProgress('unconfirmed', current.zone);
    };
  }, [fenceJob]);

  // A zone change ends the job that belonged to the previous zone. The sequence
  // is bumped so a late answer is discarded rather than applied to the new zone;
  // the in-flight read is intentionally NOT aborted, so the fence — not a
  // transport error — is what discards it.
  useEffect(
    () =>
      subscribeZoneState(() => {
        const zone = getSelectedZone();
        if (zone === lastZoneRef.current) return;
        lastZoneRef.current = zone;
        fenceJob(false);
        setJob(null);
        // The provenance belonged to the batch of the previous zone, so it is
        // dropped rather than left describing a zone nobody selected.
        setProvenance(null);
        // The progress belonged to the previous zone's job: nothing is being
        // produced for the new selection.
        reportJobProgress('idle', '');
      }),
    [fenceJob],
  );

  // Logout closes the session: abort the in-flight read, clear the job and the
  // catalogue. The scenario picker returns to its legacy-only disabled state.
  useEffect(
    () =>
      subscribeSession(() => {
        const status = getSessionSnapshot().status;
        if (status === lastSessionStatusRef.current) return;
        lastSessionStatusRef.current = status;
        if (status === 'signed-in') return;
        fenceJob(true);
        setJob(null);
        setCatalogue(null);
        setScenarioId('');
        setScenarioNote(DEFAULT_SCENARIO_NOTE);
        setRequesting(false);
        // A cycle result belongs to the session that ran it, and so does the
        // provenance of the batch it read: the next session states neither.
        cycleSequenceRef.current += 1;
        setCycleStatus(null);
        setPublishing(false);
        setProvenance(null);
        reportJobProgress('idle', '');
      }),
    [fenceJob],
  );

  // The catalogue is tied to the session: fetched once per connection. A
  // failure never becomes an invented profile.
  useEffect(() => {
    if (!signedIn) return;
    const controller = new AbortController();
    let current = true;
    void (async () => {
      const outcome = await scenarios(controller.signal);
      if (!current) return;
      if (outcome.ok) {
        setCatalogue(outcome.data);
        setScenarioNote(DEFAULT_SCENARIO_NOTE);
      } else {
        setCatalogue(null);
        setScenarioNote(scenarioFallback(outcome.failure));
      }
    })();
    return () => {
      current = false;
      controller.abort();
    };
  }, [signedIn]);

  function ownsJob(sequence: number, zone: string): boolean {
    return (
      mountedRef.current &&
      sequence === sequenceRef.current &&
      zone === zoneRef.current &&
      signedInRef.current &&
      getAccessToken() !== ''
    );
  }

  function patchJob(patch: Partial<JobSnapshot>): void {
    setJob(previous => (previous ? { ...previous, ...patch } : previous));
  }

  function stopDeadline(): void {
    if (deadlineRef.current !== null) {
      clearTimeout(deadlineRef.current);
      deadlineRef.current = null;
    }
  }

  // The single hard deadline for one job cycle. It fires once, aborts whatever is
  // in flight and states an unconfirmed completion: the page cannot know whether
  // the server published and it must not guess.
  function armDeadline(sequence: number, zone: string): void {
    stopDeadline();
    deadlineRef.current = setTimeout(() => {
      deadlineRef.current = null;
      if (!ownsJob(sequence, zone)) return;
      sequenceRef.current += 1;
      if (controllerRef.current) controllerRef.current.abort();
      controllerRef.current = null;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      attemptsRef.current = 0;
      patchJob({ status: DEADLINE_EXPIRED });
      reportJobProgress('unconfirmed', zone);
    }, timing.pollDeadlineMs);
  }

  function applyFailure(failure: Failure, action: string, zone: string): void {
    const copy = failureCopy(failure, action);
    if (copy === null) return;
    patchJob({ status: copy });
    reportJobProgress('failed', zone);
  }

  function renderJob(fetched: Job): void {
    currentJobIdRef.current = fetched.id;
    const scenario = typeof fetched.scenario_id === 'string' && fetched.scenario_id !== '' ? ` · escenario ${fetched.scenario_id}` : '';
    // The map is told which batch is being produced, not only what this panel
    // says: that is what keeps "todavía se está procesando" from reading as "no
    // hay datos" on the other view.
    const progress = jobProgressKind(fetched.state);
    reportJobProgress(progress, progress === 'idle' ? '' : fetched.zone_id);
    patchJob({
      status:
        fetched.state === 'published' && typeof fetched.batch_id === 'string' && fetched.batch_id !== ''
          ? `Trabajo publicado · lote ${fetched.batch_id}${scenario}`
          : jobStateCopy(fetched.state, scenario),
      state: fetched.state,
      id: fetched.id,
      requested:
        typeof fetched.requested_at === 'string' && fetched.requested_at !== '' ? fetched.requested_at : 'No informado',
      known: true,
    });
  }

  // One poll read. The same controller and attempt counter survive across the
  // cycle so the deadline and the attempt cap fence the whole job, not one call.
  async function loadJob(): Promise<void> {
    const id = currentJobIdRef.current;
    if (id === '') return;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (controllerRef.current === null) {
      controllerRef.current = new AbortController();
      attemptsRef.current = 0;
    }
    const controller = controllerRef.current;
    const sequence = sequenceRef.current;
    const zone = zoneRef.current;
    if (deadlineRef.current === null) armDeadline(sequence, zone);
    const attempt = (attemptsRef.current += 1);
    // A cycle that has not read a published batch is still the acceptance in
    // progress, so the confirmation stays on screen instead of flipping to a
    // bare poll; a published job being re-read is not "in process" and says so.
    setJob(previous =>
      previous === null
        ? previous
        : { ...previous, status: previous.state === 'published' ? POLLING_STATUS : ACCEPTED_POLLING_STATUS },
    );
    const outcome = await readJob(id, controller.signal);
    if (!ownsJob(sequence, zone) || attempt !== attemptsRef.current) return;
    if (!outcome.ok) {
      stopDeadline();
      applyFailure(outcome.failure, 'consultar el trabajo', zone);
      return;
    }
    const fetched = outcome.data;
    if (fetched.id !== id || fetched.zone_id !== zone) {
      stopDeadline();
      patchJob({ status: OTHER_JOB });
      // The answer belongs to another job: this page cannot state anything about
      // the batch it requested, so the map stops claiming a confirmed progress.
      reportJobProgress('unconfirmed', zone);
      return;
    }
    await followJob(fetched, sequence, zone);
  }

  // Read the published batch back. Completion is claimed only when the batch
  // correlates with the job in BOTH reads.
  async function followJob(fetched: Job, sequence: number, zone: string): Promise<void> {
    const attempt = attemptsRef.current;
    renderJob(fetched);
    if (fetched.state === 'published' && typeof fetched.batch_id === 'string' && fetched.batch_id !== '') {
      const expected = { zone, job: fetched.id, batch: fetched.batch_id };
      const controller = controllerRef.current;
      const signal = controller ? controller.signal : undefined;
      const [latestOutcome, historyOutcome] = await Promise.all([latest(zone, signal), history(zone, signal)]);
      if (!ownsJob(sequence, zone) || attempt !== attemptsRef.current) return;
      const confirmed =
        latestOutcome.ok &&
        matchesBatch(latestOutcome.data, expected) &&
        presentBatch(latestOutcome.data).valid &&
        historyOutcome.ok &&
        expectedBatchInHistory(historyOutcome.data, expected);
      if (confirmed) {
        stopDeadline();
        patchJob({ status: `Trabajo publicado · lote ${fetched.batch_id} verificado en último lote e historial.` });
        // The read that confirmed the publication is also the read that proves who
        // evaluated the batch, so the panel states that provenance instead of
        // leaving the manual and the scheduled evaluation indistinguishable.
        setProvenance({
          zone,
          batchId: fetched.batch_id,
          label: batchProvenance(latestOutcome.ok ? latestOutcome.data : null).label,
        });
        // Published: nothing is being produced any more, so the map stops saying
        // that it is.
        reportJobProgress('idle', '');
        return;
      }
    }
    if (attemptsRef.current >= timing.maxPollAttempts) {
      stopDeadline();
      patchJob({ status: POLL_EXHAUSTED });
      reportJobProgress('unconfirmed', zone);
      return;
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void loadJob();
    }, timing.pollIntervalMs);
  }

  function requestBatch(): void {
    if (!signedInRef.current || zoneRef.current === '') return;
    // Both the zone and the scenario are captured at click time: a later change
    // in either control must not alter a request that is already in flight.
    const zone = zoneRef.current;
    const scenario = scenarioId;
    fenceJob(true);
    const sequence = sequenceRef.current;
    // The map learns that a batch is being produced from this request, before the
    // server has answered: a request in flight is progress, not an absence.
    reportJobProgress('processing', zone);
    setJob({ status: 'Solicitando trabajo a la API…', state: 'Sin solicitud', id: '—', requested: '—', known: false });
    const controller = new AbortController();
    controllerRef.current = controller;
    armDeadline(sequence, zone);
    setRequesting(true);
    void (async () => {
      try {
        const outcome = await createJob(
          {
            zoneId: zone,
            // The server rejects an explicit empty scenario_id with 400 while an
            // omitted field keeps the legacy fixture, so the field travels only
            // when one was actually chosen.
            scenarioId: scenario === '' ? undefined : scenario,
            idempotencyKey: crypto.randomUUID(),
          },
          controller.signal,
        );
        if (!ownsJob(sequence, zone)) return;
        if (!outcome.ok) {
          stopDeadline();
          applyFailure(outcome.failure, 'solicitar el trabajo', zone);
          return;
        }
        const created = outcome.data;
        if (created.zone_id !== zone || created.id === '') {
          stopDeadline();
          patchJob({ status: OTHER_JOB });
          reportJobProgress('failed', zone);
          return;
        }
        if (created.state === 'published') await followJob(created, sequence, zone);
        else {
          renderJob(created);
          void loadJob();
        }
      } finally {
        if (mountedRef.current) setRequesting(false);
      }
    })();
  }

  // ── V1-P-06 — the manual publication ────────────────────────────────
  //
  // `POST /v1/risk/cycle/run` runs one full cycle synchronously and publishes a
  // batch for every configured zone. It declares no body: the operator is the
  // verified token subject, so this page sends none and an answer that names one
  // is refused by the service before the cycle starts. A cycle run is not a job,
  // so it carries its own fence and never cancels the job poll.
  function publishNow(): void {
    if (!signedInRef.current || publishing) return;
    const zone = zoneRef.current;
    const sequence = (cycleSequenceRef.current += 1);
    setPublishing(true);
    setCycleStatus(CYCLE_RUNNING_STATUS);
    void (async () => {
      try {
        const outcome = await cycleRun();
        if (!mountedRef.current || sequence !== cycleSequenceRef.current) return;
        // The action is over once the server answered: the button is live again
        // before the follow-up read, which is a display refresh and not part of
        // the publication.
        setPublishing(false);
        if (!outcome.ok) {
          // `null` hands the copy to the session: a 401 already closed it, and
          // `idleCopy` names the rejection instead of a permission decision.
          const copy = cycleFailureCopy(outcome.failure);
          setCycleStatus(copy);
          return;
        }
        setCycleStatus(summariseCycleRun(outcome.data).label);
        await readPublishedBatch(zone, sequence);
      } finally {
        if (mountedRef.current && sequence === cycleSequenceRef.current) setPublishing(false);
      }
    })();
  }

  // The batch this panel can speak about after a publication is the selected
  // zone's last one. Reading it back is what lets the view state the provenance of
  // the evaluation that produced it, and it is also how the shared zone level —
  // the fact the map paints — is refreshed after a manual run. A read that fails
  // clears the provenance instead of leaving the previous one on screen.
  async function readPublishedBatch(zone: string, sequence: number): Promise<void> {
    if (zone === '') return;
    const outcome = await latest(zone);
    if (!mountedRef.current || sequence !== cycleSequenceRef.current || zone !== zoneRef.current) return;
    if (!outcome.ok) {
      setProvenance({ zone, batchId: '', label: PROVENANCE_UNREAD });
      return;
    }
    // The transport maps a 404 to "no published batch" rather than to a failure,
    // so this is the absence of an evaluation to attribute, never an unread one.
    if (outcome.data === null) {
      rememberZoneLevel(zone, null);
      setProvenance({ zone, batchId: '', label: NO_PUBLISHED_BATCH });
      return;
    }
    const presentation = presentBatch(outcome.data);
    // The map only takes a level from a batch that passed the same fail-closed
    // validation the risk panel applies; anything else clears it.
    rememberZoneLevel(zone, presentation.valid && presentation.level !== '' ? presentation.level : null);
    setProvenance({ zone, batchId: outcome.data.id, label: batchProvenance(outcome.data).label });
  }

  const status = job
    ? job.status
    : signedIn
      ? NO_JOB_STATUS
      : idleCopy(session, 'solicitar el lote de la zona');
  const cycleCopy = cycleStatus ?? (signedIn ? NO_CYCLE_STATUS : idleCopy(session, 'publicar el lote ahora'));
  const provenanceCopy =
    provenance === null
      ? NO_PROVENANCE_READ
      : `${provenance.label}${provenance.batchId === '' ? '' : ` · lote ${provenance.batchId}`}`;
  const selectorDisabled = !signedIn || catalogue === null;
  const createDisabled = !signedIn || !tactical || selectedZone === '' || requesting;
  const publishDisabled = !signedIn || publishing;

  return (
    <section className="view" id="jobs" data-view="jobs" aria-labelledby="jobs-title">
      <article className="panel jobs-panel">
        {/* Board 16 opens the screen by naming the question and, above the
            controls, explains the sequence the service really performs. The
            illustrative queue and the three G6 actions of the board are not
            ported: there is no endpoint behind them. */}
        <OperationsViewHead
          id="jobs-head"
          eyebrow="LOTE DE DEMOSTRACIÓN"
          title="Procesamiento asíncrono"
          titleId="jobs-title"
          lede="Solicita un lote sintético para la zona seleccionada y lee el trabajo con una consulta acotada. El servidor decide cuándo publica; esta página solo solicita, espera y verifica la lectura."
        >
          <span className="admin-tag">ACCIÓN ADMINISTRATIVA</span>
          <span className="ops-chip">Trabajo sintético</span>
        </OperationsViewHead>
        <div className="ops-layout">
          <div className="ops-stack">
            <OperationsSteps
              id="jobs-flow"
              titleId="jobs-flow-title"
              eyebrow="HOY"
              title="El servidor decide y publica"
              badge={<span className="neutral-tag">CONTRATO ACTUAL</span>}
              items={[
                {
                  title: 'Solicitar lote de la zona',
                  detail: (
                    <>
                      <code>POST /v1/jobs</code> responde 202 con el trabajo aceptado. Requiere admin; un viewer recibe
                      403.
                    </>
                  ),
                },
                {
                  title: 'Esperar y consultar',
                  detail: (
                    <>
                      <code>GET /v1/jobs/{'{id}'}</code> con un número de intentos y un plazo acotados por esta página.
                    </>
                  ),
                },
                {
                  title: 'La publicación la decide el servidor',
                  detail: 'La página no fija el lote ni mueve su estado: solo lee lo que el servicio publica.',
                },
                {
                  title: 'Confirmar la lectura',
                  detail:
                    'Solo se declara publicado si el lote aparece correlacionado en el último lote y en el historial. Un plazo agotado es una publicación sin verificar, nunca un nivel bajo.',
                },
              ]}
              note="El estado en vivo no se simula: la cola del tablero de diseño es ilustrativa y no se dibuja aquí."
            />
            <div>
              <div className="scenario-field">
                <label htmlFor="scenario-select">Escenario sintético</label>
                <select
                  id="scenario-select"
                  aria-label="Escenario sintético a solicitar"
                  value={scenarioId}
                  disabled={selectorDisabled}
                  onChange={event => setScenarioId(event.target.value)}
                >
                  <option value="">Sin escenario (fixture analítico heredado)</option>
                  {(catalogue ?? []).map(scenario => (
                    <option key={scenario.id} value={scenario.id}>
                      {scenarioLabel(scenario)}
                    </option>
                  ))}
                </select>
                <p className="panel-note" id="scenario-note">
                  {scenarioNote}
                </p>
              </div>
              <p className="panel-note">
                Solicita el procesamiento de la zona seleccionada. Esta operación es táctica: requiere el rol analista o
                admin, y crea únicamente un trabajo sintético.
                {signedIn && !tactical
                  ? ' Tu token declara el rol viewer, así que el alta queda deshabilitada en esta página; puedes leer el estado de los trabajos. La página no concede permisos y el servidor decide cada uno.'
                  : ''}
              </p>
              <button id="create-job" className="primary-button" type="button" disabled={createDisabled} onClick={requestBatch}>
                Solicitar lote de la zona
              </button>
            </div>
            {/* V1-P-06 — the manual publication. It is a real control with a real
                endpoint behind it, so it states its role gate and its two refusals
                in the copy instead of hiding behind a disabled button. */}
            <div>
              <h4 id="cycle-title">Publicar lote ahora</h4>
              <p className="panel-note" id="cycle-note">
                Ejecuta el ciclo completo en el acto y publica el lote de cada zona configurada (
                <code>POST /v1/risk/cycle/run</code>). Requiere admin: un <code>viewer</code> recibe 403 y una petición
                sin sesión recibe 401. El operador queda registrado como el sujeto del token verificado, así que esta
                página no envía cuerpo ni identidad. El avance manual del estado de una acción preventiva y su
                reevaluación viven en <a href="#actions">#actions</a>.
              </p>
              <button
                id="publish-batch"
                className="primary-button"
                type="button"
                disabled={publishDisabled}
                aria-describedby="cycle-note"
                onClick={publishNow}
              >
                Publicar lote ahora
              </button>
              <StatusCopy id="cycle-status">{cycleCopy}</StatusCopy>
            </div>
          </div>
          <aside className="ops-side">
            <div className="job-result">
            <p className="eyebrow">ESTADO DEL TRABAJO</p>
            <StatusCopy id="job-status">{status}</StatusCopy>
            <dl className="data-list compact">
              <div>
                <dt>Estado</dt>
                <dd id="job-state">{job ? job.state : 'Sin solicitud'}</dd>
              </div>
              <div>
                <dt>ID del trabajo</dt>
                <dd id="job-id">{job ? job.id : '—'}</dd>
              </div>
              <div>
                <dt>Solicitado</dt>
                <dd id="job-requested">{job ? job.requested : '—'}</dd>
              </div>
            </dl>
            <p className="eyebrow">PROCEDENCIA DE LA EVALUACIÓN</p>
            <p id="batch-provenance" className="panel-note">
              {provenanceCopy}
            </p>
            <button
              id="refresh-job"
              className="secondary-button"
              type="button"
              disabled={!(job !== null && job.known)}
              onClick={() => {
                void loadJob();
              }}
            >
              Actualizar estado
            </button>
            </div>
          </aside>
        </div>
        {/* The absence this view used to declare is retired: the three G6 actions
            exist as authenticated endpoints with a role gate. The manual
            publication is offered above; the other two are pointed at the view
            that really performs them, never simulated here. */}
        <p className="ops-note" id="jobs-actions-note">
          Las tres acciones de G6 existen como endpoints autenticados con autorización por rol. Publicar un lote ahora
          es la que ofrece esta vista (<code>POST /v1/risk/cycle/run</code>, solo admin). El avance manual del estado y la
          reevaluación de una acción preventiva se realizan en <a href="#actions">#actions</a>; esta página las enlaza y
          no las simula.
        </p>
      </article>
    </section>
  );
}
