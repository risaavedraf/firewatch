// Transport for the FireWatch gateway.
//
// One function per consumed route, one outcome type: a call never throws for an
// expected condition and never returns a partial value. Every gateway URL is
// absolute against `gatewayOrigin`; the issuer is never used here, because
// `/token`, `/auth` and `/logout` belong to the session unit and to the identity
// provider alone.
//
// Three properties are load-bearing and travel with this code:
//   1. a monotonic sequence per route kind discards a superseded response, so a
//      slow answer for zone A can never be shown as the answer for zone B, and a
//      route with two independent consumers probes on one lane per consumer;
//   2. a response that lands after the view was reset (401, logout, failed
//      login) is discarded instead of repopulating it;
//   3. every read honours the caller's `AbortSignal` and a bounded deadline, so
//      a hung gateway cannot leave a request pending forever.
import { gatewayOrigin, jobRoute, observationAdoptionRoute, preventiveActionRoute, preventiveTransitionRoute, routes } from '../config';
import type {
  ActionHistoryEntry,
  AuditEntry,
  BatchCollection,
  EnvironmentClass,
  EvaluationTrigger,
  Job,
  LandCoverBreakdown,
  ModelRegistry,
  Observation,
  ObservationType,
  ObservationZone,
  PreventiveAction,
  PreventiveActionDetail,
  PreventiveEvidence,
  PreventiveEvidenceReview,
  PreventiveReassessment,
  RiskBatch,
  RiskLevel,
  Scenario,
  ServiceSnapshot,
  QualityFindingCode,
  QualityFindingDefinition,
  SourceProvenance,
  SourceQualityEntry,
  SourceReview,
  SourceReviewDecision,
  VegetationCatalogue,
  ZoneCollection,
  ZoneLandCover,
  ZonePriority,
} from '../types/api';
// The closed type catalogues are runtime values: the guards compare the served
// wire spelling against them, so they cannot travel through `import type`.
import {
  ENVIRONMENT_CLASSES,
  EVALUATION_TRIGGERS,
  LAND_COVER_KEYS,
  OBSERVATION_TYPES,
  QUALITY_FINDINGS,
  QUALITY_FINDING_TRAITS,
  RISK_LEVELS,
  SOURCE_REVIEW_DECISIONS,
  SOURCE_REVIEW_NOTE_LIMIT,
  VEGETATION_SOURCE_LABEL,
} from '../types/api';

import { getAccessToken, resetSession } from './session';

export type FailureKind = 'unavailable' | 'unauthorized' | 'forbidden' | 'malformed' | 'missing';

export interface Failure {
  kind: FailureKind;
  reason: string;
  status?: number;
  requestId?: string;
}

// The refusal codes the create contract states carry "nothing was written", each
// PAIRED with the status the OpenAPI document and the handler define it under:
// 415 `json_required` (the content type is refused before any effect), 422
// `invalid_action_request` / `assignee_not_found` ("nothing is written"), 502
// `directory_upstream_failed` and 503 `directory_unavailable` (the directory is
// refused "instead of being stored unverified", before the store is reached) and
// 503 `storage_unavailable` ("the operation has no effect and stored state is
// unchanged"). A code on any other status is a pair the contract never defines, so
// it proves nothing about what the layer did.
const CONFIRMED_WRITE_REFUSALS: ReadonlyMap<number, ReadonlySet<string>> = new Map([
  [415, new Set(['json_required'])],
  [422, new Set(['invalid_action_request', 'assignee_not_found'])],
  [502, new Set(['directory_upstream_failed'])],
  [503, new Set(['directory_unavailable', 'storage_unavailable'])],
]);

// Whether a failed WRITE is a refusal the contract proves stored nothing.
//
// This is deliberately narrower than "the response was an error". A transport
// fault, a deadline, an aborted or superseded request, an unusable 2xx body, a
// gateway 502 `upstream_unavailable` ("no upstream response was observed"), a
// status without one of the documented codes, and a documented code on an
// undocumented status all leave the write UNDETERMINED: the service may have
// stored it. A caller must not turn that into "nothing was created", and must not
// invite a retry that could duplicate the write.
//
// 401/403 and 429 are refusals by construction (the token, the role and the quota
// are checked before the route runs and before any effect), and the pairs above
// are the rest of the proof.
export function isConfirmedWriteRefusal(failure: Failure): boolean {
  if (failure.kind === 'unauthorized' || failure.kind === 'forbidden') return true;
  if (failure.status === 429) return true;
  if (failure.status === undefined) return false;
  return CONFIRMED_WRITE_REFUSALS.get(failure.status)?.has(failure.reason) === true;
}

export type Outcome<T> = { ok: true; data: T } | { ok: false; failure: Failure };

// `config.routes` carries every GET route and the job read, but not the job
// creation path, so it is named here rather than duplicated as a bare literal.
const JOBS_ROUTE = '/v1/jobs';

// PM-05's comparison read. It belongs beside the only module that consumes it
// rather than in `config.routes`, exactly as the job creation path above does:
// the registry there lists the routes the retired page already knew, and this
// one is additive. The path is written once and never as a literal at a call
// site.
const COMPARE_ROUTE = '/v1/risk/compare';

// PM-16 — the gateway's own bounded multi-service aggregate. It is named here for
// the same reason as the job creation path: `config.routes` is the shared map of
// the routes this page reads and it is not extended by this unit, so the path
// lives beside the one function that uses it instead of being a bare literal.
const AGGREGATE_STATUS_ROUTE = '/v1/status';

// V1-P-06 — the manual publication of the risk cycle. Same reason as the two paths
// above: `config.routes` lists the routes the retired page already knew and this
// unit does not extend it, so the path is written once, here, and never as a bare
// literal at the call site.
const CYCLE_RUN_ROUTE = '/v1/risk/cycle/run';

// A single bounded deadline for one transport read. The retired page bounded its
// own status cycle at 10 s and fenced a hung fetch on the job path; the port
// applies the same bound to every read so no route can hang the view.
const DEFAULT_DEADLINE_MS = 10_000;

type RequestKind =
  | 'ready'
  | 'zones'
  | 'latest'
  | 'history'
  | 'historySeries'
  | 'batches'
  | 'executiveSummary'
  | 'compare'
  | 'sources'
  | 'riskStatus'
  | 'jobsStatus'
  | 'aggregateStatus'
  | 'scenarios'
  | 'audit'
  | 'createJob'
  | 'job'
  | 'cycleRun'
  | 'preventiveActions'
  | 'preventiveAction'
  | 'createPreventiveAction'
  | 'transitionPreventiveAction'
  | 'recordPreventiveEvidence'
  | 'reviewPreventiveEvidence'
  | 'linkPreventiveReassessment'
  | 'observations'
  | 'observationZones'
  | 'createObservation'
  | 'adoptObservation'
  | 'models'
  | 'simulate'
  | 'explain'
  | 'users'
  | 'vegetation'
  | 'sourceReview';

// The sequence is per kind on purpose: `latest` and `history` are issued
// together for one selection, so a shared counter would make each treat the
// other's just-started request as a supersession and discard its own answer.
//
// A lane is the route kind unless a consumer names its own. `/health/ready` is
// polled by the shell card and by the sources cycle, and both are entitled to
// their own answer: on one lane the probe started last discarded the other's
// healthy response, which the card rendered as an outage and the cycle as an
// abandoned read.
const sequences = new Map<string, number>();

function laneKey(kind: RequestKind, lane?: string): string {
  return lane === undefined ? kind : `${kind}#${lane}`;
}

function nextSequence(lane: string): number {
  const next = (sequences.get(lane) ?? 0) + 1;
  sequences.set(lane, next);
  return next;
}

function isSuperseded(lane: string, sequence: number, token: string): boolean {
  return sequence !== (sequences.get(lane) ?? 0) || token !== getAccessToken();
}

function failureSpec(kind: FailureKind, reason: string, status?: number, requestId?: string): Failure {
  const failure: Failure = { kind, reason };
  if (status !== undefined) failure.status = status;
  if (requestId !== undefined && requestId !== '') failure.requestId = requestId;
  return failure;
}

function failureOutcome<T>(failure: Failure): Outcome<T> {
  return { ok: false, failure };
}

interface TransportRequest {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  // Optional independent supersession lane, for a route this build consumes from
  // more than one place. Absent means the route kind is the lane.
  lane?: string;
  // `false` only for the unauthenticated gateway probe; every `/v1/*` read
  // carries the bearer even when the token is empty, exactly as the retired
  // page did.
  authenticated?: boolean;
}

type TransportResult =
  | { state: 'ok'; status: number; body: unknown; requestId: string }
  | { state: 'empty'; status: number; requestId: string }
  | { state: 'httpError'; status: number; body: unknown; requestId: string }
  | { state: 'failed'; failure: Failure };

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

const jsonFailure = Symbol('json-failure');

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return jsonFailure;
  }
}

async function requestJson(
  kind: RequestKind,
  url: string,
  request: TransportRequest,
  signal?: AbortSignal,
): Promise<TransportResult> {
  const lane = laneKey(kind, request.lane);
  const sequence = nextSequence(lane);
  const token = getAccessToken();
  const controller = new AbortController();
  let stop: 'none' | 'aborted' | 'deadline' = 'none';
  const stopReason = (): 'none' | 'aborted' | 'deadline' => stop;
  const onCallerAbort = (): void => {
    stop = 'aborted';
    controller.abort();
  };
  if (signal) {
    if (signal.aborted) return { state: 'failed', failure: failureSpec('unavailable', 'aborted') };
    signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const deadline = setTimeout(() => {
    stop = 'deadline';
    controller.abort();
  }, DEFAULT_DEADLINE_MS);
  try {
    const headers: Record<string, string> = { ...(request.headers ?? {}) };
    if (request.authenticated !== false) headers.Authorization = `Bearer ${token}`;
    const response = await abortable(
      fetch(url, {
        method: request.method ?? 'GET',
        body: request.body,
        headers,
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
      }),
      controller.signal,
    );
    // Supersession is checked BEFORE the status: a superseded 401 must not reset
    // the session of the selection that replaced it.
    if (isSuperseded(lane, sequence, token)) {
      return { state: 'failed', failure: failureSpec('unavailable', 'superseded') };
    }
    const requestId = response.headers.get('X-Request-ID') ?? '';
    if (response.status === 401) {
      // The 401 still lowers the token (S6). The reason is `'rejected'` only
      // when this request actually carried a non-empty bearer: a tokenless 401
      // is not evidence that a token was refused (S3).
      const sentBearer = request.authenticated !== false && token !== '';
      resetSession(sentBearer ? 'rejected' : null);
      return { state: 'failed', failure: failureSpec('unauthorized', 'unauthorized', 401, requestId) };
    }
    if (response.status === 403) {
      // A denied permission is a stated outcome, never "the service is down".
      return { state: 'failed', failure: failureSpec('forbidden', 'forbidden', 403, requestId) };
    }
    if (response.status === 204) return { state: 'empty', status: 204, requestId };
    const body = await abortable(readJson(response), controller.signal);
    if (isSuperseded(lane, sequence, token)) {
      return { state: 'failed', failure: failureSpec('unavailable', 'superseded') };
    }
    if (body === jsonFailure) {
      return { state: 'failed', failure: failureSpec('malformed', 'malformed_json', response.status, requestId) };
    }
    if (response.ok) return { state: 'ok', status: response.status, body, requestId };
    return { state: 'httpError', status: response.status, body, requestId };
  } catch {
    // Read through the accessor: the assignments happen in callbacks, so the
    // control-flow analysis cannot see them and would narrow the variable to its
    // initial value.
    const reason = stopReason();
    if (reason === 'deadline') return { state: 'failed', failure: failureSpec('unavailable', 'deadline') };
    if (reason === 'aborted') return { state: 'failed', failure: failureSpec('unavailable', 'aborted') };
    return { state: 'failed', failure: failureSpec('unavailable', 'network') };
  } finally {
    clearTimeout(deadline);
    if (signal) signal.removeEventListener('abort', onCallerAbort);
  }
}

function reasonFromBody(body: unknown, fallback: string): string {
  if (record(body) && nonempty(body.code)) return body.code.trim();
  return fallback;
}

function httpFailure(result: { status: number; body: unknown; requestId: string }): Failure {
  const reason = reasonFromBody(result.body, `http_${result.status}`);
  const kind: FailureKind = result.status === 400 ? 'malformed' : result.status === 404 ? 'missing' : 'unavailable';
  return failureSpec(kind, reason, result.status, result.requestId);
}

function failureOf(result: TransportResult): Failure {
  if (result.state === 'failed') return result.failure;
  if (result.state === 'httpError') return httpFailure(result);
  return failureSpec('malformed', 'invalid_shape', result.status, result.requestId);
}

function resultFailure<T>(result: TransportResult): Outcome<T> {
  return failureOutcome<T>(failureOf(result));
}

function guardOutcome<T>(result: TransportResult, guard: (body: unknown) => body is T): Outcome<T> {
  if (result.state !== 'ok') return resultFailure<T>(result);
  if (!guard(result.body)) {
    return failureOutcome<T>(failureSpec('malformed', 'invalid_shape', result.status, result.requestId));
  }
  return { ok: true, data: result.body };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

// The service serializes its history primary key — an `int64` column — as a JSON
// number, so a string there would be a contract change rather than a tolerance.
// Demanding a string rejected a real detail payload as `invalid_shape`.
function optionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === 'number';
}

// --- Boundary guards -------------------------------------------------------
//
// The declarations in `types/api.ts` are not runtime guarantees. Each guard
// accepts only the shape the view can use; anything else is reported as
// `malformed` rather than rendered as a plausible partial value.

function isZoneCollection(value: unknown): value is ZoneCollection {
  return record(value) && value.type === 'FeatureCollection' && Array.isArray(value.features);
}

function isGeometry(value: unknown): boolean {
  if (!record(value)) return false;
  return (value.type === 'Polygon' || value.type === 'MultiPolygon' || value.type === 'Point') && Array.isArray(value.coordinates);
}

function isFactor(value: unknown): boolean {
  if (!record(value)) return false;
  if (!nonempty(value.name) || typeof value.known !== 'boolean') return false;
  // The contract leaves value and contribution optional, and the classifier omits
  // them for a variable it could not read. A number that IS present must still be
  // a real number, so a string or a NaN cannot slip through as a measurement.
  if (!optionalFiniteNumber(value.value) || !optionalFiniteNumber(value.contribution)) return false;
  if (value.known === true) {
    // A known variable carries the numbers the rule measured. Without them it is
    // not an incomplete reading to be averaged over: it is a shape this client
    // refuses instead of rendering a value nobody served.
    if (typeof value.value !== 'number' || typeof value.contribution !== 'number') return false;
  }
  return value.note === undefined || typeof value.note === 'string';
}

function optionalFiniteNumber(value: unknown): boolean {
  return value === undefined || Number.isFinite(value);
}

function isPolicy(value: unknown): boolean {
  return (
    record(value) &&
    nonempty(value.policy_id) &&
    nonempty(value.params_hash) &&
    (value.parameters === undefined || record(value.parameters))
  );
}

function nullableString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

// The contract types an action's `assignee_id` as `format: uuid` and nullable, and
// the service serializes the column without `omitempty`, so the reference is
// either null or the canonical dashed form. An absent field stays tolerated: a
// payload that predates the reference is still a valid action. Anything else is a
// contract change, not a name to render, so the read fails closed instead.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function nullableUuid(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && UUID_PATTERN.test(value));
}

// The evaluation's provenance, as `BatchCore` declares it. The trigger's closed
// vocabulary is validated here instead of being tolerated as an arbitrary string:
// the declaration hands a caller `'scheduler' | 'manual'`, a type predicate must not
// hand it a value outside that union, and the service writes only those two (the
// column is NOT NULL with a default). The actor is nullable because a scheduled run
// records no actor at all. A payload that predates the columns omits both, which
// stays accepted.
function isEvaluationTrigger(value: unknown): value is EvaluationTrigger {
  return EVALUATION_TRIGGERS.some(trigger => trigger === value);
}

function optionalEvaluationTrigger(value: unknown): boolean {
  return value === undefined || isEvaluationTrigger(value);
}

// V1-P-02 / PM-11 — the regional priority member. The status is closed, the three
// nullable numbers must actually be null when the backend could not place the zone
// and an integer when it did, and a summary is always a string. A payload that
// breaks either half is malformed instead of being rendered as a plausible rank.
function isZonePriority(value: unknown): value is ZonePriority {
  if (!record(value)) return false;
  // The level is the closed vocabulary the contract publishes, not free text: a
  // context that names an undeclared level would be rendered as a classification.
  if (!nonempty(value.zone_id) || !isRiskLevel(value.risk_level)) return false;
  if (value.priority_status !== 'ranked' && value.priority_status !== 'insufficient') return false;
  if (!nullableInteger(value.risk_score) || !nullableInteger(value.priority_score) || !nullableInteger(value.priority_rank)) {
    return false;
  }
  if (!integer(value.exposure_score) || value.exposure_score < 0 || value.exposure_score > 100) return false;
  if (!integer(value.total_ranked_zones) || value.total_ranked_zones < 0) return false;
  if (!integer(value.exposed_assets_count) || value.exposed_assets_count < 0) return false;
  if (!isDominantCategory(value.dominant_category)) return false;
  if (typeof value.context_summary !== 'string') return false;
  const placed = value.priority_status === 'ranked';
  if (placed) {
    // S3 — a zone the rule could not decide holds no position: `desconocido` is a
    // level the rule states, not a low one. A `ranked` block naming it contradicts
    // itself and would print a rank nobody computed.
    if (value.risk_level === 'desconocido') return false;
    const allPresent = value.risk_score !== null && value.priority_score !== null && value.priority_rank !== null;
    return allPresent && isRankedPriority(value);
  }
  const allAbsent = value.risk_score === null && value.priority_score === null && value.priority_rank === null;
  // An insufficient zone holds no position at all, so the three members are
  // all-or-nothing: a partial block would print a rank nobody computed. The ranked
  // total may be zero here, because a batch where nothing could be scored is a real
  // answer and not an invalid one.
  return allAbsent;
}

// The five ratified categories a dominant category can name. The vocabulary is
// closed: the contract publishes exactly these keys, and a value outside it would
// be printed as a category nobody ratified.
const DOMINANT_CATEGORIES = ['hospital', 'escuela', 'subestacion', 'telecom', 'vialidad'] as const;

// isDominantCategory accepts the documented absence or one of the ratified keys.
// Anything else — a retired type, a different casing, a blank string — is refused.
function isDominantCategory(value: unknown): boolean {
  return value === null || (typeof value === 'string' && (DOMINANT_CATEGORIES as readonly string[]).includes(value));
}

// --- V1-P-01 / PM-12 — the land-cover layer --------------------------------
//
// The page states, in visible text, that the layer is synthetic, that it is a
// closed scale and that the percentages sum to one hundred. A payload that does
// not satisfy those claims is unreadable instead of being rendered as if it did:
// every number below is a claim the reader is asked to trust.

// The tolerance the five percentages are summed with. The producer emits whole
// points, so the sum is exact; the tolerance only absorbs binary float error in a
// sum of five decimal values.
const BREAKDOWN_TOLERANCE = 1e-6;

function isEnvironmentClass(value: unknown): value is EnvironmentClass {
  return typeof value === 'string' && (ENVIRONMENT_CLASSES as readonly string[]).includes(value);
}

// fraction is the documented 0.00..1.00 range of every NDVI member.
function fraction(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

// percentage is the documented 0..100 range of a land-cover share.
function percentage(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

// The five declared percentages, each in 0..100 and summing to 100. An undeclared
// key is a contract change rather than a share the view may print, so the object
// has to carry exactly these five.
function isLandCoverBreakdown(value: unknown): value is LandCoverBreakdown {
  if (!record(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== LAND_COVER_KEYS.length) return false;
  if (!keys.every(key => (LAND_COVER_KEYS as readonly string[]).includes(key))) return false;
  let total = 0;
  for (const key of LAND_COVER_KEYS) {
    const share = value[key];
    if (!percentage(share)) return false;
    total += share;
  }
  return Math.abs(total - 100) < BREAKDOWN_TOLERANCE;
}

// isZoneLandCover validates one commune's entry: thousandth-free NDVI inside
// 0.00..1.00 with min <= mean <= max, an anomaly inside -1.00..1.00, the five
// percentages, the closed class and the DECLARED synthetic provenance. A block
// that claims to be an observation is refused: the layer never is one.
function isZoneLandCover(value: unknown): value is ZoneLandCover {
  if (!record(value)) return false;
  if (!nonempty(value.zone_id) || !nonempty(value.zone_name)) return false;
  const low = value.ndvi_min;
  const mean = value.ndvi_mean;
  const high = value.ndvi_max;
  if (!fraction(low) || !fraction(mean) || !fraction(high)) return false;
  if (low > mean || mean > high) return false;
  const anomaly = value.ndvi_anomaly;
  if (typeof anomaly !== 'number' || !Number.isFinite(anomaly) || anomaly < -1 || anomaly > 1) return false;
  if (!isLandCoverBreakdown(value.land_cover_breakdown)) return false;
  if (!isEnvironmentClass(value.environment_class)) return false;
  if (value.synthetic !== true) return false;
  return value.source_label === VEGETATION_SOURCE_LABEL;
}

// isVegetationCatalogue validates the whole answer. A repeated zone is refused
// because the table would show the same commune twice from one payload.
function isVegetationCatalogue(value: unknown): value is VegetationCatalogue {
  if (!record(value)) return false;
  if (value.source !== VEGETATION_SOURCE_LABEL) return false;
  if (!Array.isArray(value.zones)) return false;
  const seen = new Set<string>();
  for (const entry of value.zones) {
    if (!isZoneLandCover(entry)) return false;
    if (seen.has(entry.zone_id)) return false;
    seen.add(entry.zone_id);
  }
  return true;
}

// priorityIndex is the documented 0..100 range of every served index.
function priorityIndex(value: unknown): value is number {
  return integer(value) && value >= 0 && value <= 100;
}

// isRankedPriority validates a position: each index inside 0..100, at least one
// ranked zone, and a rank that exists inside that ranking. A rank outside 1..N
// would print a position the batch does not have, so it fails closed.
function isRankedPriority(value: Record<string, unknown>): boolean {
  if (!priorityIndex(value.risk_score) || !priorityIndex(value.priority_score)) return false;
  if (!integer(value.total_ranked_zones) || value.total_ranked_zones < 1) return false;
  const rank = value.priority_rank;
  return integer(rank) && rank >= 1 && rank <= value.total_ranked_zones;
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value);
}

function nullableInteger(value: unknown): boolean {
  return value === null || integer(value);
}

function isRiskBatch(value: unknown): value is RiskBatch {
  if (!record(value)) return false;
  if (!nonempty(value.zone_id) || !nonempty(value.id) || !nonempty(value.job_id)) return false;
  if (typeof value.demo !== 'boolean') return false;
  if (typeof value.risk_level !== 'string') return false;
  if (!Array.isArray(value.factors) || !value.factors.every(isFactor)) return false;
  if (typeof value.rationale !== 'string') return false;
  if (!isPolicy(value.policy)) return false;
  // The warning is mandatory even when the upstream notice is absent or unreadable.
  // The view renders a fixed fallback; no malformed notice becomes visible text.
  if (value.geometry !== undefined && !isGeometry(value.geometry)) return false;
  if (!optionalString(value.published_at) || !optionalString(value.valid_until) || !optionalString(value.requested_at)) return false;
  if (!optionalString(value.model_version) || !optionalString(value.data_status)) return false;
  if (!nullableString(value.scenario_id) || !nullableString(value.evaluated_at)) return false;
  if (!optionalEvaluationTrigger(value.evaluation_trigger) || !nullableString(value.evaluated_by)) return false;
  if (value.priority !== undefined && value.priority !== null) {
    const priority = value.priority;
    if (!isZonePriority(priority)) return false;
    // The context must describe this batch: a member naming another zone or another
    // level is a mismatched join, and printing it would attach a position to a row
    // the service never computed it for.
    if (priority.zone_id !== value.zone_id) return false;
    if (priority.risk_level !== value.risk_level) return false;
  }
  if (value.land_cover !== undefined && value.land_cover !== null) {
    const landCover = value.land_cover;
    if (!isZoneLandCover(landCover)) return false;
    // The same mismatched-join rule as priority: an entry naming another commune
    // would attach a land cover to a row the service never declared it for.
    if (landCover.zone_id !== value.zone_id) return false;
  }
  return true;
}

function isServiceSnapshot(value: unknown): value is ServiceSnapshot {
  return (
    record(value) &&
    typeof value.checked_at === 'string' &&
    typeof value.ready === 'boolean' &&
    record(value.dependencies) &&
    (value.dead_letter_depth === undefined || value.dead_letter_depth === null || Number.isFinite(value.dead_letter_depth))
  );
}

function isJob(value: unknown): value is Job {
  if (!record(value)) return false;
  if (!nonempty(value.id) || !nonempty(value.zone_id) || typeof value.state !== 'string') return false;
  // `batch_id` is serialized as `null` until the job publishes (the column is a
  // `*string` behind a tag without `omitempty`). Demanding a string here rejected
  // the 202 acceptance of every queued job as `invalid_shape`, and the view then
  // rendered the acceptance as a failure with the raw status code. A null stays
  // "no batch yet"; only a value that is neither null nor a string is malformed.
  if (!nullableString(value.batch_id)) return false;
  if (!optionalString(value.requested_at)) return false;
  if (!nullableString(value.scenario_id) || !nullableString(value.evaluated_at)) return false;
  return true;
}

// An event is usable only when it states WHAT happened, WHEN, its own stable id
// and its kind. A nullable name, detail or job is data, not malformation: the
// view labels the absence in place and never fills it in from another field.
// `event_kind` is the closed vocabulary the contract documents, so an unknown
// kind is refused instead of being guessed as a mutation.
function isAuditEntry(value: unknown): value is AuditEntry {
  return (
    record(value) &&
    nonempty(value.event_id) &&
    nonempty(value.action) &&
    nonempty(value.occurred_at) &&
    (value.event_kind === 'mutation' || value.event_kind === 'query') &&
    optionalString(value.actor_id) &&
    nullableString(value.actor_name) &&
    nullableString(value.detail) &&
    nullableString(value.job_id) &&
    optionalString(value.trace_id)
  );
}

// --- Routes -----------------------------------------------------------------

// Gateway-only availability probe. A 204 proves the gateway process answered;
// it does not accredit the risk or jobs pipeline, and the view states so.
//
// The consumers of this probe are independent, so each names its own lane: the
// shell card and the sources cycle overlap, and a shared lane made whichever
// probe started last discard the other's healthy answer. Omitting the scope
// keeps the single-lane behaviour every other caller already has.
export type ReadyProbeScope = 'shell' | 'sources';

export async function ready(signal?: AbortSignal, scope?: ReadyProbeScope): Promise<Outcome<null>> {
  const result = await requestJson(
    'ready',
    `${gatewayOrigin}${routes.ready}`,
    { authenticated: false, lane: scope },
    signal,
  );
  if (result.state === 'ok' || result.state === 'empty') return { ok: true, data: null };
  return resultFailure<null>(result);
}

export async function zones(signal?: AbortSignal): Promise<Outcome<ZoneCollection>> {
  const result = await requestJson('zones', `${gatewayOrigin}${routes.zones}`, { authenticated: true }, signal);
  return guardOutcome(result, isZoneCollection);
}

export async function latest(zoneId: string, signal?: AbortSignal): Promise<Outcome<RiskBatch | null>> {
  const url = `${gatewayOrigin}${routes.latest}?zone_id=${encodeURIComponent(zoneId)}`;
  const result = await requestJson('latest', url, { authenticated: true }, signal);
  // A 404 means no published batch, not low risk: the absence is data, and the
  // view must not invent a level for it.
  if (result.state === 'httpError' && result.status === 404) return { ok: true, data: null };
  if (result.state !== 'ok') return resultFailure<RiskBatch | null>(result);
  if (!isRiskBatch(result.body)) {
    return failureOutcome(failureSpec('malformed', 'invalid_shape', result.status, result.requestId));
  }
  if (result.body.zone_id !== zoneId) {
    return failureOutcome(failureSpec('malformed', 'zone_mismatch', result.status, result.requestId));
  }
  return { ok: true, data: result.body };
}

export async function history(zoneId: string, signal?: AbortSignal): Promise<Outcome<RiskBatch[]>> {
  const url = `${gatewayOrigin}${routes.history}?zone_id=${encodeURIComponent(zoneId)}`;
  const result = await requestJson('history', url, { authenticated: true }, signal);
  if (result.state !== 'ok') return resultFailure<RiskBatch[]>(result);
  if (!Array.isArray(result.body)) {
    return failureOutcome(failureSpec('malformed', 'invalid_shape', result.status, result.requestId));
  }
  const batches: RiskBatch[] = [];
  for (const entry of result.body) {
    if (!isRiskBatch(entry)) {
      return failureOutcome(failureSpec('malformed', 'invalid_shape', result.status, result.requestId));
    }
    if (entry.zone_id !== zoneId) {
      return failureOutcome(failureSpec('malformed', 'zone_mismatch', result.status, result.requestId));
    }
    batches.push(entry);
  }
  return { ok: true, data: batches };
}

// --- Granular history series ------------------------------------------------
//
// `GET /v1/risk/history/series` is the ADDITIVE sibling of the per-zone read
// above: `/v1/risk/history` keeps its fixed 100 row window and its CSV export,
// and this route answers a bounded window of every zone at one bucket size. The
// path is declared here rather than in `config.routes` for the same reason the
// job creation path is: the transport owns the query it builds for it.
const HISTORY_SERIES_ROUTE = '/v1/risk/history/series';

// The closed vocabulary of bucket sizes the route accepts. It is a runtime value
// because the guard and the request builder compare against it: a granularity
// outside it is refused here instead of being sent and answered with a 400 the
// view would render as a broken control.
export type HistoryGranularity = 'hour' | 'day' | 'week';

export const HISTORY_GRANULARITIES: readonly HistoryGranularity[] = ['hour', 'day', 'week'];

// One point of one series. It is deliberately narrower than `RiskBatch`: a
// historical point carries no freshness (`data_status`, `notice`, `valid_until`
// describe the CURRENT state of a batch and are recomputed at read time), so the
// page renders the level, the batch identity and the provenance it was served.
export interface HistoryBucket {
  bucket_start: string;
  batch_id: string;
  requested_at: string;
  published_at: string;
  risk_level: RiskLevel;
  model_version: string;
  synthetic: boolean;
}

// One zone's series. A zone is present only when it has at least one point in the
// window, so `buckets` is never empty and a gap between two points is a bucket
// with no publication rather than an interpolated value.
export interface HistoryZoneSeries {
  zone_id: string;
  buckets: HistoryBucket[];
}

// The route echoes the accepted window and granularity, so an answer is
// attributable to the question that produced it.
export interface HistorySeriesCollection {
  from: string;
  to: string;
  granularity: HistoryGranularity;
  series: HistoryZoneSeries[];
}

// The documented caps of the window, both inclusive: 48 h for hour buckets and
// 31 days for day and week buckets. The page asks for exactly the cap, so the
// answer is the largest window the route accepts and never a refused one.
const SERIES_WINDOW_MS: Record<HistoryGranularity, number> = {
  hour: 48 * 3_600_000,
  day: 31 * 86_400_000,
  week: 31 * 86_400_000,
};

export interface HistorySeriesWindow {
  readonly from: string;
  readonly to: string;
}

// The window the page asks for: the whole cap of the selected granularity,
// ending now. Both instants are RFC 3339 in UTC, which is what the route compares
// `requested_at` against. Nothing about the buckets is decided here: the service
// cuts them and the page renders the `bucket_start` it was served.
export function historySeriesWindow(
  granularity: HistoryGranularity,
  now: Date = new Date(),
): HistorySeriesWindow {
  const to = now.getTime();
  return {
    from: new Date(to - SERIES_WINDOW_MS[granularity]).toISOString(),
    to: new Date(to).toISOString(),
  };
}

export interface HistorySeriesQuery extends HistorySeriesWindow {
  readonly granularity: HistoryGranularity;
  // Omitted asks for every zone that has a point; present narrows the read to one
  // catalogue zone. The parameter travels only when it was asked for, so the
  // answer is always attributable to the query.
  readonly zoneId?: string;
}

// Every instant this route takes or serves is declared `format: date-time`, so
// the spelling is checked instead of being handed to `Date.parse`: that parser
// also accepts a bare date and US-style slashes as instants, and it silently
// rolls an impossible civil day (February 30) into the next month. Only a full
// RFC 3339 `date-time` with its mandatory offset passes here.
const RFC3339_INSTANT = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function isInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = RFC3339_INSTANT.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  const lastDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  if (day < 1 || day > lastDay) return false;
  if (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) return false;
  // The offset is only checked to be a real clock offset; any offset is accepted
  // and the instant it names is what the window compares.
  if (match[7] !== undefined && (Number(match[8]) > 23 || Number(match[9]) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

// The three series objects are `additionalProperties: false` in the contract, so
// a member the schema does not name is a body the page must not render: it would
// mean the route changed shape under a client that cannot read the change.
const HISTORY_BUCKET_MEMBERS: readonly string[] = [
  'bucket_start',
  'batch_id',
  'requested_at',
  'published_at',
  'risk_level',
  'model_version',
  'synthetic',
];
const HISTORY_ZONE_SERIES_MEMBERS: readonly string[] = ['zone_id', 'buckets'];
const HISTORY_SERIES_MEMBERS: readonly string[] = ['from', 'to', 'granularity', 'series'];

function onlyMembers(value: Record<string, unknown>, declared: readonly string[]): boolean {
  return Object.keys(value).every((key) => declared.includes(key));
}

// The bucket vocabulary of the contract is closed (`bajo`, `medio`, `alto`,
// `desconocido`), so a point outside it is refused instead of being rendered as
// unclassified history the service never recorded.
function isHistoryBucket(value: unknown): value is HistoryBucket {
  return (
    record(value) &&
    onlyMembers(value, HISTORY_BUCKET_MEMBERS) &&
    isInstant(value.bucket_start) &&
    nonempty(value.batch_id) &&
    isInstant(value.requested_at) &&
    isInstant(value.published_at) &&
    typeof value.risk_level === 'string' &&
    (RISK_LEVELS as readonly string[]).includes(value.risk_level) &&
    nonempty(value.model_version) &&
    typeof value.synthetic === 'boolean'
  );
}

// A zone is present only when it has a point, so an empty `buckets` array is a
// series the contract says cannot exist: it is refused instead of being rendered
// as a zone with no data.
function isHistoryZoneSeries(value: unknown): value is HistoryZoneSeries {
  return (
    record(value) &&
    onlyMembers(value, HISTORY_ZONE_SERIES_MEMBERS) &&
    nonempty(value.zone_id) &&
    Array.isArray(value.buckets) &&
    value.buckets.length > 0 &&
    value.buckets.every(isHistoryBucket)
  );
}

function isHistorySeriesCollection(value: unknown): value is HistorySeriesCollection {
  return (
    record(value) &&
    onlyMembers(value, HISTORY_SERIES_MEMBERS) &&
    isInstant(value.from) &&
    isInstant(value.to) &&
    typeof value.granularity === 'string' &&
    (HISTORY_GRANULARITIES as readonly string[]).includes(value.granularity) &&
    Array.isArray(value.series) &&
    value.series.every(isHistoryZoneSeries)
  );
}

// Instants are compared as instants, not as spellings: the route canonicalises
// both to UTC, which can re-spell the offset and the fractional seconds the page
// sent without changing the window it accepted.
function sameInstant(left: string, right: string): boolean {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && leftMs === rightMs;
}

// The series read. It fails closed before any request: a granularity outside the
// closed vocabulary is `invalid_granularity`, a window that is not two RFC 3339
// instants is `invalid_shape`, and an explicitly empty `zone_id` is `invalid_shape`
// rather than an omitted parameter — omitting it asks for EVERY zone, so folding
// an empty zone into the absence of a filter would widen the read behind the
// caller's back. A body the guard cannot use is `malformed`, and an answer that
// echoes ANOTHER window, granularity or zone is refused as a mismatch instead of
// being rendered as this query's series.
export async function historySeries(
  query: HistorySeriesQuery,
  signal?: AbortSignal,
): Promise<Outcome<HistorySeriesCollection>> {
  if (!(HISTORY_GRANULARITIES as readonly string[]).includes(query.granularity)) {
    return failureOutcome(failureSpec('malformed', 'invalid_granularity'));
  }
  if (!isInstant(query.from) || !isInstant(query.to)) {
    return failureOutcome(failureSpec('malformed', 'invalid_shape'));
  }
  // The field is optional, but when it is present it must name a zone.
  if (query.zoneId !== undefined && !nonempty(query.zoneId)) {
    return failureOutcome(failureSpec('malformed', 'invalid_shape'));
  }
  const parameters = new URLSearchParams({
    from: query.from,
    to: query.to,
    granularity: query.granularity,
  });
  if (query.zoneId !== undefined) parameters.set('zone_id', query.zoneId);
  const result = await requestJson(
    'historySeries',
    `${gatewayOrigin}${HISTORY_SERIES_ROUTE}?${parameters.toString()}`,
    { authenticated: true },
    signal,
  );
  if (result.state !== 'ok') return resultFailure<HistorySeriesCollection>(result);
  if (!isHistorySeriesCollection(result.body)) {
    return failureOutcome(failureSpec('malformed', 'invalid_shape', result.status, result.requestId));
  }
  if (
    result.body.granularity !== query.granularity ||
    !sameInstant(result.body.from, query.from) ||
    !sameInstant(result.body.to, query.to)
  ) {
    return failureOutcome(failureSpec('malformed', 'window_mismatch', result.status, result.requestId));
  }
  if (query.zoneId !== undefined && result.body.series.some((entry) => entry.zone_id !== query.zoneId)) {
    return failureOutcome(failureSpec('malformed', 'zone_mismatch', result.status, result.requestId));
  }
  return { ok: true, data: result.body };
}

// The aggregate body is an envelope, not the bare array `/history` serves: a bare
// array, a missing or non-array `batches`, or an element that is not a usable
// batch rejects the WHOLE answer. The read exists to paint every comuna at once,
// and painting the surviving subset would present a collection the service did
// not serve. An element of the rejected answer is not repaired, skipped or
// defaulted here either.
function isBatchCollection(value: unknown): value is BatchCollection {
  return record(value) && Array.isArray(value.batches);
}

// One request answers the newest published batch of every zone that has one, so
// the map can be coloured on load instead of one read per comuna. A zone with no
// published batch is simply absent, and this function invents nothing for it: the
// caller decides what an absent zone means, and the honest answer is "no level".
export async function batches(signal?: AbortSignal): Promise<Outcome<RiskBatch[]>> {
  const result = await requestJson('batches', `${gatewayOrigin}${routes.batches}`, { authenticated: true }, signal);
  if (result.state !== 'ok') return resultFailure<RiskBatch[]>(result);
  if (!isBatchCollection(result.body)) {
    return failureOutcome(failureSpec('malformed', 'invalid_shape', result.status, result.requestId));
  }
  const collection: RiskBatch[] = [];
  for (const entry of result.body.batches) {
    if (!isRiskBatch(entry)) {
      return failureOutcome(failureSpec('malformed', 'invalid_shape', result.status, result.requestId));
    }
    collection.push(entry);
  }
  return { ok: true, data: collection };
}

// --- Land-cover layer -------------------------------------------------------
//
// V1-P-01 / PM-12. The path is declared here rather than in `config.routes` for the
// same reason the granular series is: the transport owns the read it issues for it.
// The route accepts no parameter at all, so nothing is built into the URL.
const VEGETATION_ROUTE = '/v1/risk/vegetation';

export async function vegetation(signal?: AbortSignal): Promise<Outcome<VegetationCatalogue>> {
  const result = await requestJson(
    'vegetation',
    `${gatewayOrigin}${VEGETATION_ROUTE}`,
    { authenticated: true },
    signal,
  );
  return guardOutcome(result, isVegetationCatalogue);
}

// --- Executive summary ------------------------------------------------------
//
// PM-01's aggregate read. The server computes every count in this body; the
// panel that renders it performs no arithmetic of its own, so the types here are
// the contract's own members and nothing derived.

export interface ExecutiveCoverage {
  catalogue_zones: number;
  zones_without_batch: number;
  stale_zones: number;
  demo_zones: number;
}

// The four levels the contract fixes. `desconocido` is a level the rule can
// state, not an absence of data: a batch without a determined level counts here.
export interface ExecutiveLevelCounts {
  alto: number;
  medio: number;
  bajo: number;
  desconocido: number;
}

export interface ExecutiveTransition {
  from: string;
  to: string;
  zones: number;
}

export interface ExecutiveDelta {
  zones_compared: number;
  zones_changed: number;
  zones_without_previous: number;
  zones_incomparable: number;
  transitions: ExecutiveTransition[];
}

export interface ExecutiveVariable {
  name: string;
  zones: number;
}

// D-B "Alto sostenido dos lotes": the zones whose two newest published batches
// are both `alto`, ordered by zone id on the server, with `count` as its length.
export interface ExecutiveCriticalZones {
  count: number;
  zone_ids: string[];
}

export interface ExecutiveSummary {
  coverage: ExecutiveCoverage;
  levels: ExecutiveLevelCounts;
  delta: ExecutiveDelta;
  predominant_variables: ExecutiveVariable[];
  critical_zones: ExecutiveCriticalZones;
  // Rows stored in `risk_alerts`, unfiltered. Not an unread count: no read or
  // dismissed state exists yet, and the panel must not imply one.
  active_alerts: { count: number };
}

const EXECUTIVE_LEVELS = ['alto', 'medio', 'bajo', 'desconocido'] as const;

function isSummaryCount(value: unknown): value is number {
  // A negative, fractional or non-numeric count is not a count: the panel would
  // print it as if the service had measured it.
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isExecutiveLevel(value: unknown): value is string {
  return EXECUTIVE_LEVELS.some((level) => level === value);
}

// Fail-closed boundary guard. The panel shows six blocks side by side, so an
// answer missing one of them - or carrying a count it contradicts - is rejected
// whole rather than rendered partially. `critical_zones.count` must equal the
// list it summarises, because the contract states that invariant and a body that
// disagrees with itself cannot be shown honestly either way.
function isExecutiveSummary(value: unknown): value is ExecutiveSummary {
  if (!record(value)) return false;

  if (!record(value.coverage)) return false;
  const coverage = value.coverage;
  if (
    !isSummaryCount(coverage.catalogue_zones) ||
    !isSummaryCount(coverage.zones_without_batch) ||
    !isSummaryCount(coverage.stale_zones) ||
    !isSummaryCount(coverage.demo_zones)
  ) {
    return false;
  }

  if (!record(value.levels)) return false;
  const levels = value.levels;
  for (const level of EXECUTIVE_LEVELS) if (!isSummaryCount(levels[level])) return false;

  if (!record(value.delta)) return false;
  const delta = value.delta;
  for (const key of ['zones_compared', 'zones_changed', 'zones_without_previous', 'zones_incomparable'] as const) {
    if (!isSummaryCount(delta[key])) return false;
  }
  if (!Array.isArray(delta.transitions)) return false;
  for (const entry of delta.transitions) {
    if (!record(entry) || !isExecutiveLevel(entry.from) || !isExecutiveLevel(entry.to)) return false;
    if (!isSummaryCount(entry.zones) || entry.zones < 1) return false;
  }

  if (!Array.isArray(value.predominant_variables)) return false;
  for (const entry of value.predominant_variables) {
    if (!record(entry) || !nonempty(entry.name) || !isSummaryCount(entry.zones) || entry.zones < 1) return false;
  }

  if (!record(value.critical_zones)) return false;
  const critical = value.critical_zones;
  if (!isSummaryCount(critical.count) || !Array.isArray(critical.zone_ids)) return false;
  for (const zone of critical.zone_ids) if (!nonempty(zone)) return false;
  if (critical.count !== critical.zone_ids.length) return false;

  if (!record(value.active_alerts)) return false;
  return isSummaryCount(value.active_alerts.count);
}

// `config.routes` is the shared route table this unit does not own, so the route
// is named here the way the transport names the job creation path. The page
// reads through the gateway, like every other `/v1/*` read.
const EXECUTIVE_SUMMARY_ROUTE = '/v1/risk/executive-summary';

// One read answers the executive summary: coverage, levels, the recent variation
// and the two PM-01 members. A failure is an outcome, never a partial summary:
// the panel states it inline and the rest of the view keeps working.
export async function executiveSummary(signal?: AbortSignal): Promise<Outcome<ExecutiveSummary>> {
  const result = await requestJson(
    'executiveSummary',
    `${gatewayOrigin}${EXECUTIVE_SUMMARY_ROUTE}`,
    { authenticated: true },
    signal,
  );
  return guardOutcome(result, isExecutiveSummary);
}

// --- Multi-zone comparison (PM-05) -----------------------------------------
//
// `GET /v1/risk/compare` is the first risk read that accepts a LIST of zones. It
// answers one comparison in one request - never one read per zone - and its body
// is attributable: the route echoes the accepted window, the accepted
// granularity and the requested zone order, so a cached or crossed answer can be
// discarded instead of rendered under another question.
//
// Three properties travel with this code:
//   1. the request is judged before anything is read: two or three DISTINCT
//      zones, a granularity inside the closed vocabulary and an ordered window,
//      or nothing is sent at all;
//   2. the body is closed: a member the contract does not declare rejects the
//      WHOLE answer, because a comparison with an invented axis would be read as
//      data the service never served;
//   3. the echo is checked member by member, so an answer for another window,
//      another granularity or another zone order is `malformed`, not a value.

export type ComparisonGranularity = 'hour' | 'day' | 'week';

// The closed granularity vocabulary of the endpoint.
export const COMPARISON_GRANULARITIES: readonly ComparisonGranularity[] = ['hour', 'day', 'week'];

// The size of a comparison, mirrored from the route: two is the minimum that
// makes a comparison and three is the maximum the page has axes for.
export const COMPARISON_MIN_ZONES = 2;
export const COMPARISON_MAX_ZONES = 3;

// The per-granularity caps of the endpoint, in milliseconds: 48 hours for `hour`
// and 31 days for `day` and `week`. The page asks for the whole admitted window
// instead of a shorter one it would then have to explain, and it declares that
// window in text.
const COMPARISON_WINDOW_MS: Record<ComparisonGranularity, number> = {
  hour: 48 * 3_600_000,
  day: 31 * 86_400_000,
  week: 31 * 86_400_000,
};

export function isComparisonGranularity(value: unknown): value is ComparisonGranularity {
  return typeof value === 'string' && (COMPARISON_GRANULARITIES as readonly string[]).includes(value);
}

// The window the page asks for, as RFC 3339 instants in UTC. `now` is injectable
// so the window policy is testable without a clock, and the caller renders the
// same window the response echoes.
export function comparisonWindow(
  granularity: ComparisonGranularity,
  now: Date = new Date(),
): { from: string; to: string } {
  const to = now.getTime();
  return { from: new Date(to - COMPARISON_WINDOW_MS[granularity]).toISOString(), to: new Date(to).toISOString() };
}

// One zone's stored assessment at the shared cutoff. It is deliberately narrower
// than `RiskBatch`: the route serves no freshness, because data_status, notice and
// valid_until describe a batch's current state and would make an old assessment
// look fresh.
export interface ComparisonAssessment {
  batch_id: string;
  requested_at: string;
  published_at: string;
  risk_level: RiskLevel;
  factors: unknown[];
  model_version: string;
  synthetic: boolean;
}

// One PM-04 bucket inside the window: the explicit start, the batch it reports
// and that batch's level and provenance. A point carries no freshness either.
export interface ComparisonPoint {
  bucket_start: string;
  batch_id: string;
  requested_at: string;
  published_at: string;
  risk_level: RiskLevel;
  model_version: string;
  synthetic: boolean;
}

// One comparison axis. The zone appears because it was requested, not because it
// has data, so `assessment` and `history` can both be empty.
export interface ComparisonZone {
  zone_id: string;
  assessment: ComparisonAssessment | null;
  history: ComparisonPoint[];
}

// The comparison body. There is deliberately no priority member: the domain has
// no accepted weights yet, and a fabricated fourth axis is not an option.
export interface ComparisonCollection {
  from: string;
  to: string;
  granularity: ComparisonGranularity;
  zones: ComparisonZone[];
}

// What the caller asks for. The window travels with the request because the
// transport has to check the echo against what it sent.
export interface ComparisonRequest {
  zoneIds: readonly string[];
  granularity: ComparisonGranularity;
  from: string;
  to: string;
}

// The declared members of each level, in one place. `additionalProperties: false`
// is a contract promise, so an undeclared member is a contract change and rejects
// the answer instead of being ignored.
const COMPARISON_COLLECTION_MEMBERS = ['from', 'to', 'granularity', 'zones'] as const;
const COMPARISON_ZONE_MEMBERS = ['zone_id', 'assessment', 'history'] as const;
const COMPARISON_ASSESSMENT_MEMBERS = [
  'batch_id',
  'requested_at',
  'published_at',
  'risk_level',
  'factors',
  'model_version',
  'synthetic',
] as const;
const COMPARISON_POINT_MEMBERS = [
  'bucket_start',
  'batch_id',
  'requested_at',
  'published_at',
  'risk_level',
  'model_version',
  'synthetic',
] as const;

// An object with EXACTLY the declared members: no missing one and no extra one.
function closedRecord(value: unknown, members: readonly string[]): value is Record<string, unknown> {
  if (!record(value)) return false;
  const present = Object.keys(value);
  return present.length === members.length && members.every(member => Object.prototype.hasOwnProperty.call(value, member));
}

// An instant as a number, or null when it cannot be read. Comparing instants by
// value rather than by spelling is deliberate: the same instant has more than one
// legal RFC 3339 rendering, and a trailing-zero difference is not another window.
// `format: date-time` is RFC 3339, not "whatever `Date.parse` tolerates": the
// contract's instant names a date, a time and a MANDATORY offset (`Z` or
// `±HH:MM`), so `01/02/2026` and a bare `2026-11-01T00:00:00` are not instants
// the route accepts. The shape is checked first, then the civil fields, and only
// then the value: `Date.parse` alone would ACCEPT an impossible civil date such
// as `2026-02-31` by rolling it into March, so this guard rejects a month outside
// 1-12, a day outside the month (leap February included) and an hour, minute or
// second outside 00-23, 00-59 and 00-59.
// The instant grammar and the month table are declared once, beside `isInstant`
// above: that guard, this one and the history-series window all read the same
// RFC 3339 shape, and a second copy would be a second answer to one question.
// The reading below uses only the civil fields, which both spellings capture.

// The leap rule the calendar uses, not the one `year % 4` suggests: 1900 is not
// a leap year and 2000 is.
function daysInMonth(year: number, month: number): number {
  if (month !== 2) return DAYS_IN_MONTH[month - 1];
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
}

function instant(value: unknown): number | null {
  if (!nonempty(value)) return null;
  const fields = RFC3339_INSTANT.exec(value);
  if (fields === null) return null;
  const year = Number(fields[1]);
  const month = Number(fields[2]);
  const day = Number(fields[3]);
  const hour = Number(fields[4]);
  const minute = Number(fields[5]);
  const second = Number(fields[6]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

// `format: uuid` is eight-four-four-four-twelve hex digits; case is not
// semantic, so both spellings are accepted. It is declared for `batch_id` in
// `ComparisonAssessment` and `HistoryBucket`, and it is deliberately NOT
// declared for `zone_id`, which is any catalogue code.
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function uuid(value: unknown): boolean {
  return nonempty(value) && UUID.test(value);
}

function isComparisonLevel(value: unknown): value is RiskLevel {
  return typeof value === 'string' && (RISK_LEVELS as readonly string[]).includes(value);
}

function isComparisonAssessment(value: unknown): value is ComparisonAssessment {
  if (!closedRecord(value, COMPARISON_ASSESSMENT_MEMBERS)) return false;
  return (
    uuid(value.batch_id) &&
    instant(value.requested_at) !== null &&
    instant(value.published_at) !== null &&
    isComparisonLevel(value.risk_level) &&
    Array.isArray(value.factors) &&
    value.factors.every(record) &&
    nonempty(value.model_version) &&
    typeof value.synthetic === 'boolean'
  );
}

function isComparisonPoint(value: unknown): value is ComparisonPoint {
  if (!closedRecord(value, COMPARISON_POINT_MEMBERS)) return false;
  return (
    instant(value.bucket_start) !== null &&
    uuid(value.batch_id) &&
    instant(value.requested_at) !== null &&
    instant(value.published_at) !== null &&
    isComparisonLevel(value.risk_level) &&
    nonempty(value.model_version) &&
    typeof value.synthetic === 'boolean'
  );
}

function isComparisonZone(value: unknown): value is ComparisonZone {
  if (!closedRecord(value, COMPARISON_ZONE_MEMBERS)) return false;
  if (!nonempty(value.zone_id)) return false;
  if (value.assessment !== null && !isComparisonAssessment(value.assessment)) return false;
  return Array.isArray(value.history) && value.history.every(isComparisonPoint);
}

function isComparisonCollection(value: unknown): value is ComparisonCollection {
  if (!closedRecord(value, COMPARISON_COLLECTION_MEMBERS)) return false;
  return (
    instant(value.from) !== null &&
    instant(value.to) !== null &&
    isComparisonGranularity(value.granularity) &&
    Array.isArray(value.zones) &&
    value.zones.every(isComparisonZone)
  );
}

// The request guard. It answers a failure, never a repaired request: an empty
// entry, a duplicate, a fourth zone, a granularity outside the closed set and an
// empty or reversed window are all refused BEFORE a request is issued, so the
// route is never asked a question the page could have answered itself.
function comparisonRequestFailure(request: ComparisonRequest): Failure | null {
  const zones = request.zoneIds;
  if (
    !Array.isArray(zones) ||
    zones.length < COMPARISON_MIN_ZONES ||
    zones.length > COMPARISON_MAX_ZONES
  ) {
    return failureSpec('malformed', 'invalid_comparison_request');
  }
  const seen = new Set<string>();
  for (const zone of zones) {
    if (!nonempty(zone) || seen.has(zone)) return failureSpec('malformed', 'invalid_comparison_request');
    seen.add(zone);
  }
  if (!isComparisonGranularity(request.granularity)) return failureSpec('malformed', 'invalid_comparison_request');
  const from = instant(request.from);
  const to = instant(request.to);
  if (from === null || to === null || from >= to) return failureSpec('malformed', 'invalid_comparison_request');
  return null;
}

// The echo check. Position is the comparison axis, so the zone order is compared
// element by element; the window is compared as instants and the granularity by
// its wire spelling.
function comparisonEchoMatches(body: ComparisonCollection, request: ComparisonRequest): boolean {
  if (body.granularity !== request.granularity) return false;
  if (instant(body.from) !== instant(request.from)) return false;
  if (instant(body.to) !== instant(request.to)) return false;
  if (body.zones.length !== request.zoneIds.length) return false;
  return body.zones.every((zone, index) => zone.zone_id === request.zoneIds[index]);
}

// One call answers the whole comparison. This is the reason the view issues ONE
// read per selection instead of one per zone: the shared cutoff and the shared
// window are properties of the request, not of each zone's answer.
export async function compare(
  request: ComparisonRequest,
  signal?: AbortSignal,
): Promise<Outcome<ComparisonCollection>> {
  const refusal = comparisonRequestFailure(request);
  if (refusal !== null) return failureOutcome<ComparisonCollection>(refusal);
  const query = new URLSearchParams();
  query.set('zone_ids', request.zoneIds.join(','));
  query.set('from', request.from);
  query.set('to', request.to);
  query.set('granularity', request.granularity);
  const result = await requestJson(
    'compare',
    `${gatewayOrigin}${COMPARE_ROUTE}?${query.toString()}`,
    { authenticated: true },
    signal,
  );
  if (result.state !== 'ok') return resultFailure<ComparisonCollection>(result);
  if (!isComparisonCollection(result.body)) {
    return failureOutcome(failureSpec('malformed', 'invalid_shape', result.status, result.requestId));
  }
  if (!comparisonEchoMatches(result.body, request)) {
    return failureOutcome(failureSpec('malformed', 'comparison_echo_mismatch', result.status, result.requestId));
  }
  return { ok: true, data: result.body };
}

// The served payload is nested under `geography` exactly as the declaration
// names it, so the transport only proves that structure and then passes the
// payload through UNCHANGED. It does not flatten it and it does not decide
// integrity: `matches: false`, a missing provider or a stale cutoff is a
// fail-closed decision the domain layer makes on the same body.
//
// V1-P-05 adds two REQUIRED members and both are closed vocabularies, so they are
// proven here instead of being rendered on trust: the five-finding catalogue (its
// order, each code's kind and severity, and a non-empty description) and each
// source's findings (non-empty, no repeats, every code declared) with its review
// (`null` or a coherent one about the same source).
function isSourceProvenance(value: unknown): value is SourceProvenance {
  if (!record(value)) return false;
  const geography = record(value.geography) ? value.geography : null;
  const provenance = geography && record(geography.provenance) ? geography.provenance : null;
  const integrity = geography && record(geography.integrity) ? geography.integrity : null;
  if (geography === null || provenance === null || integrity === null) return false;
  if (!isQualityCatalog(value.quality_catalog)) return false;
  if (!Array.isArray(value.sources) || !value.sources.every(isSourceQualityEntry)) return false;
  return (
    typeof provenance.provider === 'string' &&
    typeof provenance.attribution === 'string' &&
    typeof provenance.restriction === 'string' &&
    typeof provenance.derived_sha256 === 'string' &&
    typeof provenance.record_count === 'number' &&
    Number.isFinite(provenance.record_count) &&
    typeof integrity.matches === 'boolean' &&
    typeof geography.cutoff_semantics === 'string'
  );
}

function isQualityFindingCode(value: unknown): value is QualityFindingCode {
  return typeof value === 'string' && (QUALITY_FINDINGS as readonly string[]).includes(value);
}

// The catalogue is positional on purpose: the service publishes the ratified
// order, so a reordered list is refused rather than sorted here. Each entry must
// carry the kind and severity its code has, which keeps a renamed trait from
// being painted as a finding the page cannot explain.
function isQualityCatalog(value: unknown): value is QualityFindingDefinition[] {
  if (!Array.isArray(value) || value.length !== QUALITY_FINDINGS.length) return false;
  return value.every((entry, index) => {
    if (!record(entry)) return false;
    const code = QUALITY_FINDINGS[index];
    const traits = QUALITY_FINDING_TRAITS[code];
    return (
      entry.code === code &&
      entry.kind === traits.kind &&
      entry.severity === traits.severity &&
      nonempty(entry.description)
    );
  });
}

function isSourceReviewDecision(value: unknown): value is SourceReviewDecision {
  return typeof value === 'string' && (SOURCE_REVIEW_DECISIONS as readonly string[]).includes(value);
}

// One stored review. `reviewed_by` and `reviewed_at` are never empty: a review
// without an actor or an instant is not a decision anybody can be held to.
function isSourceReview(value: unknown): value is SourceReview {
  if (!record(value)) return false;
  if (!nonempty(value.source_id)) return false;
  if (!isSourceReviewDecision(value.decision)) return false;
  if (typeof value.note !== 'string' || Array.from(value.note).length > SOURCE_REVIEW_NOTE_LIMIT) return false;
  if (!nonempty(value.reviewed_by)) return false;
  if (!nonempty(value.reviewed_at)) return false;
  return Number.isFinite(Date.parse(value.reviewed_at as string));
}

function nullableSourceInstant(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function nullableAge(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

// One source: the freshness the cycle always served, its findings and its review.
// A review about another source is refused here, because painting it as this
// source's decision would attribute one source's review to another.
function isSourceQualityEntry(value: unknown): value is SourceQualityEntry {
  if (!record(value)) return false;
  if (!nonempty(value.source_id)) return false;
  if (typeof value.complete !== 'boolean') return false;
  if (!nullableSourceInstant(value.last_run_at) || !nullableSourceInstant(value.next_run_at)) return false;
  if (!nullableAge(value.age_seconds)) return false;
  if (value.last_error !== undefined && typeof value.last_error !== 'string') return false;
  if (!Array.isArray(value.quality_findings) || value.quality_findings.length === 0) return false;
  const seen = new Set<string>();
  for (const finding of value.quality_findings) {
    if (!isQualityFindingCode(finding) || seen.has(finding)) return false;
    seen.add(finding);
  }
  if (value.review === null) return true;
  return isSourceReview(value.review) && value.review.source_id === value.source_id;
}

// The review write's own request refusal. It runs BEFORE the request, so an
// unhonourable body never reaches the gateway: an empty source, a decision outside
// the closed pair or a note past the stored bound cannot be stored by definition.
function sourceReviewRequestFailure(sourceId: string, input: { decision: string; note?: string }): Failure | null {
  if (typeof sourceId !== 'string' || sourceId.trim() === '') {
    return failureSpec('malformed', 'invalid_source_review_request');
  }
  if (!isSourceReviewDecision(input.decision)) return failureSpec('malformed', 'invalid_source_review_request');
  const note = input.note ?? '';
  if (typeof note !== 'string' || Array.from(note).length > SOURCE_REVIEW_NOTE_LIMIT) {
    return failureSpec('malformed', 'invalid_source_review_request');
  }
  return null;
}

export async function sources(signal?: AbortSignal): Promise<Outcome<SourceProvenance>> {
  const result = await requestJson('sources', `${gatewayOrigin}${routes.sources}`, { authenticated: true }, signal);
  return guardOutcome(result, isSourceProvenance);
}

// Appends one human decision about one source. The actor is deliberately absent
// from the body: the bearer token carries it and the server reads it there, so a
// client cannot attribute a review to anybody. The answer must name the source
// that was reviewed; a body about another source is refused as `source_mismatch`
// rather than painted as this decision.
export async function reviewSource(
  sourceId: string,
  input: { decision: SourceReviewDecision; note?: string },
  signal?: AbortSignal,
): Promise<Outcome<SourceReview>> {
  const refusal = sourceReviewRequestFailure(sourceId, input);
  if (refusal !== null) return failureOutcome<SourceReview>(refusal);
  const result = await requestJson(
    'sourceReview',
    `${gatewayOrigin}${routes.sources}/${encodeURIComponent(sourceId)}/review`,
    {
      method: 'POST',
      body: JSON.stringify({ decision: input.decision, note: input.note ?? '' }),
      headers: { 'Content-Type': 'application/json' },
      authenticated: true,
    },
    signal,
  );
  if (result.state !== 'ok') return resultFailure<SourceReview>(result);
  if (!isSourceReview(result.body)) {
    return failureOutcome(failureSpec('malformed', 'invalid_shape', result.status, result.requestId));
  }
  if (result.body.source_id !== sourceId) {
    return failureOutcome(failureSpec('malformed', 'source_mismatch', result.status, result.requestId));
  }
  return { ok: true, data: result.body };
}

export async function riskStatus(signal?: AbortSignal): Promise<Outcome<ServiceSnapshot>> {
  const result = await requestJson('riskStatus', `${gatewayOrigin}${routes.riskStatus}`, { authenticated: true }, signal);
  return guardOutcome(result, isServiceSnapshot);
}

export async function jobsStatus(signal?: AbortSignal): Promise<Outcome<ServiceSnapshot>> {
  const result = await requestJson('jobsStatus', `${gatewayOrigin}${routes.jobsStatus}`, { authenticated: true }, signal);
  return guardOutcome(result, isServiceSnapshot);
}

// --- Aggregate service status (PM-16 / S2) ---------------------------------
//
// `GET /v1/status` is answered by the gateway itself over four fixed status
// surfaces. The body's order is part of the contract (risk, jobs, prevention,
// inference) and so is the closed state vocabulary, so the guard compares the
// served spelling against both instead of trusting the declaration: an unknown
// service, a reordered list, an unknown state or a gateway entry that is not
// `ready` rejects the WHOLE answer, and `ready` is never invented for an entry.
//
// A 503 is not a transport failure here. The contract states that a not-ready
// service makes the aggregate answer 503 WITH THE SAME BODY, and that body is the
// only place that says which service is not ready; so the read preserves it and
// reports the code it arrived with. 200 and 503 are the only two codes the
// contract documents, so any other accepted code (a 201, a 202, ...) is refused
// rather than rewritten into a 200 the service did not send. Only an unreadable
// body, an undocumented code, an incoherent code/body pair or a real transport
// failure is a failure.
export const SERVICE_ORDER = ['risk', 'jobs', 'prevention', 'inference'] as const;
export type ServiceName = (typeof SERVICE_ORDER)[number];

export const SERVICE_STATES = ['ready', 'degraded', 'unknown', 'unauthorized', 'not_configured'] as const;
export type ServiceState = (typeof SERVICE_STATES)[number];

export interface MultiserviceStatusEntry {
  service: ServiceName;
  state: ServiceState;
}

export interface MultiserviceStatus {
  checked_at: string;
  gateway: { state: 'ready' };
  services: MultiserviceStatusEntry[];
}

// 200 only when no entry is degraded or unknown; 503 when at least one is. The
// two states that make the aggregate answer 503 are named once so the guard, the
// view and its tests cannot disagree about which ones they are.
export function isUnreadyState(state: ServiceState): boolean {
  return state === 'degraded' || state === 'unknown';
}

function isServiceState(value: unknown): value is ServiceState {
  return typeof value === 'string' && SERVICE_STATES.includes(value as ServiceState);
}

// One state of the closed catalogue is positional: `not_configured` reports an
// unset inference address, which only risk's inference evidence can state. The
// gateway's operational parser (risk, jobs, prevention) has no way to emit it, so
// accepting it there would render a state no service is able to report.
function isServiceStateOf(service: ServiceName, value: unknown): value is ServiceState {
  if (!isServiceState(value)) return false;
  return value !== 'not_configured' || service === 'inference';
}

function isMultiserviceStatus(value: unknown): value is MultiserviceStatus {
  if (!record(value)) return false;
  if (!nonempty(value.checked_at)) return false;
  if (!record(value.gateway) || value.gateway.state !== 'ready') return false;
  if (!Array.isArray(value.services) || value.services.length !== SERVICE_ORDER.length) return false;
  for (const [index, entry] of value.services.entries()) {
    if (!record(entry)) return false;
    const service = SERVICE_ORDER[index];
    // The position is the contract: entry i must name service i, so a shuffled
    // list can never be rendered under the order the server did not send. Once
    // the name matches, the state is validated against that same service.
    if (entry.service !== service) return false;
    if (!isServiceStateOf(service, entry.state)) return false;
  }
  return true;
}

export type AggregateStatusOutcome =
  | { ok: true; status: 200 | 503; data: MultiserviceStatus }
  | { ok: false; failure: Failure };

// `Outcome<T>`'s success branch carries no transport status, so the aggregate's
// failure branch is built here with the very same shape every other read reports.
function statusFailure(failure: Failure): AggregateStatusOutcome {
  return { ok: false, failure };
}

export async function aggregateStatus(signal?: AbortSignal): Promise<AggregateStatusOutcome> {
  const result = await requestJson(
    'aggregateStatus',
    `${gatewayOrigin}${AGGREGATE_STATUS_ROUTE}`,
    { authenticated: true },
    signal,
  );
  // The second arm is the documented not-ready answer, not an error: its body is
  // the verdict and it is read exactly like the 200 one. The codes are named one
  // by one on purpose: `response.ok` covers every 2xx, so testing the transport's
  // own success flag here would accept a 201/202 and normalize it to 200.
  const documented =
    (result.state === 'ok' && result.status === 200) || (result.state === 'httpError' && result.status === 503);
  if (!documented) return statusFailure(failureOf(result));
  const status: 200 | 503 = result.status === 503 ? 503 : 200;
  if (!isMultiserviceStatus(result.body)) {
    return statusFailure(failureSpec('malformed', 'invalid_shape', result.status, result.requestId));
  }
  // The code and the body must agree: a 200 carrying a not-ready entry, or a 503
  // carrying none, is an incoherent echo. It is refused rather than rendered as a
  // verdict the service did not state.
  const notReady = result.body.services.some(entry => isUnreadyState(entry.state));
  if (notReady !== (status === 503)) {
    return statusFailure(failureSpec('malformed', 'status_mismatch', result.status, result.requestId));
  }
  return { ok: true, status, data: result.body };
}

// Fail-closed catalogue validation: only entries that state a non-empty `id`
// survive, and a missing `description` becomes an empty string rather than an
// invented label. A non-array catalogue is rejected by the caller as malformed.
export function parseScenarios(value: unknown): Scenario[] {
  if (!Array.isArray(value)) return [];
  const scenarios: Scenario[] = [];
  for (const entry of value) {
    if (!record(entry) || typeof entry.id !== 'string' || entry.id === '') continue;
    scenarios.push({ id: entry.id, description: typeof entry.description === 'string' ? entry.description : '' });
  }
  return scenarios;
}

export async function scenarios(signal?: AbortSignal): Promise<Outcome<Scenario[]>> {
  const result = await requestJson('scenarios', `${gatewayOrigin}${routes.scenarios}`, { authenticated: true }, signal);
  if (result.state !== 'ok') return resultFailure<Scenario[]>(result);
  if (!Array.isArray(result.body)) {
    return failureOutcome(failureSpec('malformed', 'invalid_shape', result.status, result.requestId));
  }
  return { ok: true, data: parseScenarios(result.body) };
}

// Admin-only and parameterless: the service bounds the answer itself, so the
// page never sends a limit or an offset. A 403 is returned as `forbidden`, and
// the view renders it explicitly instead of hiding the panel.
export async function audit(signal?: AbortSignal): Promise<Outcome<AuditEntry[]>> {
  const result = await requestJson('audit', `${gatewayOrigin}${routes.audit}`, { authenticated: true }, signal);
  if (result.state !== 'ok') return resultFailure<AuditEntry[]>(result);
  if (!Array.isArray(result.body) || !result.body.every(isAuditEntry)) {
    return failureOutcome(failureSpec('malformed', 'invalid_shape', result.status, result.requestId));
  }
  return { ok: true, data: result.body };
}

export async function createJob(
  input: { zoneId: string; scenarioId?: string; idempotencyKey: string },
  signal?: AbortSignal,
): Promise<Outcome<Job>> {
  // A new request supersedes any in-flight poll of the previous job.
  nextSequence('job');
  const body: Record<string, string> = { zone_id: input.zoneId };
  // The server rejects an explicit empty `scenario_id` with 400 while an omitted
  // field keeps the legacy fixture, so the field travels only when chosen.
  if (typeof input.scenarioId === 'string' && input.scenarioId !== '') body.scenario_id = input.scenarioId;
  const result = await requestJson(
    'createJob',
    `${gatewayOrigin}${JOBS_ROUTE}`,
    {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': input.idempotencyKey },
      authenticated: true,
    },
    signal,
  );
  if (result.state !== 'ok') return resultFailure<Job>(result);
  if (!isJob(result.body)) {
    return failureOutcome(failureSpec('malformed', 'invalid_shape', result.status, result.requestId));
  }
  if (result.body.zone_id !== input.zoneId) {
    return failureOutcome(failureSpec('malformed', 'zone_mismatch', result.status, result.requestId));
  }
  return { ok: true, data: result.body };
}

export async function job(id: string, signal?: AbortSignal): Promise<Outcome<Job>> {
  const result = await requestJson('job', `${gatewayOrigin}${jobRoute(id)}`, { authenticated: true }, signal);
  if (result.state !== 'ok') return resultFailure<Job>(result);
  if (!isJob(result.body)) {
    return failureOutcome(failureSpec('malformed', 'invalid_shape', result.status, result.requestId));
  }
  if (result.body.id !== id) {
    return failureOutcome(failureSpec('malformed', 'job_mismatch', result.status, result.requestId));
  }
  return { ok: true, data: result.body };
}

// --- Manual publication of the risk cycle (V1-P-06) -----------------------
//
// `POST /v1/risk/cycle/run` is admin-only and declares NO body: the operator who
// triggered the evaluation is the verified token subject, so a body that named one
// is refused with 400 `invalid_body` before the cycle starts. This transport
// therefore sends none — an empty object would also be accepted, but "no body" is
// the one spelling that cannot look like it carried an actor.
//
// The result is one `CycleRunResult`: the source, the window, whether the cycle
// completed and one entry per configured zone. It fails closed on a payload the
// view cannot use, so a publication can never be claimed from an unusable answer.
// The three answers a caller must keep apart stay apart: 401 closes the session
// and is `unauthorized`, 403 is `forbidden`, and 503 `cycle_unavailable` is an
// availability failure that keeps its own code and status.
export interface CycleZoneResult {
  readonly zone_id: string;
  readonly published: boolean;
  // The reason a zone was not published, as the service states it. Absent when the
  // zone published; a failure without one is never given an invented reason.
  readonly error?: string;
}

export interface CycleRunResult {
  readonly source_id: string;
  readonly started_at: string;
  readonly finished_at: string;
  readonly complete: boolean;
  readonly zones: readonly CycleZoneResult[];
}

function isCycleZoneResult(value: unknown): value is CycleZoneResult {
  return (
    record(value) &&
    nonempty(value.zone_id) &&
    typeof value.published === 'boolean' &&
    optionalString(value.error)
  );
}

// One zone failed when it did not publish, or when it published while reporting an
// error. `error` carries `omitempty` in the service, so an absent or empty reason is
// not a failure by itself.
function cycleZoneFailed(zone: CycleZoneResult): boolean {
  return !zone.published || (zone.error !== undefined && zone.error !== '');
}

function isCycleRunResult(value: unknown): value is CycleRunResult {
  if (!record(value)) return false;
  if (typeof value.source_id !== 'string' || typeof value.started_at !== 'string') return false;
  if (typeof value.finished_at !== 'string' || typeof value.complete !== 'boolean') return false;
  if (!Array.isArray(value.zones) || !value.zones.every(isCycleZoneResult)) return false;
  // `cycle.Runner` starts `RunResult.Complete` at true and clears it exactly when a
  // zone fails, so the Go invariant is BICONDITIONAL: complete is true if and only if
  // every zone published and carries no error. A payload that states otherwise
  // contradicts itself — a "complete" run reporting a failed zone, or an
  // "incomplete" run reporting no failure at all — and accepting either would let
  // the page announce a publication the cycle did not make. The stricter reading is
  // deliberate; the two allowed combinations are pinned in the transport tests.
  const failures = (value.zones as readonly CycleZoneResult[]).filter(cycleZoneFailed).length;
  return value.complete === (failures === 0);
}

export async function cycleRun(signal?: AbortSignal): Promise<Outcome<CycleRunResult>> {
  const result = await requestJson(
    'cycleRun',
    `${gatewayOrigin}${CYCLE_RUN_ROUTE}`,
    // No `body`, and therefore no `Content-Type`: the route takes its actor from
    // the verified token and refuses any body that declares one.
    { method: 'POST', authenticated: true },
    signal,
  );
  return guardOutcome(result, isCycleRunResult);
}

// --- Preventive actions (frozen `prevention` contract) ---------------------
//
// The transport proves the shape the view can use and fails closed on anything
// else, exactly like every other route. The state machine lives in
// `domain/prevention.ts`; the role affordance and the rendered refusal live in
// the view. A `409 invalid_transition` and a `422 invalid_input` are NOT
// swallowed here: the failure keeps its status, its `code` and its request id so
// the view can state what the server answered.

function isPreventiveAction(value: unknown): value is PreventiveAction {
  if (!record(value)) return false;
  if (!nonempty(value.id) || !nonempty(value.community_code) || !nonempty(value.title)) return false;
  if (typeof value.status !== 'string') return false;
  // `assignee` is a nullable column (`*string`), so an unassigned action answers
  // `null`: demanding a string here rejected a real 200/201 as `invalid_shape`
  // and the view rendered nothing.
  if (!optionalString(value.description) || !optionalString(value.priority) || !nullableString(value.assignee)) {
    return false;
  }
  if (!nullableUuid(value.assignee_id)) return false;
  if (!nullableString(value.due_date) || !optionalString(value.created_by)) return false;
  if (!optionalString(value.created_at) || !optionalString(value.updated_at)) return false;
  return true;
}

// A history row must state the status it moved TO. The actor, the note and the
// from-status are optional facts the service may omit; an omitted one is labelled
// in place, never filled from another row.
function isActionHistoryEntry(value: unknown): value is ActionHistoryEntry {
  return (
    record(value) &&
    nonempty(value.to_status) &&
    nullableString(value.from_status) &&
    optionalNumber(value.id) &&
    optionalString(value.action_id) &&
    optionalString(value.actor_sub) &&
    optionalString(value.note) &&
    optionalString(value.created_at)
  );
}

function isPreventiveActionDetail(value: unknown): value is PreventiveActionDetail {
  if (!record(value)) return false;
  if (!isPreventiveAction(value) || !Array.isArray(value.history) || !value.history.every(isActionHistoryEntry)) {
    return false;
  }
  // The S2 collections are required on the detail route. A detail without them is
  // a contract change, and the page must fail closed instead of assuming an empty
  // sufficiency state the server never sent.
  if (!Array.isArray(value.evidence) || !value.evidence.every(isPreventiveEvidence)) return false;
  if (!Array.isArray(value.evidence_reviews) || !value.evidence_reviews.every(isPreventiveEvidenceReview)) return false;
  if (!Array.isArray(value.reassessments) || !value.reassessments.every(isPreventiveReassessment)) return false;
  return typeof value.evidence_sufficient === 'boolean';
}

// The S2 records have their own closed shapes. Each validator fails closed so a
// malformed snapshot, review or reassessment is never rendered as if the server
// had produced it.
function isPreventiveEvidence(value: unknown): value is PreventiveEvidence {
  if (!record(value)) return false;
  if (!nonempty(value.criterion)) return false;
  if (!Array.isArray(value.references) || value.references.length === 0) return false;
  if (!value.references.every(reference => typeof reference === 'string' && nonempty(reference))) return false;
  return (
    optionalNumber(value.id) &&
    optionalString(value.action_id) &&
    optionalString(value.created_by) &&
    optionalString(value.created_at)
  );
}

function isPreventiveEvidenceReview(value: unknown): value is PreventiveEvidenceReview {
  if (!record(value)) return false;
  if (!nonempty(value.decision)) return false;
  if (typeof value.evidence_id !== 'number' || !Number.isInteger(value.evidence_id) || value.evidence_id <= 0) {
    return false;
  }
  return (
    optionalNumber(value.id) &&
    optionalString(value.action_id) &&
    optionalString(value.reviewer_sub) &&
    optionalString(value.note) &&
    optionalString(value.reviewed_at)
  );
}

function isPreventiveReassessment(value: unknown): value is PreventiveReassessment {
  if (!record(value)) return false;
  if (!nonempty(value.job_id) || !nonempty(value.batch_id) || !nonempty(value.version)) return false;
  if (!nonempty(value.risk_level) || !nonempty(value.zone_id)) return false;
  if (typeof value.synthetic !== 'boolean') return false;
  // A synthetic classification is never causal proof of risk reduction. A `true`
  // here is a contract change, so it is refused instead of rendered as a claim.
  if (value.causal_proof !== false) return false;
  return (
    optionalNumber(value.id) &&
    optionalString(value.action_id) &&
    optionalString(value.batch_published_at) &&
    optionalString(value.linked_by) &&
    optionalString(value.linked_at)
  );
}

export async function preventiveActions(
  filter: { communityCode?: string; status?: string } = {},
  signal?: AbortSignal,
): Promise<Outcome<PreventiveAction[]>> {
  const query = new URLSearchParams();
  if (nonempty(filter.communityCode)) query.set('community_code', filter.communityCode.trim());
  if (nonempty(filter.status)) query.set('status', filter.status.trim());
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  const result = await requestJson(
    'preventiveActions',
    `${gatewayOrigin}${routes.preventiveActions}${suffix}`,
    { authenticated: true },
    signal,
  );
  if (result.state !== 'ok') return resultFailure<PreventiveAction[]>(result);
  if (!Array.isArray(result.body) || !result.body.every(isPreventiveAction)) {
    return failureOutcome(failureSpec('malformed', 'invalid_shape', result.status, result.requestId));
  }
  return { ok: true, data: result.body };
}

export async function preventiveAction(id: string, signal?: AbortSignal): Promise<Outcome<PreventiveActionDetail>> {
  const result = await requestJson(
    'preventiveAction',
    `${gatewayOrigin}${preventiveActionRoute(id)}`,
    { authenticated: true },
    signal,
  );
  if (result.state !== 'ok') return resultFailure<PreventiveActionDetail>(result);
  if (!isPreventiveActionDetail(result.body)) {
    return failureOutcome(failureSpec('malformed', 'invalid_shape', result.status, result.requestId));
  }
  if (result.body.id !== id) {
    return failureOutcome(failureSpec('malformed', 'action_mismatch', result.status, result.requestId));
  }
  return { ok: true, data: result.body };
}

export interface PreventiveActionInput {
  readonly communityCode: string;
  readonly title: string;
  readonly description?: string;
  readonly priority?: string;
  // The reference a NEW assignment uses: a directory user identifier, resolved
  // by the server against the realm's directory before anything is stored. An
  // identifier the directory does not know is refused 422 and nothing is
  // created. Omitting it creates a valid unassigned action. The legacy free-text
  // `assignee` column is display compatibility for rows that predate this
  // reference; a new assignment never travels through it.
  readonly assigneeId?: string;
  readonly dueDate?: string;
}

export async function createPreventiveAction(
  input: PreventiveActionInput,
  signal?: AbortSignal,
): Promise<Outcome<PreventiveAction>> {
  // An empty optional field is omitted, not sent blank: the server rejects an
  // explicit empty value while an absent one keeps its own default (the same
  // rule the job POST already follows for `scenario_id`).
  const body: Record<string, string> = { community_code: input.communityCode, title: input.title };
  if (nonempty(input.description)) body.description = input.description;
  if (nonempty(input.priority)) body.priority = input.priority;
  if (nonempty(input.assigneeId)) body.assignee_id = input.assigneeId.trim();
  if (nonempty(input.dueDate)) body.due_date = input.dueDate;
  const result = await requestJson(
    'createPreventiveAction',
    `${gatewayOrigin}${routes.preventiveActions}`,
    {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      authenticated: true,
    },
    signal,
  );
  if (result.state !== 'ok') return resultFailure<PreventiveAction>(result);
  if (!isPreventiveAction(result.body)) {
    return failureOutcome(failureSpec('malformed', 'invalid_shape', result.status, result.requestId));
  }
  return { ok: true, data: result.body };
}

export async function transitionPreventiveAction(
  id: string,
  input: { to: string; note?: string },
  signal?: AbortSignal,
): Promise<Outcome<PreventiveAction>> {
  const result = await requestJson(
    'transitionPreventiveAction',
    `${gatewayOrigin}${preventiveTransitionRoute(id)}`,
    {
      method: 'POST',
      // `{to, note}` is the frozen body; the note travels even when empty so the
      // field the contract names is always present.
      body: JSON.stringify({ to: input.to, note: input.note ?? '' }),
      headers: { 'Content-Type': 'application/json' },
      authenticated: true,
    },
    signal,
  );
  if (result.state !== 'ok') return resultFailure<PreventiveAction>(result);
  if (!isPreventiveAction(result.body)) {
    return failureOutcome(failureSpec('malformed', 'invalid_shape', result.status, result.requestId));
  }
  if (result.body.id !== id) {
    return failureOutcome(failureSpec('malformed', 'action_mismatch', result.status, result.requestId));
  }
  return { ok: true, data: result.body };
}

export interface PreventiveEvidenceInput {
  readonly criterion: string;
  readonly references: readonly string[];
}

// Appends one evidence snapshot. The body carries exactly the two documented
// fields; a reference is a citation and is never fetched.
export async function recordPreventiveEvidence(
  id: string,
  input: PreventiveEvidenceInput,
  signal?: AbortSignal,
): Promise<Outcome<PreventiveEvidence>> {
  const result = await requestJson(
    'recordPreventiveEvidence',
    `${gatewayOrigin}${preventiveActionRoute(id)}/evidence`,
    {
      method: 'POST',
      body: JSON.stringify({ criterion: input.criterion, references: input.references }),
      headers: { 'Content-Type': 'application/json' },
      authenticated: true,
    },
    signal,
  );
  if (result.state !== 'ok') return resultFailure<PreventiveEvidence>(result);
  if (!isPreventiveEvidence(result.body)) {
    return failureOutcome(failureSpec('malformed', 'invalid_shape', result.status, result.requestId));
  }
  if (result.body.action_id !== undefined && result.body.action_id !== id) {
    return failureOutcome(failureSpec('malformed', 'action_mismatch', result.status, result.requestId));
  }
  return { ok: true, data: result.body };
}

// Appends one human decision about one named snapshot. The reviewer and the date
// are server-set; the transport never sends an identity.
export async function reviewPreventiveEvidence(
  id: string,
  evidenceId: number,
  input: { decision: string; note?: string },
  signal?: AbortSignal,
): Promise<Outcome<PreventiveEvidenceReview>> {
  const result = await requestJson(
    'reviewPreventiveEvidence',
    `${gatewayOrigin}${preventiveActionRoute(id)}/evidence/${encodeURIComponent(String(evidenceId))}/reviews`,
    {
      method: 'POST',
      body: JSON.stringify({ decision: input.decision, note: input.note ?? '' }),
      headers: { 'Content-Type': 'application/json' },
      authenticated: true,
    },
    signal,
  );
  if (result.state !== 'ok') return resultFailure<PreventiveEvidenceReview>(result);
  if (!isPreventiveEvidenceReview(result.body)) {
    return failureOutcome(failureSpec('malformed', 'invalid_shape', result.status, result.requestId));
  }
  if (result.body.evidence_id !== evidenceId) {
    return failureOutcome(failureSpec('malformed', 'evidence_mismatch', result.status, result.requestId));
  }
  return { ok: true, data: result.body };
}

// Persists the link to one real published batch. The client names only the job;
// batch, version, risk level and the synthetic flag are server-derived.
export async function linkPreventiveReassessment(
  id: string,
  input: { jobId: string },
  signal?: AbortSignal,
): Promise<Outcome<PreventiveReassessment>> {
  const result = await requestJson(
    'linkPreventiveReassessment',
    `${gatewayOrigin}${preventiveActionRoute(id)}/reassessments`,
    {
      method: 'POST',
      body: JSON.stringify({ job_id: input.jobId }),
      headers: { 'Content-Type': 'application/json' },
      authenticated: true,
    },
    signal,
  );
  if (result.state !== 'ok') return resultFailure<PreventiveReassessment>(result);
  if (!isPreventiveReassessment(result.body)) {
    return failureOutcome(failureSpec('malformed', 'invalid_shape', result.status, result.requestId));
  }
  if (result.body.action_id !== undefined && result.body.action_id !== id) {
    return failureOutcome(failureSpec('malformed', 'action_mismatch', result.status, result.requestId));
  }
  return { ok: true, data: result.body };
}

// --- User directory (V1-U-04) --------------------------------------------
//
// `GET /v1/users` is admin-only and read-only. It fails closed on the server
// side (503 `directory_unavailable` when it is not configured, 502
// `directory_upstream_failed` when the identity provider errors), so this
// transport must not flatten either into an empty list: `200 []` means the realm
// really has no users, and a refusal keeps its status, its `code` and its
// `request_id`. Entries are validated one by one; a malformed entry rejects the
// whole answer instead of yielding a partial picker.

// One directory entry, exactly as the contract declares it: the identifier the
// identity provider assigns and a display name that is never empty. The name is
// resolved by the service (first and last name, else the username, else the
// identifier), so the page never composes one.
export interface DirectoryUser {
  readonly id: string;
  readonly display_name: string;
}

function isDirectoryUser(value: unknown): value is DirectoryUser {
  return record(value) && nonempty(value.id) && nonempty(value.display_name);
}

function isDirectoryUsers(value: unknown): value is DirectoryUser[] {
  return Array.isArray(value) && value.every(isDirectoryUser);
}

export async function users(signal?: AbortSignal): Promise<Outcome<DirectoryUser[]>> {
  const result = await requestJson('users', `${gatewayOrigin}${routes.users}`, { authenticated: true }, signal);
  return guardOutcome(result, isDirectoryUsers);
}

// --- Field observations (PM-09) --------------------------------------------
//
// The observation is authored by the server: `created_by` is the verified token
// `sub`, and the creation body carries exactly `zone_id`, `type`, `observed_on`
// and `description`. The type is a closed catalogue the server validates; this
// transport proves the shape the view can use and passes the served list through
// in the order the service returned it (newest first).

function isObservationType(value: unknown): boolean {
  return typeof value === 'string' && OBSERVATION_TYPES.includes(value as ObservationType);
}

function isObservation(value: unknown): value is Observation {
  if (!record(value)) return false;
  if (!nonempty(value.id) || !nonempty(value.zone_id)) return false;
  // A served type outside the closed catalogue is a contract change: the list is
  // refused instead of rendering a row this page cannot label or resubmit.
  if (!isObservationType(value.type)) return false;
  if (!nullableString(value.zone_name)) return false;
  if (!nonempty(value.observed_on) || !nonempty(value.description)) return false;
  // The author and the instant are server facts; a row without them is refused
  // rather than rendered with an invented attribution.
  if (!nonempty(value.created_by) || !nonempty(value.created_at)) return false;
  // PM-10 adds the optional link: null and an absent field are both "no
  // confirmation recorded", and only a value that is neither null nor a string
  // is a contract change.
  if (!nullableString(value.adopted_action_id)) return false;
  return true;
}

function isObservationZone(value: unknown): value is ObservationZone {
  return record(value) && nonempty(value.code) && nonempty(value.name) && nullableString(value.province);
}

// The full list read is validated element by element: a partially valid answer
// is refused wholesale, exactly like the preventive-action list.
function observationList(value: unknown): Observation[] | null {
  if (!Array.isArray(value)) return null;
  const entries: Observation[] = [];
  for (const entry of value) {
    if (!isObservation(entry)) return null;
    entries.push(entry);
  }
  return entries;
}

export async function observations(
  filter: { type?: string } = {},
  signal?: AbortSignal,
): Promise<Outcome<Observation[]>> {
  const query = new URLSearchParams();
  if (nonempty(filter.type)) query.set('type', filter.type.trim());
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  const result = await requestJson(
    'observations',
    `${gatewayOrigin}${routes.observations}${suffix}`,
    { authenticated: true },
    signal,
  );
  if (result.state !== 'ok') return resultFailure<Observation[]>(result);
  const entries = observationList(result.body);
  if (entries === null) {
    return failureOutcome(failureSpec('malformed', 'invalid_shape', result.status, result.requestId));
  }
  // The empty list is data: it is passed through, never replaced by an idle state.
  return { ok: true, data: entries };
}

export async function observationZones(signal?: AbortSignal): Promise<Outcome<ObservationZone[]>> {
  const result = await requestJson('observationZones', `${gatewayOrigin}${routes.observationZones}`, { authenticated: true }, signal);
  if (result.state !== 'ok') return resultFailure<ObservationZone[]>(result);
  if (!Array.isArray(result.body) || !result.body.every(isObservationZone)) {
    return failureOutcome(failureSpec('malformed', 'invalid_shape', result.status, result.requestId));
  }
  return { ok: true, data: result.body };
}

export interface ObservationInput {
  readonly zoneId: string;
  readonly type: string;
  readonly observedOn: string;
  readonly description: string;
}

// The body names the four documented fields. No author travels: reproducing one
// here would present a client-supplied identity as server-verified authorship.
export async function createObservation(input: ObservationInput, signal?: AbortSignal): Promise<Outcome<Observation>> {
  const result = await requestJson(
    'createObservation',
    `${gatewayOrigin}${routes.observations}`,
    {
      method: 'POST',
      body: JSON.stringify({
        zone_id: input.zoneId,
        type: input.type,
        observed_on: input.observedOn,
        description: input.description,
      }),
      headers: { 'Content-Type': 'application/json' },
      authenticated: true,
    },
    signal,
  );
  if (result.state !== 'ok') return resultFailure<Observation>(result);
  if (!isObservation(result.body)) {
    return failureOutcome(failureSpec('malformed', 'invalid_shape', result.status, result.requestId));
  }
  if (result.body.zone_id !== input.zoneId) {
    return failureOutcome(failureSpec('malformed', 'zone_mismatch', result.status, result.requestId));
  }
  return { ok: true, data: result.body };
}

// --- PM-10: observation adoption (S1/S4) -----------------------------------
//
// The one authorized link operation: an operator states that a recorded
// observation justifies an existing preventive action. The body carries the
// action and NOTHING else — the observation is addressed by the path and the
// confirming actor is the verified token subject, so a client cannot assign the
// work, move the action, backdate a confirmation or name itself as author. The
// answer is the observation in its post-link state, so the association the page
// displays is always the one the service stored.
//
// The request kind is its own: a link write must never supersede an in-flight
// observation or action read, and it must not be superseded by one.
export async function adoptObservation(
  observationId: string,
  actionId: string,
  signal?: AbortSignal,
): Promise<Outcome<Observation>> {
  const result = await requestJson(
    'adoptObservation',
    `${gatewayOrigin}${observationAdoptionRoute(observationId)}`,
    {
      method: 'POST',
      body: JSON.stringify({ action_id: actionId }),
      headers: { 'Content-Type': 'application/json' },
      authenticated: true,
    },
    signal,
  );
  if (result.state !== 'ok') return resultFailure<Observation>(result);
  if (!isObservation(result.body)) {
    return failureOutcome(failureSpec('malformed', 'invalid_shape', result.status, result.requestId));
  }
  // A record for another observation, or one that does not state the link that
  // was requested, is refused: the page must never display an association the
  // service did not confirm.
  if (result.body.id !== observationId || !sameIdentifier(result.body.adopted_action_id, actionId)) {
    return failureOutcome(failureSpec('malformed', 'adoption_mismatch', result.status, result.requestId));
  }
  return { ok: true, data: result.body };
}

// A path id is compared byte for byte; an action id is a UUID, whose case is not
// semantic, so the stored spelling is compared without case.
function sameIdentifier(left: unknown, right: string): boolean {
  return nonempty(left) && left.trim().toLowerCase() === right.trim().toLowerCase();
}

// The model registry is passed through as an array of opaque entries: the real
// `GET /v1/models` body is an OBJECT ENVELOPE (`{"models": [...]}`, see
// `backend/services/risk/internal/handler/models.go`), so the transport accepts the
// envelope, rejects a missing/malformed list or a malformed entry, and hands the
// array to `domain/model.ts`, which reads the one active version.
export async function modelVersions(signal?: AbortSignal): Promise<Outcome<unknown[]>> {
  const result = await requestJson('models', `${gatewayOrigin}${routes.models}`, { authenticated: true }, signal);
  if (result.state !== 'ok') return resultFailure<unknown[]>(result);
  if (!record(result.body) || !Array.isArray(result.body.models) || !result.body.models.every(record)) {
    return failureOutcome(failureSpec('malformed', 'invalid_shape', result.status, result.requestId));
  }
  return { ok: true, data: result.body.models };
}

// The FULL `/v1/models` envelope, additive beside `modelVersions` (which keeps
// serving the overview panel unchanged). The registry list is still validated so
// a broken envelope stays a malformed read, but the `effective` projection is
// passed through UNTOUCHED: `core/active-rule.ts` owns the fail-closed identity
// decision, and an absent or malformed projection is a truthful unknown rather
// than a reason to discard the whole read.
export async function modelRegistry(signal?: AbortSignal): Promise<Outcome<ModelRegistry>> {
  const result = await requestJson('models', `${gatewayOrigin}${routes.models}`, { authenticated: true }, signal);
  if (result.state !== 'ok') return resultFailure<ModelRegistry>(result);
  if (!record(result.body) || !Array.isArray(result.body.models) || !result.body.models.every(record)) {
    return failureOutcome(failureSpec('malformed', 'invalid_shape', result.status, result.requestId));
  }
  return { ok: true, data: { models: result.body.models, effective: result.body.effective } };
}

// --- PM-03: counterfactual simulation (`POST /v1/risk/simulate`) ------------
//
// The route re-applies the rule the stored batch recorded to substituted values
// and writes nothing: no batch, no outbox event, no alert and no audit row. Three
// properties travel with this code:
//   1. the body names ONE zone and ONLY the canonical variables that were
//      substituted — a request with no substitution is refused here, before the
//      fetch, because the contract's `minProperties: 1` would answer 400 for it;
//   2. the answer is refused when it echoes another zone or another stored batch,
//      so a slow answer for a batch the operator never prefilled from can never be
//      painted as that batch's counterfactual;
//   3. `freshness` must still say `not_evaluated`: this route takes no staleness
//      decision, and a value that claimed one would be a statement nobody made.
//
// The result is the stored rule applied to hypothetical values. It is not a
// forecast, a probability or an official index, and the view says so.

export const SIMULATION_VARIABLES = [
  'temperatura',
  'humedad_relativa',
  'viento',
  'cobertura_vegetal',
  'incendios_historicos',
] as const;

export type SimulationVariable = (typeof SIMULATION_VARIABLES)[number];

export interface SimulationFactor {
  name: string;
  known: boolean;
  // Omitted when the variable is absent: a missing observation is never served
  // as zero, and the page must not draw it as a measurement.
  value?: number;
  contribution?: number;
}

export interface SimulationAssessment {
  level: string;
  factors: SimulationFactor[];
}

export interface SimulationPolicy {
  policy_id: string;
  params_hash: string;
}

export interface SimulationResult {
  batch_id: string;
  zone_id: string;
  model_version: string;
  stored_level: string;
  policy: SimulationPolicy;
  computation_instant: string;
  freshness: 'not_evaluated';
  before: SimulationAssessment;
  after: SimulationAssessment;
  notice: string;
}

export interface SimulationInput {
  readonly zoneId: string;
  // The stored batch the page prefilled from. It is verified against the answer's
  // echo and never travels in the body: the route always simulates the newest one.
  readonly batchId: string;
  readonly variables: Partial<Record<SimulationVariable, number | null>>;
}

const SIMULATION_ROUTE = '/v1/risk/simulate';

// The five risk levels are a closed vocabulary: a level outside it is a contract
// change, not a label to pass through to the page.
function isRiskLevel(value: unknown): boolean {
  return typeof value === 'string' && (RISK_LEVELS as readonly string[]).includes(value);
}

function isSimulationFactor(value: unknown): boolean {
  if (!record(value) || !nonempty(value.name) || typeof value.known !== 'boolean') return false;
  if (value.known) return Number.isFinite(value.value) && Number.isFinite(value.contribution);
  return value.value === undefined && value.contribution === undefined;
}

// One assessment states a level and exactly one entry per canonical variable, in
// canonical order: the five rows the page renders are the five variables the rule
// actually used, and a missing or extra one is a contract change, not a gap to
// fill in from elsewhere.
function isSimulationAssessment(value: unknown): value is SimulationAssessment {
  if (!record(value) || !isRiskLevel(value.level)) return false;
  if (!Array.isArray(value.factors) || value.factors.length !== SIMULATION_VARIABLES.length) return false;
  if (!value.factors.every(isSimulationFactor)) return false;
  return value.factors.every((factor, index) => record(factor) && factor.name === SIMULATION_VARIABLES[index]);
}

function isSimulationResult(value: unknown): value is SimulationResult {
  if (!record(value)) return false;
  if (!nonempty(value.batch_id) || !nonempty(value.zone_id) || !nonempty(value.model_version)) return false;
  if (!isRiskLevel(value.stored_level) || !nonempty(value.computation_instant) || !nonempty(value.notice)) return false;
  if (value.freshness !== 'not_evaluated') return false;
  if (!record(value.policy) || !nonempty(value.policy.policy_id) || !nonempty(value.policy.params_hash)) return false;
  return isSimulationAssessment(value.before) && isSimulationAssessment(value.after);
}

// The substitution document. An absent variable is OMITTED rather than sent as
// its stored value, so the request states exactly the counterfactual the operator
// asked for and the service keeps the rest of the stored batch.
export async function simulateRisk(input: SimulationInput, signal?: AbortSignal): Promise<Outcome<SimulationResult>> {
  const zoneId = input.zoneId.trim();
  const batchId = input.batchId.trim();
  if (zoneId === '' || batchId === '') return failureOutcome(failureSpec('malformed', 'invalid_simulation'));
  const variables: Partial<Record<SimulationVariable, number | null>> = {};
  for (const name of SIMULATION_VARIABLES) {
    const candidate = input.variables[name];
    if (candidate === undefined) continue;
    // `null` is the contract's own "force the variable to be absent"; anything
    // that is neither null nor a finite number is refused instead of coerced.
    if (candidate !== null && !Number.isFinite(candidate)) {
      return failureOutcome(failureSpec('malformed', 'invalid_simulation'));
    }
    variables[name] = candidate;
  }
  if (Object.keys(variables).length === 0) {
    return failureOutcome(failureSpec('malformed', 'invalid_simulation'));
  }
  const result = await requestJson(
    'simulate',
    `${gatewayOrigin}${SIMULATION_ROUTE}`,
    {
      method: 'POST',
      body: JSON.stringify({ zone_id: zoneId, variables }),
      headers: { 'Content-Type': 'application/json' },
      authenticated: true,
    },
    signal,
  );
  if (result.state !== 'ok') return resultFailure<SimulationResult>(result);
  if (!isSimulationResult(result.body)) {
    return failureOutcome(failureSpec('malformed', 'invalid_shape', result.status, result.requestId));
  }
  if (result.body.zone_id !== zoneId) {
    return failureOutcome(failureSpec('malformed', 'zone_mismatch', result.status, result.requestId));
  }
  if (result.body.batch_id !== batchId) {
    return failureOutcome(failureSpec('malformed', 'batch_mismatch', result.status, result.requestId));
  }
  return { ok: true, data: result.body };
}

// --- PM-17: explanatory assistant (`POST /v1/risk/explain`) ------------------
//
// The route composes a deterministic explanation of one commune's newest published
// batch and writes nothing: no batch, no outbox event, no alert and no audit row. No
// language model is called. Four properties travel with this code:
//   1. the five topics are a closed vocabulary, matched exactly: a served topic
//      outside the list is a contract change, not a label to pass through;
//   2. the answer must declare both guardrail statuses — `GRD-I1:PASS` and
//      `GRD-I2:PASS` — and its synthetic provenance. An answer that does not present
//      itself as verified is refused here rather than rendered as if it were;
//   3. the answer must cite the five canonical variables, each with a value and a
//      contribution if and only if it is measured, so a variable without a reading
//      can never arrive carrying an invented number;
//   4. `zone_id`, `batch_id` and `topic` are checked against the request, so a slow
//      answer for another zone or another batch can never be painted as this one's
//      explanation.

export const EXPLAIN_TOPICS = ['FACTORES', 'PRIORIDAD', 'TENDENCIA', 'RECOMENDACIONES', 'FUENTES'] as const;

export type ExplainTopic = (typeof EXPLAIN_TOPICS)[number];

// The five canonical variables of the frozen rule, in the rule's order. The
// assistant cites exactly these; the vocabulary is shared with the counterfactual
// simulation so the two surfaces cannot name different variables.
const EXPLAIN_VARIABLES = SIMULATION_VARIABLES;

// The bound the contract declares for the optional question, in characters.
export const EXPLAIN_QUESTION_LIMIT = 500;

// The two statuses an answer must carry. They are literals here as well as in the
// service so a document that omits or renames one is refused at the boundary.
export const EXPLAIN_INPUT_PASS = 'GRD-I1:PASS';
export const EXPLAIN_OUTPUT_PASS = 'GRD-I2:PASS';

export interface ExplainFactor {
  name: string;
  known: boolean;
  // Omitted when the batch did not measure the variable: a missing reading is never
  // served as zero, and the page must not draw it as a measurement.
  value?: number;
  contribution?: number;
}

export interface ExplainGuardrails {
  input: typeof EXPLAIN_INPUT_PASS;
  output: typeof EXPLAIN_OUTPUT_PASS;
}

export interface ExplainResult {
  batch_id: string;
  zone_id: string;
  zone_name: string;
  topic: ExplainTopic;
  risk_level: string;
  model_version: string;
  synthetic: true;
  answer: string;
  factors: ExplainFactor[];
  guardrails: ExplainGuardrails;
  notice: string;
}

export interface ExplainInput {
  readonly zoneId: string;
  readonly topic: ExplainTopic;
  // Optional: an absent question asks the topic alone. A provided one is bounded by
  // `EXPLAIN_QUESTION_LIMIT` and travels as written.
  readonly question?: string;
  // The published batch the panel is showing. It is verified against the answer's
  // echo and never travels in the body: the route always explains the newest one.
  readonly batchId?: string;
}

const EXPLAIN_ROUTE = '/v1/risk/explain';

function isExplainTopic(value: unknown): value is ExplainTopic {
  return typeof value === 'string' && (EXPLAIN_TOPICS as readonly string[]).includes(value);
}

function isExplainFactor(value: unknown): boolean {
  if (!record(value) || !nonempty(value.name) || typeof value.known !== 'boolean') return false;
  if (value.known) return Number.isFinite(value.value) && Number.isFinite(value.contribution);
  return value.value === undefined && value.contribution === undefined;
}

// The citation is exactly the five canonical variables in the rule's order: the rows
// the panel renders are the variables the rule actually evaluated, and a missing or
// extra one is a contract change rather than a gap to fill in from elsewhere.
function isExplainResult(value: unknown): value is ExplainResult {
  if (!record(value) || !record(value.guardrails)) return false;
  if (!nonempty(value.batch_id) || !nonempty(value.zone_id) || !nonempty(value.zone_name)) return false;
  if (!nonempty(value.model_version) || !nonempty(value.answer) || !nonempty(value.notice)) return false;
  if (!isExplainTopic(value.topic) || !isRiskLevel(value.risk_level)) return false;
  if (value.synthetic !== true) return false;
  if (value.guardrails.input !== EXPLAIN_INPUT_PASS || value.guardrails.output !== EXPLAIN_OUTPUT_PASS) return false;
  if (!Array.isArray(value.factors) || value.factors.length !== EXPLAIN_VARIABLES.length) return false;
  if (!value.factors.every(isExplainFactor)) return false;
  return value.factors.every((factor, index) => record(factor) && factor.name === EXPLAIN_VARIABLES[index]);
}

// The request document. The question member is OMITTED rather than sent empty: the
// service refuses a blank question with GRD-I1, and sending one would invite a
// refusal the operator never asked for.
export async function explainRisk(input: ExplainInput, signal?: AbortSignal): Promise<Outcome<ExplainResult>> {
  const zoneId = input.zoneId.trim();
  if (zoneId === '' || !isExplainTopic(input.topic)) {
    return failureOutcome(failureSpec('malformed', 'invalid_explain'));
  }
  const question = (input.question ?? '').trim();
  if ([...question].length > EXPLAIN_QUESTION_LIMIT) {
    return failureOutcome(failureSpec('malformed', 'invalid_explain'));
  }
  const body: Record<string, unknown> = { zone_id: zoneId, topic: input.topic };
  if (question !== '') body.question = question;
  const result = await requestJson(
    'explain',
    `${gatewayOrigin}${EXPLAIN_ROUTE}`,
    {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      authenticated: true,
    },
    signal,
  );
  if (result.state !== 'ok') return resultFailure<ExplainResult>(result);
  if (!isExplainResult(result.body)) {
    return failureOutcome(failureSpec('malformed', 'invalid_shape', result.status, result.requestId));
  }
  if (result.body.zone_id !== zoneId) {
    return failureOutcome(failureSpec('malformed', 'zone_mismatch', result.status, result.requestId));
  }
  if (result.body.topic !== input.topic) {
    return failureOutcome(failureSpec('malformed', 'topic_mismatch', result.status, result.requestId));
  }
  if (input.batchId !== undefined && result.body.batch_id !== input.batchId) {
    return failureOutcome(failureSpec('malformed', 'batch_mismatch', result.status, result.requestId));
  }
  return { ok: true, data: result.body };
}
