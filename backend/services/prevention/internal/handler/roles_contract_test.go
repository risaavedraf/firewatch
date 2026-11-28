package handler

import (
	"net/http"
	"slices"
	"strings"
	"testing"

	"firewatch.local/prevention/internal/repository"
	"firewatch.local/prevention/internal/state"
	"github.com/getkin/kin-openapi/openapi3"
)

// PM-15 (D-C) — prevention's half of the contract check.
//
// This is the service where the ratified decision is not a single gate but two,
// so the document has to say which is which:
//
//	roleReadPolicy      every GET of this service, and the user directory;
//	roleTacticalPolicy  creating and assigning, evidence upload, observations,
//	                    the reassessment link and the workflow transitions;
//	roleAdminPolicy     the final evidence review alone.
const (
	roleReadPolicy     = "Viewer/analista/admin."
	roleTacticalPolicy = "Tactical: analista or admin; a viewer is refused 403."
	roleAdminPolicy    = "Admin only: analista and viewer are refused 403."
	// roleTransitionPolicy is the split sentence the transition route carries: the
	// tactical half plus the explicit exception for the final one.
	roleTransitionPolicy = "Except for the final half"
)

// preventionOperationDescription reads the description of one documented
// operation from the contract this package already loads for its other tests.
func preventionOperationDescription(t *testing.T, path, method string) string {
	t.Helper()
	item := loadContract(t).Paths.Find(path)
	if item == nil {
		t.Fatalf("the contract does not declare %s", path)
	}
	var operation *openapi3.Operation
	switch method {
	case http.MethodGet:
		operation = item.Get
	case http.MethodPost:
		operation = item.Post
	}
	if operation == nil {
		t.Fatalf("the contract does not declare %s %s", method, path)
	}
	return operation.Description
}

// TestPreventionContractDeclaresTheClosedRoleVocabulary pins the enum.
func TestPreventionContractDeclaresTheClosedRoleVocabulary(t *testing.T) {
	schema, ok := loadContract(t).Components.Schemas["RealmRole"]
	if !ok {
		t.Fatal("the contract does not declare the components/schemas/RealmRole vocabulary")
	}
	declared := make([]string, 0, len(schema.Value.Enum))
	for _, value := range schema.Value.Enum {
		name, ok := value.(string)
		if !ok {
			t.Fatalf("RealmRole carries a non-string member %v", value)
		}
		declared = append(declared, name)
	}
	slices.Sort(declared)
	if want := []string{"admin", "analista", "viewer"}; !slices.Equal(declared, want) {
		t.Fatalf("RealmRole = %v, want %v", declared, want)
	}
}

// TestPreventionContractDeclaresThePolicyOfEveryOperation is the document half.
func TestPreventionContractDeclaresThePolicyOfEveryOperation(t *testing.T) {
	for _, tc := range []struct {
		method, path, want string
	}{
		{http.MethodGet, "/v1/prevention/actions", roleReadPolicy},
		{http.MethodGet, "/v1/prevention/actions/{id}", roleReadPolicy},
		{http.MethodGet, "/v1/prevention/observations", roleReadPolicy},
		{http.MethodGet, "/v1/prevention/observations/zones", roleReadPolicy},
		{http.MethodGet, "/v1/users", roleReadPolicy},
		{http.MethodPost, "/v1/prevention/actions", roleTacticalPolicy},
		{http.MethodPost, "/v1/prevention/actions/{id}/evidence", roleTacticalPolicy},
		{http.MethodPost, "/v1/prevention/actions/{id}/reassessments", roleTacticalPolicy},
		{http.MethodPost, "/v1/prevention/observations", roleTacticalPolicy},
		{http.MethodPost, "/v1/prevention/observations/{id}/adoption", roleTacticalPolicy},
		{http.MethodPost, "/v1/prevention/actions/{id}/transitions", roleTacticalPolicy},
		{http.MethodPost, "/v1/prevention/actions/{id}/evidence/{evidence_id}/reviews", roleAdminPolicy},
	} {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			description := preventionOperationDescription(t, tc.path, tc.method)
			if !strings.Contains(description, tc.want) {
				t.Fatalf("the description of %s %s does not declare %q:\n%s", tc.method, tc.path, tc.want, description)
			}
			if tc.path == "/v1/prevention/actions/{id}/transitions" && !strings.Contains(description, roleTransitionPolicy) {
				t.Fatalf("the transition route does not declare its administrative exception %q:\n%s", roleTransitionPolicy, description)
			}
		})
	}
}

// TestAnalystMatchesThePolicyTheContractDeclares is the behaviour half: the same
// handler the contract describes is called with an analista token and must answer
// 2xx where the matrix says Sí and 403 where it says the decision is admin's.
func TestAnalystMatchesThePolicyTheContractDeclares(t *testing.T) {
	const evidenceBody = `{"criterion":"Acta de la junta","references":["https://example.org/acta"]}`

	t.Run("creating an action is granted", func(t *testing.T) {
		store := &matrixStore{action: repository.Action{ID: fixedActionID}}
		h, signer := app(t, store)
		w := requestWith(t, h, http.MethodPost, "/v1/prevention/actions",
			token(t, signer, "analista", "analista-1"), createActionBody)
		if w.Code != http.StatusCreated || store.createCalls != 1 {
			t.Fatalf("an analista create answered %d after %d store calls, want 201 after 1", w.Code, store.createCalls)
		}
	})

	t.Run("uploading evidence is granted", func(t *testing.T) {
		store := &matrixStore{action: repository.Action{ID: fixedActionID}}
		h, signer := app(t, store)
		w := requestWith(t, h, http.MethodPost, "/v1/prevention/actions/"+fixedActionID+"/evidence",
			token(t, signer, "analista", "analista-1"), evidenceBody)
		if w.Code != http.StatusCreated || store.addEvidenceCalls != 1 {
			t.Fatalf("an analista evidence upload answered %d after %d store calls, want 201 after 1", w.Code, store.addEvidenceCalls)
		}
	})

	t.Run("the final evidence review is refused", func(t *testing.T) {
		store := &matrixStore{action: repository.Action{ID: fixedActionID}}
		h, signer := app(t, store)
		w := requestWith(t, h, http.MethodPost, "/v1/prevention/actions/"+fixedActionID+"/evidence/7/reviews",
			token(t, signer, "analista", "analista-1"), `{"decision":"suficiente"}`)
		if w.Code != http.StatusForbidden {
			t.Fatalf("an analista final review answered %d, want 403: %s", w.Code, w.Body.String())
		}
		if store.reviewCalls != 0 {
			t.Fatalf("an analista final review reached storage %d times", store.reviewCalls)
		}
	})

	t.Run("accepting the action is refused", func(t *testing.T) {
		store := &matrixStore{status: state.Enviada, action: repository.Action{ID: fixedActionID, Status: string(state.Enviada)}, evidenceSufficient: true}
		h, signer := app(t, store)
		w := requestWith(t, h, http.MethodPost, "/v1/prevention/actions/"+fixedActionID+"/transitions",
			token(t, signer, "analista", "analista-1"), transitionBody(string(state.Aceptada)))
		if w.Code != http.StatusForbidden {
			t.Fatalf("an analista accept answered %d, want 403: %s", w.Code, w.Body.String())
		}
		if store.transitions != 0 {
			t.Fatalf("an analista accept reached storage %d times", store.transitions)
		}
	})

	t.Run("advancing the workflow is granted", func(t *testing.T) {
		store := &matrixStore{status: state.Propuesta, action: repository.Action{ID: fixedActionID, Status: string(state.Propuesta)}}
		h, signer := app(t, store)
		w := requestWith(t, h, http.MethodPost, "/v1/prevention/actions/"+fixedActionID+"/transitions",
			token(t, signer, "analista", "analista-1"), transitionBody(string(state.Asignada)))
		if w.Code != http.StatusOK || store.transitions != 1 {
			t.Fatalf("an analista assign answered %d after %d store calls, want 200 after 1", w.Code, store.transitions)
		}
	})
}
