package migrations

import (
	"strings"
	"testing"
)

// TestRiskAlertStateMigrationIsGuardedAndAppendOnly protects version 19: one
// personal, append-only mark of one subject on one stored alert. The table is a
// sibling of risk_alerts, never an edit of it, so the PM-07 rows stay immutable
// and byte-compatible.
func TestRiskAlertStateMigrationIsGuardedAndAppendOnly(t *testing.T) {
	migration := migrationFor(t, 19)
	if migration.Name != "risk_alert_state" {
		t.Errorf("migration 19 is named %q, want %q", migration.Name, "risk_alert_state")
	}
	sql := migration.SQL
	for _, fragment := range []string{
		"CREATE TABLE IF NOT EXISTS risk_alert_state",
		"alert_id    uuid        NOT NULL REFERENCES risk_alerts(id) ON DELETE RESTRICT",
		"subject_key text        NOT NULL",
		"state       text        NOT NULL",
		"marked_at   timestamptz NOT NULL",
		"CONSTRAINT risk_alert_state_state_check CHECK (state IN ('read','dismissed'))",
		"CREATE UNIQUE INDEX IF NOT EXISTS risk_alert_state_once ON risk_alert_state(alert_id, subject_key, state)",
		"CREATE INDEX IF NOT EXISTS risk_alert_state_owner ON risk_alert_state(alert_id, subject_key, marked_at DESC, id DESC)",
		"GRANT SELECT, INSERT ON risk_alert_state TO risk_app",
	} {
		if !strings.Contains(sql, fragment) {
			t.Errorf("019_risk_alert_state.sql does not contain %q", fragment)
		}
	}
	// The subject is a derived digest, never the raw verified subject: the schema
	// refuses anything that is not one canonical lower-case SHA-256 digest, so a
	// raw subject cannot be stored even by a future writer.
	if !strings.Contains(sql, "CHECK (subject_key ~ '^[0-9a-f]{64}$')") {
		t.Error("019_risk_alert_state.sql does not constrain subject_key to a digest")
	}
	// `unread` is the absence of a mark, so it is deliberately not storable; both
	// appendable marks are named and dismissed must order above read.
	if strings.Contains(sql, "'unread'") {
		t.Error("019_risk_alert_state.sql stores 'unread'; an unread alert simply has no mark")
	}
	// The rationale above the statements explains what the schema refuses, so the
	// forbidden-substring assertions look at the statements alone. A data statement
	// in this file would be more than a new append-only table.
	var statements []string
	for _, line := range strings.Split(sql, "\n") {
		if line, _, _ := strings.Cut(line, "--"); strings.TrimSpace(line) != "" {
			statements = append(statements, strings.TrimSpace(line))
		}
	}
	code := strings.Join(statements, " ")
	for _, forbidden := range []string{"GRANT UPDATE", "GRANT DELETE", "GRANT TRUNCATE", "GRANT ALL", "DROP TABLE", "TRUNCATE", "DELETE FROM", "UPDATE "} {
		if strings.Contains(code, forbidden) {
			t.Errorf("019_risk_alert_state.sql contains %q; a stored mark is never rewritten or removed", forbidden)
		}
	}
	// The PM-07 table is untouched: no column, constraint or grant of risk_alerts
	// moves, so existing alert rows and the listing route stay byte-compatible.
	for _, forbidden := range []string{"ALTER TABLE risk_alerts", "ALTER TABLE IF EXISTS risk_alerts", "DROP TABLE risk_alerts", "risk_alerts ADD COLUMN"} {
		if strings.Contains(code, forbidden) {
			t.Errorf("019_risk_alert_state.sql contains %q; PM-07's alert table is immutable here", forbidden)
		}
	}
	// No delivery, transport or read model is frozen into this schema: the row is
	// the explicit mark PM-08 authorizes, and nothing else.
	for _, forbidden := range []string{"notified", "delivered", "email", "transport", "push"} {
		if strings.Contains(strings.ToLower(code), forbidden) {
			t.Errorf("019_risk_alert_state.sql mentions %q; PM-08 records no fictitious delivery", forbidden)
		}
	}
}

// TestRiskAlertStateClaimsTheNextFreeLedgerVersion states the reservation this
// branch depends on: risk holds 1-8, 10, 12, 13, 17 and 18, prevention holds 9,
// 11 and 14-16, so 19 was the next free integer across the integrated tree when
// this migration was claimed. 20 was already the ledger's next determination
// afterwards and PM-06 took it, so 19 must stay 19 and nothing may be inserted
// below it. The cross-service collision guard separately reads prevention's
// registry; this test pins the claim itself so a renumber cannot happen silently.
func TestRiskAlertStateClaimsTheNextFreeLedgerVersion(t *testing.T) {
	owns := false
	for _, migration := range All() {
		if migration.Version == 19 {
			owns = true
			if migration.Name != "risk_alert_state" {
				t.Errorf("version 19 is registered as %q, want risk_alert_state", migration.Name)
			}
		}
	}
	if !owns {
		t.Error("risk does not register version 19; the personal state table would never be created")
	}
	// The versions claimed after 19 must be exactly the ones the ledger recorded
	// afterwards, so this migration cannot be renumbered and no number between them
	// can be inserted silently.
	afterwards := map[int]string{}
	for _, migration := range All() {
		if migration.Version > 19 {
			afterwards[migration.Version] = migration.Name
		}
	}
	if name, claimed := afterwards[20]; !claimed || name != "batch_evaluation_actor" {
		t.Errorf("version 20 is registered as %q (present=%t), want batch_evaluation_actor", name, claimed)
	}
	if name, claimed := afterwards[21]; !claimed || name != "source_quality_reviews" {
		t.Errorf("version 21 is registered as %q (present=%t), want source_quality_reviews", name, claimed)
	}
	if len(afterwards) != 2 {
		t.Errorf("versions claimed after 19 are %v, want only 20 and 21; a new claim must update this test and the ledger together", afterwards)
	}
}
