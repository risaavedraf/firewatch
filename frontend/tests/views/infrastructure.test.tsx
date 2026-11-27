// PM-11 — the synthetic infrastructure demo view.
//
// This suite drives the view through the dedicated endpoint and the visible
// contract that matters for the demo: a prominent Spanish synthetic-data label,
// the provisional one-point rule, every zone's five-key breakdown with its
// total, the fictional point/line geometries, and a dependency-free print path.
// It stubs `fetch` end to end, so a failed or malformed read is never papered
// over with fixture rows.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { routes } from '../../src/app/routes';
import { gatewayOrigin, issuer, pkceTransactionKey } from '../../src/config';
import {
  INFRASTRUCTURE_TYPES,
  parseInfrastructure,
  type InfrastructureCatalogue,
  type InfrastructureCounts,
  type InfrastructureElement,
  type InfrastructureType,
} from '../../src/core/infrastructure';
import { completeLogin, resetSession } from '../../src/core/session';
import { InfrastructureView } from '../../src/views/InfrastructureView';

import { createFetchStub, createStorageStub, flush, jwt } from '../core/harness';

const TOKEN_URL = `${issuer}/protocol/openid-connect/token`;
// The dedicated route is pinned as a literal: the view must consume exactly the
// route the PM-11 contract names, not a shape derived from another endpoint.
const INFRASTRUCTURE_URL = `${gatewayOrigin}/v1/risk/infrastructure`;
const appCss = readFileSync(resolve(process.cwd(), 'src', 'styles', 'app.css'), 'utf8');

let fetchStub: ReturnType<typeof createFetchStub>;
let storageStub: ReturnType<typeof createStorageStub>;

function prepare(): void {
  fetchStub = createFetchStub();
  storageStub = createStorageStub();
  vi.stubGlobal('fetch', fetchStub.fetch);
  vi.stubGlobal('sessionStorage', storageStub.storage);
  resetSession();
}

beforeEach(prepare);

afterEach(() => {
  vi.unstubAllGlobals();
  resetSession();
});

function counts(overrides: Partial<InfrastructureCounts> = {}): InfrastructureCounts {
  return {
    colegio: 0,
    vivienda: 0,
    hospital: 0,
    ruta: 0,
    hidrante: 0,
    ...overrides,
  };
}

function point(
  id: string,
  type: Exclude<InfrastructureType, 'ruta'>,
  lon: number,
  lat: number,
): InfrastructureElement {
  return { id, type, geometry: { type: 'Point', coordinates: [lon, lat] } };
}

function line(id: string, coordinates: Array<[number, number]>): InfrastructureElement {
  return { id, type: 'ruta', geometry: { type: 'LineString', coordinates } };
}

function fixture(): InfrastructureCatalogue {
  return {
    source: 'synthetic_fixture',
    points_per_element: 1,
    zones: [
      {
        zone_id: '05101',
        score: 5,
        counts: counts({ colegio: 1, vivienda: 1, hospital: 1, ruta: 1, hidrante: 1 }),
        elements: [
          point('colegio-1', 'colegio', -71.62, -33.05),
          point('vivienda-1', 'vivienda', -71.6, -33.03),
          point('hospital-1', 'hospital', -71.58, -33.07),
          point('hidrante-1', 'hidrante', -71.57, -33.02),
          line('ruta-1', [
            [-71.63, -33.04],
            [-71.55, -33.01],
          ]),
        ],
      },
      {
        zone_id: '05102',
        score: 1,
        counts: counts({ vivienda: 1 }),
        elements: [point('vivienda-2', 'vivienda', -71.52, -33.0)],
      },
    ],
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

async function settle(): Promise<void> {
  // Flush the transport promise AND the React state update it causes. Without
  // `act` the assertions run while the view is still painted as loading.
  await act(async () => {
    await flushMicrotasks();
  });
}

async function openSignedIn(): Promise<void> {
  storageStub.storage.setItem(pkceTransactionKey, JSON.stringify({ state: 's', verifier: 'v' }));
  const login = completeLogin('?code=c&state=s');
  await flush();
  fetchStub.answer(TOKEN_URL, {
    access_token: jwt({ realm_access: { roles: ['viewer'] } }),
    id_token: jwt({ sub: 'u' }),
  });
  await login;
  fetchStub.calls.length = 0;
  render(<InfrastructureView />);
  await settle();
}

async function serve(payload: unknown, status = 200): Promise<void> {
  // Answer INSIDE act: resolving the stub starts the transport/JSON/state chain,
  // and answering before the wrapper would update the view outside it.
  await act(async () => {
    fetchStub.answer(INFRASTRUCTURE_URL, payload, status);
    await flushMicrotasks();
  });
}

function text(id: string): string {
  return document.getElementById(id)?.textContent ?? '';
}

function rows(): Element[] {
  return [...document.querySelectorAll('#infrastructure-rows tr')];
}

test('shows a prominent Spanish synthetic-data label, the declared origin and the provisional rule', async () => {
  await openSignedIn();
  await serve(fixture());

  expect(text('infrastructure-synthetic')).toMatch(/datos sintéticos de demostración/i);
  expect(text('infrastructure-synthetic')).toMatch(/no es el catálogo real/i);
  expect(text('infrastructure-source')).toContain('synthetic_fixture');
  expect(text('infrastructure-formula')).toMatch(/un punto por elemento/i);
  expect(text('infrastructure-formula')).toMatch(/provisional/i);
  expect(text('infrastructure-formula')).toMatch(/no están aprobados/i);
});

test('reads only the dedicated endpoint with the bearer and renders every breakdown with counts and total', async () => {
  await openSignedIn();

  const calls = fetchStub.callsFor(INFRASTRUCTURE_URL);
  expect(calls).toHaveLength(1);
  const headers = (calls[0]?.init.headers ?? {}) as Record<string, string>;
  expect(headers.Authorization).toMatch(/^Bearer /);

  await serve(fixture());

  expect(rows().map(row => row.getAttribute('data-zone'))).toEqual(['05101', '05102']);
  const first = rows()[0] as HTMLElement;
  for (const type of INFRASTRUCTURE_TYPES) {
    expect(first.querySelector(`[data-count="${type}"]`)?.textContent).toBe('1');
  }
  expect(first.querySelector('[data-total]')?.textContent).toBe('5');
  expect(rows()[1]?.querySelector('[data-total]')?.textContent).toBe('1');
  expect(text('infrastructure-zone-count')).toBe('2');
  expect(text('infrastructure-element-count')).toBe('6');
  expect(text('infrastructure-point-total')).toBe('6');
  expect(document.getElementById('infrastructure-zone-05101')).not.toBeNull();
  expect(document.querySelector('#infrastructure-elements-05101 [data-element-id="ruta-1"]')).not.toBeNull();
});

test('draws the fictional points and route lines and names every type in the legend', async () => {
  await openSignedIn();
  await serve(fixture());

  const svg = document.getElementById('infrastructure-map-svg');
  expect(svg).not.toBeNull();
  expect(svg).not.toHaveAttribute('hidden');
  expect(text('infrastructure-map-desc')).toMatch(/ficticia/i);

  expect(svg?.querySelector('[data-element-id="colegio-1"]')?.tagName.toLowerCase()).toBe('rect');
  expect(svg?.querySelector('[data-element-id="vivienda-1"]')?.tagName.toLowerCase()).toBe('circle');
  expect(svg?.querySelector('[data-element-id="ruta-1"]')?.tagName.toLowerCase()).toBe('path');

  const legend = text('infrastructure-map-legend');
  for (const label of ['Colegio', 'Vivienda', 'Hospital', 'Ruta', 'Hidrante']) {
    expect(legend).toContain(label);
  }
});

// S7/S8 — «que el mapa sea interactivo como lo diseñamos, que resalte». The plate is
// now a dark cartographic surface, and the chart grid that gives it that reading is
// decoration: it carries no place, it is not announced, and it adds no focusable
// target. The figures stay the only content of the drawing.
test('the chart grid is decoration behind the figures, not a basemap or a control', async () => {
  await openSignedIn();
  await serve(fixture());

  const svg = document.getElementById('infrastructure-map-svg') as unknown as SVGSVGElement;
  const grid = svg.querySelector('.infrastructure-map-graticule');
  const shapes = svg.querySelector('.infrastructure-map-shapes');
  expect(grid).not.toBeNull();
  expect(shapes).not.toBeNull();
  expect(grid?.getAttribute('aria-hidden')).toBe('true');
  expect(grid?.querySelectorAll('line').length).toBeGreaterThan(0);
  // The grid paints first, so it can never cover a published geometry.
  expect(grid?.nextElementSibling).toBe(shapes);
  // No new target: the drawing stays a figure, and the legend/rows keep the only
  // controls of the map region.
  expect(svg.querySelectorAll('[tabindex], a, button').length).toBe(0);
});

test('prints through the browser and the print stylesheet keeps the synthetic label, formula and table', async () => {
  await openSignedIn();
  await serve(fixture());

  const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
  const button = screen.getByRole('button', { name: /imprimir/i });
  expect(button).toBeEnabled();
  fireEvent.click(button);
  expect(print).toHaveBeenCalledTimes(1);

  const start = appCss.indexOf('@media print');
  expect(start).toBeGreaterThanOrEqual(0);
  const printBlock = appCss.slice(start);
  expect(printBlock).toContain('.infrastructure-synthetic');
  expect(printBlock).toContain('.infrastructure-formula');
  expect(printBlock).toMatch(/\.infrastructure-print-action[^{]*\{[^}]*display:\s*none/);
  expect(printBlock).not.toMatch(/#infrastructure-zones[^{]*\{[^}]*display:\s*none/);
});

test('keeps printing unavailable while the catalogue is loading and after the read failed', async () => {
  const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);

  // Initial load: the read is in flight, so no runtime data exists to print.
  await openSignedIn();
  const button = screen.getByRole('button', { name: /imprimir/i });
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(print).not.toHaveBeenCalled();
  expect(text('infrastructure-empty')).toMatch(/sin catálogo cargado/i);

  // A failed read leaves the view without a catalogue; printing stays refused
  // instead of producing a page that claims the demo was received.
  await serve({ code: 'forbidden' }, 403);
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(print).not.toHaveBeenCalled();
  expect(text('infrastructure-empty')).toMatch(/sin catálogo disponible/i);
});

test('states a denied read explicitly and renders no invented rows', async () => {
  await openSignedIn();
  await serve({ code: 'forbidden' }, 403);

  expect(text('infrastructure-status')).toMatch(/403|permiso/i);
  expect(rows()).toHaveLength(0);
  expect(document.getElementById('infrastructure-synthetic')).not.toBeNull();
  expect(text('infrastructure-zone-count')).toBe('—');
});

test('refuses a payload whose breakdown is incomplete or whose score is not the one-point total', async () => {
  const missingType = structuredClone(fixture()) as unknown as {
    zones: Array<{ counts: Record<string, unknown> }>;
  };
  delete missingType.zones[0]?.counts.hidrante;
  expect(parseInfrastructure(missingType)).toBeNull();

  const wrongTotal = structuredClone(fixture());
  wrongTotal.zones[0].score = 4;
  expect(parseInfrastructure(wrongTotal)).toBeNull();

  await openSignedIn();
  await serve(missingType);
  expect(text('infrastructure-status')).toMatch(/ilegible|no disponible/i);
  expect(rows()).toHaveLength(0);
});

test('without a session it issues no read and states the requirement', async () => {
  render(<InfrastructureView />);
  await settle();

  expect(fetchStub.calls).toHaveLength(0);
  expect(text('infrastructure-status')).toMatch(/conecta un token/i);
  expect(rows()).toHaveLength(0);
});

// --- T3: territorial coverage composition ----------------------------------
//
// T3 ports the layout and hierarchy of the approved territorial boards
// (`design/firewatch-v1-vuelo/04-cobertura-territorial.html` and
// `21-lecturas-por-sector.html`) into this real view: the map becomes the canvas
// of a coverage stage, a rail lists every comuna with the type coverage the
// catalogue actually declares, and two reading panels sit under the breakdown.
//
// What the boards state as prototype hypotheses is stated here as the real
// granularity: the catalogue is served per comuna (CUT code), the service
// publishes no sector reading, and a zero belongs to the fixture instead of
// being a missing value. No board control without served data is simulated.

const declaredHashes = new Set<string>(routes.map(route => route.hash));

function follows(first: Element, second: Element): boolean {
  return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

function headings(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('#infrastructure h2, #infrastructure h3, #infrastructure h4')];
}

function coverageEntries(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('#coverage-list li')];
}

test('T3 composes the coverage stage: map canvas, commune rail and reading panels in order', async () => {
  await openSignedIn();
  await serve(fixture());

  const stage = document.querySelector('#infrastructure .coverage-stage');
  expect(stage, 'the coverage stage is missing').not.toBeNull();

  const canvas = stage?.querySelector('.coverage-canvas') as Element;
  const rail = screen.getByRole('complementary', { name: 'Cobertura por comuna' });
  const table = document.getElementById('infrastructure-zones') as Element;
  const breakdown = document.getElementById('infrastructure-breakdown') as Element;
  const detail = stage?.parentElement?.querySelector('.coverage-detail') as Element;

  // The map is the canvas: the shipped figure keeps its own ids and legend.
  expect(canvas.querySelector('#infrastructure-map')).not.toBeNull();
  expect(canvas.querySelector('#infrastructure-map-svg')).not.toBeNull();
  expect(canvas.querySelector('#infrastructure-map-legend')).not.toBeNull();

  // Reading order is the composition: canvas, rail, the per-type table, the
  // breakdown the rail links to, and finally the reading panels.
  expect(follows(canvas, rail), 'the rail must follow the map canvas').toBe(true);
  expect(follows(rail, table), 'the table must follow the rail').toBe(true);
  expect(follows(table, breakdown), 'the breakdown must follow the table').toBe(true);
  expect(follows(breakdown, detail), 'the reading panels must follow the breakdown').toBe(true);

  // The shell owns the only h1, so the view opens at h2 and no heading inside
  // it descends more than one level at a time.
  expect(screen.getByRole('heading', { level: 2, name: 'Infraestructura prioritaria' })).toHaveAttribute(
    'id',
    'infrastructure-title',
  );
  const levels = headings().map(heading => Number(heading.tagName.slice(1)));
  expect(levels[0]).toBe(2);
  levels.forEach((level, index) => {
    if (index === 0) return;
    expect(level, `${headings()[index].textContent} jumps to level ${level}`).toBeLessThanOrEqual(levels[index - 1] + 1);
  });
  expect(screen.getByRole('heading', { level: 3, name: 'Cobertura por comuna' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 3, name: /Granularidad, cobertura y puntaje/ })).toBeInTheDocument();
});

test('T3 names the real granularity instead of reading commune results as sectors', async () => {
  await openSignedIn();
  await serve(fixture());

  // The stage states what a zone of this catalogue is and what it is not.
  expect(text('coverage-granularity')).toMatch(/comuna/i);
  expect(text('coverage-granularity')).toMatch(/c[oó]digo CUT/i);
  expect(text('coverage-granularity')).toMatch(/no publica una lectura por sector/i);

  // The reading panel repeats the distinction in its own words: granularity,
  // coverage and score are different facts.
  const reading = text('coverage-reading');
  expect(reading).toMatch(/comuna, por c[oó]digo CUT/i);
  expect(reading).toMatch(/no publica lecturas por sector/i);
  expect(reading).toMatch(/cobertura de tipos/i);
  expect(reading).toMatch(/un conteo en cero/i);

  // No zone, row or entry is labelled as a sector reading.
  const zonesText = [...document.querySelectorAll<HTMLElement>('#infrastructure-rows th[scope="row"]')]
    .map(cell => (cell.textContent ?? '').trim())
    .join(' | ');
  expect(zonesText).toBe('05101 | 05102');
  expect(text('coverage-list')).not.toMatch(/sector/i);
  expect(document.querySelector('#infrastructure-zones thead')?.textContent ?? '').not.toMatch(/sector/i);
});

test('T3 lists every commune with the type coverage it declares and links to its breakdown', async () => {
  await openSignedIn();
  await serve(fixture());

  const entries = coverageEntries();
  expect(entries.map(entry => entry.getAttribute('data-zone'))).toEqual(['05101', '05102']);
  expect(text('coverage-rail-count')).toBe('2');

  // 05101 declares all five types; 05102 declares only one.
  const full = entries[0] as HTMLElement;
  expect(full.textContent).toMatch(/5 de 5 tipos/);
  expect(full.textContent).toMatch(/Colegio/);
  expect(full.textContent).toMatch(/Hidrante/);
  const partial = entries[1] as HTMLElement;
  expect(partial.textContent).toMatch(/1 de 5 tipos/);
  expect(partial.textContent).toMatch(/Vivienda/);
  expect(partial.textContent).not.toMatch(/Hospital/);

  // The five-slot figure is decorative: the sentence carries the meaning.
  for (const entry of entries) {
    const dots = entry.querySelectorAll('.coverage-dot');
    expect(dots).toHaveLength(5);
    expect(entry.querySelector('.coverage-dots')).toHaveAttribute('aria-hidden', 'true');
  }
  expect(full.querySelectorAll('.coverage-dot.is-on')).toHaveLength(5);
  expect(partial.querySelectorAll('.coverage-dot.is-on')).toHaveLength(1);

  // Each entry is a native button that opens the real breakdown of that comuna
  // inside this page. It is not an anchor: the hash belongs to the router, so an
  // in-page `#hash` would send the whole view to the fallback route.
  for (const entry of entries) {
    const zone = entry.getAttribute('data-zone') ?? '';
    const button = entry.querySelector('button') as HTMLButtonElement;
    expect(button.getAttribute('type')).toBe('button');
    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(entry.querySelector('a')).toBeNull();
    expect(document.getElementById(`infrastructure-zone-${zone}`)).not.toBeNull();
  }
  expect(document.getElementById('coverage-entry-05101')).not.toBeNull();
  expect(text('infrastructure-zone-coverage-05102')).toMatch(/1 de 5 tipos/);
});

test('T3 opens the chosen commune breakdown with focus, without touching the router hash', async () => {
  await openSignedIn();
  await serve(fixture());
  const hashBefore = window.location.hash;

  const button = document.getElementById('coverage-entry-05102') as HTMLButtonElement;
  fireEvent.click(button);

  expect(button).toHaveAttribute('aria-pressed', 'true');
  expect(document.getElementById('coverage-entry-05101')).toHaveAttribute('aria-pressed', 'false');
  // The reading the button promised is the one that receives the focus.
  expect(document.activeElement).toBe(document.getElementById('infrastructure-zone-05102'));
  expect(document.getElementById('infrastructure-zone-05102')).toHaveAttribute('data-active', 'true');
  expect(window.location.hash).toBe(hashBefore);
});

test('T3 keeps a commune with no declared elements as an explicit zero, not as a missing reading', async () => {
  await openSignedIn();
  const empty = fixture();
  empty.zones.push({ zone_id: '05103', score: 0, counts: counts(), elements: [] });
  await serve(empty);

  const entry = coverageEntries()[2] as HTMLElement;
  expect(entry.textContent).toMatch(/0 de 5 tipos/);
  expect(entry.textContent).toMatch(/sin elementos declarados/i);
  expect(entry.querySelectorAll('.coverage-dot.is-on')).toHaveLength(0);
  expect(text('infrastructure-zone-coverage-05103')).toMatch(/0 de 5 tipos/);
  expect(document.getElementById('infrastructure-elements-05103')).toBeNull();
  expect(screen.getByText('La zona no informa elementos.')).toBeInTheDocument();
});

test('T3 offers only declared routes and simulates none of the prototype controls', async () => {
  await openSignedIn();
  await serve(fixture());

  const detail = document.querySelector('#infrastructure .coverage-detail') as HTMLElement;
  const links = [...detail.querySelectorAll('a')];
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) {
    const href = link.getAttribute('href') ?? '';
    expect(declaredHashes.has(href), `${href} is not a declared route`).toBe(true);
    expect((link.textContent ?? '').trim().length).toBeGreaterThan(0);
  }
  for (const hash of ['#history', '#compare', '#sources']) {
    expect(links.map(link => link.getAttribute('href')), `missing ${hash}`).toContain(hash);
  }

  // The boards' cut-off slider, camera controls, commune request queue and mock
  // sector rows have no served data behind them and must not appear here.
  expect(document.querySelectorAll('#infrastructure input[type="range"]')).toHaveLength(0);
  const railButtons = [...document.querySelectorAll<HTMLButtonElement>('#infrastructure .coverage-rail button')];
  expect(railButtons).toHaveLength(coverageEntries().length);
  for (const button of railButtons) expect(button.getAttribute('type')).toBe('button');
  expect(document.querySelectorAll('#infrastructure .coverage-rail a')).toHaveLength(0);
  const viewText = document.getElementById('infrastructure')?.textContent ?? '';
  expect(viewText).not.toMatch(/seleccionar todas/i);
  expect(viewText).not.toMatch(/fecha de corte/i);
  expect(viewText).not.toMatch(/vista cenital|girar el mapa/i);
  for (const link of document.querySelectorAll<HTMLAnchorElement>('#infrastructure a[href]')) {
    expect(link.getAttribute('href')).not.toMatch(/^https?:/i);
  }
  // No invented geometry: the only drawing surface is the real catalogue map,
  // plus the shipped metric icons.
  const drawings = [...document.querySelectorAll('#infrastructure svg')];
  expect(drawings.length).toBeGreaterThan(0);
  expect(drawings.every(svg => svg.id === 'infrastructure-map-svg' || svg.classList.contains('icon'))).toBe(true);
});

test('T3 renders no coverage stage without a catalogue: the failed read owns its empty state', async () => {
  await openSignedIn();
  await serve({ code: 'forbidden' }, 403);

  expect(document.querySelector('#infrastructure .coverage-stage')).toBeNull();
  expect(document.querySelector('#infrastructure .coverage-detail')).toBeNull();
  expect(text('infrastructure-empty')).toMatch(/sin catálogo disponible/i);
  expect(text('infrastructure-zone-count')).toBe('—');
  expect(document.getElementById('infrastructure-granularity')).not.toBeNull();
});
