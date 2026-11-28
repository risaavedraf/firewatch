// V1-P-01 / PM-12 — the land-cover layer as the page reads it.
//
// The backend computed every number; this suite pins only what the page is allowed
// to say. A missing entry and a self-contradicting entry are different facts and
// both print no number, the dominant class is the served maximum with the declared
// tie-break, and the layer never claims to replace the scalar `cobertura_vegetal`.

import {
  ENVIRONMENT_CLASS_LABELS,
  LAND_COVER_ABSENT_COPY,
  LAND_COVER_BADGE,
  LAND_COVER_CONTRADICTORY_COPY,
  LAND_COVER_LABELS,
  dominantShare,
  environmentDistribution,
  landCoverView,
  sectorCoverageRows,
  sharesOf,
} from '../../src/domain/vegetation';
import type { LandCoverBreakdown, VegetationCatalogue, ZoneLandCover } from '../../src/types/api';

function breakdown(overrides: Partial<LandCoverBreakdown> = {}): LandCoverBreakdown {
  return {
    bosque_nativo_pct: 20,
    plantacion_forestal_pct: 10,
    matorral_pastizal_pct: 40,
    interfaz_urbano_forestal_pct: 20,
    suelo_desnudo_agua_pct: 10,
    ...overrides,
  };
}

function landCover(overrides: Partial<ZoneLandCover> = {}): ZoneLandCover {
  return {
    zone_id: '05101',
    zone_name: 'Valparaíso',
    ndvi_mean: 0.61,
    ndvi_min: 0.55,
    ndvi_max: 0.68,
    ndvi_anomaly: -0.04,
    land_cover_breakdown: breakdown(),
    environment_class: 'WUI_ALTA',
    synthetic: true,
    source_label: 'SINTETICO_SEED_V1',
    ...overrides,
  };
}

function catalogue(zones: ZoneLandCover[]): VegetationCatalogue {
  return { source: 'SINTETICO_SEED_V1', zones };
}

// ── The three states ───────────────────────────────────────────────────────

test('an absent entry is an explicit absence with its own reason', () => {
  for (const missing of [undefined, null]) {
    const view = landCoverView(missing);
    expect(view.kind).toBe('absent');
    if (view.kind !== 'absent') throw new Error('unreachable');
    expect(view.reason).toBe(LAND_COVER_ABSENT_COPY);
    expect(view.reason).toMatch(/no publicó la capa de vegetación/i);
  }
});

test('a served entry is projected with its own numbers, never a derived value', () => {
  const view = landCoverView(landCover());
  if (view.kind !== 'present') throw new Error(`expected a present view, got ${view.kind}`);
  expect(view.zoneId).toBe('05101');
  expect(view.zoneName).toBe('Valparaíso');
  expect(view.environment).toBe(ENVIRONMENT_CLASS_LABELS.WUI_ALTA);
  expect(view.environmentClass).toBe('WUI_ALTA');
  // Two decimals, read from the payload: no re-rounding and no re-scaling.
  expect(view.ndviMean).toBe('0.61');
  expect(view.ndviRange).toBe('0.55–0.68');
  expect(view.ndviAnomaly).toBe('-0.04');
  expect(view.synthetic).toBe(LAND_COVER_BADGE);
  expect(view.synthetic).toContain('SINTETICO_SEED_V1');
  expect(view.shares.map(share => share.key)).toEqual([
    'bosque_nativo_pct',
    'plantacion_forestal_pct',
    'matorral_pastizal_pct',
    'interfaz_urbano_forestal_pct',
    'suelo_desnudo_agua_pct',
  ]);
  expect(view.shares.map(share => share.percent)).toEqual(['20%', '10%', '40%', '20%', '10%']);
  expect(view.dominant.label).toBe(LAND_COVER_LABELS.matorral_pastizal_pct);
  expect(view.dominant.percent).toBe('40%');
  // The copy says what the layer is NOT: it never replaces the rule's variable.
  expect(view.summary).toMatch(/no sustituye la variable escalar/i);
});

test('an entry that contradicts an invariant is refused instead of explained', () => {
  const cases: [string, ZoneLandCover][] = [
    ['min above mean', landCover({ ndvi_min: 0.99, ndvi_mean: 0.61 })],
    ['mean above max', landCover({ ndvi_mean: 0.99, ndvi_max: 0.68 })],
    ['mean outside the unit interval', landCover({ ndvi_mean: 1.4, ndvi_max: 1.5 })],
    ['non-finite anomaly', landCover({ ndvi_anomaly: Number.NaN })],
    ['anomaly out of range', landCover({ ndvi_anomaly: 1.5 })],
    ['breakdown below one hundred', landCover({ land_cover_breakdown: breakdown({ suelo_desnudo_agua_pct: 9 }) })],
    ['breakdown above one hundred', landCover({ land_cover_breakdown: breakdown({ suelo_desnudo_agua_pct: 11 }) })],
    ['share out of range', landCover({ land_cover_breakdown: breakdown({ bosque_nativo_pct: 140, suelo_desnudo_agua_pct: -20 }) })],
    ['an undeclared class', landCover({ environment_class: 'BOSQUE' as never })],
    ['an undeclared provenance', landCover({ source_label: 'COPERNICUS' as never })],
    ['an observation claim', landCover({ synthetic: false as never })],
    ['a blank zone name', landCover({ zone_name: '' })],
  ];
  for (const [name, zone] of cases) {
    const view = landCoverView(zone);
    expect(view.kind, name).toBe('absent');
    if (view.kind !== 'absent') continue;
    expect(view.reason, name).toBe(LAND_COVER_CONTRADICTORY_COPY);
  }
});

// ── The declared split ─────────────────────────────────────────────────────

test('the dominant class is the served maximum, with the declared order as tie-break', () => {
  // A tie keeps the first declared key, so the answer never depends on object order.
  const tie = breakdown({
    bosque_nativo_pct: 30,
    plantacion_forestal_pct: 30,
    matorral_pastizal_pct: 10,
    interfaz_urbano_forestal_pct: 10,
    suelo_desnudo_agua_pct: 20,
  });
  expect(dominantShare(tie)?.key).toBe('bosque_nativo_pct');

  const heavy = breakdown({
    bosque_nativo_pct: 5,
    plantacion_forestal_pct: 5,
    matorral_pastizal_pct: 5,
    interfaz_urbano_forestal_pct: 80,
    suelo_desnudo_agua_pct: 5,
  });
  expect(dominantShare(heavy)?.key).toBe('interfaz_urbano_forestal_pct');
});

test('a split that is not the declared five yields no shares at all', () => {
  expect(sharesOf(breakdown({ bosque_nativo_pct: 120, suelo_desnudo_agua_pct: -10 }))).toEqual([]);
  expect(dominantShare(breakdown({ plantacion_forestal_pct: -1 }))).toBeNull();
});

// ── The sector table and the territory summary ─────────────────────────────

test('the sector table lists every served commune in the order the service used', () => {
  const rows = sectorCoverageRows(
    catalogue([
      landCover({ zone_id: '05101', zone_name: 'Valparaíso' }),
      landCover({ zone_id: '05102', zone_name: 'Casablanca', environment_class: 'FORESTAL_DENSO' }),
    ]),
  );
  expect(rows).toEqual([
    {
      zoneId: '05101',
      zoneName: 'Valparaíso',
      environment: ENVIRONMENT_CLASS_LABELS.WUI_ALTA,
      ndviMean: '0.61',
      dominant: `${LAND_COVER_LABELS.matorral_pastizal_pct} (40%)`,
      synthetic: LAND_COVER_BADGE,
    },
    {
      zoneId: '05102',
      zoneName: 'Casablanca',
      environment: ENVIRONMENT_CLASS_LABELS.FORESTAL_DENSO,
      ndviMean: '0.61',
      dominant: `${LAND_COVER_LABELS.matorral_pastizal_pct} (40%)`,
      synthetic: LAND_COVER_BADGE,
    },
  ]);
});

test('an unread catalogue produces no rows, never a placeholder commune', () => {
  expect(sectorCoverageRows(null)).toEqual([]);
  expect(sectorCoverageRows(catalogue([]))).toEqual([]);
  // A contradiction is dropped from the table instead of printed as a profile.
  expect(sectorCoverageRows(catalogue([landCover({ synthetic: false as never })]))).toEqual([]);
});

test('the territory summary counts the served classes, zero included', () => {
  const distribution = environmentDistribution(
    catalogue([
      landCover({ zone_id: '05101', environment_class: 'WUI_ALTA' }),
      landCover({ zone_id: '05102', environment_class: 'WUI_ALTA' }),
      landCover({ zone_id: '05103', environment_class: 'PERIURBANO' }),
    ]),
  );
  expect(distribution.map(entry => [entry.environmentClass, entry.count])).toEqual([
    ['WUI_ALTA', 2],
    ['FORESTAL_DENSO', 0],
    ['MIXTO_RURAL', 0],
    ['PERIURBANO', 1],
  ]);
  expect(environmentDistribution(null).every(entry => entry.count === 0)).toBe(true);
});

// ── A breakdown the payload cannot support ─────────────────────────────────
//
// `landCoverView` is called with whatever a caller hands over, not only with a
// transport-checked payload, so it must be total: a missing, null or non-object
// `land_cover_breakdown` is an absence with its reason and never a thrown error.
// The key count is part of the declared shape, so an extra key is refused exactly
// as the transport guard refuses it.

test('a missing, null or non-object breakdown is an absence instead of a crash', () => {
  const cases: [string, unknown][] = [
    ['null', null],
    ['missing', undefined],
    ['an array', []],
    ['a string', 'bosque_nativo_pct=100'],
  ];
  for (const [name, value] of cases) {
    const zone = { ...landCover(), land_cover_breakdown: value } as unknown as ZoneLandCover;
    // The projection must answer, not throw.
    const view = landCoverView(zone);
    expect(view.kind, name).toBe('absent');
    if (view.kind !== 'absent') continue;
    expect(view.reason, name).toBe(LAND_COVER_CONTRADICTORY_COPY);
    // The sector table walks the same entries: it drops the row instead of failing.
    expect(sectorCoverageRows(catalogue([zone])), name).toEqual([]);
  }
});

test('a breakdown that carries an extra key or drops a declared one is refused', () => {
  const extra = {
    ...landCover(),
    land_cover_breakdown: {
      bosque_nativo_pct: 20,
      plantacion_forestal_pct: 10,
      matorral_pastizal_pct: 40,
      interfaz_urbano_forestal_pct: 20,
      suelo_desnudo_agua_pct: 10,
      suelo_urbano_pct: 0,
    },
  } as unknown as ZoneLandCover;
  const extraView = landCoverView(extra);
  expect(extraView.kind).toBe('absent');
  if (extraView.kind === 'absent') expect(extraView.reason).toBe(LAND_COVER_CONTRADICTORY_COPY);

  // Four declared keys are not the declared five, even when they still sum to 100.
  const missing = {
    ...landCover(),
    land_cover_breakdown: {
      bosque_nativo_pct: 30,
      plantacion_forestal_pct: 10,
      matorral_pastizal_pct: 40,
      interfaz_urbano_forestal_pct: 20,
    },
  } as unknown as ZoneLandCover;
  const missingView = landCoverView(missing);
  expect(missingView.kind).toBe('absent');
  if (missingView.kind === 'absent') expect(missingView.reason).toBe(LAND_COVER_CONTRADICTORY_COPY);
});

test('the exported split helpers are total too: a broken breakdown yields nothing', () => {
  // Both helpers are exported, so a caller can hand them anything the type allows.
  expect(sharesOf(null as never)).toEqual([]);
  expect(dominantShare(null as never)).toBeNull();
  const extra = { ...breakdown(), suelo_urbano_pct: 0 } as unknown as LandCoverBreakdown;
  expect(sharesOf(extra)).toEqual([]);
});
