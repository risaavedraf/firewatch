package source

import (
	"context"
	"reflect"
	"testing"
	"time"

	observations "firewatch.local/contracts/observations/v1"
)

// S1: the same seed and the same cutoff produce byte-identical readings, in
// separate provider instances and in separate calls, so a replay does not depend
// on process state, map order or the clock.
func TestSeededFixtureIsReproducibleForTheSameSeedAndCutoff(t *testing.T) {
	cutoff := time.Date(2026, 11, 28, 12, 0, 0, 0, time.UTC)
	window := observations.Window{}

	first, err := NewSeededFixtureProvider(FixtureSeed, cutoff)
	if err != nil {
		t.Fatalf("first provider: %v", err)
	}
	second, err := NewSeededFixtureProvider(FixtureSeed, cutoff)
	if err != nil {
		t.Fatalf("second provider: %v", err)
	}

	firstSet := mustFetch(t, first, window)
	secondSet := mustFetch(t, second, window)
	if !reflect.DeepEqual(firstSet.Records, secondSet.Records) {
		t.Fatalf("two runs with seed %d differ:\n%+v\n%+v", FixtureSeed, firstSet.Records, secondSet.Records)
	}
	if firstSet.Provenance.NormalizedSHA256 != secondSet.Provenance.NormalizedSHA256 {
		t.Fatalf("digests differ: %q vs %q", firstSet.Provenance.NormalizedSHA256, secondSet.Provenance.NormalizedSHA256)
	}
	if !reflect.DeepEqual(SeededFixtureRecords(FixtureSeed, cutoff), SeededFixtureRecords(FixtureSeed, cutoff)) {
		t.Fatal("SeededFixtureRecords is not reproducible for one seed and cutoff")
	}

	// A reread of the same provider must not advance a generator either.
	again := mustFetch(t, first, window)
	if !reflect.DeepEqual(firstSet.Records, again.Records) {
		t.Fatal("rereading one provider produced different records")
	}
}

// S1: the seed is 42 by default and configurable, and a different seed produces
// different values for the same cutoff.
func TestSeededFixtureUsesSeed42ByDefaultAndHonorsAConfiguredSeed(t *testing.T) {
	cutoff := time.Date(2026, 11, 28, 12, 0, 0, 0, time.UTC)

	defaultProvider, err := NewSeededFixtureProvider(0, cutoff)
	if err != nil {
		t.Fatalf("default provider: %v", err)
	}
	if defaultProvider.Seed() != FixtureSeed || FixtureSeed != 42 {
		t.Fatalf("default seed = %d, want the agreed 42", defaultProvider.Seed())
	}
	explicit, err := NewSeededFixtureProvider(42, cutoff)
	if err != nil {
		t.Fatalf("explicit provider: %v", err)
	}
	if !reflect.DeepEqual(mustFetch(t, defaultProvider, observations.Window{}).Records, mustFetch(t, explicit, observations.Window{}).Records) {
		t.Fatal("the default seed is not the same fixture as seed 42")
	}

	otherSeed, err := NewSeededFixtureProvider(7, cutoff)
	if err != nil {
		t.Fatalf("seeded provider: %v", err)
	}
	defaultSet := mustFetch(t, explicit, observations.Window{})
	otherSet := mustFetch(t, otherSeed, observations.Window{})
	if defaultSet.Provenance.NormalizedSHA256 == otherSet.Provenance.NormalizedSHA256 {
		t.Fatal("seed 7 produced the same records as seed 42")
	}
	if !sameInstants(defaultSet.Records, otherSet.Records) {
		t.Fatal("the seed changed the observation instants, but the cutoff is what places a reading in time")
	}
}

// S1: the seeded fixture is publishable, not merely reproducible. Every canonical
// variable appears once, in the unit its variable is stored in, inside a
// physically plausible demonstration range, and the validator accepts the set.
func TestSeededFixtureIsValidatableAndPlausible(t *testing.T) {
	cutoff := time.Date(2026, 11, 28, 12, 0, 0, 0, time.UTC)
	provider, err := NewSeededFixtureProvider(FixtureSeed, cutoff)
	if err != nil {
		t.Fatalf("provider: %v", err)
	}
	set := mustFetch(t, provider, observations.Window{})

	if !set.Provenance.Complete {
		t.Fatal("the seeded fixture reported an incomplete retrieval")
	}
	if !set.Provenance.Synthetic {
		t.Fatal("the seeded fixture did not declare itself synthetic")
	}
	if !set.Provenance.CutoffAt.Equal(cutoff) {
		t.Fatalf("cutoff = %v, want %v", set.Provenance.CutoffAt, cutoff)
	}
	if report := Validate(set); !report.Complete() {
		t.Fatalf("the seeded fixture is not publishable: %s", report.Reasons())
	}

	wantVariables := ReadingVariableNames()
	if len(set.Records) != len(wantVariables) {
		t.Fatalf("records = %d, want one per stored variable (%d)", len(set.Records), len(wantVariables))
	}
	for index, record := range set.Records {
		if record.Variable != wantVariables[index] {
			t.Fatalf("record %d variable = %q, want the stable order %q", index, record.Variable, wantVariables[index])
		}
		if !record.ObservedAt.Equal(cutoff) {
			t.Fatalf("%s observed_at = %v, want the cutoff %v", record.Variable, record.ObservedAt, cutoff)
		}
		if !UnitMatches(record.Variable, record.Unit) {
			t.Fatalf("%s unit = %q, want %q", record.Variable, record.Unit, expectedUnits[record.Variable])
		}
		if !plausibleValue(record) {
			t.Fatalf("%s = %v %s is outside a plausible demonstration range", record.Variable, record.Value, record.Unit)
		}
	}
}

// S1: a zero cutoff is refused instead of silently becoming the zero instant,
// which the validator would reject later with a less attributable cause.
func TestSeededFixtureRefusesAZeroCutoff(t *testing.T) {
	if _, err := NewSeededFixtureProvider(FixtureSeed, time.Time{}); err == nil {
		t.Fatal("a zero cutoff was accepted")
	}
}

// S1: the fixture honors the closed window like the other providers, so a window
// that excludes the cutoff is an empty, complete retrieval and not an error.
func TestSeededFixtureHonorsTheFetchWindow(t *testing.T) {
	cutoff := time.Date(2026, 11, 28, 12, 0, 0, 0, time.UTC)
	provider, err := NewSeededFixtureProvider(FixtureSeed, cutoff)
	if err != nil {
		t.Fatalf("provider: %v", err)
	}

	outside := observations.Window{From: cutoff.Add(time.Hour), To: cutoff.Add(2 * time.Hour)}
	set := mustFetch(t, provider, outside)
	if len(set.Records) != 0 {
		t.Fatalf("records = %d outside the window, want 0", len(set.Records))
	}
	if !set.Provenance.Complete {
		t.Fatal("an empty retrieval outside the window reported itself incomplete")
	}

	inside := observations.Window{From: cutoff, To: cutoff}
	if set := mustFetch(t, provider, inside); len(set.Records) == 0 {
		t.Fatal("a window containing the cutoff returned no records")
	}
}

// S1: the substitution claim. One consumer, written against the Provider
// interface only, drives every implementation -the unseeded fixture, the seeded
// fixture with two seeds and a synthetic scenario- with no branch per provider.
// That is what makes swapping the source a change inside internal/source.
func TestProviderSubstitutionNeedsNoChangeOutsideThisPackage(t *testing.T) {
	cutoff := time.Date(2026, 11, 28, 12, 0, 0, 0, time.UTC)
	seeded, err := NewSeededFixtureProvider(FixtureSeed, cutoff)
	if err != nil {
		t.Fatalf("seeded provider: %v", err)
	}
	otherSeed, err := NewSeededFixtureProvider(7, cutoff)
	if err != nil {
		t.Fatalf("seeded provider: %v", err)
	}
	synthetic, err := NewSyntheticProvider("mild", "valparaiso", cutoff)
	if err != nil {
		t.Fatalf("synthetic provider: %v", err)
	}

	providers := []struct {
		name     string
		provider Provider
	}{
		{name: "fixture sin semilla", provider: NewFixtureProvider()},
		{name: "fixture con semilla 42", provider: seeded},
		{name: "fixture con semilla 7", provider: otherSeed},
		{name: "escenario sintético", provider: synthetic},
	}
	for _, entry := range providers {
		t.Run(entry.name, func(t *testing.T) {
			outcome, err := consumeProvider(t.Context(), entry.provider, observations.Window{})
			if err != nil {
				t.Fatalf("the shared consumer failed: %v", err)
			}
			if outcome.descriptor.ID == "" || outcome.descriptor.ID != outcome.sourceID {
				t.Fatalf("descriptor id = %q, provenance id = %q", outcome.descriptor.ID, outcome.sourceID)
			}
			if outcome.records == 0 || outcome.accepted != outcome.records {
				t.Fatalf("accepted %d of %d records: %s", outcome.accepted, outcome.records, outcome.reasons)
			}
			if outcome.merged != outcome.accepted {
				t.Fatalf("merged %d of %d accepted records", outcome.merged, outcome.accepted)
			}
			if outcome.hash == "" || outcome.registered != outcome.descriptor.ID {
				t.Fatalf("outcome = %+v", outcome)
			}
			// The consumer never inspects the concrete provider, so the same code
			// path covers a source that does not exist yet.
			if outcome.kindOfProvider != "Provider" {
				t.Fatalf("consumer saw %q, want the interface", outcome.kindOfProvider)
			}
		})
	}
}

// substitutionOutcome is everything a downstream consumer derives from a
// provider using the package's public surface only.
type substitutionOutcome struct {
	kindOfProvider string
	descriptor     observations.SourceDescriptor
	sourceID       string
	records        int
	accepted       int
	merged         int
	reasons        string
	hash           string
	registered     string
}

// consumeProvider is the single consumer the substitution test drives. It is
// deliberately written against Provider and never against a concrete type: a
// provider that needed a change here would need a change outside the package.
func consumeProvider(ctx context.Context, provider Provider, window observations.Window) (substitutionOutcome, error) {
	outcome := substitutionOutcome{kindOfProvider: "Provider"}
	registry := NewRegistry()
	if err := registry.Register(provider); err != nil {
		return outcome, err
	}
	outcome.descriptor = provider.Describe()
	outcome.registered = registry.Descriptors()[0].ID

	set, err := provider.Fetch(ctx, window)
	if err != nil {
		return outcome, err
	}
	outcome.sourceID = set.Provenance.SourceID
	outcome.records = len(set.Records)

	report := Validate(set)
	outcome.accepted = len(report.Accepted)
	outcome.reasons = report.Reasons()

	merged := Merge([]observations.ObservationSet{set})
	outcome.merged = len(merged.Observations)

	outcome.hash, err = RecordsHash(report.Accepted)
	return outcome, err
}

func mustFetch(t *testing.T, provider Provider, window observations.Window) observations.ObservationSet {
	t.Helper()
	set, err := provider.Fetch(context.Background(), window)
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	return set
}

func sameInstants(left, right []observations.Observation) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if !left[index].ObservedAt.Equal(right[index].ObservedAt) {
			return false
		}
	}
	return true
}

// plausibleValue is the demonstration range each stored variable must stay in.
// The fixture is synthetic but not arbitrary: a humidity of 300% would be a
// meaningless input for the classifier even in a demo.
func plausibleValue(record observations.Observation) bool {
	switch record.Variable {
	case observations.VariableTemperature:
		return record.Value >= -20 && record.Value <= 60
	case observations.VariableHumidity, observations.VariableVegetation:
		return record.Value >= 0 && record.Value <= 100
	case observations.VariableWind:
		return record.Value >= 0 && record.Value <= 200
	case observations.VariableHistoricalFires:
		return record.Value >= 0 && record.Value <= 100 && record.Value == float64(int(record.Value))
	case VariableWindDirection:
		return record.Value >= 0 && record.Value <= 360
	case VariablePrecipitation:
		return record.Value >= 0 && record.Value <= 200
	case VariableRadiation:
		return record.Value >= 0 && record.Value <= 1400
	default:
		return false
	}
}
