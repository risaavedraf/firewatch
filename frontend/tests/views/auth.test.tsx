import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { App } from '../../src/App';
import { issuer, pkceTransactionKey } from '../../src/config';
import { completeLogin, getSessionSnapshot, resetSession } from '../../src/core/session';
import { AuthView } from '../../src/views/AuthView';

import { createCryptoStub, createFetchStub, createWindowStub, flush, jwt } from '../core/harness';

// The sign-in and sign-up screen. It stands in for the workspace while there is no
// session, and both of its controls hand the browser to Keycloak: the page itself
// never renders a credential field.
const TOKEN_URL = `${issuer}/protocol/openid-connect/token`;

let fetchStub: ReturnType<typeof createFetchStub>;

beforeEach(() => {
  fetchStub = createFetchStub();
  vi.stubGlobal('fetch', fetchStub.fetch);
  vi.stubGlobal('crypto', createCryptoStub());
  window.sessionStorage.clear();
  window.location.hash = '';
  resetSession();
});

afterEach(() => {
  resetSession();
  vi.unstubAllGlobals();
});

async function signIn(): Promise<void> {
  window.sessionStorage.setItem(pkceTransactionKey, JSON.stringify({ state: 's', verifier: 'verifier' }));
  const callback = completeLogin('?code=c&state=s');
  await flush();
  fetchStub.answer(TOKEN_URL, { access_token: jwt({ realm_access: { roles: ['viewer'] } }), id_token: jwt({ sub: 'u' }) });
  await act(async () => {
    await callback;
  });
}

function selectedTab(): string | null {
  return document.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? null;
}

test('without a session the app renders the sign-in screen and no workspace view', () => {
  render(<App />);

  expect(document.querySelector('[data-view="auth"]')).not.toBeNull();
  expect(document.querySelector('.app-shell')).toBeNull();
  expect(document.querySelector('nav')).toBeNull();
  expect(document.title).toBe('Iniciar sesión | FireWatch');
});

test('a session replaces the sign-in screen with the workspace, and its end brings the screen back', async () => {
  render(<App />);
  await signIn();

  expect(document.querySelector('[data-view="auth"]')).toBeNull();
  expect(document.querySelector('.app-shell')).not.toBeNull();
  expect(document.querySelector('[data-view="overview"]')).not.toBeNull();

  // A 401 for the bearer the page held: the screen comes back and names it.
  await act(async () => {
    resetSession('rejected');
  });
  expect(document.querySelector('[data-view="auth"]')).not.toBeNull();
  expect(document.getElementById('auth-status')).toHaveTextContent(/rechazó el token \(401\)/);
});

test('the screen renders no credential field: the password is only ever typed in Keycloak', () => {
  render(<AuthView />);

  expect(document.querySelectorAll('input, textarea, select, form')).toHaveLength(0);
  expect(screen.getByText(/nunca ve tu contraseña/i)).toBeInTheDocument();
  // The scope statement travels with the screen, not only with the workspace.
  expect(document.getElementById('auth-scope')).toHaveTextContent(/entrada sintética, sin calibración/);
  expect(document.getElementById('auth-scope')).toHaveTextContent(/CONAF/);
});

test('the two tabs switch between sign-in and sign-up, by click and by keyboard', async () => {
  const user = userEvent.setup();
  render(<AuthView />);

  expect(selectedTab()).toBe('Iniciar sesión');
  expect(document.getElementById('auth-panel-login')).not.toHaveAttribute('hidden');
  expect(document.getElementById('auth-panel-register')).toHaveAttribute('hidden');

  await user.click(screen.getByRole('tab', { name: 'Crear cuenta' }));
  expect(selectedTab()).toBe('Crear cuenta');
  expect(document.getElementById('auth-panel-register')).not.toHaveAttribute('hidden');
  expect(document.title).toBe('Crear cuenta | FireWatch');

  // Arrow keys move the selection and the focus together (WAI-ARIA tabs).
  await user.keyboard('{ArrowLeft}');
  expect(selectedTab()).toBe('Iniciar sesión');
  expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Iniciar sesión' }));
  await user.keyboard('{End}');
  expect(selectedTab()).toBe('Crear cuenta');

  // The inline switch inside each panel does the same.
  await user.click(screen.getByRole('button', { name: 'Iniciar sesión' }));
  expect(selectedTab()).toBe('Iniciar sesión');
});

test('#registro opens the sign-up tab directly and survives the router', () => {
  window.location.hash = '#registro';
  render(<App />);

  expect(selectedTab()).toBe('Crear cuenta');
  expect(window.location.hash).toBe('#registro');
});

test('each button starts its own Keycloak round trip and the screen states it', async () => {
  const windowStub = createWindowStub();
  render(<AuthView />);
  vi.stubGlobal('window', windowStub.window);

  act(() => {
    (document.getElementById('register') as HTMLButtonElement).click();
  });
  expect(getSessionSnapshot().status).toBe('signing-in');
  expect(document.getElementById('auth-status')).toHaveTextContent('Abriendo el registro seguro de Keycloak…');
  expect(document.getElementById('register')).toBeDisabled();
  expect(document.getElementById('login')).toBeDisabled();

  await vi.waitFor(() => expect(windowStub.assign).toHaveBeenCalledTimes(1));
  const target = new URL(String(windowStub.assign.mock.calls[0][0]));
  expect(`${target.origin}${target.pathname}`).toBe(`${issuer}/protocol/openid-connect/registrations`);
});

test('a return from Keycloak reads as completing, and a refused one says it did not complete', async () => {
  render(<AuthView />);
  window.sessionStorage.setItem(pkceTransactionKey, JSON.stringify({ state: 's', verifier: 'verifier' }));

  let callback!: Promise<void>;
  act(() => {
    callback = completeLogin('?code=c&state=s');
  });
  expect(document.getElementById('auth-status')).toHaveTextContent('Completando el acceso con Keycloak…');
  expect(document.getElementById('login')).toBeDisabled();

  await flush();
  fetchStub.answer(TOKEN_URL, { error: 'invalid_grant' }, 400);
  await act(async () => {
    await expect(callback).rejects.toThrow();
  });

  expect(document.getElementById('auth-status')).toHaveTextContent(/No se completó el acceso/);
  expect(document.getElementById('auth-status')).toHaveClass('is-error');
  expect(document.getElementById('login')).toBeEnabled();
});

// Google is a Keycloak round trip with `kc_idp_hint`: the page still sends the
// browser to the issuer, never to Google, and still receives only a Keycloak code.
test('without the build flag there is no Google option', () => {
  render(<AuthView googleLogin={false} />);

  expect(document.getElementById('google-login')).toBeNull();
  expect(document.getElementById('google-register')).toBeNull();
  expect(screen.queryByText(/Google/)).toBeNull();
});

test('with the flag, both tabs offer Google and it opens Keycloak with the google hint', async () => {
  const user = userEvent.setup();
  const windowStub = createWindowStub();
  render(<AuthView googleLogin />);

  expect(document.getElementById('google-login')).toHaveTextContent('Continuar con Google');
  await user.click(screen.getByRole('tab', { name: 'Crear cuenta' }));
  expect(document.getElementById('google-register')).toHaveTextContent('Registrarse con Google');

  vi.stubGlobal('window', windowStub.window);
  act(() => {
    (document.getElementById('google-register') as HTMLButtonElement).click();
  });
  expect(getSessionSnapshot().status).toBe('signing-in');
  expect(document.getElementById('auth-status')).toHaveTextContent('Abriendo el acceso con Google…');

  await vi.waitFor(() => expect(windowStub.assign).toHaveBeenCalledTimes(1));
  const target = new URL(String(windowStub.assign.mock.calls[0][0]));
  // The authorization endpoint, not the sign-up one: a first Google visit is
  // turned into an account by Keycloak's broker, not by its registration form.
  expect(`${target.origin}${target.pathname}`).toBe(`${issuer}/protocol/openid-connect/auth`);
  expect(target.searchParams.get('kc_idp_hint')).toBe('google');
  expect(target.searchParams.get('code_challenge_method')).toBe('S256');
});
