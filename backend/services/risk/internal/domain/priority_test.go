package domain

import (
	"math"
	"strings"
	"testing"
)

// The owner ratified one table and nothing else may drift from it: five
// categories, their aliases, their weight and their exposure radius, in this
// order. A sixth category, a reordered row or a different radius is a different
// decision, so the whole table is pinned here.
func TestCategoryTableIsTheRatifiedFiveCategoryTable(t *testing.T) {
	categories := Categories()
	want := []struct {
		category string
		aliases  []string
		weight   float64
		radiusKM float64
	}{
		{category: "hospital", aliases: []string{"hospital", "salud"}, weight: 1.00, radiusKM: 5.0},
		{category: "escuela", aliases: []string{"escuela", "educacion"}, weight: 0.90, radiusKM: 3.0},
		{category: "subestacion", aliases: []string{"subestacion", "agua_potable"}, weight: 0.85, radiusKM: 4.0},
		{category: "telecom", aliases: []string{"telecom", "cuartel_bomberos"}, weight: 0.75, radiusKM: 4.0},
		{category: "vialidad", aliases: []string{"vialidad", "puente"}, weight: 0.65, radiusKM: 2.5},
	}
	if len(categories) != len(want) {
		t.Fatalf("the table holds %d categories, want the ratified %d", len(categories), len(want))
	}
	for index, expected := range want {
		got := categories[index]
		if got.Category != expected.category {
			t.Errorf("category %d is %q, want %q", index, got.Category, expected.category)
		}
		if strings.Join(got.Aliases, "|") != strings.Join(expected.aliases, "|") {
			t.Errorf("category %q aliases are %v, want %v", got.Category, got.Aliases, expected.aliases)
		}
		if math.Abs(got.Weight-expected.weight) > 1e-9 {
			t.Errorf("category %q weight is %v, want %v", got.Category, got.Weight, expected.weight)
		}
		if math.Abs(got.RadiusKM-expected.radiusKM) > 1e-9 {
			t.Errorf("category %q radius is %v, want %v", got.Category, got.RadiusKM, expected.radiusKM)
		}
	}
}

// The normaliser is the sum of the ratified weights, not a number declared beside
// them: changing one weight must move the exposure index with it.
func TestCategoryWeightSumIsTheSumOfTheTable(t *testing.T) {
	sum := 0.0
	for _, category := range Categories() {
		sum += category.Weight
	}
	if math.Abs(CategoryWeightSum()-sum) > 1e-12 {
		t.Errorf("weight sum is %v, want the table's own %v", CategoryWeightSum(), sum)
	}
	if math.Abs(CategoryWeightSum()-4.15) > 1e-9 {
		t.Errorf("weight sum is %v, want the ratified 4.15", CategoryWeightSum())
	}
}

func TestCategoryOfFoldsEveryRatifiedAlias(t *testing.T) {
	for alias, want := range map[string]string{
		"hospital":         "hospital",
		"salud":            "hospital",
		"escuela":          "escuela",
		"educacion":        "escuela",
		"subestacion":      "subestacion",
		"agua_potable":     "subestacion",
		"telecom":          "telecom",
		"cuartel_bomberos": "telecom",
		"vialidad":         "vialidad",
		"puente":           "vialidad",
	} {
		category, known := CategoryOf(alias)
		if !known {
			t.Errorf("%q is a ratified alias and is not known", alias)
			continue
		}
		if category.Category != want {
			t.Errorf("%q folded to %q, want %q", alias, category.Category, want)
		}
	}
	// The type that the ratified table does not name has no weight. It is not a
	// typo of a ratified alias, so it must not be folded silently.
	for _, unweighted := range []string{"vivienda", "hidrante", ""} {
		if category, known := CategoryOf(unweighted); known {
			t.Errorf("%q is outside the ratified table and folded to %q", unweighted, category.Category)
		}
	}
}

// The exposure index is weighted coverage of the ratified table: only a zone that
// declares all five categories reaches 100, and a zone that declares none reaches
// 0 instead of an absent value.
func TestExposureScoreIsWeightedCoverageOfTheTable(t *testing.T) {
	for _, tc := range []struct {
		name    string
		present []string
		want    int
	}{
		{name: "every category present", present: []string{"hospital", "escuela", "subestacion", "telecom", "vialidad"}, want: 100},
		{name: "none present", present: nil, want: 0},
		{name: "hospital only", present: []string{"hospital"}, want: 24},
		{name: "vialidad only", present: []string{"vialidad"}, want: 16},
		{name: "hospital and escuela", present: []string{"hospital", "escuela"}, want: 46},
		{name: "hospital, escuela and vialidad", present: []string{"hospital", "escuela", "vialidad"}, want: 61},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := ExposureScore(tc.present...); got != tc.want {
				t.Fatalf("exposure for %v is %d, want %d", tc.present, got, tc.want)
			}
		})
	}
}

// A category the table does not name cannot reach the index: an unweighted type
// is declared in the catalogue, not scored by it.
func TestExposureScoreIgnoresUnweightedInput(t *testing.T) {
	if got := ExposureScore("vivienda", "hidrante"); got != 0 {
		t.Fatalf("unweighted types scored %d, want 0", got)
	}
	if got := ExposureScore("hospital", "vivienda", "hidrante"); got != 24 {
		t.Fatalf("an unweighted type changed the index: got %d, want 24", got)
	}
}

// The priority weights are the ratified 70/30 pair, and the formula is the one
// the table declares.
func TestPriorityWeightsAreTheRatifiedSeventyThirtyPair(t *testing.T) {
	risk, exposure := PriorityWeights()
	if math.Abs(risk-0.70) > 1e-9 || math.Abs(exposure-0.30) > 1e-9 {
		t.Fatalf("weights are %v/%v, want the ratified 0.70/0.30", risk, exposure)
	}
	if got := PriorityFormula(); got != "round(0.70 × risk_score + 0.30 × exposure_score)" {
		t.Fatalf("priority formula is %q", got)
	}
}

func TestPriorityScoreIsTheWeightedRoundedIndex(t *testing.T) {
	for _, tc := range []struct {
		name     string
		risk     int
		exposure int
		want     int
	}{
		{name: "both ends high", risk: 100, exposure: 100, want: 100},
		{name: "both ends low", risk: 0, exposure: 0, want: 0},
		{name: "rounds the weighted sum", risk: 34, exposure: 67, want: 44},
		{name: "rounds a low sum up", risk: 1, exposure: 0, want: 1},
		{name: "rounds a low sum down", risk: 0, exposure: 1, want: 0},
		{name: "risk dominates exposure", risk: 90, exposure: 10, want: 66},
		{name: "exposure alone does not reach half", risk: 0, exposure: 100, want: 30},
		{name: "below the clamp", risk: -10, exposure: -10, want: 0},
		{name: "above the clamp", risk: 200, exposure: 200, want: 100},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := PriorityScore(tc.risk, tc.exposure); got != tc.want {
				t.Fatalf("priority(%d, %d) is %d, want %d", tc.risk, tc.exposure, got, tc.want)
			}
		})
	}
}

// The risk score is reconstructed from the contributions the classifier already
// published, never re-executed and never invented. No usable contribution means
// no score, which is why the second return value exists.
// contribution is the published contribution of one factor. A pointer is what the
// wire actually carries: the classifier writes a number for a variable it could
// read, and a known variable with no number is a different fact from a
// contribution of zero.
func contribution(value float64) *float64 { return &value }

// expectedEvidence is the outcome the caller must act on. It is spelled out in the
// table so a test cannot pass by returning the right score with the wrong verdict.
type expectedEvidence = FactorEvidence

// TestRiskScoreIsReconstructedFromPublishedContributions pins the reconstruction
// rule and its three outcomes: a usable score, readable evidence that supports no
// score at all, and corrupt evidence the caller must not publish as either.
func TestRiskScoreIsReconstructedFromPublishedContributions(t *testing.T) {
	for _, tc := range []struct {
		name     string
		factors  []PublishedFactor
		want     int
		evidence expectedEvidence
	}{
		{
			name: "sums the known contributions",
			factors: []PublishedFactor{
				{Name: "temperatura", Known: true, Contribution: contribution(0.20)},
				{Name: "humedad_relativa", Known: true, Contribution: contribution(0.10)},
				{Name: "viento", Known: true, Contribution: contribution(0.05)},
				{Name: "cobertura_vegetal", Known: true, Contribution: contribution(0.00)},
				{Name: "incendios_historicos", Known: true, Contribution: contribution(0.01)},
			},
			want: 36, evidence: EvidenceSufficient,
		},
		{
			name: "unknown factors contribute nothing",
			factors: []PublishedFactor{
				{Name: "temperatura", Known: true, Contribution: contribution(0.40)},
				{Name: "humedad_relativa", Known: false},
			},
			want: 40, evidence: EvidenceSufficient,
		},
		{
			// A published zero is evidence the rule read the variable and it added
			// nothing; it must not be confused with a contribution that never arrived.
			name:    "a published zero is a real contribution",
			factors: []PublishedFactor{{Name: "temperatura", Known: true, Contribution: contribution(0)}},
			want:    0, evidence: EvidenceSufficient,
		},
		{
			name:     "no factor at all is readable evidence of no score",
			factors:  nil,
			evidence: EvidenceInsufficient,
		},
		{
			name:     "every factor unknown is readable evidence of no score",
			factors:  []PublishedFactor{{Name: "temperatura", Known: false}},
			evidence: EvidenceInsufficient,
		},
		{
			// The producer writes an explicit zero for a variable it could not read,
			// and that shape is valid: the batch is incomplete, not corrupt.
			name: "an unknown factor carrying an explicit zero is still readable",
			factors: []PublishedFactor{
				{Name: "temperatura", Known: true, Contribution: contribution(0.30)},
				{Name: "viento", Known: false, Contribution: contribution(0)},
			},
			want: 30, evidence: EvidenceSufficient,
		},
		{
			name:     "a known factor without a published contribution is corrupt",
			factors:  []PublishedFactor{{Name: "temperatura", Known: true}},
			evidence: EvidenceCorrupt,
		},
		{
			name: "one missing contribution spoils the sum, not only its own term",
			factors: []PublishedFactor{
				{Name: "temperatura", Known: true, Contribution: contribution(0.40)},
				{Name: "viento", Known: true},
			},
			evidence: EvidenceCorrupt,
		},
		{
			name:     "a non-finite contribution is corrupt",
			factors:  []PublishedFactor{{Name: "temperatura", Known: true, Contribution: contribution(math.NaN())}},
			evidence: EvidenceCorrupt,
		},
		{
			name:     "a negative contribution is corrupt",
			factors:  []PublishedFactor{{Name: "temperatura", Known: true, Contribution: contribution(-0.2)}},
			evidence: EvidenceCorrupt,
		},
		{
			// known=false with a non-zero contribution contradicts itself: the rule
			// could not read the variable, so there is no number for it to have added.
			name:     "an unknown factor carrying a non-zero contribution is corrupt",
			factors:  []PublishedFactor{{Name: "viento", Known: false, Contribution: contribution(0.4)}},
			evidence: EvidenceCorrupt,
		},
		{
			name:     "an unknown factor carrying a non-finite contribution is corrupt",
			factors:  []PublishedFactor{{Name: "viento", Known: false, Contribution: contribution(math.Inf(1))}},
			evidence: EvidenceCorrupt,
		},
		{
			// A factor element with no name is not a variable the rule failed to read;
			// it is an element that is not a factor at all.
			name:     "a factor without a name is corrupt",
			factors:  []PublishedFactor{{Known: false}},
			evidence: EvidenceCorrupt,
		},
		{
			name:     "a factor whose name is only whitespace is corrupt",
			factors:  []PublishedFactor{{Name: "   ", Known: true, Contribution: contribution(0.2)}},
			evidence: EvidenceCorrupt,
		},
		{
			name:    "a sum above the rule ceiling is clamped, not rejected",
			factors: []PublishedFactor{{Name: "temperatura", Known: true, Contribution: contribution(1.4)}},
			want:    100, evidence: EvidenceSufficient,
		},
		{
			name:    "a sum exactly on a band boundary rounds once",
			factors: []PublishedFactor{{Name: "viento", Known: true, Contribution: contribution(0.665)}},
			want:    67, evidence: EvidenceSufficient,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			score, evidence := RiskScore(tc.factors)
			if evidence != tc.evidence {
				t.Fatalf("evidence is %v, want %v", evidence, tc.evidence)
			}
			if evidence != EvidenceSufficient {
				return
			}
			if score != tc.want {
				t.Fatalf("risk score is %d, want %d", score, tc.want)
			}
		})
	}
}

// The regional order is fixed by the owner: descending priority, ties broken by
// ascending zone id. Rankability is decided before the sort, so a zone that could
// not be scored never occupies a position.
func TestRankOrdersByPriorityThenZoneID(t *testing.T) {
	ranked, unranked := Rank([]Candidate{
		{ZoneID: "05103", RiskLevel: "medio", RiskScore: 50, ExposureScore: 50, ExposedAssets: 2, Rankable: true},
		{ZoneID: "05101", RiskLevel: "alto", RiskScore: 80, ExposureScore: 80, ExposedAssets: 5, DominantCategory: "hospital", Rankable: true},
		{ZoneID: "05102", RiskLevel: "desconocido", ExposureScore: 61, ExposedAssets: 3, Rankable: false},
		{ZoneID: "05104", RiskLevel: "alto", RiskScore: 70, ExposureScore: 70, ExposedAssets: 1, Rankable: true},
		{ZoneID: "05100", RiskLevel: "bajo", RiskScore: 50, ExposureScore: 50, ExposedAssets: 0, Rankable: true},
	})
	got := make([]string, 0, len(ranked))
	for _, entry := range ranked {
		got = append(got, entry.ZoneID)
	}
	want := []string{"05101", "05104", "05100", "05103"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("ranking is %v, want %v", got, want)
	}
	for index, entry := range ranked {
		if entry.Rank != index+1 {
			t.Errorf("%s holds rank %d, want %d", entry.ZoneID, entry.Rank, index+1)
		}
		if entry.TotalRanked != len(ranked) {
			t.Errorf("%s reports %d ranked zones, want %d", entry.ZoneID, entry.TotalRanked, len(ranked))
		}
	}
	if ranked[0].PriorityScore != 80 {
		t.Errorf("top priority is %d, want 80", ranked[0].PriorityScore)
	}
	if len(unranked) != 1 || unranked[0].ZoneID != "05102" {
		t.Fatalf("unranked is %+v, want only 05102", unranked)
	}
	if ranked[2].PriorityScore != ranked[3].PriorityScore {
		t.Fatalf("the fixture no longer exercises the tie-break: %d and %d", ranked[2].PriorityScore, ranked[3].PriorityScore)
	}
	if ranked[2].ZoneID != "05100" || ranked[3].ZoneID != "05103" {
		t.Fatalf("the tie-break is not ascending zone id: %s before %s", ranked[2].ZoneID, ranked[3].ZoneID)
	}
}

func TestRankOfAnEmptyBatchIsAnEmptyRanking(t *testing.T) {
	ranked, unranked := Rank(nil)
	if len(ranked) != 0 || len(unranked) != 0 {
		t.Fatalf("an empty batch ranked %v and held %v unranked", ranked, unranked)
	}
}

// The context summary is the sentence the ficha shows. It names the served
// numbers and the ratified weight and radius of the dominant category, and it
// never invents a position for a zone whose priority could not be computed.
func TestContextSummaryStatesTheServedFacts(t *testing.T) {
	ranked, unranked := Rank([]Candidate{
		{
			ZoneID: "05101", RiskLevel: "alto", RiskScore: 96, ExposureScore: 61,
			ExposedAssets: 5, DominantCategory: "hospital", Rankable: true,
		},
		{
			ZoneID: "05201", RiskLevel: "bajo", RiskScore: 20, ExposureScore: 0,
			ExposedAssets: 0, Rankable: true,
		},
		{
			ZoneID: "05401", RiskLevel: "desconocido", ExposureScore: 24,
			ExposedAssets: 2, DominantCategory: "hospital", Rankable: false,
		},
	})
	want := "Comuna 05101: prioridad 86 de 100, puesto 1 de 2 del lote publicado. " +
		"Riesgo 96 de 100 y exposición 61 de 100 sobre 5 elementos ficticios declarados; " +
		"la categoría dominante es hospital (peso 1.00, radio 5.0 km)."
	if got := ranked[0].ContextSummary(); got != want {
		t.Fatalf("context summary is\n%q\nwant\n%q", got, want)
	}

	withoutDominant := ranked[1].ContextSummary()
	if !strings.Contains(withoutDominant, "prioridad 14 de 100, puesto 2 de 2") {
		t.Errorf("a zone with no weighted category lost its position: %q", withoutDominant)
	}
	if !strings.Contains(withoutDominant, "no declara elementos ponderados") {
		t.Errorf("a zone with no weighted category claims one: %q", withoutDominant)
	}

	notRanked := unranked[0].ContextSummary()
	if wantNotRanked := "Comuna 05401: sin puesto regional porque el lote publicado no trae contribuciones usables o su nivel es desconocido. " +
		"Exposición 24 de 100 sobre 2 elementos ficticios declarados."; notRanked != wantNotRanked {
		t.Fatalf("unranked summary is\n%q\nwant\n%q", notRanked, wantNotRanked)
	}
}
