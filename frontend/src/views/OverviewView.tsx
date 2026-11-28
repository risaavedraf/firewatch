// The territory overview: the consolidated metrics, the real territorial map and
// the latest published batch with its evidence.
//
// Three honesty rules shape this view:
//   1. every metric reports a real value with its own declared limit — the
//      catalogue length served by `/v1/risk/zones`, the history rows actually
//      returned for the selected zone, and the count of comunas whose level this
//      session actually read. Those levels come from two reads: the per-zone
//      `/v1/risk/latest` for the selected zone and the aggregate
//      `/v1/risk/batches` read once per session, and the "high level" card states
//      what the count means in either case;
//   2. the batch evidence is fail-closed: a payload that did not survive the
//      boundary guard is rendered as explicitly unavailable, never as a
//      plausible severity. A 404 on `latest` is "no published batch", never low;
//   3. operational validity is re-evaluated on its own bounded timer and is
//      cleared on logout, on a 401 reset and on a new selection, so a claim of
//      validity never survives the bound the batch itself declares.
//
// The element identifiers are the legacy contract preserved for N9; the visible
// copy is Spanish and is copied from the retired page.

import { useEffect, useMemo, useRef, useState } from 'react';

import {
  claimZoneBatchAggregateRead,
  clearZoneState,
  getSelectedZone,
  rememberZoneCatalogue,
  rememberZoneLevel,
  selectZone,
  useSelectedZone,
  useSessionState,
  useZoneLevels,
  useJobProgress,
} from '../app/store';
import { idleCopy } from '../app/sessionCopy';
import { MapPanel, type MapLoadState, type ZoneLevelLookup } from '../components/map/MapPanel';
import { zoneLabel } from '../components/map/projection';
import { ExecutivePanel } from '../components/executive/ExecutivePanel';
import { useExecutiveSummary } from '../components/executive/useExecutiveSummary';
import { AerialWorkstation } from '../components/territory/AerialWorkstation';
import { SectorCoverageTable } from '../components/territory/SectorCoverage';
import { DataList, Metric, PanelHeading, StatusCopy, UnimplementedNote } from '../components/ui';
import '../styles/aerial-workspace.css';
import '../styles/history-workspace.css';
import {
  batches,
  history,
  latest,
  modelVersions,
  vegetation,
  zones,
  type Failure,
  type Outcome,
} from '../core/api';
import type { SessionState } from '../core/session';
import {
  computeFactorBars,
  environmentDistribution,
  evaluateActiveModel,
  evaluateValidity,
  generateZonePdf,
  LAND_COVER_BADGE,
  landCoverView,
  latestOutcome,
  levelLabel,
  presentBatch,
  priorityNumber,
  priorityRankLabel,
  priorityStatusCopy,
  priorityView,
  sectorCoverageRows,
  validityLabel,
  zonePdfFilename,
  type ActiveModel,
  type BatchPresentation,
  type FactorBar,
} from '../domain';
import type { JobProgress } from '../domain/job-progress';
import {
  DIRECT_OBSERVATION,
  planRecommendations,
  SYNTHETIC_ENVIRONMENT_NOTICE,
  type RecommendationPlan,
} from '../domain/recommendations';
import type { RiskBatch, VegetationCatalogue, ZoneCollection, ZoneFeature } from '../types/api';

// Copy reproduced from the retired page. The operational-validity label and the
// synthetic-input notice are deliberately separate: a `published_at` timestamp
// is not observation freshness, and only the first one may say "Vigente".
const DEMO_ORIGIN = 'Sintético · Synthetic';
const DISCREPANT_ORIGIN = 'Procedencia discrepante con este entorno sintético';
// The synthetic notice is the catalogue's own constant: the recommendation panel
// marks the same batch with the same literal, so the two can never drift.
const SYNTHETIC_NOTICE = SYNTHETIC_ENVIRONMENT_NOTICE;
const MISSING_NOTICE = 'Aviso de la API ausente o inválido.';
const WRONG_ZONE_STATUS = 'La API devolvió un lote de otra zona; se descartó.';
const NO_BATCH_STATUS = 'La API no informa lotes publicados para esta zona.';
const IDLE_STATUS_NO_ZONE = 'Selecciona una zona para consultar el último lote.';
const LOADING_STATUS = 'Consultando el último lote…';
const DEMO_BATCH_STATUS =
  'Entradas de demostración sintéticas: no representan riesgo real observado. La publicación no acredita frescura de observaciones. Clasificación por regla propia no oficial.';
const READ_BATCH_STATUS = 'Lote recibido de la API · clasificación calculada por una regla propia no oficial.';

// PM-02 — the five inputs the frozen rule reads, in the rule's own order and
// vocabulary. The panel names all of them, so a variable without a reading is
// visible instead of silently absent from the list. A name outside this list is
// an extra factor the batch carried and is preserved after these five.
const CANONICAL_FACTORS: readonly string[] = [
  'temperatura',
  'humedad_relativa',
  'viento',
  'cobertura_vegetal',
  'incendios_historicos',
];
const CANONICAL_FACTOR_SET = new Set(CANONICAL_FACTORS);
const NO_READING = 'sin lectura';
const NOT_INFORMED_BY_BATCH = 'no informada en el lote';

type CatalogueState = { kind: 'ready'; collection: ZoneCollection } | { kind: 'error' };
type CataloguePhase = 'idle' | 'loading' | 'ready' | 'error' | 'cleared';

type BatchState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'failed'; message: string }
  | { kind: 'batch'; batch: RiskBatch };

type HistoryState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'ready'; count: number } | { kind: 'failed' };

// V1-P-01 / PM-12 — the land-cover layer. It is ONE read for the whole territory and
// it is independent of the selected zone, so moving the selection never re-requests
// it and a failed answer cannot be repaired by clicking another commune.
type VegetationState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ready'; catalogue: VegetationCatalogue };

interface ValidityView {
  text: string;
  nextDelayMs: number | null;
}

// One settled read of the selected zone. Keeping the zone it was read for lets
// the render derive the loading phase when the selection moves away, without an
// effect that clears state synchronously.
interface ReadState {
  zone: string;
  batch: BatchState;
  history: HistoryState;
  validity: ValidityView;
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

// `setText` in the retired page: an absent or empty field is labelled in place,
// never filled in from another field and never coerced into a plausible value.
function orUninformed(value: string | undefined): string {
  return value === undefined || value === '' ? 'No informado' : value;
}

function failureMessage(failure: Failure, action: string): string {
  if (failure.kind === 'forbidden') {
    return 'La API denegó el permiso para esta acción (403). Solicita acceso a un administrador.';
  }
  const detail = failure.status !== undefined ? `HTTP ${failure.status}` : 'sin conexión';
  return `No se pudo ${action} (${detail}).`;
}

// The first comuna the catalogue offers, in the same order the map's selector
// presents them. The retired page selected it on load; reproducing that keeps the
// metrics real from the first read instead of waiting for a click. It is only
// used to fill an empty selection (S2): a zone the reader already chose outranks
// it, and a remount must not move the selection back here.
function firstCatalogueCode(collection: ZoneCollection): string {
  const codes: string[] = [];
  for (const feature of collection.features) {
    const code = feature?.properties?.code;
    if (typeof code === 'string' && code !== '') codes.push(code);
  }
  codes.sort((left, right) => left.localeCompare(right));
  return codes.length > 0 ? codes[0] : '';
}

// The display names the loaded catalogue carries, keyed by the code the shared
// store selects on. Only a feature with a real code contributes: a label without
// a key would name a zone the chip can never select, and the format is the map's
// own `zoneLabel` so the selector and the chip can never disagree.
function catalogueZoneLabels(collection: ZoneCollection): Map<string, string> {
  const labels = new Map<string, string>();
  for (const feature of collection.features) {
    const code = feature?.properties?.code;
    if (typeof code === 'string' && code !== '') labels.set(code, zoneLabel(feature.properties));
  }
  return labels;
}

interface RiskCopy {
  pill: string;
  level: string;
  status: string;
}

// One rendered factor row. The text is the row's whole visible and announced
// content: a measured factor keeps its value, contribution and note, while an
// unknown or absent one says it has no reading and is never assigned a number.
// `widthPercent` is null whenever no bar may be drawn.
interface FactorRow {
  key: string;
  text: string;
  widthPercent: number | null;
}

function factorRowText(bar: FactorBar): string {
  const { factor } = bar;
  if (factor.known !== true) {
    return `${factor.name}: ${NO_READING}${isNonEmpty(factor.note) ? ` · ${factor.note}` : ''}`;
  }
  return `${factor.name}: ${factor.value} · contribución ${factor.contribution} · ${factor.note}`;
}

function factorRow(bar: FactorBar, key: string): FactorRow {
  return { key, text: factorRowText(bar), widthPercent: bar.widthPercent };
}

// The five canonical rows first, then any extra factor, so the panel always
// answers which of the rule's inputs lacked a reading. With no usable factor
// entry at all the list stays empty: an unavailable batch is not filled in with
// five invented rows. A duplicate canonical name is preserved as an extra row
// rather than dropped, so no reading the batch carried disappears.
function overviewFactorRows(bars: FactorBar[]): FactorRow[] {
  if (bars.length === 0) return [];
  const canonical = new Map<string, FactorBar>();
  const extras: FactorRow[] = [];
  bars.forEach((bar, index) => {
    if (CANONICAL_FACTOR_SET.has(bar.factor.name) && !canonical.has(bar.factor.name)) {
      canonical.set(bar.factor.name, bar);
      return;
    }
    extras.push(factorRow(bar, `extra-${index}`));
  });
  const rows = CANONICAL_FACTORS.map((name): FactorRow => {
    const bar = canonical.get(name);
    return bar === undefined
      ? { key: `canonical-${name}`, text: `${name}: ${NO_READING} · ${NOT_INFORMED_BY_BATCH}`, widthPercent: null }
      : factorRow(bar, `canonical-${name}`);
  });
  return [...rows, ...extras];
}

function riskCopy(batch: BatchState, session: SessionState): RiskCopy {
  switch (batch.kind) {
    case 'idle':
      return {
        pill: 'SIN CONSULTAR',
        level: 'Sin datos',
        status: session.status === 'signed-in' ? IDLE_STATUS_NO_ZONE : idleCopy(session, 'consultar la API'),
      };
    case 'loading':
      return { pill: 'SIN CONSULTAR', level: 'Sin consultar', status: LOADING_STATUS };
    case 'none':
      return { pill: 'SIN LOTE', level: 'Sin lote publicado', status: NO_BATCH_STATUS };
    case 'failed':
      return { pill: 'NO DISPONIBLE', level: 'Sin datos', status: batch.message };
    case 'batch': {
      const presentation = presentBatch(batch.batch);
      if (!presentation.valid) {
        return {
          pill: 'NO DISPONIBLE',
          level: 'NO DISPONIBLE',
          status: `Lote incompleto: ${presentation.omissions.join(', ')}. Sin evaluación validada; entorno sintético, no riesgo real observado.`,
        };
      }
      const label = levelLabel(batch.batch.risk_level);
      return { pill: label, level: label, status: batch.batch.demo === true ? DEMO_BATCH_STATUS : READ_BATCH_STATUS };
    }
  }
}

// The batch state a `latest` outcome maps to. The `rememberZoneLevel` side effect
// lives here so an unreadable batch forgets the zone instead of keeping a stale
// colour on the map.
function batchFrom(zone: string, result: Outcome<RiskBatch | null>): BatchState {
  if (result.ok) {
    if (result.data === null) {
      // A 404 is an absence the map paints neutral, never a low risk.
      rememberZoneLevel(zone, null);
      return { kind: 'none' };
    }
    const presentation = presentBatch(result.data);
    const level = presentation.valid ? presentation.level : '';
    rememberZoneLevel(zone, level === '' ? null : level);
    return { kind: 'batch', batch: result.data };
  }
  const failure = result.failure;
  if (failure.reason === 'zone_mismatch') {
    rememberZoneLevel(zone, null);
    return { kind: 'failed', message: WRONG_ZONE_STATUS };
  }
  if (failure.status !== undefined) {
    const outcome = latestOutcome(failure.status);
    if (outcome === 'unauthorized') return { kind: 'loading' };
    if (outcome === 'forbidden') return { kind: 'failed', message: failureMessage(failure, 'consultar el lote') };
    if (outcome === 'no-published-batch') {
      rememberZoneLevel(zone, null);
      return { kind: 'none' };
    }
  }
  // A body that did not survive the boundary guard is explicitly unavailable,
  // never a plausible partial batch.
  if (failure.kind === 'malformed') {
    return { kind: 'failed', message: 'La API devolvió un lote ilegible; se muestra como no disponible.' };
  }
  return { kind: 'failed', message: failureMessage(failure, 'consultar el lote') };
}

function historyFrom(result: Outcome<RiskBatch[]>): HistoryState {
  return result.ok ? { kind: 'ready', count: result.data.length } : { kind: 'failed' };
}

// PM-18 — what the recommendation panel states when there is nothing to compose.
// The catalogue is derived from the last published batch, so a read that is
// absent, still in flight or failed has no suggestions to offer: the panel names
// that state instead of presenting a suggestion as if a zone had been read.
function recommendationStatus(
  batch: BatchState,
  session: SessionState,
  plan: RecommendationPlan | null,
): string {
  switch (batch.kind) {
    case 'idle':
      return session.status === 'signed-in'
        ? 'Selecciona una zona para ver las recomendaciones de prevención.'
        : idleCopy(session, 'ver las recomendaciones de prevención');
    case 'loading':
      return 'Esperando el último lote: las sugerencias se derivan de su nivel y de sus factores.';
    case 'none':
      return 'Sin lote publicado: no hay nivel ni factores de los que derivar sugerencias.';
    case 'failed':
      return `${batch.message} Sin lote disponible, la ficha no deriva sugerencias.`;
    case 'batch':
      // An unclassified level keeps the base pair only; saying that out loud is
      // the difference between a shorter list and a list ordered on a severity the
      // rule refused to state.
      return plan !== null && (plan.level === '' || plan.level === 'desconocido')
        ? 'Sin nivel clasificado, la ficha no ordena sugerencias por aporte de variables.'
        : 'Sugerencias compuestas desde el nivel informado y desde los factores con lectura del último lote.';
  }
}

// V1-P-01 / PM-12 — what the sector panel states. The sentence is built from the
// rows the layer actually answered: a failed or empty read says so and the table
// renders no row, because an invented comuna would be a coverage nobody served.
function vegetationStatus(
  layer: VegetationState,
  session: SessionState,
  signedIn: boolean,
  sessionClosed: boolean,
): string {
  switch (layer.kind) {
    case 'idle':
      if (signedIn) return 'Consultando la capa de vegetación…';
      return sessionClosed
        ? 'La capa de vegetación se consulta de nuevo al iniciar sesión; no se conserva ninguna lectura anterior.'
        : idleCopy(session, 'consultar la capa de vegetación');
    case 'loading':
      return 'Consultando la capa de vegetación…';
    case 'failed':
      return 'No se pudo consultar la capa de vegetación: la API no respondió o la respuesta no cumple el contrato. La tabla queda sin filas y no se sustituye por datos inventados.';
    case 'ready': {
      const rows = sectorCoverageRows(layer.catalogue);
      if (rows.length === 0) {
        return 'La capa de vegetación respondió sin comunas: la tabla queda sin filas y no se sustituye por datos inventados.';
      }
      const distribution = environmentDistribution(layer.catalogue)
        .map(entry => `${entry.label} ${entry.count}`)
        .join(', ');
      return `Capa de cobertura de suelo servida por /v1/risk/vegetation: ${rows.length} comunas del catálogo (${distribution}). Es sintética y declarada, así que no sustituye la variable escalar de cobertura vegetal que lee la regla.`;
    }
  }
}

// Operational validity is a property of the batch window. The label is computed
// here, never during render: `Date.now()` is impure, and this runs from async
// callbacks and the bounded timer instead.
function computeValidity(batch: BatchState): ValidityView {
  if (batch.kind !== 'batch') return { text: 'Sin consultar', nextDelayMs: null };
  const decision = evaluateValidity(batch.batch, Date.now());
  return { text: validityLabel(decision), nextDelayMs: decision.nextDelayMs };
}

// T2 — what the workstation may say about the session's single batch request. It
// reports only what the jobs view published through the store, named with the
// catalogue's own label, and it never infers progress from the collection: an
// unread zone is not a pending one, and a pending one is not a missing reading.
function batchRequestText(progress: JobProgress, progressZone: string, session: SessionState): string {
  const zone = progressZone === '' ? 'la zona seleccionada' : progressZone;
  switch (progress.kind) {
    case 'processing':
      return `Lote en proceso para ${zone}: el servicio todavía no publica su nivel.`;
    case 'unconfirmed':
      return `Lote solicitado para ${zone} sin confirmación de publicación.`;
    case 'failed':
      return `La solicitud de lote para ${zone} falló.`;
    default:
      return session.status === 'signed-in'
        ? 'Sin solicitud en curso: esta sesión no tiene un lote en proceso.'
        : idleCopy(session, 'solicitar y seguir un lote');
  }
}

// T2 — the kind of answer the selected zone's read settled on, never its level.
// The level and its evidence belong to the card beside the map; repeating a
// classification in two places is how two claims start to disagree.
function batchResultText(batch: BatchState, presentation: BatchPresentation | null): string {
  switch (batch.kind) {
    case 'idle':
      return 'Sin consultar';
    case 'loading':
      return 'Consultando el último lote';
    case 'none':
      return 'Sin lote publicado';
    case 'failed':
      return 'No disponible';
    case 'batch':
      return presentation !== null && presentation.valid ? 'Lote publicado' : 'Lote no disponible';
  }
}

// PM-14 — la ficha se compone en el navegador y se guarda por las mismas dos
// costuras que la exportación del historial: el Blob que recibe `createObjectURL`
// y el ancla con `download`. Nada sale del cliente, no hay petición y no hay
// navegación.
const PDF_REVOKE_DELAY_MS = 40;

function saveZonePdf(bytes: Uint8Array, filename: string): void {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const blob = new Blob([copy], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.hidden = true;
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), PDF_REVOKE_DELAY_MS);
  }
}

export function OverviewView() {
  const session = useSessionState();
  const selectedZone = useSelectedZone();
  const levels = useZoneLevels();
  // The batch fact the jobs view publishes. The map reads it through this view so
  // a comuna waiting for its batch is not described as a comuna without data.
  const jobProgress = useJobProgress();
  const signedIn = session.status === 'signed-in';

  const [catalogue, setCatalogue] = useState<CatalogueState | null>(null);
  const [read, setRead] = useState<ReadState | null>(null);
  const [activeModel, setActiveModel] = useState<ActiveModel | null>(null);
  // V1-P-01 / PM-12 — the land-cover layer read. It is independent of the selection.
  const [layer, setLayer] = useState<VegetationState>({ kind: 'idle' });
  // PM-01 / T4 — the server summary is one read for the mounted view, owned by
  // the shared hook so the executive route cannot double-request it. Its failure
  // is a stated outcome inside the panel, never zeros.
  const executiveState = useExecutiveSummary(signedIn);
  const [sessionClosed, setSessionClosed] = useState(false);
  // PM-14 — el resultado de la única acción de la ficha. Vive en la región viva de
  // la tarjeta, así que un lector de pantalla escucha el guardado o su fallo.
  const [fichaStatus, setFichaStatus] = useState('');
  // Whether a real session was ever established. It separates "never connected"
  // (the count is still unknown, `—`) from "the session was closed" (the count
  // is explicitly uninformed), which the retired page distinguished the same way.
  const hadSession = useRef(false);

  // The catalogue: read once per session and abandoned the moment the session
  // closes, so a late answer cannot repopulate a view that no longer exists.
  useEffect(() => {
    if (!signedIn) return undefined;
    const controller = new AbortController();
    let active = true;
    void (async () => {
      const result = await zones(controller.signal);
      if (!active) return;
      if (!result.ok) {
        if (result.failure.reason === 'superseded' || result.failure.kind === 'unauthorized') return;
        setCatalogue({ kind: 'error' });
        return;
      }
      setCatalogue({ kind: 'ready', collection: result.data });
      // The labels are recorded with the selection, never before it: the chip may
      // only name a zone whose catalogue this session actually loaded.
      rememberZoneCatalogue(catalogueZoneLabels(result.data));
      // S2 — the auto-selection only fills an EMPTY selection. This effect runs on
      // every mount of this view, so selecting unconditionally replaced the zone
      // the reader had chosen with the first catalogue code (Valparaíso, 05101)
      // as soon as they left the map and came back. The selected zone is read from
      // the store rather than from this render so the effect keeps running once
      // per session instead of once per selection.
      if (getSelectedZone() === '') {
        const first = firstCatalogueCode(result.data);
        if (first !== '') selectZone(first);
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [signedIn]);

  // S1/S4 — one aggregate read per session, so every comuna's last published
  // level is on the map without a click. It runs alongside the catalogue read and
  // is claimed through the store, which is what makes it per-session rather than
  // per-mount: coming back to this view finds the claim taken and issues nothing,
  // while a new session claims it again.
  //
  // Each element is validated with the same fail-closed `presentBatch` the risk
  // panel uses, and only a valid one may set a level. An element that fails
  // validation, and a zone the answer omits, are left alone: never a level, never
  // a default, never `bajo`. A failed, malformed, 401/403 or 503 answer paints
  // nothing at all, leaving the map exactly as the per-zone reads leave it.
  //
  // The read deliberately carries no view-lifetime abort: it belongs to the
  // session, so leaving the view mid-flight must still colour the map for the
  // next visit. The transport's own fences protect it — the bounded deadline and
  // the token check that discards an answer issued before a logout.
  useEffect(() => {
    if (!signedIn) return;
    if (!claimZoneBatchAggregateRead()) return;
    void (async () => {
      const result = await batches();
      if (!result.ok) return;
      for (const entry of result.data) {
        const presentation = presentBatch(entry);
        if (!presentation.valid || presentation.level === '') continue;
        rememberZoneLevel(entry.zone_id, presentation.level);
      }
    })();
  }, [signedIn]);

  // V1-P-01 / PM-12 — the land-cover layer, one read for the whole territory. Its
  // failure owns only the sector panel: the map, the batch card and the executive
  // summary keep whatever their own reads answered. The state is reset when the
  // session ends, so a closed session never keeps describing a layer.
  useEffect(() => {
    if (!signedIn) return undefined;
    const controller = new AbortController();
    let active = true;
    // No `setState` on entry: the pending phase is derived during render, exactly as
    // the per-zone reads derive theirs, so this effect only settles. Setting it here
    // would render twice for one read and trip the hooks rule for a cascading render.
    void (async () => {
      const result = await vegetation(controller.signal);
      if (!active) return;
      setLayer(result.ok ? { kind: 'ready', catalogue: result.data } : { kind: 'failed' });
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [signedIn]);

  // One selection reads both endpoints. The transport fences every response by
  // its own sequence and by the token it was issued with, and this effect's
  // cleanup aborts whatever the previous selection started.
  useEffect(() => {
    if (!signedIn || selectedZone === '') return undefined;
    const controller = new AbortController();
    let active = true;
    void (async () => {
      const [latestResult, historyResult] = await Promise.all([
        latest(selectedZone, controller.signal),
        history(selectedZone, controller.signal),
      ]);
      if (!active) return;
      // A superseded or aborted answer belongs to a request the view already
      // replaced: it owns nothing and must not repaint the panel.
      if (latestResult.ok === false && (latestResult.failure.reason === 'superseded' || latestResult.failure.reason === 'aborted')) {
        return;
      }
      const batch = batchFrom(selectedZone, latestResult);
      setRead({ zone: selectedZone, batch, history: historyFrom(historyResult), validity: computeValidity(batch) });
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [signedIn, selectedZone]);

  // T13 — the active model version, read from the model registry. The read is
  // independent of the zone chain: a registry that is unreachable or does not
  // report an active version is stated, never replaced with the batch's version
  // as if it were the active one.
  useEffect(() => {
    if (!signedIn) return undefined;
    const controller = new AbortController();
    let active = true;
    void (async () => {
      const outcome = await modelVersions(controller.signal);
      if (!active) return;
      setActiveModel(outcome.ok ? evaluateActiveModel(outcome.data) : evaluateActiveModel(null));
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [signedIn]);

  // Ending a session clears everything the private view was describing. The
  // shared zone state is cleared here as well so the view stays honest even when
  // it is mounted without the session binding installed at application start.
  useEffect(() => {
    if (signedIn) {
      hadSession.current = true;
      return;
    }
    if (!hadSession.current) return;
    hadSession.current = false;
    clearZoneState();
    setCatalogue(null);
    setRead(null);
    setActiveModel(null);
    setLayer({ kind: 'idle' });
    setSessionClosed(true);
  }, [signedIn]);

  // The bounded validity re-evaluation. `evaluateValidity` caps the delay at
  // `timing.validityMaxDelayMs` and expires the claim `timing.validitySkewMs`
  // early, so this single chained timer re-renders the label no later than the
  // bound the batch declares. Replacing the batch or the selection clears it.
  const currentRead = selectedZone !== '' && read !== null && read.zone === selectedZone ? read : null;
  const validityBatch = currentRead !== null && currentRead.batch.kind === 'batch' ? currentRead.batch.batch : null;
  const validityDelay = currentRead !== null ? currentRead.validity.nextDelayMs : null;
  useEffect(() => {
    if (!signedIn || validityBatch === null || validityDelay === null) return undefined;
    const timer = setTimeout(() => {
      setRead(previous =>
        previous === null || previous.zone !== selectedZone
          ? previous
          : { ...previous, validity: computeValidity(previous.batch) },
      );
    }, validityDelay);
    return () => clearTimeout(timer);
  }, [validityBatch, validityDelay, signedIn, selectedZone]);

  // The store hands the view a `ReadonlyMap`; `MapPanel` reads a single
  // `levelFor`. An unread level stays `''`, which the map paints neutral. The
  // map's contract types the absent level as `''` rather than `null`.
  const zoneLevelLookup = useMemo(
    (): ZoneLevelLookup => ({ levelFor: (code: string) => levels.get(code) ?? '' }),
    [levels],
  );

  // The catalogue's display names, keyed the way the summary reports zones. The
  // panel names a critical zone when this catalogue knows it and falls back to
  // the code the summary sent when it does not.
  const zoneNames = useMemo(
    (): ReadonlyMap<string, string> =>
      catalogue !== null && catalogue.kind === 'ready'
        ? catalogueZoneLabels(catalogue.collection)
        : new Map<string, string>(),
    [catalogue],
  );

  const highCount = useMemo(() => {
    let count = 0;
    for (const level of levels.values()) if (level === 'alto') count += 1;
    return count;
  }, [levels]);

  const cataloguePhase: CataloguePhase =
    catalogue !== null ? catalogue.kind : signedIn ? 'loading' : sessionClosed ? 'cleared' : 'idle';
  const features = catalogue !== null && catalogue.kind === 'ready' ? catalogue.collection.features : [];
  const selectedFeature: ZoneFeature | null =
    selectedZone === '' ? null : (features.find(feature => feature.properties.code === selectedZone) ?? null);

  const zoneCountText =
    cataloguePhase === 'ready'
      ? String(features.length)
      : cataloguePhase === 'error' || cataloguePhase === 'cleared'
        ? 'No informado'
        : '—';
  const mapCollection = catalogue !== null && catalogue.kind === 'ready' ? catalogue.collection : null;
  const mapState: MapLoadState =
    cataloguePhase === 'ready' ? 'ready' : cataloguePhase === 'loading' ? 'loading' : cataloguePhase === 'error' ? 'error' : 'idle';

  const currentBatch: BatchState =
    selectedZone === ''
      ? { kind: 'idle' }
      : currentRead === null
        ? { kind: 'loading' }
        : currentRead.batch;
  const currentHistory: HistoryState =
    selectedZone === ''
      ? { kind: 'idle' }
      : currentRead === null
        ? { kind: 'loading' }
        : currentRead.history;

  const risk = riskCopy(currentBatch, session);
  const historyText = currentHistory.kind === 'ready' ? String(currentHistory.count) : '—';
  const validityText = currentRead === null ? 'Sin consultar' : currentRead.validity.text;

  const batchData = currentBatch.kind === 'batch' ? currentBatch.batch : null;
  const presentation = batchData === null ? null : presentBatch(batchData);
  const factorBars = batchData === null ? [] : computeFactorBars(batchData);
  const factorRows = overviewFactorRows(factorBars);
  const showFactorOmission = presentation !== null && presentation.omissions.includes('factores');
  // V1-P-02 / PM-11 — el contexto regional que el backend calculó sobre el lote
  // publicado. No se recalcula aquí: si la API no lo sirvió, la ficha lo dice en
  // vez de derivar un puesto del nivel de riesgo.
  const zonePriority = priorityView(batchData?.priority);
  // V1-P-01 / PM-12 — la cobertura de suelo del lote publicado. Se lee del miembro
  // que la API adjuntó al lote; no se pide a la capa por la comuna seleccionada,
  // porque entonces la ficha mostraría un dato que el lote no trajo.
  const zoneLandCover = landCoverView(batchData?.land_cover);
  // The pending phase is derived, not stored: an idle layer inside an open session
  // IS the read in flight, and the settled state is the only one the effect writes.
  const layerView: VegetationState = layer.kind === 'idle' && signedIn ? { kind: 'loading' } : layer;
  const sectorRows = layer.kind === 'ready' ? sectorCoverageRows(layer.catalogue) : [];
  const layerStatus = vegetationStatus(layerView, session, signedIn, sessionClosed);
  const layerBadge = layer.kind === 'ready' ? LAND_COVER_BADGE : 'SIN CONSULTAR';
  const priorityPlaced = zonePriority.kind === 'ranked';

  // T2 — la estación de trabajo. Cada frase es un hecho que esta vista ya leyó: la
  // única solicitud de lote de la sesión, la zona compartida, el tipo de respuesta
  // del último lote y cuántas comunas tienen un nivel realmente leído. Ninguna
  // crea una solicitud, ninguna inventa un número y ninguna repite el nivel: la
  // clasificación se queda en la ficha que la sostiene.
  const selectedZoneName = selectedZone === '' ? '' : zoneNames.get(selectedZone) ?? selectedZone;
  const progressZoneName = jobProgress.zone === '' ? '' : zoneNames.get(jobProgress.zone) ?? jobProgress.zone;
  const workstation = {
    requestText: batchRequestText(jobProgress, progressZoneName, session),
    // El mapa ya anuncia el progreso de la zona que muestra; la barra solo toma
    // la región viva cuando esa solicitud no es la que el mapa está contando.
    announceRequest: jobProgress.zone !== '' && jobProgress.zone !== selectedZone,
    zoneText: selectedZoneName === '' ? 'Sin seleccionar' : selectedZoneName,
    resultText: batchResultText(currentBatch, presentation),
    levelsText: !signedIn ? 'Sin consultar' : cataloguePhase === 'loading' ? '—' : String(levels.size),
  };

  // PM-18 — the catalogue composes from the payload the card already accepted. A
  // batch the fail-closed guard rejected has no validated level, so the catalogue
  // is told exactly that: it falls back to the closed pair and names the level as
  // unclassified, never reusing a severity this page refuses to display.
  const recommendationPlan =
    batchData === null
      ? null
      : planRecommendations({
          risk_level: presentation !== null && presentation.valid ? batchData.risk_level : null,
          factors: batchData.factors,
          demo: batchData.demo,
        });
  const recommendationStateText = recommendationStatus(currentBatch, session, recommendationPlan);
  const recommendationBadge = recommendationPlan === null ? risk.pill : recommendationPlan.levelLabel;

  // PM-14 — la ficha por zona. Se habilita solo cuando hay algo verdadero que
  // describir: una zona seleccionada y un lote publicado. El generador repite el
  // mismo guardián fail-closed de la tarjeta, así que un lote que esta página
  // rechaza se exporta como `SIN CLASIFICAR` con sus omisiones nombradas, nunca
  // como una severidad que la tarjeta se niega a mostrar.
  const fichaBlocked = selectedZone === '' || batchData === null;
  const downloadFicha = (): void => {
    if (fichaBlocked) return;
    // La identidad sale de la comuna cargada; si el catálogo aún no la tiene, el
    // código seleccionado sigue nombrando la zona, que es lo único que se sabe.
    const zone = selectedFeature !== null ? selectedFeature.properties : { code: selectedZone };
    const filename = zonePdfFilename(zone.code ?? selectedZone);
    try {
      saveZonePdf(
        generateZonePdf({ zone, batch: batchData, geometry: selectedFeature?.geometry ?? null }),
        filename,
      );
      setFichaStatus(`${filename} guardado con la ficha de la zona seleccionada.`);
    } catch {
      // Un navegador que rechaza el guardado es un resultado declarado, nunca un
      // éxito vacío.
      setFichaStatus('No fue posible guardar la ficha PDF en este navegador.');
    }
  };

  const originText = batchData === null ? 'Sin consultar' : batchData.demo === true ? DEMO_ORIGIN : DISCREPANT_ORIGIN;
  const noticeText =
    batchData === null
      ? SYNTHETIC_NOTICE
      : `${SYNTHETIC_NOTICE} ${isNonEmpty(batchData.notice) ? batchData.notice : MISSING_NOTICE}`;
  const rationaleText =
    batchData === null
      ? 'Sin consultar'
      : isNonEmpty(batchData.rationale)
        ? batchData.rationale
        : 'Justificación ausente o inválida';
  const policyText =
    batchData === null
      ? 'Sin consultar'
      : presentation !== null && presentation.policyValid && batchData.policy.parameters
        ? `${batchData.policy.policy_id} · hash informado (no verificado): ${batchData.policy.params_hash} · ${Object.entries(
            batchData.policy.parameters,
          )
            .map(([key, value]) => `${key}=${value}`)
            .join('; ')}`
        : 'Política ausente o inválida';
  // After a batch settles, a field the service omitted is labelled in place.
  const batchField = (value: string | undefined): string => (batchData === null ? 'Sin consultar' : orUninformed(value));

  // T13 — the active model version and its `synthetic` mark. The mark is shown
  // only when the registry declares it: an undeclared mark is its own state, and
  // an unreachable registry is stated instead of a plausible version.
  const modelBadge =
    activeModel === null
      ? 'SIN CONSULTAR'
      : !activeModel.available
        ? 'NO DISPONIBLE'
        : activeModel.synthetic === true
          ? 'SINTÉTICO'
          : activeModel.synthetic === false
            ? 'NO SINTÉTICO'
            : 'NO DECLARADO';
  const modelStatusText = activeModel === null ? 'Sin consultar el registro de modelos.' : activeModel.label;

  return (
    <section className="view" id="overview" data-view="overview" aria-labelledby="overview-title">
      <div className="intro-row">
        <div>
          <p className="eyebrow">VISTA TERRITORIAL · VALPARAÍSO</p>
          <h2 id="overview-title">Estado de la zona</h2>
          <p className="subheading">Consulta de lote y trazabilidad disponible desde el servicio FireWatch.</p>
        </div>
        <span className="neutral-tag" id="input-scope-badge">
          ENTRADA SINTÉTICA · SIN CALIBRACIÓN
        </span>
      </div>

      {/*
        T2 — la vista aérea. El tablero aprobado pone el mapa como lienzo, una
        estación de trabajo a su lado y la lectura junto al lienzo; esta
        composición hace exactamente eso con los datos que la vista ya lee. El
        mapa abre la composición, la barra de trabajo se apoya en su columna y la
        ficha del último lote queda en la misma columna que el mapa, debajo.
      */}
      <div className="aerial-workspace">
        <section className="aerial-canvas" aria-label="Mapa de trabajo del territorio">
          <MapPanel
            collection={mapCollection}
            loadState={mapState}
            selectedCode={selectedZone}
            zoneLevels={zoneLevelLookup}
            onSelect={selectZone}
            sessionReason={session.reason}
            jobProgress={jobProgress}
          />
        </section>

        <AerialWorkstation
          requestText={workstation.requestText}
          announceRequest={workstation.announceRequest}
          zoneText={workstation.zoneText}
          resultText={workstation.resultText}
          levelsText={workstation.levelsText}
        />

        <article className="panel risk-panel aerial-result">
          <PanelHeading
            eyebrow="ESTADO DEL RIESGO"
            title="Último lote publicado"
            badge={
              <span className="risk-pill" id="risk-pill">
                {risk.pill}
              </span>
            }
          />
          <StatusCopy id="risk-status">{risk.status}</StatusCopy>
          <div className="risk-state">
            <span className="risk-symbol" aria-hidden="true">
              —
            </span>
            <div>
              <strong id="risk-level">{risk.level}</strong>
              <small>Clasificación informada por el backend</small>
            </div>
          </div>
          <DataList
            items={[
              { label: 'Código CUT', value: <span id="zone-code">{orUninformed(selectedFeature?.properties.code)}</span> },
              { label: 'Comuna', value: <span id="zone-name">{orUninformed(selectedFeature?.properties.name)}</span> },
              {
                label: 'Provincia',
                value: <span id="zone-province">{orUninformed(selectedFeature?.properties.province)}</span>,
              },
            ]}
          />
          <p id="batch-origin">{originText}</p>
          <p id="batch-notice">{noticeText}</p>
          <StatusCopy id="batch-validity">{validityText}</StatusCopy>
          {/* With no reading and no omission the card has nothing to put under a
              "Factores" heading, and a heading over an empty list reads as a
              broken widget. The artboard names no heading here: it states the
              absence in one muted sentence, which is what the card does. */}
          {factorRows.length > 0 || showFactorOmission ? (
            <>
              <h4>Factores</h4>
              <p id="factor-rule-note" className="panel-note">
                <strong>Cómo lo calculó la regla.</strong> La contribución de cada variable es aritmética de la regla
                sobre el lote publicado: no es una causa del incendio ni un pronóstico.
              </p>
              <ul id="risk-factors">
                {factorRows.map((row) => (
                  <li key={row.key}>
                    {row.text}
                    {row.widthPercent !== null ? (
                      <div className="factor-track">
                        <span style={{ width: `${row.widthPercent}%` }} />
                      </div>
                    ) : null}
                  </li>
                ))}
                {showFactorOmission ? (
                  <li>Factores ausentes o inválidos; solo se muestran entradas válidas.</li>
                ) : null}
              </ul>
            </>
          ) : (
            <p className="panel-note">No hay factores disponibles para esta comuna.</p>
          )}
          <h4>Cómo lo calculó la regla</h4>
          <p id="risk-rationale">{rationaleText}</p>
          <h4>Política informada</h4>
          <p id="risk-policy">{policyText}</p>
          {/*
            V1-P-02 / PM-11 — la prioridad regional. Es la única parte de la ficha
            que no proviene del clasificador: la calcula el backend sobre el lote
            publicado, con la tabla ponderada ratificada, y aquí solo se muestra.
          */}
          <h4>Prioridad regional</h4>
          <div className="zone-priority" id="zone-priority" data-status={zonePriority.kind}>
            <DataList
              items={[
                {
                  label: 'Prioridad',
                  value: <span id="zone-priority-score">{priorityPlaced ? priorityNumber(zonePriority.priorityScore) : '—'}</span>,
                },
                {
                  label: 'Puesto regional',
                  value: (
                    <span id="zone-priority-rank">
                      {priorityPlaced ? priorityRankLabel(zonePriority.rank, zonePriority.total) : '—'}
                    </span>
                  ),
                },
                {
                  label: 'Exposición',
                  value: (
                    <span id="zone-priority-exposure">
                      {zonePriority.kind === 'absent' ? '—' : priorityNumber(zonePriority.exposureScore)}
                    </span>
                  ),
                },
                {
                  label: 'Elementos ficticios declarados',
                  value: (
                    <span id="zone-priority-assets">
                      {zonePriority.kind === 'absent' ? '—' : priorityNumber(zonePriority.assets)}
                    </span>
                  ),
                },
              ]}
            />
            <StatusCopy id="zone-priority-status">{priorityStatusCopy(zonePriority)}</StatusCopy>
            {zonePriority.kind === 'absent' ? null : (
              <p id="zone-priority-summary" className="panel-note">
                {zonePriority.summary}
              </p>
            )}
          </div>
          <DataList
            items={[
              { label: 'Estado del dato', value: <span id="data-status">{batchField(batchData?.data_status)}</span> },
              { label: 'Versión', value: <span id="model-version">{batchField(batchData?.model_version)}</span> },
              { label: 'Vigencia hasta', value: <span id="valid-until">{batchField(batchData?.valid_until)}</span> },
              { label: 'Identificador', value: <span id="batch-id">{batchField(batchData?.id)}</span> },
            ]}
          />
          <h4>Ficha PDF</h4>
          <div className="ficha-pdf">
            <button
              id="zone-pdf-download"
              className="secondary-button"
              type="button"
              disabled={fichaBlocked}
              aria-describedby="zone-pdf-note"
              onClick={downloadFicha}
            >
              Descargar ficha PDF
            </button>
            <p className="panel-note" id="zone-pdf-note">
              La ficha PDF se compone en este navegador con el último lote, la geometría de la comuna y las
              recomendaciones que esta página ya muestra: incluye el nivel de riesgo, «Cómo lo calculó la regla», el mapa
              vectorial, la fecha y, cuando la fuente lo declara, la marca de datos sintéticos. No consulta la API, no
              crea acciones y no envía nada a ningún servicio.
            </p>
          </div>
          <StatusCopy id="zone-pdf-status">{fichaStatus}</StatusCopy>
          <UnimplementedNote>
            Cobertura por sector: la API no publica lecturas ni un porcentaje de cobertura por sector. Su unidad es la
            comuna (código CUT), así que esta ficha no muestra un porcentaje de cobertura.
          </UnimplementedNote>
          {/*
            V1-P-01 / PM-12 — la cobertura de suelo y el entorno que el lote
            publicado trae como miembro aditivo. La capa es sintética y declarada,
            no una medición satelital, y no sustituye la variable escalar
            `cobertura_vegetal` que la regla leyó: esa sigue en «Factores» y aquí
            no se recalcula ni se reemplaza.
          */}
          <h4>Cobertura de suelo y entorno</h4>
          <div className="zone-land-cover" id="zone-land-cover" data-status={zoneLandCover.kind}>
            <span className="neutral-tag" id="zone-land-cover-badge">
              {LAND_COVER_BADGE}
            </span>
            <DataList
              items={[
                {
                  label: 'Clase de entorno',
                  value: (
                    <span id="zone-land-cover-environment">
                      {zoneLandCover.kind === 'present' ? zoneLandCover.environment : '—'}
                    </span>
                  ),
                },
                {
                  label: 'NDVI medio',
                  value: (
                    <span id="zone-land-cover-ndvi">
                      {zoneLandCover.kind === 'present' ? zoneLandCover.ndviMean : '—'}
                    </span>
                  ),
                },
                {
                  label: 'Rango NDVI',
                  value: (
                    <span id="zone-land-cover-range">
                      {zoneLandCover.kind === 'present' ? zoneLandCover.ndviRange : '—'}
                    </span>
                  ),
                },
                {
                  label: 'Clase dominante',
                  value: (
                    <span id="zone-land-cover-dominant">
                      {zoneLandCover.kind === 'present'
                        ? `${zoneLandCover.dominant.label} (${zoneLandCover.dominant.percent})`
                        : '—'}
                    </span>
                  ),
                },
              ]}
            />
            <StatusCopy id="zone-land-cover-status">
              {zoneLandCover.kind === 'present' ? zoneLandCover.summary : zoneLandCover.reason}
            </StatusCopy>
          </div>
        </article>
      </div>

      {/*
        PM-01 — el resumen del servidor sigue siendo la respuesta de todo el
        territorio y su fallo solo posee esta sección. T2 lo coloca después de la
        vista aérea: el mapa abre la ruta y el resumen del servidor queda como su
        lectura agregada. T4 posee el diseño de esta sección.
      */}
      <ExecutivePanel state={executiveState} zoneNames={zoneNames} batchIsDemo={batchData?.demo === true} />

      {/*
        V1-P-01 / PM-12 — la tabla de sectores. Una fila por comuna del catálogo
        servido por `/v1/risk/vegetation`, con su clase de entorno, su NDVI medio, su
        cobertura dominante y su procedencia declarada. Un fallo de ESTA lectura solo
        posee este panel: no hay filas, el estado lo dice y ningún dato se inventa.
        Se coloca después del resumen ejecutivo para no mover la banda que T4 fijó
        como primer hermano tras la vista aérea.
      */}
      <article className="panel" id="sector-coverage" aria-labelledby="sector-coverage-title">
        <PanelHeading
          eyebrow="COBERTURA VEGETAL"
          titleId="sector-coverage-title"
          title="Tabla de sectores"
          badge={
            <span className="neutral-tag" id="vegetation-badge">
              {layerBadge}
            </span>
          }
        />
        <StatusCopy id="vegetation-status">{layerStatus}</StatusCopy>
        <SectorCoverageTable rows={sectorRows} />
        <p className="panel-note" id="sector-coverage-note">
          Una fila por comuna del catálogo. La capa es sintética y declarada (<code>SINTETICO_SEED_V1</code>): no es
          una medición satelital, no trae instante de captura y no establece frescura. Es complementaria: la variable
          escalar <code>cobertura_vegetal</code> sigue siendo el insumo de vegetación entre las cinco variables
          canónicas del clasificador, y esta tabla no la recalcula ni la sustituye.
        </p>
      </article>

      <section className="metrics-grid metrics-three" aria-label="Resumen real de la sesión">
        <Metric
          label="Zonas analizadas"
          icon="zones"
          value={<span id="zone-count">{zoneCountText}</span>}
          note={
            <>
              Comunas del catálogo servido por <code>/v1/risk/zones</code>: features reales, no un valor copiado.
            </>
          }
        />
        <Metric
          label="Lotes en el historial"
          icon="batches"
          value={<span id="metric-batches">{historyText}</span>}
          note={
            <>
              Registros que <code>/v1/risk/history</code> devolvió para la zona seleccionada; sin agregar métricas
              calculadas.
            </>
          }
        />
        <Metric
          label="Comunas con nivel alto"
          icon="attention"
          attention
          value={<span id="metric-high">{highCount}</span>}
          note={
            <>
              Cuenta solo las comunas cuyo último lote esta página leyó y validó: lo que devolvió{' '}
              <code>/v1/risk/batches</code> al iniciar la sesión, más la zona seleccionada. Si esa lectura agregada falla,
              la cuenta refleja únicamente lo leído por zona. Una comuna sin lote publicado, o cuyo lote no pasó la
              validación, queda sin nivel y no se cuenta.
            </>
          }
        />
      </section>

      <article className="panel model-panel" id="model-panel" aria-labelledby="model-panel-title">
        <PanelHeading
          eyebrow="REGISTRO Y LOTE"
          titleId="model-panel-title"
          title="Versión de modelo activa"
          badge={
            <span className="neutral-tag" id="model-synthetic">
              {modelBadge}
            </span>
          }
        />
        <StatusCopy id="model-status">{modelStatusText}</StatusCopy>
        {/*
          T5 — board 20 states the status first, then the scope of the screen,
          then what it does not publish. The registry serves two version facts and
          a synthetic mark; it serves no variable inventory, no units, no metrics
          and no source table, so those are named as absent instead of drawn. The
          two rows and their identifiers are the shipped ones.
        */}
        <dl className="data-list compact">
          <div>
            <dt>Versión activa (registro)</dt>
            <dd id="model-active-version">
              {activeModel !== null && activeModel.available ? activeModel.version : 'No informada'}
            </dd>
          </div>
          <div>
            <dt>Versión del último lote</dt>
            <dd id="model-batch-version">{batchField(batchData?.model_version)}</dd>
          </div>
        </dl>
        <div className="model-scope">
          <h4>Qué sí y qué no hace esta ficha</h4>
          <ul id="model-scope">
            <li>
              <strong>Una lectura:</strong> el registro de modelos por <code>/v1/models</code>; la versión del lote llega
              con el lote publicado que esta página ya leyó.
            </li>
            <li>
              <strong>Ninguna métrica:</strong> no enumera variables, unidades ni métricas del modelo, y no ejecuta la
              regla ni reproduce su cálculo.
            </li>
            <li>
              <strong>Ningún dato simulado:</strong> no escribe nada, no publica un lote y no presenta una versión como
              la que clasificó un lote que no la nombra.
            </li>
          </ul>
        </div>
        <p className="panel-note" id="model-panel-note">
          La marca sintética se reproduce tal como el servicio la declara. Una versión sin marca declarada se muestra
          como no declarada; la página no la supone no sintética. La fila del registro es la versión que el registro
          presenta como activa; la fila del lote es la versión que de verdad lo clasificó, y ambas pueden diferir. Una
          activación o su reversión rige para las publicaciones que resuelven su clasificador después de esa llamada:
          las que ya estaban en curso conservan la instantánea que resolvieron. Antes de una activación explícita, el
          clasificador en uso es el que fija <code>MODEL_ID</code> al arrancar, y que una fila del registro esté
          sembrada como activa no prueba que el servicio la haya usado.
        </p>
      </article>

      {/*
        PM-18 — the zone card suggests from the written catalogue. The list is
        composed by a pure rule from the batch already shown; it creates no action,
        issues no request and stores nothing, so the only control here is reading.
      */}
      <article className="panel" id="recommendation-panel" aria-labelledby="recommendation-title">
        <PanelHeading
          eyebrow="PREVENCIÓN"
          titleId="recommendation-title"
          title="Recomendaciones preventivas"
          badge={
            <span className="neutral-tag" id="recommendation-level">
              {recommendationBadge}
            </span>
          }
        />
        <StatusCopy id="recommendation-status">{recommendationStateText}</StatusCopy>
        {/*
          Both lists are always rendered, exactly as `#risk-factors` is: an empty
          list in a state that has nothing to compose is the honest shape, and a
          missing element would read as a panel that failed to load.
        */}
        <ul id="recommendation-notices" aria-label="Avisos de las recomendaciones">
          {(recommendationPlan?.notices ?? []).map(notice => (
            <li key={notice.kind}>{notice.text}</li>
          ))}
        </ul>
        <ul id="recommendation-list" aria-label="Sugerencias de prevención">
          {(recommendationPlan?.items ?? []).map(entry => (
            <li key={entry.id}>
              <span className="neutral-tag">{entry.source === 'factor' ? 'FACTOR' : 'NIVEL'}</span>{' '}
              {entry.text}
            </li>
          ))}
        </ul>
        {recommendationPlan !== null ? (
          <div id="recommendation-reference">
            <h4>Ítem de observación directa</h4>
            <p id="recommendation-reference-text">{DIRECT_OBSERVATION.text}</p>
            <p className="panel-note">
              Es un ítem consultable y no es un hallazgo de esta zona: el sistema no sabe si aquí hay vegetación en
              contacto con líneas eléctricas, así que no lo incluye en la lista.
            </p>
          </div>
        ) : null}
        <p className="panel-note" id="recommendation-panel-note">
          Texto de prevención general, no una predicción: la ficha muestra el catálogo escrito y no crea acciones, no
          envía notificaciones y no pide nada nuevo a la API. Las medidas parafrasean guías públicas de SENAPRED y
          MINVU; el mapeo de cada medida a nuestros niveles y variables es una decisión de FireWatch, y ninguna de las
          dos instituciones revisó ni valida esa correspondencia.
        </p>
      </article>
    </section>
  );
}
