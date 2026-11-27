-- 020: who triggered each evaluation, and the verified actor of a manual one
-- (PM-06, mandante item 9).
--
-- A persisted evaluation already records its date (requested_at, published_at,
-- evaluated_at), its input variables and factors (factors, and the readings the
-- vector was built from) and its result (risk_level, rationale, policy_ref). What
-- it could not record is WHO triggered it. This migration adds exactly those two
-- columns, so "the scheduler evaluated this" is distinguishable from "a verified
-- operator asked for it now" - which is the whole point of PM-06.
--
-- evaluation_trigger is a closed vocabulary of two values:
--
--   scheduler  an evaluation nobody asked for at request time: the automatic 15
--              minute cycle and every queued job delivery. Neither path carries a
--              verified token subject, so evaluated_by stays NULL.
--   manual     an evaluation an operator asked for through the manual trigger
--              POST /v1/risk/cycle/run, authenticated by a bearer token whose
--              subject the API gate already proved. evaluated_by carries that
--              subject.
--
-- evaluated_by is the VERIFIED TOKEN SUBJECT, never a client-supplied field. No
-- request body declares an actor, and a request that names one is refused before
-- any acquisition happens: a subject the caller can name is not an identity.
-- 019_risk_alert_state.sql hashes its subject because there the subject is a
-- personal lookup key; here it is the provenance of who authorised the evaluation,
-- so the exact subject the token carried is stored. It is NOT invented for a
-- scheduled evaluation: the actor of a run nobody requested is the absence of one.
--
-- The CHECK states both halves of the rule in the schema, not only in the one
-- writer that exists today: a scheduled evaluation cannot claim an actor, and a
-- manual one cannot exist without a non-blank one. Any other pair - including a
-- blank, space-only, tab-only or newline-only subject - is refused by the database,
-- so a future writer cannot record provenance that contradicts itself.
--
-- "Blank" is the whole ASCII whitespace set, not only spaces: btrim's default strips
-- spaces alone and would accept an actor of "\t\n", which the Go writer already
-- refuses with strings.TrimSpace. The POSIX class is what makes the schema agree with
-- the writer, so the two cannot disagree about what an identity looks like.
--
-- The default is 'scheduler' because every row written before this migration came
-- from a path with no verified actor; that is what makes the two columns additive
-- for the rows that already exist, and it is a default, not a backfilled claim:
-- no row is rewritten here.
--
-- 001_initial.sql through 019_risk_alert_state.sql are never edited: their
-- versions are already recorded in schema_migrations on every existing database,
-- so an edit there would never run again and would be silently ineffective. Every
-- statement below is guarded so applying the file twice is a no-op, and nothing
-- here rewrites or destroys a stored row.
--
-- No grant is added: 001_initial.sql already grants SELECT and INSERT on the whole
-- of batches to risk_app, and a table-level privilege covers the columns added
-- later. The application role therefore still cannot rewrite a recorded trigger or
-- actor.
ALTER TABLE batches ADD COLUMN IF NOT EXISTS evaluation_trigger text NOT NULL DEFAULT 'scheduler';
ALTER TABLE batches ADD COLUMN IF NOT EXISTS evaluated_by text;

ALTER TABLE batches DROP CONSTRAINT IF EXISTS batches_evaluation_actor_check;
ALTER TABLE batches ADD CONSTRAINT batches_evaluation_actor_check
    CHECK (
        (evaluation_trigger = 'scheduler' AND evaluated_by IS NULL)
        OR (evaluation_trigger = 'manual' AND evaluated_by IS NOT NULL AND evaluated_by !~ '^[[:space:]]*$')
    );
