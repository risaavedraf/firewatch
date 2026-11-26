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
