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

// comparisonTarget is a well-formed comparison read: two zones, two days of civil
// day buckets. The tests below vary one parameter at a time from this shape, so a
// refusal can only come from the parameter under test.
const comparisonTarget = "/v1/risk/compare?zone_ids=05101,05201&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&granularity=day"

// CompareZones stands in for the one snapshot read the route makes, so the
// route's validation, ordering, null assessment, failure vocabulary and
// single-read behaviour are exercised without a database. The query it received is
// recorded, because the handler must pass the validated zone list, window and
// granularity down instead of re-deriving or defaulting them.
func (s *fakeStore) CompareZones(_ context.Context, query repository.ComparisonQuery) (repository.ComparisonSnapshot, error) {
	s.compareCalls++
	s.compareQueries = append(s.compareQueries, query)
	if s.compareErr != nil {
		return repository.ComparisonSnapshot{}, s.compareErr
	}
	return s.comparison, nil
}

// TestParseComparisonQuery pins the pure validation table of the comparison read.
// It is the whole acceptance surface of the query: the required comma-separated
// zone list and its two-to-three bound, the closed granularity vocabulary, the
// PM-04 half-open window and its hard caps, and the rule that an unknown,
// repeated, duplicate or empty parameter is refused instead of being ignored,
// resolved or defaulted. Refusing matters because a silently dropped zone would
// answer a different comparison than the caller asked for.
func TestParseComparisonQuery(t *testing.T) {
	for _, tc := range []struct {
		name string
		raw  string
		want repository.ComparisonQuery
	}{
		{
			name: "two zones in the caller's order",
			raw:  "zone_ids=05201,05101&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&granularity=hour",
			want: repository.ComparisonQuery{
				ZoneIDs:     []string{"05201", "05101"},
				From:        time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC),
				To:          time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC),
				Granularity: repository.HistoryHourly,
			},
		},
		{
			name: "three zones",
			raw:  "granularity=week&to=2026-11-08T00:00:00Z&zone_ids=05101,05201,05301&from=2026-11-01T00:00:00Z",
			want: repository.ComparisonQuery{
				ZoneIDs:     []string{"05101", "05201", "05301"},
				From:        time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC),
				To:          time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC),
				Granularity: repository.HistoryWeekly,
			},
		},
		{
			// A caller may express the same instant in its own offset. The parsed
			// window is canonicalised to UTC so storage is asked the same question
			// whatever offset arrived.
			name: "window in a non-UTC offset",
			raw:  "zone_ids=05101,05201&from=2026-10-31T21:00:00-03:00&to=2026-11-01T21:00:00-03:00&granularity=day",
			want: repository.ComparisonQuery{
				ZoneIDs:     []string{"05101", "05201"},
				From:        time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC),
				To:          time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC),
				Granularity: repository.HistoryDaily,
			},
		},
		{
			name: "hour cap is inclusive",
			raw:  "zone_ids=05101,05201&from=2026-11-01T00:00:00Z&to=2026-11-03T00:00:00Z&granularity=hour",
			want: repository.ComparisonQuery{
				ZoneIDs:     []string{"05101", "05201"},
				From:        time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC),
				To:          time.Date(2026, 11, 3, 0, 0, 0, 0, time.UTC),
				Granularity: repository.HistoryHourly,
			},
		},
		{
			name: "day and week cap is inclusive",
			raw:  "zone_ids=05101,05201&from=2026-11-01T00:00:00Z&to=2026-12-02T00:00:00Z&granularity=day",
			want: repository.ComparisonQuery{
				ZoneIDs:     []string{"05101", "05201"},
				From:        time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC),
				To:          time.Date(2026, 12, 2, 0, 0, 0, 0, time.UTC),
				Granularity: repository.HistoryDaily,
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseComparisonQuery(tc.raw)
			if err != nil {
				t.Fatalf("parseComparisonQuery(%q): %v", tc.raw, err)
			}
			if got.Granularity != tc.want.Granularity {
				t.Fatalf("granularity = %q, want %q", got.Granularity, tc.want.Granularity)
			}
			if !got.From.Equal(tc.want.From) || !got.To.Equal(tc.want.To) {
				t.Fatalf("window = [%s,%s), want [%s,%s)", got.From, got.To, tc.want.From, tc.want.To)
			}
			if len(got.ZoneIDs) != len(tc.want.ZoneIDs) {
				t.Fatalf("zones = %v, want %v", got.ZoneIDs, tc.want.ZoneIDs)
			}
			for index := range got.ZoneIDs {
				if got.ZoneIDs[index] != tc.want.ZoneIDs[index] {
					t.Fatalf("zones = %v, want the caller's order %v", got.ZoneIDs, tc.want.ZoneIDs)
				}
			}
		})
	}

	for _, tc := range []struct {
		name string
		raw  string
		code string
	}{
		{"missing zone list", "from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&granularity=day", "invalid_comparison_query"},
		{"empty zone list", "zone_ids=&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&granularity=day", "invalid_comparison_query"},
		{"one zone", "zone_ids=05101&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&granularity=day", "invalid_comparison_query"},
		{"four zones", "zone_ids=05101,05201,05301,05401&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&granularity=day", "invalid_comparison_query"},
		{"empty entry", "zone_ids=05101,,05201&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&granularity=day", "invalid_comparison_query"},
		{"trailing comma", "zone_ids=05101,05201,&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&granularity=day", "invalid_comparison_query"},
		{"duplicate zone", "zone_ids=05101,05101&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&granularity=day", "invalid_zone"},
		{"repeated zone list", "zone_ids=05101,05201&zone_ids=05201,05301&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&granularity=day", "invalid_comparison_query"},
		{"unknown parameter", "zone_ids=05101,05201&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&granularity=day&limit=10", "invalid_comparison_query"},
		{"missing from", "zone_ids=05101,05201&to=2026-11-02T00:00:00Z&granularity=day", "invalid_comparison_query"},
		{"missing to", "zone_ids=05101,05201&from=2026-11-01T00:00:00Z&granularity=day", "invalid_comparison_query"},
		{"missing granularity", "zone_ids=05101,05201&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z", "invalid_comparison_query"},
		{"empty from", "zone_ids=05101,05201&from=&to=2026-11-02T00:00:00Z&granularity=day", "invalid_comparison_query"},
		{"repeated granularity", "zone_ids=05101,05201&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&granularity=day&granularity=hour", "invalid_comparison_query"},
		{"unknown granularity", "zone_ids=05101,05201&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&granularity=month", "invalid_comparison_query"},
		{"from is not RFC 3339", "zone_ids=05101,05201&from=2026-11-01&to=2026-11-02T00:00:00Z&granularity=day", "invalid_comparison_query"},
		{"to has no offset", "zone_ids=05101,05201&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00&granularity=day", "invalid_comparison_query"},
		{"empty window", "zone_ids=05101,05201&from=2026-11-02T00:00:00Z&to=2026-11-02T00:00:00Z&granularity=day", "invalid_comparison_query"},
		{"reversed window", "zone_ids=05101,05201&from=2026-11-02T00:00:00Z&to=2026-11-01T00:00:00Z&granularity=day", "invalid_comparison_query"},
		{"hourly window over the cap", "zone_ids=05101,05201&from=2026-11-01T00:00:00Z&to=2026-11-03T00:00:01Z&granularity=hour", "invalid_comparison_query"},
		{"daily window over the cap", "zone_ids=05101,05201&from=2026-11-01T00:00:00Z&to=2026-12-02T00:00:01Z&granularity=day", "invalid_comparison_query"},
		{"unreadable encoding", "zone_ids=%zz&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&granularity=day", "invalid_comparison_query"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			query, err := parseComparisonQuery(tc.raw)
			if err == nil {
				t.Fatalf("parseComparisonQuery(%q) accepted the request as %+v", tc.raw, query)
			}
			var refusal comparisonQueryRefusal
			if !errors.As(err, &refusal) {
				t.Fatalf("parseComparisonQuery(%q) failed with %v, want a documented refusal", tc.raw, err)
			}
			if refusal.code != tc.code {
				t.Fatalf("parseComparisonQuery(%q) refused with %q, want %q", tc.raw, refusal.code, tc.code)
			}
		})
	}
}

// comparisonFixture is the stored answer the route is given: two assessed zones
// and one zone with no eligible batch at all, a zone whose cutoff assessment
// predates the window, a recorded desconocido level, and a bucket inside the
// window. It is the partial-data case the caller must be able to read: a null
// assessment is not an error and not a made-up level.
func comparisonFixture() repository.ComparisonSnapshot {
	utc := time.UTC
	return repository.ComparisonSnapshot{
		Assessments: []repository.ComparisonAssessment{
			{
				ZoneID:       "05201",
				BatchID:      "7c9e6679-7425-40de-944b-e07fc1f90ae7",
				RequestedAt:  time.Date(2026, 10, 30, 9, 0, 0, 0, utc),
				PublishedAt:  time.Date(2026, 10, 30, 9, 1, 0, 0, utc),
				ModelVersion: "academic-rule-v1",
				RiskLevel:    "medio",
				Factors:      json.RawMessage(`[{"name":"humedad","known":true,"value":31,"contribution":0.4,"note":"humedad relativa baja"}]`),
			},
			{
				ZoneID:       "05101",
				BatchID:      "8f1d0a52-7b3c-4a19-9e21-8a1b2c3d4e5f",
				RequestedAt:  time.Date(2026, 11, 1, 12, 30, 0, 0, utc),
				PublishedAt:  time.Date(2026, 11, 1, 12, 31, 0, 0, utc),
				ModelVersion: "demo-fixture-v1",
				RiskLevel:    "desconocido",
				Factors:      json.RawMessage(`[]`),
				Synthetic:    true,
			},
		},
		History: []repository.HistoryPoint{
			{
				ZoneID:       "05101",
				BucketStart:  time.Date(2026, 11, 1, 3, 0, 0, 0, utc),
				BatchID:      "0f0a0e4e-4b3c-4f8e-9a1d-6c2b8d5e7a90",
				RequestedAt:  time.Date(2026, 11, 1, 11, 0, 0, 0, utc),
				PublishedAt:  time.Date(2026, 11, 1, 11, 1, 0, 0, utc),
				ModelVersion: "academic-rule-v1",
				RiskLevel:    "alto",
			},
		},
	}
}

// TestComparisonEndpoint pins the route's behaviour: the same viewer/admin bearer
// gate as every sibling read, one snapshot read per request (never one per zone),
// the documented 400 and 503 vocabulary, the caller's zone order with a null
// assessment preserved, and a body that carries the stored risk, factors and
// provenance without deriving freshness or inventing priority.
func TestComparisonEndpoint(t *testing.T) {
	for _, tc := range []struct {
		name       string
		target     string
		snapshot   repository.ComparisonSnapshot
		compareErr error
		zoneErr    error
		zones      map[string]bool
		wantStatus int
		wantCode   string
		// wantZones is the echoed order; wantAssessments uses "" for null, and
		// wantHistory is the bucket count per echoed zone.
		wantZones       []string
		wantAssessments []string
		wantHistory     []int
		// wantCatalogue counts the zone-catalogue lookups: every requested zone is
		// checked exactly once, and a malformed list is refused before any lookup.
		wantCatalogue int
		wantQuery     bool
	}{
		{
			name:            "two zones are echoed in the caller's order with a null assessment preserved",
			target:          comparisonTarget,
			snapshot:        comparisonFixture(),
			zones:           map[string]bool{"05101": true, "05201": true},
			wantStatus:      200,
			wantZones:       []string{"05101", "05201"},
			wantAssessments: []string{"desconocido", "medio"},
			wantHistory:     []int{1, 0},
			wantCatalogue:   2,
			wantQuery:       true,
		},
		{
			// The caller's order is the comparison axis, not the catalogue's and not
			// storage's: the answer must follow the request.
			name:            "request order is preserved, not sorted",
			target:          "/v1/risk/compare?zone_ids=05201,05101&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&granularity=day",
			snapshot:        comparisonFixture(),
			zones:           map[string]bool{"05101": true, "05201": true},
			wantStatus:      200,
			wantZones:       []string{"05201", "05101"},
			wantAssessments: []string{"medio", "desconocido"},
			wantHistory:     []int{0, 1},
			wantCatalogue:   2,
			wantQuery:       true,
		},
		{
			// Three zones, one of them with no batch at all: S5 keeps the zone in the
			// answer with assessment null instead of dropping it from the comparison.
			name:            "three zones with a zone that has no eligible batch",
			target:          "/v1/risk/compare?zone_ids=05101,05201,05301&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&granularity=day",
			snapshot:        comparisonFixture(),
			zones:           map[string]bool{"05101": true, "05201": true, "05301": true},
			wantStatus:      200,
			wantZones:       []string{"05101", "05201", "05301"},
			wantAssessments: []string{"desconocido", "medio", ""},
			wantHistory:     []int{1, 0, 0},
			wantCatalogue:   3,
			wantQuery:       true,
		},
		{
			// Nothing stored is an answer: both zones keep their position and are
			// served as null assessments with empty histories, never 404.
			name:            "nothing stored is an empty comparison",
			target:          comparisonTarget,
			zones:           map[string]bool{"05101": true, "05201": true},
			wantStatus:      200,
			wantZones:       []string{"05101", "05201"},
			wantAssessments: []string{"", ""},
			wantHistory:     []int{0, 0},
			wantCatalogue:   2,
			wantQuery:       true,
		},
		{
			name:          "unknown zone is refused before the comparison read",
			target:        comparisonTarget,
			snapshot:      comparisonFixture(),
			zones:         map[string]bool{"05101": true},
			wantStatus:    400,
			wantCode:      "invalid_zone",
			wantCatalogue: 2,
		},
		{
			name:          "duplicate zone is refused before any catalogue lookup",
			target:        "/v1/risk/compare?zone_ids=05101,05101&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&granularity=day",
			zones:         map[string]bool{"05101": true},
			wantStatus:    400,
			wantCode:      "invalid_zone",
			wantCatalogue: 0,
		},
		{
			name:          "one zone is refused before storage",
			target:        "/v1/risk/compare?zone_ids=05101&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&granularity=day",
			wantStatus:    400,
			wantCode:      "invalid_comparison_query",
			wantCatalogue: 0,
		},
		{
			name:          "four zones are refused before storage",
			target:        "/v1/risk/compare?zone_ids=05101,05201,05301,05401&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&granularity=day",
			wantStatus:    400,
			wantCode:      "invalid_comparison_query",
			wantCatalogue: 0,
		},
		{
			name:          "unknown parameter is refused before storage",
			target:        comparisonTarget + "&limit=10",
			wantStatus:    400,
			wantCode:      "invalid_comparison_query",
			wantCatalogue: 0,
		},
		{
			name:          "malformed query is refused before storage",
			target:        "/v1/risk/compare?zone_ids=05101,05201&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z",
			wantStatus:    400,
			wantCode:      "invalid_comparison_query",
			wantCatalogue: 0,
		},
		{
			name:          "window over the cap is refused before storage",
			target:        "/v1/risk/compare?zone_ids=05101,05201&from=2026-11-01T00:00:00Z&to=2026-11-03T00:00:01Z&granularity=hour",
			wantStatus:    400,
			wantCode:      "invalid_comparison_query",
			wantCatalogue: 0,
		},
		{
			name:          "an unreadable query encoding is refused",
			target:        "/v1/risk/compare?zone_ids=%zz&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&granularity=day",
			wantStatus:    400,
			wantCode:      "invalid_comparison_query",
			wantCatalogue: 0,
		},
		{
			name:          "catalogue failure is a storage failure",
			target:        comparisonTarget,
			zoneErr:       errors.New("storage unavailable"),
			wantStatus:    503,
			wantCode:      "storage_unavailable",
			wantCatalogue: 1,
		},
		{
			name:          "read failure is a storage failure",
			target:        comparisonTarget,
			compareErr:    errors.New("storage unavailable"),
			zones:         map[string]bool{"05101": true, "05201": true},
			wantStatus:    503,
			wantCode:      "storage_unavailable",
			wantCatalogue: 2,
			wantQuery:     true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			zones := tc.zones
			if zones == nil {
				zones = map[string]bool{}
			}
			store := &fakeStore{comparison: tc.snapshot, compareErr: tc.compareErr, zoneErr: tc.zoneErr, zones: zones}
			handler, token := authorizedServer(t, "viewer", store)
			w := getZones(t, handler, token, tc.target)
			if w.Code != tc.wantStatus {
				t.Fatalf("got %d want %d: %s", w.Code, tc.wantStatus, w.Body.String())
			}
			// One snapshot read, never one read per zone: a three-zone comparison is
			// one statement, not three round trips.
			if store.calls != 0 || store.aggregateCall != 0 || store.seriesCalls != 0 {
				t.Fatalf("the comparison used a sibling read: list=%d aggregate=%d series=%d", store.calls, store.aggregateCall, store.seriesCalls)
			}
			if got := boolInt(tc.wantQuery); store.compareCalls != got {
				t.Fatalf("comparison reads = %d, want %d", store.compareCalls, got)
			}
			if store.zoneCalls != tc.wantCatalogue {
				t.Fatalf("catalogue lookups = %d, want %d", store.zoneCalls, tc.wantCatalogue)
			}
			if tc.wantStatus != 200 {
				if !strings.Contains(w.Body.String(), `"code":"`+tc.wantCode+`"`) {
					t.Fatalf("unexpected failure body: %s", w.Body.String())
				}
				// A refusal is not a comparison document: the caller must not parse one.
				if strings.Contains(w.Body.String(), `"zones"`) {
					t.Fatalf("a refused request answered a comparison document: %s", w.Body.String())
				}
				return
			}
			var body comparisonCollection
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatalf("response is not JSON: %v: %s", err, w.Body.String())
			}
			if body.Granularity != repository.HistoryDaily {
				t.Fatalf("granularity = %q, want day", body.Granularity)
			}
			if !body.From.Equal(time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)) || !body.To.Equal(time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC)) {
				t.Fatalf("window echoed as [%s,%s)", body.From, body.To)
			}
			if len(body.Zones) != len(tc.wantZones) {
				t.Fatalf("got %d zones want %d: %s", len(body.Zones), len(tc.wantZones), w.Body.String())
			}
			for index, zoneID := range tc.wantZones {
				zone := body.Zones[index]
				if zone.ZoneID != zoneID {
					t.Fatalf("zone %d is %q, want the requested %q", index, zone.ZoneID, zoneID)
				}
				switch want := tc.wantAssessments[index]; want {
				case "":
					// A zone with no eligible batch is JSON null, not an invented level
					// and not an omitted member.
					if zone.Assessment != nil {
						t.Fatalf("zone %q answered assessment %+v, want null", zoneID, zone.Assessment)
					}
				default:
					if zone.Assessment == nil {
						t.Fatalf("zone %q answered a null assessment, want %q", zoneID, want)
					}
					if zone.Assessment.RiskLevel != want {
						t.Fatalf("zone %q risk_level = %q, want %q", zoneID, zone.Assessment.RiskLevel, want)
					}
					if zone.Assessment.RequestedAt.IsZero() || zone.Assessment.PublishedAt.IsZero() {
						t.Fatalf("zone %q lost the assessment's own dates: %+v", zoneID, zone.Assessment)
					}
					// The factors travel verbatim, so the comparison shows what produced
					// the level instead of recomputing it now.
					if len(zone.Assessment.Factors) == 0 || zone.Assessment.Factors[0] != '[' {
						t.Fatalf("zone %q factors = %s, want the stored array", zoneID, zone.Assessment.Factors)
					}
				}
				if len(zone.History) != tc.wantHistory[index] {
					t.Fatalf("zone %q answered %d buckets, want %d", zoneID, len(zone.History), tc.wantHistory[index])
				}
			}
			// S5: a zone that published outside the window keeps its previous
			// assessment with its own date, and the answer says when that was.
			if len(tc.snapshot.Assessments) > 0 && !strings.Contains(w.Body.String(), `"requested_at":"2026-10-30T09:00:00Z"`) {
				t.Fatalf("the pre-window assessment lost its own date: %s", w.Body.String())
			}
			// S2/S4: there is no priority axis until PM-11 exists, and no freshness is
			// derived for either half of the comparison.
			for _, absent := range []string{`"priority"`, `"data_status"`, `"notice"`, `"valid_until"`, `"rationale"`, `"policy"`, `"geometry"`} {
				if strings.Contains(w.Body.String(), absent) {
					t.Fatalf("the comparison body carries %s: %s", absent, w.Body.String())
				}
			}
			// An empty history is an empty array, never JSON null.
			if tc.wantHistory[0] == 0 && !strings.Contains(w.Body.String(), `"history":[]`) {
				t.Fatalf("an empty history is not an empty array: %s", w.Body.String())
			}
			// The stored level travels verbatim, including desconocido: the comparison
			// distinguishes "insufficient inputs" from "no assessment".
			if len(tc.snapshot.Assessments) > 0 && !strings.Contains(w.Body.String(), `"risk_level":"desconocido"`) {
				t.Fatalf("the fixture's desconocido assessment is missing: %s", w.Body.String())
			}
		})
	}
}

// TestComparisonIsOneReadOfTheValidatedList proves the handler passed the
// validated question down instead of re-deriving it: the zone list keeps the
// caller's order, and the window and granularity reach storage as accepted.
func TestComparisonIsOneReadOfTheValidatedList(t *testing.T) {
	store := &fakeStore{comparison: comparisonFixture(), zones: map[string]bool{"05101": true, "05201": true, "05301": true}}
	handler, token := authorizedServer(t, "viewer", store)
	target := "/v1/risk/compare?zone_ids=05301,05101,05201&from=2026-10-25T00:00:00Z&to=2026-11-01T00:00:00Z&granularity=week"
	if w := getZones(t, handler, token, target); w.Code != 200 {
		t.Fatalf("got %d want 200: %s", w.Code, w.Body.String())
	}
	if len(store.compareQueries) != 1 {
		t.Fatalf("storage was asked %d times, want exactly 1", len(store.compareQueries))
	}
	query := store.compareQueries[0]
	if len(query.ZoneIDs) != 3 || query.ZoneIDs[0] != "05301" || query.ZoneIDs[1] != "05101" || query.ZoneIDs[2] != "05201" {
		t.Fatalf("storage was asked the zones %v, want the caller's order", query.ZoneIDs)
	}
	if query.Granularity != repository.HistoryWeekly {
		t.Fatalf("storage was asked granularity %q, want week", query.Granularity)
	}
	if !query.From.Equal(time.Date(2026, 10, 25, 0, 0, 0, 0, time.UTC)) || !query.To.Equal(time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("storage was asked the window [%s,%s)", query.From, query.To)
	}
}

// TestComparisonRefusesHeadWithoutReading pins the HEAD contract: a HEAD is 405
// with the allowed method and no read at all, because ServeMux would otherwise run
// the GET handler outside the audited read path.
func TestComparisonRefusesHeadWithoutReading(t *testing.T) {
	store := &fakeStore{comparison: comparisonFixture()}
	handler, token := authorizedServer(t, "viewer", store)
	r := httptest.NewRequest(http.MethodHead, comparisonTarget, nil)
	r.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != "GET" ||
		store.zoneCalls != 0 || store.compareCalls != 0 {
		t.Fatalf("status=%d Allow=%q zone reads=%d comparison reads=%d", w.Code, w.Header().Get("Allow"), store.zoneCalls, store.compareCalls)
	}
}

// TestComparisonIsExactPathOnly proves the route is its own exact registration:
// the trailing-slash form is not served by it, so no sibling single-zone read
// gains a zone-list vocabulary by accident.
func TestComparisonIsExactPathOnly(t *testing.T) {
	store := &fakeStore{comparison: comparisonFixture()}
	handler, token := authorizedServer(t, "viewer", store)
	w := getZones(t, handler, token, "/v1/risk/compare/?"+"zone_ids=05101,05201&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&granularity=day")
	if w.Code != http.StatusNotFound {
		t.Fatalf("got %d want 404 for the trailing-slash form: %s", w.Code, w.Body.String())
	}
	if store.zoneCalls != 0 || store.compareCalls != 0 {
		t.Fatalf("an unregistered path reached storage: zone=%d comparison=%d", store.zoneCalls, store.compareCalls)
	}
}

// TestComparisonKeepsTheReadGate pins that the new route is a read like its
// neighbours: the shared bearer gate answers 401 and 403 before storage is
// touched, and an admitted read never writes.
func TestComparisonKeepsTheReadGate(t *testing.T) {
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
			store := &fakeStore{comparison: comparisonFixture(), zones: map[string]bool{"05101": true, "05201": true}}
			handler, token := authorizedServer(t, tc.role, store)
			r := httptest.NewRequest(http.MethodGet, comparisonTarget, nil)
			if tc.withAuth {
				r.Header.Set("Authorization", "Bearer "+token)
			}
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Fatalf("got %d want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if tc.want != 200 && (store.compareCalls != 0 || store.zoneCalls != 0) {
				t.Fatal("a refused request reached storage")
			}
		})
	}
}

// TestComparisonLeavesLegacyReadsUnchanged is the compatibility evidence: adding
// a zone-list read leaves the single-zone reads exactly as they were, and their
// vocabulary did not gain zone_ids. The legacy history route still refuses a
// parameter it does not accept.
func TestComparisonLeavesLegacyReadsUnchanged(t *testing.T) {
	store := &fakeStore{comparison: comparisonFixture(), zones: map[string]bool{"05101": true, "05201": true}}
	handler, token := authorizedServer(t, "viewer", store)
	if w := getZones(t, handler, token, "/v1/risk/history?zone_ids=05101,05201"); w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), `"code":"invalid_zone"`) {
		t.Fatalf("the legacy history accepted a zone list: %d %s", w.Code, w.Body.String())
	}
	if w := getZones(t, handler, token, "/v1/risk/latest?zone_ids=05101,05201"); w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), `"code":"invalid_zone"`) {
		t.Fatalf("the latest read accepted a zone list: %d %s", w.Code, w.Body.String())
	}
	if store.calls != 0 || store.compareCalls != 0 {
		t.Fatalf("a refused legacy read reached storage: list=%d comparison=%d", store.calls, store.compareCalls)
	}
}

// TestComparisonMatchesTheContract validates the wire against the published
// document instead of restating it here, so the OpenAPI file and the handler
// cannot drift. Both the populated answer and the documented 400 are covered.
func TestComparisonMatchesTheContract(t *testing.T) {
	contract := loadContract(t)
	store := &fakeStore{comparison: comparisonFixture(), zones: map[string]bool{"05101": true, "05201": true}}
	handler, token := authorizedServer(t, "viewer", store)
	app := withCorrelationID(handler)
	w := request(t, app, token, comparisonTarget)
	if w.Code != 200 {
		t.Fatalf("got %d want 200: %s", w.Code, w.Body.String())
	}
	assertResponseMatchesContract(t, contract, "/v1/risk/compare", http.MethodGet, w)

	// The partial answer is a contract shape too: the same fixture with no stored
	// batch at all must still validate, because null is a documented member.
	store = &fakeStore{zones: map[string]bool{"05101": true, "05201": true}}
	handler, token = authorizedServer(t, "viewer", store)
	app = withCorrelationID(handler)
	w = request(t, app, token, comparisonTarget)
	if w.Code != 200 {
		t.Fatalf("got %d want 200: %s", w.Code, w.Body.String())
	}
	assertResponseMatchesContract(t, contract, "/v1/risk/compare", http.MethodGet, w)
	if !strings.Contains(w.Body.String(), `"assessment":null`) {
		t.Fatalf("a zone with no eligible batch is not served as null: %s", w.Body.String())
	}

	store = &fakeStore{zones: map[string]bool{"05101": true, "05201": true}}
	handler, token = authorizedServer(t, "viewer", store)
	app = withCorrelationID(handler)
	w = request(t, app, token, "/v1/risk/compare?zone_ids=05101&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&granularity=day")
	if w.Code != 400 {
		t.Fatalf("got %d want 400: %s", w.Code, w.Body.String())
	}
	assertResponseMatchesContract(t, contract, "/v1/risk/compare", http.MethodGet, w)
}
