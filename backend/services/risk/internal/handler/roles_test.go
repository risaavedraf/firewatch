package handler

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"firewatch.local/risk/internal/cycle"
	"firewatch.local/risk/internal/repository"
	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/go-jose/go-jose/v4"
)

// PM-15 (D-C) — the closed role vocabulary and the ratified permission matrix.
//
// The three roles are viewer, analista and admin, and the decision is membership
// in that set, never the first recognised element: the demo realm hands its admin
// account BOTH viewer and admin, and the identity provider owns that order. Every
// case below is therefore exercised with the whole list the token carries.

// rolesServer is authorizedServerSubjectWith for a token that carries SEVERAL
// realm roles in the exact order given. The order is the point of the helper.
func rolesServer(t *testing.T, roles []string, subject string, store Repository, runner CycleRunner) (http.Handler, string) {
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
	payload, err := json.Marshal(map[string]any{
		"iss": "https://issuer.test", "aud": "firewatch-api", "sub": subject,
		"exp": time.Now().Add(time.Minute).Unix(), "typ": "Bearer",
		"realm_access": map[string]any{"roles": roles},
	})
	if err != nil {
		t.Fatal(err)
	}
	signed, err := signer.Sign(payload)
	if err != nil {
		t.Fatal(err)
	}
	token, err := signed.CompactSerialize()
	if err != nil {
		t.Fatal(err)
	}
	return NewWithCycle(store, verifier, nil, runner), token
}

// TestClosedRoleVocabularyAdmitsAnalistaAndRejectsUndeclaredRoles pins the first
// half of S2: `analista` is a role this service accepts, and a role the realm does
// not declare is still refused with the documented 403 before storage is reached.
func TestClosedRoleVocabularyAdmitsAnalistaAndRejectsUndeclaredRoles(t *testing.T) {
	for _, tc := range []struct {
		name  string
		roles []string
		want  int
	}{
		{"viewer reads", []string{"viewer"}, http.StatusOK},
		{"analista reads", []string{"analista"}, http.StatusOK},
		{"admin reads", []string{"admin"}, http.StatusOK},
		{"analista and viewer read", []string{"viewer", "analista"}, http.StatusOK},
		{"an undeclared role is forbidden", []string{"operator"}, http.StatusForbidden},
		{"an undeclared role beside a declared one is still admitted", []string{"operator", "analista"}, http.StatusOK},
		{"an empty role list is forbidden", []string{}, http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &fakeStore{
				zones:   map[string]bool{"valparaiso-demo": true},
				batches: []repository.Batch{{Demo: true, RiskLevel: "desconocido", DataStatus: "current"}},
			}
			handler, token := rolesServer(t, tc.roles, "subject", store, nil)
			r := httptest.NewRequest(http.MethodGet, "/v1/risk/latest?zone_id=valparaiso-demo", nil)
			r.Header.Set("Authorization", "Bearer "+token)
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Fatalf("got %d want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if tc.want == http.StatusForbidden && (store.calls != 0 || store.zoneCalls != 0) {
				t.Fatal("a refused role reached storage")
			}
		})
	}
}

// TestOnlyTheTacticalRolesTriggerAnEvaluation pins the matrix row «Disparar
// evaluación / jobs»: `analista` and `admin` run one cycle, and `viewer` is
// refused with 403 before the runner is called. D-C names the route
// `POST /v1/risk/evaluate`; the route that exists in this tree is
// `POST /v1/risk/cycle/run`, so that is the one guarded here.
func TestOnlyTheTacticalRolesTriggerAnEvaluation(t *testing.T) {
	started := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name     string
		roles    []string
		want     int
		wantRuns int
	}{
		{"admin runs", []string{"admin", "viewer"}, http.StatusOK, 1},
		{"analista runs", []string{"analista"}, http.StatusOK, 1},
		{"viewer before analista keeps the tactical right", []string{"viewer", "analista"}, http.StatusOK, 1},
		{"viewer is refused", []string{"viewer"}, http.StatusForbidden, 0},
		{"undeclared role is refused", []string{"operator"}, http.StatusForbidden, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			runner := &fakeCycle{result: cycle.RunResult{
				SourceID: "fixture-sample", StartedAt: started, FinishedAt: started, Complete: true,
				Zones: []cycle.ZoneResult{{ZoneID: "valparaiso-demo", Published: true}},
			}}
			handler, token := rolesServer(t, tc.roles, "subject", &fakeStore{}, runner)
			r := httptest.NewRequest(http.MethodPost, "/v1/risk/cycle/run", nil)
			r.Header.Set("Authorization", "Bearer "+token)
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Fatalf("got %d want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if runner.runs != tc.wantRuns {
				t.Fatalf("runner called %d times, want %d", runner.runs, tc.wantRuns)
			}
		})
	}
}

// TestEveryDeclaredRoleMayMarkItsOwnAlertState pins the matrix row «Marcas
// personales de alertas»: the mark is a per-caller preference, not an
// administrative action, so all three declared roles apply their own. The mark is
// still written for the verified subject and an undeclared role still writes
// nothing.
func TestEveryDeclaredRoleMayMarkItsOwnAlertState(t *testing.T) {
	const subject = "quien.marca@example.test"
	for _, tc := range []struct {
		name      string
		roles     []string
		want      int
		wantWrite bool
	}{
		{"viewer marks", []string{"viewer"}, http.StatusOK, true},
		{"analista marks", []string{"analista"}, http.StatusOK, true},
		{"admin marks", []string{"viewer", "admin"}, http.StatusOK, true},
		{"undeclared role is refused", []string{"operator"}, http.StatusForbidden, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &fakeStore{}
			handler, token := rolesServer(t, tc.roles, subject, store, nil)
			w := alertStateCall(t, handler, token, http.MethodPut, alertStatePath, "application/json", `{"state":"read"}`)
			if w.Code != tc.want {
				t.Fatalf("got %d want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if got := len(store.markWrites) == 1; got != tc.wantWrite {
				t.Fatalf("storage writes = %d, want a write: %v", len(store.markWrites), tc.wantWrite)
			}
			if !tc.wantWrite {
				return
			}
			if write := store.markWrites[0]; write.SubjectKey != repository.AlertStateSubjectKey(subject) {
				t.Fatalf("the mark was written for %q, want the verified subject's digest", write.SubjectKey)
			}
		})
	}
}
