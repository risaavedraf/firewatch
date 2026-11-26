import { useEffect, useState, type FormEvent } from 'react';

import { idleCopy } from '../app/sessionCopy';
import { useSessionState } from '../app/store';
import { Chip, DataList, PanelHeading } from '../components/ui';
import {
  SIMULATION_VARIABLES,
  latest,
  simulateRisk,
  zones,
  type Failure,
  type Outcome,
  type SimulationFactor,
  type SimulationResult,
  type SimulationVariable,
} from '../core/api';
import { getSessionSnapshot, subscribeSession } from '../core/session';
import { levelLabel } from '../domain';
import type { RiskBatch, ZoneFeature } from '../types/api';

// PM-03 — counterfactual simulator (S1/S2/S4, D-D).
//
// The page offers ONE capability: reapplying the rule that produced a zone's
// newest stored batch to values a person substitutes. Six properties travel here:
//   1. the zone picker is the REAL catalogue, and the five canonical variables are
//      PREFILLED from that zone's `/v1/risk/latest` read, with the value and the
//      note the batch recorded;
//   2. a variable the batch did not measure reads «sin lectura» and is not sent
//      until a person writes a value — the page never fills one in from zero or
//      from another variable;
//   3. only the substituted variables travel: the body names one zone and the
//      substitution, so the route keeps the rest of the stored batch;
//   4. the submission is explicit. Nothing is requested on keystroke, and
//      «Simular» stays disabled until at least one substitution exists;
//   5. the result is labelled «Cómo lo calculó la regla» (D-D) and is never
//      presented as a forecast, a prediction or a probability: it is the same pure
//      rule with another input, and no published row changed;
//   6. a failure settles into the panel it belongs to, so the zone picker, the
//      variables and the rest of the application keep working.

const ZONES_ACTION = 'consultar el catálogo de zonas';
const BATCH_ACTION = 'leer el último lote de la zona';
const SIMULATE_ACTION = 'simular la regla con las variables sustituidas';

const VARIABLE_LABELS: Record<SimulationVariable, string> = {
  temperatura: 'Temperatura',
  humedad_relativa: 'Humedad relativa',
  viento: 'Viento',
  cobertura_vegetal: 'Cobertura vegetal',
  incendios_historicos: 'Incendios históricos',
};

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

// One builder for every refusal, so the catalogue read, the batch read and the
// simulation all name the HTTP status, the server `code` and the `request_id` when
// they have one. The codes are the ones the frozen contract declares.
function failureMessage(failure: Failure, action: string): string {
  const status = failure.status !== undefined ? `HTTP ${failure.status}` : 'sin conexión';
  const code = nonempty(failure.reason) && failure.reason !== `http_${failure.status}` ? ` · ${failure.reason}` : '';
  const request = failure.requestId !== undefined ? ` · request_id ${failure.requestId}` : '';
  const detail = `${status}${code}${request}`;
  switch (failure.reason) {
    case 'no_published_batch':
      return `La zona no tiene ningún lote publicado, así que no hay ninguna regla guardada que simular (${detail}). El simulador no inventa un lote ni usa el modelo activo en su lugar.`;
    case 'unsupported_original_rule':
      return `El lote guardado no se puede reproducir con una regla integrada del servicio (${detail}). La simulación se detiene aquí: no se sustituye por el modelo activo, porque el resultado describiría otra política que la del nivel guardado.`;
    case 'invalid_simulation':
      return `La API rechazó el cuerpo de la simulación (${detail}): nombra una sola zona y al menos una variable canónica con un valor numérico finito.`;
    case 'invalid_zone':
      return `La zona elegida no existe en el catálogo del servicio (${detail}).`;
    case 'json_required':
      return `La API exige un cuerpo JSON para simular (${detail}).`;
    case 'storage_unavailable':
      return `El almacenamiento del servicio de riesgo no está disponible (${detail}).`;
    case 'batch_mismatch':
      return `El lote más reciente de la zona cambió desde que se precargó (${detail}), así que el antes/después no correspondería al lote que leíste. No se muestra ese resultado: se vuelve a leer el último lote.`;
    case 'zone_mismatch':
      return `La API respondió por otra zona (${detail}); no se muestra un resultado que no es el de la zona elegida.`;
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

type Phase = 'unconsulted' | 'loading' | 'read' | 'denied' | 'unavailable';

interface ZoneOption {
  readonly code: string;
  readonly name: string;
}

interface CatalogueState {
  readonly phase: Phase;
  readonly message: string;
  readonly zones: readonly ZoneOption[];
}

// One canonical variable as the stored batch states it: the value and the note it
// recorded, or null when the batch carries no reading for it.
interface Reading {
  readonly value: number;
  readonly note: string;
}

type Readings = Record<SimulationVariable, Reading | null>;

interface BatchState {
  readonly phase: Phase;
  readonly message: string;
  readonly data: RiskBatch | null;
  readonly readings: Readings;
}

interface RowState {
  readonly substitute: boolean;
  readonly text: string;
}

type Rows = Record<SimulationVariable, RowState>;

const NO_READINGS: Readings = {
  temperatura: null,
  humedad_relativa: null,
  viento: null,
  cobertura_vegetal: null,
  incendios_historicos: null,
};

const NO_ROWS: Rows = {
  temperatura: { substitute: false, text: '' },
  humedad_relativa: { substitute: false, text: '' },
  viento: { substitute: false, text: '' },
  cobertura_vegetal: { substitute: false, text: '' },
  incendios_historicos: { substitute: false, text: '' },
};

const IDLE_CATALOGUE: CatalogueState = {
  phase: 'unconsulted',
  message: 'El catálogo de zonas se consulta con una sesión conectada.',
  zones: [],
};

const LOADING_CATALOGUE: CatalogueState = {
  phase: 'loading',
  message: 'Consultando el catálogo de zonas del servicio…',
  zones: [],
};

const IDLE_BATCH: BatchState = {
  phase: 'unconsulted',
  message: 'Elige una zona del catálogo para leer su último lote publicado y precargar las cinco variables.',
  data: null,
  readings: NO_READINGS,
};

const LOADING_BATCH: BatchState = {
  phase: 'loading',
  message: 'Leyendo el último lote publicado de la zona…',
  data: null,
  readings: NO_READINGS,
};

type RunPhase = 'idle' | 'running' | 'done' | 'failed';

interface RunState {
  readonly phase: RunPhase;
  readonly message: string;
  readonly result: SimulationResult | null;
}

const IDLE_RUN: RunState = { phase: 'idle', message: '', result: null };

// The stored value of a factor, or null when the batch recorded no reading for it.
// `known: false` is exactly "no lectura": the rule would answer desconocido, which
// is not the same as zero.
function readingsFromBatch(batch: RiskBatch | null): Readings {
  const readings = { ...NO_READINGS };
  if (batch === null) return readings;
  for (const name of SIMULATION_VARIABLES) {
    const factor = batch.factors.find(entry => entry.name === name);
    readings[name] =
      factor !== undefined && factor.known === true && Number.isFinite(factor.value)
        ? { value: factor.value, note: nonempty(factor.note) ? factor.note : '' }
        : null;
  }
  return readings;
}

// The substitution fields are prefilled with the stored value so the person can
// see what the rule used; the checkbox is what decides whether a variable travels.
function rowsFromReadings(readings: Readings): Rows {
  const rows = { ...NO_ROWS };
  for (const name of SIMULATION_VARIABLES) {
    const reading = readings[name];
    rows[name] = { substitute: false, text: reading === null ? '' : String(reading.value) };
  }
  return rows;
}

// Only the checked variables with a usable value are substituted. An empty or
// non-numeric field is not a number and is never sent as one: the variable is
// simply not part of this counterfactual.
function collectSubstitutions(rows: Rows): Partial<Record<SimulationVariable, number>> {
  const variables: Partial<Record<SimulationVariable, number>> = {};
  for (const name of SIMULATION_VARIABLES) {
    const row = rows[name];
    if (!row.substitute) continue;
    const text = row.text.trim();
    if (text === '') continue;
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) continue;
    variables[name] = parsed;
  }
  return variables;
}

function readingsText(reading: Reading | null): string {
  if (reading === null) return 'sin lectura en el lote guardado';
  return reading.note === ''
    ? `Lectura del lote: ${String(reading.value)} · el servicio no adjuntó una nota`
    : `Lectura del lote: ${String(reading.value)} · ${reading.note}`;
}

function factorOf(assessment: SimulationResult['before'], name: SimulationVariable): SimulationFactor | undefined {
  return assessment.factors.find(factor => factor.name === name);
}

function factorText(factor: SimulationFactor | undefined): string {
  if (factor === undefined || factor.known !== true || !Number.isFinite(factor.value)) return 'sin lectura';
  return Number.isFinite(factor.contribution)
    ? `${String(factor.value)} · aporte ${String(factor.contribution)}`
    : String(factor.value);
}

function levelTone(level: string): 'neutral' | 'high' | 'medium' | 'low' {
  switch (level) {
    case 'alto':
      return 'high';
    case 'medio':
      return 'medium';
    case 'bajo':
      return 'low';
    default:
      return 'neutral';
  }
}

function catalogueFromOutcome(outcome: Outcome<{ type: 'FeatureCollection'; features: ZoneFeature[] }>): CatalogueState {
  if (!outcome.ok) {
    return {
      phase: outcome.failure.kind === 'forbidden' ? 'denied' : 'unavailable',
      message: failureMessage(outcome.failure, ZONES_ACTION),
      zones: [],
    };
  }
  const options = outcome.data.features.map(feature => ({
    code: feature.properties.code,
    name: feature.properties.name,
  }));
  if (options.length === 0) {
    return {
      phase: 'read',
      message: 'El catálogo del servicio no devolvió zonas: no hay ninguna regla guardada que simular.',
      zones: [],
    };
  }
  return {
    phase: 'read',
    message: `Catálogo del servicio: ${options.length} ${options.length === 1 ? 'zona disponible' : 'zonas disponibles'}.`,
    zones: options,
  };
}

function batchFromOutcome(outcome: Outcome<RiskBatch | null>, zoneId: string): BatchState {
  if (!outcome.ok) {
    return {
      phase: outcome.failure.kind === 'forbidden' ? 'denied' : 'unavailable',
      message: failureMessage(outcome.failure, BATCH_ACTION),
      data: null,
      readings: NO_READINGS,
    };
  }
  if (outcome.data === null) {
    return {
      phase: 'read',
      message: `La zona ${zoneId} no tiene ningún lote publicado (/v1/risk/latest respondió 404 no_published_batch): no hay ninguna regla guardada que simular.`,
      data: null,
      readings: NO_READINGS,
    };
  }
  const batch = outcome.data;
  const readings = readingsFromBatch(batch);
  const measured = SIMULATION_VARIABLES.filter(name => readings[name] !== null).length;
  const version = nonempty(batch.model_version) ? batch.model_version : 'sin versión declarada';
  return {
    phase: 'read',
    message: `Último lote publicado de ${zoneId}: ${levelLabel(batch.risk_level)} · lote ${batch.id} · regla ${version} · ${measured} de 5 variables con lectura.`,
    data: batch,
    readings,
  };
}

export function SimulatorView() {
  const session = useSessionState();
  const signedIn = session.status === 'signed-in';

  const [catalogue, setCatalogue] = useState<CatalogueState | null>(null);
  const [batch, setBatch] = useState<BatchState | null>(null);
  const [zoneId, setZoneId] = useState('');
  const [rows, setRows] = useState<Rows>(NO_ROWS);
  const [run, setRun] = useState<RunState>(IDLE_RUN);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  // Reading the newest batch again is the page's only reaction to a batch that
  // changed under it; it is not a control the operator can press.
  const [batchRevision, setBatchRevision] = useState(0);

  // The zone catalogue is re-read on every connection. A failed read empties it
  // instead of leaving a stale catalogue selectable.
  useEffect(() => {
    if (!signedIn) return undefined;
    const controller = new AbortController();
    let active = true;
    void (async () => {
      const outcome = await zones(controller.signal);
      if (!active) return;
      setCatalogue(catalogueFromOutcome(outcome));
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [signedIn]);

  // The newest batch of the chosen zone, prefilled into the five canonical rows.
  // The read is fenced by the effect cleanup, so a slow answer for the previous
  // zone can never prefill the zone now selected. The result of the previous zone
  // is dropped where the selection changes, not here: an effect that reset state
  // synchronously would cascade a render on every read.
  useEffect(() => {
    if (!signedIn || zoneId === '') return undefined;
    const controller = new AbortController();
    let active = true;
    void (async () => {
      const outcome = await latest(zoneId, controller.signal);
      if (!active) return;
      const state = batchFromOutcome(outcome, zoneId);
      setBatch(state);
      setRows(rowsFromReadings(state.readings));
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [signedIn, zoneId, batchRevision]);

  // Closing the session empties the private state. A refused token keeps the
  // notice — it carries the request id — while an ordinary logout clears it.
  useEffect(
    () =>
      subscribeSession(() => {
        if (getSessionSnapshot().status === 'signed-in') return;
        const reason = getSessionSnapshot().reason;
        setCatalogue(null);
        setBatch(null);
        setZoneId('');
        setRows(NO_ROWS);
        setRun(IDLE_RUN);
        setBusy(false);
        if (reason !== 'rejected') setNotice('');
      }),
    [],
  );

  // Loading is DERIVED from the absence of a settled snapshot, exactly like the
  // observational views: no effect sets it synchronously and no stale answer is
  // painted as the current one.
  const settledCatalogue: CatalogueState = catalogue ?? LOADING_CATALOGUE;
  const settledBatch: BatchState = batch ?? LOADING_BATCH;
  const catalogueState: CatalogueState = signedIn ? settledCatalogue : IDLE_CATALOGUE;
  const batchState: BatchState = signedIn && zoneId !== '' ? settledBatch : IDLE_BATCH;

  const substitutions = collectSubstitutions(rows);
  const substitutionCount = Object.keys(substitutions).length;
  const batchReady = batchState.phase === 'read' && batchState.data !== null;
  const catalogueReady = catalogueState.phase === 'read' && catalogueState.zones.length > 0;
  const canSimulate = signedIn && batchReady && substitutionCount > 0 && !busy;
  const fieldsDisabled = !signedIn || busy;

  const badge = !signedIn
    ? 'SIN CONSULTAR'
    : busy || run.phase === 'running'
      ? 'SIMULANDO'
      : run.phase === 'done'
        ? 'SIMULADO'
        : catalogueState.phase === 'loading'
          ? 'CONSULTANDO'
          : zoneId === ''
            ? 'SIN ZONA'
            : batchState.phase === 'denied'
              ? 'SIN PERMISO'
              : batchState.phase === 'unavailable'
                ? 'NO DISPONIBLE'
                : batchState.data === null
                  ? 'SIN LOTE'
                  : 'LEÍDO';

  // A refused token closes the session, so the batch falls back to its idle state;
  // the captured refusal is shown instead, because it carries the request id.
  const statusText = !signedIn
    ? notice !== ''
      ? notice
      : idleCopy(session, 'simular una sustitución sobre el último lote de una zona')
    : batchState.message;

  function selectZone(next: string): void {
    if (next === zoneId) return;
    // The previous zone's batch, rows and result are not the answer to the new
    // selection: they are dropped rather than left visible under another zone.
    setBatch(null);
    setRows(NO_ROWS);
    setRun(IDLE_RUN);
    setNotice('');
    setZoneId(next);
  }

  function updateRow(name: SimulationVariable, patch: Partial<RowState>): void {
    setRows(previous => ({ ...previous, [name]: { ...previous[name], ...patch } }));
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!signedIn || busy) return;
    const current = batchState.data;
    if (current === null) {
      setNotice(
        'Elige una zona con un lote publicado: sin lote guardado no hay ninguna regla que simular, y la página no inventa una.',
      );
      return;
    }
    if (substitutionCount === 0) {
      setNotice(
        'Marca al menos una variable y escribe un valor numérico: solo las variables sustituidas viajan al servicio.',
      );
      return;
    }
    setBusy(true);
    setNotice('');
    setRun({ phase: 'running', message: 'Aplicando la regla guardada a las variables sustituidas…', result: null });
    void (async () => {
      const outcome = await simulateRisk({ zoneId, batchId: current.id, variables: substitutions });
      setBusy(false);
      if (!outcome.ok) {
        const message = failureMessage(outcome.failure, SIMULATE_ACTION);
        if (outcome.failure.reason === 'batch_mismatch' || outcome.failure.reason === 'no_published_batch') {
          // The stored batch is not the one the page prefilled from any more, so
          // its before/after would describe a lote nobody read: it is not shown.
          setNotice(message);
          setRun(IDLE_RUN);
          setBatch(null);
          setRows(NO_ROWS);
          setBatchRevision(value => value + 1);
          return;
        }
        setRun({ phase: 'failed', message, result: null });
        return;
      }
      setRun({
        phase: 'done',
        message: `Simulación completada sobre el lote ${outcome.data.batch_id}: el nivel guardado era ${levelLabel(
          outcome.data.stored_level,
        )}. No se publicó ningún lote.`,
        result: outcome.data,
      });
    })();
  }

  const result = run.result;

  return (
    <section className="view" id="simulator" data-view="simulator" aria-labelledby="simulator-title">
      <div className="intro-row">
        <div>
          <p className="eyebrow">PREVENCIÓN · PM-03</p>
          <h2 id="simulator-title">Simulador</h2>
        </div>
        <span className="neutral-tag" id="simulator-badge">
          {badge}
        </span>
      </div>
      <p className="subheading" id="simulator-lede">
        El simulador vuelve a aplicar la regla que produjo el nivel guardado de una zona, con las variables que
        sustituyas. Es la misma regla pura con otra entrada: no se publica ningún lote y el resultado no es un
        pronóstico.
      </p>
      <p
        id="simulator-status"
        className={batchReady ? 'status-copy risk-good' : 'status-copy'}
        role="status"
        aria-live="polite"
      >
        {statusText}
      </p>

      <div className="simulator-layout">
        <article className="panel simulator-panel" aria-labelledby="simulator-form-title">
          <PanelHeading eyebrow="SUSTITUCIÓN DE VARIABLES" title="Último lote de la zona" titleId="simulator-form-title" />
          <p className="panel-note" id="simulator-catalogue-status">
            {catalogueState.message}
          </p>

          <form id="simulator-form" className="simulator-form" onSubmit={submit}>
            <div className="field">
              <label htmlFor="simulator-zone">Zona del catálogo</label>
              <select
                id="simulator-zone"
                required
                value={zoneId}
                disabled={fieldsDisabled || !catalogueReady}
                aria-describedby="simulator-zone-note"
                onChange={event => selectZone(event.target.value)}
              >
                <option value="">Selecciona una zona del catálogo</option>
                {catalogueState.zones.map(zone => (
                  <option key={zone.code} value={zone.code}>
                    {`${zone.name} · ${zone.code}`}
                  </option>
                ))}
              </select>
              <p className="field-note" id="simulator-zone-note">
                La zona sale del catálogo real del servicio. Al cambiarla se lee su último lote publicado para
                precargar las cinco variables canónicas.
              </p>
            </div>

            <p className="panel-note" id="simulator-batch-status" role="status" aria-live="polite">
              {batchState.message}
            </p>

            <fieldset className="simulator-variables" id="simulator-variables">
              <legend>Variables del lote y sustitución</legend>
              <p className="field-note" id="simulator-variables-note">
                Cada campo se precarga con la lectura del lote guardado. Solo las variables marcadas viajan al
                servicio: el resto conserva el valor del lote porque no se envía. Una variable sin lectura queda
                vacía hasta que escribas un valor.
              </p>
              {SIMULATION_VARIABLES.map(name => (
                <div className="simulator-variable" key={name} data-variable={name}>
                  <div className="simulator-variable-head">
                    <input
                      id={`simulator-substitute-${name}`}
                      type="checkbox"
                      checked={rows[name].substitute}
                      disabled={fieldsDisabled}
                      aria-describedby={`simulator-reading-${name}`}
                      onChange={event => updateRow(name, { substitute: event.target.checked })}
                    />
                    <label htmlFor={`simulator-substitute-${name}`}>{`Sustituir ${VARIABLE_LABELS[name].toLowerCase()}`}</label>
                  </div>
                  <div className="simulator-variable-field">
                    <label htmlFor={`simulator-value-${name}`}>{VARIABLE_LABELS[name]}</label>
                    <input
                      id={`simulator-value-${name}`}
                      type="number"
                      step="any"
                      inputMode="decimal"
                      value={rows[name].text}
                      disabled={fieldsDisabled}
                      aria-describedby={`simulator-reading-${name}`}
                      onChange={event => updateRow(name, { text: event.target.value })}
                    />
                  </div>
                  <p className="field-note" id={`simulator-reading-${name}`}>
                    {readingsText(batchState.readings[name])}
                  </p>
                </div>
              ))}
            </fieldset>

            <div className="form-actions">
              <button id="simulator-submit" className="primary-button" type="submit" disabled={!canSimulate}>
                {busy ? 'Simulando…' : 'Simular'}
              </button>
              <p className="panel-note" id="simulator-submit-note">
                {substitutionCount === 0
                  ? 'Marca al menos una variable y escribe su valor para habilitar «Simular». La página no envía nada por tecleo: el envío es explícito.'
                  : `Se sustituirán ${substitutionCount} de 5 variables; las demás no se envían y el servicio las conserva tal como están guardadas en el lote.`}
              </p>
            </div>

            <p id="simulator-feedback" className="status-copy" role="status" aria-live="polite">
              {notice}
            </p>
          </form>
        </article>

        <article className="panel simulator-result-panel" aria-labelledby="simulator-how-title">
          <PanelHeading eyebrow="RESULTADO CONTRAFACTUAL" title="Cómo lo calculó la regla" titleId="simulator-how-title" />
          <p className="panel-note" id="simulator-how-note">
            El simulador aplica la misma regla pura que produjo el nivel guardado del lote, con las variables
            sustituidas como única entrada distinta. Es la regla, no un pronóstico: no es una predicción ni una
            probabilidad, y no se publicó ningún lote — la simulación no escribe ninguna fila, ningún evento, ninguna
            alerta ni ninguna auditoría.
          </p>
          <p id="simulator-run-status" className="status-copy" role="status" aria-live="polite">
            {run.message}
          </p>

          {result === null ? (
            <p className="panel-note" id="simulator-result-empty">
              Todavía no se ha simulado ninguna sustitución. El resultado se muestra aquí, con el nivel del mismo lote
              antes y después y los factores que la regla usó en cada caso.
            </p>
          ) : (
            <div id="simulator-result" className="simulator-result">
              <div className="simulator-outcomes">
                <div className="simulator-outcome" id="simulator-before">
                  <p className="eyebrow">ANTES · VARIABLES GUARDADAS</p>
                  <p className="simulator-level" id="simulator-before-level">
                    <Chip tone={levelTone(result.before.level)}>{levelLabel(result.before.level)}</Chip>
                  </p>
                </div>
                <div className="simulator-outcome" id="simulator-after">
                  <p className="eyebrow">DESPUÉS · VARIABLES SUSTITUIDAS</p>
                  <p className="simulator-level" id="simulator-after-level">
                    <Chip tone={levelTone(result.after.level)}>{levelLabel(result.after.level)}</Chip>
                  </p>
                </div>
              </div>

              <div className="table-wrap">
                <table id="simulator-factors">
                  <caption className="sr-only">
                    Factores del mismo lote calculados antes y después de la sustitución, con su valor y su aporte
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Variable</th>
                      <th scope="col">Antes</th>
                      <th scope="col">Después</th>
                    </tr>
                  </thead>
                  <tbody>
                    {SIMULATION_VARIABLES.map(name => (
                      <tr key={name} data-variable={name}>
                        <th scope="row">{VARIABLE_LABELS[name]}</th>
                        <td id={`simulator-before-factor-${name}`}>{factorText(factorOf(result.before, name))}</td>
                        <td id={`simulator-after-factor-${name}`}>{factorText(factorOf(result.after, name))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <DataList
                items={[
                  { label: 'Lote simulado', value: <span id="simulator-batch-id">{result.batch_id}</span> },
                  { label: 'Zona', value: <span id="simulator-result-zone">{result.zone_id}</span> },
                  {
                    label: 'Nivel guardado en el lote',
                    value: <span id="simulator-stored-level">{levelLabel(result.stored_level)}</span>,
                  },
                  { label: 'Política', value: <span id="simulator-policy-id">{result.policy.policy_id}</span> },
                  {
                    label: 'Fingerprint de parámetros',
                    value: <span id="simulator-params-hash">{result.policy.params_hash}</span>,
                  },
                  {
                    label: 'Versión del modelo',
                    value: <span id="simulator-model-version">{result.model_version}</span>,
                  },
                  {
                    label: 'Instante de cálculo',
                    value: <span id="simulator-computation-instant">{result.computation_instant}</span>,
                  },
                  { label: 'Frescura', value: <span id="simulator-freshness">{result.freshness}</span> },
                  { label: 'Aviso del servicio', value: <span id="simulator-notice">{result.notice}</span> },
                ]}
              />

              <p className="panel-note" id="simulator-result-note">
                No se publicó ningún lote: esta respuesta no escribió ningún lote, ningún evento, ninguna alerta ni
                ninguna auditoría sobre las variables guardadas. La frescura es «not_evaluated» porque la ruta fija el
                instante del lote y no decide si el dato está vigente. La política y la versión son las que el lote
                guardado registró, no las del modelo activo.
              </p>
            </div>
          )}
        </article>
      </div>
    </section>
  );
}
