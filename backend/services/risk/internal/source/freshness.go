package source

import (
	"fmt"
	"time"

	observations "firewatch.local/contracts/observations/v1"
)

// Freshness is the band a source's newest data falls into at one evaluation
// instant. The vocabulary is closed and has three members because the owner
// ratified three: a fourth state invented here would be a contract nobody agreed
// to.
type Freshness string

const (
	// FreshnessFresh means the data is inside one cycle: the age of the newest
	// coverage is at most FreshnessWarningAfter.
	FreshnessFresh Freshness = "fresh"

	// FreshnessDegraded means the data missed the first band but is still inside
	// two cycles. WARNING is the owner's other name for this same band, so
	// FreshnessWarning is an alias rather than a fourth level.
	FreshnessDegraded Freshness = "degraded"

	// FreshnessWarning is the ratified name for FreshnessDegraded. The two
	// constants are interchangeable on purpose: a report may print WARNING while
	// the wire value stays degraded, but neither may become its own level.
	FreshnessWarning = FreshnessDegraded

	// FreshnessStale means the newest data is older than two cycles. A stale
	// source is reported with the STALE_CUTOFF finding.
	FreshnessStale Freshness = "stale"
)

const (
	// FreshnessWarningAfter is the closed upper bound of the fresh band: an age of
	// exactly 15m0s (900 s) is still fresh.
	FreshnessWarningAfter = 15 * time.Minute

	// FreshnessStaleAfter is the closed upper bound of the degraded band: an age of
	// exactly 30m0s (1800 s), two cycles, is still degraded, and one second more
	// is stale.
	FreshnessStaleAfter = 30 * time.Minute

	// FindingStaleCutoff is the finding a stale source raises. It names the field
	// that makes it stale -the cutoff the data covers- so an operator can act on
	// the source instead of on the classifier.
	FindingStaleCutoff = "STALE_CUTOFF"
)

// Finding is one machine-readable observation about a source's freshness. Code is
// the closed identifier an operator or a dashboard reacts to, and Detail explains
// this particular evaluation.
type Finding struct {
	Code   string
	Detail string
}

// FreshnessStatus is the evaluated freshness of one source at one instant.
//
// Age is measured from Provenance.CutoffAt, which is the period the data covers,
// and never from RetrievedAt, which is only when the system asked. A retrieval
// made a second ago whose content is two hours old is stale, and reporting it as
// fresh would be the exact misreading the freshness rules exist to prevent.
//
// The struct carries no JSON tags: mapping it into the API's shape belongs to the
// handler, and encoding a time.Duration directly would publish a field whose unit
// a client cannot know.
type FreshnessStatus struct {
	Level       Freshness
	Age         time.Duration
	CutoffAt    time.Time
	EvaluatedAt time.Time
	Findings    []Finding
}

// HasFinding reports whether the status carries the given finding code.
func (s FreshnessStatus) HasFinding(code string) bool {
	for _, finding := range s.Findings {
		if finding.Code == code {
			return true
		}
	}
	return false
}

// FindingCodes returns the finding codes in their stable order. The slice is a
// copy, so a caller cannot mutate the status through it.
func (s FreshnessStatus) FindingCodes() []string {
	codes := make([]string, 0, len(s.Findings))
	for _, finding := range s.Findings {
		codes = append(codes, finding.Code)
	}
	return codes
}

// EvaluateFreshness bands one retrieval's provenance at the given instant.
//
// A provenance that never recorded its cutoff is stale rather than fresh: with no
// cutoff there is no evidence of fresh data, and defaulting to fresh is the one
// mistake that would let an unattributed retrieval pass as usable. A cutoff ahead
// of the evaluation instant -a clock disagreement, not a look into the future- is
// fresh and raises no finding, because refusing it would report our clock, not
// the source.
func EvaluateFreshness(provenance observations.Provenance, evaluatedAt time.Time) FreshnessStatus {
	at := evaluatedAt.UTC()
	status := FreshnessStatus{
		CutoffAt:    provenance.CutoffAt,
		EvaluatedAt: at,
		Findings:    []Finding{},
	}
	if provenance.CutoffAt.IsZero() {
		status.Level = FreshnessStale
		status.Findings = append(status.Findings, Finding{
			Code:   FindingStaleCutoff,
			Detail: "cutoff_at is not recorded, so the age of the data cannot be established",
		})
		return status
	}

	status.Age = at.Sub(provenance.CutoffAt.UTC())
	status.Level, status.Findings = evaluateAge(status.Age)
	return status
}

// evaluateAge is the band rule alone, separated so a caller holding an age and no
// provenance evaluates the same thresholds the provenance path uses.
func evaluateAge(age time.Duration) (Freshness, []Finding) {
	findings := []Finding{}
	switch {
	case age > FreshnessStaleAfter:
		findings = append(findings, Finding{
			Code: FindingStaleCutoff,
			Detail: fmt.Sprintf(
				"cutoff_at is %s old, beyond the %s stale threshold",
				age.Round(time.Second),
				FreshnessStaleAfter,
			),
		})
		return FreshnessStale, findings
	case age > FreshnessWarningAfter:
		return FreshnessDegraded, findings
	default:
		// This branch also covers a negative age: a cutoff ahead of the evaluation
		// instant is a clock disagreement and not stale data.
		return FreshnessFresh, findings
	}
}
