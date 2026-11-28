package state

import "testing"

// V1-P-03 — the four stage groups are a PROJECTION of the eight frozen states,
// not a second vocabulary. The owner's ratified decision fixes the mapping
// literally, so this table is a transcription of that sentence and nothing else:
//
//	candidate    DRAFT, ASSIGNED                  → propuesta, asignada
//	in_progress  IN_PROGRESS, EVIDENCE_SUBMITTED  → en_curso, enviada
//	reviewed     UNDER_REVIEW, REJECTED           → bloqueada, devuelta
//	closed       COMPLETED, CANCELLED             → aceptada, cancelada
//
// It is written as the full 8 → 4 table because the rule has to hold for EVERY
// state: a state that silently loses its group, or two states of one group that
// disagree, is exactly the drift a spot check would miss.
var decidedStageOf = map[State]StageGroup{
	Propuesta: StageCandidate,
	Asignada:  StageCandidate,
	EnCurso:   StageInProgress,
	Enviada:   StageInProgress,
	Bloqueada: StageReviewed,
	Devuelta:  StageReviewed,
	Aceptada:  StageClosed,
	Cancelada: StageClosed,
}

// decidedStages is the closed vocabulary in contract order. The order is part of
// the answer: the view renders the four chips in the order the service publishes.
var decidedStages = []StageGroup{StageCandidate, StageInProgress, StageReviewed, StageClosed}

// TestEveryStateProjectsOntoTheDecidedStage walks all eight states, so a state
// added later cannot be forgotten and a group cannot silently change.
func TestEveryStateProjectsOntoTheDecidedStage(t *testing.T) {
	for _, status := range States() {
		want, decided := decidedStageOf[status]
		if !decided {
			t.Fatalf("state %q has no decided stage group; the 8 → 4 table is incomplete", status)
		}
		if got := StageGroupOf(status); got != want {
			t.Errorf("StageGroupOf(%q) = %q, want %q", status, got, want)
		}
	}
	if len(States()) != len(decidedStageOf) {
		t.Errorf("the vocabulary has %d states, the projection covers %d", len(States()), len(decidedStageOf))
	}
}

// TestAnUndeclaredStateHasNoStageGroup keeps the projection closed: an alias or a
// state the contract never declared must not inherit a group by accident.
func TestAnUndeclaredStateHasNoStageGroup(t *testing.T) {
	for _, undeclared := range []State{"", "draft", "CANDIDATE", "en curso", "archived"} {
		if got := StageGroupOf(undeclared); got != "" {
			t.Errorf("StageGroupOf(%q) = %q, want no group", undeclared, got)
		}
	}
}

// TestThePublishedVocabularyIsTheFourDecidedGroups pins the wire order and the
// closed vocabulary: the contract publishes exactly these four values.
func TestThePublishedVocabularyIsTheFourDecidedGroups(t *testing.T) {
	groups := StageGroups()
	if len(groups) != len(decidedStages) {
		t.Fatalf("StageGroups returned %d groups, want %d", len(groups), len(decidedStages))
	}
	for index, want := range decidedStages {
		if groups[index] != want {
			t.Errorf("StageGroups()[%d] = %q, want %q", index, groups[index], want)
		}
		if !ValidStageGroup(want) {
			t.Errorf("ValidStageGroup(%q) = false, want true", want)
		}
	}
	// The copy must not be the shared list: a caller mutating it would change the
	// vocabulary every other caller reads.
	groups[0] = StageClosed
	if StageGroups()[0] != StageCandidate {
		t.Error("StageGroups exposed the shared list")
	}
}

// TestUndeclaredGroupsAreRefused keeps the query parameter closed on the same
// rule as the state filter: an unknown value is malformed input, never "no rows".
func TestUndeclaredGroupsAreRefused(t *testing.T) {
	for _, undeclared := range []StageGroup{"", "CANDIDATE", "in-progress", "in progress", "open", "all"} {
		if ValidStageGroup(undeclared) {
			t.Errorf("ValidStageGroup(%q) = true, want false", undeclared)
		}
	}
}

// TestStatesInStageCoversEachStateExactlyOnce proves both halves of the
// projection: every state of a group is listed, and no state belongs to two
// groups — the same property the SQL filter relies on when it narrows by group.
func TestStatesInStageCoversEachStateExactlyOnce(t *testing.T) {
	seen := map[State]int{}
	for _, group := range StageGroups() {
		states := StatesInStage(group)
		if len(states) == 0 {
			t.Fatalf("StatesInStage(%q) returned no state", group)
		}
		for _, status := range states {
			seen[status]++
			if got := StageGroupOf(status); got != group {
				t.Errorf("StatesInStage(%q) listed %q, whose group is %q", group, status, got)
			}
		}
	}
	for _, status := range States() {
		if seen[status] != 1 {
			t.Errorf("state %q appears in %d groups, want exactly 1", status, seen[status])
		}
	}
	if len(seen) != len(States()) {
		t.Errorf("the groups cover %d states, the vocabulary has %d", len(seen), len(States()))
	}
	// An undeclared group has no states, so a filter built from it reads as
	// "nothing matches" instead of silently widening to the whole list.
	if states := StatesInStage("open"); states != nil {
		t.Errorf("StatesInStage(\"open\") = %v, want nil", states)
	}
}
