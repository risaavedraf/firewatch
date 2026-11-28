// Package engine applies the ratified priority rule to what the service already
// publishes: the newest published batch of every zone and the embedded
// infrastructure catalogue. It reads nothing, writes nothing and decides nothing
// the domain package has not stated; its job is the join.
package engine

import (
	"bytes"
	"encoding/json"
	"strings"

	"firewatch.local/risk/internal/domain"
	"firewatch.local/risk/internal/repository"
	"firewatch.local/risk/internal/source"
)

// The two documented states of a zone's regional context. They are mutually
// exclusive: a zone either holds a position in the published batch or it is
// published apart with the reason it holds none.
const (
	StatusRanked       = "ranked"
	StatusInsufficient = "insufficient"
)

// ZonePriority is the regional context of one zone as the API serves it. The
// numeric members are nullable because a zone the rule could not score has no
// score: publishing a zero there would read as the lowest priority instead of as
// the absence of one.
type ZonePriority struct {
	ZoneID             string  `json:"zone_id"`
	RiskLevel          string  `json:"risk_level"`
	PriorityStatus     string  `json:"priority_status"`
	RiskScore          *int    `json:"risk_score"`
	ExposureScore      int     `json:"exposure_score"`
	PriorityScore      *int    `json:"priority_score"`
	PriorityRank       *int    `json:"priority_rank"`
	TotalRankedZones   int     `json:"total_ranked_zones"`
	ExposedAssetsCount int     `json:"exposed_assets_count"`
	DominantCategory   *string `json:"dominant_category"`
	ContextSummary     string  `json:"context_summary"`
}

// Table is the regional ranking of one published batch: the ranked zones in the
// order the owner fixed and, separately, the zones that could not take a position.
//
// It is keyed by batch AND zone, not by zone alone. The detail route reads its
// batch and the ranking in two separate reads, so a newer batch published in
// between is a different publication: it must not lend its position to the batch
// being answered, and a position is only attached when the identity matches.
type Table struct {
	Ranked      []ZonePriority
	Unranked    []ZonePriority
	TotalRanked int
	byBatch     map[string]ZonePriority
}

// For returns the regional context of one published batch. A batch the ranking did
// not see — an older or newer publication of the same commune, or an empty
// identity — has none, which the caller serves as an absent member instead of an
// empty one.
func (t Table) For(zoneID, batchID string) (ZonePriority, bool) {
	if t.byBatch == nil || batchID == "" {
		return ZonePriority{}, false
	}
	entry, ok := t.byBatch[batchKey(zoneID, batchID)]
	return entry, ok
}

// batchKey is one published batch's identity in the ranking. The NUL separator
// keeps a zone id and a batch id from forming a key that another pair also forms.
func batchKey(zoneID, batchID string) string {
	return zoneID + "\x00" + batchID
}

// exposure is the catalogue's answer for one zone. The zero value is a real
// reading: a zone the fixture does not cover declares no weighted element.
type exposure struct {
	score    int
	assets   int
	dominant string
}

// Build joins the published batch with the catalogue and ranks it. It never
// invents a score: a batch whose factor list cannot be read, or whose published
// level is not a severity, is published as insufficient with its exposure and no
// position.
func Build(batches []repository.Batch, catalogue source.InfrastructureCatalogue) Table {
	exposures := exposuresByZone(catalogue)
	// The identity of each published batch is what the ranking answers by. The
	// first entry of a zone wins, so a duplicated zone cannot silently overwrite the
	// batch the caller asked about.
	batchIDs := make(map[string]string, len(batches))
	candidates := make([]domain.Candidate, 0, len(batches))
	for _, batch := range batches {
		factors, readable := decodedFactors(batch.Factors)
		if !readable {
			// Unreadable storage is corrupt data, not an incomplete measurement: the
			// record is omitted so no route publishes a priority built from it.
			continue
		}
		riskScore, evidence := domain.RiskScore(factors)
		if evidence == domain.EvidenceCorrupt {
			continue
		}
		if _, seen := batchIDs[batch.ZoneID]; !seen {
			batchIDs[batch.ZoneID] = batch.ID
		}
		declared := exposures[batch.ZoneID]
		candidates = append(candidates, domain.Candidate{
			ZoneID:           batch.ZoneID,
			RiskLevel:        batch.RiskLevel,
			RiskScore:        riskScore,
			ExposureScore:    declared.score,
			ExposedAssets:    declared.assets,
			DominantCategory: declared.dominant,
			Rankable:         evidence == domain.EvidenceSufficient && severity(batch.RiskLevel),
		})
	}

	ranked, unranked := domain.Rank(candidates)
	table := Table{
		Ranked:      make([]ZonePriority, 0, len(ranked)),
		Unranked:    make([]ZonePriority, 0, len(unranked)),
		TotalRanked: len(ranked),
		byBatch:     make(map[string]ZonePriority, len(candidates)),
	}
	for _, entry := range ranked {
		priority := ZonePriority{
			ZoneID:             entry.ZoneID,
			RiskLevel:          entry.RiskLevel,
			PriorityStatus:     StatusRanked,
			RiskScore:          intPointer(entry.RiskScore),
			ExposureScore:      entry.ExposureScore,
			PriorityScore:      intPointer(entry.PriorityScore),
			PriorityRank:       intPointer(entry.Rank),
			TotalRankedZones:   entry.TotalRanked,
			ExposedAssetsCount: entry.ExposedAssets,
			DominantCategory:   stringPointer(entry.DominantCategory),
			ContextSummary:     entry.ContextSummary(),
		}
		table.Ranked = append(table.Ranked, priority)
		table.record(priority, batchIDs)
	}
	for _, entry := range unranked {
		priority := ZonePriority{
			ZoneID:             entry.ZoneID,
			RiskLevel:          entry.RiskLevel,
			PriorityStatus:     StatusInsufficient,
			ExposureScore:      entry.ExposureScore,
			TotalRankedZones:   table.TotalRanked,
			ExposedAssetsCount: entry.ExposedAssets,
			DominantCategory:   stringPointer(entry.DominantCategory),
			ContextSummary:     entry.ContextSummary(),
		}
		table.Unranked = append(table.Unranked, priority)
		table.record(priority, batchIDs)
	}
	return table
}

// record indexes one entry under its batch identity, so a lookup can never answer
// with a position computed for another publication of the same commune.
func (t Table) record(priority ZonePriority, batchIDs map[string]string) {
	batchID, known := batchIDs[priority.ZoneID]
	if !known || batchID == "" {
		return
	}
	t.byBatch[batchKey(priority.ZoneID, batchID)] = priority
}

// decodedFactors decodes the factor list the classifier persisted. The second
// return value separates the two failure modes that must not be confused: a row
// without a factor list is readable evidence of no score (true), while bytes that
// are not a factor list at all are corrupt (false) and the caller omits the record.
func decodedFactors(raw json.RawMessage) ([]domain.PublishedFactor, bool) {
	if len(raw) == 0 {
		// A row with no factor list is incomplete evidence, not corrupt data: the zone
		// is published as insufficient with an empty wire array.
		return nil, true
	}
	return decodeWireFactors(raw)
}

// severity reports whether the published level is a severity the ranking can use.
// `desconocido` is a level the rule states, not a low one, so it never ranks.
func severity(level string) bool {
	switch level {
	case "bajo", "medio", "alto":
		return true
	default:
		return false
	}
}

// exposuresByZone indexes the catalogue by zone. A dominant category outside the
// ratified table is dropped instead of published: a caller-assembled catalogue
// must not be trusted more than the embedded one.
func exposuresByZone(catalogue source.InfrastructureCatalogue) map[string]exposure {
	exposures := make(map[string]exposure, len(catalogue.Zones))
	for _, zone := range catalogue.Zones {
		declared := exposure{
			score:  zone.ExposureScore,
			assets: zone.ExposedAssetsCount,
		}
		if zone.DominantCategory != nil {
			if _, ratified := domain.CategoryOf(*zone.DominantCategory); ratified {
				declared.dominant = *zone.DominantCategory
			}
		}
		exposures[zone.ZoneID] = declared
	}
	return exposures
}

func floatPointer(value float64) *float64 { return &value }

func intPointer(value int) *int {
	return &value
}

func stringPointer(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

// ValidWireFactors reports whether a batch's `factors` member is exactly what the
// published document and the client both require: a JSON array whose every element is
// a factor object with a non-blank string `name`, a boolean `known`, an optional
// string `note`, and the numeric pair the flag requires.
//
// It lives next to the ranking because a row that fails it must not influence the
// ranking at all. Excluding such a row only at the wire would let a malformed,
// higher-scoring row take the first position and shift a valid peer from `#1 of 1` to
// `#2 of 2` before the handler strips its `priority`.
func ValidWireFactors(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return false
	}
	_, ok := decodeWireFactors(raw)
	return ok
}

// allowedFactorKeys is the closed member set of one published factor. It is exact
// and lowercase on purpose: `encoding/json` matches struct fields case-insensitively,
// so `{"Known": true}` or an unknown extra key must be rejected here instead of being
// silently folded into a member the document never declared.
var allowedFactorKeys = map[string]bool{
	"name":         true,
	"known":        true,
	"value":        true,
	"contribution": true,
	"note":         true,
}

// decodeWireFactors parses the list once, rejects anything outside the published
// shape, and builds the scoring factors from the very values it validated. Parsing
// and validating in one pass is what keeps the wire and the ranking identical: there
// is no second interpretation of the same bytes.
func decodeWireFactors(raw json.RawMessage) ([]domain.PublishedFactor, bool) {
	var elements []json.RawMessage
	if err := json.Unmarshal(raw, &elements); err != nil || elements == nil {
		return nil, false
	}

	factors := make([]domain.PublishedFactor, 0, len(elements))
	for _, element := range elements {
		members := map[string]json.RawMessage{}
		if err := json.Unmarshal(element, &members); err != nil || members == nil {
			return nil, false
		}
		for key := range members {
			if !allowedFactorKeys[key] {
				return nil, false
			}
		}

		name, present, valid := wireString(members, "name")
		if !present || !valid || strings.TrimSpace(name) == "" {
			return nil, false
		}
		known, present, valid := wireBool(members)
		if !present || !valid {
			return nil, false
		}
		if _, present, valid := wireString(members, "note"); present && !valid {
			return nil, false
		}
		// `value` is validated but not scored: the rule's score is the sum of the
		// contributions. It is still required for a known variable because the client
		// refuses to render a measurement without it.
		_, hasValue, valueValid := wireNumber(members, "value")
		contribution, hasContribution, contributionValid := wireNumber(members, "contribution")
		if !valueValid || !contributionValid {
			return nil, false
		}
		if known {
			if !hasValue || !hasContribution || contribution < 0 {
				return nil, false
			}
		} else if hasContribution && contribution != 0 {
			// A variable the rule could not read may carry the explicit zero the
			// producer writes; any other number contradicts the flag.
			return nil, false
		}

		factor := domain.PublishedFactor{Name: name, Known: known}
		if hasContribution {
			factor.Contribution = floatPointer(contribution)
		}
		factors = append(factors, factor)
	}
	return factors, true
}

// wireString reads a string member. `present` says the key exists and `valid` says
// what it holds is acceptable: an absent member is valid (there is nothing to
// reject) while an explicit null is not, because null is not a string.
func wireString(members map[string]json.RawMessage, key string) (value string, present, valid bool) {
	raw, present := members[key]
	if !present {
		return "", false, true
	}
	if isJSONNull(raw) {
		return "", true, false
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", true, false
	}
	return value, true, true
}

// wireBool reads the `known` member with the same three-way answer: the caller
// requires it, and `present` is what makes an absent flag distinguishable from a
// false one.
func wireBool(members map[string]json.RawMessage) (value, present, valid bool) {
	raw, present := members["known"]
	if !present {
		return false, false, true
	}
	if isJSONNull(raw) {
		return false, true, false
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return false, true, false
	}
	return value, true, true
}

// wireNumber reads an optional numeric member. An absent member is valid — the
// caller decides whether the flag requires it — while an explicit null is not a
// number and is rejected instead of being decoded as zero.
func wireNumber(members map[string]json.RawMessage, key string) (value float64, present, valid bool) {
	raw, present := members[key]
	if !present {
		return 0, false, true
	}
	if isJSONNull(raw) {
		return 0, true, false
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, true, false
	}
	return value, true, true
}

// isJSONNull reports an explicit JSON null. Go decodes null into a zero value without
// an error, so the bytes have to be inspected to keep absence and null
// distinguishable.
func isJSONNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}
