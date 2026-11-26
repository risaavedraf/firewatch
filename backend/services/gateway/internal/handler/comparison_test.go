package handler

// Query recording for the multi-zone comparison (PM-05 / S6).
//
// The comparison asks several zones at one shared cutoff, so S6 gives it a named
// audit action of its own: risk.compare.read. These tests pin the gateway half at
// the boundary the wire crosses - the exact path and method selected, one record
// per successful request, the frozen fail-closed behaviour when the record cannot
// be written, and the raw-query refusal that must happen here because
// httputil.ReverseProxy sanitises the query it forwards.
//
// They need no database: the recorder is an interface here, and the insert itself
// is proved by the jobs module's writer tests.

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
)

// comparisonQuery is the accepted query of the read. It is repeated verbatim in
// the assertions below because the gateway must forward it untouched: the risk
// service validates the zone list, window and granularity itself, and a proxy
// that dropped or reordered a pair would turn a documented 400 into a different
// comparison.
const comparisonQuery = "zone_ids=05101,05201&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&granularity=day"

// comparisonBody is the document the risk service answers for that query: two
// requested zones in request order, one assessed and one with no eligible batch,
// plus PM-04 history buckets in the assessed zone. It is served byte for byte by
// the upstream so a test can prove the gateway did not reshape it.
const comparisonBody = `{"from":"2026-11-01T00:00:00Z","to":"2026-11-02T00:00:00Z","granularity":"day","zones":[{"zone_id":"05101","assessment":{"batch_id":"8f1d0a52-7b3c-4a19-9e21-8a1b2c3d4e5f","requested_at":"2026-10-30T09:00:00Z","published_at":"2026-10-30T09:01:00Z","risk_level":"alto","factors":[{"name":"temperatura","known":true,"value":32,"contribution":0.85,"note":"lectura de alta temperatura"}],"model_version":"academic-rule-v1","synthetic":false},"history":[{"bucket_start":"2026-11-01T03:00:00Z","batch_id":"0f0a0e4e-4b3c-4f8e-9a1d-6c2b8d5e7a90","requested_at":"2026-11-01T12:30:00Z","published_at":"2026-11-01T12:31:00Z","risk_level":"desconocido","model_version":"demo-fixture-v1","synthetic":true}]},{"zone_id":"05201","assessment":null,"history":[]}]}`

// comparisonUpstream serves the comparison exactly as the risk service does and
// counts the requests that reached it, so a test can prove the read was forwarded
// once, with the query intact, instead of being answered by the gateway.
func comparisonUpstream(t *testing.T) (*url.URL, *atomic.Int32) {
	t.Helper()
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.URL.Path != "/v1/risk/compare" {
			t.Errorf("upstream saw %s, want GET /v1/risk/compare", r.URL.RequestURI())
		}
		if r.URL.RawQuery != comparisonQuery {
			t.Errorf("upstream saw the query %q, want it forwarded verbatim as %q", r.URL.RawQuery, comparisonQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(comparisonBody))
	}))
	t.Cleanup(server.Close)
	target, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	return target, &hits
}

// TestGatewayRefusesUnreadableComparisonQuery is the boundary rule of S1: the
// comparison accepts a comma-separated list, so a pair the gateway cannot decode
// must be refused here. httputil.ReverseProxy sanitises the forwarded query and
// drops such a pair, which would turn `zone_ids=05101,%zz` into a different,
// smaller comparison that the risk service would happily answer. The exact path
// is refused before the proxy runs, with no upstream hit and no audit row.
func TestGatewayRefusesUnreadableComparisonQuery(t *testing.T) {
	key, verifier := newTokenIssuer(t)
	target, hits := comparisonUpstream(t)
	audit := &auditRecorder{}
	gateway := newAuditedGateway(t, verifier, audit, target)
	for _, suffix := range []string{"&zone_ids=%zz", "&extra=a;b"} {
		r := httptest.NewRequest(http.MethodGet, "/v1/risk/compare?"+comparisonQuery+suffix, nil)
		r.Header.Set("Authorization", "Bearer "+mintToken(t, key, map[string]any{"sub": "subject-1"}))
		w := httptest.NewRecorder()
		gateway.ServeHTTP(w, r)
		if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), `"code":"invalid_comparison_query"`) || hits.Load() != 0 || len(audit.snapshot()) != 0 {
			t.Errorf("%s: status=%d body=%s upstream=%d audits=%d", suffix, w.Code, w.Body, hits.Load(), len(audit.snapshot()))
		}
	}
}

// TestQueryRecordingCoversTheComparison is the success half: an authenticated
// comparison is one recorded consultation of the comparison under its own named
// action, recorded after the upstream answered and before the first byte of the
// body reaches the caller, with the document and the forwarded question untouched.
func TestQueryRecordingCoversTheComparison(t *testing.T) {
	key, verifier := newTokenIssuer(t)
	target, hits := comparisonUpstream(t)
	recorder := &auditRecorder{}
	probe := &writeProbe{ResponseWriter: httptest.NewRecorder()}
	var writesAtRecord, hitsAtRecord []int
	recorder.atCall = func() {
		writesAtRecord = append(writesAtRecord, probe.writes)
		hitsAtRecord = append(hitsAtRecord, int(hits.Load()))
	}
	request := httptest.NewRequest(http.MethodGet, "/v1/risk/compare?"+comparisonQuery, nil)
	request.Header.Set("Authorization", "Bearer "+mintToken(t, key, map[string]any{"sub": "subject-1", "name": "Demo Admin"}))
	newAuditedGateway(t, verifier, recorder, target).ServeHTTP(probe, request)
	response := probe.ResponseWriter.(*httptest.ResponseRecorder)

	if response.Code != http.StatusOK {
		t.Fatalf("got %d, want 200: %s", response.Code, response.Body)
	}
	// The document is the upstream's, byte for byte: adding the record must not
	// re-encode, truncate or reshape a comparison.
	if got := response.Body.String(); got != comparisonBody {
		t.Fatalf("body = %q, want the upstream's %q", got, comparisonBody)
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
	// S6: the comparator is distinguished from the history read by its action.
	if record.Action != "risk.compare.read" {
		t.Errorf("action = %q, want risk.compare.read", record.Action)
	}
	if record.ActorID != "subject-1" || record.ActorName != "Demo Admin" {
		t.Errorf("actor = %q/%q, want subject-1/Demo Admin", record.ActorID, record.ActorName)
	}
	if got := response.Header().Get("X-Request-ID"); record.TraceID != got || !canonicalUUID.MatchString(record.TraceID) {
		t.Errorf("trace id = %q, want the canonical response header %q", record.TraceID, got)
	}
	// The ordering this feature rests on, observed rather than assumed: the write ran
	// once the upstream had answered and before the response had begun, so a caller
	// never receives a comparison whose read was not recorded.
	if len(writesAtRecord) != 1 || writesAtRecord[0] != 0 {
		t.Fatalf("response writes at record time = %v, want the record attempted before the response was written", writesAtRecord)
	}
	if len(hitsAtRecord) != 1 || hitsAtRecord[0] != 1 {
		t.Fatalf("upstream hits at record time = %v, want the record attempted after the upstream answered", hitsAtRecord)
	}
	// The record carries no filter from the URL (S1/L2): the zone list, the window
	// and the granularity the caller asked for are not in the trail.
	encoded, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	for _, leaked := range []string{"zone_ids", "granularity", "from=", "2026-11-01", "05101", "05201"} {
		if strings.Contains(string(encoded), leaked) {
			t.Errorf("the record carries %q: %s", leaked, encoded)
		}
	}
}

// TestComparisonRecordingFailureAnswersTheDocumentedError is the refusal half, and
// it is what "no writer, no delivery" means at this boundary: when the record
// cannot be written the caller receives the documented JSON 503
// storage_unavailable instead of the comparison, so no audited read is unlogged.
func TestComparisonRecordingFailureAnswersTheDocumentedError(t *testing.T) {
	contract := loadContract(t)
	key, verifier := newTokenIssuer(t)
	target, hits := comparisonUpstream(t)
	recorder := &auditRecorder{err: errors.New("audit store unavailable")}
	request := httptest.NewRequest(http.MethodGet, "/v1/risk/compare?"+comparisonQuery, nil)
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
	// The comparison document is not forwarded in any form, so a caller cannot read
	// a comparison the gateway did not write down.
	if strings.Contains(response.Body.String(), `"assessment"`) || strings.Contains(response.Body.String(), `"zone_id"`) {
		t.Fatalf("the unrecorded comparison body was forwarded: %s", response.Body)
	}
	assertResponseMatchesContract(t, contract, "/v1/risk/compare", http.MethodGet, response)
}

// TestUpstreamRefusedComparisonIsForwardedAndNotRecorded pins the other half of the
// existing rule: a comparison the risk service refuses is forwarded untouched and
// left out of the trail, because nothing was read.
func TestUpstreamRefusedComparisonIsForwardedAndNotRecorded(t *testing.T) {
	key, verifier := newTokenIssuer(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"code":"invalid_comparison_query","request_id":"8f1d0a52-7b3c-4a19-9e21-8a1b2c3d4e5f"}`))
	}))
	t.Cleanup(server.Close)
	target, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	recorder := &auditRecorder{}
	request := httptest.NewRequest(http.MethodGet, "/v1/risk/compare?zone_ids=05101&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&granularity=day", nil)
	request.Header.Set("Authorization", "Bearer "+mintToken(t, key, map[string]any{"sub": "subject-1"}))
	response := httptest.NewRecorder()
	newAuditedGateway(t, verifier, recorder, target).ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("got %d, want the upstream's 400: %s", response.Code, response.Body)
	}
	if !strings.Contains(response.Body.String(), `"code":"invalid_comparison_query"`) {
		t.Fatalf("body = %s, want the upstream's refusal", response.Body)
	}
	if len(recorder.snapshot()) != 0 {
		t.Fatalf("a refused comparison recorded %d queries", len(recorder.snapshot()))
	}
}

// TestUnreadableQueryRefusalIsExactPathOnly pins the scope of the new boundary
// check: it is this method and this exact path. A sibling read keeps the
// forwarding behaviour it already has, and a path below the comparison is not the
// comparison.
func TestUnreadableQueryRefusalIsExactPathOnly(t *testing.T) {
	key, verifier := newTokenIssuer(t)
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(server.Close)
	target, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	for _, other := range []struct{ method, path string }{
		{http.MethodGet, "/v1/risk/compare/?zone_ids=05101,05201&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&granularity=day&extra=%zz"},
		{http.MethodGet, "/v1/risk/history?zone_id=05101&extra=%zz"},
		{http.MethodPost, "/v1/risk/compare?extra=%zz"},
	} {
		t.Run(other.method+other.path, func(t *testing.T) {
			hits.Store(0)
			recorder := &auditRecorder{}
			request := httptest.NewRequest(other.method, other.path, nil)
			request.Header.Set("Authorization", "Bearer "+mintToken(t, key, map[string]any{"sub": "subject-1"}))
			response := httptest.NewRecorder()
			newAuditedGateway(t, verifier, recorder, target).ServeHTTP(response, request)
			// The request is forwarded: the check is not widened to a path or method it
			// was not scoped to, so the upstream's answer (never the comparison's raw
			// query refusal) is what the caller receives.
			if hits.Load() != 1 {
				t.Fatalf("%s %s did not reach the upstream: status=%d", other.method, other.path, response.Code)
			}
			if response.Code != http.StatusOK || strings.Contains(response.Body.String(), "invalid_comparison_query") {
				t.Fatalf("%s %s was refused by the comparison's raw-query check: %d %s", other.method, other.path, response.Code, response.Body)
			}
			// A sibling route keeps its own audit decision; what must not happen is this
			// request being recorded as the comparison read.
			for _, record := range recorder.snapshot() {
				if record.Action == "risk.compare.read" {
					t.Fatalf("%s %s was recorded as the comparison", other.method, other.path)
				}
			}
		})
	}
}
