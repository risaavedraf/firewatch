package handler

import (
	"encoding/json"
	"net/http"
	"testing"

	"firewatch.local/prevention/internal/repository"
	"firewatch.local/prevention/internal/state"
)

// V1-P-03 — the four stage groups are a PROJECTION of the eight frozen states,
// fixed by the owner's ratified decision and published in the contract. These
// tests bind the wire to that decision: every action the service returns carries
// the group its status projects onto, `?stage_group=` narrows the read, and a
// value outside the vocabulary is malformed input that touches no storage.
//
// Nothing here renames a state, adds a transition or reads a new column: the
// eight states and the frozen machine are exactly as they were.

// decidedStageOf is the ratified 8 → 4 table, transcribed literally. It is
// restated here on purpose: if the service ever changes a group, the wire
// documents a different contract than the one that was approved.
var decidedStageOf = map[state.State]string{
	state.Propuesta: "candidate",
	state.Asignada:  "candidate",
	state.EnCurso:   "in_progress",
	state.Enviada:   "in_progress",
	state.Bloqueada: "reviewed",
	state.Devuelta:  "reviewed",
	state.Aceptada:  "closed",
	state.Cancelada: "closed",
}

// oneActionPerState is a store fixture holding every frozen status exactly once,
// so a list read exercises all four groups in one response.
func oneActionPerState() []repository.Action {
	statuses := state.States()
	actions := make([]repository.Action, 0, len(statuses))
	for _, status := range statuses {
		actions = append(actions, repository.Action{
			ID:            fixedActionID,
			CommunityCode: "valparaiso",
			Title:         "Acción " + string(status),
			Status:        string(status),
			CreatedBy:     "operator-1",
		})
	}
	return actions
}

// stageGroupOfResponse reads the stage_group of every item of a list response.
func stageGroupOfResponse(t *testing.T, body []byte) []string {
	t.Helper()
	var items []struct {
		Status     string `json:"status"`
		StageGroup string `json:"stage_group"`
	}
	if err := json.Unmarshal(body, &items); err != nil {
		t.Fatalf("list body is not an array of actions: %v\nbody: %s", err, body)
	}
	groups := make([]string, 0, len(items))
	for _, item := range items {
		want, declared := decidedStageOf[state.State(item.Status)]
		if !declared {
			t.Fatalf("the response carried the undeclared status %q", item.Status)
		}
		if item.StageGroup != want {
			t.Errorf("status %q answered stage_group %q, want %q", item.Status, item.StageGroup, want)
		}
		groups = append(groups, item.StageGroup)
	}
	return groups
}

// TestListRoutePublishesTheStageGroupOfEveryAction pins the field on the wire:
// the four groups appear, each one only for the statuses the decision groups
// under it, and the eight-state status is still returned untouched.
func TestListRoutePublishesTheStageGroupOfEveryAction(t *testing.T) {
	store := &matrixStore{list: oneActionPerState()}
	h, signer := app(t, store)

	w := requestWith(t, h, http.MethodGet, "/v1/prevention/actions", token(t, signer, "viewer", "viewer-1"), "")
	if w.Code != http.StatusOK {
		t.Fatalf("answered %d, want 200: %s", w.Code, w.Body.String())
	}
	groups := stageGroupOfResponse(t, w.Body.Bytes())
	if len(groups) != len(state.States()) {
		t.Fatalf("the list returned %d actions, want %d", len(groups), len(state.States()))
	}
	for _, group := range []string{"candidate", "in_progress", "reviewed", "closed"} {
		found := false
		for _, got := range groups {
			if got == group {
				found = true
			}
		}
		if !found {
			t.Errorf("the response never carried the group %q: %v", group, groups)
		}
	}
}

// TestListRouteAcceptsEveryStageGroup keeps the four values usable as filters: a
// declared group is a valid read, not malformed input.
func TestListRouteAcceptsEveryStageGroup(t *testing.T) {
	for _, group := range []string{"candidate", "in_progress", "reviewed", "closed"} {
		t.Run(group, func(t *testing.T) {
			store := &matrixStore{list: oneActionPerState()}
			h, signer := app(t, store)

			w := requestWith(t, h, http.MethodGet, "/v1/prevention/actions?stage_group="+group,
				token(t, signer, "viewer", "viewer-1"), "")
			if w.Code != http.StatusOK {
				t.Fatalf("answered %d, want 200: %s", w.Code, w.Body.String())
			}
			if store.lastListFilters.StageGroup != group {
				t.Errorf("stage_group forwarded as %q, want %q", store.lastListFilters.StageGroup, group)
			}
			if store.listCalls != 1 {
				t.Errorf("the read reached storage %d times, want 1", store.listCalls)
			}
		})
	}
}

// TestListRouteForwardsTheStageGroupBesideTheOtherFilters proves the three
// filters are independent: the pair the contract already documented keeps its
// values and the new one travels with them.
func TestListRouteForwardsTheStageGroupBesideTheOtherFilters(t *testing.T) {
	store := &matrixStore{}
	h, signer := app(t, store)

	w := requestWith(t, h, http.MethodGet,
		"/v1/prevention/actions?community_code=valparaiso&status=en_curso&stage_group=in_progress",
		token(t, signer, "viewer", "viewer-1"), "")
	if w.Code != http.StatusOK {
		t.Fatalf("answered %d, want 200: %s", w.Code, w.Body.String())
	}
	want := repository.ListFilters{CommunityCode: "valparaiso", Status: "en_curso", StageGroup: "in_progress"}
	if store.lastListFilters != want {
		t.Errorf("filters forwarded as %+v, want %+v", store.lastListFilters, want)
	}
}

// TestListRouteRejectsAStageGroupOutsideTheVocabulary pins the refusal: an
// undeclared, repeated or mis-cased group is malformed input refused 422 before
// anything is read, exactly like a status outside the frozen vocabulary.
func TestListRouteRejectsAStageGroupOutsideTheVocabulary(t *testing.T) {
	for _, target := range []string{
		"/v1/prevention/actions?stage_group=archived",
		"/v1/prevention/actions?stage_group=CANDIDATE",
		"/v1/prevention/actions?stage_group=in-progress",
		"/v1/prevention/actions?stage_group=in_progress&stage_group=closed",
	} {
		t.Run(target, func(t *testing.T) {
			store := &matrixStore{list: oneActionPerState()}
			h, signer := app(t, store)

			w := requestWith(t, h, http.MethodGet, target, token(t, signer, "viewer", "viewer-1"), "")
			if w.Code != http.StatusUnprocessableEntity {
				t.Fatalf("answered %d, want 422: %s", w.Code, w.Body.String())
			}
			if code := errorBody(t, w)["code"]; code != "invalid_query" {
				t.Errorf("code %q, want invalid_query", code)
			}
			// Nothing was read, so a refused filter cannot be mistaken for an empty
			// list — the answer the contract reserves for a valid read that matched
			// no row.
			if store.listCalls != 0 {
				t.Errorf("a malformed stage group reached storage %d times", store.listCalls)
			}
		})
	}
}

// TestDetailRoutePublishesTheStageGroup covers the second read route: the detail
// is the same action plus its history, so it carries the same projection.
func TestDetailRoutePublishesTheStageGroup(t *testing.T) {
	store := &matrixStore{detail: repository.Detail{
		Action: repository.Action{
			ID:            fixedActionID,
			CommunityCode: "valparaiso",
			Title:         "Cortafuegos",
			Status:        string(state.Devuelta),
		},
		History:            []repository.History{},
		Evidence:           []repository.Evidence{},
		EvidenceReviews:    []repository.EvidenceReview{},
		Reassessments:      []repository.Reassessment{},
		EvidenceSufficient: false,
	}}
	h, signer := app(t, store)

	w := requestWith(t, h, http.MethodGet, "/v1/prevention/actions/"+fixedActionID,
		token(t, signer, "viewer", "viewer-1"), "")
	if w.Code != http.StatusOK {
		t.Fatalf("answered %d, want 200: %s", w.Code, w.Body.String())
	}
	var detail struct {
		Status     string `json:"status"`
		StageGroup string `json:"stage_group"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &detail); err != nil {
		t.Fatalf("detail body is not an action: %v", err)
	}
	if detail.Status != string(state.Devuelta) || detail.StageGroup != "reviewed" {
		t.Errorf("detail answered status %q and stage_group %q, want devuelta and reviewed", detail.Status, detail.StageGroup)
	}
}

// TestTransitionAndCreateRoutesPublishTheStageGroup covers the two write routes:
// a refusal or a write answers with the action, so the projection travels with
// it instead of appearing only on the list.
func TestTransitionAndCreateRoutesPublishTheStageGroup(t *testing.T) {
	t.Run("transition", func(t *testing.T) {
		store := &matrixStore{
			status: state.Propuesta,
			action: repository.Action{
				ID:            fixedActionID,
				CommunityCode: "valparaiso",
				Title:         "Cortafuegos",
				Status:        string(state.Propuesta),
			},
		}
		h, signer := app(t, store)
		w := requestWith(t, h, http.MethodPost, "/v1/prevention/actions/"+fixedActionID+"/transitions",
			token(t, signer, "admin", "operator-1"), `{"to":"asignada"}`)
		if w.Code != http.StatusOK {
			t.Fatalf("answered %d, want 200: %s", w.Code, w.Body.String())
		}
		var action struct {
			Status     string `json:"status"`
			StageGroup string `json:"stage_group"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &action); err != nil {
			t.Fatalf("transition body is not an action: %v", err)
		}
		if action.Status != string(state.Asignada) || action.StageGroup != "candidate" {
			t.Errorf("transition answered status %q and stage_group %q, want asignada and candidate", action.Status, action.StageGroup)
		}
	})

	t.Run("create", func(t *testing.T) {
		store := &matrixStore{action: repository.Action{
			ID:            fixedActionID,
			CommunityCode: "valparaiso",
			Title:         "Cortafuegos",
			Status:        string(state.Propuesta),
		}}
		h, signer := app(t, store)
		w := requestWith(t, h, http.MethodPost, "/v1/prevention/actions",
			token(t, signer, "admin", "operator-1"), `{"community_code":"valparaiso","title":"Cortafuegos"}`)
		if w.Code != http.StatusCreated {
			t.Fatalf("answered %d, want 201: %s", w.Code, w.Body.String())
		}
		var action struct {
			StageGroup string `json:"stage_group"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &action); err != nil {
			t.Fatalf("create body is not an action: %v", err)
		}
		if action.StageGroup != "candidate" {
			t.Errorf("create answered stage_group %q, want candidate", action.StageGroup)
		}
	})
}

// TestListRouteRefusesAMalformedQueryInsteadOfDroppingIt pins the failure mode a
// silently ignored parse error creates: `?stage_group=%ZZ` would read as an
// OMITTED filter and answer the whole list, so the malformed request would be
// indistinguishable from a valid, unfiltered read. A query string that cannot be
// parsed is malformed input, refused before storage is touched — the same 422
// invalid_query an undeclared group already gets.
func TestListRouteRefusesAMalformedQueryInsteadOfDroppingIt(t *testing.T) {
	for _, target := range []string{
		"/v1/prevention/actions?stage_group=%ZZ",
		"/v1/prevention/actions?community_code=%ZZ&stage_group=candidate",
		"/v1/prevention/actions?status=%",
		"/v1/prevention/actions?community_code=a%2",
	} {
		t.Run(target, func(t *testing.T) {
			store := &matrixStore{list: oneActionPerState()}
			h, signer := app(t, store)

			w := requestWith(t, h, http.MethodGet, target, token(t, signer, "viewer", "viewer-1"), "")
			if w.Code != http.StatusUnprocessableEntity {
				t.Fatalf("answered %d, want 422: %s", w.Code, w.Body.String())
			}
			if code := errorBody(t, w)["code"]; code != "invalid_query" {
				t.Errorf("code %q, want invalid_query", code)
			}
			if store.listCalls != 0 {
				t.Errorf("a malformed query reached storage %d times", store.listCalls)
			}
		})
	}
}

// TestListRouteDecodesAPercentEncodedFilter is the other half of the rule: refusing
// a broken escape must not refuse a valid one. The value storage receives is the
// decoded one the client meant.
func TestListRouteDecodesAPercentEncodedFilter(t *testing.T) {
	store := &matrixStore{}
	h, signer := app(t, store)

	// %31%32%33 is "123": a percent-encoded community code, which is a valid filter.
	w := requestWith(t, h, http.MethodGet,
		"/v1/prevention/actions?community_code=%31%32%33&stage_group=in_progress",
		token(t, signer, "viewer", "viewer-1"), "")
	if w.Code != http.StatusOK {
		t.Fatalf("answered %d, want 200: %s", w.Code, w.Body.String())
	}
	want := repository.ListFilters{CommunityCode: "123", StageGroup: "in_progress"}
	if store.lastListFilters != want {
		t.Errorf("filters forwarded as %+v, want %+v", store.lastListFilters, want)
	}
}
