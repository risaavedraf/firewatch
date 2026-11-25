package handler

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/go-jose/go-jose/v4"
	"github.com/google/uuid"
)

// inferenceEvidenceApp mounts the inference evidence route through the same
// constructor and the same Authorize gate the deployment uses, so a test cannot
// pass by exercising a handler that production never reaches.
func inferenceEvidenceApp(t *testing.T, role string, check InferenceStatusCheck) (http.Handler, string) {
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
	payload, _ := json.Marshal(map[string]any{
		"iss": "https://issuer.test", "aud": "firewatch-api", "sub": "subject",
		"exp": time.Now().Add(time.Minute).Unix(), "typ": "Bearer",
		"realm_access": map[string]any{"roles": []string{role}},
	})
	signed, err := signer.Sign(payload)
	if err != nil {
		t.Fatal(err)
	}
	token, err := signed.CompactSerialize()
	if err != nil {
		t.Fatal(err)
	}
	return withCorrelationID(NewWithInferenceEvidence(&fakeStore{}, verifier, nil, nil, nil, check)), token
}

func inferenceEvidenceRequest(t *testing.T, app http.Handler, bearer string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/v1/risk/inference/status", nil)
	r.Header.Set("X-Request-ID", uuid.NewString())
	if bearer != "" {
		r.Header.Set("Authorization", "Bearer "+bearer)
	}
	w := httptest.NewRecorder()
	app.ServeHTTP(w, r)
	return w
}

type inferenceEvidenceBody struct {
	CheckedAt string `json:"checked_at"`
	State     string `json:"state"`
	Reason    string `json:"reason"`
}

func inferenceEvidenceOf(t *testing.T, w *httptest.ResponseRecorder) inferenceEvidenceBody {
	t.Helper()
	var body inferenceEvidenceBody
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("evidence body is not JSON: %v: %s", err, w.Body.String())
	}
	return body
}

// TestInferenceStatusEvidenceMatchesTheContract pins the four states this route
// can report and the 200/503 boundary between them: not_configured is not a
// failure, degraded is.
func TestInferenceStatusEvidenceMatchesTheContract(t *testing.T) {
	contract := loadContract(t)
	checkOf := func(state, reason string) InferenceStatusCheck {
		return func(context.Context) InferenceStatus {
			return InferenceStatus{CheckedAt: time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC), State: state, Reason: reason}
		}
	}
	for _, tc := range []struct {
		name       string
		role       string
		check      InferenceStatusCheck
		wantCode   int
		wantState  string
		wantReason string
	}{
		{"ready evidence", "viewer", checkOf(InferenceReady, ""), http.StatusOK, InferenceReady, ""},
		{"unconfigured inference is not a failure", "admin", checkOf(InferenceNotConfigured, "not_configured"), http.StatusOK, InferenceNotConfigured, "not_configured"},
		{"unreachable inference is degraded", "viewer", checkOf(InferenceDegraded, "inference_unavailable"), http.StatusServiceUnavailable, InferenceDegraded, "inference_unavailable"},
		{"no evaluator wired", "viewer", nil, http.StatusServiceUnavailable, InferenceUnknown, "status_unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			app, token := inferenceEvidenceApp(t, tc.role, tc.check)
			w := inferenceEvidenceRequest(t, app, token)
			if w.Code != tc.wantCode {
				t.Fatalf("got %d want %d: %s", w.Code, tc.wantCode, w.Body.String())
			}
			assertResponseMatchesContract(t, contract, "/v1/risk/inference/status", http.MethodGet, w)
			body := inferenceEvidenceOf(t, w)
			if body.State != tc.wantState || body.Reason != tc.wantReason {
				t.Fatalf("evidence = %+v, want state %q reason %q", body, tc.wantState, tc.wantReason)
			}
		})
	}
}

// TestInferenceStatusEvidenceIsBehindTheBearerGate pins that the evidence read
// is authenticated exactly like its siblings, and that an unauthenticated caller
// learns nothing about the configured inference service.
func TestInferenceStatusEvidenceIsBehindTheBearerGate(t *testing.T) {
	contract := loadContract(t)
	app, _ := inferenceEvidenceApp(t, "viewer", func(context.Context) InferenceStatus {
		t.Error("an unauthenticated request reached the evidence evaluator")
		return InferenceStatus{}
	})
	w := inferenceEvidenceRequest(t, app, "")
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("got %d want 401: %s", w.Code, w.Body.String())
	}
	assertResponseMatchesContract(t, contract, "/v1/risk/inference/status", http.MethodGet, w)
}

// TestInferenceStatusEvidenceCarriesOnlyItsOwnFields pins that the evidence is a
// summary of this route's own evaluation: nothing about the inference service's
// body, threshold, version or address reaches the caller.
func TestInferenceStatusEvidenceCarriesOnlyItsOwnFields(t *testing.T) {
	app, token := inferenceEvidenceApp(t, "viewer", func(context.Context) InferenceStatus {
		return InferenceStatus{CheckedAt: time.Now().UTC(), State: InferenceDegraded, Reason: "inference_unavailable"}
	})
	w := inferenceEvidenceRequest(t, app, token)
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatalf("evidence body is not JSON: %v", err)
	}
	if len(raw) != 3 {
		t.Fatalf("evidence body has %d fields, want exactly checked_at, state, reason: %s", len(raw), w.Body.String())
	}
	for _, key := range []string{"checked_at", "state", "reason"} {
		if _, ok := raw[key]; !ok {
			t.Errorf("evidence body is missing %q: %s", key, w.Body.String())
		}
	}
}
