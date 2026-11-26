package handler

// Query recording for the granular risk history series (PM-04 / S1).
//
// The series is a sibling of the historical risk read: same collection, same
// action (risk.history.read) and the same rule, so a successful series answer is
// never delivered without its audit row. These tests pin that half of the feature
// at the boundary the wire crosses - what is recorded, when, and what the caller
// sees when the record cannot be written - because a route that quietly joined the
// allow-list without this contract would be an unlogged read.
//
// They need no database: the recorder is an interface here, and the insert itself is
// proved by the gateway's query-audit integration tests.

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// seriesQuery is the accepted query of the read. It is repeated verbatim in the
// assertions below because the gateway must forward it untouched: the risk service
// validates from/to/granularity itself, and a proxy that dropped or reordered a
// parameter would turn a documented 400 into a different question.
const seriesQuery = "from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&granularity=day"

func TestGatewayRefusesUnreadableHistorySeriesQuery(t *testing.T) {
	key, verifier := newTokenIssuer(t)
	target, hits := seriesUpstream(t)
	audit := &auditRecorder{}
	gateway := newAuditedGateway(t, verifier, audit, target)
	for _, suffix := range []string{"&zone_id=%zz", "&extra=a;b"} {
		r := httptest.NewRequest(http.MethodGet, "/v1/risk/history/series?"+seriesQuery+suffix, nil)
		r.Header.Set("Authorization", "Bearer "+mintToken(t, key, map[string]any{"sub": "subject-1"}))
		w := httptest.NewRecorder()
		gateway.ServeHTTP(w, r)
		if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), `"code":"invalid_series_query"`) || hits.Load() != 0 || len(audit.snapshot()) != 0 {
			t.Errorf("%s: status=%d body=%s upstream=%d audits=%d", suffix, w.Code, w.Body, hits.Load(), len(audit.snapshot()))
		}
	}
}

// seriesBody is the document the risk service answers for that query: the echoed
// window, one zone and one bucket, with the provenance a series point carries. It
// is served byte for byte by the upstream so a test can prove the gateway did not
// reshape it.
const seriesBody = `{"from":"2026-11-01T00:00:00Z","to":"2026-11-02T00:00:00Z","granularity":"day","series":[{"zone_id":"05101","buckets":[{"bucket_start":"2026-11-01T03:00:00Z","batch_id":"8f1d0a52-7b3c-4a19-9e21-8a1b2c3d4e5f","requested_at":"2026-11-01T12:30:00Z","published_at":"2026-11-01T12:31:00Z","risk_level":"medio","model_version":"academic-rule-v1","synthetic":false}]}]}`

// seriesUpstream serves the series exactly as the risk service does and counts the
// requests that reached it, so a test can prove the read was forwarded once, with
// the query intact, instead of being answered by the gateway.
func seriesUpstream(t *testing.T) (*url.URL, *atomic.Int32) {
	t.Helper()
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.URL.Path != "/v1/risk/history/series" {
			t.Errorf("upstream saw %s, want GET /v1/risk/history/series", r.URL.RequestURI())
		}
		if r.URL.RawQuery != seriesQuery {
			t.Errorf("upstream saw the query %q, want it forwarded verbatim as %q", r.URL.RawQuery, seriesQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(seriesBody))
	}))
	t.Cleanup(server.Close)
	target, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	return target, &hits
}

// seriesSelectionFailureUpstream answers the way the risk service refuses a
// malformed series query, so a test can prove a refused read is forwarded and left
// out of the trail.
func seriesSelectionFailureUpstream(t *testing.T) *url.URL {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"code":"invalid_series_query","request_id":"8f1d0a52-7b3c-4a19-9e21-8a1b2c3d4e5f"}`))
	}))
	t.Cleanup(server.Close)
	target, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	return target
}

// TestQueryRecordingCoversTheHistorySeries is the success half: an authenticated
// series read is one recorded consultation of the historical risk collection,
// recorded after the upstream answered and before the first byte of the body
// reaches the caller, with the document and the forwarded question untouched.
func TestQueryRecordingCoversTheHistorySeries(t *testing.T) {
	key, verifier := newTokenIssuer(t)
	target, hits := seriesUpstream(t)
	recorder := &auditRecorder{}
	probe := &writeProbe{ResponseWriter: httptest.NewRecorder()}
	var writesAtRecord, hitsAtRecord []int
	recorder.atCall = func() {
		writesAtRecord = append(writesAtRecord, probe.writes)
		hitsAtRecord = append(hitsAtRecord, int(hits.Load()))
	}
	request := httptest.NewRequest(http.MethodGet, "/v1/risk/history/series?"+seriesQuery, nil)
	request.Header.Set("Authorization", "Bearer "+mintToken(t, key, map[string]any{"sub": "subject-1", "name": "Demo Admin"}))
	newAuditedGateway(t, verifier, recorder, target).ServeHTTP(probe, request)
	response := probe.ResponseWriter.(*httptest.ResponseRecorder)

	if response.Code != http.StatusOK {
		t.Fatalf("got %d, want 200: %s", response.Code, response.Body)
	}
	// The document is the upstream's, byte for byte: adding the record must not
	// re-encode, truncate or reshape a series.
	if got := response.Body.String(); got != seriesBody {
		t.Fatalf("body = %q, want the upstream's %q", got, seriesBody)
	}
	if got := response.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", got)
	}
	if got := response.Header().Get("Cache-Control"); !headerAllowed(got, "no-store") {
		t.Errorf("Cache-Control = %q, want the no-store directive", got)
	}
	if got := hits.Load(); got != 1 {
		t.Fatalf("the upstream saw %d requests, want exactly 1", got)
	}
	records := recorder.snapshot()
	if len(records) != 1 {
		t.Fatalf("recorded %d queries, want exactly 1", len(records))
	}
	record := records[0]
	// The series is the historical risk read at another granularity, so it carries
	// the action the audit writer already knows instead of a new label.
	if record.Action != "risk.history.read" {
		t.Errorf("action = %q, want risk.history.read", record.Action)
	}
	if record.ActorID != "subject-1" || record.ActorName != "Demo Admin" {
		t.Errorf("actor = %q/%q, want subject-1/Demo Admin", record.ActorID, record.ActorName)
	}
	if got := response.Header().Get("X-Request-ID"); record.TraceID != got || !canonicalUUID.MatchString(record.TraceID) {
		t.Errorf("trace id = %q, want the canonical response header %q", record.TraceID, got)
	}
	// The ordering this feature rests on, observed rather than assumed: the write ran
	// once the upstream had answered and before the response had begun, so a caller
	// never receives a series whose read was not recorded.
	if len(writesAtRecord) != 1 || writesAtRecord[0] != 0 {
		t.Fatalf("response writes at record time = %v, want the record attempted before the response was written", writesAtRecord)
	}
	if len(hitsAtRecord) != 1 || hitsAtRecord[0] != 1 {
		t.Fatalf("upstream hits at record time = %v, want the record attempted after the upstream answered", hitsAtRecord)
	}
	// The record carries no filter from the URL: the window and the granularity the
	// caller asked for are not in the trail.
	encoded, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	for _, leaked := range []string{"granularity", "from=", "2026-11-01", "05101"} {
		if strings.Contains(string(encoded), leaked) {
			t.Errorf("the record carries %q: %s", leaked, encoded)
		}
	}
}

// TestSeriesRecordingFailureAnswersTheDocumentedError is the refusal half, and it is
// what "no writer, no delivery" means at this boundary: when the record cannot be
// written the caller receives the documented JSON 503 storage_unavailable instead of
// the series, so no audited read is ever unlogged.
func TestSeriesRecordingFailureAnswersTheDocumentedError(t *testing.T) {
	contract := loadContract(t)
	key, verifier := newTokenIssuer(t)
	target, hits := seriesUpstream(t)
	recorder := &auditRecorder{err: errors.New("audit store unavailable")}
	request := httptest.NewRequest(http.MethodGet, "/v1/risk/history/series?"+seriesQuery, nil)
	request.Header.Set("Authorization", "Bearer "+mintToken(t, key, map[string]any{"sub": "subject-1", "name": "Demo Admin"}))
	response := httptest.NewRecorder()
	newAuditedGateway(t, verifier, recorder, target).ServeHTTP(response, request)

	if len(recorder.snapshot()) != 1 {
		t.Fatalf("the recorder was called %d times, want exactly 1", len(recorder.snapshot()))
	}
	if got := hits.Load(); got != 1 {
		t.Fatalf("the upstream saw %d requests, want exactly 1", got)
	}
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("got %d, want 503 when the record cannot be written: %s", response.Code, response.Body)
	}
	if got := response.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", got)
	}
	// The series document is not forwarded in any form: the caller cannot parse a
	// read whose record does not exist.
	if strings.Contains(response.Body.String(), `"series"`) || strings.Contains(response.Body.String(), "bucket_start") {
		t.Fatalf("the unrecorded series was written: %s", response.Body)
	}
	requestID := response.Header().Get("X-Request-ID")
	if !canonicalUUID.MatchString(requestID) {
		t.Fatalf("X-Request-ID = %q, want the canonical id", requestID)
	}
	wantBody := `{"code":"storage_unavailable","request_id":"` + requestID + "\"}\n"
	if got := response.Body.String(); got != wantBody {
		t.Fatalf("body = %q, want the existing JSON 503 %q", got, wantBody)
	}
	assertResponseMatchesContract(t, contract, "/v1/risk/history/series", http.MethodGet, response)
}

// TestSeriesIsUnrecordedWithoutAWriterAndUnrecordedWhenRefused pins the two
// remaining cases of the same rule.
//
// A transport-only construction (New, and the two constructors it delegates to)
// installs no writer at all, so nothing is recorded and the document is forwarded
// unchanged: query recording is a decision of the deployment, not a side effect of
// the route. And a failed read is not a read that produced data, so the risk
// service's own 400 is forwarded and left out of the trail - the same rule the
// sibling routes follow for every non-2xx answer.
func TestSeriesIsUnrecordedWithoutAWriterAndUnrecordedWhenRefused(t *testing.T) {
	key, verifier := newTokenIssuer(t)
	token := mintToken(t, key, map[string]any{"sub": "subject-1", "name": "Demo Admin"})

	t.Run("no writer installed", func(t *testing.T) {
		target, hits := seriesUpstream(t)
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodGet, "/v1/risk/history/series?"+seriesQuery, nil)
		request.Header.Set("Authorization", "Bearer "+token)
		New(verifier, target, target, target, allowedOrigin).ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("got %d, want 200: %s", response.Code, response.Body)
		}
		if got := response.Body.String(); got != seriesBody {
			t.Fatalf("body = %q, want the upstream's unchanged document", got)
		}
		if got := hits.Load(); got != 1 {
			t.Fatalf("the upstream saw %d requests, want exactly 1", got)
		}
	})

	t.Run("upstream refused the read", func(t *testing.T) {
		recorder := &auditRecorder{}
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodGet, "/v1/risk/history/series?from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z", nil)
		request.Header.Set("Authorization", "Bearer "+token)
		newAuditedGateway(t, verifier, recorder, seriesSelectionFailureUpstream(t)).ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("got %d, want the upstream's 400: %s", response.Code, response.Body)
		}
		if !strings.Contains(response.Body.String(), `"code":"invalid_series_query"`) {
			t.Fatalf("body = %s, want the service's own refusal forwarded", response.Body)
		}
		if records := recorder.snapshot(); len(records) != 0 {
			t.Fatalf("a refused read recorded %+v; only a confirmed success is a read", records)
		}
	})
}

// TestSeriesRecordingIsBoundedLikeItsNeighbours keeps the deadline rule in view for
// the new route: the record is written under the same bounded, uncancelled budget as
// the sibling reads, so an unavailable audit database cannot hold the caller for
// longer than the documented timeout.
func TestSeriesRecordingIsBoundedLikeItsNeighbours(t *testing.T) {
	key, verifier := newTokenIssuer(t)
	target, _ := seriesUpstream(t)
	recorder := &auditRecorder{}
	request := httptest.NewRequest(http.MethodGet, "/v1/risk/history/series?"+seriesQuery, nil)
	request.Header.Set("Authorization", "Bearer "+mintToken(t, key, map[string]any{"sub": "subject-1"}))
	newAuditedGateway(t, verifier, recorder, target).ServeHTTP(httptest.NewRecorder(), request)
	if recorder.undeadlined {
		t.Fatal("the record ran without a deadline")
	}
	if recorder.deadline <= 0 || recorder.deadline > queryAuditTimeout {
		t.Fatalf("deadline = %v, want a positive budget no larger than %v", recorder.deadline, queryAuditTimeout)
	}
	if got := recorder.deadline; got > 5*time.Second {
		t.Fatalf("deadline = %v, longer than the proxy's own request budget", got)
	}
}
