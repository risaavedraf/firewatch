import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { App } from '../../src/App';
import { routes } from '../../src/app/routes';
import { issuer, pkceTransactionKey } from '../../src/config';
import { completeLogin, resetSession } from '../../src/core/session';

import { createCryptoStub, createFetchStub, flush, jwt } from '../core/harness';

// N4 — the nine real areas are now nine views, and exactly one of them is
// rendered at a time. The retired page stacked all nine sections in one scroll,
// which is the symptom the user reported ("puedo scrolleando ver toda la info,
// no por separado").

function navigate(hash: string) {
  window.location.hash = hash;
  act(() => {
    window.dispatchEvent(new Event('hashchange'));
  });
}

function renderedViews(): string[] {
  return [...document.querySelectorAll('[data-view]')].map(node => node.getAttribute('data-view') ?? '');
}

// The workspace is only rendered with an established session (the sign-in screen
// stands in for it otherwise, see `auth.test.tsx`), so every routing test starts
// signed in. The role is irrelevant here: no route depends on it.
const TOKEN_URL = `${issuer}/protocol/openid-connect/token`;

beforeEach(async () => {
  window.location.hash = '';
  const fetchStub = createFetchStub();
  vi.stubGlobal('fetch', fetchStub.fetch);
  vi.stubGlobal('crypto', createCryptoStub());
  window.sessionStorage.setItem(pkceTransactionKey, JSON.stringify({ state: 's', verifier: 'verifier' }));
  const callback = completeLogin('?code=c&state=s');
  await flush();
  fetchStub.answer(TOKEN_URL, { access_token: jwt({ realm_access: { roles: ['viewer'] } }), id_token: jwt({ sub: 'u' }) });
  await callback;
});

afterEach(() => {
  resetSession();
  vi.unstubAllGlobals();
});

test('the fourteen views are declared once, with the two merged pairs, the infrastructure demo and no duplicate hash', () => {
  const ids = routes.map(route => route.id);
  // Declared in navigation order: the four groups are Prevención, Información,
  // Acceso and Coordinación, so `#pending` (Información) precedes `#session`
  // (Acceso) and the sidebar order is the declared order. `#actions` joins
  // Prevención beside the territory and the batch history (T12), and PM-11 adds
  // the dedicated synthetic-infrastructure demo in the same group; `#observations`
  // follows as the PM-09 field-observation page, `#simulator` is the PM-03
  // counterfactual page that explains the rule behind one zone's stored level,
  // `#status` is the PM-16 operational board of the gateway aggregate, first in
  // Información so the verdict precedes the provenance detail `#sources` already
  // carries, and `#notifications` joins Coordinación beside the activity register
  // (PM-08). `#compare` is PM-05's own comparator, declared beside the batch
  // history it compares across zones.
  expect(ids).toEqual([
    'overview',
    'infrastructure',
    'history',
    'compare',
    'actions',
    'observations',
    'simulator',
    'status',
    'sources',
    'jobs',
    'pending',
    'session',
    'notifications',
    'audit',
  ]);
  expect(new Set(ids).size).toBe(ids.length);
  // `#session` carries the permissions matrix and `#sources` carries the pipeline
  // status: the two merged pairs must not survive as their own routes, or the
  // merge would have silently dropped them instead of grouping them.
  expect(ids).not.toContain('permissions');
  expect(ids).not.toContain('pipeline');
});

test('exactly one view is rendered at a time and the default view is the territory', () => {
  render(<App />);

  expect(renderedViews()).toEqual(['overview']);
});

test('an unknown or empty hash normalises to the default view instead of rendering nothing', () => {
  render(<App />);

  navigate('#not-a-real-view');
  expect(renderedViews()).toEqual(['overview']);

  navigate('');
  expect(renderedViews()).toEqual(['overview']);
});

test('every declared view is reachable by its hash and only that one is rendered', () => {
  render(<App />);

  for (const route of routes) {
    navigate(route.hash);
    expect(renderedViews()).toEqual([route.id]);
  }
});

test('the navigation offers every view, including the "not implemented yet" inventory that had no entry', () => {
  render(<App />);

  for (const route of routes) {
    const link = screen.getByRole('link', { name: new RegExp(route.label, 'i') });
    expect(link).toHaveAttribute('href', route.hash);
  }
  // The inventory is the reason this test exists: it was reachable only by
  // scrolling before, and the honesty rule requires it to be visible on its own.
  expect(screen.getByRole('link', { name: /aún no implementado/i })).toHaveAttribute('href', '#pending');
});

// The reported keyboard defect (L20): pressing Enter on the workspace "Saltar al
// contenido" link wrote `#content` into the address bar, the router read that
// undeclared fragment as the default view, and the reader was moved from the view
// they had open to Overview with focus still outside the content. The link is a
// shell concern, so the router keeps its own contract — an unknown fragment still
// normalises to the default view — and what is pinned here is that the shell no
// longer produces one.
test('the skip link keeps the opened view and lands focus in the content region', async () => {
  const user = userEvent.setup();
  render(<App />);

  const skipLink = screen.getByRole('link', { name: /saltar al contenido/i });
  // Both a view other than the default and the default itself: a fallback to
  // Overview is invisible from Overview, which is how the defect stayed hidden.
  for (const hash of ['#audit', '#overview'] as const) {
    navigate(hash);
    expect(renderedViews()).toEqual([hash.slice(1)]);

    skipLink.focus();
    await user.keyboard('{Enter}');

    // The fragment the router reads is still the view that was open...
    expect(window.location.hash).toBe(hash);
    expect(renderedViews()).toEqual([hash.slice(1)]);
    // ...and focus is in the content region instead of left behind.
    expect(document.activeElement).toBe(document.getElementById('content'));
  }
});

test('the active navigation entry follows the opened view and marks nothing else', () => {
  render(<App />);

  navigate('#audit');
  const active = [...document.querySelectorAll('nav a[aria-current="true"]')];
  expect(active).toHaveLength(1);
  expect(active[0]).toHaveAttribute('href', '#audit');
});

test('the notification centre has its own hash and navigation entry', () => {
  render(<App />);

  navigate('#notifications');
  expect(renderedViews()).toEqual(['notifications']);

  const link = screen.getByRole('link', { name: /notificaciones/i });
  expect(link).toHaveAttribute('href', '#notifications');
  expect(link).toHaveAttribute('aria-current', 'true');
});

// PM-05 — the zone comparator is a destination of its own, not a panel inside
// the batch history: comparing two or three zones in one read is a different
// question from one zone's rows.
test('the zone comparator has a dedicated #compare route and navigation entry', () => {
  render(<App />);

  expect(screen.getByRole('link', { name: /comparador/i })).toHaveAttribute('href', '#compare');

  navigate('#compare');
  expect(renderedViews()).toEqual(['compare']);
  expect(document.getElementById('compare-title')?.textContent).toBe('Comparador de zonas');
  expect(screen.getByRole('link', { name: /comparador/i })).toHaveAttribute('aria-current', 'true');
});

// PM-11 — the synthetic infrastructure demo is a dedicated view, not a panel
// appended to the territory overview. It keeps its own hash and navigation entry.
test('the synthetic infrastructure demo has a dedicated #infrastructure route and navigation entry', () => {
  render(<App />);

  expect(screen.getByRole('link', { name: /infraestructura/i })).toHaveAttribute('href', '#infrastructure');

  navigate('#infrastructure');
  expect(renderedViews()).toEqual(['infrastructure']);
  expect(document.getElementById('infrastructure-title')?.textContent).toBe('Infraestructura prioritaria');
  expect(document.getElementById('infrastructure-synthetic')).not.toBeNull();
});

// PM-03 — the counterfactual simulator is a page of its own in the Prevención
// group, not a control hidden inside the territory panel: it explains how the
// rule produced one zone's stored level, and the operator has to be able to reach
// it by its own hash.
test('the counterfactual simulator has a dedicated #simulator route and navigation entry', () => {
  render(<App />);

  const link = screen.getByRole('link', { name: /^simulador$/i });
  expect(link).toHaveAttribute('href', '#simulator');

  navigate('#simulator');
  expect(renderedViews()).toEqual(['simulator']);
  expect(document.getElementById('simulator-title')?.textContent).toBe('Simulador');
  // The D-D label is the view's own statement that the result is the rule, not a
  // forecast: it must be reachable by hash and present without a simulation.
  expect(document.getElementById('simulator-how-title')?.textContent).toBe('Cómo lo calculó la regla');
  expect(link).toHaveAttribute('aria-current', 'true');
});

// PM-16 — the operational verdict is its own destination: one hash, one
// navigation entry in Información, and the board renders its verdict region
// instead of being folded into `#sources`.
test('the operational status board has a dedicated #status route and navigation entry', () => {
  render(<App />);

  const link = screen.getByRole('link', { name: /estado de servicios/i });
  expect(link).toHaveAttribute('href', '#status');

  navigate('#status');
  expect(renderedViews()).toEqual(['status']);
  expect(document.getElementById('status-title')?.textContent).toBe('Estado de servicios');
  expect(document.getElementById('status-verdict-title')?.textContent).toBe('Veredicto operativo');
  expect(link).toHaveAttribute('aria-current', 'true');
});
