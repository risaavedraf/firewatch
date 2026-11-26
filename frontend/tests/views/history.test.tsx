import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { clearZoneState, selectZone } from '../../src/app/store';
import { gatewayOrigin, issuer, pkceTransactionKey } from '../../src/config';
import { historySeries, type HistoryGranularity } from '../../src/core/api';
import { completeLogin, resetSession } from '../../src/core/session';
import type { RiskBatch } from '../../src/types/api';
import { HistoryView } from '../../src/views/HistoryView';

import { createFetchStub, createStorageStub, flush, jwt } from '../core/harness';

// N8b — the history view. The panel shows the rows `/v1/risk/history` returned
// for the SELECTED zone; search and the data-status filter narrow only those
// rows in memory, the badge keeps reporting what the API returned, and the
// per-zone limit stays stated. This suite stubs `fetch` end to end so no test
// can substitute fixture data when the read fails.
//
// PM-13 adds the export control to the same panel, so the same rule applies to
// the downloaded document: it is the zone's history as the export route served
// it, never the filtered table and never a locally rebuilt file. The CSV double
// below answers a raw byte document; the shared JSON double is untouched.

const TOKEN_URL = `${issuer}/protocol/openid-connect/token`;
const ZONE = '05102';
const HISTORY_URL = `${gatewayOrigin}/v1/risk/history?zone_id=${ZONE}`;
const CSV_URL = `${gatewayOrigin}/v1/risk/history.csv?zone_id=${ZONE}`;
// The frozen column seam of the export (backend history_csv.go / OpenAPI).
const CSV_HEADER =
  'zone_id,batch_id,job_id,requested_at,published_at,valid_until,model_version,risk_level,data_status,synthetic,scenario_id,evaluated_at';

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

// The export is a byte document, which the shared JSON double deliberately does
// not speak. This wrapper serves it and delegates every other call — login, the
// JSON history read — to that double, so the existing JSON coverage is
// unaffected. The CSV promise ignores abort on purpose: the view and the
// transport must discard a stale answer on their own, not because the test
// double refused to deliver it.
interface CsvReply {
  status: number;
  body: string;
  contentType: string | null;
}

function serveCsv(fetchStub: ReturnType<typeof createFetchStub>) {
  const pending: { url: string; resolve: (reply: CsvReply) => void }[] = [];
  const calls: string[] = [];
  const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (!url.startsWith(`${gatewayOrigin}/v1/risk/history.csv`)) return fetchStub.fetch(input, init);
    calls.push(url);
    return new Promise<Response>((resolve) => {
      pending.push({
        url,
        resolve: (reply) => {
          const headers = new Headers();
          if (reply.contentType !== null) headers.set('Content-Type', reply.contentType);
          resolve(new Response(reply.body, { status: reply.status, headers }));
        },
      });
    });
  };
  vi.stubGlobal('fetch', fetch);
  return {
    calls,
    pending: (): number => pending.length,
    answer(text = `${CSV_HEADER}\n`, init: Partial<CsvReply> = {}): void {
      const entry = pending.shift();
      if (!entry) throw new Error('no pending CSV request');
      entry.resolve({ status: 200, body: text, contentType: 'text/csv; charset=utf-8', ...init });
    },
  };
}

// jsdom has no `URL.createObjectURL` and no download navigation, so the save is
// observed at exactly the two seams the browser uses: the Blob handed to the
// object URL, and the anchor's `download` name at click time.
function captureDownloads() {
  const blobs: Blob[] = [];
  const names: string[] = [];
  const createObjectURL = vi.fn<(blob: Blob | MediaSource) => string>((blob) => {
    blobs.push(blob as Blob);
    return `blob:test-${blobs.length}`;
  });
  const revokeObjectURL = vi.fn<(url: string) => void>();
  class StubURL extends URL {
    static override createObjectURL = createObjectURL;
    static override revokeObjectURL = revokeObjectURL;
  }
  vi.stubGlobal('URL', StubURL);
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    names.push(this.download);
  });
  return { blobs, names, createObjectURL, revokeObjectURL };
}

function downloadButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Descargar CSV' });
}

function csvStatus(): HTMLElement {
  return document.getElementById('history-csv-status') as HTMLElement;
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

// PM-04 — the capability this note declared is delivered, so the note itself is
// gone. The label that replaces it is per-mode and asserted with the series
// below; what stays pinned here is that the panel no longer tells the reader the
// history of every zone does not exist.
test('the panel no longer declares the all-zones history as unimplemented', () => {
  prepare();
  render(<HistoryView />);

  expect(document.querySelector('#history .unimplemented-note')).toBeNull();
  expect(document.getElementById('history')).not.toHaveTextContent(/NO IMPLEMENTADO/);
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

// ── PM-13 / S1–S2 — the CSV export ──────────────────────────────────────────
// The export downloads the history of the SELECTED zone from
// `/v1/risk/history.csv`: the same bounded window the table shows, before the
// in-memory search and status filter, and the file is saved from the served
// bytes rather than rebuilt in the page. Every case below is driven through the
// public view; the CSV double answers a raw document and ignores abort, so a
// stale answer is discarded by the page itself.

test('the export is an accessible control that states its scope and reads nothing on its own', async () => {
  const { fetchStub } = await connect();
  const csv = serveCsv(fetchStub);
  selectZone(ZONE);
  render(<HistoryView />);
  await flush();

  fetchStub.answer(HISTORY_URL, [batch('lote-uno')]);
  await waitFor(() => expect(count()).toBe('1'));

  const button = downloadButton();
  expect(button).toHaveAttribute('type', 'button');
  expect(button).toBeEnabled();
  expect(button).not.toHaveAttribute('aria-busy');
  expect(button).toHaveAttribute('aria-describedby', 'history-csv-note');
  const note = document.getElementById('history-csv-note') as HTMLElement;
  expect(note).toHaveTextContent(/history\.csv/);
  expect(note).toHaveTextContent(/sin aplicar la búsqueda ni el filtro de estado/i);
  expect(note).toHaveTextContent(/no se recodifica/i);
  expect(csvStatus()).toHaveTextContent('Listo para descargar el historial de la zona 05102.');
  // Merely rendering the panel never issues the export.
  expect(csv.calls).toHaveLength(0);
});

test('without a session the export control is disabled and issues no read', () => {
  const { fetchStub } = prepare();
  const csv = serveCsv(fetchStub);
  render(<HistoryView />);

  expect(downloadButton()).toBeDisabled();
  expect(csvStatus()).toHaveTextContent('La descarga necesita una sesión autorizada; no se solicitó nada.');
  expect(csv.calls).toHaveLength(0);
});

test('signed in without a zone the export control is disabled and asks for one', async () => {
  const { fetchStub } = await connect();
  const csv = serveCsv(fetchStub);
  render(<HistoryView />);
  await flush();

  expect(downloadButton()).toBeDisabled();
  expect(csvStatus()).toHaveTextContent('Selecciona una zona para descargar su historial.');
  expect(csv.calls).toHaveLength(0);
});

test('a download saves the served bytes under a safe local name for the selected zone', async () => {
  const { fetchStub } = await connect();
  const csv = serveCsv(fetchStub);
  const download = captureDownloads();
  selectZone(ZONE);
  render(<HistoryView />);
  await flush();

  fetchStub.answer(HISTORY_URL, [
    batch('lote-uno', { data_status: 'sufficient' }),
    batch('lote-dos', { data_status: 'insufficient' }),
  ]);
  await waitFor(() => expect(count()).toBe('2'));

  // The served document: a raw CRLF inside a quoted cell, and the export's own
  // header. The page must save these bytes, not a re-serialised equivalent.
  const served = [
    CSV_HEADER,
    '05102,lote-uno,job-lote-uno,2026-01-01T00:00:00Z,2026-01-01T00:10:00Z,2026-01-02T00:00:00Z,model-v1,alto,sufficient,yes,"primera\r\nsegunda",2026-01-01T00:00:00Z',
    '05102,lote-dos,job-lote-dos,2026-02-02T00:00:00Z,2026-02-02T00:10:00Z,2026-02-03T00:00:00Z,model-v1,alto,insufficient,yes,"",2026-02-02T00:00:00Z',
    '',
  ].join('\n');

  fireEvent.click(downloadButton());

  expect(csv.calls).toEqual([CSV_URL]);
  expect(downloadButton()).toHaveAttribute('aria-busy', 'true');
  expect(downloadButton()).toHaveAttribute('aria-disabled', 'true');
  // The control keeps focus while the read is in flight: it is busy, not gone.
  expect(downloadButton()).toBeEnabled();
  expect(csvStatus()).toHaveTextContent('Preparando la descarga del historial de la zona 05102…');
  // A second click while the read is in flight is not a second request.
  fireEvent.click(downloadButton());
  expect(csv.calls).toHaveLength(1);

  csv.answer(served);
  await waitFor(() => expect(csvStatus()).toHaveTextContent(/Descarga iniciada/));

  expect(download.names).toEqual(['risk-history-05102.csv']);
  expect(download.blobs).toHaveLength(1);
  const saved = download.blobs[0];
  // Byte-for-byte, not "equivalent": the CRLF and the quoted cell survive intact.
  expect(Array.from(new Uint8Array(await saved.arrayBuffer()))).toEqual(Array.from(new TextEncoder().encode(served)));
  expect(await saved.text()).toBe(served);
  await waitFor(() => expect(download.revokeObjectURL).toHaveBeenCalledWith('blob:test-1'));
  expect(downloadButton()).not.toHaveAttribute('aria-busy');
  expect(downloadButton()).not.toHaveAttribute('aria-disabled');
});

test('the export is the zone history even when the table filter narrows it', async () => {
  const { fetchStub } = await connect();
  const csv = serveCsv(fetchStub);
  const download = captureDownloads();
  selectZone(ZONE);
  render(<HistoryView />);
  await flush();

  fetchStub.answer(HISTORY_URL, [
    batch('lote-uno', { requested_at: '2026-01-01T00:00:00Z', data_status: 'sufficient' }),
    batch('lote-dos', { requested_at: '2026-02-02T00:00:00Z', data_status: 'insufficient' }),
  ]);
  await waitFor(() => expect(count()).toBe('2'));

  fireEvent.change(screen.getByLabelText('Filtrar el historial por estado del dato'), {
    target: { value: 'insufficient' },
  });
  fireEvent.change(screen.getByLabelText('Buscar en el historial de la zona'), { target: { value: 'lote-dos' } });
  expect(tbody().children).toHaveLength(1);

  const served = [
    CSV_HEADER,
    '05102,lote-uno,job-lote-uno,2026-01-01T00:00:00Z,2026-01-01T00:10:00Z,2026-01-02T00:00:00Z,model-v1,alto,sufficient,yes,,2026-01-01T00:00:00Z',
    '05102,lote-dos,job-lote-dos,2026-02-02T00:00:00Z,2026-02-02T00:10:00Z,2026-02-03T00:00:00Z,model-v1,alto,insufficient,yes,,2026-02-02T00:00:00Z',
    '',
  ].join('\n');

  fireEvent.click(downloadButton());
  // The only parameter is the selection: the search term and the status filter
  // reach the table in memory and never the request.
  expect(csv.calls).toEqual([CSV_URL]);
  expect(csv.calls[0]).not.toMatch(/[?&](q|query|status|data_status)=/);

  csv.answer(served);
  await waitFor(() => expect(download.names).toHaveLength(1));
  expect(await download.blobs[0].text()).toBe(served);

  // Downloading did not reset or widen the table: it is still the filtered view.
  expect(visibleCount()).toBe('1 de 2');
  expect(tbody().children).toHaveLength(1);
  expect(count()).toBe('2');

  // The filters are shared state; the rest of this file starts from none.
  fireEvent.change(screen.getByLabelText('Buscar en el historial de la zona'), { target: { value: '' } });
  fireEvent.change(screen.getByLabelText('Filtrar el historial por estado del dato'), { target: { value: '' } });
});

test('a header-only export is saved and stated as carrying no rows', async () => {
  const { fetchStub } = await connect();
  const csv = serveCsv(fetchStub);
  const download = captureDownloads();
  selectZone(ZONE);
  render(<HistoryView />);
  await flush();

  fetchStub.answer(HISTORY_URL, []);
  await waitFor(() => expect(state()).toHaveTextContent('La API devolvió un historial vacío.'));

  // An empty history is a valid export (`200`, header row alone), so the control
  // stays available and the sentence states exactly what the file will hold.
  expect(downloadButton()).toBeEnabled();
  fireEvent.click(downloadButton());
  csv.answer(`${CSV_HEADER}\n`);

  await waitFor(() => expect(csvStatus()).toHaveTextContent(/solo el encabezado/i));
  expect(csvStatus()).toHaveTextContent(/no devolvió filas/i);
  expect(download.names).toEqual(['risk-history-05102.csv']);
  expect(await download.blobs[0].text()).toBe(`${CSV_HEADER}\n`);
  // The table keeps its own, separate meaning: the API returned no history.
  expect(state()).toHaveTextContent('La API devolvió un historial vacío.');
});

test('a denied export is stated as a permission denial and saves nothing', async () => {
  const { fetchStub } = await connect();
  const csv = serveCsv(fetchStub);
  const download = captureDownloads();
  selectZone(ZONE);
  render(<HistoryView />);
  await flush();

  fetchStub.answer(HISTORY_URL, [batch('lote-uno')]);
  await waitFor(() => expect(count()).toBe('1'));

  fireEvent.click(downloadButton());
  csv.answer('{"code":"forbidden"}', { status: 403, contentType: 'application/json' });

  await waitFor(() => expect(csvStatus()).toHaveTextContent(/permiso/i));
  expect(csvStatus()).toHaveTextContent('403');
  expect(csvStatus()).toHaveTextContent(/no se descargó ningún archivo/i);
  expect(download.createObjectURL).not.toHaveBeenCalled();
  expect(download.names).toHaveLength(0);
  // The available meaning is preserved: the rows the JSON read returned stay.
  expect(count()).toBe('1');
  expect(tbody().children).toHaveLength(1);
});

test('an unavailable export is stated with its status and saves nothing', async () => {
  const { fetchStub } = await connect();
  const csv = serveCsv(fetchStub);
  const download = captureDownloads();
  selectZone(ZONE);
  render(<HistoryView />);
  await flush();

  fetchStub.answer(HISTORY_URL, [batch('lote-uno')]);
  await waitFor(() => expect(count()).toBe('1'));

  fireEvent.click(downloadButton());
  csv.answer('{"code":"storage_unavailable"}', { status: 503, contentType: 'application/json' });

  await waitFor(() => expect(csvStatus()).toHaveTextContent(/No se pudo descargar el historial/i));
  expect(csvStatus()).toHaveTextContent('503');
  expect(csvStatus()).toHaveTextContent(/no se descargó ningún archivo/i);
  expect(download.createObjectURL).not.toHaveBeenCalled();
  expect(tbody().children).toHaveLength(1);
});

test('a 401 during the export lowers the session and downloads nothing', async () => {
  const { fetchStub } = await connect();
  const csv = serveCsv(fetchStub);
  const download = captureDownloads();
  selectZone(ZONE);
  render(<HistoryView />);
  await flush();

  fetchStub.answer(HISTORY_URL, [batch('lote-uno')]);
  await waitFor(() => expect(count()).toBe('1'));

  fireEvent.click(downloadButton());
  csv.answer('{"code":"unauthorized"}', { status: 401, contentType: 'application/json' });

  // The session unit owns the copy: the panel returns to its connect state and
  // the export's own state is dropped with the session it belonged to.
  await waitFor(() => expect(state()).toHaveTextContent(/rechazó el token \(401\)/i));
  expect(state()).toHaveTextContent(/conecta nuevamente un token autorizado/i);
  expect(download.createObjectURL).not.toHaveBeenCalled();
  expect(download.names).toHaveLength(0);
  expect(downloadButton()).toBeDisabled();
  expect(csvStatus()).toHaveTextContent('La descarga necesita una sesión autorizada; no se solicitó nada.');
});

test('a refused browser save is stated and never reported as a download', async () => {
  const { fetchStub } = await connect();
  const csv = serveCsv(fetchStub);
  const download = captureDownloads();
  download.createObjectURL.mockImplementation(() => {
    throw new Error('object URLs are blocked');
  });
  selectZone(ZONE);
  render(<HistoryView />);
  await flush();

  fetchStub.answer(HISTORY_URL, [batch('lote-uno')]);
  await waitFor(() => expect(count()).toBe('1'));

  fireEvent.click(downloadButton());
  csv.answer(`${CSV_HEADER}\n`);

  await waitFor(() => expect(csvStatus()).toHaveTextContent(/no pudo guardar el archivo/i));
  expect(csvStatus()).toHaveTextContent(/no se descargó ningún archivo/i);
  expect(csvStatus()).not.toHaveTextContent(/Descarga iniciada/);
  expect(download.names).toHaveLength(0);
});

// L7 blocker: `206 Partial Content` is a successful HTTP status, so the page used
// to save a truncated document as a complete export. Only the documented 200 is
// a downloadable answer; every other status is the stated failure it already was.
test('a 206 partial response is not a downloadable file', async () => {
  const { fetchStub } = await connect();
  const csv = serveCsv(fetchStub);
  const download = captureDownloads();
  selectZone(ZONE);
  render(<HistoryView />);
  await flush();

  fetchStub.answer(HISTORY_URL, [batch('lote-uno')]);
  await waitFor(() => expect(count()).toBe('1'));

  fireEvent.click(downloadButton());
  csv.answer(`${CSV_HEADER}\n05102,lote-uno`, { status: 206 });

  await waitFor(() => expect(csvStatus()).toHaveTextContent(/No se pudo descargar el historial/i));
  expect(csvStatus()).toHaveTextContent('206');
  expect(csvStatus()).toHaveTextContent(/no se descargó ningún archivo/i);
  expect(download.createObjectURL).not.toHaveBeenCalled();
  expect(download.names).toHaveLength(0);
  // The partial answer is not allowed to replace the table's meaning either.
  expect(count()).toBe('1');
  expect(tbody().children).toHaveLength(1);
});

test('changing the zone while the export is in flight discards it', async () => {
  const { fetchStub } = await connect();
  const csv = serveCsv(fetchStub);
  const download = captureDownloads();
  selectZone(ZONE);
  render(<HistoryView />);
  await flush();

  fetchStub.answer(HISTORY_URL, [batch('lote-uno')]);
  await waitFor(() => expect(count()).toBe('1'));

  fireEvent.click(downloadButton());
  expect(csv.calls).toHaveLength(1);

  selectZone('05103');
  await waitFor(() => expect(state()).toHaveTextContent('Consultando historial…'));
  // The transport double still delivers the old zone's document; the page must
  // not turn it into a file or into a status line for the new selection.
  csv.answer(`${CSV_HEADER}\n`);
  await flush();

  expect(download.createObjectURL).not.toHaveBeenCalled();
  expect(download.names).toHaveLength(0);
  expect(csvStatus()).not.toHaveTextContent(/Descarga iniciada/);

  fetchStub.answer(`${gatewayOrigin}/v1/risk/history?zone_id=05103`, []);
  await waitFor(() => expect(state()).toHaveTextContent('La API devolvió un historial vacío.'));
  expect(csvStatus()).toHaveTextContent('Listo para descargar el historial de la zona 05103.');
});

// L7 blocker: the download state was keyed only by zone id, so returning to a
// zone whose export had been abandoned restored that request's `loading` state.
// The control then stayed busy after its request was gone, and `start` refused
// every retry forever. The state belongs to the instance that read it: the stale
// completion must save nothing, and a NEW request for the same zone must work.
test('an A→B→A round trip discards the abandoned export and allows a new one for A', async () => {
  const { fetchStub } = await connect();
  const csv = serveCsv(fetchStub);
  const download = captureDownloads();
  selectZone(ZONE);
  render(<HistoryView />);
  await flush();

  fetchStub.answer(HISTORY_URL, [batch('lote-uno')]);
  await waitFor(() => expect(count()).toBe('1'));

  // A — start the export and leave the zone before it answers.
  fireEvent.click(downloadButton());
  expect(csv.pending()).toBe(1);
  expect(downloadButton()).toHaveAttribute('aria-busy', 'true');

  selectZone('05103');
  await waitFor(() => expect(state()).toHaveTextContent('Consultando historial…'));
  fetchStub.answer(`${gatewayOrigin}/v1/risk/history?zone_id=05103`, []);
  await waitFor(() => expect(state()).toHaveTextContent('La API devolvió un historial vacío.'));

  // The abandoned A answer arrives while B is selected: it must not save.
  csv.answer(`${CSV_HEADER}\n`);
  await flush();
  expect(download.createObjectURL).not.toHaveBeenCalled();
  expect(download.names).toHaveLength(0);

  // B — back to A. The abandoned request's state must not be restored: the
  // control is idle for this selection, not permanently busy with a dead read.
  selectZone(ZONE);
  await waitFor(() => expect(state()).toHaveTextContent('Consultando historial…'));
  fetchStub.answer(HISTORY_URL, [batch('lote-uno')]);
  await waitFor(() => expect(count()).toBe('1'));

  expect(csv.pending()).toBe(0);
  expect(downloadButton()).toBeEnabled();
  expect(downloadButton()).not.toHaveAttribute('aria-busy');
  expect(downloadButton()).not.toHaveAttribute('aria-disabled');
  expect(csvStatus()).not.toHaveTextContent(/Preparando/);
  expect(csvStatus()).toHaveTextContent('Listo para descargar el historial de la zona 05102.');

  // And a NEW export for A is possible and saves normally.
  fireEvent.click(downloadButton());
  expect(csv.pending()).toBe(1);
  csv.answer(`${CSV_HEADER}\n`);
  await waitFor(() => expect(download.names).toHaveLength(1));

  expect(download.names).toEqual(['risk-history-05102.csv']);
  expect(await download.blobs[0].text()).toBe(`${CSV_HEADER}\n`);
  expect(csvStatus()).toHaveTextContent(/Descarga iniciada: risk-history-05102\.csv/);
});

test('logging out while the export is in flight discards it', async () => {
  const { fetchStub } = await connect();
  const csv = serveCsv(fetchStub);
  const download = captureDownloads();
  selectZone(ZONE);
  render(<HistoryView />);
  await flush();

  fetchStub.answer(HISTORY_URL, [batch('lote-uno')]);
  await waitFor(() => expect(count()).toBe('1'));

  fireEvent.click(downloadButton());
  resetSession();
  await waitFor(() => expect(state()).toHaveTextContent('Conecta un token autorizado para consultar el historial.'));

  csv.answer(`${CSV_HEADER}\n`);
  await flush();

  expect(download.createObjectURL).not.toHaveBeenCalled();
  expect(download.names).toHaveLength(0);
  expect(csvStatus()).toHaveTextContent('La descarga necesita una sesión autorizada; no se solicitó nada.');
  expect(downloadButton()).toBeDisabled();
});

test('unmounting while the export is in flight saves nothing', async () => {
  const { fetchStub } = await connect();
  const csv = serveCsv(fetchStub);
  const download = captureDownloads();
  selectZone(ZONE);
  const view = render(<HistoryView />);
  await flush();

  fetchStub.answer(HISTORY_URL, [batch('lote-uno')]);
  await waitFor(() => expect(count()).toBe('1'));

  fireEvent.click(downloadButton());
  expect(csv.pending()).toBe(1);
  view.unmount();

  csv.answer(`${CSV_HEADER}\n`);
  await flush();

  expect(download.createObjectURL).not.toHaveBeenCalled();
  expect(download.names).toHaveLength(0);
});

// ── PM-04 / S3–S5 — the granular series ─────────────────────────────────────
// «Todas las zonas» reads `/v1/risk/history/series` with no `zone_id`, one
// granularity and a window capped by the route. The double below answers the
// JSON body the route serves, echoes the parameters it read (the attribution the
// contract defines) and records the query, so every assertion is about what the
// page ASKED instead of about a frozen clock.

interface SeriesCall {
  url: string;
  from: string;
  to: string;
  granularity: string;
  zoneId: string | null;
}

interface SeriesReply {
  status?: number;
  body?: unknown;
  jsonThrows?: boolean;
}

function seriesBody(call: SeriesCall, series: unknown[]): unknown {
  return { from: call.from, to: call.to, granularity: call.granularity, series };
}

function serveSeries(fetchStub: ReturnType<typeof createFetchStub>) {
  const pending: {
    call: SeriesCall;
    resolve: (reply: { status: number; body: unknown; jsonThrows: boolean }) => void;
  }[] = [];
  const calls: SeriesCall[] = [];
  const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (!url.startsWith(`${gatewayOrigin}/v1/risk/history/series`)) return fetchStub.fetch(input, init);
    const parameters = new URL(url).searchParams;
    const call: SeriesCall = {
      url,
      from: parameters.get('from') ?? '',
      to: parameters.get('to') ?? '',
      granularity: parameters.get('granularity') ?? '',
      zoneId: parameters.get('zone_id'),
    };
    calls.push(call);
    return new Promise<Response>((resolve, reject) => {
      const entry = {
        call,
        resolve: (reply: { status: number; body: unknown; jsonThrows: boolean }): void => {
          resolve(
            new Response(reply.jsonThrows ? '{' : JSON.stringify(reply.body), {
              status: reply.status,
              headers: { 'Content-Type': 'application/json' },
            }),
          );
        },
      };
      pending.push(entry);
      // A superseded read is aborted by the view; the double honours that so the
      // queue only ever holds the query the page is actually waiting for.
      const signal = init?.signal ?? null;
      if (signal === null) return;
      signal.addEventListener(
        'abort',
        () => {
          const index = pending.indexOf(entry);
          if (index >= 0) pending.splice(index, 1);
          reject(new DOMException('Aborted', 'AbortError'));
        },
        { once: true },
      );
    });
  };
  vi.stubGlobal('fetch', fetch);
  return {
    calls,
    pending: (): number => pending.length,
    answer(series: unknown[] = [], init: SeriesReply = {}): void {
      const entry = pending.shift();
      if (!entry) throw new Error('no pending series request');
      entry.resolve({
        status: init.status ?? 200,
        body: init.body ?? seriesBody(entry.call, series),
        jsonThrows: init.jsonThrows ?? false,
      });
    },
  };
}

interface BucketOverrides {
  bucket_start?: string;
  batch_id?: string;
  risk_level?: string;
  model_version?: string;
  synthetic?: boolean;
}

function bucket(overrides: BucketOverrides = {}): Record<string, unknown> {
  return {
    bucket_start: '2026-11-20T03:00:00Z',
    batch_id: 'lote-uno',
    requested_at: '2026-11-20T15:00:00Z',
    published_at: '2026-11-20T15:00:05Z',
    risk_level: 'alto',
    model_version: 'academic-rule-v1',
    synthetic: true,
    ...overrides,
  };
}

function zoneSeries(zone: string, buckets: Record<string, unknown>[]): Record<string, unknown> {
  return { zone_id: zone, buckets };
}

function seriesList(): HTMLElement | null {
  return document.getElementById('history-series');
}

function seriesRange(): HTMLElement {
  return document.getElementById('history-series-range') as HTMLElement;
}

async function openAllZones(): Promise<ReturnType<typeof serveSeries>> {
  const { fetchStub } = await connect();
  const series = serveSeries(fetchStub);
  render(<HistoryView />);
  await flush();
  fireEvent.change(screen.getByLabelText('Elegir el alcance del historial'), { target: { value: 'all' } });
  await flush();
  return series;
}

test('«Todas las zonas» asks for the series without a zone and renders every interval it was served (S3)', async () => {
  const series = await openAllZones();

  expect(series.calls).toHaveLength(1);
  const [call] = series.calls;
  expect(call.granularity).toBe('day');
  // Omitting `zone_id` is exactly what asks for every zone.
  expect(call.zoneId).toBeNull();
  // The window is the documented day cap, half-open by construction.
  expect(Date.parse(call.to) - Date.parse(call.from)).toBe(31 * 86_400_000);
  expect(state()).toHaveTextContent('Consultando la serie de todas las zonas…');

  series.answer([
    zoneSeries('05101', [
      bucket({ bucket_start: '2026-11-20T03:00:00Z', risk_level: 'alto' }),
      bucket({ bucket_start: '2026-11-21T03:00:00Z', risk_level: 'desconocido', batch_id: 'lote-dos' }),
    ]),
    zoneSeries('05102', [
      bucket({
        batch_id: 'lote-tres',
        risk_level: 'medio',
        model_version: 'academic-rule-v2',
        synthetic: false,
      }),
    ]),
  ]);
  await waitFor(() => expect(count()).toBe('2'));

  expect(state()).toHaveTextContent('2 zonas con al menos un intervalo publicado en la ventana.');
  const list = seriesList();
  expect(list).not.toBeNull();
  expect(list).toHaveTextContent('Zona 05101');
  expect(list).toHaveTextContent('2 intervalos');
  expect(list).toHaveTextContent('Zona 05102');
  expect(list).toHaveTextContent('1 intervalo');
  // Every interval declares its own start, the batch that produced it, its model
  // and its synthetic mark, and the level is text — never colour alone.
  expect(list).toHaveTextContent('2026-11-20T03:00:00Z');
  expect(list).toHaveTextContent('ALTO');
  expect(list).toHaveTextContent('INFORMACIÓN INSUFICIENTE');
  expect(list).toHaveTextContent('lote lote-dos');
  expect(list).toHaveTextContent('modelo academic-rule-v1');
  expect(list).toHaveTextContent('modelo academic-rule-v2');
  expect(list).toHaveTextContent('Dato sintético');
  expect(list).toHaveTextContent('Sin marca sintética');
  // The window is declared as text, with the cap of the selected granularity.
  expect(seriesRange()).toHaveTextContent(call.from);
  expect(seriesRange()).toHaveTextContent(call.to);
  expect(seriesRange()).toHaveTextContent('Días (día civil de America/Santiago)');
  expect(seriesRange()).toHaveTextContent('31 días');
  // The two honesty labels the panel owes the reader.
  expect(document.getElementById('history')).toHaveTextContent(/último lote publicado por intervalo/i);
  expect(document.getElementById('history')).toHaveTextContent(/sin relleno de huecos/i);
  // The zone table, its filters and the CSV export belong to «Por zona».
  expect(document.getElementById('history-rows')).toBeNull();
  expect(document.getElementById('history-csv-download')).toBeNull();
  expect(document.getElementById('history-granularity')).not.toBeNull();
});

test('the three granularities each ask for their own capped window and no zone filter (S3)', async () => {
  const series = await openAllZones();

  const granularity = screen.getByLabelText('Elegir la granularidad de la serie');
  expect(granularity).toHaveValue('day');
  expect(series.calls[0].granularity).toBe('day');

  fireEvent.change(granularity, { target: { value: 'hour' } });
  await flush();
  expect(series.calls).toHaveLength(2);
  expect(series.calls[1].granularity).toBe('hour');
  expect(Date.parse(series.calls[1].to) - Date.parse(series.calls[1].from)).toBe(48 * 3_600_000);

  fireEvent.change(granularity, { target: { value: 'week' } });
  await flush();
  expect(series.calls).toHaveLength(3);
  expect(series.calls[2].granularity).toBe('week');
  expect(Date.parse(series.calls[2].to) - Date.parse(series.calls[2].from)).toBe(31 * 86_400_000);

  // No granularity narrows the read to a zone.
  for (const call of series.calls) expect(call.zoneId).toBeNull();

  // The answer for the active granularity states its own civil cut.
  series.answer([zoneSeries('05101', [bucket()])]);
  await waitFor(() => expect(count()).toBe('1'));
  expect(seriesRange()).toHaveTextContent('Semanas (semana civil, lunes)');
});

test('an empty series is stated as empty and invents no interval (S3)', async () => {
  const series = await openAllZones();

  series.answer([]);
  await waitFor(() =>
    expect(state()).toHaveTextContent(
      'La API devolvió una serie vacía: ninguna zona publicó lotes en la ventana consultada.',
    ),
  );

  expect(seriesList()).toBeNull();
  // An empty answer is a count of zero zones, not an unknown count.
  expect(count()).toBe('0');
  // The empty answer is still attributable: the window it asked about stays stated.
  expect(seriesRange()).not.toBeNull();
});

test('a series failure is stated with its status and never rendered as an interval (S3)', async () => {
  const series = await openAllZones();

  series.answer([], { status: 503 });
  await waitFor(() =>
    expect(state()).toHaveTextContent('No se pudo consultar la serie de todas las zonas (HTTP 503).'),
  );

  expect(state()).toHaveClass('risk-error');
  expect(seriesList()).toBeNull();
  expect(count()).toBe('—');
});

test('a series answer that echoes another window is discarded, not rendered (S2/S3)', async () => {
  const series = await openAllZones();

  series.answer([], {
    body: { from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z', granularity: 'day', series: [] },
  });
  await waitFor(() => expect(state()).toHaveTextContent(/otra ventana o granularidad/i));

  expect(seriesList()).toBeNull();
  expect(count()).toBe('—');
});

test('a series body the guard cannot use is rejected as unreadable (S3)', async () => {
  const series = await openAllZones();

  // A bucket without its `model_version` is not a point the page can attribute.
  series.answer([{ zone_id: '05101', buckets: [{ ...bucket(), model_version: undefined }] }]);
  await waitFor(() => expect(state()).toHaveTextContent(/ilegible/i));

  expect(seriesList()).toBeNull();
});

test('without a session the series asks to connect and issues no read (S3)', async () => {
  const { fetchStub } = prepare();
  const series = serveSeries(fetchStub);
  render(<HistoryView />);

  fireEvent.change(screen.getByLabelText('Elegir el alcance del historial'), { target: { value: 'all' } });
  await flush();

  expect(series.calls).toHaveLength(0);
  expect(state()).toHaveTextContent('Conecta un token autorizado para consultar la serie de todas las zonas.');
  expect(seriesList()).toBeNull();
});

test('a failed series leaves the per-zone history and its export intact (S3)', async () => {
  const { fetchStub } = await connect();
  const series = serveSeries(fetchStub);
  selectZone(ZONE);
  render(<HistoryView />);
  await flush();

  fetchStub.answer(HISTORY_URL, [batch('lote-uno')]);
  await waitFor(() => expect(count()).toBe('1'));

  fireEvent.change(screen.getByLabelText('Elegir el alcance del historial'), { target: { value: 'all' } });
  await flush();
  series.answer([], { status: 503 });
  await waitFor(() => expect(state()).toHaveTextContent(/No se pudo consultar la serie/i));
  // The export belongs to the per-zone panel it was written for.
  expect(document.getElementById('history-csv-download')).toBeNull();

  // Back to «Por zona»: the panel reads its own zone again and the export is
  // available for exactly the selection it belongs to.
  fireEvent.change(screen.getByLabelText('Elegir el alcance del historial'), { target: { value: 'zone' } });
  await flush();
  expect(fetchStub.callsFor(HISTORY_URL)).toHaveLength(2);
  fetchStub.answer(HISTORY_URL, [batch('lote-uno')]);
  await waitFor(() => expect(count()).toBe('1'));
  expect(downloadButton()).toBeEnabled();
  expect(csvStatus()).toHaveTextContent(`Listo para descargar el historial de la zona ${ZONE}.`);
  expect(seriesList()).toBeNull();
});

// ── PM-04 / T1 — the series client ──────────────────────────────────────────
// The transport is exercised directly for the properties the view cannot show:
// `zone_id` travels only when it was asked for, an answer that echoes another
// window is refused, and a body the view cannot use is never handed back.

const SERIES_FROM = '2026-11-01T00:00:00Z';
const SERIES_TO = '2026-11-02T00:00:00Z';

function seriesUrl(parameters: Record<string, string>): string {
  return `${gatewayOrigin}/v1/risk/history/series?${new URLSearchParams(parameters).toString()}`;
}

test('the series client omits zone_id when every zone was asked for (T1)', async () => {
  const { fetchStub } = await connect();
  const request = historySeries({ from: SERIES_FROM, to: SERIES_TO, granularity: 'day' });
  await flush();

  const url = seriesUrl({ from: SERIES_FROM, to: SERIES_TO, granularity: 'day' });
  expect(fetchStub.callsFor(url)).toHaveLength(1);
  fetchStub.answer(url, { from: SERIES_FROM, to: SERIES_TO, granularity: 'day', series: [] });

  const outcome = await request;
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error('expected the series read to succeed');
  expect(outcome.data.series).toEqual([]);
});

test('the series client sends zone_id only when it was given one (T1)', async () => {
  const { fetchStub } = await connect();
  const request = historySeries({ from: SERIES_FROM, to: SERIES_TO, granularity: 'week', zoneId: ZONE });
  await flush();

  const url = seriesUrl({ from: SERIES_FROM, to: SERIES_TO, granularity: 'week', zone_id: ZONE });
  expect(fetchStub.callsFor(url)).toHaveLength(1);
  fetchStub.answer(url, {
    from: SERIES_FROM,
    to: SERIES_TO,
    granularity: 'week',
    series: [zoneSeries(ZONE, [bucket()])],
  });

  const outcome = await request;
  expect(outcome.ok).toBe(true);
});

test('the series client refuses an answer that echoes another window (T1)', async () => {
  const { fetchStub } = await connect();
  const request = historySeries({ from: SERIES_FROM, to: SERIES_TO, granularity: 'day' });
  await flush();

  fetchStub.answer(seriesUrl({ from: SERIES_FROM, to: SERIES_TO, granularity: 'day' }), {
    from: '2026-10-01T00:00:00Z',
    to: '2026-11-01T00:00:00Z',
    granularity: 'day',
    series: [],
  });

  const outcome = await request;
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error('expected the mismatched window to be refused');
  expect(outcome.failure.kind).toBe('malformed');
  expect(outcome.failure.reason).toBe('window_mismatch');
});

test('the series client refuses an unknown granularity before issuing a read (T1)', async () => {
  const { fetchStub } = await connect();

  const outcome = await historySeries({
    from: SERIES_FROM,
    to: SERIES_TO,
    granularity: 'month' as unknown as HistoryGranularity,
  });

  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error('expected the unknown granularity to be refused');
  expect(outcome.failure.kind).toBe('malformed');
  expect(outcome.failure.reason).toBe('invalid_granularity');
  expect(fetchStub.calls.filter((call) => call.url.includes('/v1/risk/history/series'))).toHaveLength(0);
});

test('the series client refuses an empty zone id instead of widening to every zone (S3)', async () => {
  const { fetchStub } = await connect();
  const pending = historySeries({ from: SERIES_FROM, to: SERIES_TO, granularity: 'day', zoneId: '' });
  await flush();
  expect(fetchStub.calls.filter((call) => call.url.includes('/v1/risk/history/series'))).toHaveLength(0);

  const outcome = await pending;
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error('expected the empty zone id to be refused');
  expect(outcome.failure.kind).toBe('malformed');
  expect(outcome.failure.reason).toBe('invalid_shape');
});

test('the series client refuses invalid instants and undeclared bucket members (S3)', async () => {
  const { fetchStub } = await connect();

  const pendingWindow = historySeries({ from: '01/02/2026', to: SERIES_TO, granularity: 'day' });
  await flush();
  expect(fetchStub.calls.filter((call) => call.url.includes('/v1/risk/history/series'))).toHaveLength(0);
  const badWindow = await pendingWindow;
  expect(badWindow.ok).toBe(false);
  if (badWindow.ok) throw new Error('expected the invalid window to be refused');
  expect(badWindow.failure.reason).toBe('invalid_shape');

  const badEcho = historySeries({ from: SERIES_FROM, to: SERIES_TO, granularity: 'day' });
  await flush();
  fetchStub.answer(seriesUrl({ from: SERIES_FROM, to: SERIES_TO, granularity: 'day' }), {
    from: '2026-11-01',
    to: SERIES_TO,
    granularity: 'day',
    series: [],
  });
  const bareDate = await badEcho;
  expect(bareDate.ok).toBe(false);
  if (bareDate.ok) throw new Error('expected the bare date to be refused');
  expect(bareDate.failure.reason).toBe('invalid_shape');

  const extra = historySeries({ from: SERIES_FROM, to: SERIES_TO, granularity: 'day' });
  await flush();
  const withExtra = bucket();
  withExtra['undeclared'] = 'x';
  fetchStub.answer(seriesUrl({ from: SERIES_FROM, to: SERIES_TO, granularity: 'day' }), {
    from: SERIES_FROM,
    to: SERIES_TO,
    granularity: 'day',
    series: [zoneSeries(ZONE, [withExtra])],
  });
  const undeclared = await extra;
  expect(undeclared.ok).toBe(false);
  if (undeclared.ok) throw new Error('expected the undeclared bucket member to be refused');
  expect(undeclared.failure.reason).toBe('invalid_shape');
});

test('returning to «Todas las zonas» shows loading instead of the previous window (S3)', async () => {
  const series = await openAllZones();
  series.answer([zoneSeries('05101', [bucket()])]);
  await waitFor(() => expect(count()).toBe('1'));
  expect(seriesList()).not.toBeNull();

  fireEvent.change(screen.getByLabelText('Elegir el alcance del historial'), { target: { value: 'zone' } });
  await flush();
  fireEvent.change(screen.getByLabelText('Elegir el alcance del historial'), { target: { value: 'all' } });
  await flush();

  // Re-entering the scope issues a fresh read; until it answers, the window and
  // the series of the previous visit must not be painted.
  expect(series.calls).toHaveLength(2);
  expect(state()).toHaveTextContent('Consultando la serie de todas las zonas…');
  expect(seriesList()).toBeNull();
  expect(count()).toBe('—');
});

test('the series client refuses a body the view cannot use (T1)', async () => {
  const { fetchStub } = await connect();
  const request = historySeries({ from: SERIES_FROM, to: SERIES_TO, granularity: 'day' });
  await flush();

  // A zone with no bucket is a series the contract says cannot exist.
  fetchStub.answer(seriesUrl({ from: SERIES_FROM, to: SERIES_TO, granularity: 'day' }), {
    from: SERIES_FROM,
    to: SERIES_TO,
    granularity: 'day',
    series: [{ zone_id: ZONE, buckets: [] }],
  });

  const outcome = await request;
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error('expected the unusable body to be refused');
  expect(outcome.failure.kind).toBe('malformed');
  expect(outcome.failure.reason).toBe('invalid_shape');
});
