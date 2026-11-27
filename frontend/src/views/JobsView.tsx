import { useCallback, useEffect, useRef, useState } from 'react';

import { idleCopy } from '../app/sessionCopy';
import {
  getJobProgress,
  getSelectedZone,
  reportJobProgress,
  subscribeZoneState,
  useSelectedZone,
  useSessionState,
} from '../app/store';
import { StatusCopy, UnimplementedNote } from '../components/ui';
import { OperationsSteps, OperationsViewHead } from '../components/operations/OperationsPrimitives';
import { timing } from '../config';
import { createJob, history, job as readJob, latest, scenarios } from '../core/api';
import type { Failure } from '../core/api';
import { getAccessToken, getSessionSnapshot, subscribeSession } from '../core/session';
import { expectedBatchInHistory, matchesBatch, presentBatch } from '../domain';
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

interface JobSnapshot {
  status: string;
  state: string;
  id: string;
  requested: string;
  // True once a job has actually been read back from the API, which is when the
  // manual refresh becomes meaningful.
  known: boolean;
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

  const [catalogue, setCatalogue] = useState<Scenario[] | null>(null);
  const [scenarioNote, setScenarioNote] = useState(DEFAULT_SCENARIO_NOTE);
  const [scenarioId, setScenarioId] = useState('');
  const [requesting, setRequesting] = useState(false);
  const [job, setJob] = useState<JobSnapshot | null>(null);

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

  const status = job
    ? job.status
    : signedIn
      ? NO_JOB_STATUS
      : idleCopy(session, 'solicitar el lote de la zona');
  const selectorDisabled = !signedIn || catalogue === null;
  const createDisabled = !signedIn || selectedZone === '' || requesting;

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
                Solicita el procesamiento de la zona seleccionada. Esta operación requiere permisos de administrador y crea
                únicamente un trabajo sintético.
              </p>
              <button id="create-job" className="primary-button" type="button" disabled={createDisabled} onClick={requestBatch}>
                Solicitar lote de la zona
              </button>
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
        <UnimplementedNote>
          Publicar lote, el avance manual del estado y la reevaluación: no existen como endpoint; el servidor decide y
          publica por su cuenta, y esta página solo solicita el trabajo y lee el resultado.
        </UnimplementedNote>
      </article>
    </section>
  );
}
