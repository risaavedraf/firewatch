package repository

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	v1 "firewatch.local/contracts/events/v1"
	"firewatch.local/risk/internal/classify"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// storedAlert is one row of risk_alerts read back for the assertions. It is read
// with SQL rather than through the store because the store deliberately exposes no
// alert reader yet: PM-08 owns the listing surface, and the alert writer is what
// this task proves.
type storedAlert struct {
	ZoneID        string
	BatchID       string
	PreviousLevel string
	NewLevel      string
	Threshold     int
	OccurredAt    time.Time
}

// alertTestPool opens the migrated disposable database these tests need, or skips
// them. The skip is the declared limit: without TEST_DATABASE_URL nothing here is
// evidence, and `go test` alone cannot prove a constraint, a lock or a
// transaction.
func alertTestPool(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	return alertTestPoolWith(t, nil)
}

// alertTestPoolWith is alertTestPool with a last chance to configure the pool.
// A test that creates session-local scaffolding needs exactly one connection,
// because the scaffolding exists in that session and nowhere else: that is the
// same technique TestListRefusesMissingCommuneGeometry uses to shadow the zone
// catalogue.
func alertTestPoolWith(t *testing.T, configure func(*pgxpool.Config)) (context.Context, *pgxpool.Pool) {
	t.Helper()
	if testing.Short() || os.Getenv("TEST_DATABASE_URL") == "" {
		t.Skip("requires migrated disposable risk database")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	t.Cleanup(cancel)
	config, err := pgxpool.ParseConfig(os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	if configure != nil {
		configure(config)
	}
	db, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	return ctx, db
}

// newestByTieBreak returns the identifier the newest-per-zone rule selects
// between two batches stored with the same requested_at: the greater identifier,
// because the ORDER BY ends with the uuid column and the canonical text form of a
// uuid orders exactly like the column value does.
func newestByTieBreak(first, second string) string {
	if first > second {
		return first
	}
	return second
}

// instantNewerThanEveryStoredBatch picks an instant that is strictly newer than
// any batch the zone already holds, so the batches this test publishes become the
// zone's effective newest instead of landing in its history. The database is
// reused across tests, so advance from the zone's last stored assessment. Start
// in the past on a fresh database so the fixture cannot shadow the current
// batches published by the existing wall-clock tests.
func instantNewerThanEveryStoredBatch(ctx context.Context, t *testing.T, db *pgxpool.Pool, zone string) time.Time {
	t.Helper()
	var stored time.Time
	if err := db.QueryRow(ctx, `SELECT coalesce(max(requested_at), 'epoch'::timestamptz) FROM batches WHERE zone_id=$1`, zone).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	base := time.Date(2000, time.January, 1, 0, 0, 0, 0, time.UTC)
	if !base.After(stored) {
		base = stored.Add(time.Microsecond).UTC()
	}
	return base
}

// publishTestBatch stores one batch through the store and returns its job and
// batch ids. It fails the test instead of returning the error because every call
// in this file is on the happy path of the publication seam.
func publishTestBatch(ctx context.Context, t *testing.T, store Store, zone string, requestedAt time.Time, level string) (v1.Event, string) {
	t.Helper()
	event := v1.Event{ID: uuid.NewString(), JobID: uuid.NewString(), TraceID: uuid.NewString(), ActorID: "test", Type: v1.JobRequestedType, ZoneID: zone, RequestedAt: requestedAt}
	assessment := Assessment{ModelVersion: classify.AcademicRuleV1ID, RiskLevel: level, Factors: []classify.Factor{}, Rationale: "transition fixture"}
	if err := store.Publish(ctx, event, assessment); err != nil {
		t.Fatalf("publish %s batch at %s: %v", level, requestedAt, err)
	}
	var batchID string
	if err := store.DB.QueryRow(ctx, `SELECT id::text FROM batches WHERE job_id=$1`, event.JobID).Scan(&batchID); err != nil {
		t.Fatalf("read the stored batch of %s: %v", event.JobID, err)
	}
	return event, batchID
}

// alertsOfBatches reads the alerts that name one of the given batches. Only the
// batches this test published are considered, so the shared disposable database
// and the rows an earlier run left behind cannot change the answer.
func alertsOfBatches(ctx context.Context, t *testing.T, db *pgxpool.Pool, batchIDs []string) map[string]storedAlert {
	t.Helper()
	rows, err := db.Query(ctx, `SELECT zone_id,batch_id::text,previous_level,new_level,threshold,occurred_at FROM risk_alerts WHERE batch_id::text = ANY($1) ORDER BY occurred_at`, batchIDs)
	if err != nil {
		t.Fatalf("read the alerts of the published batches: %v", err)
	}
	defer rows.Close()
	alerts := map[string]storedAlert{}
	for rows.Next() {
		var alert storedAlert
		if err := rows.Scan(&alert.ZoneID, &alert.BatchID, &alert.PreviousLevel, &alert.NewLevel, &alert.Threshold, &alert.OccurredAt); err != nil {
			t.Fatalf("scan a stored alert: %v", err)
		}
		if _, duplicate := alerts[alert.BatchID]; duplicate {
			t.Fatalf("batch %s carries more than one alert; the batch identity must make the alert idempotent", alert.BatchID)
		}
		alerts[alert.BatchID] = alert
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate the stored alerts: %v", err)
	}
	return alerts
}

// TestPublishRecordsAnAlertForAscentAndDescentAndNotForNoChange is the S1
// triangle on the explicit publication path: the ascent alerts, the descent
// alerts, the same level twice does not, and an unknown level never does - on
// either side of the transition. Each assertion names the batch, so the alert
// cannot be satisfied by a row some other publication wrote.
func TestPublishRecordsAnAlertForAscentAndDescentAndNotForNoChange(t *testing.T) {
	ctx, db := alertTestPool(t)
	store := Store{DB: db}
	const zone = "valparaiso-demo"
	base := instantNewerThanEveryStoredBatch(ctx, t, db, zone)

	// The chain starts at a known level so the steps below are transitions of this
	// test and not of whatever the shared database already held.
	_, baselineID := publishTestBatch(ctx, t, store, zone, base, string(classify.LevelMedio))
	_, ascentID := publishTestBatch(ctx, t, store, zone, base.Add(time.Second), string(classify.LevelAlto))
	_, descentID := publishTestBatch(ctx, t, store, zone, base.Add(2*time.Second), string(classify.LevelMedio))
	_, unchangedID := publishTestBatch(ctx, t, store, zone, base.Add(3*time.Second), string(classify.LevelMedio))
	_, unknownID := publishTestBatch(ctx, t, store, zone, base.Add(4*time.Second), string(classify.LevelDesconocido))
	_, afterUnknownID := publishTestBatch(ctx, t, store, zone, base.Add(5*time.Second), string(classify.LevelAlto))

	alerts := alertsOfBatches(ctx, t, db, []string{baselineID, ascentID, descentID, unchangedID, unknownID, afterUnknownID})

	ascent, ok := alerts[ascentID]
	if !ok {
		t.Fatal("el ascenso medio -> alto no dejó alerta")
	}
	if ascent.PreviousLevel != string(classify.LevelMedio) || ascent.NewLevel != string(classify.LevelAlto) {
		t.Fatalf("ascenso recordado como %s -> %s, want medio -> alto", ascent.PreviousLevel, ascent.NewLevel)
	}
	if ascent.ZoneID != zone {
		t.Fatalf("alerta de la zona %q, want %q", ascent.ZoneID, zone)
	}
	if ascent.Threshold != AlertLevelChangeThreshold {
		t.Fatalf("ascenso con umbral %d, want el acordado %d", ascent.Threshold, AlertLevelChangeThreshold)
	}
	if !ascent.OccurredAt.Equal(base.Add(time.Second)) {
		t.Fatalf("ascenso fechado en %s, want el instante de la evaluación %s", ascent.OccurredAt, base.Add(time.Second))
	}

	descent, ok := alerts[descentID]
	if !ok {
		t.Fatal("el descenso alto -> medio no dejó alerta")
	}
	if descent.PreviousLevel != string(classify.LevelAlto) || descent.NewLevel != string(classify.LevelMedio) {
		t.Fatalf("descenso recordado como %s -> %s, want alto -> medio", descent.PreviousLevel, descent.NewLevel)
	}

	// The absence half of S1: the level did not change.
	if unchanged, alerted := alerts[unchangedID]; alerted {
		t.Fatalf("una evaluación medio -> medio dejó la alerta %s -> %s", unchanged.PreviousLevel, unchanged.NewLevel)
	}
	// `desconocido` is not a severity: neither entering it nor leaving it is a
	// risk transition S2 authorizes an alert for.
	if unknown, alerted := alerts[unknownID]; alerted {
		t.Fatalf("una evaluación medio -> desconocido dejó la alerta %s -> %s", unknown.PreviousLevel, unknown.NewLevel)
	}
	if afterUnknown, alerted := alerts[afterUnknownID]; alerted {
		t.Fatalf("una evaluación desconocido -> alto dejó la alerta %s -> %s", afterUnknown.PreviousLevel, afterUnknown.NewLevel)
	}
}

// TestFirstAssessmentOfAZoneStoresNoAlert proves the "no previous level" edge: an
// alert needs a level to come from, and a zone's first assessment has none. The
// test needs a zone without a stored batch, which a shared disposable database
// may not have; it then skips with that reason instead of passing on a weaker
// claim.
func TestFirstAssessmentOfAZoneStoresNoAlert(t *testing.T) {
	ctx, db := alertTestPool(t)
	store := Store{DB: db}
	zone := zoneWithoutBatches(ctx, t, db)
	if zone == "" {
		t.Skip("every catalogued zone already holds a batch; first-assessment evidence needs a fresh disposable database")
	}
	event, batchID := publishTestBatch(ctx, t, store, zone, time.Now().UTC().Truncate(time.Microsecond), string(classify.LevelAlto))
	var batches int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM batches WHERE zone_id=$1`, zone).Scan(&batches); err != nil || batches != 1 {
		t.Fatalf("batches of zone %q = %d (err=%v), want exactly the first assessment", zone, batches, err)
	}
	if alerts := alertsOfBatches(ctx, t, db, []string{batchID}); len(alerts) != 0 {
		t.Fatalf("the first assessment of zone %q (job %s) stored an alert it has no previous level for", zone, event.JobID)
	}
}

// zoneWithoutBatches returns a catalogued zone that holds no batch yet, or "".
func zoneWithoutBatches(ctx context.Context, t *testing.T, db *pgxpool.Pool) string {
	t.Helper()
	var zone string
	err := db.QueryRow(ctx, `SELECT z.code FROM zones z LEFT JOIN batches b ON b.zone_id=z.code GROUP BY z.code HAVING count(b.id)=0 ORDER BY z.code LIMIT 1`).Scan(&zone)
	if errors.Is(err, pgx.ErrNoRows) {
		return ""
	}
	if err != nil {
		t.Fatal(err)
	}
	return zone
}

// TestAnOutOfOrderBatchStoresNoAlertAndLeavesTheEffectiveLevelAlone protects the
// chronological contract the newest-per-zone API already implements. A batch whose
// requested_at is older than the zone's effective newest is stored history, not a
// transition: it must not alert, it must not become the level the next transition
// compares against, and it must not change what /v1/risk/latest answers.
func TestAnOutOfOrderBatchStoresNoAlertAndLeavesTheEffectiveLevelAlone(t *testing.T) {
	ctx, db := alertTestPool(t)
	store := Store{DB: db}
	const zone = "valparaiso-demo"
	base := instantNewerThanEveryStoredBatch(ctx, t, db, zone)

	_, newestID := publishTestBatch(ctx, t, store, zone, base, string(classify.LevelAlto))
	_, staleID := publishTestBatch(ctx, t, store, zone, base.Add(-30*time.Second), string(classify.LevelBajo))

	alerts := alertsOfBatches(ctx, t, db, []string{newestID, staleID})
	if stale, alerted := alerts[staleID]; alerted {
		t.Fatalf("a batch older than the effective newest (%s at %s) stored the alert %s -> %s", zone, base.Add(-30*time.Second), stale.PreviousLevel, stale.NewLevel)
	}
	// Stored, not refused: the point is that history is kept without alerting.
	var stored int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM batches WHERE id=$1`, staleID).Scan(&stored); err != nil || stored != 1 {
		t.Fatalf("the out-of-order batch rows=%d err=%v, want it stored", stored, err)
	}

	latest, err := store.LatestPerZone(ctx)
	if err != nil {
		t.Fatal(err)
	}
	effective, ok := findZoneBatch(latest, zone)
	if !ok {
		t.Fatalf("the newest-per-zone read has no element for %q", zone)
	}
	if effective.RiskLevel != string(classify.LevelAlto) || effective.ID != newestID {
		t.Fatalf("the effective level of %q is %s (batch %s), want the newer alto batch %s: an out-of-order request must not overwrite it", zone, effective.RiskLevel, effective.ID, newestID)
	}

	// The next transition compares against the effective level alto, not against
	// the stale bajo that arrived after it.
	_, nextID := publishTestBatch(ctx, t, store, zone, base.Add(time.Second), string(classify.LevelMedio))
	next, ok := alertsOfBatches(ctx, t, db, []string{nextID})[nextID]
	if !ok || next.PreviousLevel != string(classify.LevelAlto) || next.NewLevel != string(classify.LevelMedio) {
		t.Fatalf("the transition after the out-of-order batch was recorded as %+v, want alto -> medio", next)
	}
}

func findZoneBatch(batches []Batch, zone string) (Batch, bool) {
	for _, batch := range batches {
		if batch.ZoneID == zone {
			return batch, true
		}
	}
	return Batch{}, false
}

// TestPublicationRetriesStoreOneBatchAndOneAlert exercises the retry shapes the
// publication seam already meets: a broker redelivery carrying the same event id,
// an operator re-dispatch carrying a fresh event id for the same job, and a
// repeated scheduled delivery. Each must leave exactly one batch and one alert,
// and the scheduled path must record the alert without emitting a completion.
func TestPublicationRetriesStoreOneBatchAndOneAlert(t *testing.T) {
	ctx, db := alertTestPool(t)
	store := Store{DB: db}
	const zone = "valparaiso-demo"
	base := instantNewerThanEveryStoredBatch(ctx, t, db, zone)

	// A known starting level keeps the assertions independent of what the shared
	// database already held for the zone.
	publishTestBatch(ctx, t, store, zone, base, string(classify.LevelMedio))

	explicit := v1.Event{ID: uuid.NewString(), JobID: uuid.NewString(), TraceID: uuid.NewString(), ActorID: "operator", Type: v1.JobRequestedType, ZoneID: zone, RequestedAt: base.Add(time.Second)}
	assessment := Assessment{ModelVersion: classify.AcademicRuleV1ID, RiskLevel: string(classify.LevelAlto), Factors: []classify.Factor{}, Rationale: "retry fixture"}
	for attempt := 0; attempt < 2; attempt++ {
		if err := store.Publish(ctx, explicit, assessment); err != nil {
			t.Fatalf("publish attempt %d: %v", attempt+1, err)
		}
	}
	redispatch := explicit
	redispatch.ID = uuid.NewString()
	if err := store.Publish(ctx, redispatch, assessment); err != nil {
		t.Fatalf("re-dispatch the stored job: %v", err)
	}
	scheduled := v1.Event{ID: uuid.NewString(), JobID: uuid.NewString(), TraceID: uuid.NewString(), ActorID: "cycle-scheduler", Type: v1.JobRequestedType, ZoneID: zone, RequestedAt: base.Add(2 * time.Second)}
	scheduledAssessment := Assessment{ModelVersion: classify.AcademicRuleV1ID, RiskLevel: string(classify.LevelMedio), Factors: []classify.Factor{}, Rationale: "scheduled retry fixture"}
	for attempt := 0; attempt < 2; attempt++ {
		if err := store.PublishScheduled(ctx, scheduled, scheduledAssessment); err != nil {
			t.Fatalf("scheduled attempt %d: %v", attempt+1, err)
		}
	}

	var batches int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM batches WHERE job_id=$1`, explicit.JobID).Scan(&batches); err != nil || batches != 1 {
		t.Fatalf("batches of the retried job=%d err=%v, want exactly 1", batches, err)
	}
	if err := db.QueryRow(ctx, `SELECT count(*) FROM batches WHERE job_id=$1`, scheduled.JobID).Scan(&batches); err != nil || batches != 1 {
		t.Fatalf("batches of the retried scheduled job=%d err=%v, want exactly 1", batches, err)
	}
	var explicitBatchID, scheduledBatchID string
	if err := db.QueryRow(ctx, `SELECT id::text FROM batches WHERE job_id=$1`, explicit.JobID).Scan(&explicitBatchID); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(ctx, `SELECT id::text FROM batches WHERE job_id=$1`, scheduled.JobID).Scan(&scheduledBatchID); err != nil {
		t.Fatal(err)
	}
	alerts := alertsOfBatches(ctx, t, db, []string{explicitBatchID, scheduledBatchID})
	if len(alerts) != 2 {
		t.Fatalf("the retried publications stored %d alerts, want one per stored batch (2)", len(alerts))
	}
	explicitAlert := alerts[explicitBatchID]
	if explicitAlert.PreviousLevel != string(classify.LevelMedio) || explicitAlert.NewLevel != string(classify.LevelAlto) {
		t.Fatalf("the explicit transition survived as %+v, want medio -> alto", explicitAlert)
	}
	scheduledAlert := alerts[scheduledBatchID]
	if scheduledAlert.PreviousLevel != string(classify.LevelAlto) || scheduledAlert.NewLevel != string(classify.LevelMedio) {
		t.Fatalf("the scheduled transition survived as %+v, want alto -> medio", scheduledAlert)
	}
	var completions int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM outbox WHERE routing_key=$1 AND payload->>'job_id'=$2`, v1.BatchPublishedType, scheduled.JobID).Scan(&completions); err != nil || completions != 0 {
		t.Fatalf("scheduled completions=%d err=%v, want 0", completions, err)
	}
}

// TestConcurrentPublicationsOfOneZoneSerialiseTheTransition is the concurrency
// evidence S2's per-zone rule needs. The test seeds the predecessor both
// publications start from, so neither the lock order nor what an earlier test left
// in the shared database can make the expectation ambiguous. Two publications for
// the same zone then run at the same time with different instants, and exactly one
// of the two valid orders can appear:
//
//   - the older publication commits first, so both transitions are recorded
//     (seeded bajo -> alto, then alto -> medio);
//   - the newer publication commits first, so the older one is already history
//     when it arrives and only bajo -> medio is recorded.
//
// Without the per-zone serialization both transactions read the seeded bajo and
// write two alerts that start from it, which is the duplicate-predecessor chain
// these assertions refuse.
func TestConcurrentPublicationsOfOneZoneSerialiseTheTransition(t *testing.T) {
	ctx, db := alertTestPool(t)
	store := Store{DB: db}
	const zone = "valparaiso-demo"
	base := instantNewerThanEveryStoredBatch(ctx, t, db, zone)

	// The predecessor is created and committed by this test before either goroutine
	// starts, so both lock orders begin from a known level.
	publishTestBatch(ctx, t, store, zone, base, string(classify.LevelBajo))

	older := v1.Event{ID: uuid.NewString(), JobID: uuid.NewString(), TraceID: uuid.NewString(), ActorID: "cycle-scheduler", Type: v1.JobRequestedType, ZoneID: zone, RequestedAt: base.Add(time.Second)}
	newer := v1.Event{ID: uuid.NewString(), JobID: uuid.NewString(), TraceID: uuid.NewString(), ActorID: "cycle-scheduler", Type: v1.JobRequestedType, ZoneID: zone, RequestedAt: base.Add(2 * time.Second)}
	olderAssessment := Assessment{ModelVersion: classify.AcademicRuleV1ID, RiskLevel: string(classify.LevelAlto), Factors: []classify.Factor{}, Rationale: "concurrent fixture"}
	newerAssessment := Assessment{ModelVersion: classify.AcademicRuleV1ID, RiskLevel: string(classify.LevelMedio), Factors: []classify.Factor{}, Rationale: "concurrent fixture"}

	// The two publications are started without waiting for one another and report
	// their outcome on a buffered channel: the retry shape must be genuinely
	// concurrent, and no shared slice is written from two goroutines.
	results := make(chan error, 2)
	go func() {
		results <- store.PublishScheduled(ctx, older, olderAssessment)
	}()
	go func() {
		results <- store.PublishScheduled(ctx, newer, newerAssessment)
	}()
	for index := 0; index < 2; index++ {
		if failure := <-results; failure != nil {
			t.Fatalf("concurrent publication %d: %v", index, failure)
		}
	}

	var olderBatchID, newerBatchID string
	if err := db.QueryRow(ctx, `SELECT id::text FROM batches WHERE job_id=$1`, older.JobID).Scan(&olderBatchID); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(ctx, `SELECT id::text FROM batches WHERE job_id=$1`, newer.JobID).Scan(&newerBatchID); err != nil {
		t.Fatal(err)
	}
	alerts := alertsOfBatches(ctx, t, db, []string{olderBatchID, newerBatchID})
	olderAlert, olderAlerted := alerts[olderBatchID]
	newerAlert, newerAlerted := alerts[newerBatchID]

	// The newer batch is the last transition in both orders, so it always alerts:
	// its predecessor is the seeded bajo or the older alto, and it moved from both.
	if !newerAlerted {
		t.Fatalf("the newest batch of the pair (%s at %s) stored no alert; it changed from the seeded bajo or from the older alto", classify.LevelMedio, newer.RequestedAt)
	}
	if olderAlerted {
		if olderAlert.PreviousLevel != string(classify.LevelBajo) || olderAlert.NewLevel != string(classify.LevelAlto) {
			t.Fatalf("the older concurrent batch recorded %s -> %s, want the seeded bajo -> alto", olderAlert.PreviousLevel, olderAlert.NewLevel)
		}
		// The older batch was the effective level when the newer one was assessed,
		// so the chain continues from alto. A second alert starting from bajo here
		// is the duplicate-predecessor pair a missing per-zone serialization writes.
		if newerAlert.PreviousLevel != string(classify.LevelAlto) || newerAlert.NewLevel != string(classify.LevelMedio) {
			t.Fatalf("the newer concurrent batch recorded %s -> %s after the older one alerted, want alto -> medio", newerAlert.PreviousLevel, newerAlert.NewLevel)
		}
		return
	}
	// The newer publication reached the zone first: the older one is history and
	// must stay silent, so the only recorded transition starts at the seeded bajo.
	if newerAlert.PreviousLevel != string(classify.LevelBajo) || newerAlert.NewLevel != string(classify.LevelMedio) {
		t.Fatalf("the newer concurrent batch recorded %s -> %s while the older one was already history, want bajo -> medio", newerAlert.PreviousLevel, newerAlert.NewLevel)
	}
}

// TestEqualTimestampsFollowTheNewestPerZoneTieBreak covers two assessments stored
// with the same requested_at. The newest-per-zone rule orders by requested_at
// descending and then by the batch identifier, so exactly one of the two is the
// effective level; the stored alerts must agree with that selection instead of
// inventing a transition for the batch the reads already call history.
//
// Both outcomes are deterministic and both are checked. When the second batch wins
// the tie-break it superseded the first one, so both transitions happened; when the
// first wins, the second changes nothing.
func TestEqualTimestampsFollowTheNewestPerZoneTieBreak(t *testing.T) {
	ctx, db := alertTestPool(t)
	store := Store{DB: db}
	const zone = "valparaiso-demo"
	base := instantNewerThanEveryStoredBatch(ctx, t, db, zone)
	publishTestBatch(ctx, t, store, zone, base, string(classify.LevelBajo))

	instant := base.Add(time.Second)
	_, firstID := publishTestBatch(ctx, t, store, zone, instant, string(classify.LevelAlto))
	_, secondID := publishTestBatch(ctx, t, store, zone, instant, string(classify.LevelMedio))
	winnerID := newestByTieBreak(firstID, secondID)

	latest, err := store.LatestPerZone(ctx)
	if err != nil {
		t.Fatal(err)
	}
	effective, ok := findZoneBatch(latest, zone)
	if !ok || effective.ID != winnerID {
		t.Fatalf("the effective batch of %q is %+v, want the tie-break winner %s", zone, effective, winnerID)
	}

	alerts := alertsOfBatches(ctx, t, db, []string{firstID, secondID})
	firstAlert, firstAlerted := alerts[firstID]
	if !firstAlerted || firstAlert.PreviousLevel != string(classify.LevelBajo) || firstAlert.NewLevel != string(classify.LevelAlto) {
		t.Fatalf("the first batch at the shared instant recorded %+v (alert=%t), want bajo -> alto", firstAlert, firstAlerted)
	}
	secondAlert, secondAlerted := alerts[secondID]
	if winnerID == secondID {
		// The second insert won the tie-break, so the first batch was the effective
		// level until it arrived and both transitions happened.
		if effective.RiskLevel != string(classify.LevelMedio) {
			t.Fatalf("the tie-break winner's level is %q, want the second batch's medio", effective.RiskLevel)
		}
		if !secondAlerted || secondAlert.PreviousLevel != string(classify.LevelAlto) || secondAlert.NewLevel != string(classify.LevelMedio) {
			t.Fatalf("the second batch won the tie-break and recorded %+v (alert=%t), want alto -> medio", secondAlert, secondAlerted)
		}
		return
	}
	// The first insert won the tie-break, so the second batch is history at the same
	// instant and the level it carries never became the effective one.
	if effective.RiskLevel != string(classify.LevelAlto) {
		t.Fatalf("the tie-break winner's level is %q, want the first batch's alto", effective.RiskLevel)
	}
	if secondAlerted {
		t.Fatalf("the second batch lost the tie-break and still recorded %s -> %s", secondAlert.PreviousLevel, secondAlert.NewLevel)
	}
}

// TestRollbackAfterTheAlertIsWrittenRemovesBothRows observes the order the
// publication transaction relies on, using session-local scaffolding only: a
// temporary table shadows outbox in this connection (the technique
// TestListRefusesMissingCommuneGeometry uses for zones), and a temporary trigger
// fails the outbox insert while reporting whether the alert for that batch was
// already written.
//
// The trigger's message is the observation: on this path the alert insert must
// already have run, and the failure that follows must roll the batch, the alert and
// the inbox row back together. The same transition published through the scheduled
// seam, which writes no outbox row, then stores its alert - so the difference is
// the failed later side effect and never the transition policy.
func TestRollbackAfterTheAlertIsWrittenRemovesBothRows(t *testing.T) {
	// One connection, because the shadow and its trigger exist in this session only.
	ctx, db := alertTestPoolWith(t, func(config *pgxpool.Config) { config.MaxConns = 1 })
	store := Store{DB: db}
	const zone = "valparaiso-demo"
	base := instantNewerThanEveryStoredBatch(ctx, t, db, zone)

	// The predecessor is committed first, through the scheduled seam, because the
	// shadow below makes every outbox write fail on this connection.
	seed := v1.Event{ID: uuid.NewString(), JobID: uuid.NewString(), TraceID: uuid.NewString(), ActorID: "cycle-scheduler", Type: v1.JobRequestedType, ZoneID: zone, RequestedAt: base}
	if err := store.PublishScheduled(ctx, seed, Assessment{ModelVersion: classify.AcademicRuleV1ID, RiskLevel: string(classify.LevelBajo), Factors: []classify.Factor{}, Rationale: "rollback fixture"}); err != nil {
		t.Fatalf("seed the predecessor: %v", err)
	}
	shadowOutboxWithAlertProbe(ctx, t, db)

	refused := v1.Event{ID: uuid.NewString(), JobID: uuid.NewString(), TraceID: uuid.NewString(), ActorID: "operator", Type: v1.JobRequestedType, ZoneID: zone, RequestedAt: base.Add(time.Second)}
	err := store.Publish(ctx, refused, Assessment{ModelVersion: classify.AcademicRuleV1ID, RiskLevel: string(classify.LevelAlto), Factors: []classify.Factor{}, Rationale: "rollback fixture"})
	if err == nil || !strings.Contains(err.Error(), "outbox failure after the alert was written") {
		t.Fatalf("publish error = %v, want the outbox failure that observed the written alert", err)
	}

	// The failure happened after the alert insert and rolled the whole transaction
	// back: batch, alert and inbox row are gone together, so the delivery stays
	// retryable and nothing claims a transition that was never stored.
	var batches, alerts, inbox int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM batches WHERE job_id=$1`, refused.JobID).Scan(&batches); err != nil || batches != 0 {
		t.Fatalf("the rolled-back publication left %d batches (err=%v), want 0", batches, err)
	}
	if err := db.QueryRow(ctx, `SELECT count(*) FROM risk_alerts WHERE zone_id=$1 AND occurred_at=$2`, zone, refused.RequestedAt).Scan(&alerts); err != nil || alerts != 0 {
		t.Fatalf("the rolled-back publication left %d alerts (err=%v), want 0", alerts, err)
	}
	if err := db.QueryRow(ctx, `SELECT count(*) FROM inbox WHERE id=$1`, refused.ID).Scan(&inbox); err != nil || inbox != 0 {
		t.Fatalf("the rolled-back publication left %d inbox rows (err=%v), want 0", inbox, err)
	}

	// The same transition, committed through the seam that writes no outbox row,
	// stores the alert it must: the transition policy was never the reason the
	// publication above failed.
	committed := refused
	committed.ID = uuid.NewString()
	committed.JobID = uuid.NewString()
	committed.RequestedAt = base.Add(2 * time.Second)
	if err := store.PublishScheduled(ctx, committed, Assessment{ModelVersion: classify.AcademicRuleV1ID, RiskLevel: string(classify.LevelAlto), Factors: []classify.Factor{}, Rationale: "rollback fixture"}); err != nil {
		t.Fatalf("publish the same transition without an outbox write: %v", err)
	}
	var committedBatchID string
	if err := db.QueryRow(ctx, `SELECT id::text FROM batches WHERE job_id=$1`, committed.JobID).Scan(&committedBatchID); err != nil {
		t.Fatal(err)
	}
	committedAlert, alerted := alertsOfBatches(ctx, t, db, []string{committedBatchID})[committedBatchID]
	if !alerted || committedAlert.PreviousLevel != string(classify.LevelBajo) || committedAlert.NewLevel != string(classify.LevelAlto) {
		t.Fatalf("the committed transition recorded %+v (alert=%t), want bajo -> alto", committedAlert, alerted)
	}
}

// shadowOutboxWithAlertProbe makes the outbox write of an explicit publication
// fail after the alert has been written, and reports through the failure itself
// whether the alert was already there.
//
// It is session-local scaffolding: a temporary table shadows outbox (pg_temp is
// searched before public, so the store's unqualified INSERT INTO outbox reaches it
// on this connection only), and a temporary BEFORE INSERT trigger raises instead of
// storing. The shadow is created before this session executes any outbox write, so
// that statement is parsed against it and not against a cached plan for the real
// table. The trigger's two messages are the observation - the one the test accepts
// means the alert insert had already run, and the other would mean the publication
// reached its outbox before the alert. Nothing shared is altered, and both objects
// disappear with the session.
func shadowOutboxWithAlertProbe(ctx context.Context, t *testing.T, db *pgxpool.Pool) {
	t.Helper()
	if _, err := db.Exec(ctx, `CREATE TEMP TABLE outbox (
		id uuid PRIMARY KEY,
		routing_key text NOT NULL,
		payload jsonb NOT NULL,
		created_at timestamptz NOT NULL DEFAULT now(),
		published_at timestamptz
	)`); err != nil {
		t.Fatalf("create the session-local outbox shadow: %v", err)
	}
	if _, err := db.Exec(ctx, `CREATE FUNCTION pg_temp.outbox_after_alert() RETURNS trigger LANGUAGE plpgsql AS $probe$
BEGIN
	IF EXISTS (SELECT 1 FROM risk_alerts WHERE batch_id = (NEW.payload->>'batch_id')::uuid) THEN
		RAISE EXCEPTION 'outbox failure after the alert was written';
	END IF;
	RAISE EXCEPTION 'the outbox insert ran before the alert was written';
END
$probe$`); err != nil {
		t.Fatalf("create the probe function: %v", err)
	}
	if _, err := db.Exec(ctx, `CREATE TRIGGER outbox_after_alert BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION pg_temp.outbox_after_alert()`); err != nil {
		t.Fatalf("create the probe trigger: %v", err)
	}
}

// TestFailedPublishStoresNoAlert is the atomicity half the error path can observe:
// a publication the database refuses (an unregistered model version) must leave
// neither a batch nor an alert behind, because both are written in the one
// transaction. The successful direction is structural - the alert insert runs
// inside the same transaction as the batch insert - and this is the observable
// consequence.
func TestFailedPublishStoresNoAlert(t *testing.T) {
	ctx, db := alertTestPool(t)
	store := Store{DB: db}
	const zone = "valparaiso-demo"
	base := instantNewerThanEveryStoredBatch(ctx, t, db, zone)
	publishTestBatch(ctx, t, store, zone, base, string(classify.LevelMedio))

	refused := v1.Event{ID: uuid.NewString(), JobID: uuid.NewString(), TraceID: uuid.NewString(), ActorID: "test", Type: v1.JobRequestedType, ZoneID: zone, RequestedAt: base.Add(time.Second)}
	err := store.Publish(ctx, refused, Assessment{ModelVersion: "unregistered-model-version", RiskLevel: string(classify.LevelAlto), Factors: []classify.Factor{}})
	if err == nil {
		t.Fatal("a publication naming an unregistered model version was accepted")
	}
	var batches int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM batches WHERE job_id=$1`, refused.JobID).Scan(&batches); err != nil || batches != 0 {
		t.Fatalf("the refused publication stored %d batches (err=%v)", batches, err)
	}
	var alerts int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM risk_alerts WHERE zone_id=$1 AND occurred_at=$2`, zone, refused.RequestedAt).Scan(&alerts); err != nil || alerts != 0 {
		t.Fatalf("the refused publication stored %d alerts (err=%v), want 0", alerts, err)
	}
}
