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
// ring, and the product navigation's labels must clear WCAG AA on the sidebar
// background. The geometric half — the control inside the sidebar's visible box
// at 1024x768, 1280x720, 1366x768 and 1440x900, without scrolling the column — is
// measured in a browser and recorded under tmp/e2e-sidebar/; jsdom has no layout
// engine, so what is pinned here is the stylesheet the browser receives plus the
// rendered control.
//
// T1 replaced the flat, always-expanded sidebar list with the global product
// navigation: three shortcuts, a grouped native disclosure and the current
// location. The contrast and focus invariants survive the change, so they are
// asserted against the component that now carries them (`product-nav.css`)
// instead of the retired `.nav-link` rules. The pairs are pinned deliberately:
// the E2E probe once compared a link colour with itself, so the real background
// (`--forest-900`) is read from the token file and both sides are computed.
const READY_URL = `${gatewayOrigin}/health/ready`;
const TOKEN_URL = `${issuer}/protocol/openid-connect/token`;

const appCss = readFileSync(resolve(process.cwd(), 'src', 'styles', 'app.css'), 'utf8');
const productNavCss = readFileSync(resolve(process.cwd(), 'src', 'styles', 'product-nav.css'), 'utf8');
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

// ── The product navigation ────────────────────────────────────────────────
// Small CSS readers instead of a stylesheet dependency: the component sheet is
// flat, and every assertion fails loudly if the rule it asks about is missing.
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  if (match === null) throw new Error(`missing rule for ${selector}`);
  return match[1];
}

function declaration(body: string, property: string): string {
  const found = body
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith(`${property}:`));
  if (found === undefined) throw new Error(`missing declaration: ${property}`);
  return found.slice(property.length + 1).trim();
}

function hexIn(value: string): string {
  const found = value.match(/#[0-9a-f]{6}/i);
  if (found === null) throw new Error(`no hex colour in ${value}`);
  return found[0];
}

test('the product bar and its out-of-flow panel keep WCAG AA contrast against their actual backgrounds', () => {
  const barHex = tokensCss.match(/--forest-900:\s*(#[0-9a-f]{6})/i)?.[1];
  expect(barHex).toBeTruthy();
  const bar = barHex as string;

  const panelRule = ruleBody(productNavCss, '.product-nav__panel');
  // The panel is opaque: the measured pair is the pair a reader sees. The former
  // 3% white overlay over the sidebar produced this same tone (#1e4241), and on
  // it the old #90aaa0 label measured 4.42:1 — below AA. That defect is pinned
  // here so the colour cannot silently come back.
  expect(declaration(panelRule, 'background')).toMatch(/^#[0-9a-f]{6}$/i);
  const panel = hexIn(declaration(panelRule, 'background'));
  expect(contrast('#90aaa0', panel)).toBeLessThan(4.5);

  const pairs = [
    ['shortcut label', ruleBody(productNavCss, '.product-nav__link'), 'color', bar],
    ['disclosure control', ruleBody(productNavCss, '.product-nav__summary'), 'color', bar],
    ['current location value', ruleBody(productNavCss, '.product-nav__where'), 'color', bar],
    ['current location label', ruleBody(productNavCss, '.product-nav__where-label'), 'color', bar],
    ['grouped destination', ruleBody(productNavCss, '.product-nav__item'), 'color', panel],
    ['group title', ruleBody(productNavCss, '.product-nav__group-title'), 'color', panel],
    ['panel title', ruleBody(productNavCss, '.product-nav__panel-title'), 'color', panel],
    ['panel note', ruleBody(productNavCss, '.product-nav__note'), 'color', panel],
  ] as const;
  for (const [label, body, property, background] of pairs) {
    const ratio = contrast(hexIn(declaration(body, property)), background);
    expect(ratio, `${label} contrast`).toBeGreaterThanOrEqual(4.5);
  }

  // Current destinations on both surfaces, and the light shortcut row.
  const activeShortcut = ruleBody(productNavCss, ".product-nav__link[aria-current='page']");
  expect(declaration(activeShortcut, 'color')).toBe('var(--forest-900)');
  expect(contrast(bar, hexIn(declaration(activeShortcut, 'background')))).toBeGreaterThanOrEqual(4.5);
  const activeItem = ruleBody(productNavCss, ".product-nav__item[aria-current='page']");
  expect(contrast(hexIn(declaration(activeItem, 'color')), panel)).toBeGreaterThanOrEqual(4.5);

  // The disclosure control's boundary and the focus ring clear the 3:1
  // non-text target against both surfaces they sit on.
  const summary = ruleBody(productNavCss, '.product-nav__summary');
  expect(contrast(hexIn(declaration(summary, 'border')), bar)).toBeGreaterThanOrEqual(3);
  const focusRule = ruleBody(productNavCss, '.product-nav :is(a, button):focus-visible');
  const focus = hexIn(declaration(focusRule, 'outline'));
  expect(contrast(focus, bar)).toBeGreaterThanOrEqual(3);
  expect(contrast(focus, panel)).toBeGreaterThanOrEqual(3);
  // The 48px bar cannot host a 5px ring around its 40px controls, so the bar puts
  // the ring on its own surface; the bounded panel keeps the 2px gap because its
  // padding leaves room.
  expect(declaration(ruleBody(productNavCss, '.product-nav :is(.product-nav__link, .product-nav__summary):focus-visible'), 'outline-offset')).toBe('0');

  // Touch targets: the bar controls clear 40px, the grouped items stay above the
  // 24px minimum of the target-size criterion.
  expect(declaration(ruleBody(productNavCss, '.product-nav__link'), 'min-height')).toBe('40px');
  expect(declaration(summary, 'min-height')).toBe('40px');
  expect(parseFloat(declaration(ruleBody(productNavCss, '.product-nav__item'), 'min-height'))).toBeGreaterThanOrEqual(24);
});

test('the disclosure panel is out of flow, bounded and multi-column at every width', () => {
  const bar = ruleBody(productNavCss, '.product-nav');
  expect(declaration(bar, 'position')).toBe('sticky');
  expect(declaration(bar, 'top')).toBe('0');
  expect(declaration(bar, 'min-height')).toMatch(/var\(--product-nav-h/);
  // The bar is not a clipping container: a focus ring on its controls can paint.
  expect(ruleBody(productNavCss, '.product-nav')).not.toMatch(/overflow(?:-x|-y)?:\s*(?:hidden|auto|scroll)/);

  const panel = ruleBody(productNavCss, '.product-nav__panel');
  expect(declaration(panel, 'position')).toBe('absolute');
  expect(declaration(panel, 'max-height')).toMatch(/min\(70dvh/);
  expect(declaration(panel, 'overflow-y')).toBe('auto');
  expect(declaration(panel, 'width')).toMatch(/min\(760px/);
  // Room for a 3px ring at a 2px offset on the first and last rows.
  expect(parseFloat(declaration(panel, 'padding'))).toBeGreaterThanOrEqual(5);
  // Multi-column grouped destinations.
  expect(declaration(ruleBody(productNavCss, '.product-nav__groups'), 'grid-template-columns')).toMatch(/repeat\(auto-fit, minmax\(/);

  // No breakpoint turns the overlay back into an in-flow block.
  for (const block of productNavCss.matchAll(/@media[^{]*\{[\s\S]*?\n\}/g)) {
    expect(block[0]).not.toMatch(/\.product-nav__panel\s*\{[^}]*position:\s*(?:static|relative)/);
  }
  const small = productNavCss.match(/@media\s*\(max-width:\s*720px\)[\s\S]*?\n\}/)?.[0] ?? '';
  expect(small).toMatch(/\.product-nav__panel\s*\{[^}]*width:\s*calc\(100% - 16px\)/);
  const narrow = productNavCss.match(/@media\s*\(max-width:\s*480px\)[\s\S]*?\n\}/)?.[0] ?? '';
  expect(narrow).toMatch(/\.product-nav\s*\{[^}]*flex-wrap:\s*wrap/);
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

test('the 720px layout keeps the sidebar static and the bar overlay bounded', () => {
  const smallViewport = appCss.match(/@media\s*\(max-width:\s*720px\)[\s\S]*?\n\}/)?.[0] ?? '';
  expect(smallViewport).not.toBe('');

  const sidebarRule = smallViewport.match(/\.sidebar\s*\{[^}]*\}/)?.[0] ?? '';
  expect(sidebarRule).toMatch(/position:\s*static/);
  expect(sidebarRule).toMatch(/width:\s*auto/);
  expect(sidebarRule).toMatch(/height:\s*auto/);
  expect(sidebarRule).toMatch(/min-height:\s*0/);

  const navSmall = productNavCss.match(/@media\s*\(max-width:\s*720px\)[\s\S]*?\n\}/)?.[0] ?? '';
  expect(navSmall).toMatch(/\.product-nav\s*\{[^}]*padding-inline:\s*12px/);
  expect(navSmall).toMatch(/\.product-nav__panel\s*\{[^}]*right:\s*8px/);

  const narrower = productNavCss.match(/@media\s*\(max-width:\s*480px\)[\s\S]*?\n\}/)?.[0] ?? '';
  expect(narrower).toMatch(/\.product-nav\s*\{[^}]*flex-wrap:\s*wrap/);

  // Below 560px the location line stops taking row width but stays in the
  // accessibility tree: it is the live region that names the new route.
  const compact = productNavCss.match(/@media\s*\(max-width:\s*560px\)[\s\S]*?\n\}/)?.[0] ?? '';
  expect(compact).toMatch(/\.product-nav__where\s*\{[^}]*position:\s*absolute/);
  expect(compact).toMatch(/clip-path:\s*inset\(50%\)/);
});
