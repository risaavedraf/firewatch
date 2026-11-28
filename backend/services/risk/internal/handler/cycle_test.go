package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"firewatch.local/risk/internal/cycle"
	"firewatch.local/risk/internal/source"
)

// fakeCycle is the handler's view of the runner: it records run calls and serves
// fixed statuses, so the routes are exercised without a scheduler or a database.
// It implements the manual entry point only, because that is the only one a request
// can reach, and it records the actor each call carried so a test can prove the
// subject came from the verified token and never from the request.
type fakeCycle struct {
	statuses []cycle.SourceStatus
	result   cycle.RunResult
	runs     int
	actors   []string
}

func (c *fakeCycle) RunManual(_ context.Context, actor string) cycle.RunResult {
	c.runs++
	c.actors = append(c.actors, actor)
	return c.result
}

func (c *fakeCycle) Statuses() []cycle.SourceStatus { return c.statuses }

// T4: GET /v1/risk/sources carries the per-source freshness next to the existing
// geography and descriptor, and the previous fields are unchanged.
func TestSourcesExposesCycleFreshness(t *testing.T) {
	last := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	next := last.Add(15 * time.Minute)
	age := 42.5
	runner := &fakeCycle{statuses: []cycle.SourceStatus{{
		SourceID:   "fixture-sample",
		LastRunAt:  &last,
		NextRunAt:  &next,
		Complete:   true,
		AgeSeconds: &age,
	}}}
	handler, token := authorizedServerWith(t, "viewer", &fakeStore{}, runner, source.NewFixtureProvider())
	w := getZones(t, handler, token, "/v1/risk/sources")
	if w.Code != http.StatusOK {
		t.Fatalf("got %d: %s", w.Code, w.Body.String())
	}
	var body sourcesResponse
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Sources) != 1 {
		t.Fatalf("sources = %+v", body.Sources)
	}
	status := body.Sources[0]
	if status.SourceID != "fixture-sample" || !status.Complete || status.LastRunAt == nil || !status.LastRunAt.Equal(last) || status.NextRunAt == nil || status.AgeSeconds == nil || *status.AgeSeconds != age {
		t.Fatalf("freshness = %+v", status)
	}
	// The descriptor and geography halves are unchanged by the addition.
	if body.RiskInput.ID == "" || body.Geography.CutoffSemantics == "" {
		t.Fatalf("existing fields regressed: %+v", body)
	}
}

// T4: with no runner configured the field is an empty list, never null, so the
// UI can render "no sources" without a special case.
func TestSourcesFreshnessIsEmptyWithoutARunner(t *testing.T) {
	handler, token := authorizedServerWith(t, "viewer", &fakeStore{}, nil, source.NewFixtureProvider())
	w := getZones(t, handler, token, "/v1/risk/sources")
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	if string(raw["sources"]) != "[]" {
		t.Fatalf("sources = %s, want []", raw["sources"])
	}
}

// T3: the manual trigger is admin-only and runs exactly one cycle.
func TestCycleRunRequiresAdminAndRunsOnce(t *testing.T) {
	last := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name, role string
		want       int
		wantRuns   int
	}{
		{"admin runs", "admin", http.StatusOK, 1},
		{"viewer denied", "viewer", http.StatusForbidden, 0},
		{"other denied", "operator", http.StatusForbidden, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			runner := &fakeCycle{result: cycle.RunResult{
				SourceID:   "fixture-sample",
				StartedAt:  last,
				FinishedAt: last,
				Complete:   true,
				Zones:      []cycle.ZoneResult{{ZoneID: "valparaiso-demo", Published: true}},
			}}
			handler, token := authorizedServerWith(t, tc.role, &fakeStore{}, runner)
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
			if tc.want != http.StatusOK {
				return
			}
			var result cycle.RunResult
			if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if !result.Complete || len(result.Zones) != 1 || result.Zones[0].ZoneID != "valparaiso-demo" {
				t.Fatalf("result = %+v", result)
			}
		})
	}
}

// T3: without a configured runner the manual trigger fails clearly instead of
// panicking.
func TestCycleRunUnavailableWithoutARunner(t *testing.T) {
	handler, token := authorizedServerWith(t, "admin", &fakeStore{}, nil)
	r := httptest.NewRequest(http.MethodPost, "/v1/risk/cycle/run", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("got %d want 503: %s", w.Code, w.Body.String())
	}
	var body map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if body["code"] != "cycle_unavailable" {
		t.Fatalf("code = %q", body["code"])
	}
}

// PM-06 (S1-S2): a manual run records the verified token subject as the evaluation's
// actor. The subject is the one the bearer token carries, taken from the identity
// Authorize proved, and the DB-level assertion lives in the repository integration
// test; here the runner boundary is what is pinned.
func TestManualCycleRunCarriesTheVerifiedSubjectAsActor(t *testing.T) {
	last := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	runner := &fakeCycle{result: cycle.RunResult{
		SourceID:   "fixture-sample",
		StartedAt:  last,
		FinishedAt: last,
		Complete:   true,
		Zones:      []cycle.ZoneResult{{ZoneID: "valparaiso-demo", Published: true}},
	}}
	// The token's subject is the only source of the actor; nothing in the request
	// names one.
	handler, token := authorizedServerSubjectWith(t, "admin", "operator-ana", &fakeStore{}, runner)
	r := httptest.NewRequest(http.MethodPost, "/v1/risk/cycle/run", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d want 200: %s", w.Code, w.Body.String())
	}
	if runner.runs != 1 {
		t.Fatalf("runner called %d times, want 1", runner.runs)
	}
	if len(runner.actors) != 1 || runner.actors[0] != "operator-ana" {
		t.Fatalf("the runner received actors %v, want exactly the verified subject %q", runner.actors, "operator-ana")
	}
}

// PM-06: the manual trigger declares no body. A request that tries to name the
// actor - the exact way a client could otherwise forge one - is refused with 400
// before the cycle runs, so the stored evaluated_by can never be a client value.
// The two names a client would try are the two columns the migration adds, plus the
// trigger itself, because accepting and ignoring one would look honoured.
func TestManualCycleRunRejectsAClientSuppliedActor(t *testing.T) {
	for _, body := range []string{
		`{"actor":"someone-else"}`,
		`{"evaluated_by":"someone-else"}`,
		`{"evaluation_trigger":"manual","evaluated_by":"someone-else"}`,
		`{"actor":"someone-else","zone_id":"valparaiso-demo"}`,
	} {
		t.Run(body, func(t *testing.T) {
			runner := &fakeCycle{result: cycle.RunResult{Complete: true}}
			handler, token := authorizedServerSubjectWith(t, "admin", "operator-ana", &fakeStore{}, runner)
			r := httptest.NewRequest(http.MethodPost, "/v1/risk/cycle/run", strings.NewReader(body))
			r.Header.Set("Authorization", "Bearer "+token)
			r.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("got %d want 400 for %s: %s", w.Code, body, w.Body.String())
			}
			if runner.runs != 0 {
				t.Fatalf("a request that named an actor ran the cycle %d times; nothing may be evaluated or stored", runner.runs)
			}
			if len(runner.actors) != 0 {
				t.Fatalf("the refusal still handed the runner actors %v", runner.actors)
			}
		})
	}
}

// PM-06: the empty body the route declares is accepted, so refusing a named actor
// is not achieved by refusing every body.
func TestManualCycleRunAcceptsNoBodyAndAnEmptyObject(t *testing.T) {
	for _, body := range []string{"", "{}", "  \n\t "} {
		t.Run("body "+body, func(t *testing.T) {
			runner := &fakeCycle{result: cycle.RunResult{Complete: true}}
			handler, token := authorizedServerSubjectWith(t, "admin", "operator-ana", &fakeStore{}, runner)
			r := httptest.NewRequest(http.MethodPost, "/v1/risk/cycle/run", strings.NewReader(body))
			r.Header.Set("Authorization", "Bearer "+token)
			r.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != http.StatusOK {
				t.Fatalf("got %d want 200 for %q: %s", w.Code, body, w.Body.String())
			}
			if runner.runs != 1 || len(runner.actors) != 1 || runner.actors[0] != "operator-ana" {
				t.Fatalf("runs=%d actors=%v, want one run attributed to the verified subject", runner.runs, runner.actors)
			}
		})
	}
}

// PM-06 (verify, S2-1): the body this route inspects is bounded, and a body that
// reaches the bound is REFUSED instead of being truncated into something that looks
// like no body. The case that motivates it is whitespace padding past the cap
// followed by a payload naming an actor: a reader that stops at the cap hands the
// decoder only spaces, the decoder sees EOF and the forged actor would have been
// accepted as an empty body.
func TestManualCycleRunRefusesOversizedAndNonObjectBodies(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
	}{
		{"whitespace padding past the cap hides an actor payload", strings.Repeat(" ", cycleRunBodySize+16) + `{"actor":"someone-else"}`},
		{"whitespace-only body past the cap", strings.Repeat(" ", cycleRunBodySize+1)},
		{"empty object past the cap", strings.Repeat(" ", cycleRunBodySize) + `{}`},
		{"json null", `null`},
		{"json array", `[1,2,3]`},
		{"json string", `"actor"`},
		{"json number", `5`},
		{"json boolean", `true`},
		{"malformed object", `{"actor":`},
		{"two json values", `{} {}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			runner := &fakeCycle{result: cycle.RunResult{Complete: true}}
			handler, token := authorizedServerSubjectWith(t, "admin", "operator-ana", &fakeStore{}, runner)
			r := httptest.NewRequest(http.MethodPost, "/v1/risk/cycle/run", strings.NewReader(tc.body))
			r.Header.Set("Authorization", "Bearer "+token)
			r.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("got %d want 400: %s", w.Code, w.Body.String())
			}
			if runner.runs != 0 || len(runner.actors) != 0 {
				t.Fatalf("runs=%d actors=%v, want no evaluation at all", runner.runs, runner.actors)
			}
		})
	}
}

// PM-06: a manual invocation that cannot name a verified subject fails closed. The
// route is reached without a subject only by a defect in the gate, so the entry
// point itself must refuse instead of publishing an evaluation nobody can be
// attributed to.
func TestManualCycleRunFailsClosedWithoutAVerifiedSubject(t *testing.T) {
	runner := &fakeCycle{result: cycle.RunResult{Complete: true}}
	w := httptest.NewRecorder()
	cycleRun(runner)(w, httptest.NewRequest(http.MethodPost, "/v1/risk/cycle/run", nil))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("got %d want 401: %s", w.Code, w.Body.String())
	}
	if runner.runs != 0 {
		t.Fatalf("the cycle ran %d times without a verified subject", runner.runs)
	}
}
