// How the served source-quality evidence is stated (`GET /v1/risk/sources`, V1-P-05).
//
// Framework-free, DOM-free and transport-free: the transport decides whether the
// payload is the documented one, and this module decides how the served facts are
// said. Nothing here invents a finding, a review or a severity: the catalogue comes
// from the service, and an absent review is stated as absent.
import type {
  QualityFindingCode,
  QualityFindingDefinition,
  SourceQualityEntry,
  SourceReview,
  SourceReviewDecision,
} from '../types/api';

// The Spanish label of each code. They are labels, not translations of the
// service's description: the description is reproduced verbatim beside them, and a
// label the catalogue does not name cannot occur because the transport refuses an
// undeclared code.
const QUALITY_FINDING_LABELS: Readonly<Record<QualityFindingCode, string>> = {
  STALE_CUTOFF: 'Fuera de la ventana de frescura',
  MISSING_CANONICAL_FACTOR: 'Factor canónico ausente',
  OUT_OF_RANGE_CLAMPED: 'Valor fuera de rango, acotado',
  CHECKSUM_VERIFIED: 'Integridad SHA-256 verificada',
  SYNTHETIC_FALLBACK: 'Insumo sintético declarado',
};

export function qualityFindingLabel(code: QualityFindingCode): string {
  return QUALITY_FINDING_LABELS[code];
}

// Severity is written, never implied by colour: a warning and an informational
// finding must stay distinguishable without seeing the badge's paint.
export function qualitySeverityLabel(severity: string): string {
  return severity === 'warning' ? 'Aviso' : 'Informativo';
}

const REVIEW_DECISION_LABELS: Readonly<Record<SourceReviewDecision, string>> = {
  incorporated: 'Incorporada',
  acknowledged: 'Aceptada sin incorporar',
};

export function reviewDecisionLabel(decision: SourceReviewDecision): string {
  return REVIEW_DECISION_LABELS[decision];
}

// The instant the service served, reproduced verbatim. A review without a readable
// instant is not a review this module will date, so an empty value stays empty and
// the panel says it was not reported instead of borrowing the client clock.
export function reviewInstantLabel(value: string): string {
  return value.trim() === '' ? 'fecha no informada' : value;
}

// The sentence the panel states about the review in force. `null` is the served
// absence of a review, which is stated as such - never as an empty review and
// never as an approval.
export function reviewStatusText(review: SourceReview | null): string {
  if (review === null) {
    return 'Ninguna revisión registrada para esta fuente: la acción está disponible y el servidor fija el actor.';
  }
  const note = review.note.trim() === '' ? 'sin nota' : `nota: ${review.note}`;
  return `Revisión vigente: ${reviewDecisionLabel(review.decision).toLowerCase()} por ${review.reviewed_by} el ${reviewInstantLabel(
    review.reviewed_at,
  )} · ${note}.`;
}

// The source the review controls address: the first served source, or the active
// input's identifier when the cycle reports none. An empty result means there is
// nothing this page can ask the server to review, which the panel says instead of
// offering a disabled-looking form.
export function reviewTargetId(entries: readonly SourceQualityEntry[], riskInputId: string): string {
  const first = entries[0];
  if (first !== undefined) return first.source_id;
  return riskInputId.trim();
}

// The findings of one entry as label/severity pairs, in the order the service
// published them. The order is the catalogue's, so it is never re-sorted here.
export interface QualityFindingLine {
  readonly code: QualityFindingCode;
  readonly label: string;
  readonly severity: 'warning' | 'info';
  readonly description: string;
}

export function qualityFindingLines(
  findings: readonly QualityFindingCode[],
  catalog: readonly QualityFindingDefinition[],
): QualityFindingLine[] {
  const lines: QualityFindingLine[] = [];
  for (const code of findings) {
    const definition = catalog.find(entry => entry.code === code);
    if (definition === undefined) continue;
    lines.push({
      code,
      label: qualityFindingLabel(code),
      severity: definition.severity,
      description: definition.description,
    });
  }
  return lines;
}
