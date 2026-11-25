package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"firewatch.local/risk/internal/repository"
)

// seriesTarget is a well-formed series read: one civil day of the whole
// territory. The tests below vary one parameter at a time from this shape, so a
// refusal can only come from the parameter under test.
const seriesTarget = "/v1/risk/history/series?from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&granularity=day"

// HistorySeries stands in for the one bucketed query the route makes, so the
// route's validation, grouping, failure vocabulary and single-read behaviour are
// exercised without a database. The query it received is recorded, because the
// handler must pass the validated window and granularity down instead of
// re-deriving or defaulting them.
func (s *fakeStore) HistorySeries(_ context.Context, query repository.HistorySeriesQuery) ([]repository.HistoryPoint, error) {
	s.seriesCalls++
	s.seriesQueries = append(s.seriesQueries, query)
	if s.seriesErr != nil {
		return nil, s.seriesErr
	}
	return s.seriesPoints, nil
}

// TestParseHistorySeriesQuery pins the pure validation table of the series read.
// It is the whole acceptance surface of the query: the three required parameters,
// the closed granularity vocabulary, the half-open window and its hard caps, and
// the rule that an unknown, repeated or empty parameter is refused instead of
// being ignored or defaulted. Refusing matters because a dropped parameter would
// answer a different window than the caller asked for, which is indistinguishable
// from data loss at the client.
func TestParseHistorySeriesQuery(t *testing.T) {
	for _, tc := range []struct {
		name string
		raw  string
		want repository.HistorySeriesQuery
	}{
		{
			name: "hourly window without a zone",
			raw:  "from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&granularity=hour",
			want: repository.HistorySeriesQuery{
				From:        time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC),
				To:          time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC),
				Granularity: repository.HistoryHourly,
			},
		},
		{
			name: "daily window of one zone",
			raw:  "zone_id=05101&granularity=day&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z",
			want: repository.HistorySeriesQuery{
				ZoneID:      "05101",
				From:        time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC),
				To:          time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC),
				Granularity: repository.HistoryDaily,
			},
		},
		{
			// A caller may express the same instant in its own offset. The parsed
			// window is canonicalised to UTC so storage is asked the same question
			// whatever offset arrived.
			name: "weekly window in a non-UTC offset",
			raw:  "from=2026-10-31T21:00:00-03:00&to=2026-11-07T21:00:00-03:00&granularity=week",
			want: repository.HistorySeriesQuery{
				From:        time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC),
				To:          time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC),
				Granularity: repository.HistoryWeekly,
			},
		},
		{
			name: "hour cap is inclusive",
			raw:  "from=2026-11-01T00:00:00Z&to=2026-11-03T00:00:00Z&granularity=hour",
			want: repository.HistorySeriesQuery{
				From:        time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC),
				To:          time.Date(2026, 11, 3, 0, 0, 0, 0, time.UTC),
				Granularity: repository.HistoryHourly,
			},
		},
		{
			name: "day and week cap is inclusive",
			raw:  "from=2026-11-01T00:00:00Z&to=2026-12-02T00:00:00Z&granularity=week",
			want: repository.HistorySeriesQuery{
				From:        time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC),
				To:          time.Date(2026, 12, 2, 0, 0, 0, 0, time.UTC),
				Granularity: repository.HistoryWeekly,
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseHistorySeriesQuery(tc.raw)
			if err != nil {
				t.Fatalf("parseHistorySeriesQuery(%q): %v", tc.raw, err)
			}
			if got.ZoneID != tc.want.ZoneID || got.Granularity != tc.want.Granularity {
				t.Fatalf("parsed %+v, want %+v", got, tc.want)
			}
			if !got.From.Equal(tc.want.From) || !got.To.Equal(tc.want.To) {
				t.Fatalf("window = [%s,%s), want [%s,%s)", got.From, got.To, tc.want.From, tc.want.To)
			}
		})
	}

	for _, tc := range []struct {
		name string
		raw  string
		code string
	}{
		{"missing from", "to=2026-11-02T00:00:00Z&granularity=day", "invalid_series_query"},
		{"missing to", "from=2026-11-01T00:00:00Z&granularity=day", "invalid_series_query"},
		{"missing granularity", "from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z", "invalid_series_query"},
		{"empty from", "from=&to=2026-11-02T00:00:00Z&granularity=day", "invalid_series_query"},
		{"empty granularity", "from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&granularity=", "invalid_series_query"},
		{"unknown parameter", "from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&granularity=day&limit=10", "invalid_series_query"},
		{"repeated from", "from=2026-11-01T00:00:00Z&from=2026-11-01T01:00:00Z&to=2026-11-02T00:00:00Z&granularity=day", "invalid_series_query"},
		{"repeated to", "from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&to=2026-11-03T00:00:00Z&granularity=day", "invalid_series_query"},
		{"repeated granularity", "from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&granularity=day&granularity=hour", "invalid_series_query"},
		{"unknown granularity", "from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&granularity=month", "invalid_series_query"},
		{"from is not RFC 3339", "from=2026-11-01&to=2026-11-02T00:00:00Z&granularity=day", "invalid_series_query"},
		{"to has no offset", "from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00&granularity=day", "invalid_series_query"},
		{"empty window", "from=2026-11-02T00:00:00Z&to=2026-11-02T00:00:00Z&granularity=day", "invalid_series_query"},
		{"reversed window", "from=2026-11-02T00:00:00Z&to=2026-11-01T00:00:00Z&granularity=day", "invalid_series_query"},
		{"hourly window over the cap", "from=2026-11-01T00:00:00Z&to=2026-11-03T00:00:01Z&granularity=hour", "invalid_series_query"},
		{"daily window over the cap", "from=2026-11-01T00:00:00Z&to=2026-12-02T00:00:01Z&granularity=day", "invalid_series_query"},
		{"weekly window over the cap", "from=2026-11-01T00:00:00Z&to=2026-12-02T00:00:01Z&granularity=week", "invalid_series_query"},
		{"unreadable encoding", "from=%zz&to=2026-11-02T00:00:00Z&granularity=day", "invalid_series_query"},
		{"empty zone", "zone_id=&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&granularity=day", "invalid_zone"},
		{"repeated zone", "zone_id=05101&zone_id=05201&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&granularity=day", "invalid_zone"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			query, err := parseHistorySeriesQuery(tc.raw)
			if err == nil {
				t.Fatalf("parseHistorySeriesQuery(%q) accepted the request as %+v", tc.raw, query)
			}
			var refusal seriesQueryRefusal
			if !errors.As(err, &refusal) {
				t.Fatalf("parseHistorySeriesQuery(%q) failed with %v, want a documented refusal", tc.raw, err)
			}
			if refusal.code != tc.code {
				t.Fatalf("parseHistorySeriesQuery(%q) refused with %q, want %q", tc.raw, refusal.code, tc.code)
			}
		})
	}
}

// seriesFixture is the stored answer the route is given: two zones, one of them
// with two buckets, and a level of desconocido in the newest bucket - the level a
// series must show rather than hide (S5).
func seriesFixture() []repository.HistoryPoint {
	utc := time.UTC
	return []repository.HistoryPoint{
		{
			ZoneID:       "05101",
			BucketStart:  time.Date(2026, 11, 1, 3, 0, 0, 0, utc),
			BatchID:      "8f1d0a52-7b3c-4a19-9e21-8a1b2c3d4e5f",
			RequestedAt:  time.Date(2026, 11, 1, 12, 30, 0, 0, utc),
			PublishedAt:  time.Date(2026, 11, 1, 12, 31, 0, 0, utc),
			ModelVersion: "academic-rule-v1",
			RiskLevel:    "alto",
		},
		{
			ZoneID:       "05101",
			BucketStart:  time.Date(2026, 11, 2, 3, 0, 0, 0, utc),
			BatchID:      "0f0a0e4e-4b3c-4f8e-9a1d-6c2b8d5e7a90",
			RequestedAt:  time.Date(2026, 11, 2, 9, 0, 0, 0, utc),
			PublishedAt:  time.Date(2026, 11, 2, 9, 1, 0, 0, utc),
			ModelVersion: "demo-fixture-v1",
			RiskLevel:    "desconocido",
			Synthetic:    true,
		},
		{
			ZoneID:       "05201",
			BucketStart:  time.Date(2026, 11, 1, 3, 0, 0, 0, utc),
			BatchID:      "7c9e6679-7425-40de-944b-e07fc1f90ae7",
			RequestedAt:  time.Date(2026, 11, 1, 20, 0, 0, 0, utc),
			PublishedAt:  time.Date(2026, 11, 1, 20, 2, 0, 0, utc),
			ModelVersion: "academic-rule-v1",
			RiskLevel:    "medio",
		},
	}
}

// TestHistorySeriesEndpoint pins the route's behaviour: the same viewer/admin
// bearer gate as every sibling read, one bucketed storage read per request (never
// one per zone), the documented 400 and 503 vocabulary, and a body that carries
// the bucket start, the batch identity and the provenance of each point without
// deriving freshness.
func TestHistorySeriesEndpoint(t *testing.T) {
	for _, tc := range []struct {
		name string
		// target is the URL, so the validation half of the route is reached through
		// the same mux and the same bearer gate as production.
		target     string
		points     []repository.HistoryPoint
		seriesErr  error
		zoneErr    error
		zones      map[string]bool
		wantStatus int
		wantCode   string
		wantSeries int
		wantZones  []string
		// wantCatalogue counts the zone-catalogue lookups: a read that omits
		// zone_id must not resolve one lookup per zone.
		wantCatalogue int
		wantQuery     bool
	}{
		{
			name:          "every zone that has a point",
			target:        seriesTarget,
			points:        seriesFixture(),
			wantStatus:    200,
			wantSeries:    2,
			wantZones:     []string{"05101", "05201"},
			wantCatalogue: 0,
			wantQuery:     true,
		},
		{
			name:          "one zone",
			target:        seriesTarget + "&zone_id=05101",
			points:        seriesFixture()[:2],
			zones:         map[string]bool{"05101": true},
			wantStatus:    200,
			wantSeries:    1,
			wantZones:     []string{"05101"},
			wantCatalogue: 1,
			wantQuery:     true,
		},
		{
			// An empty window is an answer, not a 404 and never an invented series:
			// a zone with no point is absent, and no bucket is interpolated.
			name:          "nothing in the window is an empty array",
			target:        seriesTarget,
			wantStatus:    200,
			wantSeries:    0,
			wantCatalogue: 0,
			wantQuery:     true,
		},
		{
			name:          "unknown zone is refused",
			target:        seriesTarget + "&zone_id=99999",
			zones:         map[string]bool{"05101": true},
			wantStatus:    400,
			wantCode:      "invalid_zone",
			wantCatalogue: 1,
		},
		{
			name:          "malformed query is refused before storage",
			target:        "/v1/risk/history/series?from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z",
			wantStatus:    400,
			wantCode:      "invalid_series_query",
			wantCatalogue: 0,
		},
		{
			name:          "window over the cap is refused before storage",
			target:        "/v1/risk/history/series?from=2026-11-01T00:00:00Z&to=2026-11-03T00:00:01Z&granularity=hour",
			wantStatus:    400,
			wantCode:      "invalid_series_query",
			wantCatalogue: 0,
		},
		{
			name:          "an unreadable query encoding is refused",
			target:        "/v1/risk/history/series?from=%zz&to=2026-11-02T00:00:00Z&granularity=day",
			wantStatus:    400,
			wantCode:      "invalid_series_query",
			wantCatalogue: 0,
		},
		{
			name:          "catalogue failure is a storage failure",
			target:        seriesTarget + "&zone_id=05101",
			zoneErr:       errors.New("storage unavailable"),
			wantStatus:    503,
			wantCode:      "storage_unavailable",
			wantCatalogue: 1,
		},
		{
			name:          "read failure is a storage failure",
			target:        seriesTarget,
			seriesErr:     errors.New("storage unavailable"),
			wantStatus:    503,
			wantCode:      "storage_unavailable",
			wantCatalogue: 0,
			wantQuery:     true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			zones := tc.zones
			if zones == nil {
				zones = map[string]bool{}
			}
			store := &fakeStore{seriesPoints: tc.points, seriesErr: tc.seriesErr, zoneErr: tc.zoneErr, zones: zones}
			handler, token := authorizedServer(t, "viewer", store)
			w := getZones(t, handler, token, tc.target)
			if w.Code != tc.wantStatus {
				t.Fatalf("got %d want %d: %s", w.Code, tc.wantStatus, w.Body.String())
			}
			// One bucketed query, never one read per zone: a fan-out of 38 reads per
			// bucket is what this route exists to avoid.
			if store.calls != 0 || store.aggregateCall != 0 {
				t.Fatalf("the series read used the per-zone reads: list=%d aggregate=%d", store.calls, store.aggregateCall)
			}
			if got := boolInt(tc.wantQuery); store.seriesCalls != got {
				t.Fatalf("series reads = %d, want %d", store.seriesCalls, got)
			}
			if store.zoneCalls != tc.wantCatalogue {
				t.Fatalf("catalogue lookups = %d, want %d", store.zoneCalls, tc.wantCatalogue)
			}
			if tc.wantStatus != 200 {
				if !strings.Contains(w.Body.String(), `"code":"`+tc.wantCode+`"`) {
					t.Fatalf("unexpected failure body: %s", w.Body.String())
				}
				// A refusal is not a series document: the caller must not parse one.
				if strings.Contains(w.Body.String(), `"series"`) {
					t.Fatalf("a refused request answered a series document: %s", w.Body.String())
				}
				return
			}
			var body historySeriesCollection
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatalf("response is not JSON: %v: %s", err, w.Body.String())
			}
			if body.Granularity != repository.HistoryDaily {
				t.Fatalf("granularity = %q, want day", body.Granularity)
			}
			if !body.From.Equal(time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)) || !body.To.Equal(time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC)) {
				t.Fatalf("window echoed as [%s,%s)", body.From, body.To)
			}
			if len(body.Series) != tc.wantSeries {
				t.Fatalf("got %d series want %d: %s", len(body.Series), tc.wantSeries, w.Body.String())
			}
			if tc.wantSeries == 0 && !strings.Contains(w.Body.String(), `"series":[]`) {
				t.Fatalf("an empty window is not an empty array: %s", w.Body.String())
			}
			for index, zone := range tc.wantZones {
				if body.Series[index].ZoneID != zone {
					t.Fatalf("series %d is zone %q, want %q", index, body.Series[index].ZoneID, zone)
				}
				if len(body.Series[index].Buckets) == 0 {
					t.Fatalf("zone %q was answered with no bucket", zone)
				}
			}
			if tc.wantSeries == 0 {
				return
			}
			// The bucket start is explicit and the buckets of a zone are in
			// chronological order, so a client plots a series without sorting it.
			first := body.Series[0]
			for index := 1; index < len(first.Buckets); index++ {
				if !first.Buckets[index-1].BucketStart.Before(first.Buckets[index].BucketStart) {
					t.Fatalf("buckets are not chronological: %s before %s", first.Buckets[index-1].BucketStart, first.Buckets[index].BucketStart)
				}
			}
			newest := first.Buckets[len(first.Buckets)-1]
			// S5: the newest assessment is shown even when its level is unknown.
			if newest.RiskLevel != "desconocido" || !newest.Synthetic || newest.BatchID != "0f0a0e4e-4b3c-4f8e-9a1d-6c2b8d5e7a90" || newest.ModelVersion != "demo-fixture-v1" {
				t.Fatalf("newest bucket lost its batch identity or provenance: %+v", newest)
			}
			// No freshness is derived here: data_status, notice and valid_until
			// belong to the per-zone reads, not to a historical bucket.
			for _, absent := range []string{"data_status", "notice", "valid_until", "factors", "rationale", "policy", "geometry"} {
				if strings.Contains(w.Body.String(), `"`+absent+`"`) {
					t.Fatalf("the series body carries %q: %s", absent, w.Body.String())
				}
			}
			// The instants are RFC 3339 in UTC, so two points compare without
			// re-reading the offset.
			if !strings.Contains(w.Body.String(), `"bucket_start":"2026-11-01T03:00:00Z"`) {
				t.Fatalf("bucket_start is not a canonical UTC instant: %s", w.Body.String())
			}
		})
	}
}

// TestHistorySeriesIsOneReadOfTheValidatedWindow proves the handler passed the
// validated question down instead of re-deriving it: the window, the granularity
// and the zone reach storage as they were accepted, and the whole-territory read
// carries no zone at all.
func TestHistorySeriesIsOneReadOfTheValidatedWindow(t *testing.T) {
	store := &fakeStore{seriesPoints: seriesFixture(), zones: map[string]bool{"05101": true}}
	handler, token := authorizedServer(t, "viewer", store)
	if w := getZones(t, handler, token, seriesTarget+"&zone_id=05101"); w.Code != 200 {
		t.Fatalf("got %d want 200: %s", w.Code, w.Body.String())
	}
	if len(store.seriesQueries) != 1 {
		t.Fatalf("storage was asked %d times, want exactly 1", len(store.seriesQueries))
	}
	query := store.seriesQueries[0]
	if query.ZoneID != "05101" || query.Granularity != repository.HistoryDaily {
		t.Fatalf("storage was asked %+v, want zone 05101 at day granularity", query)
	}
	if !query.From.Equal(time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)) || !query.To.Equal(time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("storage was asked the window [%s,%s)", query.From, query.To)
	}

	store = &fakeStore{seriesPoints: seriesFixture()}
	handler, token = authorizedServer(t, "viewer", store)
	if w := getZones(t, handler, token, seriesTarget); w.Code != 200 {
		t.Fatalf("got %d want 200: %s", w.Code, w.Body.String())
	}
	if len(store.seriesQueries) != 1 || store.seriesQueries[0].ZoneID != "" {
		t.Fatalf("the whole-territory read was asked %+v", store.seriesQueries)
	}
}

// TestHistorySeriesKeepsTheReadGate pins that the new route is a read like its
// neighbours: the shared bearer gate answers 401 and 403 before storage is
// touched, and an admitted read never writes.
func TestHistorySeriesRefusesHeadWithoutReading(t *testing.T) {
	store := &fakeStore{seriesPoints: seriesFixture()}
	handler, token := authorizedServer(t, "viewer", store)
	r := httptest.NewRequest(http.MethodHead, seriesTarget, nil)
	r.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != "GET" ||
		store.zoneCalls != 0 || store.seriesCalls != 0 {
		t.Fatalf("status=%d Allow=%q zone reads=%d series reads=%d", w.Code, w.Header().Get("Allow"), store.zoneCalls, store.seriesCalls)
	}
}

func TestHistorySeriesKeepsTheReadGate(t *testing.T) {
	for _, tc := range []struct {
		name     string
		role     string
		withAuth bool
		want     int
	}{
		{name: "anonymous is refused", want: 401},
		{name: "a role outside the read gate is forbidden", role: "operator", withAuth: true, want: 403},
		{name: "viewer reads", role: "viewer", withAuth: true, want: 200},
		{name: "admin reads", role: "admin", withAuth: true, want: 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &fakeStore{seriesPoints: seriesFixture()}
			handler, token := authorizedServer(t, tc.role, store)
			r := httptest.NewRequest(http.MethodGet, seriesTarget, nil)
			if tc.withAuth {
				r.Header.Set("Authorization", "Bearer "+token)
			}
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Fatalf("got %d want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if tc.want != 200 && (store.seriesCalls != 0 || store.zoneCalls != 0) {
				t.Fatal("a refused request reached storage")
			}
		})
	}
}

// TestHistorySeriesMatchesTheContract validates the wire against the published
// document instead of restating it here, so the OpenAPI file and the handler
// cannot drift.
func TestHistorySeriesMatchesTheContract(t *testing.T) {
	contract := loadContract(t)
	// The correlation middleware is the production one: it both answers the X-Request-ID
	// header the contract declares and forwards the same literal so the error body
	// echoes it.
	store := &fakeStore{seriesPoints: seriesFixture()}
	handler, token := authorizedServer(t, "viewer", store)
	app := withCorrelationID(handler)
	w := request(t, app, token, seriesTarget)
	if w.Code != 200 {
		t.Fatalf("got %d want 200: %s", w.Code, w.Body.String())
	}
	assertResponseMatchesContract(t, contract, "/v1/risk/history/series", http.MethodGet, w)

	store = &fakeStore{seriesPoints: seriesFixture()}
	handler, token = authorizedServer(t, "viewer", store)
	app = withCorrelationID(handler)
	w = request(t, app, token, "/v1/risk/history/series?from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z")
	if w.Code != 400 {
		t.Fatalf("got %d want 400: %s", w.Code, w.Body.String())
	}
	assertResponseMatchesContract(t, contract, "/v1/risk/history/series", http.MethodGet, w)
}

// TestLegacyHistoryReadsAreUnchanged is the S3 compatibility evidence: adding the
// series route leaves the JSON history and its CSV export exactly as they were.
// The JSON body is the stored window verbatim, the CSV header row is the frozen
// column seam, and the legacy routes still refuse a parameter they do not accept -
// so the new query vocabulary did not leak into them.
func TestLegacyHistoryReadsAreUnchanged(t *testing.T) {
	batches := []repository.Batch{{
		ID:           "8f1d0a52-7b3c-4a19-9e21-8a1b2c3d4e5f",
		JobID:        "7c9e6679-7425-40de-944b-e07fc1f90ae7",
		ZoneID:       "05101",
		RequestedAt:  time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC),
		PublishedAt:  time.Date(2026, 11, 1, 12, 1, 0, 0, time.UTC),
		ValidUntil:   time.Date(2026, 11, 1, 12, 15, 0, 0, time.UTC),
		ModelVersion: "academic-rule-v1",
		DataStatus:   "current",
		RiskLevel:    "medio",
		Factors:      json.RawMessage(`[]`),
		Rationale:    "Puntaje ponderado medio.",
		Geometry:     json.RawMessage(`{"type":"Point","coordinates":[-71.6,-33.0]}`),
	}}
	store := &fakeStore{batches: batches, zones: map[string]bool{"05101": true}, seriesPoints: seriesFixture()}
	handler, token := authorizedServer(t, "viewer", store)

	w := getZones(t, handler, token, "/v1/risk/history?zone_id=05101")
	if w.Code != http.StatusOK {
		t.Fatalf("legacy history got %d: %s", w.Code, w.Body.String())
	}
	wantJSON, err := json.Marshal(batches)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(w.Body.String()); got != string(wantJSON) {
		t.Fatalf("legacy history body changed:\n got %s\nwant %s", got, wantJSON)
	}

	csv := getZones(t, handler, token, "/v1/risk/history.csv?zone_id=05101")
	if csv.Code != http.StatusOK {
		t.Fatalf("legacy CSV got %d: %s", csv.Code, csv.Body.String())
	}
	if header, _, _ := strings.Cut(csv.Body.String(), "\n"); header != strings.Join(historyCSVHeader, ",") {
		t.Fatalf("the exported header row changed: %s", header)
	}

	// The legacy route keeps its own vocabulary: a series parameter is an unknown
	// parameter there, not a silently ignored filter.
	if w := getZones(t, handler, token, "/v1/risk/history?zone_id=05101&granularity=day"); w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), `"code":"invalid_zone"`) {
		t.Fatalf("the legacy history accepted a series parameter: %d %s", w.Code, w.Body.String())
	}

	// And the series route answers without reading the legacy window at all.
	store.calls, store.zoneCalls = 0, 0
	series := getZones(t, handler, token, seriesTarget)
	if series.Code != http.StatusOK || store.calls != 0 || store.seriesCalls != 1 {
		t.Fatalf("the series read used the legacy window: %d calls=%d series=%d", series.Code, store.calls, store.seriesCalls)
	}
}

// boolInt converts a table's expectation flag into the call count it implies.
func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
