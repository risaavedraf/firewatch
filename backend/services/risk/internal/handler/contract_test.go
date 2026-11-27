package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"firewatch.local/risk/internal/classify"
	"firewatch.local/risk/internal/cycle"
	"firewatch.local/risk/internal/repository"
	"firewatch.local/risk/internal/service"
	"firewatch.local/risk/internal/source"
	"github.com/getkin/kin-openapi/openapi3"
	"github.com/google/uuid"
)

// These tests validate real handler responses against the published contract,
// instead of only checking that the specification parses. They cover the
// service-owned error bodies the gateway cannot reach without this service: the
// dependency-unavailable 503 and the empty-state 404.

// contractPath locates the published contract from this package's working dir.
var contractPath = filepath.Join("..", "..", "..", "..", "contracts", "openapi", "firewatch-v1.yaml")

func loadContract(t *testing.T) *openapi3.T {
	t.Helper()
	loader := openapi3.NewLoader()
	contract, err := loader.LoadFromFile(contractPath)
	if err != nil {
		t.Fatalf("load the published contract: %v", err)
	}
	if err := contract.Validate(context.Background()); err != nil {
		t.Fatalf("the published contract is not valid: %v", err)
	}
	return contract
}

// withCorrelationID mirrors the production middleware in cmd/server/main.go: it
// parses the forwarded correlation id, rewrites the response header with the
// canonical dashed form and forwards the same value on the request so the
// handler error bodies echo one literal. It is reproduced here because that
// middleware lives in package main and cannot be imported; the id's origin is
// what it fakes, and the request-to-body-to-header flow it enables is what the
// assertions below pin.
func withCorrelationID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, err := uuid.Parse(r.Header.Get("X-Request-ID"))
		if err != nil {
			id = uuid.New()
		}
		w.Header().Set("X-Request-ID", id.String())
		r.Header.Set("X-Request-ID", id.String())
		next.ServeHTTP(w, r)
	})
}

// assertResponseMatchesContract fails when the real response is not the one the
// contract documents: the status must be declared for the operation, every
// header the contract declares must be present, and the JSON body must validate
// against the declared schema.
func assertResponseMatchesContract(t *testing.T, contract *openapi3.T, target, method string, response *httptest.ResponseRecorder) {
	t.Helper()
	item := contract.Paths.Find(target)
	if item == nil {
		t.Fatalf("contract documents no path %q", target)
	}
	operation := item.GetOperation(method)
	if operation == nil {
		t.Fatalf("contract documents no %s operation for %q", method, target)
	}
	documented := operation.Responses.Status(response.Code)
	if documented == nil || documented.Value == nil {
		t.Fatalf("contract documents no %d response for %s %s", response.Code, method, target)
	}
	for name := range documented.Value.Headers {
		if response.Header().Get(name) == "" {
			t.Errorf("%s %s %d is missing the documented header %q", method, target, response.Code, name)
		}
	}
	media := documented.Value.Content.Get("application/json")
	if media == nil || media.Schema == nil || media.Schema.Value == nil {
		t.Fatalf("contract documents no application/json body for %s %s %d", method, target, response.Code)
	}
	var body any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("response body is not JSON: %v: %s", err, response.Body.String())
	}
	if err := media.Schema.Value.VisitJSON(body); err != nil {
		t.Fatalf("response body does not match the contract for %s %s %d: %v\nbody: %s", method, target, response.Code, err, response.Body.String())
	}
}

func request(t *testing.T, handler http.Handler, token, target string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, target, nil)
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("X-Request-ID", uuid.NewString())
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

// TestRiskContractNewSurfacesMatchTheContract validates the responses added for
// the cycle and the model registry against the published schema, so the document
// cannot drift from what the handlers emit.
func TestRiskContractNewSurfacesMatchTheContract(t *testing.T) {
	contract := loadContract(t)
	hash := "59259c4c0c470e5a0d512fe09f6c748c38fd29f9bc5d760d49754555c66e699b"
	approved := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	age := 30.0
	last, next := approved, approved.Add(15*time.Minute)
	store := &fakeStore{models: []repository.ModelVersion{
		{Version: "academic-rule-v1", Kind: "rule", ParamsHash: &hash, ApprovedAt: &approved, Active: true, Metrics: json.RawMessage(`{}`)},
		{Version: "demo-fixture-v1", Kind: "placeholder", Active: false, Metrics: json.RawMessage(`{}`)},
	}}
	runner := &fakeCycle{
		statuses: []cycle.SourceStatus{{SourceID: "fixture-sample", LastRunAt: &last, NextRunAt: &next, Complete: true, AgeSeconds: &age}},
		result: cycle.RunResult{
			SourceID:   "fixture-sample",
			StartedAt:  approved,
			FinishedAt: approved,
			Complete:   true,
			Zones:      []cycle.ZoneResult{{ZoneID: "valparaiso-demo", Published: true}},
		},
	}
	base, token := authorizedServerWith(t, "admin", store, runner, describedSource{source.NewFixtureProvider().Describe()})
	app := withCorrelationID(base)

	for _, target := range []string{"/v1/models", "/v1/risk/sources"} {
		w := request(t, app, token, target)
		if w.Code != http.StatusOK {
			t.Fatalf("%s got %d: %s", target, w.Code, w.Body.String())
		}
		assertResponseMatchesContract(t, contract, target, http.MethodGet, w)
	}

	r := httptest.NewRequest(http.MethodPost, "/v1/risk/cycle/run", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("X-Request-ID", uuid.NewString())
	w := httptest.NewRecorder()
	app.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("cycle run got %d: %s", w.Code, w.Body.String())
	}
	assertResponseMatchesContract(t, contract, "/v1/risk/cycle/run", http.MethodPost, w)
}

// S4: the map reads every zone's last published batch from one aggregate route,
// so the document must declare it and both its populated and its empty body must
// validate. The aggregate element deliberately omits the catalogue geometry, so
// this pins that the documented schema can express a body without it.
func TestRiskContractAggregateBatchesMatchTheContract(t *testing.T) {
	contract := loadContract(t)
	published := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	policy := classify.PolicyRef{PolicyID: "academic-rule-v1", Parameters: map[string]string{"alto": "0.7"}, ParamsHash: "59259c4c0c470e5a0d512fe09f6c748c38fd29f9bc5d760d49754555c66e699b"}
	actor := "operator-ana"
	batch := repository.Batch{
		ID:           uuid.NewString(),
		JobID:        uuid.NewString(),
		ZoneID:       "05101",
		RequestedAt:  published,
		PublishedAt:  published.Add(time.Minute),
		ValidUntil:   published.Add(15 * time.Minute),
		ModelVersion: "academic-rule-v1",
		Demo:         false,
		DataStatus:   "current",
		RiskLevel:    "alto",
		Factors:      json.RawMessage(`[{"name":"temperatura","known":true,"value":32,"contribution":0.85,"note":"lectura de alta temperatura"}]`),
		Rationale:    "Puntaje ponderado alto.",
		Notice:       "",
		Policy:       &policy,
		// The wire literals are pinned here on purpose: this test validates the
		// published contract, so it must fail if the contract's enum and the value
		// a manual evaluation actually serves ever disagree.
		EvaluationTrigger: "manual",
		EvaluatedBy:       &actor,
	}

	for _, tc := range []struct {
		name  string
		store *fakeStore
		want  int
	}{
		{"populated aggregate", &fakeStore{latestPerZone: []repository.Batch{batch}}, http.StatusOK},
		{"nothing published", &fakeStore{}, http.StatusOK},
		{"storage unavailable", &fakeStore{aggregateErr: errors.New("storage unavailable")}, http.StatusServiceUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			base, token := authorizedServer(t, "viewer", tc.store)
			app := withCorrelationID(base)
			w := request(t, app, token, "/v1/risk/batches")
			if w.Code != tc.want {
				t.Fatalf("got %d want %d: %s", w.Code, tc.want, w.Body.String())
			}
			assertResponseMatchesContract(t, contract, "/v1/risk/batches", http.MethodGet, w)
		})
	}
}

// S3: "dependencia no disponible" — a storage failure is answered 503 with the
// documented shared error body, and its request_id is the same literal as the
// header the page reads.
func TestRiskContractDependencyUnavailableResponse(t *testing.T) {
	contract := loadContract(t)
	base, token := authorizedServer(t, "viewer", &fakeStore{zoneErr: errors.New("storage unavailable")})
	app := withCorrelationID(base)

	w := request(t, app, token, "/v1/risk/latest?zone_id=valparaiso-demo")
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("got %d want %d: %s", w.Code, http.StatusServiceUnavailable, w.Body.String())
	}
	assertResponseMatchesContract(t, contract, "/v1/risk/latest", http.MethodGet, w)

	var body struct {
		RequestID string `json:"request_id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if body.RequestID != w.Header().Get("X-Request-ID") {
		t.Errorf("body request_id %q and header %q must be the same literal", body.RequestID, w.Header().Get("X-Request-ID"))
	}
}

// S3: the empty-state 404 is deliberately not the shared error body: it carries
// code and data_status and no request_id. The contract documents that shape, and
// this test keeps the two from being conflated.
func TestRiskContractEmptyStateResponse(t *testing.T) {
	contract := loadContract(t)
	base, token := authorizedServer(t, "viewer", &fakeStore{zones: map[string]bool{"valparaiso-demo": true}})
	app := withCorrelationID(base)

	w := request(t, app, token, "/v1/risk/latest?zone_id=valparaiso-demo")
	if w.Code != http.StatusNotFound {
		t.Fatalf("got %d want %d: %s", w.Code, http.StatusNotFound, w.Body.String())
	}
	assertResponseMatchesContract(t, contract, "/v1/risk/latest", http.MethodGet, w)
}

// PM-06 (S1-S2): the documented batch carries the provenance of the evaluation, so
// the two reads that serve a batch must serve both members with the values storage
// holds. This is the contract half of "a scheduler evaluation is distinguishable
// from a manual one": a document that declared the members while the response
// omitted them, or served a different vocabulary, fails here instead of at review.
func TestRiskContractBatchProvenanceMatchesTheContract(t *testing.T) {
	contract := loadContract(t)
	published := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	actor := "operator-ana"
	policy := classify.PolicyRef{PolicyID: "academic-rule-v1", Parameters: map[string]string{"alto": "0.7"}, ParamsHash: "59259c4c0c470e5a0d512fe09f6c748c38fd29f9bc5d760d49754555c66e699b"}
	newBatch := func(trigger string, evaluatedBy *string) repository.Batch {
		return repository.Batch{
			ID:           uuid.NewString(),
			JobID:        uuid.NewString(),
			ZoneID:       "valparaiso-demo",
			RequestedAt:  published,
			PublishedAt:  published.Add(time.Minute),
			ValidUntil:   published.Add(15 * time.Minute),
			ModelVersion: "academic-rule-v1",
			DataStatus:   "current",
			RiskLevel:    "alto",
			Factors:      json.RawMessage(`[{"name":"temperatura","known":true,"value":32,"contribution":0.85}]`),
			Rationale:    "Puntaje ponderado alto.",
			Policy:       &policy,
			// The per-zone reads serve the catalogue geometry, so the fixture carries
			// one: the point here is the provenance pair, and a body without geometry
			// would fail the contract for a reason unrelated to this test.
			Geometry:          json.RawMessage(`{"type":"Point","coordinates":[-71.6127,-33.0472]}`),
			EvaluationTrigger: trigger,
			EvaluatedBy:       evaluatedBy,
		}
	}

	for _, tc := range []struct {
		name        string
		trigger     string
		evaluatedBy *string
	}{
		{"scheduled evaluation records no actor", "scheduler", nil},
		{"manual evaluation records the verified subject", "manual", &actor},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stored := newBatch(tc.trigger, tc.evaluatedBy)
			store := &fakeStore{batches: []repository.Batch{stored}, zones: map[string]bool{"valparaiso-demo": true}}
			base, token := authorizedServer(t, "viewer", store)
			app := withCorrelationID(base)

			// The single-batch read.
			single := request(t, app, token, "/v1/risk/latest?zone_id=valparaiso-demo")
			if single.Code != http.StatusOK {
				t.Fatalf("latest got %d: %s", single.Code, single.Body.String())
			}
			assertResponseMatchesContract(t, contract, "/v1/risk/latest", http.MethodGet, single)
			assertBatchProvenance(t, single.Body.Bytes(), tc.trigger, tc.evaluatedBy, false)

			// The bounded window read.
			history := request(t, app, token, "/v1/risk/history?zone_id=valparaiso-demo")
			if history.Code != http.StatusOK {
				t.Fatalf("history got %d: %s", history.Code, history.Body.String())
			}
			assertResponseMatchesContract(t, contract, "/v1/risk/history", http.MethodGet, history)
			assertBatchProvenance(t, history.Body.Bytes(), tc.trigger, tc.evaluatedBy, true)
		})
	}
}

// assertBatchProvenance decodes one batch body - or a one-element array of them -
// and checks the provenance members against what storage held, including that a
// scheduled evaluation serves evaluated_by as JSON null rather than as a blank
// string or an omitted member.
func assertBatchProvenance(t *testing.T, body []byte, trigger string, evaluatedBy *string, array bool) {
	t.Helper()
	encoded := body
	if array {
		var list []json.RawMessage
		if err := json.Unmarshal(body, &list); err != nil {
			t.Fatalf("decode history body: %v: %s", err, body)
		}
		if len(list) != 1 {
			t.Fatalf("history served %d batches, want 1: %s", len(list), body)
		}
		encoded = list[0]
	}
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("decode batch body: %v: %s", err, body)
	}
	if got := string(decoded["evaluation_trigger"]); got != `"`+trigger+`"` {
		t.Errorf("evaluation_trigger = %s, want %q", got, trigger)
	}
	got, present := decoded["evaluated_by"]
	if !present {
		t.Fatal("evaluated_by is absent from the response; the contract declares it required and nullable")
	}
	if evaluatedBy == nil {
		if string(got) != "null" {
			t.Errorf("evaluated_by = %s, want null for a scheduled evaluation", got)
		}
		return
	}
	if string(got) != `"`+*evaluatedBy+`"` {
		t.Errorf("evaluated_by = %s, want %q", got, *evaluatedBy)
	}
}

// PM-16 / S1 (T3): the documented `effective` object has exactly three shapes.
// Each one is produced through the production resolver and the real authorized
// handler, then validated against the published contract extract, so the
// document and the wire body cannot drift apart. The registry list is present in
// every case, including unavailable, because the projection is additive.
func TestRiskContractEffectiveProjectionMatchesTheContract(t *testing.T) {
	contract := loadContract(t)
	const trainedID = "ml-fixture-v1"
	const trainedHash = "992bd6ac53c75c2d31829c1126c8d2cb97d5a61cad4348d1047d5c93b15a15b5"
	registry := effectiveTestRegistry(t, stubTrainedClassifier{id: trainedID, hash: trainedHash})
	models := []repository.ModelVersion{
		{Version: classify.FirewatchRuleV2ID, Kind: "rule", ParamsHash: stringPtr(classify.FirewatchRuleV2ParamsHash), Active: true, Metrics: json.RawMessage(`{}`)},
	}

	for _, tc := range []struct {
		name      string
		model     repository.ModelVersion
		bootstrap classify.Classifier
		want      string
	}{
		{"verified rule", activatedModel(classify.FirewatchRuleV2ID, classify.FirewatchRuleV2ParamsHash), classify.NewAcademicRuleV1(), "rule"},
		{"resolved non-rule", activatedModel(trainedID, trainedHash), classify.NewAcademicRuleV1(), "non_rule"},
		{"unavailable", activatedModel(classify.AcademicRuleV1ID, strings.Repeat("0", 64)), classify.NewAcademicRuleV1(), "unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &fakeStore{models: models}
			source := service.RegistryClassifierSource{
				Models:    fixedActiveModel{model: tc.model},
				Registry:  registry,
				Bootstrap: tc.bootstrap,
			}
			base, token := classifierAuthorizedServer(t, "viewer", store, source)
			app := withCorrelationID(base)
			w := request(t, app, token, "/v1/models")
			if w.Code != http.StatusOK {
				t.Fatalf("got %d want 200: %s", w.Code, w.Body.String())
			}
			assertResponseMatchesContract(t, contract, "/v1/models", http.MethodGet, w)

			var body struct {
				Models    []repository.ModelVersion `json:"models"`
				Effective map[string]string         `json:"effective"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatalf("decode models body: %v", err)
			}
			if len(body.Models) != len(models) {
				t.Fatalf("models = %+v, want the unchanged registry list", body.Models)
			}
			if body.Effective["status"] != tc.want {
				t.Fatalf("effective status = %q, want %q (body %v)", body.Effective["status"], tc.want, body.Effective)
			}
		})
	}
}
