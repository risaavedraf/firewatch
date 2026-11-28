package handler

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"firewatch.local/jobs/internal/repository"
	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/go-jose/go-jose/v4"
	"github.com/google/uuid"
)

// rolesHandler builds the production transport over a signer this test owns, so
// one handler serves every role combination without a remote JWKS. The subject is
// fixed so a test can assert the identity the transport forwards to the store.
func rolesHandler(t *testing.T, store *fakeStore, checks ...StatusCheck) (http.Handler, func(roles ...string) string) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	verifier := oidc.NewVerifier("https://issuer.test", &oidc.StaticKeySet{PublicKeys: []crypto.PublicKey{&key.PublicKey}}, &oidc.Config{ClientID: "firewatch-api", SupportedSigningAlgs: []string{"RS256"}})
	mint := func(roles ...string) string {
		claims := map[string]any{"iss": "https://issuer.test", "aud": "firewatch-api", "sub": "operator-subject", "name": "Operador Verificado", "exp": time.Now().Add(time.Minute).Unix(), "typ": "Bearer", "realm_access": map[string]any{"roles": roles}}
		return signTokenWith(t, key, jose.RS256, claims)
	}
	return New(store, verifier, checks...), mint
}

// readyCheck is a readiness probe that counts its calls, so a test can prove a
// refused role never ran it.
func readyCheck(calls *int) StatusCheck {
	return func(context.Context) Status {
		*calls++
		now := time.Now().UTC()
		depth, age := int64(0), float64(0)
		return Status{CheckedAt: now, Ready: true, Dependencies: Dependencies{Database: Dependency{"ready"}, Broker: Dependency{"ready"}, DeadLetter: DeadLetterStatus{State: "ready", Depth: &depth, SampledAt: &now, AgeSeconds: &age, MaxAgeSeconds: &age, MaxDepth: &depth}}}
	}
}

// PM-15 (D-C) — the ratified permission matrix for the jobs service.
//
// Two rows matter here and they pull in opposite directions:
//
//   - «Consultas GET» answers «Sí» for viewer, analista and admin, so the job
//     reads and the activity register stop being admin-only;
//   - «Disparar evaluación / jobs» answers «No» for viewer and «Sí» for analista
//     and admin, so creating a job and replaying one stay a tactical operation
//     and a viewer is refused with the documented 403 before storage is reached.
//
// The role decision is membership in the set, never the first recognised
// element: the demo realm hands its admin account BOTH viewer and admin, so every
// case carries the whole list.

// TestJobReadsAreAvailableToEveryDeclaredRole pins the read row of the matrix: a
// declared role reads the status, one job and the activity register, and an
// undeclared role is still refused.
func TestJobReadsAreAvailableToEveryDeclaredRole(t *testing.T) {
	const id = "6f1c1c1e-0000-4000-8000-000000000001"
	for _, tc := range []struct {
		name  string
		roles []string
		want  int
	}{
		{"viewer reads a job", []string{"viewer"}, http.StatusOK},
		{"analista reads a job", []string{"analista"}, http.StatusOK},
		{"admin reads a job", []string{"viewer", "admin"}, http.StatusOK},
		{"undeclared role is refused", []string{"operator"}, http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &fakeStore{job: repository.Job{ID: id, ZoneID: "valparaiso-demo", State: "queued"}}
			handler, mint := rolesHandler(t, store)
			r := httptest.NewRequest(http.MethodGet, "/v1/jobs/"+id, nil)
			r.Header.Set("Authorization", "Bearer "+mint(tc.roles...))
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Fatalf("got %d want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if tc.want == http.StatusForbidden && store.getCalls != 0 {
				t.Fatal("a refused role reached storage")
			}
		})
	}
}

// TestJobStatusIsAvailableToEveryDeclaredRole is the same read row on the status
// route, which had its own authorization list before the matrix existed.
func TestJobStatusIsAvailableToEveryDeclaredRole(t *testing.T) {
	for _, tc := range []struct {
		name  string
		roles []string
		want  int
	}{
		{"viewer reads", []string{"viewer"}, http.StatusOK},
		{"analista reads", []string{"analista"}, http.StatusOK},
		{"admin reads", []string{"admin"}, http.StatusOK},
		{"undeclared role is refused", []string{"operator"}, http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			handler, mint := rolesHandler(t, &fakeStore{}, readyCheck(&calls))
			r := httptest.NewRequest(http.MethodGet, "/v1/jobs/status", nil)
			r.Header.Set("Authorization", "Bearer "+mint(tc.roles...))
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Fatalf("got %d want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if tc.want == http.StatusForbidden && calls != 0 {
				t.Fatal("a refused role ran the readiness check")
			}
		})
	}
}

// TestCreatingAJobIsATacticalOperation pins the write row of the matrix: analista
// and admin request a job, viewer is refused 403 and the store is never reached.
func TestCreatingAJobIsATacticalOperation(t *testing.T) {
	for _, tc := range []struct {
		name      string
		roles     []string
		want      int
		wantCalls bool
	}{
		{"analista requests", []string{"analista"}, http.StatusAccepted, true},
		{"viewer before analista keeps the right", []string{"viewer", "analista"}, http.StatusAccepted, true},
		{"admin requests", []string{"viewer", "admin"}, http.StatusAccepted, true},
		{"viewer is refused", []string{"viewer"}, http.StatusForbidden, false},
		{"undeclared role is refused", []string{"operator"}, http.StatusForbidden, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &fakeStore{zones: map[string]bool{"valparaiso-demo": true}}
			handler, mint := rolesHandler(t, store)
			r := httptest.NewRequest(http.MethodPost, "/v1/jobs", strings.NewReader(`{"zone_id":"valparaiso-demo"}`))
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Idempotency-Key", uuid.NewString())
			r.Header.Set("Authorization", "Bearer "+mint(tc.roles...))
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Fatalf("got %d want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if gotCalls := store.calls > 0; gotCalls != tc.wantCalls {
				t.Fatalf("store reached = %v, want %v", gotCalls, tc.wantCalls)
			}
		})
	}
}

// TestReplayingAJobIsATacticalOperation is the same write row on the replay
// route, which the matrix treats as dispatching evaluation work.
func TestReplayingAJobIsATacticalOperation(t *testing.T) {
	const id = "6f1c1c1e-0000-4000-8000-000000000002"
	for _, tc := range []struct {
		name      string
		roles     []string
		want      int
		wantCalls bool
	}{
		{"analista replays", []string{"analista"}, http.StatusAccepted, true},
		{"admin replays", []string{"admin"}, http.StatusAccepted, true},
		{"viewer is refused", []string{"viewer"}, http.StatusForbidden, false},
		{"undeclared role is refused", []string{"operator"}, http.StatusForbidden, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &fakeStore{replayJob: repository.Job{ID: id, ZoneID: "valparaiso-demo", State: "queued"}}
			handler, mint := rolesHandler(t, store)
			r := httptest.NewRequest(http.MethodPost, "/v1/jobs/"+id+"/replay", strings.NewReader(`{"confirm":"`+replayConfirmToken+`"}`))
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Authorization", "Bearer "+mint(tc.roles...))
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Fatalf("got %d want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if gotCalls := store.replayCalls > 0; gotCalls != tc.wantCalls {
				t.Fatalf("store reached = %v, want %v", gotCalls, tc.wantCalls)
			}
		})
	}
}

// TestAuditRegisterIsAvailableToEveryDeclaredRole pins the matrix row that names
// «auditoría» among the GET reads granted to all three roles.
func TestAuditRegisterIsAvailableToEveryDeclaredRole(t *testing.T) {
	for _, tc := range []struct {
		name  string
		roles []string
		want  int
	}{
		{"viewer reads", []string{"viewer"}, http.StatusOK},
		{"analista reads", []string{"analista"}, http.StatusOK},
		{"admin reads", []string{"admin"}, http.StatusOK},
		{"undeclared role is refused", []string{"operator"}, http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &fakeStore{}
			handler, mint := rolesHandler(t, store)
			r := httptest.NewRequest(http.MethodGet, "/v1/audit", nil)
			r.Header.Set("Authorization", "Bearer "+mint(tc.roles...))
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Fatalf("got %d want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if tc.want == http.StatusForbidden && store.auditCalls != 0 {
				t.Fatal("a refused role reached storage")
			}
		})
	}
}
