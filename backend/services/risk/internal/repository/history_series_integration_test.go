package repository

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// This file proves the granular series read against a real migrated database.
//
// A fake cannot prove it: DISTINCT ON, the bucket expression, the half-open window
// and the ordering are properties of the SQL, so a fake would only restate whatever
// the test handed it. The expectations below are therefore computed two ways. The
// buckets are verified as civil-calendar properties the database itself reports
// (the Santiago date of a bucket start must equal the Santiago date of the batch it
// reports, a weekly bucket must start on a Monday), and the selection rule is
// verified by asking storage for the rows inside the bucket the read named and
// checking the read answered the newest requested_at of them, with the batch id as
// the descending tie-break. Neither expectation restates the implementation: one
// states the requirement, the other asks the database the same question the
// contract states.
//
// It needs the disposable migrated risk database the other integration tests use,
// so it skips without TEST_DATABASE_URL and runs in `make integration`. It writes
// rows and does not clean them, exactly as its neighbours do, and it derives its
// window from what that zone already holds so a second run cannot collide with the
// first one's instants.

// seriesNextBucketSQL is the calendar arithmetic of "the instant the next bucket
// begins", expressed by the database rather than by this test. For hour it is one
// hour, which is also the UTC-aligned bucket of the read; for day and week it is
// one civil day or seven civil days in America/Santiago, so a daylight-saving
// change inside the bucket cannot make the check off by an hour.
var seriesNextBucketSQL = map[HistoryGranularity]string{
	HistoryHourly: `($1::timestamptz + interval '1 hour')`,
	HistoryDaily:  `((($1::timestamptz AT TIME ZONE 'America/Santiago') + interval '1 day') AT TIME ZONE 'America/Santiago')`,
	HistoryWeekly: `((($1::timestamptz AT TIME ZONE 'America/Santiago') + interval '7 days') AT TIME ZONE 'America/Santiago')`,
}

// seriesRow is one fixture batch: when it was requested, the level it recorded and
// whether its input was synthetic.
type seriesRow struct {
	requestedAt time.Time
	level       string
	demo        bool
	id          string
}

// insertSeriesRow stores one batch directly. The publication path is deliberately
// not used: Publish also emits completions and writes transition alerts, and this
// test is about reading a window, not about publishing one. The row satisfies every
// constraint the schema carries, including the model and zone foreign keys, which is
// why both are read from the database instead of being hardcoded.
func insertSeriesRow(t *testing.T, ctx context.Context, db *pgxpool.Pool, zone, model string, row *seriesRow) {
	t.Helper()
	row.id = uuid.NewString()
	// published_at is set explicitly, one minute after the request: the fixture window
	// is deliberately far in the future so runs cannot collide, and the column's
	// default (now()) would then describe a publication that happened before the
	// request - a shape the read would faithfully report and this test would have to
	// explain.
	if _, err := db.Exec(ctx, `INSERT INTO batches(id,job_id,zone_id,requested_at,published_at,valid_until,model_version,demo,risk_level,factors,rationale,location)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'[]'::jsonb,'granular series fixture',ST_SetSRID(ST_MakePoint(-71.6127,-33.0472),4326))`,
		row.id, uuid.NewString(), zone, row.requestedAt, row.requestedAt.Add(time.Minute), row.requestedAt.Add(15*time.Minute), model, row.demo, row.level); err != nil {
		t.Fatalf("insert a fixture batch requested at %s: %v", row.requestedAt, err)
	}
}

// assertLatestInBucket verifies one point against the selection rule the contract
// states: among the batches of that zone inside [bucket_start, next bucket start),
// the point must be the one with the newest requested_at, and the batch id must break
// a tie. It also checks that the point copied the level and the demo flag of that
// batch instead of deriving them.
func assertLatestInBucket(t *testing.T, ctx context.Context, db *pgxpool.Pool, granularity HistoryGranularity, point HistoryPoint) {
	t.Helper()
	var nextStart time.Time
	if err := db.QueryRow(ctx, `SELECT `+seriesNextBucketSQL[granularity], point.BucketStart).Scan(&nextStart); err != nil {
		t.Fatalf("compute the next %s bucket after %s: %v", granularity, point.BucketStart, err)
	}
	rows, err := db.Query(ctx, `SELECT id::text, requested_at, risk_level, demo FROM batches
		WHERE zone_id=$1 AND requested_at >= $2 AND requested_at < $3`, point.ZoneID, point.BucketStart, nextStart)
	if err != nil {
		t.Fatalf("read the batches of zone %q inside [%s,%s): %v", point.ZoneID, point.BucketStart, nextStart, err)
	}
	defer rows.Close()
	var winner seriesRow
	found := false
	for rows.Next() {
		var candidate seriesRow
		if err := rows.Scan(&candidate.id, &candidate.requestedAt, &candidate.level, &candidate.demo); err != nil {
			t.Fatalf("scan a candidate batch: %v", err)
		}
		if !found || candidate.requestedAt.After(winner.requestedAt) || (candidate.requestedAt.Equal(winner.requestedAt) && candidate.id > winner.id) {
			winner, found = candidate, true
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate the candidate batches: %v", err)
	}
	if !found {
		t.Fatalf("zone %q answered bucket %s but storage holds no batch in [%s,%s)", point.ZoneID, point.BucketStart, point.BucketStart, nextStart)
	}
	if point.BatchID != winner.id {
		t.Fatalf("zone %q bucket %s answered batch %q, but the newest requested_at in that bucket is %q", point.ZoneID, point.BucketStart, point.BatchID, winner.id)
	}
	if !point.RequestedAt.Equal(winner.requestedAt) {
		t.Fatalf("bucket %q reported requested_at %s, want the winning batch's %s", point.BucketStart, point.RequestedAt, winner.requestedAt)
	}
	if point.RiskLevel != winner.level {
		t.Fatalf("bucket %s reported level %q, want the stored %q", point.BucketStart, point.RiskLevel, winner.level)
	}
	if point.Synthetic != winner.demo {
		t.Fatalf("bucket %s reported synthetic=%v, want the stored demo flag %v", point.BucketStart, point.Synthetic, winner.demo)
	}
	if point.PublishedAt.IsZero() || point.PublishedAt.Before(point.RequestedAt) {
		t.Fatalf("bucket %s published at %s, before it was requested at %s", point.BucketStart, point.PublishedAt, point.RequestedAt)
	}
}

// TestHistorySeriesAnswersOneLatestBatchPerZoneAndBucket is the real-database proof
// of the granular read: the half-open window, the civil-day and Monday week
// buckets, one point per zone and bucket, the newest-batch selection inside a
// bucket, a synthetic provenance copied from the row, a desconocido level preserved
// instead of hidden, an empty window answered as an empty collection, and a bound
// that follows from the window instead of from how much is stored.
func TestHistorySeriesAnswersOneLatestBatchPerZoneAndBucket(t *testing.T) {
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
	var indexApplied bool
	if err := db.QueryRow(ctx, `SELECT to_regclass('public.batches_requested_zone') IS NOT NULL`).Scan(&indexApplied); err != nil {
		t.Fatal(err)
	}
	if !indexApplied {
		t.Fatal("migration 018 did not create batches_requested_zone")
	}

	// The zone and the model come from the database, so a differently seeded test
	// database still exercises the rule instead of failing on a literal.
	var zone, model string
	if err := db.QueryRow(ctx, `SELECT code FROM zones ORDER BY code LIMIT 1`).Scan(&zone); err != nil {
		t.Fatalf("the zone catalogue is empty, so there is no zone to read: %v", err)
	}
	if err := db.QueryRow(ctx, `SELECT version FROM models ORDER BY version LIMIT 1`).Scan(&model); err != nil {
		t.Fatalf("the model registry is empty, so a batch cannot be stored: %v", err)
	}

	// The fixture window starts after everything this zone already holds, aligned to
	// the hour, so a second run of this test lands in a different window instead of
	// colliding with the first one's instants.
	var stored time.Time
	if err := db.QueryRow(ctx, `SELECT coalesce(max(requested_at), now()) FROM batches WHERE zone_id=$1`, zone).Scan(&stored); err != nil {
		t.Fatalf("read the newest stored requested_at of zone %q: %v", zone, err)
	}
	base := stored.UTC().Add(3 * time.Hour).Truncate(time.Hour)

	// The hourly fixture. Four batches fall in the first hour, two of them at the
	// same instant so the id tie-break is exercised; one falls exactly on the
	// boundary; one is the only batch of a later hour and records desconocido.
	rows := []*seriesRow{
		{requestedAt: base.Add(5 * time.Minute), level: "bajo"},
		{requestedAt: base.Add(30 * time.Minute), level: "medio"},
		{requestedAt: base.Add(50 * time.Minute), level: "alto", demo: true},
		{requestedAt: base.Add(50 * time.Minute), level: "medio"},
		{requestedAt: base.Add(time.Hour), level: "bajo"},
		{requestedAt: base.Add(3*time.Hour + 5*time.Minute), level: "desconocido"},
		{requestedAt: base.Add(26 * time.Hour), level: "medio"},
		{requestedAt: base.Add(50 * time.Hour), level: "bajo"},
	}
	for _, row := range rows {
		insertSeriesRow(t, ctx, db, zone, model, row)
	}

	// --- the half-open window, one hour at a time -----------------------------
	firstHour, err := store.HistorySeries(ctx, HistorySeriesQuery{
		From: base, To: base.Add(time.Hour), Granularity: HistoryHourly, ZoneID: zone,
	})
	if err != nil {
		t.Fatalf("HistorySeries over the first hour: %v", err)
	}
	if len(firstHour) != 1 {
		t.Fatalf("the first hour answered %d points, want exactly one per zone and hour: %+v", len(firstHour), firstHour)
	}
	point := firstHour[0]
	if !point.BucketStart.Equal(base) {
		t.Fatalf("hourly bucket start = %s, want the UTC hour %s", point.BucketStart, base)
	}
	if !point.RequestedAt.Equal(base.Add(50 * time.Minute)) {
		t.Fatalf("the bucket reported requested_at %s, want the newest in it (%s)", point.RequestedAt, base.Add(50*time.Minute))
	}
	// The boundary batch belongs to the NEXT hour: an instant equal to to is outside
	// [from, to), which is what makes two adjacent windows disjoint.
	if point.RequestedAt.Equal(base.Add(time.Hour)) || point.RequestedAt.After(base.Add(time.Hour)) {
		t.Fatalf("the bucket reported a batch at or after the window end: %s", point.RequestedAt)
	}
	assertLatestInBucket(t, ctx, db, HistoryHourly, point)

	secondHour, err := store.HistorySeries(ctx, HistorySeriesQuery{
		From: base.Add(time.Hour), To: base.Add(2 * time.Hour), Granularity: HistoryHourly, ZoneID: zone,
	})
	if err != nil {
		t.Fatalf("HistorySeries over the second hour: %v", err)
	}
	if len(secondHour) != 1 || !secondHour[0].RequestedAt.Equal(base.Add(time.Hour)) {
		t.Fatalf("the boundary batch is not the only point of the next hour: %+v", secondHour)
	}

	// --- desconocido is the recorded answer, not a gap ------------------------
	unknownHour, err := store.HistorySeries(ctx, HistorySeriesQuery{
		From: base.Add(3 * time.Hour), To: base.Add(4 * time.Hour), Granularity: HistoryHourly, ZoneID: zone,
	})
	if err != nil {
		t.Fatalf("HistorySeries over the desconocido hour: %v", err)
	}
	if len(unknownHour) != 1 || unknownHour[0].RiskLevel != "desconocido" {
		t.Fatalf("a bucket whose newest batch recorded desconocido answered %+v; the recorded level is shown, never hidden", unknownHour)
	}
	if unknownHour[0].Synthetic {
		t.Fatalf("a real-input bucket was reported as synthetic: %+v", unknownHour[0])
	}

	// --- a window with no publication is an empty collection ------------------
	empty, err := store.HistorySeries(ctx, HistorySeriesQuery{
		From: base.Add(400 * time.Hour), To: base.Add(401 * time.Hour), Granularity: HistoryHourly, ZoneID: zone,
	})
	if err != nil {
		t.Fatalf("HistorySeries over an empty window: %v", err)
	}
	if len(empty) != 0 {
		t.Fatalf("an empty window answered %d points: %+v", len(empty), empty)
	}

	// --- civil days and Monday weeks ------------------------------------------
	for _, granularity := range []HistoryGranularity{HistoryDaily, HistoryWeekly} {
		t.Run(string(granularity), func(t *testing.T) {
			points, err := store.HistorySeries(ctx, HistorySeriesQuery{
				From: base, To: base.Add(72 * time.Hour), Granularity: granularity, ZoneID: zone,
			})
			if err != nil {
				t.Fatalf("HistorySeries at %s granularity: %v", granularity, err)
			}
			if len(points) == 0 {
				t.Fatal("the fixture window answered no bucket")
			}
			// How many civil days or ISO weeks the zone's stored rows span, asked of
			// the database: the read must answer exactly one bucket per one of them,
			// so neither a missing bucket nor a duplicated one can pass.
			var spans int
			unit := "day"
			if granularity == HistoryWeekly {
				unit = "week"
			}
			if err := db.QueryRow(ctx, `SELECT count(DISTINCT date_trunc('`+unit+`', requested_at AT TIME ZONE 'America/Santiago')) FROM batches
				WHERE zone_id=$1 AND requested_at >= $2 AND requested_at < $3`, zone, base, base.Add(72*time.Hour)).Scan(&spans); err != nil {
				t.Fatalf("count the civil %ss the fixture spans: %v", unit, err)
			}
			if len(points) != spans {
				t.Fatalf("got %d %s buckets, want one per civil %s spanned by the window (%d): %+v", len(points), granularity, unit, spans, points)
			}
			seen := map[string]bool{}
			for index, point := range points {
				if seen[point.BucketStart.String()] {
					t.Fatalf("bucket %s appears twice", point.BucketStart)
				}
				seen[point.BucketStart.String()] = true
				if index > 0 && !points[index-1].BucketStart.Before(point.BucketStart) {
					t.Fatalf("buckets are not chronological: %s before %s", points[index-1].BucketStart, point.BucketStart)
				}
				if point.BucketStart.After(point.RequestedAt) {
					t.Fatalf("bucket %s starts after the batch it reports (%s)", point.BucketStart, point.RequestedAt)
				}
				// The bucket start and the batch it reports must fall on the same
				// Santiago civil day or week. A UTC-aligned implementation would break
				// this for a batch requested late in the local evening.
				var sameCivilUnit bool
				if granularity == HistoryDaily {
					err = db.QueryRow(ctx, `SELECT (($1::timestamptz) AT TIME ZONE 'America/Santiago')::date = (($2::timestamptz) AT TIME ZONE 'America/Santiago')::date`,
						point.BucketStart, point.RequestedAt).Scan(&sameCivilUnit)
				} else {
					err = db.QueryRow(ctx, `SELECT extract(isodow FROM ($1::timestamptz) AT TIME ZONE 'America/Santiago') = 1
						AND date_trunc('week', ($1::timestamptz) AT TIME ZONE 'America/Santiago') = date_trunc('week', ($2::timestamptz) AT TIME ZONE 'America/Santiago')`,
						point.BucketStart, point.RequestedAt).Scan(&sameCivilUnit)
				}
				if err != nil {
					t.Fatalf("compare bucket %s with its batch in the civil calendar: %v", point.BucketStart, err)
				}
				if !sameCivilUnit {
					t.Fatalf("bucket %s does not start the America/Santiago %s that contains its batch (%s)", point.BucketStart, granularity, point.RequestedAt)
				}
				assertLatestInBucket(t, ctx, db, granularity, point)
			}
			if granularity == HistoryWeekly {
				for _, point := range points {
					var monday bool
					if err := db.QueryRow(ctx, `SELECT extract(isodow FROM ($1::timestamptz) AT TIME ZONE 'America/Santiago') = 1`, point.BucketStart).Scan(&monday); err != nil {
						t.Fatalf("ask the database whether %s is a Monday: %v", point.BucketStart, err)
					}
					if !monday {
						t.Fatalf("weekly bucket %s does not start on a Monday", point.BucketStart)
					}
				}
			}
		})
	}

	// --- the whole territory, in one read ------------------------------------
	allZones, err := store.HistorySeries(ctx, HistorySeriesQuery{
		From: base, To: base.Add(72 * time.Hour), Granularity: HistoryDaily,
	})
	if err != nil {
		t.Fatalf("HistorySeries over the whole territory: %v", err)
	}
	var zonesWithPoints int
	if err := db.QueryRow(ctx, `SELECT count(DISTINCT zone_id) FROM batches WHERE requested_at >= $1 AND requested_at < $2`, base, base.Add(72*time.Hour)).Scan(&zonesWithPoints); err != nil {
		t.Fatalf("count the zones with a batch in the window: %v", err)
	}
	answered := map[string]int{}
	for _, point := range allZones {
		answered[point.ZoneID]++
		if point.ZoneID == "" {
			t.Fatal("a point was answered without a zone")
		}
	}
	if len(answered) != zonesWithPoints {
		t.Fatalf("the whole-territory read answered %d zones, want one per zone with a point in the window (%d): %+v", len(answered), zonesWithPoints, answered)
	}
	if _, present := answered[zone]; !present {
		t.Fatalf("the fixture zone %q has batches in the window but is absent from the whole-territory read", zone)
	}
	// The bound follows from the window, not from the row count: three civil days
	// cannot produce more than four daily buckets per zone.
	if len(allZones) > zonesWithPoints*4 {
		t.Fatalf("the answer carries %d points for %d zones, more than %d buckets can hold", len(allZones), zonesWithPoints, 4)
	}

	// An hourly window of the full cap stays bounded too: 48 hours is 49 buckets.
	var hourlyTotal int
	err = db.QueryRow(ctx, `SELECT count(*) FROM batches WHERE requested_at >= $1 AND requested_at < $2`, base, base.Add(48*time.Hour)).Scan(&hourlyTotal)
	if err != nil {
		t.Fatalf("count the batches inside the hourly cap window: %v", err)
	}
	if hourlyTotal < 2 {
		t.Fatalf("the hourly cap window holds %d batches; the bound would pass vacuously", hourlyTotal)
	}
}
