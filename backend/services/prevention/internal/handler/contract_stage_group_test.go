package handler

import (
	"net/http"
	"strings"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
)

// V1-P-03 — the four stage groups are published, not just returned. The contract
// is the single source of truth for this API surface, so the projection, its
// mapping and its query parameter are bound to the YAML instead of being
// restated by hand: a service that stops sending the field, or a contract that
// stops documenting the mapping, fails here.

// stageGroupSchema returns the published ActionStageGroup schema or fails.
func stageGroupSchema(t *testing.T, contract *openapi3.T) *openapi3.Schema {
	t.Helper()
	schema := contract.Components.Schemas["ActionStageGroup"]
	if schema == nil || schema.Value == nil {
		t.Fatal("the contract documents no ActionStageGroup schema")
	}
	return schema.Value
}

// referencedSchemaName returns the component a property points at. A property may
// carry its own description beside the reference, and OpenAPI expresses that as a
// one-member allOf, so both shapes are followed instead of assuming the plain
// `$ref` form.
func referencedSchemaName(property *openapi3.SchemaRef) string {
	if property == nil {
		return ""
	}
	if property.Ref != "" {
		return property.Ref
	}
	if len(property.Value.AllOf) == 1 {
		return property.Value.AllOf[0].Ref
	}
	return ""
}

// TestTheContractPublishesTheFourStageGroups pins the closed vocabulary and its
// order, and keeps the 8 → 4 mapping written down next to it: the four values
// alone would not say which status belongs to which group.
func TestTheContractPublishesTheFourStageGroups(t *testing.T) {
	contract := loadContract(t)
	schema := stageGroupSchema(t, contract)

	if schema.Type == nil || !schema.Type.Is("string") {
		t.Errorf("ActionStageGroup is not a string schema: %v", schema.Type)
	}
	want := []string{"candidate", "in_progress", "reviewed", "closed"}
	got := make([]string, 0, len(schema.Enum))
	for _, value := range schema.Enum {
		text, ok := value.(string)
		if !ok {
			t.Fatalf("ActionStageGroup carries a non-string enum member: %v", value)
		}
		got = append(got, text)
	}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("ActionStageGroup enum is %v, want %v", got, want)
	}

	// The mapping is part of the contract: without it a reader has the four names
	// and no rule connecting them to the frozen eight states.
	for _, status := range []string{
		"propuesta", "asignada", "en_curso", "enviada", "bloqueada", "devuelta", "aceptada", "cancelada",
	} {
		if !strings.Contains(strings.ToLower(schema.Description), status) {
			t.Errorf("ActionStageGroup does not document that %q is part of the projection", status)
		}
	}
}

// TestPreventiveActionRequiresTheStageGroup keeps the field on the representation
// itself: every read returns it, so it is required rather than optional.
func TestPreventiveActionRequiresTheStageGroup(t *testing.T) {
	contract := loadContract(t)
	action := contract.Components.Schemas["PreventiveAction"]
	if action == nil || action.Value == nil {
		t.Fatal("the contract documents no PreventiveAction schema")
	}

	required := map[string]bool{}
	for _, name := range action.Value.Required {
		required[name] = true
	}
	if !required["stage_group"] {
		t.Error("PreventiveAction does not require stage_group; every read returns it")
	}
	property := action.Value.Properties["stage_group"]
	if property == nil || property.Value == nil {
		t.Fatal("PreventiveAction does not document stage_group")
	}
	if referencedSchemaName(property) == "" {
		t.Fatal("stage_group does not reference the ActionStageGroup schema, so its vocabulary is restated instead of shared")
	}

	// The eight-state status is untouched: the projection is added beside it.
	if !required["status"] {
		t.Error("PreventiveAction stopped requiring status")
	}
	statusProperty := action.Value.Properties["status"]
	if referencedSchemaName(statusProperty) == "" {
		t.Error("PreventiveAction no longer references the frozen status vocabulary")
	}
}

// TestTheListRouteDocumentsTheStageGroupFilter keeps the parameter documented on
// the operation that serves it, optional like the two filters beside it.
func TestTheListRouteDocumentsTheStageGroupFilter(t *testing.T) {
	contract := loadContract(t)
	item := contract.Paths.Find("/v1/prevention/actions")
	if item == nil || item.Get == nil {
		t.Fatal("the contract documents no GET /v1/prevention/actions")
	}

	var found bool
	for _, parameter := range item.Get.Parameters {
		if parameter.Value == nil || parameter.Value.Name != "stage_group" {
			continue
		}
		found = true
		if parameter.Value.In != "query" {
			t.Errorf("stage_group is documented in %q, want query", parameter.Value.In)
		}
		if parameter.Value.Required {
			t.Error("stage_group is documented as required; an omitted filter narrows nothing")
		}
		if parameter.Value.Schema == nil || parameter.Value.Schema.Ref == "" {
			t.Error("stage_group does not reference the ActionStageGroup schema")
		}
	}
	if !found {
		t.Error("GET /v1/prevention/actions does not document the stage_group filter")
	}
}

// TestTheMalformedQueryRefusalMatchesTheContract binds the refusal to the published
// body: a query string that cannot be percent-decoded is answered with the same
// documented 422 invalid_query an undeclared filter gets, and nothing is read.
func TestTheMalformedQueryRefusalMatchesTheContract(t *testing.T) {
	contract := loadContract(t)
	store := &matrixStore{list: oneActionPerState()}
	h, signer := app(t, store)

	w := requestWith(t, h, http.MethodGet, "/v1/prevention/actions?stage_group=%ZZ",
		token(t, signer, "viewer", "viewer-1"), "")
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("answered %d, want 422: %s", w.Code, w.Body.String())
	}
	if store.listCalls != 0 {
		t.Errorf("the malformed query reached storage %d times", store.listCalls)
	}
	assertResponseMatchesContract(t, contract, "/v1/prevention/actions", http.MethodGet, w)
}

// TestTheListResponseMatchesThePublishedStageGroup validates a real response of
// the route against the YAML: the eight statuses arrive with their projection and
// nothing in the body falls outside the documented schema.
func TestTheListResponseMatchesThePublishedStageGroup(t *testing.T) {
	contract := loadContract(t)
	store := &matrixStore{list: oneActionPerState()}
	h, signer := app(t, store)

	w := requestWith(t, h, http.MethodGet, "/v1/prevention/actions?stage_group=candidate",
		token(t, signer, "viewer", "viewer-1"), "")
	if w.Code != http.StatusOK {
		t.Fatalf("answered %d, want 200: %s", w.Code, w.Body.String())
	}
	assertResponseMatchesContract(t, contract, "/v1/prevention/actions", http.MethodGet, w)
}

// TestTheStageGroupSchemaRefusesAnUndeclaredValue is the negative half: a group
// the contract does not declare must not validate, so the enum is closed for
// readers as well as for the service.
func TestTheStageGroupSchemaRefusesAnUndeclaredValue(t *testing.T) {
	contract := loadContract(t)
	schema := stageGroupSchema(t, contract)

	for _, declared := range []string{"candidate", "in_progress", "reviewed", "closed"} {
		if err := schema.VisitJSON(declared); err != nil {
			t.Errorf("the declared group %q was refused: %v", declared, err)
		}
	}
	for _, undeclared := range []string{"archived", "CANDIDATE", "in-progress", ""} {
		if err := schema.VisitJSON(undeclared); err == nil {
			t.Errorf("the undeclared group %q validated, want the closed enum to refuse it", undeclared)
		}
	}
}
