package handler

import (
	"context"
	"net/http"
	"time"
)

// The inference evidence read is additive and reports, it does not judge: this
// service is the only one that holds the configured inference address and the
// internal CA the probe trusts, so it is the only one that can say what that
// address answers right now. It is evidence about one dependency, not an
// end-to-end delivery test and not evidence of real risk.
const (
	// InferenceReady means the configured inference service answered its own ready
	// health document at this instant.
	InferenceReady = "ready"
	// InferenceDegraded means a configured inference service could not supply that
	// document: unreachable, timed out, another status, or another document.
	InferenceDegraded = "degraded"
	// InferenceUnknown means this process has no evaluator to report from at all.
	InferenceUnknown = "unknown"
	// InferenceNotConfigured means this deployment configures no inference
	// address. That is a rule-only deployment, not a failure.
	InferenceNotConfigured = "not_configured"
)

// InferenceStatusCheck evaluates the configured inference service. A nil check is
// a process that wired no evaluator, and the route reports unknown for it.
type InferenceStatusCheck func(context.Context) InferenceStatus

// InferenceStatus is the evidence body. It carries this service's own evaluation
// and nothing of the inference service's document: no address, no version, no
// threshold and no body text of the health answer.
type InferenceStatus struct {
	CheckedAt time.Time `json:"checked_at"`
	State     string    `json:"state"`
	Reason    string    `json:"reason"`
}

// inferenceStatusHandler serves GET /v1/risk/inference/status. It is mounted
// inside the same Authorize gate as every other risk read, so the answer is only
// reachable by an admitted caller.
//
// The code follows the state, exactly like the operational status routes do: a
// ready or unconfigured answer is 200, everything else is 503, so the body and
// the code cannot disagree.
func inferenceStatusHandler(check InferenceStatusCheck) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status := InferenceStatus{CheckedAt: time.Now().UTC(), State: InferenceUnknown, Reason: "status_unavailable"}
		if check != nil {
			status = check(r.Context())
		}
		code := http.StatusServiceUnavailable
		if status.State == InferenceReady || status.State == InferenceNotConfigured {
			code = http.StatusOK
		}
		respond(w, code, status)
	}
}
