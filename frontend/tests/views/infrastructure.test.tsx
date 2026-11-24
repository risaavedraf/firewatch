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

test('prints through the browser and the print stylesheet keeps the synthetic label, formula and table', async () => {
  await openSignedIn();
  await serve(fixture());

  const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
  fireEvent.click(screen.getByRole('button', { name: /imprimir/i }));
  expect(print).toHaveBeenCalledTimes(1);

  const start = appCss.indexOf('@media print');
  expect(start).toBeGreaterThanOrEqual(0);
  const printBlock = appCss.slice(start);
  expect(printBlock).toContain('.infrastructure-synthetic');
  expect(printBlock).toContain('.infrastructure-formula');
  expect(printBlock).toMatch(/\.infrastructure-print-action[^{]*\{[^}]*display:\s*none/);
  expect(printBlock).not.toMatch(/#infrastructure-zones[^{]*\{[^}]*display:\s*none/);
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
