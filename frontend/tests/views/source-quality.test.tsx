import { fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { clearZoneState } from '../../src/app/store';
import { gatewayOrigin, issuer, pkceTransactionKey } from '../../src/config';
import { completeLogin, resetSession } from '../../src/core/session';
import { SourcesView } from '../../src/views/SourcesView';

import { createFetchStub, createStorageStub, flush, jwt } from '../core/harness';
import { qualityCatalogFixture, sourceEntryFixture, sourceReviewFixture } from '../support/source-quality';

// V1-P-05 — the quality catalogue and the review action of `#sources`.
//
// The page publishes the five-finding catalogue the API serves, the findings of
// each source, the review currently in force and accessible controls that ask the
// server to record a new one. Nothing here decides a permission: the role the token
// declares decides which controls are offered, and the server decides whether the
// write happens. The transport is stubbed end to end, so a failure can never be
// papered over with fixture data.

const TOKEN_URL = `${issuer}/protocol/openid-connect/token`;
const SOURCES_URL = `${gatewayOrigin}/v1/risk/sources`;
const RISK_STATUS_URL = `${gatewayOrigin}/v1/risk/status`;
const JOBS_STATUS_URL = `${gatewayOrigin}/v1/jobs/status`;
const MODELS_URL = `${gatewayOrigin}/v1/models`;
const READY_URL = `${gatewayOrigin}/health/ready`;
const REVIEW_URL = `${SOURCES_URL}/fixture-sample/review`;

const QUALITY_LABELS: Record<string, RegExp> = {
  STALE_CUTOFF: /Fuera de la ventana de frescura/,
  MISSING_CANONICAL_FACTOR: /Factor canónico ausente/,
  OUT_OF_RANGE_CLAMPED: /Valor fuera de rango, acotado/,
  CHECKSUM_VERIFIED: /Integridad SHA-256 verificada/,
  SYNTHETIC_FALLBACK: /Insumo sintético declarado/,
};

function provenanceBody(): Record<string, unknown> {
  return {
    geography: {
      provenance: {
        provider: 'MOP - IDE Chile (SERVICIO_DPA, capa Comunas)',
        attribution: 'Atribución literal de la fuente',
        restriction: 'Restricción literal de la fuente',
        record_count: 38,
        derived_sha256: 'c'.repeat(64),
      },
      source_cutoff_at: null,
      cutoff_semantics: 'retrieval_substitution: stored cutoff equals retrieved',
      integrity: { algorithm: 'sha256', matches: true },
    },
    risk_input: { synthetic: true, display_name: 'Perfil académico', id: 'fixture-sample' },
    quality_catalog: qualityCatalogFixture(),
    sources: [sourceEntryFixture()],
  };
}

function statusBody(): Record<string, unknown> {
  return {
    ready: true,
    reason: '',
    checked_at: new Date().toISOString(),
    dependencies: {
      database: { state: 'ready' },
      broker: { state: 'ready' },
      dead_letter: { state: 'ready', depth: 0, max_depth: 1, age_seconds: 0, max_age_seconds: 120 },
    },
  };
}

function modelRegistryBody(): Record<string, unknown> {
  return { models: [], effective: { status: 'unavailable' } };
}

interface ReadsOverrides {
  provenance?: unknown;
  sourcesReads?: unknown;
}

function prepare(): { fetchStub: ReturnType<typeof createFetchStub>; storageStub: ReturnType<typeof createStorageStub> } {
  const fetchStub = createFetchStub();
  const storageStub = createStorageStub();
  vi.stubGlobal('fetch', fetchStub.fetch);
  vi.stubGlobal('sessionStorage', storageStub.storage);
  return { fetchStub, storageStub };
}

// Every settled assertion answers all five reads of the bounded cycle, so a pending
// request can never leave the view half-painted.
function answerReads(fetchStub: ReturnType<typeof createFetchStub>, overrides: ReadsOverrides = {}): void {
  fetchStub.answer(SOURCES_URL, overrides.provenance ?? provenanceBody());
  fetchStub.answer(RISK_STATUS_URL, statusBody());
  fetchStub.answer(JOBS_STATUS_URL, statusBody());
  fetchStub.answer(MODELS_URL, modelRegistryBody());
  fetchStub.answer(READY_URL, null, 204);
  void overrides.sourcesReads;
}

async function connect(role: 'viewer' | 'admin' = 'viewer'): Promise<ReturnType<typeof prepare>> {
  const context = prepare();
  const token = jwt({ realm_access: { roles: [role] } });
  context.storageStub.storage.setItem(pkceTransactionKey, JSON.stringify({ state: 's', verifier: 'v' }));
  const login = completeLogin('?code=code-1&state=s');
  await flush();
  context.fetchStub.answer(TOKEN_URL, { access_token: token });
  await login;
  context.fetchStub.calls.length = 0;
  return context;
}

function text(id: string): string {
  return document.getElementById(id)?.textContent ?? '';
}

beforeEach(() => {
  resetSession();
  clearZoneState();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('the five-finding catalogue is published with its Spanish descriptions (V1-P-05)', async () => {
  const { fetchStub } = await connect();
  render(<SourcesView />);
  await flush();
  answerReads(fetchStub);
  await waitFor(() => expect(text('sources-badge')).toBe('PUBLICADA'));

  const catalog = document.getElementById('quality-catalog') as HTMLElement | null;
  expect(catalog).not.toBeNull();
  const items = [...(catalog as HTMLElement).querySelectorAll('li')];
  expect(items).toHaveLength(5);
  for (const [index, definition] of qualityCatalogFixture().entries()) {
    expect(items[index]).toHaveTextContent(definition.code);
    expect(items[index]).toHaveTextContent(definition.description);
    expect(items[index]).toHaveTextContent(definition.severity === 'warning' ? /Aviso/ : /Informativo/);
  }
});

test('a source publishes its findings as labelled badges, in catalogue order (V1-P-05)', async () => {
  const { fetchStub } = await connect();
  render(<SourcesView />);
  await flush();
  fetchStub.answer(SOURCES_URL, {
    ...provenanceBody(),
    sources: [
      sourceEntryFixture({
        quality_findings: ['STALE_CUTOFF', 'CHECKSUM_VERIFIED', 'SYNTHETIC_FALLBACK'],
      }),
    ],
  });
  fetchStub.answer(RISK_STATUS_URL, statusBody());
  fetchStub.answer(JOBS_STATUS_URL, statusBody());
  fetchStub.answer(MODELS_URL, modelRegistryBody());
  fetchStub.answer(READY_URL, null, 204);
  await waitFor(() => expect(text('sources-badge')).toBe('PUBLICADA'));

  const table = document.getElementById('quality-sources') as HTMLElement | null;
  expect(table).not.toBeNull();
  const rows = [...(table as HTMLElement).querySelectorAll('tbody tr')];
  expect(rows).toHaveLength(1);
  expect(rows[0]).toHaveTextContent('fixture-sample');
  const badges = [...rows[0].querySelectorAll('[data-quality-finding]')].map(badge =>
    badge.getAttribute('data-quality-finding'),
  );
  // The order the service published is the order the page shows.
  expect(badges).toEqual(['STALE_CUTOFF', 'CHECKSUM_VERIFIED', 'SYNTHETIC_FALLBACK']);
  for (const code of badges as string[]) {
    expect(rows[0]).toHaveTextContent(QUALITY_LABELS[code]);
  }
  // A finding is never conveyed by colour alone: the severity is written too.
  expect(rows[0]).toHaveTextContent(/Aviso/);
  expect(rows[0]).toHaveTextContent(/Informativo/);
});

test('the review in force states its decision, actor, instant and note (V1-P-05)', async () => {
  const { fetchStub } = await connect();
  render(<SourcesView />);
  await flush();
  fetchStub.answer(SOURCES_URL, {
    ...provenanceBody(),
    sources: [sourceEntryFixture({ review: sourceReviewFixture() })],
  });
  fetchStub.answer(RISK_STATUS_URL, statusBody());
  fetchStub.answer(JOBS_STATUS_URL, statusBody());
  fetchStub.answer(MODELS_URL, modelRegistryBody());
  fetchStub.answer(READY_URL, null, 204);
  await waitFor(() => expect(text('sources-badge')).toBe('PUBLICADA'));

  const current = document.getElementById('source-review-current');
  expect(current).not.toBeNull();
  expect(current).toHaveTextContent(/incorporad/i);
  expect(current).toHaveTextContent('operator@example.test');
  expect(current).toHaveTextContent('2026-11-20T12:05:00Z');
  expect(current).toHaveTextContent('revisado por operación');

  // The note field is labelled, bounded and not a hidden control.
  const note = document.getElementById('source-review-note') as HTMLInputElement;
  expect(document.querySelector(`label[for="${note.id}"]`)).not.toBeNull();
  expect(note.maxLength).toBe(500);
});

test('an admin records a review and the source state is refreshed (V1-P-05)', async () => {
  const { fetchStub } = await connect('admin');
  render(<SourcesView />);
  await flush();
  answerReads(fetchStub);
  await waitFor(() => expect(text('sources-badge')).toBe('PUBLICADA'));

  const note = document.getElementById('source-review-note') as HTMLInputElement;
  fireEvent.change(note, { target: { value: 'revisado por operación' } });
  fireEvent.click(document.getElementById('source-review-incorporated') as HTMLButtonElement);
  await flush();

  const calls = fetchStub.callsFor(REVIEW_URL);
  expect(calls).toHaveLength(1);
  expect(calls[0].init.method).toBe('POST');
  expect(JSON.parse(String(calls[0].init.body))).toEqual({
    decision: 'incorporated',
    note: 'revisado por operación',
  });
  // The actor is not in the body: the JWT carries it and the server reads it there.
  expect(String(calls[0].init.body)).not.toMatch(/reviewed_by/);

  // The write refreshes the served state instead of painting its own answer.
  const readsBefore = fetchStub.callsFor(SOURCES_URL).length;
  fetchStub.answer(REVIEW_URL, sourceReviewFixture({ note: 'revisado por operación' }));
  await waitFor(() => expect(fetchStub.callsFor(SOURCES_URL).length).toBeGreaterThan(readsBefore));
  answerReads(fetchStub);
  await waitFor(() => expect(text('source-review-notice')).toMatch(/incorporad/i));
  expect(text('source-review-notice')).toContain('operator@example.test');
});

test('a viewer sees the controls disabled and no client-side permission is claimed (V1-P-05)', async () => {
  const { fetchStub } = await connect();
  render(<SourcesView />);
  await flush();
  answerReads(fetchStub);
  await waitFor(() => expect(text('sources-badge')).toBe('PUBLICADA'));

  const incorporated = document.getElementById('source-review-incorporated') as HTMLButtonElement;
  const acknowledged = document.getElementById('source-review-acknowledged') as HTMLButtonElement;
  expect(incorporated).toBeDisabled();
  expect(acknowledged).toBeDisabled();
  expect((document.getElementById('source-review-note') as HTMLInputElement).disabled).toBe(true);
  expect(document.getElementById('source-review-controls')?.textContent).toMatch(/administrador/i);
  // Nothing was written: the control is disabled, and no request was attempted.
  expect(fetchStub.callsFor(REVIEW_URL)).toHaveLength(0);
});

test('a refused review is stated as not recorded and never as written (V1-P-05)', async () => {
  const { fetchStub } = await connect('admin');
  render(<SourcesView />);
  await flush();
  answerReads(fetchStub);
  await waitFor(() => expect(text('sources-badge')).toBe('PUBLICADA'));

  fireEvent.click(document.getElementById('source-review-acknowledged') as HTMLButtonElement);
  await flush();
  fetchStub.answer(REVIEW_URL, { code: 'invalid_note', request_id: '00000000-0000-4000-8000-000000000000' }, 422);
  await waitFor(() => expect(text('source-review-notice')).toMatch(/no se registró/i));
  expect(text('source-review-notice')).toContain('invalid_note');
  expect(text('source-review-notice')).not.toMatch(/registrad[ao] por el servidor/i);
});

// `503 review_audit_unavailable` is the ONE answer of this write that is not a
// refusal: the published contract states the review WAS persisted and only its audit
// event could not be recorded. The panel must say exactly that - never "no se
// registró" - and must read the stored state back, so the decision the server holds
// is displayed instead of the one the form sent.
test('an audit failure states that the review was stored and reads it back (V1-P-05)', async () => {
  const { fetchStub } = await connect('admin');
  render(<SourcesView />);
  await flush();
  answerReads(fetchStub);
  await waitFor(() => expect(text('sources-badge')).toBe('PUBLICADA'));

  const readsBefore = fetchStub.callsFor(SOURCES_URL).length;
  fireEvent.click(document.getElementById('source-review-incorporated') as HTMLButtonElement);
  await flush();
  fetchStub.answer(
    REVIEW_URL,
    { code: 'review_audit_unavailable', request_id: '00000000-0000-4000-8000-000000000000' },
    503,
  );

  // The distinct message: the decision is stored, the audit event is not.
  await waitFor(() => expect(text('source-review-notice')).toMatch(/quedó registrada/i));
  expect(text('source-review-notice')).toMatch(/auditoría/i);
  expect(text('source-review-notice')).toContain('review_audit_unavailable');
  expect(text('source-review-notice')).not.toMatch(/no se registró/i);
  // A stored decision is not painted as a failure.
  expect(document.getElementById('source-review-notice')).not.toHaveClass('risk-error');

  // The stored review is READ BACK: the panel does not assume the decision it sent.
  await waitFor(() => expect(fetchStub.callsFor(SOURCES_URL).length).toBeGreaterThan(readsBefore));
  fetchStub.answer(
    SOURCES_URL,
    { ...provenanceBody(), sources: [sourceEntryFixture({ review: sourceReviewFixture({ decision: 'incorporated' }) })] },
  );
  fetchStub.answer(RISK_STATUS_URL, statusBody());
  fetchStub.answer(JOBS_STATUS_URL, statusBody());
  fetchStub.answer(MODELS_URL, modelRegistryBody());
  fetchStub.answer(READY_URL, null, 204);
  await waitFor(() => expect(text('source-review-current')).toMatch(/incorporad/i));
  expect(text('source-review-current')).toContain('operator@example.test');
});

// The opposite case, pinned next to it so the two answers cannot be confused:
// `review_store_unavailable` means NOTHING was written, so the panel says so and does
// not re-read a state it did not change.
test('a missing store states that nothing was written and does not re-read (V1-P-05)', async () => {
  const { fetchStub } = await connect('admin');
  render(<SourcesView />);
  await flush();
  answerReads(fetchStub);
  await waitFor(() => expect(text('sources-badge')).toBe('PUBLICADA'));

  const readsBefore = fetchStub.callsFor(SOURCES_URL).length;
  fireEvent.click(document.getElementById('source-review-acknowledged') as HTMLButtonElement);
  await flush();
  fetchStub.answer(
    REVIEW_URL,
    { code: 'review_store_unavailable', request_id: '00000000-0000-4000-8000-000000000000' },
    503,
  );

  await waitFor(() => expect(text('source-review-notice')).toMatch(/no se registró/i));
  expect(text('source-review-notice')).toContain('review_store_unavailable');
  expect(text('source-review-notice')).not.toMatch(/quedó registrada/i);
  expect(document.getElementById('source-review-notice')).toHaveClass('risk-error');
  // No refresh was triggered, so the read count did not grow.
  await flush();
  expect(fetchStub.callsFor(SOURCES_URL)).toHaveLength(readsBefore);
});
