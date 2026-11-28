// Shared fixtures for the source quality resource (V1-P-05).
//
// Three suites read `GET /v1/risk/sources`, and since the closed catalogue and the
// per-source findings/review are REQUIRED members of the answer, every fixture that
// serves that route has to carry them. Keeping the shape here means a contract
// change is one edit instead of four copies that can drift.

export type QualityFindingCodeFixture =
  | 'STALE_CUTOFF'
  | 'MISSING_CANONICAL_FACTOR'
  | 'OUT_OF_RANGE_CLAMPED'
  | 'CHECKSUM_VERIFIED'
  | 'SYNTHETIC_FALLBACK';

export interface QualityDefinitionFixture {
  code: QualityFindingCodeFixture;
  kind: string;
  severity: 'warning' | 'info';
  description: string;
}

// The five codes in the ratified order, with the severity/kind the service
// publishes. A test that needs an undeclared code or a rewritten description
// overrides this copy instead of mutating the shared one.
export function qualityCatalogFixture(): QualityDefinitionFixture[] {
  return [
    {
      code: 'STALE_CUTOFF',
      kind: 'freshness',
      severity: 'warning',
      description:
        'La última lectura de la fuente está fuera de la ventana de frescura de 15 minutos, o la fuente no registra ninguna ejecución: el dato servido no está vigente.',
    },
    {
      code: 'MISSING_CANONICAL_FACTOR',
      kind: 'coverage',
      severity: 'warning',
      description:
        'La fuente no declara una o más de las cinco variables canónicas del clasificador; esas variables se publican como desconocidas en lugar de rellenarse.',
    },
    {
      code: 'OUT_OF_RANGE_CLAMPED',
      kind: 'range',
      severity: 'warning',
      description:
        'La fuente declaró un valor fuera de su rango nominal y el servicio sirve el valor acotado a ese rango, no el declarado.',
    },
    {
      code: 'CHECKSUM_VERIFIED',
      kind: 'integrity',
      severity: 'info',
      description:
        'La integridad SHA-256 del artefacto geográfico embebido coincide con el hash registrado y no se observaron anomalías.',
    },
    {
      code: 'SYNTHETIC_FALLBACK',
      kind: 'provenance',
      severity: 'info',
      description:
        'La fuente es el insumo sintético declarado por D-A: sus valores no son observaciones reales y se declaran como tales.',
    },
  ];
}

// One source entry, with every member the contract requires. `review` is null by
// default: a source nobody reviewed serves an explicit null, not a missing member.
export function sourceEntryFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source_id: 'fixture-sample',
    last_run_at: '2026-11-20T12:00:00Z',
    next_run_at: '2026-11-20T12:15:00Z',
    complete: true,
    age_seconds: 30,
    quality_findings: ['CHECKSUM_VERIFIED', 'SYNTHETIC_FALLBACK'],
    review: null,
    ...overrides,
  };
}

export function sourceReviewFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source_id: 'fixture-sample',
    decision: 'incorporated',
    note: 'revisado por operación',
    reviewed_by: 'operator@example.test',
    reviewed_at: '2026-11-20T12:05:00Z',
    ...overrides,
  };
}
