import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { gatewayOrigin, issuer, pkceTransactionKey } from '../../src/config';
import { completeLogin, getSessionSnapshot, resetSession, subscribeSessionGeneration } from '../../src/core/session';
import { ActionsView } from '../../src/views/ActionsView';

import { createCryptoStub, createFetchStub, createStorageStub, flush, jwt } from '../core/harness';

// S3 — the actions table marks the row whose detail is open. jsdom applies no
// stylesheet, so the rule is read from the file the browser receives.
const appCss = readFileSync(resolve(process.cwd(), 'src', 'styles', 'app.css'), 'utf8');

// S3 / T12 — the preventive-action view against the frozen contract. The
// transport and the session are stubbed exactly as the rest of the suite; the
// view itself is exercised end to end: list, detail with its history, creation,
// role-gated transitions and the honest rendering of the server's refusals.

const ACTIONS_URL = `${gatewayOrigin}/v1/prevention/actions`;
// V1-U-04 — the realm's user directory, spelled literally so the contract path
// itself is pinned rather than derived from the same constant under test.
const USERS_URL = `${gatewayOrigin}/v1/users`;
const TOKEN_URL = `${issuer}/protocol/openid-connect/token`;
const ADMIN_TOKEN = jwt({ realm_access: { roles: ['admin'] } });
// A second bearer declaring the SAME role as ADMIN_TOKEN: the replacement the view
// has to notice through the session generation, not through the declared roles.
const SECOND_ADMIN_TOKEN = jwt({ realm_access: { roles: ['admin'] }, sub: 'operator-2' });
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

async function connect(token: string): Promise<void> {
  storageStub.storage.setItem(pkceTransactionKey, JSON.stringify({ state: 's', verifier: 'verifier' }));
  const login = completeLogin('?code=code-1&state=s');
  await flush();
  fetchStub.answer(TOKEN_URL, { access_token: token, id_token: 'id-token' });
  await login;
  fetchStub.calls.length = 0;
}

function actionFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'action-1',
    community_code: '05101',
    title: 'Despeje de vegetación',
    description: 'Franja de 30 m junto al camino',
    priority: 'alta',
    status: 'propuesta',
    assignee: 'equipo-1',
    due_date: '2026-11-01',
    created_by: 'actor-1',
    created_at: '2026-10-17T10:00:00Z',
    updated_at: '2026-10-17T10:00:00Z',
    ...overrides,
  };
}

function detailFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...actionFixture(overrides),
    history: [
      {
        id: 1,
        action_id: 'action-1',
        from_status: null,
        to_status: 'propuesta',
        actor_sub: 'actor-1',
        note: 'alta inicial',
        created_at: '2026-10-17T10:00:00Z',
      },
      {
        id: 2,
        action_id: 'action-1',
        from_status: 'propuesta',
        to_status: 'asignada',
        actor_sub: 'admin-1',
        note: 'asignada al equipo',
        created_at: '2026-10-17T11:00:00Z',
      },
    ],
    evidence: [],
    evidence_reviews: [],
    reassessments: [],
    evidence_sufficient: false,
  };
}

async function answerList(body: unknown, status = 200, requestId = ''): Promise<void> {  await act(async () => {
    fetchStub.answer(ACTIONS_URL, body, status, requestId);
    await flush();
  });
}

async function answerDetail(body: unknown, status = 200, requestId = ''): Promise<void> {
  await act(async () => {
    fetchStub.answer(`${ACTIONS_URL}/action-1`, body, status, requestId);
    await flush();
  });
}

// The directory the identity provider would return: the identifiers it assigns
// and the display name the service resolved. Never a fabricated person. The
// identifiers are UUIDs because the contract types an action's `assignee_id` that
// way and the service resolves it by reading exactly this identifier.
const USER_ADMIN = '7f3a2c91-5b4e-4c8a-9d21-0f6b8c3d4e52';
const USER_REVIEWER = 'b2d4e6f8-1a3c-4d5e-8f90-2b4c6d8e0f1a';
const DIRECTORY = [
  { id: USER_ADMIN, display_name: 'Admin del Directorio' },
  { id: USER_REVIEWER, display_name: 'Revisor del Directorio' },
];

async function answerUsers(body: unknown, status = 200, requestId = ''): Promise<void> {
  await act(async () => {
    fetchStub.answer(USERS_URL, body, status, requestId);
    await flush();
  });
}

function assigneeSelect(): HTMLSelectElement {
  return document.getElementById('create-assignee') as HTMLSelectElement;
}

function optionValues(): string[] {
  return [...assigneeSelect().options].map(option => option.value);
}

function text(id: string): string {
  return document.getElementById(id)?.textContent ?? '';
}

function postCalls(): { url: string; init: RequestInit }[] {
  return fetchStub.calls.filter(call => call.url === ACTIONS_URL && call.init.method === 'POST');
}

// Two exchanges in flight at once. This is the one way the running page can adopt a
// different bearer while declaring the SAME roles: an ordinary login always passes
// through `signing-in`, so `SessionState` would describe it, and a same-role
// adoption would not. The second exchange settles while the first session is live.
async function startConcurrentAdoptions(): Promise<{ first: Promise<void>; second: Promise<void> }> {
  storageStub.storage.setItem(pkceTransactionKey, JSON.stringify({ state: 's', verifier: 'verifier' }));
  const first = completeLogin('?code=code-1&state=s');
  await flush();
  storageStub.storage.setItem(pkceTransactionKey, JSON.stringify({ state: 's', verifier: 'verifier' }));
  const second = completeLogin('?code=code-2&state=s');
  await flush();
  expect(fetchStub.callsFor(TOKEN_URL)).toHaveLength(2);
  return { first, second };
}

async function land(token: string, login: Promise<void>): Promise<void> {
  await act(async () => {
    fetchStub.answer(TOKEN_URL, { access_token: token, id_token: 'id-token' });
    await login;
    await flush();
  });
}

beforeEach(() => {
  setup();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('the view carries its own identifiers and offers nothing before a session exists', async () => {
  const { container } = render(<ActionsView />);

  const section = container.querySelector('section#actions') as HTMLElement | null;
  expect(section).not.toBeNull();
  expect(section).toHaveAttribute('data-view', 'actions');

  for (const id of ['actions-title', 'actions-badge', 'actions-status', 'actions-rows']) {
    expect(document.getElementById(id), id).not.toBeNull();
  }
  expect(fetchStub.calls).toHaveLength(0);
  expect(text('actions-badge')).toBe('SIN CONSULTAR');
  expect(text('actions-status')).toMatch(/conecta un token autorizado/i);
  expect(document.getElementById('actions-rows')?.querySelectorAll('tr')).toHaveLength(0);
  // The creation control exists but is disabled: the server, not a hidden panel,
  // is what decides.
  expect((document.getElementById('create-action') as HTMLButtonElement).disabled).toBe(true);
});

test('a signed-in admin reads the list with only the filters that are set', async () => {
  await connect(ADMIN_TOKEN);
  render(<ActionsView />);

  await waitFor(() => expect(fetchStub.callsFor(ACTIONS_URL)).toHaveLength(1));
  const listCall = fetchStub.callsFor(ACTIONS_URL)[0];
  expect((listCall.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${ADMIN_TOKEN}`);
  await answerList([actionFixture(), actionFixture({ id: 'action-2', status: 'en_curso', title: 'Charla' })]);

  const rows = [...(document.getElementById('actions-rows')?.querySelectorAll('tr') ?? [])];
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent('Despeje de vegetación');
  expect(rows[0]).toHaveTextContent('05101');
  expect(rows[0]).toHaveTextContent('Propuesta');
  expect(rows[1]).toHaveTextContent('En curso');
  expect(text('actions-badge')).toBe('LEÍDO');
  expect((document.getElementById('create-action') as HTMLButtonElement).disabled).toBe(false);
});

test('opening an action reads its detail and renders the history row by row', async () => {
  await connect(ADMIN_TOKEN);
  render(<ActionsView />);
  await waitFor(() => expect(fetchStub.callsFor(ACTIONS_URL)).toHaveLength(1));
  await answerList([actionFixture()]);

  await userEvent.click(document.querySelector('[data-action-id="action-1"]') as HTMLElement);
  await waitFor(() => expect(fetchStub.callsFor(`${ACTIONS_URL}/action-1`)).toHaveLength(1));
  await answerDetail(detailFixture());

  expect(text('action-detail-title')).toContain('Despeje de vegetación');
  expect(text('action-detail-fields')).toContain('equipo-1');
  expect(text('action-detail-status')).toMatch(/historial/i);

  const historyRows = [...(document.getElementById('action-history-rows')?.querySelectorAll('tr') ?? [])];
  expect(historyRows).toHaveLength(2);
  expect(historyRows[0]).toHaveTextContent('propuesta');
  expect(historyRows[0]).toHaveTextContent('alta inicial');
  expect(historyRows[1]).toHaveTextContent('asignada');
  expect(historyRows[1]).toHaveTextContent('admin-1');
});

test('the creation form posts the fields it was given and reports the created action', async () => {
  await connect(ADMIN_TOKEN);
  render(<ActionsView />);
  await waitFor(() => expect(fetchStub.callsFor(ACTIONS_URL)).toHaveLength(1));
  await answerList([]);

  await userEvent.type(document.getElementById('create-community') as HTMLElement, '05101');
  await userEvent.type(document.getElementById('create-title') as HTMLElement, 'Charla preventiva');
  await userEvent.type(document.getElementById('create-description') as HTMLElement, 'Con la junta de vecinos');
  await userEvent.type(document.getElementById('create-priority') as HTMLElement, 'media');
  await answerUsers(DIRECTORY);
  await userEvent.selectOptions(assigneeSelect(), USER_REVIEWER);

  await userEvent.click(document.getElementById('create-action') as HTMLButtonElement);
  await waitFor(() => {
    expect(fetchStub.calls.some(call => call.url === ACTIONS_URL && call.init.method === 'POST')).toBe(true);
  });

  const post = fetchStub.calls.find(call => call.url === ACTIONS_URL && call.init.method === 'POST')!;
  expect(JSON.parse(String(post.init.body))).toEqual({
    community_code: '05101',
    title: 'Charla preventiva',
    description: 'Con la junta de vecinos',
    priority: 'media',
    assignee_id: USER_REVIEWER,
  });

  await act(async () => {
    fetchStub.answer(ACTIONS_URL, actionFixture({ id: 'action-9', title: 'Charla preventiva' }), 201);
    await flush();
  });
  // The list is re-read after a create so the screen reflects the server, not a
  // local guess about where the new row belongs.
  await waitFor(() => expect(fetchStub.callsFor(ACTIONS_URL).length).toBeGreaterThanOrEqual(2));
  await answerList([actionFixture({ id: 'action-9', title: 'Charla preventiva' })]);
  expect(text('actions-notice')).toMatch(/creada/i);
  expect(text('actions-rows')).toContain('Charla preventiva');
});

// ── V1-U-04 · assignment from the user directory ───────────────────────────
//
// The acceptance cases of the plan item (V1-U-04): unassigned, assigned and a
// server refusal. The directory is real data behind an admin-only route, so the
// view must never fill the selector with an invented person, must keep the
// unassigned option while the directory is unreadable, and must never render a
// refused assignment as a created action.

test('the assignee selector is fed by the realm directory and the assignment travels as assignee_id', async () => {
  await connect(ADMIN_TOKEN);
  render(<ActionsView />);

  // Only an authorized create UI reads the directory, and it carries the bearer.
  await waitFor(() => expect(fetchStub.callsFor(USERS_URL)).toHaveLength(1));
  const usersCall = fetchStub.callsFor(USERS_URL)[0];
  expect((usersCall.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${ADMIN_TOKEN}`);
  await answerList([]);
  await answerUsers(DIRECTORY);

  // The unassigned option stays first: creating without a responsible is valid
  // and is the server's documented default. The rest are the real directory.
  expect(optionValues()).toEqual(['', USER_ADMIN, USER_REVIEWER]);
  expect([...assigneeSelect().options].map(option => option.textContent)).toEqual([
    'Sin asignar (se crea sin responsable)',
    'Admin del Directorio',
    'Revisor del Directorio',
  ]);
  expect(text('create-assignee-status')).toMatch(/2 usuario/i);

  await userEvent.type(document.getElementById('create-community') as HTMLElement, '05101');
  await userEvent.type(document.getElementById('create-title') as HTMLElement, 'Acción asignada');
  await userEvent.selectOptions(assigneeSelect(), USER_REVIEWER);
  // The chosen reference is named before the write, so the operator sees what
  // the server will resolve.
  expect(text('create-assignee-status')).toMatch(/Se asignaría a Revisor del Directorio/);

  await userEvent.click(document.getElementById('create-action') as HTMLButtonElement);
  await waitFor(() => {
    expect(fetchStub.calls.some(call => call.url === ACTIONS_URL && call.init.method === 'POST')).toBe(true);
  });
  const post = fetchStub.calls.find(call => call.url === ACTIONS_URL && call.init.method === 'POST')!;
  const body = JSON.parse(String(post.init.body)) as Record<string, unknown>;
  expect(body.assignee_id).toBe(USER_REVIEWER);
  // The legacy free-text field is display compatibility: a new assignment never
  // travels through it.
  expect(body).not.toHaveProperty('assignee');

  const created = actionFixture({ id: 'action-7', status: 'propuesta', title: 'Acción asignada', assignee: null, assignee_id: USER_REVIEWER });
  await act(async () => {
    fetchStub.answer(ACTIONS_URL, created, 201);
    await flush();
  });
  await waitFor(() => expect(fetchStub.callsFor(ACTIONS_URL).length).toBeGreaterThanOrEqual(2));
  await answerList([created]);
  // The list names the directory user, from the directory that was read.
  expect(text('actions-rows')).toContain('Revisor del Directorio');
  expect(text('actions-rows')).not.toContain(USER_REVIEWER);

  await waitFor(() => expect(fetchStub.callsFor(`${ACTIONS_URL}/action-7`)).toHaveLength(1));
  await act(async () => {
    fetchStub.answer(`${ACTIONS_URL}/action-7`, {
      ...created,
      history: [],
      evidence: [],
      evidence_reviews: [],
      reassessments: [],
      evidence_sufficient: false,
    });
    await flush();
  });
  expect(text('action-detail-fields')).toContain('Revisor del Directorio');
});

test('an action without a responsible is created without assignee_id and shown as sin asignar', async () => {
  await connect(ADMIN_TOKEN);
  render(<ActionsView />);
  await waitFor(() => expect(fetchStub.callsFor(USERS_URL)).toHaveLength(1));
  const unassigned = actionFixture({ assignee: null, assignee_id: null });
  await answerUsers(DIRECTORY);
  await answerList([unassigned]);

  // The row states the absence instead of leaving the cell blank or guessing.
  expect(text('actions-rows')).toContain('Sin asignar');

  await userEvent.type(document.getElementById('create-community') as HTMLElement, '05101');
  await userEvent.type(document.getElementById('create-title') as HTMLElement, 'Acción sin responsable');
  await userEvent.click(document.getElementById('create-action') as HTMLButtonElement);
  await waitFor(() => {
    expect(fetchStub.calls.some(call => call.url === ACTIONS_URL && call.init.method === 'POST')).toBe(true);
  });
  const post = fetchStub.calls.find(call => call.url === ACTIONS_URL && call.init.method === 'POST')!;
  expect(JSON.parse(String(post.init.body))).toEqual({
    community_code: '05101',
    title: 'Acción sin responsable',
  });

  const created = actionFixture({
    id: 'action-8',
    title: 'Acción sin responsable',
    assignee: null,
    assignee_id: null,
  });
  await act(async () => {
    fetchStub.answer(ACTIONS_URL, created, 201);
    await flush();
  });
  await waitFor(() => expect(fetchStub.callsFor(ACTIONS_URL).length).toBeGreaterThanOrEqual(2));
  await answerList([created]);
  expect(text('actions-rows')).toContain('Sin asignar');
});

// A filtered read that returns no row is not a dead end: the filters are the
// reason, so the panel offers clearing them where it reports the empty answer.
test('a filtered read with no row offers an in-panel reset of the filters', async () => {
  await connect(ADMIN_TOKEN);
  render(<ActionsView />);
  await waitFor(() => expect(fetchStub.callsFor(ACTIONS_URL)).toHaveLength(1));
  await answerList([actionFixture()]);
  await waitFor(() => expect(text('actions-rows')).toContain('Despeje de vegetación'));

  const filtered = `${ACTIONS_URL}?community_code=99999`;
  await userEvent.type(document.getElementById('actions-community-filter') as HTMLElement, '99999');
  await userEvent.click(document.getElementById('actions-apply-filters') as HTMLButtonElement);
  await waitFor(() => expect(fetchStub.callsFor(filtered)).toHaveLength(1));
  await act(async () => {
    fetchStub.answer(filtered, []);
    await flush();
  });
  await waitFor(() => expect(text('actions-status')).toMatch(/no devolvió acciones preventivas/i));

  const reset = document.getElementById('actions-clear-filters') as HTMLButtonElement;
  expect(reset).not.toBeNull();
  expect(reset).toHaveTextContent('Limpiar filtros');

  await userEvent.click(reset);
  expect((document.getElementById('actions-community-filter') as HTMLInputElement).value).toBe('');
  expect((document.getElementById('actions-status-filter') as HTMLSelectElement).value).toBe('');
  await waitFor(() => expect(fetchStub.callsFor(ACTIONS_URL).length).toBeGreaterThanOrEqual(2));
  await answerList([]);
  // Without an applied filter the block has nothing to clear and disappears.
  expect(document.getElementById('actions-clear-filters')).toBeNull();
});

test('an unavailable directory keeps the unassigned option, offers a retry and invents nobody', async () => {
  await connect(ADMIN_TOKEN);
  render(<ActionsView />);
  await waitFor(() => expect(fetchStub.callsFor(USERS_URL)).toHaveLength(1));
  await answerList([]);
  await answerUsers({ code: 'directory_unavailable' }, 503, 'req-dir-503');

  // The selector keeps exactly one meaning — unassigned — and the refusal is
  // rendered with the status, the code and the request id the server sent. It is
  // disabled while there is no directory to choose from, as the artboard shows.
  expect(optionValues()).toEqual(['']);
  expect(assigneeSelect().disabled).toBe(true);
  const status = text('create-assignee-status');
  expect(status).toMatch(/503/);
  expect(status).toMatch(/directory_unavailable/);
  expect(status).toMatch(/req-dir-503/);
  expect(status).toMatch(/sin responsable/i);
  expect(status).toMatch(/reintentar/i);
  expect(status).not.toMatch(/Admin del Directorio/);

  // Creating without a responsible is still possible while the directory is down.
  await userEvent.type(document.getElementById('create-community') as HTMLElement, '05101');
  await userEvent.type(document.getElementById('create-title') as HTMLElement, 'Acción sin directorio');
  await userEvent.click(document.getElementById('create-action') as HTMLButtonElement);
  await waitFor(() => {
    expect(fetchStub.calls.some(call => call.url === ACTIONS_URL && call.init.method === 'POST')).toBe(true);
  });
  const post = fetchStub.calls.find(call => call.url === ACTIONS_URL && call.init.method === 'POST')!;
  expect(JSON.parse(String(post.init.body))).toEqual({ community_code: '05101', title: 'Acción sin directorio' });
  await act(async () => {
    fetchStub.answer(ACTIONS_URL, actionFixture({ id: 'action-10', title: 'Acción sin directorio', assignee: null, assignee_id: null }), 201);
    await flush();
  });
  await waitFor(() => expect(fetchStub.callsFor(ACTIONS_URL).length).toBeGreaterThanOrEqual(2));
  await answerList([]);

  // The retry reads the real directory again and fills the selector with it.
  await userEvent.click(document.getElementById('retry-directory') as HTMLButtonElement);
  await waitFor(() => expect(fetchStub.callsFor(USERS_URL)).toHaveLength(2));
  await answerUsers(DIRECTORY);
  expect(optionValues()).toEqual(['', USER_ADMIN, USER_REVIEWER]);
  expect(assigneeSelect().disabled).toBe(false);
  expect(document.getElementById('retry-directory')).toBeNull();
  expect(text('create-assignee-status')).toMatch(/2 usuario/i);
});

test('a viewer never reads the directory and cannot choose a responsible', async () => {
  await connect(VIEWER_TOKEN);
  render(<ActionsView />);
  await waitFor(() => expect(fetchStub.callsFor(ACTIONS_URL)).toHaveLength(1));
  await answerList([actionFixture({ assignee: null, assignee_id: USER_REVIEWER })]);

  // The directory is admin-only: an unauthorized session never asks for it.
  expect(fetchStub.callsFor(USERS_URL)).toHaveLength(0);
  expect(assigneeSelect().disabled).toBe(true);
  expect(optionValues()).toEqual(['']);
  expect(text('create-assignee-status')).toMatch(/sesión autorizada/i);
  // The reference stays identifiable without inventing a name for it.
  expect(text('actions-rows')).toContain(USER_REVIEWER);
});

test('a refused assignment is rendered with its code and never as a created action', async () => {
  await connect(ADMIN_TOKEN);
  render(<ActionsView />);
  await waitFor(() => expect(fetchStub.callsFor(USERS_URL)).toHaveLength(1));
  await answerList([]);
  await answerUsers(DIRECTORY);

  await userEvent.type(document.getElementById('create-community') as HTMLElement, '05101');
  await userEvent.type(document.getElementById('create-title') as HTMLElement, 'Acción con referencia vencida');
  await userEvent.selectOptions(assigneeSelect(), USER_REVIEWER);
  await userEvent.click(document.getElementById('create-action') as HTMLButtonElement);
  await waitFor(() => {
    expect(fetchStub.calls.some(call => call.url === ACTIONS_URL && call.init.method === 'POST')).toBe(true);
  });
  await act(async () => {
    fetchStub.answer(ACTIONS_URL, { code: 'assignee_not_found' }, 422, 'req-422-assignee');
    await flush();
  });

  const notice = text('actions-notice');
  expect(notice).toMatch(/422/);
  expect(notice).toMatch(/assignee_not_found/);
  expect(notice).toMatch(/req-422-assignee/);
  expect(notice).toMatch(/no se creó ninguna acción/i);
  expect(notice).not.toMatch(/creada/i);
  // The operator's input survives the refusal, so the form is not a false success.
  expect((document.getElementById('create-title') as HTMLInputElement).value).toBe('Acción con referencia vencida');
  expect(assigneeSelect().value).toBe(USER_REVIEWER);
  expect(fetchStub.callsFor(`${ACTIONS_URL}/action-new`)).toHaveLength(0);
});

// ── Uncertainty is not a refusal ──────────────────────────────────────────
//
// A failed POST that the contract does not prove was refused may have been
// stored. Claiming "no se creó" there is false, and re-submitting the same form
// blindly could duplicate the action. The two outcomes are rendered differently
// and the page says which one it is.

async function submitCreateForUncertainty(title: string): Promise<void> {
  await userEvent.type(document.getElementById('create-community') as HTMLElement, '05101');
  await userEvent.type(document.getElementById('create-title') as HTMLElement, title);
  await userEvent.click(document.getElementById('create-action') as HTMLButtonElement);
  await waitFor(() => {
    expect(fetchStub.calls.some(call => call.url === ACTIONS_URL && call.init.method === 'POST')).toBe(true);
  });
}

test('a gateway 502 is stated as undetermined, without claiming the action was not created', async () => {
  await connect(ADMIN_TOKEN);
  render(<ActionsView />);
  await waitFor(() => expect(fetchStub.callsFor(USERS_URL)).toHaveLength(1));
  await answerList([]);
  await answerUsers(DIRECTORY);

  await submitCreateForUncertainty('Acción en duda');
  await act(async () => {
    fetchStub.answer(ACTIONS_URL, { code: 'upstream_unavailable' }, 502, 'req-502-gateway');
    await flush();
  });

  const notice = text('actions-notice');
  expect(notice).toMatch(/502/);
  expect(notice).toMatch(/upstream_unavailable/);
  expect(notice).toMatch(/req-502-gateway/);
  // The one thing this page cannot say.
  expect(notice).toMatch(/no se pudo confirmar/i);
  expect(notice).not.toMatch(/no se creó/i);
  expect(notice).not.toMatch(/creada/i);
  // And it must not invite a blind retry.
  expect(notice).toMatch(/duplicar/i);
  expect(notice).toMatch(/Actualizar lista/i);
  // The input is kept: the write may still have happened.
  expect((document.getElementById('create-title') as HTMLInputElement).value).toBe('Acción en duda');
});

test('an unusable 201 is undetermined: the write may have been stored', async () => {
  await connect(ADMIN_TOKEN);
  render(<ActionsView />);
  await waitFor(() => expect(fetchStub.callsFor(USERS_URL)).toHaveLength(1));
  await answerList([]);
  await answerUsers(DIRECTORY);

  await submitCreateForUncertainty('Acción sin respuesta legible');
  await act(async () => {
    fetchStub.answerMalformedJson(ACTIONS_URL, 201, 'req-201-unreadable');
    await flush();
  });

  const notice = text('actions-notice');
  expect(notice).toMatch(/no se pudo confirmar/i);
  expect(notice).not.toMatch(/no se creó/i);
  expect(notice).toMatch(/duplicar/i);
});

test('a 503 storage_unavailable is a proven refusal and says so', async () => {
  await connect(ADMIN_TOKEN);
  render(<ActionsView />);
  await waitFor(() => expect(fetchStub.callsFor(USERS_URL)).toHaveLength(1));
  await answerList([]);
  await answerUsers(DIRECTORY);

  await submitCreateForUncertainty('Acción sin almacenamiento');
  await act(async () => {
    fetchStub.answer(ACTIONS_URL, { code: 'storage_unavailable' }, 503, 'req-503-storage');
    await flush();
  });

  const notice = text('actions-notice');
  expect(notice).toMatch(/503/);
  expect(notice).toMatch(/storage_unavailable/);
  expect(notice).toMatch(/req-503-storage/);
  expect(notice).toMatch(/no se creó ninguna acción/i);
  expect(notice).not.toMatch(/no se pudo confirmar/i);
});

// ── The directory belongs to one session INSTANCE ─────────────────────────
//
// Two exchanges can adopt a different bearer while declaring the SAME roles: the
// public session state is then identical, so a consumer keyed on it keeps the
// previous session's directory and lets its in-flight answer land. Here the second
// exchange settles while the first session's directory read is still in flight.
// The answer to that first read belongs to a session that no longer exists.
test('a same-role replacement re-reads under the new bearer and drops the old answer', async () => {
  storageStub.storage.setItem(pkceTransactionKey, JSON.stringify({ state: 's', verifier: 'verifier' }));
  const first = completeLogin('?code=code-1&state=s');
  await flush();
  storageStub.storage.setItem(pkceTransactionKey, JSON.stringify({ state: 's', verifier: 'verifier' }));
  const second = completeLogin('?code=code-2&state=s');
  await flush();
  expect(fetchStub.callsFor(TOKEN_URL)).toHaveLength(2);

  render(<ActionsView />);
  await act(async () => {
    fetchStub.answer(TOKEN_URL, { access_token: ADMIN_TOKEN, id_token: 'id-token' });
    await first;
    await flush();
  });
  expect(fetchStub.callsFor(USERS_URL)).toHaveLength(1);

  // The second bearer is adopted with the same declared roles, while the first
  // session's directory read is still pending.
  await act(async () => {
    fetchStub.answer(TOKEN_URL, { access_token: SECOND_ADMIN_TOKEN, id_token: 'id-token' });
    await second;
    await flush();
  });

  // A read under the new bearer, not a retained list from the old one.
  await waitFor(() => expect(fetchStub.callsFor(USERS_URL)).toHaveLength(2));
  expect(
    (fetchStub.callsFor(USERS_URL)[1].init.headers as Record<string, string>).Authorization,
  ).toBe(`Bearer ${SECOND_ADMIN_TOKEN}`);

  // The first read's answer belongs to the previous instance: it renders nothing,
  // and it is not a failure either (a failure would offer a retry and clear the
  // operator's work).
  await act(async () => {
    fetchStub.answer(USERS_URL, DIRECTORY);
    await flush();
  });
  expect(optionValues()).toEqual(['']);
  expect(document.getElementById('retry-directory')).toBeNull();
  expect(text('create-assignee-status')).not.toMatch(/superseded/i);

  // The new session's own answer is the one that fills the selector.
  await act(async () => {
    fetchStub.answer(USERS_URL, [{ id: USER_ADMIN, display_name: 'Solo el Segundo Directorio' }]);
    await flush();
  });
  expect(optionValues()).toEqual(['', USER_ADMIN]);
  expect([...(document.getElementById('create-assignee') as HTMLSelectElement).options].map(o => o.textContent)).toEqual([
    'Sin asignar (se crea sin responsable)',
    'Solo el Segundo Directorio',
  ]);
  expect(text('actions')).not.toContain('Revisor del Directorio');
});

// ── The write boundary belongs to one instance too ────────────────────────
//
// A create POST started under one bearer belongs to that bearer. Its completion
// may not be applied to another instance: no notice, no form reset, no selection
// and no detail read. `busy` is released by the instance reset, not by the old
// answer, and a submit that would carry a reference the current instance never
// read does not start at all.

test('a create completion from a previous instance renders nothing', async () => {
  const { first, second } = await startConcurrentAdoptions();
  render(<ActionsView />);
  await land(ADMIN_TOKEN, first);
  await waitFor(() => expect(fetchStub.callsFor(ACTIONS_URL)).toHaveLength(1));
  await waitFor(() => expect(fetchStub.callsFor(USERS_URL)).toHaveLength(1));
  await answerList([]);
  await answerUsers(DIRECTORY);

  await userEvent.type(document.getElementById('create-community') as HTMLElement, '05101');
  await userEvent.type(document.getElementById('create-title') as HTMLElement, 'Acción de la sesión anterior');
  await userEvent.selectOptions(assigneeSelect(), USER_REVIEWER);
  await userEvent.click(document.getElementById('create-action') as HTMLButtonElement);
  await waitFor(() => expect(postCalls()).toHaveLength(1));

  // The bearer is replaced (same declared roles) while the write is in flight.
  await land(SECOND_ADMIN_TOKEN, second);

  // The previous instance's write completes.
  await act(async () => {
    fetchStub.answer(
      ACTIONS_URL,
      actionFixture({ id: 'action-old', status: 'propuesta', assignee: null, assignee_id: USER_REVIEWER }),
      201,
    );
    await flush();
  });

  // Nothing of that write is claimed by the instance that did not make it: not a
  // success and not a failure notice either — the answer is this page's, not the
  // previous instance's.
  expect(text('actions-notice')).toBe('');
  expect((document.getElementById('create-title') as HTMLInputElement).value).toBe('Acción de la sesión anterior');
  expect(fetchStub.callsFor(`${ACTIONS_URL}/action-old`)).toHaveLength(0);
  // The instance reset released the busy state; the old answer had no part in it.
  expect((document.getElementById('create-action') as HTMLButtonElement).disabled).toBe(false);
});

test('a submit that starts after the instance moved sends nothing at all', async () => {
  const { first, second } = await startConcurrentAdoptions();
  render(<ActionsView />);
  await land(ADMIN_TOKEN, first);
  await waitFor(() => expect(fetchStub.callsFor(ACTIONS_URL)).toHaveLength(1));
  await waitFor(() => expect(fetchStub.callsFor(USERS_URL)).toHaveLength(1));
  await answerList([]);
  await answerUsers(DIRECTORY);
  await userEvent.type(document.getElementById('create-community') as HTMLElement, '05101');
  await userEvent.type(document.getElementById('create-title') as HTMLElement, 'Acción con referencia');
  await userEvent.selectOptions(assigneeSelect(), USER_REVIEWER);

  const button = document.getElementById('create-action') as HTMLButtonElement;
  // The click lands in the window between the bearer adoption and React committing
  // the instance reset, so the handler's closure still holds the reference the
  // previous instance read. The reference may not travel: this instance never
  // served it.
  let clicked = false;
  const stop = subscribeSessionGeneration(() => {
    if (clicked) return;
    clicked = true;
    button.click();
  });
  await land(SECOND_ADMIN_TOKEN, second);
  stop();

  expect(clicked).toBe(true);
  expect(postCalls()).toHaveLength(0);
});

// ── A directory refusal belongs to the instance that issued it ────────────
//
// The refusal that closed the instance is not this panel's result to publish: the
// ownership check runs before any view effect, so a 401 from a request whose
// session is gone leaves the page as the closed session left it.
test('a directory 401 is not published as the notice of a session that did not issue it', async () => {
  await connect(ADMIN_TOKEN);
  render(<ActionsView />);
  await waitFor(() => expect(fetchStub.callsFor(USERS_URL)).toHaveLength(1));
  await answerList([]);

  await act(async () => {
    fetchStub.answer(USERS_URL, { code: 'unauthorized' }, 401, 'req-dir-401');
    await flush();
  });

  // The transport closed the session, which is the only visible consequence.
  expect(getSessionSnapshot().status).toBe('signed-out');
  expect(text('actions-badge')).toBe('SIN CONSULTAR');
  expect(text('actions-notice')).toBe('');
});

// ── The shared write interlock survives a session replacement ─────────────
//
// The panel interlocks every mutation: while a transition, evidence write, review
// or reassessment is in flight, no second write may start. A session replacement
// releases only the CREATE the previous instance owned, because that completion is
// fenced. Releasing the shared interlock instead would let two writes to the same
// action overlap, which is exactly the state the interlock exists to prevent.
test('a same-role replacement does not release the interlock of a pending sibling write', async () => {
  const { first, second } = await startConcurrentAdoptions();
  render(<ActionsView />);
  await land(ADMIN_TOKEN, first);
  await waitFor(() => expect(fetchStub.callsFor(ACTIONS_URL)).toHaveLength(1));
  await answerList([actionFixture()]);
  await userEvent.click(document.querySelector('[data-action-id="action-1"]') as HTMLElement);
  await waitFor(() => expect(fetchStub.callsFor(`${ACTIONS_URL}/action-1`)).toHaveLength(1));
  await answerDetail(detailFixture({ status: 'propuesta' }));

  // A transition is in flight, so the interlock is on for every mutation control.
  const toAsignada = document.querySelector('[data-transition-to="asignada"]') as HTMLButtonElement;
  await userEvent.click(toAsignada);
  await waitFor(() => expect(fetchStub.callsFor(`${ACTIONS_URL}/action-1/transitions`)).toHaveLength(1));
  const createButton = document.getElementById('create-action') as HTMLButtonElement;
  expect(toAsignada.disabled).toBe(true);
  expect(createButton.disabled).toBe(true);

  // The bearer is replaced (same declared roles) while that write is still pending.
  await land(SECOND_ADMIN_TOKEN, second);

  // The interlock belongs to the pending write, not to the instance: only the
  // instance's own create may be released here, so both controls stay disabled.
  expect(toAsignada.disabled).toBe(true);
  expect(createButton.disabled).toBe(true);

  // Completing the transition is what releases it — the existing behavior for the
  // writes this correction must not touch.
  await act(async () => {
    fetchStub.answer(`${ACTIONS_URL}/action-1/transitions`, actionFixture({ status: 'asignada' }));
    await flush();
  });
  expect(createButton.disabled).toBe(false);
});

test('an admin sees enabled transitions and applying one posts {to, note}', async () => {
  await connect(ADMIN_TOKEN);
  render(<ActionsView />);
  await waitFor(() => expect(fetchStub.callsFor(ACTIONS_URL)).toHaveLength(1));
  await answerList([actionFixture()]);
  await userEvent.click(document.querySelector('[data-action-id="action-1"]') as HTMLElement);
  await waitFor(() => expect(fetchStub.callsFor(`${ACTIONS_URL}/action-1`)).toHaveLength(1));
  await answerDetail(detailFixture({ status: 'propuesta' }));

  const toAsignada = document.querySelector('[data-transition-to="asignada"]') as HTMLButtonElement;
  expect(toAsignada.disabled).toBe(false);
  // Only the valid successors of `propuesta` are offered.
  expect([...document.querySelectorAll('[data-transition-to]')].map(node => node.getAttribute('data-transition-to'))).toEqual([
    'asignada',
    'cancelada',
  ]);

  await userEvent.type(document.getElementById('transition-note') as HTMLElement, 'asignada al equipo');
  await userEvent.click(toAsignada);

  await waitFor(() => {
    expect(fetchStub.callsFor(`${ACTIONS_URL}/action-1/transitions`)).toHaveLength(1);
  });
  const post = fetchStub.callsFor(`${ACTIONS_URL}/action-1/transitions`)[0];
  expect(JSON.parse(String(post.init.body))).toEqual({ to: 'asignada', note: 'asignada al equipo' });

  await act(async () => {
    fetchStub.answer(`${ACTIONS_URL}/action-1/transitions`, actionFixture({ status: 'asignada' }));
    await flush();
  });
  // The history is authored by the server, so the detail is re-read after a
  // transition instead of being patched locally.
  await waitFor(() => expect(fetchStub.callsFor(`${ACTIONS_URL}/action-1`).length).toBeGreaterThanOrEqual(2));
  await answerDetail(detailFixture({ status: 'asignada' }));
  expect(text('actions-notice')).toMatch(/transición aplicada/i);
});

test('a viewer gets the same view with the transitions disabled and the reason stated', async () => {
  await connect(VIEWER_TOKEN);
  render(<ActionsView />);
  await waitFor(() => expect(fetchStub.callsFor(ACTIONS_URL)).toHaveLength(1));
  await answerList([actionFixture()]);
  await userEvent.click(document.querySelector('[data-action-id="action-1"]') as HTMLElement);
  await waitFor(() => expect(fetchStub.callsFor(`${ACTIONS_URL}/action-1`)).toHaveLength(1));
  await answerDetail(detailFixture());

  // The view exists and the detail is readable: the declared role gates only the
  // affordance, never the read.
  expect(text('action-detail-title')).toContain('Despeje de vegetación');
  for (const button of document.querySelectorAll('[data-transition-to]')) {
    expect((button as HTMLButtonElement).disabled).toBe(true);
  }
  expect((document.getElementById('create-action') as HTMLButtonElement).disabled).toBe(true);
  const note = text('actions-role-note');
  expect(note).toMatch(/admin/i);
  expect(note).toMatch(/servidor/i);
});

test('a 409 invalid transition is rendered with its code and request id, and does not change the status', async () => {
  await connect(ADMIN_TOKEN);
  render(<ActionsView />);
  await waitFor(() => expect(fetchStub.callsFor(ACTIONS_URL)).toHaveLength(1));
  await answerList([actionFixture()]);
  await userEvent.click(document.querySelector('[data-action-id="action-1"]') as HTMLElement);
  await waitFor(() => expect(fetchStub.callsFor(`${ACTIONS_URL}/action-1`)).toHaveLength(1));
  await answerDetail(detailFixture({ status: 'en_curso' }));

  await userEvent.click(document.querySelector('[data-transition-to="enviada"]') as HTMLButtonElement);
  await waitFor(() => expect(fetchStub.callsFor(`${ACTIONS_URL}/action-1/transitions`)).toHaveLength(1));
  await act(async () => {
    fetchStub.answer(`${ACTIONS_URL}/action-1/transitions`, { code: 'invalid_transition' }, 409, 'req-409');
    await flush();
  });

  expect(text('actions-notice')).toMatch(/409/);
  expect(text('actions-notice')).toMatch(/invalid_transition/);
  expect(text('actions-notice')).toMatch(/req-409/);
  expect(text('actions-notice')).toMatch(/no cambió/i);
});

test('an unknown target state surfaces the frozen 422 invalid_transition_request code', async () => {
  await connect(ADMIN_TOKEN);
  render(<ActionsView />);
  await waitFor(() => expect(fetchStub.callsFor(ACTIONS_URL)).toHaveLength(1));
  await answerList([actionFixture()]);
  await userEvent.click(document.querySelector('[data-action-id="action-1"]') as HTMLElement);
  await waitFor(() => expect(fetchStub.callsFor(`${ACTIONS_URL}/action-1`)).toHaveLength(1));
  await answerDetail(detailFixture({ status: 'propuesta' }));

  await userEvent.click(document.querySelector('[data-transition-to="asignada"]') as HTMLButtonElement);
  await waitFor(() => expect(fetchStub.callsFor(`${ACTIONS_URL}/action-1/transitions`)).toHaveLength(1));
  await act(async () => {
    fetchStub.answer(`${ACTIONS_URL}/action-1/transitions`, { code: 'invalid_transition_request' }, 422, 'req-422');
    await flush();
  });

  expect(text('actions-notice')).toMatch(/422/);
  expect(text('actions-notice')).toMatch(/invalid_transition_request/);
  expect(text('actions-notice')).toMatch(/req-422/);
  expect(text('actions-notice')).toMatch(/no cambió/i);
});

test('a newly created action is shown with an empty history, because creation is not a transition', async () => {
  await connect(ADMIN_TOKEN);
  render(<ActionsView />);
  await waitFor(() => expect(fetchStub.callsFor(ACTIONS_URL)).toHaveLength(1));
  await answerList([]);

  await userEvent.type(document.getElementById('create-community') as HTMLElement, '05101');
  await userEvent.type(document.getElementById('create-title') as HTMLElement, 'Acción nueva');
  await userEvent.click(document.getElementById('create-action') as HTMLButtonElement);
  await waitFor(() => expect(fetchStub.calls.some(call => call.url === ACTIONS_URL && call.init.method === 'POST')).toBe(true));
  await act(async () => {
    fetchStub.answer(ACTIONS_URL, actionFixture({ id: 'action-new', title: 'Acción nueva' }), 201);
    await flush();
  });

  // The create flow opens the created action; its detail carries no history row.
  await waitFor(() => expect(fetchStub.callsFor(`${ACTIONS_URL}/action-new`)).toHaveLength(1));
  await act(async () => {
    fetchStub.answer(`${ACTIONS_URL}/action-new`, {
      ...actionFixture({ id: 'action-new' }),
      history: [],
      evidence: [],
      evidence_reviews: [],
      reassessments: [],
      evidence_sufficient: false,
    });
    await flush();
  });
  expect(document.getElementById('action-history-rows')?.querySelectorAll('tr')).toHaveLength(0);
  expect(text('action-detail-status')).toMatch(/0 movimiento/i);
});

test('a 403 on the list is stated as a permission denial with its request id', async () => {
  await connect(VIEWER_TOKEN);
  render(<ActionsView />);
  await waitFor(() => expect(fetchStub.callsFor(ACTIONS_URL)).toHaveLength(1));
  await answerList({ code: 'forbidden' }, 403, 'req-403');

  expect(text('actions-badge')).toBe('SIN PERMISO');
  expect(text('actions-status')).toMatch(/403/);
  expect(text('actions-status')).toMatch(/req-403/);
  expect(text('create-action')).not.toBe('');
});

test('a 401 is rendered with its request id and closes the session', async () => {
  await connect(ADMIN_TOKEN);
  render(<ActionsView />);
  await waitFor(() => expect(fetchStub.callsFor(ACTIONS_URL)).toHaveLength(1));
  await answerList({ code: 'unauthorized' }, 401, 'req-401');

  expect(getSessionSnapshot()).toEqual({ status: 'signed-out', roles: null, reason: 'rejected' });
  expect(text('actions-notice') || text('actions-status')).toMatch(/req-401/);
});

test('a malformed list fails closed instead of showing partial rows', async () => {
  await connect(ADMIN_TOKEN);
  render(<ActionsView />);
  await waitFor(() => expect(fetchStub.callsFor(ACTIONS_URL)).toHaveLength(1));
  await answerList([{ id: 'action-1', title: 'sin comunidad' }]);

  expect(text('actions-badge')).toBe('NO DISPONIBLE');
  expect(document.getElementById('actions-rows')?.querySelectorAll('tr')).toHaveLength(0);
});

// S3 — the row whose detail is open must be visibly marked, and the rule that
// marks it must sit after the plain hover tint: both carry the same specificity,
// so only a later rule keeps the mark while the pointer is over the row. The
// mark is visual only — the table gains no ARIA state its role does not support.
test('the selected actions row carries is-selected and the stylesheet marks it', async () => {
  await connect(ADMIN_TOKEN);
  render(<ActionsView />);
  await waitFor(() => expect(fetchStub.callsFor(ACTIONS_URL)).toHaveLength(1));
  await answerList([actionFixture(), actionFixture({ id: 'action-2', title: 'Charla vecinal' })]);

  expect(document.querySelectorAll('#actions-rows tr.is-selected')).toHaveLength(0);

  await userEvent.click(document.querySelector('[data-action-id="action-1"]') as HTMLElement);
  await waitFor(() => expect(fetchStub.callsFor(`${ACTIONS_URL}/action-1`)).toHaveLength(1));
  await answerDetail(detailFixture());

  const selected = document.querySelectorAll('#actions-rows tr.is-selected');
  // Exactly one row is marked, and it is the one whose detail is open.
  expect(selected).toHaveLength(1);
  expect(selected[0]).toHaveTextContent('Despeje de vegetación');
  // A visual mark only: the row keeps its table semantics.
  expect(selected[0]).not.toHaveAttribute('aria-selected');

  // The rule that paints the mark, and its place in the sheet.
  const hoverAt = appCss.indexOf('tbody tr:hover');
  const selectedAt = appCss.indexOf('tbody tr.is-selected');
  expect(hoverAt).toBeGreaterThan(-1);
  expect(selectedAt).toBeGreaterThan(hoverAt);
  const rule = appCss.slice(selectedAt, appCss.indexOf('}', selectedAt));
  expect(rule).toMatch(/background:\s*var\(--soft\)/);
  // The accent itself is painted on the first cell: `border-collapse: collapse`
  // drops a box-shadow declared on the row.
  expect(appCss).toMatch(
    /tbody tr\.is-selected td:first-child\s*\{[^}]*box-shadow:\s*inset 3px 0 0 var\(--forest-700\)/,
  );
});

test('logout clears the list, the detail, the form and the notice', async () => {
  await connect(ADMIN_TOKEN);
  render(<ActionsView />);
  await waitFor(() => expect(fetchStub.callsFor(ACTIONS_URL)).toHaveLength(1));
  await answerList([actionFixture()]);
  await userEvent.click(document.querySelector('[data-action-id="action-1"]') as HTMLElement);
  await waitFor(() => expect(fetchStub.callsFor(`${ACTIONS_URL}/action-1`)).toHaveLength(1));
  await answerDetail(detailFixture());
  await userEvent.type(document.getElementById('create-title') as HTMLElement, 'Borrador');

  act(() => {
    resetSession();
  });

  await waitFor(() => expect(text('actions-badge')).toBe('SIN CONSULTAR'));
  expect(document.getElementById('actions-rows')?.querySelectorAll('tr')).toHaveLength(0);
  expect(document.getElementById('action-detail')).toBeNull();
  expect((document.getElementById('create-title') as HTMLInputElement).value).toBe('');
  expect(text('actions-notice')).toBe('');
  expect(text('actions-status')).toMatch(/conecta un token autorizado/i);
});

// V1-U-04 — the directory is authenticated data read under one session. Nothing
// read from it may survive that session, in either the selector or the labels.
test('a closed session discards the directory list and the chosen responsible', async () => {
  await connect(ADMIN_TOKEN);
  render(<ActionsView />);
  await waitFor(() => expect(fetchStub.callsFor(USERS_URL)).toHaveLength(1));
  await answerUsers(DIRECTORY);
  await answerList([actionFixture({ assignee: null, assignee_id: USER_REVIEWER })]);
  expect(text('actions-rows')).toContain('Revisor del Directorio');
  await userEvent.selectOptions(assigneeSelect(), USER_REVIEWER);
  expect(assigneeSelect().value).toBe(USER_REVIEWER);

  act(() => {
    resetSession();
  });

  await waitFor(() => expect(optionValues()).toEqual(['']));
  expect(assigneeSelect().value).toBe('');
  expect(assigneeSelect().disabled).toBe(true);
  // The names read under the closed session are gone from every label.
  expect(document.getElementById('actions')?.textContent ?? '').not.toContain('Revisor del Directorio');
  expect(text('create-assignee-status')).toMatch(/sesión autorizada/i);
});

