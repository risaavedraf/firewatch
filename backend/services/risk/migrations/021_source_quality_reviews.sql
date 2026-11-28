-- 021: the review an operator records about a source (V1-P-05, G6).
--
-- 019_risk_alert_state.sql added a personal mark next to an alert; 020 added the
-- actor of an evaluation. This migration adds the third trace of the same family:
-- the human decision about a SOURCE's quality, appended by the person who made it.
-- It is its own table rather than a column on anything else, because a review is a
-- sequence of explicit decisions and the previous ones stay readable.
--
-- The catalogue of findings these reviews answer is CLOSED and lives in the
-- service (`internal/quality`), not in this table: the five codes are published by
-- GET /v1/risk/sources and derived deterministically from evidence the read already
-- serves. Nothing here stores a derived finding, so no row can disagree with the
-- evidence that produced it.
--
-- decision is a closed vocabulary of two values, ratified by the owner:
--
--   incorporated  the operator asked for the source's records to be incorporated.
--   acknowledged  the operator read the findings and accepted them as they are.
--
-- note is optional and bounded to 500 characters. The bound is stated in the
-- schema as well as in the writer, so a note the API refuses cannot be stored by a
-- future writer either. Counting characters (`char_length`) is what makes the
-- database and the API agree: a byte bound would refuse a note the API accepts.
--
-- reviewed_by is the VERIFIED TOKEN SUBJECT, never a client-supplied field. The
-- route declares no actor member, and a body that names one is refused before any
-- acquisition happens: a subject the caller can name is not an identity. The CHECK
-- refuses a blank or whitespace-only actor even if a future writer forgot the rule.
-- 019 hashes its subject because it is a personal lookup key; here the subject is
-- the provenance of who decided, so the exact subject the token carried is stored.
--
-- reviewed_at is set by the server. The row is a trace of when the decision was
-- recorded, so it is NOT NULL and has no default that would rewrite history.
--
-- The table is append-only in both directions. risk_app holds SELECT and INSERT and
-- nothing else: a later decision is a new row, never an in-place rewrite of the previous one,
-- and no DELETE erases a recorded decision. The index is what the latest-per-source
-- read uses: the instant first and review_seq, the database-drawn append order, as the
-- deterministic tie-break. The identifier is deliberately NOT the tie-break: it is a
-- random uuid, so ordering by it would make "the latest review" depend on a value
-- nobody chose. review_seq is never supplied by a caller - the column's default is
-- its only writer - so the trace cannot be reordered by a request.
--
-- review_seq belongs in this file rather than in a later migration because 021 has
-- never been applied anywhere: this file is uncommitted on this branch and no
-- environment has recorded version 21 in schema_migrations. Adding the column here
-- amends an unshipped file; it is not a rewrite of a version a deployed ledger
-- already holds, which the rule below forbids.
--
-- 001_initial.sql through 020_batch_evaluation_actor.sql are never edited: their
-- versions are already recorded in schema_migrations on every existing database, so
-- an edit there would never run again and would be silently ineffective. Every
-- statement below is guarded so applying the file twice is a no-op, and nothing
-- here rewrites or destroys a stored row.
--
-- Version 21 is the next free integer across the services that share this ledger:
-- risk holds 20 and prevention holds 9, 11, 14, 15 and 16, so this is not the next
-- integer in risk's own list. The rule and the current claims are in
-- backend/docs/migration-ledger.md.
CREATE TABLE IF NOT EXISTS source_quality_reviews (
    id          uuid        PRIMARY KEY,
    -- review_seq is the monotonic append order, drawn by the database and never by a
    -- caller. Two reviews can share an instant - the server's clock is not a
    -- uniqueness device - so the latest-per-source read needs an order the rows really
    -- have. A random uuid is an identity, not an order.
    review_seq  bigserial   NOT NULL,
    source_id   text        NOT NULL,
    decision    text        NOT NULL,
    note        text        NOT NULL DEFAULT '',
    reviewed_by text        NOT NULL,
    reviewed_at timestamptz NOT NULL,
    CONSTRAINT source_quality_reviews_source_id_check CHECK (source_id !~ '^[[:space:]]*$'),
    CONSTRAINT source_quality_reviews_decision_check CHECK (decision IN ('incorporated','acknowledged')),
    CONSTRAINT source_quality_reviews_note_check CHECK (char_length(note) <= 500),
    CONSTRAINT source_quality_reviews_actor_check CHECK (reviewed_by !~ '^[[:space:]]*$')
);

-- The latest-per-source read and the append order it relies on: the instant first,
-- and the monotonic sequence as the deterministic tie-break.
CREATE INDEX IF NOT EXISTS source_quality_reviews_latest ON source_quality_reviews(source_id, reviewed_at DESC, review_seq DESC);

-- The application role appends and reads. It has no rewrite and no removal
-- privilege: a correction is a later review, not an edited row.
GRANT SELECT, INSERT ON source_quality_reviews TO risk_app;

-- The default of review_seq reads a sequence, so the role that appends needs USAGE on
-- it; SELECT is what PostgreSQL asks for alongside USAGE on a sequence read this way.
-- No privilege here allows altering or dropping it. The jobs database grants its
-- identity sequence the same way (001_initial.sql).
GRANT USAGE, SELECT ON SEQUENCE source_quality_reviews_review_seq_seq TO risk_app;
