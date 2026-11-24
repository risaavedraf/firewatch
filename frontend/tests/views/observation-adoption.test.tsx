import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { gatewayOrigin, issuer, pkceTransactionKey } from '../../src/config';
import { completeLogin, resetSession } from '../../src/core/session';
import { ObservationsView } from '../../src/views/ObservationsView';

import { createCryptoStub, createFetchStub, createStorageStub, flush, jwt } from '../core/harness';

// S1 / S4 / L3–L6 — the PM-10 relationship inside the PM-09 observation screen.
// The person confirms that a recorded observation justifies an existing
// preventive action; the page then asks the T2 operation to store the link and
// reads the association back from the service. Three facts travel with this
// suite: the action list is read ON DEMAND (never on mount), the confirmation is
// explicit and states that nobody is assigned, and a refusal keeps what the
// person chose instead of erasing it.

const OBSERVATIONS_URL = `${gatewayOrigin}/v1/prevention/observations`;
const ZONES_URL = `${gatewayOrigin}/v1/prevention/observations/zones`;
const ACTIONS_URL = `${gatewayOrigin}/v1/prevention/actions`;
const ADOPTION_URL = `${OBSERVATIONS_URL}/obs-1/adoption`;
const TOKEN_URL = `${issuer}/protocol/openid-connect/token`;
const ADMIN_TOKEN = jwt({ realm_access: { roles: ['admin'] } });
const VIEWER_TOKEN = jwt({ realm_access: { roles: ['viewer'] } });
const DESCRIPTION = 'Pastizal seco junto a la escalera de acceso.';
const EFFECT_COPY = /no asigna a ninguna persona/i;

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

async function connect(token: string, clearCalls = true): Promise<void> {
  storageStub.storage.setItem(pkceTransactionKey, JSON.stringify({ state: 's', verifier: 'verifier' }));
  const login = completeLogin('?code=code-1&state=s');
  await flush();
  fetchStub.answer(TOKEN_URL, { access_token: token, id_token: 'id-token' });
  await login;
  if (clearCalls) fetchStub.calls.length = 0;
}

function zonesFixture(): Record<string, unknown>[] {
  return [{ code: 'z-1', name: 'Foco Quebrada del Este', province: 'Valparaíso' }];
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
    adopted_action_id: null,
    ...overrides,
  };
}

function actionFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'action-1',
    community_code: '05101',
    title: 'Despeje de vegetación seca',
    description: 'Franja de 30 m junto al acceso',
    priority: 'alta',
    status: 'propuesta',
    assignee: null,
    due_date: '2026-12-01',
    created_by: 'sub-verified',
    created_at: '2026-11-18T09:00:00Z',
    updated_at: '2026-11-18T09:00:00Z',
    ...overrides,
  };
}

function callsTo(url: string, method: 'GET' | 'POST'): { url: string; init: RequestInit }[] {
  return fetchStub.callsFor(url).filter(call => (call.init.method ?? 'GET') === method);
}

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
  return (document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null)?.value ?? '';
}

function optionValues(id: string): string[] {
  return [...document.querySelectorAll(`#${id} option`)].map(option => (option as HTMLOptionElement).value);
}

function optionLabels(id: string): string[] {
  return [...document.querySelectorAll(`#${id} option`)].map(option => option.textContent ?? '');
}

function checked(id: string): boolean {
  return (document.getElementById(id) as HTMLInputElement | null)?.checked ?? false;
}

function disabled(id: string): boolean {
  return (document.getElementById(id) as HTMLButtonElement | null)?.disabled ?? false;
}

async function mountSignedIn(token = ADMIN_TOKEN, observationsBody = [observationFixture()]): Promise<void> {
  await connect(token);
  render(<ObservationsView />);
  await answer(ZONES_URL, 'GET', zonesFixture());
  await answer(OBSERVATIONS_URL, 'GET', observationsBody);
}

async function openConfirmation(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: /confirmar que el trabajo se necesita/i }));
}

async function chooseAction(actionId = 'action-1', candidates = [actionFixture()]): Promise<void> {
  await answer(ACTIONS_URL, 'GET', candidates);
  await userEvent.selectOptions(screen.getByLabelText('Trabajo preventivo existente'), actionId);
}

beforeEach(setup);

afterEach(() => {
  vi.unstubAllGlobals();
});

test('opening the confirmation is what reads the action list, and the panel states the effect', async () => {
  await mountSignedIn();

  // Mounting the page reads observations and zones only: no action list, no post.
  expect(callsTo(ACTIONS_URL, 'GET')).toHaveLength(0);
  expect(fetchStub.calls.filter(call => (call.init.method ?? 'GET') === 'POST')).toHaveLength(0);

  const trigger = document.getElementById('observation-adopt-obs-1');
  expect(trigger).not.toBeNull();
  expect(trigger?.getAttribute('aria-expanded')).toBe('false');

  await openConfirmation();

  await waitFor(() => expect(callsTo(ACTIONS_URL, 'GET')).toHaveLength(1));
  expect(text('observation-adoption-candidates-obs-1')).toMatch(/consultando los trabajos preventivos/i);
  expect(disabled('observation-adoption-submit-obs-1')).toBe(true);
  expect(document.getElementById('observation-adopt-obs-1')?.getAttribute('aria-expanded')).toBe('true');
  // The effect is stated before anyone chooses: a link is not an assignment and
  // it does not move the action.
  expect(text('observation-adoption-effect-obs-1')).toMatch(EFFECT_COPY);
  expect(text('observation-adoption-effect-obs-1')).toMatch(/no cambia el estado del trabajo/i);
  expect(text('observation-adoption-effect-obs-1')).toMatch(/no lo marca como terminado/i);

  await answer(ACTIONS_URL, 'GET', [
    actionFixture(),
    actionFixture({ id: 'action-2', title: 'Trabajo cancelado', status: 'cancelada' }),
  ]);

  // Only the real non-cancelled action is offered: the server refuses a new link
  // to a cancelled one, so it is never presented as a choice.
  expect(optionValues('observation-adoption-action-obs-1')).toEqual(['', 'action-1']);
  expect(optionLabels('observation-adoption-action-obs-1')).toEqual([
    'Selecciona un trabajo preventivo del servicio',
    'Despeje de vegetación seca · Propuesta',
  ]);
  expect(document.getElementById('observation-adoption-action-obs-1')?.textContent).not.toMatch(/cancelado/i);
  expect(text('observation-adoption-candidates-obs-1')).toMatch(/1 trabajo preventivo vigente/i);
  // A choice is not a confirmation yet.
  expect(disabled('observation-adoption-submit-obs-1')).toBe(true);

  await userEvent.selectOptions(screen.getByLabelText('Trabajo preventivo existente'), 'action-1');
  expect(disabled('observation-adoption-submit-obs-1')).toBe(true);

  // Reopening reads the list again: a candidate set is never carried across.
  await userEvent.click(screen.getByRole('button', { name: /cancelar/i }));
  expect(document.getElementById('observation-adoption-obs-1')).toBeNull();
  // Closing returns the keyboard position to the control that opened the panel.
  expect(document.activeElement?.id).toBe('observation-adopt-obs-1');
  await openConfirmation();
  await waitFor(() => expect(callsTo(ACTIONS_URL, 'GET')).toHaveLength(2));
  await answer(ACTIONS_URL, 'GET', [actionFixture()], 200, '', 2);
  expect(optionValues('observation-adoption-action-obs-1')).toEqual(['', 'action-1']);
});

test('the explicit confirmation posts only the action and shows the association the service stored', async () => {
  await mountSignedIn();
  await openConfirmation();
  await chooseAction();

  // Enabled only by the explicit confirmation sentence, not by the selection.
  expect(disabled('observation-adoption-submit-obs-1')).toBe(true);
  await userEvent.click(screen.getByLabelText(/confirmo que la observación respalda el trabajo elegido/i));
  expect(checked('observation-adoption-confirm-obs-1')).toBe(true);
  expect(disabled('observation-adoption-submit-obs-1')).toBe(false);

  await userEvent.click(screen.getByRole('button', { name: /registrar vínculo/i }));
  await waitFor(() => expect(callsTo(ADOPTION_URL, 'POST')).toHaveLength(1));

  const call = callsTo(ADOPTION_URL, 'POST')[0];
  expect((call.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  expect(JSON.parse(String(call.init.body))).toEqual({ action_id: 'action-1' });
  expect(String(call.init.body)).not.toMatch(/created_by|assignee|status|note/);
  // A second click cannot duplicate the confirmation while it is in flight.
  expect(disabled('observation-adoption-submit-obs-1')).toBe(true);
  expect(screen.getByRole('button', { name: /registrando/i })).toBeDefined();

  await answer(ADOPTION_URL, 'POST', observationFixture({ adopted_action_id: 'action-1' }), 200, 'req-adopt');
  await answer(OBSERVATIONS_URL, 'GET', [observationFixture({ adopted_action_id: 'action-1' })], 200, '', 2);

  // The association comes from the service answer (post-link record and the
  // re-read list), never from a local draft row.
  expect(text('observation-adoption-linked-obs-1')).toMatch(/action-1/);
  expect(text('observation-adoption-linked-obs-1')).toMatch(/no se asignó a ninguna persona/i);
  expect(text('observation-adoption-linked-obs-1')).toMatch(/el estado del trabajo no cambió/i);
  expect(text('observation-adoption-status')).toMatch(/vuelve a leer desde el servicio/i);
  expect(text('observation-adopted-obs-1')).toMatch(/action-1/);
  expect(text('observation-adopted-obs-1')).toMatch(EFFECT_COPY);
  // No invented status label: the page never spells the action as assigned.
  expect(text('observation-adoption-linked-obs-1')).not.toMatch(/asignada|en curso|aceptada/i);

  // The confirmation form is gone and the result is announced and focused.
  expect(document.getElementById('observation-adoption-submit-obs-1')).toBeNull();
  expect(document.activeElement?.id).toBe('observation-adoption-close-obs-1');

  await userEvent.click(screen.getByRole('button', { name: /^cerrar$/i }));
  expect(document.getElementById('observation-adoption-obs-1')).toBeNull();
  expect(text('observation-adopted-obs-1')).toMatch(/action-1/);
  expect(document.activeElement?.id).toBe('observation-adopted-obs-1');
});

test('a cancelled action is refused in place and keeps the choice and the confirmation', async () => {
  await mountSignedIn();
  await openConfirmation();
  await chooseAction();
  await userEvent.click(screen.getByLabelText(/confirmo que la observación respalda el trabajo elegido/i));

  await userEvent.click(screen.getByRole('button', { name: /registrar vínculo/i }));
  await answer(ADOPTION_URL, 'POST', { code: 'action_cancelled' }, 409, 'req-cancelled');

  expect(text('observation-adoption-feedback-obs-1')).toMatch(/action_cancelled/);
  expect(text('observation-adoption-feedback-obs-1')).toMatch(/HTTP 409/);
  expect(text('observation-adoption-feedback-obs-1')).toMatch(/req-cancelled/);
  expect(document.activeElement?.id).toBe('observation-adoption-action-obs-1');
  // Nothing the person entered is erased by a refusal.
  expect(value('observation-adoption-action-obs-1')).toBe('action-1');
  expect(checked('observation-adoption-confirm-obs-1')).toBe(true);
  expect(disabled('observation-adoption-submit-obs-1')).toBe(false);
  expect(document.getElementById('observation-adoption-linked-obs-1')).toBeNull();
  // A refusal is not a reason to re-read the list: nothing was stored.
  expect(callsTo(OBSERVATIONS_URL, 'GET')).toHaveLength(1);
});

test('a new action selection requires its own explicit confirmation', async () => {
  await mountSignedIn();
  await openConfirmation();
  await chooseAction('action-1', [actionFixture(), actionFixture({ id: 'action-2', title: 'Retirar residuos' })]);
  await userEvent.click(screen.getByLabelText(/confirmo que la observación respalda el trabajo elegido/i));
  await userEvent.selectOptions(screen.getByLabelText('Trabajo preventivo existente'), 'action-2');
  expect(checked('observation-adoption-confirm-obs-1')).toBe(false);
  expect(disabled('observation-adoption-submit-obs-1')).toBe(true);
  await userEvent.click(screen.getByRole('button', { name: /registrar vínculo/i }));
  expect(callsTo(ADOPTION_URL, 'POST')).toHaveLength(0);
});

async function submitAdoption(): Promise<void> {
  await openConfirmation();
  await chooseAction();
  await userEvent.click(screen.getByLabelText(/confirmo que la observación respalda el trabajo elegido/i));
  await userEvent.click(screen.getByRole('button', { name: /registrar vínculo/i }));
  await waitFor(() => expect(callsTo(ADOPTION_URL, 'POST')).toHaveLength(1));
}

test.each(['closing', 'filtering'])('a late success after %s does not update or refresh the list', async exit => {
  await mountSignedIn();
  await submitAdoption();
  const signal = callsTo(ADOPTION_URL, 'POST')[0].init.signal;
  const filteredUrl = `${OBSERVATIONS_URL}?type=quema`;
  if (exit === 'closing') {
    await userEvent.click(screen.getByRole('button', { name: /cerrar confirmación/i }));
  } else {
    await userEvent.selectOptions(screen.getByLabelText('Filtrar por tipo'), 'quema');
    await answer(filteredUrl, 'GET', []);
  }
  await answer(ADOPTION_URL, 'POST', observationFixture({ adopted_action_id: 'action-1' }));
  expect(signal?.aborted).toBe(true);
  expect(text('observation-adoption-status')).toBe('');
  expect(callsTo(OBSERVATIONS_URL, 'GET')).toHaveLength(1);
  expect(callsTo(filteredUrl, 'GET')).toHaveLength(exit === 'filtering' ? 1 : 0);
});

test('a late adoption 401 cannot close a new login using the same bearer', async () => {
  await mountSignedIn();
  await submitAdoption();
  act(() => resetSession());
  await act(async () => connect(ADMIN_TOKEN, false));
  await answer(ZONES_URL, 'GET', zonesFixture(), 200, '', 2);
  await answer(OBSERVATIONS_URL, 'GET', [observationFixture()], 200, '', 2);
  await act(async () => {
    fetchStub.answer(ADOPTION_URL, { code: 'unauthorized' }, 401);
    await flush();
  });
  expect(screen.getByRole('button', { name: /confirmar que el trabajo se necesita/i })).toBeInTheDocument();
  expect(text('observation-adoption-status')).toBe('');
  expect(callsTo(OBSERVATIONS_URL, 'GET')).toHaveLength(2);
});

test('an observation that already justifies another action is stated instead of overwritten', async () => {
  await mountSignedIn();
  await openConfirmation();
  await chooseAction();
  await userEvent.click(screen.getByLabelText(/confirmo que la observación respalda el trabajo elegido/i));

  await userEvent.click(screen.getByRole('button', { name: /registrar vínculo/i }));
  await answer(ADOPTION_URL, 'POST', { code: 'observation_already_adopted' }, 409, 'req-adopted');

  expect(text('observation-adoption-feedback-obs-1')).toMatch(/observation_already_adopted/);
  expect(text('observation-adoption-feedback-obs-1')).toMatch(/no reemplaza al primero/i);
  expect(value('observation-adoption-action-obs-1')).toBe('action-1');
  expect(checked('observation-adoption-confirm-obs-1')).toBe(true);
});

test('a candidate list failure is named with its code and the retry re-reads it', async () => {
  await mountSignedIn();
  await openConfirmation();

  await answer(ACTIONS_URL, 'GET', { code: 'storage_unavailable' }, 503, 'req-503');

  expect(text('observation-adoption-candidates-obs-1')).toMatch(/storage_unavailable/);
  expect(text('observation-adoption-candidates-obs-1')).toMatch(/HTTP 503/);
  expect(text('observation-adoption-candidates-obs-1')).toMatch(/req-503/);
  expect(disabled('observation-adoption-submit-obs-1')).toBe(true);

  await userEvent.click(screen.getByRole('button', { name: /reintentar trabajos preventivos/i }));
  await waitFor(() => expect(callsTo(ACTIONS_URL, 'GET')).toHaveLength(2));
  expect(text('observation-adoption-candidates-obs-1')).toMatch(/consultando los trabajos preventivos/i);
  await answer(ACTIONS_URL, 'GET', [actionFixture()], 200, '', 2);
  expect(optionValues('observation-adoption-action-obs-1')).toEqual(['', 'action-1']);
});

test('a viewer sees the association read from the service and is offered no confirmation', async () => {
  await mountSignedIn(VIEWER_TOKEN, [observationFixture({ adopted_action_id: 'action-9' })]);

  expect(text('observation-adopted-obs-1')).toMatch(/action-9/);
  expect(text('observation-adopted-obs-1')).toMatch(EFFECT_COPY);
  // The link is a historical record: it survives a later cancellation of the work.
  expect(text('observation-adopted-obs-1')).toMatch(/aunque el trabajo se cancele después/i);
  expect(document.getElementById('observation-adopt-obs-1')).toBeNull();
  expect(callsTo(ACTIONS_URL, 'GET')).toHaveLength(0);
  expect(disabled('observation-submit')).toBe(true);
});

test('an admin sees the same historical association and cannot link that observation twice', async () => {
  await mountSignedIn(ADMIN_TOKEN, [observationFixture({ adopted_action_id: 'action-9' })]);

  expect(text('observation-adopted-obs-1')).toMatch(/action-9/);
  expect(text('observation-adopted-obs-1')).toMatch(EFFECT_COPY);
  expect(document.getElementById('observation-adopt-obs-1')).toBeNull();
  expect(callsTo(ACTIONS_URL, 'GET')).toHaveLength(0);
});

test('closing the session removes the open confirmation, its selection and its draft', async () => {
  await mountSignedIn();
  await openConfirmation();
  await chooseAction();
  await userEvent.click(screen.getByLabelText(/confirmo que la observación respalda el trabajo elegido/i));

  act(() => {
    resetSession();
  });

  await waitFor(() => expect(document.getElementById('observation-adoption-obs-1')).toBeNull());
  expect(document.getElementById('observation-rows')?.querySelectorAll('li')).toHaveLength(0);
  expect(document.getElementById('observation-adopted-obs-1')).toBeNull();
  expect(text('observation-adoption-status')).toBe('');
  expect(callsTo(ADOPTION_URL, 'POST')).toHaveLength(0);
  expect(fetchStub.calls.filter(call => (call.init.method ?? 'GET') === 'POST')).toHaveLength(0);

  // Nothing of the previous session survives: the screen is back to its idle state.
  expect(text('observations-badge')).toBe('SIN CONSULTAR');
  fireEvent.change(document.getElementById('observation-description') as HTMLTextAreaElement, {
    target: { value: 'x' },
  });
  expect(document.getElementById('observation-adoption-obs-1')).toBeNull();
});
