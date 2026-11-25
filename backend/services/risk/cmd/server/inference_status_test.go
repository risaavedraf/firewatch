package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"firewatch.local/risk/internal/handler"
	"github.com/getkin/kin-openapi/openapi3"
)

// The evidence probe is the one part of this unit that leaves the process, so it
// is pinned here: the address comes from configuration only, the caller's
// credential is never forwarded, a plaintext address is refused outside
// development, redirects are not followed, the configured CA is the only trust
// anchor, the health document must be the contracted one, and the read is
// bounded.

// inferenceContractPath locates the published inference contract from this
// package's working directory. The health document the probe accepts is defined
// there, so the test proves its acceptance criterion against the same document
// the inference service's own handler is validated against.
var inferenceContractPath = filepath.Join("..", "..", "..", "..", "contracts", "openapi", "inference-v1.yaml")

// inferenceHealthFixture is the document the real inference handler answers on
// GET /health: every field the contract declares required, in its real form.
const inferenceHealthFixture = `{"status":"ready","format":"firewatch-model/v1","model_version":"valparaiso-logistic-v1","data_hash":"9f2c41d7b0e35a6c18d4f7e2a9b03c5d6e8f1a2b4c7d9e0f3a5b6c8d1e2f4a7b","kind":"logistic","trained_at":"2026-11-01T00:00:00Z","feature_count":7,"thresholds":{"medium":0.42,"high":0.68}}`

// loadInferenceHealthSchema loads the published inference contract and returns
// its Health schema, so a fixture can be proven to be the contracted document
// instead of a shape invented by this test.
func loadInferenceHealthSchema(t *testing.T) *openapi3.Schema {
	t.Helper()
	loader := openapi3.NewLoader()
	contract, err := loader.LoadFromFile(inferenceContractPath)
	if err != nil {
		t.Fatalf("load the inference contract: %v", err)
	}
	if err := contract.Validate(context.Background()); err != nil {
		t.Fatalf("the inference contract is not valid: %v", err)
	}
	schema := contract.Components.Schemas["Health"]
	if schema == nil || schema.Value == nil {
		t.Fatal("the inference contract declares no Health schema")
	}
	return schema.Value
}

// inferenceProbeRequest is what a stub inference service observed.
type inferenceProbeRequest struct {
	path    string
	query   string
	headers http.Header
}

// inferenceProbeServer answers every inference route with one health document
// and records what arrived.
func inferenceProbeServer(t *testing.T, body string) (*httptest.Server, func() []inferenceProbeRequest) {
	t.Helper()
	var mu sync.Mutex
	var requests []inferenceProbeRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		requests = append(requests, inferenceProbeRequest{path: r.URL.Path, query: r.URL.RawQuery, headers: r.Header.Clone()})
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(server.Close)
	return server, func() []inferenceProbeRequest {
		mu.Lock()
		defer mu.Unlock()
		return append([]inferenceProbeRequest(nil), requests...)
	}
}

// TestInferenceStatusEvidenceWithoutAddressIsNotConfigured pins S4's honest
// empty case: a deployment that configures no inference address runs rule
// classifiers only, so the evidence says so and nothing is dialled.
func TestInferenceStatusEvidenceWithoutAddressIsNotConfigured(t *testing.T) {
	got := newInferenceStatusCheck("", nil, time.Second, "production")(context.Background())
	if got.State != handler.InferenceNotConfigured {
		t.Fatalf("state = %q, want %q", got.State, handler.InferenceNotConfigured)
	}
	if got.Reason != "not_configured" {
		t.Fatalf("reason = %q, want not_configured", got.Reason)
	}
	if got.CheckedAt.IsZero() {
		t.Fatal("evidence carries no evaluation instant")
	}
}

// TestInferenceStatusEvidenceUsesTheConfiguredAddressOnly pins that the probe
// calls the health path of the configured service and nothing a caller could
// supply: a path or query configured in the address does not steer it.
func TestInferenceStatusEvidenceUsesTheConfiguredAddressOnly(t *testing.T) {
	server, seen := inferenceProbeServer(t, inferenceHealthFixture)
	got := newInferenceStatusCheck(server.URL+"/some/other/path?target=elsewhere", nil, time.Second, "development")(context.Background())
	if got.State != handler.InferenceReady {
		t.Fatalf("state = %q, want ready: %s", got.State, server.URL)
	}
	requests := seen()
	if len(requests) != 1 {
		t.Fatalf("the probe made %d requests, want exactly one", len(requests))
	}
	if requests[0].path != "/health" {
		t.Fatalf("probe path = %q, want the configured /health", requests[0].path)
	}
	if requests[0].query != "" {
		t.Fatalf("probe query = %q, want none", requests[0].query)
	}
	for _, name := range []string{"Authorization", "Cookie", "X-User-ID", "X-User-Role"} {
		if value := requests[0].headers.Get(name); value != "" {
			t.Fatalf("the probe forwarded %s: %q; inference is called with no caller credential", name, value)
		}
	}
}

// TestInferenceStatusEvidenceRefusesPlaintextOutsideDevelopment pins the TLS
// policy this service already applies to every outbound address: outside the
// literal development environment a plaintext target is refused before anything
// is dialled, and a configured internal CA does not make plaintext private.
func TestInferenceStatusEvidenceRefusesPlaintextOutsideDevelopment(t *testing.T) {
	server, seen := inferenceProbeServer(t, inferenceHealthFixture)
	_, _, caFile := testTLSKeyPair(t)
	pool, err := rootCAsFromFile(caFile)
	if err != nil {
		t.Fatalf("load the configured CA: %v", err)
	}
	if got := newInferenceStatusCheck(server.URL, nil, time.Second, "production")(context.Background()); got.State != handler.InferenceDegraded {
		t.Fatalf("state with no CA = %q, want degraded: plaintext is refused outside development", got.State)
	}
	if got := newInferenceStatusCheck(server.URL, pool, time.Second, "production")(context.Background()); got.State != handler.InferenceDegraded {
		t.Fatalf("state with a configured CA = %q, want degraded: a CA does not make plaintext private", got.State)
	}
	if requests := seen(); len(requests) != 0 {
		t.Fatalf("the refused plaintext address was contacted %d time(s): %+v", len(requests), requests)
	}
	// The explicit development exception still allows the local stack to use http.
	if got := newInferenceStatusCheck(server.URL, nil, time.Second, "development")(context.Background()); got.State != handler.InferenceReady {
		t.Fatalf("state in development = %q, want ready", got.State)
	}
}

// TestInferenceStatusEvidenceValidatesTheContractedHealthDocument pins what
// counts as the inference service's own readiness: the document the published
// inference contract declares, not any JSON object that happens to say "ready".
func TestInferenceStatusEvidenceValidatesTheContractedHealthDocument(t *testing.T) {
	schema := loadInferenceHealthSchema(t)
	for _, tc := range []struct {
		name  string
		body  string
		ready bool
	}{
		{"the contracted document", inferenceHealthFixture, true},
		{"an extra health field", `{"extra":true,` + inferenceHealthFixture[1:], false},
		{"an extra threshold field", inferenceHealthFixture[:len(inferenceHealthFixture)-2] + `,"extra":true}}`, false},
		{"a minimal object that only says ready", `{"status":"ready"}`, false},
		{"the right fields with an unsupported format", `{"status":"ready","format":"other/v1","model_version":"v","data_hash":"h","kind":"logistic","trained_at":"2026-11-01T00:00:00Z","feature_count":7,"thresholds":{"medium":0.4,"high":0.6}}`, false},
		{"the right fields with an unsupported kind", `{"status":"ready","format":"firewatch-model/v1","model_version":"v","data_hash":"h","kind":"svm","trained_at":"2026-11-01T00:00:00Z","feature_count":7,"thresholds":{"medium":0.4,"high":0.6}}`, false},
		{"a missing threshold", `{"status":"ready","format":"firewatch-model/v1","model_version":"v","data_hash":"h","kind":"forest","trained_at":"2026-11-01T00:00:00Z","feature_count":7,"thresholds":{"medium":0.4}}`, false},
		{"a threshold outside the unit interval", `{"status":"ready","format":"firewatch-model/v1","model_version":"v","data_hash":"h","kind":"forest","trained_at":"2026-11-01T00:00:00Z","feature_count":7,"thresholds":{"medium":0.4,"high":1.6}}`, false},
		{"an unparsable training instant", `{"status":"ready","format":"firewatch-model/v1","model_version":"v","data_hash":"h","kind":"forest","trained_at":"yesterday","feature_count":7,"thresholds":{"medium":0.4,"high":0.6}}`, false},
		{"a document that is not ready", `{"status":"starting","format":"firewatch-model/v1","model_version":"v","data_hash":"h","kind":"forest","trained_at":"2026-11-01T00:00:00Z","feature_count":7,"thresholds":{"medium":0.4,"high":0.6}}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// For the positive case the fixture must be the contracted document, which is
			// what makes the probe's acceptance criterion the contract's and not this
			// test's opinion. Negative cases may still be contract-valid JSON (a document
			// that is not ready is not an error there), so for them the proof is the
			// probe's state assertion below.
			var document any
			if err := json.Unmarshal([]byte(tc.body), &document); err != nil {
				t.Fatalf("fixture is not JSON: %v", err)
			}
			if verifyErr := schema.VisitJSON(document); tc.ready && verifyErr != nil {
				t.Fatalf("the fixture is not the contracted Health document: %v", verifyErr)
			}
			server, _ := inferenceProbeServer(t, tc.body)
			got := newInferenceStatusCheck(server.URL, nil, time.Second, "development")(context.Background())
			wantState := handler.InferenceDegraded
			if tc.ready {
				wantState = handler.InferenceReady
			}
			if got.State != wantState {
				t.Fatalf("state = %q, want %q for body %s", got.State, wantState, tc.body)
			}
		})
	}
}

// TestInferenceStatusEvidenceDetectsCapOverflow pins the bounded read as a
// length check: a valid health document followed by padding beyond the bound is
// refused instead of being parsed as the prefix it starts with.
func TestInferenceStatusEvidenceDetectsCapOverflow(t *testing.T) {
	padded := inferenceHealthFixture + strings.Repeat(" ", inferenceHealthBodyLimit)
	server, _ := inferenceProbeServer(t, padded)
	if got := newInferenceStatusCheck(server.URL, nil, time.Second, "development")(context.Background()); got.State != handler.InferenceDegraded {
		t.Fatalf("state = %q, want degraded: a body beyond the read bound is not the health document", got.State)
	}
}

// TestInferenceStatusEvidenceFollowsNoRedirect pins that a redirected probe is
// degraded evidence, not a request to wherever the answer points.
func TestInferenceStatusEvidenceFollowsNoRedirect(t *testing.T) {
	var targetHits atomic.Int64
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		targetHits.Add(1)
		_, _ = w.Write([]byte(inferenceHealthFixture))
	}))
	t.Cleanup(target.Close)
	redirecting := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/health", http.StatusFound)
	}))
	t.Cleanup(redirecting.Close)

	got := newInferenceStatusCheck(redirecting.URL, nil, time.Second, "development")(context.Background())
	if got.State != handler.InferenceDegraded {
		t.Fatalf("state = %q, want degraded: a redirect is not the service's own health document", got.State)
	}
	if hits := targetHits.Load(); hits != 0 {
		t.Fatalf("the probe followed a redirect %d time(s)", hits)
	}
}

// TestInferenceStatusEvidenceUsesTheConfiguredRootCAs pins the TLS boundary: the
// configured pool is the only anchor the probe trusts, and the same address with
// no pool is not evidence of readiness.
func TestInferenceStatusEvidenceUsesTheConfiguredRootCAs(t *testing.T) {
	certFile, keyFile, caFile := testTLSKeyPair(t)
	pair, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		t.Fatalf("load the test key pair: %v", err)
	}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(inferenceHealthFixture))
	}))
	server.TLS = &tls.Config{Certificates: []tls.Certificate{pair}}
	server.StartTLS()
	t.Cleanup(server.Close)

	pool, err := rootCAsFromFile(caFile)
	if err != nil {
		t.Fatalf("load the configured CA: %v", err)
	}
	if got := newInferenceStatusCheck(server.URL, pool, time.Second, "production")(context.Background()); got.State != handler.InferenceReady {
		t.Fatalf("state with the configured CA = %q, want ready", got.State)
	}
	if got := newInferenceStatusCheck(server.URL, nil, time.Second, "production")(context.Background()); got.State != handler.InferenceDegraded {
		t.Fatalf("state with the system roots = %q, want degraded: the throwaway CA is not trusted there", got.State)
	}
}

// TestInferenceStatusEvidenceIsBounded pins that a service which accepts the
// connection and then stalls is answered at the deadline instead of holding the
// caller's read open.
func TestInferenceStatusEvidenceIsBounded(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	t.Cleanup(server.Close)
	t.Cleanup(func() { close(release) })

	start := time.Now()
	got := newInferenceStatusCheck(server.URL, nil, 50*time.Millisecond, "development")(context.Background())
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("the probe took %s with a 50 ms bound", elapsed)
	}
	if got.State != handler.InferenceDegraded {
		t.Fatalf("state = %q, want degraded", got.State)
	}
}

// TestInferenceStatusEvidenceRefusesOtherAnswers pins that only the service's own
// ready health document is evidence: another status or an unparsable address is
// degraded, never ready.
func TestInferenceStatusEvidenceRefusesOtherAnswers(t *testing.T) {
	notJSON := func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("not a document")) }
	failing := func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusInternalServerError) }

	for _, tc := range []struct {
		name  string
		serve http.HandlerFunc
	}{
		{"a body that is not JSON", notJSON},
		{"a failing status", failing},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(tc.serve)
			t.Cleanup(server.Close)
			if got := newInferenceStatusCheck(server.URL, nil, time.Second, "development")(context.Background()); got.State != handler.InferenceDegraded {
				t.Fatalf("state = %q, want degraded", got.State)
			}
		})
	}

	if got := newInferenceStatusCheck("://not a url", nil, time.Second, "development")(context.Background()); got.State != handler.InferenceDegraded {
		t.Fatalf("state for an unparsable address = %q, want degraded", got.State)
	}
	if got := newInferenceStatusCheck("inference-without-a-scheme:8080", nil, time.Second, "development")(context.Background()); got.State != handler.InferenceDegraded {
		t.Fatalf("state for a non-http address = %q, want degraded", got.State)
	}
}

// TestInferenceStatusEvidenceTruncatesTheBody pins the bounded read: a service
// that streams more than the read bound is not buffered whole.
func TestInferenceStatusEvidenceTruncatesTheBody(t *testing.T) {
	var written atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		chunk := []byte(strings.Repeat("x", 4096))
		for written.Load() < 8<<20 {
			if _, err := w.Write(chunk); err != nil {
				return
			}
			written.Add(int64(len(chunk)))
		}
	}))
	t.Cleanup(server.Close)

	start := time.Now()
	got := newInferenceStatusCheck(server.URL, nil, time.Second, "development")(context.Background())
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("the probe took %s for an oversized body", elapsed)
	}
	if got.State != handler.InferenceDegraded {
		t.Fatalf("state = %q, want degraded: an oversized body is not a ready document", got.State)
	}
}
