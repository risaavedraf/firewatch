import type { ReactNode } from 'react';

// The designed state of a field-work panel, shared by the three screens of T6
// (`#actions`, `#simulator`, `#observations`).
//
// Boards 06, 10 and 11 draw the same card for the three ways a panel can have
// nothing to show, and the product has to keep them apart: a read that returned
// no row is not a filter with no match, and neither is a read that failed. The
// card is therefore chosen by the state the view settled into, never by the
// absence of rows alone.
//
// Two properties matter here:
//   1. the card is STATIC content. The announcement of a state change belongs to
//      the view's `role="status"` line, which is the live region already on the
//      page; a second live region would say everything twice, so this component
//      renders none — not even an implicit one.
//   2. the card states no number and no value of its own. Every word it shows is
//      passed by the view, which is where the response is known.
//
// `tone` only selects the surface: an empty period, a filter with no match, or a
// refusal. It never changes the words, and the words never depend on colour.
export type FieldStateTone = 'empty' | 'filtered' | 'error';

export function FieldStateCard({
  id,
  tone = 'empty',
  eyebrow,
  title,
  children,
  action,
}: {
  id: string;
  tone?: FieldStateTone;
  eyebrow: string;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div id={id} className={`empty-state field-state field-state-${tone}`}>
      <p className="eyebrow">{eyebrow}</p>
      <strong>{title}</strong>
      {children === undefined ? null : <div className="field-state-body">{children}</div>}
      {action === undefined ? null : <div className="field-state-action">{action}</div>}
    </div>
  );
}
