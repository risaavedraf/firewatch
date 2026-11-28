package handler

import (
	"errors"
	"net/http"
	"testing"
	"time"

	"firewatch.local/risk/internal/cycle"
	"firewatch.local/risk/internal/repository"
	"firewatch.local/risk/internal/source"
	"github.com/getkin/kin-openapi/openapi3"
)

// TestRiskContractSourceQualityMatchesTheContract validates the real responses of
// the two routes this unit adds against the published document: the closed
// catalogue and the per-source findings/review of the read, and every answer of the
// review write, including each refusal that has its own code.
func TestRiskContractSourceQualityMatchesTheContract(t *testing.T) {
	contract := loadContract(t)
	last := time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)
	age := 30.0
	runner := &fakeCycle{statuses: []cycle.SourceStatus{{
		SourceID:   "fixture-sample",
		LastRunAt:  &last,
		Complete:   true,
		AgeSeconds: &age,
	}}}
	reviewedAt := time.Date(2026, 11, 20, 12, 5, 0, 0, time.UTC)
	stored := map[string]repository.SourceReview{
		"fixture-sample": {
			SourceID:   "fixture-sample",
			Decision:   repository.SourceReviewIncorporated,
			Note:       "revisado por operación",
			ReviewedBy: "operator@example.test",
			ReviewedAt: reviewedAt,
		},
	}

	t.Run("read", func(t *testing.T) {
		store := &fakeStore{sourceReviews: stored}
		handler, token := authorizedServerWith(t, "viewer", store, runner, source.NewFixtureProvider())
		handler = withCorrelationID(handler)
		w := getZones(t, handler, token, "/v1/risk/sources")
		if w.Code != http.StatusOK {
			t.Fatalf("got %d: %s", w.Code, w.Body.String())
		}
		assertResponseMatchesContract(t, contract, "/v1/risk/sources", http.MethodGet, w)
	})

	t.Run("read without a review", func(t *testing.T) {
		handler, token := authorizedServerWith(t, "viewer", &fakeStore{}, runner, source.NewFixtureProvider())
		handler = withCorrelationID(handler)
		w := getZones(t, handler, token, "/v1/risk/sources")
		if w.Code != http.StatusOK {
			t.Fatalf("got %d: %s", w.Code, w.Body.String())
		}
		assertResponseMatchesContract(t, contract, "/v1/risk/sources", http.MethodGet, w)
	})

	t.Run("read storage failure", func(t *testing.T) {
		store := &fakeStore{sourceReviewReadErr: errors.New("storage unavailable")}
		handler, token := authorizedServerWith(t, "viewer", store, runner, source.NewFixtureProvider())
		handler = withCorrelationID(handler)
		w := getZones(t, handler, token, "/v1/risk/sources")
		if w.Code != http.StatusServiceUnavailable {
			t.Fatalf("got %d: %s", w.Code, w.Body.String())
		}
		assertResponseMatchesContract(t, contract, "/v1/risk/sources", http.MethodGet, w)
	})

	for _, tc := range []struct {
		name, role, token, target, body string
		store                           *fakeStore
		want                            int
	}{
		{name: "incorporated", role: "admin", target: sourceReviewTarget, body: `{"decision":"incorporated"}`, store: &fakeStore{}, want: http.StatusOK},
		{name: "acknowledged with a note", role: "admin", target: sourceReviewTarget, body: `{"decision":"acknowledged","note":"nota"}`, store: &fakeStore{}, want: http.StatusOK},
		{name: "unhonourable body", role: "admin", target: sourceReviewTarget, body: `{"decision":"incorporated","actor":"someone"}`, store: &fakeStore{}, want: http.StatusBadRequest},
		{name: "unknown source", role: "admin", target: "/v1/risk/sources/otra-fuente/review", body: `{"decision":"incorporated"}`, store: &fakeStore{}, want: http.StatusNotFound},
		{name: "invalid decision", role: "admin", target: sourceReviewTarget, body: `{"decision":"approved"}`, store: &fakeStore{}, want: http.StatusUnprocessableEntity},
		{name: "note too long", role: "admin", target: sourceReviewTarget, body: `{"decision":"incorporated","note":"` + tooLongNote() + `"}`, store: &fakeStore{}, want: http.StatusUnprocessableEntity},
		{name: "storage failure", role: "admin", target: sourceReviewTarget, body: `{"decision":"incorporated"}`, store: &fakeStore{sourceReviewErr: errors.New("storage unavailable")}, want: http.StatusServiceUnavailable},
		{name: "forbidden for a viewer", role: "viewer", target: sourceReviewTarget, body: `{"decision":"incorporated"}`, store: &fakeStore{}, want: http.StatusForbidden},
		{name: "missing token", role: "admin", token: "-", target: sourceReviewTarget, body: `{"decision":"incorporated"}`, store: &fakeStore{}, want: http.StatusUnauthorized},
	} {
		t.Run(tc.name, func(t *testing.T) {
			handler, token := authorizedServer(t, tc.role, tc.store, source.NewFixtureProvider())
			handler = withCorrelationID(handler)
			if tc.token == "-" {
				token = ""
			}
			w := reviewCall(t, handler, token, tc.target, tc.body)
			if w.Code != tc.want {
				t.Fatalf("got %d want %d: %s", w.Code, tc.want, w.Body.String())
			}
			assertResponseMatchesContract(t, contract, "/v1/risk/sources/{source_id}/review", http.MethodPost, w)
		})
	}
}

// The two 503 answers of the write have their own codes and their own meaning: one
// says nothing was appended because this deployment wired no review storage, the
// other says the review WAS appended but its audit event could not be recorded. Both
// are validated against the published document like every other answer, because a
// refusal the contract does not describe is not a documented refusal.
func TestRiskContractSourceReviewUnavailableAnswersMatchTheContract(t *testing.T) {
	contract := loadContract(t)
	t.Run("review store unavailable", func(t *testing.T) {
		handler, token := authorizedServer(t, "admin", &reviewlessStore{}, source.NewFixtureProvider())
		handler = withCorrelationID(handler)
		w := reviewCall(t, handler, token, sourceReviewTarget, `{"decision":"incorporated"}`)
		if w.Code != http.StatusServiceUnavailable {
			t.Fatalf("got %d: %s", w.Code, w.Body.String())
		}
		var body map[string]string
		decodeBody(t, w.Body.Bytes(), &body)
		if body["code"] != "review_store_unavailable" {
			t.Fatalf("code = %q", body["code"])
		}
		assertResponseMatchesContract(t, contract, "/v1/risk/sources/{source_id}/review", http.MethodPost, w)
	})
	t.Run("review audit unavailable", func(t *testing.T) {
		store := &auditingStore{fakeStore: &fakeStore{}, auditErr: errors.New("audit unavailable")}
		handler, token := authorizedServerWithSubject(t, "admin", "auditor@example.test", store, source.NewFixtureProvider())
		handler = withCorrelationID(handler)
		w := reviewCall(t, handler, token, sourceReviewTarget, `{"decision":"acknowledged","note":"nota"}`)
		if w.Code != http.StatusServiceUnavailable {
			t.Fatalf("got %d: %s", w.Code, w.Body.String())
		}
		var body map[string]string
		decodeBody(t, w.Body.Bytes(), &body)
		if body["code"] != "review_audit_unavailable" {
			t.Fatalf("code = %q", body["code"])
		}
		assertResponseMatchesContract(t, contract, "/v1/risk/sources/{source_id}/review", http.MethodPost, w)
	})
}

// tooLongNote is one character past the documented limit, so the refusal is the
// length and not an encoding artefact.
func tooLongNote() string {
	const limit = 500
	note := make([]rune, 0, limit+1)
	for index := 0; index < limit+1; index++ {
		note = append(note, 'ñ')
	}
	return string(note)
}

// TestRiskContractSourceQualityCatalogIsRequired pins the one member a client
// cannot do without: the closed catalogue. Declared optional, an answer could omit
// it and the document would still validate, so the page would have to invent the
// vocabulary the service never published. The list is asserted whole and without
// repeats, because a required member stated twice is a document defect too.
func TestRiskContractSourceQualityCatalogIsRequired(t *testing.T) {
	contract := loadContract(t)
	item := contract.Paths.Find("/v1/risk/sources")
	if item == nil || item.GetOperation(http.MethodGet) == nil {
		t.Fatal("the contract documents no GET /v1/risk/sources")
	}
	documented := item.GetOperation(http.MethodGet).Responses.Status(http.StatusOK)
	if documented == nil || documented.Value == nil {
		t.Fatal("the contract documents no 200 answer for GET /v1/risk/sources")
	}
	media := documented.Value.Content.Get("application/json")
	if media == nil || media.Schema == nil || media.Schema.Value == nil {
		t.Fatal("the contract documents no application/json body for the read")
	}
	required := make(map[string]bool, len(media.Schema.Value.Required))
	for _, name := range media.Schema.Value.Required {
		if required[name] {
			t.Fatalf("the required list repeats %q: %v", name, media.Schema.Value.Required)
		}
		required[name] = true
	}
	for _, name := range []string{"geography", "risk_input", "quality_catalog", "sources"} {
		if !required[name] {
			t.Fatalf("%q is not a required member of the read: %v", name, media.Schema.Value.Required)
		}
	}
}

// TestRiskContractSourceReviewIsNullableInTheRead pins the strict OpenAPI 3.0.3
// reading of the review member: the read serves the absence of a review as null, so
// BOTH the property and the schema it references have to allow null - an allOf whose
// branch rejects null rejects the whole member, whatever the property declares. A
// keyword-only assertion would not prove that, so the loaded document is asked to
// validate instances: null passes, a stored review passes, and a broken one fails.
func TestRiskContractSourceReviewIsNullableInTheRead(t *testing.T) {
	contract := loadContract(t)
	entry := contract.Components.Schemas["SourceQualityEntry"]
	if entry == nil || entry.Value == nil {
		t.Fatal("the contract declares no SourceQualityEntry")
	}
	var review *openapi3.Schema
	for _, branch := range entry.Value.AllOf {
		if branch.Value == nil {
			continue
		}
		if candidate, ok := branch.Value.Properties["review"]; ok && candidate.Value != nil {
			review = candidate.Value
		}
	}
	if review == nil {
		t.Fatal("SourceQualityEntry declares no review member")
	}
	// The property states the two keywords the strict reading needs.
	if review.Type == nil || !review.Type.Is("object") {
		t.Fatalf("review has no explicit object type: %v", review.Type)
	}
	if !review.Nullable {
		t.Fatal("review is not declared nullable")
	}
	if len(review.AllOf) != 1 || review.AllOf[0].Ref != "#/components/schemas/SourceReview" {
		t.Fatalf("review does not reference SourceReview: %+v", review.AllOf)
	}
	// The referenced schema must allow null too, or the reference vetoes the member.
	stored := contract.Components.Schemas["SourceReview"]
	if stored == nil || stored.Value == nil {
		t.Fatal("the contract declares no SourceReview")
	}
	if stored.Value.Type == nil || !stored.Value.Type.Is("object") {
		t.Fatalf("SourceReview has no explicit object type: %v", stored.Value.Type)
	}
	if !stored.Value.Nullable {
		t.Fatal("SourceReview is not declared nullable, so the allOf reference rejects null")
	}
	// Instance-level proof through the document the service publishes.
	if err := review.VisitJSON(nil); err != nil {
		t.Fatalf("the read refuses an absent review: %v", err)
	}
	if err := review.VisitJSON(map[string]any{
		"source_id":   "fixture-sample",
		"decision":    "incorporated",
		"note":        "revisado",
		"reviewed_by": "operator@example.test",
		"reviewed_at": "2026-11-20T12:05:00Z",
	}); err != nil {
		t.Fatalf("the read refuses a stored review: %v", err)
	}
	if err := review.VisitJSON(map[string]any{"source_id": "fixture-sample"}); err == nil {
		t.Fatal("the read accepts a review that misses the decision, the actor and the instant")
	}
}
