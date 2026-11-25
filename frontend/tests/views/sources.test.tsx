import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { clearZoneState } from '../../src/app/store';
import { gatewayOrigin, issuer, pkceTransactionKey, timing } from '../../src/config';
import { completeLogin, resetSession } from '../../src/core/session';
import { SourcesView } from '../../src/views/SourcesView';

import { createFetchStub, createStorageStub, flush, jwt } from '../core/harness';

// N8b — the sources + services view. It carries the scope declaration (S15),
// reproduces the provenance fields verbatim, reproduces the restriction text
// without paraphrasing, and only reports a service as verified when the domain
// rule says its own snapshot earns it. It stubs `fetch` end to end so a failure
// can never be papered over with fixture data.

const TOKEN_URL = `${issuer}/protocol/openid-connect/token`;
const SOURCES_URL = `${gatewayOrigin}/v1/risk/sources`;
const RISK_STATUS_URL = `${gatewayOrigin}/v1/risk/status`;
const JOBS_STATUS_URL = `${gatewayOrigin}/v1/jobs/status`;
const MODELS_URL = `${gatewayOrigin}/v1/models`;
const READY_URL = `${gatewayOrigin}/health/ready`;

// The registry row the demo migration seeds: active WITHOUT an activation record.
// `backend/docs/model-activation.md` is explicit that this flag is lifecycle
// metadata, not the classifier the runtime selected, so it is the default fixture
// for every test that is not about the effective-rule branch itself.
// The authoritative `effective` object of GET /v1/models is the ONLY identity
// source. `models` remains in the envelope (and is deliberately hostile in some
// tests) so a raw registry row can never verify anything on its own.
const RULE_HASH = 'e17aaa5600eb67c9a91340e90057aec100f4e80ef0895662f373cffee66564c7';
const EFFECTIVE_RULE = { status: 'rule', version: 'academic-rule-v1', params_hash: RULE_HASH };

function registryRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 'academic-rule-v1',
    kind: 'rule',
    params_hash: RULE_HASH,
    approved_at: null,
    metrics: { official: false, calibrated_against_observed_fires: false },
    active: true,
    ...overrides,
  };
}

function modelRegistryBody(
  effective: unknown = { status: 'unavailable' },
  rowOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { models: [registryRow(rowOverrides)], effective };
}

interface ReadsOverrides {
  provenance?: unknown;
  provenanceStatus?: number;
  risk?: unknown;
  jobs?: unknown;
  jobsStatus?: number;
  models?: unknown;
  modelsStatus?: number;
  gatewayStatus?: number;
}

// PM-16 adds two reads to the same bounded cycle: the model registry (effective
// rule identity) and the unauthenticated gateway probe. Every settled assertion
// answers all five so a pending request can never leave the view half-painted.
function answerReads(fetchStub: ReturnType<typeof createFetchStub>, overrides: ReadsOverrides = {}): void {
  fetchStub.answer(SOURCES_URL, overrides.provenance ?? provenanceBody(), overrides.provenanceStatus ?? 200);
  fetchStub.answer(RISK_STATUS_URL, overrides.risk ?? statusBody());
  fetchStub.answer(JOBS_STATUS_URL, overrides.jobs ?? statusBody(), overrides.jobsStatus ?? 200);
  fetchStub.answer(MODELS_URL, overrides.models ?? modelRegistryBody(), overrides.modelsStatus ?? 200);
  fetchStub.answer(READY_URL, null, overrides.gatewayStatus ?? 204);
}

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
    risk_input: { synthetic: true, display_name: 'Perfil académico', id: 'academic' },
  };
}

function statusBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ready: true,
    reason: '',
    checked_at: new Date().toISOString(),
    dependencies: {
      database: { state: 'ready' },
      broker: { state: 'ready' },
      dead_letter: { state: 'ready', depth: 0, max_depth: 1, age_seconds: 0, max_age_seconds: 120 },
    },
    ...overrides,
  };
}

function prepare() {
  const fetchStub = createFetchStub();
  const storageStub = createStorageStub();
  vi.stubGlobal('fetch', fetchStub.fetch);
  vi.stubGlobal('sessionStorage', storageStub.storage);
  return { fetchStub, storageStub };
}

async function connect(): Promise<ReturnType<typeof prepare>> {
  const context = prepare();
  const token = jwt({ realm_access: { roles: ['viewer'] } });
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

// A second login on the SAME mounted view. The token payload carries a session
// marker so the new session is distinguishable from the first one, exactly as
// two real logins would be.
async function loginAgain(context: ReturnType<typeof prepare>, marker: string): Promise<void> {
  context.storageStub.storage.setItem(
    pkceTransactionKey,
    JSON.stringify({ state: `state-${marker}`, verifier: `verifier-${marker}` }),
  );
  const login = completeLogin(`?code=code-${marker}&state=state-${marker}`);
  await flush();
  context.fetchStub.answer(TOKEN_URL, {
    access_token: jwt({ realm_access: { roles: ['viewer'] }, session: marker }),
  });
  await login;
  await flush();
}

beforeEach(() => {
  resetSession();
  clearZoneState();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('the section keeps id=sources, data-view=sources and every legacy anchor', () => {
  prepare();
  render(<SourcesView />);

  const section = document.getElementById('sources');
  expect(section).not.toBeNull();
  expect(section).toHaveAttribute('data-view', 'sources');

  for (const id of [
    'sources-title',
    'sources-badge',
    'sources-status',
    'sources-provider',
    'sources-attribution',
    'sources-restriction',
    'sources-record-count',
    'sources-derived-sha256',
    'sources-integrity',
    'sources-cutoff',
    'sources-input',
    'pipeline',
    'pipeline-title',
    'pipeline-badge',
    'pipeline-status',
    'pipeline-risk',
    'pipeline-jobs',
    'pipeline-gateway',
    'operational-weather',
    'operational-rule',
    'operational-rule-hash',
    'operational-rule-evidence',
    'operational-freshness',
    'operational-verdict-badge',
    'operational-verdict-title',
    'operational-verdict',
    'operational-verdict-announcement',
    'operational-scope',
  ]) {
    expect(document.getElementById(id)).not.toBeNull();
  }
});

test('without a session both panels state they are unconsulted and issue no read', () => {
  const { fetchStub } = prepare();
  render(<SourcesView />);

  expect(fetchStub.calls).toHaveLength(0);
  expect(text('sources-badge')).toBe('SIN CONSULTAR');
  expect(text('sources-status')).toBe('Conecta un token autorizado para consultar la procedencia.');
  expect(text('sources-provider')).toBe('Sin consultar');
  expect(text('pipeline-badge')).toBe('SIN VERIFICAR');
  expect(text('pipeline-risk')).toBe('Sin verificar');
  // PM-16: the rule rows and the verdict stay unconsulted, with no borrowed value.
  expect(text('operational-rule')).toBe('Sin consultar');
  expect(text('operational-rule-hash')).toBe('Sin consultar');
  expect(text('operational-verdict-badge')).toBe('SIN CONSULTAR');
  expect(text('operational-verdict-title')).toMatch(/sin consultar/i);
});

test('a read in flight states the load and shows no healthy-looking source', async () => {
  const { fetchStub } = await connect();
  render(<SourcesView />);
  await flush();

  for (const url of [SOURCES_URL, RISK_STATUS_URL, JOBS_STATUS_URL]) {
    expect(fetchStub.callsFor(url)).toHaveLength(1);
  }
  expect(text('sources-badge')).toBe('CONSULTANDO');
  expect(text('sources-status')).toMatch(/consultando procedencia/i);
  expect(text('sources-provider')).toBe('Sin consultar');
  expect(text('pipeline-status')).toMatch(/consultando servicios/i);
  expect(text('operational-rule')).toBe('Consultando…');
  expect(text('operational-verdict-badge')).toBe('CONSULTANDO');

  answerReads(fetchStub);
  await waitFor(() => expect(text('sources-badge')).toBe('PUBLICADA'));
});

test('the scope declaration lives inside this view and names the real limits', () => {
  prepare();
  render(<SourcesView />);

  const scope = document.querySelector('#sources .warning-banner');
  expect(scope).not.toBeNull();
  expect(scope).toHaveTextContent(/Entrada de demostración/i);
  expect(scope).toHaveTextContent(/no calibrada/i);
  expect(scope).toHaveTextContent(/CONAF ni a SENAPRED/i);
});

test('the actions and findings note stays visible inside the view', () => {
  prepare();
  render(<SourcesView />);

  const note = document.querySelector('#sources .unimplemented-note');
  expect(note).not.toBeNull();
  expect(note).toHaveTextContent(/hallazgos de calidad/i);
});

test('provenance is reproduced verbatim and the integrity line only claims what the service verified', async () => {
  const { fetchStub } = await connect();
  render(<SourcesView />);
  await flush();

  answerReads(fetchStub);
  await waitFor(() => expect(text('sources-badge')).toBe('PUBLICADA'));

  const body = provenanceBody() as { geography: { provenance: Record<string, string | number> } };
  const provenance = body.geography.provenance;
  expect(text('sources-provider')).toBe(provenance.provider);
  expect(text('sources-attribution')).toBe(provenance.attribution);
  expect(text('sources-restriction')).toBe(provenance.restriction);
  expect(text('sources-restriction')).not.toMatch(/aprobad|licencia adicional/i);
  expect(text('sources-record-count')).toBe('38');
  expect(text('sources-derived-sha256')).toBe(provenance.derived_sha256);
  expect(text('sources-integrity')).toMatch(/coincide/i);
  expect(text('sources-integrity')).toMatch(/sha256/i);
  expect(text('sources-integrity')).not.toMatch(/verificado por el cliente/i);
  expect(text('sources-cutoff')).toMatch(/sin fecha de corte real/i);
  expect(text('sources-input')).toMatch(/sintética/i);
  expect(text('sources-input')).toMatch(/no es riesgo real observado/i);
  expect(text('sources-status')).toMatch(/no se acredita aprobación de DIFROL/i);
});

test('provenance fails closed on a 503 body and never looks like a healthy source', async () => {
  const { fetchStub } = await connect();
  render(<SourcesView />);
  await flush();

  answerReads(fetchStub, { provenance: { code: 'geography_integrity_unavailable' }, provenanceStatus: 503 });
  await waitFor(() => expect(text('sources-badge')).toBe('NO DISPONIBLE'));

  expect(text('sources-status')).toMatch(/no disponible/i);
  expect(text('sources-status')).toContain('geography_integrity_unavailable');
  expect(text('sources-provider')).toBe('No disponible');
  expect(text('sources-integrity')).toBe('No disponible');
});

test('an integrity mismatch fails closed even on a 200', async () => {
  const { fetchStub } = await connect();
  render(<SourcesView />);
  await flush();

  const mismatch = provenanceBody();
  (mismatch.geography as { integrity: { matches: boolean } }).integrity.matches = false;
  answerReads(fetchStub, { provenance: mismatch });
  await waitFor(() => expect(text('sources-badge')).toBe('NO DISPONIBLE'));

  expect(text('sources-provider')).toBe('No disponible');
  expect(text('sources-status')).toMatch(/no disponible/i);
});

test('a malformed provenance payload fails closed', async () => {
  const { fetchStub } = await connect();
  render(<SourcesView />);
  await flush();

  answerReads(fetchStub, { provenance: { geography: {} } });
  await waitFor(() => expect(text('sources-badge')).toBe('NO DISPONIBLE'));

  expect(text('sources-provider')).toBe('No disponible');
});

test('a forbidden provenance read is stated as denied permission, not as unavailable shape', async () => {
  const { fetchStub } = await connect();
  render(<SourcesView />);
  await flush();

  answerReads(fetchStub, { provenance: { code: 'forbidden' }, provenanceStatus: 403 });
  await waitFor(() => expect(text('sources-badge')).toBe('NO DISPONIBLE'));

  expect(text('sources-status')).toMatch(/permiso/i);
  expect(text('sources-status')).toContain('403');
});

test('a service is verified only when its own snapshot earns it, and the gateway is excluded', async () => {
  const { fetchStub } = await connect();
  render(<SourcesView />);
  await flush();

  answerReads(fetchStub);
  await waitFor(() => expect(text('pipeline-badge')).toBe('VERIFICADO'));

  expect(text('pipeline-risk')).toMatch(/verificado/i);
  expect(text('pipeline-jobs')).toMatch(/verificado/i);
  expect(text('pipeline-status')).toMatch(/no participa de esta verificación/i);
  expect(text('pipeline-gateway')).toMatch(/204/);
  expect(text('pipeline-gateway')).toMatch(/no acredita el pipeline/i);
});

test('a stale snapshot is unknown, never reported as verified', async () => {
  const { fetchStub } = await connect();
  render(<SourcesView />);
  await flush();

  const stale = statusBody({ checked_at: '2020-01-01T00:00:00Z' });
  answerReads(fetchStub, { risk: stale, jobs: stale });
  await waitFor(() => expect(text('pipeline-badge')).toBe('SIN VERIFICAR'));

  expect(text('pipeline-risk')).toMatch(/desconocido/i);
  expect(text('pipeline-risk')).not.toMatch(/verificado/i);
  expect(text('pipeline-status')).not.toMatch(/verificado/i);
});

test('logout returns both panels to the explicit unconsulted state without keeping green marks', async () => {
  const { fetchStub } = await connect();
  render(<SourcesView />);
  await flush();

  answerReads(fetchStub);
  await waitFor(() => expect(text('sources-badge')).toBe('PUBLICADA'));
  expect(text('pipeline-badge')).toBe('VERIFICADO');

  resetSession();
  await waitFor(() =>
    expect(text('sources-status')).toBe('Conecta un token autorizado para consultar la procedencia.'),
  );
  expect(text('sources-provider')).toBe('No disponible');
  expect(text('pipeline-risk')).toBe('Sin verificar');
  expect(text('pipeline-badge')).toBe('SIN VERIFICAR');
  // PM-16: a closed session clears the rule rows and the verdict too.
  expect(text('operational-rule')).toBe('Sin consultar');
  expect(text('operational-rule-hash')).toBe('Sin consultar');
  expect(text('operational-verdict-badge')).toBe('SIN CONSULTAR');
});

test('a 403 check reads as not authorized to check, never as down, and cannot green the pipeline', async () => {
  const { fetchStub } = await connect();
  render(<SourcesView />);
  await flush();

  answerReads(fetchStub, { jobs: { code: 'forbidden' }, jobsStatus: 403 });
  await waitFor(() => expect(text('pipeline-jobs')).toMatch(/no autorizado para comprobar/i));

  expect(text('pipeline-jobs')).not.toMatch(/ca[ií]do|down/i);
  expect(text('pipeline-risk')).toMatch(/verificado/i);
  expect(text('pipeline-badge')).toBe('SIN VERIFICAR');
});

test('the pipeline refresh is rescheduled while signed in and cancelled on logout', async () => {
  vi.useFakeTimers();
  try {
    const { fetchStub } = await connect();
    render(<SourcesView />);
    await flush();

    answerReads(fetchStub);
    await flush();
    const firstCycle = fetchStub.callsFor(RISK_STATUS_URL).length;
    expect(firstCycle).toBeGreaterThan(0);

    // One bounded cycle later the view asks again: a verification claim is
    // re-checked rather than kept indefinitely from one snapshot.
    await vi.advanceTimersByTimeAsync(timing.pipelineRefreshMs);
    await flush();
    expect(fetchStub.callsFor(RISK_STATUS_URL).length).toBe(firstCycle + 1);
    expect(fetchStub.callsFor(MODELS_URL).length).toBe(firstCycle + 1);
    expect(fetchStub.callsFor(READY_URL).length).toBe(firstCycle + 1);

    resetSession();
    await flush();
    const afterLogout = fetchStub.callsFor(RISK_STATUS_URL).length;

    // A closed session must not keep probing the API in the background.
    await vi.advanceTimersByTimeAsync(timing.pipelineRefreshMs * 3);
    await flush();
    expect(fetchStub.callsFor(RISK_STATUS_URL).length).toBe(afterLogout);
  } finally {
    vi.useRealTimers();
  }
});

// T13 — cycle freshness. The service owns the cycle; the panel reproduces the
// last/next run, the declared status and the age, and states explicitly when the
// service does not report them instead of inventing a fresh-looking default.
test('the cycle panel shows the last run, the next run and the freshness the service reports (T13)', async () => {
  const { fetchStub } = await connect();
  render(<SourcesView />);
  await flush();

  fetchStub.answer(SOURCES_URL, {
    ...provenanceBody(),
    sources: [
      {
        source_id: 'fixture',
        last_run_at: '2026-01-01T11:45:00Z',
        next_run_at: '2026-01-01T12:00:00Z',
        complete: true,
        age_seconds: 900,
      },
    ],
  });
  fetchStub.answer(RISK_STATUS_URL, statusBody());
  fetchStub.answer(JOBS_STATUS_URL, statusBody());
  fetchStub.answer(MODELS_URL, modelRegistryBody());
  fetchStub.answer(READY_URL, null, 204);
  await waitFor(() => expect(text('cycle-badge')).toBe('COMPLETA'));

  expect(text('cycle-last-run')).toBe('2026-01-01T11:45:00Z');
  expect(text('cycle-next-run')).toBe('2026-01-01T12:00:00Z');
  expect(text('cycle-state')).toBe('completa');
  expect(text('cycle-age')).toBe('900 s');
  expect(text('cycle-sources')).toBe('1');
  expect(text('cycle-last-error')).toBe('Sin error informado');
  expect(text('cycle-status')).toMatch(/completa/);
});

test('the cycle panel derives incompleteness and surfaces a source error (T13)', async () => {
  const { fetchStub } = await connect();
  render(<SourcesView />);
  await flush();

  fetchStub.answer(SOURCES_URL, {
    ...provenanceBody(),
    sources: [
      { source_id: 'a', last_run_at: '2026-01-01T11:45:00Z', next_run_at: '2026-01-01T12:00:00Z', complete: true, age_seconds: 900 },
      { source_id: 'b', last_run_at: null, next_run_at: null, complete: false, age_seconds: null, last_error: 'timeout upstream' },
    ],
  });
  fetchStub.answer(RISK_STATUS_URL, statusBody());
  fetchStub.answer(JOBS_STATUS_URL, statusBody());
  fetchStub.answer(MODELS_URL, modelRegistryBody());
  fetchStub.answer(READY_URL, null, 204);
  await waitFor(() => expect(text('cycle-badge')).toBe('INCOMPLETA'));

  expect(text('cycle-state')).toBe('incompleta');
  expect(text('cycle-sources')).toBe('2');
  expect(text('cycle-last-error')).toContain('b');
  expect(text('cycle-last-error')).toContain('timeout upstream');
});

test('the cycle panel states the service does not report sources, without inventing a run (T13)', async () => {
  const { fetchStub } = await connect();
  render(<SourcesView />);
  await flush();

  answerReads(fetchStub);
  await waitFor(() => expect(text('cycle-badge')).toBe('SIN INFORMAR'));

  expect(text('cycle-status')).toMatch(/no informa/i);
  expect(text('cycle-last-run')).toBe('No informado');
  expect(text('cycle-age')).toBe('No informado');
  expect(text('cycle-sources')).toBe('No informado');
});

// PM-16 / S1-S3 — the operational verdict. ONE screen states the verdict, and the
// "model" row states the effective RULE with its version and hash. Identity comes
// only from the validated authoritative `effective` projection of GET /v1/models;
// no registry row, activation record or fixture may earn it.
test('a validated effective rule supplies the version and the hash (PM-16)', async () => {
  const { fetchStub } = await connect();
  render(<SourcesView />);
  await flush();

  answerReads(fetchStub, { models: modelRegistryBody(EFFECTIVE_RULE) });
  await waitFor(() => expect(text('operational-rule')).toBe('academic-rule-v1'));

  expect(text('operational-rule-hash')).toBe(RULE_HASH);
  expect(text('operational-rule-kind')).toBe('Regla');
  expect(text('operational-rule-evidence')).toMatch(/próxima publicación/i);
  expect(text('operational-rule-evidence')).toMatch(/no acredita una publicación ya ocurrida/i);
  expect(text('pipeline-badge')).toBe('VERIFICADO');
});

test('registry rows never verify, even when a row looks activated (PM-16)', async () => {
  const { fetchStub } = await connect();
  render(<SourcesView />);
  await flush();

  // Hostile rows: an explicit activation record and the canonical hash. Without a
  // validated `effective` they are lifecycle data, not the classifier in use.
  answerReads(fetchStub, {
    models: { models: [registryRow({ metrics: { activation: { at: '2026-11-18T12:00:00Z' } } })] },
  });
  await waitFor(() => expect(text('operational-rule')).toBe('No verificable'));

  expect(text('operational-rule-hash')).toBe('No acreditado');
  expect(text('operational-rule')).not.toContain('academic-rule-v1');
  expect(text('operational-rule-evidence')).not.toContain('academic-rule-v1');
  expect(text('operational-rule-evidence')).not.toContain(RULE_HASH);
  expect(text('operational-rule-evidence')).toMatch(/no publica el objeto/i);
});

test('a hostile effective rule with a non-canonical hash shows no identity (PM-16)', async () => {
  const { fetchStub } = await connect();
  render(<SourcesView />);
  await flush();

  answerReads(fetchStub, {
    models: modelRegistryBody({ status: 'rule', version: 'academic-rule-v1', params_hash: RULE_HASH.toUpperCase() }),
  });
  await waitFor(() => expect(text('operational-rule')).toBe('No verificable'));

  expect(text('operational-rule-hash')).toBe('No acreditado');
  expect(text('operational-rule-evidence')).toMatch(/SHA-256/i);
  expect(text('operational-rule-evidence')).not.toContain(RULE_HASH);
  expect(document.getElementById('sources')?.textContent ?? '').not.toContain(RULE_HASH.toUpperCase());
});

test('a resolved non-rule is never reported as a rule or with an identity (PM-16)', async () => {
  const { fetchStub } = await connect();
  render(<SourcesView />);
  await flush();

  // Hostile identity fields on a non-rule must be ignored, not displayed.
  answerReads(fetchStub, {
    models: modelRegistryBody({ status: 'non_rule', version: 'ml-fixture-v1', params_hash: RULE_HASH }),
  });
  await waitFor(() => expect(text('operational-rule')).toBe('No es una regla'));

  expect(text('operational-rule-hash')).toBe('No aplica');
  expect(text('operational-rule-kind')).toBe('No es una regla');
  expect(text('operational-rule-evidence')).toMatch(/no es una regla/i);
  expect(document.getElementById('sources')?.textContent ?? '').not.toContain('ml-fixture-v1');
  expect(text('operational-verdict')).toMatch(/la regla activa no es una regla/i);
});

test('an unavailable projection is a truthful unknown with no identity (PM-16)', async () => {
  const { fetchStub } = await connect();
  render(<SourcesView />);
  await flush();

  answerReads(fetchStub, {
    models: modelRegistryBody({ status: 'unavailable', version: 'academic-rule-v1', params_hash: RULE_HASH }),
  });
  await waitFor(() => expect(text('operational-rule')).toBe('No verificable'));

  expect(text('operational-rule-hash')).toBe('No acreditado');
  expect(text('operational-rule-evidence')).toMatch(/unavailable/);
  expect(text('operational-rule-evidence')).not.toContain(RULE_HASH);
});

test('a denied registry read is named as a permission and never as a model (PM-16)', async () => {
  const { fetchStub } = await connect();
  render(<SourcesView />);
  await flush();

  answerReads(fetchStub, { models: { code: 'forbidden' }, modelsStatus: 403 });
  await waitFor(() => expect(text('operational-rule')).toBe('No verificable'));

  expect(text('operational-rule-hash')).toBe('No acreditado');
  expect(text('operational-rule-evidence')).toContain('403');
  expect(text('operational-rule-evidence')).toMatch(/permiso/i);
});

test('the weather row states the missing integration and invents no reading (PM-16)', () => {
  prepare();
  render(<SourcesView />);

  expect(text('operational-weather')).toMatch(/no integrada/i);
  expect(text('operational-weather')).toMatch(/no publica una fuente meteorológica/i);
  expect(text('operational-weather')).toMatch(/no se inventa/i);
});

test('a failed gateway probe is its own evidence and cannot green the pipeline (PM-16)', async () => {
  const { fetchStub } = await connect();
  render(<SourcesView />);
  await flush();

  answerReads(fetchStub, { gatewayStatus: 503 });
  await waitFor(() => expect(text('pipeline-status')).toMatch(/ambos servicios reportan ready/i));

  expect(text('pipeline-badge')).toBe('VERIFICADO');
  expect(text('pipeline-gateway')).toContain('503');
  expect(text('pipeline-gateway')).toMatch(/no acredita el pipeline/i);
  // The explicit verdict does not ignore a probe that did not answer.
  expect(text('operational-verdict-badge')).toBe('NO ACREDITA');
});

test('the verdict stays demo, not production, with every service verified (PM-16)', async () => {
  const { fetchStub } = await connect();
  render(<SourcesView />);
  await flush();

  answerReads(fetchStub, { models: modelRegistryBody(EFFECTIVE_RULE) });
  await waitFor(() => expect(text('operational-verdict-badge')).toBe('DEMOSTRACIÓN'));

  expect(text('operational-verdict-title')).toMatch(/demostración, no producción/i);
  expect(text('operational-verdict')).toMatch(/no acredita operación de producción/i);
  expect(text('operational-verdict')).toMatch(/entrada sintética/i);
  expect(text('operational-verdict')).toMatch(/fuente meteorológica no integrada/i);
  expect(text('operational-verdict')).toMatch(/CONAF/);
  expect(text('operational-verdict')).not.toMatch(/listo para producción|producción verificada/i);
  expect(text('operational-scope')).toMatch(/no consulta métricas ni telemetría/i);
});

test('a settled read reports the service freshness it actually received (PM-16)', async () => {
  const { fetchStub } = await connect();
  render(<SourcesView />);
  await flush();

  const stamp = new Date().toISOString();
  answerReads(fetchStub, { risk: statusBody({ checked_at: stamp }), jobs: statusBody({ checked_at: stamp }) });
  await waitFor(() => expect(text('operational-freshness')).toContain(stamp));

  expect(text('operational-freshness')).toMatch(/^riesgo /);
  expect(text('operational-freshness')).toMatch(/· trabajos /);
});

test('the status screen issues no metrics scrape and no second status endpoint (S2, PM-16)', async () => {
  const { fetchStub } = await connect();
  render(<SourcesView />);
  await flush();

  answerReads(fetchStub);
  await waitFor(() => expect(text('sources-badge')).toBe('PUBLICADA'));

  const urls = fetchStub.calls.map(call => call.url);
  expect(new Set(urls)).toEqual(
    new Set([SOURCES_URL, RISK_STATUS_URL, JOBS_STATUS_URL, MODELS_URL, READY_URL]),
  );
  expect(urls.filter(url => /metrics|telemetry/i.test(url))).toEqual([]);
});

// PM-16 correction — session boundaries. Evidence is keyed to the session
// instance that produced it, so a re-login cannot show the previous session's
// readings even before the first new response lands.
test('a new session never renders the previous evidence (PM-16)', async () => {
  const context = await connect();
  render(<SourcesView />);
  await flush();

  answerReads(context.fetchStub, { models: modelRegistryBody(EFFECTIVE_RULE) });
  await waitFor(() => expect(text('operational-rule')).toBe('academic-rule-v1'));
  expect(text('operational-rule-hash')).toBe(RULE_HASH);
  expect(text('operational-verdict-badge')).toBe('DEMOSTRACIÓN');

  resetSession();
  await waitFor(() => expect(text('operational-verdict-badge')).toBe('SIN CONSULTAR'));
  expect(text('operational-rule')).toBe('Sin consultar');

  await loginAgain(context, 'b');
  // Nothing from session A may reappear while session B's reads are in flight.
  expect(text('operational-rule')).toBe('Consultando…');
  expect(text('operational-rule-hash')).toBe('Consultando…');
  expect(text('operational-verdict-badge')).toBe('CONSULTANDO');
  expect(text('sources-badge')).toBe('CONSULTANDO');
  expect(text('operational-verdict')).not.toContain(RULE_HASH);

  answerReads(context.fetchStub, { models: modelRegistryBody({ status: 'unavailable' }) });
  await waitFor(() => expect(text('operational-rule')).toBe('No verificable'));
  expect(text('operational-rule-hash')).toBe('No acreditado');
});

// PM-16 correction — late completions. Session A's reads are never answered before
// the logout, so their promised completions land after session B started. The
// aborted controllers and the session-owner guard keep them inert.
test('a late completion from the previous session cannot paint (PM-16)', async () => {
  const context = await connect();
  render(<SourcesView />);
  await flush();
  // Session A's five reads are in flight and stay unanswered.
  expect(context.fetchStub.callsFor(MODELS_URL)).toHaveLength(1);

  resetSession();
  await waitFor(() => expect(text('operational-verdict-badge')).toBe('SIN CONSULTAR'));

  await loginAgain(context, 'c');
  expect(text('operational-verdict-badge')).toBe('CONSULTANDO');

  // Resolve session A's abandoned entries first: they must not repaint anything.
  answerReads(context.fetchStub, { models: modelRegistryBody(EFFECTIVE_RULE) });
  await flush();
  expect(text('operational-rule')).toBe('Consultando…');
  expect(text('operational-rule-hash')).toBe('Consultando…');
  expect(text('operational-verdict-badge')).toBe('CONSULTANDO');

  // Session B's own reads settle the screen, with B's evidence only.
  answerReads(context.fetchStub, { models: modelRegistryBody(EFFECTIVE_RULE) });
  await waitFor(() => expect(text('operational-rule')).toBe('academic-rule-v1'));
  expect(text('operational-rule-hash')).toBe(RULE_HASH);
});

// PM-16 correction — announcement semantics. The verdict has ONE dedicated live
// region that names only the verdict, so a screen reader hears a transition once.
// Same-verdict refreshes mutate nothing, and the visible paragraph is not a second
// live region repeating the same sentence.
test('the verdict announces transitions once, in its own live region (PM-16)', async () => {
  vi.useFakeTimers();
  let observer: MutationObserver | null = null;
  try {
    const { fetchStub } = await connect();
    render(<SourcesView />);
    await flush();

    answerReads(fetchStub, { models: modelRegistryBody(EFFECTIVE_RULE) });
    await vi.waitFor(() => expect(text('operational-verdict-badge')).toBe('DEMOSTRACIÓN'));
    const region = document.getElementById('operational-verdict-announcement');
    expect(region).not.toBeNull();
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveClass('sr-only');
    expect(region?.textContent).toBe('Veredicto operativo: Demostración, no producción.');

    // The visible verdict is plain text, not a second live copy of the sentence.
    const visible = document.getElementById('operational-verdict');
    expect(visible).not.toHaveAttribute('role');
    expect(visible).not.toHaveAttribute('aria-live');
    expect(region?.textContent).not.toContain('entrada sintética');
    expect(region?.textContent).not.toContain('CONAF');

    // A 30 s refresh that reaches the same verdict must not re-announce: the live
    // region receives no DOM mutation at all.
    let mutations = 0;
    observer = new MutationObserver((records) => {
      mutations += records.length;
    });
    observer.observe(region as Node, { childList: true, characterData: true, subtree: true });

    await vi.advanceTimersByTimeAsync(timing.pipelineRefreshMs);
    await flush();
    answerReads(fetchStub, { models: modelRegistryBody(EFFECTIVE_RULE) });
    await vi.waitFor(() => expect(mutations).toBe(0));
    expect(region?.textContent).toBe('Veredicto operativo: Demostración, no producción.');

    // A real verdict transition announces once, with only the new title.
    await vi.advanceTimersByTimeAsync(timing.pipelineRefreshMs);
    await flush();
    answerReads(fetchStub, {
      models: modelRegistryBody(EFFECTIVE_RULE),
      jobs: { code: 'unavailable' },
      jobsStatus: 503,
    });
    await vi.waitFor(() => expect(text('operational-verdict-badge')).toBe('NO ACREDITA'));
    expect(region?.textContent).toBe('Veredicto operativo: Sin verificación operativa completa.');
  } finally {
    observer?.disconnect();
    vi.useRealTimers();
  }
});
