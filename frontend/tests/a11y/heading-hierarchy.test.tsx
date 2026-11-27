import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { gatewayOrigin, issuer, pkceTransactionKey } from '../../src/config';
import { completeLogin, resetSession } from '../../src/core/session';
import { PanelHeading } from '../../src/components/ui';
import { ActionsView } from '../../src/views/ActionsView';
import { ExecutiveView } from '../../src/views/ExecutiveView';
import { AuditView } from '../../src/views/AuditView';
import { PendingView } from '../../src/views/PendingView';
import { SessionView } from '../../src/views/SessionView';
import { SourcesView } from '../../src/views/SourcesView';

import { createCryptoStub, createFetchStub, createStorageStub, flush, jwt } from '../core/harness';

// The workspace shell states the route with the only `h1` on the page
// (`components/Shell.tsx`), so every view's own first heading sits one level
// below it. The rendered audit found four routes — Actions, Audit, Pending and
// Session — whose only in-view headings started at `h3`, which a screen reader
// announces as a skipped level. Their panels rendered the primitive's default
// `h3` while the views that never used it (Overview, History, Jobs, Sources)
// already stated their title with an `h2`.
//
// What this suite pins, in the rendered DOM a user actually meets:
//   * those four views open at `h2`, and no heading inside a view descends more
//     than one level at a time, so `h1 -> h3` and `h2 -> h4` cannot come back;
//   * the Actions detail and the Session permissions panel keep a hierarchy
//     under the section that owns them, across a populated detail;
//   * the primitive keeps its `h3` default, so a view that did not opt into a
//     level is unchanged;
//   * the title ids, eyebrow labels and controls are the ones that already
//     shipped — the level changed, the interface did not.
//
// jsdom has no layout engine, so the visible typography is pinned at the
// stylesheet the browser receives: opting into `h2` must not inherit the lighter
// global `h2` weight, and the detail's subsections must keep the type they had
// as `h4`. The rendered comparison itself was recorded in a real browser.

const ACTIONS_URL = `${gatewayOrigin}/v1/prevention/actions`;
const AUDIT_URL = `${gatewayOrigin}/v1/audit`;
const EXECUTIVE_URL = `${gatewayOrigin}/v1/risk/executive-summary`;
const TOKEN_URL = `${issuer}/protocol/openid-connect/token`;
const ADMIN_TOKEN = jwt({ realm_access: { roles: ['admin'] } });

const appCss = readFileSync(resolve(process.cwd(), 'src', 'styles', 'app.css'), 'utf8');

let fetchStub: ReturnType<typeof createFetchStub>;
let storageStub: ReturnType<typeof createStorageStub>;

function prepare(): void {
  fetchStub = createFetchStub();
  storageStub = createStorageStub();
  vi.stubGlobal('fetch', fetchStub.fetch);
  vi.stubGlobal('sessionStorage', storageStub.storage);
  vi.stubGlobal('crypto', createCryptoStub());
  resetSession();
}

async function connect(): Promise<void> {
  storageStub.storage.setItem(pkceTransactionKey, JSON.stringify({ state: 's', verifier: 'verifier' }));
  const login = completeLogin('?code=code-1&state=s');
  await flush();
  fetchStub.answer(TOKEN_URL, { access_token: ADMIN_TOKEN, id_token: 'id-token' });
  await login;
  fetchStub.calls.length = 0;
}

function actionFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'action-1',
    community_code: '05101',
    title: 'Despeje de vegetación',
    description: 'Franja de 30 m',
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

// A signed-in admin with one action selected and its detail answered: the state
// the browser audit was taken in, where the detail panel and its subsections are
// actually on screen.
async function openAdminWithDetail(): Promise<void> {
  await connect();
  render(<ActionsView />);
  await waitFor(() => expect(fetchStub.callsFor(ACTIONS_URL)).toHaveLength(1));
  await act(async () => {
    fetchStub.answer(ACTIONS_URL, [actionFixture()]);
    await flush();
  });
  await userEvent.click(document.querySelector('[data-action-id="action-1"]') as HTMLElement);
  await waitFor(() => expect(fetchStub.callsFor(`${ACTIONS_URL}/action-1`)).toHaveLength(1));
  await act(async () => {
    fetchStub.answer(`${ACTIONS_URL}/action-1`, {
      ...actionFixture(),
      history: [
        {
          id: 1,
          action_id: 'action-1',
          from_status: null,
          to_status: 'propuesta',
          actor_sub: 'actor-1',
          note: 'alta',
          created_at: '2026-10-17T10:00:00Z',
        },
      ],
      evidence: [
        {
          id: 5,
          action_id: 'action-1',
          criterion: 'Acta de la junta',
          references: ['https://example.org/acta'],
          created_by: 'admin-1',
          created_at: '2026-10-18T12:00:00Z',
        },
      ],
      evidence_reviews: [
        {
          id: 1,
          action_id: 'action-1',
          evidence_id: 5,
          decision: 'suficiente',
          reviewer_sub: 'reviewer-1',
          note: 'revisado',
          reviewed_at: '2026-10-18T12:05:00Z',
        },
      ],
      reassessments: [],
      evidence_sufficient: true,
    });
    await flush();
  });
}

function headingsIn(container: HTMLElement): HTMLElement[] {
  return within(container).getAllByRole('heading') as HTMLElement[];
}

function levelOf(heading: HTMLElement): number {
  return Number(heading.tagName.slice(1));
}

// The rule the browser audit failed: the shell owns the only `h1`, so a view
// starts at `h2` and each following heading may descend one level at most.
function expectCoherentHierarchy(container: HTMLElement, view: string): void {
  const headings = headingsIn(container);
  expect(headings.length, `${view} must expose its headings`).toBeGreaterThan(0);

  const levels = headings.map(levelOf);
  expect(levels[0], `${view}: the first heading must be level 2 under the shell h1`).toBe(2);
  expect(levels, `${view} must not repeat the shell's level 1`).not.toContain(1);

  levels.forEach((level, index) => {
    if (index === 0) return;
    expect(
      level,
      `${view}: "${headings[index].textContent}" jumps from level ${levels[index - 1]} to ${level}`,
    ).toBeLessThanOrEqual(levels[index - 1] + 1);
  });
}

function ruleFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(appCss);
  expect(match, `missing stylesheet rule for ${selector}`).not.toBeNull();
  return (match as RegExpExecArray)[1].replace(/\s+/g, ' ');
}

beforeEach(prepare);

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── The four views the audit flagged ───────────────────────────────────────

test('the actions view, with a populated detail, opens at level 2 and nests the detail under it', async () => {
  await openAdminWithDetail();
  const view = document.getElementById('actions') as HTMLElement;
  expectCoherentHierarchy(view, 'actions');

  // The list title is the section's own label: same id, same words, one level up.
  expect(screen.getByRole('heading', { level: 2, name: 'Acciones preventivas' })).toHaveAttribute(
    'id',
    'actions-title',
  );
  expect(screen.getByRole('heading', { level: 2, name: 'Despeje de vegetación' })).toHaveAttribute(
    'id',
    'action-detail-title',
  );
  expect(screen.getByRole('heading', { level: 2, name: 'Nueva acción preventiva' })).toHaveAttribute(
    'id',
    'action-create-title',
  );

  // The detail's subsections are sections of the detail, so they sit one level
  // below it instead of skipping from the detail's level straight to h4.
  for (const name of [
    'Historial',
    'Evidencia y suficiencia',
    'Revisión humana de suficiencia',
    'Reevaluación sintética',
    'Transiciones',
  ]) {
    expect(screen.getByRole('heading', { level: 3, name }), name).toBeInTheDocument();
  }

  // The eyebrows and the controls the view shipped are untouched: only the
  // level of the title changed.
  expect(document.querySelector('#actions .panel-heading .eyebrow')).toHaveTextContent('PREVENCIÓN');
  expect(document.getElementById('actions-badge')).not.toBeNull();
  expect(document.getElementById('action-detail')).toHaveAttribute('aria-labelledby', 'action-detail-title');
  for (const id of ['record-evidence', 'transition-note', 'create-action']) {
    expect(document.getElementById(id), id).not.toBeNull();
  }
});

test('the audit view opens at level 2 under the shell h1', async () => {
  await connect();
  const { container } = render(<AuditView />);
  await waitFor(() => expect(fetchStub.callsFor(AUDIT_URL)).toHaveLength(1));
  await act(async () => {
    fetchStub.answer(AUDIT_URL, []);
    await flush();
  });

  expectCoherentHierarchy(container.querySelector('#audit') as HTMLElement, 'audit');
  expect(screen.getByRole('heading', { level: 2, name: 'Registro de actividad' })).toHaveAttribute(
    'id',
    'audit-title',
  );
  expect(document.querySelector('#audit .eyebrow')).toHaveTextContent('COORDINACIÓN');

  // T7 — the head stays inside the card the panel modifier pads, and the new
  // response legend is a section of the register one level below it.
  expect(document.getElementById('audit-head')?.contains(document.getElementById('audit-title'))).toBe(true);
  expect(screen.getByRole('heading', { level: 3, name: 'Qué declara cada respuesta' })).toHaveAttribute(
    'id',
    'audit-states-title',
  );
});

test('the pending view opens at level 2 under the shell h1', () => {
  const { container } = render(<PendingView />);

  expectCoherentHierarchy(container.querySelector('#pending') as HTMLElement, 'pending');
  expect(screen.getByRole('heading', { level: 2, name: 'Aún no implementado' })).toHaveAttribute(
    'id',
    'pending-title',
  );
  expect(document.querySelector('#pending .eyebrow')).toHaveTextContent('ALCANCE DE ESTA ENTREGA');
  // T7 — the board 19 head is the panel's own head, so the title keeps its place
  // and its level; only the lede and the count were added under it.
  expect(document.getElementById('pending-head')?.querySelector('h2#pending-title')).not.toBeNull();
});

// T4 — the executive route opens at level 2 and composes the server panel under
// it: the view states where the reader is, the panel states what it read, and the
// blocks below are the panel's sections. The levels band moved the counts into a
// list, so the band's own heading is what keeps the descent coherent.
test('the executive view opens at level 2 and keeps the server panel under it', async () => {
  await connect();
  const { container } = render(<ExecutiveView />);
  await waitFor(() => expect(fetchStub.callsFor(EXECUTIVE_URL)).toHaveLength(1));
  await act(async () => {
    fetchStub.answer(EXECUTIVE_URL, {
      coverage: { catalogue_zones: 3, zones_without_batch: 1, stale_zones: 0, demo_zones: 0 },
      levels: { alto: 1, medio: 1, bajo: 0, desconocido: 0 },
      delta: {
        zones_compared: 1,
        zones_changed: 0,
        zones_without_previous: 1,
        zones_incomparable: 0,
        transitions: [],
      },
      predominant_variables: [{ name: 'viento', zones: 1 }],
      critical_zones: { count: 1, zone_ids: ['05101'] },
      active_alerts: { count: 0 },
    });
    await flush();
  });

  const view = container.querySelector('#executive') as HTMLElement;
  expectCoherentHierarchy(view, 'executive');
  expect(screen.getByRole('heading', { level: 2, name: 'Panel ejecutivo' })).toHaveAttribute(
    'id',
    'executive-view-title',
  );
  expect(screen.getByRole('heading', { level: 3, name: 'Panel ejecutivo' })).toHaveAttribute(
    'id',
    'executive-title',
  );
  for (const name of [
    'Niveles',
    'Cobertura',
    'Variación reciente',
    'Variables predominantes',
    'Zonas críticas',
    'Alertas registradas',
  ]) {
    expect(screen.getByRole('heading', { level: 4, name }), name).toBeInTheDocument();
  }
  expect(document.querySelector('#executive .eyebrow')).toHaveTextContent('PANEL EJECUTIVO');
});

test('the session view opens at level 2 and keeps the permissions matrix under its own panel', async () => {
  await connect();
  const { container } = render(<SessionView />);
  const view = container.querySelector('#session') as HTMLElement;
  expectCoherentHierarchy(view, 'session');

  expect(screen.getByRole('heading', { level: 2, name: 'Sesión y permisos' })).toHaveAttribute(
    'id',
    'session-title',
  );
  expect(screen.getByRole('heading', { level: 3, name: 'Tu cuenta' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 3, name: 'Perfiles y permisos' })).toHaveAttribute(
    'id',
    'permissions-title',
  );
  // The matrix is a section of the permissions panel, not a sibling of the
  // view title: level 4 stays correct once the panel is at level 3.
  expect(screen.getByRole('heading', { level: 4, name: 'Matriz de perfiles y permisos' })).toBeInTheDocument();

  expect(document.getElementById('permissions')).toHaveAttribute('aria-labelledby', 'permissions-title');
  for (const id of ['session-roles', 'permissions-rows', 'account-console']) {
    expect(document.getElementById(id), id).not.toBeNull();
  }

  // T7 — the view head owns the level-2 title, and the two documentation blocks
  // added under the panels are level-3 sections, so the descent stays one step
  // at a time after the matrix's level-4 heading.
  expect(document.getElementById('session-head')?.querySelector('h2#session-title')).not.toBeNull();
  expect(screen.getByRole('heading', { level: 3, name: 'Cómo se verifica el rol' })).toHaveAttribute(
    'id',
    'session-verification-title',
  );
  expect(screen.getByRole('heading', { level: 3, name: 'Qué no hace esta vista' })).toHaveAttribute(
    'id',
    'session-limits-title',
  );
});

// ── The primitive and the views that did not opt in ────────────────────────

test('PanelHeading keeps level 3 unless a view asks for another level', () => {
  const { unmount } = render(
    <PanelHeading
      eyebrow="CONSUMIDOR SIN CAMBIOS"
      title="Título por defecto"
      titleId="default-panel-title"
      badge={<span id="default-panel-badge">CONTEO</span>}
    />,
  );

  const byDefault = screen.getByRole('heading', { level: 3, name: 'Título por defecto' });
  expect(byDefault).toHaveAttribute('id', 'default-panel-title');
  expect(byDefault).toHaveClass('panel-heading-title');
  expect(screen.getByText('CONSUMIDOR SIN CAMBIOS')).toHaveClass('eyebrow');
  expect(document.getElementById('default-panel-badge')).toHaveTextContent('CONTEO');

  unmount();

  render(<PanelHeading level={2} eyebrow="CONSUMIDOR QUE OPTA" title="Título explícito" titleId="opt-in-panel-title" />);
  const optedIn = screen.getByRole('heading', { level: 2, name: 'Título explícito' });
  expect(optedIn).toHaveAttribute('id', 'opt-in-panel-title');
  expect(optedIn).toHaveClass('panel-heading-title');
});

test('a view that did not opt into a level keeps its panel headings at level 3', () => {
  const { container } = render(<SourcesView />);

  expectCoherentHierarchy(container.querySelector('#sources') as HTMLElement, 'sources');
  expect(screen.getByRole('heading', { level: 2, name: 'Fuentes y servicios' })).toHaveAttribute(
    'id',
    'sources-title',
  );
  // T7 — the board 15 head carries the view title; the panels below it keep the
  // default level the primitive shipped.
  expect(document.getElementById('sources-head')?.querySelector('h2#sources-title')).not.toBeNull();
  // PM-16 renamed this panel to its operational verdict; the heading level is
  // still the default one, which is what this case pins.
  for (const name of ['Fuentes y procedencia', 'Servicios y veredicto operativo', 'Frescura y última ejecución']) {
    expect(screen.getByRole('heading', { level: 3, name }), name).toBeInTheDocument();
  }
});

// ── Typography the level must not change ───────────────────────────────────

test('the opt-in level keeps the shipped panel title and detail subsection type', () => {
  // The panel title kept its size and spacing before the level was available.
  const panelTitle = ruleFor('.panel-heading h3, .panel-heading h2');
  expect(panelTitle).toContain('margin: 0');
  expect(panelTitle).toContain('font-size: 15px');
  expect(panelTitle).toContain('letter-spacing: -.3px');

  // The global `h2` rule is lighter (600) than `h3` (650), so the primitive's
  // own title carries its weight instead of inheriting the level's.
  expect(ruleFor('.panel-heading .panel-heading-title')).toContain('font-weight: 650');

  // The detail's subsections moved from `h4` to `h3` for the hierarchy; they keep
  // the type they were rendered with.
  const detailSection = ruleFor('.actions-detail > h3');
  expect(detailSection).toContain('font-size: 11px');
  expect(detailSection).toContain('font-weight: 700');
  expect(detailSection).toContain('letter-spacing: -.1px');
  expect(detailSection).toContain('margin-bottom: 7px');
});
