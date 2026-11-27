import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { clearZoneState, selectZone } from '../../src/app/store';
import { gatewayOrigin, issuer, pkceTransactionKey } from '../../src/config';
import { completeLogin, resetSession } from '../../src/core/session';
import type { RiskBatch } from '../../src/types/api';
import { ActionsView } from '../../src/views/ActionsView';
import { AuditView } from '../../src/views/AuditView';
import { HistoryView } from '../../src/views/HistoryView';
import { InfrastructureView } from '../../src/views/InfrastructureView';
import { NOT_IMPLEMENTED, PendingView } from '../../src/views/PendingView';
import { PERMISSION_MATRIX, SessionView } from '../../src/views/SessionView';

import { createCryptoStub, createFetchStub, createStorageStub, flush, jwt } from '../core/harness';

// axe-core 4.10.3 reported `scrollable-region-focusable` on `.table-wrap` in
// Actions, Pending, Session (both widths) and Audit at 390 px. The scroll
// container is the wrapper, not the table, so the wrapper is what a keyboard
// user has to reach: Chromium's own scroll-container focus heuristic happened to
// expose it in that engine, which is not behaviour any other browser owes the
// page. The suite pins the DOM contract in the state the browser audit sampled:
// every table wrapper is a Tab stop exposed as a named region, and the tables it
// carries keep the exact content, columns and hidden states they shipped with.
//
// What this cannot establish: that Chromium (or any other engine) paints the
// focus ring and scrolls the region. That half is measured in a real browser.

const ACTIONS_URL = `${gatewayOrigin}/v1/prevention/actions`;
const AUDIT_URL = `${gatewayOrigin}/v1/audit`;
const TOKEN_URL = `${issuer}/protocol/openid-connect/token`;
const ZONE = '05102';
const HISTORY_URL = `${gatewayOrigin}/v1/risk/history?zone_id=${ZONE}`;
const ADMIN_TOKEN = jwt({ realm_access: { roles: ['admin'] } });

// The names the regions must expose. They say what each scroll area holds; a
// bare "tabla" would not tell a screen reader which table it just entered.
const NAMES = {
  actions: 'Listado de acciones preventivas',
  actionHistory: 'Historial de estados de la acción',
  actionEvidence: 'Evidencia registrada de la acción',
  actionReviews: 'Revisión humana de la evidencia',
  actionReassessments: 'Reevaluaciones sintéticas de la acción',
  audit: 'Eventos del registro de actividad',
  history: 'Historial de lotes de la zona',
  pending: 'Capacidades sin respaldo en el backend',
  session: 'Matriz de perfiles y permisos',
} as const;

let fetchStub: ReturnType<typeof createFetchStub>;
let storageStub: ReturnType<typeof createStorageStub>;

function prepare(): void {
  fetchStub = createFetchStub();
  storageStub = createStorageStub();
  vi.stubGlobal('fetch', fetchStub.fetch);
  vi.stubGlobal('sessionStorage', storageStub.storage);
  vi.stubGlobal('crypto', createCryptoStub());
  resetSession();
  clearZoneState();
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

function batch(id: string, overrides: Partial<RiskBatch> = {}): RiskBatch {
  return {
    zone_id: ZONE,
    id,
    job_id: `job-${id}`,
    demo: true,
    risk_level: 'alto',
    factors: [{ name: 'temperatura', known: true, value: 30, contribution: 0.2 }],
    rationale: 'Regla académica',
    policy: { policy_id: 'academic-rule-v1', params_hash: 'hash', parameters: { weight: '0.2' } },
    notice: 'Sintético',
    ...overrides,
  };
}

// The state the browser audit was taken in: one action selected and its detail
// answered, so the list and all four detail tables are rendered.
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

// The contract for one scroll container: same class the stylesheet already
// targets, a Tab stop, and a name that resolves as a landmark.
function scrollRegionOf(table: Element | null, name: string): HTMLElement {
  expect(table, `missing the table region "${name}"`).not.toBeNull();
  const wrapper = (table as Element).parentElement as HTMLElement;
  expect(wrapper, `the table "${name}" must keep its wrapper`).not.toBeNull();
  // The shipped class holds `overflow: auto` and the existing `:focus-visible`
  // ring; a different class would restyle the table and drop both.
  expect(wrapper.className.split(/\s+/)).toContain('table-wrap');
  expect(wrapper).toHaveAttribute('tabindex', '0');
  expect(wrapper).toHaveAttribute('role', 'region');
  expect(wrapper).toHaveAttribute('aria-label', name);
  // Named landmarks resolve by role and name, not by a raw attribute.
  expect(screen.getByRole('region', { name })).toBe(wrapper);
  return wrapper;
}

function tableIn(selector: string): Element | null {
  return document.querySelector(selector)?.closest('table') ?? null;
}

// A wrapper without a name would be a silent Tab stop, and two wrappers with the
// same name would make the landmark ambiguous. Both are read from the DOM so a
// new, unnamed wrapper fails even if this suite does not enumerate it yet.
function expectAllWrappersNamed(expectedCount: number): void {
  const wrappers = [...document.querySelectorAll('.table-wrap')];
  expect(wrappers).toHaveLength(expectedCount);
  const names = wrappers.map(wrapper => wrapper.getAttribute('aria-label')?.trim() ?? '');
  for (const name of names) expect(name).not.toBe('');
  expect(new Set(names).size).toBe(names.length);
}

beforeEach(prepare);

afterEach(() => {
  vi.unstubAllGlobals();
});

test('every actions table is a named, focusable scroll region and keeps its columns and rows', async () => {
  await openAdminWithDetail();

  scrollRegionOf(document.getElementById('actions-table'), NAMES.actions);
  scrollRegionOf(document.getElementById('action-history'), NAMES.actionHistory);
  scrollRegionOf(document.getElementById('action-evidence'), NAMES.actionEvidence);
  scrollRegionOf(document.getElementById('action-evidence-reviews'), NAMES.actionReviews);
  scrollRegionOf(document.getElementById('action-reassessments'), NAMES.actionReassessments);
  expectAllWrappersNamed(5);

  // The correction adds focus and a name; it does not touch the tables.
  expect(document.querySelectorAll('#actions-table thead th')).toHaveLength(7);
  expect(document.querySelectorAll('#actions-table tbody tr')).toHaveLength(1);
  expect(document.querySelector('#actions-table tbody tr td')?.textContent).toContain('Despeje de vegetación');
  expect(document.querySelectorAll('#action-history tbody tr')).toHaveLength(1);
  expect(document.querySelectorAll('#action-evidence tbody tr')).toHaveLength(1);
  expect(document.querySelectorAll('#action-evidence-reviews tbody tr')).toHaveLength(1);
});

test('the audit register is a named scroll region only while the service returned events', async () => {
  await connect();
  render(<AuditView />);
  await waitFor(() => expect(fetchStub.callsFor(AUDIT_URL)).toHaveLength(1));

  // The shipped hidden state is preserved: an empty or unread register keeps the
  // wrapper out of the page instead of exposing an empty scroll area.
  const wrapper = document.getElementById('audit-table') as HTMLElement;
  expect(wrapper).toHaveAttribute('hidden');

  await act(async () => {
    fetchStub.answer(AUDIT_URL, [
      {
        // PM-10 added the decision-log fields: the register now names the event,
        // its kind and its optional detail, so the guard refuses an older row.
        event_id: 'evt-1',
        event_kind: 'query',
        actor_id: 'actor-1',
        actor_name: null,
        action: 'risk.read',
        detail: null,
        job_id: 'job-1',
        trace_id: 'trace-1',
        occurred_at: '2026-11-01T10:00:00Z',
      },
    ]);
    await flush();
  });

  expect(wrapper).not.toHaveAttribute('hidden');
  scrollRegionOf(wrapper.querySelector('table'), NAMES.audit);
  expectAllWrappersNamed(1);
  expect(document.querySelectorAll('#audit-table thead th')).toHaveLength(8);
  expect(document.querySelectorAll('#audit-table tbody tr')).toHaveLength(1);
});

// The infrastructure breakdown arrived with the merge using the plain
// `div.table-wrap` the audit already flagged elsewhere: a scroll container no
// keyboard user can reach. It carries the same contract as the rest.
test('the infrastructure breakdown is a named, focusable scroll region', async () => {
  const INFRA_URL = `${gatewayOrigin}/v1/risk/infrastructure`;
  await connect();
  render(<InfrastructureView />);
  await waitFor(() => expect(fetchStub.callsFor(INFRA_URL)).toHaveLength(1));

  await act(async () => {
    fetchStub.answer(INFRA_URL, {
      source: 'synthetic_fixture',
      points_per_element: 1,
      zones: [
        {
          zone_id: '05101',
          score: 1,
          counts: { colegio: 1, vivienda: 0, hospital: 0, ruta: 0, hidrante: 0 },
          elements: [
            { id: 'colegio-1', type: 'colegio', geometry: { type: 'Point', coordinates: [-71.62, -33.05] } },
          ],
        },
      ],
    });
    await flush();
  });

  const table = document.getElementById('infrastructure-zones') as HTMLElement;
  scrollRegionOf(table, 'Desglose por zona de infraestructura');
  expectAllWrappersNamed(1);
  expect(document.querySelectorAll('#infrastructure-rows tr')).toHaveLength(1);
});

test('the pending inventory is a named scroll region and keeps every declared row', () => {  render(<PendingView />);

  scrollRegionOf(tableIn('#pending tbody'), NAMES.pending);
  expectAllWrappersNamed(1);
  expect(document.querySelectorAll('#pending-rows tr')).toHaveLength(NOT_IMPLEMENTED.length);
  expect(document.querySelectorAll('#pending thead th')).toHaveLength(3);
});

test('the session permissions matrix is a named scroll region and keeps its four columns', () => {
  render(<SessionView />);

  scrollRegionOf(tableIn('#permissions-rows'), NAMES.session);
  expectAllWrappersNamed(1);
  expect(document.querySelectorAll('#permissions-rows tr')).toHaveLength(PERMISSION_MATRIX.length);
  expect(document.querySelectorAll('#permissions table thead th')).toHaveLength(4);
});

test('the history table is a named scroll region and keeps the hidden-until-rows contract', async () => {
  await connect();
  selectZone(ZONE);
  render(<HistoryView />);
  await flush();

  // The stylesheet still hides the wrapper of a panel without rows; the region is
  // named in the DOM but the view must not start claiming it has content.
  const panel = document.querySelector('.history-panel') as HTMLElement;
  expect(panel).not.toHaveClass('has-rows');

  fetchStub.answer(HISTORY_URL, [batch('lote-uno')]);
  await waitFor(() => expect(panel).toHaveClass('has-rows'));

  scrollRegionOf(tableIn('#history-rows'), NAMES.history);
  expectAllWrappersNamed(1);
  expect(document.querySelectorAll('#history-rows tr')).toHaveLength(1);
  // The five visible columns of the migrated board 05 table, in order. The
  // assertion names them instead of counting them: a column that changes place
  // or label is a change to what the reader is told, and the served fields behind
  // them (request instant, publication instant, level, data status, batch id) are
  // five different facts.
  const historyTable = tableIn('#history-rows') as HTMLTableElement;
  const headers = [...historyTable.querySelectorAll('thead th')].map(cell => (cell.textContent ?? '').trim());
  expect(headers).toEqual(['Solicitado', 'Publicado', 'Nivel', 'Estado', 'Lote']);
});
