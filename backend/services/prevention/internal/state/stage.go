package state

// V1-P-03 — the canonical four-group projection of the frozen eight states of a
// preventive action.
//
// The owner's ratified decision keeps the eight statuses and their transitions
// exactly as they are and publishes four STAGE GROUPS on top of them. The map
// below is that decision transcribed literally:
//
//	candidate    DRAFT, ASSIGNED                  → propuesta, asignada
//	in_progress  IN_PROGRESS, EVIDENCE_SUBMITTED  → en_curso, enviada
//	reviewed     UNDER_REVIEW, REJECTED           → bloqueada, devuelta
//	closed       COMPLETED, CANCELLED             → aceptada, cancelada
//
// Two consequences follow, and both are part of the contract:
//
//   - the projection is derived from the status and is never stored. There is no
//     column for it and no migration adds one, so a row cannot carry a group that
//     disagrees with the state it is in;
//   - the projection is not a second state machine. Moving an action is still
//     decided by CanTransition alone; a group never authorizes a transition.

// StageGroup is one of the four groups the eight frozen states project onto. The
// literals are the contract's, so they are part of the API, not an internal
// detail.
type StageGroup string

const (
	StageCandidate  StageGroup = "candidate"
	StageInProgress StageGroup = "in_progress"
	StageReviewed   StageGroup = "reviewed"
	StageClosed     StageGroup = "closed"
)

// stageGroups is the ordered vocabulary, kept separate from the projection so the
// documented order is stable for the chips that render it.
var stageGroups = []StageGroup{StageCandidate, StageInProgress, StageReviewed, StageClosed}

// stageOf is the deterministic 8 → 4 projection. Every state of the vocabulary
// appears exactly once: a state cannot lose its group, and no state belongs to
// two groups.
var stageOf = map[State]StageGroup{
	Propuesta: StageCandidate,
	Asignada:  StageCandidate,
	EnCurso:   StageInProgress,
	Enviada:   StageInProgress,
	Bloqueada: StageReviewed,
	Devuelta:  StageReviewed,
	Aceptada:  StageClosed,
	Cancelada: StageClosed,
}

// StageGroups returns the four groups in contract order. A copy is returned so a
// caller cannot mutate the shared vocabulary.
func StageGroups() []StageGroup {
	all := make([]StageGroup, len(stageGroups))
	copy(all, stageGroups)
	return all
}

// ValidStageGroup reports whether group is a group the contract defines. Exact
// comparison is deliberate, exactly as in Valid: an alias would be a second
// vocabulary that can drift.
func ValidStageGroup(group StageGroup) bool {
	for _, candidate := range stageGroups {
		if candidate == group {
			return true
		}
	}
	return false
}

// StageGroupOf returns the group status projects onto, or "" when status is not a
// state of the vocabulary. The empty answer is the honest one: an undeclared
// status has no group, and inventing one would describe a state the contract
// never declared.
func StageGroupOf(status State) StageGroup {
	return stageOf[status]
}

// StatesInStage returns the states that project onto group, in vocabulary order,
// or nil when group is not one the contract declares. A filter built from an
// undeclared group therefore matches nothing instead of widening the read to the
// whole list.
func StatesInStage(group StageGroup) []State {
	if !ValidStageGroup(group) {
		return nil
	}
	states := make([]State, 0, len(stageOf))
	for _, status := range vocabulary {
		if stageOf[status] == group {
			states = append(states, status)
		}
	}
	return states
}
