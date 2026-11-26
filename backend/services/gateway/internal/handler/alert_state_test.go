package handler

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// personalStateAlertID is one canonical dashed lower-case uuid: the only spelling
// the risk service's path check accepts, and therefore the only spelling whose
// preflight may be told that PUT is allowed.
const personalStateAlertID = "8f14e45f-ceea-467a-9c3f-1d2b4c1b0a11"

const personalStatePath = "/v1/risk/alerts/" + personalStateAlertID + "/state"

// legacyPreflightHeaders are the exact CORS values every preflight answered
// before the personal alert-state write existed. The change is bounded: every
// request that is not the one PUT preflight below keeps these byte for byte.
var legacyPreflightHeaders = map[string]string{
	"Access-Control-Allow-Origin":   allowedOrigin,
	"Access-Control-Allow-Methods":  "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers":  "Authorization, Content-Type, Idempotency-Key",
	"Access-Control-Max-Age":        "600",
	"Access-Control-Expose-Headers": "X-Request-ID",
	"Vary":                          "Origin",
}

// personalStatePreflight sends the one preflight shape the page needs for its
// personal state write, with the configured origin unless origin is overridden.
func personalStatePreflight(t *testing.T, app http.Handler, target, origin, requestedMethod string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodOptions, target, nil)
	if origin != "" {
		request.Header.Set("Origin", origin)
	}
	if requestedMethod != "" {
		request.Header.Set("Access-Control-Request-Method", requestedMethod)
	}
	response := httptest.NewRecorder()
	app.ServeHTTP(response, request)
	return response
}

// assertPreflightHeaders compares the whole CORS answer, so a legacy caller
// keeps every value it already relied on and only the method list is allowed to
// differ for the one new shape. It also refuses any new Access-Control-* header:
// advertising PUT must not widen exposure.
func assertPreflightHeaders(t *testing.T, response *httptest.ResponseRecorder) {
	t.Helper()
	for header, want := range legacyPreflightHeaders {
		if got := response.Header().Get(header); got != want {
			t.Errorf("preflight %s = %q, want %q", header, got, want)
		}
	}
	for header := range response.Header() {
		canonical := http.CanonicalHeaderKey(header)
		if !strings.HasPrefix(canonical, "Access-Control-") {
			continue
		}
		if _, known := legacyPreflightHeaders[canonical]; !known {
			t.Errorf("preflight emitted the new CORS header %s = %q; exposure must not widen", canonical, response.Header().Get(header))
		}
	}
}

// TestGatewayPreflightAdvertisesPutForThePersonalStateWrite is the public
// boundary of PM-08's write: the page cannot send PUT from the configured origin
// unless this preflight names it. The rest of the answer is the legacy one, so
// the write asks for no new header, origin or max-age.
func TestGatewayPreflightAdvertisesPutForThePersonalStateWrite(t *testing.T) {
	upstream := newAlertUpstream(t)
	target, err := url.Parse(upstream.server.URL)
	if err != nil {
		t.Fatalf("parse the upstream address: %v", err)
	}
	app := New(verifier{}, target, target, target, allowedOrigin)

	response := personalStatePreflight(t, app, personalStatePath, allowedOrigin, http.MethodPut)
	if response.Code != http.StatusNoContent {
		t.Fatalf("preflight got %d want %d: %s", response.Code, http.StatusNoContent, response.Body.String())
	}
	if got := response.Header().Get("Access-Control-Allow-Methods"); got != "GET, POST, OPTIONS, PUT" {
		t.Fatalf("Access-Control-Allow-Methods got %q, want the legacy list followed by PUT", got)
	}
	for header, want := range legacyPreflightHeaders {
		if header == "Access-Control-Allow-Methods" {
			continue
		}
		if got := response.Header().Get(header); got != want {
			t.Errorf("preflight %s = %q, want the unchanged %q", header, got, want)
		}
	}
	if got := upstream.requests(); len(got) != 0 {
		t.Fatalf("a preflight reached the upstream: %+v", got)
	}
}

// TestGatewayPreflightKeepsLegacyMethodList is the compatibility half: siblings,
// an unrequested or non-PUT method, and malformed or suffixed paths keep the
// exact previous answer. A PUT preflight is not a licence for any other route.
func TestGatewayPreflightKeepsLegacyMethodList(t *testing.T) {
	app := newTestGateway(t, allowedOrigin)

	for _, tc := range []struct {
		name            string
		target          string
		requestedMethod string
	}{
		{"the timeline collection", "/v1/risk/alerts", http.MethodPut},
		{"an encoded path separator", "/v1/risk/alerts%2F" + personalStateAlertID + "/state", http.MethodPut},
		{"a sibling read with the same verb", "/v1/risk/latest?zone_id=valparaiso-demo", http.MethodPut},
		{"a sibling read with its own verb", "/v1/risk/history/series", http.MethodGet},
		{"the state path with a read preflight", personalStatePath, http.MethodGet},
		{"the state path with a post preflight", personalStatePath, http.MethodPost},
		{"the state path with a delete preflight", personalStatePath, http.MethodDelete},
		{"the state path with a missing requested method", personalStatePath, ""},
		{"the state path with a lower-case requested method", personalStatePath, "put"},
		{"an identifier that is not a uuid", "/v1/risk/alerts/not-a-uuid/state", http.MethodPut},
		{"a bare 32-hex identifier", "/v1/risk/alerts/8f14e45fceea467a9c3f1d2b4c1b0a11/state", http.MethodPut},
		{"an upper-case identifier", "/v1/risk/alerts/8F14E45F-CEEA-467A-9C3F-1D2B4C1B0A11/state", http.MethodPut},
		{"a brace-wrapped identifier", "/v1/risk/alerts/{8f14e45f-ceea-467a-9c3f-1d2b4c1b0a11}/state", http.MethodPut},
		{"a trailing slash after state", personalStatePath + "/", http.MethodPut},
		{"a suffixed state path", personalStatePath + "/extra", http.MethodPut},
		{"a plural spelling", "/v1/risk/alerts/" + personalStateAlertID + "/states", http.MethodPut},
		{"a suffix on the state segment", "/v1/risk/alerts/" + personalStateAlertID + "/statex", http.MethodPut},
		{"an empty identifier", "/v1/risk/alerts//state", http.MethodPut},
		{"a missing state segment", "/v1/risk/alerts/" + personalStateAlertID, http.MethodPut},
	} {
		t.Run(tc.name, func(t *testing.T) {
			response := personalStatePreflight(t, app, tc.target, allowedOrigin, tc.requestedMethod)
			if response.Code != http.StatusNoContent {
				t.Fatalf("preflight got %d want %d: %s", response.Code, http.StatusNoContent, response.Body.String())
			}
			assertPreflightHeaders(t, response)
		})
	}
}

// TestGatewayPersonalStatePreflightStaysFailClosed pins that the new promise is
// still conditional on the configured origin: an unconfigured gateway and an
// off-origin request receive no CORS answer at all, including no PUT licence.
func TestGatewayPersonalStatePreflightStaysFailClosed(t *testing.T) {
	for _, tc := range []struct {
		name   string
		origin string
		app    http.Handler
	}{
		{"an unconfigured gateway", allowedOrigin, newTestGateway(t, "")},
		{"an off-origin request", "http://localhost:9999", newTestGateway(t, allowedOrigin)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			response := personalStatePreflight(t, tc.app, personalStatePath, tc.origin, http.MethodPut)
			for _, header := range []string{"Access-Control-Allow-Origin", "Access-Control-Allow-Methods", "Access-Control-Allow-Headers", "Access-Control-Max-Age", "Access-Control-Expose-Headers", "Vary"} {
				if got := response.Header().Get(header); got != "" {
					t.Errorf("preflight must not carry %s, got %q", header, got)
				}
			}
		})
	}
}

// TestGatewayPersonalStatePutKeepsTheBearerGate pins that the preflight change
// widens only what a browser is allowed to ask for: a real write still needs a
// verified bearer token, an anonymous or invalid one never reaches the upstream,
// and an admitted PUT/GET is forwarded unchanged. No role decision moved into
// this gateway.
func TestGatewayPersonalStatePutKeepsTheBearerGate(t *testing.T) {
	upstream := newAlertUpstream(t)
	target, err := url.Parse(upstream.server.URL)
	if err != nil {
		t.Fatalf("parse the upstream address: %v", err)
	}
	app := New(verifier{}, target, target, target, allowedOrigin)

	request := func(method, token string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, personalStatePath, nil)
		r.Header.Set("Origin", allowedOrigin)
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		app.ServeHTTP(w, r)
		return w
	}

	anonymous := request(http.MethodPut, "")
	if anonymous.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous PUT got %d want %d: %s", anonymous.Code, http.StatusUnauthorized, anonymous.Body.String())
	}
	invalid := request(http.MethodPut, "invalid")
	if invalid.Code != http.StatusUnauthorized {
		t.Fatalf("invalid-token PUT got %d want %d: %s", invalid.Code, http.StatusUnauthorized, invalid.Body.String())
	}
	if got := upstream.requests(); len(got) != 0 {
		t.Fatalf("an unauthenticated write reached the upstream: %+v", got)
	}

	admitted := request(http.MethodPut, "valid")
	if admitted.Code != http.StatusOK {
		t.Fatalf("authenticated PUT got %d want %d: %s", admitted.Code, http.StatusOK, admitted.Body.String())
	}
	if got := upstream.requests(); len(got) != 1 || got[0].Method != http.MethodPut || got[0].Path != personalStatePath {
		t.Fatalf("upstream received %+v, want one PUT to %s", got, personalStatePath)
	}
	if got := admitted.Header().Get("Access-Control-Allow-Origin"); got != allowedOrigin {
		t.Errorf("actual PUT response Access-Control-Allow-Origin = %q, want %q", got, allowedOrigin)
	}
	// The method list belongs to the preflight; an actual response must not gain it.
	if got := admitted.Header().Get("Access-Control-Allow-Methods"); got != "" {
		t.Errorf("actual PUT response advertises methods %q; that header is preflight-only", got)
	}

	read := request(http.MethodGet, "valid")
	if read.Code != http.StatusOK {
		t.Fatalf("authenticated GET got %d want %d: %s", read.Code, http.StatusOK, read.Body.String())
	}
	if got := upstream.requests(); len(got) != 2 || got[1].Method != http.MethodGet || got[1].Path != personalStatePath {
		t.Fatalf("upstream received %+v, want a GET after the PUT", got)
	}

	// A sibling keeps its forwarding behaviour with the same admitted token: the
	// CORS and preflight work is path-exact and does not add an authorisation rule.
	sibling := httptest.NewRequest(http.MethodPut, "/v1/risk/alerts", nil)
	sibling.Header.Set("Origin", allowedOrigin)
	sibling.Header.Set("Authorization", "Bearer valid")
	siblingResponse := httptest.NewRecorder()
	app.ServeHTTP(siblingResponse, sibling)
	if siblingResponse.Code != http.StatusOK {
		t.Fatalf("sibling PUT got %d want %d: %s", siblingResponse.Code, http.StatusOK, siblingResponse.Body.String())
	}
	if got := upstream.requests(); len(got) != 3 || got[2].Method != http.MethodPut || got[2].Path != "/v1/risk/alerts" {
		t.Fatalf("upstream received %+v, want the unchanged sibling PUT", got)
	}
}

// TestCanonicalAlertStatePath pins the one path shape the preflight discards:
// the canonical dashed lower-case uuid the risk service's own parse/print check
// accepts, with no other shape surviving.
func TestCanonicalAlertStatePath(t *testing.T) {
	for _, tc := range []struct {
		name string
		path string
		want bool
	}{
		{"canonical v4", personalStatePath, true},
		{"canonical non-v4", "/v1/risk/alerts/00000000-0000-0000-0000-000000000000/state", true},
		{"bare 32 hex", "/v1/risk/alerts/8f14e45fceea467a9c3f1d2b4c1b0a11/state", false},
		{"upper case", "/v1/risk/alerts/8F14E45F-CEEA-467A-9C3F-1D2B4C1B0A11/state", false},
		{"braces", "/v1/risk/alerts/{8f14e45f-ceea-467a-9c3f-1d2b4c1b0a11}/state", false},
		{"urn prefix", "/v1/risk/alerts/urn:uuid:8f14e45f-ceea-467a-9c3f-1d2b4c1b0a11/state", false},
		{"trailing slash", personalStatePath + "/", false},
		{"extra segment", personalStatePath + "/extra", false},
		{"empty id", "/v1/risk/alerts//state", false},
		{"another route under the prefix", "/v1/risk/alerts/" + personalStateAlertID, false},
		{"another service", "/v1/models/8f14e45f-ceea-467a-9c3f-1d2b4c1b0a11/state", false},
		{"empty path", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := canonicalAlertStatePath(tc.path); got != tc.want {
				t.Fatalf("canonicalAlertStatePath(%q) = %v, want %v", tc.path, got, tc.want)
			}
		})
	}
}
