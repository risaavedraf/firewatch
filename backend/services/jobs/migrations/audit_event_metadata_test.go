package migrations

import (
	"regexp"
	"strings"
	"testing"

	"firewatch.local/jobs/internal/repository"
)

// auditKindLiteral matches a single-quoted lower-case literal, which is how the
// event-kind vocabulary appears in the CHECK constraint.
var auditKindLiteral = regexp.MustCompile(`'([a-z_]+)'`)

// TestAuditEventMetadataMigrationIsGuardedAndAdditive pins the shape of version
// 5: the metadata columns are added IF NOT EXISTS, the job reference becomes
// nullable, and the kind CHECK is dropped before it is re-added so re-applying
// the file is a no-op. It is a structural test: it cannot prove execution
// against a real database (see the repository storage test).
func TestAuditEventMetadataMigrationIsGuardedAndAdditive(t *testing.T) {
	sql := AuditEventMetadata
	for _, fragment := range []string{
		"ALTER TABLE audit ADD COLUMN IF NOT EXISTS actor_name text",
		"ALTER TABLE audit ADD COLUMN IF NOT EXISTS detail text",
		"ALTER TABLE audit ADD COLUMN IF NOT EXISTS event_kind text NOT NULL DEFAULT 'mutation'",
		"ALTER TABLE audit ALTER COLUMN job_id DROP NOT NULL",
		"ALTER TABLE audit DROP CONSTRAINT IF EXISTS audit_event_kind_check",
		"ALTER TABLE audit ADD CONSTRAINT audit_event_kind_check CHECK (event_kind IN ('mutation', 'query'))",
	} {
		if !strings.Contains(sql, fragment) {
			t.Errorf("005_audit_event_metadata.sql does not contain %q", fragment)
		}
	}
	for _, forbidden := range []string{"DROP TABLE", "TRUNCATE", "DELETE FROM", "DROP COLUMN", "UPDATE audit"} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("005_audit_event_metadata.sql contains %q; migrations here never destroy or rewrite data", forbidden)
		}
	}
	// The existing least privilege is intentional: jobs_app may select and insert
	// audit rows but never update or delete them. This migration must not widen
	// that, so it grants nothing at all.
	if strings.Contains(sql, "GRANT ") {
		t.Error("005_audit_event_metadata.sql grants privileges; the append-only audit role must stay unchanged")
	}
}

// TestAuditEventKindVocabularyMatchesTheStore is the guard against the one
// duplication this design cannot remove: the closed vocabulary is a Go value the
// writer uses and a SQL CHECK the database accepts. They must name exactly the
// same two kinds, no more and no fewer.
func TestAuditEventKindVocabularyMatchesTheStore(t *testing.T) {
	sql := AuditEventMetadata
	marker := "event_kind IN"
	index := strings.Index(sql, marker)
	if index < 0 {
		t.Fatalf("migration has no %q constraint", marker)
	}
	end := strings.Index(sql[index:], ")")
	if end < 0 {
		t.Fatal("the event_kind CHECK constraint is not terminated")
	}
	declared := map[string]bool{}
	for _, match := range auditKindLiteral.FindAllStringSubmatch(sql[index:index+end], -1) {
		declared[match[1]] = true
	}
	want := map[string]bool{}
	for _, kind := range repository.AuditEventKinds() {
		want[kind] = true
	}
	for value := range want {
		if !declared[value] {
			t.Errorf("audit.event_kind does not accept %q, but the store can write it", value)
		}
	}
	for value := range declared {
		if !want[value] {
			t.Errorf("audit.event_kind accepts %q, which is not a kind the store defines", value)
		}
	}
}
