package repository

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// These tests exercise the timeline read's real SQL against Postgres. They are
// skipped without a migrated disposable database (TEST_DATABASE_URL), and a skip
// is not a pass.
//
// Isolation is session-local, the technique TestListRefusesMissingCommuneGeometry
// and shadowOutboxWithAlertProbe already use: temporary tables named zones,
// batches and risk_alerts shadow the shared ones on this connection (pg_temp is
// searched before public for relation names), so the read runs its own statement
// - joins, keyset predicate, direction, LIMIT - against fixtures this test wrote
// and nobody else can see. The committed tables are never read, written or
// altered, and the shadows disappear with the session.
//
// The shadow DDL mirrors the columns and types 017_risk_alerts.sql defines. It
// deliberately omits the foreign keys, and only that omission is invented: an
// alert whose zone or batch row is missing is a state the real schema forbids, and
// omitting the keys is the only way to observe what the read does when a reference
// disappears (serve a null label, fail closed on provenance).

// alertReadPool opens the disposable database with one connection, because the
// shadows and their fixtures exist in that session and nowhere else.
func alertReadPool(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	return alertTestPoolWith(t, func(config *pgxpool.Config) { config.MaxConns = 1 })
}

// shadowAlertTimeline creates the session-local tables the timeline read resolves
// through and returns the session it belongs to.
func shadowAlertTimeline(ctx context.Context, t *testing.T, db *pgxpool.Pool) {
	t.Helper()
	for name, statement := range map[string]string{
		"zones": `CREATE TEMP TABLE zones (
			code text PRIMARY KEY,
			name text NOT NULL
		)`,
		"batches": `CREATE TEMP TABLE batches (
			id uuid PRIMARY KEY,
			demo boolean NOT NULL,
			risk_level text NOT NULL DEFAULT 'alto',
			requested_at timestamptz NOT NULL DEFAULT now()
		)`,
		"risk_alerts": `CREATE TEMP TABLE risk_alerts (
			id uuid PRIMARY KEY,
			zone_id text NOT NULL,
			batch_id uuid NOT NULL,
			previous_level text NOT NULL,
			new_level text NOT NULL,
			threshold integer NOT NULL DEFAULT 1,
			occurred_at timestamptz NOT NULL
		)`,
	} {
		if _, err := db.Exec(ctx, statement); err != nil {
			t.Fatalf("create the session-local %s shadow: %v", name, err)
		}
	}
}

// alertReadFixture is one stored transition plus the two references it is read
// through. zoneName is a pointer because "the catalogue does not name this zone"
// is a state the test must be able to express.
type alertReadFixture struct {
	alertID    string
	zoneID     string
	batchID    string
	previous   string
	next       string
	threshold  int
	occurredAt time.Time
	demo       bool
	zoneName   *string
	// storeBatch false leaves the batch row out, which is only expressible
	// because the shadow omits the foreign key.
	storeBatch bool
}

// insertAlertReadFixture writes the fixture's catalogue row, batch row and alert
// row. Every value is explicit: nothing is defaulted that the read could be
// relying on.
func insertAlertReadFixture(ctx context.Context, t *testing.T, db *pgxpool.Pool, fixture alertReadFixture) {
	t.Helper()
	if fixture.zoneName != nil {
		if _, err := db.Exec(ctx, `INSERT INTO zones(code,name) VALUES($1,$2) ON CONFLICT DO NOTHING`, fixture.zoneID, *fixture.zoneName); err != nil {
			t.Fatalf("store the catalogue label of %s: %v", fixture.zoneID, err)
		}
	}
	if fixture.storeBatch {
		if _, err := db.Exec(ctx, `INSERT INTO batches(id,demo,risk_level,requested_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, fixture.batchID, fixture.demo, fixture.next, fixture.occurredAt); err != nil {
			t.Fatalf("store the batch of alert %s: %v", fixture.alertID, err)
		}
	}
	if _, err := db.Exec(ctx, `INSERT INTO risk_alerts(id,zone_id,batch_id,previous_level,new_level,threshold,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,
		fixture.alertID, fixture.zoneID, fixture.batchID, fixture.previous, fixture.next, fixture.threshold, fixture.occurredAt); err != nil {
		t.Fatalf("store alert %s: %v", fixture.alertID, err)
	}
}

// alertIDsOf is the observable order of a page: the identifiers, in served order.
func alertIDsOf(alerts []Alert) []string {
	ids := make([]string, 0, len(alerts))
	for _, alert := range alerts {
		ids = append(ids, alert.ID)
	}
	return ids
}

func assertAlertOrder(t *testing.T, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("order = %v, want %v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("order = %v, want %v", got, want)
		}
	}
}

// TestListAlertsPaginatesWithAStableKeyset is the pagination contract of the
// frozen wire: (occurred_at, id) in the selected direction, a next cursor only
// while more rows remain, and a page boundary that neither repeats nor skips a row
// when two alerts share an instant.
func TestListAlertsPaginatesWithAStableKeyset(t *testing.T) {
	ctx, db := alertReadPool(t)
	shadowAlertTimeline(ctx, t, db)
	store := Store{DB: db}

	const (
		zoneID = "15201"
	)
	name := "Quilpue"
	base := time.Date(2026, time.August, 1, 12, 0, 0, 0, time.UTC)
	// The two tie ids are chosen so the canonical uuid order is unambiguous: f…
	// is greater than 1…, so it comes first in descending order and second in
	// ascending order.
	const (
		newestID  = "00000000-0000-4000-8000-0000000000a1"
		tieHighID = "f0000000-0000-4000-8000-0000000000b2"
		tieLowID  = "10000000-0000-4000-8000-0000000000c3"
		oldestID  = "00000000-0000-4000-8000-0000000000d4"
	)
	for _, fixture := range []alertReadFixture{
		{alertID: oldestID, zoneID: zoneID, batchID: "00000000-0000-4000-8000-000000000104", previous: "alto", next: "medio", threshold: 1, occurredAt: base.Add(1 * time.Second), demo: false, zoneName: &name, storeBatch: true},
		{alertID: tieLowID, zoneID: zoneID, batchID: "00000000-0000-4000-8000-000000000103", previous: "medio", next: "bajo", threshold: 1, occurredAt: base.Add(2 * time.Second), demo: true, zoneName: &name, storeBatch: true},
		{alertID: tieHighID, zoneID: zoneID, batchID: "00000000-0000-4000-8000-000000000102", previous: "bajo", next: "alto", threshold: 1, occurredAt: base.Add(2 * time.Second), demo: false, zoneName: &name, storeBatch: true},
		{alertID: newestID, zoneID: zoneID, batchID: "00000000-0000-4000-8000-000000000101", previous: "alto", next: "bajo", threshold: 1, occurredAt: base.Add(3 * time.Second), demo: true, zoneName: &name, storeBatch: true},
	} {
		insertAlertReadFixture(ctx, t, db, fixture)
	}

	// Descending, two rows per page: the tie pair is split across the boundary,
	// which is the case a keyset on occurred_at alone would get wrong.
	first, err := store.ListAlerts(ctx, AlertPageQuery{Limit: 2, Order: AlertOrderNewestFirst})
	if err != nil {
		t.Fatalf("first page: %v", err)
	}
	assertAlertOrder(t, alertIDsOf(first.Alerts), []string{newestID, tieHighID})
	if first.NextCursor == "" {
		t.Fatal("a page with more rows behind it returned no cursor")
	}
	boundary, err := DecodeAlertCursor(AlertOrderNewestFirst, first.NextCursor)
	if err != nil {
		t.Fatalf("decode the cursor the read returned: %v", err)
	}
	if !boundary.OccurredAt.Equal(base.Add(2*time.Second)) || boundary.ID != tieHighID {
		t.Fatalf("cursor boundary = %+v, want the last row this page served (%s)", boundary, tieHighID)
	}
	second, err := store.ListAlerts(ctx, AlertPageQuery{Limit: 2, Order: AlertOrderNewestFirst, Cursor: &boundary})
	if err != nil {
		t.Fatalf("second page: %v", err)
	}
	assertAlertOrder(t, alertIDsOf(second.Alerts), []string{tieLowID, oldestID})
	if second.NextCursor != "" {
		t.Fatalf("the last page carries a cursor: %q", second.NextCursor)
	}

	// The whole timeline, walked page by page, is every stored row exactly once.
	walked := append(alertIDsOf(first.Alerts), alertIDsOf(second.Alerts)...)
	assertAlertOrder(t, walked, []string{newestID, tieHighID, tieLowID, oldestID})

	// Ascending reverses the timeline and, with it, the tie-break: the lower
	// identifier comes first. A cursor is only valid for the direction it was
	// issued for, which is why this walk starts without one.
	ascending, err := store.ListAlerts(ctx, AlertPageQuery{Limit: 3, Order: AlertOrderOldestFirst})
	if err != nil {
		t.Fatalf("oldest first: %v", err)
	}
	assertAlertOrder(t, alertIDsOf(ascending.Alerts), []string{oldestID, tieLowID, tieHighID})
	if ascending.NextCursor == "" {
		t.Fatal("the ascending page hides the row behind it")
	}
	ascendingBoundary, err := DecodeAlertCursor(AlertOrderOldestFirst, ascending.NextCursor)
	if err != nil {
		t.Fatalf("decode the ascending cursor: %v", err)
	}
	ascendingRest, err := store.ListAlerts(ctx, AlertPageQuery{Limit: 3, Order: AlertOrderOldestFirst, Cursor: &ascendingBoundary})
	if err != nil {
		t.Fatalf("ascending continuation: %v", err)
	}
	assertAlertOrder(t, alertIDsOf(ascendingRest.Alerts), []string{newestID})

	// An unspecified order is the documented default: newest first, not a third
	// direction and not an error.
	unspecified, err := store.ListAlerts(ctx, AlertPageQuery{Limit: 2})
	if err != nil {
		t.Fatalf("unspecified order: %v", err)
	}
	assertAlertOrder(t, alertIDsOf(unspecified.Alerts), []string{newestID, tieHighID})
}

// TestListAlertsServesProvenanceAndANullableZoneLabel pins the two references the
// alert row does not store: the demo flag read from the originating batch, and the
// current catalogue label, which is null when the catalogue no longer names the
// zone. The alert is served in that case - it is evidence a transition happened,
// not a projection of the catalogue.
func TestListAlertsServesProvenanceAndANullableZoneLabel(t *testing.T) {
	ctx, db := alertReadPool(t)
	shadowAlertTimeline(ctx, t, db)
	store := Store{DB: db}

	base := time.Date(2026, time.August, 2, 9, 0, 0, 0, time.UTC)
	named := "Valparaiso"
	const (
		syntheticID = "00000000-0000-4000-8000-0000000000e1"
		realID      = "00000000-0000-4000-8000-0000000000e2"
		orphanID    = "00000000-0000-4000-8000-0000000000e3"
	)
	insertAlertReadFixture(ctx, t, db, alertReadFixture{alertID: syntheticID, zoneID: "05101", batchID: "00000000-0000-4000-8000-000000000201", previous: "bajo", next: "medio", threshold: 1, occurredAt: base, demo: true, zoneName: &named, storeBatch: true})
	insertAlertReadFixture(ctx, t, db, alertReadFixture{alertID: realID, zoneID: "05101", batchID: "00000000-0000-4000-8000-000000000202", previous: "medio", next: "alto", threshold: 1, occurredAt: base.Add(time.Second), demo: false, zoneName: &named, storeBatch: true})
	// No catalogue row for this zone: the label must be null and the alert kept.
	insertAlertReadFixture(ctx, t, db, alertReadFixture{alertID: orphanID, zoneID: "99999", batchID: "00000000-0000-4000-8000-000000000203", previous: "alto", next: "medio", threshold: 1, occurredAt: base.Add(2 * time.Second), demo: false, storeBatch: true})

	page, err := store.ListAlerts(ctx, AlertPageQuery{Limit: AlertMaxLimit, Order: AlertOrderNewestFirst})
	if err != nil {
		t.Fatalf("read the timeline: %v", err)
	}
	assertAlertOrder(t, alertIDsOf(page.Alerts), []string{orphanID, realID, syntheticID})
	byID := map[string]Alert{}
	for _, alert := range page.Alerts {
		byID[alert.ID] = alert
	}
	if !byID[syntheticID].Demo {
		t.Fatal("a synthetic transition is not labelled demo")
	}
	if byID[realID].Demo {
		t.Fatal("a transition read from a real batch is labelled demo")
	}
	if byID[orphanID].ZoneName != nil {
		t.Fatalf("the missing catalogue label was invented as %q", *byID[orphanID].ZoneName)
	}
	if byID[realID].ZoneName == nil || *byID[realID].ZoneName != named {
		t.Fatalf("the catalogue label is %+v, want %q", byID[realID].ZoneName, named)
	}
	for _, alert := range page.Alerts {
		if alert.Threshold != 1 {
			t.Fatalf("alert %s serves threshold %d, want the stored 1", alert.ID, alert.Threshold)
		}
		if alert.OccurredAt.Location() != time.UTC {
			t.Fatalf("alert %s serves occurred_at in %s, want UTC", alert.ID, alert.OccurredAt.Location())
		}
		if alert.PreviousLevel == "" || alert.NewLevel == "" {
			t.Fatalf("alert %s serves an empty level: %+v", alert.ID, alert)
		}
	}
}

// TestListAlertsFailsClosedOnMissingProvenance is the other half of the batch
// join: an alert whose originating batch is not stored cannot state whether its
// input was synthetic, so the page is refused instead of served with an invented
// demo flag. The shadow omits the foreign key that makes this state unreachable in
// the migrated schema; the check exists so a violated reference surfaces as an
// error rather than as a quiet "demo": false.
func TestListAlertsFailsClosedOnMissingProvenance(t *testing.T) {
	ctx, db := alertReadPool(t)
	shadowAlertTimeline(ctx, t, db)
	store := Store{DB: db}
	name := "Valparaiso"
	insertAlertReadFixture(ctx, t, db, alertReadFixture{
		alertID:  "00000000-0000-4000-8000-0000000000f1",
		zoneID:   "05101",
		batchID:  "00000000-0000-4000-8000-000000000301",
		previous: "bajo", next: "alto", threshold: 1,
		occurredAt: time.Date(2026, time.August, 3, 9, 0, 0, 0, time.UTC),
		demo:       false,
		zoneName:   &name,
		// The batch row is deliberately absent.
	})

	page, err := store.ListAlerts(ctx, AlertPageQuery{Limit: 10, Order: AlertOrderNewestFirst})
	if err == nil || !strings.Contains(err.Error(), "names a batch that is not stored") {
		t.Fatalf("ListAlerts = %+v, %v; want the missing-provenance error", page, err)
	}
	if len(page.Alerts) != 0 || page.NextCursor != "" {
		t.Fatalf("a refused page served data: %+v", page)
	}
}

// TestListAlertsEmptyTimelineIsAnEmptyPage pins the empty state the notification
// screen renders: no rows is an answer with an empty list and no cursor, never an
// error and never a null collection for the caller to special-case.
func TestListAlertsEmptyTimelineIsAnEmptyPage(t *testing.T) {
	ctx, db := alertReadPool(t)
	shadowAlertTimeline(ctx, t, db)
	store := Store{DB: db}

	for _, order := range []AlertOrder{AlertOrderNewestFirst, AlertOrderOldestFirst} {
		page, err := store.ListAlerts(ctx, AlertPageQuery{Limit: AlertDefaultLimit, Order: order})
		if err != nil {
			t.Fatalf("%s on an empty timeline: %v", order, err)
		}
		if page.Alerts == nil {
			t.Fatalf("%s on an empty timeline served a nil list", order)
		}
		if len(page.Alerts) != 0 || page.NextCursor != "" {
			t.Fatalf("%s on an empty timeline served %+v", order, page)
		}
	}
}

// TestListAlertsBoundsThePage pins the page window. A limit of one serves one row
// and a cursor; an unspecified or oversized limit is bounded by this read instead
// of being handed to the database, so a direct caller cannot ask for the whole
// table in one statement.
func TestListAlertsBoundsThePage(t *testing.T) {
	ctx, db := alertReadPool(t)
	shadowAlertTimeline(ctx, t, db)
	store := Store{DB: db}
	name := "Valparaiso"
	base := time.Date(2026, time.August, 4, 9, 0, 0, 0, time.UTC)
	for index, occurredAt := range []time.Time{base, base.Add(time.Minute), base.Add(2 * time.Minute)} {
		insertAlertReadFixture(ctx, t, db, alertReadFixture{
			alertID:  []string{"00000000-0000-4000-8000-0000000000f2", "00000000-0000-4000-8000-0000000000f3", "00000000-0000-4000-8000-0000000000f4"}[index],
			zoneID:   "05101",
			batchID:  []string{"00000000-0000-4000-8000-000000000401", "00000000-0000-4000-8000-000000000402", "00000000-0000-4000-8000-000000000403"}[index],
			previous: "bajo", next: "medio", threshold: 1,
			occurredAt: occurredAt,
			demo:       false,
			zoneName:   &name,
			storeBatch: true,
		})
	}

	single, err := store.ListAlerts(ctx, AlertPageQuery{Limit: 1, Order: AlertOrderNewestFirst})
	if err != nil {
		t.Fatalf("limit 1: %v", err)
	}
	if len(single.Alerts) != 1 || single.NextCursor == "" {
		t.Fatalf("limit 1 served %d rows and cursor %q", len(single.Alerts), single.NextCursor)
	}
	for _, limit := range []int{0, -5, AlertDefaultLimit, AlertMaxLimit, AlertMaxLimit + 500} {
		page, err := store.ListAlerts(ctx, AlertPageQuery{Limit: limit, Order: AlertOrderOldestFirst})
		if err != nil {
			t.Fatalf("limit %d: %v", limit, err)
		}
		if len(page.Alerts) != 3 || page.NextCursor != "" {
			t.Fatalf("limit %d served %d rows and cursor %q, want the three stored rows and no cursor", limit, len(page.Alerts), page.NextCursor)
		}
	}
}

// TestListAlertsRefusesToReadTheSharedTimeline is a guard on the isolation this
// file relies on: without the session-local shadows the read would answer rows the
// disposable database already holds, and every assertion above would be measuring
// someone else's fixtures. With them it answers exactly what the test wrote.
func TestListAlertsReadsOnlyTheSessionShadow(t *testing.T) {
	ctx, db := alertReadPool(t)
	shadowAlertTimeline(ctx, t, db)
	store := Store{DB: db}

	// The shared risk_alerts table is not visible from this session's search path,
	// so an empty shadow must mean an empty page even on a populated database.
	page, err := store.ListAlerts(ctx, AlertPageQuery{Limit: AlertMaxLimit, Order: AlertOrderNewestFirst})
	if err != nil {
		t.Fatalf("read the shadowed timeline: %v", err)
	}
	if len(page.Alerts) != 0 {
		t.Fatalf("the shadowed read served %d rows it did not write", len(page.Alerts))
	}
	var shared int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM public.risk_alerts`).Scan(&shared); err != nil {
		t.Fatalf("count the shared timeline: %v", err)
	}
	if shared != 0 {
		// Not a failure: the disposable database is reused. This line records that
		// the emptiness above came from the shadow, not from an empty shared table.
		t.Logf("the shared timeline holds %d rows this session did not read", shared)
	}
}
