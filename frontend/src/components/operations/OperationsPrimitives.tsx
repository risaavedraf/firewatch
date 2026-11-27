import type { ReactNode } from 'react';

// T7 — the one presentation vocabulary the access and operations screens share.
//
// Boards 14-19 (acceso, fuentes, procesamiento, sesión, registro, prototipos)
// open with the same three things: an eyebrow, the screen's title and a lede,
// with the scope of the screen stated at the right. Below that they arrange
// their content as a main column and a side column, and they explain a sequence
// or a state vocabulary as numbered steps and labelled rows.
//
// These components decide WHERE those things sit and how they look. They decide
// nothing about whether they are true: every string a caller passes comes from
// the view's own derived state, and a component here never invents a label, a
// count or a state. The style rules live in `styles/operations-workspace.css`.

interface OperationsViewHeadProps {
  /** Wrapper id, used by the view's own tests and by `aria` references. */
  id?: string;
  eyebrow: string;
  title: string;
  /** The id the view already exposes for its title. */
  titleId: string;
  /** The lede may be a fragment when the view keeps an id inside it. */
  lede: ReactNode;
  /** Chips go here. They are `<span>`s: the head never carries a control. */
  children?: ReactNode;
}

export function OperationsViewHead({ id, eyebrow, title, titleId, lede, children }: OperationsViewHeadProps) {
  return (
    <div className="ops-view-head" id={id}>
      <div className="ops-view-head-copy">
        <p className="eyebrow">{eyebrow}</p>
        <h2 id={titleId}>{title}</h2>
        <p className="ops-lede">{lede}</p>
      </div>
      {children === undefined ? null : <div className="ops-chips">{children}</div>}
    </div>
  );
}

interface OperationsStep {
  readonly title: string;
  readonly detail: ReactNode;
}

interface OperationsStepsProps {
  id?: string;
  titleId: string;
  eyebrow?: string;
  title: string;
  items: readonly OperationsStep[];
  badge?: ReactNode;
  note?: ReactNode;
}

// A sequence the product really performs, in the order it performs it. The
// number is decorative (`aria-hidden`), so a screen reader hears the step's own
// sentence instead of "1" with no meaning.
export function OperationsSteps({ id, titleId, eyebrow, title, items, badge, note }: OperationsStepsProps) {
  return (
    <section className="ops-block" id={id} aria-labelledby={titleId}>
      <div className="ops-block-head">
        <div>
          {eyebrow === undefined ? null : <p className="eyebrow">{eyebrow}</p>}
          <h3 className="ops-block-title" id={titleId}>
            {title}
          </h3>
        </div>
        {badge}
      </div>
      <ol className="ops-steps">
        {items.map((item, index) => (
          <li className="ops-step" key={item.title}>
            <span className="ops-step-num" aria-hidden="true">
              {index + 1}
            </span>
            <div>
              <strong>{item.title}</strong>
              <p>{item.detail}</p>
            </div>
          </li>
        ))}
      </ol>
      {note === undefined ? null : <p className="ops-note">{note}</p>}
    </section>
  );
}

interface OperationsStateItem {
  readonly label: string;
  readonly detail: ReactNode;
}

interface OperationsStateListProps {
  id?: string;
  titleId: string;
  eyebrow?: string;
  title: string;
  items: readonly OperationsStateItem[];
  badge?: ReactNode;
  note?: ReactNode;
}

// The vocabulary the view can actually render: each row names a state in words
// and says what it means. It is a list, not a legend of colours and not a
// control surface.
export function OperationsStateList({
  id,
  titleId,
  eyebrow,
  title,
  items,
  badge,
  note,
}: OperationsStateListProps) {
  return (
    <section className="ops-block" id={id} aria-labelledby={titleId}>
      <div className="ops-block-head">
        <div>
          {eyebrow === undefined ? null : <p className="eyebrow">{eyebrow}</p>}
          <h3 className="ops-block-title" id={titleId}>
            {title}
          </h3>
        </div>
        {badge}
      </div>
      <ul className="ops-states">
        {items.map(item => (
          <li key={item.label}>
            <strong>{item.label}</strong>
            <span>{item.detail}</span>
          </li>
        ))}
      </ul>
      {note === undefined ? null : <p className="ops-note">{note}</p>}
    </section>
  );
}
