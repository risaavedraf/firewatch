// PM-18 — the preventive-recommendation catalogue as a pure composition.
//
// The written catalogue lives in `odd/plan-produccion/catalogo-recomendaciones-preventivas.md`;
// this module is its only executable form on the card. It receives the batch the
// zone card already shows, and returns a list of items plus the notices that
// explain how the list was composed. Nothing else: no request, no persistence, no
// action. Creating an action remains item 11 of the client's request.
//
// The rules are the document's §2 and §5, in order:
//   1. an unknown, absent or out-of-set level fails closed — `desconocido`,
//      `null`, `"critico"` and a missing field all take the same branch, and none
//      is remapped to a similar severity;
//   2. the level picks a base pair in the order the document writes it;
//   3. up to two canonical variables with `known: true` AND `contribution > 0`
//      add one factor item each, ordered by contribution;
//   4. a tie is won by the earlier variable in the canonical order, which is the
//      order the contract and the rule already share — no extra criterion;
//   5. factor items come first, then the base pair;
//   6. an item identifier appears once and the gap a duplicate leaves is NOT
//      filled: a shorter list is declared, never padded;
//   7. the notices are prepended: unclassified level, synthetic batch, variables
//      without a reading, and the general-prevention limit.
//
// The only own number here is the presentation budget the document fixes (§2):
// two base items, two factor items, four on screen. `contribution > 0` is the
// calculation's own natural bound, not a new threshold.

import type { RiskLevel } from '../types/api';
import { isValidFactor, type ValidFactor } from './batch';
import { isRecord } from './guards';
import { canonicalLevel, levelLabel } from './risk-level';

export type RecommendationId =
  | 'R-01'
  | 'R-02'
  | 'R-03'
  | 'R-04'
  | 'R-05'
  | 'R-06'
  | 'R-07'
  | 'R-08';

// §3, verbatim. R-05 is catalogued but never composed: the system does not know
// whether vegetation touches power lines where the card points, so claiming it
// would be inventing a local condition.
export const RECOMMENDATION_TEXTS: Readonly<Record<RecommendationId, string>> = {
  'R-01': 'Retira la vegetación seca y los desechos acumulados alrededor de la vivienda.',
  'R-02':
    'Mantén despejadas, con anticipación, las vías de salida y los accesos que usarías ante una emergencia.',
  'R-03': 'Restringe fogatas, parrillas, quema de desechos y otras fuentes de calor cerca de vegetación.',
  'R-04':
    'Coordina con la municipalidad o la junta de vecinos una revisión del entorno y de las vías de salida.',
  'R-05':
    'Si ves vegetación en contacto con líneas eléctricas, avisa a la empresa distribuidora; no intervengas tú esa vegetación.',
  'R-06':
    'En días calurosos, evita herramientas y trabajos que generen chispas al aire libre, sobre todo cerca de vegetación.',
  'R-07':
    'Con el ambiente seco, no enciendas cigarrillos, fósforos ni nada que produzca calor cerca de vegetación.',
  'R-08': 'Con viento, no hagas fogatas ni quemas y no uses herramientas que produzcan chispas.',
};

// §1 — the five canonical variables, in the rule's own order. That order is the
// tie-break of step 5, so it is data here rather than an implicit iteration order.
export type RecommendationFactorName =
  | 'temperatura'
  | 'humedad_relativa'
  | 'viento'
  | 'cobertura_vegetal'
  | 'incendios_historicos';

export const CANONICAL_FACTOR_ORDER: readonly RecommendationFactorName[] = [
  'temperatura',
  'humedad_relativa',
  'viento',
  'cobertura_vegetal',
  'incendios_historicos',
];

// §1 — the base pair each classified level selects, in the written order.
const LEVEL_BASE: Readonly<Record<'bajo' | 'medio' | 'alto', readonly RecommendationId[]>> = {
  bajo: ['R-01', 'R-02'],
  medio: ['R-01', 'R-03'],
  alto: ['R-03', 'R-04'],
};

// §1 — the factor each canonical variable contributes.
const FACTOR_ITEM: Readonly<Record<RecommendationFactorName, RecommendationId>> = {
  temperatura: 'R-06',
  humedad_relativa: 'R-07',
  viento: 'R-08',
  cobertura_vegetal: 'R-01',
  incendios_historicos: 'R-04',
};

// §5 — the closed fallback. A level the rule did not classify never receives a
// factor item, even when a variable carries a positive contribution: ordering
// suggestions by contribution on an unclassified batch would imply a severity the
// rule refused to state.
const UNCLASSIFIED_BASE: readonly RecommendationId[] = ['R-01', 'R-02'];

// §2 — the presentation budget, and the only number this module owns.
const MAX_FACTOR_ITEMS = 2;

// §3 — the direct-observation item, for the card to offer as a consultable item.
// It is listed separately from the composition and is never a finding.
export const DIRECT_OBSERVATION: { readonly id: 'R-05'; readonly text: string } = {
  id: 'R-05',
  text: RECOMMENDATION_TEXTS['R-05'],
};

// §5 — the synthetic notice reuses, literally, the text the card already renders
// (`OverviewView` imports this constant for its own batch notice). The measures
// stay valid as general prevention text; what changes is that they do not
// describe a real zone.
export const SYNTHETIC_ENVIRONMENT_NOTICE = 'Entorno sintético: no riesgo real observado.';

const UNCLASSIFIED_LEVEL_NOTICE =
  'Nivel no clasificado: el sistema no tiene una evaluación validada de esta zona.';
const NO_READABLE_FACTORS_NOTICE = 'Sin factores con lectura en este lote.';
const MISSING_READING_PREFIX = 'Sin lectura: ';

// §6 — the limits the card states with the list. This is prevention for planning,
// not an alert, not an official risk classification and not an order.
export const GENERAL_PREVENTION_NOTICE =
  'Sugerencias de prevención general para planificar antes de una emergencia: no son una alerta oficial, ni una clasificación oficial de riesgo, ni una orden. Ante un incendio en curso, sigue las instrucciones de la autoridad.';

export type RecommendationSource = 'nivel' | 'factor';

export interface RecommendationItem {
  id: RecommendationId;
  text: string;
  /** Which side of the composition placed the item: the level or a variable. */
  source: RecommendationSource;
}

export type RecommendationNoticeKind =
  | 'nivel-no-clasificado'
  | 'entorno-sintetico'
  | 'sin-lectura'
  | 'sin-factores'
  | 'prevencion-general';

export interface RecommendationNotice {
  kind: RecommendationNoticeKind;
  text: string;
}

export interface RecommendationPlan {
  /** The canonical level the composition used, or `''` when the payload had none. */
  level: RiskLevel | '';
  /** The label the card shows for that level, from the one label rule it has. */
  levelLabel: string;
  items: RecommendationItem[];
  notices: RecommendationNotice[];
}

interface CanonicalReading {
  name: RecommendationFactorName;
  contribution: number;
}

interface CanonicalReadings {
  measured: CanonicalReading[];
  /** Variables with no reading: absent from the batch or explicitly unknown. */
  missing: RecommendationFactorName[];
}

function item(id: RecommendationId, source: RecommendationSource): RecommendationItem {
  return { id, text: RECOMMENDATION_TEXTS[id], source };
}

function itemsOf(ids: readonly RecommendationId[], source: RecommendationSource): RecommendationItem[] {
  return ids.map((id) => item(id, source));
}

// The five variables resolved from the entries that survive the same boundary
// guard the evidence panel uses. A duplicate name keeps its first valid entry, as
// the panel does, so the two readings of one batch cannot disagree. A variable
// that is absent or states `known: false` has no reading and is named rather than
// filled in; a reading of zero HAS a reading and simply does not participate.
function canonicalReadings(factors: unknown): CanonicalReadings {
  const valid: ValidFactor[] = Array.isArray(factors) ? factors.filter(isValidFactor) : [];
  const byName = new Map<string, ValidFactor>();
  for (const entry of valid) {
    if (!byName.has(entry.name)) byName.set(entry.name, entry);
  }

  const measured: CanonicalReading[] = [];
  const missing: RecommendationFactorName[] = [];
  for (const name of CANONICAL_FACTOR_ORDER) {
    const entry = byName.get(name);
    if (entry === undefined || entry.known !== true) {
      missing.push(name);
      continue;
    }
    measured.push({ name, contribution: entry.contribution });
  }
  return { measured, missing };
}

// Steps 4–6. `sort` is stable, so the array's canonical build order IS the
// documented tie-break and no second comparison is introduced.
function factorItems(readings: readonly CanonicalReading[]): RecommendationItem[] {
  return readings
    .filter((reading) => reading.contribution > 0)
    .sort((left, right) => right.contribution - left.contribution)
    .slice(0, MAX_FACTOR_ITEMS)
    .map((reading) => item(FACTOR_ITEM[reading.name], 'factor'));
}

// Step 8. The first occurrence keeps its place and its source; the later one is
// dropped and nothing is pulled in to fill the gap.
function dedupe(items: readonly RecommendationItem[]): RecommendationItem[] {
  const seen = new Set<RecommendationId>();
  const unique: RecommendationItem[] = [];
  for (const entry of items) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    unique.push(entry);
  }
  return unique;
}

export function planRecommendations(batch: unknown): RecommendationPlan {
  const source = isRecord(batch) ? batch : {};
  const level = canonicalLevel(source.risk_level);
  const { measured, missing } = canonicalReadings(source.factors);
  const notices: RecommendationNotice[] = [];

  if (source.demo === true) {
    notices.push({ kind: 'entorno-sintetico', text: SYNTHETIC_ENVIRONMENT_NOTICE });
  }

  const base = level === 'bajo' || level === 'medio' || level === 'alto' ? LEVEL_BASE[level] : null;
  let items: RecommendationItem[];

  if (base === null) {
    // §5 — no validated level. Only the closed fallback pair: no factor item and
    // no reading notice, because no variable took part in the composition.
    items = itemsOf(UNCLASSIFIED_BASE, 'nivel');
    notices.unshift({ kind: 'nivel-no-clasificado', text: UNCLASSIFIED_LEVEL_NOTICE });
  } else {
    items = dedupe([...factorItems(measured), ...itemsOf(base, 'nivel')]);
    if (missing.length === CANONICAL_FACTOR_ORDER.length) {
      notices.push({ kind: 'sin-factores', text: NO_READABLE_FACTORS_NOTICE });
    } else if (missing.length > 0) {
      notices.push({ kind: 'sin-lectura', text: `${MISSING_READING_PREFIX}${missing.join(', ')}.` });
    }
  }

  notices.push({ kind: 'prevencion-general', text: GENERAL_PREVENTION_NOTICE });

  return { level, levelLabel: levelLabel(level), items, notices };
}
