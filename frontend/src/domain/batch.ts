import type { EvaluationTrigger, RiskLevel } from '../types/api';
import { isFiniteNumber, isNonEmptyString, isRecord } from './guards';
import { canonicalLevel } from './risk-level';

// Fail-closed batch acceptance. A batch is only presentable when every part the
// panel relies on is present and well-formed; anything else is explicitly
// invalid so the view can name what was missing instead of showing a plausible
// severity it cannot support.

export interface ValidFactor {
  name: string;
  known: boolean;
  value: number;
  contribution: number;
  note: string;
}

export function isValidFactor(factor: unknown): factor is ValidFactor {
  return (
    isRecord(factor) &&
    isNonEmptyString(factor.name) &&
    typeof factor.known === 'boolean' &&
    typeof factor.note === 'string' &&
    isFiniteNumber(factor.value) &&
    isFiniteNumber(factor.contribution)
  );
}

export type BatchOmission = 'nivel' | 'procedencia demo' | 'factores' | 'justificación' | 'política';

export interface BatchPresentation {
  valid: boolean;
  omissions: BatchOmission[];
  /** Only the factors that are individually valid; the order is preserved. */
  factors: ValidFactor[];
  policyValid: boolean;
  /** The canonical level, or empty when the batch is not valid as a whole. */
  level: RiskLevel | '';
}

function policyIsValid(policy: unknown): boolean {
  return (
    isRecord(policy) &&
    isNonEmptyString(policy.policy_id) &&
    isNonEmptyString(policy.params_hash) &&
    isRecord(policy.parameters) &&
    Object.keys(policy.parameters).length > 0 &&
    Object.entries(policy.parameters).every(
      ([key, value]) => isNonEmptyString(key) && typeof value === 'string',
    )
  );
}

export function presentBatch(batch: unknown): BatchPresentation {
  const source = isRecord(batch) ? batch : {};
  const rawFactors = Array.isArray(source.factors) ? source.factors : [];
  const factors = rawFactors.filter(isValidFactor);
  const policyValid = policyIsValid(source.policy);

  const omissions: BatchOmission[] = [];
  if (canonicalLevel(source.risk_level) === '') omissions.push('nivel');
  if (typeof source.demo !== 'boolean') omissions.push('procedencia demo');
  if (rawFactors.length === 0 || !rawFactors.every(isValidFactor)) omissions.push('factores');
  if (!isNonEmptyString(source.rationale)) omissions.push('justificación');
  if (!policyValid) omissions.push('política');

  const valid = omissions.length === 0;
  return {
    valid,
    omissions,
    factors,
    policyValid,
    level: valid ? canonicalLevel(source.risk_level) : '',
  };
}

// The only outcomes the latest read may take. A 404 is "no published batch" — an
// absence the map paints neutral — and never a low risk that was never computed.
export type LatestOutcome = 'ok' | 'no-published-batch' | 'unauthorized' | 'forbidden' | 'error';

export function latestOutcome(status: number): LatestOutcome {
  if (status === 200) return 'ok';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'no-published-batch';
  return 'error';
}

// ── Provenance of the evaluation itself (V1-P-06) ────────────────────────
//
// `BatchCore` declares `evaluation_trigger` (`scheduler` or `manual`) and
// `evaluated_by`: the verified token subject of the operator who asked for a
// manual evaluation, and null for a scheduled one — a run nobody requested has no
// actor to attribute. The batch was published with that provenance and the page
// used to leave it invisible, so a manual publication read exactly like the
// automatic cycle's.
//
// This reads the payload rather than the declared type on purpose: the two members
// are read here as `unknown`, which is the same fail-closed entry `presentBatch`
// takes, so a batch that predates them is still presentable while its provenance
// is stated as not reported instead of guessed. Nothing here upgrades a missing or
// contradictory provenance into a manual evaluation.
//
// The trigger union is NOT redeclared here: it lives with the shared payload
// declarations in `types/api.ts` and the transport validates it against the same
// closed catalogue, so the domain, the guard and the declaration cannot drift into
// three spellings of the same two words.
export interface BatchProvenance {
  /** True only when the payload proves one of the two documented evaluations. */
  readonly reported: boolean;
  readonly trigger: EvaluationTrigger | '';
  /** The verified subject of the operator, or `''` when there is no actor. */
  readonly actor: string;
  /** The sentence the panel renders, never a placeholder for a missing fact. */
  readonly label: string;
}

const PROVENANCE_NOT_REPORTED =
  'Procedencia de la evaluación no informada: el lote no declara una evaluación manual con operador ni una evaluación programada.';

export function batchProvenance(batch: unknown): BatchProvenance {
  const notReported: BatchProvenance = {
    reported: false,
    trigger: '',
    actor: '',
    label: PROVENANCE_NOT_REPORTED,
  };
  if (!isRecord(batch)) return notReported;

  const trigger = batch.evaluation_trigger;
  const actor = batch.evaluated_by;

  // A manual evaluation always records its operator: the service takes it from the
  // verified token, so a manual trigger without one is a contradiction and not a
  // provenance this page can show.
  if (trigger === 'manual') {
    if (!isNonEmptyString(actor)) return notReported;
    return {
      reported: true,
      trigger: 'manual',
      actor,
      label: `Evaluación manual · operador verificado: ${actor}.`,
    };
  }

  // A scheduled run has no actor. A non-empty one there contradicts the contract,
  // so the pair is reported as unproven rather than presented as scheduled.
  if (trigger === 'scheduler') {
    if (actor !== undefined && actor !== null && actor !== '') return notReported;
    return {
      reported: true,
      trigger: 'scheduler',
      actor: '',
      label: 'Evaluación programada · nadie la solicitó, así que no hay operador que atribuir.',
    };
  }

  return notReported;
}
