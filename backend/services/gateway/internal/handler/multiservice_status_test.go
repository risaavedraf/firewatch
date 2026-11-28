package handler

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/go-jose/go-jose/v4"
)

// The aggregate is answered by this gateway, so its body, its code and the
// states it derives from the four contracted status bodies are pinned here
// against the published contract. The upstream stubs answer only what the
// aggregate parses: the full status bodies belong to the sibling services and
// are validated by their own contract tests.

// Contracted bodies, trimmed to the fields the aggregate reads.
const (
	msOperationalReady    = `{"checked_at":"2026-10-20T12:00:00Z","ready":true,"reason":"","dependencies":{"database":{"state":"ready"},"broker":{"state":"ready"},"dead_letter":{"state":"ready","depth":0,"sampled_at":null,"age_seconds":null,"max_age_seconds":null,"max_depth":null}}}`
	msOperationalDegraded = `{"checked_at":"2026-10-20T12:00:00Z","ready":false,"reason":"database_unavailable","dependencies":{"database":{"state":"degraded"},"broker":{"state":"ready"},"dead_letter":{"state":"ready","depth":0,"sampled_at":null,"age_seconds":null,"max_age_seconds":null,"max_depth":null}}}`
	msInferenceReady      = `{"checked_at":"2026-10-20T12:00:00Z","state":"ready","reason":""}`
	msInferenceUnset      = `{"checked_at":"2026-10-20T12:00:00Z","state":"not_configured","reason":"not_configured"}`
	msInferenceDegraded   = `{"checked_at":"2026-10-20T12:00:00Z","state":"degraded","reason":"inference_unavailable"}`
)

// msJSON answers one status code with one JSON body.
func msJSON(code int, body string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		_, _ = w.Write([]byte(body))
	}
}

func msURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse %q: %v", raw, err)
	}
	return parsed
}

// msRisk serves the two status surfaces the aggregate reads from risk: its own
// operational status and the inference evidence it publishes.
func msRisk(status, inference http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/risk/status":
			status(w, r)
		case "/v1/risk/inference/status":
			inference(w, r)
		default:
			http.NotFound(w, r)
		}
	}
}

// msAccess mints the tokens this gateway actually verifies. The aggregate reads
// the verified realm roles of the token, and go-oidc only exposes the claims of a
// token its own verifier produced, so a stub with unreadable claims cannot stand
// in for a signed one here.
type msAccess struct {
	verifier *oidc.IDTokenVerifier
	key      *rsa.PrivateKey
}

func newMSAccess(t *testing.T) *msAccess {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	verifier := oidc.NewVerifier("https://issuer.test", &oidc.StaticKeySet{PublicKeys: []crypto.PublicKey{&key.PublicKey}}, &oidc.Config{ClientID: "firewatch-api"})
	return &msAccess{verifier: verifier, key: key}
}

// token mints an access token for exactly the roles given.
func (a *msAccess) token(t *testing.T, roles ...string) string {
	t.Helper()
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: a.key}, nil)
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(map[string]any{
		"iss": "https://issuer.test", "aud": "firewatch-api", "sub": "subject",
		"exp": time.Now().Add(time.Hour).Unix(), "typ": "Bearer",
		"realm_access": map[string]any{"roles": roles},
	})
	signed, err := signer.Sign(payload)
	if err != nil {
		t.Fatal(err)
	}
	token, err := signed.CompactSerialize()
	if err != nil {
		t.Fatal(err)
	}
	return token
}

// msGatewayWith is the real gateway handler in front of three stub upstreams.
// The aggregate is a route of this process, not a proxy to a fifth service.
func msGatewayWith(t *testing.T, access *msAccess, riskStatus, inference, jobs, prevention http.HandlerFunc) http.Handler {
	t.Helper()
	risk := httptest.NewServer(msRisk(riskStatus, inference))
	t.Cleanup(risk.Close)
	jobsServer := httptest.NewServer(jobs)
	t.Cleanup(jobsServer.Close)
	preventionServer := httptest.NewServer(prevention)
	t.Cleanup(preventionServer.Close)
	return New(access.verifier, msURL(t, jobsServer.URL), msURL(t, risk.URL), msURL(t, preventionServer.URL), "")
}

// msGateway is msGatewayWith plus a viewer credential, which is the role the
// aggregate is declared for.
func msGateway(t *testing.T, riskStatus, inference, jobs, prevention http.HandlerFunc) (http.Handler, string) {
	t.Helper()
	access := newMSAccess(t)
	return msGatewayWith(t, access, riskStatus, inference, jobs, prevention), access.token(t, "viewer")
}

// msRequest sends the headers a caller controls, so a test can prove none of
// them chooses a target, grants access or reaches an upstream.
func msRequest(t *testing.T, h http.Handler, token, target string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, target, nil)
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	r.Header.Set("X-Request-ID", "spoofed")
	r.Header.Set("X-User-ID", "root")
	r.Header.Set("X-User-Role", "admin")
	r.Header.Set("X-Forwarded-For", "10.0.0.9")
	r.Header.Set("Cookie", "session=stolen")
	r.Header.Set("Origin", "http://attacker.invalid")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

type msBody struct {
	CheckedAt string `json:"checked_at"`
	Gateway   struct {
		State string `json:"state"`
	} `json:"gateway"`
	Services []struct {
		Service string `json:"service"`
		State   string `json:"state"`
	} `json:"services"`
}

func msDecode(t *testing.T, w *httptest.ResponseRecorder) msBody {
	t.Helper()
	var body msBody
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("aggregate body is not JSON: %v: %s", err, w.Body.String())
	}
	return body
}

func msStates(t *testing.T, w *httptest.ResponseRecorder) []string {
	t.Helper()
	body := msDecode(t, w)
	states := make([]string, 0, len(body.Services))
	for _, entry := range body.Services {
		states = append(states, entry.Service+"="+entry.State)
	}
	return states
}

// TestMultiserviceStatusAggregateMatchesTheContract pins the whole mapping: the
// states derived from the four contracted bodies, the fixed order, and the
// truthful 200/503 boundary. degraded and unknown are the only states that make
// the aggregate answer 503; unauthorized reports the caller's permission and
// not_configured reports an unset configuration, so neither is a failure.
func TestMultiserviceStatusAggregateMatchesTheContract(t *testing.T) {
	contract := loadContract(t)
	unreachable := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	unreachable.Close()

	for _, tc := range []struct {
		name       string
		risk       http.HandlerFunc
		inference  http.HandlerFunc
		jobs       http.HandlerFunc
		prevention http.HandlerFunc
		wantCode   int
		wantStates []string
	}{
		{
			name:       "everything ready and inference unconfigured",
			risk:       msJSON(200, msOperationalReady),
			inference:  msJSON(200, msInferenceUnset),
			jobs:       msJSON(200, msOperationalReady),
			prevention: msJSON(200, msOperationalReady),
			wantCode:   http.StatusOK,
			wantStates: []string{"risk=ready", "jobs=ready", "prevention=ready", "inference=not_configured"},
		},
		{
			name:       "degraded dependency makes the aggregate 503",
			risk:       msJSON(503, msOperationalDegraded),
			inference:  msJSON(200, msInferenceReady),
			jobs:       msJSON(200, msOperationalReady),
			prevention: msJSON(200, msOperationalReady),
			wantCode:   http.StatusServiceUnavailable,
			wantStates: []string{"risk=degraded", "jobs=ready", "prevention=ready", "inference=ready"},
		},
		{
			name:       "admin-only service is unauthorized for this caller, not degraded",
			risk:       msJSON(200, msOperationalReady),
			inference:  msJSON(200, msInferenceReady),
			jobs:       msJSON(403, `{"code":"forbidden","request_id":"x"}`),
			prevention: msJSON(200, msOperationalReady),
			wantCode:   http.StatusOK,
			wantStates: []string{"risk=ready", "jobs=unauthorized", "prevention=ready", "inference=ready"},
		},
		{
			name:       "refused credential is unauthorized too",
			risk:       msJSON(200, msOperationalReady),
			inference:  msJSON(200, msInferenceReady),
			jobs:       msJSON(401, `{"code":"unauthorized","request_id":"x"}`),
			prevention: msJSON(200, msOperationalReady),
			wantCode:   http.StatusOK,
			wantStates: []string{"risk=ready", "jobs=unauthorized", "prevention=ready", "inference=ready"},
		},
		{
			name:       "an unreachable service is unknown, never ready",
			risk:       msJSON(200, msOperationalReady),
			inference:  msJSON(200, msInferenceReady),
			jobs:       msJSON(200, msOperationalReady),
			prevention: func(w http.ResponseWriter, r *http.Request) { panic("unreachable") },
			wantCode:   http.StatusServiceUnavailable,
			wantStates: []string{"risk=ready", "jobs=ready", "prevention=unknown", "inference=ready"},
		},
		{
			name:       "a body that is not the contracted one is unknown",
			risk:       msJSON(200, `{"status":"fine","message":"trust me"}`),
			inference:  msJSON(200, `{"status":"ready"}`),
			jobs:       msJSON(200, msOperationalReady),
			prevention: msJSON(200, msOperationalReady),
			wantCode:   http.StatusServiceUnavailable,
			wantStates: []string{"risk=unknown", "jobs=ready", "prevention=ready", "inference=unknown"},
		},
		{
			// Truthfulness: a 200 that reports itself unready is an incompatible
			// pair, so it is unknown rather than a combination this gateway invents.
			name:       "a 200 that reports itself unready is unknown",
			risk:       msJSON(200, msOperationalDegraded),
			inference:  msJSON(200, msInferenceReady),
			jobs:       msJSON(200, msOperationalReady),
			prevention: msJSON(200, msOperationalReady),
			wantCode:   http.StatusServiceUnavailable,
			wantStates: []string{"risk=unknown", "jobs=ready", "prevention=ready", "inference=ready"},
		},
		{
			// Truthfulness: a failure status over a ready document is incompatible.
			name:       "a 503 over a ready document is unknown",
			risk:       msJSON(200, msOperationalReady),
			inference:  msJSON(503, msInferenceReady),
			jobs:       msJSON(200, msOperationalReady),
			prevention: msJSON(200, msOperationalReady),
			wantCode:   http.StatusServiceUnavailable,
			wantStates: []string{"risk=ready", "jobs=ready", "prevention=ready", "inference=unknown"},
		},
		{
			// The correction this round exists for: a 503 that claims an unset
			// configuration is contradictory, and must never become a success.
			name:       "a 503 claiming not_configured is unknown, not a success",
			risk:       msJSON(200, msOperationalReady),
			inference:  msJSON(503, msInferenceUnset),
			jobs:       msJSON(200, msOperationalReady),
			prevention: msJSON(200, msOperationalReady),
			wantCode:   http.StatusServiceUnavailable,
			wantStates: []string{"risk=ready", "jobs=ready", "prevention=ready", "inference=unknown"},
		},
		{
			// The compatible pairs keep their documented states.
			name:       "a 503 degraded evidence stays degraded",
			risk:       msJSON(200, msOperationalReady),
			inference:  msJSON(503, msInferenceDegraded),
			jobs:       msJSON(200, msOperationalReady),
			prevention: msJSON(200, msOperationalReady),
			wantCode:   http.StatusServiceUnavailable,
			wantStates: []string{"risk=ready", "jobs=ready", "prevention=ready", "inference=degraded"},
		},
		{
			name:       "a 200 not_configured stays not_configured",
			risk:       msJSON(200, msOperationalReady),
			inference:  msJSON(200, msInferenceUnset),
			jobs:       msJSON(200, msOperationalReady),
			prevention: msJSON(200, msOperationalReady),
			wantCode:   http.StatusOK,
			wantStates: []string{"risk=ready", "jobs=ready", "prevention=ready", "inference=not_configured"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			gateway, token := msGateway(t, tc.risk, tc.inference, tc.jobs, tc.prevention)
			w := msRequest(t, gateway, token, "/v1/status")
			if w.Code != tc.wantCode {
				t.Fatalf("got %d want %d: %s", w.Code, tc.wantCode, w.Body.String())
			}
			assertResponseMatchesContract(t, contract, "/v1/status", http.MethodGet, w)
			if got := msStates(t, w); strings.Join(got, ",") != strings.Join(tc.wantStates, ",") {
				t.Fatalf("states = %v, want %v", got, tc.wantStates)
			}
		})
	}
}

// TestMultiserviceStatusEnforcesTheDeclaredRoles pins the policy the contract
// declares for this exact route: viewer, analista or admin —the three roles the
// ratified D-C matrix declares— read from the verified token's realm roles. A
// caller without any of them is refused 403 before any upstream is contacted, and
// a spoofed X-User-Role header grants nothing.
func TestMultiserviceStatusEnforcesTheDeclaredRoles(t *testing.T) {
	contract := loadContract(t)
	var upstreamCalls atomic.Int64
	record := func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls.Add(1)
		if r.URL.Path == "/v1/risk/inference/status" {
			_, _ = w.Write([]byte(msInferenceReady))
			return
		}
		_, _ = w.Write([]byte(msOperationalReady))
	}
	for _, tc := range []struct {
		name      string
		roles     []string
		wantCode  int
		wantCalls int64
	}{
		{"no realm role is refused", nil, http.StatusForbidden, 0},
		{"an unrelated role is refused", []string{"operator"}, http.StatusForbidden, 0},
		{"viewer is admitted", []string{"viewer"}, http.StatusOK, 4},
		{"analista is admitted", []string{"analista"}, http.StatusOK, 4},
		{"admin is admitted", []string{"admin"}, http.StatusOK, 4},
		// The role decision is membership in the set, never the first recognised
		// element: the demo realm hands its admin account both viewer and admin.
		{"viewer before analista is admitted", []string{"viewer", "analista"}, http.StatusOK, 4},
		{"viewer before admin is admitted", []string{"viewer", "admin"}, http.StatusOK, 4},
	} {
		t.Run(tc.name, func(t *testing.T) {
			upstreamCalls.Store(0)
			access := newMSAccess(t)
			gateway := msGatewayWith(t, access, record, record, record, record)
			w := msRequest(t, gateway, access.token(t, tc.roles...), "/v1/status")
			if w.Code != tc.wantCode {
				t.Fatalf("got %d want %d: %s", w.Code, tc.wantCode, w.Body.String())
			}
			assertResponseMatchesContract(t, contract, "/v1/status", http.MethodGet, w)
			if calls := upstreamCalls.Load(); calls != tc.wantCalls {
				t.Fatalf("upstream calls = %d, want %d: a refused caller must not reach any status target", calls, tc.wantCalls)
			}
		})
	}
}

// TestMultiserviceStatusIsNotAGlobalBoolean pins the two shapes the unit
// forbids: an overall readiness boolean and a gateway entry that goes unready
// with its dependencies.
func TestMultiserviceStatusIsNotAGlobalBoolean(t *testing.T) {
	unreachable := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	unreachable.Close()

	access := newMSAccess(t)
	gateway := New(access.verifier, msURL(t, unreachable.URL), msURL(t, unreachable.URL), msURL(t, unreachable.URL), "")
	w := msRequest(t, gateway, access.token(t, "viewer"), "/v1/status")
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("got %d want 503: %s", w.Code, w.Body.String())
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatalf("aggregate body is not JSON: %v", err)
	}
	if _, ok := raw["ready"]; ok {
		t.Error("the aggregate carries a global readiness boolean")
	}
	for _, key := range []string{"checked_at", "gateway", "services"} {
		if _, ok := raw[key]; !ok {
			t.Errorf("aggregate body is missing %q: %s", key, w.Body.String())
		}
	}
	body := msDecode(t, w)
	if body.Gateway.State != "ready" {
		t.Errorf("gateway state = %q, want ready: the process that answered is reachable even when its dependencies are not", body.Gateway.State)
	}
	for _, state := range msStates(t, w) {
		if !strings.HasSuffix(state, "=unknown") {
			t.Errorf("unreachable service reported %q, want unknown", state)
		}
	}
}

// TestMultiserviceStatusForwardsOnlyTheCallerCredential pins the boundary: the
// four targets come from configuration, the gateway's own correlation id is the
// only other header, and no caller-supplied path or header chooses or reaches a
// target.
func TestMultiserviceStatusForwardsOnlyTheCallerCredential(t *testing.T) {
	type seen struct {
		path    string
		query   string
		headers http.Header
	}
	var mu sync.Mutex
	var requests []seen
	record := func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		requests = append(requests, seen{path: r.URL.Path, query: r.URL.RawQuery, headers: r.Header.Clone()})
		mu.Unlock()
		_, _ = w.Write([]byte(`{}`))
	}
	gateway, token := msGateway(t, record, record, record, record)
	w := msRequest(t, gateway, token, "/v1/status?target=http://metadata.invalid&service=all")
	mu.Lock()
	defer mu.Unlock()
	if len(requests) != 4 {
		t.Fatalf("fan-out made %d requests, want exactly 4", len(requests))
	}
	minted := w.Header().Get("X-Request-ID")
	if minted == "" || minted == "spoofed" {
		t.Fatalf("gateway correlation id = %q, want a freshly minted one", minted)
	}
	wantPaths := map[string]bool{"/v1/risk/status": true, "/v1/jobs/status": true, "/v1/prevention/status": true, "/v1/risk/inference/status": true}
	for _, request := range requests {
		if !wantPaths[request.path] {
			t.Errorf("fan-out reached %q, which is not one of the four configured targets", request.path)
		}
		delete(wantPaths, request.path)
		if request.query != "" {
			t.Errorf("%q was called with query %q; the aggregate supplies none", request.path, request.query)
		}
		if got := request.headers.Get("Authorization"); got != "Bearer "+token {
			t.Errorf("%q got Authorization %q, want the caller's own credential", request.path, got)
		}
		if got := request.headers.Get("X-Request-ID"); got != minted {
			t.Errorf("%q got X-Request-ID %q, want %q", request.path, got, minted)
		}
		for _, name := range []string{"X-User-ID", "X-User-Role", "X-Forwarded-For", "Cookie", "Origin"} {
			if got := request.headers.Get(name); got != "" {
				t.Errorf("%q relaid the caller-supplied %s: %q", request.path, name, got)
			}
		}
	}
	if len(wantPaths) != 0 {
		t.Errorf("fan-out never reached %v", wantPaths)
	}
}

// TestMultiserviceStatusRelaysNoUpstreamBody pins that the answer is derived
// evidence, never a copy: not even a field of the upstream body reaches the
// caller.
func TestMultiserviceStatusRelaysNoUpstreamBody(t *testing.T) {
	secret := "internal-host risk-db-primary password=hunter2"
	leaky := msJSON(200, `{"checked_at":"2026-10-20T12:00:00Z","ready":true,"reason":"`+secret+`","dependencies":{"database":{"state":"ready"}}}`)
	gateway, token := msGateway(t, leaky, leaky, leaky, leaky)
	w := msRequest(t, gateway, token, "/v1/status")
	if strings.Contains(w.Body.String(), secret) || strings.Contains(w.Body.String(), "hunter2") || strings.Contains(w.Body.String(), "risk-db-primary") {
		t.Fatalf("the aggregate relayed upstream detail: %s", w.Body.String())
	}
	if strings.Contains(w.Body.String(), "reason") {
		t.Errorf("the aggregate relays an upstream reason field: %s", w.Body.String())
	}
}

// TestMultiserviceStatusDetectsCapOverflow pins the bounded read as a length
// check, not a truncation: a contracted body followed by padding beyond the
// read bound is refused instead of being parsed as the prefix it starts with.
func TestMultiserviceStatusDetectsCapOverflow(t *testing.T) {
	// The prefix is a complete, valid contracted body; only the padding makes it
	// bigger than the bound. A truncating reader would answer ready.
	paddedOperational := msJSON(200, msOperationalReady+strings.Repeat(" ", statusBodyLimit))
	paddedInference := msJSON(200, msInferenceReady+strings.Repeat(" ", statusBodyLimit))
	gateway, token := msGateway(t, paddedOperational, paddedInference, paddedOperational, paddedOperational)
	w := msRequest(t, gateway, token, "/v1/status")
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("got %d want 503: an oversized body is not evidence", w.Code)
	}
	for _, state := range msStates(t, w) {
		if !strings.HasSuffix(state, "=unknown") {
			t.Fatalf("oversized body reported %q, want unknown", state)
		}
	}
}

// TestMultiserviceStatusReadsBodiesBounded pins that a body larger than the
// bound is not buffered and that only a contracted body inside the bound can
// produce ready.
func TestMultiserviceStatusReadsBodiesBounded(t *testing.T) {
	huge := msJSON(200, strings.Repeat(" ", 1<<20)+msOperationalReady)
	gateway, token := msGateway(t, huge, msJSON(200, msInferenceReady), msJSON(200, msOperationalReady), msJSON(200, msOperationalReady))
	start := time.Now()
	w := msRequest(t, gateway, token, "/v1/status")
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("aggregate took %s for a 1 MiB body", elapsed)
	}
	states := msStates(t, w)
	if states[0] != "risk=unknown" {
		t.Fatalf("risk = %q, want unknown: only a contracted body inside the read bound is evidence", states[0])
	}
	if strings.Contains(w.Body.String(), "  ") {
		t.Error("the aggregate relayed padding from an upstream body")
	}
}

// TestMultiserviceStatusFanOutIsBoundedAndSiblingsIndependent drives the
// aggregate core with one probe that never returns: the answer must arrive at
// the deadline, the stuck probe must be unknown, and its siblings must still
// report what they observed.
func TestMultiserviceStatusFanOutIsBoundedAndSiblingsIndependent(t *testing.T) {
	release := make(chan struct{})
	defer close(release)
	probes := []statusProbe{
		{service: "risk", evaluate: func(context.Context, statusCredential) string { return serviceReady }},
		{service: "jobs", evaluate: func(context.Context, statusCredential) string { <-release; return serviceReady }},
		{service: "prevention", evaluate: func(context.Context, statusCredential) string { return serviceDegraded }},
		{service: "inference", evaluate: func(context.Context, statusCredential) string { return serviceNotConfigured }},
	}
	agg := multiserviceStatus(probes, 50*time.Millisecond)
	start := time.Now()
	w := msRequest(t, agg, "", "/v1/status")
	elapsed := time.Since(start)
	if elapsed > time.Second {
		t.Fatalf("aggregate took %s with a 50 ms budget; the deadline must bound the fan-out", elapsed)
	}
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("got %d want 503: a stuck probe is not ready", w.Code)
	}
	want := []string{"risk=ready", "jobs=unknown", "prevention=degraded", "inference=not_configured"}
	if got := msStates(t, w); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("states = %v, want %v", got, want)
	}
}

// TestMultiserviceStatusHonoursIncomingCancellation pins that a cancelled caller
// ends the fan-out: the budget is 5 s, so returning quickly proves the request's
// own context stops the read, and the sibling that already observed its state
// keeps reporting it.
func TestMultiserviceStatusHonoursIncomingCancellation(t *testing.T) {
	probes := []statusProbe{
		{service: "risk", evaluate: func(context.Context, statusCredential) string { return serviceReady }},
		{service: "jobs", evaluate: func(ctx context.Context, _ statusCredential) string { <-ctx.Done(); return serviceUnknown }},
		{service: "prevention", evaluate: func(context.Context, statusCredential) string { return serviceReady }},
		{service: "inference", evaluate: func(context.Context, statusCredential) string { return serviceNotConfigured }},
	}
	agg := multiserviceStatus(probes, 5*time.Second)
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(20*time.Millisecond, cancel)
	defer cancel()

	r := httptest.NewRequest(http.MethodGet, "/v1/status", nil).WithContext(ctx)
	w := httptest.NewRecorder()
	start := time.Now()
	agg.ServeHTTP(w, r)
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("aggregate took %s after the caller cancelled; the request context must bound the fan-out", elapsed)
	}
	want := []string{"risk=ready", "jobs=unknown", "prevention=ready", "inference=not_configured"}
	if got := msStates(t, w); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("states = %v, want %v", got, want)
	}
}

// TestMultiserviceStatusPanickingProbeIsIsolated pins that one broken probe
// cannot take the process, or its siblings' answers, down with it.
func TestMultiserviceStatusPanickingProbeIsIsolated(t *testing.T) {
	probes := []statusProbe{
		{service: "risk", evaluate: func(context.Context, statusCredential) string { panic("broken probe") }},
		{service: "jobs", evaluate: func(context.Context, statusCredential) string { return serviceReady }},
		{service: "prevention", evaluate: func(context.Context, statusCredential) string { return serviceReady }},
		{service: "inference", evaluate: func(context.Context, statusCredential) string { return serviceNotConfigured }},
	}
	w := msRequest(t, multiserviceStatus(probes, time.Second), "", "/v1/status")
	want := []string{"risk=unknown", "jobs=ready", "prevention=ready", "inference=not_configured"}
	if got := msStates(t, w); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("states = %v, want %v", got, want)
	}
}

// TestMultiserviceStatusKeepsAFixedBoundAndOrder pins the hard bound: the list
// is exactly the four declared services in the declared order, whatever a
// caller or a future wiring passes in.
func TestMultiserviceStatusKeepsAFixedBoundAndOrder(t *testing.T) {
	alwaysReady := func(context.Context, statusCredential) string { return serviceReady }
	probes := []statusProbe{
		{service: "weather", evaluate: alwaysReady},
		{service: "risk", evaluate: alwaysReady},
		{service: "jobs", evaluate: alwaysReady},
		{service: "prevention", evaluate: alwaysReady},
		{service: "inference", evaluate: alwaysReady},
		{service: "extra", evaluate: alwaysReady},
	}
	body := msDecode(t, msRequest(t, multiserviceStatus(probes, time.Second), "", "/v1/status"))
	if len(body.Services) != 4 {
		t.Fatalf("aggregate served %d services, want the fixed bound of 4: %+v", len(body.Services), body.Services)
	}
	var order []string
	for _, entry := range body.Services {
		order = append(order, entry.Service)
	}
	if got := strings.Join(order, ","); got != "weather,risk,jobs,prevention" {
		t.Fatalf("aggregate reordered the probes: %q", got)
	}
}

// TestMultiserviceStatusRequiresTheBearerGate pins that the aggregate is not a
// hole in the existing gate: no token, no aggregate.
func TestMultiserviceStatusRequiresTheBearerGate(t *testing.T) {
	contract := loadContract(t)
	gateway, token := msGateway(t, msJSON(200, msOperationalReady), msJSON(200, msInferenceReady), msJSON(200, msOperationalReady), msJSON(200, msOperationalReady))
	for _, bearer := range []string{"", "expired"} {
		w := msRequest(t, gateway, bearer, "/v1/status")
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("token %q got %d, want 401", bearer, w.Code)
		}
		assertResponseMatchesContract(t, contract, "/v1/status", http.MethodGet, w)
	}
	// The minted viewer token is still accepted, so the gate above is the reason
	// for the 401 rather than a broken fixture.
	if w := msRequest(t, gateway, token, "/v1/status"); w.Code != http.StatusOK {
		t.Fatalf("viewer token got %d, want 200: %s", w.Code, w.Body.String())
	}
}

// TestMultiserviceStatusLeavesTheRawStatusRoutesForwarded pins S3: the existing
// service-owned status routes keep forwarding exactly what their service
// answered, unchanged by the new aggregate.
func TestMultiserviceStatusLeavesTheRawStatusRoutesForwarded(t *testing.T) {
	gateway, token := msGateway(t, msJSON(503, msOperationalDegraded), msJSON(200, msInferenceReady), msJSON(200, msOperationalReady), msJSON(200, msOperationalReady))
	w := msRequest(t, gateway, token, "/v1/risk/status")
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("raw /v1/risk/status got %d, want 503", w.Code)
	}
	if got := strings.TrimSpace(w.Body.String()); got != msOperationalDegraded {
		t.Fatalf("raw /v1/risk/status body changed:\n got %s\nwant %s", got, msOperationalDegraded)
	}
}
