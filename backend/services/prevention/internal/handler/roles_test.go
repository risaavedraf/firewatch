package handler

import (
	"fmt"
	"net/http"
	"strings"
	"testing"

	"firewatch.local/prevention/internal/directory"
	"firewatch.local/prevention/internal/repository"
	"firewatch.local/prevention/internal/state"
)

// PM-15 (D-C) — the ratified permission matrix, route by route, for prevention.
//
// The decision cuts the older single admin gate in two:
//
//   - the TACTICAL half («evalúa y gestiona acciones, sin admin») creates,
//     assigns, uploads evidence, registers and adopts observations and advances
//     the workflow: analista and admin, never viewer;
//   - the FINAL half approves or rejects the evidence review and cancels the
//     action: admin alone, and the refusal is decided BEFORE storage is reached.
//
// Every case carries the whole realm_access list because the demo realm hands its
// admin account both viewer and admin, and the identity provider owns that order.

// transitionBody builds the documented transition body.
func transitionBody(to string) string {
	return fmt.Sprintf(`{"to":%q,"note":"paso de prueba"}`, to)
}

// TestTacticalTransitionsAreAnalistaAndFinalOnesAreAdmin pins both halves of the
// transition matrix on the route that exists (`/transitions`; the ratified text
// says `/transition`).
func TestTacticalTransitionsAreAnalistaAndFinalOnesAreAdmin(t *testing.T) {
	for _, tc := range []struct {
		name        string
		roles       []string
		from        state.State
		to          state.State
		want        int
		wantReached bool
	}{
		// Tactical workflow: analista operates it.
		{"analista assigns", []string{"analista"}, state.Propuesta, state.Asignada, http.StatusOK, true},
		{"analista starts", []string{"analista"}, state.Asignada, state.EnCurso, http.StatusOK, true},
		{"analista submits", []string{"analista"}, state.EnCurso, state.Enviada, http.StatusOK, true},
		{"analista blocks", []string{"analista"}, state.EnCurso, state.Bloqueada, http.StatusOK, true},
		{"analista unblocks", []string{"analista"}, state.Bloqueada, state.EnCurso, http.StatusOK, true},
		{"analista returns to work", []string{"analista"}, state.Devuelta, state.EnCurso, http.StatusOK, true},
		{"admin assigns", []string{"viewer", "admin"}, state.Propuesta, state.Asignada, http.StatusOK, true},
		{"viewer before analista keeps the tactical right", []string{"viewer", "analista"}, state.Propuesta, state.Asignada, http.StatusOK, true},
		// Final review and cancellation: admin alone, refused before storage.
		{"analista cannot accept", []string{"analista"}, state.Enviada, state.Aceptada, http.StatusForbidden, false},
		{"analista cannot send back", []string{"analista"}, state.Enviada, state.Devuelta, http.StatusForbidden, false},
		{"analista cannot cancel", []string{"analista"}, state.EnCurso, state.Cancelada, http.StatusForbidden, false},
		{"analista cannot cancel a proposal either", []string{"analista"}, state.Propuesta, state.Cancelada, http.StatusForbidden, false},
		{"viewer cannot accept", []string{"viewer"}, state.Enviada, state.Aceptada, http.StatusForbidden, false},
		{"admin accepts", []string{"admin"}, state.Enviada, state.Aceptada, http.StatusOK, true},
		{"admin sends back", []string{"viewer", "admin"}, state.Enviada, state.Devuelta, http.StatusOK, true},
		{"admin cancels", []string{"admin"}, state.EnCurso, state.Cancelada, http.StatusOK, true},
		// A viewer never operates the workflow at all.
		{"viewer cannot assign", []string{"viewer"}, state.Propuesta, state.Asignada, http.StatusForbidden, false},
		// An undeclared role is refused by the gate itself.
		{"undeclared role cannot assign", []string{"operator"}, state.Propuesta, state.Asignada, http.StatusForbidden, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &matrixStore{status: tc.from, action: repository.Action{ID: fixedActionID, Status: string(tc.from)}, evidenceSufficient: true}
			h, signer := app(t, store)
			w := requestWith(t, h, http.MethodPost,
				"/v1/prevention/actions/"+fixedActionID+"/transitions",
				multiRoleToken(t, signer, tc.roles, "operator-1"),
				transitionBody(string(tc.to)))
			if w.Code != tc.want {
				t.Fatalf("roles %v %s -> %s answered %d, want %d: %s", tc.roles, tc.from, tc.to, w.Code, tc.want, w.Body.String())
			}
			if reached := store.transitions > 0; reached != tc.wantReached {
				t.Fatalf("roles %v %s -> %s reached storage %v, want %v", tc.roles, tc.from, tc.to, reached, tc.wantReached)
			}
			if tc.want == http.StatusForbidden {
				if code := errorBody(t, w)["code"]; code != "forbidden" {
					t.Fatalf("403 code %q, want forbidden", code)
				}
			}
		})
	}
}

// TestCreatingAnActionIsATacticalOperation pins «crear/asignar acciones».
func TestCreatingAnActionIsATacticalOperation(t *testing.T) {
	for _, tc := range []struct {
		name      string
		roles     []string
		want      int
		wantReach bool
	}{
		{"analista creates", []string{"analista"}, http.StatusCreated, true},
		{"admin creates", []string{"viewer", "admin"}, http.StatusCreated, true},
		{"viewer is refused", []string{"viewer"}, http.StatusForbidden, false},
		{"undeclared role is refused", []string{"operator"}, http.StatusForbidden, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &matrixStore{action: repository.Action{ID: fixedActionID}}
			h, signer := app(t, store)
			w := requestWith(t, h, http.MethodPost, "/v1/prevention/actions",
				multiRoleToken(t, signer, tc.roles, "operator-1"), createActionBody)
			if w.Code != tc.want {
				t.Fatalf("roles %v answered %d, want %d: %s", tc.roles, w.Code, tc.want, w.Body.String())
			}
			if reached := store.createCalls > 0; reached != tc.wantReach {
				t.Fatalf("roles %v reached storage %v, want %v", tc.roles, reached, tc.wantReach)
			}
		})
	}
}

// TestEvidenceIsTacticalButTheFinalReviewIsAdmin pins the pair of rows that the
// owner separated on purpose: uploading evidence is tactical, deciding it is the
// one prevention write that stays administrative.
func TestEvidenceIsTacticalButTheFinalReviewIsAdmin(t *testing.T) {
	const evidenceBody = `{"criterion":"Acta de la junta","references":["https://example.org/acta"]}`
	const reviewBody = `{"decision":"suficiente","note":"revisado"}`

	t.Run("uploading evidence", func(t *testing.T) {
		for _, tc := range []struct {
			name      string
			roles     []string
			want      int
			wantReach bool
		}{
			{"analista records evidence", []string{"analista"}, http.StatusCreated, true},
			{"admin records evidence", []string{"admin"}, http.StatusCreated, true},
			{"viewer is refused", []string{"viewer"}, http.StatusForbidden, false},
		} {
			t.Run(tc.name, func(t *testing.T) {
				store := &matrixStore{action: repository.Action{ID: fixedActionID}}
				h, signer := app(t, store)
				w := requestWith(t, h, http.MethodPost,
					"/v1/prevention/actions/"+fixedActionID+"/evidence",
					multiRoleToken(t, signer, tc.roles, "operator-1"), evidenceBody)
				if w.Code != tc.want {
					t.Fatalf("roles %v answered %d, want %d: %s", tc.roles, w.Code, tc.want, w.Body.String())
				}
				if reached := store.addEvidenceCalls > 0; reached != tc.wantReach {
					t.Fatalf("roles %v reached storage %v, want %v", tc.roles, reached, tc.wantReach)
				}
			})
		}
	})

	t.Run("deciding the evidence review", func(t *testing.T) {
		for _, tc := range []struct {
			name      string
			roles     []string
			want      int
			wantReach bool
		}{
			{"admin decides", []string{"viewer", "admin"}, http.StatusCreated, true},
			{"analista is refused before storage", []string{"analista"}, http.StatusForbidden, false},
			{"viewer is refused", []string{"viewer"}, http.StatusForbidden, false},
		} {
			t.Run(tc.name, func(t *testing.T) {
				store := &matrixStore{action: repository.Action{ID: fixedActionID}}
				h, signer := app(t, store)
				w := requestWith(t, h, http.MethodPost,
					"/v1/prevention/actions/"+fixedActionID+"/evidence/7/reviews",
					multiRoleToken(t, signer, tc.roles, "operator-1"), reviewBody)
				if w.Code != tc.want {
					t.Fatalf("roles %v answered %d, want %d: %s", tc.roles, w.Code, tc.want, w.Body.String())
				}
				if reached := store.reviewCalls > 0; reached != tc.wantReach {
					t.Fatalf("roles %v reached storage %v, want %v", tc.roles, reached, tc.wantReach)
				}
			})
		}
	})
}

// TestReassessmentLinkIsTactical pins the remaining prevention write that is not
// a final review nor a cancellation: re-evaluating an action is exactly the
// tactical operation the ratified decision describes, so analista reaches it.
func TestReassessmentLinkIsTactical(t *testing.T) {
	const jobID = "8a1c1c1e-0000-4000-8000-000000000003"
	for _, tc := range []struct {
		name      string
		roles     []string
		want      int
		wantReach bool
	}{
		{"analista links", []string{"analista"}, http.StatusCreated, true},
		{"admin links", []string{"admin"}, http.StatusCreated, true},
		{"viewer is refused", []string{"viewer"}, http.StatusForbidden, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &matrixStore{action: repository.Action{ID: fixedActionID}}
			h, signer := app(t, store)
			w := requestWith(t, h, http.MethodPost,
				"/v1/prevention/actions/"+fixedActionID+"/reassessments",
				multiRoleToken(t, signer, tc.roles, "operator-1"), fmt.Sprintf(`{"job_id":%q}`, jobID))
			if w.Code != tc.want {
				t.Fatalf("roles %v answered %d, want %d: %s", tc.roles, w.Code, tc.want, w.Body.String())
			}
			if reached := store.linkCalls > 0; reached != tc.wantReach {
				t.Fatalf("roles %v reached storage %v, want %v", tc.roles, reached, tc.wantReach)
			}
		})
	}
}

// TestObservationsAreTactical pins «registrar/adoptar observaciones».
func TestObservationsAreTactical(t *testing.T) {
	for _, tc := range []struct {
		name      string
		roles     []string
		want      int
		wantReach bool
	}{
		{"analista registers", []string{"analista"}, http.StatusCreated, true},
		{"admin registers", []string{"admin"}, http.StatusCreated, true},
		{"viewer is refused", []string{"viewer"}, http.StatusForbidden, false},
		{"undeclared role is refused", []string{"operator"}, http.StatusForbidden, false},
	} {
		t.Run("registering as "+tc.name, func(t *testing.T) {
			store := newObservationStore()
			h, signer := app(t, store)
			w := requestWith(t, h, http.MethodPost, "/v1/prevention/observations",
				multiRoleToken(t, signer, tc.roles, "operator-1"), observationBody)
			if w.Code != tc.want {
				t.Fatalf("roles %v answered %d, want %d: %s", tc.roles, w.Code, tc.want, w.Body.String())
			}
			if reached := store.createCalls > 0; reached != tc.wantReach {
				t.Fatalf("roles %v reached storage %v, want %v", tc.roles, reached, tc.wantReach)
			}
		})
	}
}

// TestUserDirectoryIsReadableByEveryDeclaredRole pins the matrix row that names
// «usuarios» among the GET reads granted to all three roles, so an analista can
// resolve who to assign an action to and a viewer can read the same catalogue.
func TestUserDirectoryIsReadableByEveryDeclaredRole(t *testing.T) {
	for _, tc := range []struct {
		name      string
		roles     []string
		want      int
		wantReach bool
	}{
		{"viewer reads", []string{"viewer"}, http.StatusOK, true},
		{"analista reads", []string{"analista"}, http.StatusOK, true},
		{"admin reads", []string{"admin"}, http.StatusOK, true},
		{"undeclared role is refused", []string{"operator"}, http.StatusForbidden, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := &stubDirectory{users: []directory.User{{ID: "u-1", DisplayName: "Demo Analista"}}}
			h, signer := usersApp(t, dir)
			w := requestWith(t, h, http.MethodGet, "/v1/users",
				multiRoleToken(t, signer, tc.roles, "operator-1"), "")
			if w.Code != tc.want {
				t.Fatalf("roles %v answered %d, want %d: %s", tc.roles, w.Code, tc.want, w.Body.String())
			}
			if reached := dir.calls > 0; reached != tc.wantReach {
				t.Fatalf("roles %v reached the directory %v, want %v", tc.roles, reached, tc.wantReach)
			}
		})
	}
}

// TestEveryDeclaredRoleReadsTheActionList pins the plain read row for this
// service, so widening the write gate cannot have narrowed the read gate.
func TestEveryDeclaredRoleReadsTheActionList(t *testing.T) {
	for _, tc := range []struct {
		name  string
		roles []string
		want  int
	}{
		{"viewer reads", []string{"viewer"}, http.StatusOK},
		{"analista reads", []string{"analista"}, http.StatusOK},
		{"admin reads", []string{"admin"}, http.StatusOK},
		{"undeclared role is refused", []string{"operator"}, http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &matrixStore{list: []repository.Action{}}
			h, signer := app(t, store)
			w := requestWith(t, h, http.MethodGet, "/v1/prevention/actions",
				multiRoleToken(t, signer, tc.roles, "operator-1"), "")
			if w.Code != tc.want {
				t.Fatalf("roles %v answered %d, want %d: %s", tc.roles, w.Code, tc.want, w.Body.String())
			}
		})
	}
}

// TestAnalystIsAdmittedByTheServiceGate is the vocabulary check on the read path:
// before PM-15 an analista token was refused 403 by Authorize on every route.
func TestAnalystIsAdmittedByTheServiceGate(t *testing.T) {
	store := &matrixStore{detail: repository.Detail{Action: repository.Action{ID: fixedActionID, Status: string(state.Devuelta)}}}
	h, signer := app(t, store)
	w := requestWith(t, h, http.MethodGet, "/v1/prevention/actions/"+fixedActionID,
		token(t, signer, "analista", "analista-1"), "")
	if w.Code != http.StatusOK {
		t.Fatalf("an analista token answered %d, want 200: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), fixedActionID) {
		t.Fatalf("body does not carry the action: %s", w.Body.String())
	}
}
