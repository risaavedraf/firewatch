package repository

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	v1 "firewatch.local/contracts/events/v1"
	"firewatch.local/risk/internal/classify"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PM-06 (S1-S2) against a real database: one persisted evaluation records its
// date, its variables, its result AND its actor, and a scheduler evaluation is
// distinguishable from a manual one. The two publication seams are what decide
// the provenance, so this test drives them instead of writing the columns itself;
// a writer that guessed the origin from a request field would fail here.
//
// It skips without TEST_DATABASE_URL, exactly like the other integration tests, and
// a skip is not a pass.
func TestPersistedEvaluationRecordsItsTriggerAndVerifiedActor(t *testing.T) {
	if testing.Short() || os.Getenv("TEST_DATABASE_URL") == "" {
		t.Skip("requires migrated disposable risk database")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := pgxpool.New(ctx, os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	s := Store{DB: db}

	assessment := Assessment{
		ModelVersion: "academic-rule-v1",
		RiskLevel:    "alto",
		Factors: []classify.Factor{{
			Name:         "temperatura",
			Known:        true,
			Value:        32,
			Contribution: 0.85,
			Note:         "lectura de alta temperatura",
		}},
		Rationale: "Puntaje ponderado alto: temperatura y viento sostienen el nivel alto.",
		Demo:      true,
	}
	// The instants are newer than every batch already stored for the zone, so the
	// aggregate read below unambiguously serves this test's manual row even though
	// the database is shared with the other integration tests.
	instant := instantNewerThanEveryStoredBatch(ctx, t, db, "valparaiso-demo")
	event := func(requestedAt time.Time) v1.Event {
		return v1.Event{
			ID:         uuid.NewString(),
			Type:       v1.JobRequestedType,
			OccurredAt: requestedAt,
			TraceID:    uuid.NewString(),
			JobID:      uuid.NewString(),
			// The descriptive actor of the transport is deliberately NOT the stored
			// actor: the seam decides the provenance, not this string.
			ActorID:     "cycle-scheduler",
			ZoneID:      "valparaiso-demo",
			RequestedAt: requestedAt,
			Demo:        true,
		}
	}

	scheduled, manual := event(instant), event(instant.Add(time.Second))
	if err = s.PublishScheduled(ctx, scheduled, assessment); err != nil {
		t.Fatalf("publish the scheduled evaluation: %v", err)
	}
	if err = s.PublishManual(ctx, manual, assessment, "operator-ana"); err != nil {
		t.Fatalf("publish the manual evaluation: %v", err)
	}

	// What the two read paths serve: the per-zone reads (latest and history) and
	// the aggregate read must all carry the provenance, so no route can serve a
	// batch without it.
	stored, err := s.List(ctx, "valparaiso-demo", 100)
	if err != nil {
		t.Fatalf("list the zone's batches: %v", err)
	}
	byJob := map[string]Batch{}
	for _, batch := range stored {
		byJob[batch.JobID] = batch
	}
	scheduledBatch, ok := byJob[scheduled.JobID]
	if !ok {
		t.Fatalf("the scheduled evaluation was not stored; stored jobs = %d", len(byJob))
	}
	if scheduledBatch.EvaluationTrigger != EvaluationTriggerScheduler {
		t.Errorf("the scheduled evaluation recorded trigger %q, want %q", scheduledBatch.EvaluationTrigger, EvaluationTriggerScheduler)
	}
	if scheduledBatch.EvaluatedBy != nil {
		t.Errorf("the scheduled evaluation recorded actor %q, want NULL", *scheduledBatch.EvaluatedBy)
	}
	manualBatch, ok := byJob[manual.JobID]
	if !ok {
		t.Fatalf("the manual evaluation was not stored; stored jobs = %d", len(byJob))
	}
	if manualBatch.EvaluationTrigger != EvaluationTriggerManual {
		t.Errorf("the manual evaluation recorded trigger %q, want %q", manualBatch.EvaluationTrigger, EvaluationTriggerManual)
	}
	if manualBatch.EvaluatedBy == nil || *manualBatch.EvaluatedBy != "operator-ana" {
		t.Errorf("the manual evaluation recorded actor %v, want the verified subject %q", manualBatch.EvaluatedBy, "operator-ana")
	}
	// The rest of what an evaluation must record travels with it, so the provenance
	// is never the only thing stored.
	if manualBatch.RequestedAt.IsZero() || manualBatch.PublishedAt.IsZero() || len(manualBatch.Factors) == 0 || manualBatch.RiskLevel != "alto" {
		t.Errorf("the manual evaluation lost its date, variables or result: %+v", manualBatch)
	}

	aggregate, err := s.LatestPerZone(ctx)
	if err != nil {
		t.Fatalf("read the aggregate: %v", err)
	}
	aggregated := false
	for _, batch := range aggregate {
		if batch.JobID != manual.JobID {
			continue
		}
		aggregated = true
		if batch.EvaluationTrigger != EvaluationTriggerManual || batch.EvaluatedBy == nil || *batch.EvaluatedBy != "operator-ana" {
			t.Errorf("the aggregate read served %q/%v, want manual/operator-ana", batch.EvaluationTrigger, batch.EvaluatedBy)
		}
	}
	if !aggregated {
		t.Error("the aggregate read did not serve this zone's newest batch")
	}

	// A manual publication that cannot name its operator is refused BEFORE the
	// transaction writes anything: no inbox mark, no batch, no invented actor.
	anonymous := event(instant.Add(2 * time.Second))
	if err = s.PublishManual(ctx, anonymous, assessment, "   "); !errors.Is(err, ErrManualEvaluationWithoutActor) {
		t.Fatalf("a manual publication without a subject returned %v, want ErrManualEvaluationWithoutActor", err)
	}
	var written int
	if err = db.QueryRow(ctx, `SELECT count(*) FROM batches WHERE job_id=$1`, anonymous.JobID).Scan(&written); err != nil {
		t.Fatal(err)
	}
	if written != 0 {
		t.Fatalf("a refused manual publication stored %d batches", written)
	}
}

// PM-06: the pairing rule lives in the schema, not only in the writer, so a future
// writer cannot record provenance that contradicts itself. The three refused pairs
// are exactly the ones the CHECK names; the accepted pair is the one the manual
// seam writes. Asserting the SQLSTATE keeps a privilege failure from being mistaken
// for the constraint doing its job.
func TestBatchEvaluationActorCheckRefusesInconsistentPairs(t *testing.T) {
	if testing.Short() || os.Getenv("TEST_DATABASE_URL") == "" {
		t.Skip("requires migrated disposable risk database")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	db, err := pgxpool.New(ctx, os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	insert := func(trigger, actor string, actorSet bool) error {
		var evaluatedBy any
		if actorSet {
			evaluatedBy = actor
		}
		_, err := db.Exec(ctx, `INSERT INTO batches(id,job_id,zone_id,requested_at,valid_until,model_version,demo,risk_level,location,evaluation_trigger,evaluated_by)
			VALUES($1,$2,'valparaiso-demo',now(),now()+interval '15 minutes','academic-rule-v1',false,'alto',ST_SetSRID(ST_MakePoint(-71.6127,-33.0472),4326),$3,$4)`,
			uuid.NewString(), uuid.NewString(), trigger, evaluatedBy)
		return err
	}
	// checkViolation reports whether the database refused the row on a CHECK, not
	// because the role lacks a privilege or the schema is missing a column.
	checkViolation := func(err error) bool {
		var pgErr *pgconn.PgError
		return errors.As(err, &pgErr) && pgErr.Code == "23514"
	}

	for _, tc := range []struct {
		name     string
		trigger  string
		actor    string
		actorSet bool
	}{
		{"scheduler with an actor", EvaluationTriggerScheduler, "operator-ana", true},
		{"manual without an actor", EvaluationTriggerManual, "", false},
		{"manual with a blank actor", EvaluationTriggerManual, "   ", true},
		// Blank is the whole ASCII whitespace set, not only spaces: the writer trims
		// with strings.TrimSpace, so the schema must refuse what the writer refuses.
		{"manual with a tab and newline actor", EvaluationTriggerManual, "\t\n", true},
		{"manual with every ascii whitespace character", EvaluationTriggerManual, " \t\r\n\f\v ", true},
		{"an unknown trigger", "cron", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := insert(tc.trigger, tc.actor, tc.actorSet); !checkViolation(err) {
				t.Fatalf("the schema accepted %+v; error = %v, want a 23514 check violation", tc, err)
			}
		})
	}
	if err := insert(EvaluationTriggerManual, "operator-ana", true); err != nil {
		t.Fatalf("the schema refused the pair the manual seam writes: %v", err)
	}
}
