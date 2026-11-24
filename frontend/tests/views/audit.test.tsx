import { act, render, waitFor } from '@testing-library/react';

import { gatewayOrigin, issuer, pkceTransactionKey } from '../../src/config';
import { completeLogin, getSessionSnapshot, resetSession } from '../../src/core/session';
import { AuditView } from '../../src/views/AuditView';
import type { AuditEntry } from '../../src/types/api';

import {
  createCryptoStub,
  createFetchStub,
  createStorageStub,
  flush,
  jwt,
} from '../core/harness';

// N8b — the activity register (S13/S17/S1/S2). `/v1/audit` is a parameterless,
// admin-only endpoint. The view renders the durable metadata the endpoint now
// carries: its own stable `event_id`, the verified `actor_name` (falling back to
// the opaque `actor_id` when no name was captured), `action`, `event_kind`,
// the free-text `detail`, and the legacy `job_id`, `trace_id` and `occurred_at`.
// An explicit 403 is stated for a non-administrator, and an entry that does not
// say WHAT happened and WHEN fails closed.
//
// The transport, storage and crypto are stubbed exactly as `tests/core/harness.ts`
// establishes; the real `window` stays in place because this is a DOM render.

const AUDIT_URL = `${gatewayOrigin}/v1/audit`;
const TOKEN_URL = `${issuer}/protocol/openid-connect/token`;
const ADMIN_TOKEN = jwt({ realm_access: { roles: ['viewer', 'admin'] } });
const VIEWER_TOKEN = jwt({ realm_access: { roles: ['viewer'] } });

// auditEntry is the shape the service returns for one row. Overrides keep each
// case focused on the field it exercises instead of repeating nine keys.
function auditEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    event_id: 'audit-1',
    actor_id: 'actor-opaco-1',
    actor_name: 'Demo Admin',
    action: 'job.requested',
    event_kind: 'mutation',
    detail: 'Solicitud de trabajo para la zona valparaiso-demo',
    job_id: 'job-1',
    trace_id: 'trace-1',
    occurred_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

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

// `answerAudit` resolves the pending `/v1/audit` request inside `act`, so the
// state update the transport settles is flushed before the assertions run.
async function answerAudit(body: unknown, status = 200, requestId = ''): Promise<void> {
  await act(async () => {
    fetchStub.answer(AUDIT_URL, body, status, requestId);
    await flush();
  });
}

function text(id: string): string {
  return document.getElementById(id)?.textContent ?? '';
}

function badgeText(): string {
  return text('audit-badge');
}

function cells(): string[] {
  return [...document.querySelectorAll('#audit-rows tr td')].map(cell => cell.textContent ?? '');
}

beforeEach(() => {
  setup();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('the audit panel carries the durable event columns and no longer declares them unimplemented', async () => {
  await connect(ADMIN_TOKEN);
  const { container } = render(<AuditView />);

  const section = container.querySelector('section#audit') as HTMLElement | null;
  expect(section).not.toBeNull();
  expect(section).toHaveAttribute('data-view', 'audit');

  for (const id of [
    'audit',
    'audit-title',
    'audit-badge',
    'audit-status',
    'audit-table',
    'audit-rows',
    'audit-count',
    'audit-refresh',
  ]) {
    expect(document.getElementById(id), id).not.toBeNull();
  }

  // The retired mockup's fields now have a backend: the panel must not carry the
  // old "not implemented" note anymore.
  expect(document.getElementById('audit-unimplemented')).toBeNull();
  expect(text('audit-status')).not.toMatch(/Aún no implementado/i);

  await waitFor(() => {
    expect(fetchStub.callsFor(AUDIT_URL)).toHaveLength(1);
  });
  const headerCells = [...document.querySelectorAll('#audit-table thead th')].map(cell => cell.textContent);
  expect(headerCells).toEqual([
    'Evento (event_id)',
    'Actor (nombre o actor_id)',
    'Acción',
    'Tipo',
    'Detalle',
    'Trabajo (job_id)',
    'Traza (trace_id)',
    'Ocurrido (occurred_at)',
  ]);
  expect(document.querySelector('.panel-note')?.textContent).toMatch(/identidad verificada/i);
});

test('the panel reads the parameterless admin endpoint once and renders the durable metadata verbatim', async () => {
  await connect(ADMIN_TOKEN);
  render(<AuditView />);

  await waitFor(() => {
    expect(fetchStub.callsFor(AUDIT_URL)).toHaveLength(1);
  });
  const call = fetchStub.callsFor(AUDIT_URL)[0];
  expect(call.url).toBe(AUDIT_URL);
  expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${ADMIN_TOKEN}`);

  await answerAudit([
    auditEntry(),
    auditEntry({
      event_id: 'audit-2',
      actor_id: 'system',
      actor_name: null,
      action: 'batch.published',
      detail: null,
      job_id: 'job-2',
      trace_id: 'trace-2',
      occurred_at: '2026-01-02T00:00:00Z',
    }),
    auditEntry({
      event_id: 'audit-3',
      actor_id: 'consulta-actor',
      actor_name: 'Demo Viewer',
      action: 'risk.current.read',
      event_kind: 'query',
      detail: 'Consulta del riesgo actual',
      job_id: null,
      trace_id: 'trace-3',
      occurred_at: '2026-01-03T00:00:00Z',
    }),
  ]);

  const rows = [...document.querySelectorAll('#audit-rows tr')];
  expect(rows).toHaveLength(3);
  expect([...rows[0].querySelectorAll('td')].map(cell => cell.textContent)).toEqual([
    'audit-1',
    'Demo Admin',
    'job.requested',
    'Mutación',
    'Solicitud de trabajo para la zona valparaiso-demo',
    'job-1',
    'trace-1',
    '2026-01-01T00:00:00Z',
  ]);
  // No verified name was captured for the system record: the page falls back to
  // the opaque actor_id and never invents a display name.
  expect([...rows[1].querySelectorAll('td')].map(cell => cell.textContent)).toEqual([
    'audit-2',
    'system',
    'batch.published',
    'Mutación',
    'No informado',
    'job-2',
    'trace-2',
    '2026-01-02T00:00:00Z',
  ]);
  // A query record is shown as a query and has no job to show.
  expect([...rows[2].querySelectorAll('td')].map(cell => cell.textContent)).toEqual([
    'audit-3',
    'Demo Viewer',
    'risk.current.read',
    'Consulta',
    'Consulta del riesgo actual',
    'No informado',
    'trace-3',
    '2026-01-03T00:00:00Z',
  ]);
  expect(text('audit-count')).toBe('3');
  expect(badgeText()).toBe('LEÍDO');
  expect(document.getElementById('audit-table')?.hasAttribute('hidden')).toBe(false);
  expect(text('audit-status')).toMatch(/Registro real devuelto por \/v1\/audit/);
  expect((document.getElementById('audit-refresh') as HTMLButtonElement).disabled).toBe(false);

  // Nothing the endpoint does not provide is rendered: no severity and no
  // Spanish gloss of the action enum.
  expect(text('audit-status')).not.toMatch(/severidad|riesgo/i);
});

test('audit 403 renders an explicit admin-only reason instead of hiding the panel', async () => {
  await connect(VIEWER_TOKEN);
  render(<AuditView />);

  await waitFor(() => {
    expect(fetchStub.callsFor(AUDIT_URL)).toHaveLength(1);
  });
  // The transport reads the request id from the `X-Request-ID` response header.
  await answerAudit({ code: 'forbidden' }, 403, 'req-9');

  const status = text('audit-status');
  expect(badgeText()).toBe('SIN PERMISO');
  expect(status).toMatch(/403/);
  expect(status).toMatch(/administrador/i);
  expect(status).toMatch(/forbidden/);
  expect(status).toMatch(/req-9/);
  expect(document.querySelectorAll('#audit-rows tr')).toHaveLength(0);
  expect(document.getElementById('audit-table')?.hasAttribute('hidden')).toBe(true);
  expect(text('audit-count')).toBe('—');
});

test('a viewer reaches the audit view and reads the server 403 instead of being gated by role', async () => {
  await connect(VIEWER_TOKEN);
  const { container } = render(<AuditView />);

  // The view exists and its control is offered to a viewer: the server, not the
  // client, decides the permission.
  expect(container.querySelector('section#audit')).not.toBeNull();
  const refresh = document.getElementById('audit-refresh') as HTMLButtonElement;
  expect(refresh.hidden).toBe(false);

  await waitFor(() => {
    expect(fetchStub.callsFor(AUDIT_URL)).toHaveLength(1);
  });
  expect((fetchStub.callsFor(AUDIT_URL)[0].init.headers as Record<string, string>).Authorization).toBe(
    `Bearer ${VIEWER_TOKEN}`,
  );

  await answerAudit({ code: 'forbidden' }, 403, 'req-viewer');
  expect(badgeText()).toBe('SIN PERMISO');
  expect(text('audit-status')).toMatch(/403/);
  expect(text('audit-status')).toMatch(/req-viewer/);
  expect(refresh.disabled).toBe(false);
});

// expectMalformed drives one fresh render through a response the register must
// refuse as a whole: an unusable body never paints partial or invented rows.
async function expectMalformed(body: unknown): Promise<void> {
  setup();
  await connect(ADMIN_TOKEN);
  const view = render(<AuditView />);
  await waitFor(() => {
    expect(fetchStub.callsFor(AUDIT_URL)).toHaveLength(1);
  });
  await answerAudit(body);
  expect(badgeText()).toBe('NO DISPONIBLE');
  expect(document.querySelectorAll('#audit-rows tr')).toHaveLength(0);
  expect(document.getElementById('audit-table')?.hasAttribute('hidden')).toBe(true);
  view.unmount();
}

test('the register fails closed unless every entry states its own event id, action, time and kind', async () => {
  // A body that is not an array of events is not a register.
  await expectMalformed({ code: 'unexpected' });

  // An entry without an action and a time is not an event: nothing is invented.
  await expectMalformed([{ actor_id: 'a', job_id: 'j', trace_id: 't' }]);

  // The durable event id is required: without it the page cannot key a row.
  await expectMalformed([auditEntry({ event_id: '' })]);

  // The kind is a closed vocabulary, not free text.
  await expectMalformed([
    {
      event_id: 'audit-9',
      actor_id: 'a',
      actor_name: null,
      action: 'cualquier.valor',
      event_kind: 'lectura',
      detail: null,
      job_id: null,
      trace_id: 't',
      occurred_at: '2026-01-01T00:00:00Z',
    },
  ]);
});

test('an omitted nullable field is labelled in place, never filled in from another field', async () => {
  await connect(ADMIN_TOKEN);
  render(<AuditView />);
  await waitFor(() => {
    expect(fetchStub.callsFor(AUDIT_URL)).toHaveLength(1);
  });
  await answerAudit([
    auditEntry({
      event_id: 'audit-9',
      actor_id: 'a',
      actor_name: null,
      action: 'cualquier.valor',
      detail: null,
      job_id: null,
      trace_id: '',
    }),
  ]);
  expect(cells()).toEqual([
    'audit-9',
    'a',
    'cualquier.valor',
    'Mutación',
    'No informado',
    'No informado',
    'No informado',
    '2026-01-01T00:00:00Z',
  ]);
});

test('the refresh control re-reads the same parameterless endpoint and an empty register is a real zero', async () => {
  await connect(ADMIN_TOKEN);
  render(<AuditView />);
  await waitFor(() => {
    expect(fetchStub.callsFor(AUDIT_URL)).toHaveLength(1);
  });
  await answerAudit([auditEntry()]);
  expect(document.querySelectorAll('#audit-rows tr')).toHaveLength(1);

  act(() => {
    (document.getElementById('audit-refresh') as HTMLButtonElement).click();
  });
  await waitFor(() => {
    expect(fetchStub.callsFor(AUDIT_URL)).toHaveLength(2);
  });
  expect(fetchStub.callsFor(AUDIT_URL)[1].url).toBe(AUDIT_URL);
  expect(badgeText()).toBe('CONSULTANDO');

  await answerAudit([]);
  expect(badgeText()).toBe('LEÍDO');
  expect(text('audit-count')).toBe('0');
  expect(document.querySelectorAll('#audit-rows tr')).toHaveLength(0);
  expect(text('audit-status')).toMatch(/sin eventos/);
});

test('closing the session clears the register and a fenced reply cannot repaint it', async () => {
  await connect(ADMIN_TOKEN);
  render(<AuditView />);
  await waitFor(() => {
    expect(fetchStub.callsFor(AUDIT_URL)).toHaveLength(1);
  });
  await answerAudit([auditEntry()]);
  expect(document.querySelectorAll('#audit-rows tr')).toHaveLength(1);

  // Start a read, then close the session while it is in flight.
  act(() => {
    (document.getElementById('audit-refresh') as HTMLButtonElement).click();
  });
  await waitFor(() => {
    expect(fetchStub.callsFor(AUDIT_URL)).toHaveLength(2);
  });
  act(() => {
    resetSession();
  });

  expect(badgeText()).toBe('SIN CONSULTAR');
  expect(document.querySelectorAll('#audit-rows tr')).toHaveLength(0);
  expect(text('audit-count')).toBe('—');
  expect(document.getElementById('audit-table')?.hasAttribute('hidden')).toBe(true);
  expect((document.getElementById('audit-refresh') as HTMLButtonElement).disabled).toBe(true);

  // The late reply owns nothing: it must not repaint the closed panel.
  await answerAudit([auditEntry({ event_id: 'audit-late', actor_id: 'late', action: 'batch.published' })]);
  expect(document.querySelectorAll('#audit-rows tr')).toHaveLength(0);
  expect(badgeText()).toBe('SIN CONSULTAR');
  expect(text('audit-status')).toBe('Conecta un token autorizado para consultar el registro de actividad.');
});

// S2 — a 401 on the admin read carries the bearer, so the register must name the
// rejection instead of showing the first-visit copy.
test('a rejected token is named in the register, never as a first visit (S2)', async () => {
  await connect(ADMIN_TOKEN);
  render(<AuditView />);
  await waitFor(() => {
    expect(fetchStub.callsFor(AUDIT_URL)).toHaveLength(1);
  });

  await answerAudit({ code: 'unauthorized' }, 401);

  expect(getSessionSnapshot()).toEqual({ status: 'signed-out', roles: null, reason: 'rejected' });
  expect(text('audit-status')).not.toBe('Conecta un token autorizado para consultar el registro de actividad.');
  expect(text('audit-status')).toMatch(/rechazó el token/i);
});
