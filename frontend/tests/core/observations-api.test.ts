import { afterEach, beforeEach, expect, test } from 'vitest';

import { gatewayOrigin, issuer, pkceTransactionKey } from '../../src/config';
import {
  createObservation,
  observationZones,
  observations,
  type Failure,
  type Outcome,
} from '../../src/core/api';
import { completeLogin, getSessionSnapshot, resetSession } from '../../src/core/session';
import type { Observation, ObservationZone } from '../../src/types/api';

import { createCryptoStub, createFetchStub, createStorageStub, flush, jwt } from '../core/harness';

// S2 / L5 — the transport half of the PM-09 field-observation seam:
// `odd/tasks/pm-09-incidents.md` freezes `GET|POST /v1/prevention/observations`
// and `GET /v1/prevention/observations/zones`. The list read accepts an optional
// `type`, the creation posts only `zone_id`, `type`, `observed_on` and
// `description` — never an author — and the error codes travel untouched.

const TOKEN_URL = `${issuer}/protocol/openid-connect/token`;
const OBSERVATIONS_URL = `${gatewayOrigin}/v1/prevention/observations`;
const ZONES_URL = `${gatewayOrigin}/v1/prevention/observations/zones`;

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

function observation(overrides: Record<string, unknown> = {}): Observation {
  return {
    id: 'obs-1',
    type: 'vegetacion_seca',
    zone_id: 'z-1',
    zone_name: 'Foco Quebrada del Este',
    observed_on: '2026-11-20',
    description: 'Acumulación de pastizal seco junto a la escalera de acceso.',
    created_by: 'sub-verified',
    created_at: '2026-11-20T10:00:00Z',
    ...overrides,
  } as Observation;
}

function zone(overrides: Record<string, unknown> = {}): ObservationZone {
  return {
    code: 'z-1',
    name: 'Foco Quebrada del Este',
    province: 'Valparaíso',
    ...overrides,
  } as ObservationZone;
}

beforeEach(setup);

afterEach(() => {
  vi.unstubAllGlobals();
});

test('the list read carries the bearer, no query when no type was chosen and the served order untouched', async () => {
  const token = await connect();

  const unfiltered = observations();
  await flush();
  const [call] = fetchStub.callsFor(OBSERVATIONS_URL);
  expect((call.init.method ?? 'GET')).toBe('GET');
  expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
  expect(call.init.credentials).toBe('omit');
  fetchStub.answer(OBSERVATIONS_URL, [observation({ id: 'obs-2' }), observation({ id: 'obs-1' })]);
  const outcome = await unfiltered;
  expect(outcome.ok).toBe(true);
  // Newest first is the server's order; the transport neither sorts nor reverses it.
  if (outcome.ok) expect(outcome.data.map(entry => entry.id)).toEqual(['obs-2', 'obs-1']);

  const filtered = observations({ type: 'quema' });
  await flush();
  expect(fetchStub.callsFor(`${OBSERVATIONS_URL}?type=quema`)).toHaveLength(1);
  fetchStub.answer(`${OBSERVATIONS_URL}?type=quema`, []);
  // An empty list is a real answer, not a failure.
  expect(await filtered).toEqual({ ok: true, data: [] });
});

test('the list fails closed on an envelope, a missing identity or a zone name that is neither null nor a string', async () => {
  await connect();

  const envelope = observations();
  await flush();
  fetchStub.answer(OBSERVATIONS_URL, { observations: [] });
  expect(expectFailure(await envelope).kind).toBe('malformed');

  const missingId = observations();
  await flush();
  fetchStub.answer(OBSERVATIONS_URL, [observation({ id: '' })]);
  expect(expectFailure(await missingId).kind).toBe('malformed');

  const missingAuthor = observations();
  await flush();
  fetchStub.answer(OBSERVATIONS_URL, [observation({ created_by: '' })]);
  expect(expectFailure(await missingAuthor).kind).toBe('malformed');

  const brokenZoneName = observations();
  await flush();
  fetchStub.answer(OBSERVATIONS_URL, [observation({ zone_name: 7 })]);
  expect(expectFailure(await brokenZoneName).kind).toBe('malformed');
});

test('the zones read returns the real catalogue, including a zone without province, and rejects a malformed one', async () => {
  await connect();

  const read = observationZones();
  await flush();
  const [call] = fetchStub.callsFor(ZONES_URL);
  expect((call.init.method ?? 'GET')).toBe('GET');
  const body = [zone(), zone({ code: 'z-2', name: 'Interior de Quilpué', province: null })];
  fetchStub.answer(ZONES_URL, body);
  expect(await read).toEqual({ ok: true, data: body });

  const envelope = observationZones();
  await flush();
  fetchStub.answer(ZONES_URL, { zones: [] });
  expect(expectFailure(await envelope).kind).toBe('malformed');

  const missingCode = observationZones();
  await flush();
  fetchStub.answer(ZONES_URL, [zone({ code: '' })]);
  expect(expectFailure(await missingCode).kind).toBe('malformed');

  const brokenProvince = observationZones();
  await flush();
  fetchStub.answer(ZONES_URL, [zone({ province: 5 })]);
  expect(expectFailure(await brokenProvince).kind).toBe('malformed');
});

test('creation posts exactly the four documented fields, omits the author and accepts the 201 record', async () => {
  await connect();

  const created = createObservation({
    zoneId: 'z-1',
    type: 'vegetacion_seca',
    observedOn: '2026-11-20',
    description: 'Acumulación de pastizal seco junto a la escalera de acceso.',
  });
  await flush();

  const call = fetchStub.callsFor(OBSERVATIONS_URL).find(candidate => candidate.init.method === 'POST');
  expect(call).toBeDefined();
  expect((call?.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  const body = JSON.parse(String(call?.init.body)) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(['description', 'observed_on', 'type', 'zone_id']);
  expect(body).toEqual({
    zone_id: 'z-1',
    type: 'vegetacion_seca',
    observed_on: '2026-11-20',
    description: 'Acumulación de pastizal seco junto a la escalera de acceso.',
  });
  // The author is the verified token `sub`; the client never sends one.
  expect(String(call?.init.body)).not.toMatch(/created_by|author/);
  expect((call?.init.headers as Record<string, string>).Authorization).toBeTruthy();

  fetchStub.answer(OBSERVATIONS_URL, observation(), 201, 'req-201');
  const outcome = await created;
  expect(outcome.ok).toBe(true);
  if (outcome.ok) {
    expect(outcome.data.id).toBe('obs-1');
    expect(outcome.data.created_by).toBe('sub-verified');
  }
});

test('a refused creation keeps the server code, the HTTP status and the request id', async () => {
  await connect();

  const invalid = createObservation({ zoneId: 'z-1', type: 'quema', observedOn: '2026-11-20', description: 'x' });
  await flush();
  fetchStub.answer(OBSERVATIONS_URL, { code: 'invalid_observation_request' }, 422, 'req-invalid');
  const invalidFailure = expectFailure(await invalid);
  expect(invalidFailure.status).toBe(422);
  expect(invalidFailure.reason).toBe('invalid_observation_request');
  expect(invalidFailure.requestId).toBe('req-invalid');

  const unknownZone = createObservation({ zoneId: 'z-x', type: 'quema', observedOn: '2026-11-20', description: 'x' });
  await flush();
  fetchStub.answer(OBSERVATIONS_URL, { code: 'zone_not_found' }, 422, 'req-zone');
  const zoneFailure = expectFailure(await unknownZone);
  expect(zoneFailure.status).toBe(422);
  expect(zoneFailure.reason).toBe('zone_not_found');
  expect(zoneFailure.requestId).toBe('req-zone');

  const unavailable = createObservation({ zoneId: 'z-1', type: 'quema', observedOn: '2026-11-20', description: 'x' });
  await flush();
  fetchStub.answer(OBSERVATIONS_URL, { code: 'storage_unavailable' }, 503, 'req-503');
  const storageFailure = expectFailure(await unavailable);
  expect(storageFailure.status).toBe(503);
  expect(storageFailure.reason).toBe('storage_unavailable');
  expect(storageFailure.requestId).toBe('req-503');
});

test('a 403 stays a stated permission denial and a 401 closes the session', async () => {
  await connect();

  const denied = observations();
  await flush();
  fetchStub.answer(OBSERVATIONS_URL, { code: 'forbidden' }, 403, 'req-403');
  const forbidden = expectFailure(await denied);
  expect(forbidden.kind).toBe('forbidden');
  expect(forbidden.reason).toBe('forbidden');
  expect(forbidden.requestId).toBe('req-403');

  const refused = createObservation({ zoneId: 'z-1', type: 'quema', observedOn: '2026-11-20', description: 'x' });
  await flush();
  fetchStub.answer(OBSERVATIONS_URL, { code: 'unauthorized' }, 401, 'req-401');
  const unauthorized = expectFailure(await refused);
  expect(unauthorized.kind).toBe('unauthorized');
  expect(unauthorized.requestId).toBe('req-401');
  expect(getSessionSnapshot().status).toBe('signed-out');
  expect(getSessionSnapshot().reason).toBe('rejected');
});

test('a creation response that does not echo the selected zone is refused instead of rendered', async () => {
  await connect();

  const created = createObservation({
    zoneId: 'z-1',
    type: 'otro',
    observedOn: '2026-11-20',
    description: 'Acceso bloqueado por un portón nuevo.',
  });
  await flush();
  fetchStub.answer(OBSERVATIONS_URL, observation({ zone_id: 'z-2' }), 201, 'req-201');
  const failure = expectFailure(await created);
  expect(failure.kind).toBe('malformed');
  expect(failure.reason).toBe('zone_mismatch');
});
