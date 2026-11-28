import { gatewayOrigin, issuer, pkceTransactionKey } from '../../src/config';
import {
  audit,
  batches,
  createJob,
  cycleRun,
  history,
  job,
  jobsStatus,
  latest,
  ready,
  reviewSource,
  riskStatus,
  scenarios,
  sources,
  zones,
  parseScenarios,
} from '../../src/core/api';
import type { Failure, Outcome } from '../../src/core/api';
import { priorityView } from '../../src/domain/priority';
import { completeLogin, getAccessToken, getSessionSnapshot, resetSession } from '../../src/core/session';
import type { Job, RiskBatch, SourceProvenance, ZonePriority } from '../../src/types/api';

import { createCryptoStub, createFetchStub, createStorageStub, createWindowStub, flush, jwt } from './harness';
import { qualityCatalogFixture, sourceEntryFixture, sourceReviewFixture } from '../support/source-quality';

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
    quality_catalog: qualityCatalogFixture(),
    sources: [sourceEntryFixture()],
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

// V1-P-06 — the manual publication. `POST /v1/risk/cycle/run` declares no body at
// all: the operator is the verified token subject, so a body that names one is
// refused with 400 before anything runs. The transport therefore sends none, and
// keeps 401, 403 and 503 as three different outcomes instead of flattening a
// refusal into "the service is down".
test('cycleRun posts no body and reads the cycle result the service answers', async () => {
  const { fetchStub } = await connectedSession();

  const run = cycleRun();
  await flush();
  const calls = fetchStub.callsFor(`${gatewayOrigin}/v1/risk/cycle/run`);
  expect(calls).toHaveLength(1);
  expect(calls[0].init.method).toBe('POST');
  expect(calls[0].init.body).toBeUndefined();
  expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBeUndefined();

  fetchStub.answer(`${gatewayOrigin}/v1/risk/cycle/run`, {
    source_id: 'fixture-sample',
    started_at: '2026-11-27T10:00:00Z',
    finished_at: '2026-11-27T10:00:01Z',
    complete: true,
    zones: [{ zone_id: '05101', published: true }],
  });
  const outcome = await run;
  if (!outcome.ok) throw new Error(`expected a cycle result, got ${outcome.failure.reason}`);
  expect(outcome.data.complete).toBe(true);
  expect(outcome.data.zones).toEqual([{ zone_id: '05101', published: true }]);
});

test('cycleRun fails closed on an unusable result instead of reporting a publication', async () => {
  const { fetchStub } = await connectedSession();

  for (const body of [
    {},
    { complete: true },
    { complete: 'true', zones: [] },
    { complete: true, zones: [{ published: true }] },
    { complete: true, zones: [{ zone_id: '05101', published: 'yes' }] },
    [],
  ]) {
    const run = cycleRun();
    await flush();
    fetchStub.answer(`${gatewayOrigin}/v1/risk/cycle/run`, body);
    const failure = expectFailure(await run);
    expect(failure.kind, JSON.stringify(body)).toBe('malformed');
    expect(failure.reason, JSON.stringify(body)).toBe('invalid_shape');
  }
});

test('cycleRun refuses a result whose completeness contradicts its zones', async () => {
  const { fetchStub } = await connectedSession();

  // `cycle.Runner` starts RunResult.Complete at true and sets it to false exactly
  // when a zone fails, so the Go invariant is a biconditional: complete is true IF
  // AND ONLY IF every zone published and carries no error. A payload that states
  // otherwise contradicts itself, and the page must not claim a publication from
  // it — a "complete" cycle with a failed zone and an "incomplete" cycle with no
  // failure are both unusable.
  const envelope = { source_id: 'fixture-sample', started_at: '2026-11-27T10:00:00Z', finished_at: '2026-11-27T10:00:01Z' };
  for (const body of [
    // complete = true with a zone that did not publish.
    { ...envelope, complete: true, zones: [{ zone_id: '05101', published: false }] },
    { ...envelope, complete: true, zones: [{ zone_id: '05101', published: false, error: 'validation_failed' }] },
    // a published zone that nevertheless reports an error is a failed zone too.
    { ...envelope, complete: true, zones: [{ zone_id: '05101', published: true, error: 'late_error' }] },
    { ...envelope, complete: true, zones: [{ zone_id: '05101', published: true }, { zone_id: '05102', published: false }] },
    // complete = false with every zone published, including no zone at all.
    { ...envelope, complete: false, zones: [{ zone_id: '05101', published: true }] },
    { ...envelope, complete: false, zones: [] },
  ]) {
    const run = cycleRun();
    await flush();
    fetchStub.answer(`${gatewayOrigin}/v1/risk/cycle/run`, body);
    const failure = expectFailure(await run);
    expect(failure.kind, JSON.stringify(body)).toBe('malformed');
    expect(failure.reason, JSON.stringify(body)).toBe('invalid_shape');
  }
});

test('cycleRun accepts the two combinations the Go invariant allows', async () => {
  const { fetchStub } = await connectedSession();
  const envelope = { source_id: 'fixture-sample', started_at: '2026-11-27T10:00:00Z', finished_at: '2026-11-27T10:00:01Z' };

  // complete = true and nothing failed, including a cycle with no configured zone.
  for (const body of [
    { ...envelope, complete: true, zones: [{ zone_id: '05101', published: true }, { zone_id: '05102', published: true }] },
    { ...envelope, complete: true, zones: [] },
    // complete = false and at least one zone failed.
    { ...envelope, complete: false, zones: [{ zone_id: '05101', published: true }, { zone_id: '05102', published: false, error: 'validation_failed' }] },
    { ...envelope, complete: false, zones: [{ zone_id: '05101', published: false }] },
  ]) {
    const run = cycleRun();
    await flush();
    fetchStub.answer(`${gatewayOrigin}/v1/risk/cycle/run`, body);
    const outcome = await run;
    if (!outcome.ok) throw new Error(`expected a concrete answer for ${JSON.stringify(body)}, got ${outcome.failure.reason}`);
    expect(outcome.data.complete, JSON.stringify(body)).toBe(body.complete);
  }
});

test('the batch provenance is a typed BatchCore member the boundary validates', async () => {
  const { fetchStub } = await connectedSession();

  // `BatchCore` declares `evaluation_trigger` (scheduler | manual) and
  // `evaluated_by`, so the shared API type carries them and the view reads a typed
  // member instead of casting a record. The wire is still not a runtime guarantee:
  // a member of the wrong type is a contract violation and fails closed.
  const read = latest('05101');
  await flush();
  fetchStub.answer(`${gatewayOrigin}/v1/risk/latest?zone_id=05101`, {
    ...batch(),
    evaluation_trigger: 'manual',
    evaluated_by: 'operator-ana',
  });
  const outcome = await read;
  if (!outcome.ok || outcome.data === null) throw new Error('expected a published batch with provenance');
  expect(outcome.data.evaluation_trigger).toBe('manual');
  expect(outcome.data.evaluated_by).toBe('operator-ana');

  // A scheduled evaluation records no actor: null and absent are both accepted.
  const scheduled = latest('05101');
  await flush();
  fetchStub.answer(`${gatewayOrigin}/v1/risk/latest?zone_id=05101`, {
    ...batch(),
    evaluation_trigger: 'scheduler',
    evaluated_by: null,
  });
  const scheduledOutcome = await scheduled;
  if (!scheduledOutcome.ok || scheduledOutcome.data === null) throw new Error('expected a scheduled batch');
  expect(scheduledOutcome.data.evaluation_trigger).toBe('scheduler');
  expect(scheduledOutcome.data.evaluated_by).toBeNull();

  for (const overrides of [
    { evaluation_trigger: 5 },
    { evaluation_trigger: true },
    { evaluated_by: 5 },
    { evaluated_by: {} },
    { evaluation_trigger: 'manual', evaluated_by: ['operator-ana'] },
  ]) {
    const malformed = latest('05101');
    await flush();
    fetchStub.answer(`${gatewayOrigin}/v1/risk/latest?zone_id=05101`, { ...batch(), ...overrides });
    const failure = expectFailure(await malformed);
    expect(failure.kind, JSON.stringify(overrides)).toBe('malformed');
    expect(failure.reason, JSON.stringify(overrides)).toBe('invalid_shape');
  }
});

test('cycleRun keeps 401, 403 and 503 as three distinct answers', async () => {
  const { fetchStub } = await connectedSession();

  const denied = cycleRun();
  await flush();
  fetchStub.answer(`${gatewayOrigin}/v1/risk/cycle/run`, { code: 'forbidden' }, 403, 'req-403');
  expect(expectFailure(await denied)).toEqual({
    kind: 'forbidden',
    reason: 'forbidden',
    status: 403,
    requestId: 'req-403',
  });
  expect(getSessionSnapshot().status).toBe('signed-in');

  const unavailable = cycleRun();
  await flush();
  fetchStub.answer(`${gatewayOrigin}/v1/risk/cycle/run`, { code: 'cycle_unavailable' }, 503, 'req-503');
  expect(expectFailure(await unavailable)).toEqual({
    kind: 'unavailable',
    reason: 'cycle_unavailable',
    status: 503,
    requestId: 'req-503',
  });
  expect(getSessionSnapshot().status).toBe('signed-in');

  const rejected = cycleRun();
  await flush();
  fetchStub.answer(`${gatewayOrigin}/v1/risk/cycle/run`, { code: 'unauthorized' }, 401, 'req-401');
  expect(expectFailure(await rejected)).toEqual({
    kind: 'unauthorized',
    reason: 'unauthorized',
    status: 401,
    requestId: 'req-401',
  });
  expect(getSessionSnapshot()).toEqual({ status: 'signed-out', roles: null, reason: 'rejected' });
});

// V1-P-02 / PM-11 — the regional priority is a served index, so its bounds are
// part of the contract the page may trust. A payload that would print an
// impossible score or a position outside the ranking it declares is malformed
// instead of being rendered as a plausible number.
function rankedPriority(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    zone_id: '05101',
    risk_level: 'alto',
    priority_status: 'ranked',
    risk_score: 96,
    exposure_score: 61,
    priority_score: 86,
    priority_rank: 1,
    total_ranked_zones: 2,
    exposed_assets_count: 5,
    dominant_category: 'hospital',
    context_summary: 'Comuna 05101: prioridad 86 de 100, puesto 1 de 2 del lote publicado.',
    ...overrides,
  };
}

test('the regional priority fails closed outside the documented bounds', async () => {
  const { fetchStub } = await connectedSession();
  const url = `${gatewayOrigin}/v1/risk/batches`;
  const invalid: Array<{ name: string; overrides: Record<string, unknown> }> = [
    { name: 'a priority above 100', overrides: { priority_score: 101 } },
    { name: 'a risk score below zero', overrides: { risk_score: -1 } },
    { name: 'a risk score above 100', overrides: { risk_score: 101 } },
    { name: 'an exposure above 100', overrides: { exposure_score: 101 } },
    { name: 'an exposure below zero', overrides: { exposure_score: -1 } },
    { name: 'a rank below one', overrides: { priority_rank: 0 } },
    { name: 'a rank beyond the ranked total', overrides: { priority_rank: 3, total_ranked_zones: 2 } },
    { name: 'a ranked entry with no ranked zones', overrides: { total_ranked_zones: 0 } },
  ];

  for (const entry of invalid) {
    const read = batches();
    await flush();
    fetchStub.answer(url, {
      batches: [{ ...batch('05101', 'batch-1', 'job-1'), priority: rankedPriority(entry.overrides) }],
    });
    expect(expectFailure(await read).kind, entry.name).toBe('malformed');
  }
});

test('a zone with no position is accepted without a score and with an empty ranking', async () => {
  const { fetchStub } = await connectedSession();
  const read = batches();
  await flush();
  fetchStub.answer(`${gatewayOrigin}/v1/risk/batches`, {
    batches: [
      {
        ...batch('05101', 'batch-1', 'job-1'),
        priority: rankedPriority({
          priority_status: 'insufficient',
          risk_score: null,
          priority_score: null,
          priority_rank: null,
          total_ranked_zones: 0,
          exposed_assets_count: 0,
          dominant_category: null,
          context_summary: 'Comuna 05101: sin puesto regional.',
        }),
      },
    ],
  });

  const outcome = await read;
  expect(outcome.ok).toBe(true);
});

// S5 — an `insufficient` priority holds no position at all. The three nullable
// members are all-or-nothing: a payload that nulls one or two of them is a partial
// position, and printing it would show a rank the service never computed.
test('an insufficient priority must null all three position members', async () => {
  const { fetchStub } = await connectedSession();
  const url = `${gatewayOrigin}/v1/risk/batches`;
  const partials: Array<{ name: string; overrides: Record<string, unknown> }> = [
    { name: 'only the risk score is null', overrides: { risk_score: null } },
    { name: 'only the rank is null', overrides: { priority_rank: null } },
    { name: 'only the priority score is null', overrides: { priority_score: null } },
    { name: 'two of the three are null', overrides: { risk_score: null, priority_rank: null } },
  ];

  for (const entry of partials) {
    const read = batches();
    await flush();
    fetchStub.answer(url, {
      batches: [
        {
          ...batch('05101', 'batch-1', 'job-1'),
          priority: rankedPriority({ priority_status: 'insufficient', ...entry.overrides }),
        },
      ],
    });
    expect(expectFailure(await read).kind, entry.name).toBe('malformed');
  }
});

// S4/S5 — the contract allows an unknown variable to omit its numbers, and valid
// insufficient evidence must stay readable: five unknown factors with no value and
// no contribution, a `desconocido` level and a position-less priority.
test('an incomplete batch with unknown factors and an empty position is readable', async () => {
  const { fetchStub } = await connectedSession();
  const url = `${gatewayOrigin}/v1/risk/batches`;
  const unknownOnly = [
    { name: 'temperatura', known: false },
    { name: 'humedad_relativa', known: false },
    { name: 'viento', known: false },
    { name: 'cobertura_vegetal', known: false },
    { name: 'incendios_historicos', known: false },
  ];
  const read = batches();
  await flush();
  fetchStub.answer(url, {
    batches: [
      {
        ...batch('05101', 'batch-1', 'job-1'),
        risk_level: 'desconocido',
        factors: unknownOnly,
        priority: rankedPriority({
          risk_level: 'desconocido',
          priority_status: 'insufficient',
          risk_score: null,
          priority_score: null,
          priority_rank: null,
          total_ranked_zones: 0,
          exposed_assets_count: 0,
          dominant_category: null,
          context_summary: 'Comuna 05101: sin puesto regional.',
        }),
      },
    ],
  });

  const outcome = await read;
  expect(outcome.ok).toBe(true);
  if (outcome.ok) {
    expect(outcome.data).toHaveLength(1);
    expect(outcome.data[0]?.factors).toHaveLength(5);
    expect(outcome.data[0]?.factors.every(factor => factor.known === false)).toBe(true);
  }
});

// A known variable without its numbers is the one factor shape this client must not
// read as a measurement, even though the contract leaves the members optional.
test('a known factor without value or contribution is still refused', async () => {
  const { fetchStub } = await connectedSession();
  const read = batches();
  await flush();
  fetchStub.answer(`${gatewayOrigin}/v1/risk/batches`, {
    batches: [{ ...batch('05101', 'batch-1', 'job-1'), factors: [{ name: 'temperatura', known: true }] }],
  });
  expect(expectFailure(await read).kind).toBe('malformed');
});

// S5 — `dominant_category` is a closed vocabulary, not free text. A category the
// ratified table does not name would be printed as if the service had classified it.
test('an undeclared dominant category is refused', async () => {
  const { fetchStub } = await connectedSession();
  const url = `${gatewayOrigin}/v1/risk/batches`;

  for (const category of ['vivienda', 'hidrante', 'HOSPITAL', 'hospital ', '']) {
    const read = batches();
    await flush();
    fetchStub.answer(url, {
      batches: [
        {
          ...batch('05101', 'batch-1', 'job-1'),
          priority: rankedPriority({ dominant_category: category }),
        },
      ],
    });
    expect(expectFailure(await read).kind, `dominant_category ${JSON.stringify(category)}`).toBe('malformed');
  }
});

// S5 — the regional context must describe the batch it travels with. A member that
// names another zone or another level is a mismatched join, and an undeclared level
// is not a level this contract publishes.
test('the regional priority must name this batch zone and level', async () => {
  const { fetchStub } = await connectedSession();
  const url = `${gatewayOrigin}/v1/risk/batches`;
  const mismatched: Array<{ name: string; overrides: Record<string, unknown> }> = [
    { name: 'another zone', overrides: { zone_id: '05102' } },
    { name: 'another level', overrides: { risk_level: 'medio' } },
    { name: 'an undeclared level', overrides: { risk_level: 'extremo' } },
  ];

  for (const entry of mismatched) {
    const read = batches();
    await flush();
    fetchStub.answer(url, {
      batches: [
        {
          ...batch('05101', 'batch-1', 'job-1'),
          priority: rankedPriority(entry.overrides),
        },
      ],
    });
    expect(expectFailure(await read).kind, entry.name).toBe('malformed');
  }
});

// The matching case stays readable, so the guard cannot pass by refusing everything.
test('the regional priority is accepted when it names its own batch', async () => {
  const { fetchStub } = await connectedSession();
  const read = batches();
  await flush();
  fetchStub.answer(`${gatewayOrigin}/v1/risk/batches`, {
    batches: [{ ...batch('05101', 'batch-1', 'job-1'), priority: rankedPriority() }],
  });
  expect((await read).ok).toBe(true);
});

// S3/S5 — a zone the rule could not decide holds no position: `desconocido` is a
// level the rule states, not a low one. A `ranked` block that names it contradicts
// itself, so the transport refuses it and the projection refuses to show a rank for
// it even if a caller hands the object over directly.
test('a ranked priority cannot name the desconocido level', async () => {
  const { fetchStub } = await connectedSession();
  const read = batches();
  await flush();
  fetchStub.answer(`${gatewayOrigin}/v1/risk/batches`, {
    batches: [
      {
        // Both sides say `desconocido`, so the block fails on the contradiction alone
        // and not on the identity rule.
        ...batch('05101', 'batch-1', 'job-1'),
        risk_level: 'desconocido',
        priority: rankedPriority({ risk_level: 'desconocido' }),
      },
    ],
  });
  expect(expectFailure(await read).kind).toBe('malformed');
});

// S5 — a `ranked` block that fails its own invariant (an unknown level, or a missing
// score or rank) cannot be explained either: falling through to `insufficient` kept
// the contradictory `context_summary` ("puesto 1 de 2") and told the reader a position
// the data does not support. The projection refuses it as absent instead.
test('the projection refuses a contradictory ranked payload instead of explaining it', () => {
  const contradictory: ZonePriority = {
    zone_id: '05101',
    risk_level: 'alto',
    priority_status: 'ranked',
    risk_score: 96,
    exposure_score: 61,
    priority_score: 86,
    priority_rank: 1,
    total_ranked_zones: 2,
    exposed_assets_count: 5,
    dominant_category: 'hospital',
    context_summary: 'Comuna 05101: prioridad 86 de 100, puesto 1 de 2 del lote publicado.',
  };

  const cases: Array<{ name: string; payload: ZonePriority }> = [
    { name: 'a desconocido level', payload: { ...contradictory, risk_level: 'desconocido' } },
    { name: 'a missing priority score', payload: { ...contradictory, priority_score: null } },
    { name: 'a missing rank', payload: { ...contradictory, priority_rank: null } },
    { name: 'a missing risk score', payload: { ...contradictory, risk_score: null } },
  ];

  for (const entry of cases) {
    const view = priorityView(entry.payload);
    expect(view.kind, entry.name).toBe('absent');
    // The contradictory sentence must never reach a reader through any member.
    expect(JSON.stringify(view), entry.name).not.toContain('puesto 1 de 2');
  }
});

test('the projection still ranks a payload whose position is consistent', () => {
  const view = priorityView({
    zone_id: '05101',
    risk_level: 'alto',
    priority_status: 'ranked',
    risk_score: 96,
    exposure_score: 61,
    priority_score: 86,
    priority_rank: 1,
    total_ranked_zones: 2,
    exposed_assets_count: 5,
    dominant_category: 'hospital',
    context_summary: 'Comuna 05101: prioridad 86 de 100, puesto 1 de 2 del lote publicado.',
  });
  expect(view.kind).toBe('ranked');
});

// ── V1-P-05 — the closed quality catalogue and the source review ───────────
//
// The catalogue is CLOSED: five codes, in the ratified order, each with its kind,
// its severity and a Spanish description. A sixth code, a reordered list, an empty
// description or a source carrying an undeclared finding is refused at the boundary
// instead of being painted as a quality finding the service cannot produce.
test('the sources read requires the closed quality catalogue and its findings', async () => {
  const { fetchStub } = await connectedSession();

  const goodRead = sources();
  await flush();
  fetchStub.answer(`${gatewayOrigin}/v1/risk/sources`, sourceBody());
  const good = await goodRead;
  if (!good.ok) throw new Error(`expected a usable catalogue, got ${good.failure.reason}`);
  expect(good.data.quality_catalog?.map(entry => entry.code)).toEqual([
    'STALE_CUTOFF',
    'MISSING_CANONICAL_FACTOR',
    'OUT_OF_RANGE_CLAMPED',
    'CHECKSUM_VERIFIED',
    'SYNTHETIC_FALLBACK',
  ]);
  expect(good.data.sources?.[0].quality_findings).toEqual(['CHECKSUM_VERIFIED', 'SYNTHETIC_FALLBACK']);
  expect(good.data.sources?.[0].review).toBeNull();
});

test('the sources read refuses a catalogue or a finding the contract does not declare', async () => {
  const cases: Array<{ name: string; mutate: (body: Record<string, unknown>) => void }> = [
    {
      name: 'a missing catalogue',
      mutate: body => delete body.quality_catalog,
    },
    {
      name: 'a catalogue with an undeclared sixth code',
      mutate: body => {
        (body.quality_catalog as unknown[]).push({
          code: 'INVENTED_FINDING',
          kind: 'coverage',
          severity: 'warning',
          description: 'Un código que el servicio no puede producir.',
        });
      },
    },
    {
      name: 'a reordered catalogue',
      mutate: body => {
        const catalog = body.quality_catalog as unknown[];
        body.quality_catalog = [catalog[1], catalog[0], ...catalog.slice(2)];
      },
    },
    {
      name: 'a definition with an empty description',
      mutate: body => {
        (body.quality_catalog as Array<Record<string, unknown>>)[0].description = '';
      },
    },
    {
      name: 'a definition with an undeclared severity',
      mutate: body => {
        (body.quality_catalog as Array<Record<string, unknown>>)[0].severity = 'critical';
      },
    },
    {
      name: 'a definition whose kind does not belong to its code',
      mutate: body => {
        (body.quality_catalog as Array<Record<string, unknown>>)[0].kind = 'integrity';
      },
    },
    {
      name: 'a source with no findings',
      mutate: body => {
        (body.sources as Array<Record<string, unknown>>)[0].quality_findings = [];
      },
    },
    {
      name: 'a source with an undeclared finding',
      mutate: body => {
        (body.sources as Array<Record<string, unknown>>)[0].quality_findings = ['INVENTED_FINDING'];
      },
    },
    {
      name: 'a source repeating a finding',
      mutate: body => {
        (body.sources as Array<Record<string, unknown>>)[0].quality_findings = ['CHECKSUM_VERIFIED', 'CHECKSUM_VERIFIED'];
      },
    },
    {
      name: 'a review whose source is another source',
      mutate: body => {
        (body.sources as Array<Record<string, unknown>>)[0].review = sourceReviewFixture({ source_id: 'otra-fuente' });
      },
    },
    {
      name: 'a review with a decision outside the closed pair',
      mutate: body => {
        (body.sources as Array<Record<string, unknown>>)[0].review = sourceReviewFixture({ decision: 'approved' });
      },
    },
    {
      name: 'a review with no verified actor',
      mutate: body => {
        (body.sources as Array<Record<string, unknown>>)[0].review = sourceReviewFixture({ reviewed_by: '' });
      },
    },
    {
      name: 'a review with no instant',
      mutate: body => {
        (body.sources as Array<Record<string, unknown>>)[0].review = sourceReviewFixture({ reviewed_at: '' });
      },
    },
    {
      name: 'a review with an unparseable instant',
      mutate: body => {
        (body.sources as Array<Record<string, unknown>>)[0].review = sourceReviewFixture({ reviewed_at: 'ayer' });
      },
    },
    {
      name: 'a review whose note exceeds the stored bound',
      mutate: body => {
        (body.sources as Array<Record<string, unknown>>)[0].review = sourceReviewFixture({ note: 'ñ'.repeat(501) });
      },
    },
  ];

  for (const entry of cases) {
    const { fetchStub } = await connectedSession();
    const body = sourceBody();
    entry.mutate(body);
    const read = sources();
    await flush();
    fetchStub.answer(`${gatewayOrigin}/v1/risk/sources`, body);
    const outcome = await read;
    expect(outcome.ok, entry.name).toBe(false);
    if (!outcome.ok) expect(outcome.failure.kind, entry.name).toBe('malformed');
  }
});

test('the sources read accepts a 500 character note and a review of this source', async () => {
  const { fetchStub } = await connectedSession();
  const body = sourceBody();
  (body.sources as Array<Record<string, unknown>>)[0].review = sourceReviewFixture({ note: 'ñ'.repeat(500) });
  const read = sources();
  await flush();
  fetchStub.answer(`${gatewayOrigin}/v1/risk/sources`, body);
  const outcome = await read;
  if (!outcome.ok) throw new Error(`expected the longest accepted note, got ${outcome.failure.reason}`);
  expect(outcome.data.sources?.[0].review?.note).toHaveLength(500);
});

test('reviewSource posts the decision and echoes the source it reviewed', async () => {
  const { fetchStub } = await connectedSession();

  const accepted = reviewSource('fixture-sample', { decision: 'incorporated', note: 'revisado' });
  await flush();
  const calls = fetchStub.callsFor(`${gatewayOrigin}/v1/risk/sources/fixture-sample/review`);
  expect(calls).toHaveLength(1);
  expect(calls[0].init.method).toBe('POST');
  expect(JSON.parse(String(calls[0].init.body))).toEqual({ decision: 'incorporated', note: 'revisado' });
  fetchStub.answer(
    `${gatewayOrigin}/v1/risk/sources/fixture-sample/review`,
    sourceReviewFixture({ note: 'revisado' }),
  );
  const outcome = await accepted;
  if (!outcome.ok) throw new Error(`expected the stored review, got ${outcome.failure.reason}`);
  expect(outcome.data.decision).toBe('incorporated');
  expect(outcome.data.reviewed_by).toBe('operator@example.test');

  // The answer must name the source that was reviewed: a body about another source
  // would be a different decision painted as this one.
  const mismatched = reviewSource('fixture-sample', { decision: 'acknowledged' });
  await flush();
  fetchStub.answer(
    `${gatewayOrigin}/v1/risk/sources/fixture-sample/review`,
    sourceReviewFixture({ source_id: 'otra-fuente', decision: 'acknowledged' }),
  );
  expect(expectFailure(await mismatched).reason).toBe('source_mismatch');

  // A malformed answer is not a stored decision either.
  const malformed = reviewSource('fixture-sample', { decision: 'acknowledged' });
  await flush();
  fetchStub.answer(`${gatewayOrigin}/v1/risk/sources/fixture-sample/review`, { decision: 'acknowledged' });
  expect(expectFailure(await malformed).reason).toBe('invalid_shape');
});

test('reviewSource refuses an unhonourable request before it reaches the gateway', async () => {
  const { fetchStub } = await connectedSession();
  const cases: Array<{ name: string; sourceId: string; input: { decision: string; note?: string } }> = [
    { name: 'an empty source', sourceId: '  ', input: { decision: 'incorporated' } },
    { name: 'an unknown decision', sourceId: 'fixture-sample', input: { decision: 'approved' } },
    { name: 'a note past the stored bound', sourceId: 'fixture-sample', input: { decision: 'incorporated', note: 'ñ'.repeat(501) } },
  ];
  for (const entry of cases) {
    const outcome = await reviewSource(entry.sourceId, entry.input as { decision: 'incorporated'; note?: string });
    expect(outcome.ok, entry.name).toBe(false);
    if (!outcome.ok) expect(outcome.failure.kind, entry.name).toBe('malformed');
  }
  expect(fetchStub.calls).toHaveLength(0);
});

test('reviewSource reports the documented refusals the service actually answered', async () => {
  const { fetchStub } = await connectedSession();
  const refused = reviewSource('fixture-sample', { decision: 'incorporated' });
  await flush();
  fetchStub.answer(
    `${gatewayOrigin}/v1/risk/sources/fixture-sample/review`,
    { code: 'invalid_decision', request_id: '00000000-0000-4000-8000-000000000000' },
    422,
  );
  const outcome = await refused;
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) {
    expect(outcome.failure.kind).toBe('unavailable');
    expect(outcome.failure.status).toBe(422);
    expect(outcome.failure.reason).toBe('invalid_decision');
  }
});
