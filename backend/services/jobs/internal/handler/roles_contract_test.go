package handler

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// PM-15 (D-C) — the jobs service's half of the contract check.
//
// The published document must declare, per operation, which of the three roles
// may call it, and the real handler must answer an analista token exactly as that
// sentence says. Two rows of the ratified matrix meet here and they pull in
// opposite directions:
//
//	POST /v1/jobs and the replay route are TACTICAL (analista+admin);
//	every GET of this service, the activity register included, is a READ.
//
// This module deliberately has no OpenAPI loader dependency, so the document is
// read as text: the path item is located by its own line and the whole item must
// carry the declared policy sentence. No line number is pinned, so inserting a
// line above a route cannot silently pass or fail this check.
const (
	jobsReadPolicy     = "Viewer/analista/admin."
	jobsTacticalPolicy = "Tactical: analista or admin; a viewer is refused 403."
	jobsAdminPolicy    = "Admin only: analista and viewer are refused 403."
)

// jobsContractPath locates the published contract from this package's working dir,
// the same way the risk and prevention services do.
var jobsContractPath = filepath.Join("..", "..", "..", "..", "contracts", "openapi", "firewatch-v1.yaml")

// jobsPathItem returns the raw text of one path item: from its own line to the
// next path item, so every operation declared under it is included.
func jobsPathItem(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(jobsContractPath)
	if err != nil {
		t.Fatalf("read the published contract: %v", err)
	}
	// A checkout with autocrlf rewrites this .yaml to CRLF, and both comparisons
	// below are exact against the line, so the endings are normalised here instead
	// of making the declared policy depend on how the file was checked out. This
	// changes no assertion: the path line and the policy sentence are still matched
	// exactly.
	lines := strings.Split(strings.ReplaceAll(string(raw), "\r\n", "\n"), "\n")
	start := -1
	for index, line := range lines {
		if line == "  "+path+":" {
			start = index
			continue
		}
		if start >= 0 && strings.HasPrefix(line, "  /") && strings.HasSuffix(line, ":") {
			return strings.Join(lines[start:index], "\n")
		}
	}
	if start < 0 {
		t.Fatalf("the contract does not declare %s", path)
	}
	return strings.Join(lines[start:], "\n")
}

// TestJobsContractDeclaresThePolicyOfEveryOperation is the document half.
func TestJobsContractDeclaresThePolicyOfEveryOperation(t *testing.T) {
	for _, tc := range []struct {
		path, item, want string
	}{
		{"/v1/jobs/status", "get", jobsReadPolicy},
		{"/v1/jobs/{id}", "get", jobsReadPolicy},
		{"/v1/audit", "get", jobsReadPolicy},
		{"/v1/jobs", "post", jobsTacticalPolicy},
		{"/v1/jobs/{id}/replay", "post", jobsTacticalPolicy},
	} {
		t.Run(strings.ToUpper(tc.item)+" "+tc.path, func(t *testing.T) {
			item := jobsPathItem(t, tc.path)
			if !strings.Contains(item, "    "+tc.item+":") {
				t.Fatalf("the contract does not declare %s %s:\n%s", tc.item, tc.path, item)
			}
			if !strings.Contains(item, tc.want) {
				t.Fatalf("the description of %s %s does not declare %q:\n%s", tc.item, tc.path, tc.want, item)
			}
		})
	}
}

// TestTheContractVocabularyMatchesTheRolesThisServiceAdmits pins the closed
// vocabulary in the document against the gate this package implements: a role the
// enum does not list must be refused, and every role it lists must be admitted.
// The enum is read as text for the same dependency-free reason as above.
func TestTheContractVocabularyMatchesTheRolesThisServiceAdmits(t *testing.T) {
	raw, err := os.ReadFile(jobsContractPath)
	if err != nil {
		t.Fatalf("read the published contract: %v", err)
	}
	text := string(raw)
	const marker = "    RealmRole:"
	start := strings.Index(text, marker)
	if start < 0 {
		t.Fatal("the contract does not declare the components/schemas/RealmRole vocabulary")
	}
	block := text[start:]
	if end := strings.Index(block, "\n    CycleSourceStatus:"); end > 0 {
		block = block[:end]
	}
	if !strings.Contains(block, "enum: [viewer, analista, admin]") {
		t.Fatalf("RealmRole does not declare the closed vocabulary enum: [viewer, analista, admin]:\n%s", block)
	}

	for _, role := range []string{"viewer", "analista", "admin"} {
		if !holdsDeclaredRole([]string{role}) {
			t.Fatalf("the service refuses %q, which the contract declares", role)
		}
	}
	if holdsDeclaredRole([]string{"operator"}) || holdsDeclaredRole(nil) {
		t.Fatal("the service admits a role the contract does not declare")
	}
}

// TestAnalystMatchesTheJobsPolicyTheContractDeclares is the behaviour half: an
// analista token creates a job and reads the register, while a viewer reaches
// neither the create route nor a write.
func TestAnalystMatchesTheJobsPolicyTheContractDeclares(t *testing.T) {
	t.Run("an analista requests a job", func(t *testing.T) {
		store := &fakeStore{zones: map[string]bool{"valparaiso-demo": true}}
		handler, mint := rolesHandler(t, store)
		r := httptest.NewRequest(http.MethodPost, "/v1/jobs", strings.NewReader(`{"zone_id":"valparaiso-demo"}`))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Idempotency-Key", "2b1c1c1e-0000-4000-8000-000000000001")
		r.Header.Set("Authorization", "Bearer "+mint("analista"))
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != http.StatusAccepted {
			t.Fatalf("an analista request answered %d, want 202: %s", w.Code, w.Body.String())
		}
	})

	t.Run("a viewer still cannot request a job", func(t *testing.T) {
		store := &fakeStore{zones: map[string]bool{"valparaiso-demo": true}}
		handler, mint := rolesHandler(t, store)
		r := httptest.NewRequest(http.MethodPost, "/v1/jobs", strings.NewReader(`{"zone_id":"valparaiso-demo"}`))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Idempotency-Key", "2b1c1c1e-0000-4000-8000-000000000002")
		r.Header.Set("Authorization", "Bearer "+mint("viewer"))
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != http.StatusForbidden {
			t.Fatalf("a viewer request answered %d, want 403: %s", w.Code, w.Body.String())
		}
		if store.calls != 0 {
			t.Fatalf("a refused request reached storage %d times", store.calls)
		}
	})

	t.Run("an analista reads the register", func(t *testing.T) {
		handler, mint := rolesHandler(t, &fakeStore{})
		r := httptest.NewRequest(http.MethodGet, "/v1/audit", nil)
		r.Header.Set("Authorization", "Bearer "+mint("analista"))
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("an analista audit read answered %d, want 200: %s", w.Code, w.Body.String())
		}
	})
}
