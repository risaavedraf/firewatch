package repository

// BH-10, Create-boundary concurrency slice: the two ordinary concurrent Create
// cases at the persistence boundary (same actor/key, and distinct identities),
// the atomicity of the request write, and the guard that keeps these writes away
// from any target except the disposable jobs test database. Everything except the
// guard test skips without TEST_DATABASE_URL; a skip is not a pass. Runnable
// command and unproven scope (broker ordering, redelivery, connection loss) are
// recorded in the BH-10 unit document.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	v1 "firewatch.local/contracts/events/v1"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	concurrentCreateRequests = 8 // wave size; larger than the pool minimum so the requests overlap
	concurrentCreateZone     = "valparaiso-demo"
	// The only target the guard accepts: the repository's dedicated test database
	// reached with the application role. jobs_app also exists on the operational
	// databases, so the role alone proves nothing.
	disposableTargetDatabase = "jobs_test"
	disposableTargetRole     = "jobs_app"
	// composeServiceAlias is how the docker-compose test profile addresses the
	// database. It is the one non-loopback name accepted, and it is exact: no
	// arbitrary network host becomes disposable because TEST_DATABASE_URL was set.
	composeServiceAlias = "postgres"
)

// checkDisposableTarget is the fail-closed half of the safeguard. It refuses
// before a connection is opened: the same role exists on the operational
// databases, so a reachable server does not make the target disposable. A
// different host requires a code change and review, not an environment variable.
func checkDisposableTarget(host, database, user string) error {
	if database != disposableTargetDatabase {
		return fmt.Errorf("refusing database %q: these tests require the disposable %q database", database, disposableTargetDatabase)
	}
	if user != disposableTargetRole {
		return fmt.Errorf("refusing role %q: these tests require the application role %q", user, disposableTargetRole)
	}
	switch host {
	case "127.0.0.1", "::1", "localhost", composeServiceAlias:
		return nil
	default:
		return fmt.Errorf("refusing host %q: only loopback or the compose alias %q is disposable here", host, composeServiceAlias)
	}
}

// disposableTargetConfig parses TEST_DATABASE_URL and validates EVERY target,
// fallbacks included, before any connection is opened. A malformed DSN gets a
// fixed message: the driver's parse error can quote the raw URL, password
// included, so it is never forwarded.
func disposableTargetConfig(dsn string) (*pgxpool.Config, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, errors.New("TEST_DATABASE_URL is not a usable PostgreSQL URL")
	}
	hosts := []string{cfg.ConnConfig.Host}
	for _, fallback := range cfg.ConnConfig.Fallbacks {
		hosts = append(hosts, fallback.Host)
	}
	for _, host := range hosts {
		if err = checkDisposableTarget(host, cfg.ConnConfig.Database, cfg.ConnConfig.User); err != nil {
			return nil, err
		}
	}
	return cfg, nil
}

// TestDisposableTargetFailsClosed drives the guard through the real DSN parser,
// the way the fixture reaches it; everything asserted here happens before a
// connection exists. Every row carries a canary password and every refusal is
// checked for it, so a rejected target can never print the DSN.
func TestDisposableTargetFailsClosed(t *testing.T) {
	const canary = "canary-password-must-not-be-printed"
	for _, tc := range []struct {
		name, dsn, wantText, wantDatabase string
		fallbacks                         int
	}{
		{name: "accepts local container", dsn: "postgres://jobs_app:" + canary + "@127.0.0.1:59692/jobs_test?sslmode=disable", wantDatabase: disposableTargetDatabase},
		{name: "accepts ipv6 loopback", dsn: "postgres://jobs_app:" + canary + "@[::1]:59692/jobs_test?sslmode=disable", wantDatabase: disposableTargetDatabase},
		{name: "accepts localhost", dsn: "postgres://jobs_app:" + canary + "@localhost:59692/jobs_test?sslmode=disable", wantDatabase: disposableTargetDatabase},
		{name: "accepts compose service alias", dsn: "postgres://jobs_app:" + canary + "@postgres:5432/jobs_test?sslmode=disable", wantDatabase: disposableTargetDatabase},
		{name: "accepts the CI alias with a loopback fallback", dsn: "postgres://jobs_app:" + canary + "@postgres:5432,127.0.0.1:5432/jobs_test?sslmode=disable", wantDatabase: disposableTargetDatabase, fallbacks: 1},
		{name: "refuses application database", dsn: "postgres://jobs_app:" + canary + "@127.0.0.1:59692/jobs?sslmode=disable", wantText: `"jobs_test"`},
		{name: "refuses application database on the CI alias", dsn: "postgres://jobs_app:" + canary + "@postgres:5432/jobs?sslmode=disable", wantText: `"jobs_test"`},
		{name: "refuses unrelated network host", dsn: "postgres://jobs_app:" + canary + "@192.0.2.1:5432/jobs_test?sslmode=disable", wantText: `"192.0.2.1"`},
		{name: "refuses superuser role", dsn: "postgres://postgres:" + canary + "@127.0.0.1:59692/jobs_test?sslmode=disable", wantText: `"jobs_app"`},
		{name: "refuses other service role", dsn: "postgres://risk_app:" + canary + "@127.0.0.1:59692/jobs_test?sslmode=disable", wantText: `"jobs_app"`},
		{name: "refuses a network host in a fallback", dsn: "postgres://jobs_app:" + canary + "@127.0.0.1:59692,192.0.2.1:5432/jobs_test?sslmode=disable", wantText: `"192.0.2.1"`},
		{name: "refuses malformed port", dsn: "postgres://jobs_app:" + canary + "@127.0.0.1:not-a-port/jobs_test", wantText: "not a usable PostgreSQL URL"},
		{name: "refuses malformed escaping", dsn: "postgres://jobs_app:" + canary + "%@127.0.0.1:59692/jobs_test", wantText: "not a usable PostgreSQL URL"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg, err := disposableTargetConfig(tc.dsn)
			if tc.wantText == "" {
				if err != nil {
					t.Fatalf("guard refused a disposable target: %v", err)
				}
				// The fallback count proves the host list was really parsed, so the
				// refused-fallback case is not rejected for the wrong reason.
				if cfg.ConnConfig.Database != tc.wantDatabase || len(cfg.ConnConfig.Fallbacks) != tc.fallbacks {
					t.Fatalf("parsed database=%q fallbacks=%d, want %q/%d", cfg.ConnConfig.Database, len(cfg.ConnConfig.Fallbacks), tc.wantDatabase, tc.fallbacks)
				}
				return
			}
			if err == nil {
				t.Fatalf("guard accepted a target it must refuse: host=%q database=%q fallbacks=%d", cfg.ConnConfig.Host, cfg.ConnConfig.Database, len(cfg.ConnConfig.Fallbacks))
			}
			if strings.Contains(err.Error(), canary) {
				t.Fatalf("guard leaked the DSN password in its error: %v", err)
			}
			if !strings.Contains(err.Error(), tc.wantText) {
				t.Fatalf("refusal = %q, want it to contain %q", err, tc.wantText)
			}
		})
	}
}

// concurrentCreateFixture is one connection pool and the store built on it. Each
// test gets its own, so a wave in one test cannot be mistaken for another.
type concurrentCreateFixture struct {
	ctx   context.Context
	db    *pgxpool.Pool
	store Store
}

func newConcurrentCreateFixture(t *testing.T) concurrentCreateFixture {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if testing.Short() || dsn == "" {
		t.Skip("requires a migrated disposable jobs database in TEST_DATABASE_URL")
	}
	cfg, err := disposableTargetConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	// Every request in a wave needs its own transaction at the same time; a smaller
	// pool would serialise them in the pool, not the database.
	cfg.MaxConns = int32(2*concurrentCreateRequests + 4)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	t.Cleanup(cancel)
	db, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("connect to the disposable target: %v", err)
	}
	t.Cleanup(db.Close)
	// The server has to agree with the parsed target BEFORE the test writes
	// anything: the DSN can name jobs_test while the session lands elsewhere.
	var database, role string
	if err = db.QueryRow(ctx, `SELECT current_database(), current_user`).Scan(&database, &role); err != nil {
		t.Fatalf("verify the connected target: %v", err)
	}
	if database != disposableTargetDatabase || role != disposableTargetRole {
		t.Fatalf("connected to %q as %q, want %q as %q", database, role, disposableTargetDatabase, disposableTargetRole)
	}
	return concurrentCreateFixture{ctx: ctx, db: db, store: Store{DB: db}}
}

// identityWrites counts the three durable rows one identity may produce: the
// stored job, the outbox effect that announces it and the audit record of the
// action. One statement gives the three counts one snapshot; the same counts are
// the positive control in the rollback case, so a zero there is evidence rather
// than a blind count.
func (f concurrentCreateFixture) identityWrites(t *testing.T, actor, key string) (jobs, effects, audits int) {
	t.Helper()
	err := f.db.QueryRow(f.ctx, `SELECT
		(SELECT count(*) FROM jobs WHERE actor_id=$1 AND idempotency_key=$2),
		(SELECT count(*) FROM outbox WHERE payload->>'actor_id'=$1),
		(SELECT count(*) FROM audit WHERE actor_id=$1 AND action='job.requested')`, actor, key).Scan(&jobs, &effects, &audits)
	if err != nil {
		t.Fatalf("count the identity's writes: %v", err)
	}
	return jobs, effects, audits
}

// assertSingleIdentityWrite fails unless the job the identity returned exists
// under its own (actor, key), carries exactly one effect attributed to that
// actor, and exactly one audit record. Scoping the effect and the audit by job id
// rather than by actor is what keeps the assertion meaningful when several
// identities share one actor.
func (f concurrentCreateFixture) assertSingleIdentityWrite(t *testing.T, call createCall, wantJobID string) {
	t.Helper()
	var jobs, effects, audits int
	err := f.db.QueryRow(f.ctx, `SELECT
		(SELECT count(*) FROM jobs WHERE actor_id=$1 AND idempotency_key=$2 AND id=$3),
		(SELECT count(*) FROM outbox WHERE (payload->>'job_id')::uuid=$3 AND payload->>'actor_id'=$1),
		(SELECT count(*) FROM audit WHERE job_id=$3 AND action='job.requested' AND actor_id=$1)`, call.actor, call.key, wantJobID).Scan(&jobs, &effects, &audits)
	if err != nil {
		t.Fatalf("count identity %s/%s: %v", call.actor, call.key, err)
	}
	if jobs != 1 || effects != 1 || audits != 1 {
		t.Fatalf("identity writes = jobs:%d effects:%d audits:%d, want 1/1/1", jobs, effects, audits)
	}
}

// createCall is one Create request in a wave.
type createCall struct{ actor, key, trace, scenario string }

type createOutcome struct {
	index int
	job   Job
	err   error
}

// runCreateWave releases every call at the same instant and returns their
// outcomes in call order. Results travel over a buffered channel and the caller
// applies the index, so no goroutine writes memory another goroutine reads.
func runCreateWave(s Store, ctx context.Context, calls []createCall) []createOutcome {
	start := make(chan struct{})
	results := make(chan createOutcome, len(calls))
	var wg sync.WaitGroup
	for i, call := range calls {
		wg.Add(1)
		go func(i int, call createCall) {
			defer wg.Done()
			<-start
			job, err := s.Create(ctx, call.actor, call.key, concurrentCreateZone, call.trace, call.scenario)
			results <- createOutcome{index: i, job: job, err: err}
		}(i, call)
	}
	close(start)
	wg.Wait()
	close(results)
	outcomes := make([]createOutcome, len(calls))
	for result := range results {
		outcomes[result.index] = result
	}
	return outcomes
}

// assertSameJobRecord pins every field two answers about one identity must agree
// on. Comparing against the STORED row, not only against each other, makes the
// conflict path answerable: a retry returning its own scenario while the row kept
// the first would agree with itself and still be wrong.
func assertSameJobRecord(t *testing.T, got, want Job) {
	t.Helper()
	if got.ID != want.ID || got.ZoneID != want.ZoneID || got.State != want.State || got.Attempts != want.Attempts {
		t.Fatalf("job = %s/%s/%s attempts:%d, want %s/%s/%s attempts:%d", got.ID, got.ZoneID, got.State, got.Attempts, want.ID, want.ZoneID, want.State, want.Attempts)
	}
	if !got.RequestedAt.Equal(want.RequestedAt) {
		t.Fatalf("requested_at = %v, want %v", got.RequestedAt, want.RequestedAt)
	}
	differs := func(a, b *string) bool { return (a == nil) != (b == nil) || (a != nil && *a != *b) }
	if differs(got.BatchID, want.BatchID) || differs(got.ScenarioID, want.ScenarioID) || differs(got.FailureReason, want.FailureReason) {
		t.Fatalf("nullable fields = batch:%v scenario:%v failure:%v, want batch:%v scenario:%v failure:%v", got.BatchID, got.ScenarioID, got.FailureReason, want.BatchID, want.ScenarioID, want.FailureReason)
	}
	if (got.EvaluatedAt == nil) != (want.EvaluatedAt == nil) || (got.EvaluatedAt != nil && !got.EvaluatedAt.Equal(*want.EvaluatedAt)) {
		t.Fatalf("evaluated_at = %v, want %v", got.EvaluatedAt, want.EvaluatedAt)
	}
}

// TestConcurrentCreateSameIdentityConvergesOnOneJobAndOneEffect proves a wave of
// simultaneous requests for the SAME actor and key produces one stored job, one
// outbox effect and one audit record, and every request returns the stored row.
func TestConcurrentCreateSameIdentityConvergesOnOneJobAndOneEffect(t *testing.T) {
	f := newConcurrentCreateFixture(t)
	actor, key := uuid.NewString(), uuid.NewString()
	calls := make([]createCall, concurrentCreateRequests)
	submitted := make(map[string]bool, concurrentCreateRequests)
	for i := range calls {
		scenario := "dry-windy"
		if i%2 == 1 {
			scenario = "mild"
		}
		calls[i] = createCall{actor: actor, key: key, trace: uuid.NewString(), scenario: scenario}
		submitted[calls[i].trace] = true
	}
	outcomes := runCreateWave(f.store, f.ctx, calls)
	for i, outcome := range outcomes {
		if outcome.err != nil {
			t.Fatalf("request %d failed: %v", i, outcome.err)
		}
	}
	converged := outcomes[0].job
	for i, outcome := range outcomes[1:] {
		if outcome.job.ID != converged.ID {
			t.Fatalf("request %d returned job %s, want the single job %s", i+1, outcome.job.ID, converged.ID)
		}
		assertSameJobRecord(t, outcome.job, converged)
	}
	// Every answer must also equal the persisted row.
	stored, err := f.store.Get(f.ctx, converged.ID)
	if err != nil {
		t.Fatalf("read the stored job: %v", err)
	}
	if stored.State != "queued" || stored.ZoneID != concurrentCreateZone || stored.ScenarioID == nil {
		t.Fatalf("stored job = %+v, want a queued job with its scenario metadata", stored)
	}
	assertSameJobRecord(t, converged, stored)
	f.assertSingleIdentityWrite(t, calls[0], converged.ID)
	// The one effect is the converged job's request event and the one audit row
	// carries the same winning trace: both came from one request.
	var routingKey string
	var payload []byte
	var event v1.Event
	if err = f.db.QueryRow(f.ctx, `SELECT routing_key,payload FROM outbox WHERE payload->>'job_id'=$1`, converged.ID).Scan(&routingKey, &payload); err == nil {
		err = json.Unmarshal(payload, &event)
	}
	if err != nil {
		t.Fatalf("read the single effect: %v", err)
	}
	if routingKey != v1.JobRequestedType || event.ID == "" || event.Type != v1.JobRequestedType || event.JobID != converged.ID || event.ActorID != actor || event.ZoneID != concurrentCreateZone {
		t.Fatalf("effect %q = %+v, want the converged job %s", routingKey, event, converged.ID)
	}
	if event.ScenarioID != *stored.ScenarioID {
		t.Fatalf("effect scenario = %q, want the stored %q", event.ScenarioID, *stored.ScenarioID)
	}
	var auditTrace string
	if err = f.db.QueryRow(f.ctx, `SELECT trace_id::text FROM audit WHERE job_id=$1 AND action='job.requested'`, converged.ID).Scan(&auditTrace); err != nil {
		t.Fatalf("read the single audit record: %v", err)
	}
	if auditTrace != event.TraceID || !submitted[auditTrace] {
		t.Fatalf("audit trace = %q (effect %q) is not one submitted request", auditTrace, event.TraceID)
	}
	// A retry after the wave is the same job and adds no effect, even with a
	// different scenario: idempotency is not a race-only property.
	retried, err := f.store.Create(f.ctx, actor, key, concurrentCreateZone, uuid.NewString(), "mixed")
	if err != nil {
		t.Fatalf("retry after the wave: %v", err)
	}
	assertSameJobRecord(t, retried, stored)
	f.assertSingleIdentityWrite(t, calls[0], converged.ID)
}

// TestConcurrentCreateKeepsActorAndKeyIndependent puts, in ONE wave, one identity
// asked four times, three other keys of that SAME actor, and three other actors
// asking that SAME key. Actor-only coupling would collapse the second group into
// one job; key-only coupling would collapse the third. Each identity must keep
// its own job, every response must equal the row it persisted, and each must
// leave exactly one effect.
//
// The gate releases all requests together; it does NOT prove the statements
// overlapped inside the server, so these are concurrent-in-intent cases.
func TestConcurrentCreateKeepsActorAndKeyIndependent(t *testing.T) {
	f := newConcurrentCreateFixture(t)
	actor, key := uuid.NewString(), uuid.NewString()
	request := func(actor, key string) createCall {
		return createCall{actor: actor, key: key, trace: uuid.NewString(), scenario: "dry-windy"}
	}
	calls := make([]createCall, 0, 10)
	for range 4 {
		calls = append(calls, request(actor, key))
	}
	for range 3 {
		calls = append(calls, request(actor, uuid.NewString()))
	}
	for range 3 {
		calls = append(calls, request(uuid.NewString(), key))
	}
	outcomes := runCreateWave(f.store, f.ctx, calls)
	for i, outcome := range outcomes {
		if outcome.err != nil {
			t.Fatalf("request %d failed: %v", i, outcome.err)
		}
	}
	type identity struct{ actor, key string }
	stored := make(map[identity]Job, 7)
	owners := make(map[string]identity, 7)
	for i, outcome := range outcomes {
		id := identity{actor: calls[i].actor, key: calls[i].key}
		row, known := stored[id]
		if !known {
			var err error
			if row, err = f.store.Get(f.ctx, outcome.job.ID); err != nil {
				t.Fatalf("read job %s of identity %v: %v", outcome.job.ID, id, err)
			}
			if owner, taken := owners[row.ID]; taken {
				t.Fatalf("identities %v and %v share job %s", owner, id, row.ID)
			}
			owners[row.ID] = id
			stored[id] = row
		}
		// Every response must equal the row its own identity persisted, so a
		// collapsed group fails here and not only in the counts below.
		assertSameJobRecord(t, outcome.job, row)
	}
	if len(stored) != 7 {
		t.Fatalf("distinct identities = %d, want 7", len(stored))
	}
	for id, row := range stored {
		f.assertSingleIdentityWrite(t, createCall{actor: id.actor, key: id.key}, row.ID)
	}
}

// TestCreateRollsBackEveryWriteWhenTheAuditInsertFails proves the request write
// is atomic. The trace is not a UUID, so the audit insert - the third statement
// of the same transaction, after the job and the outbox row - is rejected by the
// server itself; no production file and no schema is touched.
func TestCreateRollsBackEveryWriteWhenTheAuditInsertFails(t *testing.T) {
	f := newConcurrentCreateFixture(t)
	actor, key := uuid.NewString(), uuid.NewString()
	_, err := f.store.Create(f.ctx, actor, key, concurrentCreateZone, "not-a-uuid", "dry-windy")
	var pgErr *pgconn.PgError
	if err == nil || !errors.As(err, &pgErr) || pgErr.Code != "22P02" {
		t.Fatalf("err = %v, want the server's own data exception (SQLSTATE 22P02)", err)
	}
	// Positive control: the same counts are 1/1/1 for an identity that was really
	// written, so the zeros below are evidence, not a blind count.
	control := createCall{actor: uuid.NewString(), key: uuid.NewString(), trace: uuid.NewString(), scenario: "dry-windy"}
	controlJob, err := f.store.Create(f.ctx, control.actor, control.key, concurrentCreateZone, control.trace, control.scenario)
	if err != nil {
		t.Fatalf("control create: %v", err)
	}
	f.assertSingleIdentityWrite(t, control, controlJob.ID)
	if jobs, effects, audits := f.identityWrites(t, actor, key); jobs != 0 || effects != 0 || audits != 0 {
		t.Fatalf("aborted create left jobs:%d effects:%d audits:%d, want 0/0/0", jobs, effects, audits)
	}
	// Nothing partial remained, so the identity is still free: the retry succeeds
	// with exactly one job, one effect and one audit record.
	retried, err := f.store.Create(f.ctx, actor, key, concurrentCreateZone, uuid.NewString(), "dry-windy")
	if err != nil {
		t.Fatalf("retry after the aborted attempt: %v", err)
	}
	f.assertSingleIdentityWrite(t, createCall{actor: actor, key: key}, retried.ID)
	stored, err := f.store.Get(f.ctx, retried.ID)
	if err != nil {
		t.Fatalf("read the retried job: %v", err)
	}
	assertSameJobRecord(t, retried, stored)
}
