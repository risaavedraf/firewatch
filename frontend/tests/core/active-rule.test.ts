import { describe, expect, test } from 'vitest';

import { evaluateEffectiveClassifier } from '../../src/core/active-rule';

// PM-16 / S1 — the "model" row states the ACTIVE RULE with its version and its
// hash, and it must not present a registry row, a fixture or a model as the rule
// that is running. The authoritative source is the additive `effective` object of
// `GET /v1/models` (frozen contract, backend T3):
//
//   {status:"rule", version, params_hash}  -> the only shape that may claim identity
//   {status:"non_rule"}                    -> a resolved non-rule; NO identity
//   {status:"unavailable"}                 -> missing evidence; NO identity
//
// The client validates the claim itself instead of trusting the label: a rule
// needs a non-empty version and one canonical lowercase SHA-256, and every other
// answer is a truthful unknown. Raw rows are never an input to this function.

const HASH = '59259c4c0c470e5a0d512fe09f6c748c38fd29f9bc5d760d49754555c66e699b';

function effective(value: unknown) {
  return { ok: true as const, effective: value };
}

describe('the effective classifier identity read from /v1/models', () => {
  test('a validated rule projection is the only branch that reports version and hash', () => {
    const evidence = evaluateEffectiveClassifier(effective({ status: 'rule', version: 'academic-rule-v1', params_hash: HASH }));

    expect(evidence.state).toBe('verified');
    expect(evidence.version).toBe('academic-rule-v1');
    expect(evidence.paramsHash).toBe(HASH);
    expect(evidence.label).toMatch(/próxima publicación/i);
    expect(evidence.label).toMatch(/no acredita una publicación ya ocurrida/i);
  });

  test('a resolved non-rule is distinguished without being reported as a rule', () => {
    const evidence = evaluateEffectiveClassifier(effective({ status: 'non_rule' }));

    expect(evidence.state).toBe('non-rule');
    expect(evidence.version).toBe('');
    expect(evidence.paramsHash).toBe('');
    expect(evidence.label).toMatch(/no es una regla/i);
    expect(evidence.label).not.toMatch(/regla activa verificada/i);
  });

  test('a non-rule that carries hostile identity fields still reports no identity', () => {
    const evidence = evaluateEffectiveClassifier(
      effective({ status: 'non_rule', version: 'ml-fixture-v1', params_hash: HASH }),
    );

    expect(evidence.state).toBe('non-rule');
    expect(evidence.version).toBe('');
    expect(evidence.paramsHash).toBe('');
    expect(evidence.label).not.toContain('ml-fixture-v1');
    expect(evidence.label).not.toContain(HASH);
  });

  test('an unavailable projection is a truthful unknown with no borrowed identity', () => {
    const evidence = evaluateEffectiveClassifier(
      effective({ status: 'unavailable', version: 'academic-rule-v1', params_hash: HASH }),
    );

    expect(evidence.state).toBe('unknown');
    expect(evidence.version).toBe('');
    expect(evidence.paramsHash).toBe('');
    expect(evidence.label).toMatch(/unavailable/);
    expect(evidence.label).not.toContain('academic-rule-v1');
    expect(evidence.label).not.toContain(HASH);
  });

  test('an absent effective object is unknown, never inferred from the registry list', () => {
    for (const value of [undefined, null, 'rule', [], 42]) {
      const evidence = evaluateEffectiveClassifier(effective(value));

      expect(evidence.state, String(value)).toBe('unknown');
      expect(evidence.version).toBe('');
      expect(evidence.paramsHash).toBe('');
      expect(evidence.label).toMatch(/no publica el objeto|no reconoce|no declara estado|no es un objeto/i);
    }
  });

  test('an unrecognised status is unknown and not echoed as a claim', () => {
    const evidence = evaluateEffectiveClassifier(effective({ status: 'verified', version: 'academic-rule-v1', params_hash: HASH }));

    expect(evidence.state).toBe('unknown');
    expect(evidence.version).toBe('');
    expect(evidence.paramsHash).toBe('');
    expect(evidence.label).toMatch(/no reconoce/i);
  });

  test.each([
    ['missing hash', { status: 'rule', version: 'academic-rule-v1' }],
    ['null hash', { status: 'rule', version: 'academic-rule-v1', params_hash: null }],
    ['numeric hash', { status: 'rule', version: 'academic-rule-v1', params_hash: 7 }],
    ['uppercase hash', { status: 'rule', version: 'academic-rule-v1', params_hash: HASH.toUpperCase() }],
    ['truncated hash', { status: 'rule', version: 'academic-rule-v1', params_hash: HASH.slice(0, 63) }],
    ['overlong hash', { status: 'rule', version: 'academic-rule-v1', params_hash: `${HASH}0` }],
    ['non-hex hash', { status: 'rule', version: 'academic-rule-v1', params_hash: `${'g'}${HASH.slice(1)}` }],
    // `$` alone accepts a trailing newline; the length check must reject it.
    ['hash with a trailing newline', { status: 'rule', version: 'academic-rule-v1', params_hash: `${HASH}\n` }],
  ] as const)('a rule with a %s is unknown and shows no identity', (_label, value) => {
    const evidence = evaluateEffectiveClassifier(effective(value));

    expect(evidence.state).toBe('unknown');
    expect(evidence.version).toBe('');
    expect(evidence.paramsHash).toBe('');
    expect(evidence.label).not.toContain(HASH);
    expect(evidence.label).toMatch(/SHA-256|params_hash/i);
  });

  test.each([
    ['missing version', { status: 'rule', params_hash: HASH }],
    ['empty version', { status: 'rule', version: '', params_hash: HASH }],
    ['whitespace version', { status: 'rule', version: '   ', params_hash: HASH }],
    ['non-string version', { status: 'rule', version: 7, params_hash: HASH }],
  ] as const)('a rule with a %s is unknown and shows no identity', (_label, value) => {
    const evidence = evaluateEffectiveClassifier(effective(value));

    expect(evidence.state).toBe('unknown');
    expect(evidence.version).toBe('');
    expect(evidence.paramsHash).toBe('');
    expect(evidence.label).not.toContain(HASH);
  });

  test('a 403 is denied permission, named as such and never as a model or a hash', () => {
    const evidence = evaluateEffectiveClassifier({
      ok: false,
      failure: { kind: 'forbidden', reason: 'forbidden', status: 403 },
    });

    expect(evidence.state).toBe('unknown');
    expect(evidence.version).toBe('');
    expect(evidence.paramsHash).toBe('');
    expect(evidence.label).toMatch(/permiso/i);
    expect(evidence.label).toContain('403');
    expect(evidence.label).not.toMatch(/ca[ií]do|down/i);
  });

  test.each([
    ['unauthorized', 401, /401/],
    ['malformed', 200, /ilegible/i],
    ['unavailable', 503, /503/],
    ['missing', 404, /404/],
  ] as const)('a %s read is unknown and names what the service answered', (kind, status, pattern) => {
    const evidence = evaluateEffectiveClassifier({ ok: false, failure: { kind, reason: 'x', status } });

    expect(evidence.state).toBe('unknown');
    expect(evidence.label).toMatch(pattern);
    expect(evidence.label).toMatch(/sin verificar/i);
  });

  test('a read with no HTTP status says so instead of inventing a code', () => {
    const evidence = evaluateEffectiveClassifier({ ok: false, failure: { kind: 'unavailable', reason: 'network' } });

    expect(evidence.state).toBe('unknown');
    expect(evidence.label).toMatch(/sin conexión/i);
    expect(evidence.label).not.toMatch(/\bHTTP\b/);
  });
});
