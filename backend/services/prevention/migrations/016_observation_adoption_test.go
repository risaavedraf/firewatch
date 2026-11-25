package migrations

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// PM-10's migration is version 16 because versions are a repository-wide
// resource: risk claims 1-8, 10, 12 and 13, prevention claims 9, 11, 14 and 15, so
// the next integer with both ledgers counted is 16
// (backend/docs/migration-ledger.md). The file is read from this package's
// directory instead of through All() so the shape and apply tests exercise the
// bytes that will be registered, without restating the registry in a second place.

const adoptionMigrationFile = "016_observation_adoption.sql"

// adoptionMigrationSQL reads version 16's file, failing when it is absent.
func adoptionMigrationSQL(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile(adoptionMigrationFile)
	if err != nil {
		t.Fatalf("read %s: %v", adoptionMigrationFile, err)
	}
	return string(raw)
}

// TestAdoptionMigrationIsAdditiveAndLinkSafe pins the shape of version 16: one new
// table that makes "at most one action per observation" a primary-key fact, two
// foreign keys inside prevention's own schema so referential integrity costs no
// startup ordering between migration runners, the durable confirmation provenance,
// and append-only grants. Nothing in it drops, rewrites, backfills or alters an
// existing table, so every PM-09 record survives unchanged.
func TestAdoptionMigrationIsAdditiveAndLinkSafe(t *testing.T) {
	sql := adoptionMigrationSQL(t)
	for _, fragment := range []string{
		"CREATE TABLE IF NOT EXISTS prevention.observation_adoptions (",
		"observation_id uuid PRIMARY KEY",
		"REFERENCES prevention.observations(id) ON DELETE RESTRICT",
		"action_id uuid NOT NULL",
		"REFERENCES prevention.actions(id) ON DELETE RESTRICT",
		"confirmed_by text NOT NULL CHECK (btrim(confirmed_by) <> '')",
		"confirmed_at timestamptz NOT NULL DEFAULT now()",
		"CREATE INDEX IF NOT EXISTS observation_adoptions_action",
		"GRANT SELECT, INSERT ON prevention.observation_adoptions TO risk_app;",
	} {
		if !strings.Contains(sql, fragment) {
			t.Errorf("migration 016 does not contain %q", fragment)
		}
	}
	if count := strings.Count(sql, "CREATE TABLE"); count != 1 {
		t.Errorf("migration 016 creates %d tables, the adoption is exactly 1", count)
	}
	for _, forbidden := range []string{
		"ALTER TABLE", "DROP ", "DELETE FROM", "TRUNCATE",
		"UPDATE prevention.observations", "UPDATE prevention.observation_adoptions",
		"SET status", "INSERT INTO prevention.actions", "INSERT INTO prevention.action_history",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("migration 016 is not additive or writes outside its own table: it contains %q", forbidden)
		}
	}
}

// TestAdoptionMigrationClaimsVersionSixteen proves the number itself: the file is
// named 016, and no sibling migration file claims 16. A duplicated version makes
// the second migrator skip its own file in silence, which is the failure the
// shared-ledger rule exists to prevent.
func TestAdoptionMigrationClaimsVersionSixteen(t *testing.T) {
	files, err := filepath.Glob("*.sql")
	if err != nil {
		t.Fatalf("list the migration files: %v", err)
	}
	claimants := make([]string, 0, 1)
	for _, name := range files {
		if strings.HasPrefix(name, "016_") {
			claimants = append(claimants, name)
		}
	}
	if len(claimants) != 1 || claimants[0] != adoptionMigrationFile {
		t.Fatalf("version 16 is claimed by %v, want exactly %s", claimants, adoptionMigrationFile)
	}
}

// TestAdoptionMigrationAppliesRepeatedlyEnforcesIntegrityAndKeepsTheLedgerShape is
// the database-side proof of version 16: applying it twice to an isolated schema
// is a no-op, a link stores the durable provenance, both references are real
// RESTRICT foreign keys that refuse orphans and a parent delete, a second link for
// one observation is refused by the primary key, and the observations table gains
// no column — which is what keeps its append-only grants untouched.
//
// It needs a connection that may create a schema, which the compose test service's
// unprivileged risk_app URL cannot do. Set TEST_MIGRATION_DATABASE_URL to a
// disposable database's owner or superuser and run:
//
//	TEST_MIGRATION_DATABASE_URL=postgres://postgres@127.0.0.1:5432/risk?sslmode=disable go test ./migrations -run TestAdoptionMigrationApplies -count=1 -v
func TestAdoptionMigrationAppliesRepeatedlyEnforcesIntegrityAndKeepsTheLedgerShape(t *testing.T) {
	ctx, db := migrationDatabase(t)
	schema := throwawaySchema(t, ctx, db)
	ident := pgx.Identifier{schema}.Sanitize()

	if _, err := db.Exec(ctx, sqlInSchema(sqlFor(t, 9), schema)); err != nil {
		t.Fatalf("apply migration 009 to the isolated schema: %v", err)
	}
	if _, err := db.Exec(ctx, sqlInSchema(sqlFor(t, 15), schema)); err != nil {
		t.Fatalf("apply migration 015 to the isolated schema: %v", err)
	}
	sql := sqlInSchema(adoptionMigrationSQL(t), schema)
	for attempt := 1; attempt <= 2; attempt++ {
		if _, err := db.Exec(ctx, sql); err != nil {
			t.Fatalf("apply migration 016 (attempt %d): %v", attempt, err)
		}
	}

	actionID, observationID := uuid.NewString(), uuid.NewString()
	if _, err := db.Exec(ctx, `INSERT INTO `+ident+`.actions(id,community_code,title,status,created_by)
		VALUES($1,'valparaiso','Cortafuegos','propuesta','tester')`, actionID); err != nil {
		t.Fatalf("insert the action: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO `+ident+`.observations(id,type,zone_id,observed_on,description,created_by)
		VALUES($1,'quema','valparaiso-demo','2026-11-22','Pastizal seco','tester')`, observationID); err != nil {
		t.Fatalf("insert the observation: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO `+ident+`.observation_adoptions(observation_id,action_id,confirmed_by)
		VALUES($1,$2,'encargado-1')`, observationID, actionID); err != nil {
		t.Fatalf("insert the confirmed adoption: %v", err)
	}

	var confirmedBy string
	var confirmedAtZero bool
	if err := db.QueryRow(ctx, `SELECT confirmed_by, confirmed_at IS NULL FROM `+ident+`.observation_adoptions WHERE observation_id=$1`, observationID).
		Scan(&confirmedBy, &confirmedAtZero); err != nil {
		t.Fatalf("read the adoption back: %v", err)
	}
	if confirmedBy != "encargado-1" || confirmedAtZero {
		t.Errorf("stored adoption is confirmed_by=%q empty_confirmed_at=%v, want the confirmer and a server instant", confirmedBy, confirmedAtZero)
	}

	// A second link for the same observation is impossible: the primary key is the
	// "at most one action per observation" rule.
	if _, err := db.Exec(ctx, `INSERT INTO `+ident+`.observation_adoptions(observation_id,action_id,confirmed_by)
		VALUES($1,$1,'other')`, observationID); err == nil {
		t.Error("a second link for one observation was accepted; the primary key must refuse it")
	}

	// Both references are real foreign keys with an explicit RESTRICT.
	for _, constraint := range []struct{ table, name string }{
		{"observation_adoptions", "observation_adoptions_observation_id_fkey"},
		{"observation_adoptions", "observation_adoptions_action_id_fkey"},
	} {
		var deleteAction string
		if err := db.QueryRow(ctx, `SELECT c.confdeltype::text
			FROM pg_constraint c
			JOIN pg_class t ON t.oid = c.conrelid
			JOIN pg_namespace n ON n.oid = t.relnamespace
			WHERE n.nspname=$1 AND t.relname=$2 AND c.conname=$3`, schema, constraint.table, constraint.name).
			Scan(&deleteAction); err != nil {
			t.Fatalf("read the delete action of %s: %v", constraint.name, err)
		}
		if deleteAction != "r" {
			t.Errorf("%s is ON DELETE %q, want 'r' (RESTRICT)", constraint.name, deleteAction)
		}
	}

	// An orphan link is refused by the action foreign key, and a linked action
	// cannot be deleted out from under the confirmation.
	if _, err := db.Exec(ctx, `INSERT INTO `+ident+`.observation_adoptions(observation_id,action_id,confirmed_by)
		VALUES($1,$1,'tester')`, uuid.NewString()); err == nil {
		t.Error("a link naming an unknown action and observation was accepted")
	} else {
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "23503" {
			t.Errorf("inserting an orphan link returned %v, want SQLSTATE 23503", err)
		}
	}
	if _, err := db.Exec(ctx, `DELETE FROM `+ident+`.actions WHERE id=$1`, actionID); err == nil {
		t.Error("deleting a linked action succeeded; ON DELETE RESTRICT must refuse it")
	}

	// The association lives in its own table, so PM-09's observations table keeps
	// its append-only lifecycle and gained no column.
	var columns int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM information_schema.columns
		WHERE table_schema=$1 AND table_name='observations' AND column_name='adopted_action_id'`, schema).Scan(&columns); err != nil {
		t.Fatalf("read the observations columns: %v", err)
	}
	if columns != 0 {
		t.Error("the observations table gained an adopted_action_id column; the association must not require rewriting a stored observation")
	}
}
