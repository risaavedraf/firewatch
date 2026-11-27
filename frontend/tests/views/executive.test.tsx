import { render, screen, waitFor } from '@testing-library/react';

import { gatewayOrigin, issuer, pkceTransactionKey } from '../../src/config';
import { routes } from '../../src/app/routes';
import { completeLogin, resetSession } from '../../src/core/session';
import { ExecutiveView } from '../../src/views/ExecutiveView';

import { createCryptoStub, createFetchStub, createStorageStub, flush, jwt } from '../core/harness';

// T4 — the executive panel as a route of its own.
//
// `design/firewatch-v1-vuelo/07-panel-ejecutivo.html` is the board: a head that
// says what the reading is, a band of level counts, the change reading and the
// panel's limits. The production view keeps the board's hierarchy and drops what
// the service cannot back: there is no sector table (the contract is per comuna),
// no alert preview and no filter over a list the endpoint never sends. Every
// number on the screen is one the server computed, and the section issues ONE read
// per mount.

const EXECUTIVE_URL = `${gatewayOrigin}/v1/risk/executive-summary`;
const TOKEN_URL = `${issuer}/protocol/openid-connect/token`;
const VIEWER_TOKEN = jwt({ realm_access: { roles: ['viewer'] } });

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

async function connect(): Promise<void> {
  storageStub.storage.setItem(pkceTransactionKey, JSON.stringify({ state: 's', verifier: 'verifier' }));
  const login = completeLogin('?code=code-1&state=s');
  await flush();
  fetchStub.answer(TOKEN_URL, { access_token: VIEWER_TOKEN, id_token: 'id-token' });
  await login;
  fetchStub.calls.length = 0;
}

function summaryBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    coverage: { catalogue_zones: 38, zones_without_batch: 4, stale_zones: 2, demo_zones: 0 },
    levels: { alto: 6, medio: 11, bajo: 17, desconocido: 4 },
    delta: {
      zones_compared: 30,
      zones_changed: 5,
      zones_without_previous: 4,
      zones_incomparable: 4,
      transitions: [
        { from: 'medio', to: 'alto', zones: 3 },
        { from: 'bajo', to: 'medio', zones: 2 },
      ],
    },
    predominant_variables: [{ name: 'viento', zones: 9 }],
    critical_zones: { count: 1, zone_ids: ['05101'] },
    active_alerts: { count: 3 },
    ...overrides,
  };
}

function element(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing DOM ${id}`);
  return node;
}

function textOf(id: string): string {
  return element(id).textContent ?? '';
}

async function openSignedIn(): Promise<void> {
  setup();
  await connect();
  render(<ExecutiveView />);
}

afterEach(() => {
  resetSession();
  vi.unstubAllGlobals();
});

test('the route reads the server summary once and renders the counts it answered', async () => {
  await openSignedIn();

  // The view opens at its own title, above the panel it composes.
  expect(element('executive').getAttribute('data-view')).toBe('executive');
  expect(screen.getByRole('heading', { level: 2, name: 'Panel ejecutivo' })).toHaveAttribute(
    'id',
    'executive-view-title',
  );
  expect(screen.getByRole('heading', { level: 3, name: 'Panel ejecutivo' })).toHaveAttribute('id', 'executive-title');

  await waitFor(() => expect(fetchStub.callsFor(EXECUTIVE_URL)).toHaveLength(1));
  fetchStub.answer(EXECUTIVE_URL, summaryBody());
  await waitFor(() => expect(textOf('executive-status')).toMatch(/Resumen recibido del servidor/));

  // Exactly one read for the whole mounted view: the summary is one section with
  // one owner, so a second caller would be a duplicate request on the same screen.
  expect(fetchStub.callsFor(EXECUTIVE_URL)).toHaveLength(1);

  expect(textOf('executive-coverage-catalogue')).toBe('38');
  expect(textOf('executive-level-alto')).toBe('6');
  expect(textOf('executive-level-desconocido')).toBe('4');
  expect(textOf('executive-delta-changed')).toBe('5');
  expect(textOf('executive-critical-count')).toBe('1');
  expect(textOf('executive-alerts-count')).toBe('3');

  // The counts are the board's band, not a metric grid the page computed: every
  // cell is a number the server sent, with the domain's own level label.
  const cells = [...document.querySelectorAll('#executive-levels .decision-summary__cell')];
  expect(cells.map(cell => cell.querySelector('.decision-summary__label')?.textContent)).toEqual([
    'ALTO',
    'MEDIO',
    'BAJO',
    'INFORMACIÓN INSUFICIENTE',
  ]);
  expect(cells.map(cell => cell.querySelector('strong')?.textContent)).toEqual(['6', '11', '17', '4']);
});

test('the view only leads to destinations the router serves, and names no invented reading', async () => {
  await openSignedIn();
  fetchStub.answer(EXECUTIVE_URL, summaryBody());
  await waitFor(() => expect(textOf('executive-status')).toMatch(/Resumen recibido/));

  const declared = new Set<string>(routes.map(route => route.hash));
  const links = [...document.querySelectorAll('#executive a[href^="#"]')];
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) expect(declared.has(link.getAttribute('href') ?? '')).toBe(true);

  // The panel's own link to the centre that stores the alert rows is kept.
  expect(element('executive-alert-link').getAttribute('href')).toBe('#notifications');
  // The three readings the panel cannot compute are one hop away, not rebuilt here.
  const hrefs = links.map(link => link.getAttribute('href'));
  expect(hrefs).toEqual(expect.arrayContaining(['#overview', '#compare', '#notifications']));

  // The board's sector table and alert preview are not ported: the service
  // publishes comuna-level aggregates and stored alert rows, so there is no
  // per-sector list and no illustrative row on this screen.
  expect(document.getElementById('executive-sector-table')).toBeNull();
  expect(document.getElementById('executive-preview')).toBeNull();
  expect(document.querySelectorAll('#executive [aria-pressed]')).toHaveLength(0);
  expect(textOf('executive')).not.toMatch(/maqueta/i);
});

test('the view states its commune granularity and its read-only scope', async () => {
  await openSignedIn();
  fetchStub.answer(EXECUTIVE_URL, summaryBody());
  await waitFor(() => expect(textOf('executive-status')).toMatch(/Resumen recibido/));

  const limits = textOf('executive-limits');
  expect(limits).toMatch(/comuna/i);
  expect(limits).toMatch(/no publica conteos por sector/i);
  expect(limits).toMatch(/Solo lectura/);
  // The critical-zone block keeps the responsible's definition instead of a
  // severity the reader would have to infer.
  expect(textOf('executive-critical-rule')).toBe('Alto en los dos últimos lotes');
});

// The same copy must reach the dedicated route: D-B is decided and applied, so the
// screen cannot read as a pending question in either consumer of the panel.
test('the route states D-B as the resolved definition the server applies', async () => {
  await openSignedIn();
  fetchStub.answer(EXECUTIVE_URL, summaryBody());
  await waitFor(() => expect(textOf('executive-status')).toMatch(/Resumen recibido/));

  const limits = textOf('executive-limits');
  expect(limits).toMatch(/Definición acordada · D-B/);
  expect(limits).not.toMatch(/Definición abierta|sin decidir/i);
  expect(limits).toMatch(/dos últimos lotes publicados tienen\s+nivel alto/i);
  // The rule's own label and the panel note keep the explanation.
  expect(textOf('executive-critical-rule')).toBe('Alto en los dos últimos lotes');
  expect(textOf('executive-panel-note')).toMatch(/definición acordada/i);
});

test('a failed summary is stated inline and no count stands in for it', async () => {
  await openSignedIn();
  await waitFor(() => expect(fetchStub.callsFor(EXECUTIVE_URL)).toHaveLength(1));
  fetchStub.answer(EXECUTIVE_URL, { code: 'storage_unavailable' }, 503);
  await waitFor(() => expect(textOf('executive-status')).toMatch(/HTTP 503/));

  expect(textOf('executive-status')).toMatch(/No se pudo consultar el resumen ejecutivo/);
  expect(document.getElementById('executive-level-alto')).toBeNull();
  expect(document.getElementById('executive-coverage-catalogue')).toBeNull();
  expect(document.getElementById('executive-critical-count')).toBeNull();
  expect(document.getElementById('executive-alerts-count')).toBeNull();
  // The failure owns the section: the panel still names itself and its scope.
  expect(screen.getByRole('heading', { level: 3, name: 'Panel ejecutivo' })).toBeInTheDocument();
  expect(textOf('executive-limits')).toMatch(/Solo lectura/);
});

test('without a session the view reads nothing and says it has not read the summary', () => {
  setup();
  render(<ExecutiveView />);

  expect(textOf('executive-status')).toMatch(/Sin consultar/);
  expect(fetchStub.callsFor(EXECUTIVE_URL)).toHaveLength(0);
  expect(document.getElementById('executive-level-alto')).toBeNull();
});
