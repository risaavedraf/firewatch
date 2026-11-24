-- 006: the narrow query writer the gateway records through.
--
-- Forward-only. 001-005 are frozen: their versions are already recorded in
-- schema_migrations on every existing database, so editing them would never run
-- again. Every statement below is guarded so applying this file twice is a
-- no-op, and nothing here destroys data.
--
-- Why a function instead of a table grant. audit.event_kind defaults to
-- 'mutation', so an INSERT privilege on audit -- even a column-specific one that
-- omits event_kind -- would let the holder write a recorded read as a mutation,
-- which is exactly the statement PM-10 makes (a consulta is never a mutacion).
-- The only write path this migration grants is one SECURITY DEFINER function that
-- fixes event_kind='query', leaves job_id NULL and accepts nothing but the
-- verified actor, one of the closed action labels below and the gateway's trace
-- id. The stored detail sentence is chosen inside the function, so the text a
-- person reads in GET /v1/audit cannot be a caller-supplied string either.
--
-- Who runs what. This file creates the role and its privileges, because a
-- migration is the only statement that reaches a database which already exists:
-- deploy/local/postgres-init.sh and the Kubernetes init ConfigMap only run on a
-- first start. It creates the role NOLOGIN and never sets a password, because a
-- credential is provisioning's to set and must never be a file in this
-- repository. deploy/local/postgres-init.sh (fresh local volumes),
-- deploy/k8s/bootstrap-secrets.sh and the "existing cluster" step in
-- deploy/k8s/README.md carry the LOGIN half.
--
-- If the migration credential cannot create a role this file raises instead of
-- skipping the surface: a deployment without an audit writer answers 503
-- storage_unavailable on the recorded reads, which is visible; a deployment that
-- recorded nothing at all would not be.

DO $do$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'audit_query_app') THEN
		CREATE ROLE audit_query_app NOLOGIN;
	END IF;
END
$do$;

-- Least privilege, stated negatively as well as positively, so a hand-made grant
-- cannot widen it later: no table privilege, no column privilege and no sequence
-- privilege. The identity sequence needs no grant because the function below
-- inserts as its owner. Both statements are idempotent.
REVOKE ALL ON TABLE public.audit FROM audit_query_app;
REVOKE SELECT (id, actor_id, actor_name, action, event_kind, detail, job_id, trace_id, occurred_at),
	INSERT (id, actor_id, actor_name, action, event_kind, detail, job_id, trace_id, occurred_at),
	UPDATE (id, actor_id, actor_name, action, event_kind, detail, job_id, trace_id, occurred_at)
	ON TABLE public.audit FROM audit_query_app;
REVOKE ALL ON SEQUENCE public.audit_id_seq FROM audit_query_app;

-- Reaching the function needs these two and nothing more: connect to the database
-- the ledger lives in, and resolve a name inside its schema. current_database()
-- keeps this correct for jobs and jobs_test alike, where the same file runs.
GRANT USAGE ON SCHEMA public TO audit_query_app;
DO $do$
BEGIN
	EXECUTE pg_catalog.format('GRANT CONNECT ON DATABASE %I TO audit_query_app', pg_catalog.current_database());
END
$do$;

-- The writer itself.
--
-- SET search_path = pg_catalog is what makes SECURITY DEFINER safe here: a
-- function that searched the caller's path would resolve audit through whatever
-- schema the caller put first, so the body is schema-qualified and the path is
-- pinned. The owner is whoever runs this migration -- the database owner, never
-- audit_query_app, which would make the definer check meaningless.
CREATE OR REPLACE FUNCTION public.audit_record_query(
	p_actor_id text,
	p_actor_name text,
	p_action text,
	p_trace_id text
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
	v_detail text;
	v_id bigint;
BEGIN
	v_detail := CASE p_action
		WHEN 'risk.current.read' THEN 'Consulta del riesgo actual'
		WHEN 'risk.history.read' THEN 'Consulta del histórico de lotes publicados'
		WHEN 'risk.batches.read' THEN 'Consulta del último lote publicado de cada zona'
		WHEN 'prevention.observations.read' THEN 'Consulta de observaciones de campo'
		WHEN 'prevention.actions.read' THEN 'Consulta de acciones preventivas'
		ELSE NULL
	END;
	IF v_detail IS NULL THEN
		RAISE EXCEPTION 'audit query action is not in the eligible set' USING ERRCODE = '22023';
	END IF;
	-- A row without a subject is not evidence of who consulted anything, and a
	-- trace id that is not the canonical dashed form the gateway mints is not the
	-- correlation id it answered with.
	IF p_actor_id IS NULL OR btrim(p_actor_id) = '' THEN
		RAISE EXCEPTION 'an audit query needs a verified subject' USING ERRCODE = '22023';
	END IF;
	IF p_trace_id IS NULL OR p_trace_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
		RAISE EXCEPTION 'an audit query needs the canonical trace id' USING ERRCODE = '22023';
	END IF;
	INSERT INTO public.audit (actor_id, actor_name, action, event_kind, detail, job_id, trace_id)
	VALUES (p_actor_id, NULLIF(btrim(p_actor_name), ''), p_action, 'query', v_detail, NULL, p_trace_id::pg_catalog.uuid)
	RETURNING id INTO v_id;
	RETURN v_id;
END
$function$;

-- PUBLIC gets EXECUTE on a new function by default, which would hand this writer
-- to every role that can connect, jobs_app included. Revoking it first is the
-- reason the grant below means "only the query recorder".
REVOKE ALL ON FUNCTION public.audit_record_query(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.audit_record_query(text, text, text, text) TO audit_query_app;
