package migrations

// Version 7 - the comparison action for the narrow query writer (PM-05 / S6).
//
// The structural test runs everywhere; the database test needs the disposable
// migrated jobs database and skips without it, exactly like the rest of this
// module's storage tests.

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// comparisonAuditLabel is the one action and the one stored sentence version 7
// adds. It is written out here rather than derived from the SQL so the test can
// fail when the migration loses it or renames the sentence.
const comparisonAuditLabel = "Consulta comparativa del riesgo entre zonas"

// TestComparisonAuditActionReplacesTheWriterForwardOnly pins the shape of version
// 7: the same function signature is replaced rather than a second writer created,
// every security control of 006 is restated, every existing label and sentence is
// preserved, and the only addition is the comparison's branch.
func TestComparisonAuditActionReplacesTheWriterForwardOnly(t *testing.T) {
	sql := ComparisonAuditAction
	for _, fragment := range []string{
		"CREATE OR REPLACE FUNCTION public.audit_record_query(\n\tp_actor_id text,\n\tp_actor_name text,\n\tp_action text,\n\tp_trace_id text\n) RETURNS bigint",
		"SECURITY DEFINER",
		"SET search_path = pg_catalog",
		"INSERT INTO public.audit",
		"NULLIF(btrim(p_actor_name), '')",
		"REVOKE ALL ON FUNCTION public.audit_record_query(text, text, text, text) FROM PUBLIC",
		"GRANT EXECUTE ON FUNCTION public.audit_record_query(text, text, text, text) TO audit_query_app",
		"'risk.compare.read'",
		"'" + comparisonAuditLabel + "'",
	} {
		if !strings.Contains(sql, fragment) {
			t.Errorf("007_comparison_audit_action.sql does not contain %q", fragment)
		}
	}
	// A credential or a wider role attribute in a migration is a credential or a
	// privilege in the repository, and nothing here destroys data.
	for _, forbidden := range []string{"PASSWORD", "SUPERUSER", "CREATEDB", "CREATEROLE", "BYPASSRLS", "TO jobs_app", "GRANT ALL", "TRUNCATE", "DROP TABLE", "DROP COLUMN", "DELETE FROM", "ALTER TABLE", "UPDATE public.audit", "CREATE ROLE"} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("007_comparison_audit_action.sql contains %q; the writer surface must stay insert-only and unprivileged", forbidden)
		}
	}
	// No filter is accepted: the function keeps the same four parameters, so a
	// comparison cannot record which zones, window or granularity it asked for.
	for _, forbidden := range []string{"p_zone", "p_filter", "p_from", "p_to", "p_granularity", "p_query", "p_params"} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("007_comparison_audit_action.sql takes %q; the writer accepts no filter", forbidden)
		}
	}
	// The kind stays a literal inside the function; a parameter would restore the
	// spoofing 006 exists to prevent.
	if strings.Contains(sql, "p_event_kind") || strings.Contains(sql, "p_kind") {
		t.Error("007_comparison_audit_action.sql takes the event kind as a parameter")
	}
	if !strings.Contains(sql, "'query'") {
		t.Error("007_comparison_audit_action.sql does not fix event_kind to 'query'")
	}
}

// TestComparisonAuditActionPreservesTheClosedLabelSet proves the two halves of the
// compatibility claim at once: the five labels 006 owns are still accepted with
// their exact sentences, and the comparison is the sixth and only new one. The
// frozen 006 test keeps pinning the original five; this one pins the union.
func TestComparisonAuditActionPreservesTheClosedLabelSet(t *testing.T) {
	sql := ComparisonAuditAction
	start := strings.Index(sql, "v_detail := CASE")
	end := strings.Index(sql, "ELSE NULL")
	if start < 0 || end < start {
		t.Fatal("007_comparison_audit_action.sql has no CASE block for the stored detail")
	}
	block := sql[start:end]
	if got, want := strings.Count(block, "WHEN '"), len(queryAuditLabels)+1; got != want {
		t.Errorf("the writer accepts %d actions, want the frozen %d plus the comparison", got, len(queryAuditLabels))
	}
	for action, detail := range queryAuditLabels {
		if !strings.Contains(block, "'"+action+"'") {
			t.Errorf("the replacement writer dropped %q", action)
		}
		if !strings.Contains(block, "'"+detail+"'") {
			t.Errorf("the replacement writer dropped the sentence %q for %q", detail, action)
		}
	}
	if !strings.Contains(block, "'risk.compare.read'") {
		t.Error("the replacement writer does not accept risk.compare.read")
	}
	if !strings.Contains(block, "'"+comparisonAuditLabel+"'") {
		t.Error("the replacement writer does not store the comparison's sentence")
	}
}

// TestWriterRecordsTheComparisonAction is the real-database proof that the
// replaced function keeps working as the least-privileged writer: the comparison
// is accepted and stored as a query with its own sentence, an existing action is
// still accepted with its unchanged sentence, and an action outside the closed set
// is refused with the invalid-parameter SQLSTATE.
func TestWriterRecordsTheComparisonAction(t *testing.T) {
	writer, reader := disposableAuditDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	trace := "3c9d8a71-5b2e-4f6a-9d10-7e8f1a2b3c4d"
	var id int64
	if err := writer.QueryRow(ctx, `SELECT public.audit_record_query($1,$2,$3,$4)`, "subject-9", "Demo Admin", "risk.compare.read", trace).Scan(&id); err != nil {
		t.Fatalf("the writer refused the comparison action: %v", err)
	}
	var action, kind, detail, storedTrace string
	var jobID *string
	if err := reader.QueryRow(ctx, `SELECT action, event_kind, detail, job_id::text, trace_id::text FROM public.audit WHERE id=$1`, id).
		Scan(&action, &kind, &detail, &jobID, &storedTrace); err != nil {
		t.Fatal(err)
	}
	if action != "risk.compare.read" || detail != comparisonAuditLabel {
		t.Fatalf("action/detail = %q/%q, want the comparison's named action and sentence", action, detail)
	}
	if kind != "query" {
		t.Fatalf("event_kind = %q, want query: a recorded comparison read is never a mutation", kind)
	}
	if jobID != nil {
		t.Fatalf("job_id = %q, want NULL: a comparison is not attached to a job", *jobID)
	}
	if storedTrace != trace {
		t.Fatalf("trace_id = %q, want the canonical %q the gateway minted", storedTrace, trace)
	}

	// The replacement did not disturb an existing action.
	var existing int64
	if err := writer.QueryRow(ctx, `SELECT public.audit_record_query($1,$2,$3,$4)`, "subject-9", "", "risk.history.read", trace).Scan(&existing); err != nil {
		t.Fatalf("the replacement writer refused an existing action: %v", err)
	}
	var existingDetail string
	if err := reader.QueryRow(ctx, `SELECT detail FROM public.audit WHERE id=$1`, existing).Scan(&existingDetail); err != nil {
		t.Fatal(err)
	}
	if existingDetail != queryAuditLabels["risk.history.read"] {
		t.Fatalf("risk.history.read stores %q, want the unchanged %q", existingDetail, queryAuditLabels["risk.history.read"])
	}

	// The closed set is still closed, and the refusal is the invalid-parameter
	// SQLSTATE rather than a silent NULL.
	for _, ineligible := range []string{"risk.compare", "risk.compare.read.all", "job.requested", ""} {
		_, err := writer.Exec(ctx, `SELECT public.audit_record_query($1,$2,$3,$4)`, "subject-9", "", ineligible, trace)
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "22023" {
			t.Errorf("%q answered %v, want SQLSTATE 22023", ineligible, err)
		}
	}

	// The executable surface is still exactly one function: the comparison was
	// added to the existing writer, not bolted on as a second entry point.
	var scopedExecute int
	if err := reader.QueryRow(ctx, `SELECT count(*)::int FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
		WHERE n.nspname = 'public' AND EXISTS (
			SELECT 1 FROM pg_catalog.aclexplode(p.proacl) a
			WHERE a.grantee = 'audit_query_app'::pg_catalog.regrole AND a.privilege_type = 'EXECUTE')`).Scan(&scopedExecute); err != nil {
		t.Fatal(err)
	}
	if scopedExecute != 1 {
		t.Fatalf("audit_query_app may execute %d function(s), want exactly the narrow writer", scopedExecute)
	}
}
