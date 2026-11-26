package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"reflect"
	"testing"
	"time"

	v1 "firewatch.local/contracts/events/v1"
	"firewatch.local/risk/internal/classify"
	"firewatch.local/risk/internal/repository"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// simulationIntegrationZone is the one zone every risk migration guarantees: the
// legacy demo row. A commune code depends on the geographic seed step, so using it
// would make this test skip for a reason unrelated to what it verifies.
const simulationIntegrationZone = "valparaiso-demo"

// TestSimulationIntegrationLeavesBatchesUnchanged is S5's PostgreSQL evidence: the
// real authorized handler, a real HTTP request and a migrated disposable database.
// It publishes a real assessment whose policy is recorded, calls the route with
// substituted variables, and compares the full content of the batches table before
// and after. A successful substitution must be visible in the answer and leave
// every stored row byte-identical, which is what "no writes" means here.
//
// The route is also exercised for the refusal case: a newer batch recorded without
// a policy reference must answer 422 and still write nothing.
//
// It skips without TEST_DATABASE_URL, exactly like the repository integration
// suite, and it never points itself at operational data.
func TestSimulationIntegrationLeavesBatchesUnchanged(t *testing.T) {
	if testing.Short() || os.Getenv("TEST_DATABASE_URL") == "" {
		t.Skip("requires migrated disposable risk database")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	db, err := pgxpool.New(ctx, os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	store := repository.Store{DB: db}
	contract := loadContract(t)

	for _, tc := range []struct {
		name       string
		withPolicy bool
		want       int
		wantLevel  string
	}{
		{name: "reproducible rule is simulated without writing", withPolicy: true, want: http.StatusOK, wantLevel: string(classify.LevelAlto)},
		{name: "unreproducible rule is refused without writing", withPolicy: false, want: http.StatusUnprocessableEntity},
	} {
		t.Run(tc.name, func(t *testing.T) {
			batchID, ok := publishSimulationFixture(t, ctx, store, tc.withPolicy)
			if !ok {
				t.Skip("another writer replaced the newest batch of the disposable database between the fixture and the request")
			}
			before := snapshotBatches(t, ctx, db)

			handler, token := authorizedServer(t, "viewer", store)
			w := postSimulation(t, handler, token, `{"zone_id":"`+simulationIntegrationZone+`","variables":`+simulationHighVariables+`}`)
			if w.Code != tc.want {
				t.Fatalf("got %d want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if tc.want == http.StatusOK {
				assertResponseMatchesContract(t, contract, "/v1/risk/simulate", http.MethodPost, w)
			}

			after := snapshotBatches(t, ctx, db)
			if !reflect.DeepEqual(before, after) {
				t.Fatalf("the batches table changed across a simulation request: before %d rows, after %d rows", len(before), len(after))
			}

			if tc.want == http.StatusOK {
				body := decodeSimulation(t, w)
				if body.BatchID != batchID {
					t.Fatalf("batch_id = %q, want the fixture's newest batch %q", body.BatchID, batchID)
				}
				if body.After.Level != tc.wantLevel || body.Before.Level == body.After.Level {
					t.Fatalf("before=%q after=%q, want a substitution that moves the level to %q", body.Before.Level, body.After.Level, tc.wantLevel)
				}
			} else {
				assertSimulationError(t, w, "unsupported_original_rule")
			}
		})
	}
}

// publishSimulationFixture writes one real batch through the production
// publication path and reports whether it is the newest stored batch of the zone
// when the answer comes back. The publication is the test's own setup, not
// something the route does: it is what gives the route a stored rule to reproduce.
//
// A false answer means a concurrent writer published after this fixture, so the
// request would be answered for a batch this test did not create. That is a
// declared limit of running several packages against one disposable database and
// the caller skips instead of asserting on someone else's row.
func publishSimulationFixture(t *testing.T, ctx context.Context, store repository.Store, withPolicy bool) (string, bool) {
	t.Helper()
	rule := classify.NewAcademicRuleV1()
	features := simulationBaseFeatures()
	instant := time.Now().UTC()
	features.ObservedAt, features.EvaluatedAt = instant, instant
	features.ZoneID = simulationIntegrationZone
	assessment, err := rule.Classify(ctx, features)
	if err != nil {
		t.Fatalf("classify the fixture: %v", err)
	}
	if assessment.Level != classify.LevelBajo {
		t.Fatalf("the fixture classifies as %q, want %q", assessment.Level, classify.LevelBajo)
	}
	policy := assessment.Policy
	recorded := &policy
	if !withPolicy {
		recorded = nil
	}
	event := v1.Event{
		ID:          uuid.NewString(),
		JobID:       uuid.NewString(),
		TraceID:     uuid.NewString(),
		ActorID:     "simulation-integration-test",
		Type:        v1.JobRequestedType,
		ZoneID:      simulationIntegrationZone,
		Demo:        true,
		RequestedAt: instant,
	}
	if err := store.Publish(ctx, event, repository.Assessment{
		ModelVersion: rule.ID(),
		RiskLevel:    string(assessment.Level),
		Factors:      assessment.Factors,
		Rationale:    assessment.Rationale,
		Demo:         true,
		Policy:       recorded,
	}); err != nil {
		t.Fatalf("publish the fixture batch: %v", err)
	}
	var newest string
	if err := store.DB.QueryRow(ctx, `SELECT job_id::text FROM batches WHERE zone_id=$1 ORDER BY requested_at DESC, id DESC LIMIT 1`, simulationIntegrationZone).Scan(&newest); err != nil {
		t.Fatalf("read the newest batch: %v", err)
	}
	if newest != event.JobID {
		return "", false
	}
	var batchID string
	if err := store.DB.QueryRow(ctx, `SELECT id::text FROM batches WHERE job_id=$1`, event.JobID).Scan(&batchID); err != nil {
		t.Fatalf("read the fixture batch id: %v", err)
	}
	return batchID, true
}

// snapshotBatches renders every stored batch, ordered by id, as one string per
// row. The factors, the policy reference and the geometry are included as text so
// an update that leaves the identifiers alone is still visible: a handler that
// rewrote a level or a policy would change this snapshot.
func snapshotBatches(t *testing.T, ctx context.Context, db *pgxpool.Pool) []string {
	t.Helper()
	rows, err := db.Query(ctx, `SELECT id::text, job_id::text, zone_id, requested_at, published_at, valid_until,
			model_version, demo, risk_level, coalesce(factors::text, 'null'), coalesce(rationale, ''),
			coalesce(policy_ref::text, 'null'), coalesce(scenario_id, ''), coalesce(evaluated_at::text, ''),
			coalesce(ST_AsText(location), '')
		FROM batches ORDER BY id`)
	if err != nil {
		t.Fatalf("snapshot the batches table: %v", err)
	}
	defer rows.Close()
	var snapshot []string
	for rows.Next() {
		var (
			id, jobID, zone, modelVersion, riskLevel, factors, rationale, policy, scenario, evaluated, location string
			requestedAt, publishedAt, validUntil                                                                time.Time
			demo                                                                                                bool
		)
		if err := rows.Scan(&id, &jobID, &zone, &requestedAt, &publishedAt, &validUntil, &modelVersion, &demo, &riskLevel, &factors, &rationale, &policy, &scenario, &evaluated, &location); err != nil {
			t.Fatalf("scan a batch row: %v", err)
		}
		row, err := json.Marshal([]any{id, jobID, zone, requestedAt.UTC(), publishedAt.UTC(), validUntil.UTC(), modelVersion, demo, riskLevel, factors, rationale, policy, scenario, evaluated, location})
		if err != nil {
			t.Fatalf("encode a batch row: %v", err)
		}
		snapshot = append(snapshot, string(row))
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read the batches snapshot: %v", err)
	}
	return snapshot
}
