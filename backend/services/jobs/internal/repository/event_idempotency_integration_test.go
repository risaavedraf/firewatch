package repository

// BH-10, event-side slice: duplicate and reordered completions at the jobs
// persistence boundary, plus the uniqueness conflict and the rollback that
// `Store.Complete` relies on.
//
// The earlier slice measured the `Create` boundary. This one measures what a
// consumer does when the broker hands it the same completion twice, two
// different completions for one job, or a completion that matches nothing. The
// effect asserted is the persisted state - the job row, the audit row and the
// `inbox` row that gates redelivery - not a broker delivery, so no broker is
// required and none is claimed. Every case skips without TEST_DATABASE_URL: a
// skip is not a pass.

import (
	"errors"
	"sync"
	"testing"
	"time"

	v1 "firewatch.local/contracts/events/v1"
	"github.com/google/uuid"
)

// completion builds the risk.batch.published.v1 delivery a consumer hands to
// Store.Complete. It is built FROM the stored row, like the real completion, so
// the event and the row cannot drift apart inside the test.
func completion(job Job, actor, batchID string) v1.Event {
	event := v1.Event{
		ID:          uuid.NewString(),
		Type:        v1.BatchPublishedType,
		OccurredAt:  time.Now().UTC(),
		TraceID:     uuid.NewString(),
		JobID:       job.ID,
		ActorID:     actor,
		ZoneID:      job.ZoneID,
		BatchID:     batchID,
		RequestedAt: job.RequestedAt,
		Demo:        true,
	}
	if job.ScenarioID != nil {
		event.ScenarioID = *job.ScenarioID
	}
	if job.EvaluatedAt != nil {
		instant := *job.EvaluatedAt
		event.EvaluatedAt = &instant
	}
	return event
}

// count runs one counting query on this fixture's pool.
func (f concurrentCreateFixture) count(t *testing.T, query string, args ...any) int {
	t.Helper()
	var n int
	if err := f.db.QueryRow(f.ctx, query, args...).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

// auditsFor counts the audit rows one job carries for one action.
func (f concurrentCreateFixture) auditsFor(t *testing.T, jobID, action string) int {
	t.Helper()
	return f.count(t, `SELECT count(*) FROM audit WHERE job_id=$1 AND action=$2`, jobID, action)
}

// inboxFor counts the deduplication rows one event id left behind. A zero after
// a failed delivery is the rollback: the gate row is written first and must not
// survive a transaction that did not apply the completion.
func (f concurrentCreateFixture) inboxFor(t *testing.T, eventID string) int {
	t.Helper()
	return f.count(t, `SELECT count(*) FROM inbox WHERE id=$1`, eventID)
}

// mustCreate stores one queued job for a fresh identity.
func (f concurrentCreateFixture) mustCreate(t *testing.T, actor string) Job {
	t.Helper()
	job, err := f.store.Create(f.ctx, actor, uuid.NewString(), concurrentCreateZone, uuid.NewString())
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	return job
}

// mustPublished fails unless the stored row is published with exactly this batch.
func (f concurrentCreateFixture) mustPublished(t *testing.T, jobID, batchID string) {
	t.Helper()
	stored, err := f.store.Get(f.ctx, jobID)
	if err != nil {
		t.Fatalf("read the stored job: %v", err)
	}
	if stored.State != "published" {
		t.Fatalf("state = %q, want published", stored.State)
	}
	if stored.BatchID == nil || *stored.BatchID != batchID {
		t.Fatalf("batch_id = %v, want %s", stored.BatchID, batchID)
	}
}

// TestDuplicateCompletionEventIsAbsorbedByTheInboxGate proves the same event id
// delivered twice applies the completion once: the second delivery is stopped by
// the inbox primary key before it can write a second audit row.
func TestDuplicateCompletionEventIsAbsorbedByTheInboxGate(t *testing.T) {
	f := newConcurrentCreateFixture(t)
	actor := uuid.NewString()
	job := f.mustCreate(t, actor)
	event := completion(job, actor, uuid.NewString())

	for attempt := 1; attempt <= 2; attempt++ {
		if err := f.store.Complete(f.ctx, event); err != nil {
			t.Fatalf("delivery %d of the same event failed: %v", attempt, err)
		}
	}

	f.mustPublished(t, job.ID, event.BatchID)
	if n := f.auditsFor(t, job.ID, "batch.published"); n != 1 {
		t.Fatalf("batch.published audit rows = %d, want exactly one for two deliveries of one event id", n)
	}
	if n := f.inboxFor(t, event.ID); n != 1 {
		t.Fatalf("inbox rows for the event = %d, want exactly one", n)
	}
}

// TestConcurrentDuplicateCompletionsProduceOneEffect releases the SAME delivery
// from several goroutines at once. The inbox insert is the only arbiter, so
// exactly one completion may apply and the rest must be absorbed silently.
func TestConcurrentDuplicateCompletionsProduceOneEffect(t *testing.T) {
	f := newConcurrentCreateFixture(t)
	actor := uuid.NewString()
	job := f.mustCreate(t, actor)
	event := completion(job, actor, uuid.NewString())

	const workers = 8
	start := make(chan struct{})
	failures := make(chan error, workers)
	var wg sync.WaitGroup
	// No loop variable is captured: the goroutine closes over the event and the
	// fixture only, so the wave cannot depend on per-iteration scoping rules.
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			failures <- f.store.Complete(f.ctx, event)
		}()
	}
	close(start)
	wg.Wait()
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatalf("a concurrent duplicate delivery failed: %v", err)
		}
	}

	f.mustPublished(t, job.ID, event.BatchID)
	if n := f.auditsFor(t, job.ID, "batch.published"); n != 1 {
		t.Fatalf("batch.published audit rows = %d, want exactly one for %d concurrent duplicates", n, workers)
	}
	if n := f.inboxFor(t, event.ID); n != 1 {
		t.Fatalf("inbox rows for the event = %d, want exactly one", n)
	}
}

// TestConcurrentDistinctCompletionsForOneBatchLeaveOneEffect is the redelivery
// the inbox CANNOT stop: a fresh event id carrying the batch already stored. Each
// delivery legitimately commits its own gate row, and the guarded update plus the
// matching-published check are what keep the effect single.
func TestConcurrentDistinctCompletionsForOneBatchLeaveOneEffect(t *testing.T) {
	f := newConcurrentCreateFixture(t)
	actor := uuid.NewString()
	job := f.mustCreate(t, actor)
	batchID := uuid.NewString()

	const workers = 8
	events := make([]v1.Event, workers)
	for i := range events {
		events[i] = completion(job, actor, batchID)
	}
	start := make(chan struct{})
	failures := make(chan error, workers)
	var wg sync.WaitGroup
	// The event is passed as a parameter, never captured from the loop.
	for _, event := range events {
		wg.Add(1)
		go func(delivery v1.Event) {
			defer wg.Done()
			<-start
			failures <- f.store.Complete(f.ctx, delivery)
		}(event)
	}
	close(start)
	wg.Wait()
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatalf("a distinct completion for the stored batch failed: %v", err)
		}
	}

	f.mustPublished(t, job.ID, batchID)
	if n := f.auditsFor(t, job.ID, "batch.published"); n != 1 {
		t.Fatalf("batch.published audit rows = %d, want exactly one for %d distinct completions", n, workers)
	}
	for _, event := range events {
		if n := f.inboxFor(t, event.ID); n != 1 {
			t.Fatalf("inbox rows for event %s = %d, want one: each distinct id is gated on its own", event.ID, n)
		}
	}
}

// TestCompletionForAForeignBatchIsPermanentAndLeavesNoPartialState is the
// reordered delivery: a fresh event naming a different batch for a job that is
// already published. No retry can make it match, so it must be permanent, the
// stored row must keep its original batch, and the gate row written first must be
// rolled back with the rest of the transaction.
func TestCompletionForAForeignBatchIsPermanentAndLeavesNoPartialState(t *testing.T) {
	f := newConcurrentCreateFixture(t)
	actor := uuid.NewString()
	job := f.mustCreate(t, actor)
	stored := uuid.NewString()
	if err := f.store.Complete(f.ctx, completion(job, actor, stored)); err != nil {
		t.Fatalf("the first completion failed: %v", err)
	}

	reordered := completion(job, actor, uuid.NewString())
	err := f.store.Complete(f.ctx, reordered)
	var permanent interface{ Permanent() bool }
	if !errors.As(err, &permanent) || !permanent.Permanent() {
		t.Fatalf("a completion naming a foreign batch returned %v, want a permanent error", err)
	}

	f.mustPublished(t, job.ID, stored)
	if n := f.auditsFor(t, job.ID, "batch.published"); n != 1 {
		t.Fatalf("batch.published audit rows = %d, want the foreign batch to add none", n)
	}
	if n := f.inboxFor(t, reordered.ID); n != 0 {
		t.Fatalf("inbox rows for the refused event = %d, want zero: the gate row must roll back with the transaction", n)
	}
}

// TestCompletionForAnUnknownJobIsPermanentAndLeavesNoInboxRow is the completion
// that arrives for a job this service never stored. It is permanent for the same
// reason and must leave no trace of having been accepted.
func TestCompletionForAnUnknownJobIsPermanentAndLeavesNoInboxRow(t *testing.T) {
	f := newConcurrentCreateFixture(t)
	unknown := Job{ID: uuid.NewString(), ZoneID: concurrentCreateZone, RequestedAt: time.Now().UTC()}
	orphan := completion(unknown, uuid.NewString(), uuid.NewString())

	err := f.store.Complete(f.ctx, orphan)
	var permanent interface{ Permanent() bool }
	if !errors.As(err, &permanent) || !permanent.Permanent() {
		t.Fatalf("a completion for an unknown job returned %v, want a permanent error", err)
	}
	if n := f.inboxFor(t, orphan.ID); n != 0 {
		t.Fatalf("inbox rows for the refused event = %d, want zero", n)
	}
	if n := f.count(t, `SELECT count(*) FROM jobs WHERE id=$1`, orphan.JobID); n != 0 {
		t.Fatalf("rows for the unknown job = %d, want zero", n)
	}
}
