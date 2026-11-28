import type { ActionStageGroup, PreventiveAction } from '../types/api';

// V1-P-03 — the canonical four-stage projection of the eight frozen preventive
// action statuses, transcribed for the page.
//
// Two facts travel with this module:
//   1. it is a TRANSCRIPTION, not an authority. The service computes
//      `stage_group` from `status` and the contract publishes the field, so a
//      response that declares a group is what the page shows; the projection
//      below is used only when an older payload omits it, and it follows the
//      same ratified 8 → 4 table (`stage.go` on the service side);
//   2. the eight statuses and their transitions are untouched. A group is a
//      reading of a state, never a state of its own: it authorizes nothing and
//      renames nothing.

// The four groups in the order the service and the contract publish them.
export const ACTION_STAGE_GROUPS = ['candidate', 'in_progress', 'reviewed', 'closed'] as const;

// The ratified 8 → 4 table:
//
//	candidate    propuesta (DRAFT), asignada (ASSIGNED)
//	in_progress  en_curso (IN_PROGRESS), enviada (EVIDENCE_SUBMITTED)
//	reviewed     bloqueada (UNDER_REVIEW), devuelta (REJECTED)
//	closed       aceptada (COMPLETED), cancelada (CANCELLED)
const STAGE_OF_STATUS: Readonly<Record<string, ActionStageGroup>> = {
  propuesta: 'candidate',
  asignada: 'candidate',
  en_curso: 'in_progress',
  enviada: 'in_progress',
  bloqueada: 'reviewed',
  devuelta: 'reviewed',
  aceptada: 'closed',
  cancelada: 'closed',
};

// The words the chips render. The status labels of `domain/prevention.ts` stay
// as they are: a row shows both, so the projection cannot be mistaken for the
// state or the reverse.
const STAGE_LABELS: Readonly<Record<ActionStageGroup, string>> = {
  candidate: 'Candidata',
  in_progress: 'En curso',
  reviewed: 'En revisión',
  closed: 'Cerrada',
};

// A closed vocabulary: the four values the contract declares.
export function isActionStageGroup(value: unknown): value is ActionStageGroup {
  return typeof value === 'string' && (ACTION_STAGE_GROUPS as readonly string[]).includes(value);
}

// The group one of the eight frozen statuses projects onto, or `null` when the
// status is not one the contract declares. Nothing is guessed for an unknown
// status: the page says the state is not declared instead.
export function stageGroupOfStatus(status: string): ActionStageGroup | null {
  return Object.prototype.hasOwnProperty.call(STAGE_OF_STATUS, status) ? STAGE_OF_STATUS[status] : null;
}

// The two facts a row needs to answer which group it belongs to. `stage_group` is
// typed `string` rather than the closed union on purpose: the contract declares
// four values, and a response that carries a fifth one has to be shown as it
// arrived instead of being silently narrowed into a group it never named.
type StageCarryingAction = { readonly status: string; readonly stage_group?: string | null };

// What a row shows: the group the response declares; the deterministic projection
// of its `status` when the field is absent; and the raw token when the response
// declares something the contract does not — never translated into a group the
// contract does not declare.
export function stageGroupOfAction(action: StageCarryingAction): string | null {
  if (typeof action.stage_group === 'string' && action.stage_group !== '') return action.stage_group;
  return stageGroupOfStatus(action.status);
}

// A declared group gets its Spanish label; anything else is shown raw rather than
// silently translated into a value the contract never declared.
export function stageGroupLabel(group: string): string {
  return isActionStageGroup(group) ? STAGE_LABELS[group] : group;
}

// Whether the row belongs to the group. Only declared groups are offered as
// filters, so a token outside the vocabulary is visible with «Todas» and is never
// claimed by one of the four chips.
export function matchesStageGroup(action: StageCarryingAction, group: string): boolean {
  return stageGroupOfAction(action) === group;
}

// The number of returned rows in each group. It counts the rows the service
// returned, never a total the page did not read.
export function stageGroupCounts(actions: readonly PreventiveAction[]): Readonly<Record<ActionStageGroup, number>> {
  const counts: Record<ActionStageGroup, number> = {
    candidate: 0,
    in_progress: 0,
    reviewed: 0,
    closed: 0,
  };
  for (const action of actions) {
    const group = stageGroupOfAction(action);
    if (isActionStageGroup(group)) counts[group] += 1;
  }
  return counts;
}
