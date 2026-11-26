package handler

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"firewatch.local/risk/internal/classify"
	"firewatch.local/risk/internal/repository"
)

// TestSimulationDocumentMatchesTheContract is the S2 half of the route: the
// published document declares the operation, its request body and every status the
// handler can answer, and each real response validates against it. It also checks
// the request schema itself, so the accepted document and the documented document
// cannot drift: a request the handler accepts must validate, and a vocabulary the
// handler refuses must not validate.
func TestSimulationDocumentMatchesTheContract(t *testing.T) {
	contract := loadContract(t)
	target := "/v1/risk/simulate"
	item := contract.Paths.Find(target)
	if item == nil || item.Post == nil {
		t.Fatalf("contract documents no POST %s", target)
	}
	if item.Post.OperationID != "simulateRiskBatch" {
		t.Fatalf("operationId = %q, want simulateRiskBatch", item.Post.OperationID)
	}
	// Every status the handler can answer must be documented, so a caller never
	// meets an answer the contract does not describe.
	for _, status := range []int{http.StatusOK, http.StatusBadRequest, http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound, http.StatusUnsupportedMediaType, http.StatusUnprocessableEntity, http.StatusTooManyRequests, http.StatusBadGateway, http.StatusServiceUnavailable} {
		if item.Post.Responses.Status(status) == nil {
			t.Fatalf("contract documents no %d response for POST %s", status, target)
		}
	}

	schema := contract.Components.Schemas["SimulationRequest"]
	if schema == nil || schema.Value == nil {
		t.Fatal("contract documents no SimulationRequest schema")
	}
	for _, tc := range []struct {
		name      string
		document  string
		wantValid bool
	}{
		{
			name:      "a number or an explicit null per canonical variable",
			document:  `{"zone_id":"05101","variables":{"temperatura":40,"humedad_relativa":null,"viento":60,"cobertura_vegetal":80,"incendios_historicos":5}}`,
			wantValid: true,
		},
		{
			name:      "a single substituted variable",
			document:  `{"zone_id":"05101","variables":{"viento":12}}`,
			wantValid: true,
		},
		{
			name:      "a variable outside the canonical vocabulary",
			document:  `{"zone_id":"05101","variables":{"presion":1}}`,
			wantValid: false,
		},
		{
			name:      "a quoted observation",
			document:  `{"zone_id":"05101","variables":{"temperatura":"40"}}`,
			wantValid: false,
		},
		{
			name:      "an empty substitution",
			document:  `{"zone_id":"05101","variables":{}}`,
			wantValid: false,
		},
		{
			name:      "an unknown member",
			document:  `{"zone_id":"05101","variables":{"temperatura":40},"forecast":true}`,
			wantValid: false,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var document any
			if err := json.Unmarshal([]byte(tc.document), &document); err != nil {
				t.Fatalf("decode document: %v", err)
			}
			err := schema.Value.VisitJSON(document)
			if tc.wantValid && err != nil {
				t.Fatalf("the contract refuses a document the handler accepts: %v", err)
			}
			if !tc.wantValid && err == nil {
				t.Fatalf("the contract accepts a document the handler refuses: %s", tc.document)
			}
		})
	}

	stored := storedSimulationBatch(t, stableRule[classify.AcademicRuleV1ID])
	for _, tc := range []struct {
		name        string
		store       Repository
		body        string
		contentType string
		want        int
	}{
		{
			name:  "substituted evaluation",
			store: &fakeStore{zones: map[string]bool{simulationZone: true}, batches: []repository.Batch{stored}},
			body:  `{"zone_id":"` + simulationZone + `","variables":` + simulationHighVariables + `}`,
			want:  http.StatusOK,
		},
		{
			name:  "malformed document",
			store: &fakeStore{zones: map[string]bool{simulationZone: true}, batches: []repository.Batch{stored}},
			body:  `{"zone_id":"` + simulationZone + `","variables":{"presion":1}}`,
			want:  http.StatusBadRequest,
		},
		{
			name:  "zone outside the catalogue",
			store: &fakeStore{zones: map[string]bool{simulationZone: true}, batches: []repository.Batch{stored}},
			body:  `{"zone_id":"99999","variables":{"temperatura":40}}`,
			want:  http.StatusBadRequest,
		},
		{
			name:  "nothing published",
			store: &fakeStore{zones: map[string]bool{simulationZone: true}},
			body:  `{"zone_id":"` + simulationZone + `","variables":{"temperatura":40}}`,
			want:  http.StatusNotFound,
		},
		{
			name:  "unreproducible rule",
			store: &fakeStore{zones: map[string]bool{simulationZone: true}, batches: []repository.Batch{withoutSimulationPolicy(stored)}},
			body:  `{"zone_id":"` + simulationZone + `","variables":{"temperatura":40}}`,
			want:  http.StatusUnprocessableEntity,
		},
		{
			name:  "storage unavailable",
			store: listFailingStore{&fakeStore{zones: map[string]bool{simulationZone: true}}},
			body:  `{"zone_id":"` + simulationZone + `","variables":{"temperatura":40}}`,
			want:  http.StatusServiceUnavailable,
		},
		{
			name:        "not declared as JSON",
			store:       &fakeStore{zones: map[string]bool{simulationZone: true}, batches: []repository.Batch{stored}},
			body:        `{"zone_id":"` + simulationZone + `","variables":{"temperatura":40}}`,
			contentType: "text/plain",
			want:        http.StatusUnsupportedMediaType,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			handler, token := authorizedServer(t, "viewer", tc.store)
			// postSimulationAs always declares an explicit media type, so the
			// documented 415 answer is exercised through the real handler.
			media := "application/json"
			if tc.contentType != "" {
				media = tc.contentType
			}
			w := postSimulationAs(t, handler, token, tc.body, media)
			if w.Code != tc.want {
				t.Fatalf("got %d want %d: %s", w.Code, tc.want, w.Body.String())
			}
			assertResponseMatchesContract(t, contract, target, http.MethodPost, w)
		})
	}
}

// withoutSimulationPolicy returns the batch with its recorded policy removed, the
// one shape of a legacy row this route must refuse instead of falling back.
func withoutSimulationPolicy(batch repository.Batch) repository.Batch {
	batch.Policy = nil
	return batch
}

// TestSimulationOpenAPIDocumentsNoForecast keeps the words out of the document as
// well as out of the body: a description that promised a prediction would be a
// contract claim even if the handler never made one.
func TestSimulationOpenAPIDocumentsNoForecast(t *testing.T) {
	contract := loadContract(t)
	operation := contract.Paths.Find("/v1/risk/simulate").Post
	described := strings.ToLower(operation.Description)
	for _, claim := range []string{"forecast:", "probabilidad de", "prediction:"} {
		if strings.Contains(described, claim) {
			t.Fatalf("the operation description claims %q", claim)
		}
	}
	for _, required := range []string{"not a forecast", "not a probability", "unsupported_original_rule", "not_evaluated"} {
		if !strings.Contains(described, required) {
			t.Fatalf("the operation description must state %q so a reader cannot mistake the result", required)
		}
	}
}
