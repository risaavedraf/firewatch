// Package scheduler owns the cadence of the automatic ingestion cycle: the
// nominal 15-minute period plus a bounded jitter derived from a seed.
//
// It fixes the numbers the contract promises and nothing else. What one cycle
// does -fetch, validate, classify, publish- is internal/cycle's job, and the two
// are pinned to each other by test rather than by a shared import, so this package
// stays a pure, clock-free calculation that a test can replay without sleeping.
//
// The jitter is applied per interval and is not compensated later: each gap is the
// nominal interval plus at most MaxJitter, and the series averages the nominal
// period. A caller that needs absolute phase would be asking for a different
// contract, and no such contract was agreed.
package scheduler

import (
	"math/rand/v2"
	"time"
)

const (
	// NominalInterval is the agreed cycle period: 15m0s, that is 900 s.
	NominalInterval = 15 * time.Minute

	// MaxJitter is the agreed bound on the jitter of one interval: 30 s. It is the
	// tolerance a simulated-clock test is allowed to observe, so no schedule may
	// exceed it.
	MaxJitter = 30 * time.Second

	// DefaultSeed is the seed a default schedule uses. It is the same 42 the
	// reproducible fixture uses, so one number reproduces a whole demonstration
	// run: values and instants.
	DefaultSeed uint64 = 42
)

// Options configures a Schedule. Every field is optional: the zero value is the
// agreed cadence, which is what production gets without configuration.
type Options struct {
	// Interval is the period between cycles. A value of zero or less means
	// NominalInterval.
	Interval time.Duration
	// Jitter is the largest deviation applied to one interval. It is clamped to
	// [0, MaxJitter]. Zero means MaxJitter, the agreed default, because the zero
	// value of Options is the cadence production gets without configuration; a
	// caller that wants the exact nominal grid asks for a negative value, which is
	// clamped to zero. The two settings are spelled differently on purpose: an
	// unset field and a deliberate opt-out must not be the same number.
	Jitter time.Duration
	// Seed decides the jitter sequence. Zero means DefaultSeed.
	Seed uint64
}

// Schedule is the cycle cadence. It is a value with no clock and no state, so two
// schedules built from the same options always produce the same instants.
type Schedule struct {
	interval time.Duration
	jitter   time.Duration
	seed     uint64
}

// New returns a schedule, clamping every option to the agreed contract instead of
// trusting it: a jitter larger than MaxJitter would silently break the tolerance
// the freshness rules rely on.
func New(options Options) Schedule {
	schedule := Schedule{
		interval: options.Interval,
		jitter:   options.Jitter,
		seed:     options.Seed,
	}
	if schedule.interval <= 0 {
		schedule.interval = NominalInterval
	}
	switch {
	case schedule.jitter < 0:
		// A negative value is the documented opt-out: no jitter at all.
		schedule.jitter = 0
	case schedule.jitter == 0:
		// Unset means the agreed default, not the absence of jitter.
		schedule.jitter = MaxJitter
	case schedule.jitter > MaxJitter:
		schedule.jitter = MaxJitter
	}
	if schedule.seed == 0 {
		schedule.seed = DefaultSeed
	}
	return schedule
}

// Interval returns the configured period between cycles.
func (s Schedule) Interval() time.Duration { return s.interval }

// Jitter returns the effective jitter bound.
func (s Schedule) Jitter() time.Duration { return s.jitter }

// Seed returns the effective seed. A report can print it to name the run it
// reproduces.
func (s Schedule) Seed() uint64 { return s.seed }

// WithinTolerance reports whether a gap between two consecutive cycles respects
// this schedule's cadence, that is whether it is the interval plus at most the
// jitter.
func (s Schedule) WithinTolerance(gap time.Duration) bool {
	lowest := s.interval - s.jitter
	highest := s.interval + s.jitter
	return gap >= lowest && gap <= highest
}

// Delay returns how long the cycle of the given ordinal waits after the previous
// one: the nominal interval plus that cycle's jitter. Ordinals start at 1, because
// the cycle that runs on startup is not a delay.
func (s Schedule) Delay(ordinal int) time.Duration {
	return s.interval + s.offset(ordinal)
}

// Next returns the instant of the cycle of the given ordinal, counted from the
// previous cycle. A live loop and a simulated series advance by this same rule,
// which is what keeps a cadence test honest about production.
func (s Schedule) Next(previous time.Time, ordinal int) time.Time {
	return previous.Add(s.Delay(ordinal))
}

// Ticks returns count cycle instants starting at start. The first tick is start
// itself -the cycle that runs immediately on startup- and every later tick is one
// interval plus that cycle's jitter after the previous one.
//
// The jitter of cycle n is a pure function of (seed, n), so the series is
// reproducible and the same schedule replays identically in a test and in the
// process.
func (s Schedule) Ticks(start time.Time, count int) []time.Time {
	if count <= 0 {
		return []time.Time{}
	}
	ticks := make([]time.Time, 0, count)
	ticks = append(ticks, start.UTC())
	for ordinal := 1; ordinal < count; ordinal++ {
		ticks = append(ticks, s.Next(ticks[len(ticks)-1], ordinal))
	}
	return ticks
}

// offset is the jitter of one cycle, in [-jitter, +jitter] and rounded to the
// millisecond so the instant is not an artefact of float arithmetic.
func (s Schedule) offset(ordinal int) time.Duration {
	if s.jitter == 0 {
		return 0
	}
	// A PCG generator seeded with the cycle ordinal: no wall clock, no global
	// state, and the same value on every platform.
	// A deliberate non-cryptographic generator: the jitter must be reproducible from
	// the seed and it carries no secret, so crypto/rand would make the cadence
	// unreplayable -the opposite of what the contract asks for.
	generator := rand.New(rand.NewPCG(s.seed, uint64(ordinal)))
	signedUnit := generator.Float64()*2 - 1
	offset := time.Duration(signedUnit * float64(s.jitter)).Round(time.Millisecond)
	if offset > s.jitter {
		return s.jitter
	}
	if offset < -s.jitter {
		return -s.jitter
	}
	return offset
}
