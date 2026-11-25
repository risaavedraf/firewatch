-- 015: PM-09 field observations.
--
-- Forward-only and guarded: re-applying this file is a no-op, and nothing here
-- backfills, updates or destroys data. Version 15 is the next free number in the
-- SHARED schema_migrations ledger: risk owns 001..008, 010, 012 and 013, this
-- service owns 009, 011 and 014, so 15 is the next integer with both services
-- counted. The rule and its determination are in
-- backend/docs/migration-ledger.md.
--
-- One append-only table inside the `prevention` schema. Each row is what an
-- operator reported seeing in a zone on a day:
--
--   type         the closed PM-09 catalogue. There is no free-text type and no
--                default: the transport refuses a value outside the five and the
--                CHECK below refuses it again, so a future code path that skips
--                the Go validation cannot invent a sixth type.
--   zone_id      a code the authoritative zone catalogue (`zones`, created and
--                seeded by the risk migrations) holds. There is deliberately NO
--                foreign key: the prevention and risk migration runners are
--                independent in the compose test profile, so a foreign key would
--                add a startup ordering dependency between two migrations — the
--                same reason migration 011 documents no foreign key to `batches`.
--                The service resolves the zone with a select from `zones` inside
--                the insert, so an unknown code writes no row, and the schema
--                still applies no matter which service migrated first.
--   observed_on  the calendar date of the observation, not an instant: the
--                observation happened on a day, and a time of day would be
--                fabricated precision. No upper or lower bound is imposed here;
--                the published design's sample calendar bounds are a mock
--                artefact and are not imported.
--   description  what was seen, as sent. The transport bounds it (non-blank, at
--                most 240 characters, the size the design states for the field);
--                the column enforces the part a database can enforce.
--   created_by   the AUTHOR, taken by the transport from the verified token
--                subject. It is an audit field and is never a client-supplied
--                identity: the create body has no author field at all.
--   created_at   the server clock.
--
-- The application role may read and append observations but never update or
-- delete them: the append-only guarantee is the grants below, not a convention,
-- exactly as it is for the evidence trail.

CREATE TABLE IF NOT EXISTS prevention.observations (
    id uuid PRIMARY KEY,
    type text NOT NULL CHECK (type IN
        ('vegetacion_seca','microbasural','quema','acceso_bloqueado','otro')),
    zone_id text NOT NULL CHECK (btrim(zone_id) <> ''),
    observed_on date NOT NULL,
    description text NOT NULL CHECK (btrim(description) <> ''),
    created_by text NOT NULL CHECK (btrim(created_by) <> ''),
    created_at timestamptz NOT NULL DEFAULT now()
);

-- The list route reads newest first and optionally narrows by type, so one index
-- carries the filter and the ordering the page uses. The type leads because it is
-- the only filter the contract defines.
CREATE INDEX IF NOT EXISTS observations_type_recency
    ON prevention.observations(type, observed_on DESC, created_at DESC, id DESC);

-- Read and append only. There is no UPDATE and no DELETE grant: a field
-- observation is a record of what was seen, and rewriting it would destroy the
-- only account of that moment.
GRANT SELECT, INSERT ON prevention.observations TO risk_app;
