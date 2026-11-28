package engine

import (
	"encoding/json"
	"strings"
	"testing"

	"firewatch.local/risk/internal/repository"
	"firewatch.local/risk/internal/source"
)

// publishedFactors is the persisted factor list of a batch, spelled as the
// classifier writes it so the reconstruction reads real JSON instead of a Go
// literal the producer never emits.
func publishedFactors(t *testing.T, contributions map[string]float64) json.RawMessage {
	t.Helper()
	factors := make([]map[string]any, 0, len(contributions))
	for _, name := range []string{"temperatura", "humedad_relativa", "viento", "cobertura_vegetal", "incendios_historicos"} {
		contribution, known := contributions[name]
		entry := map[string]any{"name": name, "known": known}
		if known {
			entry["value"] = 1
			entry["contribution"] = contribution
		}
		factors = append(factors, entry)
	}
	encoded, err := json.Marshal(factors)
	if err != nil {
		t.Fatalf("encode factors: %v", err)
	}
	return encoded
}

func batch(t *testing.T, zoneID, level string, contributions map[string]float64) repository.Batch {
	t.Helper()
	return repository.Batch{
		ID:         "batch-" + zoneID,
		ZoneID:     zoneID,
		RiskLevel:  level,
		DataStatus: "current",
		Factors:    publishedFactors(t, contributions),
	}
}

func intOf(t *testing.T, value *int, label string) int {
	t.Helper()
	if value == nil {
		t.Fatalf("%s is null", label)
	}
	return *value
}

func stringOf(t *testing.T, value *string, label string) string {
	t.Helper()
	if value == nil {
		t.Fatalf("%s is null", label)
	}
	return *value
}

// The table joins the published batch with the infrastructure catalogue: the risk
// score comes from the batch's own contributions, the exposure index from the
// ratified table applied to the zone's fictional assets, and the priority is the
// weighted pair. The ranking covers the published batch, so a zone that cannot be
// scored is published apart instead of taking a position it did not earn.
func TestBuildRanksThePublishedBatch(t *testing.T) {
	batches := []repository.Batch{
		batch(t, "05109", "medio", map[string]float64{"temperatura": 0.20, "viento": 0.10}),
		batch(t, "05101", "alto", map[string]float64{"temperatura": 0.60, "viento": 0.36, "humedad_relativa": 0.0}),
		batch(t, "05401", "desconocido", map[string]float64{"temperatura": 0.40}),
		batch(t, "05201", "bajo", nil),
	}
	table := Build(batches, source.SyntheticInfrastructure())

	if table.TotalRanked != 2 {
		t.Fatalf("%d zones ranked, want 2: %+v", table.TotalRanked, table.Ranked)
	}
	if len(table.Ranked) != 2 {
		t.Fatalf("ranked list holds %d entries, want 2", len(table.Ranked))
	}

	first := table.Ranked[0]
	if first.ZoneID != "05101" {
		t.Fatalf("top zone is %q, want 05101", first.ZoneID)
	}
	if got := intOf(t, first.RiskScore, "risk_score"); got != 96 {
		t.Errorf("05101 risk score is %d, want the 96 the contributions sum to", got)
	}
	if first.ExposureScore != 61 {
		t.Errorf("05101 exposure is %d, want the ratified index 61", first.ExposureScore)
	}
	if got := intOf(t, first.PriorityScore, "priority_score"); got != 86 {
		t.Errorf("05101 priority is %d, want round(0.70*96 + 0.30*61) = 86", got)
	}
	if got := intOf(t, first.PriorityRank, "priority_rank"); got != 1 {
		t.Errorf("05101 rank is %d, want 1", got)
	}
	if first.ExposedAssetsCount != 5 {
		t.Errorf("05101 declares %d fictional assets, want its 5 fixture elements", first.ExposedAssetsCount)
	}
	if got := stringOf(t, first.DominantCategory, "dominant_category"); got != "hospital" {
		t.Errorf("05101 dominant category is %q, want hospital", got)
	}
	if !strings.Contains(first.ContextSummary, "puesto 1 de 2") {
		t.Errorf("context summary does not state the regional position: %q", first.ContextSummary)
	}

	second := table.Ranked[1]
	if got := intOf(t, second.PriorityRank, "priority_rank"); second.ZoneID != "05109" || got != 2 {
		t.Fatalf("second position is %q rank %d, want 05109 rank 2", second.ZoneID, got)
	}
	if second.ExposureScore != 37 {
		t.Errorf("05109 exposure is %d, want 37", second.ExposureScore)
	}

	if len(table.Unranked) != 2 {
		t.Fatalf("%d unranked zones, want the desconocido and the factorless one", len(table.Unranked))
	}
	for _, entry := range table.Unranked {
		if entry.PriorityRank != nil {
			t.Errorf("unranked %s carries a rank %d", entry.ZoneID, *entry.PriorityRank)
		}
		if entry.PriorityStatus != StatusInsufficient {
			t.Errorf("unranked %s status is %q, want %q", entry.ZoneID, entry.PriorityStatus, StatusInsufficient)
		}
		if entry.ContextSummary == "" {
			t.Errorf("unranked %s claims no context at all", entry.ZoneID)
		}
	}
}

// A zone the fixture does not cover still has a priority: the exposure index is a
// real zero, not an absent reading, and the absence of a dominant category is
// stated instead of filled in.
func TestBuildScoresAZoneWithoutCatalogueAssetsAsAZeroExposure(t *testing.T) {
	table := Build([]repository.Batch{batch(t, "05201", "medio", map[string]float64{"viento": 0.5})}, source.SyntheticInfrastructure())

	entry, ok := table.For("05201", "batch-05201")
	if !ok {
		t.Fatal("05201 is absent from the table")
	}
	if entry.ExposureScore != 0 {
		t.Errorf("05201 exposure is %d, want 0 for a zone the fixture does not cover", entry.ExposureScore)
	}
	if entry.ExposedAssetsCount != 0 {
		t.Errorf("05201 declares %d assets, want 0", entry.ExposedAssetsCount)
	}
	if entry.DominantCategory != nil {
		t.Errorf("05201 dominant category is %q, want none", *entry.DominantCategory)
	}
	if !strings.Contains(entry.ContextSummary, "no declara elementos ponderados") {
		t.Errorf("05101 summary does not state the empty exposure: %q", entry.ContextSummary)
	}
	if entry.PriorityScore == nil || *entry.PriorityScore != 35 {
		t.Fatalf("05201 priority is %v, want round(0.70*50) = 35", entry.PriorityScore)
	}
}

// The tie-break is a property of the table, not of the order storage answered.
func TestBuildBreaksPriorityTiesByZoneIDAscending(t *testing.T) {
	batches := []repository.Batch{
		batch(t, "05109", "medio", map[string]float64{"viento": 0.5}),
		batch(t, "05101", "medio", map[string]float64{"viento": 0.5}),
		batch(t, "05104", "alto", map[string]float64{"viento": 1.0}),
	}
	table := Build(batches, source.SyntheticInfrastructure())
	got := make([]string, 0, len(table.Ranked))
	for _, entry := range table.Ranked {
		got = append(got, entry.ZoneID)
	}
	if strings.Join(got, ",") != "05104,05101,05109" {
		t.Fatalf("ranking is %v, want 05104 then the two tied zones by ascending id", got)
	}
}

// A factor list storage cannot decode is corrupt, not incomplete evidence: the
// zone cannot be scored and its record is omitted from the table, so no route
// publishes an `insufficient` priority built from data nobody could read.
func TestBuildOmitsABatchWhoseFactorListIsUnreadable(t *testing.T) {
	table := Build([]repository.Batch{{
		ID:        "batch-broken",
		ZoneID:    "05101",
		RiskLevel: "alto",
		Factors:   json.RawMessage(`{"not":"an array"}`),
	}}, source.SyntheticInfrastructure())

	if _, ok := table.For("05101", "batch-broken"); ok {
		t.Fatalf("a corrupt factor list produced a priority: %+v", table.Ranked)
	}
	if len(table.Ranked) != 0 || len(table.Unranked) != 0 {
		t.Fatalf("a corrupt record reached the table: ranked=%d unranked=%d", len(table.Ranked), len(table.Unranked))
	}
	if table.TotalRanked != 0 {
		t.Errorf("%d zones ranked, want 0", table.TotalRanked)
	}
}

func TestBuildOfNothingIsAnEmptyTable(t *testing.T) {
	table := Build(nil, source.SyntheticInfrastructure())
	if table.TotalRanked != 0 || len(table.Ranked) != 0 || len(table.Unranked) != 0 {
		t.Fatalf("an empty batch produced %+v", table)
	}
	if _, ok := table.For("05101", "batch-05101"); ok {
		t.Fatal("an empty table answered a zone")
	}
}

// A catalogue the caller assembles by hand must not be trusted more than the real
// one: a zone whose dominant category is outside the ratified table is refused
// instead of published.
func TestBuildRejectsAZoneWhoseCategoryIsNotRatified(t *testing.T) {
	catalogue := source.SyntheticInfrastructure()
	catalogue.Zones[0].Categories = append(catalogue.Zones[0].Categories, source.InfrastructureZoneCategory{
		Category: "vivienda", Weight: 1, RadiusKM: 1, Count: 9,
	})
	entry, ok := Build(
		[]repository.Batch{batch(t, catalogue.Zones[0].ZoneID, "alto", map[string]float64{"viento": 0.5})},
		catalogue,
	).For(catalogue.Zones[0].ZoneID, "batch-"+catalogue.Zones[0].ZoneID)
	if !ok {
		t.Fatal("the zone disappeared")
	}
	if entry.DominantCategory != nil && *entry.DominantCategory == "vivienda" {
		t.Fatal("an unratified category became the dominant one")
	}
}

// S3(a) — a `known` factor whose contribution was never published is corrupt
// evidence: the variable was read and the number that says how much it added is
// missing. The record is omitted instead of being published as insufficient.
func TestBuildOmitsAKnownFactorWithoutContribution(t *testing.T) {
	factors := json.RawMessage(
		`[{"name":"temperatura","known":true,"value":30},` +
			`{"name":"viento","known":true,"value":40,"contribution":0.4}]`,
	)
	table := Build([]repository.Batch{{
		ID:        "batch-05101",
		ZoneID:    "05101",
		RiskLevel: "alto",
		Factors:   factors,
	}}, source.SyntheticInfrastructure())

	if _, ok := table.For("05101", "batch-05101"); ok {
		t.Fatal("a known factor with no contribution produced a priority")
	}
	if table.TotalRanked != 0 || len(table.Unranked) != 0 {
		t.Fatalf("a corrupt record reached the table: ranked=%d unranked=%d", len(table.Ranked), len(table.Unranked))
	}
}

// An `unknown` factor carrying a non-zero contribution contradicts itself: the
// rule could not read the variable, so there is no number for it to have added.
func TestBuildOmitsAnUnknownFactorCarryingAContribution(t *testing.T) {
	table := Build([]repository.Batch{{
		ID:        "batch-05101",
		ZoneID:    "05101",
		RiskLevel: "alto",
		Factors:   json.RawMessage(`[{"name":"viento","known":false,"contribution":0.4}]`),
	}}, source.SyntheticInfrastructure())

	if _, ok := table.For("05101", "batch-05101"); ok {
		t.Fatal("a contradictory unknown factor produced a priority")
	}
	if table.TotalRanked != 0 || len(table.Unranked) != 0 {
		t.Fatalf("a corrupt record reached the table: ranked=%d unranked=%d", len(table.Ranked), len(table.Unranked))
	}
}

// S3 — a factor element that is not a factor at all is corrupt, not an unknown
// variable: `[null]`, `[{}]`, a blank name and an element with no `known` member
// each omit the record instead of publishing an absence the service never stated.
func TestBuildOmitsFactorElementsThatAreNotFactors(t *testing.T) {
	for _, tc := range []struct {
		name    string
		factors string
	}{
		{name: "a null element", factors: `[null]`},
		{name: "an empty object", factors: `[{}]`},
		{name: "a blank name", factors: `[{"name":"   ","known":false}]`},
		{name: "a missing known member", factors: `[{"name":"viento"}]`},
		{name: "a null element beside a valid factor", factors: `[null,{"name":"viento","known":true,"contribution":0.4}]`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			table := Build([]repository.Batch{{
				ID:        "batch-05101",
				ZoneID:    "05101",
				RiskLevel: "alto",
				Factors:   json.RawMessage(tc.factors),
			}}, source.SyntheticInfrastructure())

			if _, ok := table.For("05101", "batch-05101"); ok {
				t.Fatalf("%s produced a priority", tc.factors)
			}
			if len(table.Ranked) != 0 || len(table.Unranked) != 0 {
				t.Fatalf("%s reached the table: ranked=%d unranked=%d", tc.factors, len(table.Ranked), len(table.Unranked))
			}
		})
	}
}

// Valid insufficient evidence — five `unknown` factors that omit value and
// contribution, exactly as the contract allows — is published as insufficient
// with no position at all, next to a zone that can be scored.
func TestBuildPublishesValidInsufficientEvidenceWithoutAPosition(t *testing.T) {
	unknownOnly := json.RawMessage(
		`[{"name":"temperatura","known":false},` +
			`{"name":"humedad_relativa","known":false},` +
			`{"name":"viento","known":false},` +
			`{"name":"cobertura_vegetal","known":false},` +
			`{"name":"incendios_historicos","known":false}]`,
	)
	table := Build([]repository.Batch{
		{ID: "batch-05101", ZoneID: "05101", RiskLevel: "desconocido", Factors: unknownOnly},
		batch(t, "05109", "alto", map[string]float64{"viento": 0.5}),
	}, source.SyntheticInfrastructure())

	entry, ok := table.For("05101", "batch-05101")
	if !ok {
		t.Fatal("valid insufficient evidence was dropped from the table")
	}
	if entry.PriorityStatus != StatusInsufficient {
		t.Fatalf("status is %q, want %q", entry.PriorityStatus, StatusInsufficient)
	}
	if entry.RiskScore != nil || entry.PriorityScore != nil || entry.PriorityRank != nil {
		t.Fatalf("insufficient evidence carries a position: %+v", entry)
	}
	if entry.ExposureScore != 61 {
		t.Errorf("exposure is %d, want the catalogue's 61", entry.ExposureScore)
	}
	if table.TotalRanked != 1 {
		t.Errorf("%d zones ranked, want the scoreable one", table.TotalRanked)
	}
	if ranked, ok := table.For("05109", "batch-05109"); !ok || ranked.PriorityStatus != StatusRanked {
		t.Fatalf("the scoreable zone is not ranked: %+v", table.Ranked)
	}
}

// S3(a) — a batch whose factors carry no usable contribution at all is published
// apart, with its exposure and no position.
func TestBuildTreatsZeroUsableContributionsAsInsufficient(t *testing.T) {
	table := Build(
		[]repository.Batch{batch(t, "05101", "alto", nil)},
		source.SyntheticInfrastructure(),
	)

	entry, ok := table.For("05101", "batch-05101")
	if !ok {
		t.Fatal("the zone is absent instead of published as insufficient")
	}
	if entry.PriorityStatus != StatusInsufficient {
		t.Fatalf("status is %q, want %q", entry.PriorityStatus, StatusInsufficient)
	}
	if entry.RiskScore != nil {
		t.Errorf("a contribution-less batch produced risk score %d", *entry.RiskScore)
	}
	if table.TotalRanked != 0 {
		t.Errorf("%d zones ranked, want 0", table.TotalRanked)
	}
}

// S3(b) — the join is keyed by batch and zone: a newer batch of the same commune
// is a different batch and cannot lend its position to the one being answered.
func TestBuildKeysTheRankingByBatchAndZone(t *testing.T) {
	table := Build(
		[]repository.Batch{batch(t, "05101", "alto", map[string]float64{"viento": 0.5})},
		source.SyntheticInfrastructure(),
	)

	if _, ok := table.For("05101", "batch-newer"); ok {
		t.Fatal("a different batch id borrowed the zone's position")
	}
	if _, ok := table.For("05102", "batch-05101"); ok {
		t.Fatal("a different zone borrowed the batch's position")
	}
	if _, ok := table.For("05101", ""); ok {
		t.Fatal("an empty batch id borrowed a position")
	}
	if _, ok := table.For("05101", "batch-05101"); !ok {
		t.Fatal("the published batch is absent from the ranking")
	}
}

// TestValidWireFactorsClassifiesThePublishedShapes pins the strict factor check
// where the ranking applies it, so the engine and the handler cannot disagree about
// what a readable factor list is.
func TestValidWireFactorsClassifiesThePublishedShapes(t *testing.T) {
	for _, tc := range []struct {
		name string
		raw  string
		want bool
	}{
		{name: "an empty list", raw: `[]`, want: true},
		{name: "a valid known factor", raw: `[{"name":"viento","known":true,"value":40,"contribution":0.4}]`, want: true},
		{name: "an unknown factor that omits its numbers", raw: `[{"name":"viento","known":false}]`, want: true},
		{name: "an unknown factor with an explicit zero contribution", raw: `[{"name":"viento","known":false,"contribution":0}]`, want: true},
		{name: "an absent list is not a list", raw: ``, want: false},
		{name: "a null list", raw: `null`, want: false},
		{name: "a non-array root", raw: `{"not":"an array"}`, want: false},
		{name: "a null element", raw: `[null]`, want: false},
		{name: "a scalar element", raw: `[5]`, want: false},
		{name: "a known factor without value", raw: `[{"name":"viento","known":true,"contribution":0.4}]`, want: false},
		{name: "a known factor without contribution", raw: `[{"name":"viento","known":true,"value":40}]`, want: false},
		{name: "an explicit null contribution", raw: `[{"name":"viento","known":true,"value":40,"contribution":null}]`, want: false},
		{name: "a numeric note", raw: `[{"name":"viento","known":true,"value":40,"contribution":0.4,"note":5}]`, want: false},
		{name: "an explicit null note", raw: `[{"name":"viento","known":false,"note":null}]`, want: false},
		{name: "a negative contribution", raw: `[{"name":"viento","known":true,"value":40,"contribution":-0.1}]`, want: false},
		{name: "an unknown factor carrying a non-zero contribution", raw: `[{"name":"viento","known":false,"contribution":0.4}]`, want: false},
		{name: "a blank name", raw: `[{"name":"   ","known":false}]`, want: false},
		{name: "a missing known member", raw: `[{"name":"viento"}]`, want: false},
		{name: "a capitalized name key", raw: `[{"Name":"viento","known":false}]`, want: false},
		{name: "a capitalized known key", raw: `[{"name":"viento","known":true,"Known":false,"value":40,"contribution":0.4}]`, want: false},
		{name: "a capitalized value key", raw: `[{"name":"viento","known":true,"value":40,"Value":41,"contribution":0.4}]`, want: false},
		{name: "a capitalized contribution key", raw: `[{"name":"viento","known":true,"value":40,"contribution":0.4,"Contribution":0.1}]`, want: false},
		{name: "an extra key", raw: `[{"name":"viento","known":true,"value":40,"contribution":0.4,"extra":1}]`, want: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := ValidWireFactors(json.RawMessage(tc.raw)); got != tc.want {
				t.Fatalf("ValidWireFactors(%s) = %v, want %v", tc.raw, got, tc.want)
			}
		})
	}
}

// S3 — a malformed row must be excluded before the ranking is computed. It used to
// enter the ranking because the engine checked less than the wire, so a
// higher-scoring row with a missing `value` or a numeric `note` shifted a valid
// peer from #1 of 1 to #2 of 2.
func TestBuildExcludesMalformedRowsBeforeRanking(t *testing.T) {
	for _, tc := range []struct {
		name   string
		broken string
	}{
		{name: "a known factor without value", broken: `[{"name":"viento","known":true,"contribution":0.95}]`},
		{name: "a numeric note", broken: `[{"name":"viento","known":true,"value":40,"contribution":0.95,"note":5}]`},
		{name: "a capitalized known key", broken: `[{"name":"viento","known":true,"Known":false,"value":40,"contribution":0.95}]`},
		{name: "a capitalized contribution key", broken: `[{"name":"viento","known":true,"value":40,"contribution":0.95,"Contribution":0.05}]`},
		{name: "an extra key", broken: `[{"name":"viento","known":true,"value":40,"contribution":0.95,"extra":1}]`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			malformed := repository.Batch{
				ID:        "batch-05101",
				ZoneID:    "05101",
				RiskLevel: "alto",
				Factors:   json.RawMessage(tc.broken),
			}
			valid := batch(t, "05109", "alto", map[string]float64{"viento": 0.5})
			table := Build([]repository.Batch{malformed, valid}, source.SyntheticInfrastructure())

			if _, ok := table.For("05101", "batch-05101"); ok {
				t.Fatal("a malformed row entered the ranking")
			}
			if table.TotalRanked != 1 {
				t.Fatalf("%d zones ranked, want only the valid one", table.TotalRanked)
			}
			entry, ok := table.For("05109", "batch-05109")
			if !ok {
				t.Fatal("the valid peer is absent from the ranking")
			}
			if entry.PriorityRank == nil || *entry.PriorityRank != 1 {
				t.Fatalf("the valid peer holds rank %v, want 1", entry.PriorityRank)
			}
			if entry.TotalRankedZones != 1 {
				t.Fatalf("the valid peer reports %d ranked zones, want 1", entry.TotalRankedZones)
			}
		})
	}
}
