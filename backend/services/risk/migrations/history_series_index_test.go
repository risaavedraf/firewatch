package migrations

import (
	"strings"
	"testing"
)

// TestRiskHistorySeriesIndexIsAdditiveAndTimeLed protects the one schema change
// PM-04 adds. The granular series read asks for every publication inside a window
// of requested_at, for one zone or for all of them, and keeps the newest row per
// zone and bucket. The existing index cannot serve the all-zone shape: it leads
// with zone_id, so a range on the instant alone has no prefix to seek.
//
// The assertions are deliberately narrow: the index exists, it is time-led, the
// file is guarded so re-applying it is a no-op, and it neither rewrites data nor
// touches the index the per-zone reads already depend on.
func TestRiskHistorySeriesIndexIsAdditiveAndTimeLed(t *testing.T) {
	migration := migrationFor(t, 18)
	if migration.Name != "risk_history_series_index" {
		t.Errorf("migration 18 is named %q, want %q", migration.Name, "risk_history_series_index")
	}
	var statements []string
	for _, line := range strings.Split(migration.SQL, "\n") {
		if line, _, _ := strings.Cut(line, "--"); strings.TrimSpace(line) != "" {
			statements = append(statements, strings.TrimSpace(line))
		}
	}
	sql := strings.Join(statements, " ")
	if !strings.Contains(sql, "CREATE INDEX IF NOT EXISTS batches_requested_zone ON batches(requested_at, zone_id)") {
		t.Error("018_risk_history_series_index.sql does not create the time-led index; the all-zone series read would scan the whole table")
	}
	// Time-led is the whole point: a leading zone_id would repeat the shape the
	// existing index already has and leave the all-zone window unserved.
	if strings.Contains(sql, "batches(zone_id, requested_at") {
		t.Error("the new index leads with zone_id; that duplicates the existing per-zone index instead of serving the all-zone window")
	}
	// The per-zone index is what the 100 row history and the aggregate read use.
	// This migration is additive, so it must not remove, rename or replace it.
	for _, forbidden := range []string{"DROP INDEX", "ALTER INDEX", "RENAME"} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("018_risk_history_series_index.sql contains %q; the migration is additive", forbidden)
		}
	}
	if !strings.Contains(migrationFor(t, 1).SQL, "batches_latest") {
		t.Fatal("001_initial.sql no longer creates batches_latest; this test's premise is stale")
	}
	// Nothing here destroys, rewrites or backfills: an index is a new access path
	// over rows that already exist, and a data statement would make this more than
	// that.
	for _, forbidden := range []string{"DROP TABLE", "TRUNCATE", "DELETE FROM", "UPDATE ", "INSERT INTO", "ALTER TABLE"} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("018_risk_history_series_index.sql contains %q; schema migrations here never rewrite data", forbidden)
		}
	}
	// CREATE INDEX CONCURRENTLY cannot run inside the transaction a migrator opens,
	// so its presence would make this migration fail at deploy time instead of
	// building the index.
	if strings.Contains(sql, "CONCURRENTLY") {
		t.Error("018_risk_history_series_index.sql builds the index CONCURRENTLY, which cannot run in the migrator's transaction")
	}
}

// TestRiskHistorySeriesIndexClaimsTheNextFreeLedgerVersion pins the history
// migration at 18, followed by the personal alert-state migration at 19 and PM-06's
// evaluation actor at 20. The prevention service's reservations remain unchanged,
// and the next free integer the ledger names is 21.
func TestRiskHistorySeriesIndexClaimsTheNextFreeLedgerVersion(t *testing.T) {
	owned := map[int]bool{}
	highest := 0
	for _, migration := range All() {
		owned[migration.Version] = true
		if migration.Version > highest {
			highest = migration.Version
		}
	}
	if !owned[18] {
		t.Error("risk does not register version 18; the time-led index would never be created")
	}
	if highest != 20 {
		t.Errorf("risk's highest registered version is %d, want 20; the ledger claim and this migration disagree", highest)
	}
	for _, reservedBySibling := range []int{9, 11, 14, 15, 16} {
		if owned[reservedBySibling] {
			t.Errorf("risk claims version %d, which belongs to prevention's migrations in the shared ledger", reservedBySibling)
		}
	}
}
