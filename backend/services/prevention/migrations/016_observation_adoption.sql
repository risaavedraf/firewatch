-- 016: PM-10 decision log — the durable observation/action adoption.
--
-- Forward-only and guarded: re-applying this file is a no-op, and nothing here
-- backfills, updates or destroys data. Version 16 is the next free number in the
-- SHARED schema_migrations ledger: risk owns 001..008, 010, 012 and 013, this
-- service owns 009, 011, 014 and 015, so 16 is the next integer with both
-- services counted. The rule and its determination are in
-- backend/docs/migration-ledger.md.
--
-- One append-only table inside the `prevention` schema. Each row is the operator's
-- explicit confirmation that one recorded observation justifies one existing
-- preventive action:
--
--   observation_id  the observation being linked. It is the PRIMARY KEY, so "at
--                   most one action per observation" is a schema fact instead of a
--                   convention: a second, different link cannot be written at all.
--   action_id       the action the observation justifies. Many observations may
--                   back the same action, so this column is indexed but not
--                   unique. Cancelling the action later does not touch the row:
--                   the confirmation is the historical record of why the work was
--                   considered necessary, and a cancellation must not erase it. A
--                   new link to an already-cancelled action is refused by the
--                   service before it reaches this table.
--   confirmed_by    the verified token subject that confirmed the need. It is an
--                   audit field and is never a client-supplied identity: the
--                   operation's body has no actor field at all.
--   confirmed_at    the server clock.
--
-- Both references are foreign keys inside this same schema, so referential
-- integrity is enforced without adding an ordering dependency between the
-- prevention and risk migration runners: both tables are prevention's own and
-- version 15 is theirs. ON DELETE RESTRICT is explicit — an action or an
-- observation that is part of a durable confirmation cannot be deleted out from
-- under it.
--
-- The application role may read and append confirmations but never rewrite or
-- delete them: the durability guarantee is the grants below, not a convention.
-- prevention.observations itself stays append-only with no UPDATE grant, which is
-- why the association lives in its own table instead of in a new column.

CREATE TABLE IF NOT EXISTS prevention.observation_adoptions (
    observation_id uuid PRIMARY KEY
        REFERENCES prevention.observations(id) ON DELETE RESTRICT,
    action_id uuid NOT NULL
        REFERENCES prevention.actions(id) ON DELETE RESTRICT,
    confirmed_by text NOT NULL CHECK (btrim(confirmed_by) <> ''),
    confirmed_at timestamptz NOT NULL DEFAULT now()
);

-- Many observations may support one action, and the page that shows an action's
-- supporting observations reads by action. The primary key already serves the
-- per-observation lookup every adoption performs.
CREATE INDEX IF NOT EXISTS observation_adoptions_action
    ON prevention.observation_adoptions(action_id);

-- Read and append only. There is no UPDATE and no DELETE grant: a confirmation is
-- a record of a decision, and rewriting it would allow the link to be moved to a
-- different action after the fact.
GRANT SELECT, INSERT ON prevention.observation_adoptions TO risk_app;
