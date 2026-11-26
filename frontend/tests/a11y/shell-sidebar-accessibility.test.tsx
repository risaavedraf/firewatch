import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { routes } from '../../src/app/routes';
import { Shell } from '../../src/components/Shell';
import { gatewayOrigin, issuer, pkceTransactionKey } from '../../src/config';
import { completeLogin, resetSession } from '../../src/core/session';

import { createCryptoStub, createFetchStub, flush, jwt } from '../core/harness';

// The sidebar accessibility invariants the clipped-control finding touched: the
// keyboard must reach the only sign-out control with the shared visible focus
// ring, and the navigation's link colour must clear WCAG AA on the sidebar
// background. The geometric half — the control inside the sidebar's visible box
// at 1024x768, 1280x720, 1366x768 and 1440x900, without scrolling the column — is
// measured in a browser and recorded under tmp/e2e-sidebar/; jsdom has no layout
// engine, so what is pinned here is the stylesheet the browser receives plus the
// rendered control.
//
// The contrast pair is pinned deliberately. The E2E probe reported the active
// navigation link at 1:1 against the sidebar, comparing the link's own colour
// with itself; the real pair is #c3d6cf on #173c3b, which passes.
const READY_URL = `${gatewayOrigin}/health/ready`;
const TOKEN_URL = `${issuer}/protocol/openid-connect/token`;

const appCss = readFileSync(resolve(process.cwd(), 'src', 'styles', 'app.css'), 'utf8');
const tokensCss = readFileSync(resolve(process.cwd(), 'src', 'styles', 'tokens.css'), 'utf8');

let fetchStub: ReturnType<typeof createFetchStub>;

function setup(): void {
  fetchStub = createFetchStub();
  vi.stubGlobal('fetch', fetchStub.fetch);
  vi.stubGlobal('crypto', createCryptoStub());
  window.sessionStorage.clear();
  resetSession();
}

async function signIn(): Promise<void> {
  window.sessionStorage.setItem(pkceTransactionKey, JSON.stringify({ state: 's', verifier: 'verifier' }));
  const callback = completeLogin('?code=c&state=s');
  await flush();
  fetchStub.answer(TOKEN_URL, { access_token: jwt({ realm_access: { roles: ['admin'] } }), id_token: jwt({ sub: 'u' }) });
  await callback;
}

function renderShell() {
  return render(
    <Shell route={routes[0]}>
      <p>contenido</p>
    </Shell>,
  );
}

// WCAG 2.1 relative luminance and contrast ratio, over the exact hex values the
// stylesheet declares.
function luminance(hex: string): number {
  const channels = (hex.match(/[0-9a-f]{2}/gi) ?? []).map(pair => {
    const value = parseInt(pair, 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((left, right) => right - left);
  return (lighter + 0.05) / (darker + 0.05);
}

beforeEach(setup);

test('the sign-out control stays in the tab order with the shared visible focus ring', async () => {
  renderShell();
  fetchStub.answer(READY_URL, null, 204);
  await waitFor(() => expect(fetchStub.callsFor(READY_URL)).toHaveLength(1));

  await signIn();
  await waitFor(() => expect(document.getElementById('logout')).not.toHaveAttribute('hidden'));

  const logout = document.getElementById('logout');
  expect(logout).toBeInstanceOf(HTMLButtonElement);
  expect(logout).toHaveAttribute('type', 'button');
  // Not removed from the tab order and not disabled: a keyboard user reaches it
  // with Tab, like every other control on the page.
  expect(logout).not.toHaveAttribute('tabindex');
  expect(logout).not.toBeDisabled();

  // The shared focus ring the control inherits must survive.
  expect(appCss).toMatch(/button:focus-visible[^{}]*\{[^}]*outline:\s*3px solid/);
});

test('the sidebar navigation keeps WCAG AA contrast on the sidebar background', () => {
  const navLinkRule = appCss.match(/^\.nav-link \{[^}]*\}/m);
  expect(navLinkRule).not.toBeNull();
  const foreground = navLinkRule?.[0].match(/color:\s*(#[0-9a-f]{6})/i)?.[1];
  const background = tokensCss.match(/--forest-900:\s*(#[0-9a-f]{6})/i)?.[1];
  expect(foreground).toBeTruthy();
  expect(background).toBeTruthy();

  const ratio = contrast(foreground as string, background as string);
  expect(ratio).toBeGreaterThanOrEqual(4.5);
});

// ── The skip link ─────────────────────────────────────────────────────────
//
// The workspace's "Saltar al contenido" never actually skipped: the link was a
// plain fragment link, so activating it wrote `#content` into the address bar,
// the hash router read that undeclared fragment as the default view, and the
// content region never received focus — the reader was moved to Overview instead
// (odd/tasks/g1-production-frontend.md, L20).
//
// jsdom has no layout engine and no sequential focus navigation of its own, but
// the user-event keyboard is enough for both halves that matter here: whether the
// activation keeps the fragment, and where focus actually lands. Whether Chromium
// then reveals the region on screen is measured in a browser, not here.
test('the skip link moves focus into the content region and keeps the fragment', async () => {
  const user = userEvent.setup();
  renderShell();
  fetchStub.answer(READY_URL, null, 204);
  await waitFor(() => expect(fetchStub.callsFor(READY_URL)).toHaveLength(1));

  const skipLink = screen.getByRole('link', { name: /saltar al contenido/i });
  const content = document.getElementById('content');
  expect(content).toBeInstanceOf(HTMLElement);
  expect((content as HTMLElement).tagName).toBe('MAIN');
  // Still a link, so it keeps its role, its name and anchor keyboard activation.
  expect(skipLink).toHaveAttribute('href', '#content');

  // The region is a target, not a stop: walking every control of the shell with
  // Tab must never land on it.
  const tabStops: Element[] = [];
  for (let step = 0; step < 20; step += 1) {
    await user.tab();
    const active = document.activeElement;
    if (active === null || active === document.body) break;
    tabStops.push(active);
  }
  expect(tabStops[0]).toBe(skipLink);
  expect(tabStops).not.toContain(content);

  // Activating it from the keyboard puts focus inside the content region and
  // leaves the fragment — and with it the open view — untouched.
  window.location.hash = '#audit';
  skipLink.focus();
  expect(document.activeElement).toBe(skipLink);
  await user.keyboard('{Enter}');
  expect(document.activeElement).toBe(content);
  expect(window.location.hash).toBe('#audit');
});

test('the 720px layout keeps the sidebar static and the navigation three-column (no regression)', () => {
  const smallViewport = appCss.match(/@media\s*\(max-width:\s*720px\)[\s\S]*?\n\}/)?.[0] ?? '';
  expect(smallViewport).not.toBe('');

  const sidebarRule = smallViewport.match(/\.sidebar\s*\{[^}]*\}/)?.[0] ?? '';
  expect(sidebarRule).toMatch(/position:\s*static/);
  expect(sidebarRule).toMatch(/width:\s*auto/);
  expect(sidebarRule).toMatch(/height:\s*auto/);
  expect(sidebarRule).toMatch(/min-height:\s*0/);

  const navRule = smallViewport.match(/\.sidebar nav\s*\{[^}]*\}/)?.[0] ?? '';
  expect(navRule).toMatch(/grid-template-columns:\s*repeat\(3,/);
});
