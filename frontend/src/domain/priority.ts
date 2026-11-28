// V1-P-02 / PM-11 — what the regional priority payload means to a reader.
//
// The backend computed every number here; this module only decides how to say it
// and what to say when something is missing. It never recomputes the index: a
// priority the API did not serve is shown as absent, never derived from the level
// or from the exposure alone, because a derived rank would be a position nobody
// calculated.
import type { ZonePriority } from '../types/api';

export const PRIORITY_ABSENT_COPY =
  'Sin contexto regional: la API no publicó prioridad ni puesto para esta comuna, así que no se muestra ninguno.';

// A block that claims a position but cannot support it is not explained either: its
// own `context_summary` would state a rank the data contradicts, so the reader gets the
// absence with the reason instead of a sentence nobody can stand behind.
export const PRIORITY_CONTRADICTORY_COPY =
  'Sin contexto regional: la API marcó la prioridad como publicada pero no sostiene el puesto (nivel desconocido o puntaje ausente), así que no se muestra un puesto.';
export const PRIORITY_UNRANKED_COPY = 'sin categoría ponderada';

// Three states exist because the page distinguishes them: a network or storage
// answer that carried no context, a context that says the zone holds no position,
// and a context that does.
export type PriorityView =
  | { kind: 'absent'; reason: string }
  | {
      kind: 'ranked';
      riskLevel: string;
      riskScore: number;
      exposureScore: number;
      priorityScore: number;
      rank: number;
      total: number;
      assets: number;
      dominant: string | null;
      summary: string;
    }
  | {
      kind: 'insufficient';
      riskLevel: string;
      exposureScore: number;
      assets: number;
      dominant: string | null;
      summary: string;
    };

export function priorityView(priority: ZonePriority | null | undefined): PriorityView {
  if (priority === undefined || priority === null) {
    return { kind: 'absent', reason: PRIORITY_ABSENT_COPY };
  }
  // A `ranked` block that names `desconocido` contradicts S3: the rule could not
  // decide, so no position exists. The projection refuses it even when a caller hands
  // the object over directly, without going through the transport guard.
  const ranked =
    priority.priority_status === 'ranked' &&
    priority.risk_level !== 'desconocido' &&
    priority.priority_rank !== null &&
    priority.priority_score !== null &&
    priority.risk_score !== null;
  if (ranked) {
    return {
      kind: 'ranked',
      riskLevel: String(priority.risk_level),
      riskScore: priority.risk_score as number,
      exposureScore: priority.exposure_score,
      priorityScore: priority.priority_score as number,
      rank: priority.priority_rank as number,
      total: priority.total_ranked_zones,
      assets: priority.exposed_assets_count,
      dominant: priority.dominant_category,
      summary: priority.context_summary,
    };
  }
  if (priority.priority_status === 'ranked') {
    // The block claims a position but fails the invariant above. Keeping its
    // `context_summary` would print a rank the data does not support, so the payload
    // degrades to the absence state instead of being explained as insufficient.
    return { kind: 'absent', reason: PRIORITY_CONTRADICTORY_COPY };
  }
  return {
    kind: 'insufficient',
    riskLevel: String(priority.risk_level),
    exposureScore: priority.exposure_score,
    assets: priority.exposed_assets_count,
    dominant: priority.dominant_category,
    summary: priority.context_summary,
  };
}

// A number the API did not serve is an em dash, never a zero: the two mean
// different things to an operator.
export function priorityNumber(value: number | null | undefined): string {
  return typeof value === 'number' ? String(value) : '—';
}

export function priorityRankLabel(rank: number | null | undefined, total: number | null | undefined): string {
  if (typeof rank !== 'number' || typeof total !== 'number' || total < 1) return '—';
  return `#${rank} de ${total}`;
}

export function dominantCategoryLabel(dominant: string | null | undefined): string {
  return typeof dominant === 'string' && dominant !== '' ? dominant : PRIORITY_UNRANKED_COPY;
}

// The status sentence of the zone detail card. It names the served rule inputs and
// the position; it never claims a forecast or a cause.
export function priorityStatusCopy(view: PriorityView): string {
  switch (view.kind) {
    case 'absent':
      return view.reason;
    case 'insufficient':
      return `El lote publicado no permite calcular prioridad (nivel ${view.riskLevel} o sin contribuciones usables), así que no se le asigna puesto regional. Exposición ${view.exposureScore} de 100.`;
    case 'ranked':
      return `Prioridad del lote publicado: riesgo ${view.riskScore} de 100 y exposición ${view.exposureScore} de 100; categoría dominante ${dominantCategoryLabel(view.dominant)}.`;
  }
}

// The compact per-comuna line of the infrastructure table and its breakdown. It
// repeats the three served numbers in one sentence so a printed row stays readable
// on its own.
export function priorityLineCopy(view: PriorityView): string {
  switch (view.kind) {
    case 'absent':
      // The absence carries its own reason: a payload that never arrived and one that
      // contradicted itself are different facts, and neither prints a position.
      return view.reason;
    case 'insufficient':
      return `Sin puesto regional: el lote publicado no trae contribuciones usables o su nivel es desconocido. Exposición ${view.exposureScore} de 100 sobre ${view.assets} elementos ficticios.`;
    case 'ranked':
      return `Prioridad ${view.priorityScore} de 100 · puesto #${view.rank} de ${view.total} · exposición ${view.exposureScore} de 100 · categoría dominante ${dominantCategoryLabel(view.dominant)}.`;
  }
}
