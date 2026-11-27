package repository

import (
	"errors"
	"strings"
)

// The closed vocabulary of evaluation triggers, as 020_batch_evaluation_actor.sql
// accepts it. The database states the same rule in one CHECK: a scheduled
// evaluation records no actor and a manual one cannot exist without a non-blank
// one, so any other pair - including a value outside this vocabulary - is refused
// by storage even if a future writer forgot these constants.
const (
	// EvaluationTriggerScheduler is an evaluation nobody asked for at request time:
	// the automatic 15 minute cycle and every queued job delivery. Those paths carry
	// no verified token subject, so the actor is NULL rather than an invented name.
	EvaluationTriggerScheduler = "scheduler"
	// EvaluationTriggerManual is an evaluation a verified operator asked for through
	// the manual cycle trigger. The actor is the token subject the API gate proved.
	EvaluationTriggerManual = "manual"
)

// ErrManualEvaluationWithoutActor refuses a manual evaluation that cannot name its
// operator. It is returned before the transaction opens, so a refused manual
// evaluation leaves no inbox mark and no batch behind.
var ErrManualEvaluationWithoutActor = errors.New("a manual evaluation requires the verified token subject of the operator")

// evaluationOrigin is who triggered one persisted evaluation, in the vocabulary
// the schema records. It is unexported and built only by the three publication
// methods that own an origin - Publish, PublishScheduled and PublishManual - so no
// caller, request body or header can decide it.
type evaluationOrigin struct {
	trigger string
	// actor is the verified token subject of a manual evaluation, stored verbatim.
	// It is empty for a scheduled evaluation, which is recorded as SQL NULL.
	actor string
}

// scheduledEvaluation is the origin of an evaluation nobody asked for at request
// time: the automatic cycle and every queued job delivery.
func scheduledEvaluation() evaluationOrigin {
	return evaluationOrigin{trigger: EvaluationTriggerScheduler}
}

// manualEvaluation is the origin of an evaluation a verified operator asked for. A
// blank subject is refused: whitespace is not an identity, and the schema CHECK
// would refuse the row anyway.
func manualEvaluation(actor string) (evaluationOrigin, error) {
	if strings.TrimSpace(actor) == "" {
		return evaluationOrigin{}, ErrManualEvaluationWithoutActor
	}
	return evaluationOrigin{trigger: EvaluationTriggerManual, actor: actor}, nil
}
