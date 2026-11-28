package source

import (
	"reflect"
	"testing"
	"time"

	observations "firewatch.local/contracts/observations/v1"
)

// S3: the agreed bands are closed intervals and their thresholds are the ones the
// owner ratified, not arbitrary numbers a later edit can quietly move.
func TestFreshnessThresholdsAreTheAgreedValues(t *testing.T) {
	if FreshnessWarningAfter != 15*time.Minute {
		t.Fatalf("warning threshold = %v, want 15m0s", FreshnessWarningAfter)
	}
	if FreshnessWarningAfter.Seconds() != 900 {
		t.Fatalf("warning threshold = %vs, want 900s", FreshnessWarningAfter.Seconds())
	}
	if FreshnessStaleAfter != 30*time.Minute {
		t.Fatalf("stale threshold = %v, want 30m0s", FreshnessStaleAfter)
	}
	if FreshnessStaleAfter.Seconds() != 1800 {
		t.Fatalf("stale threshold = %vs, want 1800s (two cycles)", FreshnessStaleAfter.Seconds())
	}
	// WARNING and DEGRADED are the same band: the owner named both, so the two
	// constants must not drift into two levels.
	if FreshnessWarning != FreshnessDegraded {
		t.Fatalf("WARNING = %q and DEGRADED = %q, want the same band", FreshnessWarning, FreshnessDegraded)
	}
	if FindingStaleCutoff != "STALE_CUTOFF" {
		t.Fatalf("stale finding code = %q, want STALE_CUTOFF", FindingStaleCutoff)
	}
}

// S3: the bands are evaluated on the exact boundary instants the owner listed, so
// an age of 15m0s is still fresh and 30m1s is already stale.
func TestEvaluateFreshnessBandsTheAgreedBoundaries(t *testing.T) {
	cases := []struct {
		name      string
		age       time.Duration
		want      Freshness
		wantStale bool
	}{
		{name: "edad 0s", age: 0, want: FreshnessFresh},
		{name: "borde fresco 15m", age: 15 * time.Minute, want: FreshnessFresh},
		{name: "15m1s", age: 15*time.Minute + time.Second, want: FreshnessDegraded},
		{name: "borde degradado 30m", age: 30 * time.Minute, want: FreshnessDegraded},
		{name: "30m1s", age: 30*time.Minute + time.Second, want: FreshnessStale, wantStale: true},
		{name: "una hora atrasado", age: time.Hour, want: FreshnessStale, wantStale: true},
	}

	cutoff := time.Date(2026, 11, 28, 12, 0, 0, 0, time.UTC)
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			evaluatedAt := cutoff.Add(testCase.age)
			status := EvaluateFreshness(provenanceWithCutoff(cutoff, cutoff, true), evaluatedAt)

			if status.Level != testCase.want {
				t.Fatalf("level = %q, want %q", status.Level, testCase.want)
			}
			if status.Age != testCase.age {
				t.Fatalf("age = %v, want %v", status.Age, testCase.age)
			}
			if !status.CutoffAt.Equal(cutoff) || !status.EvaluatedAt.Equal(evaluatedAt) {
				t.Fatalf("status instants = %+v", status)
			}
			hasStaleFinding := status.HasFinding(FindingStaleCutoff)
			if hasStaleFinding != testCase.wantStale {
				t.Fatalf("STALE_CUTOFF finding = %v, want %v (findings %+v)", hasStaleFinding, testCase.wantStale, status.Findings)
			}
			// Only the stale band raises findings: a degraded source is reported by
			// its level, not by a finding nobody agreed on.
			if testCase.want != FreshnessStale && len(status.Findings) != 0 {
				t.Fatalf("band %q raised findings %+v", status.Level, status.Findings)
			}
			if testCase.wantStale {
				finding := status.Findings[0]
				if finding.Code != FindingStaleCutoff || finding.Detail == "" {
					t.Fatalf("finding = %+v, want a documented STALE_CUTOFF finding", finding)
				}
			}
		})
	}
}

// S3: the age is measured from cutoff_at, which is what the data covers, and not
// from retrieved_at, which is merely when the system asked. A source retrieved
// just now whose content is two hours old is stale.
func TestEvaluateFreshnessUsesTheCutoffNotTheRetrieval(t *testing.T) {
	now := time.Date(2026, 11, 28, 12, 0, 0, 0, time.UTC)
	staleCutoff := now.Add(-2 * time.Hour)

	status := EvaluateFreshness(provenanceWithCutoff(staleCutoff, now, true), now)
	if status.Level != FreshnessStale {
		t.Fatalf("level = %q with cutoff two hours old, want %q", status.Level, FreshnessStale)
	}
	if status.Age != 2*time.Hour {
		t.Fatalf("age = %v, want 2h measured from cutoff_at", status.Age)
	}
}

// S3: an unrecorded cutoff is not evidence of fresh data. Treating a zero cutoff
// as "no age" would let an unattributed retrieval pass as fresh, so it is stale
// and carries the same finding.
func TestEvaluateFreshnessRefusesAnUnrecordedCutoff(t *testing.T) {
	now := time.Date(2026, 11, 28, 12, 0, 0, 0, time.UTC)
	status := EvaluateFreshness(observations.Provenance{SourceID: "sin-cutoff"}, now)

	if status.Level != FreshnessStale {
		t.Fatalf("level = %q without a cutoff, want %q", status.Level, FreshnessStale)
	}
	if !status.HasFinding(FindingStaleCutoff) {
		t.Fatalf("findings = %+v, want STALE_CUTOFF", status.Findings)
	}
}

// S3: a cutoff ahead of the evaluation instant is a clock disagreement, not data
// from the future to be clamped into the stale band by accident.
func TestEvaluateFreshnessTreatsAFutureCutoffAsFresh(t *testing.T) {
	now := time.Date(2026, 11, 28, 12, 0, 0, 0, time.UTC)
	status := EvaluateFreshness(provenanceWithCutoff(now.Add(30*time.Second), now, true), now)

	if status.Level != FreshnessFresh {
		t.Fatalf("level = %q with a future cutoff, want %q", status.Level, FreshnessFresh)
	}
	if len(status.Findings) != 0 {
		t.Fatalf("findings = %+v, want none", status.Findings)
	}
}

// S3: findings are a closed vocabulary with a stable order, so the same input
// renders the same operator-facing list.
func TestFreshnessStatusReportsFindingsDeterministically(t *testing.T) {
	cutoff := time.Date(2026, 11, 28, 12, 0, 0, 0, time.UTC)
	now := cutoff.Add(time.Hour)

	first := EvaluateFreshness(provenanceWithCutoff(cutoff, now, true), now)
	second := EvaluateFreshness(provenanceWithCutoff(cutoff, now, true), now)
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("two evaluations differ:\n%+v\n%+v", first, second)
	}

	codes := first.FindingCodes()
	if len(codes) != 1 || codes[0] != FindingStaleCutoff {
		t.Fatalf("finding codes = %v, want [STALE_CUTOFF]", codes)
	}
	// The slice is a copy: a caller cannot mutate the status through it.
	codes[0] = "MUTATED"
	if !first.HasFinding(FindingStaleCutoff) {
		t.Fatal("mutating the returned codes changed the status")
	}
}

func provenanceWithCutoff(cutoff, retrievedAt time.Time, complete bool) observations.Provenance {
	return observations.Provenance{
		SourceID:    "fixture-sample",
		RetrievedAt: retrievedAt,
		CutoffAt:    cutoff,
		Complete:    complete,
	}
}
