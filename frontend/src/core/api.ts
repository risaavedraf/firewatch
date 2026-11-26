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
  Job,
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
  Scenario,
  ServiceSnapshot,
  SourceProvenance,
  ZoneCollection,
} from '../types/api';
// The closed type catalogue is a runtime value: the guards compare the served
// wire spelling against it, so it cannot travel through `import type`.
import { OBSERVATION_TYPES, RISK_LEVELS } from '../types/api';

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

// A single bounded deadline for one transport read. The retired page bounded its
// own status cycle at 10 s and fenced a hung fetch on the job path; the port
// applies the same bound to every read so no route can hang the view.
const DEFAULT_DEADLINE_MS = 10_000;

type RequestKind =
  | 'ready'
  | 'zones'
  | 'latest'
  | 'history'
  | 'batches'
  | 'executiveSummary'
  | 'sources'
  | 'riskStatus'
  | 'jobsStatus'
  | 'scenarios'
  | 'audit'
  | 'createJob'
  | 'job'
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
  | 'users';

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

function resultFailure<T>(result: TransportResult): Outcome<T> {
  if (result.state === 'failed') return failureOutcome<T>(result.failure);
  if (result.state === 'httpError') return failureOutcome<T>(httpFailure(result));
  return failureOutcome<T>(failureSpec('malformed', 'invalid_shape', result.status, result.requestId));
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
  return (
    record(value) &&
    nonempty(value.name) &&
    typeof value.known === 'boolean' &&
    Number.isFinite(value.value) &&
    Number.isFinite(value.contribution) &&
    (value.note === undefined || typeof value.note === 'string')
  );
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

// The served payload is nested under `geography` exactly as the declaration
// names it, so the transport only proves that structure and then passes the
// payload through UNCHANGED. It does not flatten it and it does not decide
// integrity: `matches: false`, a missing provider or a stale cutoff is a
// fail-closed decision the domain layer makes on the same body.
function isSourceProvenance(value: unknown): value is SourceProvenance {
  if (!record(value)) return false;
  const geography = record(value.geography) ? value.geography : null;
  const provenance = geography && record(geography.provenance) ? geography.provenance : null;
  const integrity = geography && record(geography.integrity) ? geography.integrity : null;
  if (geography === null || provenance === null || integrity === null) return false;
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

export async function sources(signal?: AbortSignal): Promise<Outcome<SourceProvenance>> {
  const result = await requestJson('sources', `${gatewayOrigin}${routes.sources}`, { authenticated: true }, signal);
  return guardOutcome(result, isSourceProvenance);
}

export async function riskStatus(signal?: AbortSignal): Promise<Outcome<ServiceSnapshot>> {
  const result = await requestJson('riskStatus', `${gatewayOrigin}${routes.riskStatus}`, { authenticated: true }, signal);
  return guardOutcome(result, isServiceSnapshot);
}

export async function jobsStatus(signal?: AbortSignal): Promise<Outcome<ServiceSnapshot>> {
  const result = await requestJson('jobsStatus', `${gatewayOrigin}${routes.jobsStatus}`, { authenticated: true }, signal);
  return guardOutcome(result, isServiceSnapshot);
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
