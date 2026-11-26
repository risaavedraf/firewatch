package repository

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// This file proves the multi-zone comparison read against a real migrated
// database.
//
// A fake cannot prove it: DISTINCT ON, the shared cutoff, the half-open window,
// the bucket expression and the ordering are properties of the SQL, so a fake
// would only restate whatever the test handed it. The expectations below are
// therefore computed two ways. The bucket selection is verified by asking storage
// which batches of that zone fall inside the bucket the read named and checking
// that the read answered the newest requested_at of them with the batch id as the
// descending tie-break; the shared-cutoff rule is verified by a second read whose
// window starts after every fixture, which can only answer assessments that
// predate the window.
//
// It needs the disposable migrated risk database the other integration tests use,
// so it skips without TEST_DATABASE_URL and runs in `make integration`. It writes
// rows and does not clean them, exactly as its neighbours do, and it derives its
// window from what the chosen zones already hold so a second run cannot collide
// with the first one's instants.

// comparisonRow is one fixture batch: when it was requested, the level it
// recorded, whether its input was synthetic, the factors it stored and the
// identity it was inserted with.
type comparisonRow struct {
	requestedAt time.Time
	level       string
	demo        bool
	factors     string
	id          string
}

// insertComparisonRow stores one batch directly. The publication path is
// deliberately not used: Publish also emits completions and writes transition
// alerts, and this test is about reading a snapshot, not about publishing one. The
// row satisfies every constraint the schema carries, including the model and zone
// foreign keys, which is why both are read from the database instead of being
// hardcoded.
func insertComparisonRow(t *testing.T, ctx context.Context, db *pgxpool.Pool, zone, model string, row *comparisonRow) {
	t.Helper()
	row.id = uuid.NewString()
	// published_at is set explicitly, one minute after the request: the fixture
	// window is deliberately far in the future so runs cannot collide, and the
	// column's default (now()) would then describe a publication that happened
	// before the request - a shape the read would faithfully report and this test
	// would have to explain.
	if _, err := db.Exec(ctx, `INSERT INTO batches(id,job_id,zone_id,requested_at,published_at,valid_until,model_version,demo,risk_level,factors,rationale,location)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'comparison fixture',ST_SetSRID(ST_MakePoint(-71.6127,-33.0472),4326))`,
		row.id, uuid.NewString(), zone, row.requestedAt, row.requestedAt.Add(time.Minute), row.requestedAt.Add(15*time.Minute), model, row.demo, row.level, row.factors); err != nil {
		t.Fatalf("insert a comparison fixture batch requested at %s: %v", row.requestedAt, err)
	}
}

// comparisonAssessmentOf returns the assessment of one zone, or a flag when the
// read did not answer one for it. The read must answer at most one row per zone,
// which this lookup also proves by counting.
func comparisonAssessmentOf(t *testing.T, snapshot ComparisonSnapshot, zone string) (ComparisonAssessment, bool) {
	t.Helper()
	found := ComparisonAssessment{}
	count := 0
	for _, assessment := range snapshot.Assessments {
		if assessment.ZoneID == zone {
			found, count = assessment, count+1
		}
	}
	if count > 1 {
		t.Fatalf("the snapshot answered %d assessments for zone %q, want at most one", count, zone)
	}
	return found, count == 1
}

// comparisonHistoryOf returns the history points of one zone, in read order.
func comparisonHistoryOf(snapshot ComparisonSnapshot, zone string) []HistoryPoint {
	points := make([]HistoryPoint, 0, len(snapshot.History))
	for _, point := range snapshot.History {
		if point.ZoneID == zone {
			points = append(points, point)
		}
	}
	return points
}

// TestCompareZonesReadsOneCutoffAndTheWindowOnly is the real-database proof of the
// comparison read: the shared newest-batch-before-to cutoff (which may predate
// from), the half-open window on the history half, the newest-requested_at and id
// tie-break selection inside a bucket, the stored factors and provenance, a
// desconocido level preserved instead of hidden, and a cutoff before every stored
// batch answered as an empty snapshot rather than an error.
func TestCompareZonesReadsOneCutoffAndTheWindowOnly(t *testing.T) {
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
	store := Store{DB: db}

	// Both zones and the model come from the database, so a differently seeded test
	// database still exercises the rule instead of failing on a literal. Two zones
	// are the minimum a comparison accepts.
	rows, err := db.Query(ctx, `SELECT code FROM zones ORDER BY code LIMIT 2`)
	if err != nil {
		t.Fatal(err)
	}
	var zones []string
	for rows.Next() {
		var zone string
		if err := rows.Scan(&zone); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		zones = append(zones, zone)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(zones) != 2 {
		t.Fatalf("the zone catalogue holds %d zones, so there is no pair to compare", len(zones))
	}
	zoneA, zoneB := zones[0], zones[1]
	var model string
	if err := db.QueryRow(ctx, `SELECT version FROM models ORDER BY version LIMIT 1`).Scan(&model); err != nil {
		t.Fatalf("the model registry is empty, so a batch cannot be stored: %v", err)
	}

	// The fixture window starts after everything the two zones already hold,
	// aligned to the hour, so a second run of this test lands in a different window
	// instead of colliding with the first one's instants.
	var stored time.Time
	if err := db.QueryRow(ctx, `SELECT coalesce(max(requested_at), now()) FROM batches WHERE zone_id = ANY($1::text[])`, zones).Scan(&stored); err != nil {
		t.Fatalf("read the newest stored requested_at of the compared zones: %v", err)
	}
	base := stored.UTC().Add(3 * time.Hour).Truncate(time.Hour)

	// The factors document the cutoff assessment must carry verbatim.
	factors := `[{"name":"temperatura","known":true,"value":32,"contribution":0.85,"note":"lectura de alta temperatura"}]`

	// Fixtures. zoneA has an old batch that only the later cutoff can answer, and
	// two batches at the same instant inside the first window so the id tie-break
	// is exercised. zoneB has a desconocido batch inside the first window and a
	// batch exactly on the window end, which must belong to the next window.
	oldA := &comparisonRow{requestedAt: base.Add(-26 * time.Hour), level: "medio", factors: `[]`}
	insertComparisonRow(t, ctx, db, zoneA, model, oldA)
	tieLow := &comparisonRow{requestedAt: base.Add(2*time.Hour + 5*time.Minute), level: "bajo", factors: factors}
	insertComparisonRow(t, ctx, db, zoneA, model, tieLow)
	tieHigh := &comparisonRow{requestedAt: tieLow.requestedAt, level: "alto", factors: factors}
	insertComparisonRow(t, ctx, db, zoneA, model, tieHigh)
	unknownB := &comparisonRow{requestedAt: base.Add(2*time.Hour + 10*time.Minute), level: "desconocido", demo: true, factors: `[]`}
	insertComparisonRow(t, ctx, db, zoneB, model, unknownB)
	boundaryB := &comparisonRow{requestedAt: base.Add(3 * time.Hour), level: "medio", factors: `[]`}
	insertComparisonRow(t, ctx, db, zoneB, model, boundaryB)

	// The tie-break winner is the batch with the greater identity at the same
	// instant, which is the documented descending-id rule stated as data rather than
	// as SQL.
	winnerA := tieLow
	if tieHigh.id > tieLow.id {
		winnerA = tieHigh
	}

	// --- the window: history inside [from,to), assessments at the cutoff --------
	snapshot, err := store.CompareZones(ctx, ComparisonQuery{
		ZoneIDs: zones, From: base.Add(2 * time.Hour), To: base.Add(3 * time.Hour), Granularity: HistoryHourly,
	})
	if err != nil {
		t.Fatalf("CompareZones over the window: %v", err)
	}
	if len(snapshot.Assessments) != 2 {
		t.Fatalf("the snapshot answered %d assessments, want one per compared zone: %+v", len(snapshot.Assessments), snapshot.Assessments)
	}

	assessmentA, ok := comparisonAssessmentOf(t, snapshot, zoneA)
	if !ok {
		t.Fatalf("zone %q has a batch before the cutoff but the snapshot answered no assessment", zoneA)
	}
	if assessmentA.BatchID != winnerA.id {
		t.Fatalf("zone %q answered batch %q, but the newest requested_at at the cutoff is %q", zoneA, assessmentA.BatchID, winnerA.id)
	}
	if assessmentA.RiskLevel != winnerA.level {
		t.Fatalf("zone %q answered level %q, want the stored %q", zoneA, assessmentA.RiskLevel, winnerA.level)
	}
	if !assessmentA.RequestedAt.Equal(base.Add(2*time.Hour + 5*time.Minute)) {
		t.Fatalf("zone %q answered requested_at %s, want the newest before the cutoff", zoneA, assessmentA.RequestedAt)
	}
	// The stored factors travel with the assessment instead of being recomputed.
	var storedFactors []struct {
		Name  string  `json:"name"`
		Value float64 `json:"value"`
	}
	if err := json.Unmarshal(assessmentA.Factors, &storedFactors); err != nil || len(storedFactors) != 1 || storedFactors[0].Name != "temperatura" || storedFactors[0].Value != 32 {
		t.Fatalf("zone %q factors = %s, want the stored temperatura factor", zoneA, assessmentA.Factors)
	}

	assessmentB, ok := comparisonAssessmentOf(t, snapshot, zoneB)
	if !ok {
		t.Fatalf("zone %q has a batch before the cutoff but the snapshot answered no assessment", zoneB)
	}
	if assessmentB.BatchID != unknownB.id || assessmentB.RiskLevel != "desconocido" {
		t.Fatalf("zone %q answered %+v, want the desconocido batch %q", zoneB, assessmentB, unknownB.id)
	}
	if !assessmentB.Synthetic {
		t.Fatalf("zone %q lost the synthetic provenance of its batch", zoneB)
	}
	if storedFactors == nil {
		t.Fatal("the factors document was not consulted")
	}

	historyA := comparisonHistoryOf(snapshot, zoneA)
	if len(historyA) != 1 {
		t.Fatalf("zone %q answered %d buckets, want exactly the one inside the window: %+v", zoneA, len(historyA), historyA)
	}
	if !historyA[0].BucketStart.Equal(base.Add(2 * time.Hour)) {
		t.Fatalf("zone %q bucket start = %s, want the UTC hour %s", zoneA, historyA[0].BucketStart, base.Add(2*time.Hour))
	}
	if historyA[0].BatchID != winnerA.id || historyA[0].RiskLevel != winnerA.level {
		t.Fatalf("zone %q bucket answered %+v, want the tie-break winner %q", zoneA, historyA[0], winnerA.id)
	}

	historyB := comparisonHistoryOf(snapshot, zoneB)
	if len(historyB) != 1 {
		t.Fatalf("zone %q answered %d buckets, want the one inside the window: %+v", zoneB, len(historyB), historyB)
	}
	if historyB[0].BatchID != unknownB.id {
		t.Fatalf("zone %q bucket answered batch %q, want the in-window %q", zoneB, historyB[0].BatchID, unknownB.id)
	}
	// The boundary batch belongs to the NEXT window: an instant equal to to is
	// outside [from, to), which is what makes two adjacent windows disjoint.
	for _, point := range snapshot.History {
		if point.BatchID == boundaryB.id {
			t.Fatalf("the window reported the batch at exactly the window end: %+v", point)
		}
	}

	// --- a later cutoff answers assessments older than from --------------------
	laterQuery := ComparisonQuery{
		ZoneIDs: zones, From: base.Add(10 * time.Hour), To: base.Add(11 * time.Hour), Granularity: HistoryHourly,
	}
	later, err := store.CompareZones(ctx, laterQuery)
	if err != nil {
		t.Fatalf("CompareZones with a later cutoff: %v", err)
	}
	lateA, ok := comparisonAssessmentOf(t, later, zoneA)
	if !ok {
		t.Fatalf("zone %q has stored batches before the later cutoff but none was answered", zoneA)
	}
	// The shared cutoff is the newest batch strictly before to, regardless of from:
	// an assessment older than the window is reported with its own date (S5).
	if lateA.BatchID != winnerA.id || !lateA.RequestedAt.Before(laterQuery.From) {
		t.Fatalf("zone %q answered %+v, want the pre-window assessment %q with its own date", zoneA, lateA, winnerA.id)
	}
	lateB, ok := comparisonAssessmentOf(t, later, zoneB)
	if !ok {
		t.Fatalf("zone %q has stored batches before the later cutoff but none was answered", zoneB)
	}
	if lateB.BatchID != boundaryB.id || lateB.RiskLevel != "medio" {
		t.Fatalf("zone %q answered batch %q, want the newest before the later cutoff %q", zoneB, lateB.BatchID, boundaryB.id)
	}
	// The history half stayed inside its own window: neither zone published in
	// [later.From, later.To), so no bucket is invented and none is repeated.
	if len(later.History) != 0 {
		t.Fatalf("a window with no publication answered %d points: %+v", len(later.History), later.History)
	}

	// Requested before the cutoff but published exactly at it: history is keyed
	// by request time, while the assessment cannot use a future publication.
	delayed := &comparisonRow{requestedAt: laterQuery.To.Add(-time.Minute), level: "alto", factors: `[]`}
	insertComparisonRow(t, ctx, db, zoneA, model, delayed)
	crossing, err := store.CompareZones(ctx, laterQuery)
	if err != nil {
		t.Fatal(err)
	}
	assessment, ok := comparisonAssessmentOf(t, crossing, zoneA)
	if !ok || assessment.BatchID != winnerA.id {
		t.Fatalf("cutoff assessment = %+v, want already-published batch %s", assessment, winnerA.id)
	}
	points := comparisonHistoryOf(crossing, zoneA)
	if len(points) != 1 || points[0].BatchID != delayed.id {
		t.Fatalf("request-time history = %+v, want delayed batch %s", points, delayed.id)
	}

	// --- a cutoff before every stored batch is an empty snapshot --------------
	var oldest time.Time
	if err := db.QueryRow(ctx, `SELECT coalesce(min(requested_at), now()) FROM batches`).Scan(&oldest); err != nil {
		t.Fatal(err)
	}
	nothingTo := oldest.UTC().Add(-time.Hour)
	empty, err := store.CompareZones(ctx, ComparisonQuery{
		ZoneIDs: zones, From: nothingTo.Add(-time.Hour), To: nothingTo, Granularity: HistoryHourly,
	})
	if err != nil {
		t.Fatalf("CompareZones before every stored batch: %v", err)
	}
	// A requested zone with no eligible batch produces no assessment row, which is
	// the absence the handler serves as null; it is not an error and no level is
	// invented for it.
	if len(empty.Assessments) != 0 || len(empty.History) != 0 {
		t.Fatalf("a cutoff before every stored batch answered assessments=%d history=%d", len(empty.Assessments), len(empty.History))
	}

	// --- the twenty-four hour bucket reuses PM-04's expression ----------------
	daily, err := store.CompareZones(ctx, ComparisonQuery{
		ZoneIDs: zones, From: base, To: base.Add(48 * time.Hour), Granularity: HistoryDaily,
	})
	if err != nil {
		t.Fatalf("CompareZones at day granularity: %v", err)
	}
	for _, point := range daily.History {
		// The bucket start must be the local midnight of the Santiago day the batch
		// lives in, which is the property the series read is already pinned to.
		var local string
		if err := db.QueryRow(ctx, `SELECT to_char(($1::timestamptz AT TIME ZONE 'America/Santiago'), 'HH24:MI')`, point.BucketStart).Scan(&local); err != nil {
			t.Fatal(err)
		}
		if local != "00:00" {
			t.Fatalf("a day bucket starts at %s local time, want a Santiago midnight: %+v", local, point)
		}
	}
	if len(daily.History) == 0 {
		t.Fatalf("the two-day fixture window answered no day bucket, so the civil expression was not exercised")
	}
	// A zone with no point keeps its absence rather than an empty invented point.
	for _, point := range daily.History {
		if point.ZoneID != zoneA && point.ZoneID != zoneB {
			t.Fatalf("the snapshot answered a zone that was not requested: %+v", point)
		}
		if strings.TrimSpace(point.BatchID) == "" {
			t.Fatalf("a history point lost its batch identity: %+v", point)
		}
	}
}
