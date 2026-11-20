// PM-18 — the preventive-recommendation catalogue as a pure composition.
//
// Every rule pinned here is the one written in
// `odd/plan-produccion/catalogo-recomendaciones-preventivas.md` §2, §3 and §5:
// the level picks a base pair, up to two canonical variables with a reading and a
// positive contribution add one item each, ties break on the canonical order, an
// item identifier appears once and the gap a duplicate leaves is never filled.
// Nothing here issues a request, so the catalogue cannot create an action.

import { describe, expect, test } from 'vitest';

import {
  DIRECT_OBSERVATION,
  GENERAL_PREVENTION_NOTICE,
  RECOMMENDATION_TEXTS,
  SYNTHETIC_ENVIRONMENT_NOTICE,
  planRecommendations,
} from '../../src/domain/recommendations';

// --- Fixtures --------------------------------------------------------------
// A factor entry exactly as the contract serves it. `known` and `contribution`
// are the two members the composition reads, so they are the only ones a test
// varies on purpose.

function factor(name: string, contribution: number, known = true): Record<string, unknown> {
  return { name, known, value: 12, contribution, note: '' };
}

function batchOf(
  riskLevel: unknown,
  factors: unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    zone_id: '05101',
    id: 'batch-1',
    job_id: 'job-1',
    demo: true,
    risk_level: riskLevel,
    factors,
    rationale: 'Regla académica',
    policy: { policy_id: 'academic-rule-v1', params_hash: 'hash', parameters: { weight: '0.2' } },
    ...extra,
  };
}

const ids = (plan: ReturnType<typeof planRecommendations>): string[] => plan.items.map((item) => item.id);
const texts = (plan: ReturnType<typeof planRecommendations>): string[] => plan.items.map((item) => item.text);
const noticeKinds = (plan: ReturnType<typeof planRecommendations>): string[] =>
  plan.notices.map((notice) => notice.kind);
const noticeText = (plan: ReturnType<typeof planRecommendations>, kind: string): string | undefined =>
  plan.notices.find((notice) => notice.kind === kind)?.text;

describe('the catalogue text', () => {
  test('pins the eight identifiers and reproduces their text exactly', () => {
    expect(Object.keys(RECOMMENDATION_TEXTS).sort()).toEqual([
      'R-01',
      'R-02',
      'R-03',
      'R-04',
      'R-05',
      'R-06',
      'R-07',
      'R-08',
    ]);
    expect(RECOMMENDATION_TEXTS['R-01']).toBe(
      'Retira la vegetación seca y los desechos acumulados alrededor de la vivienda.',
    );
    expect(RECOMMENDATION_TEXTS['R-02']).toBe(
      'Mantén despejadas, con anticipación, las vías de salida y los accesos que usarías ante una emergencia.',
    );
    expect(RECOMMENDATION_TEXTS['R-03']).toBe(
      'Restringe fogatas, parrillas, quema de desechos y otras fuentes de calor cerca de vegetación.',
    );
    expect(RECOMMENDATION_TEXTS['R-04']).toBe(
      'Coordina con la municipalidad o la junta de vecinos una revisión del entorno y de las vías de salida.',
    );
    expect(RECOMMENDATION_TEXTS['R-05']).toBe(
      'Si ves vegetación en contacto con líneas eléctricas, avisa a la empresa distribuidora; no intervengas tú esa vegetación.',
    );
    expect(RECOMMENDATION_TEXTS['R-06']).toBe(
      'En días calurosos, evita herramientas y trabajos que generen chispas al aire libre, sobre todo cerca de vegetación.',
    );
    expect(RECOMMENDATION_TEXTS['R-07']).toBe(
      'Con el ambiente seco, no enciendas cigarrillos, fósforos ni nada que produzca calor cerca de vegetación.',
    );
    expect(RECOMMENDATION_TEXTS['R-08']).toBe(
      'Con viento, no hagas fogatas ni quemas y no uses herramientas que produzcan chispas.',
    );
  });
});

describe('the level base pair', () => {
  test.each([
    ['bajo', 'BAJO', ['R-01', 'R-02']],
    ['medio', 'MEDIO', ['R-01', 'R-03']],
    ['alto', 'ALTO', ['R-03', 'R-04']],
  ])('%s composes its documented base pair in the written order', (level, label, expected) => {
    const plan = planRecommendations(batchOf(level, []));

    expect(plan.level).toBe(level);
    expect(plan.levelLabel).toBe(label);
    expect(ids(plan)).toEqual(expected);
    expect(plan.items.every((item) => item.source === 'nivel')).toBe(true);
    expect(texts(plan)).toEqual(expected.map((id) => RECOMMENDATION_TEXTS[id as 'R-01']));
  });

  test('a batch with no readable factor keeps the base pair and says so', () => {
    const plan = planRecommendations(batchOf('bajo', []));

    expect(ids(plan)).toEqual(['R-01', 'R-02']);
    expect(noticeKinds(plan)).toContain('sin-factores');
    expect(noticeText(plan, 'sin-factores')).toBe('Sin factores con lectura en este lote.');
  });

  test('a batch whose every variable is explicitly unknown says the same thing', () => {
    const plan = planRecommendations(
      batchOf('medio', [
        factor('temperatura', 0, false),
        factor('humedad_relativa', 0, false),
        factor('viento', 0, false),
        factor('cobertura_vegetal', 0, false),
        factor('incendios_historicos', 0, false),
      ]),
    );

    expect(ids(plan)).toEqual(['R-01', 'R-03']);
    expect(noticeText(plan, 'sin-factores')).toBe('Sin factores con lectura en este lote.');
    expect(noticeKinds(plan)).not.toContain('sin-lectura');
  });
});

describe('factor composition', () => {
  test('orders factor items by contribution and places them before the level base', () => {
    // The worked example of §4, with its illustrative figures.
    const plan = planRecommendations(
      batchOf('alto', [
        factor('temperatura', 0.18),
        factor('humedad_relativa', 0),
        factor('viento', 0.216),
        factor('cobertura_vegetal', 0, false),
        factor('incendios_historicos', 0.05),
      ]),
    );

    expect(ids(plan)).toEqual(['R-08', 'R-06', 'R-03', 'R-04']);
    expect(plan.items.map((item) => item.source)).toEqual(['factor', 'factor', 'nivel', 'nivel']);
    expect(texts(plan)).toEqual([
      RECOMMENDATION_TEXTS['R-08'],
      RECOMMENDATION_TEXTS['R-06'],
      RECOMMENDATION_TEXTS['R-03'],
      RECOMMENDATION_TEXTS['R-04'],
    ]);
    // Only the absent reading is named: a zero contribution was read, it simply
    // does not participate.
    expect(noticeText(plan, 'sin-lectura')).toBe('Sin lectura: cobertura_vegetal.');
  });

  test('takes at most two factor items when all five variables contribute', () => {
    const plan = planRecommendations(
      batchOf('bajo', [
        factor('temperatura', 0.1),
        factor('humedad_relativa', 0.2),
        factor('viento', 0.3),
        factor('cobertura_vegetal', 0.4),
        factor('incendios_historicos', 0.5),
      ]),
    );

    expect(plan.items.filter((item) => item.source === 'factor')).toHaveLength(2);
    expect(ids(plan)).toEqual(['R-04', 'R-01', 'R-02']);
    expect(plan.items.length).toBeLessThanOrEqual(4);
  });

  test('breaks a contribution tie by the canonical variable order', () => {
    const plan = planRecommendations(
      batchOf('bajo', [
        factor('incendios_historicos', 0.2),
        factor('viento', 0.2),
        factor('temperatura', 0.2),
      ]),
    );

    expect(plan.items.filter((item) => item.source === 'factor').map((item) => item.id)).toEqual([
      'R-06',
      'R-08',
    ]);
  });

  test('never composes an item from a zero, negative or unread variable', () => {
    const plan = planRecommendations(
      batchOf('bajo', [
        factor('temperatura', 0),
        factor('viento', -0.4),
        factor('humedad_relativa', 0.4, false),
        factor('cobertura_vegetal', 0.1),
      ]),
    );

    // Only `cobertura_vegetal` participates and its item duplicates the base R-01,
    // so the result is the base pair with that item stated as a factor item.
    expect(ids(plan)).toEqual(['R-01', 'R-02']);
    expect(plan.items[0].source).toBe('factor');
    expect(texts(plan)).not.toContain(RECOMMENDATION_TEXTS['R-06']);
    expect(texts(plan)).not.toContain(RECOMMENDATION_TEXTS['R-07']);
    expect(texts(plan)).not.toContain(RECOMMENDATION_TEXTS['R-08']);
    expect(noticeText(plan, 'sin-lectura')).toBe(
      'Sin lectura: humedad_relativa, incendios_historicos.',
    );
  });

  test('drops a duplicated identifier without refilling the gap', () => {
    const plan = planRecommendations(
      batchOf('alto', [
        factor('incendios_historicos', 0.4),
        factor('temperatura', 0.3),
        factor('viento', 0.2),
      ]),
    );

    // R-04 comes first as a factor item and is not repeated for the level; the
    // third factor the batch carried is NOT pulled in to keep the list at four.
    expect(ids(plan)).toEqual(['R-04', 'R-06', 'R-03']);
    expect(plan.items).toHaveLength(3);
    expect(texts(plan)).not.toContain(RECOMMENDATION_TEXTS['R-08']);
  });

  test('names every canonical variable without a reading, in the canonical order', () => {
    const plan = planRecommendations(
      batchOf('medio', [factor('temperatura', 0, false), factor('incendios_historicos', 0.1)]),
    );

    expect(noticeText(plan, 'sin-lectura')).toBe(
      'Sin lectura: temperatura, humedad_relativa, viento, cobertura_vegetal.',
    );
  });

  test('ignores an entry the boundary guard would reject and a non-canonical variable', () => {
    const plan = planRecommendations(
      batchOf('bajo', [
        factor('humedad', 0.9),
        { name: 'viento', known: 'yes', value: 1, contribution: 0.9, note: '' },
        { name: '', known: true, value: 1, contribution: 0.9, note: '' },
        factor('temperatura', 0.3),
      ]),
    );

    // A variable outside the five cannot displace a canonical one, and an invalid
    // entry is not a reading either.
    expect(ids(plan)).toEqual(['R-06', 'R-01', 'R-02']);
    expect(noticeText(plan, 'sin-lectura')).toBe(
      'Sin lectura: humedad_relativa, viento, cobertura_vegetal, incendios_historicos.',
    );
  });
});

describe('levels the rule did not classify', () => {
  test('desconocido shows only R-01 and R-02 and never a factor item', () => {
    const plan = planRecommendations(
      batchOf('desconocido', [factor('viento', 0.9), factor('temperatura', 0.5)]),
    );

    expect(plan.level).toBe('desconocido');
    expect(plan.levelLabel).toBe('INFORMACIÓN INSUFICIENTE');
    expect(ids(plan)).toEqual(['R-01', 'R-02']);
    expect(texts(plan)).not.toContain(RECOMMENDATION_TEXTS['R-08']);
    expect(plan.notices[0].text).toBe(
      'Nivel no clasificado: el sistema no tiene una evaluación validada de esta zona.',
    );
    // No factor item means no factor reading is discussed either.
    expect(noticeKinds(plan)).not.toContain('sin-lectura');
    expect(noticeKinds(plan)).not.toContain('sin-factores');
  });

  test.each([['critico'], ['ALTO'], [null], [undefined], [''], [7], [{}]])(
    'fails closed for %s instead of remapping it to a similar level',
    (level) => {
      const plan = planRecommendations(batchOf(level, [factor('viento', 0.9)]));

      expect(plan.level).toBe('');
      expect(plan.levelLabel).toBe('SIN CLASIFICAR');
      expect(ids(plan)).toEqual(['R-01', 'R-02']);
      expect(plan.notices[0].kind).toBe('nivel-no-clasificado');
      expect(texts(plan)).not.toContain(RECOMMENDATION_TEXTS['R-08']);
    },
  );

  test('never returns an empty list, even for an input that is not a batch', () => {
    for (const input of [null, undefined, 'alto', 42, [], {}]) {
      const plan = planRecommendations(input);
      expect(ids(plan)).toEqual(['R-01', 'R-02']);
      expect(noticeKinds(plan)).toContain('prevencion-general');
    }
  });
});

describe('notices', () => {
  test('a synthetic batch is preceded by the text the card already renders', () => {
    const plan = planRecommendations(batchOf('medio', [], { demo: true }));

    expect(SYNTHETIC_ENVIRONMENT_NOTICE).toBe('Entorno sintético: no riesgo real observado.');
    expect(noticeText(plan, 'entorno-sintetico')).toBe(SYNTHETIC_ENVIRONMENT_NOTICE);
  });

  test('an undeclared or false synthetic mark adds no synthetic notice', () => {
    for (const demo of [false, undefined, 'yes', null]) {
      const plan = planRecommendations(batchOf('medio', [], { demo }));
      expect(noticeKinds(plan)).not.toContain('entorno-sintetico');
    }
  });

  test('data_status never changes the catalogue: the card states it by its own side', () => {
    const factors = [factor('viento', 0.2), factor('temperatura', 0.1)];
    const current = planRecommendations(batchOf('alto', factors, { data_status: 'current' }));
    const stale = planRecommendations(batchOf('alto', factors, { data_status: 'stale' }));

    expect(stale).toEqual(current);
  });

  test('always states that the suggestions are general prevention, not an alert, a classification or an order', () => {
    for (const level of ['bajo', 'medio', 'alto', 'desconocido', 'critico']) {
      const plan = planRecommendations(batchOf(level, []));
      const general = noticeText(plan, 'prevencion-general');

      expect(general).toBe(GENERAL_PREVENTION_NOTICE);
    }
    expect(GENERAL_PREVENTION_NOTICE).toMatch(/prevención general/i);
    expect(GENERAL_PREVENTION_NOTICE).toMatch(
      /no son una alerta oficial, ni una clasificación oficial de riesgo, ni una orden/i,
    );
    expect(GENERAL_PREVENTION_NOTICE).toMatch(/autoridad/i);
  });

  test('prepends the notices in the documented order', () => {
    const plan = planRecommendations(batchOf('alto', [factor('viento', 0.2)], { demo: true }));

    expect(noticeKinds(plan)).toEqual(['entorno-sintetico', 'sin-lectura', 'prevencion-general']);
  });
});

describe('the direct-observation item', () => {
  test('is catalogued but never composed into the list', () => {
    expect(DIRECT_OBSERVATION.id).toBe('R-05');
    expect(DIRECT_OBSERVATION.text).toBe(RECOMMENDATION_TEXTS['R-05']);

    for (const level of ['bajo', 'medio', 'alto', 'desconocido', 'critico']) {
      const plan = planRecommendations(
        batchOf(level, [
          factor('viento', 0.9),
          factor('temperatura', 0.8),
          factor('cobertura_vegetal', 0.7),
        ]),
      );

      expect(plan.items.map((item) => item.id)).not.toContain('R-05');
      expect(plan.items.length).toBeLessThanOrEqual(4);
    }
  });
});

describe('determinism', () => {
  test('repeats the same plan for the same payload and leaves the payload untouched', () => {
    const input = batchOf('alto', [
      factor('temperatura', 0.18),
      factor('viento', 0.18),
      factor('incendios_historicos', 0.05),
    ]);
    const snapshot = structuredClone(input);

    const first = planRecommendations(input);
    const second = planRecommendations(input);

    expect(second).toEqual(first);
    expect(input).toEqual(snapshot);
    expect(ids(first)).toEqual(['R-06', 'R-08', 'R-03', 'R-04']);
  });
});
