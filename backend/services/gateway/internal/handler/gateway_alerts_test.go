package handler

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
)

// proxiedRequest is one request the upstream actually received. It is recorded by
// the upstream itself, so a test can tell "the gateway answered" from "the gateway
// forwarded the caller's request unchanged".
type proxiedRequest struct {
	Method   string
	Path     string
	RawQuery string
}

// alertUpstream is an isolated upstream for the alert-query boundary. It is a real
// httptest server rather than a stub, so the proxy path a caller travels is the one
// production uses; every forwarded request is recorded so the assertions can be
// about what left the gateway and not only about what came back.
type alertUpstream struct {
	mu       sync.Mutex
	received []proxiedRequest
	server   *httptest.Server
}

func newAlertUpstream(t *testing.T) *alertUpstream {
	t.Helper()
	upstream := &alertUpstream{}
	upstream.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstream.mu.Lock()
		upstream.received = append(upstream.received, proxiedRequest{Method: r.Method, Path: r.URL.Path, RawQuery: r.URL.RawQuery})
		upstream.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"proxied":true}`))
	}))
	t.Cleanup(upstream.server.Close)
	return upstream
}

func (u *alertUpstream) requests() []proxiedRequest {
	u.mu.Lock()
	defer u.mu.Unlock()
	return append([]proxiedRequest(nil), u.received...)
}

// gatewayAgainst points every service prefix at the one recording upstream, so a
// request either reaches that upstream or was answered by the gateway.
func gatewayAgainst(t *testing.T, upstream *alertUpstream) http.Handler {
	t.Helper()
	target, err := url.Parse(upstream.server.URL)
	if err != nil {
		t.Fatalf("parse the upstream address: %v", err)
	}
	return New(verifier{}, target, target, target, "")
}

// serveGateway sends one request through the gateway with a bearer token and the
// correlation id the production middleware would forward.
func serveGateway(t *testing.T, app http.Handler, method, target, token string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, target, nil)
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	app.ServeHTTP(w, r)
	return w
}

// TestGatewayRefusesUnreadableAlertQueryBeforeTheProxy pins the public boundary of
// the alert read: a request whose query cannot be unescaped is answered 400
// invalid_alert_query by the gateway itself, in the same error envelope as every
// other gateway refusal, and it is never forwarded. Without this check the pair the
// proxy cannot represent would be dropped and the caller would receive the default
// first page - an answer to a different question than the one it sent.
func TestGatewayRefusesUnreadableAlertQueryBeforeTheProxy(t *testing.T) {
	upstream := newAlertUpstream(t)
	app := gatewayAgainst(t, upstream)
	contract := loadContract(t)

	for _, target := range []string{
		"/v1/risk/alerts?limit=%zz",
		"/v1/risk/alerts?cursor=%",
		"/v1/risk/alerts?order=asc&cursor=%E0%A4%A",
	} {
		w := serveGateway(t, app, http.MethodGet, target, "valid")
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s got %d want %d: %s", target, w.Code, http.StatusBadRequest, w.Body.String())
		}
		if !strings.Contains(w.Body.String(), `"code":"invalid_alert_query"`) {
			t.Fatalf("%s body = %s, want code invalid_alert_query", target, w.Body.String())
		}
		// The refusal is the documented 400 of the operation, envelope included, so a
		// caller cannot tell it apart from the service's own refusal of the same query.
		assertResponseMatchesContract(t, contract, "/v1/risk/alerts", http.MethodGet, w)
	}
	if got := upstream.requests(); len(got) != 0 {
		t.Fatalf("a request with unreadable encoding reached the upstream: %+v", got)
	}
}

// TestGatewayAlertQueryGuardLeavesSiblingsAndAuthAlone pins that the new check is
// scoped to exactly `GET /v1/risk/alerts`. Every other method, every sibling route
// under the same prefix and every other service prefix keeps its existing forwarding
// behaviour, including for a query the guard would refuse on its own path, and the
// bearer gate still answers first: an anonymous request is 401, not 400.
func TestGatewayAlertQueryGuardLeavesSiblingsAndAuthAlone(t *testing.T) {
	upstream := newAlertUpstream(t)
	app := gatewayAgainst(t, upstream)

	for _, tc := range []struct {
		method, target string
		// queryPreserved is true for a well-formed query, which the guard must hand to
		// the proxy untouched. It is false for the malformed sibling queries: the
		// shared proxy sanitises those exactly as it did before this guard existed,
		// and that behaviour is deliberately not changed here.
		queryPreserved bool
	}{
		{http.MethodGet, "/v1/risk/alerts", true},
		{http.MethodGet, "/v1/risk/alerts?limit=10&order=asc", true},
		// Well-formed but semantically invalid: the service owns that 400, so the
		// gateway must forward it rather than re-judging the values.
		{http.MethodGet, "/v1/risk/alerts?limit=500", true},
		// The exact guarded path with another method: not this guard's request.
		{http.MethodPost, "/v1/risk/alerts?limit=%zz", false},
		// A trailing slash is not the guarded path either.
		{http.MethodGet, "/v1/risk/alerts/?limit=%zz", false},
		// Siblings below the same prefix and the other collection paths.
		{http.MethodGet, "/v1/risk/batches?bbox=%zz", false},
		{http.MethodGet, "/v1/models?limit=%zz", false},
		{http.MethodGet, "/v1/jobs?x=%zz", false},
		{http.MethodGet, "/v1/prevention/actions?x=%zz", false},
	} {
		w := serveGateway(t, app, tc.method, tc.target, "valid")
		if w.Code != http.StatusOK {
			t.Fatalf("%s %s got %d want %d: %s", tc.method, tc.target, w.Code, http.StatusOK, w.Body.String())
		}
		path, rawQuery, _ := strings.Cut(tc.target, "?")
		received := upstream.requests()
		last := received[len(received)-1]
		if last.Method != tc.method || last.Path != path {
			t.Fatalf("upstream received %+v, want %s %s", last, tc.method, path)
		}
		if tc.queryPreserved && last.RawQuery != rawQuery {
			t.Fatalf("upstream received query %q, want %q forwarded verbatim", last.RawQuery, rawQuery)
		}
	}
	if received := upstream.requests(); len(received) != 9 {
		t.Fatalf("upstream received %d requests, want 9: %+v", len(received), received)
	}

	// The bearer gate is answered before the query guard, as it is for every other
	// route: a caller that cannot be authenticated learns nothing about its query.
	anonymousUpstream := newAlertUpstream(t)
	anonymous := serveGateway(t, gatewayAgainst(t, anonymousUpstream), http.MethodGet, "/v1/risk/alerts?limit=%zz", "")
	if anonymous.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous malformed query got %d want %d: %s", anonymous.Code, http.StatusUnauthorized, anonymous.Body.String())
	}
	if got := anonymousUpstream.requests(); len(got) != 0 {
		t.Fatalf("an unauthenticated request reached the upstream: %+v", got)
	}
}
