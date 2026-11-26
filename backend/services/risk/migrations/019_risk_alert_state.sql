-- 019: personal, append-only notification marks of stored alerts (PM-08).
--
-- 017_risk_alerts.sql is deliberately untouched. An alert is evidence that a
-- transition happened, so PM-08 adds a separate, personal resource next to it
-- instead of a column on it: the PM-07 rows, their listing route and their wire
-- body stay exactly as they were, and one person's read or dismissal can never
-- rewrite the alert another person reads.
--
-- One row is one explicit mark one subject appended to one alert. `unread` is not
-- a stored value: it is the absence of a row, which is why a read of an alert with
-- no mark of this subject needs no default row and carries no instant. The two
-- appendable states are closed by CHECK, and their order is fixed - read below
-- dismissed - so "dismissed dominates" is a property of the vocabulary and not of
-- whichever request happened to arrive last.
--
-- subject_key is the SHA-256 digest of the verified token subject, never the raw
-- subject. The actor is read exclusively from the verified bearer token; this
-- table deliberately has no client-supplied actor column, because an actor the
-- caller can name is not an identity. The CHECK refuses anything that is not one
-- canonical lower-case digest, so a raw subject cannot be stored even by a future
-- writer.
--
-- The table is append-only in both directions. risk_app holds SELECT and INSERT
-- and nothing else: no UPDATE rewrites the instant of an existing mark, and no
-- DELETE erases it. The trace of a change is the appended row itself, not a
-- gateway audit event; PM-08 adds no audit writer and records no fictitious
-- delivery, transport or receipt.
--
-- The unique index is the schema-level idempotency key: at most one read mark and
-- at most one dismissed mark per (alert, subject). A replay therefore cannot make
-- the same mark look like two events, even if a future writer skipped the
-- application's no-op branch. The owner index serves the personal read, which asks
-- for the marks of one subject on one alert, and the writer's current-rank check.
--
-- alert_id is a real RESTRICT foreign key: a stored mark is provenance of an
-- alert, so an alert cannot be deleted out from under it. Nothing here backfills
-- or invents a mark: state begins to exist with the first explicit admin request.
CREATE TABLE IF NOT EXISTS risk_alert_state (
    id          uuid        PRIMARY KEY,
    alert_id    uuid        NOT NULL REFERENCES risk_alerts(id) ON DELETE RESTRICT,
    subject_key text        NOT NULL,
    state       text        NOT NULL,
    marked_at   timestamptz NOT NULL,
    CONSTRAINT risk_alert_state_state_check CHECK (state IN ('read','dismissed')),
    CONSTRAINT risk_alert_state_subject_key_check CHECK (subject_key ~ '^[0-9a-f]{64}$')
);

-- One row per rank per personal pair: the idempotency key.
CREATE UNIQUE INDEX IF NOT EXISTS risk_alert_state_once ON risk_alert_state(alert_id, subject_key, state);

-- The personal read and the writer's current-rank lookup: one subject's marks on
-- one alert, newest first.
CREATE INDEX IF NOT EXISTS risk_alert_state_owner ON risk_alert_state(alert_id, subject_key, marked_at DESC, id DESC);

-- The application role appends and reads its own marks. It has no rewrite and no
-- removal privilege: a correction is a later mark, not an edited row.
GRANT SELECT, INSERT ON risk_alert_state TO risk_app;
