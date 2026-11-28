import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { gatewayOrigin, issuer, pkceTransactionKey } from '../../src/config';
import {
  compare,
  comparisonWindow,
  type ComparisonGranularity,
  type Outcome,
} from '../../src/core/api';
import { completeLogin, resetSession } from '../../src/core/session';
import { CompareView } from '../../src/views/CompareView';

import { createFetchStub, createStorageStub, flush, jwt } from '../core/harness';

// PM-05 — the zone comparator. Two levels are exercised here because the route
// has two obligations that fail in different places:
//
//   1. the transport: one request for two or three DISTINCT zones, a closed body
//      and an echo that matches the question that was asked;
//   2. the view: the selection order is the comparison axis, a null assessment is
//      stated instead of invented, an empty answer is an answer, a transport
//      failure stays inside the panel, and no priority axis is offered while
//      PM-11 has no accepted weights.
//
// `fetch` is stubbed end to end, so no test can substitute a fixture when the
// read fails.

const TOKEN_URL = `${issuer}/protocol/openid-connect/token`;
const CATALOGUE_URL = `${gatewayOrigin}/v1/prevention/observations/zones`;
const COMPARE_PREFIX = `${gatewayOrigin}/v1/risk/compare`;

const WINDOW = { from: '2026-11-01T00:00:00Z', to: '2026-11-03T00:00:00Z' };

const CATALOGUE = [
  { code: '05101', name: 'Valparaíso', province: 'Valparaíso' },
  { code: '05201', name: 'Viña del Mar', province: 'Valparaíso' },
  { code: '05301', name: 'Quilpué', province: 'Marga Marga' },
];

function prepare(): ReturnType<typeof createStorageStub> & ReturnType<typeof createFetchStub> {
  const fetchStub = createFetchStub();
  const storageStub = createStorageStub();
  vi.stubGlobal('fetch', fetchStub.fetch);
  vi.stubGlobal('sessionStorage', storageStub.storage);
  return { ...fetchStub, ...storageStub };
}

// The contract declares `batch_id` as `format: uuid`, so the fixtures carry real
// UUIDs instead of a readable alias: a fixture that the contract would refuse
// cannot stand for a valid answer.
function batchId(seed: string): string {
  let hash = 0;
  for (const character of seed) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  const hex = hash.toString(16).padStart(8, '0').slice(-8);
  return `${hex}-aaaa-4${hex.slice(0, 3)}-8${hex.slice(3, 6)}-${hex}${hex.slice(0, 4)}`;
}

function assessment(code: string, level: string): Record<string, unknown> {
  return {
    batch_id: batchId(code),
    requested_at: '2026-11-02T08:00:00Z',
    published_at: '2026-11-02T08:05:00Z',
    risk_level: level,
    factors: [
      { name: 'temperatura', known: true, value: 31, contribution: 0.4 },
      { name: 'humedad', known: true, value: 18, contribution: 0.2 },
    ],
    model_version: 'academic-rule-v1',
    synthetic: true,
  };
}

function point(code: string, bucketStart: string, level: string): Record<string, unknown> {
  return {
    bucket_start: bucketStart,
    batch_id: batchId(`${code}-${bucketStart}`),
    requested_at: bucketStart,
    published_at: bucketStart,
    risk_level: level,
    model_version: 'academic-rule-v1',
    synthetic: true,
  };
}

// One zone axis with a real assessment and two buckets in the window.
function zone(code: string, level = 'alto'): Record<string, unknown> {
  return {
    zone_id: code,
    assessment: assessment(code, level),
    history: [
      point(code, '2026-11-01T00:00:00Z', 'medio'),
      point(code, '2026-11-02T00:00:00Z', level),
    ],
  };
}

// A zone the catalogue holds but that never published: the route answers null,
// and the view must state that instead of inventing a level.
function emptyZone(code: string): Record<string, unknown> {
  return { zone_id: code, assessment: null, history: [] };
}

// The accepted window, granularity and zone order, echoed the way the route
// echoes them: built from the request that was actually sent.
function collectionFor(request: URL, zones: unknown[]): Record<string, unknown> {
  return {
    from: request.searchParams.get('from'),
    to: request.searchParams.get('to'),
    granularity: request.searchParams.get('granularity'),
    zones,
  };
}

function expectFailure<T>(outcome: Outcome<T>) {
  if (outcome.ok) throw new Error('expected a failure outcome');
  return outcome.failure;
}

// --- transport ------------------------------------------------------------

test('a two-zone comparison is one request that keeps the requested order', async () => {
  const fetchStub = prepare();
  const read = compare({ zoneIds: ['05101', '05201'], granularity: 'day', ...WINDOW });
  await flush();

  expect(fetchStub.calls).toHaveLength(1);
  const url = new URL(fetchStub.calls[0].url);
  expect(url.pathname).toBe('/v1/risk/compare');
  expect(url.searchParams.get('zone_ids')).toBe('05101,05201');
  expect(url.searchParams.get('granularity')).toBe('day');
  expect(url.searchParams.get('from')).toBe(WINDOW.from);
  expect(url.searchParams.get('to')).toBe(WINDOW.to);

  fetchStub.answer(fetchStub.calls[0].url, collectionFor(url, [zone('05101'), zone('05201')]));
  const outcome = await read;
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return;
  expect(outcome.data.zones.map(entry => entry.zone_id)).toEqual(['05101', '05201']);
  // Still one read: the comparison is never one request per zone.
  expect(fetchStub.calls).toHaveLength(1);
});

test('a three-zone comparison keeps the caller order instead of sorting it', async () => {
  const fetchStub = prepare();
  const read = compare({ zoneIds: ['05301', '05101', '05201'], granularity: 'week', ...WINDOW });
  await flush();

  const url = new URL(fetchStub.calls[0].url);
  expect(url.searchParams.get('zone_ids')).toBe('05301,05101,05201');
  fetchStub.answer(
    fetchStub.calls[0].url,
    collectionFor(url, [zone('05301', 'medio'), zone('05101'), zone('05201', 'bajo')]),
  );
  const outcome = await read;
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return;
  expect(outcome.data.zones.map(entry => entry.zone_id)).toEqual(['05301', '05101', '05201']);
  expect(outcome.data.zones.map(entry => entry.assessment?.risk_level)).toEqual(['medio', 'alto', 'bajo']);
});

test('a null assessment is a valid answer: no level is invented for it', async () => {
  const fetchStub = prepare();
  const read = compare({ zoneIds: ['05101', '05201'], granularity: 'day', ...WINDOW });
  await flush();
  const url = new URL(fetchStub.calls[0].url);
  fetchStub.answer(fetchStub.calls[0].url, collectionFor(url, [emptyZone('05101'), zone('05201')]));

  const outcome = await read;
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return;
  expect(outcome.data.zones[0].assessment).toBeNull();
  expect(outcome.data.zones[0].history).toEqual([]);
});

test('the window is the endpoint cap: 48 hours for hour and 31 days for day and week', () => {
  const now = new Date('2026-11-25T12:00:00Z');

  expect(comparisonWindow('hour', now)).toEqual({ from: '2026-11-23T12:00:00.000Z', to: '2026-11-25T12:00:00.000Z' });
  expect(comparisonWindow('day', now)).toEqual({ from: '2026-10-25T12:00:00.000Z', to: '2026-11-25T12:00:00.000Z' });
  expect(comparisonWindow('week', now)).toEqual({ from: '2026-10-25T12:00:00.000Z', to: '2026-11-25T12:00:00.000Z' });
});

test('a list of the wrong size or with a duplicate is refused before anything is read', async () => {
  const fetchStub = prepare();

  const one = expectFailure(await compare({ zoneIds: ['05101'], granularity: 'day', ...WINDOW }));
  const four = expectFailure(
    await compare({ zoneIds: ['05101', '05201', '05301', '05401'], granularity: 'day', ...WINDOW }),
  );
  const duplicate = expectFailure(await compare({ zoneIds: ['05101', '05101'], granularity: 'day', ...WINDOW }));
  const empty = expectFailure(await compare({ zoneIds: ['05101', ''], granularity: 'day', ...WINDOW }));

  for (const failure of [one, four, duplicate, empty]) {
    expect(failure.kind).toBe('malformed');
    expect(failure.reason).toBe('invalid_comparison_request');
  }
  expect(fetchStub.calls).toHaveLength(0);
});

test('a granularity outside the closed vocabulary is refused before anything is read', async () => {
  const fetchStub = prepare();
  const failure = expectFailure(
    await compare({
      zoneIds: ['05101', '05201'],
      granularity: 'month' as unknown as ComparisonGranularity,
      ...WINDOW,
    }),
  );

  expect(failure.reason).toBe('invalid_comparison_request');
  expect(fetchStub.calls).toHaveLength(0);
});

test('an empty or reversed window is refused before anything is read', async () => {
  const fetchStub = prepare();
  const reversed = expectFailure(
    await compare({ zoneIds: ['05101', '05201'], granularity: 'day', from: WINDOW.to, to: WINDOW.from }),
  );
  const unreadable = expectFailure(
    await compare({ zoneIds: ['05101', '05201'], granularity: 'day', from: 'ayer', to: WINDOW.to }),
  );

  expect(reversed.reason).toBe('invalid_comparison_request');
  expect(unreadable.reason).toBe('invalid_comparison_request');
  expect(fetchStub.calls).toHaveLength(0);
});

// The request window is `format: date-time` on both ends (SeriesFrom/SeriesTo),
// which is RFC 3339: an instant names its offset, and a spelling Date.parse
// happens to tolerate is not an instant the contract declares.
test('a window instant that is not RFC 3339 is refused before anything is read', async () => {
  const fetchStub = prepare();
  const slashedRead = compare({ zoneIds: ['05101', '05201'], granularity: 'day', from: '01/02/2026', to: WINDOW.to });
  const withoutOffsetRead = compare({
    zoneIds: ['05101', '05201'],
    granularity: 'day',
    from: '2026-11-01T00:00:00',
    to: WINDOW.to,
  });

  // The guard answers locally, so a refused window costs no request.
  await flush();
  expect(fetchStub.calls).toHaveLength(0);

  for (const failure of [expectFailure(await slashedRead), expectFailure(await withoutOffsetRead)]) {
    expect(failure.kind).toBe('malformed');
    expect(failure.reason).toBe('invalid_comparison_request');
  }
});

// RFC 3339 spells a civil date, so a well-shaped date the calendar does not hold
// is not an instant: `Date.parse` rolls `2026-02-31` into March, which would
// accept a window the route never serves and an echo that names another day.
test('a well-shaped but impossible civil date is refused, not rolled into the next month', async () => {
  const fetchStub = prepare();

  const impossibleFrom = compare({
    zoneIds: ['05101', '05201'],
    granularity: 'day',
    from: '2026-02-31T00:00:00Z',
    to: WINDOW.to,
  });
  const impossibleTo = compare({
    zoneIds: ['05101', '05201'],
    granularity: 'day',
    from: WINDOW.from,
    to: '2026-02-31T00:00:00Z',
  });

  // The guard answers locally, so an impossible window costs no request.
  await flush();
  expect(fetchStub.calls).toHaveLength(0);

  for (const failure of [expectFailure(await impossibleFrom), expectFailure(await impossibleTo)]) {
    expect(failure.kind).toBe('malformed');
    expect(failure.reason).toBe('invalid_comparison_request');
  }

  // The same impossible date inside the body refuses the whole answer.
  async function readWith(build: (url: URL) => unknown) {
    const read = compare({ zoneIds: ['05101', '05201'], granularity: 'day', ...WINDOW });
    await flush();
    const url = new URL(fetchStub.calls[fetchStub.calls.length - 1].url);
    fetchStub.answer(url.toString(), build(url));
    return read;
  }

  const impossibleAssessment = expectFailure(
    await readWith(url =>
      collectionFor(url, [
        {
          ...zone('05101'),
          assessment: { ...assessment('05101', 'alto'), requested_at: '2026-02-31T00:00:00Z' },
        },
        zone('05201'),
      ]),
    ),
  );
  const impossibleBucket = expectFailure(
    await readWith(url =>
      collectionFor(url, [
        {
          ...zone('05101'),
          history: [
            { ...point('05101', '2026-11-01T00:00:00Z', 'medio'), bucket_start: '2026-02-31T00:00:00Z' },
          ],
        },
        zone('05201'),
      ]),
    ),
  );

  for (const failure of [impossibleAssessment, impossibleBucket]) {
    expect(failure.kind).toBe('malformed');
    expect(failure.reason).toBe('invalid_shape');
  }
});

// `batch_id` is `format: uuid` in ComparisonAssessment and HistoryBucket, while
// `zone_id` is deliberately a plain catalogue code: the guard enforces the first
// and must not invent the second.
test('a batch id that is not a UUID is refused, while a zone code stays any catalogue string', async () => {
  const fetchStub = prepare();

  async function readWith(zoneIds: string[], build: (url: URL) => unknown) {
    const read = compare({ zoneIds, granularity: 'day', ...WINDOW });
    await flush();
    const url = new URL(fetchStub.calls[fetchStub.calls.length - 1].url);
    fetchStub.answer(url.toString(), build(url));
    return read;
  }

  const aliasInAssessment = expectFailure(
    await readWith(['05101', '05201'], url =>
      collectionFor(url, [
        { ...zone('05101'), assessment: { ...assessment('05101', 'alto'), batch_id: 'lote-demo' } },
        zone('05201'),
      ]),
    ),
  );
  const aliasInBucket = expectFailure(
    await readWith(['05101', '05201'], url =>
      collectionFor(url, [
        {
          ...zone('05101'),
          history: [{ ...point('05101', '2026-11-01T00:00:00Z', 'medio'), batch_id: 'lote-demo' }],
        },
        zone('05201'),
      ]),
    ),
  );

  for (const failure of [aliasInAssessment, aliasInBucket]) {
    expect(failure.kind).toBe('malformed');
    expect(failure.reason).toBe('invalid_shape');
  }

  // A slug the catalogue happens to hold is a legal zone_id: no format is
  // declared for it, so none is imposed.
  const slug = await readWith(['valparaiso-demo', '05201'], url =>
    collectionFor(url, [zone('valparaiso-demo'), zone('05201')]),
  );
  expect(slug.ok).toBe(true);
});

test('a body whose instants are not RFC 3339 is refused whole', async () => {
  const fetchStub = prepare();

  async function readWith(build: (url: URL) => unknown) {
    const read = compare({ zoneIds: ['05101', '05201'], granularity: 'day', ...WINDOW });
    await flush();
    const url = new URL(fetchStub.calls[fetchStub.calls.length - 1].url);
    fetchStub.answer(url.toString(), build(url));
    return read;
  }

  const slashed = expectFailure(
    await readWith(url =>
      collectionFor(url, [
        { ...zone('05101'), assessment: { ...assessment('05101', 'alto'), requested_at: '02/11/2026' } },
        zone('05201'),
      ]),
    ),
  );
  const withoutOffset = expectFailure(
    await readWith(url =>
      collectionFor(url, [
        {
          ...zone('05101'),
          history: [{ ...point('05101', '2026-11-01T00:00:00Z', 'medio'), bucket_start: '2026-11-01T00:00:00' }],
        },
        zone('05201'),
      ]),
    ),
  );

  for (const failure of [slashed, withoutOffset]) {
    expect(failure.kind).toBe('malformed');
    expect(failure.reason).toBe('invalid_shape');
  }
});

test('a body the contract does not declare is refused whole, never partially rendered', async () => {
  const fetchStub = prepare();

  async function readWith(mutate: (url: URL) => unknown) {
    const read = compare({ zoneIds: ['05101', '05201'], granularity: 'day', ...WINDOW });
    await flush();
    const url = new URL(fetchStub.calls[fetchStub.calls.length - 1].url);
    fetchStub.answer(url.toString(), mutate(url));
    return read;
  }

  const valid = (url: URL): Record<string, unknown> => collectionFor(url, [zone('05101'), zone('05201')]);

  const bareObject = expectFailure(await readWith(() => ({})));
  const priorityMember = expectFailure(
    await readWith(url => ({ ...valid(url), priority: 0.42 })),
  );
  const unknownMember = expectFailure(
    await readWith(url => ({
      ...valid(url),
      zones: [{ ...zone('05101'), priority: 0.42 }, zone('05201')],
    })),
  );
  const nullHistory = expectFailure(
    await readWith(url => ({ ...valid(url), zones: [{ ...zone('05101'), history: null }, zone('05201')] })),
  );
  const unknownLevel = expectFailure(
    await readWith(url => ({ ...valid(url), zones: [zone('05101', 'extremo'), zone('05201')] })),
  );
  const unnamedFactor = expectFailure(
    await readWith(url => ({
      ...valid(url),
      zones: [
        {
          ...zone('05101'),
          assessment: { ...assessment('05101', 'alto'), factors: ['temperatura'] },
        },
        zone('05201'),
      ],
    })),
  );

  for (const failure of [bareObject, priorityMember, unknownMember, nullHistory, unknownLevel, unnamedFactor]) {
    expect(failure.kind).toBe('malformed');
    expect(failure.reason).toBe('invalid_shape');
  }
});

test('an echo of another window, granularity or zone order is discarded as malformed', async () => {
  const fetchStub = prepare();

  async function readWith(build: (url: URL) => unknown) {
    const read = compare({ zoneIds: ['05101', '05201'], granularity: 'day', ...WINDOW });
    await flush();
    const url = new URL(fetchStub.calls[fetchStub.calls.length - 1].url);
    fetchStub.answer(url.toString(), build(url));
    return read;
  }

  const otherWindow = expectFailure(
    await readWith(url => ({
      ...collectionFor(url, [zone('05101'), zone('05201')]),
      from: '2026-10-01T00:00:00Z',
    })),
  );
  const otherBearing = expectFailure(
    await readWith(url => ({
      ...collectionFor(url, [zone('05101'), zone('05201')]),
      to: '2026-11-04T00:00:00Z',
    })),
  );
  const otherGranularity = expectFailure(
    await readWith(url => ({
      ...collectionFor(url, [zone('05101'), zone('05201')]),
      granularity: 'week',
    })),
  );
  const otherOrder = expectFailure(
    await readWith(url => collectionFor(url, [zone('05201'), zone('05101')])),
  );
  // A body that echoes only one of the two requested zones is an echo of another
  // comparison, not a partially valid answer.
  const missingZone = expectFailure(
    await readWith(url => collectionFor(url, [zone('05101')])),
  );

  for (const failure of [otherWindow, otherBearing, otherGranularity, otherOrder, missingZone]) {
    expect(failure.kind).toBe('malformed');
    expect(failure.reason).toBe('comparison_echo_mismatch');
  }
});

test('an HTTP refusal is a stated failure with its server code, never a value', async () => {
  const fetchStub = prepare();
  const read = compare({ zoneIds: ['05101', '05201'], granularity: 'day', ...WINDOW });
  await flush();
  fetchStub.answer(fetchStub.calls[0].url, { code: 'invalid_zone' }, 400);

  const failure = expectFailure(await read);
  expect(failure.kind).toBe('malformed');
  expect(failure.reason).toBe('invalid_zone');
  expect(failure.status).toBe(400);
});

// --- view -----------------------------------------------------------------

interface CompareDouble {
  requests: URL[];
  pending: () => number;
  answer: (build: (request: URL, requestZones: string[]) => unknown) => void;
  fail: (status: number, body: unknown) => void;
}

// The compare read is the one request whose URL the view builds from the current
// clock, so the double echoes from the request that actually arrived instead of
// from a window the test guessed.
function serveCompare(fetchStub: ReturnType<typeof createFetchStub>): CompareDouble {
  const requests: URL[] = [];
  const pending: { request: URL; resolve: (response: Response) => void }[] = [];
  const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = String(input);
    if (!raw.startsWith(COMPARE_PREFIX)) return fetchStub.fetch(input, init);
    const request = new URL(raw);
    requests.push(request);
    return new Promise<Response>(resolve => {
      pending.push({
        request,
        resolve: response => resolve(response),
      });
    });
  };
  vi.stubGlobal('fetch', fetch);
  return {
    requests,
    pending: () => pending.length,
    answer(build) {
      const entry = pending.shift();
      if (!entry) throw new Error('no pending comparison request');
      const codes = (entry.request.searchParams.get('zone_ids') ?? '').split(',');
      entry.resolve(
        new Response(JSON.stringify(build(entry.request, codes)), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    },
    fail(status, body) {
      const entry = pending.shift();
      if (!entry) throw new Error('no pending comparison request');
      entry.resolve(
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
      );
    },
  };
}

async function connect(): Promise<ReturnType<typeof createFetchStub>> {
  const context = prepare();
  const token = jwt({ realm_access: { roles: ['viewer'] } });
  context.storage.setItem(pkceTransactionKey, JSON.stringify({ state: 's', verifier: 'v' }));
  const login = completeLogin('?code=code-1&state=s');
  await flush();
  context.answer(TOKEN_URL, { access_token: token });
  await login;
  context.calls.length = 0;
  return context;
}

function picker(): HTMLSelectElement {
  return document.getElementById('compare-zone-picker') as HTMLSelectElement;
}
function stateLine(): HTMLElement {
  return document.getElementById('compare-state') as HTMLElement;
}
function zoneBodies(): Element[] {
  return [...document.querySelectorAll('#compare-zones .compare-zone')];
}

// Renders the view with a connected session and the catalogue answered, which is
// the only state in which the picker can add a zone.
async function mountWithCatalogue() {
  const fetchStub = await connect();
  const compareDouble = serveCompare(fetchStub);
  render(<CompareView />);
  await waitFor(() => expect(fetchStub.callsFor(CATALOGUE_URL)).toHaveLength(1));
  fetchStub.answer(CATALOGUE_URL, CATALOGUE);
  await waitFor(() => expect(picker()).not.toBeDisabled());
  return { fetchStub, compareDouble };
}

beforeEach(() => {
  resetSession();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('without a session the comparator asks to connect and issues no read', async () => {
  const fetchStub = prepare();
  const compareDouble = serveCompare(fetchStub);
  render(<CompareView />);

  expect(stateLine()).toHaveTextContent('Conecta un token autorizado para comparar las zonas.');
  expect(document.getElementById('compare')?.getAttribute('data-view')).toBe('compare');
  expect(document.getElementById('compare-title')?.textContent).toBe('Comparador de zonas');
  expect(fetchStub.callsFor(CATALOGUE_URL)).toHaveLength(0);
  expect(compareDouble.requests).toHaveLength(0);
});

test('with fewer than two zones the view asks for a second one and issues no comparison', async () => {
  const { compareDouble } = await mountWithCatalogue();

  expect(stateLine()).toHaveTextContent('Elige al menos dos zonas');

  fireEvent.change(picker(), { target: { value: '05101' } });
  await flush();

  expect(stateLine()).toHaveTextContent('Elige al menos dos zonas');
  expect(compareDouble.requests).toHaveLength(0);
});

test('two zones are compared by one call and rendered in the chosen order', async () => {
  const { compareDouble } = await mountWithCatalogue();

  fireEvent.change(picker(), { target: { value: '05201' } });
  fireEvent.change(picker(), { target: { value: '05101' } });
  await waitFor(() => expect(compareDouble.pending()).toBe(1));

  expect(compareDouble.requests).toHaveLength(1);
  expect(compareDouble.requests[0].searchParams.get('zone_ids')).toBe('05201,05101');
  expect(screen.getByText('Comparando las zonas seleccionadas…')).toBeInTheDocument();

  compareDouble.answer((request, codes) =>
    collectionFor(request, codes.map((code, index) => zone(code, index === 0 ? 'medio' : 'alto'))),
  );
  await waitFor(() => expect(zoneBodies()).toHaveLength(2));

  expect(zoneBodies().map(node => node.getAttribute('data-zone'))).toEqual(['05201', '05101']);
  expect(zoneBodies()[0]).toHaveTextContent('Viña del Mar · 05201');
  expect(zoneBodies()[1]).toHaveTextContent('Valparaíso · 05101');
  // The variables of the stored assessment and its buckets are both rendered.
  expect(zoneBodies()[0]).toHaveTextContent('temperatura · valor 31 · contribución 0.4');
  expect(zoneBodies()[0].querySelectorAll('.compare-history tbody tr')).toHaveLength(2);
  expect(zoneBodies()[0]).toHaveTextContent('2026-11-01T00:00:00Z');
  expect(stateLine()).toHaveTextContent('Comparación devuelta por la API para 2 zonas.');
  // One call, not one per zone.
  expect(compareDouble.requests).toHaveLength(1);
});

test('three zones are compared in the chosen order and a fourth cannot be added', async () => {
  const { compareDouble } = await mountWithCatalogue();

  // Each settled selection is one comparison and costs exactly one read: the
  // first two zones, then the three-zone comparison the reader asked for.
  fireEvent.change(picker(), { target: { value: '05301' } });
  fireEvent.change(picker(), { target: { value: '05101' } });
  await waitFor(() => expect(compareDouble.pending()).toBe(1));
  expect(compareDouble.requests).toHaveLength(1);
  compareDouble.answer((request, codes) => collectionFor(request, codes.map(code => zone(code))));
  await waitFor(() => expect(zoneBodies()).toHaveLength(2));

  fireEvent.change(picker(), { target: { value: '05201' } });
  await waitFor(() => expect(compareDouble.pending()).toBe(1));
  expect(compareDouble.requests).toHaveLength(2);
  expect(compareDouble.requests[1].searchParams.get('zone_ids')).toBe('05301,05101,05201');
  expect(picker()).toBeDisabled();
  expect(screen.getByRole('button', { name: /quitar quilpué · 05301/i })).toBeInTheDocument();

  compareDouble.answer((request, codes) => collectionFor(request, codes.map(code => zone(code))));
  await waitFor(() => expect(zoneBodies()).toHaveLength(3));
  expect(zoneBodies().map(node => node.getAttribute('data-zone'))).toEqual(['05301', '05101', '05201']);
});

test('re-adding the last removed zone reads again instead of reusing the previous answer', async () => {
  const { compareDouble } = await mountWithCatalogue();

  fireEvent.change(picker(), { target: { value: '05101' } });
  fireEvent.change(picker(), { target: { value: '05201' } });
  await waitFor(() => expect(compareDouble.pending()).toBe(1));
  compareDouble.answer((request, codes) => collectionFor(request, codes.map(code => zone(code))));
  await waitFor(() => expect(zoneBodies()).toHaveLength(2));

  fireEvent.change(picker(), { target: { value: '05301' } });
  await waitFor(() => expect(compareDouble.pending()).toBe(1));
  compareDouble.answer((request, codes) => collectionFor(request, codes.map(code => zone(code))));
  await waitFor(() => expect(zoneBodies()).toHaveLength(3));
  expect(stateLine()).toHaveTextContent('Comparación devuelta por la API para 3 zonas.');

  // Removing the third zone poses the two-zone question, and re-adding it poses
  // the three-zone question again: the previous three-zone answer is not an
  // answer to the new read, so it cannot be painted while that read is in flight.
  fireEvent.click(screen.getByRole('button', { name: /quitar quilpué · 05301/i }));
  await waitFor(() => expect(compareDouble.requests).toHaveLength(3));

  fireEvent.change(picker(), { target: { value: '05301' } });
  await waitFor(() => expect(compareDouble.requests).toHaveLength(4));

  expect(compareDouble.requests[3].searchParams.get('zone_ids')).toBe('05101,05201,05301');
  expect(stateLine()).toHaveTextContent('Comparando las zonas seleccionadas…');
  expect(stateLine()).not.toHaveTextContent('Comparación devuelta');
  expect(zoneBodies()).toHaveLength(0);
});

test('a zone without a published assessment says so instead of inventing a level', async () => {
  const { compareDouble } = await mountWithCatalogue();

  fireEvent.change(picker(), { target: { value: '05101' } });
  fireEvent.change(picker(), { target: { value: '05201' } });
  await waitFor(() => expect(compareDouble.pending()).toBe(1));
  compareDouble.answer(request => collectionFor(request, [emptyZone('05101'), zone('05201')]));
  await waitFor(() => expect(zoneBodies()).toHaveLength(2));

  const absent = zoneBodies()[0];
  expect(absent).toHaveTextContent('Sin evaluación publicada.');
  expect(absent.querySelector('.chip')).toBeNull();
  expect(absent).toHaveTextContent('Sin publicaciones en la ventana consultada.');
  expect(absent).not.toHaveTextContent('BAJO');
  expect(absent).not.toHaveTextContent('INFORMACIÓN INSUFICIENTE');
  expect(zoneBodies()[1].querySelector('.chip')).toHaveTextContent('ALTO');
});

test('an empty comparison is an answer and is stated as one', async () => {
  const { compareDouble } = await mountWithCatalogue();

  fireEvent.change(picker(), { target: { value: '05101' } });
  fireEvent.change(picker(), { target: { value: '05201' } });
  await waitFor(() => expect(compareDouble.pending()).toBe(1));
  compareDouble.answer(request => collectionFor(request, [emptyZone('05101'), emptyZone('05201')]));
  await waitFor(() => expect(zoneBodies()).toHaveLength(2));

  expect(stateLine()).toHaveTextContent(
    'La API no devolvió evaluación ni historial para las zonas comparadas en esta ventana.',
  );
  expect(stateLine()).not.toHaveTextContent('Comparación devuelta');
});

test('a transport failure stays inside the panel and says what happened', async () => {
  const { compareDouble } = await mountWithCatalogue();

  fireEvent.change(picker(), { target: { value: '05101' } });
  fireEvent.change(picker(), { target: { value: '05201' } });
  await waitFor(() => expect(compareDouble.pending()).toBe(1));
  compareDouble.fail(503, { code: 'storage_unavailable' });
  await waitFor(() => expect(stateLine()).toHaveTextContent('storage_unavailable'));

  expect(stateLine()).toHaveTextContent('HTTP 503');
  expect(stateLine()).toHaveTextContent('El almacenamiento de riesgo no está disponible');
  // The failure does not take the page down: the view and its controls are
  // still rendered, and a retry is offered.
  expect(document.getElementById('compare-title')).not.toBeNull();
  expect(document.getElementById('compare-retry')).not.toBeNull();
  expect(zoneBodies()).toHaveLength(0);
});

test('no priority axis is offered, and the view says when it will arrive', async () => {
  const { compareDouble } = await mountWithCatalogue();

  fireEvent.change(picker(), { target: { value: '05101' } });
  fireEvent.change(picker(), { target: { value: '05201' } });
  await waitFor(() => expect(compareDouble.pending()).toBe(1));
  compareDouble.answer((request, codes) => collectionFor(request, codes.map(code => zone(code))));
  await waitFor(() => expect(zoneBodies()).toHaveLength(2));

  // No fourth axis: no column, no label, no empty measure.
  expect(screen.queryByRole('columnheader', { name: /prioridad/i })).toBeNull();
  expect(screen.queryByRole('heading', { name: /prioridad/i })).toBeNull();
  expect(document.querySelector('#compare-zones')?.textContent).not.toMatch(/prioridad/i);

  // The absence is declared in writing, with the dependency that would change it.
  const note = document.querySelector('#compare .unimplemented-note');
  expect(note).not.toBeNull();
  expect(note).toHaveTextContent(/prioridad/i);
  expect(note).toHaveTextContent(/PM-11/);
  expect(note).toHaveTextContent(/pesos aceptados/i);
});

test('the catalogue is the real one, and a failed catalogue read is stated', async () => {
  const fetchStub = await connect();
  render(<CompareView />);
  await waitFor(() => expect(fetchStub.callsFor(CATALOGUE_URL)).toHaveLength(1));

  expect(picker()).toBeDisabled();
  fetchStub.answer(CATALOGUE_URL, [], 403);
  await waitFor(() => expect(document.getElementById('compare-catalogue-status')).toHaveTextContent('403'));

  expect(document.getElementById('compare-catalogue-status')).toHaveTextContent(
    'La API denegó el permiso para leer el catálogo de zonas',
  );
  expect(picker()).toBeDisabled();
  expect(document.getElementById('compare-catalogue-retry')).not.toBeNull();
});

// ── T4 · the approved board's selection/reading split ──────────────────────
//
// `design/firewatch-v1-vuelo/08-comparar-sectores.html` puts the selection in a
// narrow panel on the left and the compared reading in the panel beside it. The
// port keeps the production contracts: the two zones are still chosen from the
// real catalogue, the window is still the endpoint's own cap, and every control
// and status identifier this suite already reads keeps working.

test('the comparator reads as the board: a selection panel beside the reading panel', async () => {
  const { fetchStub, compareDouble } = await mountWithCatalogue();

  const view = document.getElementById('compare') as HTMLElement;
  const layout = view.querySelector('.compare-layout');
  expect(layout).not.toBeNull();
  const panels = [...(layout?.children ?? [])];
  expect(panels).toHaveLength(2);
  expect(panels[0].tagName).toBe('ARTICLE');
  expect(panels[1].tagName).toBe('ARTICLE');
  expect(panels[0].classList.contains('compare-panel')).toBe(true);
  expect(panels[1].classList.contains('compare-panel')).toBe(true);

  // The board's two headings, one per panel, under the view's own title.
  expect(screen.getByRole('heading', { level: 3, name: 'Elige 2 o 3 zonas' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 3, name: 'Riesgo, variables e historial' })).toBeInTheDocument();

  // Selection side: the real catalogue picker, the order the comparison uses and
  // the catalogue's own status stay in the panel that owns them.
  expect(panels[0].querySelector('#compare-zone-picker')).not.toBeNull();
  expect(panels[0].querySelector('#compare-granularity')).not.toBeNull();
  expect(panels[0].querySelector('#compare-selection')).not.toBeNull();
  expect(panels[0].querySelector('#compare-catalogue-status')).not.toBeNull();

  // Reading side: the window, the read status and the compared zones.
  expect(panels[1].querySelector('#compare-window')).not.toBeNull();
  expect(panels[1].querySelector('#compare-state')).not.toBeNull();
  expect(panels[1].querySelector('#compare-zones')).not.toBeNull();

  fireEvent.change(picker(), { target: { value: '05101' } });
  fireEvent.change(picker(), { target: { value: '05201' } });
  await waitFor(() => expect(compareDouble.pending()).toBe(1));
  compareDouble.answer((request, codes) => collectionFor(request, codes.map(code => zone(code))));
  await waitFor(() => expect(zoneBodies()).toHaveLength(2));
  expect(document.querySelectorAll('#compare-selection li')).toHaveLength(2);
  expect(fetchStub.callsFor(CATALOGUE_URL)).toHaveLength(1);
});
