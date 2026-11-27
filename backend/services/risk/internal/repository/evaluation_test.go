package repository

import (
	"errors"
	"testing"
)

// PM-06 (S1-S2): the origin a persisted evaluation records is decided by the
// persistence method that owns it, and the manual half cannot exist without the
// verified subject the API gate already proved. These are the pure rules the
// integration test then exercises against a real database, so a mistake is
// attributable without a container.
func TestEvaluationOriginVocabulary(t *testing.T) {
	// The two values are the vocabulary 020_batch_evaluation_actor.sql closes with
	// a CHECK: pinning them here keeps the writer and the schema from drifting.
	if EvaluationTriggerScheduler != "scheduler" {
		t.Errorf("the scheduled trigger is %q, want %q", EvaluationTriggerScheduler, "scheduler")
	}
	if EvaluationTriggerManual != "manual" {
		t.Errorf("the manual trigger is %q, want %q", EvaluationTriggerManual, "manual")
	}

	scheduled := scheduledEvaluation()
	if scheduled.trigger != EvaluationTriggerScheduler || scheduled.actor != "" {
		t.Errorf("a scheduled evaluation recorded %+v, want the scheduler and no actor", scheduled)
	}

	manual, err := manualEvaluation("operator-ana")
	if err != nil {
		t.Fatalf("a manual evaluation with a verified subject was refused: %v", err)
	}
	if manual.trigger != EvaluationTriggerManual || manual.actor != "operator-ana" {
		t.Errorf("a manual evaluation recorded %+v, want the manual trigger and the subject verbatim", manual)
	}

	// A manual evaluation that cannot name its operator is refused before any row
	// is written: an empty or whitespace-only actor is not an identity, and the
	// database CHECK would refuse the row anyway.
	for _, actor := range []string{"", " ", "\t\n "} {
		if _, err := manualEvaluation(actor); !errors.Is(err, ErrManualEvaluationWithoutActor) {
			t.Errorf("manualEvaluation(%q) error = %v, want ErrManualEvaluationWithoutActor", actor, err)
		}
	}
}
