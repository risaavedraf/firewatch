package migrations

import (
	"strings"
	"testing"
)

// TestRiskAlertsMigrationIsGuardedAndIdempotent protects the alert entity PM-07
// adds and PM-08 later lists: one stored transition of one zone, with the level
// before, the level after, the agreed threshold and the instant of the
// assessment. Version 17 is the next free integer of the shared ledger once the
// sibling branches' reservations of 15 and 16 are counted, so a migration at any
// lower number would collide with a claim this branch does not own.
//
// Every statement is guarded so applying the file twice is a no-op, and nothing
// here destroys or backfills data.
func TestRiskAlertsMigrationIsGuardedAndIdempotent(t *testing.T) {
	migration := migrationFor(t, 17)
	if migration.Name != "risk_alerts" {
		t.Errorf("migration 17 is named %q, want %q", migration.Name, "risk_alerts")
	}
	sql := migration.SQL
	for _, fragment := range []string{
		"CREATE TABLE IF NOT EXISTS risk_alerts",
		"zone_id        text        NOT NULL REFERENCES zones(code)",
		"batch_id       uuid        NOT NULL REFERENCES batches(id)",
		"previous_level text        NOT NULL",
		"new_level      text        NOT NULL",
		"occurred_at    timestamptz NOT NULL",
		"CONSTRAINT risk_alerts_batch_identity UNIQUE (batch_id)",
		"CHECK (previous_level <> new_level)",
		"CREATE INDEX IF NOT EXISTS risk_alerts_timeline ON risk_alerts(occurred_at DESC, id DESC)",
		"GRANT SELECT, INSERT ON risk_alerts TO risk_app",
	} {
		if !strings.Contains(sql, fragment) {
			t.Errorf("017_risk_alerts.sql does not contain %q", fragment)
		}
	}
	// The threshold is an agreed value written in the schema, not a literal only
	// the Go writer knows: the column carries it as its default and refuses a
	// value that would mean "alert on no change".
	for _, fragment := range []string{
		"threshold      integer     NOT NULL DEFAULT 1",
		"CHECK (threshold >= 1)",
	} {
		if !strings.Contains(sql, fragment) {
			t.Errorf("017_risk_alerts.sql does not contain %q", fragment)
		}
	}
	// `desconocido` is not a risk level; it records that the inputs were
	// insufficient. The schema refuses an alert that names it, so PM-08 never has
	// to explain a level that is an absence of data.
	if strings.Contains(sql, "'desconocido'") {
		t.Error("017_risk_alerts.sql accepts 'desconocido' as a level; an alert exists only between determined levels")
	}
	for _, fragment := range []string{
		"previous_level IN ('bajo','medio','alto')",
		"new_level IN ('bajo','medio','alto')",
	} {
		if !strings.Contains(sql, fragment) {
			t.Errorf("017_risk_alerts.sql does not contain %q", fragment)
		}
	}
	// An alert is evidence of a transition that happened: the application role
	// appends and reads it, and no grant lets it rewrite or delete one.
	if strings.Contains(sql, "GRANT SELECT, INSERT, UPDATE") || strings.Contains(sql, "GRANT DELETE") {
		t.Error("017_risk_alerts.sql grants a write privilege beyond appending; a stored alert is not rewritten")
	}
	for _, forbidden := range []string{"DROP TABLE", "TRUNCATE", "DELETE FROM", "UPDATE "} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("017_risk_alerts.sql contains %q; schema migrations here never destroy data", forbidden)
		}
	}
}

// TestRiskAlertsClaimsTheNextFreeLedgerVersion states the reservation this
// branch depends on. The shared ledger is claimed against the integrated tree,
// not against one module's list: risk holds 1-8, 10, 12 and 13, prevention holds
// 9, 11 and 14, and the registered sibling branches reserve 15 (PM-09) and 16
// (PM-10). 17 is therefore the next free integer, and risk must not take a
// reserved number to "tidy" the sequence: the sibling migrator would then skip
// its own schema in silence.
func TestRiskAlertsClaimsTheNextFreeLedgerVersion(t *testing.T) {
	reservedBySiblings := map[int]bool{15: true, 16: true}
	if reservedBySiblings[17] {
		t.Fatal("17 is reserved by a sibling branch; this test's claim is stale")
	}
	owns := false
	for _, migration := range All() {
		if migration.Version == 17 {
			owns = true
		}
	}
	if !owns {
		t.Error("risk does not register version 17; the alert table would never be created")
	}
	for _, migration := range All() {
		if reservedBySiblings[migration.Version] {
			t.Errorf("risk claims version %d (%s), reserved by a sibling branch; the sibling migrator would skip its own migration in silence", migration.Version, migration.Name)
		}
	}
}
