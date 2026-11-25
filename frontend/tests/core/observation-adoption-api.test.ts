import { afterEach, beforeEach, expect, test } from 'vitest';

import { gatewayOrigin, issuer, pkceTransactionKey } from '../../src/config';
import { adoptObservation, observations, type Failure, type Outcome } from '../../src/core/api';
import { completeLogin, getSessionSnapshot, resetSession } from '../../src/core/session';
import type { Observation } from '../../src/types/api';

import { createCryptoStub, createFetchStub, createStorageStub, flush, jwt } from '../core/harness';

// PM-10 / T4 — the transport half of the S4 relationship. The frozen seam is
// `POST /v1/prevention/observations/{id}/adoption` with a body that carries
// exactly one existing action: the confirming actor is the verified token
// subject, and the observation is addressed by the path. The answer is the
// observation in its post-link state, so the link the page displays is the one
// the service confirmed. A refusal keeps its status, its `code` and its
// `request_id` for the view to state.

const TOKEN_URL = `${issuer}/protocol/openid-connect/token`;
const OBSERVATIONS_URL = `${gatewayOrigin}/v1/prevention/observations`;
const ADOPTION_URL = `${OBSERVATIONS_URL}/obs-1/adoption`;

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
    adopted_action_id: null,
    ...overrides,
  } as Observation;
}

beforeEach(setup);

afterEach(() => {
  vi.unstubAllGlobals();
});

test('the adoption posts exactly one action id to the observation path and returns the linked record', async () => {
  const token = await connect();

  const adopted = adoptObservation('obs-1', 'action-1');
  await flush();

  const [call] = fetchStub.callsFor(ADOPTION_URL);
  expect(call).toBeDefined();
  expect(call.init.method).toBe('POST');
  expect((call.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
  const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
  // One field: no status, assignee, note, date or author may travel from here.
  expect(Object.keys(body)).toEqual(['action_id']);
  expect(body).toEqual({ action_id: 'action-1' });
  expect(String(call.init.body)).not.toMatch(/created_by|assignee|status|confirmed_by|note/);

  fetchStub.answer(ADOPTION_URL, observation({ adopted_action_id: 'action-1' }), 200, 'req-adopt');
  const outcome = await adopted;
  expect(outcome.ok).toBe(true);
  if (outcome.ok) expect(outcome.data.adopted_action_id).toBe('action-1');
});

test('the observation id is encoded in the path and never concatenated raw', async () => {
  await connect();

  const adopted = adoptObservation('obs/../1', 'action-1');
  await flush();

  expect(fetchStub.callsFor(`${OBSERVATIONS_URL}/obs%2F..%2F1/adoption`)).toHaveLength(1);
  fetchStub.answer(`${OBSERVATIONS_URL}/obs%2F..%2F1/adoption`, observation({ id: 'obs/../1', adopted_action_id: 'action-1' }));
  const outcome = await adopted;
  expect(outcome.ok).toBe(true);
});

test('an answer that does not echo the requested link is refused instead of displayed', async () => {
  await connect();

  const otherObservation = adoptObservation('obs-1', 'action-1');
  await flush();
  fetchStub.answer(ADOPTION_URL, observation({ id: 'obs-2', adopted_action_id: 'action-1' }), 200, 'req-other');
  const wrongObservation = expectFailure(await otherObservation);
  expect(wrongObservation.kind).toBe('malformed');
  expect(wrongObservation.reason).toBe('adoption_mismatch');
  expect(wrongObservation.requestId).toBe('req-other');

  const otherAction = adoptObservation('obs-1', 'action-1');
  await flush();
  fetchStub.answer(ADOPTION_URL, observation({ adopted_action_id: 'action-2' }));
  expect(expectFailure(await otherAction).reason).toBe('adoption_mismatch');

  const noLink = adoptObservation('obs-1', 'action-1');
  await flush();
  fetchStub.answer(ADOPTION_URL, observation({ adopted_action_id: null }));
  expect(expectFailure(await noLink).reason).toBe('adoption_mismatch');

  const unreadable = adoptObservation('obs-1', 'action-1');
  await flush();
  fetchStub.answer(ADOPTION_URL, { observation: observation() });
  const malformed = expectFailure(await unreadable);
  expect(malformed.kind).toBe('malformed');
  expect(malformed.reason).toBe('invalid_shape');
});

test('a cancelled action and an already adopted observation stay distinguishable 409 conflicts', async () => {
  await connect();

  const cancelled = adoptObservation('obs-1', 'action-1');
  await flush();
  fetchStub.answer(ADOPTION_URL, { code: 'action_cancelled' }, 409, 'req-cancelled');
  const cancelledFailure = expectFailure(await cancelled);
  expect(cancelledFailure.status).toBe(409);
  expect(cancelledFailure.reason).toBe('action_cancelled');
  expect(cancelledFailure.requestId).toBe('req-cancelled');

  const alreadyAdopted = adoptObservation('obs-1', 'action-2');
  await flush();
  fetchStub.answer(ADOPTION_URL, { code: 'observation_already_adopted' }, 409, 'req-adopted');
  const adoptedFailure = expectFailure(await alreadyAdopted);
  expect(adoptedFailure.status).toBe(409);
  expect(adoptedFailure.reason).toBe('observation_already_adopted');
  expect(adoptedFailure.requestId).toBe('req-adopted');
});

test('a missing action, a malformed request and a missing observation keep their own codes', async () => {
  await connect();

  const unknownAction = adoptObservation('obs-1', 'action-x');
  await flush();
  fetchStub.answer(ADOPTION_URL, { code: 'action_not_found' }, 422, 'req-action');
  const actionFailure = expectFailure(await unknownAction);
  expect(actionFailure.status).toBe(422);
  expect(actionFailure.reason).toBe('action_not_found');

  const invalid = adoptObservation('obs-1', '');
  await flush();
  fetchStub.answer(ADOPTION_URL, { code: 'invalid_adoption_request' }, 422, 'req-invalid');
  expect(expectFailure(await invalid).reason).toBe('invalid_adoption_request');

  const missing = adoptObservation('obs-1', 'action-1');
  await flush();
  fetchStub.answer(ADOPTION_URL, { code: 'observation_not_found' }, 404, 'req-404');
  const missingFailure = expectFailure(await missing);
  expect(missingFailure.kind).toBe('missing');
  expect(missingFailure.reason).toBe('observation_not_found');
});

test('a 403 stays a stated permission denial and a 401 closes the session', async () => {
  await connect();

  const denied = adoptObservation('obs-1', 'action-1');
  await flush();
  fetchStub.answer(ADOPTION_URL, { code: 'forbidden' }, 403, 'req-403');
  const forbidden = expectFailure(await denied);
  expect(forbidden.kind).toBe('forbidden');
  expect(forbidden.requestId).toBe('req-403');

  const refused = adoptObservation('obs-1', 'action-1');
  await flush();
  fetchStub.answer(ADOPTION_URL, { code: 'unauthorized' }, 401, 'req-401');
  const unauthorized = expectFailure(await refused);
  expect(unauthorized.kind).toBe('unauthorized');
  expect(getSessionSnapshot().status).toBe('signed-out');
  expect(getSessionSnapshot().reason).toBe('rejected');
});

test('the list read accepts the additive adopted_action_id as absent, null or an id and refuses anything else', async () => {
  await connect();

  const absent = observations();
  await flush();
  fetchStub.answer(OBSERVATIONS_URL, [observation({ adopted_action_id: undefined })]);
  const absentOutcome = await absent;
  expect(absentOutcome.ok).toBe(true);
  if (absentOutcome.ok) expect(absentOutcome.data[0].adopted_action_id).toBeUndefined();

  const cleared = observations();
  await flush();
  fetchStub.answer(OBSERVATIONS_URL, [observation({ adopted_action_id: null })]);
  const clearedOutcome = await cleared;
  expect(clearedOutcome.ok).toBe(true);
  if (clearedOutcome.ok) expect(clearedOutcome.data[0].adopted_action_id).toBeNull();

  const linked = observations();
  await flush();
  fetchStub.answer(OBSERVATIONS_URL, [observation({ adopted_action_id: 'action-1' })]);
  const linkedOutcome = await linked;
  expect(linkedOutcome.ok).toBe(true);
  if (linkedOutcome.ok) expect(linkedOutcome.data[0].adopted_action_id).toBe('action-1');

  const broken = observations();
  await flush();
  fetchStub.answer(OBSERVATIONS_URL, [observation({ adopted_action_id: 7 })]);
  const brokenFailure = expectFailure(await broken);
  expect(brokenFailure.kind).toBe('malformed');
  expect(brokenFailure.reason).toBe('invalid_shape');
});
