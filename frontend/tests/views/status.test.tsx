import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { clearZoneState } from '../../src/app/store';
import { gatewayOrigin, issuer, pkceTransactionKey } from '../../src/config';
import { aggregateStatus, type AggregateStatusOutcome, type Failure } from '../../src/core/api';
import { completeLogin, resetSession } from '../../src/core/session';
import { StatusView } from '../../src/views/StatusView';

import { createFetchStub, createStorageStub, flush, jwt } from '../core/harness';

// PM-16 — the `#status` board and the aggregate read behind it.
//
// The transport half is exercised here because `/v1/status` is the one route that
// answers 503 WITH A BODY: what must be pinned is that the body survives, that an
// incoherent or reordered answer is refused instead of being rendered, and that a
// 403 stays a permission fact. The view half pins the verdict, the per-row
// reasons, the weather source and the active-rule row (version and hash), and that
// the board never claims a trained model.

const TOKEN_URL = `${issuer}/protocol/openid-connect/token`;
const STATUS_URL = `${gatewayOrigin}/v1/status`;
const SOURCES_URL = `${gatewayOrigin}/v1/risk/sources`;
const MODELS_URL = `${gatewayOrigin}/v1/models`;

const RULE_HASH = 'e17aaa5600eb67c9a91340e90057aec100f4e80ef0895662f373cffee66564c7';

function statusBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    checked_at: '2026-11-25T12:00:00Z',
    gateway: { state: 'ready' },
    services: [
      { service: 'risk', state: 'ready' },
      { service: 'jobs', state: 'ready' },
      { service: 'prevention', state: 'ready' },
      { service: 'inference', state: 'ready' },
    ],
    ...overrides,
  };
}

function degradedBody(): Record<string, unknown> {
  return statusBody({
    services: [
      { service: 'risk', state: 'ready' },
      { service: 'jobs', state: 'ready' },
      { service: 'prevention', state: 'degraded' },
      { service: 'inference', state: 'unknown' },
    ],
  });
}

function sourcesBody(riskInput: unknown = { id: 'open-meteo', display_name: 'Open-Meteo', synthetic: false }): Record<string, unknown> {
  return {
    geography: {
      provenance: {
        provider: 'MOP - IDE Chile (SERVICIO_DPA, capa Comunas)',
        attribution: 'Atribución literal de la fuente',
        restriction: 'Restricción literal de la fuente',
        record_count: 38,
        derived_sha256: 'c'.repeat(64),
      },
      source_cutoff_at: null,
      cutoff_semantics: 'retrieval_substitution: stored cutoff equals retrieved',
      integrity: { algorithm: 'sha256', matches: true },
    },
    // The weather source is the active publisher descriptor; `null` is the
    // contracted way of saying this deployment configures none.
    risk_input: riskInput,
    sources: [],
  };
}

function modelsBody(effective: unknown = { status: 'rule', version: 'academic-rule-v1', params_hash: RULE_HASH }): Record<string, unknown> {
  return { models: [], effective };
}

function prepare() {
  const fetchStub = createFetchStub();
  const storageStub = createStorageStub();
  vi.stubGlobal('fetch', fetchStub.fetch);
  vi.stubGlobal('sessionStorage', storageStub.storage);
  return { fetchStub, storageStub };
}

async function connect(): Promise<ReturnType<typeof prepare> & { token: string }> {
  const context = prepare();
  const token = jwt({ realm_access: { roles: ['viewer'] } });
  context.storageStub.storage.setItem(pkceTransactionKey, JSON.stringify({ state: 's', verifier: 'v' }));
  const login = completeLogin('?code=code-1&state=s');
  await flush();
  context.fetchStub.answer(TOKEN_URL, { access_token: token });
  await login;
  context.fetchStub.calls.length = 0;
  return { ...context, token };
}

interface ReadsOverrides {
  status?: unknown;
  statusStatus?: number;
  sources?: unknown;
  sourcesStatus?: number;
  models?: unknown;
  modelsStatus?: number;
}

// Every settled assertion answers all three reads, so a pending request can never
// leave the board half-painted and pass by accident.
function answerReads(fetchStub: ReturnType<typeof createFetchStub>, overrides: ReadsOverrides = {}): void {
  fetchStub.answer(STATUS_URL, overrides.status ?? statusBody(), overrides.statusStatus ?? 200);
  fetchStub.answer(SOURCES_URL, overrides.sources ?? sourcesBody(), overrides.sourcesStatus ?? 200);
  fetchStub.answer(MODELS_URL, overrides.models ?? modelsBody(), overrides.modelsStatus ?? 200);
}

function text(id: string): string {
  return document.getElementById(id)?.textContent ?? '';
}

function rows(): Element[] {
  return [...document.querySelectorAll('#status .status-table tbody tr')];
}

function rowFor(service: string): Element | null {
  return document.querySelector(`#status .status-table tbody tr[data-service="${service}"]`);
}

function expectFailure(outcome: AggregateStatusOutcome): Failure {
  if (outcome.ok) throw new Error('expected a failure outcome');
  return outcome.failure;
}

beforeEach(() => {
  resetSession();
  clearZoneState();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Transport (S4) ──────────────────────────────────────────────────────────

test('the aggregate read is absolute, authenticated, cache-busting and keeps the served order', async () => {
  const { fetchStub, token } = await connect();

  const read = aggregateStatus();
  await flush();
  const calls = fetchStub.callsFor(STATUS_URL);
  expect(calls).toHaveLength(1);
  expect(calls[0].init.headers).toMatchObject({ Authorization: `Bearer ${token}` });
  expect(calls[0].init.cache).toBe('no-store');
  expect(calls[0].init.credentials).toBe('omit');

  fetchStub.answer(STATUS_URL, statusBody());
  const outcome = await read;
  expect(outcome).toMatchObject({ ok: true, status: 200 });
  if (!outcome.ok) return;
  expect(outcome.data.services.map(entry => entry.service)).toEqual(['risk', 'jobs', 'prevention', 'inference']);
  expect(outcome.data.services.every(entry => entry.state === 'ready')).toBe(true);
});

test('a 503 body is preserved as the aggregate verdict instead of becoming a generic error', async () => {
  const { fetchStub } = await connect();

  const read = aggregateStatus();
  await flush();
  fetchStub.answer(STATUS_URL, degradedBody(), 503);
  const outcome = await read;

  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return;
  // The code travels with the body so the view can say the aggregate answered
  // 503 without turning the rows into a failure.
  expect(outcome.status).toBe(503);
  expect(outcome.data.services).toEqual([
    { service: 'risk', state: 'ready' },
    { service: 'jobs', state: 'ready' },
    { service: 'prevention', state: 'degraded' },
    { service: 'inference', state: 'unknown' },
  ]);
});

test('an out-of-order service list is refused instead of being rendered under the wrong name', async () => {
  const { fetchStub } = await connect();

  const read = aggregateStatus();
  await flush();
  fetchStub.answer(
    STATUS_URL,
    statusBody({
      services: [
        { service: 'jobs', state: 'ready' },
        { service: 'risk', state: 'ready' },
        { service: 'prevention', state: 'ready' },
        { service: 'inference', state: 'ready' },
      ],
    }),
  );

  expect(expectFailure(await read)).toMatchObject({ kind: 'malformed', reason: 'invalid_shape' });
});

test('an unknown service or an unknown state is refused, and ready is never invented', async () => {
  const { fetchStub } = await connect();

  const unknownService = aggregateStatus();
  await flush();
  fetchStub.answer(
    STATUS_URL,
    statusBody({
      services: [
        { service: 'risk', state: 'ready' },
        { service: 'jobs', state: 'ready' },
        { service: 'prevention', state: 'ready' },
        { service: 'batch', state: 'ready' },
      ],
    }),
  );
  expect(expectFailure(await unknownService)).toMatchObject({ kind: 'malformed' });

  const unknownState = aggregateStatus();
  await flush();
  fetchStub.answer(
    STATUS_URL,
    statusBody({
      services: [
        { service: 'risk', state: 'ready' },
        { service: 'jobs', state: 'ready' },
        { service: 'prevention', state: 'listo' },
        { service: 'inference', state: 'ready' },
      ],
    }),
  );
  expect(expectFailure(await unknownState)).toMatchObject({ kind: 'malformed' });
});

test('a body with fewer than the four declared services is refused', async () => {
  const { fetchStub } = await connect();

  const read = aggregateStatus();
  await flush();
  fetchStub.answer(STATUS_URL, statusBody({ services: [{ service: 'risk', state: 'ready' }] }));

  expect(expectFailure(await read)).toMatchObject({ kind: 'malformed' });
});

test('an incoherent code/body pair is refused in both directions', async () => {
  const { fetchStub } = await connect();

  // 200 that claims a not-ready service.
  const healthyCode = aggregateStatus();
  await flush();
  fetchStub.answer(STATUS_URL, degradedBody(), 200);
  expect(expectFailure(await healthyCode)).toMatchObject({ kind: 'malformed', reason: 'status_mismatch' });

  // 503 that carries no not-ready entry.
  const unreadyCode = aggregateStatus();
  await flush();
  fetchStub.answer(STATUS_URL, statusBody(), 503);
  expect(expectFailure(await unreadyCode)).toMatchObject({ kind: 'malformed', reason: 'status_mismatch' });
});

test('the route decides its roles: a 403 is a permission fact and a 401 lowers the session', async () => {
  const { fetchStub } = await connect();

  const forbidden = aggregateStatus();
  await flush();
  fetchStub.answer(STATUS_URL, { code: 'forbidden' }, 403);
  expect(expectFailure(await forbidden)).toMatchObject({ kind: 'forbidden', status: 403 });

  const { fetchStub: secondStub } = await connect();
  const unauthorized = aggregateStatus();
  await flush();
  secondStub.answer(STATUS_URL, { code: 'unauthorized' }, 401);
  expect(expectFailure(await unauthorized)).toMatchObject({ kind: 'unauthorized', status: 401 });
});

test('a transport failure is unavailable, not an empty board', async () => {
  await connect();

  const controller = new AbortController();
  const read = aggregateStatus(controller.signal);
  await flush();
  controller.abort();

  expect(expectFailure(await read)).toMatchObject({ kind: 'unavailable', reason: 'aborted' });
});

// ── View (S3/S5) ────────────────────────────────────────────────────────────

test('without a session the board states it is unconsulted and issues no read', () => {
  const { fetchStub } = prepare();
  render(<StatusView />);

  expect(fetchStub.calls).toHaveLength(0);
  expect(text('status-verdict-badge')).toBe('SIN CONSULTAR');
  expect(text('status-verdict')).toMatch(/conecta un token autorizado/i);
  expect(text('status-weather-source')).toBe('Sin consultar');
  expect(text('status-rule-version')).toBe('Sin consultar');
  expect(text('status-rule-hash')).toBe('Sin consultar');
  expect(rows()).toHaveLength(0);
});

test('a read in flight says so and shows no invented row', async () => {
  const { fetchStub } = await connect();
  render(<StatusView />);
  await flush();

  for (const url of [STATUS_URL, SOURCES_URL, MODELS_URL]) {
    expect(fetchStub.callsFor(url)).toHaveLength(1);
  }
  expect(text('status-verdict-badge')).toBe('CONSULTANDO');
  expect(text('status-rule-version')).toBe('Consultando…');
  expect(rows()).toHaveLength(0);

  answerReads(fetchStub);
  await waitFor(() => expect(text('status-verdict-badge')).toBe('OPERATIVO'));
});

test('every service ready renders «Operativo», the five rows in server order and the active rule', async () => {
  const { fetchStub } = await connect();
  render(<StatusView />);
  await flush();

  answerReads(fetchStub);
  await waitFor(() => expect(text('status-verdict-badge')).toBe('OPERATIVO'));

  expect(document.getElementById('status-verdict-title')?.textContent).toBe('Veredicto operativo');
  expect(text('status-verdict')).toMatch(/^Los cuatro servicios declarados/);
  expect(text('status-verdict')).toMatch(/CONAF ni de SENAPRED/);
  expect(text('status-checked-at')).toBe('2026-11-25T12:00:00Z');
  expect(text('status-http-status')).toBe('200 con las cuatro filas');
  expect(text('status-services-count')).toBe('4 listos · 0 sin estar listos');

  expect(rows().map(row => row.getAttribute('data-service'))).toEqual([
    'gateway',
    'risk',
    'jobs',
    'prevention',
    'inference',
  ]);
  for (const row of rows()) {
    expect(row.getAttribute('data-state')).toBe('ready');
    expect(row.textContent).toMatch(/Listo/);
    expect(row.textContent).not.toMatch(/modelo/i);
  }

  // The composed rows: the weather source the payload publishes and the ACTIVE
  // RULE with its validated version and hash.
  expect(text('status-weather-source')).toBe('Open-Meteo · open-meteo');
  expect(text('status-weather-detail')).toMatch(/no sintética/);
  expect(text('status-rule-version')).toBe('academic-rule-v1');
  expect(text('status-rule-hash')).toBe(RULE_HASH);
  expect(text('status-partial')).toMatch(/compusieron el tablero/i);

  // The board never presents a trained model and never uses that language.
  const board = document.getElementById('status')?.textContent ?? '';
  expect(board).not.toMatch(/modelo entrenado/i);
  expect(board).not.toMatch(/modelo/i);
  expect(board).toMatch(/Regla activa/);
});

test('a 503 with its body renders «Operación degradada», the served rows and is not a generic error', async () => {
  const { fetchStub } = await connect();
  render(<StatusView />);
  await flush();

  answerReads(fetchStub, { status: degradedBody(), statusStatus: 503 });
  await waitFor(() => expect(text('status-verdict-badge')).toBe('OPERACIÓN DEGRADADA'));

  expect(text('status-verdict-title')).toBe('Veredicto operativo');
  expect(text('status-verdict')).toMatch(/Operación degradada|No todos los servicios están listos/);
  expect(text('status-verdict')).toMatch(/Servicio de prevención \(degradado\)/);
  expect(text('status-verdict')).toMatch(/Servicio de inferencia \(desconocido\)/);
  // The 503 is stated as the aggregate's own answer, not as a transport error.
  expect(text('status-verdict')).toMatch(/respondió 503 con este mismo cuerpo/);
  expect(text('status-verdict')).not.toMatch(/No fue posible leer/);
  expect(text('status-http-status')).toBe('503 con las cuatro filas');
  expect(text('status-services-count')).toBe('2 listos · 2 sin estar listos');

  expect(rows()).toHaveLength(5);
  expect(rowFor('prevention')?.getAttribute('data-state')).toBe('degraded');
  expect(rowFor('prevention')?.textContent).toMatch(/Degradado/);
  expect(rowFor('inference')?.getAttribute('data-state')).toBe('unknown');
  expect(rowFor('inference')?.textContent).toMatch(/Desconocido/);
});

test('jobs «unauthorized» reads as «requiere admin», not as an outage', async () => {
  const { fetchStub } = await connect();
  render(<StatusView />);
  await flush();

  answerReads(fetchStub, {
    status: statusBody({
      services: [
        { service: 'risk', state: 'ready' },
        { service: 'jobs', state: 'unauthorized' },
        { service: 'prevention', state: 'ready' },
        { service: 'inference', state: 'not_configured' },
      ],
    }),
  });
  await waitFor(() => expect(text('status-verdict-badge')).toBe('OPERACIÓN DEGRADADA'));

  const jobs = rowFor('jobs');
  expect(jobs?.getAttribute('data-state')).toBe('unauthorized');
  expect(jobs?.querySelector('.status-state')?.textContent).toBe('Requiere admin');
  expect(jobs?.textContent).toMatch(/permiso/i);
  // It is never labelled with the two states that mean a service failed.
  expect(jobs?.textContent).not.toMatch(/Degradado|Desconocido/);

  const inference = rowFor('inference');
  expect(inference?.getAttribute('data-state')).toBe('not_configured');
  expect(inference?.textContent).toMatch(/No configurado/);
  expect(text('status-verdict')).toMatch(/no configurado/);
});

test('an absent weather source says «no configurada» and invents none', async () => {
  const { fetchStub } = await connect();
  render(<StatusView />);
  await flush();

  answerReads(fetchStub, { sources: sourcesBody(null) });
  await waitFor(() => expect(text('status-verdict-badge')).toBe('OPERATIVO'));

  expect(text('status-weather-source')).toBe('No configurada');
  expect(text('status-weather-detail')).toMatch(/no publica una fuente meteorológica/i);
  expect(text('status-weather-detail')).toMatch(/no inventa una/i);
  // The aggregate verdict is independent of this row, so the services stay true.
  expect(rows()).toHaveLength(5);
});

test('a synthetic weather source is labelled as such', async () => {
  const { fetchStub } = await connect();
  render(<StatusView />);
  await flush();

  answerReads(fetchStub, {
    sources: sourcesBody({ id: 'academic', display_name: 'Perfil académico', synthetic: true }),
  });
  await waitFor(() => expect(text('status-weather-source')).toBe('Perfil académico · academic'));

  expect(text('status-weather-detail')).toMatch(/sintética para demostración/i);
  expect(text('status-weather-detail')).toMatch(/no es una lectura meteorológica observada/i);
});

test('a failed weather read degrades that row only and the board keeps its services', async () => {
  const { fetchStub } = await connect();
  render(<StatusView />);
  await flush();

  answerReads(fetchStub, { sources: { code: 'forbidden' }, sourcesStatus: 403 });
  await waitFor(() => expect(text('status-verdict-badge')).toBe('OPERATIVO'));

  expect(text('status-weather-source')).toBe('No disponible');
  expect(text('status-weather-detail')).toMatch(/denegó el permiso/i);
  expect(text('status-partial')).toMatch(/Lectura parcial/i);
  expect(text('status-partial')).toMatch(/fuente meteorológica/i);
  expect(rows()).toHaveLength(5);
});

test('a resolved non-rule states «sin regla activa» and never a version or a hash', async () => {
  const { fetchStub } = await connect();
  render(<StatusView />);
  await flush();

  answerReads(fetchStub, { models: modelsBody({ status: 'non_rule' }) });
  await waitFor(() => expect(text('status-rule-version')).toBe('Sin regla activa'));

  expect(text('status-rule-hash')).toBe('No aplica');
  expect(text('status-rule-detail')).toMatch(/no es una regla/i);
  expect(document.getElementById('status')?.textContent ?? '').not.toMatch(/modelo/i);
});

test('an unreadable effective projection is «no verificable» and never borrows an identity', async () => {
  const { fetchStub } = await connect();
  render(<StatusView />);
  await flush();

  answerReads(fetchStub, { models: modelsBody({ status: 'rule', version: '', params_hash: RULE_HASH }) });
  await waitFor(() => expect(text('status-rule-version')).toBe('No verificable'));

  expect(text('status-rule-hash')).toBe('No acreditado');
  expect(text('status-partial')).toMatch(/Lectura parcial/i);
  expect(text('status-partial')).toMatch(/regla activa/i);
  // The valid hash of a rule without a version is not rendered as an identity.
  expect(text('status-rule-hash')).not.toBe(RULE_HASH);
});

test('a failed rule read leaves the aggregate verdict intact and says the rule is unverified', async () => {
  const { fetchStub } = await connect();
  render(<StatusView />);
  await flush();

  answerReads(fetchStub, { models: { code: 'storage_unavailable' }, modelsStatus: 503 });
  await waitFor(() => expect(text('status-verdict-badge')).toBe('OPERATIVO'));

  expect(text('status-rule-version')).toBe('No verificable');
  expect(text('status-rule-hash')).toBe('No acreditado');
  expect(text('status-rule-detail')).toMatch(/HTTP 503/);
  expect(rows()).toHaveLength(5);
});

test('a transport failure of the aggregate shows an explicit failure and no fabricated rows', async () => {
  const { fetchStub } = await connect();
  render(<StatusView />);
  await flush();

  fetchStub.answer(SOURCES_URL, sourcesBody());
  fetchStub.answer(MODELS_URL, modelsBody());
  // The aggregate is answered 502: a real transport/upstream failure, not the
  // documented 503 verdict.
  fetchStub.answer(STATUS_URL, { code: 'upstream_unavailable' }, 502);
  await waitFor(() => expect(text('status-verdict-badge')).toBe('NO DISPONIBLE'));

  expect(text('status-verdict')).toMatch(/No fue posible leer/);
  expect(text('status-verdict')).toMatch(/upstream_unavailable/);
  expect(rows()).toHaveLength(0);
  expect(text('status-services-unavailable')).toMatch(/no fabrica un estado por servicio/i);
  // The composed rows are still readable: only the aggregate failed.
  expect(text('status-weather-source')).toBe('Open-Meteo · open-meteo');
  expect(text('status-rule-version')).toBe('academic-rule-v1');
});

test('the table is semantic: caption, headers with scope and a text state per row', async () => {
  const { fetchStub } = await connect();
  render(<StatusView />);
  await flush();
  answerReads(fetchStub);
  await waitFor(() => expect(rows()).toHaveLength(5));

  const section = document.getElementById('status');
  expect(section?.tagName).toBe('SECTION');
  expect(section).toHaveAttribute('aria-labelledby', 'status-title');
  expect(document.getElementById('status-title')?.tagName).toBe('H2');
  expect(document.getElementById('status-verdict-title')?.tagName).toBe('H3');

  const table = section?.querySelector('table.status-table');
  expect(table).not.toBeNull();
  expect(table?.querySelector('caption')?.textContent).toMatch(/orden es el del\s+servidor/i);
  expect(table?.querySelectorAll('thead th[scope="col"]')).toHaveLength(3);
  expect(table?.querySelectorAll('tbody th[scope="row"]')).toHaveLength(5);
  // Every state is a word, so the row is readable without relying on colour.
  for (const row of rows()) {
    expect(row.querySelector('.status-state')?.textContent?.trim()).not.toBe('');
  }
});
