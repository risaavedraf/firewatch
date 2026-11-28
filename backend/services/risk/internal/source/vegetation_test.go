package source

import (
	"encoding/json"
	"math"
	"reflect"
	"testing"

	"firewatch.local/contracts/geo"
	"firewatch.local/risk/internal/zones"
)

// TestSyntheticVegetationCoversTheZoneCatalogue pins the coverage the PM-12
// decision demands: the land-cover catalogue is exactly the seeded commune
// catalogue --38 comunas, no invented code and no missing one-- and it carries
// each comuna's own name, so a row of the sector table can never name a zone the
// zones route does not serve.
func TestSyntheticVegetationCoversTheZoneCatalogue(t *testing.T) {
	catalogue := mustSyntheticVegetation(t)
	if catalogue.Source != VegetationSourceLabel {
		t.Fatalf("catalogue source is %q, want %q", catalogue.Source, VegetationSourceLabel)
	}
	if VegetationSourceLabel != "SINTETICO_SEED_V1" {
		t.Fatalf("declared source label is %q, want SINTETICO_SEED_V1", VegetationSourceLabel)
	}

	seeded, err := zones.ParseComunas(geo.ComunasGeoJSON)
	if err != nil {
		t.Fatalf("parse the seeded commune catalogue: %v", err)
	}
	if len(seeded) != 38 {
		t.Fatalf("the commune catalogue carries %d zones, want the seeded 38", len(seeded))
	}
	if len(catalogue.Zones) != len(seeded) {
		t.Fatalf("the land-cover catalogue carries %d zones, want %d", len(catalogue.Zones), len(seeded))
	}

	names := make(map[string]string, len(seeded))
	for _, zone := range seeded {
		names[zone.Code] = zone.Name
	}
	seen := make(map[string]bool, len(catalogue.Zones))
	previous := ""
	for index, zone := range catalogue.Zones {
		if seen[zone.ZoneID] {
			t.Errorf("zone %q appears twice in the catalogue", zone.ZoneID)
		}
		seen[zone.ZoneID] = true
		if zone.ZoneName != names[zone.ZoneID] {
			t.Errorf("zone %q is named %q, want the seeded %q", zone.ZoneID, zone.ZoneName, names[zone.ZoneID])
		}
		// The documented order is ascending zone_id, so the sector table can be
		// rendered without sorting and two runs stay byte-identical.
		if index > 0 && zone.ZoneID <= previous {
			t.Errorf("zone %q follows %q, want ascending zone_id", zone.ZoneID, previous)
		}
		previous = zone.ZoneID
	}
	for code := range names {
		if !seen[code] {
			t.Errorf("seeded zone %q is missing from the land-cover catalogue", code)
		}
	}
}

// TestSyntheticVegetationHoldsEveryDeclaredInvariant checks, zone by zone, the
// bounds the PM-12 decision fixes: NDVI inside 0.00..1.00 with
// min <= mean <= max, an anomaly inside -1.00..1.00, five breakdown percentages
// inside 0..100 that sum to exactly 100, a closed environment class and the
// declared synthetic provenance. A payload that breaks any of them would be
// rendered as a measurement nobody took.
func TestSyntheticVegetationHoldsEveryDeclaredInvariant(t *testing.T) {
	catalogue := mustSyntheticVegetation(t)
	classes := make(map[EnvironmentClass]int, len(EnvironmentClasses()))
	means := make(map[float64]bool, len(catalogue.Zones))
	for _, zone := range catalogue.Zones {
		checkNDVI(t, zone)
		checkBreakdown(t, zone)
		if !zone.Synthetic || zone.SourceLabel != VegetationSourceLabel {
			t.Errorf(
				"zone %q declares synthetic %v and label %q, want true and %q",
				zone.ZoneID, zone.Synthetic, zone.SourceLabel, VegetationSourceLabel,
			)
		}
		classes[zone.EnvironmentClass]++
		means[zone.NDVIMean] = true
	}

	// A catalogue that answered one constant profile for 38 comunas would satisfy
	// every bound above while telling a reader nothing: variety is part of the
	// contract, not a cosmetic detail.
	if len(means) < 3 {
		t.Errorf("the catalogue serves %d distinct ndvi_mean values, want at least 3", len(means))
	}
	if len(classes) < 2 {
		t.Errorf("the catalogue serves %d distinct environment classes, want at least 2", len(classes))
	}
}

// checkNDVI pins one zone's NDVI block: hundredths in 0..1, ordered, with the
// anomaly inside its own range. Every served value is a whole hundredth, so a
// rounding step can never break the ordering the client validates.
func checkNDVI(t *testing.T, zone ZoneLandCover) {
	t.Helper()
	for label, value := range map[string]float64{
		"ndvi_mean": zone.NDVIMean,
		"ndvi_min":  zone.NDVIMin,
		"ndvi_max":  zone.NDVIMax,
	} {
		if value < 0 || value > 1 {
			t.Errorf("zone %q %s is %v, want 0..1", zone.ZoneID, label, value)
		}
		if math.Abs(value*100-math.Round(value*100)) > 1e-9 {
			t.Errorf("zone %q %s is %v, want a whole hundredth", zone.ZoneID, label, value)
		}
	}
	if zone.NDVIMin > zone.NDVIMean || zone.NDVIMean > zone.NDVIMax {
		t.Errorf(
			"zone %q serves min %v, mean %v, max %v, want min <= mean <= max",
			zone.ZoneID, zone.NDVIMin, zone.NDVIMean, zone.NDVIMax,
		)
	}
	if zone.NDVIAnomaly < -1 || zone.NDVIAnomaly > 1 {
		t.Errorf("zone %q ndvi_anomaly is %v, want -1..1", zone.ZoneID, zone.NDVIAnomaly)
	}
	if math.IsNaN(zone.NDVIAnomaly) || math.IsInf(zone.NDVIAnomaly, 0) {
		t.Errorf("zone %q ndvi_anomaly is not finite", zone.ZoneID)
	}
}

// checkBreakdown pins the five declared percentages: each inside 0..100 and the
// five of them summing to exactly 100.
func checkBreakdown(t *testing.T, zone ZoneLandCover) {
	t.Helper()
	breakdown := zone.LandCoverBreakdown
	values := map[string]float64{
		"bosque_nativo_pct":            breakdown.BosqueNativoPct,
		"plantacion_forestal_pct":      breakdown.PlantacionForestalPct,
		"matorral_pastizal_pct":        breakdown.MatorralPastizalPct,
		"interfaz_urbano_forestal_pct": breakdown.InterfazUrbanoForestalPct,
		"suelo_desnudo_agua_pct":       breakdown.SueloDesnudoAguaPct,
	}
	total := 0.0
	for label, value := range values {
		if value < 0 || value > 100 {
			t.Errorf("zone %q %s is %v, want 0..100", zone.ZoneID, label, value)
		}
		total += value
	}
	if math.Abs(total-100) > 1e-9 {
		t.Errorf("zone %q breakdown sums to %v, want exactly 100", zone.ZoneID, total)
	}
}

// TestSyntheticVegetationIsDeterministic proves the fixture is compiled-in data
// and not a generator: two calls serialise to the same bytes, so two responses of
// the same deployment can never disagree.
func TestSyntheticVegetationIsDeterministic(t *testing.T) {
	first, err := json.Marshal(mustSyntheticVegetation(t))
	if err != nil {
		t.Fatalf("marshal the first catalogue: %v", err)
	}
	second, err := json.Marshal(mustSyntheticVegetation(t))
	if err != nil {
		t.Fatalf("marshal the second catalogue: %v", err)
	}
	if string(first) != string(second) {
		t.Error("two calls serialised different catalogues")
	}
}

// TestSyntheticVegetationWireShape pins the JSON members the contract publishes,
// key by key, so a rename in the struct cannot silently change the response.
func TestSyntheticVegetationWireShape(t *testing.T) {
	encoded, err := json.Marshal(mustSyntheticVegetation(t))
	if err != nil {
		t.Fatalf("marshal the catalogue: %v", err)
	}
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("decode the catalogue: %v", err)
	}
	assertKeys(t, "catalogue", decoded, "source", "zones")

	var entries []map[string]json.RawMessage
	if err := json.Unmarshal(decoded["zones"], &entries); err != nil {
		t.Fatalf("decode zones: %v", err)
	}
	if len(entries) == 0 {
		t.Fatal("the catalogue serves no zone")
	}
	assertKeys(
		t, "zone", entries[0],
		"zone_id", "zone_name", "ndvi_mean", "ndvi_min", "ndvi_max", "ndvi_anomaly",
		"land_cover_breakdown", "environment_class", "synthetic", "source_label",
	)

	var breakdown map[string]json.RawMessage
	if err := json.Unmarshal(entries[0]["land_cover_breakdown"], &breakdown); err != nil {
		t.Fatalf("decode breakdown: %v", err)
	}
	assertKeys(
		t, "breakdown", breakdown,
		"bosque_nativo_pct", "plantacion_forestal_pct", "matorral_pastizal_pct",
		"interfaz_urbano_forestal_pct", "suelo_desnudo_agua_pct",
	)
}

// TestVegetationZoneAnswersTheCatalogueEntry proves the per-batch join reads the
// same entry the route serves, and that a zone outside the catalogue is an
// explicit absence instead of a zeroed block.
func TestVegetationZoneAnswersTheCatalogueEntry(t *testing.T) {
	catalogue := mustSyntheticVegetation(t)
	for _, want := range catalogue.Zones[:3] {
		got, ok := VegetationZone(want.ZoneID)
		if !ok {
			t.Fatalf("zone %q is missing from the lookup", want.ZoneID)
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("lookup for %q returned %+v, want %+v", want.ZoneID, got, want)
		}
	}
	for _, missing := range []string{"valparaiso-demo", "99999", ""} {
		if _, ok := VegetationZone(missing); ok {
			t.Errorf("zone %q resolved a land cover the catalogue does not declare", missing)
		}
	}
}

// TestEnvironmentClassesAreTheDeclaredFour pins the closed vocabulary the
// decision fixes, in the order it fixes it.
func TestEnvironmentClassesAreTheDeclaredFour(t *testing.T) {
	want := []EnvironmentClass{
		EnvironmentWUIAlta,
		EnvironmentForestalDenso,
		EnvironmentMixtoRural,
		EnvironmentPeriurbano,
	}
	if got := EnvironmentClasses(); !reflect.DeepEqual(got, want) {
		t.Fatalf("declared classes are %v, want %v", got, want)
	}
	if got := []string{string(EnvironmentWUIAlta), string(EnvironmentForestalDenso), string(EnvironmentMixtoRural), string(EnvironmentPeriurbano)}; !reflect.DeepEqual(got, []string{
		"WUI_ALTA", "FORESTAL_DENSO", "MIXTO_RURAL", "PERIURBANO",
	}) {
		t.Errorf("class literals are %v, want the four declared values", got)
	}
}

// mustSyntheticVegetation reads the built catalogue or fails the test: the
// embedded asset is compiled in, so a read failure is a defect and not an input.
func mustSyntheticVegetation(t *testing.T) VegetationCatalogue {
	t.Helper()
	catalogue, err := SyntheticVegetation()
	if err != nil {
		t.Fatalf("build the land-cover catalogue: %v", err)
	}
	return catalogue
}

// assertKeys fails unless object carries exactly the declared members.
func assertKeys(t *testing.T, label string, object map[string]json.RawMessage, want ...string) {
	t.Helper()
	if len(object) != len(want) {
		t.Errorf("%s carries %d keys, want exactly %d", label, len(object), len(want))
	}
	for _, key := range want {
		if _, present := object[key]; !present {
			t.Errorf("%s is missing the %q key", label, key)
		}
	}
}
