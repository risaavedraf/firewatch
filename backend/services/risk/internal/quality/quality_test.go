package quality

import (
	"reflect"
	"testing"
	"time"
)

// The catalogue is CLOSED: five codes, in the ratified order. A sixth code, a
// renamed one or a reordered list is the regression this table catches, because
// the contract, the service and the page all state the same closed set.
func TestCatalogIsTheRatifiedClosedSet(t *testing.T) {
	want := []Finding{
		"STALE_CUTOFF",
		"MISSING_CANONICAL_FACTOR",
		"OUT_OF_RANGE_CLAMPED",
		"CHECKSUM_VERIFIED",
		"SYNTHETIC_FALLBACK",
	}
	if got := Codes(); !reflect.DeepEqual(got, want) {
		t.Fatalf("codes = %v, want %v", got, want)
	}
	catalog := Catalog()
	if len(catalog) != len(want) {
		t.Fatalf("catalog has %d definitions, want %d", len(catalog), len(want))
	}
	seen := map[Finding]bool{}
	for index, definition := range catalog {
		if definition.Code != want[index] {
			t.Fatalf("catalog[%d].Code = %q, want %q", index, definition.Code, want[index])
		}
		if definition.Kind == "" || definition.Severity == "" || definition.Description == "" {
			t.Fatalf("catalog[%d] is incomplete: %+v", index, definition)
		}
		if definition.Severity != SeverityWarning && definition.Severity != SeverityInfo {
			t.Fatalf("catalog[%d].Severity = %q, want one of the two closed values", index, definition.Severity)
		}
		if seen[definition.Code] {
			t.Fatalf("catalog repeats %q", definition.Code)
		}
		seen[definition.Code] = true
	}
}

// The catalogue is a copy: a caller that sorted or truncated it must not be able
// to change what the next response publishes.
func TestCatalogIsACopy(t *testing.T) {
	catalog := Catalog()
	catalog[0] = Definition{Code: "INVENTED"}
	if Codes()[0] != StaleCutoff {
		t.Fatal("the catalogue was mutated through the returned slice")
	}
}

// Evaluate states every finding the evidence supports, in catalogue order, and
// never invents one. This is the deterministic table the handler relies on.
func TestEvaluateIsDeterministicAndOrderedByTheCatalog(t *testing.T) {
	for _, tc := range []struct {
		name     string
		evidence Evidence
		want     []Finding
	}{
		{
			name:     "a fresh, complete, verified, real source",
			evidence: Evidence{ChecksumVerified: true},
			want:     []Finding{ChecksumVerified},
		},
		{
			name:     "stale and synthetic",
			evidence: Evidence{Stale: true, ChecksumVerified: true, Synthetic: true},
			want:     []Finding{StaleCutoff, ChecksumVerified, SyntheticFallback},
		},
		{
			name:     "every finding at once keeps the catalogue order",
			evidence: Evidence{Stale: true, MissingFactors: []string{"viento"}, ClampedPriority: true, ChecksumVerified: true, Synthetic: true},
			want:     []Finding{StaleCutoff, MissingCanonicalFactor, OutOfRangeClamped, ChecksumVerified, SyntheticFallback},
		},
		{
			name:     "no evidence supports nothing",
			evidence: Evidence{},
			want:     []Finding{},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := Evaluate(tc.evidence)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("Evaluate = %v, want %v", got, tc.want)
			}
			// Deterministic: the same evidence answers the same list.
			if again := Evaluate(tc.evidence); !reflect.DeepEqual(again, got) {
				t.Fatalf("Evaluate is not deterministic: %v then %v", got, again)
			}
		})
	}
}

// Evaluate never returns nil: a JSON encoder would turn nil into `null`, and the
// contract publishes an array.
func TestEvaluateNeverReturnsNil(t *testing.T) {
	if got := Evaluate(Evidence{}); got == nil {
		t.Fatal("Evaluate returned nil, want an empty list")
	}
}

// The five canonical factors are the classifier's own vocabulary. Duplicating a
// second list in this package is what keeps the two from drifting.
func TestCanonicalFactorsAreTheClassifierVocabulary(t *testing.T) {
	want := []string{"temperatura", "humedad_relativa", "viento", "cobertura_vegetal", "incendios_historicos"}
	if got := CanonicalFactors(); !reflect.DeepEqual(got, want) {
		t.Fatalf("CanonicalFactors = %v, want %v", got, want)
	}
	var missing []string
	if got := MissingCanonicalFactors(want); len(got) != 0 {
		t.Fatalf("a complete source reports missing factors %v", got)
	}
	missing = MissingCanonicalFactors([]string{"temperatura", "viento"})
	if !reflect.DeepEqual(missing, []string{"humedad_relativa", "cobertura_vegetal", "incendios_historicos"}) {
		t.Fatalf("missing = %v", missing)
	}
	if got := MissingCanonicalFactors(nil); len(got) != len(want) {
		t.Fatalf("a source with no variables is missing %d factors, got %d", len(want), len(got))
	}
	// Case and padding are not a declaration of the canonical name.
	if got := MissingCanonicalFactors([]string{"Temperatura", " viento"}); len(got) != 5 {
		t.Fatalf("a non-canonical spelling covered a canonical factor: %v", got)
	}
}

// The freshness window is the cycle's, and the age is the source's own number: a
// reading exactly at the window is still fresh, one second past it is stale, and a
// source that never ran is stale rather than infinitely fresh.
func TestStaleUsesTheFreshnessWindowAndTheServedAge(t *testing.T) {
	now := time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)
	window := FreshnessWindow
	if window != 15*time.Minute {
		t.Fatalf("FreshnessWindow = %v, want the 15 minute cycle", window)
	}
	exact := window.Seconds()
	older := exact + 1
	fresher := exact - 1
	last := now.Add(-window)
	if Stale(nil, nil, now) != true {
		t.Fatal("a source that never ran is stale")
	}
	if Stale(&last, &exact, now) {
		t.Fatal("a reading exactly at the window is fresh")
	}
	if !Stale(&last, &older, now) {
		t.Fatal("a reading past the window is stale")
	}
	if Stale(&last, &fresher, now) {
		t.Fatal("a reading inside the window is fresh")
	}
	// Without the served age the timestamp decides; a future instant is not stale
	// and the subtraction must not be read as a huge positive age.
	future := now.Add(time.Minute)
	if Stale(&future, nil, now) {
		t.Fatal("a future instant is not a stale reading")
	}
	if !Stale(&last, nil, now.Add(time.Minute)) {
		t.Fatal("the timestamp decides when the service published no age")
	}
}

// A declared priority outside the nominal 0..100 range is bounded before it is
// served, and the finding records that it was bounded.
func TestBoundedPriorityClampsTheNominalRange(t *testing.T) {
	for _, tc := range []struct {
		declared, served int
		clamped          bool
	}{
		{declared: 100, served: 100, clamped: false},
		{declared: 0, served: 0, clamped: false},
		{declared: 55, served: 55, clamped: false},
		{declared: 150, served: 100, clamped: true},
		{declared: -1, served: 0, clamped: true},
	} {
		served, clamped := BoundedPriority(tc.declared)
		if served != tc.served || clamped != tc.clamped {
			t.Fatalf("BoundedPriority(%d) = (%d, %v), want (%d, %v)", tc.declared, served, clamped, tc.served, tc.clamped)
		}
	}
}
