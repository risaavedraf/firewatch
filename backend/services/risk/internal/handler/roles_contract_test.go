package handler

import (
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"firewatch.local/risk/internal/cycle"
	"firewatch.local/risk/internal/repository"
	"github.com/getkin/kin-openapi/openapi3"
)

// PM-15 (D-C) — the published contract declares the closed role vocabulary and the
// policy of each operation, and the declaration is checked against the real
// handler instead of being trusted.
//
// Three sentences carry the whole matrix, and every authenticated operation uses
// exactly one of them:
//
//	roleReadPolicy      a GET read granted to the three declared roles;
//	roleTacticalPolicy  analista+admin — «evalúa y gestiona acciones, sin admin»;
//	roleAdminPolicy     admin alone, the configuration and final-review half.
const (
	roleReadPolicy     = "Viewer/analista/admin."
	roleTacticalPolicy = "Tactical: analista or admin; a viewer is refused 403."
	roleAdminPolicy    = "Admin only: analista and viewer are refused 403."
)

// operationDescription reads the description of one documented operation.
func operationDescription(t *testing.T, path, method string) string {
	t.Helper()
	contract := loadContract(t)
	item := contract.Paths.Find(path)
	if item == nil {
		t.Fatalf("the contract does not declare %s", path)
	}
	var operation *openapi3.Operation
	switch method {
	case http.MethodGet:
		operation = item.Get
	case http.MethodPost:
		operation = item.Post
	case http.MethodPut:
		operation = item.Put
	}
	if operation == nil {
		t.Fatalf("the contract does not declare %s %s", method, path)
	}
	return operation.Description
}

// documentedOperation is one method of one documented path, so a walk can name it
// in a failure message.
type documentedOperation struct {
	method    string
	path      string
	operation *openapi3.Operation
}

// documentedOperations enumerates EVERY operation the document declares, in a
// stable order (paths sorted, methods in a fixed order). It walks the path items
// instead of a hand-written list on purpose: a route added tomorrow is covered the
// moment it is documented, and a method this walk forgets to enumerate shows up as
// a count that no longer matches the number of method lines in the document.
func documentedOperations(t *testing.T, contract *openapi3.T) []documentedOperation {
	t.Helper()
	paths := contract.Paths.Map()
	names := make([]string, 0, len(paths))
	for path := range paths {
		names = append(names, path)
	}
	slices.Sort(names)

	var operations []documentedOperation
	for _, path := range names {
		item := paths[path]
		for _, candidate := range []struct {
			method    string
			operation *openapi3.Operation
		}{
			{http.MethodConnect, item.Connect},
			{http.MethodDelete, item.Delete},
			{http.MethodGet, item.Get},
			{http.MethodHead, item.Head},
			{http.MethodOptions, item.Options},
			{http.MethodPatch, item.Patch},
			{http.MethodPost, item.Post},
			{http.MethodPut, item.Put},
			{http.MethodTrace, item.Trace},
		} {
			if candidate.operation == nil {
				continue
			}
			operations = append(operations, documentedOperation{method: candidate.method, path: path, operation: candidate.operation})
		}
	}
	return operations
}

// requiresBearer reports whether an operation is authenticated. The document
// declares a global `security: [bearerAuth]`, so an operation is authenticated
// unless it overrides `security` to say otherwise; that override is the only way
// a route escapes the rule this test enforces.
func requiresBearer(contract *openapi3.T, operation *openapi3.Operation) bool {
	requirements := contract.Security
	if operation.Security != nil {
		requirements = *operation.Security
	}
	for _, requirement := range requirements {
		if _, ok := requirement["bearerAuth"]; ok {
			return true
		}
	}
	return false
}

// TestEveryAuthenticatedOperationDeclaresItsRolePolicy closes the gap a table of
// chosen routes cannot: it walks the whole document, so EVERY authenticated
// operation has to name the policy of the three declared roles. A route that is
// documented without saying who may call it fails here instead of shipping an
// undocumented permission.
//
// Exactly one of the three sentences must appear. Zero means the operation is
// silent about its role; two would mean it promises two contradictory policies.
func TestEveryAuthenticatedOperationDeclaresItsRolePolicy(t *testing.T) {
	contract := loadContract(t)
	operations := documentedOperations(t, contract)

	// A floor, not an exact count: the document may grow, but a walk that stops
	// enumerating a method would shrink this number and has to be noticed.
	const documentedAtLeast = 39
	if len(operations) < documentedAtLeast {
		t.Fatalf("the walk found %d operations, fewer than the %d the document declares: a method is missing from the enumeration", len(operations), documentedAtLeast)
	}

	policies := []string{roleReadPolicy, roleTacticalPolicy, roleAdminPolicy}
	authenticated := 0
	unauthenticated := make([]string, 0, 1)
	for _, documented := range operations {
		label := documented.method + " " + documented.path
		if !requiresBearer(contract, documented.operation) {
			unauthenticated = append(unauthenticated, label)
			continue
		}
		authenticated++

		declared := make([]string, 0, 1)
		for _, policy := range policies {
			if strings.Contains(documented.operation.Description, policy) {
				declared = append(declared, policy)
			}
		}
		switch len(declared) {
		case 0:
			t.Errorf("%s is authenticated but declares no role policy; one of %q, %q or %q must appear in its description", label, roleReadPolicy, roleTacticalPolicy, roleAdminPolicy)
		case 1:
			// Exactly the documented answer.
		default:
			t.Errorf("%s declares %d contradictory role policies %v; an operation has one policy", label, len(declared), declared)
		}
	}

	// This deployment has no public route in the contract: the health probes live
	// outside it. If that ever changes, the override has to be visible here rather
	// than silently exempting a route from the matrix.
	if len(unauthenticated) > 0 {
		t.Logf("operations that opt out of bearerAuth: %v", unauthenticated)
	}
	if authenticated == 0 {
		t.Fatal("no authenticated operation was found: the security requirement is not being read")
	}
}

// TestContractDeclaresTheClosedRoleVocabulary pins the enum the rest of the matrix
// is built on: the three roles of the ratified decision, no fourth role, and no
// room for a value the services would refuse.
func TestContractDeclaresTheClosedRoleVocabulary(t *testing.T) {
	contract := loadContract(t)
	schema, ok := contract.Components.Schemas["RealmRole"]
	if !ok {
		t.Fatal("the contract does not declare the components/schemas/RealmRole vocabulary")
	}
	raw := schema.Value.Enum
	if len(raw) == 0 {
		t.Fatal("RealmRole has no enum: the role vocabulary would be open-ended")
	}
	declared := make([]string, 0, len(raw))
	for _, value := range raw {
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

// TestContractDeclaresThePolicyOfEveryRiskOperation is the document half of S4: a
// reader of the contract learns, per operation, which of the three roles may call
// it. A stale sentence fails here instead of reaching a client.
func TestContractDeclaresThePolicyOfEveryRiskOperation(t *testing.T) {
	for _, tc := range []struct {
		method, path, want string
	}{
		{http.MethodGet, "/v1/risk/status", roleReadPolicy},
		{http.MethodGet, "/v1/risk/latest", roleReadPolicy},
		{http.MethodGet, "/v1/risk/history", roleReadPolicy},
		{http.MethodGet, "/v1/risk/history.csv", roleReadPolicy},
		{http.MethodGet, "/v1/risk/batches", roleReadPolicy},
		{http.MethodGet, "/v1/risk/alerts", roleReadPolicy},
		{http.MethodGet, "/v1/risk/sources", roleReadPolicy},
		{http.MethodGet, "/v1/models", roleReadPolicy},
		// The gateway's own aggregate read, declared in this same document.
		{http.MethodGet, "/v1/status", roleReadPolicy},
		// The counterfactual simulation is a POST that writes no row, so it is a read
		// of the matrix and stays available to the three declared roles.
		{http.MethodPost, "/v1/risk/simulate", roleReadPolicy},
		{http.MethodGet, "/v1/risk/alerts/{id}/state", roleReadPolicy},
		// A personal mark is a per-caller preference, not an administrative action.
		{http.MethodPut, "/v1/risk/alerts/{id}/state", roleReadPolicy},
		// Triggering the pipeline is tactical: analista and admin, never viewer.
		{http.MethodPost, "/v1/risk/cycle/run", roleTacticalPolicy},
		// Activating a model version is configuration, and stays administrative.
		{http.MethodPost, "/v1/models/{version}/activate", roleAdminPolicy},
	} {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			description := operationDescription(t, tc.path, tc.method)
			if !strings.Contains(description, tc.want) {
				t.Fatalf("the description of %s %s does not declare %q:\n%s", tc.method, tc.path, tc.want, description)
			}
		})
	}
}

// TestAnalystRoleMatchesThePolicyTheContractDeclares is the behaviour half of S4:
// the real handler is called with an analista token and the answer must agree with
// the sentence the contract publishes. A document that promised more than the
// server does — or less — fails here.
func TestAnalystRoleMatchesThePolicyTheContractDeclares(t *testing.T) {
	started := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)

	t.Run("a read is granted", func(t *testing.T) {
		store := &fakeStore{
			zones:   map[string]bool{"valparaiso-demo": true},
			batches: []repository.Batch{{Demo: true, RiskLevel: "desconocido", DataStatus: "current"}},
		}
		handler, token := authorizedServer(t, "analista", store)
		w := serve(t, handler, http.MethodGet, "/v1/risk/latest?zone_id=valparaiso-demo", token)
		if w.Code != http.StatusOK {
			t.Fatalf("an analista read answered %d, want 200: %s", w.Code, w.Body.String())
		}
	})

	t.Run("triggering the pipeline is granted", func(t *testing.T) {
		runner := &fakeCycle{result: cycle.RunResult{
			SourceID: "fixture-sample", StartedAt: started, FinishedAt: started, Complete: true,
			Zones: []cycle.ZoneResult{{ZoneID: "valparaiso-demo", Published: true}},
		}}
		handler, token := authorizedServerWith(t, "analista", &fakeStore{}, runner)
		w := serve(t, handler, http.MethodPost, "/v1/risk/cycle/run", token)
		if w.Code != http.StatusOK || runner.runs != 1 {
			t.Fatalf("an analista trigger answered %d after %d runs, want 200 after 1", w.Code, runner.runs)
		}
	})

	t.Run("a personal mark is granted", func(t *testing.T) {
		handler, token := authorizedServer(t, "analista", &fakeStore{})
		w := alertStateCall(t, handler, token, http.MethodPut, alertStatePath, "application/json", `{"state":"read"}`)
		if w.Code != http.StatusOK {
			t.Fatalf("an analista mark answered %d, want 200: %s", w.Code, w.Body.String())
		}
	})

	t.Run("model activation stays administrative", func(t *testing.T) {
		handler, token := authorizedServer(t, "analista", &fakeStore{})
		w := serve(t, handler, http.MethodPost, "/v1/models/firewatch-rule-v2/activate", token)
		if w.Code != http.StatusForbidden {
			t.Fatalf("an analista activation answered %d, want 403: %s", w.Code, w.Body.String())
		}
	})
}

// serve issues one bearer-authenticated request against the real handler.
func serve(t *testing.T, handler http.Handler, method, target, token string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, target, nil)
	r.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}
