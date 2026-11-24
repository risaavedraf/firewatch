package handler

// Query recording (PM-10 / V1-P-07, S1 item 3 and S3).
//
// These tests pin the gateway half of the feature at the boundary the wire
// crosses: which request is a recorded read, what the record may contain, when
// it is written relative to the response, and what the caller sees when writing
// it fails. They need no database: the recorder is an interface, so the
// vocabulary, the redaction rule and the failure contract are proved here and
// the insert itself is proved against PostgreSQL.

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/go-jose/go-jose/v4"
)

// canonicalUUID is the dashed lower-case form the gateway mints for X-Request-ID
// and forwards as trace_id. The audit column is a uuid, so a value that is not
// this shape would be rejected by the writer instead of being stored.
var canonicalUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// auditRecorder is the recording seam these tests observe. It captures every
// record it is handed, the deadline the caller bounded it with, and the error the
// test asked it to fail with.
type auditRecorder struct {
	mu          sync.Mutex
	records     []QueryRecord
	err         error
	deadline    time.Duration
	undeadlined bool
}

func (r *auditRecorder) RecordQuery(ctx context.Context, record QueryRecord) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if deadline, ok := ctx.Deadline(); ok {
		r.deadline = time.Until(deadline)
	} else {
		r.undeadlined = true
	}
	r.records = append(r.records, record)
	return r.err
}

func (r *auditRecorder) snapshot() []QueryRecord {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]QueryRecord(nil), r.records...)
}

// newTokenIssuer builds the production RS256 policy over a local key, so a test
// can mint a token whose signed claims carry a display name without a remote
// key set. The subject and the name claims are the only identity inputs the
// recorder may read.
func newTokenIssuer(t *testing.T) (*rsa.PrivateKey, Verifier) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	verifier := oidc.NewVerifier("https://issuer.test", &oidc.StaticKeySet{PublicKeys: []crypto.PublicKey{&key.PublicKey}}, &oidc.Config{ClientID: "firewatch-api", SupportedSigningAlgs: []string{"RS256"}})
	return key, verifier
}

// mintToken signs one ID token with the claims this test asserts on. iss, aud and
// exp are supplied here so every token is accepted by the same verifier the
// production binary builds.
func mintToken(t *testing.T, key *rsa.PrivateKey, claims map[string]any) string {
	t.Helper()
	full := map[string]any{"iss": "https://issuer.test", "aud": "firewatch-api", "exp": time.Now().Add(time.Minute).Unix()}
	for name, value := range claims {
		full[name] = value
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key}, nil)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(full)
	if err != nil {
		t.Fatal(err)
	}
	signed, err := signer.Sign(payload)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := signed.CompactSerialize()
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// newAuditedGateway is the transport under test with a recording seam and the
// upstream every route of these tests proxies to.
func newAuditedGateway(t *testing.T, verifier Verifier, recorder QueryRecorder, upstream *url.URL) http.Handler {
	t.Helper()
	return NewWithQueryRecorder(verifier, upstream, upstream, upstream, allowedOrigin, nil, recorder)
}

// auditUpstream answers every proxied request with a 200 and the same small JSON
// body, so a test can tell a forwarded response from one the gateway replaced.
func auditUpstream(t *testing.T) (*httptest.Server, *url.URL) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"zone_id":"valparaiso-demo","ok":true}`)
	}))
	t.Cleanup(server.Close)
	target, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	return server, target
}

// TestQueryRoutesAreExactlyTheSelectedBusinessReads pins the whole selection at
// once. The list is the feature: anything added here starts writing audit rows,
// so the expectation is written out in full rather than derived from the table
// under test. S3 selected current and historical risk, observations and
// preventive actions; the audit log itself, the catalogue/map loads, the model
// registry, the job routes and the directory stay out.
func TestQueryRoutesAreExactlyTheSelectedBusinessReads(t *testing.T) {
	want := []struct{ method, path, action string }{
		{http.MethodGet, "/v1/risk/latest", "risk.current.read"},
		{http.MethodGet, "/v1/risk/history", "risk.history.read"},
		{http.MethodGet, "/v1/risk/batches", "risk.batches.read"},
		{http.MethodGet, "/v1/prevention/observations", "prevention.observations.read"},
		{http.MethodGet, "/v1/prevention/actions", "prevention.actions.read"},
	}
	if len(queryRoutes) != len(want) {
		t.Fatalf("the query vocabulary has %d entries, want %d: %+v", len(queryRoutes), len(want), queryRoutes)
	}
	seenPath, seenAction := map[string]bool{}, map[string]bool{}
	for i, expected := range want {
		got := queryRoutes[i]
		if got.Method != expected.method || got.Path != expected.path || got.Action != expected.action {
			t.Errorf("route %d = %+v, want %s %s as %q", i, got, expected.method, expected.path, expected.action)
		}
		if seenPath[got.Path] {
			t.Errorf("path %q is listed twice", got.Path)
		}
		if seenAction[got.Action] {
			t.Errorf("action %q is listed twice", got.Action)
		}
		seenPath[got.Path], seenAction[got.Action] = true, true
	}
	// The exclusions S3 and the technical-map note name, plus the writes and the
	// sub-resources that are not the selected collection reads. Every one of them
	// is routed by this gateway, so the allow-list — not the route table — is what
	// keeps them out.
	for _, excluded := range []struct{ method, path string }{
		{http.MethodGet, "/v1/audit"},
		{http.MethodGet, "/v1/risk/zones"},
		{http.MethodGet, "/v1/risk/synthetic-scenarios"},
		{http.MethodGet, "/v1/models"},
		{http.MethodPost, "/v1/models"},
		{http.MethodGet, "/v1/users"},
		{http.MethodGet, "/v1/jobs"},
		{http.MethodPost, "/v1/jobs"},
		{http.MethodGet, "/v1/jobs/8f1d0a52-7b3c-4a19-9e21-8a1b2c3d4e5f"},
		{http.MethodGet, "/v1/risk"},
		{http.MethodGet, "/v1/risk/history/valparaiso-demo"},
		{http.MethodGet, "/v1/risk/latest/"},
		{http.MethodPost, "/v1/risk/batches"},
		{http.MethodGet, "/v1/prevention/actions/invalid-id"},
		{http.MethodHead, "/v1/prevention/actions/8f1d0a52-7b3c-4a19-9e21-8a1b2c3d4e5f"},
		{http.MethodPost, "/v1/prevention/actions"},
		{http.MethodGet, "/v1/prevention/observations/zones"},
		{http.MethodGet, "/v1/prevention/actions/8f1d0a52-7b3c-4a19-9e21-8a1b2c3d4e5f/evidence"},
	} {
		if route, ok := queryRouteFor(excluded.method, excluded.path); ok {
			t.Errorf("%s %s is recorded as %q; it is outside the selected scope", excluded.method, excluded.path, route.Action)
		}
	}
}

// TestQueryRecordingCoversOnlyTheSelectedSuccessfulReads proves the behaviour the
// table alone cannot: a selected 200 is recorded once with the verified actor,
// the closed action and the gateway's own trace id, and nothing else is recorded
// even though the same proxy answers it.
func TestQueryRecordingCoversOnlyTheSelectedSuccessfulReads(t *testing.T) {
	key, verifier := newTokenIssuer(t)
	_, target := auditUpstream(t)
	for _, selected := range []struct{ path, action string }{
		{"/v1/risk/latest?zone_id=valparaiso-demo", "risk.current.read"},
		{"/v1/risk/history?zone_id=valparaiso-demo&from=2026-01-01", "risk.history.read"},
		{"/v1/risk/batches", "risk.batches.read"},
		{"/v1/prevention/observations?community_code=valparaiso-demo&status=pendiente", "prevention.observations.read"},
		{"/v1/prevention/actions?community_code=valparaiso-demo&status=propuesta", "prevention.actions.read"},
		{"/v1/prevention/actions/8F1D0A52-7B3C-4A19-9E21-8A1B2C3D4E5F", "prevention.actions.read"},
		{"/v1/prevention/actions/8f1d0a527b3c4a199e218a1b2c3d4e5f", "prevention.actions.read"},
		{"/v1/prevention/actions/urn:uuid:8f1d0a52-7b3c-4a19-9e21-8a1b2c3d4e5f", "prevention.actions.read"},
		{"/v1/prevention/actions/%7B8f1d0a52-7b3c-4a19-9e21-8a1b2c3d4e5f%7D", "prevention.actions.read"},
	} {
		t.Run(selected.action, func(t *testing.T) {
			recorder := &auditRecorder{}
			app := newAuditedGateway(t, verifier, recorder, target)
			request := httptest.NewRequest(http.MethodGet, selected.path, nil)
			request.Header.Set("Authorization", "Bearer "+mintToken(t, key, map[string]any{"sub": "subject-1", "name": "Demo Admin"}))
			response := httptest.NewRecorder()
			app.ServeHTTP(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("%s got %d, want 200", selected.path, response.Code)
			}
			records := recorder.snapshot()
			if len(records) != 1 {
				t.Fatalf("%s recorded %d queries, want 1", selected.path, len(records))
			}
			record := records[0]
			if record.Action != selected.action {
				t.Errorf("action = %q, want %q", record.Action, selected.action)
			}
			if record.ActorID != "subject-1" || record.ActorName != "Demo Admin" {
				t.Errorf("actor = %q/%q, want subject-1/Demo Admin", record.ActorID, record.ActorName)
			}
			// The trace id is the one this gateway minted and answered with, not one
			// the caller sent: the request below sets no header, and a spoofed one is
			// covered by the identity test.
			if got := response.Header().Get("X-Request-ID"); record.TraceID != got {
				t.Errorf("trace id = %q, want the response's %q", record.TraceID, got)
			}
			if !canonicalUUID.MatchString(record.TraceID) {
				t.Errorf("trace id %q is not the canonical dashed UUID the audit column stores", record.TraceID)
			}
		})
	}

	for _, other := range []struct{ method, path string }{
		{http.MethodGet, "/v1/audit"},
		{http.MethodGet, "/v1/risk/zones?zone_id=valparaiso-demo"},
		{http.MethodGet, "/v1/risk/synthetic-scenarios"},
		{http.MethodGet, "/v1/models"},
		{http.MethodGet, "/v1/users"},
		{http.MethodGet, "/v1/jobs"},
		{http.MethodPost, "/v1/jobs"},
		{http.MethodGet, "/v1/risk/history/valparaiso-demo"},
		{http.MethodPost, "/v1/risk/batches"},
		{http.MethodGet, "/v1/prevention/observations/zones"},
		{http.MethodPost, "/v1/prevention/actions"},
		{http.MethodGet, "/v1/prevention/actions/invalid-id"},
		{http.MethodHead, "/v1/prevention/actions/8f1d0a52-7b3c-4a19-9e21-8a1b2c3d4e5f"},
	} {
		t.Run(strings.NewReplacer("/", "_", "?", "_").Replace(other.method+other.path), func(t *testing.T) {
			recorder := &auditRecorder{}
			app := newAuditedGateway(t, verifier, recorder, target)
			request := httptest.NewRequest(other.method, other.path, strings.NewReader(`{}`))
			request.Header.Set("Authorization", "Bearer "+mintToken(t, key, map[string]any{"sub": "subject-1", "name": "Demo Admin"}))
			app.ServeHTTP(httptest.NewRecorder(), request)
			if records := recorder.snapshot(); len(records) != 0 {
				t.Fatalf("%s %s recorded %+v; only the selected reads are recorded", other.method, other.path, records)
			}
		})
	}

	// A selected path answered by the gateway itself is not a read that happened
	// upstream, so it is not recorded: no bearer token, and a preflight.
	anonymous := httptest.NewRecorder()
	anonymousRecorder := &auditRecorder{}
	newAuditedGateway(t, verifier, anonymousRecorder, target).ServeHTTP(anonymous, httptest.NewRequest(http.MethodGet, "/v1/risk/latest", nil))
	if anonymous.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous /v1/risk/latest got %d, want 401", anonymous.Code)
	}
	if records := anonymousRecorder.snapshot(); len(records) != 0 {
		t.Fatalf("a rejected request recorded %+v", records)
	}
	preflightRecorder := &auditRecorder{}
	preflight := httptest.NewRequest(http.MethodOptions, "/v1/risk/latest", nil)
	preflight.Header.Set("Origin", allowedOrigin)
	newAuditedGateway(t, verifier, preflightRecorder, target).ServeHTTP(httptest.NewRecorder(), preflight)
	if records := preflightRecorder.snapshot(); len(records) != 0 {
		t.Fatalf("a preflight recorded %+v", records)
	}
}

// TestQueryRecordingSkipsEveryUnsuccessfulAnswer pins "successful business GETs".
// The upstream's answer decides: only a 2xx is a read that produced data, so the
// documented 404 empty state and every error answer are forwarded and left out
// of the trail.
func TestQueryRecordingSkipsEveryUnsuccessfulAnswer(t *testing.T) {
	key, verifier := newTokenIssuer(t)
	for _, status := range []int{http.StatusNotFound, http.StatusBadRequest, http.StatusForbidden, http.StatusTooManyRequests, http.StatusInternalServerError, http.StatusServiceUnavailable, http.StatusBadGateway} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(status)
			}))
			defer upstream.Close()
			target, _ := url.Parse(upstream.URL)
			recorder := &auditRecorder{}
			request := httptest.NewRequest(http.MethodGet, "/v1/risk/latest", nil)
			request.Header.Set("Authorization", "Bearer "+mintToken(t, key, map[string]any{"sub": "subject-1"}))
			response := httptest.NewRecorder()
			newAuditedGateway(t, verifier, recorder, target).ServeHTTP(response, request)
			if response.Code != status {
				t.Fatalf("got %d, want the upstream's %d", response.Code, status)
			}
			if records := recorder.snapshot(); len(records) != 0 {
				t.Fatalf("a %d answer recorded %+v; only a confirmed success is a read", status, records)
			}
		})
	}
	// An unreachable upstream is the gateway's own 502 and is never recorded.
	dead := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	deadTarget, _ := url.Parse(dead.URL)
	dead.Close()
	recorder := &auditRecorder{}
	request := httptest.NewRequest(http.MethodGet, "/v1/risk/latest", nil)
	request.Header.Set("Authorization", "Bearer "+mintToken(t, key, map[string]any{"sub": "subject-1"}))
	response := httptest.NewRecorder()
	newAuditedGateway(t, verifier, recorder, deadTarget).ServeHTTP(response, request)
	if response.Code != http.StatusBadGateway {
		t.Fatalf("an unreachable upstream got %d, want 502", response.Code)
	}
	if records := recorder.snapshot(); len(records) != 0 {
		t.Fatalf("an upstream failure recorded %+v", records)
	}
}

// TestQueryRecordingReadsOnlyTheVerifiedToken is the redaction rule: the record is
// built from the signed subject, the signed display claims, the closed action and
// the trace id this gateway minted. Nothing the caller writes reaches it — not a
// header, not the bearer token, not one of the filters in the URL.
func TestQueryRecordingReadsOnlyTheVerifiedToken(t *testing.T) {
	key, verifier := newTokenIssuer(t)
	_, target := auditUpstream(t)
	token := mintToken(t, key, map[string]any{"sub": "subject-1", "name": "Demo Admin"})
	recorder := &auditRecorder{}
	request := httptest.NewRequest(http.MethodGet, "/v1/prevention/observations?community_code=valparaiso-demo&status=pendiente&actor_name=Mallory", nil)
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("X-User-ID", "root")
	request.Header.Set("X-User-Role", "admin")
	request.Header.Set("X-Actor-Name", "Mallory")
	request.Header.Set("X-Request-ID", "8f1d0a52-7b3c-4a19-9e21-8a1b2c3d4e5f")
	response := httptest.NewRecorder()
	newAuditedGateway(t, verifier, recorder, target).ServeHTTP(response, request)

	records := recorder.snapshot()
	if len(records) != 1 {
		t.Fatalf("recorded %d queries, want 1", len(records))
	}
	record := records[0]
	if record.ActorID != "subject-1" || record.ActorName != "Demo Admin" {
		t.Fatalf("actor = %q/%q, want the verified subject-1/Demo Admin", record.ActorID, record.ActorName)
	}
	if record.TraceID == "8f1d0a52-7b3c-4a19-9e21-8a1b2c3d4e5f" {
		t.Fatal("the trace id was taken from the caller's header")
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	for _, leaked := range []string{"Mallory", "valparaiso-demo", "pendiente", "root", "admin", "Bearer", token, "?community_code"} {
		if strings.Contains(string(encoded), leaked) {
			t.Errorf("the record carries %q: %s", leaked, encoded)
		}
	}
}

// TestQueryDisplayNameUsesOnlyVerifiedClaims pins the name resolution order the
// audit store relies on: the full name, then the preferred username, then the
// given/family pair, and empty when the token asserts none of them — the store
// keeps NULL rather than inventing a name from the subject.
func TestQueryDisplayNameUsesOnlyVerifiedClaims(t *testing.T) {
	key, verifier := newTokenIssuer(t)
	_, target := auditUpstream(t)
	for _, tc := range []struct {
		name    string
		claims  map[string]any
		want    string
		wantSub string
	}{
		{"full name wins", map[string]any{"sub": "s-1", "name": "Demo Admin", "preferred_username": "demo-admin", "given_name": "De", "family_name": "Mo"}, "Demo Admin", "s-1"},
		{"preferred username", map[string]any{"sub": "s-2", "preferred_username": "demo-viewer"}, "demo-viewer", "s-2"},
		{"given and family", map[string]any{"sub": "s-3", "given_name": "Demo", "family_name": "Viewer"}, "Demo Viewer", "s-3"},
		{"blank name falls through", map[string]any{"sub": "s-4", "name": "   ", "preferred_username": "demo-admin"}, "demo-admin", "s-4"},
		{"no name claim", map[string]any{"sub": "s-5"}, "", "s-5"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			recorder := &auditRecorder{}
			request := httptest.NewRequest(http.MethodGet, "/v1/risk/batches", nil)
			request.Header.Set("Authorization", "Bearer "+mintToken(t, key, tc.claims))
			newAuditedGateway(t, verifier, recorder, target).ServeHTTP(httptest.NewRecorder(), request)
			records := recorder.snapshot()
			if len(records) != 1 {
				t.Fatalf("recorded %d queries, want 1", len(records))
			}
			if records[0].ActorName != tc.want || records[0].ActorID != tc.wantSub {
				t.Fatalf("actor = %q/%q, want %q/%q", records[0].ActorID, records[0].ActorName, tc.wantSub, tc.want)
			}
		})
	}
}

// TestQueryRecordingFailureAnswersStorageUnavailable is the ordering rule and the
// failure contract in one test: the record is attempted before the upstream body
// is copied, so a failed write answers the documented 503 storage_unavailable and
// the caller never receives an audited success that was not audited.
func TestQueryRecordingFailureAnswersStorageUnavailable(t *testing.T) {
	contract := loadContract(t)
	key, verifier := newTokenIssuer(t)
	_, target := auditUpstream(t)
	for _, path := range []string{"/v1/risk/latest", "/v1/risk/history", "/v1/risk/batches", "/v1/prevention/observations", "/v1/prevention/actions", "/v1/prevention/actions/8f1d0a527b3c4a199e218a1b2c3d4e5f"} {
		t.Run(path, func(t *testing.T) {
			recorder := &auditRecorder{err: errors.New("audit store unavailable")}
			request := httptest.NewRequest(http.MethodGet, path, nil)
			request.Header.Set("Authorization", "Bearer "+mintToken(t, key, map[string]any{"sub": "subject-1", "name": "Demo Admin"}))
			response := httptest.NewRecorder()
			newAuditedGateway(t, verifier, recorder, target).ServeHTTP(response, request)

			if len(recorder.snapshot()) != 1 {
				t.Fatalf("the recorder was called %d times, want exactly 1", len(recorder.snapshot()))
			}
			if response.Code != http.StatusServiceUnavailable {
				t.Fatalf("got %d, want 503 when the record cannot be written", response.Code)
			}
			var body struct {
				Code      string `json:"code"`
				RequestID string `json:"request_id"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatalf("body is not JSON: %v: %s", err, response.Body)
			}
			if body.Code != "storage_unavailable" {
				t.Fatalf("code = %q, want storage_unavailable", body.Code)
			}
			if body.RequestID != response.Header().Get("X-Request-ID") || !canonicalUUID.MatchString(body.RequestID) {
				t.Fatalf("request_id %q does not match the header %q", body.RequestID, response.Header().Get("X-Request-ID"))
			}
			// The upstream answered 200 with a body; the caller must not see any of
			// it, because the read it describes was never recorded.
			if strings.Contains(response.Body.String(), "valparaiso-demo") {
				t.Fatalf("the unrecorded upstream body was forwarded: %s", response.Body)
			}
			contractPath := path
			if strings.HasPrefix(path, "/v1/prevention/actions/") {
				contractPath = "/v1/prevention/actions/{id}"
			}
			assertResponseMatchesContract(t, contract, contractPath, http.MethodGet, response)
		})
	}
}

// TestQueryRecordingIsBoundedAndUncancelled proves the deadline the writer runs
// under: a bounded budget, and one that does not inherit the caller's
// cancellation, because the upstream answer that must be recorded already
// happened.
func TestQueryRecordingIsBoundedAndUncancelled(t *testing.T) {
	key, verifier := newTokenIssuer(t)
	_, target := auditUpstream(t)
	recorder := &auditRecorder{}
	request := httptest.NewRequest(http.MethodGet, "/v1/risk/latest", nil)
	request.Header.Set("Authorization", "Bearer "+mintToken(t, key, map[string]any{"sub": "subject-1"}))
	newAuditedGateway(t, verifier, recorder, target).ServeHTTP(httptest.NewRecorder(), request)
	if recorder.undeadlined {
		t.Fatal("the record ran without a deadline")
	}
	if recorder.deadline <= 0 || recorder.deadline > queryAuditTimeout {
		t.Fatalf("deadline = %v, want a positive budget no larger than %v", recorder.deadline, queryAuditTimeout)
	}
}

// TestQueryRecordingLeavesTheProxyResponseUntouched pins the sibling behaviour the
// feature must not change: with a working recorder the proxied status, body and
// headers are the upstream's, and the correlation id stays the gateway's own.
func TestQueryRecordingLeavesTheProxyResponseUntouched(t *testing.T) {
	key, verifier := newTokenIssuer(t)
	_, target := auditUpstream(t)
	for _, recorded := range []bool{true, false} {
		recorder := &auditRecorder{}
		var handler http.Handler
		if recorded {
			handler = newAuditedGateway(t, verifier, recorder, target)
		} else {
			handler = New(verifier, target, target, target, allowedOrigin)
		}
		request := httptest.NewRequest(http.MethodGet, "/v1/risk/batches", nil)
		request.Header.Set("Authorization", "Bearer "+mintToken(t, key, map[string]any{"sub": "subject-1"}))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("recorded=%v got %d, want 200", recorded, response.Code)
		}
		if got := response.Body.String(); got != `{"zone_id":"valparaiso-demo","ok":true}` {
			t.Fatalf("recorded=%v body = %q, want the upstream's", recorded, got)
		}
		if ids := response.Header().Values("X-Request-ID"); len(ids) != 1 || !canonicalUUID.MatchString(ids[0]) {
			t.Fatalf("recorded=%v X-Request-ID = %v, want exactly one canonical id", recorded, ids)
		}
		if got := response.Header().Get("Cache-Control"); got != "no-store" {
			t.Fatalf("recorded=%v Cache-Control = %q, want no-store", recorded, got)
		}
	}
}

// TestQueryLabelsMatchTheDatabaseWriter is the one duplication this design cannot
// remove: the action vocabulary is a Go table and the narrow SQL writer accepts a
// fixed set. A label the gateway sends but the database refuses would answer 503
// to every audited read, so the two are compared as text — the same technique the
// risk module uses to read prevention's migration list.
func TestQueryLabelsMatchTheDatabaseWriter(t *testing.T) {
	migrations := filepath.Join("..", "..", "..", "jobs", "migrations")
	if _, err := os.Stat(migrations); errors.Is(err, os.ErrNotExist) {
		t.Skip("the jobs module is not part of this checkout, so its migration cannot be read")
	}
	path := filepath.Join(migrations, "006_query_audit_writer.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("the narrow query writer owns the action vocabulary and must be readable: %v", err)
	}
	sql := string(raw)
	for _, route := range queryRoutes {
		if !strings.Contains(sql, "'"+route.Action+"'") {
			t.Errorf("006_query_audit_writer.sql rejects %q, which the gateway records", route.Action)
		}
	}
	// The kind is fixed inside the writer, so a recorded read can never be stored
	// as a mutation.
	if !strings.Contains(sql, "'query'") {
		t.Error("006_query_audit_writer.sql does not fix event_kind to 'query'")
	}
	if strings.Contains(sql, "event_kind text") {
		t.Error("006_query_audit_writer.sql widens the audit columns; the writer only inserts")
	}
}
