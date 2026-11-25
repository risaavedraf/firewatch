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

async function connect(clearCalls = true): Promise<void> {
  storageStub.storage.setItem(pkceTransactionKey, JSON.stringify({ state: 's', verifier: 'verifier' }));
  const login = completeLogin('?code=code-1&state=s');
  await flush();
  fetchStub.answer(TOKEN_URL, { access_token: VIEWER_TOKEN, id_token: 'id-token' });
  await login;
  if (clearCalls) fetchStub.calls.length = 0;
}

function alertFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'alert-1',
    zone_id: '05501',
    zone_name: 'Valparaíso',
    previous_level: 'bajo',
    new_level: 'alto',
    threshold: 1,
    occurred_at: '2026-11-20T16:05:00Z',
    demo: true,
    ...overrides,
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
          id: 'alert-1',
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
  expect(headers).toEqual(['Fecha', 'Sector', 'Cambio de nivel', 'Procedencia']);
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

  expect(document.getElementById('notifications-empty-title')).toHaveTextContent('Sin notificaciones');
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
