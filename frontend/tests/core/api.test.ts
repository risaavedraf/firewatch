import { gatewayOrigin, issuer, pkceTransactionKey } from '../../src/config';
import {
  audit,
  batches,
  createJob,
  EXPLAIN_QUESTION_LIMIT,
  explainRisk,
  history,
  job,
  jobsStatus,
  latest,
  ready,
  riskStatus,
  scenarios,
  sources,
  zones,
  parseScenarios,
} from '../../src/core/api';
import type { Failure, Outcome } from '../../src/core/api';
import { completeLogin, getAccessToken, getSessionSnapshot, resetSession } from '../../src/core/session';
import type { Job, RiskBatch, SourceProvenance } from '../../src/types/api';

import { createCryptoStub, createFetchStub, createStorageStub, createWindowStub, flush, jwt } from './harness';

const TOKEN_URL = `${issuer}/protocol/openid-connect/token`;

const REQUEST_DEADLINE_MS = 10_000;

function expectFailure<T>(outcome: Outcome<T>): Failure {
  if (outcome.ok) throw new Error('expected a failure outcome');
  return outcome.failure;
}

function batch(zone = '05101', id = 'batch-1', jobId = 'job-1'): RiskBatch {
  return {
    zone_id: zone,
    id,
    job_id: jobId,
    demo: true,
    risk_level: 'alto',
    factors: [{ name: 'temperatura', known: true, value: 30, contribution: 0.2, note: '' }],
    rationale: 'Regla académica',
    policy: { policy_id: 'academic-rule-v1', params_hash: 'hash', parameters: { weight: '0.2' } },
    notice: 'Sintético',
  };
}

function jobFixture(zone = '05101', id = 'job-1'): Job {
  return { id, zone_id: zone, state: 'queued' };
}

function snapshot() {
  return {
    ready: true,
    reason: '',
    checked_at: '2024-01-01T00:00:00Z',
    dependencies: {
      database: { state: 'ready' },
      broker: { state: 'ready' },
      dead_letter: { state: 'ready', max_age_seconds: 30, depth: 0 },
    },
  };
}

function sourceBody(): Record<string, unknown> {
  return {
    geography: {
      provenance: {
        provider: 'SUBDERE',
        attribution: 'Atribución literal',
        restriction: 'Restricción literal',
        record_count: 38,
        derived_sha256: 'c'.repeat(64),
      },
      source_cutoff_at: null,
      cutoff_semantics: 'retrieval_substitution: stored cutoff equals retrieved',
      integrity: { algorithm: 'sha256', recorded_sha256: 'c'.repeat(64), computed_sha256: 'c'.repeat(64), matches: true },
    },
    risk_input: { id: 'academic', display_name: 'Perfil académico', synthetic: true },
  };
}

function prepare() {
  const fetchStub = createFetchStub();
  const storageStub = createStorageStub();
  const windowStub = createWindowStub();
  vi.stubGlobal('fetch', fetchStub.fetch);
  vi.stubGlobal('sessionStorage', storageStub.storage);
  vi.stubGlobal('crypto', createCryptoStub());
  vi.stubGlobal('window', windowStub.window);
  return { fetchStub, storageStub, windowStub };
}

async function connectedSession(): Promise<ReturnType<typeof prepare> & { token: string }> {
  const context = prepare();
  const token = jwt({ realm_access: { roles: ['viewer'] } });
  context.storageStub.storage.setItem(pkceTransactionKey, JSON.stringify({ state: 's', verifier: 'v' }));
  const login = completeLogin('?code=code-1&state=s');
  await flush();
  context.fetchStub.answer(TOKEN_URL, { access_token: token });
  await login;
  context.fetchStub.calls.length = 0;
  return { ...context, token };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('every gateway read is absolute on the gateway origin with the bearer, omit credentials and no-store', async () => {
  const { fetchStub, token } = await connectedSession();
  const readyRead = ready();
  const zonesRead = zones();
  const latestRead = latest('05101');
  const historyRead = history('05101');
  const batchesRead = batches();
  const sourcesRead = sources();
  const riskRead = riskStatus();
  const jobsRead = jobsStatus();
  const scenariosRead = scenarios();
  const auditRead = audit();
  const jobRead = job('job-1');
  const createRead = createJob({ zoneId: '05101', idempotencyKey: 'key-1' });
  await flush();

  const expected = [
    '/health/ready',
    '/v1/risk/zones',
    '/v1/risk/latest?zone_id=05101',
    '/v1/risk/history?zone_id=05101',
    '/v1/risk/batches',
    '/v1/risk/sources',
    '/v1/risk/status',
    '/v1/jobs/status',
    '/v1/risk/synthetic-scenarios',
    '/v1/audit',
    '/v1/jobs/job-1',
    '/v1/jobs',
  ];
  for (const path of expected) {
    expect(fetchStub.calls.map((call) => call.url)).toContain(`${gatewayOrigin}${path}`);
  }
  for (const call of fetchStub.calls) {
    expect(call.init.credentials).toBe('omit');
    expect(call.init.cache).toBe('no-store');
  }
  const readyCall = fetchStub.callsFor(`${gatewayOrigin}/health/ready`)[0];
  expect(readyCall.init.headers).not.toHaveProperty('Authorization');
  const zonesCall = fetchStub.callsFor(`${gatewayOrigin}/v1/risk/zones`)[0];
  expect((zonesCall.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);

  fetchStub.answer(`${gatewayOrigin}/health/ready`, null, 204);
  fetchStub.answer(`${gatewayOrigin}/v1/risk/zones`, { type: 'FeatureCollection', features: [] });
  fetchStub.answer(`${gatewayOrigin}/v1/risk/latest?zone_id=05101`, batch());
  fetchStub.answer(`${gatewayOrigin}/v1/risk/history?zone_id=05101`, []);
  fetchStub.answer(`${gatewayOrigin}/v1/risk/batches`, { batches: [] });
  fetchStub.answer(`${gatewayOrigin}/v1/risk/sources`, sourceBody());
  fetchStub.answer(`${gatewayOrigin}/v1/risk/status`, snapshot());
  fetchStub.answer(`${gatewayOrigin}/v1/jobs/status`, snapshot());
  fetchStub.answer(`${gatewayOrigin}/v1/risk/synthetic-scenarios`, []);
  fetchStub.answer(`${gatewayOrigin}/v1/audit`, []);
  fetchStub.answer(`${gatewayOrigin}/v1/jobs/job-1`, jobFixture());
  fetchStub.answer(`${gatewayOrigin}/v1/jobs`, jobFixture());
  await Promise.all([
    readyRead,
    zonesRead,
    latestRead,
    historyRead,
    batchesRead,
    sourcesRead,
    riskRead,
    jobsRead,
    scenariosRead,
    auditRead,
    jobRead,
    createRead,
  ]);
});

test('ready accepts only a 2xx gateway answer and never claims the pipeline', async () => {
  const { fetchStub } = await connectedSession();
  const available = ready();
  await flush();
  fetchStub.answer(`${gatewayOrigin}/health/ready`, null, 204);
  expect(await available).toEqual({ ok: true, data: null });

  const unavailable = ready();
  await flush();
  fetchStub.answer(`${gatewayOrigin}/health/ready`, { code: 'down' }, 503, 'req-down');
  const failure = expectFailure(await unavailable);
  expect(failure.kind).toBe('unavailable');
  expect(failure.reason).toBe('down');
  expect(failure.status).toBe(503);
  expect(failure.requestId).toBe('req-down');
});

test('latest reports an absent published batch for a 404 and never a low level', async () => {
  const { fetchStub } = await connectedSession();
  const outcome = latest('05101');
  await flush();
  fetchStub.answer(`${gatewayOrigin}/v1/risk/latest?zone_id=05101`, { code: 'not_found' }, 404);
  expect(await outcome).toEqual({ ok: true, data: null });
});

test('job reports a missing job distinctly from an absent batch', async () => {
  const { fetchStub } = await connectedSession();
  const outcome = job('job-1');
  await flush();
  fetchStub.answer(`${gatewayOrigin}/v1/jobs/job-1`, { code: 'not_found' }, 404);
  const failure = expectFailure(await outcome);
  expect(failure.kind).toBe('missing');
  expect(failure.status).toBe(404);
});

test('a shape that fails its guard is malformed and never a partial value', async () => {
  const { fetchStub } = await connectedSession();

  const zonesRead = zones();
  await flush();
  fetchStub.answer(`${gatewayOrigin}/v1/risk/zones`, { type: 'FeatureCollection', features: 'not-an-array' });
  expect(expectFailure(await zonesRead).kind).toBe('malformed');

  const latestRead = latest('05101');
  await flush();
  const broken = batch();
  delete (broken as { policy?: unknown }).policy;
  fetchStub.answer(`${gatewayOrigin}/v1/risk/latest?zone_id=05101`, broken);
  expect(expectFailure(await latestRead).kind).toBe('malformed');

  const historyRead = history('05101');
  await flush();
  fetchStub.answer(`${gatewayOrigin}/v1/risk/history?zone_id=05101`, [batch(), { zone_id: '05101' }]);
  expect(expectFailure(await historyRead).kind).toBe('malformed');

  const auditRead = audit();
  await flush();
  fetchStub.answer(`${gatewayOrigin}/v1/audit`, [{ occurred_at: '2024-01-01T00:00:00Z' }]);
  expect(expectFailure(await auditRead).kind).toBe('malformed');

  const scenariosRead = scenarios();
  await flush();
  fetchStub.answer(`${gatewayOrigin}/v1/risk/synthetic-scenarios`, { not: 'an array' });
  expect(expectFailure(await scenariosRead).kind).toBe('malformed');

  const statusRead = riskStatus();
  await flush();
  fetchStub.answer(`${gatewayOrigin}/v1/risk/status`, { checked_at: '2024-01-01T00:00:00Z', ready: true });
  expect(expectFailure(await statusRead).kind).toBe('malformed');
});

test.each([
  ['missing', undefined],
  ['malformed', {}],
])('latest and history retain a batch with %s notice for the mandatory warning', async (_label, notice) => {
  const { fetchStub } = await connectedSession();
  const incoming = { ...batch(), notice };
  const latestRead = latest('05101');
  await flush();
  fetchStub.answer(`${gatewayOrigin}/v1/risk/latest?zone_id=05101`, incoming);
  expect(await latestRead).toEqual({ ok: true, data: incoming });

  const historyRead = history('05101');
  await flush();
  fetchStub.answer(`${gatewayOrigin}/v1/risk/history?zone_id=05101`, [incoming]);
  expect(await historyRead).toEqual({ ok: true, data: [incoming] });
});

test('malformed JSON is reported as malformed, never as a value', async () => {
  const { fetchStub } = await connectedSession();
  const outcome = zones();
  await flush();
  fetchStub.answerMalformedJson(`${gatewayOrigin}/v1/risk/zones`);
  const failure = expectFailure(await outcome);
  expect(failure.kind).toBe('malformed');
  expect(failure.reason).toBe('malformed_json');
});

test('a batch from another zone is discarded as malformed, never rendered', async () => {
  const { fetchStub } = await connectedSession();

  const latestRead = latest('05101');
  await flush();
  fetchStub.answer(`${gatewayOrigin}/v1/risk/latest?zone_id=05101`, batch('05102'));
  const latestFailure = expectFailure(await latestRead);
  expect(latestFailure.kind).toBe('malformed');
  expect(latestFailure.reason).toBe('zone_mismatch');

  const historyRead = history('05101');
  await flush();
  fetchStub.answer(`${gatewayOrigin}/v1/risk/history?zone_id=05101`, [batch('05101'), batch('05102')]);
  const historyFailure = expectFailure(await historyRead);
  expect(historyFailure.kind).toBe('malformed');
  expect(historyFailure.reason).toBe('zone_mismatch');
});

test('401 resets the session and reports unauthorized', async () => {
  const { fetchStub } = await connectedSession();
  const outcome = zones();
  await flush();
  fetchStub.answer(`${gatewayOrigin}/v1/risk/zones`, { code: 'unauthorized' }, 401, 'req-401');
  const failure = expectFailure(await outcome);
  expect(failure).toEqual({ kind: 'unauthorized', reason: 'unauthorized', status: 401, requestId: 'req-401' });
  expect(getSessionSnapshot()).toEqual({ status: 'signed-out', roles: null, reason: 'rejected' });
  expect(getAccessToken()).toBe('');
});

test('a 401 on a request that carried no token lowers the session without a reason', async () => {
  const { fetchStub } = prepare();
  const outcome = ready();
  await flush();
  fetchStub.answer(`${gatewayOrigin}/health/ready`, { code: 'unauthorized' }, 401);
  const failure = expectFailure(await outcome);
  expect(failure.kind).toBe('unauthorized');
  // No bearer travelled, so the server did not reject a token: the first-visit
  // copy is the honest one and the reason stays `null`.
  expect(getSessionSnapshot()).toEqual({ status: 'signed-out', roles: null, reason: null });
});

test('403 is a permission denial, never unavailable, and keeps the session', async () => {
  const { fetchStub } = await connectedSession();
  const outcome = riskStatus();
  await flush();
  fetchStub.answer(`${gatewayOrigin}/v1/risk/status`, { code: 'forbidden' }, 403);
  const failure = expectFailure(await outcome);
  expect(failure.kind).toBe('forbidden');
  expect(failure.status).toBe(403);
  expect(getSessionSnapshot().status).toBe('signed-in');
  expect(getAccessToken()).not.toBe('');
});

test('a superseded response for the same route is discarded instead of rendered', async () => {
  const { fetchStub } = await connectedSession();
  const first = latest('05101');
  const second = latest('05102');
  await flush();

  fetchStub.answer(`${gatewayOrigin}/v1/risk/latest?zone_id=05102`, batch('05102', 'new'));
  expect(await second).toEqual({ ok: true, data: batch('05102', 'new') });

  fetchStub.answer(`${gatewayOrigin}/v1/risk/latest?zone_id=05101`, batch('05101', 'old'));
  const failure = expectFailure(await first);
  expect(failure.kind).toBe('unavailable');
  expect(failure.reason).toBe('superseded');
});

test('a superseded unauthorized response cannot reset the current session', async () => {
  const { fetchStub } = await connectedSession();
  const first = latest('05101');
  const second = latest('05102');
  await flush();

  fetchStub.answer(`${gatewayOrigin}/v1/risk/latest?zone_id=05101`, { code: 'unauthorized' }, 401);
  const failure = expectFailure(await first);
  expect(failure.reason).toBe('superseded');
  expect(getSessionSnapshot().status).toBe('signed-in');
  expect(getAccessToken()).not.toBe('');

  fetchStub.answer(`${gatewayOrigin}/v1/risk/latest?zone_id=05102`, batch('05102'));
  expect((await second).ok).toBe(true);
});

test('a response that lands after the view was reset is discarded', async () => {
  const { fetchStub } = await connectedSession();
  const callCountBefore = fetchStub.calls.length;
  const pendingRead = latest('05101');
  await flush();

  resetSession();
  fetchStub.answer(`${gatewayOrigin}/v1/risk/latest?zone_id=05101`, batch('05101'));

  const failure = expectFailure(await pendingRead);
  expect(failure.reason).toBe('superseded');
  expect(fetchStub.calls.length).toBe(callCountBefore + 1);
});

test('a hung read is bounded by the deadline and reports it', async () => {
  const { fetchStub } = await connectedSession();
  vi.useFakeTimers();
  const outcome = latest('05101');
  await flush();
  await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS);
  const failure = expectFailure(await outcome);
  expect(failure.kind).toBe('unavailable');
  expect(failure.reason).toBe('deadline');
  expect(fetchStub.calls).toHaveLength(1);
});

test('an aborted read reports the abort and resolves no data', async () => {
  const { fetchStub } = await connectedSession();
  const controller = new AbortController();
  const outcome = zones(controller.signal);
  await flush();
  expect(fetchStub.calls).toHaveLength(1);
  controller.abort();
  const failure = expectFailure(await outcome);
  expect(failure.kind).toBe('unavailable');
  expect(failure.reason).toBe('aborted');
});

test('createJob posts only the chosen fields with the idempotency header', async () => {
  const { fetchStub } = await connectedSession();

  const legacy = createJob({ zoneId: '05101', idempotencyKey: 'key-1' });
  await flush();
  const legacyCall = fetchStub.callsFor(`${gatewayOrigin}/v1/jobs`)[0];
  expect(legacyCall.init.method).toBe('POST');
  expect(legacyCall.init.headers).toMatchObject({ 'Content-Type': 'application/json', 'Idempotency-Key': 'key-1' });
  expect(JSON.parse(legacyCall.init.body as string)).toEqual({ zone_id: '05101' });
  fetchStub.answer(`${gatewayOrigin}/v1/jobs`, jobFixture());
  expect((await legacy).ok).toBe(true);

  const selected = createJob({ zoneId: '05101', scenarioId: 'dry-windy', idempotencyKey: 'key-2' });
  await flush();
  const selectedCall = fetchStub.callsFor(`${gatewayOrigin}/v1/jobs`)[1];
  expect(selectedCall.init.headers).toMatchObject({ 'Idempotency-Key': 'key-2' });
  expect(JSON.parse(selectedCall.init.body as string)).toEqual({ zone_id: '05101', scenario_id: 'dry-windy' });
  fetchStub.answer(`${gatewayOrigin}/v1/jobs`, jobFixture());
  expect((await selected).ok).toBe(true);

  const empty = createJob({ zoneId: '05101', scenarioId: '', idempotencyKey: 'key-3' });
  await flush();
  const emptyCall = fetchStub.callsFor(`${gatewayOrigin}/v1/jobs`)[2];
  expect(Object.hasOwn(JSON.parse(emptyCall.init.body as string), 'scenario_id')).toBe(false);
  fetchStub.answer(`${gatewayOrigin}/v1/jobs`, jobFixture());
  await empty;
});

test('a queued job whose batch_id is null is an acceptance, not a malformed answer', async () => {
  const { fetchStub } = await connectedSession();

  // The exact body `POST /v1/jobs` serves with its 202: `batch_id` is a nullable
  // column serialized without `omitempty`, so a queued job answers `null` rather
  // than omitting the field. The boundary guard used to reject it as
  // `invalid_shape` with status 202, and the view then reported the acceptance as
  // `No se pudo solicitar el trabajo (HTTP 202).` (issue #96).
  const accepted = createJob({ zoneId: '05101', idempotencyKey: 'key-null' });
  await flush();
  fetchStub.answer(
    `${gatewayOrigin}/v1/jobs`,
    { ...jobFixture(), batch_id: null, requested_at: '2026-01-01T00:00:00Z', attempts: 0 },
    202,
  );
  const outcome = await accepted;
  if (!outcome.ok) throw new Error(`expected an accepted job, got ${outcome.failure.reason}`);
  expect(outcome.data.state).toBe('queued');
  expect(outcome.data.batch_id).toBeNull();

  // `null` and `undefined` are the two honest spellings of "no batch yet"; a value
  // that is neither a string nor null is still a contract violation.
  const wrong = createJob({ zoneId: '05101', idempotencyKey: 'key-wrong' });
  await flush();
  fetchStub.answer(`${gatewayOrigin}/v1/jobs`, { ...jobFixture(), batch_id: 7 }, 202);
  expect(expectFailure(await wrong).reason).toBe('invalid_shape');
});

test('sources passes the served provenance through and the domain decides its integrity', async () => {
  const { fetchStub } = await connectedSession();

  const okRead = sources();
  await flush();
  fetchStub.answer(`${gatewayOrigin}/v1/risk/sources`, sourceBody());
  const okResult = await okRead;
  if (!okResult.ok) throw new Error('expected a usable provenance');
  const provenance: SourceProvenance = okResult.data;
  expect(provenance.geography.provenance.provider).toBe('SUBDERE');
  expect(provenance.geography.provenance.attribution).toBe('Atribución literal');
  expect(provenance.geography.provenance.restriction).toBe('Restricción literal');
  expect(provenance.geography.provenance.record_count).toBe(38);
  expect(provenance.geography.provenance.derived_sha256).toBe('c'.repeat(64));
  expect(provenance.geography.integrity.matches).toBe(true);
  expect(provenance.geography.cutoff_semantics).toContain('retrieval_substitution');

  // An integrity mismatch is a domain decision, not a transport failure: the
  // payload travels unchanged so the panel can fail closed on it.
  const mismatchBody = sourceBody();
  (mismatchBody.geography as { integrity: { matches: boolean } }).integrity.matches = false;
  const mismatchRead = sources();
  await flush();
  fetchStub.answer(`${gatewayOrigin}/v1/risk/sources`, mismatchBody);
  const mismatchResult = await mismatchRead;
  if (!mismatchResult.ok) throw new Error('the transport must not decide integrity');
  expect(mismatchResult.data.geography.integrity.matches).toBe(false);

  const malformedRead = sources();
  await flush();
  fetchStub.answer(`${gatewayOrigin}/v1/risk/sources`, { geography: {} });
  expect(expectFailure(await malformedRead).kind).toBe('malformed');
});

test('scenarios publishes only usable catalogue entries', () => {
  expect(parseScenarios('not-an-array')).toEqual([]);
  expect(parseScenarios([{ id: 'mild', description: 'Perfil suave' }, { id: '' }, { description: 'sin id' }, null, 42])).toEqual([
    { id: 'mild', description: 'Perfil suave' },
  ]);
  expect(parseScenarios([{ id: 'no-description' }])).toEqual([{ id: 'no-description', description: '' }]);
});

// ── The aggregate risk read (T2/S4) ────────────────────────────────────────
//
// `/v1/risk/batches` answers the newest published batch of every zone inside an
// envelope, with no geometry. The transport proves that envelope and fails
// closed, exactly like every other read: a collection is either usable as a
// whole or it is not a collection the page may paint from.

test('batches reads the aggregate envelope and keeps the bearer discipline of every other read', async () => {
  const { fetchStub, token } = await connectedSession();
  const outcome = batches();
  await flush();

  const call = fetchStub.callsFor(`${gatewayOrigin}/v1/risk/batches`)[0];
  expect(call.init.credentials).toBe('omit');
  expect(call.init.cache).toBe('no-store');
  expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);

  // An element carries the per-zone members MINUS the batch geometry, which the
  // aggregate route deliberately does not serve.
  const first = batch('05101');
  const second = batch('05102', 'batch-2', 'job-2');
  fetchStub.answer(`${gatewayOrigin}/v1/risk/batches`, { batches: [first, second] });
  expect(await outcome).toEqual({ ok: true, data: [first, second] });
});

test('an empty aggregate answer is a real empty collection, never a failure', async () => {
  const { fetchStub } = await connectedSession();
  const outcome = batches();
  await flush();
  fetchStub.answer(`${gatewayOrigin}/v1/risk/batches`, { batches: [] });
  expect(await outcome).toEqual({ ok: true, data: [] });
});

test('the aggregate answer fails closed on anything but the served envelope', async () => {
  const { fetchStub } = await connectedSession();

  // `/history` serves a bare array; this route serves an envelope, and a bare
  // array here is a contract change rather than a tolerated alternative.
  const bareArray = batches();
  await flush();
  fetchStub.answer(`${gatewayOrigin}/v1/risk/batches`, [batch()]);
  expect(expectFailure(await bareArray).kind).toBe('malformed');

  const missingKey = batches();
  await flush();
  fetchStub.answer(`${gatewayOrigin}/v1/risk/batches`, { items: [] });
  expect(expectFailure(await missingKey).kind).toBe('malformed');

  // One unusable element rejects the whole answer: painting the others would
  // publish a collection the service did not actually serve.
  const brokenElement = batch('05102', 'batch-2', 'job-2');
  delete (brokenElement as { policy?: unknown }).policy;
  const badElement = batches();
  await flush();
  fetchStub.answer(`${gatewayOrigin}/v1/risk/batches`, { batches: [batch(), brokenElement] });
  const elementFailure = expectFailure(await badElement);
  expect(elementFailure.kind).toBe('malformed');
  expect(elementFailure.reason).toBe('invalid_shape');

  const malformedJson = batches();
  await flush();
  fetchStub.answerMalformedJson(`${gatewayOrigin}/v1/risk/batches`);
  expect(expectFailure(await malformedJson).reason).toBe('malformed_json');
});

test('the aggregate read maps 403, 503 and 401 to their own outcomes', async () => {
  const { fetchStub } = await connectedSession();

  const denied = batches();
  await flush();
  fetchStub.answer(`${gatewayOrigin}/v1/risk/batches`, { code: 'forbidden' }, 403, 'req-403');
  expect(expectFailure(await denied)).toEqual({ kind: 'forbidden', reason: 'forbidden', status: 403, requestId: 'req-403' });
  expect(getSessionSnapshot().status).toBe('signed-in');

  const unavailable = batches();
  await flush();
  fetchStub.answer(`${gatewayOrigin}/v1/risk/batches`, { code: 'storage_unavailable' }, 503, 'req-503');
  expect(expectFailure(await unavailable)).toEqual({
    kind: 'unavailable',
    reason: 'storage_unavailable',
    status: 503,
    requestId: 'req-503',
  });
  expect(getSessionSnapshot().status).toBe('signed-in');

  const rejected = batches();
  await flush();
  fetchStub.answer(`${gatewayOrigin}/v1/risk/batches`, { code: 'unauthorized' }, 401, 'req-401');
  expect(expectFailure(await rejected)).toEqual({
    kind: 'unauthorized',
    reason: 'unauthorized',
    status: 401,
    requestId: 'req-401',
  });
  expect(getSessionSnapshot()).toEqual({ status: 'signed-out', roles: null, reason: 'rejected' });
});

// --- PM-17: the explanatory assistant ---------------------------------------
//
// The route composes the answer locally from the published batch, so the transport
// owns the four properties the page relies on: a closed request document, the two
// guardrail statuses, the declared synthetic provenance, and the five canonical
// variables cited with a value if and only if they were measured.

const EXPLAIN_URL = `${gatewayOrigin}/v1/risk/explain`;

function explainBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    batch_id: 'batch-1',
    zone_id: '05101',
    zone_name: 'Valparaíso',
    topic: 'FACTORES',
    risk_level: 'alto',
    model_version: 'academic-rule-v1',
    synthetic: true,
    answer: 'Lote batch-1 de la comuna Valparaíso (05101). Nivel registrado: alto.',
    factors: [
      { name: 'temperatura', known: true, value: 32.5, contribution: 0.4 },
      { name: 'humedad_relativa', known: false },
      { name: 'viento', known: false },
      { name: 'cobertura_vegetal', known: false },
      { name: 'incendios_historicos', known: false },
    ],
    guardrails: { input: 'GRD-I1:PASS', output: 'GRD-I2:PASS' },
    notice: 'Procedencia sintética: datos sintéticos.',
    ...overrides,
  };
}

// One canonical citation with a measured variable and four the batch did not read.
function explainFactors(overrides: Record<string, unknown> = {}): Record<string, unknown>[] {
  return [
    { name: 'temperatura', known: true, value: 32.5, contribution: 0.4, ...overrides },
    { name: 'humedad_relativa', known: false },
    { name: 'viento', known: false },
    { name: 'cobertura_vegetal', known: false },
    { name: 'incendios_historicos', known: false },
  ];
}

test('the explain read posts one closed document with the bearer and omits an empty question (PM-17)', async () => {
  const { fetchStub, token } = await connectedSession();

  const outcome = explainRisk({ zoneId: ' 05101 ', topic: 'FACTORES', question: '   ' });
  await flush();
  const calls = fetchStub.callsFor(EXPLAIN_URL);
  expect(calls).toHaveLength(1);
  expect((calls[0].init.method ?? 'GET').toUpperCase()).toBe('POST');
  expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
  expect((calls[0].init as { cache?: string }).cache).toBe('no-store');
  // The zone is trimmed once, and the blank question is OMITTED rather than sent:
  // the service refuses a present but blank question with GRD-I1, and sending one
  // would invite a refusal the operator never asked for.
  expect(JSON.parse(String(calls[0].init.body))).toEqual({ zone_id: '05101', topic: 'FACTORES' });

  fetchStub.answer(EXPLAIN_URL, explainBody());
  const settled = await outcome;
  expect(settled.ok).toBe(true);
  if (settled.ok) expect(settled.data.guardrails).toEqual({ input: 'GRD-I1:PASS', output: 'GRD-I2:PASS' });
});

test('the explain request refuses locally what the contract would refuse, before the fetch', async () => {
  const { fetchStub } = await connectedSession();

  expect(expectFailure(await explainRisk({ zoneId: '   ', topic: 'FACTORES' })).reason).toBe('invalid_explain');
  // A topic outside the closed vocabulary cannot be produced by the typed UI, so the
  // guard is exercised through a cast: a served spelling is never trusted anyway.
  expect(expectFailure(await explainRisk({ zoneId: '05101', topic: 'CAUSAS' as never })).reason).toBe('invalid_explain');
  expect(
    expectFailure(await explainRisk({ zoneId: '05101', topic: 'FACTORES', question: 'a'.repeat(EXPLAIN_QUESTION_LIMIT + 1) }))
      .reason,
  ).toBe('invalid_explain');
  expect(fetchStub.callsFor(EXPLAIN_URL)).toHaveLength(0);

  // The bound is inclusive and counted in characters, so a Spanish question is not
  // refused for the width of its accents.
  const atBound = explainRisk({ zoneId: '05101', topic: 'FUENTES', question: 'á'.repeat(EXPLAIN_QUESTION_LIMIT) });
  await flush();
  expect(fetchStub.callsFor(EXPLAIN_URL)).toHaveLength(1);
  fetchStub.answer(EXPLAIN_URL, explainBody({ topic: 'FUENTES' }));
  expect((await atBound).ok).toBe(true);
});

test('the explain answer fails closed unless both guardrails passed and the provenance is declared (PM-17)', async () => {
  const { fetchStub } = await connectedSession();

  const arms: { name: string; body: Record<string, unknown> }[] = [
    { name: 'an input guardrail that did not pass', body: explainBody({ guardrails: { input: 'GRD-I1:FAIL', output: 'GRD-I2:PASS' } }) },
    { name: 'an output guardrail that did not pass', body: explainBody({ guardrails: { input: 'GRD-I1:PASS', output: '' } }) },
    { name: 'missing guardrails', body: explainBody({ guardrails: undefined }) },
    { name: 'an undeclared synthetic mark', body: explainBody({ synthetic: false }) },
    { name: 'a synthetic mark served as a string', body: explainBody({ synthetic: 'true' }) },
    { name: 'a topic outside the enum', body: explainBody({ topic: 'CAUSAS' }) },
    { name: 'a level outside the vocabulary', body: explainBody({ risk_level: 'extremo' }) },
    { name: 'an empty batch id', body: explainBody({ batch_id: '' }) },
    { name: 'an empty answer', body: explainBody({ answer: '   ' }) },
    { name: 'an empty notice', body: explainBody({ notice: '' }) },
    { name: 'four cited variables', body: explainBody({ factors: explainFactors().slice(0, 4) }) },
    {
      name: 'an unmeasured variable carrying a value',
      body: explainBody({
        factors: [explainFactors()[0], { name: 'humedad_relativa', known: false, value: 12 }, ...explainFactors().slice(2)],
      }),
    },
    {
      name: 'a citation outside the canonical order',
      body: explainBody({ factors: [explainFactors()[1], explainFactors()[0], ...explainFactors().slice(2)] }),
    },
    {
      name: 'a measured variable without a contribution',
      body: explainBody({ factors: [{ name: 'temperatura', known: true, value: 32.5 }, ...explainFactors().slice(1)] }),
    },
    {
      name: 'an unmeasured variable with a contribution',
      body: explainBody({
        factors: [{ ...explainFactors()[0] }, { name: 'humedad_relativa', known: false, contribution: 0.1 }, ...explainFactors().slice(2)],
      }),
    },
  ];

  for (const arm of arms) {
    const outcome = explainRisk({ zoneId: '05101', topic: 'FACTORES' });
    await flush();
    fetchStub.answer(EXPLAIN_URL, arm.body);
    // `expectFailure` throws when the arm was accepted, so a regression names itself.
    expect(expectFailure(await outcome).reason, arm.name).toBe('invalid_shape');
  }
});

test('the explain answer is discarded when it echoes another zone, topic or batch (PM-17)', async () => {
  const { fetchStub } = await connectedSession();

  const otherZone = explainRisk({ zoneId: '05101', topic: 'FACTORES' });
  await flush();
  fetchStub.answer(EXPLAIN_URL, explainBody({ zone_id: '05109' }));
  expect(expectFailure(await otherZone).reason).toBe('zone_mismatch');

  const otherTopic = explainRisk({ zoneId: '05101', topic: 'PRIORIDAD' });
  await flush();
  fetchStub.answer(EXPLAIN_URL, explainBody({ topic: 'FUENTES' }));
  expect(expectFailure(await otherTopic).reason).toBe('topic_mismatch');

  const otherBatch = explainRisk({ zoneId: '05101', topic: 'FACTORES', batchId: 'batch-1' });
  await flush();
  fetchStub.answer(EXPLAIN_URL, explainBody({ batch_id: 'batch-2' }));
  expect(expectFailure(await otherBatch).reason).toBe('batch_mismatch');

  // The matching case is accepted, so the three refusals above are about the echo
  // and not about a guard that refuses every answer.
  const matching = explainRisk({ zoneId: '05101', topic: 'FACTORES', batchId: 'batch-1' });
  await flush();
  fetchStub.answer(EXPLAIN_URL, explainBody());
  expect((await matching).ok).toBe(true);
});

test('the explain read surfaces each guardrail code as its own failure (PM-17)', async () => {
  const { fetchStub } = await connectedSession();

  const rejected = explainRisk({ zoneId: '05101', topic: 'FACTORES' });
  await flush();
  fetchStub.answer(EXPLAIN_URL, { code: 'GUARDRAIL_INPUT_REJECTED' }, 422, 'req-422');
  expect(expectFailure(await rejected)).toEqual({
    kind: 'unavailable',
    reason: 'GUARDRAIL_INPUT_REJECTED',
    status: 422,
    requestId: 'req-422',
  });

  const noBatch = explainRisk({ zoneId: '05101', topic: 'FUENTES' });
  await flush();
  fetchStub.answer(EXPLAIN_URL, { code: 'no_published_batch', data_status: 'insufficient' }, 404, 'req-404');
  expect(expectFailure(await noBatch)).toEqual({
    kind: 'missing',
    reason: 'no_published_batch',
    status: 404,
    requestId: 'req-404',
  });

  const blocked = explainRisk({ zoneId: '05101', topic: 'TENDENCIA' });
  await flush();
  fetchStub.answer(EXPLAIN_URL, { code: 'GUARDRAIL_OUTPUT_BLOCKED' }, 503, 'req-503');
  expect(expectFailure(await blocked).reason).toBe('GUARDRAIL_OUTPUT_BLOCKED');
});
