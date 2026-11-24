package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"firewatch.local/prevention/internal/repository"
)

// The adoption operation is exercised through the same authenticated chain as
// every other observation route; these tests cover the guarded input, the error
// mapping, the additive field on the reads PM-09 already serves, and the wiring
// guard. The link rule itself (idempotent repeat, conflict, cancellation) is the
// repository's single decision and is proved with the real database.

// TestAdoptObservationRefusesInvalidInput covers the guarded input of the
// operation: a malformed path id is the documented 400, a body that is not
// exactly one JSON document with one UUID is the documented 422, a non-JSON body
// is the documented 415, and none of them reaches storage.
func TestAdoptObservationRefusesInvalidInput(t *testing.T) {
	path := "/v1/prevention/observations/" + fixedObservationID + "/adoption"
	longBody := `{"action_id":"` + fixedAdoptionActionID + `","note":"` + strings.Repeat("a", maxAdoptionBody) + `"}`
	for _, tc := range []struct {
		name, target, body, contentType string
		want                            int
		wantCode                        string
	}{
		{name: "path is not a uuid", target: "/v1/prevention/observations/not-a-uuid/adoption", body: adoptionBody, want: http.StatusBadRequest, wantCode: "invalid_observation_id"},
		{name: "path is the nil uuid", target: "/v1/prevention/observations/00000000-0000-0000-0000-000000000000/adoption", body: adoptionBody, want: http.StatusBadRequest, wantCode: "invalid_observation_id"},
		{name: "missing action", target: path, body: `{}`, want: http.StatusUnprocessableEntity, wantCode: "invalid_adoption_request"},
		{name: "blank action", target: path, body: `{"action_id":"   "}`, want: http.StatusUnprocessableEntity, wantCode: "invalid_adoption_request"},
		{name: "action is not a uuid", target: path, body: `{"action_id":"cortafuegos"}`, want: http.StatusUnprocessableEntity, wantCode: "invalid_adoption_request"},
		{name: "action is the nil uuid", target: path, body: `{"action_id":"00000000-0000-0000-0000-000000000000"}`, want: http.StatusUnprocessableEntity, wantCode: "invalid_adoption_request"},
		{name: "status is not accepted", target: path, body: `{"action_id":"` + fixedAdoptionActionID + `","status":"asignada"}`, want: http.StatusUnprocessableEntity, wantCode: "invalid_adoption_request"},
		{name: "assignee is not accepted", target: path, body: `{"action_id":"` + fixedAdoptionActionID + `","assignee_id":"u1"}`, want: http.StatusUnprocessableEntity, wantCode: "invalid_adoption_request"},
		{name: "confirmer is not accepted", target: path, body: `{"action_id":"` + fixedAdoptionActionID + `","confirmed_by":"someone-else"}`, want: http.StatusUnprocessableEntity, wantCode: "invalid_adoption_request"},
		{name: "over-long body", target: path, body: longBody, want: http.StatusUnprocessableEntity, wantCode: "invalid_adoption_request"},
		{name: "trailing document", target: path, body: adoptionBody + adoptionBody, want: http.StatusUnprocessableEntity, wantCode: "invalid_adoption_request"},
		{name: "not json", target: path, body: `action_id=1`, want: http.StatusUnprocessableEntity, wantCode: "invalid_adoption_request"},
		{name: "wrong content type", target: path, body: adoptionBody, contentType: "text/plain", want: http.StatusUnsupportedMediaType, wantCode: "json_required"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := newAdoptionStore()
			h, signer := app(t, store)
			contentType := tc.contentType
			if contentType == "" {
				contentType = "application/json"
			}
			w := requestWithContentType(t, h, http.MethodPost, tc.target,
				token(t, signer, "admin", "admin-1"), tc.body, contentType)
			if w.Code != tc.want {
				t.Fatalf("answered %d, want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if code := errorBody(t, w)["code"]; code != tc.wantCode {
				t.Errorf("code %q, want %q", code, tc.wantCode)
			}
			if store.adoptionCalls != 0 {
				t.Fatalf("an invalid adoption reached storage %d times", store.adoptionCalls)
			}
		})
	}
}

// TestAdoptObservationMapsTheDocumentedRefusals keeps the four distinguishable
// outcomes apart: a missing observation is the 404 of the addressed resource, a
// reference to an action that does not exist is the 422 the PM-09 zone refusal
// uses for a body reference, a cancelled action and an already-linked observation
// are 409 conflicts because the record exists but the rule refuses, and an
// unavailable store is a 503 that claims none of the above.
func TestAdoptObservationMapsTheDocumentedRefusals(t *testing.T) {
	for _, tc := range []struct {
		name     string
		err      error
		want     int
		wantCode string
	}{
		{name: "unknown observation", err: repository.ErrObservationNotFound, want: http.StatusNotFound, wantCode: "observation_not_found"},
		{name: "unknown action", err: repository.ErrAdoptionActionNotFound, want: http.StatusUnprocessableEntity, wantCode: "action_not_found"},
		{name: "cancelled action", err: repository.ErrAdoptionActionCancelled, want: http.StatusConflict, wantCode: "action_cancelled"},
		{name: "already adopted", err: repository.ErrObservationAlreadyAdopted, want: http.StatusConflict, wantCode: "observation_already_adopted"},
		{name: "storage unavailable", err: errors.New("connection refused"), want: http.StatusServiceUnavailable, wantCode: "storage_unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := newAdoptionStore()
			store.adoptionErr = tc.err
			h, signer := app(t, store)
			w := requestWith(t, h, http.MethodPost, "/v1/prevention/observations/"+fixedObservationID+"/adoption",
				token(t, signer, "admin", "admin-1"), adoptionBody)
			if w.Code != tc.want {
				t.Fatalf("answered %d, want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if code := errorBody(t, w)["code"]; code != tc.wantCode {
				t.Errorf("code %q, want %q", code, tc.wantCode)
			}
		})
	}
}

// TestObservationListReportsTheDurableAdoption is S4's read half: the list that
// already serves the field observations also carries the durable association, so
// the page can render it without a second call. An observation with no adoption
// reports null rather than a fabricated action.
func TestObservationListReportsTheDurableAdoption(t *testing.T) {
	unlinkedID := "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
	adopted := fixedAdoptionActionID
	store := newObservationStore()
	linked := store.created
	linked.AdoptedActionID = &adopted
	unlinked := store.created
	unlinked.ID = unlinkedID
	store.list = []repository.Observation{linked, unlinked}

	h, signer := app(t, store)
	w := requestWith(t, h, http.MethodGet, "/v1/prevention/observations",
		token(t, signer, "viewer", "viewer-1"), "")
	if w.Code != http.StatusOK {
		t.Fatalf("answered %d, want 200: %s", w.Code, w.Body.String())
	}
	var listed []map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &listed); err != nil {
		t.Fatalf("body is not a list: %v", err)
	}
	if len(listed) != 2 {
		t.Fatalf("listed %d observations, want 2", len(listed))
	}
	if got := listed[0]["adopted_action_id"]; got != fixedAdoptionActionID {
		t.Errorf("adopted_action_id is %v, want %q", got, fixedAdoptionActionID)
	}
	value, present := listed[1]["adopted_action_id"]
	if !present {
		t.Fatal("an unlinked observation omits adopted_action_id; the optional field must be reported as null")
	}
	if value != nil {
		t.Errorf("an unlinked observation reports adopted_action_id %v, want null", value)
	}
	// The confirmation actor and instant stay off the wire: the observation
	// response is the PM-09 object plus one association, and provenance is durable
	// server-side data, not a field every reader needs.
	for _, key := range []string{"confirmed_by", "confirmed_at"} {
		if _, present := listed[0][key]; present {
			t.Errorf("the observation body exposes %q, which is not part of the documented response", key)
		}
	}
}

// TestAdoptionResponseKeepsTheDocumentedObservationShape validates the 200 body of
// the adoption operation against the published PreventiveObservation schema, so
// the additive association cannot quietly change the observation the frontend
// already renders. The operation and the new optional property are documented by
// the contract owner; this test proves the body those documents must describe.
func TestAdoptionResponseKeepsTheDocumentedObservationShape(t *testing.T) {
	contract := loadContract(t)
	schema := contract.Components.Schemas["PreventiveObservation"]
	if schema == nil || schema.Value == nil {
		t.Fatal("the contract documents no PreventiveObservation schema")
	}
	store := newAdoptionStore()
	store.adoption.ConfirmedAt = time.Date(2026, 11, 21, 9, 0, 0, 0, time.UTC)
	h, signer := app(t, store)
	w := requestWith(t, h, http.MethodPost, "/v1/prevention/observations/"+fixedObservationID+"/adoption",
		token(t, signer, "admin", "admin-1"), adoptionBody)
	if w.Code != http.StatusOK {
		t.Fatalf("answered %d, want 200: %s", w.Code, w.Body.String())
	}
	var body any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("body is not JSON: %v", err)
	}
	if err := schema.Value.VisitJSON(body); err != nil {
		t.Fatalf("the adoption answer is not a documented observation: %v\nbody: %s", err, w.Body.String())
	}
	documented, _ := body.(map[string]any)
	if documented["adopted_action_id"] != fixedAdoptionActionID {
		t.Errorf("adopted_action_id is %v, want the linked action", documented["adopted_action_id"])
	}
}

// TestAdoptionRouteFailsClosedWithoutObservationPersistence extends the wiring
// guard to the new operation: a store without observation persistence answers 503
// rather than 404, which would read as "this service has no adoption route".
func TestAdoptionRouteFailsClosedWithoutObservationPersistence(t *testing.T) {
	h, signer := app(t, &matrixStore{})
	w := requestWith(t, h, http.MethodPost, "/v1/prevention/observations/"+fixedObservationID+"/adoption",
		token(t, signer, "admin", "admin-1"), adoptionBody)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("answered %d, want 503: %s", w.Code, w.Body.String())
	}
	if code := errorBody(t, w)["code"]; code != "storage_unavailable" {
		t.Errorf("code %q, want storage_unavailable", code)
	}
}
