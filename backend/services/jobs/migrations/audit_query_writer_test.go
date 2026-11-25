package migrations

// Version 6 — the narrow query writer (PM-10 / V1-P-07, S1 item 2 and S3).
//
// The structural test runs everywhere; the two database tests need a disposable
// database and skip without one, exactly like the rest of this module's storage
// tests.

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// queryAuditLabels is the closed vocabulary this migration owns: the action the
// gateway sends and the sentence a person reads in GET /v1/audit. It is written
// out here rather than derived from the SQL so the test can fail when the file
// loses a label, gains one, or renames a sentence.
var queryAuditLabels = map[string]string{
	"risk.current.read":            "Consulta del riesgo actual",
	"risk.history.read":            "Consulta del histórico de lotes publicados",
	"risk.batches.read":            "Consulta del último lote publicado de cada zona",
	"prevention.observations.read": "Consulta de observaciones de campo",
	"prevention.actions.read":      "Consulta de acciones preventivas",
}

// TestQueryAuditWriterIsGuardedAndQueryOnly pins the shape of version 6: the role
// is created without a credential, the trail is closed to direct DML, the writer
// is a SECURITY DEFINER function with a pinned search path, the kind is fixed
// inside the function, and PUBLIC loses the EXECUTE it would otherwise hold.
func TestQueryAuditWriterIsGuardedAndQueryOnly(t *testing.T) {
	sql := QueryAuditWriter
	for _, fragment := range []string{
		"CREATE ROLE audit_query_app NOLOGIN",
		"REVOKE ALL ON TABLE public.audit FROM audit_query_app",
		"REVOKE ALL ON SEQUENCE public.audit_id_seq FROM audit_query_app",
		"GRANT USAGE ON SCHEMA public TO audit_query_app",
		"GRANT CONNECT ON DATABASE %I TO audit_query_app",
		"SECURITY DEFINER",
		"SET search_path = pg_catalog",
		"INSERT INTO public.audit",
		"NULLIF(btrim(p_actor_name), '')",
		"REVOKE ALL ON FUNCTION public.audit_record_query(text, text, text, text) FROM PUBLIC",
		"GRANT EXECUTE ON FUNCTION public.audit_record_query(text, text, text, text) TO audit_query_app",
	} {
		if !strings.Contains(sql, fragment) {
			t.Errorf("006_query_audit_writer.sql does not contain %q", fragment)
		}
	}
	// A credential in a migration is a credential in the repository, and an
	// attribute wider than LOGIN would let the writer reshape the schema it writes
	// into. Neither belongs in this file. jobs_app is named as a grantee, not as a
	// word, because the file explains why it is excluded.
	for _, forbidden := range []string{"PASSWORD", "SUPERUSER", "CREATEDB", "CREATEROLE", "BYPASSRLS", "TO jobs_app", "GRANT ALL", "TRUNCATE", "DROP TABLE", "DROP COLUMN", "DELETE FROM", "ALTER TABLE", "UPDATE public.audit"} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("006_query_audit_writer.sql contains %q; the writer surface must stay insert-only and unprivileged", forbidden)
		}
	}
	// The kind is a literal inside the function, never a parameter: a parameter
	// would restore exactly the spoofing this migration exists to prevent.
	if strings.Contains(sql, "p_event_kind") || strings.Contains(sql, "p_kind") {
		t.Error("006_query_audit_writer.sql takes the event kind as a parameter")
	}
	if !strings.Contains(sql, "'query'") {
		t.Error("006_query_audit_writer.sql does not fix event_kind to 'query'")
	}
}

// TestQueryAuditWriterOwnsTheClosedLabelSet pins the other half of the vocabulary
// the gateway's drift test checks from its own side: exactly the five actions and
// exactly their sentences, no more and no fewer.
func TestQueryAuditWriterOwnsTheClosedLabelSet(t *testing.T) {
	sql := QueryAuditWriter
	start := strings.Index(sql, "v_detail := CASE")
	end := strings.Index(sql, "ELSE NULL")
	if start < 0 || end < start {
		t.Fatal("006_query_audit_writer.sql has no CASE block for the stored detail")
	}
	block := sql[start:end]
	if got, want := strings.Count(block, "WHEN '"), len(queryAuditLabels); got != want {
		t.Errorf("the writer accepts %d actions, want %d", got, want)
	}
	for action, detail := range queryAuditLabels {
		if !strings.Contains(block, "'"+action+"'") {
			t.Errorf("the writer does not accept %q", action)
		}
		if !strings.Contains(block, "'"+detail+"'") {
			t.Errorf("the writer does not store %q for %q", detail, action)
		}
	}
}

// disposableAuditDatabase is the pair of connections the database tests need: the
// writer role the migration creates, and the application role that may read the
// trail back. The credential of the writer is provisioning's, so it never appears
// here: the test is skipped, never silently widened, when either is absent.
func disposableAuditDatabase(t *testing.T) (*pgxpool.Pool, *pgxpool.Pool) {
	t.Helper()
	audit, reader := os.Getenv("TEST_AUDIT_DATABASE_URL"), os.Getenv("TEST_DATABASE_URL")
	if testing.Short() || audit == "" || reader == "" {
		t.Skip("requires a migrated disposable jobs database plus TEST_AUDIT_DATABASE_URL (audit_query_app) and TEST_DATABASE_URL (jobs_app)")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	writer, err := pgxpool.New(ctx, audit)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(writer.Close)
	app, err := pgxpool.New(ctx, reader)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Close)
	return writer, app
}

// TestQueryAuditWriterAcceptsOnlyEligibleReads is the negative SQL half of the
// least-privilege claim, executed as the real writer role rather than inspected:
// the function is the only statement it may run, the trail itself rejects it, and
// the three inputs the function cannot fix are validated inside it.
func TestQueryAuditWriterAcceptsOnlyEligibleReads(t *testing.T) {
	writer, reader := disposableAuditDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	// The granted surface is exactly one function plus the two name-resolution
	// privileges; nothing on the table, on a column, or on the sequence. The
	// executable surface is counted rather than probed with a second signature: a
	// signature that does not exist makes has_function_privilege raise instead of
	// answering false, so the count is what proves "one function, and it is this one".
	var insert, selectOn, update, deleteOn, nextval, execute, scopedExecute int
	err := reader.QueryRow(ctx, `SELECT
		has_table_privilege('audit_query_app','public.audit','INSERT')::int,
		has_table_privilege('audit_query_app','public.audit','SELECT')::int,
		has_table_privilege('audit_query_app','public.audit','UPDATE')::int,
		has_table_privilege('audit_query_app','public.audit','DELETE')::int,
		has_sequence_privilege('audit_query_app','public.audit_id_seq','USAGE')::int,
		has_function_privilege('audit_query_app','public.audit_record_query(text,text,text,text)','EXECUTE')::int,
		(SELECT count(*)::int FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
			WHERE n.nspname = 'public' AND EXISTS (
				SELECT 1 FROM pg_catalog.aclexplode(p.proacl) a
				WHERE a.grantee = 'audit_query_app'::pg_catalog.regrole AND a.privilege_type = 'EXECUTE'))`).
		Scan(&insert, &selectOn, &update, &deleteOn, &nextval, &execute, &scopedExecute)
	if err != nil {
		t.Fatal(err)
	}
	if insert+selectOn+update+deleteOn+nextval != 0 {
		t.Fatalf("audit_query_app privileges insert=%d select=%d update=%d delete=%d nextval=%d, want all zero", insert, selectOn, update, deleteOn, nextval)
	}
	if execute != 1 {
		t.Fatal("audit_query_app cannot execute the writer, so the gateway could never record a read")
	}
	if scopedExecute != 1 {
		t.Fatalf("audit_query_app may execute %d function(s) in schema public, want exactly the narrow writer", scopedExecute)
	}
	var columnInsert bool
	if err := reader.QueryRow(ctx, `SELECT has_column_privilege('audit_query_app','public.audit','event_kind','INSERT')`).Scan(&columnInsert); err != nil {
		t.Fatal(err)
	}
	if columnInsert {
		t.Fatal("audit_query_app may insert event_kind directly, which would let it write a query as a mutation")
	}

	// The writer records an eligible read and returns the identity of the row.
	trace := "8f1d0a52-7b3c-4a19-9e21-8a1b2c3d4e5f"
	var id int64
	if err := writer.QueryRow(ctx, `SELECT public.audit_record_query($1,$2,$3,$4)`, "subject-1", "Demo Admin", "risk.current.read", trace).Scan(&id); err != nil {
		t.Fatalf("the writer refused an eligible read: %v", err)
	}
	if id <= 0 {
		t.Fatalf("the writer returned id %d", id)
	}

	// Every way to widen the record is refused inside the function, with the
	// invalid-parameter SQLSTATE rather than a silent NULL.
	for _, tc := range []struct {
		name                 string
		actor, action, trace string
	}{
		{"a mutation label", "subject-1", "job.requested", trace},
		{"an unknown label", "subject-1", "risk.everything.read", trace},
		{"empty action", "subject-1", "", trace},
		{"empty subject", "", "risk.current.read", trace},
		{"a bare trace id", "subject-1", "risk.current.read", "8f1d0a527b3c4a199e218a1b2c3d4e5f"},
		{"a truncated trace id", "subject-1", "risk.current.read", "8f1d0a52-7b3c-4a19"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := writer.Exec(ctx, `SELECT public.audit_record_query($1,$2,$3,$4)`, tc.actor, "", tc.action, tc.trace)
			var pgErr *pgconn.PgError
			if !errors.As(err, &pgErr) || pgErr.Code != "22023" {
				t.Fatalf("the writer answered %v, want SQLSTATE 22023", err)
			}
		})
	}

	// And the trail itself stays closed: four direct statements, four refusals.
	for _, statement := range []string{
		`INSERT INTO public.audit(actor_id,action,event_kind,trace_id) VALUES('subject-1','risk.current.read','query','8f1d0a52-7b3c-4a19-9e21-8a1b2c3d4e5f')`,
		`INSERT INTO public.audit(actor_id,action,job_id,trace_id) VALUES('subject-1','job.requested','8f1d0a52-7b3c-4a19-9e21-8a1b2c3d4e5f','8f1d0a52-7b3c-4a19-9e21-8a1b2c3d4e5f')`,
		`UPDATE public.audit SET event_kind='query' WHERE id=$1`,
		`DELETE FROM public.audit WHERE id=$1`,
		`SELECT count(*) FROM public.audit`,
		`SELECT nextval('public.audit_id_seq')`,
	} {
		var err error
		if strings.Contains(statement, "$1") {
			_, err = writer.Exec(ctx, statement, id)
		} else {
			_, err = writer.Exec(ctx, statement)
		}
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "42501" {
			t.Errorf("%s answered %v, want SQLSTATE 42501", statement, err)
		}
	}
}

// TestQueryAuditRowIsTheRecordedRead proves the row the gateway would produce:
// kind query, no job reference, the verified name trimmed into place, the fixed
// sentence of the action, and the canonical trace id the caller answered with.
func TestQueryAuditRowIsTheRecordedRead(t *testing.T) {
	writer, reader := disposableAuditDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	trace := "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
	var id int64
	if err := writer.QueryRow(ctx, `SELECT public.audit_record_query($1,$2,$3,$4)`, "subject-7", "  Demo Viewer  ", "prevention.actions.read", trace).Scan(&id); err != nil {
		t.Fatal(err)
	}
	var actorID, action, kind, detail, storedTrace string
	var actorName *string
	var jobID *string
	if err := reader.QueryRow(ctx, `SELECT actor_id, actor_name, action, event_kind, detail, job_id::text, trace_id::text FROM public.audit WHERE id=$1`, id).
		Scan(&actorID, &actorName, &action, &kind, &detail, &jobID, &storedTrace); err != nil {
		t.Fatal(err)
	}
	if actorID != "subject-7" || actorName == nil || *actorName != "Demo Viewer" {
		t.Fatalf("actor = %q/%v, want subject-7/the trimmed Demo Viewer", actorID, actorName)
	}
	if kind != "query" {
		t.Fatalf("event_kind = %q, want query: a recorded read is never a mutation", kind)
	}
	if jobID != nil {
		t.Fatalf("job_id = %q, want NULL: a query is not attached to a job", *jobID)
	}
	if action != "prevention.actions.read" || detail != "Consulta de acciones preventivas" {
		t.Fatalf("action/detail = %q/%q", action, detail)
	}
	if storedTrace != trace {
		t.Fatalf("trace_id = %q, want the canonical %q the gateway minted", storedTrace, trace)
	}

	// A caller without a verified display name stores NULL: an opaque subject is
	// never turned into a name.
	var anonymousID int64
	if err := writer.QueryRow(ctx, `SELECT public.audit_record_query($1,$2,$3,$4)`, "subject-8", "", "risk.current.read", trace).Scan(&anonymousID); err != nil {
		t.Fatal(err)
	}
	var name *string
	if err := reader.QueryRow(ctx, `SELECT actor_name FROM public.audit WHERE id=$1`, anonymousID).Scan(&name); err != nil {
		t.Fatal(err)
	}
	if name != nil {
		t.Fatalf("a token without a name claim stored %q", *name)
	}

	// The writer belongs to the migration credential, never to the role that may
	// call it: a SECURITY DEFINER function owned by its caller would enforce
	// nothing. The pinned search path is read from the catalog for the same reason:
	// the file states it, and the database has to agree.
	var owner, settings string
	var security, ownerIsSuper bool
	if err := reader.QueryRow(ctx, `SELECT pg_get_userbyid(p.proowner), p.prosecdef, coalesce(array_to_string(p.proconfig, ','), ''), r.rolsuper FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='public.audit_record_query(text,text,text,text)'::regprocedure`).Scan(&owner, &security, &settings, &ownerIsSuper); err != nil {
		t.Fatal(err)
	}
	if owner == "audit_query_app" {
		t.Fatal("the narrow writer is owned by the role it constrains")
	}
	if !ownerIsSuper {
		t.Fatalf("the narrow writer is owned by %q, which is not the migration credential", owner)
	}
	if !security {
		t.Fatal("the narrow writer is not SECURITY DEFINER, so it runs with the caller's privileges")
	}
	if settings != "search_path=pg_catalog" {
		t.Fatalf("the narrow writer's search path is %q, want search_path=pg_catalog", settings)
	}
}
