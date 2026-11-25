package main

import (
	"context"
	"errors"
	"testing"
	"time"
)

// The status route reports the dependency this process actually has. The
// evaluator is a named seam so its two answers and its bound can be exercised
// without a database.

func TestOperationalStatusReportsTheDatabaseEvidence(t *testing.T) {
	answered := operationalStatusCheck(func(context.Context) error { return nil }, time.Second)(context.Background())
	if !answered.Ready || answered.Reason != "" {
		t.Fatalf("answer with a live database = ready %v reason %q, want ready and no reason", answered.Ready, answered.Reason)
	}
	if answered.Dependencies.Database.State != "ready" {
		t.Fatalf("database state = %q, want ready", answered.Dependencies.Database.State)
	}
	if answered.CheckedAt.IsZero() {
		t.Fatal("the answer carries no evaluation instant")
	}

	unanswered := operationalStatusCheck(func(context.Context) error { return errors.New("database down") }, time.Second)(context.Background())
	if unanswered.Ready || unanswered.Reason != "database_unavailable" {
		t.Fatalf("answer with a failed ping = ready %v reason %q, want not ready and database_unavailable", unanswered.Ready, unanswered.Reason)
	}
	if unanswered.Dependencies.Database.State != "degraded" {
		t.Fatalf("database state = %q, want degraded", unanswered.Dependencies.Database.State)
	}
}

// TestOperationalStatusPingIsBounded pins that a ping which hangs is answered at
// the deadline instead of holding the caller's read open.
func TestOperationalStatusPingIsBounded(t *testing.T) {
	start := time.Now()
	answer := operationalStatusCheck(func(ctx context.Context) error {
		<-ctx.Done()
		return ctx.Err()
	}, 20*time.Millisecond)(context.Background())
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("the ping took %s with a 20 ms bound", elapsed)
	}
	if answer.Ready || answer.Reason != "database_unavailable" {
		t.Fatalf("answer for a hung ping = ready %v reason %q", answer.Ready, answer.Reason)
	}
}
