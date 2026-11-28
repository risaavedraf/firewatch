package handler

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"firewatch.local/risk/internal/repository"
	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/go-jose/go-jose/v4"
)

type fakeStore struct {
	batches       []repository.Batch
	zones         map[string]bool
	zoneErr       error
	calls         int
	zoneCalls     int
	catalogue     []repository.Zone
	listZonesErr  error
	listZonesCall int
	// lastBBox records the bbox the handler passed down, so a test can prove
	// the parsed value reached the repository instead of being dropped.
	lastBBox *repository.BBox
	// Model registry state for the T6 endpoints.
	models      []repository.ModelVersion
	modelsErr   error
	activateErr error
	activated   []string
	// latestPerZone answers the aggregate read, and the counters prove the route
	// asks storage once for every zone instead of once per zone.
	latestPerZone    []repository.Batch
	aggregateErr     error
	aggregateCall    int
	executiveBatches [][]repository.Batch
	executiveErr     error
	executiveCalls   int
	// The executive summary's alert tally. The triple proves the route reads the
	// count once, reports what storage answered, and turns a failed count into 503
	// instead of a zero it did not observe.
	alertCount      int
	alertCountErr   error
	alertCountCalls int
	// Alert timeline state for the PM-08 read route. alertQueries records what the
	// route asked for, so a test can prove the page window and the keyset boundary
	// reached storage instead of being dropped or replaced by defaults.
	alertPage    repository.AlertPage
	alertErr     error
	alertQueries []repository.AlertPageQuery
	// Personal notification state for the PM-08 state routes. stateReads and
	// markWrites record the (alert, subject key) pair the route asked about, so a
	// test can prove the actor came from the verified token and never from the
	// request; alertStates mirrors the append-only monotonic rule closely enough to
	// exercise the no-op answer without a database.
	alertStates   map[string]repository.AlertState
	missingAlerts map[string]bool
	alertStateErr error
	stateReads    []alertStateKey
	markWrites    []alertMarkWrite
	// Granular series state for the PM-04 read route. seriesQueries records the
	// window, granularity and zone the route asked for, and seriesCalls proves the
	// whole territory is answered by one bucketed read instead of one per zone.
	seriesPoints  []repository.HistoryPoint
	seriesErr     error
	seriesCalls   int
	seriesQueries []repository.HistorySeriesQuery
	// Comparison state for the PM-05 read route. compareQueries records the zone
	// list, window and granularity the route asked for, and compareCalls proves the
	// comparison is one read for the whole list instead of one read per zone.
	comparison     repository.ComparisonSnapshot
	compareErr     error
	compareCalls   int
	compareQueries []repository.ComparisonQuery
	// Source review state for the V1-P-05 routes. sourceReviewWrites records what
	// each accepted write asked to append, so a test can prove the actor came from
	// the verified token and never from the body; sourceReviews is the memory store
	// the read serves back, and the two error seams prove both routes fail closed.
	sourceReviews       map[string]repository.SourceReview
	sourceReviewErr     error
	sourceReviewReadErr error
	sourceReviewWrites  []repository.SourceReviewRequest
}

// LatestSourceReviews stands in for the newest-review-per-source read. A store with
// no review yet answers an empty map, which the route serves as the explicit null.
func (s *fakeStore) LatestSourceReviews(context.Context) (map[string]repository.SourceReview, error) {
	if s.sourceReviewReadErr != nil {
		return nil, s.sourceReviewReadErr
	}
	if s.sourceReviews == nil {
		return map[string]repository.SourceReview{}, nil
	}
	return s.sourceReviews, nil
}

// RecordSourceReview appends one review into memory and answers the row it wrote,
// so the route's echo, its latest-per-source read-back and its append-only trace are
// exercised without a database. A refused request stores nothing.
func (s *fakeStore) RecordSourceReview(_ context.Context, request repository.SourceReviewRequest) (repository.SourceReview, error) {
	if s.sourceReviewErr != nil {
		return repository.SourceReview{}, s.sourceReviewErr
	}
	if err := request.Validate(); err != nil {
		return repository.SourceReview{}, err
	}
	s.sourceReviewWrites = append(s.sourceReviewWrites, request)
	review := repository.SourceReview{
		SourceID:   request.SourceID,
		Decision:   request.Decision,
		Note:       request.Note,
		ReviewedBy: request.ReviewedBy,
		ReviewedAt: request.ReviewedAt.UTC(),
	}
	if s.sourceReviews == nil {
		s.sourceReviews = map[string]repository.SourceReview{}
	}
	s.sourceReviews[review.SourceID] = review
	return review, nil
}

func (s *fakeStore) ExecutiveBatches(context.Context) ([][]repository.Batch, error) {
	s.executiveCalls++
	return s.executiveBatches, s.executiveErr
}

func (s *fakeStore) ExecutiveAlertCount(context.Context) (int, error) {
	s.alertCountCalls++
	if s.alertCountErr != nil {
		return 0, s.alertCountErr
	}
	return s.alertCount, nil
}

func (s *fakeStore) ListModels(context.Context) ([]repository.ModelVersion, error) {
	if s.modelsErr != nil {
		return nil, s.modelsErr
	}
	return s.models, nil
}

// ActivateModel records the requested version and returns that version marked
// active, so the handler's success path is exercised without a database.
func (s *fakeStore) ActivateModel(_ context.Context, version string) (repository.ModelVersion, error) {
	s.activated = append(s.activated, version)
	if s.activateErr != nil {
		return repository.ModelVersion{}, s.activateErr
	}
	approved := time.Now().UTC()
	for _, model := range s.models {
		if model.Version == version {
			model.Active = true
			model.ApprovedAt = &approved
			return model, nil
		}
	}
	return repository.ModelVersion{Version: version, Kind: "rule", Active: true, ApprovedAt: &approved, Metrics: []byte("{}")}, nil
}

func (s *fakeStore) List(context.Context, string, int) ([]repository.Batch, error) {
	s.calls++
	return s.batches, nil
}

// LatestPerZone stands in for the single aggregate query so the route's ordering,
// empty state and failure vocabulary are exercised without a database.
func (s *fakeStore) LatestPerZone(context.Context) ([]repository.Batch, error) {
	s.aggregateCall++
	if s.aggregateErr != nil {
		return nil, s.aggregateErr
	}
	return s.latestPerZone, nil
}

// ListAlerts stands in for the timeline read so the route's ordering, empty state,
// navigation and failure vocabulary are exercised without a database.
func (s *fakeStore) ListAlerts(_ context.Context, query repository.AlertPageQuery) (repository.AlertPage, error) {
	s.alertQueries = append(s.alertQueries, query)
	if s.alertErr != nil {
		return repository.AlertPage{}, s.alertErr
	}
	return s.alertPage, nil
}

// alertStateKey is one (alert, subject key) pair the fake was asked about. The
// subject arrives already derived, so a test can assert the raw token subject was
// never handed to storage.
type alertStateKey struct{ AlertID, SubjectKey string }

// alertMarkWrite is one append attempt the fake observed.
type alertMarkWrite struct {
	AlertID    string
	SubjectKey string
	Mark       repository.AlertMark
}

// alertStateMapKey names one personal state in the fake's map.
func alertStateMapKey(alertID, subjectKey string) string { return alertID + "|" + subjectKey }

// ReadAlertState stands in for the personal read: an alert that is not missing
// and carries no mark of this subject is unread with no instant.
func (s *fakeStore) ReadAlertState(_ context.Context, alertID, subjectKey string) (repository.AlertState, error) {
	s.stateReads = append(s.stateReads, alertStateKey{AlertID: alertID, SubjectKey: subjectKey})
	if s.alertStateErr != nil {
		return repository.AlertState{}, s.alertStateErr
	}
	if state, present := s.alertStates[alertStateMapKey(alertID, subjectKey)]; present {
		return state, nil
	}
	if s.missingAlerts[alertID] {
		return repository.AlertState{}, repository.ErrAlertNotFound
	}
	return repository.AlertState{AlertID: alertID, State: repository.AlertStateUnread}, nil
}

// MarkAlertState stands in for the append-only write with the same monotonic rule
// the real store enforces: a mark at or below the current rank appends nothing and
// answers the current state, so a replay never rewrites the instant.
func (s *fakeStore) MarkAlertState(_ context.Context, alertID, subjectKey string, mark repository.AlertMark) (repository.AlertState, error) {
	s.markWrites = append(s.markWrites, alertMarkWrite{AlertID: alertID, SubjectKey: subjectKey, Mark: mark})
	if s.alertStateErr != nil {
		return repository.AlertState{}, s.alertStateErr
	}
	if s.missingAlerts[alertID] {
		return repository.AlertState{}, repository.ErrAlertNotFound
	}
	current, present := s.alertStates[alertStateMapKey(alertID, subjectKey)]
	if !present {
		current = repository.AlertState{AlertID: alertID, State: repository.AlertStateUnread}
	}
	if current.State != repository.AlertStateUnread && repository.AlertMark(current.State).Rank() >= mark.Rank() {
		return current, nil
	}
	if s.alertStates == nil {
		s.alertStates = map[string]repository.AlertState{}
	}
	instant := time.Now().UTC()
	marked := repository.AlertState{AlertID: alertID, State: string(mark), MarkedAt: &instant}
	s.alertStates[alertStateMapKey(alertID, subjectKey)] = marked
	return marked, nil
}

// ZoneExists stands in for the zones catalogue so the handler path that decides
// membership is exercised without a database.
func (s *fakeStore) ZoneExists(_ context.Context, code string) (bool, error) {
	s.zoneCalls++
	if s.zoneErr != nil {
		return false, s.zoneErr
	}
	return s.zones[code], nil
}

func (s *fakeStore) ListZones(_ context.Context, bbox *repository.BBox) ([]repository.Zone, error) {
	s.listZonesCall++
	s.lastBBox = bbox
	if s.listZonesErr != nil {
		return nil, s.listZonesErr
	}
	return s.catalogue, nil
}

func TestStatusAuthorization(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	signer, _ := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key}, nil)
	verifier := oidc.NewVerifier("https://issuer.test", &oidc.StaticKeySet{PublicKeys: []crypto.PublicKey{&key.PublicKey}}, &oidc.Config{ClientID: "firewatch-api"})
	for _, tc := range []struct {
		role string
		want int
	}{{"", 401}, {"invalid", 401}, {"operator", 403}, {"viewer", 200}, {"admin", 200}} {
		t.Run(tc.role, func(t *testing.T) {
			calls := 0
			ready := true
			check := func(context.Context) Status {
				calls++
				now := time.Now().UTC()
				depth, age := int64(0), float64(0)
				return Status{CheckedAt: now, Ready: ready, Dependencies: Dependencies{Database: Dependency{"ready"}, Broker: Dependency{"ready"}, DeadLetter: DeadLetterStatus{State: "ready", Depth: &depth, SampledAt: &now, AgeSeconds: &age, MaxAgeSeconds: &age, MaxDepth: &depth}}}
			}
			h := NewWithStatus(&fakeStore{}, verifier, check)
			r := httptest.NewRequest("GET", "/v1/risk/status", nil)
			if tc.role != "" {
				payload, _ := json.Marshal(map[string]any{"iss": "https://issuer.test", "aud": "firewatch-api", "sub": "user", "exp": time.Now().Add(time.Hour).Unix(), "typ": "Bearer", "realm_access": map[string]any{"roles": []string{tc.role}}})
				signed, _ := signer.Sign(payload)
				raw, _ := signed.CompactSerialize()
				if tc.role == "invalid" {
					raw = "invalid"
				}
				r.Header.Set("Authorization", "Bearer "+raw)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.want || (calls == 1) != (tc.want == 200) {
				t.Fatalf("code=%d calls=%d body=%s", w.Code, calls, w.Body)
			}
			if tc.want == 200 {
				var got Status
				if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
					t.Fatal(err)
				}
				if got.CheckedAt.IsZero() || got.Dependencies.DeadLetter.Depth == nil || got.Dependencies.DeadLetter.SampledAt == nil || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Content-Type") != "application/json" {
					t.Fatalf("ready wire: %s", w.Body)
				}
				ready = false
				w = httptest.NewRecorder()
				h.ServeHTTP(w, r)
				if w.Code != 503 || !strings.Contains(w.Body.String(), `"ready":false`) {
					t.Fatalf("degraded wire: %s", w.Body)
				}
				w = httptest.NewRecorder()
				NewWithStatus(&fakeStore{}, verifier, nil).ServeHTTP(w, r)
				var s Status
				if err := json.Unmarshal(w.Body.Bytes(), &s); err != nil {
					t.Fatal(err)
				}
				for _, field := range []string{"depth", "sampled_at", "age_seconds", "max_age_seconds", "max_depth"} {
					if !strings.Contains(w.Body.String(), `"`+field+`":null`) {
						t.Fatalf("missing nullable %s: %s", field, w.Body)
					}
				}
				if w.Code != 503 || s.Reason != "status_unavailable" || s.Dependencies.Database.State != "unknown" || s.Dependencies.DeadLetter.MaxDepth != nil || s.CheckedAt.IsZero() || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Content-Type") != "application/json" {
					t.Fatalf("unavailable: %s", w.Body)
				}
			}
		})
	}
}

func TestReadAccessAndInsufficientData(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key}, nil)
	if err != nil {
		t.Fatal(err)
	}
	verifier := oidc.NewVerifier("https://issuer.test", &oidc.StaticKeySet{PublicKeys: []crypto.PublicKey{&key.PublicKey}}, &oidc.Config{ClientID: "firewatch-api"})
	for _, tc := range []struct {
		name    string
		role    string
		query   string
		want    int
		data    bool
		zones   map[string]bool
		zoneErr error
	}{
		{"viewer can read", "viewer", "zone_id=valparaiso-demo", 200, true, nil, nil},
		{"admin can read", "admin", "zone_id=valparaiso-demo", 200, true, nil, nil},
		{"missing batches explicit", "viewer", "zone_id=valparaiso-demo", 404, false, nil, nil},
		{"unknown role denied", "other", "zone_id=valparaiso-demo", 403, true, nil, nil},
		// A zone absent from the catalogue is rejected with invalid_zone. The
		// handler asks ZoneExists instead of comparing to a literal, so the
		// accepted set is whatever the catalogue holds.
		{"unknown zone denied", "viewer", "zone_id=other", 400, true, nil, nil},
		// A real commune code (as seeded from the geographic asset) is accepted
		// once the catalogue holds it, proving the hardcoded demo literal is gone.
		{"known catalogue code read", "viewer", "zone_id=05101", 200, true, map[string]bool{"05101": true}, nil},
		{"duplicate parameter denied", "viewer", "zone_id=valparaiso-demo&zone_id=other", 400, true, nil, nil},
		{"missing zone parameter denied", "viewer", "", 400, true, nil, nil},
		// A catalogue failure must surface as storage_unavailable, never as an
		// unknown zone: the two mean different things to a client.
		{"catalogue lookup fails", "viewer", "zone_id=valparaiso-demo", 503, true, nil, errors.New("storage unavailable")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			payload, _ := json.Marshal(map[string]any{"iss": "https://issuer.test", "aud": "firewatch-api", "sub": "subject", "exp": time.Now().Add(time.Minute).Unix(), "typ": "Bearer", "realm_access": map[string]any{"roles": []string{tc.role}}})
			signed, _ := signer.Sign(payload)
			token, _ := signed.CompactSerialize()
			r := httptest.NewRequest("GET", "/v1/risk/latest?"+tc.query, nil)
			r.Header.Set("Authorization", "Bearer "+token)
			zones := tc.zones
			if zones == nil {
				zones = map[string]bool{"valparaiso-demo": true}
			}
			store := &fakeStore{zones: zones, zoneErr: tc.zoneErr}
			if tc.data {
				store.batches = []repository.Batch{{Demo: true, RiskLevel: "desconocido", DataStatus: "current"}}
			}
			w := httptest.NewRecorder()
			New(store, verifier).ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Fatalf("got %d want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if tc.want == 403 && (store.calls != 0 || store.zoneCalls != 0) {
				t.Fatal("unauthorized repository call")
			}
		})
	}
}

// authorizedServer builds the real handler over a store and returns it with a
// signed token for role. The verifier and the token share one generated key, so
// the zones route is exercised through the same authorization as production.
func authorizedServer(t *testing.T, role string, store Repository, providers ...DescriptorProvider) (http.Handler, string) {
	t.Helper()
	return authorizedServerWith(t, role, store, nil, providers...)
}

// authorizedServerWith is the full harness: it also wires the cycle runner, so
// the freshness route and the manual trigger are exercised through the same
// authorization as production. Its verified subject is the fixed "subject" the
// existing tests assume; a personal-state test uses authorizedServerWithSubject.
func authorizedServerWith(t *testing.T, role string, store Repository, runner CycleRunner, providers ...DescriptorProvider) (http.Handler, string) {
	t.Helper()
	return authorizedServerSubjectWith(t, role, "subject", store, runner, providers...)
}

// authorizedServerWithSubject is authorizedServerWith with a verified token
// subject chosen by the test, so the personal state routes can prove that two
// callers see different marks without either naming an actor in the request.
func authorizedServerWithSubject(t *testing.T, role, subject string, store Repository, providers ...DescriptorProvider) (http.Handler, string) {
	t.Helper()
	return authorizedServerSubjectWith(t, role, subject, store, nil, providers...)
}

// authorizedServerSubjectWith signs one token with the given verified subject and
// role and wraps the real handler in the production authorization gate.
func authorizedServerSubjectWith(t *testing.T, role, subject string, store Repository, runner CycleRunner, providers ...DescriptorProvider) (http.Handler, string) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key}, nil)
	if err != nil {
		t.Fatal(err)
	}
	verifier := oidc.NewVerifier("https://issuer.test", &oidc.StaticKeySet{PublicKeys: []crypto.PublicKey{&key.PublicKey}}, &oidc.Config{ClientID: "firewatch-api"})
	payload, _ := json.Marshal(map[string]any{"iss": "https://issuer.test", "aud": "firewatch-api", "sub": subject, "exp": time.Now().Add(time.Minute).Unix(), "typ": "Bearer", "realm_access": map[string]any{"roles": []string{role}}})
	signed, err := signer.Sign(payload)
	if err != nil {
		t.Fatal(err)
	}
	token, err := signed.CompactSerialize()
	if err != nil {
		t.Fatal(err)
	}
	return NewWithCycle(store, verifier, nil, runner, providers...), token
}

// TestBatchesEndpoint pins the aggregate read the map needs on load: every zone's
// newest published batch in one answer, ordered by zone_id, an empty array when
// nothing is published, and the same storage_unavailable vocabulary its
// neighbouring read routes use.
func TestBatchesEndpoint(t *testing.T) {
	for _, tc := range []struct {
		name string
		// stored is what storage answered, deliberately in the order a set of
		// zones was published in rather than in response order.
		stored      []repository.Batch
		storageErr  error
		wantStatus  int
		wantZones   []string
		wantNoZone  string
		wantEmpty   bool
		wantNoGeo   bool
		wantStore   int
		wantPerZone int
	}{
		{
			name: "every zone ordered by zone_id",
			stored: []repository.Batch{
				{ID: "b-1", ZoneID: "valparaiso-demo", RiskLevel: "bajo", DataStatus: "current", Demo: true},
				{ID: "b-2", ZoneID: "05201", RiskLevel: "medio", DataStatus: "stale", Demo: false},
				{ID: "b-3", ZoneID: "05101", RiskLevel: "alto", DataStatus: "current", Demo: false},
			},
			wantStatus: 200,
			wantZones:  []string{"05101", "05201", "valparaiso-demo"},
			wantNoGeo:  true,
			wantStore:  1,
		},
		{
			name:       "nothing published is an empty array",
			stored:     nil,
			wantStatus: 200,
			wantEmpty:  true,
			wantStore:  1,
		},
		{
			name:        "storage failure is storage_unavailable",
			storageErr:  errors.New("storage unavailable"),
			wantStatus:  503,
			wantStore:   1,
			wantPerZone: 0,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &fakeStore{latestPerZone: tc.stored, aggregateErr: tc.storageErr}
			handler, token := authorizedServer(t, "viewer", store)
			w := getZones(t, handler, token, "/v1/risk/batches")
			if w.Code != tc.wantStatus {
				t.Fatalf("got %d want %d: %s", w.Code, tc.wantStatus, w.Body.String())
			}
			// One aggregate query, never one query per zone: a fan-out of 38 reads is
			// what this route exists to avoid.
			if store.aggregateCall != tc.wantStore || store.calls != tc.wantPerZone {
				t.Fatalf("aggregate calls=%d per-zone calls=%d, want %d and %d", store.aggregateCall, store.calls, tc.wantStore, tc.wantPerZone)
			}
			if tc.wantStatus != 200 {
				if !strings.Contains(w.Body.String(), `"code":"storage_unavailable"`) {
					t.Fatalf("unexpected failure body: %s", w.Body.String())
				}
				return
			}
			var body struct {
				Batches []repository.Batch `json:"batches"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatalf("response is not JSON: %v: %s", err, w.Body.String())
			}
			if tc.wantEmpty {
				// An empty publication state is an answer, not a 404 and not null.
				if !strings.Contains(w.Body.String(), `"batches":[]`) {
					t.Fatalf("empty aggregate is not an empty array: %s", w.Body.String())
				}
				return
			}
			got := make([]string, 0, len(body.Batches))
			for _, batch := range body.Batches {
				got = append(got, batch.ZoneID)
			}
			if len(got) != len(tc.wantZones) {
				t.Fatalf("zones %v want %v: %s", got, tc.wantZones, w.Body.String())
			}
			for index, zone := range tc.wantZones {
				if got[index] != zone {
					t.Fatalf("zones %v want %v", got, tc.wantZones)
				}
			}
			if tc.wantNoGeo && strings.Contains(w.Body.String(), `"geometry"`) {
				t.Fatalf("the aggregate repeats the catalogue geometry: %s", w.Body.String())
			}
		})
	}
}

// TestBatchesEndpointKeepsTheReadVerificationPath pins that the aggregate route
// is a read like every other one: the shared bearer gate answers 401 and 403
// before storage is touched, and an admitted read never mutates.
func TestBatchesEndpointKeepsTheReadVerificationPath(t *testing.T) {
	for _, tc := range []struct {
		name  string
		role  string
		want  int
		store *fakeStore
	}{
		{"anonymous is refused", "", 401, &fakeStore{}},
		{"a role outside the read gate is forbidden", "operator", 403, &fakeStore{latestPerZone: []repository.Batch{{ID: "b-1", ZoneID: "05101"}}}},
		{"viewer reads", "viewer", 200, &fakeStore{latestPerZone: []repository.Batch{{ID: "b-1", ZoneID: "05101"}}}},
		{"admin reads", "admin", 200, &fakeStore{latestPerZone: []repository.Batch{{ID: "b-1", ZoneID: "05101"}}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			handler, token := authorizedServer(t, tc.role, tc.store)
			r := httptest.NewRequest("GET", "/v1/risk/batches", nil)
			if tc.role != "" {
				r.Header.Set("Authorization", "Bearer "+token)
			}
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Fatalf("got %d want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if tc.want != 200 && tc.store.aggregateCall != 0 {
				t.Fatal("a refused request reached storage")
			}
		})
	}
}

func getZones(t *testing.T, handler http.Handler, token, target string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest("GET", target, nil)
	r.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

// TestParseBBox pins the pure validation table. Clamping is deliberately not
// offered: a box that was silently repaired would answer a question the caller
// did not ask.
func TestParseBBox(t *testing.T) {
	for _, tc := range []struct {
		name    string
		raw     string
		wantErr bool
		want    *repository.BBox
	}{
		{"valid box", "-72,-33.5,-70.5,-32", false, &repository.BBox{MinLon: -72, MinLat: -33.5, MaxLon: -70.5, MaxLat: -32}},
		{"empty value", "", true, nil},
		{"three parts", "-72,-33.5,-70.5", true, nil},
		{"five parts", "-72,-33.5,-70.5,-32,0", true, nil},
		{"non numeric", "-72,oops,-70.5,-32", true, nil},
		{"NaN", "-72,NaN,-70.5,-32", true, nil},
		{"positive infinity", "-72,-33.5,-70.5,+Inf", true, nil},
		{"negative infinity", "-Inf,-33.5,-70.5,-32", true, nil},
		{"longitude too low", "-181,-33.5,-70.5,-32", true, nil},
		{"longitude too high", "-72,-33.5,181,-32", true, nil},
		{"latitude too low", "-72,-91,-70.5,-32", true, nil},
		{"latitude too high", "-72,-33.5,-70.5,91", true, nil},
		{"minimum equals maximum longitude", "-72,-33.5,-72,-32", true, nil},
		{"minimum equals maximum latitude", "-72,-33.5,-70.5,-33.5", true, nil},
		{"minimum above maximum", "-70.5,-32,-72,-33.5", true, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseBBox(tc.raw)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("parseBBox(%q) = %+v, want an error", tc.raw, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseBBox(%q): %v", tc.raw, err)
			}
			if *got != *tc.want {
				t.Fatalf("parseBBox(%q) = %+v, want %+v", tc.raw, *got, *tc.want)
			}
		})
	}
}

func TestZonesEndpoint(t *testing.T) {
	catalogue := []repository.Zone{
		{Code: "05101", Name: "Valparaiso", Province: "Valparaiso", Kind: "comuna", Geometry: json.RawMessage(`{"type":"Polygon","coordinates":[[[-71.6,-33.0],[-71.5,-33.0],[-71.5,-33.1],[-71.6,-33.0]]]}`)},
		{Code: "05201", Name: "Isla de Pascua", Province: "Isla de Pascua", Kind: "comuna", Geometry: json.RawMessage(`{"type":"MultiPolygon","coordinates":[[[[-109.4,-27.1],[-109.3,-27.1],[-109.3,-27.2],[-109.4,-27.1]]]]}`)},
	}
	for _, tc := range []struct {
		name       string
		target     string
		catalogue  []repository.Zone
		listErr    error
		wantStatus int
		wantCount  int
		wantBBox   bool
	}{
		{"full catalogue without bbox", "/v1/risk/zones", catalogue, nil, 200, 2, false},
		{"bbox that matches nothing", "/v1/risk/zones?bbox=10,10,20,20", nil, nil, 200, 0, true},
		{"valid bbox", "/v1/risk/zones?bbox=-72,-34,-70,-32", catalogue, nil, 200, 2, true},
		{"invalid bbox", "/v1/risk/zones?bbox=-72", nil, nil, 400, 0, false},
		{"unknown parameter", "/v1/risk/zones?zone_id=05101", nil, nil, 400, 0, false},
		{"repeated bbox", "/v1/risk/zones?bbox=-72,-34,-70,-32&bbox=10,10,20,20", nil, nil, 400, 0, false},
		{"catalogue without geometry", "/v1/risk/zones", nil, nil, 200, 0, false},
		{"storage error", "/v1/risk/zones", nil, errors.New("storage unavailable"), 503, 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &fakeStore{catalogue: tc.catalogue, listZonesErr: tc.listErr}
			handler, token := authorizedServer(t, "viewer", store)
			w := getZones(t, handler, token, tc.target)
			if w.Code != tc.wantStatus {
				t.Fatalf("got %d want %d: %s", w.Code, tc.wantStatus, w.Body.String())
			}
			if tc.wantStatus != 200 {
				// A malformed request is rejected before it reaches storage. A
				// 503 is the opposite case: the read was attempted and failed.
				if tc.wantStatus == 400 && store.listZonesCall != 0 {
					t.Fatal("a malformed request reached the repository")
				}
				return
			}
			// A geometry re-encoded as a string would appear like this; RFC 7946
			// requires an object.
			if strings.Contains(w.Body.String(), `"geometry":"`) {
				t.Fatalf("geometry was serialised as a string: %s", w.Body.String())
			}
			var collection struct {
				Type     string `json:"type"`
				Features []struct {
					Type       string          `json:"type"`
					Properties json.RawMessage `json:"properties"`
					Geometry   json.RawMessage `json:"geometry"`
				} `json:"features"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &collection); err != nil {
				t.Fatalf("response is not JSON: %v: %s", err, w.Body.String())
			}
			if collection.Type != "FeatureCollection" {
				t.Fatalf("type is %q, want FeatureCollection", collection.Type)
			}
			if len(collection.Features) != tc.wantCount {
				t.Fatalf("got %d features want %d: %s", len(collection.Features), tc.wantCount, w.Body.String())
			}
			for _, feature := range collection.Features {
				if feature.Type != "Feature" {
					t.Fatalf("feature type is %q, want Feature", feature.Type)
				}
				if len(feature.Properties) == 0 || string(feature.Properties) == "null" {
					t.Fatal("feature has no properties")
				}
				if len(feature.Geometry) == 0 || feature.Geometry[0] != '{' {
					t.Fatalf("geometry is not an object: %s", feature.Geometry)
				}
			}
			if tc.wantCount == 0 && !strings.Contains(w.Body.String(), `"features":[]`) {
				t.Fatalf("empty collection is not an empty array: %s", w.Body.String())
			}
			if (store.lastBBox != nil) != tc.wantBBox {
				t.Fatalf("bbox passed down = %+v, want present=%v", store.lastBBox, tc.wantBBox)
			}
		})
	}
}
