package source

import (
	"context"
	"errors"
	"math"
	"math/rand/v2"
	"strconv"
	"time"

	observations "firewatch.local/contracts/observations/v1"
)

// FixtureSeed is the seed the reproducible fixture uses when none is configured.
// It is the value the owner ratified, and it is a constant rather than a default
// buried in a constructor so a test can name the run it reproduces.
const FixtureSeed int64 = 42

// seededFixtureSourceID is the identifier of the seeded sample. It is distinct
// from "fixture-sample" on purpose: two sources with different content must never
// share an identifier, because provenance and precedence are keyed by it.
const seededFixtureSourceID = "fixture-seeded"

// seededFixtureZone is where the seeded sample is placed. The demo label is a
// spatial placeholder, not a measurement, and the validator accepts it.
const seededFixtureZone = "valparaiso"

// seededRange is the plausible demonstration range of one stored variable.
//
// The range exists because a seeded generator can produce a physically absurd
// reading -a humidity of 300%- and the validator checks units and dates but not
// plausibility. Bounding the range here keeps the sample usable for a
// demonstration classification without pretending to be calibrated data.
type seededRange struct {
	min      float64
	max      float64
	decimals int
	// integer marks a variable that is a count or a degree: a fractional count of
	// historical fires or a fractional wind direction is a defect, not precision.
	integer bool
}

// seededRanges declares the range of every stored variable. A variable absent
// from this table is not emitted by the seeded fixture: inventing values outside
// a declared range would be worse than reporting the variable as missing, which
// the validator already does.
var seededRanges = map[string]seededRange{
	observations.VariableTemperature:     {min: 5, max: 40, decimals: 1},
	observations.VariableHumidity:        {min: 10, max: 95, decimals: 1},
	observations.VariableWind:            {min: 0, max: 90, decimals: 1},
	observations.VariableVegetation:      {min: 5, max: 95, decimals: 1},
	observations.VariableHistoricalFires: {min: 0, max: 12, integer: true},
	VariableWindDirection:                {min: 0, max: 360, integer: true},
	VariablePrecipitation:                {min: 0, max: 25, decimals: 1},
	VariableRadiation:                    {min: 0, max: 1100, decimals: 1},
}

// SeededFixtureProvider serves a synthetic sample whose values are decided by a
// seed and whose instants are decided by a cutoff. Two runs with the same seed and
// the same cutoff produce identical readings, in this process and in any other,
// so a demonstration or a regression can be replayed instead of re-rolled.
//
// It is a Provider like any other: substituting it for the unseeded fixture or for
// a real source requires no change outside this package.
type SeededFixtureProvider struct {
	seed   int64
	cutoff time.Time
}

var _ Provider = SeededFixtureProvider{}

// NewSeededFixtureProvider builds the reproducible sample. A zero seed means
// FixtureSeed, which keeps the zero value of the seed usable; a zero cutoff is
// refused, because an instant nobody chose would make the "reproducible" claim
// meaningless.
func NewSeededFixtureProvider(seed int64, cutoff time.Time) (SeededFixtureProvider, error) {
	if cutoff.IsZero() {
		return SeededFixtureProvider{}, errors.New("seeded fixture requires an explicit cutoff instant")
	}
	return SeededFixtureProvider{seed: normalizeSeed(seed), cutoff: cutoff.UTC()}, nil
}

// Seed returns the effective seed, so a report can name the run it reproduces.
func (p SeededFixtureProvider) Seed() int64 { return p.seed }

// Cutoff returns the instant the sample covers.
func (p SeededFixtureProvider) Cutoff() time.Time { return p.cutoff }

// Describe implements Provider. The descriptor declares the sample synthetic, so
// the persisted demo flag still derives from the source rather than from the
// caller.
func (p SeededFixtureProvider) Describe() observations.SourceDescriptor {
	return observations.SourceDescriptor{
		ID:               seededFixtureSourceID,
		DisplayName:      "Muestra sintética reproducible con semilla",
		Kind:             observations.SourceKindFile,
		Origin:           observations.OriginPublicOfficial,
		Endpoint:         "builtin://fixture-seeded/v1?seed=" + strconv.FormatInt(p.seed, 10),
		License:          "N/A (datos sintéticos de demostración)",
		Attribution:      "FireWatch (2026). Muestra sintética reproducible con semilla. No contiene observaciones reales.",
		Variables:        ReadingVariableNames(),
		GeoCoverage:      "Región de Valparaíso (muestra sintética)",
		TemporalCoverage: "instantánea del cutoff declarado",
		Cadence:          "manual",
		Purpose:          "Reproducir una corrida con semilla fija sin datos reales",
		// The same priority as the unseeded sample: it must never outrank a real
		// source inside the same origin.
		Priority:  100,
		Synthetic: true,
	}
}

// Fetch implements Provider with the same closed-window semantics as
// FixtureProvider: a window that excludes the cutoff is a successful, complete,
// empty retrieval rather than an error.
func (p SeededFixtureProvider) Fetch(
	ctx context.Context,
	window observations.Window,
) (observations.ObservationSet, error) {
	if err := ctx.Err(); err != nil {
		return observations.ObservationSet{}, err
	}
	if p.cutoff.IsZero() {
		// A provider built as a zero value has no cutoff, and returning records at
		// the zero instant would make the validator the place that discovers it.
		return observations.ObservationSet{}, errors.New("seeded fixture has no cutoff instant")
	}

	records := SeededFixtureRecords(p.seed, p.cutoff)
	if !window.From.IsZero() || !window.To.IsZero() {
		filtered := make([]observations.Observation, 0, len(records))
		for _, record := range records {
			if !window.From.IsZero() && record.ObservedAt.Before(window.From) {
				continue
			}
			if !window.To.IsZero() && record.ObservedAt.After(window.To) {
				continue
			}
			filtered = append(filtered, record)
		}
		records = filtered
	}

	digest, err := RecordsHash(records)
	if err != nil {
		return observations.ObservationSet{}, err
	}
	seed := strconv.FormatInt(p.seed, 10)
	provenance := ProvenanceFrom(p.Describe())
	provenance.QueryFingerprint = "builtin:fixture-seeded/v1?seed=" + seed +
		"&cutoff_at=" + p.cutoff.Format(time.RFC3339Nano)
	provenance.RetrievedAt = p.cutoff
	provenance.CutoffAt = p.cutoff
	provenance.Format = "builtin"
	provenance.Records = len(records)
	provenance.NormalizedSHA256 = digest
	// No payload crossed a network boundary, so PayloadSHA256 stays empty and
	// HTTPStatus is not applicable; both are documented on the contract rather than
	// faked here.
	provenance.Complete = true

	return observations.ObservationSet{
		Window:     window,
		Records:    records,
		Provenance: provenance,
	}, nil
}

// SeededFixtureRecords returns the reproducible sample: one record per stored
// variable, in the stable order of ReadingVariableNames, all at the cutoff.
//
// The seed decides every value and the cutoff decides every instant, so the two
// inputs together identify the whole sample. The generator is created per call and
// never stored, which is what makes a reread of the same provider produce the same
// records instead of the next draw of a sequence.
func SeededFixtureRecords(seed int64, cutoff time.Time) []observations.Observation {
	effective := normalizeSeed(seed)
	// The two PCG words are derived from one seed so that a single number, the one
	// the report prints, fully determines the generator state.
	generator := rand.New(rand.NewPCG(uint64(effective), uint64(effective)+1))

	variables := ReadingVariableNames()
	records := make([]observations.Observation, 0, len(variables))
	for _, variable := range variables {
		valueRange, declared := seededRanges[variable]
		if !declared {
			continue
		}
		unit, hasUnit := ExpectedUnit(variable)
		if !hasUnit {
			continue
		}
		records = append(records, observations.Observation{
			SourceID:   seededFixtureSourceID,
			Variable:   variable,
			ZoneID:     seededFixtureZone,
			ObservedAt: cutoff.UTC(),
			Value:      valueRange.sample(generator),
			Unit:       unit,
			// Generated, not measured: the quality has to say so even in a demo.
			Quality: observations.QualityEstimated,
		})
	}
	return records
}

// sample draws one value inside the declared range, rounded to the precision the
// variable is stored with so two runs serialize identically.
func (r seededRange) sample(generator *rand.Rand) float64 {
	raw := r.min + (r.max-r.min)*generator.Float64()
	if r.integer {
		return math.Round(raw)
	}
	scale := math.Pow(10, float64(r.decimals))
	return math.Round(raw*scale) / scale
}

// normalizeSeed maps the zero seed to the ratified default, so an unset seed still
// produces a named, reproducible run.
func normalizeSeed(seed int64) int64 {
	if seed == 0 {
		return FixtureSeed
	}
	return seed
}

// Substituting a provider must not require a change outside this package: the
// unseeded sample, the seeded sample and the synthetic scenarios all satisfy
// Provider, so one consumer serves all three.
var (
	_ Provider = FixtureProvider{}
	_ Provider = SeededFixtureProvider{}
	_ Provider = SyntheticProvider{}
)
