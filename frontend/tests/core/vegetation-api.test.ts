// V1-P-01 / PM-12 — the land-cover layer at the transport boundary.
//
// `GET /v1/risk/vegetation` publishes one entry per catalogue commune and the two
// batch reads attach that same entry as `land_cover`. These tests pin the guard
// that stands between the two: a payload that breaks any declared invariant is
// unreadable instead of being rendered as a measurement nobody took.

import { gatewayOrigin, issuer, pkceTransactionKey } from '../../src/config';
import { batches, latest, vegetation } from '../../src/core/api';
import type { Failure, Outcome } from '../../src/core/api';
import { completeLogin, resetSession } from '../../src/core/session';
import type { LandCoverBreakdown, RiskBatch, ZoneLandCover } from '../../src/types/api';

import { createCryptoStub, createFetchStub, createStorageStub, flush, jwt } from '../core/harness';

const TOKEN_URL = `${issuer}/protocol/openid-connect/token`;
const VEGETATION_URL = `${gatewayOrigin}/v1/risk/vegetation`;
const LATEST_URL = (zone: string): string => `${gatewayOrigin}/v1/risk/latest?zone_id=${zone}`;
const BATCHES_URL = `${gatewayOrigin}/v1/risk/batches`;

function expectFailure<T>(outcome: Outcome<T>): Failure {
  if (outcome.ok) throw new Error('expected a failure outcome');
  return outcome.failure;
}

function breakdown(overrides: Partial<LandCoverBreakdown> = {}): LandCoverBreakdown {
  return {
    bosque_nativo_pct: 20,
    plantacion_forestal_pct: 10,
    matorral_pastizal_pct: 40,
    interfaz_urbano_forestal_pct: 20,
    suelo_desnudo_agua_pct: 10,
    ...overrides,
  };
}

function landCover(overrides: Partial<ZoneLandCover> = {}): ZoneLandCover {  return {
    zone_id: '05101',
    zone_name: 'Valparaíso',
    ndvi_mean: 0.61,
    ndvi_min: 0.55,
    ndvi_max: 0.68,
    ndvi_anomaly: -0.04,
    land_cover_breakdown: breakdown(),
    environment_class: 'WUI_ALTA',
    synthetic: true,
    source_label: 'SINTETICO_SEED_V1',
    ...overrides,
  };
}

function catalogue(zones: ZoneLandCover[] = [landCover(), landCover({ zone_id: '05102', zone_name: 'Casablanca' })]): unknown {
  return { source: 'SINTETICO_SEED_V1', zones };
}

function batch(zone = '05101', overrides: Partial<RiskBatch> = {}): RiskBatch {
  return {
    zone_id: zone,
    id: 'batch-1',
    job_id: 'job-1',
    demo: true,
    risk_level: 'alto',
    factors: [{ name: 'temperatura', known: true, value: 30, contribution: 0.2, note: '' }],
    rationale: 'Regla académica',
    policy: { policy_id: 'academic-rule-v1', params_hash: 'hash', parameters: { weight: '0.2' } },
    notice: 'Sintético',
    ...overrides,
  };
}

async function connectedSession(): Promise<ReturnType<typeof createFetchStub>> {
  const fetchStub = createFetchStub();
  const storageStub = createStorageStub();
  vi.stubGlobal('fetch', fetchStub.fetch);
  vi.stubGlobal('sessionStorage', storageStub.storage);
  vi.stubGlobal('crypto', createCryptoStub());
  resetSession();
  const token = jwt({ realm_access: { roles: ['viewer'] } });
  storageStub.storage.setItem(pkceTransactionKey, JSON.stringify({ state: 's', verifier: 'v' }));
  const login = completeLogin('?code=code-1&state=s');
  await flush();
  fetchStub.answer(TOKEN_URL, { access_token: token });
  await login;
  fetchStub.calls.length = 0;
  return fetchStub;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── The layer read ─────────────────────────────────────────────────────────

test('vegetation reads the layer with the bearer discipline of every other risk read', async () => {
  const fetchStub = await connectedSession();
  const outcome = vegetation();
  await flush();

  const call = fetchStub.callsFor(VEGETATION_URL)[0];
  expect(call).toBeDefined();
  expect(call.init.credentials).toBe('omit');
  expect(call.init.cache).toBe('no-store');
  expect((call.init.headers as Record<string, string>).Authorization).toMatch(/^Bearer /);

  fetchStub.answer(VEGETATION_URL, catalogue());
  const result = await outcome;
  if (!result.ok) throw new Error(`expected a catalogue, got ${JSON.stringify(result.failure)}`);
  expect(result.data.source).toBe('SINTETICO_SEED_V1');
  expect(result.data.zones).toHaveLength(2);
  expect(result.data.zones[0]).toEqual(landCover());
});

test('the layer guard refuses a payload that breaks a declared NDVI invariant', async () => {
  const cases: [string, unknown][] = [
    ['min above mean', catalogue([landCover({ ndvi_min: 0.7, ndvi_mean: 0.6 })])],
    ['mean above max', catalogue([landCover({ ndvi_mean: 0.7, ndvi_max: 0.6 })])],
    ['mean above one', catalogue([landCover({ ndvi_mean: 1.2, ndvi_max: 1.3 })])],
    ['negative minimum', catalogue([landCover({ ndvi_min: -0.1 })])],
    ['anomaly out of range', catalogue([landCover({ ndvi_anomaly: -1.4 })])],
    ['non-finite mean', catalogue([landCover({ ndvi_mean: Number.NaN })])],
  ];

  const fetchStub = await connectedSession();
  for (const [name, body] of cases) {
    const outcome = vegetation();
    await flush();
    fetchStub.answer(VEGETATION_URL, body);
    const failure = expectFailure(await outcome);
    expect(failure.kind, name).toBe('malformed');
    expect(failure.reason, name).toBe('invalid_shape');
  }
});

test('the layer guard refuses a breakdown that does not sum to one hundred', async () => {
  const cases: [string, unknown][] = [
    ['sum below one hundred', catalogue([landCover({ land_cover_breakdown: breakdown({ suelo_desnudo_agua_pct: 9 }) })])],
    ['sum above one hundred', catalogue([landCover({ land_cover_breakdown: breakdown({ suelo_desnudo_agua_pct: 11 }) })])],
    ['a percentage above one hundred', catalogue([landCover({ land_cover_breakdown: breakdown({ bosque_nativo_pct: 120, suelo_desnudo_agua_pct: -10 }) })])],
    ['a negative percentage', catalogue([landCover({ land_cover_breakdown: breakdown({ plantacion_forestal_pct: -5, suelo_desnudo_agua_pct: 25 }) })])],
  ];

  const fetchStub = await connectedSession();
  for (const [name, body] of cases) {
    const outcome = vegetation();
    await flush();
    fetchStub.answer(VEGETATION_URL, body);
    expect(expectFailure(await outcome).kind, name).toBe('malformed');
  }
});

test('the layer guard refuses an undeclared class or an undeclared provenance', async () => {
  const cases: [string, unknown][] = [
    ['unknown class', catalogue([landCover({ environment_class: 'BOSQUE' as never })])],
    ['synthetic not declared', catalogue([landCover({ synthetic: false as never })])],
    ['another source label', catalogue([landCover({ source_label: 'COPERNICUS' as never })])],
    ['absent zone name', catalogue([landCover({ zone_name: '' })])],
    ['another envelope source', { source: 'synthetic_fixture', zones: [landCover()] }],
    ['zones not an array', { source: 'SINTETICO_SEED_V1', zones: {} }],
  ];

  const fetchStub = await connectedSession();
  for (const [name, body] of cases) {
    const outcome = vegetation();
    await flush();
    fetchStub.answer(VEGETATION_URL, body);
    expect(expectFailure(await outcome).kind, name).toBe('malformed');
  }
});

// ── The member attached to a batch ─────────────────────────────────────────

test('a published batch carries the land cover of its own commune', async () => {
  const fetchStub = await connectedSession();
  const served = batch('05101', { land_cover: landCover() });

  const detail = latest('05101');
  await flush();
  fetchStub.answer(LATEST_URL('05101'), served);
  expect(await detail).toEqual({ ok: true, data: served });

  const aggregate = batches();
  await flush();
  fetchStub.answer(BATCHES_URL, { batches: [served] });
  expect(await aggregate).toEqual({ ok: true, data: [served] });
});

test('a batch whose land cover names another commune is refused, not repaired', async () => {
  const fetchStub = await connectedSession();
  const foreign = batch('05101', { land_cover: landCover({ zone_id: '05102', zone_name: 'Casablanca' }) });

  const detail = latest('05101');
  await flush();
  fetchStub.answer(LATEST_URL('05101'), foreign);
  const failure = expectFailure(await detail);
  expect(failure.kind).toBe('malformed');
  expect(failure.reason).toBe('invalid_shape');
});

test('a batch whose land cover breaks an invariant is refused, and an absent member stays valid', async () => {
  const fetchStub = await connectedSession();

  const broken = batch('05101', { land_cover: landCover({ ndvi_min: 0.99, ndvi_mean: 0.61 }) });
  const detail = latest('05101');
  await flush();
  fetchStub.answer(LATEST_URL('05101'), broken);
  expect(expectFailure(await detail).kind).toBe('malformed');

  // The member is additive and optional: a zone the layer does not declare is
  // served without it, and that is a usable batch.
  const withoutMember = batch('05101');
  const plain = latest('05101');
  await flush();
  fetchStub.answer(LATEST_URL('05101'), withoutMember);
  expect(await plain).toEqual({ ok: true, data: withoutMember });
});
