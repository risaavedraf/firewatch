import { describe, expect, test } from 'vitest';

import { batchProvenance, latestOutcome, presentBatch } from '../../src/domain/batch';

function validBatch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    zone_id: '05101',
    id: 'batch',
    job_id: 'job',
    demo: true,
    risk_level: 'alto',
    factors: [{ name: 'temperatura', known: true, value: 30, contribution: 0.2, note: '' }],
    rationale: 'Regla académica',
    policy: { policy_id: 'academic-rule-v1', params_hash: 'hash', parameters: { weight: '0.2' } },
    notice: 'Sintético',
    ...overrides,
  };
}

describe('fail-closed batch acceptance', () => {
  test('accepts only a complete batch and reports its canonical level', () => {
    const presentation = presentBatch(validBatch());
    expect(presentation.valid).toBe(true);
    expect(presentation.omissions).toEqual([]);
    expect(presentation.policyValid).toBe(true);
    expect(presentation.level).toBe('alto');
  });

  test('names exactly which part of the contract the batch omitted', () => {
    expect(presentBatch(validBatch({ risk_level: 'HIGH' })).omissions).toEqual(['nivel']);
    expect(presentBatch(validBatch({ demo: undefined })).omissions).toEqual(['procedencia demo']);
    expect(presentBatch(validBatch({ factors: [] })).omissions).toEqual(['factores']);
    expect(presentBatch(validBatch({ rationale: '' })).omissions).toEqual(['justificación']);
    expect(presentBatch(validBatch({ policy: {} })).omissions).toEqual(['política']);
  });

  test('a malformed level, a non-boolean demo flag or a broken factor never yields a level', () => {
    for (const override of [
      { risk_level: 'HIGH' },
      { demo: 'true' },
      { demo: 1 },
      { factors: [] },
      { rationale: 42 },
      { policy: {} },
      { policy: { policy_id: 'p', params_hash: '', parameters: { w: '1' } } },
      { policy: { policy_id: 'p', params_hash: 'h', parameters: {} } },
      { policy: { policy_id: 'p', params_hash: 'h', parameters: { w: 1 } } },
    ]) {
      const presentation = presentBatch(validBatch(override));
      expect(presentation.valid).toBe(false);
      expect(presentation.level).toBe('');
    }
  });

  test('a factor without its note string is not a valid measurement', () => {
    const presentation = presentBatch(
      validBatch({ factors: [{ name: 'viento', known: true, value: 1, contribution: 1 }] }),
    );
    expect(presentation.valid).toBe(false);
    expect(presentation.omissions).toContain('factores');
  });

  test('keeps only the factors it can present, in order', () => {
    const presentation = presentBatch(
      validBatch({
        factors: [
          { name: 'ok', known: true, value: 1, contribution: 1, note: '' },
          { name: 'bad', known: 'yes', value: 1, contribution: 1, note: '' },
          { name: 'also-ok', known: false, value: 0, contribution: 0, note: 'sin dato' },
        ],
      }),
    );
    expect(presentation.factors.map((factor) => factor.name)).toEqual(['ok', 'also-ok']);
    expect(presentation.valid).toBe(false);
  });

  test('404 from latest means there is no published batch, never low risk', () => {
    expect(latestOutcome(404)).toBe('no-published-batch');
    expect(latestOutcome(404)).not.toBe('ok');
    // A missing or empty body can never be turned into a level.
    for (const body of [{}, null, undefined, { risk_level: 'bajo' }]) {
      const presentation = presentBatch(body);
      expect(presentation.valid).toBe(false);
      expect(presentation.level).toBe('');
    }
  });

  test('maps the latest HTTP outcomes without inventing a severity', () => {
    expect(latestOutcome(200)).toBe('ok');
    expect(latestOutcome(401)).toBe('unauthorized');
    expect(latestOutcome(403)).toBe('forbidden');
    expect(latestOutcome(500)).toBe('error');
    expect(latestOutcome(404)).toBe('no-published-batch');
  });
});

// V1-P-06 — the provenance of the evaluation that produced a batch. `BatchCore`
// declares `evaluation_trigger` (`scheduler` or `manual`) and `evaluated_by`: the
// verified token subject of the operator who asked for a manual evaluation, and
// null for a scheduled one, because a run nobody requested has no actor. The page
// shows what the payload proves and says "no informada" for anything else — it
// never upgrades a missing or contradictory provenance into a manual publication.
describe('evaluation provenance on a published batch', () => {
  test('a manual evaluation names the operator the token carried', () => {
    const provenance = batchProvenance(validBatch({ evaluation_trigger: 'manual', evaluated_by: 'operator-ana' }));
    expect(provenance.reported).toBe(true);
    expect(provenance.trigger).toBe('manual');
    expect(provenance.actor).toBe('operator-ana');
    expect(provenance.label).toContain('manual');
    expect(provenance.label).toContain('operator-ana');
  });

  test('a scheduled evaluation says nobody requested it, instead of inventing an actor', () => {
    const provenance = batchProvenance(validBatch({ evaluation_trigger: 'scheduler', evaluated_by: null }));
    expect(provenance.reported).toBe(true);
    expect(provenance.trigger).toBe('scheduler');
    expect(provenance.actor).toBe('');
    expect(provenance.label).toContain('programada');
    expect(provenance.label).toContain('nadie la solicitó');
  });

  test('a missing, unknown or contradictory provenance is reported as not informed', () => {
    for (const overrides of [
      {},
      { evaluation_trigger: 'MANUAL' },
      { evaluation_trigger: 'cron' },
      { evaluation_trigger: 'manual' },
      { evaluation_trigger: 'manual', evaluated_by: '' },
      { evaluation_trigger: 'manual', evaluated_by: 7 },
      // A scheduled run has no actor, so an actor there contradicts the contract.
      { evaluation_trigger: 'scheduler', evaluated_by: 'operator-ana' },
    ]) {
      const provenance = batchProvenance(validBatch(overrides));
      expect(provenance.reported, JSON.stringify(overrides)).toBe(false);
      expect(provenance.trigger, JSON.stringify(overrides)).toBe('');
      expect(provenance.actor, JSON.stringify(overrides)).toBe('');
      expect(provenance.label).toContain('no informada');
    }
  });

  test('something that is not a batch reports no provenance at all', () => {
    for (const batch of [null, undefined, 5, 'batch', []]) {
      expect(batchProvenance(batch).reported).toBe(false);
    }
  });
});
