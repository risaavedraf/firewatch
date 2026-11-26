import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { gatewayOrigin, issuer, pkceTransactionKey } from '../../src/config';
import { simulateRisk, type Failure, type Outcome } from '../../src/core/api';
import { completeLogin, resetSession } from '../../src/core/session';
import { SimulatorView } from '../../src/views/SimulatorView';

import { createCryptoStub, createFetchStub, createStorageStub, flush, jwt } from '../core/harness';

// PM-03 / S5 — the counterfactual simulator against the backend the base already
// carries (`POST /v1/risk/simulate`, contract frozen). Two halves:
//
//   1. the TRANSPORT posts one zone and only the substituted canonical variables,
//      refuses a body with no substitution before reading, refuses an answer that
//      echoes another zone or another stored batch, and keeps the 404/422/415
//      codes the contract declares;
//   2. the VIEW prefills the five canonical variables from the zone's newest
//      stored batch, substitutes one and several of them, shows the before/after
//      of the same batch, labels the block «Cómo lo calculó la regla» and never
//      presents the result as a forecast. A refusal settles into its own panel and
//      leaves the rest of the page usable.

const ZONES_URL = `${gatewayOrigin}/v1/risk/zones`;
const SIMULATE_URL = `${gatewayOrigin}/v1/risk/simulate`;
const TOKEN_URL = `${issuer}/protocol/openid-connect/token`;
const VIEWER_TOKEN = jwt({ realm_access: { roles: ['viewer'] } });
const ZONE_ID = '05101';
const BATCH_ID = 'b1a2c3d4-1111-2222-3333-444455556666';
const CANONICAL = ['temperatura', 'humedad_relativa', 'viento', 'cobertura_vegetal', 'incendios_historicos'] as const;

let fetchStub: ReturnType<typeof createFetchStub>;
let storageStub: ReturnType<typeof createStorageStub>;

function latestUrl(zoneId: string): string {
  return `${gatewayOrigin}/v1/risk/latest?zone_id=${zoneId}`;
}

function setup(): void {
  fetchStub = createFetchStub();
  storageStub = createStorageStub();
  vi.stubGlobal('fetch', fetchStub.fetch);
  vi.stubGlobal('sessionStorage', storageStub.storage);
  vi.stubGlobal('crypto', createCryptoStub());
  resetSession();
}

async function connect(token = VIEWER_TOKEN): Promise<void> {
  storageStub.storage.setItem(pkceTransactionKey, JSON.stringify({ state: 's', verifier: 'verifier' }));
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

function factor(name: string, known: boolean, value: number, contribution: number, note?: string): Record<string, unknown> {
  return note === undefined ? { name, known, value, contribution } : { name, known, value, contribution, note };
}

// The newest stored batch of the zone, as `/v1/risk/latest` serves it. Four
// variables carry a reading and `incendios_historicos` does not, which is the case
// the page must label «sin lectura» instead of prefilling a zero.
function batchFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    zone_id: ZONE_ID,
    id: BATCH_ID,
    job_id: 'job-1',
    demo: true,
    risk_level: 'medio',
    factors: [
      factor('temperatura', true, 31.5, 0.21, 'Máxima registrada en la estación'),
      factor('humedad_relativa', true, 22, 0.18, 'Mínima del día'),
      factor('viento', true, 40, 0.3, 'Ráfaga sostenida'),
      factor('cobertura_vegetal', true, 65, 0.22, 'Pastizal continuo'),
      factor('incendios_historicos', false, 0, 0),
    ],
    rationale: 'Regla de demostración.',
    policy: { policy_id: 'risk-rule', params_hash: 'sha256:aaaaaaaa' },
    published_at: '2026-11-24T12:00:00Z',
    requested_at: '2026-11-24T11:59:00Z',
    model_version: 'rule-v1',
    data_status: 'demo',
    ...overrides,
  };
}

function zonesFixture(): Record<string, unknown> {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { code: ZONE_ID, name: 'Valparaíso', province: 'Valparaíso', kind: 'comuna' },
        geometry: { type: 'Point', coordinates: [-71.6, -33.03] },
      },
      {
        type: 'Feature',
        properties: { code: '05102', name: 'Casablanca', province: 'Valparaíso', kind: 'comuna' },
        geometry: { type: 'Point', coordinates: [-71.4, -33.32] },
      },
    ],
  };
}

// One recomputation: a level and one entry per canonical variable, in canonical
// order. `null` is the contract's "the variable is absent", which carries neither
// a value nor a contribution.
function assessment(level: string, readings: Partial<Record<(typeof CANONICAL)[number], number | null>>): Record<string, unknown> {
  return {
    level,
    factors: CANONICAL.map(name => {
      const value = readings[name];
      return value === null || value === undefined ? { name, known: false } : { name, known: true, value, contribution: 0.1 };
    }),
  };
}

function simulationFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    batch_id: BATCH_ID,
    zone_id: ZONE_ID,
    model_version: 'rule-v1',
    stored_level: 'medio',
    policy: { policy_id: 'risk-rule', params_hash: 'sha256:aaaaaaaa' },
    computation_instant: '2026-11-24T11:59:00Z',
    freshness: 'not_evaluated',
    before: assessment('medio', {
      temperatura: 31.5,
      humedad_relativa: 22,
      viento: 40,
      cobertura_vegetal: 65,
      incendios_historicos: null,
    }),
    after: assessment('alto', {
      temperatura: 39,
      humedad_relativa: 22,
      viento: 40,
      cobertura_vegetal: 65,
      incendios_historicos: null,
    }),
    notice: 'Recálculo contrafactual de la regla guardada: no se publicó ningún lote.',
    ...overrides,
  };
}

function callsTo(url: string, method: 'GET' | 'POST'): { url: string; init: RequestInit }[] {
  return fetchStub.callsFor(url).filter(call => (call.init.method ?? 'GET') === method);
}

async function answerUrl(url: string, body: unknown, status = 200, requestId = '', expected = 1): Promise<void> {
  await waitFor(() => expect(fetchStub.callsFor(url)).toHaveLength(expected));
  await act(async () => {
    fetchStub.answer(url, body, status, requestId);
    await flush();
  });
}

async function answerMethod(
  url: string,
  method: 'GET' | 'POST',
  body: unknown,
  status = 200,
  requestId = '',
  expected = 1,
): Promise<void> {
  await waitFor(() => expect(callsTo(url, method)).toHaveLength(expected));
  await act(async () => {
    fetchStub.answer(url, body, status, requestId);
    await flush();
  });
}

function text(id: string): string {
  return document.getElementById(id)?.textContent ?? '';
}

function fieldValue(id: string): string {
  return (document.getElementById(id) as HTMLInputElement | null)?.value ?? '';
}

function checked(id: string): boolean {
  return (document.getElementById(id) as HTMLInputElement | null)?.checked ?? false;
}

function disabled(id: string): boolean {
  return (document.getElementById(id) as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | null)?.disabled ?? false;
}

// Mounts the page signed in and prefills it from a real catalogue and a real
// stored batch, which is the state every substitution test starts from.
async function mountPrefilled(): Promise<void> {
  await connect();
  render(<SimulatorView />);
  await answerUrl(ZONES_URL, zonesFixture());
  await userEvent.selectOptions(screen.getByLabelText('Zona del catálogo'), ZONE_ID);
  await answerUrl(latestUrl(ZONE_ID), batchFixture());
}

beforeEach(setup);

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Transport ───────────────────────────────────────────────────────────────

test('the request names one zone and only the substituted canonical variables', async () => {
  const pending = simulateRisk({ zoneId: ZONE_ID, batchId: BATCH_ID, variables: { temperatura: 39, viento: 55 } });
  await flush();

  const calls = callsTo(SIMULATE_URL, 'POST');
  expect(calls).toHaveLength(1);
  const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
  // The three unsubstituted variables are absent, not sent with a default, and
  // the stored batch the page prefilled from never travels in the body: the route
  // always simulates the newest stored batch.
  expect(body).toEqual({ zone_id: ZONE_ID, variables: { temperatura: 39, viento: 55 } });
  expect(Object.keys(body)).toEqual(['zone_id', 'variables']);
  expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  expect(calls[0].init.credentials).toBe('omit');

  fetchStub.answer(SIMULATE_URL, simulationFixture());
  const outcome = await pending;
  expect(outcome.ok).toBe(true);
  if (outcome.ok) expect(outcome.data.batch_id).toBe(BATCH_ID);
});

test('a null substitution travels as null, because forcing a variable to be absent is not zero', async () => {
  const pending = simulateRisk({ zoneId: ZONE_ID, batchId: BATCH_ID, variables: { incendios_historicos: null } });
  await flush();

  const body = JSON.parse(String(callsTo(SIMULATE_URL, 'POST')[0].init.body)) as Record<string, unknown>;
  expect(body).toEqual({ zone_id: ZONE_ID, variables: { incendios_historicos: null } });

  fetchStub.answer(SIMULATE_URL, simulationFixture({ after: assessment('desconocido', {}) }));
  const outcome = await pending;
  expect(outcome.ok).toBe(true);
});

test('a body with no substitution is refused before any read happens', async () => {
  const empty = await simulateRisk({ zoneId: ZONE_ID, batchId: BATCH_ID, variables: {} });
  expect(expectFailure(empty).reason).toBe('invalid_simulation');

  // An unknown member is not quietly forwarded either: the vocabulary is closed.
  const unknown = await simulateRisk({
    zoneId: ZONE_ID,
    batchId: BATCH_ID,
    variables: { temperatura: Number.NaN },
  });
  expect(expectFailure(unknown).reason).toBe('invalid_simulation');

  const noZone = await simulateRisk({ zoneId: '  ', batchId: BATCH_ID, variables: { temperatura: 1 } });
  expect(expectFailure(noZone).reason).toBe('invalid_simulation');

  // None of the three reached the network.
  expect(fetchStub.calls).toHaveLength(0);
});

test('the answer fails closed on an unreadable body, on a freshness claim and on the zone/lote echo', async () => {
  const missingAfter = simulateRisk({ zoneId: ZONE_ID, batchId: BATCH_ID, variables: { temperatura: 39 } });
  await flush();
  const broken = simulationFixture();
  delete broken['after'];
  fetchStub.answer(SIMULATE_URL, broken);
  expect(expectFailure(await missingAfter).reason).toBe('invalid_shape');

  const claim = simulateRisk({ zoneId: ZONE_ID, batchId: BATCH_ID, variables: { temperatura: 39 } });
  await flush();
  fetchStub.answer(SIMULATE_URL, simulationFixture({ freshness: 'stale' }));
  expect(expectFailure(await claim).reason).toBe('invalid_shape');

  const otherZone = simulateRisk({ zoneId: ZONE_ID, batchId: BATCH_ID, variables: { temperatura: 39 } });
  await flush();
  fetchStub.answer(SIMULATE_URL, simulationFixture({ zone_id: '05102' }));
  expect(expectFailure(await otherZone).reason).toBe('zone_mismatch');

  // A different stored batch than the one the page prefilled from is refused too:
  // its before/after would describe a batch the operator never read.
  const otherBatch = simulateRisk({ zoneId: ZONE_ID, batchId: BATCH_ID, variables: { temperatura: 39 } });
  await flush();
  fetchStub.answer(SIMULATE_URL, simulationFixture({ batch_id: 'b1a2c3d4-9999-2222-3333-444455556666' }));
  expect(expectFailure(await otherBatch).reason).toBe('batch_mismatch');

  // A factor list outside the canonical vocabulary is a contract change.
  const wrongFactors = simulateRisk({ zoneId: ZONE_ID, batchId: BATCH_ID, variables: { temperatura: 39 } });
  await flush();
  fetchStub.answer(SIMULATE_URL, simulationFixture({ after: { level: 'alto', factors: [{ name: 'temperatura', known: true, value: 39, contribution: 0.1 }] } }));
  expect(expectFailure(await wrongFactors).reason).toBe('invalid_shape');
});

test('a level outside the closed risk enum fails closed on the stored and the recomputed side', async () => {
  const stored = simulateRisk({ zoneId: ZONE_ID, batchId: BATCH_ID, variables: { temperatura: 39 } });
  await flush();
  fetchStub.answer(SIMULATE_URL, simulationFixture({ stored_level: 'extremo' }));
  expect(expectFailure(await stored).reason).toBe('invalid_shape');

  const recomputed = simulateRisk({ zoneId: ZONE_ID, batchId: BATCH_ID, variables: { temperatura: 39 } });
  await flush();
  fetchStub.answer(SIMULATE_URL, simulationFixture({ after: assessment('extremo', { temperatura: 39 }) }));
  expect(expectFailure(await recomputed).reason).toBe('invalid_shape');

  const before = simulateRisk({ zoneId: ZONE_ID, batchId: BATCH_ID, variables: { temperatura: 39 } });
  await flush();
  fetchStub.answer(SIMULATE_URL, simulationFixture({ before: assessment('extremo', { temperatura: 31.5 }) }));
  expect(expectFailure(await before).reason).toBe('invalid_shape');
});

test('the 404, 422 and 415 answers keep their status and their server code', async () => {
  const noBatch = simulateRisk({ zoneId: ZONE_ID, batchId: BATCH_ID, variables: { temperatura: 39 } });
  await flush();
  fetchStub.answer(SIMULATE_URL, { code: 'no_published_batch' }, 404, 'req-404');
  const missing = expectFailure(await noBatch);
  expect(missing.kind).toBe('missing');
  expect(missing.status).toBe(404);
  expect(missing.reason).toBe('no_published_batch');
  expect(missing.requestId).toBe('req-404');

  const notReproducible = simulateRisk({ zoneId: ZONE_ID, batchId: BATCH_ID, variables: { temperatura: 39 } });
  await flush();
  fetchStub.answer(SIMULATE_URL, { code: 'unsupported_original_rule' }, 422, 'req-422');
  const unsupported = expectFailure(await notReproducible);
  expect(unsupported.status).toBe(422);
  expect(unsupported.reason).toBe('unsupported_original_rule');

  const notJson = simulateRisk({ zoneId: ZONE_ID, batchId: BATCH_ID, variables: { temperatura: 39 } });
  await flush();
  fetchStub.answer(SIMULATE_URL, { code: 'json_required' }, 415, 'req-415');
  const media = expectFailure(await notJson);
  expect(media.status).toBe(415);
  expect(media.reason).toBe('json_required');
});

// ── View ────────────────────────────────────────────────────────────────────

test('the view states its own identifiers and offers nothing before a session exists', () => {
  render(<SimulatorView />);

  const section = document.querySelector('section#simulator');
  expect(section).not.toBeNull();
  expect(section).toHaveAttribute('data-view', 'simulator');

  for (const id of [
    'simulator-title',
    'simulator-badge',
    'simulator-lede',
    'simulator-status',
    'simulator-form',
    'simulator-form-title',
    'simulator-zone',
    'simulator-variables',
    'simulator-submit',
    'simulator-how-title',
    'simulator-how-note',
  ]) {
    expect(document.getElementById(id), id).not.toBeNull();
  }

  expect(text('simulator-title')).toBe('Simulador');
  expect(text('simulator-badge')).toBe('SIN CONSULTAR');
  expect(text('simulator-status')).toMatch(/conecta un token autorizado/i);
  // No control offers a simulation without a session, and no read was attempted.
  expect(disabled('simulator-zone')).toBe(true);
  expect(disabled('simulator-submit')).toBe(true);
  for (const name of CANONICAL) {
    expect(checked(`simulator-substitute-${name}`)).toBe(false);
    expect(disabled(`simulator-value-${name}`)).toBe(true);
  }
  expect(fetchStub.calls).toHaveLength(0);
  // The D-D label is the panel's own title, present before any simulation.
  expect(text('simulator-how-title')).toBe('Cómo lo calculó la regla');
  expect(text('simulator-how-note')).toMatch(/no se publicó ningún lote/i);
});

test('choosing a zone prefills the five canonical variables with the stored value and note, and marks the missing reading', async () => {
  await mountPrefilled();

  expect(fieldValue('simulator-zone')).toBe(ZONE_ID);
  expect(fieldValue('simulator-value-temperatura')).toBe('31.5');
  expect(text('simulator-reading-temperatura')).toContain('Máxima registrada en la estación');
  expect(text('simulator-reading-temperatura')).toContain('31.5');
  expect(fieldValue('simulator-value-viento')).toBe('40');
  expect(fieldValue('simulator-value-cobertura_vegetal')).toBe('65');

  // The batch carried no reading for this variable: it is labelled, left empty and
  // never prefilled with a zero.
  expect(fieldValue('simulator-value-incendios_historicos')).toBe('');
  expect(text('simulator-reading-incendios_historicos')).toMatch(/sin lectura/i);

  // Prefill is not a substitution: nothing is checked and «Simular» is disabled.
  for (const name of CANONICAL) expect(checked(`simulator-substitute-${name}`)).toBe(false);
  expect(disabled('simulator-submit')).toBe(true);
  expect(text('simulator-status')).toMatch(/lote publicado de 05101/i);
  expect(text('simulator-badge')).toBe('LEÍDO');
});

test('a stored factor marked unknown keeps its note in the prefill', async () => {
  await connect();
  render(<SimulatorView />);
  await answerUrl(ZONES_URL, zonesFixture());
  await userEvent.selectOptions(screen.getByLabelText('Zona del catálogo'), ZONE_ID);

  const batch = batchFixture();
  batch['factors'] = [
    ...(batch['factors'] as Record<string, unknown>[]).filter(factor => factor['name'] !== 'incendios_historicos'),
    factor('incendios_historicos', false, 0, 0, 'La estación no reportó la variable'),
  ];
  await answerUrl(latestUrl(ZONE_ID), batch);

  expect(fieldValue('simulator-value-incendios_historicos')).toBe('');
  expect(text('simulator-reading-incendios_historicos')).toContain('La estación no reportó la variable');
});

test('substituting one variable sends only that variable and shows the before/after of the same batch', async () => {
  await mountPrefilled();

  await userEvent.click(screen.getByLabelText('Sustituir temperatura'));
  fireEvent.change(screen.getByLabelText('Temperatura'), { target: { value: '39' } });
  expect(disabled('simulator-submit')).toBe(false);

  await userEvent.click(screen.getByRole('button', { name: 'Simular' }));
  await waitFor(() => expect(callsTo(SIMULATE_URL, 'POST')).toHaveLength(1));

  const body = JSON.parse(String(callsTo(SIMULATE_URL, 'POST')[0].init.body)) as Record<string, unknown>;
  expect(body).toEqual({ zone_id: ZONE_ID, variables: { temperatura: 39 } });

  await answerMethod(SIMULATE_URL, 'POST', simulationFixture());

  expect(text('simulator-before-level')).toBe('MEDIO');
  expect(text('simulator-after-level')).toBe('ALTO');
  expect(text('simulator-stored-level')).toBe('MEDIO');
  expect(text('simulator-batch-id')).toBe(BATCH_ID);
  expect(text('simulator-policy-id')).toBe('risk-rule');
  expect(text('simulator-params-hash')).toBe('sha256:aaaaaaaa');
  expect(text('simulator-model-version')).toBe('rule-v1');
  expect(text('simulator-freshness')).toBe('not_evaluated');
  expect(text('simulator-computation-instant')).toBe('2026-11-24T11:59:00Z');
  expect(text('simulator-notice')).toMatch(/no se publicó ningún lote/i);

  // The factors of both recomputations are shown, and a variable the rule could
  // not read says so instead of showing a zero.
  expect(text('simulator-before-factor-temperatura')).toBe('31.5 · aporte 0.1');
  expect(text('simulator-after-factor-temperatura')).toBe('39 · aporte 0.1');
  expect(text('simulator-after-factor-incendios_historicos')).toBe('sin lectura');
  expect(text('simulator-run-status')).toMatch(/simulación completada/i);
  expect(text('simulator-badge')).toBe('SIMULADO');
});

test('substituting several variables sends exactly those and no other, and keeps the entered values when a refusal arrives', async () => {
  await mountPrefilled();

  await userEvent.click(screen.getByLabelText('Sustituir temperatura'));
  fireEvent.change(screen.getByLabelText('Temperatura'), { target: { value: '40' } });
  await userEvent.click(screen.getByLabelText('Sustituir viento'));
  fireEvent.change(screen.getByLabelText('Viento'), { target: { value: '70' } });

  expect(text('simulator-submit-note')).toMatch(/2 de 5/i);

  await userEvent.click(screen.getByRole('button', { name: 'Simular' }));
  await waitFor(() => expect(callsTo(SIMULATE_URL, 'POST')).toHaveLength(1));

  const body = JSON.parse(String(callsTo(SIMULATE_URL, 'POST')[0].init.body)) as Record<string, unknown>;
  expect(body).toEqual({ zone_id: ZONE_ID, variables: { temperatura: 40, viento: 70 } });

  await answerMethod(SIMULATE_URL, 'POST', { code: 'storage_unavailable' }, 503, 'req-503');

  // The refusal is stated in the result panel, and every entered value stays.
  expect(text('simulator-run-status')).toMatch(/503/);
  expect(text('simulator-run-status')).toMatch(/storage_unavailable/);
  expect(text('simulator-result')).toBe('');
  expect(fieldValue('simulator-value-temperatura')).toBe('40');
  expect(fieldValue('simulator-value-viento')).toBe('70');
  expect(checked('simulator-substitute-viento')).toBe(true);
});

test('a zone without a published batch is stated as such and offers no simulation', async () => {
  await connect();
  render(<SimulatorView />);
  await answerUrl(ZONES_URL, zonesFixture());
  await userEvent.selectOptions(screen.getByLabelText('Zona del catálogo'), '05102');
  await answerUrl(latestUrl('05102'), { code: 'no_published_batch' }, 404, 'req-404');

  expect(text('simulator-batch-status')).toMatch(/no tiene ningún lote publicado/i);
  expect(text('simulator-badge')).toBe('SIN LOTE');
  expect(disabled('simulator-submit')).toBe(true);
  expect(text('simulator-result')).toBe('');
});

test('a stored batch that cannot be reproduced with a builtin rule answers 422 and is never replaced by the active model', async () => {
  await mountPrefilled();

  // The label is the human one, so the checkbox reads as a sentence.
  expect(screen.getByLabelText('Sustituir humedad relativa')).toBeInTheDocument();

  await userEvent.click(screen.getByLabelText('Sustituir humedad relativa'));
  fireEvent.change(screen.getByLabelText('Humedad relativa'), { target: { value: '15' } });
  await userEvent.click(screen.getByRole('button', { name: 'Simular' }));
  await waitFor(() => expect(callsTo(SIMULATE_URL, 'POST')).toHaveLength(1));
  await answerMethod(SIMULATE_URL, 'POST', { code: 'unsupported_original_rule' }, 422, 'req-422');

  expect(text('simulator-run-status')).toMatch(/422/);
  expect(text('simulator-run-status')).toMatch(/unsupported_original_rule/);
  expect(text('simulator-run-status')).toMatch(/no se sustituye por el modelo activo/i);
  expect(text('simulator-result')).toBe('');
});

test('a transport failure settles into its panel and leaves the zone, the variables and the button usable', async () => {
  await mountPrefilled();

  // Only the simulation call fails: the catalogue and batch reads already landed.
  const wired = fetchStub.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).includes('/v1/risk/simulate')
      ? Promise.reject(new TypeError('network down'))
      : wired(input, init),
  );

  await userEvent.click(screen.getByLabelText('Sustituir temperatura'));
  await userEvent.click(screen.getByRole('button', { name: 'Simular' }));

  await waitFor(() => expect(text('simulator-run-status')).toMatch(/sin conexión/i));
  expect(text('simulator-result')).toBe('');
  // The rest of the page still works: the prefilled rows and the picker survive.
  expect(fieldValue('simulator-zone')).toBe(ZONE_ID);
  expect(fieldValue('simulator-value-viento')).toBe('40');
  expect(disabled('simulator-zone')).toBe(false);
  expect(disabled('simulator-submit')).toBe(false);
});

test('the substitute checkbox governs the substitution: an unchecked prefilled value never travels', async () => {
  await mountPrefilled();

  await userEvent.click(screen.getByLabelText('Sustituir temperatura'));
  fireEvent.change(screen.getByLabelText('Temperatura'), { target: { value: '39' } });
  // Unchecking it removes the substitution: the prefilled value stays visible but
  // is no longer part of the counterfactual, so «Simular» is disabled again.
  await userEvent.click(screen.getByLabelText('Sustituir temperatura'));

  expect(disabled('simulator-submit')).toBe(true);
  expect(fieldValue('simulator-value-temperatura')).toBe('39');
  expect(callsTo(SIMULATE_URL, 'POST')).toHaveLength(0);
});

test('the block is labelled «Cómo lo calculó la regla» and never speaks as a forecast', async () => {
  await mountPrefilled();
  await userEvent.click(screen.getByLabelText('Sustituir temperatura'));
  fireEvent.change(screen.getByLabelText('Temperatura'), { target: { value: '39' } });
  await userEvent.click(screen.getByRole('button', { name: 'Simular' }));
  await waitFor(() => expect(callsTo(SIMULATE_URL, 'POST')).toHaveLength(1));
  await answerMethod(SIMULATE_URL, 'POST', simulationFixture());

  // D-D: the page uses this label and says the calculation is the rule.
  expect(text('simulator-how-title')).toBe('Cómo lo calculó la regla');
  expect(text('simulator-how-note')).toMatch(/es la regla, no un pronóstico/i);

  // Every occurrence of the forecast vocabulary is inside a negation: stripping the
  // three negation phrases must leave no such word behind.
  const claim = text('simulator-how-note')
    .replace(/no un pronóstico/gi, '')
    .replace(/no es una predicción/gi, '')
    .replace(/ni una probabilidad/gi, '');
  expect(claim).not.toMatch(/pronóstico|predicción|probabilidad/i);

  // The forbidden framing is absent from the whole page, and the no-write claim is
  // stated as text — not only as a colour or a badge.
  const page = document.body.textContent ?? '';
  expect(page).not.toMatch(/qué pasaría si se quema/i);
  expect(page).not.toMatch(/pronóstico de|pronostica|se pronostica|predice|riesgo esperado/i);
  expect(text('simulator-result-note')).toMatch(/no se publicó ningún lote/i);
});
