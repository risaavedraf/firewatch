import { gatewayOrigin, issuer, pkceTransactionKey } from '../../src/config';
import type { Failure, Outcome } from '../../src/core/api';
import {
  markRiskAlertState,
  readRiskAlertState,
  type AlertStateMark,
  type RiskAlertState,
} from '../../src/core/notifications';
import { completeLogin, getAccessToken, getSessionSnapshot, resetSession } from '../../src/core/session';

import { createCryptoStub, createFetchStub, createStorageStub, flush, jwt } from './harness';

// PM-08 S2/S3 — the personal mark seam of the notification centre.
//
// The frozen contract serves the caller's own mark on one stored alert:
// `GET /v1/risk/alerts/{id}/state` for viewer/admin and
// `PUT /v1/risk/alerts/{id}/state` for admin only, with a body that is exactly
// one JSON document of one member, `state`, whose value is `read` or
// `dismissed`. `unread` is the absence of a mark, never a value to send.
//
// These tests are the whole client contract of that seam: the request that goes
// out, the one answer shape that is accepted, and the fact that the answer is
// what the view shows — the dominant stored mark, not the one requested. They
// also pin the prohibition the spec states twice: no client storage.

const ADMIN_TOKEN = jwt({ realm_access: { roles: ['admin'] } });
const SECOND_ADMIN_TOKEN = jwt({ realm_access: { roles: ['admin'] }, sid: 'second-session' });
const TOKEN_URL = `${issuer}/protocol/openid-connect/token`;
const ALERT_ID = '1c0d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const STATE_URL = `${gatewayOrigin}/v1/risk/alerts/${ALERT_ID}/state`;

let fetchStub: ReturnType<typeof createFetchStub>;
let sessionStub: ReturnType<typeof createStorageStub>;
let localStub: ReturnType<typeof createStorageStub>;

beforeEach(() => {
  fetchStub = createFetchStub();
  sessionStub = createStorageStub();
  localStub = createStorageStub();
  vi.stubGlobal('fetch', fetchStub.fetch);
  vi.stubGlobal('sessionStorage', sessionStub.storage);
  vi.stubGlobal('localStorage', localStub.storage);
  vi.stubGlobal('crypto', createCryptoStub());
  resetSession();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function connect(token = ADMIN_TOKEN): Promise<void> {
  sessionStub.storage.setItem(pkceTransactionKey, JSON.stringify({ state: 's', verifier: 'verifier' }));
  const login = completeLogin('?code=code-1&state=s');
  await flush();
  fetchStub.answer(TOKEN_URL, { access_token: token, id_token: 'id-token' });
  await login;
  fetchStub.calls.length = 0;
}

function expectFailure<T>(outcome: Outcome<T>): Failure {
  if (outcome.ok) throw new Error('expected a failure outcome');
  return outcome.failure;
}

function servedState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { alert_id: ALERT_ID, state: 'read', marked_at: '2026-11-20T16:05:00Z', ...overrides };
}

// ── The read ───────────────────────────────────────────────────────────────

test('the read asks the per-alert state route with the bearer and no body', async () => {
  await connect();
  const pending = readRiskAlertState(ALERT_ID);

  expect(fetchStub.callsFor(STATE_URL)).toHaveLength(1);
  const call = fetchStub.callsFor(STATE_URL)[0];
  expect(call.init).toMatchObject({
    method: 'GET',
    cache: 'no-store',
    credentials: 'omit',
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  expect(call.init.body).toBeUndefined();
  // A read declares no content type: it carries no document.
  expect(call.init.headers).toEqual({ Authorization: `Bearer ${ADMIN_TOKEN}` });

  fetchStub.answer(STATE_URL, servedState());
  await expect(pending).resolves.toEqual({
    ok: true,
    data: { alert_id: ALERT_ID, state: 'read', marked_at: '2026-11-20T16:05:00Z' },
  });
});

test('the read accepts the three personal states and keeps the served instant verbatim', async () => {
  await connect();
  const unread = readRiskAlertState(ALERT_ID);
  fetchStub.answer(STATE_URL, { alert_id: ALERT_ID, state: 'unread', marked_at: null });
  await expect(unread).resolves.toEqual({
    ok: true,
    data: { alert_id: ALERT_ID, state: 'unread', marked_at: null },
  });

  const dismissed = readRiskAlertState(ALERT_ID);
  fetchStub.answer(STATE_URL, servedState({ state: 'dismissed', marked_at: '2026-11-21T08:30:00.123Z' }));
  const result = await dismissed;
  if (!result.ok) throw new Error('the dominant mark must be an accepted answer');
  // The transport never rewrites the instant: the server canonicalises it.
  expect(result.data).toEqual({
    alert_id: ALERT_ID,
    state: 'dismissed',
    marked_at: '2026-11-21T08:30:00.123Z',
  } satisfies RiskAlertState);
});

test('a state document outside the frozen schema is rejected whole, never repaired', async () => {
  await connect();

  const rejected: Array<[string, unknown]> = [
    ['an unknown enum value', servedState({ state: 'extremo' })],
    ['unread carrying an instant', { alert_id: ALERT_ID, state: 'unread', marked_at: '2026-11-20T16:05:00Z' }],
    ['read without an instant', { alert_id: ALERT_ID, state: 'read', marked_at: null }],
    ['an unparseable instant', servedState({ marked_at: 'ayer' })],
    ['a missing member', { alert_id: ALERT_ID, state: 'read' }],
    ['an unknown member', servedState({ actor: 'someone' })],
    ['another alert id', servedState({ alert_id: '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a' })],
    ['a non-object', 'read'],
  ];

  for (const [label, body] of rejected) {
    const pending = readRiskAlertState(ALERT_ID);
    fetchStub.answer(STATE_URL, body);
    await expect(pending, label).resolves.toMatchObject({
      ok: false,
      failure: { kind: 'malformed', reason: 'invalid_shape' },
    });
  }
});

test('the read states the contract failures with their code and request id', async () => {
  await connect();

  const forbidden = readRiskAlertState(ALERT_ID);
  fetchStub.answer(STATE_URL, { code: 'forbidden' }, 403, 'req-403');
  expect(expectFailure(await forbidden)).toEqual({ kind: 'forbidden', reason: 'forbidden', status: 403, requestId: 'req-403' });

  const missing = readRiskAlertState(ALERT_ID);
  fetchStub.answer(STATE_URL, { code: 'alert_not_found' }, 404, 'req-404');
  expect(expectFailure(await missing)).toEqual({
    kind: 'missing',
    reason: 'alert_not_found',
    status: 404,
    requestId: 'req-404',
  });

  const unavailable = readRiskAlertState(ALERT_ID);
  fetchStub.answer(STATE_URL, { code: 'storage_unavailable' }, 503, 'req-503');
  expect(expectFailure(await unavailable)).toEqual({
    kind: 'unavailable',
    reason: 'storage_unavailable',
    status: 503,
    requestId: 'req-503',
  });

  const unauthorized = readRiskAlertState(ALERT_ID);
  fetchStub.answer(STATE_URL, { code: 'unauthorized' }, 401);
  expect(expectFailure(await unauthorized)).toMatchObject({ kind: 'unauthorized', status: 401 });
  expect(getSessionSnapshot().status).toBe('signed-out');
});

// ── The write ──────────────────────────────────────────────────────────────

test('the write is one JSON document with exactly the state member and the bearer', async () => {
  await connect();
  const pending = markRiskAlertState(ALERT_ID, 'dismissed');

  expect(fetchStub.callsFor(STATE_URL)).toHaveLength(1);
  const call = fetchStub.callsFor(STATE_URL)[0];
  expect(call.init).toMatchObject({
    method: 'PUT',
    body: '{"state":"dismissed"}',
    cache: 'no-store',
    credentials: 'omit',
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
  });
  expect(JSON.parse(String(call.init.body))).toEqual({ state: 'dismissed' });

  fetchStub.answer(STATE_URL, servedState({ state: 'dismissed' }));
  await expect(pending).resolves.toMatchObject({
    ok: true,
    data: { alert_id: ALERT_ID, state: 'dismissed', marked_at: '2026-11-20T16:05:00Z' },
  });
});

test('unread is never sent: the client refuses before it builds a request', async () => {
  await connect();
  const outcome = await markRiskAlertState(ALERT_ID, 'unread' as unknown as AlertStateMark);

  expect(fetchStub.callsFor(STATE_URL)).toHaveLength(0);
  expect(fetchStub.calls).toHaveLength(0);
  expect(expectFailure(outcome)).toEqual({ kind: 'malformed', reason: 'invalid_alert_state' });
});

test('the write answers the stored dominant mark, not the requested one', async () => {
  await connect();
  const pending = markRiskAlertState(ALERT_ID, 'read');
  // The contract is monotonic: a dismissal already stored answers `dismissed`
  // with its original instant even though `read` was requested. Replay is a 200.
  fetchStub.answer(STATE_URL, servedState({ state: 'dismissed', marked_at: '2026-11-19T09:00:00Z' }));
  await expect(pending).resolves.toEqual({
    ok: true,
    data: { alert_id: ALERT_ID, state: 'dismissed', marked_at: '2026-11-19T09:00:00Z' },
  });
});

test('the write states the frozen refusals and an unconfirmed network fault distinctly', async () => {
  await connect();

  const denied = markRiskAlertState(ALERT_ID, 'read');
  fetchStub.answer(STATE_URL, { code: 'forbidden' }, 403, 'req-w403');
  expect(expectFailure(await denied)).toEqual({
    kind: 'forbidden',
    reason: 'forbidden',
    status: 403,
    requestId: 'req-w403',
  });

  const missing = markRiskAlertState(ALERT_ID, 'read');
  fetchStub.answer(STATE_URL, { code: 'alert_not_found' }, 404, 'req-w404');
  expect(expectFailure(await missing)).toMatchObject({ kind: 'missing', reason: 'alert_not_found', status: 404 });

  const invalid = markRiskAlertState(ALERT_ID, 'read');
  fetchStub.answer(STATE_URL, { code: 'invalid_alert_state' }, 400, 'req-w400');
  expect(expectFailure(await invalid)).toEqual({
    kind: 'malformed',
    reason: 'invalid_alert_state',
    status: 400,
    requestId: 'req-w400',
  });

  const notJson = markRiskAlertState(ALERT_ID, 'read');
  fetchStub.answer(STATE_URL, { code: 'json_required' }, 415, 'req-w415');
  expect(expectFailure(await notJson)).toEqual({
    kind: 'malformed',
    reason: 'json_required',
    status: 415,
    requestId: 'req-w415',
  });

  const unavailable = markRiskAlertState(ALERT_ID, 'read');
  fetchStub.answer(STATE_URL, { code: 'storage_unavailable' }, 503, 'req-w503');
  expect(expectFailure(await unavailable)).toEqual({
    kind: 'unavailable',
    reason: 'storage_unavailable',
    status: 503,
    requestId: 'req-w503',
  });

  // A 2xx whose body is not the served document is not a stored mark.
  const headless = markRiskAlertState(ALERT_ID, 'read');
  fetchStub.answerMalformedJson(STATE_URL, 200, 'req-wjson');
  expect(expectFailure(await headless)).toEqual({
    kind: 'malformed',
    reason: 'invalid_shape',
    status: 200,
    requestId: 'req-wjson',
  });

  const shape = markRiskAlertState(ALERT_ID, 'read');
  fetchStub.answer(STATE_URL, { ...servedState(), marked_at: null });
  expect(expectFailure(await shape)).toMatchObject({ kind: 'malformed', reason: 'invalid_shape' });
});

test('a network fault is an unavailable outcome, not a claimed write', async () => {
  await connect();
  const original = fetchStub.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === STATE_URL ? Promise.reject(new TypeError('Failed to fetch')) : original(input, init),
  );

  const outcome = await markRiskAlertState(ALERT_ID, 'read');
  expect(expectFailure(outcome)).toEqual({ kind: 'unavailable', reason: 'network' });
});

// ── No client persistence ──────────────────────────────────────────────────

test('the mark lives on the server: neither storage is written by the seam', async () => {
  await connect();
  const wrote = sessionStub.writes.length;

  const read = readRiskAlertState(ALERT_ID);
  fetchStub.answer(STATE_URL, servedState());
  await read;

  const write = markRiskAlertState(ALERT_ID, 'dismissed');
  fetchStub.answer(STATE_URL, servedState({ state: 'dismissed' }));
  await write;

  // The only value the application ever stores is the PKCE transaction, and this
  // seam added nothing to it.
  expect(sessionStub.writes).toHaveLength(wrote);
  expect(sessionStub.writes.every(entry => entry.key === pkceTransactionKey)).toBe(true);
  expect(localStub.writes).toEqual([]);
  expect([...localStub.snapshot().keys()]).toEqual([]);
});

// ── Verifier round 2: status, shape and envelope strictness ────────────────

test('only the frozen 200 is an answer: another 2xx status is an unexpected transport response', async () => {
  await connect();

  // 201 is `ok` to `fetch` but is not the status this route defines.
  const created = readRiskAlertState(ALERT_ID);
  fetchStub.answer(STATE_URL, servedState(), 201, 'req-201');
  expect(expectFailure(await created)).toEqual({
    kind: 'malformed',
    reason: 'unexpected_status',
    status: 201,
    requestId: 'req-201',
  });

  const noContent = readRiskAlertState(ALERT_ID);
  fetchStub.answer(STATE_URL, null, 204, 'req-204');
  expect(expectFailure(await noContent)).toEqual({
    kind: 'malformed',
    reason: 'unexpected_status',
    status: 204,
    requestId: 'req-204',
  });

  const accepted = markRiskAlertState(ALERT_ID, 'read');
  fetchStub.answer(STATE_URL, servedState(), 202, 'req-202');
  expect(expectFailure(await accepted)).toEqual({
    kind: 'malformed',
    reason: 'unexpected_status',
    status: 202,
    requestId: 'req-202',
  });
});

test('the served alert id must be the canonical uuid that was asked for', async () => {
  await connect();

  // An id outside `format: uuid` is refused before a request exists: no service is
  // asked about a row it cannot name, and the failure is stated rather than sent.
  expect(expectFailure(await readRiskAlertState('alert-1'))).toEqual({
    kind: 'malformed',
    reason: 'invalid_shape',
  });
  expect(fetchStub.callsFor(`${gatewayOrigin}/v1/risk/alerts/alert-1/state`)).toHaveLength(0);

  // A valid uuid that is not the addressed alert is the same refusal: the answer
  // must belong to the row that asked.
  const foreign = readRiskAlertState(ALERT_ID);
  fetchStub.answer(STATE_URL, servedState({ alert_id: '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a' }));
  expect(expectFailure(await foreign)).toMatchObject({ kind: 'malformed', reason: 'invalid_shape' });
});

test('only the canonical lower-case spelling addresses a row: an upper-case id never leaves the client', async () => {
  await connect();

  const upper = ALERT_ID.toUpperCase();
  expect(upper).not.toBe(ALERT_ID);

  // `firewatch-v1.yaml:1025-1029`: only the canonical lower-case dashed spelling
  // addresses a row, so an upper-case uuid fails closed before any request.
  expect(expectFailure(await readRiskAlertState(upper))).toEqual({ kind: 'malformed', reason: 'invalid_shape' });
  expect(expectFailure(await markRiskAlertState(upper, 'read'))).toEqual({ kind: 'malformed', reason: 'invalid_shape' });
  expect(fetchStub.calls).toHaveLength(0);

  // A served id that differs only in case is not the row that asked either.
  const servedUpper = readRiskAlertState(ALERT_ID);
  fetchStub.answer(STATE_URL, servedState({ alert_id: upper }));
  expect(expectFailure(await servedUpper)).toMatchObject({ kind: 'malformed', reason: 'invalid_shape' });
});

test('marked_at must be a full RFC 3339 instant in UTC, not a date, an offset or a leap second', async () => {
  await connect();

  const rejectedInstants = [
    '2026-11-27',
    '2026-11-20T16:05:00',
    '2026-11-20 16:05:00Z',
    '2026-02-30T10:00:00Z',
    '2026-11-20T25:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-11-20T16:05:00+25:00',
    // `marked_at` is canonicalised to UTC, so an offset is not this contract's
    // instant even when it names the same moment.
    '2026-11-20T16:05:00-03:00',
    '2026-11-20T16:05:00+02:00',
    // A leap second is outside `0..59` and is not served by this schema.
    '2026-11-20T16:05:60Z',
    // The `t`/`z` spelling is the RFC's relaxed form, not the wire's.
    '2026-11-20t16:05:00z',
  ];
  for (const instant of rejectedInstants) {
    const pending = readRiskAlertState(ALERT_ID);
    fetchStub.answer(STATE_URL, servedState({ marked_at: instant }));
    await expect(pending, instant).resolves.toMatchObject({
      ok: false,
      failure: { kind: 'malformed', reason: 'invalid_shape' },
    });
  }

  const acceptedInstants = ['2026-11-20T16:05:00Z', '2026-11-21T08:30:00.123Z'];
  for (const instant of acceptedInstants) {
    const pending = readRiskAlertState(ALERT_ID);
    fetchStub.answer(STATE_URL, servedState({ marked_at: instant }));
    await expect(pending, instant).resolves.toMatchObject({ ok: true, data: { marked_at: instant } });
  }
});

test('a 401 answers its own envelope: the code and the request id survive the session reset', async () => {
  await connect();
  const denied = readRiskAlertState(ALERT_ID);
  // No `X-Request-ID` header: the envelope's own request_id is the only one there.
  fetchStub.answer(STATE_URL, { code: 'invalid_token', request_id: 'req-body-401' }, 401);

  expect(expectFailure(await denied)).toEqual({
    kind: 'unauthorized',
    reason: 'invalid_token',
    status: 401,
    requestId: 'req-body-401',
  });
  expect(getSessionSnapshot().status).toBe('signed-out');
  expect(getSessionSnapshot().reason).toBe('rejected');
});

test('a rejected write keeps its envelope as well', async () => {
  await connect();
  const pending = markRiskAlertState(ALERT_ID, 'dismissed');
  fetchStub.answer(STATE_URL, { code: 'invalid_token', request_id: 'req-w401' }, 401);

  expect(expectFailure(await pending)).toEqual({
    kind: 'unauthorized',
    reason: 'invalid_token',
    status: 401,
    requestId: 'req-w401',
  });
  expect(getSessionSnapshot().reason).toBe('rejected');
});

test('a late 401 from a superseded bearer never lowers the newer session', async () => {
  await connect();
  const stale = readRiskAlertState(ALERT_ID);
  expect(getAccessToken()).toBe(ADMIN_TOKEN);

  // A newer session installs a different bearer while the old request is still in
  // flight, exactly as a re-login would.
  resetSession();
  await connect(SECOND_ADMIN_TOKEN);
  expect(getAccessToken()).toBe(SECOND_ADMIN_TOKEN);

  fetchStub.answer(STATE_URL, { code: 'invalid_token', request_id: 'req-stale-401' }, 401);
  expect(expectFailure(await stale)).toEqual({
    kind: 'unauthorized',
    reason: 'invalid_token',
    status: 401,
    requestId: 'req-stale-401',
  });

  // The refusal belongs to the token that was sent, not to the one in memory now.
  expect(getSessionSnapshot().status).toBe('signed-in');
  expect(getSessionSnapshot().reason).toBeNull();
  expect(getAccessToken()).toBe(SECOND_ADMIN_TOKEN);
});

test('a 401 for the bearer the session still holds does close that session', async () => {
  await connect();
  const pending = readRiskAlertState(ALERT_ID);
  fetchStub.answer(STATE_URL, { code: 'invalid_token', request_id: 'req-live-401' }, 401);
  expect(expectFailure(await pending)).toMatchObject({ kind: 'unauthorized', status: 401 });

  expect(getSessionSnapshot().status).toBe('signed-out');
  expect(getSessionSnapshot().reason).toBe('rejected');
  expect(getAccessToken()).toBe('');
});
