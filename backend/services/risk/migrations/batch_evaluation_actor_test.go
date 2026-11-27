package migrations

import (
	"strings"
	"testing"
)

// TestBatchEvaluationActorMigrationIsGuardedAndIdempotent protects PM-06's two
// columns: who triggered a persisted evaluation and, for a manual one, the
// verified token subject of the operator who asked for it. The mandante's
// criterion has two halves - every evaluation records its actor, and a scheduler
// evaluation is distinguishable from a manual one - so the schema has to state
// both, not only the writer that exists today.
//
// Every statement is guarded so applying the file twice is a no-op, and nothing
// here rewrites or destroys a stored row: the trigger's default is what makes the
// columns additive for the rows that already exist.
func TestBatchEvaluationActorMigrationIsGuardedAndIdempotent(t *testing.T) {
	migration := migrationFor(t, 20)
	if migration.Name != "batch_evaluation_actor" {
		t.Errorf("migration 20 is named %q, want %q", migration.Name, "batch_evaluation_actor")
	}
	sql := migration.SQL
	for _, fragment := range []string{
		"ALTER TABLE batches ADD COLUMN IF NOT EXISTS evaluation_trigger text NOT NULL DEFAULT 'scheduler'",
		"ALTER TABLE batches ADD COLUMN IF NOT EXISTS evaluated_by text",
		"ALTER TABLE batches DROP CONSTRAINT IF EXISTS batches_evaluation_actor_check",
		"ADD CONSTRAINT batches_evaluation_actor_check",
	} {
		if !strings.Contains(sql, fragment) {
			t.Errorf("020_batch_evaluation_actor.sql does not contain %q", fragment)
		}
	}
	// The pairing rule itself: a scheduled evaluation cannot claim an actor, and a
	// manual one cannot exist without a non-blank one. Both halves are pinned here
	// so weakening either is a test failure rather than a review comment. "Blank" is
	// the whole ASCII whitespace set, not just spaces: a subject of `\t\n` is not an
	// identity either, and the writer's strings.TrimSpace agrees with the schema.
	for _, fragment := range []string{
		"evaluation_trigger = 'scheduler' AND evaluated_by IS NULL",
		"evaluation_trigger = 'manual' AND evaluated_by IS NOT NULL AND evaluated_by !~ '^[[:space:]]*$'",
	} {
		if !strings.Contains(sql, fragment) {
			t.Errorf("020_batch_evaluation_actor.sql does not refuse the inconsistent pair %q", fragment)
		}
	}
	// `btrim` strips spaces only, so it would accept a tab/newline-only actor the
	// application already refuses. The constraint must cover the whitespace set.
	if strings.Contains(sql, "btrim(evaluated_by) <> ''") {
		t.Error("020_batch_evaluation_actor.sql uses btrim, which strips spaces only; a tab/newline-only actor would be stored")
	}
	// The migration adds columns to a table that already has a table-level grant,
	// so it must neither invent a column-level privilege nor grant a write beyond
	// insertion: a recorded trigger and actor are evidence, not editable state.
	if strings.Contains(sql, "GRANT") {
		t.Error("020_batch_evaluation_actor.sql re-grants batches; 001_initial.sql already grants SELECT and INSERT on the whole table")
	}
	for _, forbidden := range []string{"DROP TABLE", "TRUNCATE", "DELETE FROM", "UPDATE "} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("020_batch_evaluation_actor.sql contains %q; schema migrations here never destroy or rewrite data", forbidden)
		}
	}
}

// TestBatchEvaluationActorClaimsTheNextFreeLedgerVersion states the reservation
// this branch depends on. The shared ledger is claimed against the integrated
// tree, not against one module's list: risk held 1-8, 10, 12, 13, 17, 18 and 19,
// prevention holds 9, 11, 14, 15 and 16, so 20 was the next free integer and
// prevention's next migration must take 21. A version lower than 20 would collide
// with a claim this branch does not own.
func TestBatchEvaluationActorClaimsTheNextFreeLedgerVersion(t *testing.T) {
	all := All()
	highest := 0
	owns := false
	for _, migration := range all {
		if migration.Version == 20 {
			owns = true
			if migration.Name != "batch_evaluation_actor" {
				t.Errorf("version 20 is named %q, want %q", migration.Name, "batch_evaluation_actor")
			}
		}
		if migration.Version > highest {
			highest = migration.Version
		}
	}
	if !owns {
		t.Error("risk does not register version 20; the evaluation actor columns would never be created")
	}
	if highest != 20 {
		t.Errorf("risk's highest claimed version is %d, want 20; the ledger's next free integer follows from it", highest)
	}
}
