package source

import (
	"encoding/json"
	"math"
	"reflect"
	"strings"
	"testing"

	"firewatch.local/contracts/geo"
	"firewatch.local/risk/internal/domain"
)

// TestSyntheticInfrastructureExposureIsTheRatifiedWeightedIndex pins the table
// the owner ratified and the index derived from it: every zone count is computed
// from its own elements, every weighted category present raises the exposure
// index by its ratified weight over the table's 4.15, and the two declared types
// the table does not name contribute nothing while staying declared.
func TestSyntheticInfrastructureExposureIsTheRatifiedWeightedIndex(t *testing.T) {
	catalogue := SyntheticInfrastructure()
	if catalogue.Source != InfrastructureSourceID {
		t.Fatalf("source is %q, want the declared %q", catalogue.Source, InfrastructureSourceID)
	}
	if InfrastructureSourceID != "synthetic_fixture" {
		t.Fatalf("declared source is %q, want synthetic_fixture", InfrastructureSourceID)
	}
	if len(catalogue.Zones) == 0 {
		t.Fatal("the fixture serves no zone")
	}

	// The published weighting block is the ratified table and the fixture's own
	// fold of its five element types, with the two unweighted types named.
	if len(catalogue.Weighting.Categories) != 5 {
		t.Fatalf("catalogue publishes %d categories, want the ratified 5", len(catalogue.Weighting.Categories))
	}
	if math.Abs(catalogue.Weighting.WeightSum-4.15) > 1e-9 {
		t.Errorf("catalogue weight sum is %v, want 4.15", catalogue.Weighting.WeightSum)
	}
	if math.Abs(catalogue.Weighting.RiskWeight-0.70) > 1e-9 || math.Abs(catalogue.Weighting.ExposureWeight-0.30) > 1e-9 {
		t.Errorf(
			"catalogue priority weights are %v/%v, want the ratified 0.70/0.30",
			catalogue.Weighting.RiskWeight, catalogue.Weighting.ExposureWeight,
		)
	}
	if strings.Join(catalogue.Weighting.UnweightedTypes, ",") != "vivienda,hidrante" {
		t.Errorf("unweighted types are %v, want vivienda and hidrante", catalogue.Weighting.UnweightedTypes)
	}
	// The catalogue's own vocabulary is folded onto the ratified categories in one
	// published place, and only onto categories the table names.
	folded := make(map[string]string, len(catalogue.Weighting.TypeCategories))
	for _, entry := range catalogue.Weighting.TypeCategories {
		if _, ratified := domain.CategoryOf(entry.Category); !ratified {
			t.Errorf("type %q folds onto %q, which the ratified table does not name", entry.Type, entry.Category)
		}
		if entry.Weight <= 0 {
			t.Errorf("type %q folds onto a category with weight %v", entry.Type, entry.Weight)
		}
		folded[entry.Type] = entry.Category
	}
	wantFold := map[string]string{"colegio": "escuela", "hospital": "hospital", "ruta": "vialidad"}
	if !reflect.DeepEqual(folded, wantFold) {
		t.Errorf("the published fold is %v, want %v", folded, wantFold)
	}

	wantExposure := map[string]int{"05101": 61, "05109": 37, "05401": 24, "05801": 16}
	wantAssets := map[string]int{"05101": 5, "05109": 3, "05401": 2, "05801": 2}
	wantDominant := map[string]string{"05101": "hospital", "05109": "escuela", "05401": "hospital", "05801": "vialidad"}

	for _, zone := range catalogue.Zones {
		expected := make(InfrastructureCounts, len(InfrastructureElementTypes()))
		for _, elementType := range InfrastructureElementTypes() {
			expected[elementType] = 0
		}
		exposed := 0
		weightedElements := 0
		for _, element := range zone.Elements {
			exposed++
			if _, weighted := infrastructureTypeCategories[element.Type]; weighted {
				weightedElements++
			}
			if _, known := expected[element.Type]; !known {
				t.Errorf("zone %s element %s has unknown type %q", zone.ZoneID, element.ID, element.Type)
				continue
			}
			expected[element.Type]++
		}
		if len(zone.Counts) != len(InfrastructureElementTypes()) {
			t.Errorf(
				"zone %s carries %d count keys, want all %d",
				zone.ZoneID, len(zone.Counts), len(InfrastructureElementTypes()),
			)
		}
		if !reflect.DeepEqual(zone.Counts, expected) {
			t.Errorf("zone %s counts are %v, want %v computed from its elements", zone.ZoneID, zone.Counts, expected)
		}
		total := 0
		for _, count := range zone.Counts {
			total += count
		}
		if total != len(zone.Elements) {
			t.Errorf("zone %s counts sum to %d, want %d elements", zone.ZoneID, total, len(zone.Elements))
		}
		if zone.ExposedAssetsCount != exposed {
			t.Errorf("zone %s declares %d exposed assets, want %d", zone.ZoneID, zone.ExposedAssetsCount, exposed)
		}
		if zone.ExposedAssetsCount != wantAssets[zone.ZoneID] {
			t.Errorf("zone %s asset count is %d, want the fixture's %d", zone.ZoneID, zone.ExposedAssetsCount, wantAssets[zone.ZoneID])
		}

		// The per-category breakdown always carries the five ratified rows, in
		// table order, with the count taken from the elements and the weight and
		// radius taken from the table instead of restated in the fixture.
		if len(zone.Categories) != len(catalogue.Weighting.Categories) {
			t.Errorf("zone %s carries %d category rows, want 5", zone.ZoneID, len(zone.Categories))
		}
		weighted := 0.0
		counted := 0
		for index, row := range zone.Categories {
			ratified := catalogue.Weighting.Categories[index]
			if row.Category != ratified.Category {
				t.Errorf("zone %s category %d is %q, want %q", zone.ZoneID, index, row.Category, ratified.Category)
			}
			if math.Abs(row.Weight-ratified.Weight) > 1e-12 || math.Abs(row.RadiusKM-ratified.RadiusKM) > 1e-12 {
				t.Errorf(
					"zone %s category %q carries weight %v radius %v, want %v and %v",
					zone.ZoneID, row.Category, row.Weight, row.RadiusKM, ratified.Weight, ratified.RadiusKM,
				)
			}
			weighted += row.Weight * float64(row.Count)
			counted += row.Count
		}
		if counted != weightedElements {
			t.Errorf(
				"zone %s category rows count %d elements, want the %d weighted elements",
				zone.ZoneID, counted, weightedElements,
			)
		}
		if math.Abs(zone.WeightedPoints-weighted) > 1e-9 {
			t.Errorf("zone %s weighted points are %v, want %v", zone.ZoneID, zone.WeightedPoints, weighted)
		}
		if zone.ExposureScore != wantExposure[zone.ZoneID] {
			t.Errorf("zone %s exposure is %d, want the ratified index %d", zone.ZoneID, zone.ExposureScore, wantExposure[zone.ZoneID])
		}
		if zone.ExposureScore < 0 || zone.ExposureScore > 100 {
			t.Errorf("zone %s exposure %d is outside 0..100", zone.ZoneID, zone.ExposureScore)
		}
		if zone.DominantCategory == nil {
			t.Errorf("zone %s has no dominant category", zone.ZoneID)
			continue
		}
		if *zone.DominantCategory != wantDominant[zone.ZoneID] {
			t.Errorf("zone %s dominant category is %q, want %q", zone.ZoneID, *zone.DominantCategory, wantDominant[zone.ZoneID])
		}
	}
}

// TestSyntheticInfrastructureZonesAreOrdered pins the frozen ordering contract:
// descending exposure index, then ascending zone ID. The fixture deliberately
// lists the zones in another order, so insertion order cannot leak into the
// response.
func TestSyntheticInfrastructureZonesAreOrdered(t *testing.T) {
	catalogue := SyntheticInfrastructure()
	got := make([]string, 0, len(catalogue.Zones))
	for _, zone := range catalogue.Zones {
		got = append(got, zone.ZoneID)
	}
	want := []string{"05101", "05109", "05401", "05801"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("zone order is %v, want %v (descending exposure, then ascending ID)", got, want)
	}
	for index := 1; index < len(catalogue.Zones); index++ {
		previous, current := catalogue.Zones[index-1], catalogue.Zones[index]
		ordered := previous.ExposureScore > current.ExposureScore ||
			(previous.ExposureScore == current.ExposureScore && previous.ZoneID < current.ZoneID)
		if !ordered {
			t.Errorf(
				"zone %s (exposure %d) precedes %s (exposure %d)",
				previous.ZoneID, previous.ExposureScore, current.ZoneID, current.ExposureScore,
			)
		}
	}
	if !reflect.DeepEqual(catalogue, SyntheticInfrastructure()) {
		t.Error("two calls answered different catalogues")
	}
}

// TestSortInfrastructureZonesBreaksTiesByZoneID pins the tie-break the fixture no
// longer exercises on its own: two zones with the same exposure index are served
// in ascending zone-id order, whatever order they were assembled in.
func TestSortInfrastructureZonesBreaksTiesByZoneID(t *testing.T) {
	zones := []InfrastructureZone{
		{ZoneID: "05801", ExposureScore: 37},
		{ZoneID: "05109", ExposureScore: 61},
		{ZoneID: "05401", ExposureScore: 37},
		{ZoneID: "05101", ExposureScore: 61},
	}
	sortInfrastructureZones(zones)
	got := make([]string, 0, len(zones))
	for _, zone := range zones {
		got = append(got, zone.ZoneID)
	}
	if want := []string{"05101", "05109", "05401", "05801"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("sorted order is %v, want %v", got, want)
	}
}

// TestSyntheticInfrastructureDeclaresStableFictionalElements pins provenance and
// wire shape: stable fixture identifiers, a declared source, Point geometry for
// every non-route type and LineString for routes, encoded as RFC 7946 positions
// rather than as an invented shape.
func TestSyntheticInfrastructureDeclaresStableFictionalElements(t *testing.T) {
	catalogue := SyntheticInfrastructure()
	seen := make(map[string]bool)
	for _, zone := range catalogue.Zones {
		if len(zone.Elements) == 0 {
			t.Errorf("zone %s has no element", zone.ZoneID)
		}
		for _, element := range zone.Elements {
			if element.ID == "" || !strings.HasPrefix(element.ID, "fixture-") {
				t.Errorf("element ID %q is not a stable fixture identifier", element.ID)
			}
			if seen[element.ID] {
				t.Errorf("element ID %q is repeated", element.ID)
			}
			seen[element.ID] = true
			switch element.Type {
			case "ruta":
				if element.Geometry.Type != "LineString" {
					t.Errorf("route %s geometry is %q, want LineString", element.ID, element.Geometry.Type)
				}
				if len(element.Geometry.Coordinates) < 2 {
					t.Errorf("route %s has %d positions, want at least 2", element.ID, len(element.Geometry.Coordinates))
				}
			case "colegio", "vivienda", "hospital", "hidrante":
				if element.Geometry.Type != "Point" {
					t.Errorf("%s %s geometry is %q, want Point", element.Type, element.ID, element.Geometry.Type)
				}
				if len(element.Geometry.Coordinates) != 1 {
					t.Errorf("point %s has %d positions, want exactly 1", element.ID, len(element.Geometry.Coordinates))
				}
			default:
				t.Errorf("element %s has unknown type %q", element.ID, element.Type)
			}
			for _, position := range element.Geometry.Coordinates {
				lon, lat := position[0], position[1]
				if math.IsNaN(lon) || math.IsNaN(lat) || math.IsInf(lon, 0) || math.IsInf(lat, 0) {
					t.Errorf("element %s has a non-finite position %v", element.ID, position)
					continue
				}
				if lon < -180 || lon > 180 || lat < -90 || lat > 90 {
					t.Errorf("element %s has a position outside WGS84: %v", element.ID, position)
				}
			}
		}
	}

	encoded, err := json.Marshal(catalogue)
	if err != nil {
		t.Fatalf("encode the fixture: %v", err)
	}
	var decoded struct {
		Zones []struct {
			ZoneID   string         `json:"zone_id"`
			Elements []decodedShape `json:"elements"`
		} `json:"zones"`
	}
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("decode the fixture: %v", err)
	}
	if len(decoded.Zones) != len(catalogue.Zones) {
		t.Fatalf("encoded %d zones, want %d", len(decoded.Zones), len(catalogue.Zones))
	}
	for _, zone := range decoded.Zones {
		for _, element := range zone.Elements {
			switch element.Geometry.Type {
			case "Point":
				var position []float64
				if err := json.Unmarshal(element.Geometry.Coordinates, &position); err != nil {
					t.Fatalf("point %s coordinates are not an RFC 7946 position: %v", element.ID, err)
				}
				if len(position) != 2 {
					t.Fatalf("point %s coordinates are %v, want [longitude, latitude]", element.ID, position)
				}
			case "LineString":
				var positions [][]float64
				if err := json.Unmarshal(element.Geometry.Coordinates, &positions); err != nil {
					t.Fatalf("route %s coordinates are not an RFC 7946 position array: %v", element.ID, err)
				}
				if len(positions) < 2 {
					t.Fatalf("route %s serves %d positions, want at least 2", element.ID, len(positions))
				}
				for _, position := range positions {
					if len(position) != 2 {
						t.Fatalf("route %s serves a position %v, want [longitude, latitude]", element.ID, position)
					}
				}
			default:
				t.Fatalf("element %s encoded geometry type %q", element.ID, element.Geometry.Type)
			}
		}
	}
}

type decodedShape struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Geometry struct {
		Type        string          `json:"type"`
		Coordinates json.RawMessage `json:"coordinates"`
	} `json:"geometry"`
}

// TestSyntheticInfrastructureZonesMatchSeededTerritory keeps the fixture honest
// about where its elements claim to be: every zone ID must be a commune code of
// the seeded catalogue asset, and every fictional geometry must fall inside that
// commune's territory. Route segments are sampled between vertices, so a chord
// that cuts across a bay or a neighbouring commune is caught instead of passing
// because its endpoints happen to be inside.
func TestSyntheticInfrastructureZonesMatchSeededTerritory(t *testing.T) {
	territories := seededTerritories(t)
	for _, zone := range SyntheticInfrastructure().Zones {
		polygons, seeded := territories[zone.ZoneID]
		if !seeded {
			t.Errorf("zone %q is not a seeded commune code", zone.ZoneID)
			continue
		}
		for _, element := range zone.Elements {
			if len(element.Geometry.Coordinates) == 0 {
				t.Errorf("element %s has no position", element.ID)
				continue
			}
			for _, position := range element.Geometry.Coordinates {
				if !pointInTerritory(polygons, position) {
					t.Errorf("element %s position %v is outside zone %s", element.ID, position, zone.ZoneID)
				}
			}
			if element.Geometry.Type != "LineString" {
				continue
			}
			const samples = 32
			for index := 0; index+1 < len(element.Geometry.Coordinates); index++ {
				from, to := element.Geometry.Coordinates[index], element.Geometry.Coordinates[index+1]
				for sample := 0; sample <= samples; sample++ {
					ratio := float64(sample) / samples
					position := [2]float64{
						from[0] + (to[0]-from[0])*ratio,
						from[1] + (to[1]-from[1])*ratio,
					}
					if !pointInTerritory(polygons, position) {
						t.Errorf("route %s leaves zone %s at %v", element.ID, zone.ZoneID, position)
						break
					}
				}
			}
		}
	}
}

func seededTerritories(t *testing.T) map[string][][][][2]float64 {
	t.Helper()
	var asset struct {
		Features []struct {
			Properties struct {
				CutCom string `json:"CUT_COM"`
			} `json:"properties"`
			Geometry struct {
				Type        string          `json:"type"`
				Coordinates json.RawMessage `json:"coordinates"`
			} `json:"geometry"`
		} `json:"features"`
	}
	if err := json.Unmarshal(geo.ComunasGeoJSON, &asset); err != nil {
		t.Fatalf("decode the seeded commune asset: %v", err)
	}
	if len(asset.Features) == 0 {
		t.Fatal("the seeded commune asset carries no feature")
	}
	territories := make(map[string][][][][2]float64, len(asset.Features))
	for _, feature := range asset.Features {
		code := feature.Properties.CutCom
		if code == "" {
			t.Fatal("a seeded commune feature has no CUT_COM")
		}
		var polygons [][][][2]float64
		switch feature.Geometry.Type {
		case "Polygon":
			var rings [][][2]float64
			if err := json.Unmarshal(feature.Geometry.Coordinates, &rings); err != nil {
				t.Fatalf("decode commune %s polygon: %v", code, err)
			}
			polygons = [][][][2]float64{rings}
		case "MultiPolygon":
			if err := json.Unmarshal(feature.Geometry.Coordinates, &polygons); err != nil {
				t.Fatalf("decode commune %s multipolygon: %v", code, err)
			}
		default:
			t.Fatalf("commune %s has unsupported geometry %q", code, feature.Geometry.Type)
		}
		territories[code] = polygons
	}
	return territories
}

func pointInTerritory(polygons [][][][2]float64, point [2]float64) bool {
	for _, polygon := range polygons {
		if len(polygon) == 0 {
			continue
		}
		if !pointInRing(polygon[0], point) {
			continue
		}
		inHole := false
		for _, hole := range polygon[1:] {
			if pointInRing(hole, point) {
				inHole = true
				break
			}
		}
		if !inHole {
			return true
		}
	}
	return false
}

// pointInRing is the even-odd rule on a closed linear ring. Sharing an edge or a
// vertex with the boundary is not exercised by the fixture, so the simpler rule
// is enough and the geometries are checked with a margin below.
func pointInRing(ring [][2]float64, point [2]float64) bool {
	if len(ring) < 3 {
		return false
	}
	inside := false
	for index, current := range ring {
		next := ring[(index+1)%len(ring)]
		if (current[1] > point[1]) == (next[1] > point[1]) {
			continue
		}
		intersection := current[0] + (point[1]-current[1])*(next[0]-current[0])/(next[1]-current[1])
		if point[0] < intersection {
			inside = !inside
		}
	}
	return inside
}
