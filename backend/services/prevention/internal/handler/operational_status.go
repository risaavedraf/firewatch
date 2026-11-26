package handler

import (
	"context"
	"net/http"
	"time"
)

// OperationalStatusCheck evaluates the dependencies this service actually has.
type OperationalStatusCheck func(context.Context) OperationalStatus

// OperationalDependency is one dependency's state.
type OperationalDependency struct {
	State string `json:"state"`
}

// OperationalDependencies is the dependency map of this service. It holds the
// database and nothing else: prevention talks to no broker and owns no
// dead-letter queue, so reporting either would be a fabricated dependency.
type OperationalDependencies struct {
	Database OperationalDependency `json:"database"`
}

// OperationalStatus is the body of the authenticated status read. It reports
// what the bounded ping observed, not an end-to-end delivery guarantee.
type OperationalStatus struct {
	CheckedAt    time.Time               `json:"checked_at"`
	Ready        bool                    `json:"ready"`
	Reason       string                  `json:"reason"`
	Dependencies OperationalDependencies `json:"dependencies"`
}

// operationalStatusHandler serves GET /v1/prevention/status. It is mounted inside
// the same Authorize gate as every other route of this service, so the answer is
// only reachable by an admitted caller.
//
// The code follows the evidence: 200 when the evaluator reports ready, 503
// otherwise, so the body and the code cannot disagree. A nil evaluator is a
// process that wired none, and it reports unknown rather than claiming ready.
func operationalStatusHandler(check OperationalStatusCheck) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status := OperationalStatus{
			CheckedAt:    time.Now().UTC(),
			Reason:       "status_unavailable",
			Dependencies: OperationalDependencies{Database: OperationalDependency{State: "unknown"}},
		}
		if check != nil {
			status = check(r.Context())
		}
		code := http.StatusServiceUnavailable
		if status.Ready {
			code = http.StatusOK
		}
		respond(w, code, status)
	}
}
