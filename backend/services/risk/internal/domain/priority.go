// Package domain holds the rules that decide what the risk service publishes,
// stated once and as pure functions.
//
// The two rules here exist because the owner ratified them in writing: a weighted
// table of five critical-infrastructure categories, and a 0..100 priority index
// that combines the published risk score with that exposure. Both are expressed as
// data plus arithmetic, so the catalogue, the API edge and the page read the same
// numbers instead of restating them.
package domain

import (
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
)

// Category is one ratified weighted category of critical infrastructure: the
// weight it contributes to the exposure index and the radius it reaches. The
// aliases are the owner's own: they are the element-type names that fold onto this
// category, and they are the only names that do. The table below is the single
// source of truth for the catalogue, the index and the page.
type Category struct {
	Category string
	Aliases  []string
	Weight   float64
	RadiusKM float64
}

// The ratified table. It is written once, in the order the owner wrote it, because
// a reordered row, a sixth category or a different radius is a different decision
// and not an implementation detail.
var ratifiedCategories = []Category{
	{Category: "hospital", Aliases: []string{"hospital", "salud"}, Weight: 1.00, RadiusKM: 5.0},
	{Category: "escuela", Aliases: []string{"escuela", "educacion"}, Weight: 0.90, RadiusKM: 3.0},
	{Category: "subestacion", Aliases: []string{"subestacion", "agua_potable"}, Weight: 0.85, RadiusKM: 4.0},
	{Category: "telecom", Aliases: []string{"telecom", "cuartel_bomberos"}, Weight: 0.75, RadiusKM: 4.0},
	{Category: "vialidad", Aliases: []string{"vialidad", "puente"}, Weight: 0.65, RadiusKM: 2.5},
}

// The ratified priority pair. Risk weighs 0.70 and exposure 0.30 of the index.
const (
	riskWeight     = 0.70
	exposureWeight = 0.30
)

// Categories returns the ratified table. The aliases are copied so a caller
// cannot edit the rule through the slice it received.
func Categories() []Category {
	copied := make([]Category, 0, len(ratifiedCategories))
	for _, category := range ratifiedCategories {
		aliases := make([]string, len(category.Aliases))
		copy(aliases, category.Aliases)
		copied = append(copied, Category{
			Category: category.Category,
			Aliases:  aliases,
			Weight:   category.Weight,
			RadiusKM: category.RadiusKM,
		})
	}
	return copied
}

// CategoryWeightSum is the normaliser of the exposure index. It is computed from
// the table, so changing one weight moves the index with it instead of leaving a
// literal behind that no longer matches.
func CategoryWeightSum() float64 {
	sum := 0.0
	for _, category := range ratifiedCategories {
		sum += category.Weight
	}
	return sum
}

// CategoryOf folds one element type onto its ratified category. A type the table
// does not name — a home, a hydrant — is reported as unknown: it is declared in
// the catalogue but it carries no weight, and inventing one would be a different
// decision.
func CategoryOf(elementType string) (Category, bool) {
	for _, category := range ratifiedCategories {
		for _, alias := range category.Aliases {
			if alias == elementType {
				return category, true
			}
		}
	}
	return Category{}, false
}

// ExposureScore is the weighted coverage of the ratified table: which categories
// the zone declares, not how many elements it holds. A zone that declares all five
// reaches 100 and a zone that declares none reaches 0, which is a real zero and
// not an absent reading. Repeated categories count once.
func ExposureScore(present ...string) int {
	seen := make(map[string]bool, len(present))
	weight := 0.0
	for _, elementType := range present {
		category, known := CategoryOf(elementType)
		if !known || seen[category.Category] {
			continue
		}
		seen[category.Category] = true
		weight += category.Weight
	}
	return int(math.Round(100 * weight / CategoryWeightSum()))
}

// ExposureFormula is the exposure rule in the words the catalogue publishes.
func ExposureFormula() string {
	return "round(100 × Σ pesos de las categorías presentes ÷ Σ pesos de la tabla)"
}

// PriorityWeights returns the ratified pair.
func PriorityWeights() (float64, float64) {
	return riskWeight, exposureWeight
}

// PriorityFormula is the index in the words the catalogue publishes.
func PriorityFormula() string {
	return fmt.Sprintf(
		"round(%.2f × risk_score + %.2f × exposure_score)",
		riskWeight,
		exposureWeight,
	)
}

// RiskFormula is the risk-score reconstruction in the words the catalogue
// publishes: the score is read back from what the classifier already stored.
func RiskFormula() string {
	return "round(100 × Σ contribuciones publicadas del lote)"
}

// PriorityScore combines the two served scores. It is clamped to the documented
// 0..100 range and rounded once, at the end, so the result is reproducible from the
// two published inputs instead of depending on an intermediate rounding.
//
// The arithmetic is done in integer tenths because 0.70 and 0.30 are exactly 7/10
// and 3/10: in floating point `0.70*96 + 0.30*61` lands on 85.49999999999999 and
// rounds to 85, which is not the number the owner wrote. Rounding is half-up, the
// same rule the published formula states.
func PriorityScore(riskScore, exposureScore int) int {
	weightedTenths := 7*riskScore + 3*exposureScore
	rounded := (weightedTenths + 5) / 10
	switch {
	case rounded < 0:
		return 0
	case rounded > 100:
		return 100
	default:
		return rounded
	}
}

// PublishedFactor is one factor of a published batch, as the classifier wrote it.
// Only the three members this rule needs are declared. The contribution is a
// pointer because the wire distinguishes "the rule read this variable and it added
// nothing" (a published 0) from "the contribution was not published at all" (null
// or absent): the second is missing evidence, and a score built on it would be a
// number nobody calculated.
type PublishedFactor struct {
	Name         string
	Known        bool
	Contribution *float64
}

// FactorEvidence is what one published factor list supports. It is three-valued
// because "no score" and "unreadable" are different facts: an incomplete batch is
// a valid answer the page explains, while a contradictory one is data this service
// must not publish as a position, a score or an absence of either.
type FactorEvidence int

const (
	// EvidenceSufficient means at least one known variable published a usable
	// contribution, so a score can be reconstructed from the list.
	EvidenceSufficient FactorEvidence = iota
	// EvidenceInsufficient means the list is readable and supports no score at all:
	// nobody published a contribution, or no variable is known.
	EvidenceInsufficient
	// EvidenceCorrupt means the list contradicts itself: a known variable without a
	// number, a negative or non-finite contribution, or an unknown variable that
	// carries a non-zero contribution it could not have produced. The caller must
	// omit the record instead of publishing it as incomplete evidence.
	EvidenceCorrupt
)

// RiskScore reconstructs the rule's numeric score from the published contributions
// and reports what the evidence supports. It never re-executes the classifier and
// never guesses: a readable list with no usable contribution is insufficient
// evidence, and a list that contradicts itself is corrupt, which the caller treats
// as unreadable data rather than as an empty measurement.
func RiskScore(factors []PublishedFactor) (int, FactorEvidence) {
	usable := false
	sum := 0.0
	for _, factor := range factors {
		// An element with no name is not a variable the rule failed to read: it is an
		// element that is not a factor at all, so the list is corrupt.
		if strings.TrimSpace(factor.Name) == "" {
			return 0, EvidenceCorrupt
		}
		contribution := factor.Contribution
		if contribution != nil && (math.IsNaN(*contribution) || math.IsInf(*contribution, 0)) {
			return 0, EvidenceCorrupt
		}
		if !factor.Known {
			// The producer writes an explicit zero for a variable it could not read, so
			// a zero here is the documented shape and stays readable. Any other number
			// contradicts `known: false`: there is no amount the rule could have added
			// for a variable it never read.
			if contribution != nil && *contribution != 0 {
				return 0, EvidenceCorrupt
			}
			continue
		}
		if contribution == nil || *contribution < 0 {
			return 0, EvidenceCorrupt
		}
		usable = true
		sum += *contribution
	}
	if !usable {
		return 0, EvidenceInsufficient
	}
	if sum > 1 {
		sum = 1
	}
	return int(math.Round(100 * sum)), EvidenceSufficient
}

// String names the evidence, so a handler, a test failure or a log line says which
// of the three outcomes happened instead of printing a number.
func (e FactorEvidence) String() string {
	switch e {
	case EvidenceSufficient:
		return "sufficient"
	case EvidenceInsufficient:
		return "insufficient"
	case EvidenceCorrupt:
		return "corrupt"
	default:
		return "unknown"
	}
}

// Candidate is one published zone entering the regional ranking. Rankable says
// whether the batch allowed a risk score to be reconstructed and published a
// severity; a candidate that is not rankable is published apart and takes no
// position.
type Candidate struct {
	ZoneID           string
	RiskLevel        string
	RiskScore        int
	ExposureScore    int
	ExposedAssets    int
	DominantCategory string
	Rankable         bool
}

// Ranked is one position of the regional ranking.
type Ranked struct {
	ZoneID           string
	RiskLevel        string
	RiskScore        int
	ExposureScore    int
	ExposedAssets    int
	DominantCategory string
	PriorityScore    int
	Rank             int
	TotalRanked      int
}

// Unranked is a published zone whose priority could not be computed. It carries
// the exposure the catalogue does provide and no position at all.
type Unranked struct {
	ZoneID           string
	RiskLevel        string
	ExposureScore    int
	ExposedAssets    int
	DominantCategory string
}

// Rank assigns the deterministic regional order the owner fixed: descending
// priority, ties broken by ascending zone id. Both lists are ordered, so the same
// published batch always answers the same ranking.
func Rank(candidates []Candidate) ([]Ranked, []Unranked) {
	ranked := make([]Ranked, 0, len(candidates))
	unranked := make([]Unranked, 0, len(candidates))
	for _, candidate := range candidates {
		if !candidate.Rankable {
			unranked = append(unranked, Unranked{
				ZoneID:           candidate.ZoneID,
				RiskLevel:        candidate.RiskLevel,
				ExposureScore:    candidate.ExposureScore,
				ExposedAssets:    candidate.ExposedAssets,
				DominantCategory: candidate.DominantCategory,
			})
			continue
		}
		ranked = append(ranked, Ranked{
			ZoneID:           candidate.ZoneID,
			RiskLevel:        candidate.RiskLevel,
			RiskScore:        candidate.RiskScore,
			ExposureScore:    candidate.ExposureScore,
			ExposedAssets:    candidate.ExposedAssets,
			DominantCategory: candidate.DominantCategory,
			PriorityScore:    PriorityScore(candidate.RiskScore, candidate.ExposureScore),
		})
	}
	sort.SliceStable(ranked, func(i, j int) bool {
		if ranked[i].PriorityScore != ranked[j].PriorityScore {
			return ranked[i].PriorityScore > ranked[j].PriorityScore
		}
		return ranked[i].ZoneID < ranked[j].ZoneID
	})
	for index := range ranked {
		ranked[index].Rank = index + 1
		ranked[index].TotalRanked = len(ranked)
	}
	sort.SliceStable(unranked, func(i, j int) bool { return unranked[i].ZoneID < unranked[j].ZoneID })
	return ranked, unranked
}

// ContextSummary is the sentence the detail card shows for a ranked zone: the
// served numbers, the position they earned and the ratified weight and radius of
// the dominant category. It states arithmetic, never a forecast.
func (r Ranked) ContextSummary() string {
	if r.DominantCategory == "" {
		return fmt.Sprintf(
			"Comuna %s: prioridad %d de 100, puesto %d de %d del lote publicado. "+
				"Riesgo %d de 100 y exposición %d de 100: el catálogo sintético no declara "+
				"elementos ponderados en la comuna, así que no hay categoría dominante.",
			r.ZoneID, r.PriorityScore, r.Rank, r.TotalRanked, r.RiskScore, r.ExposureScore,
		)
	}
	category, known := CategoryOf(r.DominantCategory)
	if !known {
		return fmt.Sprintf(
			"Comuna %s: prioridad %d de 100, puesto %d de %d del lote publicado. "+
				"Riesgo %d de 100 y exposición %d de 100: la categoría dominante informada "+
				"no pertenece a la tabla ratificada, así que no se declara.",
			r.ZoneID, r.PriorityScore, r.Rank, r.TotalRanked, r.RiskScore, r.ExposureScore,
		)
	}
	return fmt.Sprintf(
		"Comuna %s: prioridad %d de 100, puesto %d de %d del lote publicado. "+
			"Riesgo %d de 100 y exposición %d de 100 sobre %d elementos ficticios declarados; "+
			"la categoría dominante es %s (peso %s, radio %s km).",
		r.ZoneID, r.PriorityScore, r.Rank, r.TotalRanked, r.RiskScore, r.ExposureScore,
		r.ExposedAssets, category.Category, formatWeight(category.Weight), formatRadius(category.RadiusKM),
	)
}

// ContextSummary is the sentence the detail card shows for a zone that could not
// be ranked. It says why no position exists instead of publishing a zero that
// would read as the lowest priority.
func (u Unranked) ContextSummary() string {
	return fmt.Sprintf(
		"Comuna %s: sin puesto regional porque el lote publicado no trae contribuciones "+
			"usables o su nivel es desconocido. Exposición %d de 100 sobre %d elementos "+
			"ficticios declarados.",
		u.ZoneID, u.ExposureScore, u.ExposedAssets,
	)
}

func formatWeight(weight float64) string {
	return strconv.FormatFloat(weight, 'f', 2, 64)
}

func formatRadius(radius float64) string {
	return strconv.FormatFloat(radius, 'f', 1, 64)
}
