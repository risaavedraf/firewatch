// PM-14 — the per-zone PDF ficha offered from the published batch card.
//
// The acceptance criterion asks for a ficha the reader can download with the
// zone's real state, and for the synthetic mark of `R3` to travel inside the
// document. What is asserted here is therefore the browser seams the save really
// uses — the Blob handed to `URL.createObjectURL`, the anchor's `download` name at
// click time, and the bytes themselves read back as PDF — plus the two honesty
// rules the page already keeps:
//
//   * the control is disabled while there is no selected zone or no published
//     batch, because a ficha with nothing to describe would be an invented one;
//   * generating the ficha issues no request and mutates nothing: it is a pure
//     composition of the batch, the zones and the recommendations the page already
//     shows.
//
// jsdom has no `URL.createObjectURL` and no download navigation, so the save is
// observed at exactly the two seams the browser uses, as the history export tests
// do.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { clearZoneState, getSelectedZone } from '../../src/app/store';
import { gatewayOrigin, issuer, pkceTransactionKey, routes } from '../../src/config';
import { completeLogin, resetSession } from '../../src/core/session';
import type { RiskBatch, ZoneCollection, ZoneFeature } from '../../src/types/api';
import { OverviewView } from '../../src/views/OverviewView';
import { createFetchStub, createStorageStub, flush, jwt } from '../core/harness';

const TOKEN_URL = `${issuer}/protocol/openid-connect/token`;
const ZONES_URL = `${gatewayOrigin}${routes.zones}`;
const latestUrl = (zone: string): string => `${gatewayOrigin}${routes.latest}?zone_id=${zone}`;
const historyUrl = (zone: string): string => `${gatewayOrigin}${routes.history}?zone_id=${zone}`;

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
  cleanup();
  vi.unstubAllGlobals();
});

// --- Fixtures -------------------------------------------------------------

function ring(minLon = -71.7, minLat = -33.1): ZoneFeature['geometry'] {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [minLon, minLat],
        [minLon + 0.1, minLat],
        [minLon + 0.1, minLat + 0.1],
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

function batch(zone: string, level: RiskBatch['risk_level'], overrides: Partial<RiskBatch> = {}): RiskBatch {
  return {
    zone_id: zone,
    id: `batch-${zone}`,
    job_id: `job-${zone}`,
    demo: true,
    risk_level: level,
    factors: [
      { name: 'temperatura', known: true, value: 31.2, contribution: 0.34, note: 'lectura de la estación' },
      { name: 'humedad_relativa', known: false, value: 0, contribution: 0, note: 'sensor sin dato' },
      { name: 'viento', known: true, value: 18, contribution: 0.12, note: 'rachas del sector' },
      { name: 'incendios_historicos', known: true, value: 6, contribution: 0.08, note: 'eventos registrados' },
    ],
    rationale: 'Regla académica de pesos fijos.',
    policy: { policy_id: 'academic-rule-v1', params_hash: 'abc123', parameters: { weight: '0.2' } },
    notice: 'Entrada sintética',
    published_at: '2026-11-25T12:00:00Z',
    data_status: 'final',
    model_version: 'academic-rule-v1',
    ...overrides,
  };
}

// --- Driving the view -----------------------------------------------------

async function settle(): Promise<void> {
  await act(async () => {
    await flush();
  });
}

async function signIn(): Promise<void> {
  storageStub.storage.setItem(pkceTransactionKey, JSON.stringify({ state: 's', verifier: 'v' }));
  const login = completeLogin('?code=c&state=s');
  await flush();
  fetchStub.answer(TOKEN_URL, { access_token: jwt({ realm_access: { roles: ['viewer'] } }), id_token: jwt({ sub: 'u' }) });
  await login;
  fetchStub.calls.length = 0;
}

async function openSignedIn(): Promise<void> {
  await signIn();
  render(<OverviewView />);
  await settle();
}

async function serveCatalogue(collection: ZoneCollection): Promise<void> {
  fetchStub.answer(ZONES_URL, collection);
  await settle();
}

async function serveZone(zone: string, latestBody: unknown, latestStatus = 200): Promise<void> {
  fetchStub.answer(latestUrl(zone), latestBody, latestStatus);
  fetchStub.answer(historyUrl(zone), []);
  await settle();
}

async function choose(zone: string): Promise<void> {
  fireEvent.change(screen.getByRole('combobox', { name: 'Zona a consultar' }), { target: { value: zone } });
  await settle();
}

// --- Reading the saved document ------------------------------------------

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

// The reverse of `/WinAnsiEncoding` for the bytes 0x80–0x9F, which carry CP1252
// punctuation instead of the Latin-1 controls.
const WIN_ANSI: Readonly<Record<number, string>> = {
  0x80: '\u20AC',
  0x85: '\u2026',
  0x91: '\u2018',
  0x92: '\u2019',
  0x93: '\u201C',
  0x94: '\u201D',
  0x95: '\u2022',
  0x96: '\u2013',
  0x97: '\u2014',
};

// The view suite does not re-own the PDF reader: `tests/domain/zone-pdf.test.ts`
// walks the operators. Here the bytes are only proved to be a real PDF whose text
// carries the selected zone, which is what the download seam can silently lose.
async function savedPdf(blob: Blob): Promise<{ header: string; text: string }> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let raw = '';
  const chunk = 8192;
  for (let index = 0; index < bytes.length; index += chunk) {
    raw += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  let text = '';
  for (const match of raw.matchAll(/\(((?:\\.|[^\\()])*)\)\s*Tj/g)) {
    for (const character of match[1].replace(/\\([()\\])/g, '$1')) {
      text += WIN_ANSI[character.charCodeAt(0)] ?? character;
    }
    text += '\n';
  }
  return { header: raw.slice(0, 8), text };
}

function downloadButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Descargar ficha PDF' });
}

// --- Tests ----------------------------------------------------------------

test('offers the ficha as a named, native control inside the published batch card (PM-14)', async () => {
  await openSignedIn();
  await serveCatalogue(catalogue([feature('05101', 'Valparaíso')]));
  await serveZone('05101', batch('05101', 'alto'));

  const button = downloadButton();
  expect(button.tagName).toBe('BUTTON');
  expect(button).toHaveAttribute('type', 'button');
  expect(button).toBeEnabled();
  // The control says what it will save and where the ficha comes from.
  const describedBy = button.getAttribute('aria-describedby') ?? '';
  expect(document.getElementById(describedBy)?.textContent ?? '').toContain('PDF');

  // A native button is a keyboard target: it takes focus and Enter activates it.
  button.focus();
  expect(document.activeElement).toBe(button);
});

test('stays disabled while there is no selected zone or no published batch', async () => {
  await openSignedIn();
  // Neither catalogue nor selection yet: there is nothing the ficha could describe.
  expect(downloadButton()).toBeDisabled();

  await serveCatalogue(
    catalogue([
      feature('05101', 'Valparaíso'),
      feature('05102', 'Quilpué', 'Marga Marga'),
      feature('05103', 'Villa Alemana', 'Marga Marga'),
    ]),
  );
  // The selection is now the first comuna but its batch is still in flight.
  expect(getSelectedZone()).toBe('05101');
  expect(downloadButton()).toBeDisabled();

  // A 404 is "no published batch", never a low risk to export.
  await serveZone('05101', null, 404);
  expect(downloadButton()).toBeDisabled();

  // A published batch enables it…
  await choose('05102');
  await serveZone('05102', batch('05102', 'alto'));
  expect(downloadButton()).toBeEnabled();

  // …and a failed read takes it away again instead of exporting a stale one.
  await choose('05103');
  await serveZone('05103', { detail: 'boom' }, 500);
  expect(downloadButton()).toBeDisabled();
});

test('saves a real PDF of the selected zone without issuing a request (PM-14)', async () => {
  const download = captureDownloads();
  await openSignedIn();
  await serveCatalogue(catalogue([feature('05101', 'Valparaíso'), feature('05102', 'Quilpué', 'Marga Marga')]));
  await serveZone('05101', batch('05101', 'alto'));

  const before = fetchStub.calls.length;
  fireEvent.click(downloadButton());
  await settle();

  expect(download.names).toEqual(['ficha-zona-05101.pdf']);
  expect(download.blobs).toHaveLength(1);
  expect(download.blobs[0].type).toBe('application/pdf');
  const saved = await savedPdf(download.blobs[0]);
  expect(saved.header).toBe('%PDF-1.4');
  // The document carries the state the card shows, read from the real payload.
  expect(saved.text).toContain('Ficha de riesgo por zona');
  expect(saved.text).toContain('Comuna: Valparaíso');
  expect(saved.text).toContain('CUT 05101');
  expect(saved.text).toContain('Nivel de riesgo: ALTO');
  expect(saved.text).toContain('Cómo lo calculó la regla');
  expect(saved.text).toContain('Recomendaciones preventivas');
  // The commune polygon travels as vector geometry, not as a placeholder.
  expect(saved.text).toContain('Trazado vectorial del polígono servido por /v1/risk/zones');

  // The ficha is composed locally: no read, no write, no action.
  expect(fetchStub.calls.length).toBe(before);
  expect(fetchStub.calls.every(call => (call.init.method ?? 'GET') === 'GET')).toBe(true);
  // The object URL is released once the download has started.
  await waitFor(() => expect(download.revokeObjectURL).toHaveBeenCalledWith('blob:test-1'));
});

test('follows the selection instead of reusing the previous ficha (PM-14)', async () => {
  const download = captureDownloads();
  await openSignedIn();
  await serveCatalogue(catalogue([feature('05101', 'Valparaíso'), feature('05102', 'Quilpué', 'Marga Marga')]));
  await serveZone('05101', batch('05101', 'alto'));

  fireEvent.click(downloadButton());
  await settle();

  await choose('05102');
  await serveZone('05102', batch('05102', 'medio'));
  fireEvent.click(downloadButton());
  await settle();

  expect(download.names).toEqual(['ficha-zona-05101.pdf', 'ficha-zona-05102.pdf']);
  const second = await savedPdf(download.blobs[1]);
  expect(second.text).toContain('Comuna: Quilpué');
  expect(second.text).toContain('CUT 05102');
  expect(second.text).toContain('Nivel de riesgo: MEDIO');
  expect(second.text).not.toContain('CUT 05101');
  await waitFor(() => expect(download.revokeObjectURL).toHaveBeenCalledTimes(2));
});

test('carries the synthetic disclosure of the batch into the saved document (R3)', async () => {
  const download = captureDownloads();
  await openSignedIn();
  await serveCatalogue(catalogue([feature('05101', 'Valparaíso')]));
  await serveZone('05101', batch('05101', 'alto', { demo: true }));

  fireEvent.click(downloadButton());
  await settle();

  const saved = await savedPdf(download.blobs[0]);
  expect(saved.text).toContain('Datos sintéticos');
  expect(saved.text).toContain('Entorno sintético: no riesgo real observado.');
  await waitFor(() => expect(download.revokeObjectURL).toHaveBeenCalledWith('blob:test-1'));
});

test('a batch the page refuses to present is exported as unclassified, not as a level (PM-14)', async () => {
  const download = captureDownloads();
  await openSignedIn();
  await serveCatalogue(catalogue([feature('05101', 'Valparaíso')]));
  // The batch carries no rationale, so `presentBatch` fails closed and the card
  // shows no level while the payload itself is still a readable batch.
  await serveZone('05101', batch('05101', 'alto', { rationale: '' }));
  expect(downloadButton()).toBeEnabled();

  fireEvent.click(downloadButton());
  await settle();

  const saved = await savedPdf(download.blobs[0]);
  expect(saved.text).toContain('Nivel de riesgo: SIN CLASIFICAR');
  expect(saved.text).toContain('justificación');
  expect(saved.text).not.toContain('Nivel de riesgo: ALTO');
  await waitFor(() => expect(download.revokeObjectURL).toHaveBeenCalledWith('blob:test-1'));
});
