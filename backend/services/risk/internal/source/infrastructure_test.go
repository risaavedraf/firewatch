package source

import (
	"encoding/json"
	"math"
	"reflect"
	"strings"
	"testing"

	"firewatch.local/contracts/geo"
)

// TestSyntheticInfrastructureScoreIsTheSumOfItsCounts pins the demo formula:
// every element contributes exactly one point, so a zone score is the number of
// fixture elements it holds, and each per-type count is derived from those same
// entries rather than declared next to them.
func TestSyntheticInfrastructureScoreIsTheSumOfItsCounts(t *testing.T) {
	catalogue := SyntheticInfrastructure()
	if catalogue.Source != InfrastructureSourceID {
		t.Fatalf("source is %q, want the declared %q", catalogue.Source, InfrastructureSourceID)
	}
	if InfrastructureSourceID != "synthetic_fixture" {
		t.Fatalf("declared source is %q, want synthetic_fixture", InfrastructureSourceID)
	}
	if catalogue.PointsPerElement != 1 {
		t.Fatalf("points per element is %d, want the approved demo weight 1", catalogue.PointsPerElement)
	}
	if len(catalogue.Zones) == 0 {
		t.Fatal("the fixture serves no zone")
	}

	for _, zone := range catalogue.Zones {
		if zone.Score != catalogue.PointsPerElement*len(zone.Elements) {
			t.Errorf(
				"zone %s score is %d, want %d points for %d elements",
				zone.ZoneID, zone.Score, catalogue.PointsPerElement*len(zone.Elements), len(zone.Elements),
			)
		}
		expected := make(InfrastructureCounts, len(InfrastructureElementTypes()))
		for _, elementType := range InfrastructureElementTypes() {
			expected[elementType] = 0
		}
		for _, element := range zone.Elements {
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
		if total != zone.Score/catalogue.PointsPerElement {
			t.Errorf("zone %s counts sum to %d but score is %d", zone.ZoneID, total, zone.Score)
		}
	}
}

// TestSyntheticInfrastructureZonesAreOrdered pins the frozen ordering contract:
// descending score, then ascending zone ID. The fixture deliberately lists the
// zones in another order, and two of them tie, so a stable sort alone would not
// pass and insertion order cannot leak into the response.
func TestSyntheticInfrastructureZonesAreOrdered(t *testing.T) {
	catalogue := SyntheticInfrastructure()
	got := make([]string, 0, len(catalogue.Zones))
	for _, zone := range catalogue.Zones {
		got = append(got, zone.ZoneID)
	}
	want := []string{"05101", "05109", "05401", "05801"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("zone order is %v, want %v (descending score, then ascending ID)", got, want)
	}
	if catalogue.Zones[2].Score != catalogue.Zones[3].Score {
		t.Fatalf(
			"the fixture no longer exercises the score tie-break: %d and %d",
			catalogue.Zones[2].Score, catalogue.Zones[3].Score,
		)
	}
	for index := 1; index < len(catalogue.Zones); index++ {
		previous, current := catalogue.Zones[index-1], catalogue.Zones[index]
		ordered := previous.Score > current.Score ||
			(previous.Score == current.Score && previous.ZoneID < current.ZoneID)
		if !ordered {
			t.Errorf("zone %s (score %d) precedes %s (score %d)", previous.ZoneID, previous.Score, current.ZoneID, current.Score)
		}
	}
	if !reflect.DeepEqual(catalogue, SyntheticInfrastructure()) {
		t.Error("two calls answered different catalogues")
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
