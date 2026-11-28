package cycle

import (
	"context"
	"testing"
	"time"

	v1 "firewatch.local/contracts/events/v1"
	"firewatch.local/risk/internal/scheduler"
)

// cadencePublisher counts cycles published from the goroutine Start runs on. It
// is mutex-guarded because the test reads it while that goroutine is running,
// which the unsynchronised stub in runner_test.go is not used for.
type cadencePublisher struct {
	mu       chan struct{}
	requests []v1.Event
}

func newCadencePublisher() *cadencePublisher {
	return &cadencePublisher{mu: make(chan struct{}, 1)}
}

func (p *cadencePublisher) PublishScheduled(_ context.Context, request v1.Event) error {
	p.mu <- struct{}{}
	p.requests = append(p.requests, request)
	<-p.mu
	return nil
}

// count returns how many cycles have been published so far.
func (p *cadencePublisher) count() int {
	p.mu <- struct{}{}
	defer func() { <-p.mu }()
	return len(p.requests)
}

// requestAt returns a copy of one published request.
func (p *cadencePublisher) requestAt(index int) v1.Event {
	p.mu <- struct{}{}
	defer func() { <-p.mu }()
	return p.requests[index]
}

// cadenceSeam is the timer seam a test drives. Every wait the runner asks for is
// recorded, and the tick instant is delivered by the test, so the automatic loop
// is observed without sleeping.
type cadenceSeam struct {
	mu        chan struct{}
	requested []time.Duration
	ready     chan struct{}
	ticks     chan time.Time
}

func newCadenceSeam() *cadenceSeam {
	return &cadenceSeam{
		mu:    make(chan struct{}, 1),
		ready: make(chan struct{}, 1),
		ticks: make(chan time.Time),
	}
}

func (s *cadenceSeam) after(delay time.Duration) <-chan time.Time {
	s.mu <- struct{}{}
	s.requested = append(s.requested, delay)
	<-s.mu
	select {
	case s.ready <- struct{}{}:
	default:
	}
	return s.ticks
}

func (s *cadenceSeam) waits() []time.Duration {
	s.mu <- struct{}{}
	defer func() { <-s.mu }()
	waits := make([]time.Duration, len(s.requested))
	copy(waits, s.requested)
	return waits
}

// S2: the automatic loop must take its cadence from internal/scheduler. A fixed
// ticker produces exactly the nominal interval every time; the seeded schedule
// produces the nominal interval plus a bounded jitter, so a run whose waits are
// all exactly 900s cannot be schedule-driven. The bounds are asserted as well:
// no wait may leave 900s ± 30s.
func TestRunnerDrivesTheAutomaticCycleThroughTheSeededSchedule(t *testing.T) {
	// The wired period is the scheduler's nominal interval, not a second literal:
	// this package is the importer, so the pinning lives here and the dependency
	// keeps pointing one way.
	if DefaultInterval != scheduler.NominalInterval {
		t.Fatalf("cycle interval = %v, want the scheduler's %v", DefaultInterval, scheduler.NominalInterval)
	}

	publisher, waits := collectWaits(t, nil, 4)

	if len(waits) < 3 {
		t.Fatalf("waits = %v, want at least 3 observed intervals", waits)
	}
	allNominal := true
	for index, wait := range waits {
		lowest := scheduler.NominalInterval - scheduler.MaxJitter
		highest := scheduler.NominalInterval + scheduler.MaxJitter
		if wait < lowest || wait > highest {
			t.Fatalf("wait %d = %v, outside %v ± %v", index, wait, scheduler.NominalInterval, scheduler.MaxJitter)
		}
		if wait != scheduler.NominalInterval {
			allNominal = false
		}
	}
	if allNominal {
		t.Fatalf("every wait was exactly %v: the runner is not using the seeded schedule", scheduler.NominalInterval)
	}

	// The deterministic hooks survive the wiring: the injected clock still stamps
	// the request, so a test does not have to give up reproducibility.
	instant := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	if got := publisher.requestAt(0).OccurredAt; !got.Equal(instant) {
		t.Fatalf("request instant = %v, want the injected clock %v", got, instant)
	}
}

// S2: the injected schedule is the authority, not a hardcoded default. A schedule
// bounded to 5s must narrow every wait, and a schedule with jitter disabled must
// produce the exact nominal grid -two shapes a fixed ticker could not follow from
// configuration.
func TestRunnerFollowsTheInjectedScheduleBounds(t *testing.T) {
	narrow := scheduler.New(scheduler.Options{Jitter: 5 * time.Second})
	_, narrowWaits := collectWaits(t, &narrow, 4)
	if len(narrowWaits) < 3 {
		t.Fatalf("waits = %v, want at least 3 observed intervals", narrowWaits)
	}
	allNominal := true
	for index, wait := range narrowWaits {
		if wait < scheduler.NominalInterval-5*time.Second || wait > scheduler.NominalInterval+5*time.Second {
			t.Fatalf("wait %d = %v, outside the injected 5s bound", index, wait)
		}
		if wait != scheduler.NominalInterval {
			allNominal = false
		}
	}
	if allNominal {
		t.Fatal("the injected 5s jitter was ignored: every wait was exactly nominal")
	}

	// A negative jitter is the documented opt-out of the scheduler contract.
	exact := scheduler.New(scheduler.Options{Jitter: -time.Second})
	_, exactWaits := collectWaits(t, &exact, 3)
	for index, wait := range exactWaits {
		if wait != scheduler.NominalInterval {
			t.Fatalf("wait %d = %v, want exactly %v with jitter disabled", index, wait, scheduler.NominalInterval)
		}
	}
}

// S2: the same schedule replays identically, so a cadence assertion is not a
// flaky observation of wall-clock noise.
func TestRunnerCadenceIsReproducibleForOneSchedule(t *testing.T) {
	first := scheduler.New(scheduler.Options{})
	_, firstWaits := collectWaits(t, &first, 5)
	second := scheduler.New(scheduler.Options{})
	_, secondWaits := collectWaits(t, &second, 5)

	if len(firstWaits) != len(secondWaits) {
		t.Fatalf("wait counts differ: %d vs %d", len(firstWaits), len(secondWaits))
	}
	for index := range firstWaits {
		if firstWaits[index] != secondWaits[index] {
			t.Fatalf("wait %d differs between runs: %v vs %v", index, firstWaits[index], secondWaits[index])
		}
	}
}

// collectWaits starts a runner on an injected schedule and drives the requested
// number of automatic cycles through the timer seam. It returns the publisher so a
// caller can assert what the loop published, and the waits the runner asked for.
// S2: the scheduled delay is the start-to-start interval, not a wait added on top
// of the cycle's own runtime. When a cycle spends 45s of clock, the loop must wait
// the delay minus those 45s, so consecutive starts stay Delay(ordinal) apart and
// inside the agreed 900s ± 30s band.
func TestRunnerSubtractsTheCycleRuntimeFromTheScheduledDelay(t *testing.T) {
	const perCycle = 45 * time.Second
	schedule := scheduler.New(scheduler.Options{})
	publisher, waits := collectMeasuredWaits(t, &schedule, 4, perCycle)

	if len(waits) < 3 {
		t.Fatalf("waits = %v, want at least 3 observed intervals", waits)
	}
	lowest := scheduler.NominalInterval - scheduler.MaxJitter
	highest := scheduler.NominalInterval + scheduler.MaxJitter
	for index, wait := range waits {
		ordinal := index + 1
		wantWait := schedule.Delay(ordinal) - perCycle
		if wait != wantWait {
			t.Fatalf(
				"wait %d = %v, want %v (delay %v minus the %v the cycle spent)",
				index,
				wait,
				wantWait,
				schedule.Delay(ordinal),
				perCycle,
			)
		}
		startToStart := wait + perCycle
		if startToStart != schedule.Delay(ordinal) {
			t.Fatalf("start-to-start %d = %v, want the scheduled %v", index, startToStart, schedule.Delay(ordinal))
		}
		if startToStart < lowest || startToStart > highest {
			t.Fatalf(
				"start-to-start %d = %v, outside %v ± %v",
				index,
				startToStart,
				scheduler.NominalInterval,
				scheduler.MaxJitter,
			)
		}
	}
	if published := publisher.count(); published < 4 {
		t.Fatalf("published %d cycles, want 4", published)
	}
}

// S2: a cycle that outlasts its own period must not produce a negative wait. The
// next cycle starts at once instead of the loop computing a wait it cannot honour.
func TestRunnerClampsTheWaitWhenTheCycleOutlastsThePeriod(t *testing.T) {
	schedule := scheduler.New(scheduler.Options{})
	_, waits := collectMeasuredWaits(t, &schedule, 3, 20*time.Minute)

	if len(waits) < 2 {
		t.Fatalf("waits = %v, want at least 2 observed intervals", waits)
	}
	for index, wait := range waits {
		if wait != 0 {
			t.Fatalf("wait %d = %v, want 0 when the cycle outlasted its period", index, wait)
		}
	}
}

// advancingClock is the injected clock of a timed run. The instant stays fixed
// until the publisher reports that a cycle spent time, which is what makes a
// nonzero cycle duration observable without sleeping.
type advancingClock struct {
	mu      chan struct{}
	instant time.Time
}

func newAdvancingClock(instant time.Time) *advancingClock {
	return &advancingClock{mu: make(chan struct{}, 1), instant: instant}
}

func (c *advancingClock) now() time.Time {
	c.mu <- struct{}{}
	defer func() { <-c.mu }()
	return c.instant
}

func (c *advancingClock) spend(elapsed time.Duration) {
	c.mu <- struct{}{}
	defer func() { <-c.mu }()
	c.instant = c.instant.Add(elapsed)
}

// timedPublisher makes every published cycle consume a fixed span of the injected
// clock, standing in for the ingest, validation and persistence a cycle performs.
type timedPublisher struct {
	*cadencePublisher
	clock    *advancingClock
	perCycle time.Duration
}

func (p *timedPublisher) PublishScheduled(ctx context.Context, request v1.Event) error {
	err := p.cadencePublisher.PublishScheduled(ctx, request)
	p.clock.spend(p.perCycle)
	return err
}

func collectWaits(t *testing.T, schedule *scheduler.Schedule, cycles int) (*cadencePublisher, []time.Duration) {
	t.Helper()
	return collectMeasuredWaits(t, schedule, cycles, 0)
}

// collectMeasuredWaits starts a runner on an injected schedule and drives the
// requested number of automatic cycles through the timer seam. perCycle is how much
// of the injected clock each cycle consumes, so a caller can observe whether the
// loop treats the cycle runtime as part of the period or as an addition to it.
func collectMeasuredWaits(
	t *testing.T,
	schedule *scheduler.Schedule,
	cycles int,
	perCycle time.Duration,
) (*cadencePublisher, []time.Duration) {
	t.Helper()
	publisher := newCadencePublisher()
	clock := newAdvancingClock(time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC))
	publishing := &timedPublisher{cadencePublisher: publisher, clock: clock, perCycle: perCycle}
	seam := newCadenceSeam()
	runner := New(testSource(), publishing, Options{
		Zones:    []string{"valparaiso-demo"},
		Schedule: schedule,
		After:    seam.after,
		Now:      clock.now,
		NewID:    func() string { return "cadence-id" },
	})

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	stopped := make(chan struct{})
	go func() {
		runner.Start(ctx)
		close(stopped)
	}()

	// Start runs the first cycle immediately: it must not wait before publishing.
	waitFor(t, "the first cycle", func() bool { return publisher.count() == 1 })

	for cycle := 1; cycle <= cycles; cycle++ {
		select {
		case <-seam.ready:
		case <-time.After(10 * time.Second):
			t.Fatalf("the runner did not request automatic cycle %d", cycle+1)
		}
		// Unblock the wait the runner is blocked on. The zero instant is enough:
		// the runner's own clock decides every timestamp, which is the hook this
		// test is preserving.
		seam.ticks <- time.Time{}
		want := cycle + 1
		waitFor(t, "the next automatic cycle", func() bool { return publisher.count() == want })
	}

	cancel()
	select {
	case <-stopped:
	case <-time.After(10 * time.Second):
		t.Fatal("Start did not return after its context was cancelled")
	}
	return publisher, seam.waits()
}

// waitFor polls a condition with a deadline instead of sleeping a fixed span, so
// the test is deterministic without depending on scheduler timing.
func waitFor(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(time.Millisecond)
	}
}
