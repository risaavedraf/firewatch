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
import { gatewayOrigin, routes } from '../config';
import type { Failure, FailureKind, Outcome } from './api';
import { getAccessToken, resetSession } from './session';

export type AlertOrder = 'asc' | 'desc';
export type AlertLevel = 'bajo' | 'medio' | 'alto';

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
