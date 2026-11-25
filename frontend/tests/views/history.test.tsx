import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { clearZoneState, selectZone } from '../../src/app/store';
import { gatewayOrigin, issuer, pkceTransactionKey } from '../../src/config';
import { completeLogin, resetSession } from '../../src/core/session';
import type { RiskBatch } from '../../src/types/api';
import { HistoryView } from '../../src/views/HistoryView';

import { createFetchStub, createStorageStub, flush, jwt } from '../core/harness';

// N8b — the history view. The panel shows the rows `/v1/risk/history` returned
// for the SELECTED zone; search and the data-status filter narrow only those
// rows in memory, the badge keeps reporting what the API returned, and the
// per-zone limit stays stated. This suite stubs `fetch` end to end so no test
// can substitute fixture data when the read fails.

const TOKEN_URL = `${issuer}/protocol/openid-connect/token`;
const ZONE = '05102';
const HISTORY_URL = `${gatewayOrigin}/v1/risk/history?zone_id=${ZONE}`;

function batch(id: string, overrides: Partial<RiskBatch> = {}): RiskBatch {
  return {
    zone_id: ZONE,
    id,
    job_id: `job-${id}`,
    demo: true,
    risk_level: 'alto',
    factors: [{ name: 'temperatura', known: true, value: 30, contribution: 0.2 }],
    rationale: 'Regla académica',
    policy: { policy_id: 'academic-rule-v1', params_hash: 'hash', parameters: { weight: '0.2' } },
    notice: 'Sintético',
    ...overrides,
  };
}

function prepare() {
  const fetchStub = createFetchStub();
  const storageStub = createStorageStub();
  vi.stubGlobal('fetch', fetchStub.fetch);
  vi.stubGlobal('sessionStorage', storageStub.storage);
  return { fetchStub, storageStub };
}

async function connect(): Promise<ReturnType<typeof prepare>> {
  const context = prepare();
  const token = jwt({ realm_access: { roles: ['viewer'] } });
  context.storageStub.storage.setItem(pkceTransactionKey, JSON.stringify({ state: 's', verifier: 'v' }));
  const login = completeLogin('?code=code-1&state=s');
  await flush();
  context.fetchStub.answer(TOKEN_URL, { access_token: token });
  await login;
  context.fetchStub.calls.length = 0;
  return context;
}

function state(): HTMLElement {
  return document.getElementById('history-state') as HTMLElement;
}
function tbody(): HTMLElement {
  return document.getElementById('history-rows') as HTMLElement;
}
function count(): string {
  return document.getElementById('history-count')?.textContent ?? '';
}
function visibleCount(): string {
  return document.getElementById('history-visible-count')?.textContent ?? '';
}

beforeEach(() => {
  resetSession();
  clearZoneState();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('the section keeps id=history, data-view=history and the seven legacy anchors', () => {
  prepare();
  render(<HistoryView />);

  const section = document.getElementById('history');
  expect(section).not.toBeNull();
  expect(section).toHaveAttribute('data-view', 'history');
  expect(document.getElementById('history-title')).not.toBeNull();

  for (const id of [
    'history-count',
    'history-query',
    'history-status-filter',
    'history-visible-count',
    'history-state',
    'history-rows',
  ]) {
    expect(document.getElementById(id)).not.toBeNull();
  }
});

test('the per-zone limit note stays visible inside the view', () => {
  prepare();
  render(<HistoryView />);

  const note = document.querySelector('#history .unimplemented-note');
  expect(note).not.toBeNull();
  expect(note).toHaveTextContent(/Historial de todas las zonas/);
  expect(note).toHaveTextContent(/zone_id/);
});

test('without a session the panel asks to connect and issues no read', () => {
  const { fetchStub } = prepare();
  render(<HistoryView />);

  expect(fetchStub.callsFor(HISTORY_URL)).toHaveLength(0);
  expect(state()).toHaveTextContent('Conecta un token autorizado para consultar el historial.');
});

test('signed in without a selected zone the panel asks for one and issues no read', async () => {
  const { fetchStub } = await connect();
  render(<HistoryView />);
  await flush();

  expect(fetchStub.callsFor(HISTORY_URL)).toHaveLength(0);
  expect(state()).toHaveTextContent('Selecciona una zona para consultar el historial.');
});

test('a read in flight states the load and shows no rows until the API answers', async () => {
  const { fetchStub } = await connect();
  selectZone(ZONE);
  render(<HistoryView />);
  await flush();

  expect(fetchStub.callsFor(HISTORY_URL)).toHaveLength(1);
  expect(state()).toHaveTextContent('Consultando historial…');
  expect(tbody().children).toHaveLength(0);

  fetchStub.answer(HISTORY_URL, []);
  await waitFor(() => expect(state()).toHaveTextContent('La API devolvió un historial vacío.'));
});

test('renders only the selected zone rows and counts what the API returned', async () => {
  const { fetchStub } = await connect();
  selectZone(ZONE);
  render(<HistoryView />);
  await flush();

  fetchStub.answer(HISTORY_URL, [
    batch('lote-uno', { requested_at: '2026-01-01T00:00:00Z', data_status: 'sufficient' }),
    batch('lote-dos', { requested_at: '2026-02-02T00:00:00Z', data_status: 'insufficient' }),
  ]);
  await waitFor(() => expect(count()).toBe('2'));

  expect(tbody().children).toHaveLength(2);
  expect(visibleCount()).toBe('2 de 2');
  expect(state()).toHaveTextContent('Registros sintéticos devueltos por la API.');
  expect(fetchStub.callsFor(HISTORY_URL)).toHaveLength(1);
});

test('search and the data-status filter narrow only the returned rows and issue no new read', async () => {
  const { fetchStub } = await connect();
  selectZone(ZONE);
  render(<HistoryView />);
  await flush();

  fetchStub.answer(HISTORY_URL, [
    batch('lote-uno', { requested_at: '2026-01-01T00:00:00Z', data_status: 'sufficient' }),
    batch('lote-dos', { requested_at: '2026-02-02T00:00:00Z', data_status: 'insufficient' }),
  ]);
  await waitFor(() => expect(count()).toBe('2'));
  const readsAfterLoad = fetchStub.callsFor(HISTORY_URL).length;

  const filter = screen.getByLabelText('Filtrar el historial por estado del dato');
  fireEvent.change(filter, { target: { value: 'insufficient' } });
  expect(tbody().children).toHaveLength(1);
  expect(visibleCount()).toBe('1 de 2');
  expect(count()).toBe('2');
  expect(fetchStub.callsFor(HISTORY_URL)).toHaveLength(readsAfterLoad);

  const query = screen.getByLabelText('Buscar en el historial de la zona');
  fireEvent.change(query, { target: { value: 'lote-uno' } });
  expect(tbody().children).toHaveLength(0);
  expect(fetchStub.callsFor(HISTORY_URL)).toHaveLength(readsAfterLoad);

  fireEvent.change(query, { target: { value: '' } });
  fireEvent.change(filter, { target: { value: '' } });
  expect(tbody().children).toHaveLength(2);
  expect(visibleCount()).toBe('2 de 2');
});

// The artboard explains the absence instead of leaving one line: a zone with no
// published lot was not measured as low risk.
test('an empty history states that absence is not a low risk level', async () => {
  const { fetchStub } = await connect();
  selectZone(ZONE);
  render(<HistoryView />);
  await flush();

  fetchStub.answer(HISTORY_URL, []);
  await waitFor(() => expect(count()).toBe('0'));

  expect(state()).toHaveTextContent('Esta zona no tiene lotes ni evaluación al corte.');
  expect(state()).toHaveTextContent('La ausencia de datos no es un nivel bajo.');
  // Nothing to reveal, so the period reset is not offered.
  expect(document.getElementById('history-show-period')).toBeNull();
});

// The rows the API returned exist; the filters are what hid them. The in-panel
// reset gives the period back without the reader having to find the search box.
test('filters that hide every returned row offer the whole period back', async () => {
  const { fetchStub } = await connect();
  selectZone(ZONE);
  render(<HistoryView />);
  await flush();

  fetchStub.answer(HISTORY_URL, [batch('lote-uno', { data_status: 'sufficient' })]);
  await waitFor(() => expect(count()).toBe('1'));

  fireEvent.change(screen.getByLabelText('Buscar en el historial de la zona'), {
    target: { value: 'sin coincidencias' },
  });
  expect(tbody().children).toHaveLength(0);
  expect(visibleCount()).toBe('0 de 1');
  expect(state()).toHaveTextContent('No hay lotes que coincidan con los filtros.');

  const reset = document.getElementById('history-show-period') as HTMLButtonElement;
  expect(reset).not.toBeNull();
  expect(reset).toHaveTextContent('Ver todo el periodo');

  fireEvent.click(reset);
  expect((screen.getByLabelText('Buscar en el historial de la zona') as HTMLInputElement).value).toBe('');
  expect(tbody().children).toHaveLength(1);
  expect(document.getElementById('history-show-period')).toBeNull();
});

// The badge spoke a bare number, so its meaning depended on where it sat on the
// page. The name travels with it in document order, before the number it names.
test('the count badge is named for a reader before its number', async () => {
  const { fetchStub } = await connect();
  selectZone(ZONE);
  render(<HistoryView />);
  await flush();

  fetchStub.answer(HISTORY_URL, [batch('lote-uno')]);
  await waitFor(() => expect(count()).toBe('1'));

  const label = document.querySelector('#history .intro-row > .sr-only');
  expect(label).toHaveTextContent('Lotes devueltos:');
  expect(label?.nextElementSibling?.id).toBe('history-count');
  expect(count()).toBe('1');
});

// 4.1.3 — the result count is the only copy that reports what survived the// filters, and a search that drops every row changes it without moving focus,
// so the count must expose itself as a status message instead of a silently
// repainted span. No other live region in the view repeats it.
test('the visible count exposes itself as a polite status message', async () => {
  const { fetchStub } = await connect();
  selectZone(ZONE);
  render(<HistoryView />);
  await flush();

  fetchStub.answer(HISTORY_URL, [
    batch('lote-uno', { requested_at: '2026-01-01T00:00:00Z', data_status: 'sufficient' }),
  ]);
  await waitFor(() => expect(visibleCount()).toBe('1 de 1'));

  fireEvent.change(screen.getByLabelText('Buscar en el historial de la zona'), {
    target: { value: 'sin-coincidencias' },
  });

  const badge = document.getElementById('history-visible-count') as HTMLElement;
  expect(tbody().children).toHaveLength(0);
  expect(visibleCount()).toBe('0 de 1');
  expect(badge).toHaveAttribute('role', 'status');
  expect(badge).toHaveAttribute('aria-live', 'polite');
});

test('a 503 read is stated as unavailable and never rendered as a row', async () => {
  const { fetchStub } = await connect();
  selectZone(ZONE);
  render(<HistoryView />);
  await flush();

  fetchStub.answer(HISTORY_URL, { code: 'down' }, 503);
  await waitFor(() => expect(state()).toHaveTextContent(/No se pudo consultar el historial/i));

  expect(state().textContent).toContain('503');
  expect(tbody().children).toHaveLength(0);
  expect(count()).toBe('—');
});

test('a 403 read is stated as a denied permission, never as missing data', async () => {
  const { fetchStub } = await connect();
  selectZone(ZONE);
  render(<HistoryView />);
  await flush();

  fetchStub.answer(HISTORY_URL, { code: 'forbidden' }, 403);
  await waitFor(() => expect(state()).toHaveTextContent(/permiso/i));

  expect(state().textContent).toContain('403');
  expect(state().textContent).not.toMatch(/vac[ií]o/i);
  expect(tbody().children).toHaveLength(0);
  expect(count()).toBe('—');
});

test('an unreadable payload is rejected and never rendered as a row', async () => {
  const { fetchStub } = await connect();
  selectZone(ZONE);
  render(<HistoryView />);
  await flush();

  fetchStub.answerMalformedJson(HISTORY_URL);
  await waitFor(() => expect(state()).toHaveTextContent(/ilegible/i));
  expect(tbody().children).toHaveLength(0);
  expect(count()).toBe('—');
});

test('a row whose shape fails the guard is rejected as a whole, never partially shown', async () => {
  const { fetchStub } = await connect();
  selectZone(ZONE);
  render(<HistoryView />);
  await flush();

  fetchStub.answer(HISTORY_URL, [{ ...batch('roto'), factors: [{ name: 'viento', known: true }] }]);
  await waitFor(() => expect(state()).toHaveTextContent(/ilegible/i));
  expect(tbody().children).toHaveLength(0);
});

test('logout clears the rows and returns the panel to the connect state', async () => {
  const { fetchStub } = await connect();
  selectZone(ZONE);
  render(<HistoryView />);
  await flush();

  fetchStub.answer(HISTORY_URL, [batch('lote-uno')]);
  await waitFor(() => expect(count()).toBe('1'));

  resetSession();
  await waitFor(() => expect(state()).toHaveTextContent('Conecta un token autorizado para consultar el historial.'));
  expect(tbody().children).toHaveLength(0);
  expect(count()).toBe('—');
});

// S3 — the stylesheet hides the rows table and the filter bar of a history
// panel that carries no `has-rows` (`.history-panel:not(.has-rows) .table-wrap,
// .history-panel:not(.has-rows) .filter-bar { display: none }`), so the class is
// the view's to state and it must be right in both directions: a missing class
// hides the controls that clear a filter, and a stale one keeps an empty table
// on screen.
test('the history panel carries has-rows exactly when the read returned rows', async () => {
  const { fetchStub } = await connect();
  selectZone(ZONE);
  render(<HistoryView />);
  await flush();

  const panel = (): Element | null => document.querySelector('#history article.panel.history-panel');
  expect(panel()).not.toBeNull();
  // No rows have been read yet: the class is absent.
  expect(panel()).not.toHaveClass('has-rows');

  fetchStub.answer(HISTORY_URL, [batch('lote-uno')]);
  await waitFor(() => expect(count()).toBe('1'));
  expect(panel()).toHaveClass('has-rows');

  // The class reports what the API returned, not what survived the filter: a
  // search that narrows the table to zero rows must not hide the filter bar.
  fireEvent.change(screen.getByLabelText('Buscar en el historial de la zona'), { target: { value: 'no-existe' } });
  expect(tbody().children).toHaveLength(0);
  expect(panel()).toHaveClass('has-rows');

  // A second zone whose read answers with no rows reads the same way, and the
  // logout that clears the rows drops the class with them.
  selectZone('05103');
  await waitFor(() => expect(state()).toHaveTextContent('Consultando historial…'));
  fetchStub.answer(`${gatewayOrigin}/v1/risk/history?zone_id=05103`, []);
  await waitFor(() => expect(state()).toHaveTextContent('La API devolvió un historial vacío.'));
  expect(panel()).not.toHaveClass('has-rows');

  resetSession();
  await waitFor(() => expect(state()).toHaveTextContent('Conecta un token autorizado para consultar el historial.'));
  expect(panel()).not.toHaveClass('has-rows');
});

test('history returned for another zone is discarded with a terminal state', async () => {
  const { fetchStub } = await connect();
  selectZone(ZONE);
  render(<HistoryView />);
  await flush();

  fetchStub.answer(HISTORY_URL, [batch('ajena', { zone_id: '05501' })]);
  await waitFor(() => expect(state()).toHaveTextContent(/otra zona/i));
  expect(tbody().children).toHaveLength(0);
});
