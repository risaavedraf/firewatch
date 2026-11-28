package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"firewatch.local/risk/internal/cycle"
	"firewatch.local/risk/internal/quality"
	"firewatch.local/risk/internal/repository"
	"firewatch.local/risk/internal/source"
)

// sourceReviewTarget is the review route of the fixture source.
const sourceReviewTarget = "/v1/risk/sources/fixture-sample/review"

// reviewCall issues one review request. The body is written verbatim so a test can
// send the exact shape a client would send, including a shape this route refuses.
func reviewCall(t *testing.T, handler http.Handler, token, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, target, strings.NewReader(body))
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Request-ID", "9d1b1bb0-2a4e-4f0e-9f3a-2f0c9a3f6f10")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

// failingReviewAudit is the audit seam with a fixed failure, so the route's
// "stored but not announced" answer is proven rather than assumed.
type failingReviewAudit struct{ err error }

func (a failingReviewAudit) RecordSourceReviewAudit(context.Context, repository.SourceReview) error {
	return a.err
}

// auditingStore adds the optional audit seam to the read/write fake. It is a
// separate type on purpose: whether the seam is wired is a property of the METHOD
// SET, so the unwired case is the plain fake and the wired case is this one.
type auditingStore struct {
	*fakeStore
	auditErr error
	events   []repository.SourceReview
}

func (s *auditingStore) RecordSourceReviewAudit(_ context.Context, review repository.SourceReview) error {
	s.events = append(s.events, review)
	return s.auditErr
}

// The catalogue the page renders is the closed five-value catalogue the service
// publishes, and every source carries findings drawn from it: the contract, the
// backend and the client can never disagree about the vocabulary.
func TestSourceQualityCatalogAndFindingsAreServed(t *testing.T) {
	last := time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)
	age := 30.0
	runner := &fakeCycle{statuses: []cycle.SourceStatus{{
		SourceID:   "fixture-sample",
		LastRunAt:  &last,
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
	if len(body.QualityCatalog) != len(quality.Codes()) {
		t.Fatalf("quality_catalog has %d definitions, want %d", len(body.QualityCatalog), len(quality.Codes()))
	}
	for index, definition := range body.QualityCatalog {
		if definition.Code != quality.Codes()[index] || definition.Description == "" || definition.Kind == "" || definition.Severity == "" {
			t.Fatalf("quality_catalog[%d] = %+v", index, definition)
		}
	}
	if len(body.Sources) != 1 {
		t.Fatalf("sources = %+v", body.Sources)
	}
	entry := body.Sources[0]
	if len(entry.QualityFindings) == 0 {
		t.Fatal("a source served no quality findings")
	}
	for _, finding := range entry.QualityFindings {
		if _, ok := quality.Lookup(finding); !ok {
			t.Fatalf("a source served the undeclared finding %q", finding)
		}
	}
	// The fixture is a fresh, complete source that DECLARES itself synthetic and
	// declares every canonical variable, so its evidence supports exactly the two
	// findings below and none of the three warning findings the demo cannot have.
	if !contains(entry.QualityFindings, quality.ChecksumVerified) {
		t.Fatalf("findings = %v, want CHECKSUM_VERIFIED", entry.QualityFindings)
	}
	if !contains(entry.QualityFindings, quality.SyntheticFallback) {
		t.Fatalf("findings = %v, want SYNTHETIC_FALLBACK for a synthetic fixture", entry.QualityFindings)
	}
	for _, unwanted := range []string{"STALE_CUTOFF", "MISSING_CANONICAL_FACTOR", "OUT_OF_RANGE_CLAMPED"} {
		if contains(entry.QualityFindings, quality.Finding(unwanted)) {
			t.Fatalf("findings = %v, want no %s", entry.QualityFindings, unwanted)
		}
	}
	// No review recorded yet is the explicit null, never an invented or stale one.
	if entry.Review != nil {
		t.Fatalf("review = %+v, want null", entry.Review)
	}
}

// The findings are derived from the evidence the route already reads: a stale or
// unrun source, a source missing a canonical variable and a synthetic source each
// produce their own code, and a declared priority outside the nominal range is
// served bounded with the finding that says so.
func TestSourceQualityFindingsFollowTheServedEvidence(t *testing.T) {
	last := time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)
	window := quality.FreshnessWindow
	stale := window.Seconds() + 1
	fresh := window.Seconds() - 1
	descriptor := source.NewFixtureProvider().Describe()
	incomplete := descriptor
	incomplete.Variables = []string{"temperatura"}
	synthetic := descriptor
	synthetic.Synthetic = true
	ranged := descriptor
	ranged.Priority = 150

	for _, tc := range []struct {
		name       string
		descriptor describedSource
		status     cycle.SourceStatus
		want       []quality.Finding
		unwanted   []quality.Finding
	}{
		{
			name:       "stale reading",
			descriptor: describedSource{descriptor},
			status:     cycle.SourceStatus{SourceID: "fixture-sample", LastRunAt: &last, Complete: true, AgeSeconds: &stale},
			want:       []quality.Finding{quality.StaleCutoff, quality.ChecksumVerified},
		},
		{
			name:       "never ran",
			descriptor: describedSource{descriptor},
			status:     cycle.SourceStatus{SourceID: "fixture-sample"},
			want:       []quality.Finding{quality.StaleCutoff, quality.ChecksumVerified},
		},
		{
			name:       "fresh",
			descriptor: describedSource{descriptor},
			status:     cycle.SourceStatus{SourceID: "fixture-sample", LastRunAt: &last, Complete: true, AgeSeconds: &fresh},
			want:       []quality.Finding{quality.ChecksumVerified},
			unwanted:   []quality.Finding{quality.StaleCutoff},
		},
		{
			name:       "missing canonical factor",
			descriptor: describedSource{incomplete},
			status:     cycle.SourceStatus{SourceID: "fixture-sample", LastRunAt: &last, Complete: true, AgeSeconds: &fresh},
			want:       []quality.Finding{quality.MissingCanonicalFactor, quality.ChecksumVerified},
		},
		{
			name:       "synthetic input",
			descriptor: describedSource{synthetic},
			status:     cycle.SourceStatus{SourceID: "fixture-sample", LastRunAt: &last, Complete: true, AgeSeconds: &fresh},
			want:       []quality.Finding{quality.ChecksumVerified, quality.SyntheticFallback},
		},
		{
			name:       "priority outside the nominal range",
			descriptor: describedSource{ranged},
			status:     cycle.SourceStatus{SourceID: "fixture-sample", LastRunAt: &last, Complete: true, AgeSeconds: &fresh},
			want:       []quality.Finding{quality.OutOfRangeClamped, quality.ChecksumVerified},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			runner := &fakeCycle{statuses: []cycle.SourceStatus{tc.status}}
			handler, token := authorizedServerWith(t, "viewer", &fakeStore{}, runner, tc.descriptor)
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
			got := body.Sources[0].QualityFindings
			for _, want := range tc.want {
				if !contains(got, want) {
					t.Fatalf("findings = %v, want %s", got, want)
				}
			}
			for _, unwanted := range tc.unwanted {
				if contains(got, unwanted) {
					t.Fatalf("findings = %v, want no %s", got, unwanted)
				}
			}
			// The served order is the catalogue order, not the detection order.
			if !orderedByCatalog(got) {
				t.Fatalf("findings are not in catalogue order: %v", got)
			}
			// A declared priority outside the nominal range is served bounded.
			if tc.name == "priority outside the nominal range" && body.RiskInput.Priority != 100 {
				t.Fatalf("risk_input.priority = %d, want the bounded 100", body.RiskInput.Priority)
			}
		})
	}
}

// The review is a tactical write: analista and admin reach it, a viewer is refused
// 403, and the actor it records is the verified token subject - never a field of
// the body, which is refused. The ratified D-C matrix names this route explicitly
// (viewer No, analista Si, admin Si), which is why the guard is requireTactical and
// not requireAdmin; the viewer arm still has to be refused.
func TestSourceReviewRequiresTacticalRoleAndUsesTheVerifiedSubject(t *testing.T) {
	for _, tc := range []struct {
		name, role, subject, token string
		want                       int
	}{
		{"admin", "admin", "operator@example.test", "", http.StatusOK},
		{"analista", "analista", "analyst@example.test", "", http.StatusOK},
		{"viewer", "viewer", "viewer@example.test", "", http.StatusForbidden},
		{"unknown role", "operator", "operator@example.test", "", http.StatusForbidden},
		{"missing token", "admin", "operator@example.test", "-", http.StatusUnauthorized},
		{"invalid token", "admin", "operator@example.test", "invalid", http.StatusUnauthorized},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &fakeStore{}
			handler, token := authorizedServerWithSubject(t, tc.role, tc.subject, store, source.NewFixtureProvider())
			if tc.token == "-" {
				token = ""
			}
			if tc.token == "invalid" {
				token = "invalid"
			}
			w := reviewCall(t, handler, token, sourceReviewTarget, `{"decision":"incorporated","note":"revisado"}`)
			if w.Code != tc.want {
				t.Fatalf("got %d want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if tc.want != http.StatusOK {
				if len(store.sourceReviewWrites) != 0 {
					t.Fatalf("a refused review reached storage: %+v", store.sourceReviewWrites)
				}
				return
			}
			if len(store.sourceReviewWrites) != 1 {
				t.Fatalf("writes = %+v", store.sourceReviewWrites)
			}
			written := store.sourceReviewWrites[0]
			if written.ReviewedBy != tc.subject {
				t.Fatalf("reviewed_by = %q, want the verified subject %q", written.ReviewedBy, tc.subject)
			}
			if written.SourceID != "fixture-sample" || written.Decision != repository.SourceReviewIncorporated || written.Note != "revisado" {
				t.Fatalf("written = %+v", written)
			}
			var body sourceReviewWire
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body.SourceID != "fixture-sample" || body.Decision != "incorporated" || body.ReviewedBy != tc.subject || body.Note != "revisado" || body.ReviewedAt.IsZero() {
				t.Fatalf("response = %+v", body)
			}
		})
	}
}

// Every body this route cannot honour is refused with its own documented code and
// nothing is stored. A body that names an actor is refused instead of ignored,
// because an ignored actor would look honoured.
func TestSourceReviewRefusesBodiesItCannotHonour(t *testing.T) {
	long := strings.Repeat("ñ", 500) // the longest note the route accepts.
	tooLong := strings.Repeat("ñ", 501)
	for _, tc := range []struct {
		name, target, body string
		want               int
		code               string
	}{
		{"valid", sourceReviewTarget, `{"decision":"incorporated"}`, http.StatusOK, ""},
		{"valid with a 500 character note", sourceReviewTarget, `{"decision":"acknowledged","note":"` + long + `"}`, http.StatusOK, ""},
		{"unknown key reviewed_by", sourceReviewTarget, `{"decision":"incorporated","reviewed_by":"someone"}`, http.StatusBadRequest, "invalid_review_request"},
		{"unknown key actor", sourceReviewTarget, `{"decision":"incorporated","actor":"someone"}`, http.StatusBadRequest, "invalid_review_request"},
		{"malformed json", sourceReviewTarget, `{"decision":`, http.StatusBadRequest, "invalid_review_request"},
		{"empty body", sourceReviewTarget, ``, http.StatusBadRequest, "invalid_review_request"},
		{"json null", sourceReviewTarget, `null`, http.StatusBadRequest, "invalid_review_request"},
		{"json array", sourceReviewTarget, `[]`, http.StatusBadRequest, "invalid_review_request"},
		{"second document", sourceReviewTarget, `{"decision":"incorporated"}{"decision":"acknowledged"}`, http.StatusBadRequest, "invalid_review_request"},
		{"unknown decision", sourceReviewTarget, `{"decision":"approved"}`, http.StatusUnprocessableEntity, "invalid_decision"},
		{"missing decision", sourceReviewTarget, `{"note":"revisado"}`, http.StatusUnprocessableEntity, "invalid_decision"},
		{"note too long", sourceReviewTarget, `{"decision":"incorporated","note":"` + tooLong + `"}`, http.StatusUnprocessableEntity, "invalid_note"},
		{"explicit null note", sourceReviewTarget, `{"decision":"incorporated","note":null}`, http.StatusBadRequest, "invalid_review_request"},
		{"explicit null note with padding", sourceReviewTarget, `{"decision":"incorporated","note" : null }`, http.StatusBadRequest, "invalid_review_request"},
		{"numeric note", sourceReviewTarget, `{"decision":"incorporated","note":7}`, http.StatusBadRequest, "invalid_review_request"},
		{"unknown source", "/v1/risk/sources/otra-fuente/review", `{"decision":"incorporated"}`, http.StatusNotFound, "source_not_found"},
		{"empty source", "/v1/risk/sources/%20/review", `{"decision":"incorporated"}`, http.StatusNotFound, "source_not_found"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &fakeStore{}
			handler, token := authorizedServer(t, "admin", store, source.NewFixtureProvider())
			w := reviewCall(t, handler, token, tc.target, tc.body)
			if w.Code != tc.want {
				t.Fatalf("got %d want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if tc.want != http.StatusOK {
				var body map[string]string
				decodeBody(t, w.Body.Bytes(), &body)
				if body["code"] != tc.code {
					t.Fatalf("code = %q, want %q (%s)", body["code"], tc.code, w.Body.String())
				}
				if len(store.sourceReviewWrites) != 0 {
					t.Fatalf("a refused review reached storage: %+v", store.sourceReviewWrites)
				}
				return
			}
			if len(store.sourceReviewWrites) != 1 {
				t.Fatalf("writes = %+v", store.sourceReviewWrites)
			}
		})
	}
}

// The read reflects the latest review of each source, and the answer is the stored
// row, not the request: a second review becomes the current one and the first row
// is left untouched, which is what makes the table a trace.
func TestSourceReviewReadBackIsTheLatestPerSource(t *testing.T) {
	store := &fakeStore{}
	handler, token := authorizedServerWithSubject(t, "admin", "operator@example.test", store, source.NewFixtureProvider())
	if w := reviewCall(t, handler, token, sourceReviewTarget, `{"decision":"acknowledged","note":"primera"}`); w.Code != http.StatusOK {
		t.Fatalf("first review got %d: %s", w.Code, w.Body.String())
	}
	if w := reviewCall(t, handler, token, sourceReviewTarget, `{"decision":"incorporated","note":"segunda"}`); w.Code != http.StatusOK {
		t.Fatalf("second review got %d: %s", w.Code, w.Body.String())
	}
	if len(store.sourceReviewWrites) != 2 {
		t.Fatalf("writes = %+v, want two appended rows", store.sourceReviewWrites)
	}
	w := getZones(t, handler, token, "/v1/risk/sources")
	if w.Code != http.StatusOK {
		t.Fatalf("read got %d: %s", w.Code, w.Body.String())
	}
	var body sourcesResponse
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	// The read-back is asserted for EVERY reviewed source, with no skip: the active
	// source is published even when the cycle reports no status for it, so a stored
	// review is always readable. The entry is located by identifier rather than by
	// position, because the order is the cycle's and a second source may exist.
	entry := sourceEntryOf(t, body, "fixture-sample")
	review := entry.Review
	if review == nil || review.Decision != "incorporated" || review.Note != "segunda" || review.ReviewedBy != "operator@example.test" {
		t.Fatalf("review = %+v", review)
	}
	if review.ReviewedAt.IsZero() {
		t.Fatal("the read-back review carries no instant")
	}
}

// The active source is published NEXT TO the sources the cycle reports, once, and
// last: a review of the active source has to be readable whether or not the
// scheduler has run, and a source the cycle already reports must not be duplicated.
func TestSourcesPublishesTheActiveSourceNextToTheCycle(t *testing.T) {
	store := &fakeStore{}
	handler, token := authorizedServerSubjectWith(t, "admin", "operator@example.test", store, &fakeCycle{
		statuses: []cycle.SourceStatus{{SourceID: "fuente-del-ciclo", Complete: true}},
	}, source.NewFixtureProvider())
	if w := reviewCall(t, handler, token, sourceReviewTarget, `{"decision":"acknowledged"}`); w.Code != http.StatusOK {
		t.Fatalf("review got %d: %s", w.Code, w.Body.String())
	}
	w := getZones(t, handler, token, "/v1/risk/sources")
	if w.Code != http.StatusOK {
		t.Fatalf("read got %d: %s", w.Code, w.Body.String())
	}
	var body sourcesResponse
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Sources) != 2 {
		t.Fatalf("sources = %+v, want the cycle source and the active source once each", body.Sources)
	}
	if body.Sources[0].SourceID != "fuente-del-ciclo" || !body.Sources[0].Complete {
		t.Fatalf("the cycle entry was rewritten: %+v", body.Sources[0])
	}
	active := sourceEntryOf(t, body, "fixture-sample")
	if active.Review == nil || active.Review.Decision != "acknowledged" {
		t.Fatalf("the active source lost its review: %+v", active)
	}
	// A cycle that already reports the active source does not produce a second row.
	duplicated, token := authorizedServerSubjectWith(t, "viewer", "reader@example.test", &fakeStore{}, &fakeCycle{
		statuses: []cycle.SourceStatus{{SourceID: "fixture-sample", Complete: true}},
	}, source.NewFixtureProvider())
	w = getZones(t, duplicated, token, "/v1/risk/sources")
	if w.Code != http.StatusOK {
		t.Fatalf("read got %d: %s", w.Code, w.Body.String())
	}
	var once sourcesResponse
	if err := json.Unmarshal(w.Body.Bytes(), &once); err != nil {
		t.Fatal(err)
	}
	if len(once.Sources) != 1 {
		t.Fatalf("sources = %+v, want the reported source once", once.Sources)
	}
}

// sourceEntryOf finds one served source by identifier, failing the test when the
// read did not publish it at all.
func sourceEntryOf(t *testing.T, body sourcesResponse, sourceID string) sourceEntry {
	t.Helper()
	for _, entry := range body.Sources {
		if entry.SourceID == sourceID {
			return entry
		}
	}
	t.Fatalf("the read did not publish %q: %+v", sourceID, body.Sources)
	return sourceEntry{}
}

// Without the audit seam nothing is announced and the review is still the trace;
// when the seam is wired it receives the verified actor, and its failure is
// reported as an announcement failure rather than as a write that did not happen.
func TestSourceReviewAnnouncesToAWiredAuditSeam(t *testing.T) {
	t.Run("not wired", func(t *testing.T) {
		store := &fakeStore{}
		handler, token := authorizedServerWithSubject(t, "admin", "auditor@example.test", store, source.NewFixtureProvider())
		if w := reviewCall(t, handler, token, sourceReviewTarget, `{"decision":"incorporated"}`); w.Code != http.StatusOK {
			t.Fatalf("got %d: %s", w.Code, w.Body.String())
		}
		if len(store.sourceReviewWrites) != 1 {
			t.Fatalf("writes = %+v", store.sourceReviewWrites)
		}
	})
	t.Run("wired", func(t *testing.T) {
		store := &auditingStore{fakeStore: &fakeStore{}}
		handler, token := authorizedServerWithSubject(t, "admin", "auditor@example.test", store, source.NewFixtureProvider())
		if w := reviewCall(t, handler, token, sourceReviewTarget, `{"decision":"acknowledged","note":"nota"}`); w.Code != http.StatusOK {
			t.Fatalf("got %d: %s", w.Code, w.Body.String())
		}
		if len(store.events) != 1 {
			t.Fatalf("events = %+v, want one", store.events)
		}
		event := store.events[0]
		if event.ReviewedBy != "auditor@example.test" || event.Decision != repository.SourceReviewAcknowledged || event.SourceID != "fixture-sample" || event.Note != "nota" {
			t.Fatalf("event = %+v", event)
		}
	})
	t.Run("announcement failure", func(t *testing.T) {
		store := &auditingStore{fakeStore: &fakeStore{}, auditErr: errors.New("audit unavailable")}
		handler, token := authorizedServerWithSubject(t, "admin", "auditor@example.test", store, source.NewFixtureProvider())
		w := reviewCall(t, handler, token, sourceReviewTarget, `{"decision":"incorporated"}`)
		if w.Code != http.StatusServiceUnavailable {
			t.Fatalf("got %d want 503: %s", w.Code, w.Body.String())
		}
		var body map[string]string
		decodeBody(t, w.Body.Bytes(), &body)
		if body["code"] != "review_audit_unavailable" {
			t.Fatalf("code = %q", body["code"])
		}
		if len(store.sourceReviewWrites) != 1 {
			t.Fatalf("the stored row was lost when the announcement failed: %+v", store.sourceReviewWrites)
		}
	})
}

// A storage failure on the read fails closed instead of serving sources with no
// findings and no review, which would read as "nothing to report".
func TestSourceQualityReadFailsClosedOnStorageFailure(t *testing.T) {
	store := &fakeStore{sourceReviewReadErr: errors.New("storage unavailable")}
	handler, token := authorizedServer(t, "viewer", store, source.NewFixtureProvider())
	w := getZones(t, handler, token, "/v1/risk/sources")
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("got %d want 503: %s", w.Code, w.Body.String())
	}
	var body map[string]string
	decodeBody(t, w.Body.Bytes(), &body)
	if body["code"] != "storage_unavailable" {
		t.Fatalf("code = %q", body["code"])
	}
}

// The write refuses with 503 when storage fails, and no review is answered as if
// it had been recorded.
func TestSourceReviewFailsClosedOnStorageFailure(t *testing.T) {
	store := &fakeStore{sourceReviewErr: errors.New("storage unavailable")}
	handler, token := authorizedServerWithSubject(t, "admin", "operator@example.test", store, source.NewFixtureProvider())
	w := reviewCall(t, handler, token, sourceReviewTarget, `{"decision":"incorporated"}`)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("got %d want 503: %s", w.Code, w.Body.String())
	}
	var body map[string]string
	decodeBody(t, w.Body.Bytes(), &body)
	if body["code"] != "storage_unavailable" {
		t.Fatalf("code = %q", body["code"])
	}
}

func contains(findings []quality.Finding, want quality.Finding) bool {
	for _, finding := range findings {
		if finding == want {
			return true
		}
	}
	return false
}

// orderedByCatalog reports whether the served findings follow the catalogue order,
// which is what makes the list deterministic across requests.
func orderedByCatalog(findings []quality.Finding) bool {
	last := -1
	for _, finding := range findings {
		position := -1
		for index, code := range quality.Codes() {
			if code == finding {
				position = index
				break
			}
		}
		if position <= last {
			return false
		}
		last = position
	}
	return true
}

// decodeBody fails the test when a refusal body is not JSON, so a malformed answer
// cannot pass as the documented code.
func decodeBody(t *testing.T, raw []byte, target any) {
	t.Helper()
	if err := json.Unmarshal(raw, target); err != nil {
		t.Fatalf("decode %s: %v", raw, err)
	}
}

// The parser is the single place a review body is read, so its treatment of an
// explicit null is pinned directly: JSON null is not the documented optional
// string, and accepting it would store an empty note the client never sent.
func TestParseSourceReviewRefusesAnExplicitNullNote(t *testing.T) {
	for _, body := range []string{
		`{"decision":"incorporated","note":null}`,
		`{"decision":"incorporated","note" : null }`,
		`{
  "decision": "acknowledged",
  "note": null
}`,
	} {
		if _, ok := parseSourceReview([]byte(body)); ok {
			t.Fatalf("an explicit null note was accepted: %s", body)
		}
	}
	// The documented spellings still parse: absent, empty and a non-empty string.
	for _, body := range []string{
		`{"decision":"incorporated"}`,
		`{"decision":"incorporated","note":""}`,
		`{"decision":"incorporated","note":"nota"}`,
	} {
		parsed, ok := parseSourceReview([]byte(body))
		if !ok {
			t.Fatalf("a documented note spelling was refused: %s", body)
		}
		if parsed.Decision != "incorporated" {
			t.Fatalf("decision = %q", parsed.Decision)
		}
	}
	// An explicit null decision is still a missing literal, which the route answers
	// as an invalid decision rather than as a malformed document.
	if parsed, ok := parseSourceReview([]byte(`{"decision":null}`)); !ok || parsed.Decision != "" {
		t.Fatalf("an explicit null decision must parse as the absent literal: ok=%t parsed=%+v", ok, parsed)
	}
}

// The active descriptor describes exactly ONE source. Its synthetic declaration, its
// canonical factor coverage and its declared priority are facts about the active
// source, so a cycle entry with a DIFFERENT identifier must not inherit them: painting
// SYNTHETIC_FALLBACK, MISSING_CANONICAL_FACTOR or OUT_OF_RANGE_CLAMPED on a foreign
// source would report findings nobody observed about it. The foreign entry is
// evaluated on its own evidence - its freshness and the checksum this read verified.
func TestSourceQualityDoesNotAttributeTheActiveDescriptorToAnotherSource(t *testing.T) {
	last := time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)
	fresh := quality.FreshnessWindow.Seconds() - 1
	stale := quality.FreshnessWindow.Seconds() + 1
	// The active source declares one canonical variable, declares itself synthetic and
	// declared a priority outside the nominal range: the three traits that produce the
	// three findings a foreign source must not inherit.
	descriptor := source.NewFixtureProvider().Describe()
	descriptor.Variables = []string{"temperatura"}
	descriptor.Priority = 150
	runner := &fakeCycle{statuses: []cycle.SourceStatus{
		{SourceID: "otra-fuente-fresca", LastRunAt: &last, Complete: true, AgeSeconds: &fresh},
		{SourceID: "otra-fuente-obsoleta", LastRunAt: &last, Complete: true, AgeSeconds: &stale},
		{SourceID: descriptor.ID, LastRunAt: &last, Complete: true, AgeSeconds: &fresh},
	}}
	handler, token := authorizedServerSubjectWith(t, "viewer", "reader@example.test", &fakeStore{}, runner, describedSource{descriptor})
	w := getZones(t, handler, token, "/v1/risk/sources")
	if w.Code != http.StatusOK {
		t.Fatalf("got %d: %s", w.Code, w.Body.String())
	}
	var body sourcesResponse
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}

	// The active source carries all three traits, because they are facts about it.
	active := sourceEntryOf(t, body, descriptor.ID)
	for _, want := range []quality.Finding{
		quality.MissingCanonicalFactor,
		quality.OutOfRangeClamped,
		quality.ChecksumVerified,
		quality.SyntheticFallback,
	} {
		if !contains(active.QualityFindings, want) {
			t.Fatalf("the active source is missing %s: %v", want, active.QualityFindings)
		}
	}

	// The foreign entries carry their OWN evidence and none of the active traits.
	for _, tc := range []struct {
		sourceID string
		want     []quality.Finding
	}{
		{"otra-fuente-fresca", []quality.Finding{quality.ChecksumVerified}},
		{"otra-fuente-obsoleta", []quality.Finding{quality.StaleCutoff, quality.ChecksumVerified}},
	} {
		foreign := sourceEntryOf(t, body, tc.sourceID)
		if !reflect.DeepEqual(foreign.QualityFindings, tc.want) {
			t.Fatalf("%s findings = %v, want exactly its own evidence %v", tc.sourceID, foreign.QualityFindings, tc.want)
		}
		for _, unwanted := range []quality.Finding{
			quality.SyntheticFallback,
			quality.MissingCanonicalFactor,
			quality.OutOfRangeClamped,
		} {
			if contains(foreign.QualityFindings, unwanted) {
				t.Fatalf("%s inherited the active descriptor's %s: %v", tc.sourceID, unwanted, foreign.QualityFindings)
			}
		}
		// The entry itself is the cycle's, untouched, and it has no review.
		if foreign.Complete != true || foreign.Review != nil {
			t.Fatalf("%s entry was rewritten: %+v", tc.sourceID, foreign)
		}
	}
	// The bounded priority still describes the active descriptor's declaration.
	if body.RiskInput.Priority != 100 {
		t.Fatalf("risk_input.priority = %d, want the bounded 100", body.RiskInput.Priority)
	}
}

// reviewlessStore is the handler's Repository WITHOUT the review seam. The embedded
// field is typed as the Repository interface, so only the methods that interface
// declares are promoted: the review operations are absent from the method set and the
// route runs exactly as it does in a process that wired no review storage. The zero
// value is enough for the review route, which calls no other repository method.
type reviewlessStore struct{ Repository }

// The order of the gates is part of the contract: an unknown source is 404 and a
// body that cannot be honoured is 400/422, both BEFORE the capability gate. A caller
// that named a source nobody serves must never be told the server lacks review
// storage, because that answer would describe a capability the request never reached.
func TestSourceReviewOrdersTheSourceAndBodyGatesBeforeTheStorageGate(t *testing.T) {
	for _, tc := range []struct {
		name, target, body string
		store              Repository
		want               int
		code               string
	}{
		{
			name:   "unknown source without storage",
			target: "/v1/risk/sources/otra-fuente/review",
			body:   `{"decision":"incorporated"}`,
			store:  &reviewlessStore{},
			want:   http.StatusNotFound,
			code:   "source_not_found",
		},
		{
			name:   "unknown source with a broken body and no storage",
			target: "/v1/risk/sources/otra-fuente/review",
			body:   `{"decision":`,
			store:  &reviewlessStore{},
			want:   http.StatusNotFound,
			code:   "source_not_found",
		},
		{
			name:   "known source with a broken body and no storage",
			target: sourceReviewTarget,
			body:   `{"decision":"incorporated","actor":"someone"}`,
			store:  &reviewlessStore{},
			want:   http.StatusBadRequest,
			code:   "invalid_review_request",
		},
		{
			name:   "known source with an invalid decision and no storage",
			target: sourceReviewTarget,
			body:   `{"decision":"approved"}`,
			store:  &reviewlessStore{},
			want:   http.StatusUnprocessableEntity,
			code:   "invalid_decision",
		},
		{
			name:   "known source with a durable body but no storage",
			target: sourceReviewTarget,
			body:   `{"decision":"incorporated"}`,
			store:  &reviewlessStore{},
			want:   http.StatusServiceUnavailable,
			code:   "review_store_unavailable",
		},
		{
			name:   "unknown source with storage wired",
			target: "/v1/risk/sources/otra-fuente/review",
			body:   `{"decision":"incorporated"}`,
			store:  &fakeStore{},
			want:   http.StatusNotFound,
			code:   "source_not_found",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			handler, token := authorizedServer(t, "admin", tc.store, source.NewFixtureProvider())
			w := reviewCall(t, handler, token, tc.target, tc.body)
			if w.Code != tc.want {
				t.Fatalf("got %d want %d: %s", w.Code, tc.want, w.Body.String())
			}
			var body map[string]string
			decodeBody(t, w.Body.Bytes(), &body)
			if body["code"] != tc.code {
				t.Fatalf("code = %q, want %q: %s", body["code"], tc.code, w.Body.String())
			}
			if writes, ok := tc.store.(*fakeStore); ok && tc.want != http.StatusOK && len(writes.sourceReviewWrites) != 0 {
				t.Fatalf("a refused review reached storage: %+v", writes.sourceReviewWrites)
			}
		})
	}
}
