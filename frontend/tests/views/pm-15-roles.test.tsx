import { act, render } from '@testing-library/react';

import { issuer, pkceTransactionKey } from '../../src/config';
import { completeLogin, resetSession } from '../../src/core/session';
import { ActionsView } from '../../src/views/ActionsView';
import { JobsView } from '../../src/views/JobsView';
import { ObservationsView } from '../../src/views/ObservationsView';
import { SessionView } from '../../src/views/SessionView';

import { createCryptoStub, createFetchStub, createStorageStub, flush, jwt } from '../core/harness';

// PM-15 (D-C) — the ratified role matrix on the client.
//
// The new role is `analista`: «Operación táctica: evalúa y gestiona acciones, sin
// admin». These tests pin the two halves of that sentence where the page actually
// behaves by them:
//
//   - the TACTICAL controls (create an action, register an observation, request a
//     batch) are offered to an analista and withheld from a viewer;
//   - the FINAL controls (the evidence decision and the cancellation) stay
//     administrative, which the pure affordance test in
//     `tests/domain/prevention.test.ts` pins target by target.
//
// A control being disabled is an affordance, never an authorization: the server is
// still the only authority and every one of these pages renders its 401/403.

const TOKEN_URL = `${issuer}/protocol/openid-connect/token`;

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
}

const ANALYST_TOKEN = jwt({ realm_access: { roles: ['analista'] } });
const VIEWER_TOKEN = jwt({ realm_access: { roles: ['viewer'] } });
const ADMIN_TOKEN = jwt({ realm_access: { roles: ['viewer', 'admin'] } });

beforeEach(() => {
  setup();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('the session view derives the effective role by membership and precedence', async () => {
  const cases: ReadonlyArray<[string, string]> = [
    [jwt({ realm_access: { roles: ['viewer'] } }), 'Visualizador'],
    [ANALYST_TOKEN, 'Analista'],
    // The realm hands its admin account BOTH roles, in an order the page does not
    // own: membership decides, never the first element.
    [ADMIN_TOKEN, 'Administrador'],
    [jwt({ realm_access: { roles: ['viewer', 'analista'] } }), 'Analista'],
    [jwt({ realm_access: { roles: ['analista', 'admin'] } }), 'Administrador'],
    // A role the deployment does not declare is never upgraded into one.
    [jwt({ realm_access: { roles: ['operator'] } }), 'No informado'],
  ];

  for (const [token, expected] of cases) {
    resetSession();
    await connect(token);
    const { unmount } = render(<SessionView />);
    expect(document.getElementById('session-effective-role')?.textContent, expected).toBe(expected);
    unmount();
  }
});

test('the actions page offers an analista the tactical controls and withholds the evidence decision', async () => {
  await connect(ANALYST_TOKEN);
  const { unmount } = render(<ActionsView />);

  const create = document.getElementById('create-action') as HTMLButtonElement | null;
  expect(create).not.toBeNull();
  expect(create?.disabled).toBe(false);

  // The page says which half of the matrix it is operating under, and it says it
  // with the ANALISTA sentence. An analista is tactical but not administrative, so
  // inheriting the viewer text would be false («tu token declara el rol viewer»)
  // and would tell the one role this change exists for that the page is read-only,
  // which it is not.
  const note = document.getElementById('actions-role-note')?.textContent ?? '';
  expect(note).toMatch(/declara el rol analista/i);
  expect(note).toMatch(/alta/i);
  expect(note).toMatch(/transiciones tácticas/i);
  expect(note).toMatch(/devuelta → en_curso/);
  // The final half is stated as admin-only, not silently omitted.
  expect(note).toMatch(/aceptada/);
  expect(note).toMatch(/cancelada/);
  expect(note).toMatch(/rol admin/i);
  // And it never mislabels the token nor the page.
  expect(note).not.toMatch(/declara el rol viewer/i);
  expect(note).not.toMatch(/solo lectura|modo lectura/i);
  expect(note).not.toMatch(/no declara un rol/i);

  // The sufficiency decision is the FINAL half: an analista is not offered it.
  for (const id of ['review-suficiente', 'review-insuficiente']) {
    const control = document.getElementById(id) as HTMLButtonElement | null;
    if (control !== null) expect(control.disabled, id).toBe(true);
  }
  unmount();

  resetSession();
  await connect(VIEWER_TOKEN);
  render(<ActionsView />);
  const viewerCreate = document.getElementById('create-action') as HTMLButtonElement | null;
  expect(viewerCreate).not.toBeNull();
  expect(viewerCreate?.disabled).toBe(true);
  // The viewer keeps its own, accurate message.
  const viewerNote = document.getElementById('actions-role-note')?.textContent ?? '';
  expect(viewerNote).toMatch(/declara el rol viewer/i);
  expect(viewerNote).toMatch(/modo lectura/i);
});

test('the observations page lets an analista register and keeps a viewer read-only', async () => {
  await connect(ANALYST_TOKEN);
  const analyst = render(<ObservationsView />);
  // The form fields depend on the role alone, so they discriminate the two roles
  // even when the zone catalogue has not been read (the submit control also waits
  // for that catalogue, which is a separate interlock).
  const analystDescription = document.getElementById('observation-description') as HTMLTextAreaElement | null;
  expect(analystDescription).not.toBeNull();
  expect(analystDescription?.disabled).toBe(false);
  expect(document.getElementById('observation-role-note')?.textContent).toMatch(/analista o admin/i);
  analyst.unmount();

  resetSession();
  await connect(VIEWER_TOKEN);
  render(<ObservationsView />);
  const viewerDescription = document.getElementById('observation-description') as HTMLTextAreaElement | null;
  expect(viewerDescription).not.toBeNull();
  expect(viewerDescription?.disabled).toBe(true);
  const viewerSubmit = document.getElementById('observation-submit') as HTMLButtonElement | null;
  expect(viewerSubmit).not.toBeNull();
  expect(viewerSubmit?.disabled).toBe(true);
  expect(document.getElementById('observation-role-note')?.textContent).toMatch(/viewer/i);
});

test('the jobs page states the tactical requirement to a viewer and does not claim it granted it', async () => {
  await connect(VIEWER_TOKEN);
  render(<JobsView />);

  // The create control is interlocked for a viewer, and the page says why instead
  // of leaving the operator to discover it from a 403.
  const create = document.getElementById('create-job') as HTMLButtonElement | null;
  expect(create).not.toBeNull();
  expect(create?.disabled).toBe(true);
  const text = document.body.textContent ?? '';
  expect(text).toMatch(/requiere el rol analista o admin/);
  expect(text).toMatch(/rol viewer/);
});

test('an analista token is a token fact the pages read without verifying the signature', async () => {
  await connect(ANALYST_TOKEN);
  render(<ObservationsView />);
  // The role only decides affordances; no page claims it granted a permission.
  const note = document.getElementById('observation-role-note')?.textContent ?? '';
  expect(note).toMatch(/no se verifica aquí/i);
  expect(note).toMatch(/servidor/i);
  act(() => {
    resetSession();
  });
});
