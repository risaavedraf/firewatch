package repository

import (
	"encoding/json"
	"testing"

	"firewatch.local/prevention/internal/state"
)

// V1-P-03 — the stage group is part of the ACTION REPRESENTATION, not only of the
// HTTP body the transport builds. The owner's ratified decision fixes the mapping,
// so this file transcribes it literally and holds the repository to it: every
// representation the repository returns carries the group its status projects
// onto, and the projection is derived from the status rather than trusted from a
// caller.

// decidedStageOf is the ratified 8 → 4 table, restated here so a change to the
// projection fails against the decision instead of silently moving a state.
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

// TestTheActionRepresentationCarriesTheStageGroup walks the eight frozen states
// through the repository projection and reads the field off the JSON the service
// actually serialises: the representation the repository hands to the transport
// already carries it, so the wire cannot depend on the transport remembering to
// derive it.
func TestTheActionRepresentationCarriesTheStageGroup(t *testing.T) {
	for status, want := range decidedStageOf {
		action := WithStageGroup(Action{
			ID:            "6f1e7b0a-2f4f-4a3f-9a5b-1d3c7e9f2a44",
			CommunityCode: "05101",
			Title:         "Cortafuegos",
			Status:        string(status),
		})
		if action.StageGroup != want {
			t.Errorf("WithStageGroup(%q) = %q, want %q", status, action.StageGroup, want)
		}
		raw, err := json.Marshal(action)
		if err != nil {
			t.Fatalf("marshal %q: %v", status, err)
		}
		var body map[string]any
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Fatalf("unmarshal %q: %v", status, err)
		}
		if body["stage_group"] != want {
			t.Errorf("the representation of %q carries stage_group %v, want %q", status, body["stage_group"], want)
		}
		if body["status"] != string(status) {
			t.Errorf("the representation of %q carries status %v; the eight-state status must be untouched", status, body["status"])
		}
	}
}

// TestTheProjectionIsDerivedFromTheStatusAndNeverTrusted keeps the one rule the
// two layers share: a value that arrives on the struct is overwritten from the
// status, so a stale or fabricated group can never be emitted beside it.
func TestTheProjectionIsDerivedFromTheStatusAndNeverTrusted(t *testing.T) {
	action := WithStageGroup(Action{Status: string(state.Propuesta), StageGroup: "closed"})
	if action.StageGroup != "candidate" {
		t.Errorf("a stale group survived: got %q, want candidate", action.StageGroup)
	}

	// An undeclared status has no group, so the field stays empty and the published
	// enum refuses the body instead of the service claiming a group it cannot name.
	undeclared := WithStageGroup(Action{Status: "archived", StageGroup: "closed"})
	if undeclared.StageGroup != "" {
		t.Errorf("an undeclared status answered the group %q, want none", undeclared.StageGroup)
	}
}

// TestTheListFilterIsTheGroupItNames pins the other half of the filter: the
// repository narrows by the states of the group, and an undeclared group has no
// state, so a filter built from it matches nothing instead of widening the read.
func TestTheListFilterIsTheGroupItNames(t *testing.T) {
	candidate := state.StatesInStage(state.StageCandidate)
	if len(candidate) != 2 {
		t.Fatalf("the candidate group holds %d states, want 2", len(candidate))
	}
	for _, status := range candidate {
		if decidedStageOf[status] != "candidate" {
			t.Errorf("the candidate filter listed %q, whose group is %q", status, decidedStageOf[status])
		}
	}
	if states := state.StatesInStage("archived"); states != nil {
		t.Errorf("an undeclared group produced the states %v, want none", states)
	}
}
