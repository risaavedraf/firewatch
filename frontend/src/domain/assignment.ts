// Assignment display rules for the preventive-action view (V1-U-04).
//
// Three facts travel with this module:
//   1. `assignee_id` is the reference a NEW assignment uses. It points at a user
//      of the realm's directory, which the service resolves before it stores
//      anything; the page never composes an identifier and never sends a name.
//   2. the legacy free-text `assignee` column is DISPLAY compatibility for rows
//      created before that reference existed. It is shown as the server stored
//      it and is never derived from `assignee_id`, nor offered as a new
//      assignment input.
//   3. the names come from `GET /v1/users`, which is admin-only. A name is
//      therefore known only while an authorized session has actually read the
//      directory, so an unread identifier is stated as the identifier rather
//      than guessed: this module never invents a person.

export const UNASSIGNED_ASSIGNEE = 'Sin asignar';

// The two assignment columns of a preventive action, as the contract serves
// them. Both are nullable (`*string` behind a tag without `omitempty`).
export interface AssigneeSource {
  readonly assignee?: string | null;
  readonly assignee_id?: string | null;
}

function trimmed(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

// The label a view renders for one action's responsible.
//
// The order is deliberate and closed:
//   1. the directory name for a reference assignment, when the directory has
//      been read and knows that identifier;
//   2. the legacy free text the server stored, when there is one;
//   3. the identifier itself, because it is the reference the contract quotes
//      and a name is not known here;
//   4. `Sin asignar`, which is an absence and never a guess.
//
// `names` is `null` when the directory has not been read under this session
// (unauthorized, failed, or not yet answered), so the caller's state decides
// whether a name can be shown at all.
export function assigneeLabel(action: AssigneeSource, names: ReadonlyMap<string, string> | null): string {
  const reference = trimmed(action.assignee_id);
  if (reference !== '') {
    const name = names?.get(reference);
    if (name !== undefined && name.trim() !== '') return name;
  }
  const legacy = trimmed(action.assignee);
  if (legacy !== '') return legacy;
  if (reference !== '') return reference;
  return UNASSIGNED_ASSIGNEE;
}
