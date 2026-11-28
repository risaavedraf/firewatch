package scheduler

import (
	"reflect"
	"testing"
	"time"

	observations "firewatch.local/contracts/observations/v1"
	"firewatch.local/risk/internal/source"
)

// S2: the cadence the contract fixes is 15m0s (900s) with at most 30s of jitter.
//
// The pinning against internal/cycle lives in that package's own test: cycle
// imports this one, so a test of this package cannot import cycle without creating
// an import cycle, and the dependency must keep pointing one way.
func TestNominalCadenceIsFifteenMinutes(t *testing.T) {
	if NominalInterval != 15*time.Minute {
		t.Fatalf("nominal interval = %v, want 15m0s", NominalInterval)
	}
	if NominalInterval.Seconds() != 900 {
		t.Fatalf("nominal interval = %vs, want 900s", NominalInterval.Seconds())
	}
	if MaxJitter != 30*time.Second {
		t.Fatalf("jitter bound = %v, want 30s", MaxJitter)
	}
	if DefaultSeed != 42 {
		t.Fatalf("default seed = %d, want 42", DefaultSeed)
	}
}

// S2: a default schedule ticks sequentially, every interval stays inside 900s
// ± 30s, the whole series averages the nominal period, and two runs of the same
// simulated clock produce the same instants.
func TestDefaultScheduleTicksSequentiallyWithinTheAgreedTolerance(t *testing.T) {
	schedule := New(Options{})
	start := time.Date(2026, 11, 28, 12, 0, 0, 0, time.UTC)

	ticks := schedule.Ticks(start, 12)
	if len(ticks) != 12 {
		t.Fatalf("ticks = %d, want 12", len(ticks))
	}
	if !ticks[0].Equal(start) {
		t.Fatalf("first tick = %v, want the start instant %v", ticks[0], start)
	}
	for index := 1; index < len(ticks); index++ {
		if !ticks[index].After(ticks[index-1]) {
			t.Fatalf("tick %d (%v) is not after tick %d (%v)", index, ticks[index], index-1, ticks[index-1])
		}
		gap := ticks[index].Sub(ticks[index-1])
		if !schedule.WithinTolerance(gap) {
			t.Fatalf("gap %d = %v, outside %v ± %v", index, gap, NominalInterval, MaxJitter)
		}
		if gap < NominalInterval-MaxJitter || gap > NominalInterval+MaxJitter {
			t.Fatalf("gap %d = %v, outside the agreed 870s..930s band", index, gap)
		}
	}

	// The jitter is per interval and is not compensated, so the cadence is asserted
	// per gap and on average -never as an absolute phase, which no contract fixed.
	cycles := time.Duration(len(ticks) - 1)
	average := ticks[len(ticks)-1].Sub(ticks[0]) / cycles
	if drift := average - NominalInterval; drift > MaxJitter || drift < -MaxJitter {
		t.Fatalf("average interval over %d cycles = %v, want %v ± %v", cycles, average, NominalInterval, MaxJitter)
	}

	if !reflect.DeepEqual(ticks, schedule.Ticks(start, 12)) {
		t.Fatal("the same schedule produced two different tick series")
	}
	if !reflect.DeepEqual(ticks, New(Options{}).Ticks(start, 12)) {
		t.Fatal("two default schedules produced different tick series")
	}
}

// S2: the jitter is seeded, not taken from the clock, so a different seed gives a
// different series that still respects the same bound.
func TestScheduleJitterIsSeededNotRandom(t *testing.T) {
	start := time.Date(2026, 11, 28, 12, 0, 0, 0, time.UTC)
	defaultTicks := New(Options{}).Ticks(start, 8)
	otherTicks := New(Options{Seed: 7}).Ticks(start, 8)

	if reflect.DeepEqual(defaultTicks, otherTicks) {
		t.Fatal("seed 7 produced the same tick series as the default seed")
	}
	for index := 1; index < len(otherTicks); index++ {
		gap := otherTicks[index].Sub(otherTicks[index-1])
		if gap < NominalInterval-MaxJitter || gap > NominalInterval+MaxJitter {
			t.Fatalf("seeded gap %d = %v, outside the agreed band", index, gap)
		}
	}
}

// S2: the bound is a contract, so an over-large or negative jitter request is
// clamped instead of trusted, and an empty configuration is the nominal cadence.
func TestScheduleClampsJitterAndFallsBackToTheNominalInterval(t *testing.T) {
	cases := []struct {
		name         string
		options      Options
		wantInterval time.Duration
		wantJitter   time.Duration
		wantSeed     uint64
	}{
		{
			name:         "sin configuración",
			options:      Options{},
			wantInterval: NominalInterval,
			wantJitter:   MaxJitter,
			wantSeed:     DefaultSeed,
		},
		{
			name:         "jitter por encima del límite",
			options:      Options{Jitter: 5 * time.Minute},
			wantInterval: NominalInterval,
			wantJitter:   MaxJitter,
			wantSeed:     DefaultSeed,
		},
		{
			name:         "jitter negativo sin jitter",
			options:      Options{Jitter: -time.Minute},
			wantInterval: NominalInterval,
			wantJitter:   0,
			wantSeed:     DefaultSeed,
		},
		{
			name:         "intervalo inválido cae al nominal",
			options:      Options{Interval: -time.Minute, Jitter: time.Second, Seed: 7},
			wantInterval: NominalInterval,
			wantJitter:   time.Second,
			wantSeed:     7,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			schedule := New(testCase.options)
			if schedule.Interval() != testCase.wantInterval {
				t.Fatalf("interval = %v, want %v", schedule.Interval(), testCase.wantInterval)
			}
			if schedule.Jitter() != testCase.wantJitter {
				t.Fatalf("jitter = %v, want %v", schedule.Jitter(), testCase.wantJitter)
			}
			if schedule.Seed() != testCase.wantSeed {
				t.Fatalf("seed = %d, want %d", schedule.Seed(), testCase.wantSeed)
			}
		})
	}
}

// S2: with the jitter explicitly disabled the schedule is exactly the nominal
// grid, so the cycle instants themselves can be asserted and not only their gaps.
func TestScheduleWithoutJitterIsTheNominalGrid(t *testing.T) {
	schedule := New(Options{Jitter: disableJitter})
	start := time.Date(2026, 11, 28, 12, 0, 0, 0, time.UTC)

	ticks := schedule.Ticks(start, 5)
	for index, tick := range ticks {
		want := start.Add(time.Duration(index) * NominalInterval)
		if !tick.Equal(want) {
			t.Fatalf("tick %d = %v, want %v", index, tick, want)
		}
	}
}

// S2 and S3 together: over a simulated clock, sequential 15-minute cycles keep a
// refreshed source fresh, and stop doing so as soon as the source's cutoff falls
// behind -fresh at one cycle, degraded at two, stale and STALE_CUTOFF beyond the
// second.
func TestScheduleDrivesSequentialCyclesAndFreshnessTransitions(t *testing.T) {
	start := time.Date(2026, 11, 28, 12, 0, 0, 0, time.UTC)
	schedule := New(Options{Jitter: disableJitter, Seed: DefaultSeed})
	ticks := schedule.Ticks(start, 4)

	refreshedProvider, err := source.NewSeededFixtureProvider(source.FixtureSeed, start)
	if err != nil {
		t.Fatalf("seeded fixture: %v", err)
	}
	frozenSet := mustFetch(t, refreshedProvider)

	// A source that refreshes every cycle never leaves the fresh band.
	for index, tick := range ticks {
		if index == 0 {
			continue
		}
		refreshedProvider, err = source.NewSeededFixtureProvider(source.FixtureSeed, tick)
		if err != nil {
			t.Fatalf("seeded fixture for tick %d: %v", index, err)
		}
		set := mustFetch(t, refreshedProvider)
		status := source.EvaluateFreshness(set.Provenance, tick)
		if status.Level != source.FreshnessFresh {
			t.Fatalf("tick %d: refreshed source reported %q, want %q", index, status.Level, source.FreshnessFresh)
		}
	}

	// A source that stops refreshing walks the bands in order.
	wantLevels := []source.Freshness{
		source.FreshnessFresh,    // age 0s
		source.FreshnessFresh,    // age 900s: the closed fresh boundary
		source.FreshnessDegraded, // age 1800s: the closed degraded boundary
		source.FreshnessStale,    // age 2700s: beyond two cycles
	}
	wantAges := []time.Duration{0, 15 * time.Minute, 30 * time.Minute, 45 * time.Minute}
	for index, tick := range ticks {
		status := source.EvaluateFreshness(frozenSet.Provenance, tick)
		if status.Level != wantLevels[index] {
			t.Fatalf("tick %d (age %v): level = %q, want %q", index, status.Age, status.Level, wantLevels[index])
		}
		if status.Age != wantAges[index] {
			t.Fatalf("tick %d: age = %v, want %v", index, status.Age, wantAges[index])
		}
		hasStaleFinding := status.HasFinding(source.FindingStaleCutoff)
		if wantStaleFinding := wantLevels[index] == source.FreshnessStale; hasStaleFinding != wantStaleFinding {
			t.Fatalf("tick %d: STALE_CUTOFF = %v, want %v", index, hasStaleFinding, wantStaleFinding)
		}
	}

	// The same walk with the agreed jitter still lands in the bands in order: the
	// 30s tolerance may move an instant, never the band sequence, so a cycle never
	// reports a fresher band than the one before it.
	jittered := New(Options{})
	for index, tick := range jittered.Ticks(start, 4) {
		if index == 0 {
			continue
		}
		status := source.EvaluateFreshness(frozenSet.Provenance, tick)
		if severity(status.Level) < severity(wantLevels[index-1]) {
			t.Fatalf("tick %d: level %q fell behind the previous band", index, status.Level)
		}
	}
}

// disableJitter is how a test asks for the exact nominal grid: a negative value
// is the documented opt-out, because zero means the agreed default of MaxJitter.
const disableJitter = -time.Second

func mustFetch(t *testing.T, provider source.Provider) observations.ObservationSet {
	t.Helper()
	set, err := provider.Fetch(t.Context(), observations.Window{})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	return set
}

func severity(level source.Freshness) int {
	switch level {
	case source.FreshnessFresh:
		return 0
	case source.FreshnessDegraded:
		return 1
	case source.FreshnessStale:
		return 2
	default:
		return -1
	}
}
