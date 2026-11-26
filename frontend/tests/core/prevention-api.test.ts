import { afterEach, beforeEach, expect, test } from 'vitest';

import { gatewayOrigin, issuer, pkceTransactionKey } from '../../src/config';
import {
  createPreventiveAction,
  isConfirmedWriteRefusal,
  modelVersions,
  preventiveAction,
  preventiveActions,
  sources,
  transitionPreventiveAction,
  users,
  type Failure,
  type Outcome,
} from '../../src/core/api';
import { completeLogin, resetSession } from '../../src/core/session';
import type { PreventiveAction, PreventiveActionDetail } from '../../src/types/api';

import { createCryptoStub, createFetchStub, createStorageStub, flush, jwt } from '../core/harness';

// S3 — the transport half of the frozen `prevention` contract
// (`odd/tasks/presentation-client-ready.md` §«Contrato congelado»): the four
// routes, the same absolute gateway origin and bearer as every other read, and
// the `{"code": ..., "request_id": ...}` error format the other services use.

const TOKEN_URL = `${issuer}/protocol/openid-connect/token`;
const ACTIONS_URL = `${gatewayOrigin}/v1/prevention/actions`;
const USERS_URL = `${gatewayOrigin}/v1/users`;
const MODELS_URL = `${gatewayOrigin}/v1/models`;
const SOURCES_URL = `${gatewayOrigin}/v1/risk/sources`;

// The directory identifier of an assignment reference. The contract types
// `PreventiveAction.assignee_id` — and the value the create body carries — as
// `format: uuid`, so every create/read fixture here uses a real UUID.
const ASSIGNEE_UUID = '7f3a2c91-5b4e-4c8a-9d21-0f6b8c3d4e52';

let fetchStub: ReturnType<typeof createFetchStub>;
let storageStub: ReturnType<typeof createStorageStub>;

function setup(): void {
  fetchStub = createFetchStub();
  storageStub = createStorageStub();
  vi.stubGlobal('fetch', fetchStub.fetch);
  vi.stubGlobal('sessionStorage', storageStub.storage);
  vi.stubGlobal('crypto', createCryptoStub());
  resetSession();
}

async function connect(token = jwt({ realm_access: { roles: ['admin'] } })): Promise<string> {
  storageStub.storage.setItem(pkceTransactionKey, JSON.stringify({ state: 's', verifier: 'verifier' }));
  const login = completeLogin('?code=code-1&state=s');
  await flush();
  fetchStub.answer(TOKEN_URL, { access_token: token, id_token: 'id-token' });
  await login;
  fetchStub.calls.length = 0;
  return token;
}

function expectFailure<T>(outcome: Outcome<T>): Failure {
  if (outcome.ok) throw new Error('expected a failure outcome');
  return outcome.failure;
}

function action(overrides: Record<string, unknown> = {}): PreventiveAction {
  return {
    id: 'action-1',
    community_code: '05101',
    title: 'Despeje de vegetación',
    description: '',
    priority: 'alta',
    status: 'propuesta',
    assignee: 'equipo-1',
    due_date: '2026-11-01',
    created_by: 'actor-1',
    created_at: '2026-10-17T10:00:00Z',
    updated_at: '2026-10-17T10:00:00Z',
    ...overrides,
  };
}

function detail(): PreventiveActionDetail {
  return {
    ...action(),
    history: [
      {
        id: 1,
        action_id: 'action-1',
        from_status: null,
        to_status: 'propuesta',
        actor_sub: 'actor-1',
        note: 'alta',
        created_at: '2026-10-17T10:00:00Z',
      },
    ],
    evidence: [],
    evidence_reviews: [],
    reassessments: [],
    evidence_sufficient: false,
  };
}

beforeEach(setup);

afterEach(() => {
  vi.unstubAllGlobals();
});

test('the list route carries the bearer and only the filters that were chosen', async () => {
  const token = await connect();

  const filtered = preventiveActions({ communityCode: '05101', status: 'propuesta' });
  await flush();
  expect(fetchStub.callsFor(`${ACTIONS_URL}?community_code=05101&status=propuesta`)).toHaveLength(1);
  const call = fetchStub.callsFor(`${ACTIONS_URL}?community_code=05101&status=propuesta`)[0];
  expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
  expect(call.init.credentials).toBe('omit');
  fetchStub.answer(`${ACTIONS_URL}?community_code=05101&status=propuesta`, [action()]);
  expect(await filtered).toEqual({ ok: true, data: [action()] });

  // A second list read of the same kind only starts once the first has settled:
  // the transport discards a superseded answer, so two concurrent lists would
  // leave the earlier one unanswerable by design.
  const unfiltered = preventiveActions();
  await flush();
  expect(fetchStub.callsFor(ACTIONS_URL)).toHaveLength(1);
  fetchStub.answer(ACTIONS_URL, []);
  expect(await unfiltered).toEqual({ ok: true, data: [] });
});

test('the list fails closed on a non-array or an entry without identity', async () => {
  await connect();

  const notArray = preventiveActions();
  await flush();
  fetchStub.answer(ACTIONS_URL, { actions: [] });
  expect(expectFailure(await notArray).kind).toBe('malformed');

  const brokenEntry = preventiveActions();
  await flush();
  fetchStub.answer(ACTIONS_URL, [action({ id: '' })]);
  expect(expectFailure(await brokenEntry).kind).toBe('malformed');
});

test('the detail route returns the action with its history', async () => {
  await connect();

  const read = preventiveAction('action-1');
  await flush();
  expect(fetchStub.callsFor(`${ACTIONS_URL}/action-1`)).toHaveLength(1);
  fetchStub.answer(`${ACTIONS_URL}/action-1`, detail());
  expect(await read).toEqual({ ok: true, data: detail() });
});

test('the detail route rejects a history that is missing or not an array', async () => {
  await connect();

  const missing = preventiveAction('action-1');
  await flush();
  fetchStub.answer(`${ACTIONS_URL}/action-1`, action());
  expect(expectFailure(await missing).kind).toBe('malformed');

  const brokenHistory = preventiveAction('action-1');
  await flush();
  fetchStub.answer(`${ACTIONS_URL}/action-1`, { ...action(), history: [{ from_status: 'propuesta' }] });
  expect(expectFailure(await brokenHistory).kind).toBe('malformed');
});

test('creation posts only the fields it was given and accepts a 201', async () => {
  await connect();

  const created = createPreventiveAction({
    communityCode: '05101',
    title: 'Charla preventiva',
    description: 'Actividad con la junta de vecinos',
    priority: 'media',
    assigneeId: '',
    dueDate: '',
  });
  await flush();

  const call = fetchStub.callsFor(ACTIONS_URL).find(candidate => candidate.init.method === 'POST');
  expect(call).toBeDefined();
  expect((call?.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  expect(JSON.parse(String(call?.init.body))).toEqual({
    community_code: '05101',
    title: 'Charla preventiva',
    description: 'Actividad con la junta de vecinos',
    priority: 'media',
  });

  fetchStub.answer(ACTIONS_URL, action({ status: 'propuesta' }), 201);
  const outcome = await created;
  expect(outcome.ok).toBe(true);
  if (outcome.ok) expect(outcome.data.status).toBe('propuesta');
});

test('a transition posts {to, note} and returns the new version', async () => {
  await connect();

  const outcome = transitionPreventiveAction('action-1', { to: 'asignada', note: 'asignada al equipo' });
  await flush();
  const transitionUrl = `${ACTIONS_URL}/action-1/transitions`;
  const call = fetchStub.callsFor(transitionUrl)[0];
  expect(call.init.method).toBe('POST');
  expect(JSON.parse(String(call.init.body))).toEqual({ to: 'asignada', note: 'asignada al equipo' });

  fetchStub.answer(transitionUrl, action({ status: 'asignada' }));
  const settled = await outcome;
  expect(settled.ok).toBe(true);
  if (settled.ok) expect(settled.data.status).toBe('asignada');
});

test('an invalid transition surfaces the 409 code and the request id untouched', async () => {
  await connect();

  const outcome = transitionPreventiveAction('action-1', { to: 'aceptada', note: '' });
  await flush();
  fetchStub.answer(`${ACTIONS_URL}/action-1/transitions`, { code: 'invalid_transition' }, 409, 'req-409');
  const failure = expectFailure(await outcome);
  expect(failure.status).toBe(409);
  expect(failure.reason).toBe('invalid_transition');
  expect(failure.requestId).toBe('req-409');
});

test('a 422 invalid input is surfaced with its code', async () => {
  await connect();

  const outcome = createPreventiveAction({ communityCode: '', title: '' });
  await flush();
  fetchStub.answer(ACTIONS_URL, { code: 'invalid_input' }, 422, 'req-422');
  const failure = expectFailure(await outcome);
  expect(failure.status).toBe(422);
  expect(failure.reason).toBe('invalid_input');
});

// ── V1-U-04 · the realm user directory and the assignment reference ────────
//
// `GET /v1/users` is admin-only and fails closed: an unreachable directory is
// answered 503/502, never with an empty list, so the transport must keep that
// distinction instead of turning it into "the realm has no users".

test('the user directory read is absolute, authenticated and returns the served list', async () => {
  const token = await connect();

  const read = users();
  await flush();
  expect(fetchStub.callsFor(USERS_URL)).toHaveLength(1);
  const call = fetchStub.callsFor(USERS_URL)[0];
  expect(call.init.method).toBe('GET');
  expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
  expect(call.init.credentials).toBe('omit');
  expect(call.init.cache).toBe('no-store');

  const served = [
    { id: 'user-1', display_name: 'Admin del Directorio' },
    { id: 'user-2', display_name: 'Revisor del Directorio' },
  ];
  fetchStub.answer(USERS_URL, served);
  expect(await read).toEqual({ ok: true, data: served });
});

test('the user directory fails closed and keeps the directory error codes', async () => {
  await connect();

  const notArray = users();
  await flush();
  fetchStub.answer(USERS_URL, { users: [] });
  expect(expectFailure(await notArray).kind).toBe('malformed');

  const nameless = users();
  await flush();
  fetchStub.answer(USERS_URL, [{ id: 'user-1' }]);
  expect(expectFailure(await nameless).kind).toBe('malformed');

  const anonymous = users();
  await flush();
  fetchStub.answer(USERS_URL, [{ id: '', display_name: 'Sin identificador' }]);
  expect(expectFailure(await anonymous).kind).toBe('malformed');

  // 200 [] is a realm that really has no users: data, not an error.
  const empty = users();
  await flush();
  fetchStub.answer(USERS_URL, []);
  expect(await empty).toEqual({ ok: true, data: [] });

  const unavailable = users();
  await flush();
  fetchStub.answer(USERS_URL, { code: 'directory_unavailable' }, 503, 'req-dir-503');
  const unavailableFailure = expectFailure(await unavailable);
  expect(unavailableFailure.kind).toBe('unavailable');
  expect(unavailableFailure.status).toBe(503);
  expect(unavailableFailure.reason).toBe('directory_unavailable');
  expect(unavailableFailure.requestId).toBe('req-dir-503');

  const upstream = users();
  await flush();
  fetchStub.answer(USERS_URL, { code: 'directory_upstream_failed' }, 502, 'req-dir-502');
  const upstreamFailure = expectFailure(await upstream);
  expect(upstreamFailure.status).toBe(502);
  expect(upstreamFailure.reason).toBe('directory_upstream_failed');

  const denied = users();
  await flush();
  fetchStub.answer(USERS_URL, { code: 'forbidden' }, 403, 'req-dir-403');
  const deniedFailure = expectFailure(await denied);
  expect(deniedFailure.kind).toBe('forbidden');
  expect(deniedFailure.requestId).toBe('req-dir-403');
});

test('creation sends assignee_id and never the legacy free text', async () => {
  await connect();

  const created = createPreventiveAction({
    communityCode: '05101',
    title: 'Acción asignada',
    assigneeId: ASSIGNEE_UUID,
  });
  await flush();

  const call = fetchStub.callsFor(ACTIONS_URL).find(candidate => candidate.init.method === 'POST');
  expect(JSON.parse(String(call?.init.body))).toEqual({
    community_code: '05101',
    title: 'Acción asignada',
    assignee_id: ASSIGNEE_UUID,
  });

  fetchStub.answer(ACTIONS_URL, action({ status: 'propuesta', assignee: null, assignee_id: ASSIGNEE_UUID }), 201);
  const outcome = await created;
  expect(outcome.ok).toBe(true);
});

test('a refused assignee identifier is surfaced with its code and request id', async () => {
  await connect();

  const outcome = createPreventiveAction({
    communityCode: '05101',
    title: 'Acción con referencia desconocida',
    // A well-formed reference the directory does not know: the contract refuses it
    // 422 `assignee_not_found`, and a malformed identifier would be a different
    // refusal (`invalid_action_request`).
    assigneeId: '0f6b8c3d-4e52-4a7b-8c9d-1e2f3a4b5c6d',
  });
  await flush();
  fetchStub.answer(ACTIONS_URL, { code: 'assignee_not_found' }, 422, 'req-422-assignee');
  const failure = expectFailure(await outcome);
  expect(failure.status).toBe(422);
  expect(failure.reason).toBe('assignee_not_found');
  expect(failure.requestId).toBe('req-422-assignee');
});

// A failed POST is one of two different facts, and the view may not merge them:
// the contract PROVES some refusals stored nothing, while a transport fault, a
// deadline or an unusable 2xx body leaves the write undetermined. The code of
// each refused response is what carries the proof (a bare status is not enough:
// a gateway 502 and the directory's own 502 share it and mean opposite things).
test('a failed write is a proven refusal only when the contract says nothing was written', () => {
  const proven: Failure[] = [
    { kind: 'forbidden', reason: 'forbidden', status: 403 },
    { kind: 'unauthorized', reason: 'unauthorized', status: 401 },
    // 415 json_required: the content type is refused before any effect.
    { kind: 'unavailable', reason: 'json_required', status: 415 },
    // 422: "nothing is written".
    { kind: 'malformed', reason: 'invalid_action_request', status: 422 },
    { kind: 'malformed', reason: 'assignee_not_found', status: 422 },
    // The directory failed before the store was reached.
    { kind: 'unavailable', reason: 'directory_unavailable', status: 503 },
    { kind: 'unavailable', reason: 'directory_upstream_failed', status: 502 },
    // 503: "the operation has no effect and stored state is unchanged".
    { kind: 'unavailable', reason: 'storage_unavailable', status: 503 },
    // 429: answered before routing.
    { kind: 'unavailable', reason: 'rate_limited', status: 429 },
  ];
  for (const failure of proven) {
    expect(isConfirmedWriteRefusal(failure), JSON.stringify(failure)).toBe(true);
  }

  const undetermined: Failure[] = [
    // No response was ever read: the request may have been stored.
    { kind: 'unavailable', reason: 'network' },
    { kind: 'unavailable', reason: 'deadline' },
    { kind: 'unavailable', reason: 'superseded' },
    { kind: 'unavailable', reason: 'aborted' },
    // The gateway never reached the service ("no upstream response was observed"),
    // which is the opposite of the directory's own 502.
    { kind: 'unavailable', reason: 'upstream_unavailable', status: 502 },
    // A 2xx whose body this page cannot use: the write may have happened.
    { kind: 'malformed', reason: 'invalid_shape', status: 201 },
    { kind: 'malformed', reason: 'malformed_json', status: 201 },
    // A status alone, with no contract code, proves nothing about the layer.
    { kind: 'unavailable', reason: 'http_422', status: 422 },
    { kind: 'unavailable', reason: 'http_503', status: 503 },
    { kind: 'unavailable', reason: 'http_500', status: 500 },
  ];
  for (const failure of undetermined) {
    expect(isConfirmedWriteRefusal(failure), JSON.stringify(failure)).toBe(false);
  }
});

// The code and the status are one fact: each refusal code is documented under one
// status on the create route, and a pair the contract never defines proves nothing
// about what the layer did. A refusal code on an unexpected status is therefore
// undetermined, not "nothing was written".
test('a refusal code on a status the contract does not pair it with is undetermined', () => {
  const mismatched: Failure[] = [
    { kind: 'unavailable', reason: 'assignee_not_found', status: 500 },
    { kind: 'unavailable', reason: 'invalid_action_request', status: 500 },
    { kind: 'unavailable', reason: 'assignee_not_found', status: 503 },
    { kind: 'unavailable', reason: 'json_required', status: 422 },
    { kind: 'unavailable', reason: 'directory_unavailable', status: 502 },
    { kind: 'unavailable', reason: 'directory_upstream_failed', status: 503 },
    { kind: 'unavailable', reason: 'storage_unavailable', status: 502 },
    { kind: 'unavailable', reason: 'upstream_unavailable', status: 502 },
    // A code with no status at all cannot be paired with its documented response.
    { kind: 'unavailable', reason: 'assignee_not_found' },
  ];
  for (const failure of mismatched) {
    expect(isConfirmedWriteRefusal(failure), JSON.stringify(failure)).toBe(false);
  }
});

// ── The assignment reference is a nullable UUID on every read ──────────────
//
// `PreventiveAction.assignee_id` is `type: string, format: uuid, nullable: true`
// in the contract and has no `omitempty` on the service side, so the reference is
// either null or a dashed UUID. A payload carrying anything else is a contract
// change, not a name to render. An ABSENT field stays tolerated: the legacy
// fixtures that predate the reference must keep working.
test('assignee_id is validated as a nullable UUID on every preventive-action read', async () => {
  await connect();

  const reference = preventiveActions();
  await flush();
  fetchStub.answer(ACTIONS_URL, [action({ assignee_id: ASSIGNEE_UUID })]);
  expect(await reference).toEqual({ ok: true, data: [action({ assignee_id: ASSIGNEE_UUID })] });

  const unassigned = preventiveActions();
  await flush();
  fetchStub.answer(ACTIONS_URL, [action({ assignee_id: null })]);
  expect((await unassigned).ok).toBe(true);

  // Absent stays valid: the older fixtures never carried the field.
  const legacy = preventiveActions();
  await flush();
  fetchStub.answer(ACTIONS_URL, [action()]);
  expect((await legacy).ok).toBe(true);

  const notAUuid = preventiveActions();
  await flush();
  fetchStub.answer(ACTIONS_URL, [action({ assignee_id: 'user-2' })]);
  expect(expectFailure(await notAUuid).kind).toBe('malformed');

  const wrongType = preventiveActions();
  await flush();
  fetchStub.answer(ACTIONS_URL, [action({ assignee_id: 42 })]);
  expect(expectFailure(await wrongType).kind).toBe('malformed');

  const detailRead = preventiveAction('action-1');
  await flush();
  fetchStub.answer(`${ACTIONS_URL}/action-1`, { ...detail(), assignee_id: 'user-2' });
  expect(expectFailure(await detailRead).kind).toBe('malformed');

  // A created action is read the same way, and the contract returns propuesta.
  const created = createPreventiveAction({ communityCode: '05101', title: 'Acción asignada', assigneeId: ASSIGNEE_UUID });
  await flush();
  fetchStub.answer(ACTIONS_URL, action({ status: 'propuesta', assignee: null, assignee_id: ASSIGNEE_UUID }), 201);
  const outcome = await created;
  expect(outcome.ok).toBe(true);
  if (outcome.ok) expect(outcome.data.assignee_id).toBe(ASSIGNEE_UUID);
});

test('a 403 is a stated permission denial and a 401 closes the session', async () => {
  await connect();

  const denied = preventiveActions();
  await flush();
  fetchStub.answer(ACTIONS_URL, { code: 'forbidden' }, 403, 'req-403');
  const forbidden = expectFailure(await denied);
  expect(forbidden.kind).toBe('forbidden');
  expect(forbidden.requestId).toBe('req-403');

  const refused = preventiveActions();
  await flush();
  fetchStub.answer(ACTIONS_URL, { code: 'unauthorized' }, 401, 'req-401');
  const unauthorized = expectFailure(await refused);
  expect(unauthorized.kind).toBe('unauthorized');
  expect(unauthorized.requestId).toBe('req-401');
});

test('the model versions read accepts the real {models} envelope and rejects a malformed list or entry', async () => {
  await connect();
  const read = modelVersions();
  await flush();
  expect(fetchStub.callsFor(MODELS_URL)).toHaveLength(1);
  fetchStub.answer(MODELS_URL, {
    models: [
      { version: 'academic-rule-v1', kind: 'rule', params_hash: null, approved_at: null, metrics: {}, active: true },
      { version: 'demo-fixture-v1', kind: 'placeholder', params_hash: null, approved_at: null, metrics: { synthetic: true }, active: false },
    ],
  });
  const outcome = await read;
  expect(outcome.ok).toBe(true);
  if (outcome.ok) expect(outcome.data).toHaveLength(2);

  // The bare array is the shape that was assumed and is NOT what the service
  // serves; it must be rejected so a wrong shape can never render as data.
  const bareArray = modelVersions();
  await flush();
  fetchStub.answer(MODELS_URL, [{ version: 'academic-rule-v1', active: true }]);
  expect(expectFailure(await bareArray).kind).toBe('malformed');

  const missingList = modelVersions();
  await flush();
  fetchStub.answer(MODELS_URL, { versions: [] });
  expect(expectFailure(await missingList).kind).toBe('malformed');

  const malformedEntry = modelVersions();
  await flush();
  fetchStub.answer(MODELS_URL, { models: [{ version: 'academic-rule-v1' }, 'not-an-entry'] });
  expect(expectFailure(await malformedEntry).kind).toBe('malformed');
});

test('the sources read carries the per-source cycle array through untouched', async () => {
  await connect();
  const body = {
    geography: {
      provenance: {
        provider: 'SUBDERE',
        attribution: 'Atribución',
        restriction: 'Restricción',
        record_count: 38,
        derived_sha256: 'c'.repeat(64),
      },
      source_cutoff_at: null,
      cutoff_semantics: 'retrieval_substitution',
      integrity: { algorithm: 'sha256', matches: true },
    },
    risk_input: { synthetic: true, display_name: 'Perfil', id: 'academic' },
    sources: [
      {
        source_id: 'fixture',
        last_run_at: '2026-01-01T11:45:00Z',
        next_run_at: '2026-01-01T12:00:00Z',
        complete: true,
        age_seconds: 900,
      },
    ],
  };
  const read = sources();
  await flush();
  fetchStub.answer(SOURCES_URL, body);
  const outcome = await read;
  expect(outcome.ok).toBe(true);
  if (outcome.ok) expect(outcome.data.sources).toEqual(body.sources);
});
