package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	v1 "firewatch.local/contracts/events/v1"
	"firewatch.local/risk/internal/classify"
	"firewatch.local/risk/internal/cycle"
	"firewatch.local/risk/internal/repository"
	"firewatch.local/risk/internal/service"
	"firewatch.local/risk/internal/source"
)

// statefulCycleStore is the storage the production publication path writes into and
// the read route reads back from, so the role test proves the RESULTING STATE
// through the API instead of trusting a runner's canned answer.
//
// It embeds the read fake for the routes this test never exercises, and adds the
// two durability pieces the criterion needs: the manual/scheduled persistence
// seams the publisher requires, and a `List` that serves what was really stored.
type statefulCycleStore struct {
	*fakeStore
	published []repository.Batch
}

func newStatefulCycleStore(zone string) *statefulCycleStore {
	return &statefulCycleStore{fakeStore: &fakeStore{zones: map[string]bool{zone: true}}}
}

// Publish is the job-completion seam. A cycle never reaches it (the runner uses the
// two origin seams below), but the publisher's store contract requires it, so it
// persists with the scheduled origin the column defaults to instead of pretending
// an operator asked.
func (s *statefulCycleStore) Publish(_ context.Context, request v1.Event, assessment repository.Assessment) error {
	return s.persist(request, assessment, "scheduler", "")
}

func (s *statefulCycleStore) PublishScheduled(_ context.Context, request v1.Event, assessment repository.Assessment) error {
	return s.persist(request, assessment, "scheduler", "")
}

func (s *statefulCycleStore) PublishManual(_ context.Context, request v1.Event, assessment repository.Assessment, actor string) error {
	return s.persist(request, assessment, "manual", actor)
}

// persist records one batch exactly as the two provenance columns describe it: the
// trigger the seam owns and, for a manual run, the operator the API gate proved.
// The actor is never read from the request, which is what makes the readback
// evidence of attribution rather than of echoing.
func (s *statefulCycleStore) persist(request v1.Event, assessment repository.Assessment, trigger, actor string) error {
	factors, err := json.Marshal(assessment.Factors)
	if err != nil {
		return err
	}
	published := request.RequestedAt
	if published.IsZero() {
		published = time.Now().UTC()
	}
	batch := repository.Batch{
		ID:                request.ID,
		JobID:             request.JobID,
		ZoneID:            request.ZoneID,
		RequestedAt:       request.RequestedAt,
		PublishedAt:       published,
		ValidUntil:        published.Add(24 * time.Hour),
		ModelVersion:      assessment.ModelVersion,
		Demo:              assessment.Demo,
		DataStatus:        "verified",
		RiskLevel:         assessment.RiskLevel,
		Factors:           factors,
		Rationale:         assessment.Rationale,
		Notice:            "Sintético",
		Policy:            assessment.Policy,
		EvaluationTrigger: trigger,
	}
	if strings.TrimSpace(actor) != "" {
		operator := actor
		batch.EvaluatedBy = &operator
	}
	s.published = append(s.published, batch)
	return nil
}

// List serves what was really stored, newest first, so `GET /v1/risk/latest` reads
// the state the POST left instead of a fixture the test wrote twice.
func (s *statefulCycleStore) List(_ context.Context, zone string, limit int) ([]repository.Batch, error) {
	s.calls++
	matches := make([]repository.Batch, 0, len(s.published))
	for index := len(s.published) - 1; index >= 0; index-- {
		if s.published[index].ZoneID == zone {
			matches = append(matches, s.published[index])
		}
	}
	if limit > 0 && len(matches) > limit {
		matches = matches[:limit]
	}
	return matches, nil
}

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

// V1-P-05 (S3): with no runner configured the ACTIVE source is still published,
// with no reading reported for it. A manual-only deployment accepts a review of its
// active source through POST /v1/risk/sources/{source_id}/review, so the read has to
// publish that source - otherwise the accepted write would never be readable, and
// "no sources" would contradict the route that just stored a decision about one.
func TestSourcesReportsTheActiveSourceWithoutARunner(t *testing.T) {
	handler, token := authorizedServerWith(t, "viewer", &fakeStore{}, nil, source.NewFixtureProvider())
	w := getZones(t, handler, token, "/v1/risk/sources")
	if w.Code != http.StatusOK {
		t.Fatalf("got %d: %s", w.Code, w.Body.String())
	}
	var body sourcesResponse
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Sources) != 1 {
		t.Fatalf("sources = %+v, want the one active source", body.Sources)
	}
	entry := body.Sources[0]
	if entry.SourceID != "fixture-sample" {
		t.Fatalf("source_id = %q, want the active source", entry.SourceID)
	}
	// No reading has been reported for it: the age, the run instants and the
	// completeness are the honest absence, never a zero or an invented run.
	if entry.LastRunAt != nil || entry.NextRunAt != nil || entry.AgeSeconds != nil || entry.Complete {
		t.Fatalf("a source that never ran reported a reading: %+v", entry)
	}
	if len(entry.QualityFindings) == 0 {
		t.Fatal("the active source was served with no quality findings")
	}
	if entry.QualityFindings[0] != "STALE_CUTOFF" {
		t.Fatalf("findings = %v, want STALE_CUTOFF first for a source that never ran", entry.QualityFindings)
	}
	if entry.Review != nil {
		t.Fatalf("review = %+v, want null", entry.Review)
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

// V1-P-06 (S1-S2): the manual publication's role gate and the state the ACCEPTED
// call really leaves. The three G6 routes exist as authenticated endpoints with a
// role gate, and the criterion asks for the rejection AND the resulting state — so
// this test wires the production publication path (domain/cycle.New runner ->
// service.Publisher -> storage) instead of a canned runner answer, and then reads
// the state back through `GET /v1/risk/latest`. A refused request must leave that
// read empty; an accepted one must serve the batch with the provenance the manual
// origin records: `evaluation_trigger = manual` and `evaluated_by` equal to the
// verified token subject.
func TestManualCycleRunRoleGateAndResultingState(t *testing.T) {
	const zone = "valparaiso-demo"
	const subject = "operator-ana"
	for _, tc := range []struct {
		name       string
		role       string
		want       int
		wantStored bool
	}{
		{"unauthenticated is refused", "", http.StatusUnauthorized, false},
		{"viewer is refused", "viewer", http.StatusForbidden, false},
		{"admin publishes and the read proves it", "admin", http.StatusOK, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := newStatefulCycleStore(zone)
			// The real publication path: the fixture provider is synthetic, the rule
			// classifier is the shipped one, and the store persists through the manual
			// seam that records the operator.
			publisher := service.Publisher{
				Provider:   source.NewFixtureProvider(),
				Classifier: classify.NewAcademicRuleV1(),
				Store:      store,
			}
			runner := cycle.New(source.NewFixtureProvider(), publisher, cycle.Options{Zones: []string{zone}})
			handler, token := authorizedServerSubjectWith(t, tc.role, subject, store, runner)

			r := httptest.NewRequest(http.MethodPost, "/v1/risk/cycle/run", nil)
			// An empty role means the caller sent no token at all: 401 and 403 are
			// different answers and this row proves they stay different.
			if tc.role != "" {
				r.Header.Set("Authorization", "Bearer "+token)
			}
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Fatalf("got %d want %d: %s", w.Code, tc.want, w.Body.String())
			}

			// The readback uses its own reader router over the SAME store, so an
			// unauthenticated or forbidden POST can still be read back: what it
			// published (or did not) is a property of storage, not of the caller.
			reader, readerToken := authorizedServerSubjectWith(t, "viewer", "reader-ana", store, runner)
			latest := getZones(t, reader, readerToken, "/v1/risk/latest?zone_id="+zone)

			if !tc.wantStored {
				if latest.Code != http.StatusNotFound {
					t.Fatalf("a refused run left a published batch: %d %s", latest.Code, latest.Body.String())
				}
				if len(store.published) != 0 {
					t.Fatalf("a refused run stored %d batches", len(store.published))
				}
				return
			}

			if latest.Code != http.StatusOK {
				t.Fatalf("the run published nothing: %d %s", latest.Code, latest.Body.String())
			}
			var batch repository.Batch
			if err := json.Unmarshal(latest.Body.Bytes(), &batch); err != nil {
				t.Fatal(err)
			}
			if batch.ZoneID != zone {
				t.Errorf("the published batch is for zone %q, want %q", batch.ZoneID, zone)
			}
			if batch.ID == "" || batch.JobID == "" {
				t.Errorf("the published batch carries no id/job id: %+v", batch)
			}
			// The provenance the manual origin records, read back from storage: the
			// trigger and the operator's verified subject, never a request value.
			if batch.EvaluationTrigger != "manual" {
				t.Errorf("evaluation_trigger = %q, want manual", batch.EvaluationTrigger)
			}
			if batch.EvaluatedBy == nil || *batch.EvaluatedBy != subject {
				t.Errorf("evaluated_by = %v, want the verified subject %q", batch.EvaluatedBy, subject)
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
