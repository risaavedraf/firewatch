import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { routes } from '../../src/app/routes';
import { Shell } from '../../src/components/Shell';
import { gatewayOrigin, issuer, pkceTransactionKey } from '../../src/config';
import { completeLogin, resetSession } from '../../src/core/session';

import { createCryptoStub, createFetchStub, flush, jwt } from '../core/harness';

// The shell's accessibility invariants after S7 removed the left column.
//
// The column used to own four things a keyboard or screen-reader reader needs:
// the gateway availability live region with its refresh control, the session
// state with the only sign-out control, the territorial scope and a visible focus
// ring measured against its own dark surface. T10 moved all four into the shell
// header, so the invariants are asserted against the header that now carries
// them — same ids, same live region, same labels — plus the contrast of every
// pair the new cluster paints.
//
// The geometric half (no horizontal overflow at 320/390/1280/1440, the control
// inside the header box) is measured in a browser; jsdom has no layout engine, so
// what is pinned here is the shipped stylesheet the browser receives plus the
// rendered controls.
const READY_URL = `${gatewayOrigin}/health/ready`;
const TOKEN_URL = `${issuer}/protocol/openid-connect/token`;

const appCss = readFileSync(resolve(process.cwd(), 'src', 'styles', 'app.css'), 'utf8');
const productNavCss = readFileSync(resolve(process.cwd(), 'src', 'styles', 'product-nav.css'), 'utf8');
const tokensCss = readFileSync(resolve(process.cwd(), 'src', 'styles', 'tokens.css'), 'utf8');

const palette = new Map<string, string>();
for (const match of tokensCss.split(/@media\s+print/)[0].matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/g)) {
  palette.set(match[1], match[2]);
}

function token(name: string): string {
  const value = palette.get(name);
  if (value === undefined) throw new Error(`tokens.css declares no --${name} as an explicit hex value`);
  return value;
}

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
  return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100;
}

// Small CSS readers instead of a stylesheet dependency: the sheets are flat, and
// every assertion fails loudly if the rule it asks about is missing.
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

// A role reference (`var(--x)`) is resolved through `tokens.css`; an explicit hex
// is measured as declared. That way a colour moved into a token cannot pass on the
// strength of a literal that happens to be repeated here.
function colour(value: string): string {
  const reference = value.match(/var\(--([\w-]+)\)/);
  if (reference !== null) return token(reference[1]);
  const hex = value.match(/#[0-9a-f]{6}/i);
  if (hex === null) throw new Error(`no resolvable colour in ${value}`);
  return hex[0];
}

beforeEach(setup);

test('the sign-out control stays in the tab order with the shared visible focus ring (S7)', async () => {
  renderShell();
  fetchStub.answer(READY_URL, null, 204);
  await waitFor(() => expect(fetchStub.callsFor(READY_URL)).toHaveLength(1));

  await signIn();
  await waitFor(() => expect(document.getElementById('logout')).not.toHaveAttribute('hidden'));

  const logout = document.getElementById('logout');
  expect(logout).toBeInstanceOf(HTMLButtonElement);
  expect(logout).toHaveAttribute('type', 'button');
  expect(logout).toHaveAccessibleName('Cerrar sesión');
  // Not removed from the tab order and not disabled: a keyboard user reaches it
  // with Tab, like every other control on the page.
  expect(logout).not.toHaveAttribute('tabindex');
  expect(logout).not.toBeDisabled();
  // It belongs to the shell header, not to the destinations menu.
  expect(logout?.closest('header.topbar')).not.toBeNull();
  expect(logout?.closest('.product-nav')).toBeNull();

  // The shared focus ring the control inherits must survive the palette change.
  expect(appCss).toMatch(/button:focus-visible[^{}]*\{[^}]*outline:\s*3px solid var\(--focus\)/);
});

test('the gateway cluster keeps its live region, its single refresh control and its measured pairs (S7)', async () => {
  renderShell();

  // The probe has not settled yet: the control states that in its only visible
  // way and cannot be fired twice.
  const refresh = document.getElementById('readiness-refresh');
  expect(refresh).toBeInstanceOf(HTMLButtonElement);
  expect(refresh).toHaveAccessibleName('Actualizar estado');
  expect(refresh).toBeDisabled();

  await waitFor(() => expect(fetchStub.callsFor(READY_URL)).toHaveLength(1));
  fetchStub.answer(READY_URL, null, 204);
  await waitFor(() => expect(document.querySelector('.health-dot.ready')).not.toBeNull());

  const status = document.getElementById('readiness-status');
  expect(status).toHaveAttribute('role', 'status');
  expect(status).toHaveAttribute('aria-live', 'polite');
  expect(status?.closest('header.topbar')).not.toBeNull();
  await waitFor(() => expect(refresh).not.toBeDisabled());

  // The card is a named region, not an anonymous box.
  const card = document.querySelector('.health-card');
  expect(card?.tagName).toBe('SECTION');
  expect(document.getElementById(card?.getAttribute('aria-labelledby') ?? '')).not.toBeNull();

  // The cluster is painted on the soft role; the message is the readable muted
  // tone there, and the refresh control is ink on paper with a 3:1 boundary.
  const cardRule = ruleBody(appCss, '.health-card');
  const cardSurface = colour(declaration(cardRule, 'background'));
  expect(cardSurface).toBe(token('soft'));
  expect(contrast(colour(declaration(ruleBody(appCss, '.health-card p'), 'color')), cardSurface)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(colour(declaration(ruleBody(appCss, '.health-head'), 'color')), cardSurface)).toBeGreaterThanOrEqual(4.5);

  const refreshRule = ruleBody(appCss, '.status-action');
  expect(contrast(colour(declaration(refreshRule, 'color')), colour(declaration(refreshRule, 'background')))).toBeGreaterThanOrEqual(4.5);
  expect(contrast(colour(declaration(refreshRule, 'border')), colour(declaration(refreshRule, 'background')))).toBeGreaterThanOrEqual(3);
  // A real target, not a 10px text link.
  expect(Number.parseInt(declaration(refreshRule, 'min-height'), 10)).toBeGreaterThanOrEqual(32);
});

test('the header cluster paints every label with a measured pair (S7/S8)', () => {
  const paper = token('paper');
  const soft = token('soft');

  // Brand mark: the filled square carries the dark ink, never the light one.
  const brandRule = ruleBody(appCss, '.brand-mark');
  const brandFill = colour(declaration(brandRule, 'background'));
  expect(contrast(colour(declaration(brandRule, 'color')), brandFill)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(brandFill, paper)).toBeGreaterThanOrEqual(3);

  const pairs: Array<[string, string, string, string]> = [
    ['brand name', ruleBody(appCss, '.brand strong'), 'color', paper],
    ['brand scope', ruleBody(appCss, '.brand small'), 'color', paper],
    ['route group', ruleBody(appCss, '.breadcrumbs'), 'color', paper],
    ['route title', ruleBody(appCss, '.topbar h1'), 'color', paper],
    ['zone scope', ruleBody(appCss, '.zone-chip small'), 'color', paper],
    ['zone value', ruleBody(appCss, '.zone-chip strong'), 'color', paper],
    ['zone glyph', ruleBody(appCss, '.zone-chip > span'), 'color', paper],
    ['session state', ruleBody(appCss, '.session-card strong'), 'color', soft],
    ['session detail', ruleBody(appCss, '.session-card small'), 'color', soft],
    ['sign-out label', ruleBody(appCss, '.session-card button'), 'color', soft],
    ['session mark', ruleBody(appCss, '.session-mark'), 'color', soft],
  ];

  for (const [label, body, property, background] of pairs) {
    expect(contrast(colour(declaration(body, property)), background), `${label} contrast`).toBeGreaterThanOrEqual(4.5);
  }

  // The sign-out control's own surface is the paper role and its boundary clears
  // the 3:1 non-text minimum against the card behind it.
  const logoutRule = ruleBody(appCss, '.session-card button');
  expect(colour(declaration(logoutRule, 'background'))).toBe(paper);
  expect(contrast(colour(declaration(logoutRule, 'border')), soft)).toBeGreaterThanOrEqual(3);

  // The header itself is the paper surface with the readable ink.
  const topbarRule = ruleBody(appCss, '.topbar');
  expect(colour(declaration(topbarRule, 'background'))).toBe(paper);
  expect(contrast(token('muted'), paper)).toBeGreaterThanOrEqual(4.5);
});

// ── The product navigation ────────────────────────────────────────────────
// The bar is always the slate/aqua palette now (S8). Every pair is resolved
// through `tokens.css` so a colour changed there is measured again instead of
// passing on the strength of a literal repeated in this file.
test('the product bar and its out-of-flow panel keep WCAG AA contrast against their actual backgrounds (S8)', () => {
  const bar = colour(declaration(ruleBody(productNavCss, '.product-nav'), 'background'));
  const panel = colour(declaration(ruleBody(productNavCss, '.product-nav__panel'), 'background'));

  expect(bar).toBe(token('paper'));
  // The panel is opaque: the measured pair is the pair a reader sees.
  expect(panel).toBe(token('surface-raised'));
  expect(contrast(panel, bar)).toBeGreaterThanOrEqual(1);

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
    expect(contrast(colour(declaration(body, property)), background), `${label} contrast`).toBeGreaterThanOrEqual(4.5);
  }

  // The current destinations: the shortcut is a filled accent chip with the dark
  // ink on it, and the grouped entry uses the accent on the raised panel.
  const activeShortcut = ruleBody(productNavCss, ".product-nav__link[aria-current='page']");
  const activeFill = colour(declaration(activeShortcut, 'background'));
  expect(activeFill).toBe(token('accent'));
  expect(contrast(colour(declaration(activeShortcut, 'color')), activeFill)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(activeFill, bar)).toBeGreaterThanOrEqual(3);
  const activeItem = ruleBody(productNavCss, ".product-nav__item[aria-current='page']");
  expect(contrast(colour(declaration(activeItem, 'color')), panel)).toBeGreaterThanOrEqual(4.5);

  // The disclosure control's boundary and the focus ring clear the 3:1 non-text
  // target against both surfaces they sit on.
  const summary = ruleBody(productNavCss, '.product-nav__summary');
  expect(contrast(colour(declaration(summary, 'border')), bar)).toBeGreaterThanOrEqual(3);
  const focusRule = ruleBody(productNavCss, '.product-nav :is(a, button):focus-visible');
  const focus = colour(declaration(focusRule, 'outline'));
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
  const barRule = ruleBody(productNavCss, '.product-nav');
  expect(declaration(barRule, 'position')).toBe('sticky');
  expect(declaration(barRule, 'top')).toBe('0');
  expect(declaration(barRule, 'min-height')).toMatch(/var\(--product-nav-h/);
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

// ── The narrow shell ─────────────────────────────────────────────────────
// Removing the column is what gives a phone its width back: the header wraps
// instead of shrinking, and nothing is hidden to make it fit. The old 720px block
// turned the column into a row and hid the gateway card; both are gone.
test('the narrow layout wraps the header cluster instead of hiding any of it (S7)', () => {
  const smallViewport = appCss.match(/@media\s*\(max-width:\s*720px\)[\s\S]*?\n\}/)?.[0] ?? '';
  expect(smallViewport).not.toBe('');

  // The retired column keeps no rule at any width.
  expect(appCss).not.toMatch(/\.sidebar\b/);
  expect(smallViewport).not.toMatch(/\.sidebar\b/);

  // The gateway card is never hidden: it carries the readiness live region and the
  // refresh control on every viewport.
  expect(appCss).not.toMatch(/\.health-card\s*\{[^}]*display:\s*none/);

  const header = ruleBody(appCss, '.topbar');
  expect(declaration(header, 'flex-wrap')).toBe('wrap');
  expect(parseFloat(declaration(header, 'min-height'))).toBeLessThan(75);

  // Every cluster box may shrink: `min-width: 0` on each one is what keeps a long
  // zone name or readiness sentence from widening the page.
  for (const selector of ['.topbar', '.topbar-lead', '.topbar-utils', '.brand', '.topbar-route', '.zone-chip', '.health-card', '.session-card']) {
    expect(declaration(ruleBody(appCss, selector), 'min-width'), `${selector} must be able to shrink`).toBe('0');
  }

  expect(smallViewport).toMatch(/\.topbar\s*\{[^}]*padding:\s*7px 14px/);
  expect(smallViewport).toMatch(/\.topbar-utils\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/);

  // The only sign-out control keeps its target size on a phone.
  const logout = smallViewport.match(/\.session-card button\s*\{[^}]*\}/)?.[0] ?? '';
  expect(Number.parseInt((logout.match(/min-height:\s*(\d+)px/) ?? [])[1] ?? '0', 10)).toBeGreaterThanOrEqual(36);
});
