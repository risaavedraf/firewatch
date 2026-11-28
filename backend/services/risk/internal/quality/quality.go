// Package quality carries the closed catalogue of source quality findings.
//
// The catalogue is a closed vocabulary of five codes, ratified by the owner, and it
// is published by GET /v1/risk/sources so the page, the contract and the service
// state the same set. Nothing here invents a sixth code and nothing here derives a
// finding from evidence the route does not serve: Evaluate is a pure function of
// the observable evidence, and the handler builds that evidence from what the read
// already returned.
package quality

import (
	"time"

	observations "firewatch.local/contracts/observations/v1"
)

// Finding is one code of the closed catalogue, as the wire spells it.
type Finding string

const (
	// StaleCutoff means the reading falls outside the freshness window, or the
	// source never ran: the served value is not current.
	StaleCutoff Finding = "STALE_CUTOFF"
	// MissingCanonicalFactor means the source does not declare a variable the
	// classifier reads, so that input is published as unknown.
	MissingCanonicalFactor Finding = "MISSING_CANONICAL_FACTOR"
	// OutOfRangeClamped means the source declared a value outside its nominal
	// range and the service serves the bounded value.
	OutOfRangeClamped Finding = "OUT_OF_RANGE_CLAMPED"
	// ChecksumVerified means the embedded artifact's SHA-256 matches the recorded
	// hash: an integrity finding, and the only positive one.
	ChecksumVerified Finding = "CHECKSUM_VERIFIED"
	// SyntheticFallback means the source is the declared synthetic input of D-A.
	SyntheticFallback Finding = "SYNTHETIC_FALLBACK"
)

// The two severities the catalogue uses. They are closed because the page paints
// them, and a severity the page does not know would render as neither.
const (
	SeverityWarning = "warning"
	SeverityInfo    = "info"
)

// The kinds group the findings by the evidence they come from. They are a closed
// vocabulary for the same reason as the severities.
const (
	KindFreshness  = "freshness"
	KindCoverage   = "coverage"
	KindRange      = "range"
	KindIntegrity  = "integrity"
	KindProvenance = "provenance"
)

// FreshnessWindow is the cycle's target interval: a reading older than this is
// outside its freshness window. It is declared here, next to the finding it
// decides, instead of being read from the scheduler, because a source that never
// ran has no scheduler state to read.
const FreshnessWindow = 15 * time.Minute

// NominalPriorityMin and NominalPriorityMax bound the declared priority of a
// source. The range is the contract's own 0..100 index scale, and a value outside
// it is bounded before it is served.
const (
	NominalPriorityMin = 0
	NominalPriorityMax = 100
)

// Definition is one published entry of the catalogue.
type Definition struct {
	Code        Finding `json:"code"`
	Kind        string  `json:"kind"`
	Severity    string  `json:"severity"`
	Description string  `json:"description"`
}

// catalog is the ratified order. It is unexported so no caller can append a code
// the service does not derive; Catalog returns a copy.
var catalog = []Definition{
	{
		Code:     StaleCutoff,
		Kind:     KindFreshness,
		Severity: SeverityWarning,
		Description: "La última lectura de la fuente está fuera de la ventana de frescura de 15 minutos, " +
			"o la fuente no registra ninguna ejecución: el dato servido no está vigente.",
	},
	{
		Code:     MissingCanonicalFactor,
		Kind:     KindCoverage,
		Severity: SeverityWarning,
		Description: "La fuente no declara una o más de las cinco variables canónicas del clasificador; " +
			"esas variables se publican como desconocidas en lugar de rellenarse.",
	},
	{
		Code:     OutOfRangeClamped,
		Kind:     KindRange,
		Severity: SeverityWarning,
		Description: "La fuente declaró un valor fuera de su rango nominal y el servicio sirve el valor " +
			"acotado a ese rango, no el declarado.",
	},
	{
		Code:     ChecksumVerified,
		Kind:     KindIntegrity,
		Severity: SeverityInfo,
		Description: "La integridad SHA-256 del artefacto geográfico embebido coincide con el hash " +
			"registrado y no se observaron anomalías.",
	},
	{
		Code:     SyntheticFallback,
		Kind:     KindProvenance,
		Severity: SeverityInfo,
		Description: "La fuente es el insumo sintético declarado por D-A: sus valores no son " +
			"observaciones reales y se declaran como tales.",
	},
}

// Catalog returns the published catalogue in its ratified order. The slice is a
// copy, so a caller that sorts or truncates it cannot change what is served next.
func Catalog() []Definition {
	return append([]Definition(nil), catalog...)
}

// Codes returns the five codes in catalogue order.
func Codes() []Finding {
	codes := make([]Finding, 0, len(catalog))
	for _, definition := range catalog {
		codes = append(codes, definition.Code)
	}
	return codes
}

// Lookup returns the published definition of one code and whether the catalogue
// declares it at all. A caller that received an undeclared code must refuse it
// rather than render it.
func Lookup(code Finding) (Definition, bool) {
	for _, definition := range catalog {
		if definition.Code == code {
			return definition, true
		}
	}
	return Definition{}, false
}

// Evidence is the observable per-source evidence the findings are derived from.
// Every field is a fact the read already returned or validated: no entry is
// inferred from a value the route does not serve.
type Evidence struct {
	// Stale reports a reading outside the freshness window, or no reading at all.
	Stale bool
	// MissingFactors names the canonical variables the source does not declare.
	MissingFactors []string
	// ClampedPriority reports a declared priority the service had to bound.
	ClampedPriority bool
	// ChecksumVerified reports the integrity check the route performed.
	ChecksumVerified bool
	// Synthetic reports the descriptor's own synthetic declaration.
	Synthetic bool
}

// Evaluate states every finding the evidence supports, in catalogue order. An
// evidence with nothing to report answers an empty, non-nil list: a JSON encoder
// would turn nil into null, and the contract publishes an array.
//
// Evaluating the same evidence twice answers the same list, which is what makes
// the served findings deterministic rather than incidental.
func Evaluate(evidence Evidence) []Finding {
	findings := make([]Finding, 0, len(catalog))
	if evidence.Stale {
		findings = append(findings, StaleCutoff)
	}
	if len(evidence.MissingFactors) > 0 {
		findings = append(findings, MissingCanonicalFactor)
	}
	if evidence.ClampedPriority {
		findings = append(findings, OutOfRangeClamped)
	}
	if evidence.ChecksumVerified {
		findings = append(findings, ChecksumVerified)
	}
	if evidence.Synthetic {
		findings = append(findings, SyntheticFallback)
	}
	return findings
}

// CanonicalFactors returns the five classifier variables in their canonical order.
// It reads them from the shared observations contract instead of declaring a second
// list, so the two cannot drift.
func CanonicalFactors() []string {
	return observations.VariableNames()
}

// MissingCanonicalFactors returns the canonical variables declared does not name,
// in canonical order. The comparison is exact: a differently spelled or padded
// name is not the canonical variable, because the classifier would not read it.
func MissingCanonicalFactors(declared []string) []string {
	present := make(map[string]bool, len(declared))
	for _, name := range declared {
		present[name] = true
	}
	missing := make([]string, 0, len(present))
	for _, name := range CanonicalFactors() {
		if !present[name] {
			missing = append(missing, name)
		}
	}
	return missing
}

// Stale reports whether a source's reading falls outside the freshness window.
//
// The served age is authoritative when it is present; otherwise the timestamp
// decides. A source that never ran is stale, and a future instant is not: the
// second is an out-of-range timestamp, not an old reading, and calling it stale
// would hide the difference.
func Stale(lastRunAt *time.Time, ageSeconds *float64, now time.Time) bool {
	if ageSeconds != nil {
		return *ageSeconds > FreshnessWindow.Seconds()
	}
	if lastRunAt == nil {
		return true
	}
	return now.Sub(*lastRunAt) > FreshnessWindow
}

// BoundedPriority returns the priority the service serves and whether it had to
// bound it. The declared value is never served outside the nominal range, and the
// finding that says so travels with the bounded value.
func BoundedPriority(priority int) (int, bool) {
	if priority < NominalPriorityMin {
		return NominalPriorityMin, true
	}
	if priority > NominalPriorityMax {
		return NominalPriorityMax, true
	}
	return priority, false
}
