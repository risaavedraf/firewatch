import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { navigationGroups, routes } from '../../src/app/routes';
import {
  clearZoneState,
  getHistoryFilters,
  rememberZoneCatalogue,
  resetHistoryFilters,
  selectZone,
  setHistoryQuery,
  setHistoryStatus,
} from '../../src/app/store';
import { Shell } from '../../src/components/Shell';
import { gatewayOrigin, issuer, pkceTransactionKey } from '../../src/config';
import { zones } from '../../src/core/api';
import { completeLogin, resetSession } from '../../src/core/session';

import { createCryptoStub, createFetchStub, flush, jwt } from '../core/harness';

// The shell owns four things a view cannot: the gateway availability card, the
// session card, the single logout control and the footer's filter reset. Each is
// asserted here because each is visible on every view.
const READY_URL = `${gatewayOrigin}/health/ready`;
const TOKEN_URL = `${issuer}/protocol/openid-connect/token`;
const appCss = readFileSync(resolve(process.cwd(), 'src', 'styles', 'app.css'), 'utf8');

let fetchStub: ReturnType<typeof createFetchStub>;

function setup(): void {
  fetchStub = createFetchStub();
  vi.stubGlobal('fetch', fetchStub.fetch);
  vi.stubGlobal('crypto', createCryptoStub());
  window.sessionStorage.clear();
  resetSession();
  clearZoneState();
  resetHistoryFilters();
}

function renderShell() {
  return render(
    <Shell route={routes[0]}>
      <p>contenido</p>
    </Shell>,
  );
}

function renderShellFor(id: (typeof routes)[number]['id']) {
  const route = routes.find(candidate => candidate.id === id);
  if (route === undefined) throw new Error(`missing declared route: ${id}`);
  return render(
    <Shell route={route}>
      <p>contenido</p>
    </Shell>,
  );
}

async function signIn(): Promise<void> {
  window.sessionStorage.setItem(pkceTransactionKey, JSON.stringify({ state: 's', verifier: 'verifier' }));
  const callback = completeLogin('?code=c&state=s');
  await flush();
  fetchStub.answer(TOKEN_URL, {
    access_token: jwt({ realm_access: { roles: ['admin'] } }),
    id_token: jwt({ sub: 'u' }),
  });
  await callback;
}

beforeEach(setup);

test('the availability card proves gateway availability and says that is all it proves', async () => {
  renderShell();
  await waitFor(() => expect(fetchStub.callsFor(READY_URL)).toHaveLength(1));
  fetchStub.answer(READY_URL, null, 204);

  await waitFor(() => expect(screen.getByText(/no acredita el pipeline/i)).toBeInTheDocument());
  expect(document.querySelector('.health-dot.ready')).not.toBeNull();
});

test('a refused probe marks the gateway down instead of claiming it', async () => {
  renderShell();
  await waitFor(() => expect(fetchStub.callsFor(READY_URL)).toHaveLength(1));
  fetchStub.answer(READY_URL, null, 503);

  await waitFor(() => expect(screen.getByText(/Gateway no disponible \(HTTP 503\)/i)).toBeInTheDocument());
  expect(document.querySelector('.health-dot.down')).not.toBeNull();
});

test('the manual refresh re-probes the same endpoint', async () => {
  renderShell();
  await waitFor(() => expect(fetchStub.callsFor(READY_URL)).toHaveLength(1));
  fetchStub.answer(READY_URL, null, 204);
  await waitFor(() => expect(document.querySelector('.health-dot.ready')).not.toBeNull());

  await userEvent.click(screen.getByRole('button', { name: /actualizar estado/i }));
  await waitFor(() => expect(fetchStub.callsFor(READY_URL)).toHaveLength(2));
  fetchStub.answer(READY_URL, null, 503);
  await waitFor(() => expect(document.querySelector('.health-dot.down')).not.toBeNull());
});

test('the session card follows the session and the logout control stays single and hidden while signed out', async () => {
  renderShell();
  fetchStub.answer(READY_URL, null, 204);

  expect(screen.getByText('Sin conexión')).toBeInTheDocument();
  expect(screen.getByText('Token requerido para consultar')).toBeInTheDocument();
  // Exactly one control, and it is hidden — never a duplicate for a second layout.
  expect(document.querySelectorAll('#logout')).toHaveLength(1);
  expect(document.getElementById('logout')).toHaveAttribute('hidden');

  await signIn();

  await waitFor(() => expect(screen.getByText('Sesión conectada')).toBeInTheDocument());
  expect(screen.getByText('Permisos evaluados por el servidor')).toBeInTheDocument();
  expect(document.getElementById('logout')).not.toHaveAttribute('hidden');
});

test('the footer control resets the history filters', async () => {  setHistoryQuery('05501');
  setHistoryStatus('publicado');
  renderShell();
  fetchStub.answer(READY_URL, null, 204);

  await userEvent.click(screen.getByRole('button', { name: /restablecer filtros/i }));

  expect(getHistoryFilters()).toEqual({ query: '', status: '' });
});

// The footer is its own landmark. Nested inside `main` it became part of the main
// region, which is the defect the reader pass recorded.
test('the footer is a landmark outside the main region', async () => {
  renderShell();
  fetchStub.answer(READY_URL, null, 204);

  expect(document.querySelector('main footer')).toBeNull();
  const footer = document.querySelector('.main-area > footer');
  expect(footer).not.toBeNull();
  expect(footer?.querySelector('#reset-filters')).not.toBeNull();
});

// S2 — the sidebar session card must name a rejected token instead of falling
// back to the first-visit copy, and the reason must not survive the session it
// describes. `resetSession` is the first thing `signOut` runs.
test('a rejected token is named in the session card and does not survive logout (S2/S6)', async () => {
  renderShell();
  fetchStub.answer(READY_URL, null, 204);
  await signIn();
  await waitFor(() => expect(screen.getByText('Sesión conectada')).toBeInTheDocument());

  // An authenticated read carries the bearer and comes back 401.
  const read = zones();
  await flush();
  fetchStub.answer(`${gatewayOrigin}/v1/risk/zones`, { code: 'unauthorized' }, 401);
  await act(async () => {
    await read;
  });

  expect(document.getElementById('session-state')).toHaveTextContent('Sin conexión');
  const detail = document.getElementById('session-detail')?.textContent ?? '';
  expect(detail).not.toBe('Token requerido para consultar');
  expect(detail).toMatch(/rechazó el token/i);

  // The reason belongs to that rejected session only.
  act(() => {
    resetSession();
  });
  expect(document.getElementById('session-detail')).toHaveTextContent('Token requerido para consultar');
});

// Finding 2 — the topbar chip used to be a dead literal that contradicted the
// page body. It now mirrors the zone selected in the shared store and names it
// only from the catalogue that was actually loaded.
test('the topbar chip names the selected zone from the loaded catalogue and never invents one (finding: dead #zone-chip-name)', async () => {
  renderShell();
  await waitFor(() => expect(fetchStub.callsFor(READY_URL)).toHaveLength(1));
  fetchStub.answer(READY_URL, null, 204);

  const chip = () => document.getElementById('zone-chip-name')?.textContent ?? '';
  // No catalogue was loaded and no zone is selected: the chip claims no zone.
  expect(chip()).toBe('Sin zona');

  act(() => {
    rememberZoneCatalogue(new Map([['05101', 'Valparaíso (05101)']]));
    selectZone('05101');
  });
  expect(chip()).toBe('Valparaíso (05101)');

  // A code the loaded catalogue never carried is a zone without a name: the chip
  // falls back to "Sin zona" instead of inventing one.
  act(() => {
    selectZone('05999');
  });
  expect(chip()).toBe('Sin zona');
});

// S5 — `#update-checked` stopped being a fixed literal: it states what the page
// actually knows and never contradicts `#readiness-status`.
test('the update bar states the real review state and never contradicts the availability card (S5)', async () => {
  renderShell();
  // Before the first probe settles the page knows of no review.
  expect(document.getElementById('update-checked')?.textContent ?? '').toMatch(/sin verificar/i);

  await waitFor(() => expect(fetchStub.callsFor(READY_URL)).toHaveLength(1));
  fetchStub.answer(READY_URL, null, 204);
  await waitFor(() => expect(document.querySelector('.health-dot.ready')).not.toBeNull());
  const ready = document.getElementById('update-checked')?.textContent ?? '';
  expect(ready).toMatch(/gateway respondió/i);
  expect(ready).not.toMatch(/no respondió/i);
  expect(ready).not.toMatch(/conecta un token/i);

  // A failed re-check must follow the card, not keep claiming success.
  await userEvent.click(screen.getByRole('button', { name: /actualizar estado/i }));
  await waitFor(() => expect(fetchStub.callsFor(READY_URL)).toHaveLength(2));
  fetchStub.answer(READY_URL, null, 503);
  await waitFor(() => expect(document.querySelector('.health-dot.down')).not.toBeNull());
  const down = document.getElementById('update-checked')?.textContent ?? '';
  expect(down).toMatch(/no respondió/i);
  expect(down).not.toMatch(/disponible/i);
});

// ── T1 · the global product navigation ─────────────────────────────────────
// The approved canvas puts a thin horizontal bar above the workspace, outside
// it, and opens its grouped destinations as an out-of-flow multi-column panel.
// The bar carries the canvas' four shortcuts: the three it already had keep their
// place, and T4 adds the executive panel's now that the route exists. Every href
// still comes from `routes`.

test('the product navigation is a horizontal bar above the shell, not a region inside it', () => {
  renderShell();

  const nav = screen.getByRole('navigation', { name: 'Navegación del producto FireWatch' });
  const shell = document.querySelector('.app-shell');
  expect(shell).not.toBeNull();

  // Above and outside the workspace: the bar is a sibling that precedes the
  // shell, never a region inside the column and never inside `main`.
  expect(nav.nextElementSibling).toBe(shell);
  expect(nav.closest('aside')).toBeNull();
  expect(nav.closest('main')).toBeNull();
  expect(nav.closest('.app-shell')).toBeNull();
});

// ── S7 · the sidebar is gone ────────────────────────────────────────────────
// «también me gustaría sacar la barra lateral para darle más espacio a las
// cosas». The column is not collapsed or narrowed: it is removed, so the
// workspace is the only column of `.app-shell` and `main` gets its width. Every
// control the column held was moved into the top bar by the tests below, not
// dropped with it.
test('the shell renders no sidebar and the workspace owns the whole width (S7)', () => {
  renderShell();

  expect(document.querySelector('aside.sidebar')).toBeNull();
  expect(document.querySelector('.sidebar')).toBeNull();
  expect(document.querySelector('.sidebar-bottom')).toBeNull();
  expect(document.querySelector('.workspace')).toBeNull();

  const shell = document.querySelector('.app-shell');
  expect(shell).not.toBeNull();
  // One column, and it is the workspace: nothing is left to take width away.
  expect([...(shell?.children ?? [])].map(child => child.className)).toEqual(['main-area']);

  const main = document.getElementById('content');
  expect(main?.tagName).toBe('MAIN');
  expect(main?.parentElement?.className).toBe('main-area');
  expect(shell?.contains(main as Node)).toBe(true);

  // No stylesheet may keep a rule for a column the DOM no longer renders.
  expect(appCss).not.toMatch(/\.sidebar\b/);
});

// ── S7 · the utility cluster in the top bar ─────────────────────────────────
// The column's operational controls (brand, territorial scope, gateway
// readiness with its refresh, the session state and the only sign-out control)
// are preserved in the shell header — same ids, same live region, same labels.
test('the shell header carries the brand, the territory, the gateway cluster and the single sign-out control (S7)', async () => {
  renderShell();
  await waitFor(() => expect(fetchStub.callsFor(READY_URL)).toHaveLength(1));
  fetchStub.answer(READY_URL, null, 204);
  await waitFor(() => expect(document.querySelector('.health-dot.ready')).not.toBeNull());

  const header = document.querySelector('header.topbar') as HTMLElement;
  expect(header).not.toBeNull();

  // Brand mark, on the left of the bar.
  expect(header.querySelector('.brand')?.textContent).toContain('FireWatch');
  expect(header.querySelector('.brand')?.textContent).toContain('Prevención territorial');

  // The active territorial context: the scope and the chip that names the zone.
  expect(header.textContent).toContain('Valparaíso · Ámbito regional');
  expect(header.querySelector('#zone-chip-name')).not.toBeNull();

  // The gateway readiness indicator keeps its live region and its single control.
  const status = header.querySelector('#readiness-status');
  expect(status).not.toBeNull();
  expect(status).toHaveAttribute('role', 'status');
  expect(status).toHaveAttribute('aria-live', 'polite');
  expect(status?.textContent).toMatch(/no acredita el pipeline/i);
  const refresh = header.querySelector('#readiness-refresh');
  expect(refresh).toBeInstanceOf(HTMLButtonElement);
  expect(refresh).toHaveAccessibleName('Actualizar estado');

  // The session state and the one sign-out control live here too, not in a menu.
  expect(header.querySelector('#session-state')).toHaveTextContent('Sin conexión');
  expect(header.querySelector('#session-detail')).toHaveTextContent('Token requerido para consultar');
  expect(document.querySelectorAll('#logout')).toHaveLength(1);
  expect(header.querySelectorAll('#logout')).toHaveLength(1);
  expect(document.getElementById('logout')?.closest('.product-nav')).toBeNull();

  // The header is the shell's banner, not a second navigation region.
  expect(header.querySelector('nav')).toBeNull();
  expect(document.querySelector('.product-nav')?.contains(header)).toBe(false);
});

// The tab order the utility cluster promises: the bar first (shortcuts and its
// disclosure), then the gateway refresh, then the only sign-out control, then the
// workspace. Nothing else may interrupt it, and a keyboard reader must reach
// every one of those controls without opening the destinations menu.
test('the top bar keeps the tab order skip link → navigation → gateway refresh → sign-out → workspace (S7)', async () => {
  const user = userEvent.setup();
  renderShell();
  await waitFor(() => expect(fetchStub.callsFor(READY_URL)).toHaveLength(1));
  fetchStub.answer(READY_URL, null, 204);

  await signIn();
  await waitFor(() => expect(document.getElementById('logout')).not.toHaveAttribute('hidden'));

  const order: Element[] = [];
  for (let step = 0; step < 40; step += 1) {
    await user.tab();
    const active = document.activeElement;
    if (active === null || active === document.body) break;
    order.push(active);
  }

  const at = (node: Element | null) => order.indexOf(node as Element);
  const skip = screen.getByRole('link', { name: /saltar al contenido/i });
  const firstShortcut = document.getElementById('nav-overview') as Element;
  const disclosure = screen.getByRole('button', { name: /más destinos/i });
  const refresh = document.getElementById('readiness-refresh') as Element;
  const logout = document.getElementById('logout') as Element;
  const reset = document.getElementById('reset-filters') as Element;

  expect(order[0]).toBe(skip);
  expect(at(firstShortcut)).toBeGreaterThan(at(skip));
  expect(at(disclosure)).toBeGreaterThan(at(firstShortcut));
  expect(at(refresh)).toBeGreaterThan(at(disclosure));
  expect(at(logout)).toBeGreaterThan(at(refresh));
  expect(at(reset)).toBeGreaterThan(at(logout));

  // The refresh and the sign-out control are consecutive stops: no shell control
  // sits between the bar and them, and neither is reachable only through the menu.
  expect(at(logout) - at(refresh)).toBe(1);
  expect(document.getElementById('logout')).not.toHaveAttribute('hidden');
});

test('the bar keeps four canvas shortcuts, every declared hash once, and names the current location', () => {
  renderShell();

  const nav = screen.getByRole('navigation', { name: 'Navegación del producto FireWatch' });
  const hrefs = [...nav.querySelectorAll('a[href]')].map(link => link.getAttribute('href'));
  expect(new Set(hrefs)).toEqual(new Set(routes.map(route => route.hash)));
  expect(hrefs).toHaveLength(routes.length);

  // The canvas' fourth shortcut (Panel ejecutivo) is a real route since T4; the
  // bar must not point at a destination the application does not serve.
  const shortcuts = [...nav.querySelectorAll('.product-nav__shortcuts a[href]')];
  expect(shortcuts.map(link => link.textContent?.trim())).toEqual(['Mapa', 'Historial', 'Acciones', 'Panel']);
  expect(shortcuts.map(link => link.getAttribute('href'))).toEqual(['#overview', '#history', '#actions', '#executive']);
  expect(shortcuts.every(href => routes.some(route => route.hash === href.getAttribute('href')))).toBe(true);
  // The short visible label stays the beginning of the full accessible name, so
  // the bar fits one row without losing the destination.
  expect(shortcuts[0]).toHaveAccessibleName('Mapa · Territorio');
  expect(shortcuts[1]).toHaveAccessibleName('Historial de lotes');
  expect(shortcuts[2]).toHaveAccessibleName('Acciones preventivas');
  expect(shortcuts[3]).toHaveAccessibleName('Panel ejecutivo');

  expect(document.querySelector('.product-nav__where')?.textContent).toContain('Territorio');
});

test('the open route is named in "Estás en" and is the only destination marked current', () => {
  const grouped = renderShellFor('audit');
  const where = document.querySelector('.product-nav__where');
  expect(where?.textContent).toMatch(/estás en/i);
  expect(where?.textContent).toContain('Registro de actividad');
  // A hash route change reloads nothing: the location line is the polite live
  // region that announces where the reader landed.
  expect(where).toHaveAttribute('aria-live', 'polite');
  const currentGrouped = [...document.querySelectorAll('.product-nav [aria-current="page"]')];
  expect(currentGrouped).toHaveLength(1);
  expect(currentGrouped[0]).toHaveAttribute('href', '#audit');
  grouped.unmount();

  renderShellFor('history');
  expect(document.querySelector('.product-nav__where')?.textContent).toContain('Historial de lotes');
  const currentShortcut = [...document.querySelectorAll('.product-nav [aria-current="page"]')];
  expect(currentShortcut).toHaveLength(1);
  expect(currentShortcut[0]).toHaveAttribute('href', '#history');
});

test('the grouped destinations live in an out-of-flow disclosure outside the shell, grouped by the real navigation groups', async () => {
  const user = userEvent.setup();
  renderShell();

  const button = screen.getByRole('button', { name: /más destinos/i });
  const panelId = button.getAttribute('aria-controls');
  const panel = document.getElementById(panelId as string);
  expect(panel).not.toBeNull();
  expect(button).toHaveAttribute('aria-expanded', 'false');
  expect(panel).toHaveAttribute('hidden');
  // The panel is not part of the workspace shell: opening it cannot push the
  // sidebar, the logout control or `main` down, at any width.
  expect(panel?.closest('.app-shell')).toBeNull();
  expect(panel?.closest('aside')).toBeNull();
  expect(panel?.closest('.product-nav')).not.toBeNull();

  const grouped = [...(panel?.querySelectorAll('a[href]') ?? [])].map(link => link.getAttribute('href'));
  const shortcutHrefs = ['#overview', '#history', '#actions', '#executive'];
  expect(new Set(grouped)).toEqual(new Set(routes.map(route => route.hash).filter(href => !shortcutHrefs.includes(href))));
  expect(panel?.querySelector('.product-nav__groups')).not.toBeNull();

  const groupTitles = [...(panel?.querySelectorAll('.product-nav__group-title') ?? [])].map(node => node.textContent);
  expect(groupTitles).toEqual([...navigationGroups]);
  const lists = [...(panel?.querySelectorAll('.product-nav__list') ?? [])];
  expect(lists).toHaveLength(navigationGroups.length);
  for (const list of lists) {
    const labelId = list.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId as string)).not.toBeNull();
  }

  await user.click(button);
  expect(button).toHaveAttribute('aria-expanded', 'true');
  expect(panel).not.toHaveAttribute('hidden');
});

test('Escape returns focus to the disclosure control and an outside press dismisses the panel', async () => {
  const user = userEvent.setup();
  renderShell();

  const button = screen.getByRole('button', { name: /más destinos/i });
  await user.click(button);
  const link = screen.getByRole('link', { name: 'Notificaciones' });
  link.focus();
  expect(document.activeElement).toBe(link);

  await user.keyboard('{Escape}');
  expect(button).toHaveAttribute('aria-expanded', 'false');
  expect(document.activeElement).toBe(button);

  await user.click(button);
  expect(button).toHaveAttribute('aria-expanded', 'true');
  await user.click(document.querySelector('.topbar h1') as Element);
  expect(button).toHaveAttribute('aria-expanded', 'false');
});

test('the open panel keeps every grouped destination reachable without trapping Tab', async () => {
  const user = userEvent.setup();
  renderShell();

  await user.click(screen.getByRole('button', { name: /más destinos/i }));
  const links = [...document.querySelectorAll('.product-nav__panel a[href]')] as HTMLElement[];
  expect(links).toHaveLength(routes.length - 4);

  links[0].focus();
  expect(document.activeElement).toBe(links[0]);
  for (const link of links.slice(1)) {
    await user.tab();
    expect(document.activeElement).toBe(link);
  }
  // One more Tab leaves the bar instead of cycling inside it.
  await user.tab();
  expect(document.querySelector('.product-nav')?.contains(document.activeElement)).toBe(false);
});

test('a grouped route change reveals its current entry, while a same-route re-render leaves the reader\'s choice alone', async () => {
  const user = userEvent.setup();
  const audit = routes.find(route => route.id === 'audit') as (typeof routes)[number];
  const notifications = routes.find(route => route.id === 'notifications') as (typeof routes)[number];
  const history = routes.find(route => route.id === 'history') as (typeof routes)[number];

  const { rerender } = render(
    <Shell route={audit}>
      <p>contenido</p>
    </Shell>,
  );
  const button = screen.getByRole('button', { name: /más destinos/i });
  const panel = document.getElementById(button.getAttribute('aria-controls') as string) as HTMLElement;
  // A direct grouped link starts closed: the location line names the screen and
  // the panel is opened by the reader, as in the canvas.
  expect(button).toHaveAttribute('aria-expanded', 'false');

  const scrollIntoView = vi.fn();
  const original = Element.prototype.scrollIntoView;
  Object.defineProperty(Element.prototype, 'scrollIntoView', { value: scrollIntoView, configurable: true, writable: true });
  try {
    // Back/Forward to another grouped route is a route change the reader did not
    // make from the menu, so the new current destination is revealed.
    rerender(
      <Shell route={notifications}>
        <p>contenido</p>
      </Shell>,
    );
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(panel).not.toHaveAttribute('hidden');
    expect(scrollIntoView).toHaveBeenCalled();
    const current = [...document.querySelectorAll('.product-nav [aria-current="page"]')];
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAttribute('href', '#notifications');

    // The reader closes it; a same-route re-render (for example the gateway probe
    // settling) must not reopen what they closed.
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');
    rerender(
      <Shell route={notifications}>
        <p>otro contenido</p>
      </Shell>,
    );
    expect(button).toHaveAttribute('aria-expanded', 'false');

    // Leaving for a shortcut destination closes the menu too.
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    rerender(
      <Shell route={history}>
        <p>otro contenido</p>
      </Shell>,
    );
    expect(button).toHaveAttribute('aria-expanded', 'false');
  } finally {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { value: original, configurable: true, writable: true });
  }
});

// Finding 1 — the sign-out control must remain visible without scrolling, and the
// destinations menu must never be able to occlude it. T10 moved it into the top
// bar: the panel is out of flow and belongs to a separate bar above the shell, so
// an open menu cannot push the control down and a closed menu cannot cover it.
// jsdom has no layout engine: the geometry is measured in a browser, the structure
// and the declarations are pinned here.
test('the sign-out control sits in the header, keeps a 36px target and is never inside the destinations menu (S7)', async () => {
  renderShell();
  await waitFor(() => expect(fetchStub.callsFor(READY_URL)).toHaveLength(1));
  fetchStub.answer(READY_URL, null, 204);
  await waitFor(() => expect(document.querySelector('.health-dot.ready')).not.toBeNull());
  await signIn();
  await waitFor(() => expect(document.getElementById('logout')).not.toHaveAttribute('hidden'));

  const header = document.querySelector('header.topbar');
  const logout = document.getElementById('logout');
  const nav = document.querySelector('.product-nav');
  const menu = document.querySelector('.product-nav__panel');
  expect(header?.contains(logout as Node)).toBe(true);
  expect(nav?.contains(logout as Node)).toBe(false);
  expect(menu?.contains(logout as Node)).toBe(false);

  // The control keeps a real target size on the header surface and the label is
  // the readable ink of that surface.
  const logoutRule = appCss.match(/^\.session-card button \{[^}]*\}/m)?.[0] ?? '';
  expect(logoutRule).not.toBe('');
  expect(Number.parseInt((logoutRule.match(/min-height:\s*(\d+)px/) ?? [])[1] ?? '0', 10)).toBeGreaterThanOrEqual(36);
  expect(logoutRule).toMatch(/color:\s*var\(--ink\)/);

  // The shared focus ring the control inherits is the global focus role.
  expect(appCss).toMatch(/\[tabindex\]:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--focus\)/);
});

// ── T4 correction · the reserved offset follows the real bar ────────────────
// At 320–360 px the four shortcuts and the disclosure wrap onto two rows. Every
// rule that reserves the bar reads `--product-nav-h`: the shell height, the sticky
// sidebar top and the coverage view's `scroll-margin-top`. A fixed 48px would let
// the second row cover content, and cover a commune breakdown the reader just
// focused. The bar therefore publishes its measured box, and keeps the stylesheet's
// 48px fallback when there is nothing to measure (jsdom, or a hidden document).
test('the bar publishes its measured height so a wrapped bar cannot cover content', () => {
  const rect = (height: number) =>
    ({ height, width: 360, top: 0, bottom: height, left: 0, right: 360, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  let barHeight = 89;
  const original = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this instanceof HTMLElement && this.classList.contains('product-nav')) return rect(barHeight);
    return original.call(this);
  });

  const { unmount } = renderShell();
  // Published on `body`: the bar shadows it with its own 48px so a wrapped bar can
  // return to one row when the viewport grows again.
  const root = document.body;
  expect(root.style.getPropertyValue('--product-nav-h')).toBe('89px');

  // A wider window fits one row, and the reserved offset follows it back down.
  barHeight = 48;
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
  expect(root.style.getPropertyValue('--product-nav-h')).toBe('48px');

  // Nothing to measure: the 48px fallback stays instead of reserving nothing.
  barHeight = 0;
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
  expect(root.style.getPropertyValue('--product-nav-h')).toBe('48px');

  // Unmounting restores the stylesheet value for whatever mounts next.
  unmount();
  expect(root.style.getPropertyValue('--product-nav-h')).toBe('');
});
