import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { gatewayOrigin, issuer, pkceTransactionKey } from '../../src/config';
import { listRiskAlerts } from '../../src/core/notifications';
import { completeLogin, getSessionSnapshot, resetSession } from '../../src/core/session';
import { NotificationsView } from '../../src/views/NotificationsView';

import {
  createCryptoStub,
  createFetchStub,
  createStorageStub,
  flush,
  jwt,
} from '../core/harness';

// PM-08 S1/S2 — the notification centre lists the persisted PM-07 alerts through
// the frozen wire seam. The view owns the previous-page cursor history, resets it
// on order and session changes, and keeps loading, failure and empty state
// separate. The approved artboard defines the hierarchy and the Spanish labels;
// its invented preview rows and its "the alert entity does not exist yet" copy are
// deliberately not ported.

const ALERTS_URL = `${gatewayOrigin}/v1/risk/alerts`;
const TOKEN_URL = `${issuer}/protocol/openid-connect/token`;
const VIEWER_TOKEN = jwt({ realm_access: { roles: ['viewer'] } });

// The wire ids are canonical uuids because the frozen contract types `id` as
// `format: uuid` and validates the path parameter as one. The short aliases keep
// the tests readable; every helper below translates them at the boundary.
const ALERT_UUIDS: Readonly<Record<string, string>> = {
  'alert-1': '1c0d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f',
  'alert-2': '2d1e3f4a-5b6c-4d7e-8f90-1a2b3c4d5e6f',
  'alert-3': '3e2f4a5b-6c7d-4e8f-9012-2b3c4d5e6f70',
};

function uuid(id: string): string {
  return ALERT_UUIDS[id] ?? id;
}

let fetchStub: ReturnType<typeof createFetchStub>;
let storageStub: ReturnType<typeof createStorageStub>;
let localStub: ReturnType<typeof createStorageStub>;

function setup(): void {
  fetchStub = createFetchStub();
  storageStub = createStorageStub();
  localStub = createStorageStub();
  vi.stubGlobal('fetch', fetchStub.fetch);
  vi.stubGlobal('sessionStorage', storageStub.storage);
  // The mark lives on the server: `localStorage` is stubbed so a write would be
  // observable instead of silently touching whatever the engine provides.
  vi.stubGlobal('localStorage', localStub.storage);
  vi.stubGlobal('crypto', createCryptoStub());
  resetSession();
}

async function connect(clearCalls = true): Promise<void> {
  storageStub.storage.setItem(pkceTransactionKey, JSON.stringify({ state: 's', verifier: 'verifier' }));
  const login = completeLogin('?code=code-1&state=s');
  await flush();
  fetchStub.answer(TOKEN_URL, { access_token: VIEWER_TOKEN, id_token: 'id-token' });
  await login;
  if (clearCalls) fetchStub.calls.length = 0;
}

function alertFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  // The id is mapped to the uuid the wire carries, including an explicit
  // override, so no fixture can smuggle a non-canonical id into the mark seam.
  const { id: overriddenId, ...rest } = overrides;
  return {
    zone_id: '05501',
    zone_name: 'Valparaíso',
    previous_level: 'bajo',
    new_level: 'alto',
    threshold: 1,
    occurred_at: '2026-11-20T16:05:00Z',
    demo: true,
    ...rest,
    id: uuid(typeof overriddenId === 'string' ? overriddenId : 'alert-1'),
  };
}

async function answerAlerts(url: string, body: unknown, status = 200, requestId = ''): Promise<void> {
  await act(async () => {
    fetchStub.answer(url, body, status, requestId);
    await flush();
  });
}

function rowCells(): string[][] {
  return [...document.querySelectorAll('#notifications-rows tr')].map(row =>
    [...row.querySelectorAll('td')].map(cell => cell.textContent ?? ''),
  );
}

beforeEach(setup);

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Wire seam ─────────────────────────────────────────────────────────────

test('the transport reads the frozen alerts route with the selected order, no client limit and no invented page size', async () => {
  const pending = listRiskAlerts({ order: 'desc' });
  await waitFor(() => expect(fetchStub.callsFor(`${ALERTS_URL}?order=desc`)).toHaveLength(1));

  expect(fetchStub.callsFor(`${ALERTS_URL}?order=desc`)[0].init.headers).toMatchObject({
    Authorization: 'Bearer ',
  });

  fetchStub.answer(`${ALERTS_URL}?order=desc`, { items: [], next_cursor: null });
  await expect(pending).resolves.toEqual({ ok: true, data: { items: [], next_cursor: null } });
});

test('the transport accepts null catalog labels and labels every field, but rejects one malformed alert as a whole page', async () => {
  const accepted = listRiskAlerts({ order: 'asc', cursor: 'next page&1' });
  await waitFor(() =>
    expect(
      fetchStub.callsFor(`${ALERTS_URL}?order=asc&cursor=next+page%261`),
    ).toHaveLength(1),
  );
  fetchStub.answer(`${ALERTS_URL}?order=asc&cursor=next+page%261`, {
    items: [alertFixture({ zone_name: null, demo: false })],
    next_cursor: 'next-cursor',
  });
  await expect(accepted).resolves.toMatchObject({
    ok: true,
    data: {
      items: [
        {
          id: uuid('alert-1'),
          zone_id: '05501',
          zone_name: null,
          previous_level: 'bajo',
          new_level: 'alto',
          threshold: 1,
          occurred_at: '2026-11-20T16:05:00Z',
          demo: false,
        },
      ],
      next_cursor: 'next-cursor',
    },
  });

  const rejected = listRiskAlerts({ order: 'desc' });
  await waitFor(() => expect(fetchStub.callsFor(`${ALERTS_URL}?order=desc`)).toHaveLength(1));
  fetchStub.answer(`${ALERTS_URL}?order=desc`, {
    items: [alertFixture({ new_level: 'extremo' })],
    next_cursor: null,
  });
  await expect(rejected).resolves.toMatchObject({
    ok: false,
    failure: { kind: 'malformed', reason: 'invalid_shape' },
  });
});

test('a rejected cursor is a stated malformed failure, not an empty page', async () => {
  const pending = listRiskAlerts({ order: 'desc', cursor: 'stale' });
  await waitFor(() => expect(fetchStub.callsFor(`${ALERTS_URL}?order=desc&cursor=stale`)).toHaveLength(1));

  fetchStub.answer(`${ALERTS_URL}?order=desc&cursor=stale`, { code: 'invalid_cursor' }, 400, 'req-cursor');
  await expect(pending).resolves.toMatchObject({
    ok: false,
    failure: { kind: 'malformed', reason: 'invalid_cursor', status: 400, requestId: 'req-cursor' },
  });
});

test('a 401 still closes the session and is reported as an unauthorized read', async () => {
  await connect();
  const pending = listRiskAlerts({ order: 'desc' });
  await waitFor(() => expect(fetchStub.callsFor(`${ALERTS_URL}?order=desc`)).toHaveLength(1));

  fetchStub.answer(`${ALERTS_URL}?order=desc`, { code: 'unauthorized' }, 401);
  await expect(pending).resolves.toMatchObject({
    ok: false,
    failure: { kind: 'unauthorized', reason: 'unauthorized', status: 401 },
  });
  expect(getSessionSnapshot().status).toBe('signed-out');
});

// ── Rendered list ─────────────────────────────────────────────────────────

test('the view reads the alerts once and renders the approved labels with real date, sector, change and provenance', async () => {
  await connect();
  render(<NotificationsView />);

  await waitFor(() => expect(fetchStub.callsFor(`${ALERTS_URL}?order=desc`)).toHaveLength(1));
  expect(fetchStub.callsFor(`${ALERTS_URL}?order=desc`)[0].init.headers).toMatchObject({
    Authorization: `Bearer ${VIEWER_TOKEN}`,
  });
  expect(document.getElementById('notifications-status')).toHaveTextContent('Consultando alertas…');
  expect(document.querySelector('article.notification-panel')).toHaveAttribute('aria-busy', 'true');
  expect(document.getElementById('notifications-table')).toBeNull();

  expect(document.getElementById('notifications-title')).toHaveTextContent('Notificaciones');
  expect(document.getElementById('notifications-order')).toHaveValue('desc');
  expect(document.querySelector('option[value="desc"]')).toHaveTextContent('Más recientes primero');
  expect(document.querySelector('option[value="asc"]')).toHaveTextContent('Más antiguas primero');

  await answerAlerts(`${ALERTS_URL}?order=desc`, {
    items: [
      alertFixture(),
      alertFixture({
        id: 'alert-2',
        zone_id: '05502',
        zone_name: null,
        previous_level: 'alto',
        new_level: 'medio',
        threshold: 2,
        occurred_at: '2026-11-19T12:00:00Z',
        demo: false,
      }),
    ],
    next_cursor: 'cursor-2',
  });

  const headers = [...document.querySelectorAll('#notifications-table thead th')].map(cell => cell.textContent);
  expect(headers).toEqual(['Fecha', 'Sector', 'Cambio de nivel', 'Procedencia', 'Marca personal']);
  expect(document.querySelector('article.notification-panel')).toHaveAttribute('aria-busy', 'false');

  const rows = rowCells();
  expect(rows).toHaveLength(2);
  expect(rows[0][0]).toBe('2026-11-20T16:05:00Z');
  expect(rows[0][1]).toContain('Valparaíso');
  expect(rows[0][1]).toContain('05501');
  expect(rows[0][2]).toContain('BAJO');
  expect(rows[0][2]).toContain('ALTO');
  expect(rows[0][2]).toContain('Umbral 1');
  expect(rows[0][3]).toBe('Sintético');

  // A null catalog label falls back to the real zone code, never to an invented
  // display name, and a non-synthetic row is not labelled as synthetic.
  expect(rows[1][1]).toContain('05502');
  expect(rows[1][1]).not.toContain('Sector 05502');
  expect(rows[1][3]).toBe('Sin marca sintética');

  expect(document.getElementById('notifications-page')).toHaveTextContent('Página 1');
  expect(document.querySelector('button#notifications-prev')).toBeDisabled();
  expect(document.querySelector('button#notifications-next')).toBeEnabled();

  // The artboard's preview rows and its obsolete dependency claim are not ported.
  expect(document.body.textContent).not.toMatch(/filas inventadas|entidad de alerta no existe|PM-07 pendiente/i);
});

test('an empty collection is its own state: "Sin notificaciones", no table and no fake rows', async () => {
  await connect();
  render(<NotificationsView />);

  await waitFor(() => expect(fetchStub.callsFor(`${ALERTS_URL}?order=desc`)).toHaveLength(1));
  await answerAlerts(`${ALERTS_URL}?order=desc`, { items: [], next_cursor: null });

  expect(document.getElementById('notifications-empty-title')).toHaveTextContent('Sin notificaciones');
  expect(document.getElementById('notifications-table')).toBeNull();
  expect(document.querySelectorAll('#notifications-rows tr')).toHaveLength(0);
  expect(document.querySelector('button#notifications-prev')).toBeNull();
  expect(document.querySelector('button#notifications-next')).toBeNull();
  expect(document.getElementById('notifications-status')).toHaveTextContent(/lista vacía/i);
});

// ── Pager history, order reset and focus ──────────────────────────────────

test('the pager keeps a previous-page cursor history instead of restarting from the first page', async () => {
  await connect();
  render(<NotificationsView />);
  await waitFor(() => expect(fetchStub.callsFor(`${ALERTS_URL}?order=desc`)).toHaveLength(1));
  await answerAlerts(`${ALERTS_URL}?order=desc`, {
    items: [alertFixture()],
    next_cursor: 'cursor-page-2',
  });

  await userEvent.click(document.querySelector('button#notifications-next') as HTMLButtonElement);
  await waitFor(() =>
    expect(fetchStub.callsFor(`${ALERTS_URL}?order=desc&cursor=cursor-page-2`)).toHaveLength(1),
  );
  await answerAlerts(`${ALERTS_URL}?order=desc&cursor=cursor-page-2`, {
    items: [alertFixture({ id: 'alert-page-2' })],
    next_cursor: 'cursor-page-3',
  });
  expect(document.getElementById('notifications-page')).toHaveTextContent('Página 2');

  await userEvent.click(document.querySelector('button#notifications-prev') as HTMLButtonElement);
  await waitFor(() => expect(fetchStub.callsFor(`${ALERTS_URL}?order=desc`)).toHaveLength(2));
  await answerAlerts(`${ALERTS_URL}?order=desc`, {
    items: [alertFixture()],
    next_cursor: 'cursor-page-2',
  });
  expect(document.getElementById('notifications-page')).toHaveTextContent('Página 1');
  expect(document.querySelector('button#notifications-prev')).toBeDisabled();
});

// A later page and the whole register are different facts. The same card cannot
// claim "there are no registered alerts" when the previous page showed rows: the
// list is cursor-paginated and this page merely came back empty.
test('an empty page reached by paging says this page is empty instead of claiming the register is empty', async () => {
  await connect();
  render(<NotificationsView />);
  await waitFor(() => expect(fetchStub.callsFor(`${ALERTS_URL}?order=desc`)).toHaveLength(1));
  await answerAlerts(`${ALERTS_URL}?order=desc`, {
    items: [alertFixture()],
    next_cursor: 'cursor-page-2',
  });

  await userEvent.click(document.querySelector('button#notifications-next') as HTMLButtonElement);
  await waitFor(() =>
    expect(fetchStub.callsFor(`${ALERTS_URL}?order=desc&cursor=cursor-page-2`)).toHaveLength(1),
  );
  await answerAlerts(`${ALERTS_URL}?order=desc&cursor=cursor-page-2`, { items: [], next_cursor: null });

  const card = document.querySelector('#notifications .notification-empty');
  expect(card).not.toBeNull();
  const cardText = card?.textContent ?? '';
  // The false global claim is the defect this test exists for.
  expect(cardText).not.toMatch(/No hay alertas de cambio de nivel registradas/i);
  expect(cardText).toMatch(/esta página/i);
  // It says how to get back, and the pager keeps offering it.
  expect(cardText).toMatch(/Anterior/);
  expect(document.querySelector('button#notifications-prev')).toBeEnabled();

  // The page-scoped status line and the focus contract are unchanged.
  expect(document.getElementById('notifications-status')).toHaveTextContent(/página 2/i);
  expect(document.getElementById('notifications-status')).toHaveTextContent(/lista vacía/i);
  expect(document.activeElement?.id).toBe('notifications-status');

  // Going back restores the populated page and its real rows.
  await userEvent.click(document.querySelector('button#notifications-prev') as HTMLButtonElement);
  await waitFor(() => expect(fetchStub.callsFor(`${ALERTS_URL}?order=desc`)).toHaveLength(2));
  await answerAlerts(`${ALERTS_URL}?order=desc`, {
    items: [alertFixture()],
    next_cursor: 'cursor-page-2',
  });
  await waitFor(() => expect(document.querySelectorAll('#notifications-rows tr')).toHaveLength(1));
  expect(document.getElementById('notifications-page')).toHaveTextContent('Página 1');
  expect(document.querySelector('#notifications .notification-empty')).toBeNull();
});

test('an empty page reached by paging keeps "Anterior" available', async () => {
  await connect();
  render(<NotificationsView />);
  await waitFor(() => expect(fetchStub.callsFor(`${ALERTS_URL}?order=desc`)).toHaveLength(1));
  await answerAlerts(`${ALERTS_URL}?order=desc`, {
    items: [alertFixture()],
    next_cursor: 'cursor-page-2',
  });

  await userEvent.click(document.querySelector('button#notifications-next') as HTMLButtonElement);
  await waitFor(() =>
    expect(fetchStub.callsFor(`${ALERTS_URL}?order=desc&cursor=cursor-page-2`)).toHaveLength(1),
  );
  await answerAlerts(`${ALERTS_URL}?order=desc&cursor=cursor-page-2`, { items: [], next_cursor: null });

  // A later empty page is not "Sin notificaciones": it says this page is empty and
  // keeps the way back. The initial-page message is covered by its own test.
  expect(document.getElementById('notifications-empty-title')).toHaveTextContent(/esta página no tiene alertas/i);
  expect(document.getElementById('notifications-page')).toHaveTextContent('Página 2');
  expect(document.querySelector('button#notifications-prev')).toBeEnabled();
  expect(document.querySelector('button#notifications-next')).toBeDisabled();
});

test('changing the order resets the cursor history and asks for a first page in the new direction', async () => {
  await connect();
  render(<NotificationsView />);
  await waitFor(() => expect(fetchStub.callsFor(`${ALERTS_URL}?order=desc`)).toHaveLength(1));
  await answerAlerts(`${ALERTS_URL}?order=desc`, {
    items: [alertFixture()],
    next_cursor: 'cursor-page-2',
  });

  await userEvent.click(document.querySelector('button#notifications-next') as HTMLButtonElement);
  await waitFor(() =>
    expect(fetchStub.callsFor(`${ALERTS_URL}?order=desc&cursor=cursor-page-2`)).toHaveLength(1),
  );
  await answerAlerts(`${ALERTS_URL}?order=desc&cursor=cursor-page-2`, {
    items: [alertFixture({ id: 'alert-page-2' })],
    next_cursor: 'cursor-page-3',
  });

  await userEvent.selectOptions(document.getElementById('notifications-order') as HTMLSelectElement, 'asc');
  await waitFor(() => expect(fetchStub.callsFor(`${ALERTS_URL}?order=asc`)).toHaveLength(1));
  expect(document.getElementById('notifications-page')).toHaveTextContent('Página 1');
  await answerAlerts(`${ALERTS_URL}?order=asc`, { items: [], next_cursor: null });
});

test('a new session starts again at page one in the default order', async () => {
  await connect();
  render(<NotificationsView />);
  await waitFor(() => expect(fetchStub.callsFor(`${ALERTS_URL}?order=desc`)).toHaveLength(1));
  await answerAlerts(`${ALERTS_URL}?order=desc`, {
    items: [alertFixture()],
    next_cursor: 'cursor-page-2',
  });

  await userEvent.click(document.querySelector('button#notifications-next') as HTMLButtonElement);
  await waitFor(() =>
    expect(fetchStub.callsFor(`${ALERTS_URL}?order=desc&cursor=cursor-page-2`)).toHaveLength(1),
  );
  await answerAlerts(`${ALERTS_URL}?order=desc&cursor=cursor-page-2`, {
    items: [alertFixture({ id: 'alert-page-2' })],
    next_cursor: null,
  });

  await act(async () => {
    resetSession();
    await flush();
  });
  await connect(false);
  await waitFor(() => expect(fetchStub.callsFor(`${ALERTS_URL}?order=desc`)).toHaveLength(2));
  await answerAlerts(`${ALERTS_URL}?order=desc`, {
    items: [alertFixture()],
    next_cursor: 'cursor-page-2',
  });
  expect(document.getElementById('notifications-page')).toHaveTextContent('Página 1');
  expect(document.querySelector('button#notifications-prev')).toBeDisabled();
});

test('after a page change the settled result is focused and announced', async () => {
  await connect();
  render(<NotificationsView />);
  await waitFor(() => expect(fetchStub.callsFor(`${ALERTS_URL}?order=desc`)).toHaveLength(1));
  await answerAlerts(`${ALERTS_URL}?order=desc`, {
    items: [alertFixture()],
    next_cursor: 'cursor-page-2',
  });

  await userEvent.click(document.querySelector('button#notifications-next') as HTMLButtonElement);
  await waitFor(() =>
    expect(fetchStub.callsFor(`${ALERTS_URL}?order=desc&cursor=cursor-page-2`)).toHaveLength(1),
  );
  await answerAlerts(`${ALERTS_URL}?order=desc&cursor=cursor-page-2`, {
    items: [alertFixture({ id: 'alert-page-2' })],
    next_cursor: null,
  });

  await waitFor(() => expect(document.activeElement?.id).toBe('notifications-status'));
  expect(document.getElementById('notifications-status')).toHaveAttribute('role', 'status');
  expect(document.getElementById('notifications-status')).toHaveTextContent(/página 2/i);
});

// ── Failure ───────────────────────────────────────────────────────────────

test('a failed read is stated with its HTTP status and retry, and is never shown as an empty list', async () => {
  await connect();
  render(<NotificationsView />);
  await waitFor(() => expect(fetchStub.callsFor(`${ALERTS_URL}?order=desc`)).toHaveLength(1));

  await answerAlerts(`${ALERTS_URL}?order=desc`, { code: 'storage_unavailable' }, 503, 'req-503');
  const status = document.getElementById('notifications-status');
  expect(status).toHaveTextContent(/HTTP 503/);
  expect(status).toHaveTextContent(/storage_unavailable/);
  expect(status).toHaveTextContent(/req-503/);
  expect(status).toHaveClass('risk-error');
  expect(document.getElementById('notifications-empty-title')).toBeNull();
  expect(document.getElementById('notifications-table')).toBeNull();

  await userEvent.click(document.querySelector('button#notifications-retry') as HTMLButtonElement);
  await waitFor(() => expect(fetchStub.callsFor(`${ALERTS_URL}?order=desc`)).toHaveLength(2));
  await answerAlerts(`${ALERTS_URL}?order=desc`, {
    items: [alertFixture()],
    next_cursor: null,
  });
  await waitFor(() => expect(document.getElementById('notifications-table')).not.toBeNull());
});

// ── T4 · the approved board's empty-state hierarchy ────────────────────────
//
// `design/firewatch-v1-vuelo/09-notificaciones.html` states the real empty state
// as a designed card: a dashed mark, the eyebrow "SIN DATOS · ESTADO REAL", the
// title, the explanation and what would fill the list. The production page keeps
// its real read, its order control, its pager and its status line; the board's
// invented preview rows stay out.

test('the real empty state keeps the board card and explains what would fill it', async () => {
  await connect();
  render(<NotificationsView />);
  await waitFor(() => expect(fetchStub.callsFor(`${ALERTS_URL}?order=desc`)).toHaveLength(1));
  await act(async () => {
    fetchStub.answer(`${ALERTS_URL}?order=desc`, { items: [], next_cursor: null });
    await flush();
  });

  const title = document.getElementById('notifications-empty-title');
  expect(title?.textContent).toBe('Sin notificaciones');
  const card = document.querySelector('#notifications .notification-empty');
  expect(card).not.toBeNull();
  expect(card?.querySelector('.notification-empty-mark')).not.toBeNull();
  expect(card?.querySelector('.notification-empty-mark')?.getAttribute('aria-hidden')).toBe('true');
  expect(card?.querySelector('.eyebrow')?.textContent).toBe('SIN DATOS · ESTADO REAL');

  // What would fill the list and what the page does not do are real statements
  // about this contract, not the board's "PM-07 does not exist yet" copy.
  const points = [...(card?.querySelectorAll('.notification-empty-points li') ?? [])].map(node =>
    node.textContent ?? '',
  );
  expect(points).toHaveLength(2);
  expect(points[0]).toMatch(/cambio de nivel/i);
  expect(points[0]).toMatch(/\/v1\/risk\/alerts|servicio/i);
  // PM-08: the page now records the caller's own mark, so it no longer claims it
  // cannot mark; it still creates nothing and sends nothing.
  expect(points[1]).toMatch(/no crea/i);
  expect(points[1]).toMatch(/no envía/i);
  expect(points[1]).not.toMatch(/no marca como leída/i);

  // The real read and its status are untouched: the card never replaces them.
  expect(document.getElementById('notifications-status')).toHaveTextContent(/lista vacía/i);
  expect(document.querySelectorAll('#notifications [aria-pressed]')).toHaveLength(0);
  expect(document.querySelector('#notifications .notification-scenario')).toBeNull();
});

// ── PM-08 personal marks (S3) ──────────────────────────────────────────────
//
// The centre shows and updates the caller's own mark: `GET` per visible alert,
// `PUT` on the frozen write, and the row is the unit of feedback — its live
// region, its disabled controls and its focus return, with the table and the
// other rows untouched. The contract declares the write admin-only, so the page
// does not pre-authorise with a role guess: a viewer's click reaches the service
// and its `403` is stated inline as a denial.

const STATE_URL = (id: string): string => `${gatewayOrigin}/v1/risk/alerts/${uuid(id)}/state`;

function stateFixture(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { alert_id: uuid(id), state: 'unread', marked_at: null, ...overrides };
}

function markCellDomId(id: string): string {
  return `notifications-mark-${uuid(id)}`;
}

function markButtonDomId(id: string, mark: 'read' | 'dismissed'): string {
  return `notifications-mark-${mark}-${uuid(id)}`;
}

function markChip(id: string): Element | null {
  return document.querySelector(`#${markCellDomId(id)} .notification-mark-chip`);
}

function markButtons(id: string): HTMLButtonElement[] {
  return [
    document.getElementById(markButtonDomId(id, 'read')) as HTMLButtonElement,
    document.getElementById(markButtonDomId(id, 'dismissed')) as HTMLButtonElement,
  ];
}

function markFeedback(id: string): string {
  return document.getElementById(`notifications-mark-feedback-${uuid(id)}`)?.textContent ?? '';
}

function markRow(id: string): HTMLTableRowElement {
  return document.getElementById(markCellDomId(id))?.closest('tr') as HTMLTableRowElement;
}

async function answerState(id: string, body: unknown, status = 200, requestId = ''): Promise<void> {
  await act(async () => {
    fetchStub.answer(STATE_URL(id), body, status, requestId);
    await flush();
  });
}

async function answerBothStates(
  first: Record<string, unknown> = stateFixture('alert-1'),
  second: Record<string, unknown> = stateFixture('alert-2', { state: 'read', marked_at: '2026-11-19T12:00:00Z' }),
): Promise<void> {
  await waitFor(() => expect(fetchStub.callsFor(STATE_URL('alert-1'))).toHaveLength(1));
  await waitFor(() => expect(fetchStub.callsFor(STATE_URL('alert-2'))).toHaveLength(1));
  await answerState('alert-1', first);
  await answerState('alert-2', second);
}

// The page with two visible rows, their marks read and settled.
async function readyPage(first?: Record<string, unknown>, second?: Record<string, unknown>): Promise<void> {
  await connect();
  render(<NotificationsView />);
  await waitFor(() => expect(fetchStub.callsFor(`${ALERTS_URL}?order=desc`)).toHaveLength(1));
  await answerAlerts(`${ALERTS_URL}?order=desc`, {
    items: [
      alertFixture(),
      alertFixture({
        id: 'alert-2',
        zone_id: '05502',
        zone_name: 'Quilpué',
        previous_level: 'alto',
        new_level: 'medio',
        threshold: 2,
        occurred_at: '2026-11-19T12:00:00Z',
        demo: false,
      }),
    ],
    next_cursor: 'cursor-2',
  });
  await answerBothStates(first, second);
}

test('every visible row shows the personal mark the service returned, read per alert', async () => {
  await readyPage();

  // One state read per visible row, addressed by the alert ids the page served.
  const stateCalls = fetchStub.calls.filter(call => call.url.endsWith('/state'));
  expect(stateCalls.map(call => call.url)).toEqual([STATE_URL('alert-1'), STATE_URL('alert-2')]);
  expect(fetchStub.callsFor(STATE_URL('alert-1'))[0].init).toMatchObject({
    method: 'GET',
    headers: { Authorization: `Bearer ${VIEWER_TOKEN}` },
  });

  expect(markChip('alert-1')).toHaveTextContent('Sin leer');
  // A null instant is painted only for `unread`; nothing is invented for it.
  expect(document.querySelector(`#${markCellDomId('alert-1')} time`)).toBeNull();

  expect(markChip('alert-2')).toHaveTextContent('Leída');
  const instant = document.querySelector(`#${markCellDomId('alert-2')} time`);
  expect(instant).toHaveAttribute('dateTime', '2026-11-19T12:00:00Z');
  expect(instant).toHaveTextContent('2026-11-19T12:00:00Z');

  expect(document.getElementById('notifications-status')).toHaveTextContent(/marca personal leída del servicio/i);
  // The row's controls follow the served state: a dismissal is final, so it is
  // not offered for a dismissed row, while the unread row offers both marks.
  expect(markButtons('alert-1')[0]).toBeEnabled();
  expect(markButtons('alert-1')[1]).toBeEnabled();
  expect(markButtons('alert-2')[0]).toBeDisabled();
  expect(markButtons('alert-2')[1]).toBeEnabled();
  // The announcement region is the page's own and mounted before any update, so a
  // row can leave the table (an active filter) and the confirmation still lands.
  const live = document.getElementById('notifications-mark-status');
  expect(live).toHaveAttribute('role', 'status');
  expect(live).toHaveAttribute('aria-live', 'polite');
  expect(markRow('alert-1')).toHaveAttribute('aria-busy', 'false');
});

test('a mark the service could not answer is unavailable, never read as "Sin leer"', async () => {
  await connect();
  render(<NotificationsView />);
  await waitFor(() => expect(fetchStub.callsFor(`${ALERTS_URL}?order=desc`)).toHaveLength(1));
  await answerAlerts(`${ALERTS_URL}?order=desc`, {
    items: [alertFixture(), alertFixture({ id: 'alert-2' })],
    next_cursor: null,
  });
  await waitFor(() => expect(fetchStub.callsFor(STATE_URL('alert-1'))).toHaveLength(1));
  await answerState('alert-1', { code: 'storage_unavailable' }, 503, 'req-m503');
  await answerState('alert-2', stateFixture('alert-2', { state: 'read', marked_at: '2026-11-19T12:00:00Z' }));

  // The failed row states its own failure with the contract's code and id, and
  // offers no mark: the service never returned one for this alert.
  const cell = document.getElementById(markCellDomId('alert-1'));
  expect(cell).toHaveTextContent(/marca no disponible/i);
  expect(cell).toHaveTextContent(/storage_unavailable/);
  expect(cell).toHaveTextContent(/req-m503/);
  expect(markChip('alert-1')).toBeNull();
  expect(cell?.textContent).not.toMatch(/sin leer/i);
  expect(markButtons('alert-1')[0]).toBeDisabled();
  expect(markButtons('alert-1')[1]).toBeDisabled();

  // The other row keeps the mark the service did answer.
  expect(markChip('alert-2')).toHaveTextContent('Leída');
  expect(document.getElementById('notifications-marks-note')).toHaveTextContent(/no se muestran como «Sin leer»/i);
  expect(document.getElementById('notifications-marks-retry')).not.toBeNull();

  // Re-reading the page's marks asks the service again and settles honestly.
  await userEvent.click(document.getElementById('notifications-marks-retry') as HTMLButtonElement);
  await waitFor(() => expect(fetchStub.callsFor(STATE_URL('alert-1'))).toHaveLength(2));
  await answerState('alert-1', stateFixture('alert-1'));
  await answerState('alert-2', stateFixture('alert-2', { state: 'read', marked_at: '2026-11-19T12:00:00Z' }));
  expect(markChip('alert-1')).toHaveTextContent('Sin leer');
  expect(document.getElementById('notifications-marks-retry')).toBeNull();
  expect(markButtons('alert-1')[0]).toBeEnabled();
});

test('marking an alert as read is the frozen PUT, disables only that row and applies the served state', async () => {
  await readyPage();
  await userEvent.click(markButtons('alert-1')[0]);

  const put = fetchStub.callsFor(STATE_URL('alert-1'))[1];
  expect(put.init).toMatchObject({
    method: 'PUT',
    body: '{"state":"read"}',
    headers: { Authorization: `Bearer ${VIEWER_TOKEN}`, 'Content-Type': 'application/json' },
  });

  // In flight: only this row is busy and only its controls are disabled.
  expect(markRow('alert-1')).toHaveAttribute('aria-busy', 'true');
  expect(markButtons('alert-1')[0]).toBeDisabled();
  expect(markButtons('alert-1')[1]).toBeDisabled();
  expect(markButtons('alert-2')[1]).toBeEnabled();
  expect(markFeedback('alert-1')).toMatch(/registrando la marca «Leída»/i);
  expect(markChip('alert-1')).toHaveTextContent('Sin leer');

  await answerState('alert-1', stateFixture('alert-1', { state: 'read', marked_at: '2026-11-21T10:00:00Z' }));

  // The row paints the response, not the request.
  expect(markChip('alert-1')).toHaveTextContent('Leída');
  expect(document.querySelector(`#${markCellDomId('alert-1')} time`)).toHaveAttribute(
    'dateTime',
    '2026-11-21T10:00:00Z',
  );
  expect(markFeedback('alert-1')).toMatch(/marca registrada: «Leída»/i);
  expect(markFeedback('alert-1')).toContain('2026-11-21T10:00:00Z');
  expect(markRow('alert-1')).toHaveAttribute('aria-busy', 'false');
  expect(markButtons('alert-1')[0]).toBeDisabled();
  expect(markButtons('alert-1')[1]).toBeEnabled();
  // The control that fired is now disabled, so focus lands on the row's mark.
  expect(document.activeElement?.id).toBe(markCellDomId('alert-1'));
});

test('a replayed or dominated write is shown as the server answered, not as it was requested', async () => {
  await readyPage();
  await userEvent.click(markButtons('alert-1')[0]);
  // `read` was requested; the service already held the dominant `dismissed` and
  // answered it with its original instant. Replay is a 200, not a conflict.
  await answerState('alert-1', stateFixture('alert-1', { state: 'dismissed', marked_at: '2026-11-18T09:00:00Z' }));

  expect(markChip('alert-1')).toHaveTextContent('Revisada');
  expect(markChip('alert-1')?.textContent).not.toBe('Leída');
  expect(document.querySelector(`#${markCellDomId('alert-1')} time`)).toHaveAttribute(
    'dateTime',
    '2026-11-18T09:00:00Z',
  );
  expect(markFeedback('alert-1')).toMatch(/marca dominante «Revisada»/i);
  expect(markFeedback('alert-1')).toMatch(/el servicio devolvió/i);
  expect(markButtons('alert-1')[0]).toBeDisabled();
  expect(markButtons('alert-1')[1]).toBeDisabled();
  expect(document.getElementById(markCellDomId('alert-1'))).toHaveFocus();
});

test('a dismissal is final in the row: revisada dominates leída and the note says it does not revert', async () => {
  await readyPage();
  expect(markChip('alert-2')).toHaveTextContent('Leída');
  await userEvent.click(markButtons('alert-2')[1]);
  await answerState('alert-2', stateFixture('alert-2', { state: 'dismissed', marked_at: '2026-11-22T08:00:00Z' }));

  expect(markChip('alert-2')).toHaveTextContent('Revisada');
  expect(markFeedback('alert-2')).toMatch(/marca registrada: «Revisada»/i);
  expect(markButtons('alert-2')[0]).toBeDisabled();
  expect(markButtons('alert-2')[1]).toBeDisabled();
  const noteId = markButtons('alert-2')[1].getAttribute('aria-describedby') ?? '';
  expect(document.getElementById(noteId)).toHaveTextContent(/no se revierte/i);
});

test('a denied mark (403) is stated inline as a permission denial and never drawn as applied', async () => {
  await readyPage();
  await userEvent.click(markButtons('alert-1')[0]);
  await answerState('alert-1', { code: 'forbidden' }, 403, 'req-403');

  const feedback = markFeedback('alert-1');
  expect(feedback).toMatch(/permiso/i);
  expect(feedback).toContain('HTTP 403');
  expect(feedback).toContain('forbidden');
  expect(feedback).toContain('req-403');
  expect(feedback).toMatch(/no se muestra como marcada/i);
  // The stored row is untouched and the control is offered again.
  expect(markChip('alert-1')).toHaveTextContent('Sin leer');
  expect(markButtons('alert-1')[0]).toBeEnabled();
  expect(markRow('alert-1')).toHaveAttribute('aria-busy', 'false');
  // The control that fired is still available, so focus returns to it.
  expect(document.activeElement?.id).toBe(markButtonDomId('alert-1', 'read'));
});

test('404, 400 and 503 keep the row state and say what the service answered', async () => {
  await readyPage();

  await userEvent.click(markButtons('alert-1')[1]);
  await answerState('alert-1', { code: 'alert_not_found' }, 404, 'req-404');
  expect(markFeedback('alert-1')).toContain('HTTP 404');
  expect(markFeedback('alert-1')).toContain('alert_not_found');
  expect(markFeedback('alert-1')).toContain('req-404');
  expect(markChip('alert-1')).toHaveTextContent('Sin leer');

  await userEvent.click(markButtons('alert-1')[0]);
  await answerState('alert-1', { code: 'invalid_alert_state' }, 400, 'req-400');
  expect(markFeedback('alert-1')).toContain('HTTP 400');
  expect(markFeedback('alert-1')).toContain('invalid_alert_state');
  expect(markChip('alert-1')).toHaveTextContent('Sin leer');

  await userEvent.click(markButtons('alert-1')[0]);
  await answerState('alert-1', { code: 'storage_unavailable' }, 503, 'req-503');
  expect(markFeedback('alert-1')).toContain('HTTP 503');
  expect(markFeedback('alert-1')).toContain('storage_unavailable');
  expect(markFeedback('alert-1')).toContain('req-503');
  expect(markChip('alert-1')).toHaveTextContent('Sin leer');
  expect(markButtons('alert-1')[0]).toBeEnabled();
});

test('a network fault is not presented as an applied mark', async () => {
  await readyPage();
  const original = fetchStub.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === STATE_URL('alert-1')
      ? Promise.reject(new TypeError('Failed to fetch'))
      : original(input, init),
  );

  await act(async () => {
    await userEvent.click(markButtons('alert-1')[0]);
    await flush();
  });

  await waitFor(() => expect(markFeedback('alert-1')).toMatch(/sin conexión/i));
  expect(markFeedback('alert-1')).toMatch(/pudo haberse guardado/i);
  expect(markFeedback('alert-1')).toMatch(/no se muestra como aplicada/i);
  expect(markChip('alert-1')).toHaveTextContent('Sin leer');
  expect(markButtons('alert-1')[0]).toBeEnabled();
});

test('the personal filter is scoped to the loaded page and never claims anything about the register', async () => {
  await readyPage();

  const scope = document.getElementById('notifications-mark-scope');
  expect(scope).toHaveTextContent(/solo a las 2 alertas cargadas en la página 1/i);
  expect(scope).toHaveTextContent(/registro completo/i);
  expect(document.getElementById('notifications-mark-counts')).toHaveTextContent(/Sin leer: 1/);
  expect(document.getElementById('notifications-mark-counts')).toHaveTextContent(/Leídas: 1/);

  await userEvent.selectOptions(document.getElementById('notifications-mark-filter') as HTMLSelectElement, 'unread');
  expect(document.querySelectorAll('#notifications-rows tr')).toHaveLength(1);
  expect(document.querySelector('#notifications-rows tr')?.textContent).toContain('2026-11-20T16:05:00Z');

  await userEvent.selectOptions(
    document.getElementById('notifications-mark-filter') as HTMLSelectElement,
    'dismissed',
  );
  // A page-scoped failure to match is not the empty register and not an error.
  expect(document.getElementById('notifications-table')).toBeNull();
  expect(document.getElementById('notifications-empty-title')).toBeNull();
  const empty = document.getElementById('notifications-filter-empty');
  expect(empty).toHaveTextContent(/ninguna alerta de la página 1/i);
  expect(empty).toHaveTextContent(/Revisadas/);
  expect(empty).toHaveTextContent(/registro completo/i);

  await userEvent.click(document.getElementById('notifications-mark-filter-clear') as HTMLButtonElement);
  expect(document.querySelectorAll('#notifications-rows tr')).toHaveLength(2);
  expect(document.getElementById('notifications-filter-empty')).toBeNull();
});

test('the mark lives on the server: the page writes no browser storage at all', async () => {
  await readyPage();
  await userEvent.click(markButtons('alert-1')[0]);
  await answerState('alert-1', stateFixture('alert-1', { state: 'read', marked_at: '2026-11-21T10:00:00Z' }));
  await userEvent.selectOptions(document.getElementById('notifications-mark-filter') as HTMLSelectElement, 'read');

  // `connect()` performs the only storage write of the whole flow (the PKCE
  // transaction) and the callback consumes it, so both stores carry no mark and
  // end without the transaction the sign-in left behind.
  expect(storageStub.writes).toHaveLength(1);
  expect(storageStub.removals).toContain(pkceTransactionKey);
  expect([...storageStub.snapshot().keys()]).toEqual([]);
  expect(localStub.writes).toEqual([]);
  expect([...localStub.snapshot().keys()]).toEqual([]);

  // A source-level guard, because a future edit could add storage inside a branch
  // these interactions never take.
  for (const source of ['src/views/NotificationsView.tsx', 'src/core/notifications.ts']) {
    const text = readFileSync(resolve(process.cwd(), source), 'utf8');
    expect(text, source).not.toMatch(/localStorage|sessionStorage/);
  }
});

test('the corrected copy states the personal mark, still creates nothing and sends nothing', async () => {
  await connect();
  render(<NotificationsView />);

  const subtitle = document.querySelector('#notifications .subheading')?.textContent ?? '';
  expect(subtitle).toMatch(/marca personal/i);
  expect(subtitle).not.toMatch(/no las marca/i);

  const chips = document.querySelector('#notifications .decision-head__chips')?.textContent ?? '';
  expect(chips).toContain('SIN ENVÍO DE AVISOS');
  expect(chips).toContain('MARCA PERSONAL');
  expect(chips).not.toContain('SOLO LECTURA');

  // The executive panel is outside this task: its count keeps the unfiltered
  // semantics of `active_alerts.count` and it never reads the mark seam.
  const panel = readFileSync(
    resolve(process.cwd(), 'src', 'components', 'executive', 'ExecutivePanel.tsx'),
    'utf8',
  );
  expect(panel).toContain('{summary.active_alerts.count}');
  expect(panel).not.toMatch(/riskAlertState|core\/notifications/);
});

// ── Verification round 2: transport strictness, honest refusals, focus ─────

test('a served mark outside the frozen status or instant shape is unavailable, never applied', async () => {
  await connect();
  render(<NotificationsView />);
  await waitFor(() => expect(fetchStub.callsFor(`${ALERTS_URL}?order=desc`)).toHaveLength(1));
  await answerAlerts(`${ALERTS_URL}?order=desc`, {
    items: [alertFixture(), alertFixture({ id: 'alert-2' }), alertFixture({ id: 'alert-3' })],
    next_cursor: null,
  });
  await waitFor(() => expect(fetchStub.callsFor(STATE_URL('alert-1'))).toHaveLength(1));

  // 201 is `ok` to fetch but is not the status the route defines.
  await answerState('alert-1', stateFixture('alert-1'), 201);
  // A date is not an instant: `marked_at` must carry the time and the offset.
  await answerState('alert-2', stateFixture('alert-2', { marked_at: '2026-11-27' }));
  await answerState('alert-3', stateFixture('alert-3'));

  expect(markChip('alert-1')).toBeNull();
  expect(document.getElementById(markCellDomId('alert-1'))).toHaveTextContent(/marca no disponible/i);
  expect(markChip('alert-2')).toBeNull();
  expect(document.getElementById(markCellDomId('alert-2'))).toHaveTextContent(/marca no disponible/i);
  expect(markButtons('alert-1')[0]).toBeDisabled();
  expect(markChip('alert-3')).toHaveTextContent('Sin leer');

  // A write answered 204 carries no stored mark, so the row is not repainted.
  await userEvent.click(markButtons('alert-3')[0]);
  await answerState('alert-3', null, 204);
  expect(markFeedback('alert-3')).toContain('HTTP 204');
  expect(markFeedback('alert-3')).toMatch(/no la muestra como aplicada/i);
  expect(markChip('alert-3')).toHaveTextContent('Sin leer');
});

test('429 and 503 say the mark was not applied; only a 502 leaves the outcome undetermined', async () => {
  await readyPage();

  await userEvent.click(markButtons('alert-1')[0]);
  await answerState('alert-1', { code: 'rate_limited' }, 429, 'req-429');
  expect(markFeedback('alert-1')).toContain('HTTP 429');
  expect(markFeedback('alert-1')).toContain('req-429');
  expect(markFeedback('alert-1')).toMatch(/no se registró/i);
  expect(markFeedback('alert-1')).not.toMatch(/pudo haberse guardado/i);
  expect(markChip('alert-1')).toHaveTextContent('Sin leer');

  await userEvent.click(markButtons('alert-1')[0]);
  await answerState('alert-1', { code: 'storage_unavailable' }, 503, 'req-503b');
  expect(markFeedback('alert-1')).toContain('HTTP 503');
  expect(markFeedback('alert-1')).toMatch(/no se registró/i);
  expect(markFeedback('alert-1')).not.toMatch(/pudo haberse guardado/i);
  expect(markChip('alert-1')).toHaveTextContent('Sin leer');

  // 502 is the one transport answer that does not prove completion either way.
  await userEvent.click(markButtons('alert-1')[0]);
  await answerState('alert-1', { code: 'upstream_unavailable' }, 502, 'req-502');
  expect(markFeedback('alert-1')).toContain('HTTP 502');
  expect(markFeedback('alert-1')).toMatch(/pudo haberse guardado/i);
  expect(markChip('alert-1')).toHaveTextContent('Sin leer');
});

test('the mark confirmation survives the filtered row leaving the table and focus moves to the next row', async () => {
  await readyPage(stateFixture('alert-1'), stateFixture('alert-2'));
  await userEvent.selectOptions(document.getElementById('notifications-mark-filter') as HTMLSelectElement, 'unread');
  expect(document.querySelectorAll('#notifications-rows tr')).toHaveLength(2);

  await userEvent.click(markButtons('alert-1')[0]);
  await answerState('alert-1', stateFixture('alert-1', { state: 'read', marked_at: '2026-11-21T10:00:00Z' }));

  // The row no longer matches «Sin leer», so it leaves the visible table.
  expect(document.querySelectorAll('#notifications-rows tr')).toHaveLength(1);
  expect(markChip('alert-1')).toBeNull();
  expect(markChip('alert-2')).toHaveTextContent('Sin leer');

  // The confirmation is announced by a region that is still mounted.
  const live = document.getElementById('notifications-mark-status');
  expect(live).toHaveAttribute('role', 'status');
  expect(live).toHaveAttribute('aria-live', 'polite');
  expect(live).toHaveTextContent(/marca registrada: «Leída»/i);

  // Focus moves to the row that took its place, never to the document body.
  expect(document.activeElement?.id).toBe(markCellDomId('alert-2'));
  expect(document.activeElement).not.toBe(document.body);
});

test('when the active filter empties the page, focus lands on the filter card heading', async () => {
  await readyPage(
    stateFixture('alert-1'),
    stateFixture('alert-2', { state: 'read', marked_at: '2026-11-19T12:00:00Z' }),
  );
  await userEvent.selectOptions(document.getElementById('notifications-mark-filter') as HTMLSelectElement, 'unread');
  expect(document.querySelectorAll('#notifications-rows tr')).toHaveLength(1);

  await userEvent.click(markButtons('alert-1')[0]);
  await answerState('alert-1', stateFixture('alert-1', { state: 'read', marked_at: '2026-11-21T10:00:00Z' }));

  expect(document.querySelectorAll('#notifications-rows tr')).toHaveLength(0);
  const title = document.getElementById('notifications-filter-empty-title');
  expect(title).not.toBeNull();
  expect(document.activeElement?.id).toBe('notifications-filter-empty-title');
  expect(document.activeElement).not.toBe(document.body);
  expect(document.getElementById('notifications-mark-status')).toHaveTextContent(/marca registrada: «Leída»/i);
});

test('a late PUT from the page the user left never overwrites the marks of the page on screen', async () => {
  await readyPage();
  await userEvent.click(markButtons('alert-1')[0]);

  // The user leaves page 1 while its write is still in flight.
  await userEvent.click(document.querySelector('button#notifications-next') as HTMLButtonElement);
  await waitFor(() => expect(fetchStub.callsFor(`${ALERTS_URL}?order=desc&cursor=cursor-2`)).toHaveLength(1));
  await answerAlerts(`${ALERTS_URL}?order=desc&cursor=cursor-2`, {
    items: [alertFixture({ id: 'alert-3' })],
    next_cursor: null,
  });
  await waitFor(() => expect(fetchStub.callsFor(STATE_URL('alert-3'))).toHaveLength(1));
  await answerState('alert-3', stateFixture('alert-3', { state: 'read', marked_at: '2026-11-23T07:00:00Z' }));
  expect(markChip('alert-3')).toHaveTextContent('Leída');

  // Page 1's write finally answers. Its page is no longer on screen.
  await answerState('alert-1', stateFixture('alert-1', { state: 'read', marked_at: '2026-11-21T10:00:00Z' }));

  expect(document.getElementById('notifications-page')).toHaveTextContent('Página 2');
  expect(document.querySelectorAll('#notifications-rows tr')).toHaveLength(1);
  // Page 2 keeps the mark its own read served: no stuck «Consultando marca…».
  expect(markChip('alert-3')).toHaveTextContent('Leída');
  expect(document.getElementById(markCellDomId('alert-3'))?.textContent).not.toMatch(/consultando marca/i);
  // The stale confirmation belongs to the page the user left and is not announced here.
  expect(document.getElementById('notifications-mark-status')).not.toHaveTextContent(/marca registrada/i);
});

test('a 401 on the mark keeps its envelope visible in the page mark status', async () => {
  await readyPage();
  await userEvent.click(markButtons('alert-1')[0]);
  await answerState('alert-1', { code: 'invalid_token', request_id: 'req-401-body' }, 401);

  // The register restarts signed out, but the view keeps the message mounted.
  expect(getSessionSnapshot().status).toBe('signed-out');
  expect(document.getElementById('notifications-rows')).toBeNull();
  const live = document.getElementById('notifications-mark-status');
  expect(live).not.toBeNull();
  expect(live).toHaveTextContent(/invalid_token/);
  expect(live).toHaveTextContent(/req-401-body/);
  expect(live).toHaveTextContent(/no se registró/i);
});

// ── Verification round 3: canonical spelling, UTC instants, session guards ──

test('a 401 on a per-row state read keeps its envelope visible after the sign-out remount', async () => {
  await connect();
  render(<NotificationsView />);
  await waitFor(() => expect(fetchStub.callsFor(`${ALERTS_URL}?order=desc`)).toHaveLength(1));
  await answerAlerts(`${ALERTS_URL}?order=desc`, {
    items: [alertFixture(), alertFixture({ id: 'alert-2' })],
    next_cursor: null,
  });
  await waitFor(() => expect(fetchStub.callsFor(STATE_URL('alert-1'))).toHaveLength(1));

  await answerState('alert-1', { code: 'invalid_token', request_id: 'req-get-401' }, 401);

  // The register restarts signed out, so the read's refusal has to survive it.
  expect(getSessionSnapshot().status).toBe('signed-out');
  const live = document.getElementById('notifications-mark-status');
  expect(live).not.toBeNull();
  expect(live).toHaveTextContent(/invalid_token/);
  expect(live).toHaveTextContent(/req-get-401/);
});

test('a 401 from a PUT started on a page the user left does not become this page notice', async () => {
  await readyPage();
  await userEvent.click(markButtons('alert-1')[0]);

  // The user leaves page 1 while its write is still in flight.
  await userEvent.click(document.querySelector('button#notifications-next') as HTMLButtonElement);
  await waitFor(() => expect(fetchStub.callsFor(`${ALERTS_URL}?order=desc&cursor=cursor-2`)).toHaveLength(1));
  await answerAlerts(`${ALERTS_URL}?order=desc&cursor=cursor-2`, {
    items: [alertFixture({ id: 'alert-3' })],
    next_cursor: null,
  });
  await waitFor(() => expect(fetchStub.callsFor(STATE_URL('alert-3'))).toHaveLength(1));
  await answerState('alert-3', stateFixture('alert-3'));
  expect(markChip('alert-3')).toHaveTextContent('Sin leer');

  // The stale write answers 401. The bearer is still the session's, so the session
  // is lowered — but the refusal belongs to the page the user left.
  await answerState('alert-1', { code: 'invalid_token', request_id: 'req-put-a401' }, 401);

  expect(getSessionSnapshot().status).toBe('signed-out');
  const live = document.getElementById('notifications-mark-status');
  expect(live).not.toBeNull();
  expect(live?.textContent).toBe('');
});
