-- 005: durable audit event metadata.
--
-- Forward-only. 001-004 are frozen: their versions are already recorded in
-- schema_migrations on every existing database, so editing them would never run
-- again. Every statement below is guarded so applying this file twice is a
-- no-op, and nothing here destroys data.
--
-- event_kind closes the vocabulary to the two kinds the read contract documents:
-- 'mutation' is written by this service's job transitions, and 'query' is
-- reserved for the query recorder. Every pre-existing audit row is mutation
-- evidence, so the additive default states exactly that instead of guessing.
-- job_id becomes nullable because a query is not attached to a job; every
-- existing row keeps its job reference. actor_name and detail stay nullable: a
-- historical row or a system event recorded without a verified human name must
-- never be given a synthesized one.
--
-- The application grants in 001_initial.sql stay exactly as they are: jobs_app
-- may select and insert audit rows and use the identity sequence, but it may not
-- update or delete the trail. Nothing here widens that.
ALTER TABLE audit ADD COLUMN IF NOT EXISTS actor_name text;
ALTER TABLE audit ADD COLUMN IF NOT EXISTS detail text;
ALTER TABLE audit ADD COLUMN IF NOT EXISTS event_kind text NOT NULL DEFAULT 'mutation';
ALTER TABLE audit ALTER COLUMN job_id DROP NOT NULL;

ALTER TABLE audit DROP CONSTRAINT IF EXISTS audit_event_kind_check;
ALTER TABLE audit ADD CONSTRAINT audit_event_kind_check CHECK (event_kind IN ('mutation', 'query'));
