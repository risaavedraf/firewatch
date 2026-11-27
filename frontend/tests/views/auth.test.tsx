import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

// ── T7 — the board 14 hierarchy, stated truthfully ─────────────────────────
// Board 14 opens the entrance with an eyebrow, a title, a lede and a row of
// state chips, then names the real contract and the states a person can meet in
// a side column. The production screen is a full-page gate instead of a view
// inside the shell, so the same hierarchy is stated in the hero and under the
// card. What the chips may say is the session this screen actually observes:
// nothing here simulates a sign-in or a permission.
test('the entrance states its real state and the contract it cannot change (T7)', () => {
  render(<AuthView />);

  const state = document.getElementById('auth-state');
  expect(state).not.toBeNull();
  expect(state).toHaveAttribute('role', 'group');
  expect(state).toHaveTextContent('Sin sesión');
  expect(state).toHaveTextContent('Entrada sin credenciales');

  // The facts are the shipped contract, not a promise: the identity provider, the
  // in-memory token and the realm-owned roles.
  const facts = document.getElementById('auth-facts');
  expect(facts).not.toBeNull();
  expect(facts).toHaveTextContent('Keycloak · Authorization Code + PKCE');
  expect(facts).toHaveTextContent(/se escriben solo en Keycloak/i);
  expect(facts).toHaveTextContent(/no se persiste ni viaja en cookie/i);
  expect(facts).toHaveTextContent(/el servidor los verifica en cada petición/i);
  expect(facts).toHaveTextContent(/no una frontera de autorización/i);

  // The states list names the outcomes the screen really renders, including the
  // credential error it can never show.
  const states = document.getElementById('auth-states');
  expect(states).not.toBeNull();
  expect(states).toHaveTextContent('Sin sesión');
  expect(states).toHaveTextContent(/Regresando de Keycloak/);
  expect(states).toHaveTextContent(/Sesión rechazada/);
  expect(states).toHaveTextContent(/Cancelado/);
  expect(states).toHaveTextContent(/no se muestra: la página nunca recibe la credencial/i);

  // Presentation only: the screen still renders no credential field and no extra
  // control beyond the two tabs, the two round trips and the inline switches.
  expect(document.querySelectorAll('input, textarea, select, form')).toHaveLength(0);
});

test('the state chip follows the real session transition instead of a fixed label (T7)', async () => {
  render(<AuthView />);
  window.sessionStorage.setItem(pkceTransactionKey, JSON.stringify({ state: 's', verifier: 'verifier' }));

  let callback!: Promise<void>;
  act(() => {
    callback = completeLogin('?code=c&state=s');
  });
  expect(document.getElementById('auth-state')).toHaveTextContent('Regresando de Keycloak');

  await flush();
  fetchStub.answer(TOKEN_URL, { error: 'invalid_grant' }, 400);
  await act(async () => {
    await expect(callback).rejects.toThrow();
  });
  expect(document.getElementById('auth-state')).toHaveTextContent('Acceso no completado');
});

// ── T11 — one viewport, one card, the aerial night palette (S5/S8) ─────────
//
// S5 — «es el inicio pero se vé cortado porque es muy grande por lo que hay que
// hacer scroll y eso mejor que no, algo más sencillo». The entrance stacked the
// card with two long reference panels, so the whole first screen of the product
// asked for a scroll to reach one button. S8 — «tiene que ser los nuevos colores
// globales» — is the migration `tokens.css` now carries for every sheet.
//
// jsdom has no layout engine and applies no cascade, so nothing here claims to
// have measured the window: what is pinned is the shipped sheet the browser
// receives, the compact DOM, and the arithmetic a browser would otherwise be
// trusted for. The geometry itself is verified in a browser, not in this file.
const authCss = readFileSync(resolve(process.cwd(), 'src', 'styles', 'auth.css'), 'utf8');
const tokenCss = readFileSync(resolve(process.cwd(), 'src', 'styles', 'tokens.css'), 'utf8');

// Prose is not a rule: a comment may name the literal or the token this suite
// retires, so comments and the paper palette are removed first.
function screenCss(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media\s+print[\s\S]*?\n\}/g, '');
}

const screenTokens = screenCss(tokenCss);
const palette = new Map<string, string>();
for (const match of screenTokens.matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/g)) palette.set(match[1], match[2]);

function tokenHex(name: string): string {
  const value = palette.get(name);
  if (value === undefined) throw new Error(`tokens.css declares no --${name} as an explicit hex value`);
  return value;
}

// The body of one rule, read at its own boundaries: anchored at the start of a
// line, the selector compared whole, and the value ending at the brace that
// closes the rule.
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = screenCss(css).match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`));
  if (match === null) throw new Error(`auth.css declares no ${selector} rule`);
  return match[1];
}

function declared(css: string, selector: string, property: string): string | null {
  for (const part of ruleBody(css, selector).split(';')) {
    const colon = part.indexOf(':');
    if (colon !== -1 && part.slice(0, colon).trim() === property) return part.slice(colon + 1).trim();
  }
  return null;
}

function required(css: string, selector: string, property: string): string {
  const value = declared(css, selector, property);
  if (value === null) throw new Error(`${selector} declares no ${property}`);
  return value;
}

// The brace-balanced body of an at-rule block. The desktop fit lives inside the
// breakpoint, so reading the base rule alone would miss it.
function mediaBlock(css: string, query: string): string {
  const screen = screenCss(css);
  const start = screen.indexOf(`@media ${query}`);
  if (start === -1) throw new Error(`auth.css declares no @media ${query}`);
  const open = screen.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < screen.length; index += 1) {
    if (screen[index] === '{') depth += 1;
    if (screen[index] === '}') {
      depth -= 1;
      if (depth === 0) return screen.slice(open + 1, index);
    }
  }
  throw new Error(`@media ${query} is not a closed block`);
}

// A declared colour has to be measurable: a role from the global palette or an
// explicit hex, never an unreadable shorthand this suite would silently skip.
function colorOf(value: string): string {
  const variable = /^var\(\s*--([\w-]+)\s*(?:,\s*([^()]+))?\)$/.exec(value.trim());
  if (variable !== null) {
    const [, name, fallback] = variable;
    if (palette.has(name)) return tokenHex(name);
    if (fallback !== undefined) return colorOf(fallback);
    throw new Error(`--${name} is not an explicit hex in tokens.css`);
  }
  if (/^#[0-9a-fA-F]{6}$/.test(value.trim())) return value.trim();
  throw new Error(`${value} is not a measurable colour`);
}

function channel(value: number): number {
  const ratio = value / 255;
  return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const digits = hex.replace('#', '');
  const [red, green, blue] = [0, 2, 4].map(index => parseInt(digits.slice(index, index + 2), 16));
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

function contrast(foreground: string, background: string): number {
  const [first, second] = [luminance(foreground), luminance(background)];
  const [lighter, darker] = first > second ? [first, second] : [second, first];
  return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100;
}

test('the entrance is one primary card and the reference is a closed disclosure (S5)', () => {
  render(<AuthView />);

  // The old entry stacked two reference panels under the card. They are now one
  // disclosure, closed by default, so the first screen is the card and nothing else.
  expect(document.querySelector('.auth-aside')).toBeNull();

  const disclosure = document.querySelector('details.auth-disclosure');
  expect(disclosure, 'the reference has to be a <details> the reader can open').not.toBeNull();
  expect(disclosure).not.toHaveAttribute('open');
  expect((disclosure as HTMLDetailsElement).open).toBeFalsy();

  const summary = disclosure!.querySelector('summary');
  expect(summary, 'a disclosure without a summary cannot be opened from the keyboard').not.toBeNull();
  expect(summary).toHaveTextContent(/contrato/i);
  expect(summary).toHaveTextContent(/estado/i);

  // Nothing of the reference occupies the first fold, but its words still travel
  // with the screen (T7): closed is a presentation decision, not a deletion.
  for (const id of ['auth-facts', 'auth-states']) {
    const node = document.getElementById(id);
    expect(node, `#${id} must stay in the DOM`).not.toBeNull();
    expect(disclosure!.contains(node!)).toBe(true);
  }

  // The round trips are never behind the disclosure.
  const tablist = screen.getByRole('tablist', { name: 'Acceso a FireWatch' });
  expect(disclosure!.contains(tablist)).toBe(false);
  expect(disclosure!.contains(document.getElementById('login')!)).toBe(false);
  expect(disclosure!.contains(document.getElementById('register')!)).toBe(false);
  expect(disclosure!.contains(document.getElementById('auth-status')!)).toBe(false);
});

test('the hero states the scope in three one-line capabilities, not a paragraph wall (S5)', () => {
  render(<AuthView />);

  const capabilities = [...document.querySelectorAll('.auth-features li')];
  expect(capabilities).toHaveLength(3);

  // A character budget, not a measurement: jsdom cannot tell whether a line wraps,
  // so what is pinned is copy short enough to read as a one-line item at the
  // desktop widths the entrance is designed for.
  for (const item of capabilities) {
    const copy = (item.textContent ?? '').replace(/\s+/g, ' ').trim();
    expect(copy.length, `a one-line capability outgrew its line: ${copy}`).toBeLessThanOrEqual(72);
  }

  // The scope statement is not the hero's: it stays the honest footnote it is.
  expect(document.getElementById('auth-scope')).toHaveTextContent(/no oficial/);
});

test('auth.css is painted with the aerial night roles, with no light-theme literal left (S8)', () => {
  const screen = screenCss(authCss);

  for (const retired of ['#fffefa', '#f5f5ef', '#f6fff9', '#fcfcf2', '#173c3b', '#d7aa73', '#41625b', '#54766e', '#8a3c27', '#c9d1c8', '#f7f8f5', '#1f1f1f', '#fff']) {
    expect(screen.toLowerCase(), `${retired} is a retired cream/forest literal`).not.toContain(retired);
  }

  // The sheet is token-driven end to end: a future rule cannot reintroduce a
  // literal this list has not learned yet.
  expect(screen.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], 'auth.css must read roles, never hex values').toEqual([]);

  // The three surfaces the entrance is painted on are the global roles.
  expect(required(authCss, '.auth-page', 'background')).toBe('var(--canvas)');
  expect(colorOf(required(authCss, '.auth-hero', 'background'))).toBe(tokenHex('aerial-water'));
  expect(required(authCss, '.auth-card', 'background')).toBe('var(--paper)');
  // Atmosphere is drawn with gradients only: the sheet still loads nothing from
  // another origin.
  expect(required(authCss, '.auth-hero', 'background-image')).toMatch(/radial-gradient/);

  // The primary control is the accent fill with the accent ink: `#94dfda` is a
  // light tone, so the light ink on it would be the very regression this fixes.
  expect(required(authCss, '.auth-primary', 'background')).toBe('var(--accent)');
  expect(required(authCss, '.auth-primary', 'color')).toBe('var(--accent-ink)');

  // The selected tab is the same filled-accent decision, not a cream card.
  expect(required(authCss, '.auth-tab.is-selected', 'background')).toBe('var(--accent)');
  expect(required(authCss, '.auth-tab.is-selected', 'color')).toBe('var(--accent-ink)');

  // Every surface the sheet paints is a role: the sheet may not declare a token.
  expect(screen).not.toMatch(/--[\w-]+\s*:/);
});

test('every text pair in the entrance clears WCAG AA on the surface it is painted on (S8)', () => {
  const pairs: Array<{ foreground: string; background: string; minimum: number; what: string }> = [
    { foreground: '.auth-tab.is-selected', background: '.auth-tab.is-selected', minimum: 7, what: 'the selected tab' },
    { foreground: '.auth-primary', background: '.auth-primary', minimum: 7, what: 'the primary control' },
    { foreground: '.auth-tab', background: '.auth-tabs', minimum: 4.5, what: 'an unselected tab' },
    { foreground: '.auth-google', background: '.auth-google', minimum: 4.5, what: 'the Google control' },
    { foreground: '.auth-lead', background: '.auth-card', minimum: 4.5, what: 'the card lede' },
    { foreground: '.auth-switch', background: '.auth-card', minimum: 4.5, what: 'the switch sentence' },
    { foreground: '.auth-link', background: '.auth-card', minimum: 4.5, what: 'the inline switch' },
    { foreground: '.auth-privacy', background: '.auth-card', minimum: 4.5, what: 'the trust note' },
    { foreground: '.auth-status-line', background: '.auth-card', minimum: 4.5, what: 'the status line' },
    { foreground: '.auth-status-line.is-error', background: '.auth-status-line.is-error', minimum: 4.5, what: 'the error banner' },
    { foreground: '.auth-panel-body h2', background: '.auth-card', minimum: 4.5, what: 'the panel title' },
    { foreground: '.auth-steps li', background: '.auth-card', minimum: 4.5, what: 'a registration step' },
    { foreground: '.auth-hero', background: '.auth-hero', minimum: 4.5, what: 'the hero body copy' },
    { foreground: '.auth-kicker', background: '.auth-hero', minimum: 4.5, what: 'the regional eyebrow' },
    { foreground: '.auth-hero h1', background: '.auth-hero', minimum: 4.5, what: 'the headline' },
    { foreground: '.auth-features li', background: '.auth-features li', minimum: 4.5, what: 'a capability item' },
    { foreground: '.auth-scope', background: '.auth-hero', minimum: 4.5, what: 'the scope statement' },
    { foreground: '.auth-chip', background: '.auth-chip', minimum: 4.5, what: 'a state chip' },
    { foreground: '.auth-disclosure-summary', background: '.auth-disclosure', minimum: 4.5, what: 'the disclosure summary' },
    { foreground: '.auth-facts dd', background: '.auth-facts-panel', minimum: 4.5, what: 'a contract value' },
    { foreground: '.auth-facts-note', background: '.auth-facts-panel', minimum: 4.5, what: 'the reference note' },
  ];

  for (const pair of pairs) {
    const foreground = colorOf(required(authCss, pair.foreground, 'color'));
    const background = colorOf(required(authCss, pair.background, 'background'));
    expect(contrast(foreground, background), `${pair.what}: ${foreground} on ${background}`).toBeGreaterThanOrEqual(
      pair.minimum,
    );
  }

  // The selected tab and the primary control carry the promise of this fix twice:
  // the accent ink measures 11.54 on its accent fill, the light ink does not.
  expect(contrast(tokenHex('accent-ink'), tokenHex('accent'))).toBeGreaterThanOrEqual(7);
  expect(contrast(tokenHex('ink'), tokenHex('accent'))).toBeLessThan(4.5);
});

test('the entrance is pinned to one viewport on desktop and the reference scrolls inside itself (S5)', () => {
  const screen = screenCss(authCss);

  // The defect was a window unit used as a floor with unbounded content. The page
  // is a viewport-tall box now, and no rule in the sheet may ask for the legacy
  // unit that ignores the mobile browser bars.
  expect(screen).not.toMatch(/\b100vh\b/);
  expect(required(authCss, '.auth-page', 'min-height')).toBe('100dvh');

  const desktop = mediaBlock(authCss, '(min-width: 960px)');
  expect(required(desktop, '.auth-page', 'height')).toBe('100dvh');
  expect(required(desktop, '.auth-page', 'overflow')).toBe('hidden');
  expect(required(desktop, '.auth-page', 'grid-template-columns')).toBe('minmax(0, 1.02fr) minmax(0, .98fr)');

  // Each column owns the overflow the page no longer takes: a very short window
  // scrolls its own column instead of the document.
  expect(required(desktop, '.auth-main', 'min-height')).toBe('0');
  expect(required(desktop, '.auth-main', 'overflow-y')).toBe('auto');
  expect(required(desktop, '.auth-hero', 'overflow-y')).toBe('auto');

  // Opening the reference cannot push the card out of the window: the reference is
  // the part that scrolls.
  expect(required(desktop, '.auth-disclosure-body', 'max-height')).toMatch(/^min\(\s*\d+dvh\s*,/);
  expect(required(desktop, '.auth-disclosure-body', 'overflow-y')).toBe('auto');

  // Below the breakpoint the flow is the document's: one column, no bound, so a
  // phone scrolls naturally instead of clipping its own card.
  expect(required(authCss, '.auth-page', 'grid-template-columns')).toBe('minmax(0, 1fr)');
  expect(declared(authCss, '.auth-page', 'height')).toBeNull();
  expect(declared(authCss, '.auth-disclosure-body', 'max-height')).toBeNull();
});
