// Transport for the PM-08 notification centre.
//
// The route is the frozen `GET /v1/risk/alerts` seam: authenticated, bounded by
// the caller's signal, and validated at the boundary like every other read. A
// page is either fully usable or rejected as a whole; a malformed alert is never
// dropped to leave a smaller list that looks like what the service served.
//
// The client sends the order it selected and a cursor only when it has one. It
// deliberately does not send `limit`: the frozen contract gives the server the
// default (50), so the page size cannot drift from the service's own decision.
import { gatewayOrigin, riskAlertStateRoute, routes } from '../config';
import type { Failure, FailureKind, Outcome } from './api';
import { getAccessToken, resetSession } from './session';

export type AlertOrder = 'asc' | 'desc';
export type AlertLevel = 'bajo' | 'medio' | 'alto';

// The personal mark of the caller on one alert. `unread` is the ABSENCE of a
// mark: the contract serves it, and refuses it as a value to write.
export type AlertStateMark = 'read' | 'dismissed';
export type PersonalAlertState = AlertStateMark | 'unread';

export interface RiskAlertState {
  alert_id: string;
  state: PersonalAlertState;
  marked_at: string | null;
}

export interface RiskAlert {
  id: string;
  zone_id: string;
  zone_name: string | null;
  previous_level: AlertLevel;
  new_level: AlertLevel;
  threshold: number;
  occurred_at: string;
  demo: boolean;
}

export interface RiskAlertPage {
  items: RiskAlert[];
  next_cursor: string | null;
}

export interface RiskAlertQuery {
  order?: AlertOrder;
  cursor?: string | null;
  // Optional on purpose. The view does not send it, so the server's default 50
  // remains the page size; the parameter exists for a caller that explicitly
  // asks for a bounded page within the frozen 1–100 range.
  limit?: number;
}

const DEFAULT_DEADLINE_MS = 10_000;
const ALERT_LEVELS: readonly AlertLevel[] = ['bajo', 'medio', 'alto'];
const PERSONAL_STATES: readonly PersonalAlertState[] = ['unread', 'read', 'dismissed'];
const ALERT_MARKS: readonly AlertStateMark[] = ['read', 'dismissed'];
// The frozen `AlertState` is `additionalProperties: false` with three required
// members, so a document is accepted only when it carries exactly these keys.
const STATE_MEMBERS: ReadonlySet<string> = new Set(['alert_id', 'state', 'marked_at']);
// `alert_id` is `format: uuid` in the contract, and the route only addresses the
// canonical lower-case dashed spelling (`firewatch-v1.yaml:1025-1029`). There is
// deliberately no `i` flag: an upper-case uuid is a different spelling and names
// no row, so it fails closed instead of being normalised into a guess.
const ALERT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// A `date-time` is a FULL instant: date, `T`, time of day and the UTC `Z` the
// schema's `marked_at` documents ("canonicalised to UTC"). A date-only value, an
// offset or the RFC's relaxed `t`/`z` spelling is not this wire's instant.
const RFC3339_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function alertLevel(value: unknown): value is AlertLevel {
  return typeof value === 'string' && (ALERT_LEVELS as readonly string[]).includes(value);
}

function isRiskAlert(value: unknown): value is RiskAlert {
  if (!record(value)) return false;
  if (!nonempty(value.id) || !nonempty(value.zone_id) || !nonempty(value.occurred_at)) return false;
  if (value.zone_name !== null && typeof value.zone_name !== 'string') return false;
  if (!alertLevel(value.previous_level) || !alertLevel(value.new_level)) return false;
  if (typeof value.threshold !== 'number' || !Number.isFinite(value.threshold)) return false;
  return typeof value.demo === 'boolean';
}

function isRiskAlertPage(value: unknown): value is RiskAlertPage {
  if (!record(value) || !Array.isArray(value.items) || !value.items.every(isRiskAlert)) return false;
  // The wire spells "no more pages" as `null`; an empty string is not a usable
  // cursor and would otherwise render an enabled "Siguiente" that cannot page.
  return value.next_cursor === null || nonempty(value.next_cursor);
}

function personalState(value: unknown): value is PersonalAlertState {
  return typeof value === 'string' && (PERSONAL_STATES as readonly string[]).includes(value);
}

function isCanonicalAlertId(value: unknown): value is string {
  return typeof value === 'string' && ALERT_ID_PATTERN.test(value);
}

// The full-instant check the schema's `date-time` demands. `Date.parse` alone
// accepts `2026-11-27` and silently rolls `2026-02-30` forward, so the fields are
// matched first and the calendar is compared back instead of trusted.
function isRfc3339Instant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = RFC3339_INSTANT.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  // `0..59` only: `:60` is a leap second this schema never serves.
  const second = Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  return (
    calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() === month - 1 &&
    calendar.getUTCDate() === day
  );
}

// The served mark document, checked whole. The answer must name the alert that
// was asked for with its canonical uuid, `marked_at` is null EXACTLY when the
// state is `unread` (and a full RFC 3339 instant otherwise), and an unknown
// member means the payload is not this resource's document at all: it is refused
// instead of being read for the members this build happens to know.
function isRiskAlertState(value: unknown, alertId: string): value is RiskAlertState {
  if (!record(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== STATE_MEMBERS.size || !keys.every(key => STATE_MEMBERS.has(key))) return false;
  if (!isCanonicalAlertId(value.alert_id) || value.alert_id !== alertId) return false;
  if (!personalState(value.state)) return false;
  if (value.state === 'unread') return value.marked_at === null;
  return isRfc3339Instant(value.marked_at);
}

function failure(kind: FailureKind, reason: string, status?: number, requestId?: string): Failure {
  const result: Failure = { kind, reason };
  if (status !== undefined) result.status = status;
  if (requestId !== undefined && requestId !== '') result.requestId = requestId;
  return result;
}

function failed<T>(kind: FailureKind, reason: string, status?: number, requestId?: string): Outcome<T> {
  return { ok: false, failure: failure(kind, reason, status, requestId) };
}

function reasonFromBody(body: unknown, fallback: string): string {
  if (record(body) && nonempty(body.code)) return body.code.trim();
  return fallback;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export async function listRiskAlerts(
  query: RiskAlertQuery = {},
  signal?: AbortSignal,
): Promise<Outcome<RiskAlertPage>> {
  const params = new URLSearchParams();
  params.set('order', query.order ?? 'desc');
  if (nonempty(query.cursor)) params.set('cursor', query.cursor);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const url = `${gatewayOrigin}${routes.alerts}?${params.toString()}`;

  const token = getAccessToken();
  const controller = new AbortController();
  let stop: 'none' | 'aborted' | 'deadline' = 'none';
  const stopReason = (): 'none' | 'aborted' | 'deadline' => stop;
  const onCallerAbort = (): void => {
    stop = 'aborted';
    controller.abort();
  };
  if (signal) {
    if (signal.aborted) return failed('unavailable', 'aborted');
    signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const deadline = setTimeout(() => {
    stop = 'deadline';
    controller.abort();
  }, DEFAULT_DEADLINE_MS);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
    });
    const requestId = response.headers.get('X-Request-ID') ?? '';
    if (response.status === 401) {
      resetSession(token !== '' ? 'rejected' : null);
      return failed('unauthorized', 'unauthorized', 401, requestId);
    }
    if (response.status === 403) return failed('forbidden', 'forbidden', 403, requestId);
    if (response.status === 204) return failed('malformed', 'invalid_shape', 204, requestId);

    const body = await readJson(response);
    if (!response.ok) {
      const reason = reasonFromBody(body, `http_${response.status}`);
      const kind: FailureKind = response.status === 400 ? 'malformed' : response.status === 404 ? 'missing' : 'unavailable';
      return failed(kind, reason, response.status, requestId);
    }
    if (!isRiskAlertPage(body)) return failed('malformed', 'invalid_shape', response.status, requestId);
    return { ok: true, data: body };
  } catch {
    const reason = stopReason();
    if (reason === 'deadline') return failed('unavailable', 'deadline');
    if (reason === 'aborted') return failed('unavailable', 'aborted');
    return failed('unavailable', 'network');
  } finally {
    clearTimeout(deadline);
    if (signal) signal.removeEventListener('abort', onCallerAbort);
  }
}

// PM-08 — the personal mark on one stored alert.
//
// `GET` is viewer/admin and `PUT` is admin-only in the frozen contract. This
// transport does not decide either: it sends the bearer it holds and states the
// answer, so a viewer's `403` reaches the view as a denial instead of being
// pre-empted by a local role guess. Only `read` and `dismissed` are ever written;
// `unread` is the absence of a mark and is refused before a request exists.

interface StateAnswer {
  kind: 'answered' | 'failed';
  status: number;
  requestId: string;
  body: unknown;
  failure?: Failure;
}

async function askState(
  url: string,
  request: { method: 'GET' | 'PUT'; body?: string },
  signal?: AbortSignal,
): Promise<StateAnswer> {
  const token = getAccessToken();
  const controller = new AbortController();
  let stop: 'none' | 'aborted' | 'deadline' = 'none';
  const stopReason = (): 'none' | 'aborted' | 'deadline' => stop;
  const onCallerAbort = (): void => {
    stop = 'aborted';
    controller.abort();
  };
  if (signal) {
    if (signal.aborted) {
      return { kind: 'failed', status: 0, requestId: '', body: undefined, failure: failure('unavailable', 'aborted') };
    }
    signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const deadline = setTimeout(() => {
    stop = 'deadline';
    controller.abort();
  }, DEFAULT_DEADLINE_MS);

  // A read carries no document, so it declares no content type; a write declares
  // exactly the one the contract requires, or the service answers 415.
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (request.body !== undefined) headers['Content-Type'] = 'application/json';

  try {
    const response = await fetch(url, {
      method: request.method,
      body: request.body,
      headers,
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
    });
    const headerRequestId = response.headers.get('X-Request-ID') ?? '';
    // The contract's error envelopes carry their own `request_id`; the header is
    // preferred when present, so a probe that only kept the body still reports it.
    const body = await readJson(response);
    const envelopeRequestId = record(body) && nonempty(body.request_id) ? body.request_id.trim() : '';
    const requestId = headerRequestId !== '' ? headerRequestId : envelopeRequestId;
    if (response.status === 401) {
      // Only a bearer that is STILL the session's may be rejected. A late 401 for a
      // token that has already been replaced must never lower the newer session:
      // the refusal still belongs to the request that received it, and only that
      // request reports it.
      const currentToken = getAccessToken();
      if (token !== '' && currentToken === token) resetSession('rejected');
      // The refusal envelope is read BEFORE the session is lowered, so the code and
      // the request id the service served are not lost with the token.
      return {
        kind: 'failed',
        status: 401,
        requestId,
        body,
        failure: failure('unauthorized', reasonFromBody(body, 'unauthorized'), 401, requestId),
      };
    }
    if (response.status === 403) {
      return {
        kind: 'failed',
        status: 403,
        requestId,
        body,
        failure: failure('forbidden', reasonFromBody(body, 'forbidden'), 403, requestId),
      };
    }
    // This route defines exactly one success status. `fetch` treats any 2xx as
    // `ok`, so 201/202/204 are refused as an unexpected transport answer instead
    // of being read as a stored mark that the service never said it stored.
    if (response.status !== 200) {
      if (response.ok) {
        return {
          kind: 'failed',
          status: response.status,
          requestId,
          body,
          failure: failure('malformed', 'unexpected_status', response.status, requestId),
        };
      }
      const reason = reasonFromBody(body, `http_${response.status}`);
      // 415 `json_required` and 400 `invalid_alert_state` are refusals of the
      // request document, not service outages: nothing was written.
      const kind: FailureKind =
        response.status === 400 || response.status === 415
          ? 'malformed'
          : response.status === 404
            ? 'missing'
            : 'unavailable';
      return {
        kind: 'failed',
        status: response.status,
        requestId,
        body,
        failure: failure(kind, reason, response.status, requestId),
      };
    }
    return { kind: 'answered', status: 200, requestId, body };
  } catch {
    const reason = stopReason();
    const failureReason = reason === 'none' ? 'network' : reason;
    return {
      kind: 'failed',
      status: 0,
      requestId: '',
      body: undefined,
      failure: failure('unavailable', failureReason),
    };
  } finally {
    clearTimeout(deadline);
    if (signal) signal.removeEventListener('abort', onCallerAbort);
  }
}

export async function readRiskAlertState(alertId: string, signal?: AbortSignal): Promise<Outcome<RiskAlertState>> {
  // Only the canonical lower-case spelling addresses a row, so any other spelling
  // fails closed here instead of asking the service a question it refuses.
  if (!isCanonicalAlertId(alertId)) return failed('malformed', 'invalid_shape');
  const answer = await askState(`${gatewayOrigin}${riskAlertStateRoute(alertId)}`, { method: 'GET' }, signal);
  if (answer.kind === 'failed') return { ok: false, failure: answer.failure ?? failure('unavailable', 'network') };
  if (!isRiskAlertState(answer.body, alertId)) {
    return failed('malformed', 'invalid_shape', answer.status, answer.requestId);
  }
  return { ok: true, data: answer.body };
}

export async function markRiskAlertState(
  alertId: string,
  mark: AlertStateMark,
  signal?: AbortSignal,
): Promise<Outcome<RiskAlertState>> {
  // The closed write vocabulary, enforced here too: `unread` is the absence of a
  // mark and the contract refuses it, so it never becomes a request.
  if (!ALERT_MARKS.includes(mark)) return failed('malformed', 'invalid_alert_state');
  // Same canonical-spelling rule as the read: an upper-case uuid names no row.
  if (!isCanonicalAlertId(alertId)) return failed('malformed', 'invalid_shape');
  const answer = await askState(
    `${gatewayOrigin}${riskAlertStateRoute(alertId)}`,
    { method: 'PUT', body: JSON.stringify({ state: mark }) },
    signal,
  );
  if (answer.kind === 'failed') return { ok: false, failure: answer.failure ?? failure('unavailable', 'network') };
  if (!isRiskAlertState(answer.body, alertId)) {
    return failed('malformed', 'invalid_shape', answer.status, answer.requestId);
  }
  // The answer is the state actually stored, which may dominate the requested
  // one. It is returned as served; the caller never substitutes what it asked for.
  return { ok: true, data: answer.body };
}
