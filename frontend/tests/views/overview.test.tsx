// N8b — the territory overview: the consolidated metrics, the real territorial
// map and the latest published batch with its evidence.
//
// The suite drives the view through the accessible surface plus the contracted
// identifiers, stubs `globalThis.fetch` and exercises the validity bound with
// fake timers. Every test title names the legacy readback assertion it ports.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { gatewayOrigin, issuer, pkceTransactionKey, routes } from '../../src/config';
import { clearZoneState, getSelectedZone, getSelectedZoneLabel, getZoneLevels, reportJobProgress } from '../../src/app/store';
import { completeLogin, getSessionSnapshot, resetSession } from '../../src/core/session';
import type { RiskBatch, ZoneCollection, ZoneFeature } from '../../src/types/api';
import { OverviewView } from '../../src/views/OverviewView';
import { createFetchStub, createStorageStub, flush, jwt } from '../core/harness';

const TOKEN_URL = `${issuer}/protocol/openid-connect/token`;
const ZONES_URL = `${gatewayOrigin}${routes.zones}`;
const latestUrl = (zone: string): string => `${gatewayOrigin}${routes.latest}?zone_id=${zone}`;
const historyUrl = (zone: string): string => `${gatewayOrigin}${routes.history}?zone_id=${zone}`;
const MODELS_URL = `${gatewayOrigin}${routes.models}`;
// `config.routes` carries the per-zone risk reads; the aggregate read is named
// here the way the transport names it, so this suite pins the exact route the
// page consumes.
const BATCHES_URL = `${gatewayOrigin}/v1/risk/batches`;

// Two stubs are shared by the whole file and rebuilt before every test, so no
// test can inherit a pending request or a previous session from another.
let fetchStub: ReturnType<typeof createFetchStub>;
let storageStub: ReturnType<typeof createStorageStub>;

function prepare(): void {
  fetchStub = createFetchStub();
  storageStub = createStorageStub();
  vi.stubGlobal('fetch', fetchStub.fetch);
  vi.stubGlobal('sessionStorage', storageStub.storage);
  resetSession();
  clearZoneState();
}

beforeEach(prepare);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// --- Fixtures --------------------------------------------------------------
//
// The geometry is schematic and intentionally shared: these tests are about the
// view contract, not about the projection, which the map unit already covers.

function ring(minLon = -71.7, minLat = -33.1, size = 0.1): ZoneFeature['geometry'] {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [minLon, minLat],
        [minLon + size, minLat],
        [minLon + size, minLat + size],
        [minLon, minLat],
      ],
    ],
  };
}

function feature(code: string, name: string, province = 'Valparaíso'): ZoneFeature {
  return { type: 'Feature', properties: { code, name, province }, geometry: ring() };
}

function catalogue(features: ZoneFeature[]): ZoneCollection {
  return { type: 'FeatureCollection', features };
}

function catalogueOfSize(size: number): ZoneCollection {
  const features: ZoneFeature[] = [];
  for (let index = 0; index < size; index += 1) {
    const code = String(50000 + index);
    features.push(feature(code, `Comuna ${code}`));
  }
  return catalogue(features);
}

function batch(zone = '05101', id = 'batch-1', job = 'job-1', overrides: Partial<RiskBatch> = {}): RiskBatch {
  return {
    zone_id: zone,
    id,
    job_id: job,
    demo: true,
    risk_level: 'alto',
    factors: [{ name: 'temperatura', known: true, value: 30, contribution: 0.2, note: '' }],
    rationale: 'Regla académica',
    policy: { policy_id: 'academic-rule-v1', params_hash: 'hash', parameters: { weight: '0.2' } },
    notice: 'Sintético',
    ...overrides,
  };
}

// --- Driving the view ------------------------------------------------------

function element(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing DOM ${id}`);
  return node;
}

function textOf(id: string): string {
  return element(id).textContent ?? '';
}

async function settle(): Promise<void> {
  await act(async () => {
    await flush();
  });
}

async function signInAgain(): Promise<void> {
  storageStub.storage.setItem(pkceTransactionKey, JSON.stringify({ state: 's', verifier: 'v' }));
  const login = completeLogin('?code=c&state=s');
  await flush();
  fetchStub.answer(TOKEN_URL, { access_token: jwt({ realm_access: { roles: ['viewer'] } }), id_token: jwt({ sub: 'u' }) });
  await login;
}

async function signIn(): Promise<void> {
  await signInAgain();
  fetchStub.calls.length = 0;
}

async function openSignedIn(): Promise<void> {
  await signIn();
  render(<OverviewView />);
  await settle();
}

async function openSignedOut(): Promise<void> {
  render(<OverviewView />);
  await settle();
}

test('shows the territorial map and its zone selector before the session summary and model details', async () => {
  await openSignedIn();

  const mapHeading = screen.getByRole('heading', { name: 'Vista territorial de las comunas' });
  const zoneSelector = screen.getByRole('combobox', { name: 'Zona a consultar' });
  const summary = screen.getByRole('region', { name: 'Resumen real de la sesión' });
  const modelHeading = screen.getByRole('heading', { name: 'Versión de modelo activa' });
  for (const item of [mapHeading, zoneSelector]) {
    for (const secondary of [summary, modelHeading]) {
      expect(item.compareDocumentPosition(secondary) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    }
  }
});

async function serveCatalogue(collection: ZoneCollection): Promise<void> {
  fetchStub.answer(ZONES_URL, collection);
  await settle();
}

async function serveZone(
  zone: string,
  latestBody: unknown,
  latestStatus = 200,
  historyBody: unknown = [],
  historyStatus = 200,
): Promise<void> {
  fetchStub.answer(latestUrl(zone), latestBody, latestStatus);
  fetchStub.answer(historyUrl(zone), historyBody, historyStatus);
  await settle();
}

async function choose(zone: string): Promise<void> {
  fireEvent.change(screen.getByRole('combobox', { name: 'Zona a consultar' }), { target: { value: zone } });
  await settle();
}

function latestCallCount(): number {
  return fetchStub.calls.filter(call => call.url.includes(routes.latest)).length;
}

function historyCallCount(): number {
  return fetchStub.calls.filter(call => call.url.includes(routes.history)).length;
}

function batchesCallCount(): number {
  return fetchStub.calls.filter(call => call.url === BATCHES_URL).length;
}

function mapIsHidden(): boolean {
  return element('map-svg').hasAttribute('hidden');
}

function selector(): HTMLSelectElement {
  return element('zone-select') as HTMLSelectElement;
}

async function logOut(): Promise<void> {
  act(() => {
    resetSession();
  });
  await settle();
}

// --- Contract surface ------------------------------------------------------

test('the view keeps the overview identity, every contracted identifier and the coverage note', async () => {
  await openSignedIn();
  await serveCatalogue(catalogue([feature('05101', 'Valparaíso')]));
  await serveZone('05101', null, 404);

  const section = document.getElementById('overview');
  expect(section).not.toBeNull();
  expect(section).toHaveAttribute('data-view', 'overview');

  for (const id of [
    'zone-count',
    'metric-batches',
    'metric-high',
    'risk-pill',
    'risk-status',
    'risk-level',
    'zone-code',
    'zone-name',
    'zone-province',
    'batch-origin',
    'batch-notice',
    'batch-validity',
    'risk-factors',
    'risk-rationale',
    'risk-policy',
    'data-status',
    'model-version',
    'valid-until',
    'batch-id',
    'input-scope-badge',
  ]) {
    expect(document.getElementById(id), `missing DOM ${id}`).not.toBeNull();
  }

  // The "Cobertura por sector" limitation stays inside this view.
  expect(screen.getByText(/Cobertura por sector/)).toBeInTheDocument();
});

test('without a session the metrics stay unknown and the map states the connection requirement', async () => {
  await openSignedOut();

  expect(textOf('zone-count')).toBe('—');
  expect(textOf('metric-batches')).toBe('—');
  expect(textOf('metric-high')).toBe('0');
  expect(textOf('risk-pill')).toBe('SIN CONSULTAR');
  expect(textOf('risk-status')).toMatch(/Conecta un token autorizado/);
  expect(mapIsHidden()).toBe(true);
  expect(textOf('map-empty')).toBe('Conecta un token autorizado para cargar las zonas analizadas.');
});

test('zone count derives from the actual /zones feature length, never a copied constant', async () => {
  await openSignedIn();
  await serveCatalogue(catalogueOfSize(38));
  expect(textOf('zone-count')).toBe('38');
  expect(textOf('zone-count')).not.toBe('39');

  cleanup();
  prepare();
  await openSignedIn();
  await serveCatalogue(catalogueOfSize(3));
  expect(textOf('zone-count')).toBe('3');
});

test('metric cards report the real catalogue, history and read-zone counts', async () => {
  await openSignedIn();

  // Nothing was asked yet: the catalogue count is explicitly unknown, not zero.
  expect(textOf('zone-count')).toBe('—');

  await serveCatalogue(catalogue([feature('05101', 'Valparaíso'), feature('05102', 'Casablanca')]));
  expect(textOf('zone-count')).toBe('2');

  // The auto-selected zone's history is still in flight, so the metric is unset.
  expect(textOf('metric-batches')).toBe('—');
  expect(textOf('metric-high')).toBe('0');

  // An empty history is a real zero, never a blank.
  await serveZone('05101', null, 404, []);
  expect(textOf('metric-batches')).toBe('0');

  await choose('05102');
  await serveZone('05102', batch('05102'), 200, [batch('05102'), batch('05102', 'second', 'job2')]);
  expect(textOf('metric-batches')).toBe('2');
  expect(textOf('metric-high')).toBe('1');

  await logOut();
  expect(textOf('metric-high')).toBe('0');
  expect(textOf('metric-batches')).toBe('—');
  expect(textOf('zone-count')).toBe('No informado');
});

test('the catalogue the view loads is the only source of the shared chip name', async () => {
  await openSignedIn();
  // Before any catalogue arrives there is no name to report, not a provisional one.
  expect(getSelectedZoneLabel()).toBe('');

  await serveCatalogue(catalogue([feature('05101', 'Valparaíso'), feature('05102', 'Casablanca')]));
  // The auto-selected first code is named with the same label the map selector
  // shows, and only because the served catalogue carried it.
  expect(getSelectedZoneLabel()).toBe('Valparaíso (05101)');
});

test('a healthy session still renders the live catalogue count and keeps selection working', async () => {
  await openSignedIn();
  await serveCatalogue(catalogue([feature('05101', 'Valparaíso'), feature('05102', 'Casablanca'), feature('05201', 'Juan Fernández')]));
  expect(textOf('zone-count')).toBe('3');

  // The map shape is the accessible selection surface, not just the select.
  fireEvent.click(screen.getByRole('button', { name: 'Casablanca (05102)' }));
  await settle();
  expect(selector().value).toBe('05102');

  await serveZone('05102', null, 404, []);
  expect(textOf('risk-pill')).toBe('SIN LOTE');
});

test('selection reads latest and history; a 404 is absence, never low risk', async () => {
  await openSignedIn();
  await serveCatalogue(catalogue([feature('05101', 'Valparaíso'), feature('05102', 'Casablanca')]));
  await serveZone('05101', null, 404, []);

  await choose('05102');
  expect(latestCallCount()).toBe(2);
  expect(historyCallCount()).toBe(2);

  await serveZone('05102', null, 404, []);
  expect(textOf('risk-pill')).toBe('SIN LOTE');
  expect(textOf('risk-level')).toBe('Sin lote publicado');
  expect(textOf('risk-level')).not.toBe('BAJO');
  expect(textOf('metric-batches')).toBe('0');
  expect(element('risk-factors').children).toHaveLength(0);
});

test('wrong-zone and superseded latest responses cannot render; catalogue geometry stays unchanged', async () => {
  await openSignedIn();
  await serveCatalogue(catalogue([feature('05101', 'Valparaíso'), feature('05102', 'Casablanca')]));
  await serveZone('05101', batch('05101', 'first'), 200, [batch('05101', 'first')]);

  const before = element('map-svg').querySelectorAll('path').length;

  // A to B to A: the first A answer is superseded by the second A request.
  await choose('05102');
  await choose('05101');
  fetchStub.answer(latestUrl('05102'), batch('05102', 'obsolete'));
  fetchStub.answer(historyUrl('05102'), [batch('05102', 'obsolete')]);
  fetchStub.answer(latestUrl('05101'), batch('05101', 'current'));
  fetchStub.answer(historyUrl('05101'), [batch('05101', 'current')]);
  await settle();
  expect(textOf('batch-id')).toBe('current');
  expect(textOf('batch-id')).not.toBe('obsolete');

  // A batch the server computed for another zone is discarded as a whole.
  await choose('05102');
  await serveZone('05102', batch('05101', 'wrong-zone'), 200, []);
  expect(textOf('risk-status')).toMatch(/otra zona/);
  expect(textOf('risk-pill')).toBe('NO DISPONIBLE');
  expect(textOf('batch-id')).not.toBe('wrong-zone');
  expect(element('map-svg').querySelectorAll('path').length).toBe(before);
});

test('an unreadable batch body renders as explicitly unavailable, never as a plausible level', async () => {
  await openSignedIn();
  await serveCatalogue(catalogue([feature('05101', 'Valparaíso')]));
  // `rationale` is required by the boundary guard, so this body is rejected and
  // must never be shown as a severity the API did not state.
  await serveZone('05101', { ...batch('05101'), rationale: undefined }, 200, []);

  expect(textOf('risk-pill')).toBe('NO DISPONIBLE');
  expect(textOf('risk-status')).toMatch(/ilegible/);
  expect(textOf('batch-id')).toBe('Sin consultar');
  expect(textOf('risk-level')).not.toMatch(/BAJO|MEDIO|ALTO/);
});

test('unknown level, false demo discrepancy, loading and logout clear prior details', async () => {
  await openSignedIn();
  await serveCatalogue(catalogue([feature('05101', 'Valparaíso'), feature('05102', 'Casablanca')]));
  await serveZone('05101', null, 404, []);

  await choose('05102');
  await serveZone('05102', batch('05102', 'b', 'j', { demo: false, risk_level: 'desconocido' }), 200, [batch('05102')]);
  expect(textOf('risk-pill')).toBe('INFORMACIÓN INSUFICIENTE');
  expect(textOf('risk-level')).toBe('INFORMACIÓN INSUFICIENTE');
  expect(textOf('batch-origin')).toMatch(/discrepante/);
  expect(textOf('batch-notice')).toMatch(/no riesgo real observado/);

  // A new selection clears the previous batch's details while the read is in flight.
  await choose('05101');
  expect(element('risk-factors').children).toHaveLength(0);
  expect(textOf('risk-policy')).toBe('Sin consultar');
  expect(textOf('risk-rationale')).toBe('Sin consultar');

  await logOut();
  expect(textOf('zone-code')).toBe('No informado');
  expect(element('risk-factors').children).toHaveLength(0);
  expect(textOf('risk-policy')).toBe('Sin consultar');
  expect(textOf('risk-pill')).toBe('SIN CONSULTAR');
});

test('lot validity from published_at/valid_until is separate from the synthetic recency notice', async () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const past = new Date(Date.now() - 86_400_000).toISOString();

  await openSignedIn();
  await serveCatalogue(catalogue([feature('05101', 'Valparaíso')]));
  await serveZone('05101', batch('05101', 'b', 'j', { published_at: past, valid_until: future }), 200, [batch('05101')]);
  expect(textOf('batch-validity')).toMatch(/Vigente/i);
  expect(textOf('batch-validity')).toMatch(/publicado/i);
  expect(textOf('batch-notice')).toMatch(/no riesgo real observado/i);
  expect(textOf('batch-notice')).not.toMatch(/vigente|vencida/i);

  cleanup();
  prepare();
  await openSignedIn();
  await serveCatalogue(catalogue([feature('05101', 'Valparaíso')]));
  await serveZone('05101', batch('05101', 'b', 'j', { published_at: past, valid_until: past }), 200, [batch('05101')]);
  expect(textOf('batch-validity')).toMatch(/Vencida/i);
  expect(textOf('batch-notice')).toMatch(/no riesgo real observado/i);
});

test('batch validity label re-evaluates on its own bounded timer, stops at or before valid_until and logout clears it', async () => {
  vi.useFakeTimers();
  const start = new Date('2026-01-01T00:00:00.000Z');
  vi.setSystemTime(start);

  await openSignedIn();
  await serveCatalogue(catalogue([feature('05101', 'Valparaíso'), feature('05102', 'Casablanca'), feature('05103', 'Quilpué')]));

  const windowMs = 3000;
  const published = new Date(start.getTime() - 1000).toISOString();
  const until = new Date(start.getTime() + windowMs).toISOString();
  await serveZone('05101', batch('05101', 'b', 'j', { published_at: published, valid_until: until }), 200, [batch('05101')]);
  expect(textOf('batch-validity')).toMatch(/Vigente/);

  // The flip is scheduled no later than valid_until; the skew may only expire
  // the claim early, never keep it alive past the declared bound.
  await act(async () => {
    vi.advanceTimersByTime(windowMs);
  });
  expect(textOf('batch-validity')).toMatch(/Vencida/);
  expect(textOf('batch-validity')).not.toMatch(/Vigente/);
  expect(Date.now()).toBeLessThanOrEqual(Date.parse(until) + 1);

  // A new selection arms a fresh bound, then logout clears the label for good.
  await choose('05102');
  await serveZone('05102', batch('05102', 'b2', 'j2', { published_at: published, valid_until: new Date(Date.now() + windowMs).toISOString() }), 200, [batch('05102')]);
  expect(textOf('batch-validity')).toMatch(/Vigente/);

  await logOut();
  expect(textOf('batch-validity')).toBe('Sin consultar');
  await act(async () => {
    vi.advanceTimersByTime(60_000);
  });
  expect(textOf('batch-validity')).toBe('Sin consultar');
});

test('a 401 reset clears a live validity bound instead of keeping the claim', async () => {
  vi.useFakeTimers();
  const start = new Date('2026-01-01T00:00:00.000Z');
  vi.setSystemTime(start);

  await openSignedIn();
  await serveCatalogue(catalogue([feature('05101', 'Valparaíso')]));
  await serveZone('05101', batch('05101', 'b', 'j', { published_at: start.toISOString(), valid_until: new Date(start.getTime() + 20_000).toISOString() }), 200, [batch('05101')]);
  expect(textOf('batch-validity')).toMatch(/Vigente/);

  // The transport resets the session on 401; the view must drop the bound.
  act(() => {
    resetSession();
  });
  await settle();
  expect(getSessionSnapshot().status).toBe('signed-out');
  expect(textOf('batch-validity')).toBe('Sin consultar');
  await act(async () => {
    vi.advanceTimersByTime(30_000);
  });
  expect(textOf('batch-validity')).toBe('Sin consultar');
});

test('synthetic warning independent of notice; unknown factor never displays zero', async () => {
  await openSignedIn();
  await serveCatalogue(catalogue([feature('05101', 'Valparaíso')]));
  await serveZone(
    '05101',
    batch('05101', 'b', 'j', {
      notice: '',
      rationale: '<img onerror=evil>',
      factors: [{ name: 'viento', known: false, note: 'ausente', value: 0, contribution: 0 }],
    }),
    200,
    [batch('05101')],
  );

  expect(textOf('batch-origin')).toMatch(/Sintético/);
  expect(textOf('batch-notice')).toMatch(/no riesgo real observado/);
  expect(textOf('batch-notice')).toMatch(/ausente o inválido/);
  // The approved label describes the rule's calculation, not a cause or forecast (PM-02).
  expect(screen.getByRole('heading', { name: 'Cómo lo calculó la regla' }).nextElementSibling).toBe(
    element('risk-rationale'),
  );
  // The rationale is reproduced as text, never interpreted as markup.
  expect(textOf('risk-rationale')).toBe('<img onerror=evil>');
  // The unknown entry is found by name, not by position: the row list names the
  // five canonical inputs in a fixed order (PM-02).
  const unknownViento = Array.from(element('risk-factors').children).find((row) =>
    (row.textContent ?? '').startsWith('viento:'),
  );
  expect(unknownViento).toBeDefined();
  expect(unknownViento?.textContent).not.toMatch(/0/);
  expect(unknownViento?.querySelector('.factor-track')).toBeNull();
});

test.each([
  ['missing', undefined],
  ['malformed', {}],
])('demo mandatory warning with %s notice', async (_label, notice) => {
  await openSignedIn();
  await serveCatalogue(catalogue([feature('05101', 'Valparaíso')]));
  const incoming = { ...batch('05101'), notice };
  await serveZone('05101', incoming, 200, [incoming]);
  expect(textOf('batch-origin')).toMatch(/Sintético/);
  expect(textOf('batch-notice')).toMatch(/no riesgo real observado/);
  expect(textOf('batch-notice')).toMatch(/ausente o inválido/);
  expect(textOf('batch-notice')).not.toContain('[object Object]');
});

test('factor bars use the real contribution and a factor without data draws no bar', async () => {
  await openSignedIn();
  await serveCatalogue(catalogue([feature('05101', 'Valparaíso')]));
  await serveZone(
    '05101',
    batch('05101', 'b', 'j', {
      factors: [
        { name: 'temperatura', known: true, value: 30, contribution: 0.5, note: '' },
        { name: 'humedad', known: true, value: 10, contribution: 0.25, note: '' },
        { name: 'viento', known: false, value: 0, contribution: 0, note: 'sin dato' },
      ],
    }),
    200,
    [batch('05101')],
  );

  // The five canonical inputs are named first, then the extra factor the batch
  // carried; rows are looked up by name so the bar contract does not depend on
  // enumeration order. `humedad` is not a canonical name and must survive.
  const items = Array.from(element('risk-factors').children);
  expect(items).toHaveLength(6);
  const rowOf = (name: string): Element => {
    const matches = items.filter((item) => (item.textContent ?? '').startsWith(`${name}:`));
    expect(matches, `row ${name}`).toHaveLength(1);
    return matches[0];
  };
  const trackOf = (name: string): HTMLElement | null => rowOf(name).querySelector('.factor-track');
  const widthOf = (name: string): string => (trackOf(name)?.firstElementChild as HTMLElement).style.width;
  expect(widthOf('temperatura')).toBe('100%');
  expect(widthOf('humedad')).toBe('50%');
  expect(trackOf('viento')).toBeNull();
});

// PM-02 — the panel names the five inputs the frozen rule reads, so a variable
// without a reading is stated instead of disappearing from the list. One entry
// is explicitly unknown (the service's zero sentinels) and another is missing
// from the payload; neither may become a zero or a bar. The measured inputs keep
// their real value, contribution, note and proportional bar, and a batch with no
// usable factor entry still renders no rows at all.
test('the factor list names the five canonical inputs and states every missing reading without inventing a value (PM-02)', async () => {
  await openSignedIn();
  await serveCatalogue(catalogue([feature('05101', 'Valparaíso'), feature('05102', 'Casablanca')]));
  await serveZone(
    '05101',
    batch('05101', 'b', 'j', {
      factors: [
        { name: 'temperatura', known: true, value: 31, contribution: 0.4, note: 'máxima del día' },
        { name: 'humedad_relativa', known: false, value: 0, contribution: 0, note: 'dato ausente' },
        { name: 'cobertura_vegetal', known: true, value: 62, contribution: 0.2, note: 'estimada' },
        { name: 'incendios_historicos', known: true, value: 4, contribution: 0.1, note: 'últimos 5 años' },
      ],
    }),
    200,
    [batch('05101')],
  );

  const rows = Array.from(element('risk-factors').children);
  expect(rows).toHaveLength(5);
  const names = rows.map((row) => (row.textContent ?? '').split(':')[0]);
  expect(names).toEqual([
    'temperatura',
    'humedad_relativa',
    'viento',
    'cobertura_vegetal',
    'incendios_historicos',
  ]);
  const rowOf = (name: string): Element => {
    const matches = rows.filter((row) => (row.textContent ?? '').startsWith(`${name}:`));
    expect(matches, `row ${name}`).toHaveLength(1);
    return matches[0];
  };
  const widthOf = (name: string): string | null => {
    const track = rowOf(name).querySelector('.factor-track');
    return track === null ? null : (track.firstElementChild as HTMLElement).style.width;
  };

  // Measured inputs keep their actual value, contribution, note and bar.
  expect(rowOf('temperatura').textContent).toContain('temperatura: 31');
  expect(rowOf('temperatura').textContent).toContain('contribución 0.4');
  expect(rowOf('temperatura').textContent).toContain('máxima del día');
  expect(widthOf('temperatura')).toBe('100%');
  expect(rowOf('cobertura_vegetal').textContent).toContain('cobertura_vegetal: 62');
  expect(widthOf('cobertura_vegetal')).toBe('50%');
  expect(rowOf('incendios_historicos').textContent).toContain('incendios_historicos: 4');
  expect(widthOf('incendios_historicos')).toBe('25%');

  // Explicitly unknown: a readable status and the service's own note, never the
  // zero sentinel it was sent with, never a contribution, never a bar.
  const unknown = rowOf('humedad_relativa');
  expect(unknown.textContent).toMatch(/sin lectura/);
  expect(unknown.textContent).toContain('dato ausente');
  expect(unknown.textContent).not.toMatch(/0/);
  expect(unknown.textContent).not.toMatch(/contribución/);
  expect(unknown.querySelector('.factor-track')).toBeNull();

  // Absent from the payload: the same no-reading status, exposed as real text so
  // it is announced, and equally free of an invented number or bar.
  const absent = rowOf('viento');
  expect(absent.textContent).toMatch(/sin lectura/);
  expect(absent.textContent).not.toMatch(/\d/);
  expect(absent.querySelector('.factor-track')).toBeNull();
  expect(screen.getByText(/^viento: sin lectura/)).toBeInTheDocument();

  // A batch with no usable factor entry stays explicitly unavailable: the only
  // list entry is the pre-existing omission notice, never a fabricated canonical
  // row, a number or a bar.
  await choose('05102');
  await serveZone('05102', batch('05102', 'b2', 'j2', { factors: [] }), 200, []);
  expect(textOf('risk-pill')).toBe('NO DISPONIBLE');
  expect(textOf('risk-status')).toMatch(/Lote incompleto/);
  expect(textOf('risk-level')).not.toMatch(/BAJO|MEDIO|ALTO/);
  const unavailableRows = Array.from(element('risk-factors').children);
  expect(unavailableRows).toHaveLength(1);
  expect(unavailableRows[0].textContent).toMatch(/Factores ausentes o inválidos/);
  expect(unavailableRows[0].querySelector('.factor-track')).toBeNull();
});

test('superseded /v1/risk/zones after a 401 reset cannot repopulate map, count, selector or risk status', async () => {
  await openSignedIn();
  // The catalogue read is in flight when the 401 arrives.
  fetchStub.answer(ZONES_URL, { code: 'unauthorized' }, 401);
  await settle();

  expect(getSessionSnapshot().status).toBe('signed-out');
  expect(textOf('zone-count')).toBe('No informado');
  const clearedRisk = textOf('risk-status');
  // The catalogue read carried the bearer, so this is a rejected token, not a
  // first visit: the panel must name the rejection (S2).
  expect(clearedRisk).toMatch(/rechazó el token/i);
  expect(mapIsHidden()).toBe(true);
  expect(selector().disabled).toBe(true);

  // No late read may chain a selection, and no zone read may have been issued.
  expect(textOf('risk-status')).toBe(clearedRisk);
  expect(latestCallCount()).toBe(0);
  expect(historyCallCount()).toBe(0);
});

test('superseded /v1/risk/zones after logout cannot repopulate state nor chain latest/history reads', async () => {
  await openSignedIn();
  await logOut();
  const clearedRisk = textOf('risk-status');

  // The response lands after the session closed: it owns nothing.
  fetchStub.answer(ZONES_URL, catalogue([feature('05101', 'Valparaíso')]));
  await settle();

  expect(textOf('zone-count')).toBe('No informado');
  expect(textOf('metric-batches')).toBe('—');
  expect(mapIsHidden()).toBe(true);
  expect(selector().disabled).toBe(true);
  expect(textOf('risk-status')).toBe(clearedRisk);
  expect(latestCallCount()).toBe(0);
  expect(historyCallCount()).toBe(0);
});

// S2 — a rejected token is the visible consequence of the model change: the
// map's empty message and the risk panel name the rejection instead of telling
// the operator they never connected.
test('a token-bearing 401 names the rejection in the map and the risk panel (S2)', async () => {
  await openSignedIn();
  fetchStub.answer(ZONES_URL, { code: 'unauthorized' }, 401);
  await settle();

  expect(getSessionSnapshot()).toEqual({ status: 'signed-out', roles: null, reason: 'rejected' });
  expect(textOf('map-empty')).not.toBe('Conecta un token autorizado para cargar las zonas analizadas.');
  expect(textOf('map-empty')).toMatch(/rechazó el token/i);
  expect(textOf('risk-status')).toMatch(/rechazó el token/i);
});

// S6 — the reason belongs to the rejected session only: once the session is
// closed (the state `signOut` publishes) the anonymous copy is the correct one.
test('closing a rejected session returns to the anonymous copy (S6)', async () => {
  await openSignedIn();
  fetchStub.answer(ZONES_URL, { code: 'unauthorized' }, 401);
  await settle();
  expect(getSessionSnapshot().reason).toBe('rejected');

  await logOut();

  expect(getSessionSnapshot()).toEqual({ status: 'signed-out', roles: null, reason: null });
  expect(textOf('map-empty')).toBe('Conecta un token autorizado para cargar las zonas analizadas.');
  expect(textOf('risk-status')).toBe('Conecta un token autorizado para consultar la API.');
});

// T13 — the active model version comes from the model registry (`GET /v1/models`,
// an OBJECT ENVELOPE `{models: [...]}`) and is labelled with the `synthetic` mark
// the service declares. An undeclared mark is stated as undeclared, never assumed
// to be non-synthetic; an unreachable or wrongly-shaped registry is stated, never
// replaced with a plausible version.
test('shows the active model version from the {models} envelope with its declared synthetic mark (T13)', async () => {
  await openSignedIn();

  fetchStub.answer(MODELS_URL, {
    models: [
      {
        version: 'academic-rule-v1',
        kind: 'rule',
        params_hash: 'e17aaa5600eb67c9a91340e90057aec100f4e80ef0895662f373cffee66564c7',
        approved_at: null,
        metrics: { official: false, calibrated_against_observed_fires: false },
        active: false,
      },
      { version: 'modelo-sintetico', kind: 'rule', params_hash: null, approved_at: null, metrics: { synthetic: true }, active: true },
    ],
  });
  await settle();

  expect(textOf('model-active-version')).toBe('modelo-sintetico');
  expect(textOf('model-synthetic')).toBe('SINTÉTICO');
  expect(textOf('model-status')).toMatch(/sintétic/i);
});

test('the real default active row declares no synthetic mark, and a wrong envelope is rejected (T13)', async () => {
  await openSignedIn();
  // The exact default seed: academic-rule-v1 active, firewatch-rule-v2 and
  // demo-fixture-v1 registered but inactive. Neither academic-rule-v1 nor
  // firewatch-rule-v2 declares `synthetic`, so the honest answer is "not declared".
  fetchStub.answer(MODELS_URL, {
    models: [
      {
        version: 'academic-rule-v1',
        kind: 'rule',
        params_hash: 'e17aaa5600eb67c9a91340e90057aec100f4e80ef0895662f373cffee66564c7',
        approved_at: null,
        metrics: { official: false, calibrated_against_observed_fires: false },
        active: true,
      },
      {
        version: 'firewatch-rule-v2',
        kind: 'rule',
        params_hash: '59259c4c0c470e5a0d512fe09f6c748c38fd29f9bc5d760d49754555c66e699b',
        approved_at: null,
        metrics: { official: false, calibrated_against_observed_fires: false, aggregation: 'dominant_factor' },
        active: false,
      },
      { version: 'demo-fixture-v1', kind: 'placeholder', params_hash: null, approved_at: null, metrics: { official: false, synthetic: true }, active: false },
    ],
  });
  await settle();

  expect(textOf('model-active-version')).toBe('academic-rule-v1');
  expect(textOf('model-synthetic')).toBe('NO DECLARADO');
  expect(textOf('model-status')).toMatch(/no declara/i);

  cleanup();
  prepare();
  await openSignedIn();
  // The bare array was the assumed shape and is NOT what the service serves; it
  // must render as unavailable rather than as a parsed registry.
  fetchStub.answer(MODELS_URL, [{ version: 'academic-rule-v1', active: true }]);
  await settle();
  expect(textOf('model-active-version')).toBe('No informada');
  expect(textOf('model-synthetic')).toBe('NO DISPONIBLE');
});

// S1/S4 — the aggregate read colours the territory on load, with no click: one
// `/v1/risk/batches` answer carries every published level, so more than one comuna
// is painted as soon as it settles. Nothing in this test selects anything.
test('the aggregate read colours several comunas with no click (S1, S4)', async () => {
  await openSignedIn();
  await serveCatalogue(
    catalogue([feature('05101', 'Valparaíso'), feature('05102', 'Casablanca'), feature('05103', 'Quilpué')]),
  );
  await serveZone('05101', null, 404, []);
  expect(batchesCallCount()).toBe(1);

  fetchStub.answer(BATCHES_URL, {
    batches: [
      batch('05101'),
      batch('05102', 'batch-2', 'job-2', { risk_level: 'medio' }),
      batch('05103', 'batch-3', 'job-3', { risk_level: 'bajo' }),
    ],
  });
  await settle();

  // The shared level map is what the map paints from, so it is asserted directly
  // as well as through the rendered shape classes.
  expect(getZoneLevels().get('05101')).toBe('alto');
  expect(getZoneLevels().get('05102')).toBe('medio');
  expect(getZoneLevels().get('05103')).toBe('bajo');
  expect(document.querySelector('[data-zone="05102"]')?.getAttribute('class')).toContain('level-medio');
  expect(document.querySelector('[data-zone="05103"]')?.getAttribute('class')).toContain('level-bajo');
  // The count is what the page read and validated, not a regional total.
  expect(textOf('metric-high')).toBe('1');
});

// S5 — an element that fails the fail-closed presentation check and a zone the
// answer omits both leave their comuna neutral: never a level, never a default.
test('a zone absent from the aggregate and an element that fails validation stay neutral (S5)', async () => {
  await openSignedIn();
  await serveCatalogue(
    catalogue([feature('05101', 'Valparaíso'), feature('05102', 'Casablanca'), feature('05103', 'Quilpué')]),
  );
  await serveZone('05101', null, 404, []);

  // `factors: []` passes the wire shape and fails `presentBatch` exactly as an
  // incomplete batch from `/v1/risk/latest` would.
  fetchStub.answer(BATCHES_URL, { batches: [batch('05102', 'batch-2', 'job-2', { factors: [] })] });
  await settle();

  expect(getZoneLevels().has('05102')).toBe(false);
  expect(getZoneLevels().has('05103')).toBe(false);
  expect(getZoneLevels().has('05101')).toBe(false);
  for (const code of ['05101', '05102', '05103']) {
    expect(document.querySelector(`[data-zone="${code}"]`)?.getAttribute('class')).toContain('zone-neutral');
  }
  expect(textOf('metric-high')).toBe('0');
});

// S5 — a failed aggregate answer must not paint anything nor support a claim: the
// map stays exactly as the per-zone reads left it.
test('a failed aggregate answer leaves the map as the per-zone reads leave it (S5)', async () => {
  await openSignedIn();
  await serveCatalogue(catalogue([feature('05101', 'Valparaíso'), feature('05102', 'Casablanca')]));
  await serveZone('05101', batch('05101'), 200, [batch('05101')]);

  fetchStub.answer(BATCHES_URL, { code: 'storage_unavailable' }, 503);
  await settle();

  expect(getZoneLevels().get('05101')).toBe('alto');
  expect(getZoneLevels().has('05102')).toBe(false);
  expect(document.querySelector('[data-zone="05102"]')?.getAttribute('class')).toContain('zone-neutral');
  expect(textOf('metric-high')).toBe('1');
});

// S5 — a 401 is the one aggregate failure that changes the session: the transport
// lowers it, so the map is emptied by the session ending rather than by anything
// this read decided, and no comuna is painted from a refusal.
test('a 401 on the aggregate read closes the session instead of painting the map (S5)', async () => {
  await openSignedIn();
  await serveCatalogue(catalogue([feature('05101', 'Valparaíso'), feature('05102', 'Casablanca')]));

  fetchStub.answer(BATCHES_URL, { code: 'unauthorized' }, 401);
  await settle();

  expect(getSessionSnapshot().status).toBe('signed-out');
  expect(getZoneLevels().size).toBe(0);
  expect(selector().disabled).toBe(true);
});

// S2 — leaving the map and coming back must not move the selection back to the
// first catalogue code (Valparaíso, 05101): the reader's comuna survives the
// remount because the auto-selection only fills an EMPTY selection.
test('the selected zone survives leaving the view and is not replaced by the first catalogue code (S2)', async () => {
  await openSignedIn();
  await serveCatalogue(catalogue([feature('05101', 'Valparaíso'), feature('05102', 'Casablanca')]));
  await serveZone('05101', null, 404, []);

  fireEvent.click(screen.getByRole('button', { name: 'Casablanca (05102)' }));
  await settle();
  await serveZone('05102', batch('05102'), 200, [batch('05102')]);
  expect(getSelectedZone()).toBe('05102');
  const latestForFirstCode = fetchStub.callsFor(latestUrl('05101')).length;

  // Leave the map view and come back.
  cleanup();
  render(<OverviewView />);
  await settle();
  await serveCatalogue(catalogue([feature('05101', 'Valparaíso'), feature('05102', 'Casablanca')]));
  await serveZone('05102', batch('05102'), 200, [batch('05102')]);

  expect(getSelectedZone()).toBe('05102');
  expect(selector().value).toBe('05102');
  // The remount re-read the zone the reader chose, and never the first code.
  expect(fetchStub.callsFor(latestUrl('05102')).length).toBeGreaterThan(1);
  expect(fetchStub.callsFor(latestUrl('05101')).length).toBe(latestForFirstCode);
});

// S4 — the aggregate read is a per-session read, not a per-mount one: coming back
// to the map must not re-issue it, while a new session must.
test('the aggregate read runs once per session, not once per mount (S4)', async () => {
  await openSignedIn();
  await serveCatalogue(catalogue([feature('05101', 'Valparaíso')]));
  await serveZone('05101', null, 404, []);
  fetchStub.answer(BATCHES_URL, { batches: [batch('05101')] });
  await settle();
  expect(batchesCallCount()).toBe(1);

  cleanup();
  render(<OverviewView />);
  await settle();
  await serveCatalogue(catalogue([feature('05101', 'Valparaíso')]));
  // The selected zone's own read runs again on the remount, as it should: this
  // test is about the aggregate read, which must not.
  await serveZone('05101', batch('05101'), 200, [batch('05101')]);

  // Nothing was re-requested, and the level the session already bought is still
  // on the map: the colour belongs to the session, not to the view.
  expect(batchesCallCount()).toBe(1);
  expect(getZoneLevels().get('05101')).toBe('alto');

  // A new session buys the aggregate again.
  act(() => {
    resetSession();
  });
  await settle();
  await signInAgain();
  await settle();
  expect(batchesCallCount()).toBe(2);
  await serveCatalogue(catalogue([feature('05101', 'Valparaíso')]));
  fetchStub.answer(BATCHES_URL, { batches: [] });
  await settle();
});

// T2 — the "high level" note may no longer deny that an aggregate endpoint
// exists, and it has to say honestly what the count means whether that read
// succeeded or failed.
test('the high-level metric note describes the aggregate read instead of denying it (T2)', async () => {
  await openSignedIn();
  await serveCatalogue(catalogue([feature('05101', 'Valparaíso')]));

  const note = screen.getByText('Comunas con nivel alto').closest('article')?.querySelector('p')?.textContent ?? '';
  expect(note).not.toMatch(/no existe endpoint agregado/i);
  expect(note).toMatch(/\/v1\/risk\/batches/);
  expect(note).toMatch(/validó/);
  expect(note).toMatch(/sin lote publicado/i);
  expect(note).toMatch(/sin nivel/i);
});

// T2/S1 — the panel must present the registry version and the version that really
// classified the newest batch as two different facts, and it must state when an
// activation applies: to publications whose classifier resolution happens after
// the call, never to one already in flight. The sentence this replaces claimed the
// running classifier was fixed by MODEL_ID at startup and that activating a
// version moved only the registry, which was exactly the defect.
test('separates the registry version from the batch version and states when an activation applies (T2)', async () => {
  await openSignedIn();
  fetchStub.answer(MODELS_URL, {
    models: [
      {
        version: 'firewatch-rule-v2',
        kind: 'rule',
        params_hash: '59259c4c0c470e5a0d512fe09f6c748c38fd29f9bc5d760d49754555c66e699b',
        approved_at: '2026-10-18T12:00:00Z',
        metrics: { official: false, activation: { at: '2026-10-18T12:00:00Z' } },
        active: true,
      },
      {
        version: 'academic-rule-v1',
        kind: 'rule',
        params_hash: 'e17aaa5600eb67c9a91340e90057aec100f4e80ef0895662f373cffee66564c7',
        approved_at: null,
        metrics: { official: false, calibrated_against_observed_fires: false },
        active: false,
      },
    ],
  });
  await settle();
  // The batch was resolved before the activation, so it still names v1 while the
  // registry already presents v2. That difference is legitimate and the panel must
  // show both instead of presenting one as the other.
  await serveCatalogue(catalogue([feature('05101', 'Valparaíso')]));
  await serveZone('05101', batch('05101', 'b', 'j', { model_version: 'academic-rule-v1' }), 200, [
    batch('05101', 'b', 'j', { model_version: 'academic-rule-v1' }),
  ]);

  expect(textOf('model-active-version')).toBe('firewatch-rule-v2');
  expect(textOf('model-batch-version')).toBe('academic-rule-v1');

  const note = textOf('model-panel-note');
  expect(note).toMatch(/registro/i);
  expect(note).toMatch(/lote/i);
  expect(note).toMatch(/después de esa llamada/i);
  expect(note).toMatch(/en curso/i);
  expect(note).toMatch(/MODEL_ID/);
  expect(note).toMatch(/sembrada como activa/i);
  expect(note).not.toMatch(/fija su versión con MODEL_ID al arrancar, así que/i);
  expect(note).not.toMatch(/no el clasificador que está en uso/i);
  expect(note).not.toMatch(/recrear el servicio/i);
});

// Issue #96 — the map had one vocabulary for "no level yet", so a batch the
// operator had just requested was presented as a comuna without information. The
// jobs view now publishes the progress through the shared store and the map states
// it, which is the difference between «procesando» and «sin información».
test('the map announces a batch in process instead of treating it as missing information', async () => {
  await openSignedIn();
  await serveCatalogue(catalogue([feature('05101', 'Valparaíso')]));
  // Nothing published yet: the batch the operator asked for is still being built.
  await serveZone('05101', null, 404);

  act(() => {
    reportJobProgress('processing', '05101');
  });
  await settle();

  const progress = document.getElementById('map-job-progress');
  expect(progress).not.toBeNull();
  expect(progress).toHaveAttribute('role', 'status');
  expect(progress).toHaveAttribute('aria-live', 'polite');
  expect(progress).toHaveTextContent(/proceso/i);
  expect(progress).not.toHaveTextContent(/INFORMACIÓN INSUFICIENTE/i);

  // The risk panel still reports the absence it actually observed; what changed is
  // that the map no longer presents the pending batch as a missing assessment.
  expect(textOf('risk-level')).toBe('Sin lote publicado');
  expect(textOf('risk-level')).not.toMatch(/INFORMACIÓN INSUFICIENTE/i);
});

test('the map stops claiming a batch in process once the jobs view reports none', async () => {
  await openSignedIn();
  await serveCatalogue(catalogue([feature('05101', 'Valparaíso')]));
  await serveZone('05101', null, 404);

  act(() => {
    reportJobProgress('processing', '05101');
  });
  await settle();
  expect(document.getElementById('map-job-progress')).not.toBeNull();

  act(() => {
    reportJobProgress('idle', '');
  });
  await settle();
  expect(document.getElementById('map-job-progress')).toBeNull();
});

// --- PM-18: the preventive-recommendation catalogue ------------------------
//
// The zone card suggests from the written catalogue in
// `odd/plan-produccion/catalogo-recomendaciones-preventivas.md`. The composition
// itself is pinned by `tests/domain/recommendations.test.ts`; these tests pin what
// the card renders, the states it must not suggest in, and the public interface
// fact that showing suggestions creates nothing.

function listTexts(id: string): string[] {
  return Array.from(element(id).children).map(row => row.textContent ?? '');
}

test('the zone card suggests from the catalogue with exact text, source and limits (PM-18)', async () => {
  await openSignedIn();
  await serveCatalogue(catalogue([feature('05101', 'Valparaíso')]));
  await serveZone(
    '05101',
    batch('05101', 'b', 'j', {
      risk_level: 'alto',
      factors: [
        { name: 'temperatura', known: true, value: 30, contribution: 0.18, note: '' },
        { name: 'humedad_relativa', known: true, value: 20, contribution: 0, note: '' },
        { name: 'viento', known: true, value: 40, contribution: 0.216, note: '' },
        { name: 'cobertura_vegetal', known: false, value: 0, contribution: 0, note: 'sin dato' },
        { name: 'incendios_historicos', known: true, value: 3, contribution: 0.05, note: '' },
      ],
    }),
    200,
    [batch('05101')],
  );

  // The level the composition used is the level the card informed, never a
  // re-classification.
  expect(textOf('recommendation-level')).toBe('ALTO');

  // Two factor items in contribution order, then the level's base pair, each one
  // with the side of the composition it came from and the document's own text.
  expect(listTexts('recommendation-list')).toEqual([
    'FACTOR Con viento, no hagas fogatas ni quemas y no uses herramientas que produzcan chispas.',
    'FACTOR En días calurosos, evita herramientas y trabajos que generen chispas al aire libre, sobre todo cerca de vegetación.',
    'NIVEL Restringe fogatas, parrillas, quema de desechos y otras fuentes de calor cerca de vegetación.',
    'NIVEL Coordina con la municipalidad o la junta de vecinos una revisión del entorno y de las vías de salida.',
  ]);

  const notices = listTexts('recommendation-notices').join(' ');
  expect(notices).toMatch(/Sin lectura: cobertura_vegetal\./);
  expect(notices).toMatch(/no son una alerta oficial, ni una clasificación oficial de riesgo, ni una orden/i);
  expect(notices).toMatch(/autoridad/i);

  // Provenance and the no-action statement, in the card's own words.
  expect(textOf('recommendation-panel-note')).toMatch(/SENAPRED/);
  expect(textOf('recommendation-panel-note')).toMatch(/MINVU/);
  expect(textOf('recommendation-panel-note')).toMatch(/decisión de FireWatch/);
  expect(textOf('recommendation-panel-note')).toMatch(/no crea acciones/);
  expect(textOf('recommendation-panel-note')).toMatch(/no pide nada nuevo a la API/);

  // The list is a real list and a real heading: semantic, not styled divs.
  expect(screen.getByRole('heading', { name: 'Recomendaciones preventivas', level: 3 })).toBeInTheDocument();
  expect(element('recommendation-list').tagName).toBe('UL');
  expect(element('recommendation-list').querySelectorAll('li')).toHaveLength(4);
  // Both lists are named, so a screen reader reaches them by their meaning.
  expect(screen.getByRole('list', { name: 'Sugerencias de prevención' })).toBe(element('recommendation-list'));
  expect(screen.getByRole('list', { name: 'Avisos de las recomendaciones' })).toBe(element('recommendation-notices'));
});

test('a level the rule did not classify suggests only the fallback pair (PM-18)', async () => {
  await openSignedIn();
  await serveCatalogue(catalogue([feature('05101', 'Valparaíso'), feature('05102', 'Casablanca')]));
  await serveZone(
    '05101',
    batch('05101', 'b', 'j', {
      risk_level: 'desconocido',
      factors: [{ name: 'viento', known: true, value: 40, contribution: 0.9, note: '' }],
    }),
    200,
    [batch('05101')],
  );

  expect(textOf('recommendation-level')).toBe('INFORMACIÓN INSUFICIENTE');
  expect(listTexts('recommendation-list')).toEqual([
    'NIVEL Retira la vegetación seca y los desechos acumulados alrededor de la vivienda.',
    'NIVEL Mantén despejadas, con anticipación, las vías de salida y los accesos que usarías ante una emergencia.',
  ]);
  expect(textOf('recommendation-notices')).toMatch(
    /Nivel no clasificado: el sistema no tiene una evaluación validada de esta zona\./,
  );
  // A positive contribution on an unclassified batch does not become a factor
  // item, and it is not discussed as a reading either.
  expect(textOf('recommendation-list')).not.toMatch(/Con viento/);
  expect(textOf('recommendation-notices')).not.toMatch(/Sin lectura/);

  // An out-of-set level is not remapped to a similar severity: the card fails
  // closed on its own label while the batch stays explicitly unavailable.
  await choose('05102');
  await serveZone('05102', batch('05102', 'b2', 'j2', { risk_level: 'critico' }), 200, [batch('05102')]);
  expect(textOf('recommendation-level')).toBe('SIN CLASIFICAR');
  expect(textOf('risk-pill')).toBe('NO DISPONIBLE');
  expect(listTexts('recommendation-list')).toHaveLength(2);
  expect(textOf('recommendation-list')).not.toMatch(/ALTO|MEDIO|BAJO/);
});

test('without a published batch the panel states it instead of suggesting from nothing (PM-18)', async () => {
  await openSignedIn();
  await serveCatalogue(catalogue([feature('05101', 'Valparaíso'), feature('05102', 'Casablanca')]));

  // The read is still in flight: no item and no guessed level.
  expect(listTexts('recommendation-list')).toEqual([]);
  expect(textOf('recommendation-level')).toBe('SIN CONSULTAR');
  expect(textOf('recommendation-status')).toMatch(/Esperando el último lote/);

  // A 404 is an absence, not a low risk to suggest from.
  await serveZone('05101', null, 404, []);
  expect(listTexts('recommendation-list')).toEqual([]);
  expect(textOf('recommendation-level')).toBe('SIN LOTE');
  expect(textOf('recommendation-status')).toMatch(/Sin lote publicado/);

  // A failed read keeps its own message and adds no suggestion.
  await choose('05102');
  fetchStub.answer(latestUrl('05102'), { code: 'storage_unavailable' }, 500);
  fetchStub.answer(historyUrl('05102'), []);
  await settle();
  expect(listTexts('recommendation-list')).toEqual([]);
  expect(textOf('recommendation-level')).toBe('NO DISPONIBLE');
  expect(textOf('recommendation-status')).toMatch(/No se pudo consultar el lote \(HTTP 500\)/);

  // A new selection clears the previous list while the read is in flight, as the
  // rest of the card does, and does not keep a stale batch's suggestions.
  await choose('05101');
  expect(listTexts('recommendation-list')).toEqual([]);
  await serveZone('05101', batch('05101', 'b3', 'j3', { risk_level: 'medio' }), 200, [batch('05101')]);
  expect(listTexts('recommendation-list').length).toBeGreaterThan(0);
  await choose('05102');
  expect(listTexts('recommendation-list')).toEqual([]);
  await serveZone('05102', batch('05102', 'b4', 'j4', { risk_level: 'medio' }), 200, [batch('05102')]);

  // Closing the session drops the list and the state it described.
  await logOut();
  expect(listTexts('recommendation-list')).toEqual([]);
  expect(textOf('recommendation-level')).toBe('SIN CONSULTAR');
  expect(textOf('recommendation-status')).toMatch(/Conecta un token autorizado para ver las recomendaciones/);
});

test('a synthetic batch is marked and an unverified one is not called synthetic (PM-18)', async () => {
  await openSignedIn();
  await serveCatalogue(catalogue([feature('05101', 'Valparaíso'), feature('05102', 'Casablanca')]));
  await serveZone('05101', batch('05101', 'b', 'j', { demo: true }), 200, [batch('05101')]);

  expect(textOf('recommendation-notices')).toMatch(/Entorno sintético: no riesgo real observado\./);
  expect(listTexts('recommendation-list').length).toBeGreaterThan(0);

  await choose('05102');
  await serveZone(
    '05102',
    batch('05102', 'b2', 'j2', { demo: false, risk_level: 'medio' }),
    200,
    [batch('05102')],
  );
  // An undeclared synthetic origin is not a claim of real data either: the panel
  // repeats only what the payload declared.
  expect(textOf('recommendation-notices')).not.toMatch(/Entorno sintético/);
  expect(textOf('batch-origin')).toMatch(/discrepante/);
  expect(listTexts('recommendation-list').length).toBeGreaterThan(0);
});

test('R-05 is offered as a consultable item, never as a finding of the zone (PM-18)', async () => {
  await openSignedIn();
  await serveCatalogue(catalogue([feature('05101', 'Valparaíso')]));
  await serveZone('05101', batch('05101'), 200, [batch('05101')]);

  const reference =
    'Si ves vegetación en contacto con líneas eléctricas, avisa a la empresa distribuidora; no intervengas tú esa vegetación.';
  expect(textOf('recommendation-reference-text')).toBe(reference);
  expect(textOf('recommendation-reference')).toMatch(/no es un hallazgo/i);
  // It is outside the composition list and never displaces one of its items.
  expect(textOf('recommendation-list')).not.toContain(reference);
  expect(listTexts('recommendation-list')).toEqual([
    'FACTOR En días calurosos, evita herramientas y trabajos que generen chispas al aire libre, sobre todo cerca de vegetación.',
    'NIVEL Restringe fogatas, parrillas, quema de desechos y otras fuentes de calor cerca de vegetación.',
    'NIVEL Coordina con la municipalidad o la junta de vecinos una revisión del entorno y de las vías de salida.',
  ]);
});

test('suggesting creates nothing: no mutating request and no prevention read (PM-18)', async () => {
  await openSignedIn();
  await serveCatalogue(catalogue([feature('05101', 'Valparaíso'), feature('05102', 'Casablanca')]));
  await serveZone('05101', batch('05101'), 200, [batch('05101')]);
  expect(listTexts('recommendation-list').length).toBeGreaterThan(0);

  const before = fetchStub.calls.length;

  // The only trigger is the reader's own selection.
  await choose('05102');
  await serveZone('05102', batch('05102', 'b2', 'j2', { risk_level: 'medio' }), 200, [batch('05102')]);
  expect(listTexts('recommendation-list').length).toBeGreaterThan(0);

  const issued = fetchStub.calls.slice(before);
  expect(issued.length).toBe(2);
  expect(issued.map(call => call.url)).toEqual([latestUrl('05102'), historyUrl('05102')]);
  for (const call of issued) {
    expect((call.init.method ?? 'GET').toUpperCase()).toMatch(/^(GET|HEAD)$/);
    expect(call.url).not.toMatch(/\/v1\/prevention/);
    expect(call.url).not.toMatch(/actions/);
  }
  // Nothing anywhere in the session was written: every request was a read.
  for (const call of fetchStub.calls) {
    expect((call.init.method ?? 'GET').toUpperCase()).toMatch(/^(GET|HEAD)$/);
  }
});
