-- 007: the named comparison action for the narrow query writer.
--
-- Forward-only. 001-006 are frozen: their versions are already recorded in
-- schema_migrations on every existing database, so editing 006 would never run
-- again and the new action would be refused by the deployed writer. This file
-- therefore replaces the same function instead of editing its definition.
--
-- Why CREATE OR REPLACE of public.audit_record_query instead of a second writer.
-- The gateway records every selected read through one SECURITY DEFINER function
-- with one grant, and the executable surface of audit_query_app is asserted to be
-- exactly that function. A second function would widen that surface, split the
-- closed label set across two places and make the least-privilege claim harder to
-- read. Replacing the body keeps the signature, the owner, the SECURITY DEFINER
-- attribute, the pinned search_path and the grant exactly as 006 established
-- them; the only change is one WHEN branch inside the CASE.
--
-- Every existing action and its stored sentence is preserved verbatim, and no
-- filter is added: the function still accepts nothing but the verified actor, one
-- closed action label and the gateway's trace id. A comparison cannot store which
-- zones, window or granularity it asked for, because there is no parameter for
-- them. The stored detail remains chosen inside this function, so the text a
-- person reads in GET /v1/audit is never caller-supplied.
--
-- The two closing statements are reissued rather than assumed: they are
-- idempotent, and restating them here keeps this file self-contained if it is
-- ever the first statement a reviewer reads. CREATE OR REPLACE preserves the
-- existing ACL on its own, so nothing is widened by them.

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
		WHEN 'risk.compare.read' THEN 'Consulta comparativa del riesgo entre zonas'
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

-- PUBLIC gets EXECUTE on a new function by default; replacing an existing one
-- keeps that revoke in place, and restating it is still correct.
REVOKE ALL ON FUNCTION public.audit_record_query(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.audit_record_query(text, text, text, text) TO audit_query_app;
