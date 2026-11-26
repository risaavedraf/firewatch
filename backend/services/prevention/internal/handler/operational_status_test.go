package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// operationalStatusApp mounts the status route through the constructor the
// deployment uses, so the test exercises the same Authorize gate and the same
// router as production.
func operationalStatusApp(t *testing.T, role string, check OperationalStatusCheck) (http.Handler, string) {
	t.Helper()
	verifier, signer := signingFixture(t)
	return withCorrelationID(NewWithOperationalStatus(&matrixStore{}, verifier, &stubDirectory{}, check)), token(t, signer, role, "subject")
}

func operationalStatusRequest(t *testing.T, app http.Handler, bearer string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/v1/prevention/status", nil)
	if bearer != "" {
		r.Header.Set("Authorization", "Bearer "+bearer)
	}
	w := httptest.NewRecorder()
	app.ServeHTTP(w, r)
	return w
}

type operationalStatusBody struct {
	CheckedAt    string `json:"checked_at"`
	Ready        bool   `json:"ready"`
	Reason       string `json:"reason"`
	Dependencies struct {
		Database struct {
			State string `json:"state"`
		} `json:"database"`
	} `json:"dependencies"`
}

func operationalStatusOf(t *testing.T, w *httptest.ResponseRecorder) operationalStatusBody {
	t.Helper()
	var body operationalStatusBody
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("status body is not JSON: %v: %s", err, w.Body.String())
	}
	return body
}

// TestOperationalStatusMatchesTheContract pins the two answers this route can
// give, and the 200/503 boundary that keeps the evidence and the code from
// disagreeing.
func TestOperationalStatusMatchesTheContract(t *testing.T) {
	contract := loadContract(t)
	checkOf := func(ready bool, reason, database string) OperationalStatusCheck {
		return func(context.Context) OperationalStatus {
			status := OperationalStatus{CheckedAt: time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC), Ready: ready, Reason: reason}
			status.Dependencies.Database = OperationalDependency{State: database}
			return status
		}
	}
	for _, tc := range []struct {
		name       string
		check      OperationalStatusCheck
		wantCode   int
		wantReady  bool
		wantReason string
		wantDB     string
	}{
		{"database answered", checkOf(true, "", "ready"), http.StatusOK, true, "", "ready"},
		{"database did not answer", checkOf(false, "database_unavailable", "degraded"), http.StatusServiceUnavailable, false, "database_unavailable", "degraded"},
		{"no evaluator wired", nil, http.StatusServiceUnavailable, false, "status_unavailable", "unknown"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			app, bearer := operationalStatusApp(t, "viewer", tc.check)
			w := operationalStatusRequest(t, app, bearer)
			if w.Code != tc.wantCode {
				t.Fatalf("got %d want %d: %s", w.Code, tc.wantCode, w.Body.String())
			}
			assertResponseMatchesContract(t, contract, "/v1/prevention/status", http.MethodGet, w)
			body := operationalStatusOf(t, w)
			if body.Ready != tc.wantReady || body.Reason != tc.wantReason || body.Dependencies.Database.State != tc.wantDB {
				t.Fatalf("status = %+v, want ready %v reason %q database %q", body, tc.wantReady, tc.wantReason, tc.wantDB)
			}
		})
	}
}

// TestOperationalStatusIsBehindTheBearerGate pins that the additive route is
// authenticated like every sibling: an unauthenticated caller learns nothing.
func TestOperationalStatusIsBehindTheBearerGate(t *testing.T) {
	contract := loadContract(t)
	app, _ := operationalStatusApp(t, "viewer", func(context.Context) OperationalStatus {
		t.Error("an unauthenticated request reached the status evaluator")
		return OperationalStatus{}
	})
	w := operationalStatusRequest(t, app, "")
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("got %d want 401: %s", w.Code, w.Body.String())
	}
	assertResponseMatchesContract(t, contract, "/v1/prevention/status", http.MethodGet, w)
}

// TestOperationalStatusReportsNoFabricatedDependency pins the honest shape: this
// service talks to a database and nothing else, so no broker or dead-letter
// entry is invented for it.
func TestOperationalStatusReportsNoFabricatedDependency(t *testing.T) {
	app, bearer := operationalStatusApp(t, "viewer", func(context.Context) OperationalStatus {
		return OperationalStatus{CheckedAt: time.Now().UTC(), Ready: true, Dependencies: OperationalDependencies{Database: OperationalDependency{State: "ready"}}}
	})
	w := operationalStatusRequest(t, app, bearer)
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatalf("status body is not JSON: %v", err)
	}
	if len(raw) != 4 {
		t.Fatalf("status body has %d fields, want exactly checked_at, ready, reason, dependencies: %s", len(raw), w.Body.String())
	}
	var dependencies map[string]json.RawMessage
	if err := json.Unmarshal(raw["dependencies"], &dependencies); err != nil {
		t.Fatalf("dependencies is not an object: %v", err)
	}
	if len(dependencies) != 1 {
		t.Fatalf("dependencies has %d entries, want only database: %s", len(dependencies), w.Body.String())
	}
	if _, ok := dependencies["database"]; !ok {
		t.Fatalf("dependencies carries no database entry: %s", w.Body.String())
	}
	for _, invented := range []string{"broker", "dead_letter"} {
		if _, ok := dependencies[invented]; ok {
			t.Errorf("dependencies reports %q, a dependency this service does not have", invented)
		}
	}
}
