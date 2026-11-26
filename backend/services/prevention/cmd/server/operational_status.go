package main

import (
	"context"
	"time"

	"firewatch.local/prevention/internal/handler"
)

// operationalStatusTimeout bounds the database ping behind the authenticated
// status read, so a stalled database cannot hold the caller's read open.
const operationalStatusTimeout = time.Second

// operationalStatusCheck builds the evaluator the status route reports, from the
// same database handle the readiness probe pings. It is a named seam so both of
// its answers and its bound can be exercised without a database.
//
// It reports only the dependency this service has. Reusing the jobs/risk
// operational shape would mean reporting a broker and a dead-letter queue this
// service never talks to, which would be a fabricated dependency rather than
// evidence.
func operationalStatusCheck(ping func(context.Context) error, timeout time.Duration) handler.OperationalStatusCheck {
	return func(parent context.Context) handler.OperationalStatus {
		ctx, cancel := context.WithTimeout(parent, timeout)
		defer cancel()
		status := handler.OperationalStatus{
			CheckedAt:    time.Now().UTC(),
			Ready:        true,
			Dependencies: handler.OperationalDependencies{Database: handler.OperationalDependency{State: "ready"}},
		}
		if ping(ctx) != nil {
			// A failed ping is genuinely not ready, so the body and the code agree.
			status.Ready = false
			status.Reason = "database_unavailable"
			status.Dependencies.Database = handler.OperationalDependency{State: "degraded"}
		}
		return status
	}
}
