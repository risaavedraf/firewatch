-- 017: persisted alerts for a zone's risk-level transitions.
--
-- 001_initial.sql through 013_ml_fixture_v1.sql are never edited: their versions
-- are already recorded in schema_migrations on every existing database, so an
-- edit there would never run again and would be silently ineffective. Version 14
-- is prevention's action assignee, and 15 and 16 are reserved by the registered
-- sibling branches of PM-09 and PM-10; 17 is the next free integer of the shared
-- ledger, which is why this file does not take a number next to risk's own 13.
--
-- Every statement here is guarded so applying the file twice is a no-op, and
-- nothing here destroys or backfills data: alerts begin with the first transition
-- stored after this migration runs. There is no backfill because a historical
-- transition is not recoverable from a table that already holds the levels in
-- order - reconstructing it here would invent alerts nobody observed and would
-- misdate them.
--
-- One row is one stored transition of one zone: the level the zone effectively had
-- immediately before, the level the new batch records, the threshold that made the
-- change an alert, and the instant of that assessment. The table is deliberately
-- narrow: it carries no read model, no acknowledgement state and no delivery
-- attempt, because those belong to PM-08 and a transport decision frozen here would
-- have to be migrated away again.
--
-- batch_id names the batch that produced the alert and is UNIQUE. That is the
-- idempotency key: a broker redelivery, an operator re-dispatch or a retried
-- transaction that reaches the insert again collides instead of storing a second
-- alert for the same transition. There is deliberately no unique key on
-- (zone_id, previous_level, new_level): the same ascent legitimately happens twice,
-- weeks apart, and collapsing those two alerts would erase one of them.
--
-- The levels are constrained to the three determined ones. `desconocido` is not a
-- risk level - it records that the inputs were insufficient - so an alert naming it
-- is refused by the schema as well as by the writer, and PM-08 never has to explain
-- a "level" that is an absence of data. The change constraint states the other half
-- of the same policy: an alert exists only when the level moved.
--
-- threshold is the agreed value, written in every row instead of being assumed: one
-- severity step, the smallest change two determined levels can have, which is
-- exactly "an alert on any ascent or descent between known levels" (S2). Storing it
-- keeps a stored alert self-describing after the policy is revisited: a later
-- threshold applies to the rows written with it, not retroactively to these.
CREATE TABLE IF NOT EXISTS risk_alerts (
    id             uuid        PRIMARY KEY,
    zone_id        text        NOT NULL REFERENCES zones(code),
    batch_id       uuid        NOT NULL REFERENCES batches(id),
    previous_level text        NOT NULL,
    new_level      text        NOT NULL,
    threshold      integer     NOT NULL DEFAULT 1,
    occurred_at    timestamptz NOT NULL,
    CONSTRAINT risk_alerts_batch_identity UNIQUE (batch_id),
    CONSTRAINT risk_alerts_levels_check CHECK (previous_level IN ('bajo','medio','alto') AND new_level IN ('bajo','medio','alto')),
    CONSTRAINT risk_alerts_change_check CHECK (previous_level <> new_level),
    CONSTRAINT risk_alerts_threshold_check CHECK (threshold >= 1)
);

-- PM-08 lists these rows newest first and paginates them. (occurred_at, id) is the
-- ordering key, with the identifier as the deterministic tie-break that keeps a
-- page boundary stable when two alerts share an instant - the same newest-first
-- convention the batch reads already use.
CREATE INDEX IF NOT EXISTS risk_alerts_timeline ON risk_alerts(occurred_at DESC, id DESC);

-- The application role records alerts and reads them back; only the migration
-- owner creates schema. The role gets no rewrite and no removal privilege: an
-- alert is evidence that a transition happened, so a correction is a new
-- transition and not an edited row.
GRANT SELECT, INSERT ON risk_alerts TO risk_app;
