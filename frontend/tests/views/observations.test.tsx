import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { gatewayOrigin, issuer, pkceTransactionKey } from '../../src/config';
import { completeLogin, getSessionSnapshot, resetSession } from '../../src/core/session';
import { ObservationsView } from '../../src/views/ObservationsView';

import { createCryptoStub, createFetchStub, createStorageStub, flush, jwt } from '../core/harness';

// S2 / S3 — the field-observation screen against the frozen PM-09 seam. The
// transport and the session are stubbed exactly like the rest of the suite, and
// the view is exercised as a person would use it: the zone picker reads the real
// catalogue, the type is a closed catalogue, the filter is a server read, the
// author is never sent, a refusal keeps every entered value and a saved record
// is re-read from the service instead of being stitched into the list locally.

const OBSERVATIONS_URL = `${gatewayOrigin}/v1/prevention/observations`;
const ZONES_URL = `${gatewayOrigin}/v1/prevention/observations/zones`;
const ACTIONS_URL = `${gatewayOrigin}/v1/prevention/actions`;
const TOKEN_URL = `${issuer}/protocol/openid-connect/token`;
const ADMIN_TOKEN = jwt({ realm_access: { roles: ['admin'] } });
const VIEWER_TOKEN = jwt({ realm_access: { roles: ['viewer'] } });
const DESCRIPTION = 'Pastizal seco junto a la escalera de acceso.';

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

async function connect(token: string): Promise<void> {
  storageStub.storage.setItem(pkceTransactionKey, JSON.stringify({ state: 's', verifier: 'verifier' }));
  const login = completeLogin('?code=code-1&state=s');
  await flush();
  fetchStub.answer(TOKEN_URL, { access_token: token, id_token: 'id-token' });
  await login;
  fetchStub.calls.length = 0;
}

function zonesFixture(): Record<string, unknown>[] {
  return [
    { code: 'z-1', name: 'Foco Quebrada del Este', province: 'Valparaíso' },
    { code: 'z-2', name: 'Interior de Quilpué', province: null },
  ];
}

function observationFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'obs-1',
    type: 'vegetacion_seca',
    zone_id: 'z-1',
    zone_name: 'Foco Quebrada del Este',
    observed_on: '2026-11-20',
    description: DESCRIPTION,
    created_by: 'sub-verified',
    created_at: '2026-11-20T10:05:00Z',
    ...overrides,
  };
}

function actionFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'action-1',
    community_code: '05101',
    title: 'Despeje de vegetación seca',
    priority: 'alta',
    status: 'propuesta',
    assignee: null,
    due_date: null,
    ...overrides,
  };
}

function callsTo(url: string, method: 'GET' | 'POST'): { url: string; init: RequestInit }[] {
  return fetchStub.callsFor(url).filter(call => (call.init.method ?? 'GET') === method);
}

// Resolves the pending request for `url` once it has been issued. The stub
// records the call synchronously, so waiting on the count is the fence that keeps
// an answer from being delivered to a request the view never made.
async function answer(
  url: string,
  method: 'GET' | 'POST',
  body: unknown,
  status = 200,
  requestId = '',
  expected = 1,
): Promise<void> {
  await waitFor(() => expect(callsTo(url, method)).toHaveLength(expected));
  await act(async () => {
    fetchStub.answer(url, body, status, requestId);
    await flush();
  });
}

function text(id: string): string {
  return document.getElementById(id)?.textContent ?? '';
}

function value(id: string): string {
  return (document.getElementById(id) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null)?.value ?? '';
}

function optionValues(id: string): string[] {
  return [...document.querySelectorAll(`#${id} option`)].map(option => (option as HTMLOptionElement).value);
}

function optionLabels(id: string): string[] {
  return [...document.querySelectorAll(`#${id} option`)].map(option => option.textContent ?? '');
}

async function mountSignedIn(token = ADMIN_TOKEN): Promise<void> {
  await connect(token);
  render(<ObservationsView />);
}

async function fillForm(overrides: { type?: string; description?: string } = {}): Promise<void> {
  await userEvent.selectOptions(screen.getByLabelText('Zona o sector'), 'z-1');
  await userEvent.selectOptions(screen.getByLabelText('Tipo de observación'), overrides.type ?? 'vegetacion_seca');
  fireEvent.change(screen.getByLabelText('Fecha de la observación'), { target: { value: '2026-11-20' } });
  await userEvent.type(screen.getByLabelText('Descripción'), overrides.description ?? DESCRIPTION);
}

beforeEach(setup);

afterEach(() => {
  vi.unstubAllGlobals();
});

test('the view carries its own identifiers and offers nothing before a session exists', () => {
  render(<ObservationsView />);

  const section = document.querySelector('section#observations');
  expect(section).not.toBeNull();
  expect(section).toHaveAttribute('data-view', 'observations');

  for (const id of [
    'observations-title',
    'observations-badge',
    'observations-lede',
    'observations-status',
    'observation-form',
    'observation-form-title',
    'observation-zone',
    'observation-type',
    'observation-date',
    'observation-description',
    'observation-submit',
    'observation-feedback',
    'observation-list-title',
    'observation-filter',
    'observation-filter-reset',
    'observation-count',
    'observation-rows',
  ]) {
    expect(document.getElementById(id), id).not.toBeNull();
  }

  // No session, no request: the page does not read anything it cannot attribute.
  expect(fetchStub.calls).toHaveLength(0);
  expect(text('observations-badge')).toBe('SIN CONSULTAR');
  expect(text('observations-status')).toMatch(/conecta un token autorizado/i);
  expect((document.getElementById('observation-submit') as HTMLButtonElement).disabled).toBe(true);
  expect(document.getElementById('observation-rows')?.querySelectorAll('li')).toHaveLength(0);
});

test('the controls keep native label associations and the type catalogue is closed in Spanish', async () => {
  await mountSignedIn();
  await answer(ZONES_URL, 'GET', zonesFixture());
  await answer(OBSERVATIONS_URL, 'GET', []);

  expect(screen.getByLabelText('Zona o sector')).toHaveAttribute('id', 'observation-zone');
  expect(screen.getByLabelText('Tipo de observación')).toHaveAttribute('id', 'observation-type');
  expect(screen.getByLabelText('Fecha de la observación')).toHaveAttribute('id', 'observation-date');
  expect(screen.getByLabelText('Descripción')).toHaveAttribute('id', 'observation-description');
  expect(screen.getByLabelText('Filtrar por tipo')).toHaveAttribute('id', 'observation-filter');

  // The closed feed catalogue of PM-09: wire values with the Spanish labels S2/S3
  // name. No free-text type control exists.
  expect(optionValues('observation-type')).toEqual([
    '',
    'vegetacion_seca',
    'microbasural',
    'quema',
    'acceso_bloqueado',
    'otro',
  ]);
  expect(optionLabels('observation-type')).toEqual([
    'Selecciona un tipo del catálogo',
    'Vegetación seca',
    'Microbasural',
    'Quema',
    'Acceso bloqueado',
    'Otro',
  ]);
  expect(optionValues('observation-filter')).toEqual([
    '',
    'vegetacion_seca',
    'microbasural',
    'quema',
    'acceso_bloqueado',
    'otro',
  ]);
  // The description is bounded by the contract, and the page counts what is left.
  expect(screen.getByLabelText('Descripción')).toHaveAttribute('maxlength', '240');
  expect(text('observation-description-count')).toBe('0 / 240');
});

test('the zone picker lists only the real catalogue and never invents a sector', async () => {
  await mountSignedIn();
  await answer(ZONES_URL, 'GET', zonesFixture());
  await answer(OBSERVATIONS_URL, 'GET', []);

  expect(optionValues('observation-zone')).toEqual(['', 'z-1', 'z-2']);
  // A zone without a province keeps the service code instead of an invented name.
  expect(optionLabels('observation-zone')).toEqual([
    'Selecciona una zona del catálogo',
    'Foco Quebrada del Este · Valparaíso',
    'Interior de Quilpué · z-2',
  ]);
  expect(document.getElementById('observation-zone')?.textContent).not.toMatch(/foco-quebrada-este|borde-costero/i);
  expect(text('observation-zones-status')).toMatch(/2 zonas disponibles/i);
  expect((document.getElementById('observation-submit') as HTMLButtonElement).disabled).toBe(false);
});

test('a stored observation is rendered with its type label, zone, date, description and server author', async () => {
  await mountSignedIn();
  await answer(ZONES_URL, 'GET', zonesFixture());
  await answer(OBSERVATIONS_URL, 'GET', [observationFixture()]);

  const rows = document.getElementById('observation-rows');
  expect(rows?.querySelectorAll('li')).toHaveLength(1);
  const body = rows?.textContent ?? '';
  expect(body).toContain('Vegetación seca');
  expect(body).not.toContain('vegetacion_seca');
  expect(body).toContain('Foco Quebrada del Este');
  expect(body).toContain('2026-11-20');
  expect(body).toContain(DESCRIPTION);
  expect(body).toContain('sub-verified');
  expect(body).toContain('2026-11-20T10:05:00Z');
  expect(text('observation-count')).toBe('1 observación');
  expect(text('observations-status')).toMatch(/\/v1\/prevention\/observations \(1\)/);
  expect(text('observations-badge')).toBe('LEÍDO');
});

test('the type filter is a server read; Quitar filtro restores the unfiltered list', async () => {
  await mountSignedIn();
  await answer(ZONES_URL, 'GET', zonesFixture());
  await answer(OBSERVATIONS_URL, 'GET', [observationFixture()]);

  await userEvent.selectOptions(screen.getByLabelText('Filtrar por tipo'), 'quema');
  await answer(`${OBSERVATIONS_URL}?type=quema`, 'GET', []);

  // An empty filtered answer is a real state that keeps the filter and explains
  // how to leave it: it is not "the service has no observations".
  expect(text('observations-status')).toMatch(/no devolvió observaciones del tipo/i);
  expect(text('observations-status')).toMatch(/Quema/);
  const empty = document.getElementById('observation-empty');
  expect(empty).not.toBeNull();
  expect(empty?.textContent).toMatch(/no hay observaciones registradas de ese tipo/i);
  expect(document.getElementById('observation-empty-reset')).not.toBeNull();
  expect(document.getElementById('observation-rows')?.querySelectorAll('li')).toHaveLength(0);

  await userEvent.click(screen.getByRole('button', { name: /quitar el filtro/i }));
  await answer(OBSERVATIONS_URL, 'GET', [observationFixture()], 200, '', 2);

  expect(value('observation-filter')).toBe('');
  expect(document.getElementById('observation-rows')?.querySelectorAll('li')).toHaveLength(1);
  expect(document.getElementById('observation-empty')).toBeNull();
});

test('saving posts the four fields without an author, blocks a duplicate submit and re-reads the list', async () => {
  await mountSignedIn();
  await answer(ZONES_URL, 'GET', zonesFixture());
  await answer(OBSERVATIONS_URL, 'GET', []);
  expect(text('observations-status')).toMatch(/todavía no registra observaciones/i);

  await fillForm();
  expect(text('observation-description-count')).toBe(`${DESCRIPTION.length} / 240`);

  await userEvent.click(screen.getByRole('button', { name: /guardar observación/i }));
  await waitFor(() => expect(callsTo(OBSERVATIONS_URL, 'POST')).toHaveLength(1));

  const call = callsTo(OBSERVATIONS_URL, 'POST')[0];
  expect((call.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  const posted = JSON.parse(String(call.init.body)) as Record<string, unknown>;
  expect(posted).toEqual({
    zone_id: 'z-1',
    type: 'vegetacion_seca',
    observed_on: '2026-11-20',
    description: DESCRIPTION,
  });
  expect(String(call.init.body)).not.toMatch(/created_by|author/);

  // While the creation is in flight the control is disabled, so a second click
  // cannot create a duplicate record.
  await userEvent.click(screen.getByRole('button', { name: /guardando…/i }));
  expect(callsTo(OBSERVATIONS_URL, 'POST')).toHaveLength(1);

  const created = observationFixture({ id: 'obs-9' });
  await answer(OBSERVATIONS_URL, 'POST', created, 201, 'req-201');
  await answer(OBSERVATIONS_URL, 'GET', [created], 200, '', 2);

  expect(text('observation-feedback')).toMatch(/guardada/i);
  expect(text('observation-feedback')).toMatch(/obs-9/);
  // The success copy says the list was re-read from the service, not patched.
  expect(text('observation-feedback')).toMatch(/vuelve a leer/i);
  expect(document.getElementById('observation-rows')?.querySelectorAll('li')).toHaveLength(1);
  // The type, date and description are cleared; the zone is kept for the next
  // observation of the same sector.
  expect(value('observation-type')).toBe('');
  expect(value('observation-date')).toBe('');
  expect(value('observation-description')).toBe('');
  expect(value('observation-zone')).toBe('z-1');
});

test('saving while a different type is filtered confirms persistence without promising a listed row', async () => {
  await mountSignedIn();
  await answer(ZONES_URL, 'GET', zonesFixture());
  await answer(OBSERVATIONS_URL, 'GET', []);
  await userEvent.selectOptions(screen.getByLabelText('Filtrar por tipo'), 'quema');
  await answer(`${OBSERVATIONS_URL}?type=quema`, 'GET', []);

  await fillForm();
  await userEvent.click(screen.getByRole('button', { name: /guardar observación/i }));
  const created = observationFixture({ id: 'obs-older', observed_on: '2020-01-01' });
  await answer(OBSERVATIONS_URL, 'POST', created, 201, 'req-201');
  await answer(`${OBSERVATIONS_URL}?type=quema`, 'GET', [], 200, '', 2);

  expect(text('observation-feedback')).toMatch(/Observación guardada \(obs-older\)/);
  expect(text('observation-feedback')).not.toMatch(/filtro|aparecerá/i);
  expect(value('observation-filter')).toBe('quema');
  expect(document.getElementById('observation-rows')?.querySelectorAll('li')).toHaveLength(0);
});

test('a refused save keeps every entered value and surfaces the server code and request id', async () => {
  await mountSignedIn();
  await answer(ZONES_URL, 'GET', zonesFixture());
  await answer(OBSERVATIONS_URL, 'GET', []);

  await fillForm({ type: 'quema' });
  await userEvent.click(screen.getByRole('button', { name: /guardar observación/i }));
  await answer(OBSERVATIONS_URL, 'POST', { code: 'invalid_observation_request' }, 422, 'req-invalid');

  expect(text('observation-feedback')).toMatch(/invalid_observation_request/);
  expect(text('observation-feedback')).toMatch(/HTTP 422/);
  expect(text('observation-feedback')).toMatch(/req-invalid/);
  expect(value('observation-zone')).toBe('z-1');
  expect(value('observation-type')).toBe('quema');
  expect(value('observation-date')).toBe('2026-11-20');
  expect(value('observation-description')).toBe(DESCRIPTION);
  // A failure is not a reason to re-read the list: nothing changed on the server.
  expect(callsTo(OBSERVATIONS_URL, 'GET')).toHaveLength(1);
});

test('the catalogue and the list state their loading phase before any answer lands', async () => {
  await mountSignedIn();
  await waitFor(() => expect(callsTo(OBSERVATIONS_URL, 'GET')).toHaveLength(1));

  expect(text('observations-badge')).toBe('CONSULTANDO');
  expect(text('observations-status')).toMatch(/consultando las observaciones/i);
  expect(text('observation-zones-status')).toMatch(/consultando el catálogo de zonas/i);
  expect((document.getElementById('observation-submit') as HTMLButtonElement).disabled).toBe(true);

  await answer(ZONES_URL, 'GET', zonesFixture());
  await answer(OBSERVATIONS_URL, 'GET', []);
});

test('a closed session empties the persisted list and the form draft', async () => {
  await mountSignedIn();
  await answer(ZONES_URL, 'GET', zonesFixture());
  await answer(OBSERVATIONS_URL, 'GET', [observationFixture()]);
  await fillForm();

  act(() => {
    resetSession();
  });

  await waitFor(() => expect(text('observations-badge')).toBe('SIN CONSULTAR'));
  expect(document.getElementById('observation-rows')?.querySelectorAll('li')).toHaveLength(0);
  expect(value('observation-zone')).toBe('');
  expect(value('observation-type')).toBe('');
  expect(value('observation-description')).toBe('');
  expect(text('observations-status')).toMatch(/conecta un token autorizado/i);
});

test('a 403 on the list is a stated permission denial with its request id and no rows', async () => {
  await mountSignedIn();
  await answer(ZONES_URL, 'GET', zonesFixture());
  await answer(OBSERVATIONS_URL, 'GET', { code: 'forbidden' }, 403, 'req-403');

  expect(text('observations-badge')).toBe('SIN PERMISO');
  expect(text('observations-status')).toMatch(/denegó el permiso/i);
  expect(text('observations-status')).toMatch(/req-403/);
  expect(document.getElementById('observation-rows')?.querySelectorAll('li')).toHaveLength(0);
});

test('a 503 storage failure is named with its code instead of being repaired with data', async () => {
  await mountSignedIn();
  await answer(ZONES_URL, 'GET', zonesFixture());
  await answer(OBSERVATIONS_URL, 'GET', { code: 'storage_unavailable' }, 503, 'req-503');

  expect(text('observations-badge')).toBe('NO DISPONIBLE');
  expect(text('observations-status')).toMatch(/storage_unavailable/);
  expect(text('observations-status')).toMatch(/HTTP 503/);
  expect(text('observations-status')).toMatch(/req-503/);
  expect(document.getElementById('observation-rows')?.querySelectorAll('li')).toHaveLength(0);
});

test('a 401 on the list closes the session and says the token was rejected', async () => {
  await mountSignedIn();
  await answer(ZONES_URL, 'GET', zonesFixture());
  await answer(OBSERVATIONS_URL, 'GET', { code: 'unauthorized' }, 401, 'req-401');

  expect(getSessionSnapshot().status).toBe('signed-out');
  expect(text('observations-status')).toMatch(/rechazó el token/i);
  expect(text('observations-status')).toMatch(/req-401/);
  expect((document.getElementById('observation-submit') as HTMLButtonElement).disabled).toBe(true);
});

test('a viewer reads the list but cannot submit the form', async () => {
  await mountSignedIn(VIEWER_TOKEN);
  await answer(ZONES_URL, 'GET', zonesFixture());
  await answer(OBSERVATIONS_URL, 'GET', [observationFixture()]);

  expect(document.getElementById('observation-rows')?.querySelectorAll('li')).toHaveLength(1);
  expect((document.getElementById('observation-submit') as HTMLButtonElement).disabled).toBe(true);
  expect(text('observation-role-note')).toMatch(/rol viewer/i);
  expect(text('observation-role-note')).toMatch(/analista o admin/i);
  expect(text('observation-role-note')).toMatch(/servidor/i);
  expect(callsTo(OBSERVATIONS_URL, 'POST')).toHaveLength(0);
});

test('an unavailable zone catalogue disables the form until the retry read succeeds', async () => {
  await mountSignedIn();
  await answer(OBSERVATIONS_URL, 'GET', []);
  await answer(ZONES_URL, 'GET', { code: 'storage_unavailable' }, 503, 'req-z503');

  expect(text('observation-zones-status')).toMatch(/storage_unavailable/);
  expect((document.getElementById('observation-submit') as HTMLButtonElement).disabled).toBe(true);
  expect(document.getElementById('observation-zones-retry')).not.toBeNull();

  await userEvent.click(screen.getByRole('button', { name: /reintentar catálogo de zonas/i }));
  await answer(ZONES_URL, 'GET', zonesFixture(), 200, '', 2);

  expect(optionValues('observation-zone')).toEqual(['', 'z-1', 'z-2']);
  expect((document.getElementById('observation-zone') as HTMLSelectElement).disabled).toBe(false);
  expect(text('observation-zones-status')).toMatch(/2 zonas disponibles/i);
});

// PM-10 / S4 — the narrow seam this task adds to the PM-09 screen. The action
// list is a panel-local read, so it must not become part of the list's lifecycle:
// replacing the list closes the confirmation instead of re-reading the action
// list for a row the person never opened.
test('a filter change closes the open confirmation instead of re-reading its action list', async () => {
  await mountSignedIn();
  await answer(ZONES_URL, 'GET', zonesFixture());
  await answer(OBSERVATIONS_URL, 'GET', [observationFixture()]);

  await userEvent.click(screen.getByRole('button', { name: /confirmar que el trabajo se necesita/i }));
  await answer(ACTIONS_URL, 'GET', [actionFixture()]);
  expect(document.getElementById('observation-adoption-obs-1')).not.toBeNull();

  await userEvent.selectOptions(screen.getByLabelText('Filtrar por tipo'), 'quema');
  expect(document.getElementById('observation-adoption-obs-1')).toBeNull();

  await answer(`${OBSERVATIONS_URL}?type=quema`, 'GET', [observationFixture({ type: 'quema' })]);

  // The same observation is listed under the new filter and the panel is NOT
  // reopened: its one action-list read stays the only one.
  expect(document.getElementById('observation-rows')?.querySelectorAll('li')).toHaveLength(1);
  expect(document.getElementById('observation-adoption-obs-1')).toBeNull();
  expect(callsTo(ACTIONS_URL, 'GET')).toHaveLength(1);
  expect(document.getElementById('observation-adopt-obs-1')?.getAttribute('aria-expanded')).toBe('false');
  expect(text('observation-adoption-status')).toBe('');
});

// The confirmation is a write, so a viewer reads the observations and the
// recorded associations but is offered no control and no action-list read.
test('a viewer is offered no confirmation control and no action-list read', async () => {
  await mountSignedIn(VIEWER_TOKEN);
  await answer(ZONES_URL, 'GET', zonesFixture());
  await answer(OBSERVATIONS_URL, 'GET', [observationFixture()]);

  expect(document.getElementById('observation-rows')?.querySelectorAll('li')).toHaveLength(1);
  expect(document.getElementById('observation-adopt-obs-1')).toBeNull();
  expect(document.getElementById('observation-adoption-obs-1')).toBeNull();
  expect(callsTo(ACTIONS_URL, 'GET')).toHaveLength(0);
  expect(text('observation-list-note')).toMatch(/rol analista o admin/i);
});

// ── T6 · the field-work composition (board 11) ─────────────────────────────
//
// The board's record opens with the closed-catalogue type and the date, names the
// zone as the record's subject, then reads the description and the attribution.
// The list also states what it is, because a screen reader reaches the rows
// without the panel title in view.

test('each record opens with its type and names the zone before the description and the attribution', async () => {
  await mountSignedIn();
  await answer(ZONES_URL, 'GET', zonesFixture());
  await answer(OBSERVATIONS_URL, 'GET', [observationFixture()]);

  const item = document.querySelector('#observation-rows li') as HTMLElement | null;
  expect(item).not.toBeNull();
  const children = [...(item as HTMLElement).children];
  // The head carries the type mark and the date; the zone is the record's own
  // subject and is emphasised, not left as flat metadata.
  expect(item?.querySelector('.observation-type')).toHaveTextContent('Vegetación seca');
  expect(item?.querySelector('.observation-item-head .observation-date')).toHaveTextContent('2026-11-20');
  expect(item?.querySelector('.observation-zone strong')).toHaveTextContent('Foco Quebrada del Este · z-1');
  expect(children[0]?.className).toBe('observation-item-head');
  expect(children[1]?.className).toBe('observation-zone');

  // The list names itself and its order for the reader who lands inside it.
  expect(document.getElementById('observation-rows')).toHaveAttribute(
    'aria-label',
    'Observaciones registradas, más reciente primero',
  );
});

test('an unavailable list is a designed state, and the technical line stays in the live region', async () => {
  await mountSignedIn();
  await answer(ZONES_URL, 'GET', zonesFixture());
  await answer(OBSERVATIONS_URL, 'GET', { code: 'storage_unavailable' }, 503, 'req-503');

  const card = document.getElementById('observation-list-state');
  expect(card).not.toBeNull();
  expect(card).toHaveClass('field-state-error');
  expect(card).toHaveTextContent(/no está disponible/i);
  // The status/code/request id are announced once, by the status line.
  expect(card).not.toHaveTextContent(/req-503/);
  expect(text('observations-status')).toMatch(/req-503/);
  // An error is not an empty period: the empty card belongs to a completed read.
  expect(document.getElementById('observation-empty')).toBeNull();
  expect(document.getElementById('observation-rows')?.querySelectorAll('li')).toHaveLength(0);
});
