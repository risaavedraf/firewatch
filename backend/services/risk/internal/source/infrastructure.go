package source

import (
	"encoding/json"
	"fmt"
	"sort"

	"firewatch.local/risk/internal/domain"
)

// InfrastructureSourceID is the declared origin of the embedded infrastructure
// catalogue. It is repeated in the response and in the UI/PDF label so a reader
// can tell the demo fixture from the mandante's real infrastructure catalogue.
const InfrastructureSourceID = "synthetic_fixture"

const (
	infrastructurePoint      = "Point"
	infrastructureLineString = "LineString"
)

// InfrastructureElementTypes returns a copy of the frozen type vocabulary. The
// response always carries a count for every one of these types, zero included,
// so this list is the single place that decides which breakdown keys exist.
func InfrastructureElementTypes() []string {
	return []string{"colegio", "vivienda", "hospital", "ruta", "hidrante"}
}

// InfrastructureCategory is one row of the ratified weighting table: the category,
// the element-type aliases that fold onto it, its weight and its exposure radius.
// The values come from the domain rule, never from this package.
type InfrastructureCategory struct {
	Category string   `json:"category"`
	Aliases  []string `json:"aliases"`
	Weight   float64  `json:"weight"`
	RadiusKM float64  `json:"radius_km"`
}

// InfrastructureTypeCategory is this catalogue's own fold of one declared element
// type onto the ratified table. The PM-11 vocabulary names a school a `colegio` and
// a route a `ruta`; the ratified table names the same assets `escuela` and
// `vialidad`, so the fold is published instead of being left for the client to
// guess.
type InfrastructureTypeCategory struct {
	Type     string  `json:"type"`
	Category string  `json:"category"`
	Weight   float64 `json:"weight"`
	RadiusKM float64 `json:"radius_km"`
}

// InfrastructureWeighting is the published weighting block: the ratified table,
// the three formulas the indices are computed with, and the two declared types the
// table does not rate. It replaces the retired one-point-per-element demo policy.
type InfrastructureWeighting struct {
	ExposureFormula string                       `json:"exposure_formula"`
	PriorityFormula string                       `json:"priority_formula"`
	RiskFormula     string                       `json:"risk_formula"`
	RiskWeight      float64                      `json:"risk_weight"`
	ExposureWeight  float64                      `json:"exposure_weight"`
	WeightSum       float64                      `json:"weight_sum"`
	Categories      []InfrastructureCategory     `json:"categories"`
	TypeCategories  []InfrastructureTypeCategory `json:"type_categories"`
	UnweightedTypes []string                     `json:"unweighted_types"`
}

// infrastructureTypeCategories folds the catalogue's own vocabulary onto the
// ratified categories. A type absent from this map keeps its entity, zone and
// geometry but contributes no weight: the ratified table does not name it, and
// inventing a weight for it would be a decision nobody ratified.
var infrastructureTypeCategories = map[string]string{
	"colegio":  "escuela",
	"hospital": "hospital",
	"ruta":     "vialidad",
}

// InfrastructureWeightingTable builds the published weighting block from the
// domain rule, so the catalogue, the index and the page cannot disagree.
func InfrastructureWeightingTable() InfrastructureWeighting {
	ratified := domain.Categories()
	categories := make([]InfrastructureCategory, 0, len(ratified))
	for _, category := range ratified {
		categories = append(categories, InfrastructureCategory{
			Category: category.Category,
			Aliases:  category.Aliases,
			Weight:   category.Weight,
			RadiusKM: category.RadiusKM,
		})
	}

	typeCategories := make([]InfrastructureTypeCategory, 0, len(infrastructureTypeCategories))
	unweighted := make([]string, 0, 2)
	for _, elementType := range InfrastructureElementTypes() {
		categoryName, weighted := infrastructureTypeCategories[elementType]
		if !weighted {
			unweighted = append(unweighted, elementType)
			continue
		}
		category, _ := domain.CategoryOf(categoryName)
		typeCategories = append(typeCategories, InfrastructureTypeCategory{
			Type:     elementType,
			Category: category.Category,
			Weight:   category.Weight,
			RadiusKM: category.RadiusKM,
		})
	}

	riskWeight, exposureWeight := domain.PriorityWeights()
	return InfrastructureWeighting{
		ExposureFormula: domain.ExposureFormula(),
		PriorityFormula: domain.PriorityFormula(),
		RiskFormula:     domain.RiskFormula(),
		RiskWeight:      riskWeight,
		ExposureWeight:  exposureWeight,
		WeightSum:       domain.CategoryWeightSum(),
		Categories:      categories,
		TypeCategories:  typeCategories,
		UnweightedTypes: unweighted,
	}
}

// InfrastructureCounts is the per-type breakdown of a zone. Every vocabulary
// type is present, with zero when the zone has no element of that type, and the
// counts are computed from the zone's elements instead of declared beside them.
type InfrastructureCounts map[string]int

// InfrastructureElement is one fictional asset: a stable fixture identity, a
// declared type and an RFC 7946 geometry linked to its zone's territory.
type InfrastructureElement struct {
	ID       string                 `json:"id"`
	Type     string                 `json:"type"`
	Geometry InfrastructureGeometry `json:"geometry"`
}

// InfrastructureGeometry is an RFC 7946 geometry restricted to the two shapes
// this catalogue needs: Point for buildings and hydrants, LineString for routes.
// Coordinates are [longitude, latitude] WGS84 positions.
type InfrastructureGeometry struct {
	Type        string
	Coordinates [][2]float64
}

// MarshalJSON emits the RFC 7946 shape the declared type requires: a Point is
// one position, while a LineString is an array of positions. Encoding both
// through one struct would turn every point into a one-element line, which is
// not a valid GeoJSON Point.
func (g InfrastructureGeometry) MarshalJSON() ([]byte, error) {
	switch g.Type {
	case infrastructurePoint:
		if len(g.Coordinates) != 1 {
			return nil, fmt.Errorf("point geometry has %d positions, want exactly 1", len(g.Coordinates))
		}
		return json.Marshal(struct {
			Type        string     `json:"type"`
			Coordinates [2]float64 `json:"coordinates"`
		}{Type: g.Type, Coordinates: g.Coordinates[0]})
	case infrastructureLineString:
		if len(g.Coordinates) < 2 {
			return nil, fmt.Errorf("lineString geometry has %d positions, want at least 2", len(g.Coordinates))
		}
		return json.Marshal(struct {
			Type        string       `json:"type"`
			Coordinates [][2]float64 `json:"coordinates"`
		}{Type: g.Type, Coordinates: g.Coordinates})
	default:
		return nil, fmt.Errorf("unsupported infrastructure geometry %q", g.Type)
	}
}

// InfrastructureZoneCategory is one row of a zone's per-category breakdown: the
// ratified weight and radius, the count of elements the zone declares for that
// category and the weighted points they contribute.
type InfrastructureZoneCategory struct {
	Category       string  `json:"category"`
	Weight         float64 `json:"weight"`
	RadiusKM       float64 `json:"radius_km"`
	Count          int     `json:"count"`
	WeightedPoints float64 `json:"weighted_points"`
}

// InfrastructureZone is one seeded zone with its derived exposure index, weighted
// breakdown and fictional elements.
type InfrastructureZone struct {
	ZoneID         string  `json:"zone_id"`
	ExposureScore  int     `json:"exposure_score"`
	WeightedPoints float64 `json:"weighted_points"`
	// ExposedAssetsCount is how many fictional assets the zone declares. It is a
	// count of declared entities, not a severity: a zone with five elements is not
	// twice as exposed as a zone with two unless the categories say so.
	ExposedAssetsCount int `json:"exposed_assets_count"`
	// DominantCategory is the ratified category with the greatest weighted points,
	// ties broken by the table's own order. It is null when the zone declares no
	// weighted element, so "none" is never reported as one of the five.
	DominantCategory *string                      `json:"dominant_category"`
	Counts           InfrastructureCounts         `json:"counts"`
	Categories       []InfrastructureZoneCategory `json:"categories"`
	Elements         []InfrastructureElement      `json:"elements"`
}

// InfrastructureCatalogue is the frozen response body: the declared origin, the
// ratified weighting table and the zones ordered by descending exposure index,
// then ascending zone ID.
type InfrastructureCatalogue struct {
	Source    string                  `json:"source"`
	Weighting InfrastructureWeighting `json:"weighting"`
	Zones     []InfrastructureZone    `json:"zones"`
}

// SyntheticInfrastructure returns the embedded fictional infrastructure catalogue
// for the PM-11 demo. It reads no database, broker or external service: the
// entries are compiled in, the weights are the ratified table, and counts, the
// exposure index and the dominant category are derived from those same entries.
func SyntheticInfrastructure() InfrastructureCatalogue {
	fixture := infrastructureFixture()
	weighting := InfrastructureWeightingTable()
	elementTypes := InfrastructureElementTypes()
	zones := make([]InfrastructureZone, 0, len(fixture))
	for _, declared := range fixture {
		counts := make(InfrastructureCounts, len(elementTypes))
		for _, elementType := range elementTypes {
			counts[elementType] = 0
		}
		for _, element := range declared.elements {
			counts[element.Type]++
		}
		zones = append(zones, newInfrastructureZone(declared, counts, weighting))
	}
	sortInfrastructureZones(zones)
	return InfrastructureCatalogue{
		Source:    InfrastructureSourceID,
		Weighting: weighting,
		Zones:     zones,
	}
}

// newInfrastructureZone derives the weighted breakdown, the exposure index and the
// dominant category from one zone's own elements. Nothing here is declared next to
// the elements it describes.
func newInfrastructureZone(
	declared infrastructureZoneFixture,
	counts InfrastructureCounts,
	weighting InfrastructureWeighting,
) InfrastructureZone {
	countByCategory := make(map[string]int, len(weighting.Categories))
	for _, element := range declared.elements {
		category, weighted := infrastructureTypeCategories[element.Type]
		if !weighted {
			continue
		}
		countByCategory[category]++
	}

	present := make([]string, 0, len(countByCategory))
	categories := make([]InfrastructureZoneCategory, 0, len(weighting.Categories))
	weightedPoints := 0.0
	for _, row := range weighting.Categories {
		count := countByCategory[row.Category]
		points := row.Weight * float64(count)
		weightedPoints += points
		if count > 0 {
			present = append(present, row.Category)
		}
		categories = append(categories, InfrastructureZoneCategory{
			Category:       row.Category,
			Weight:         row.Weight,
			RadiusKM:       row.RadiusKM,
			Count:          count,
			WeightedPoints: points,
		})
	}

	// The table is ordered by descending weight, so a strict comparison keeps the
	// heavier category on a tie and the first row wins without a second rule.
	dominant := ""
	bestPoints := 0.0
	for _, row := range categories {
		if row.Count == 0 {
			continue
		}
		if dominant == "" || row.WeightedPoints > bestPoints {
			dominant = row.Category
			bestPoints = row.WeightedPoints
		}
	}

	zone := InfrastructureZone{
		ZoneID:             declared.zoneID,
		ExposureScore:      domain.ExposureScore(present...),
		WeightedPoints:     weightedPoints,
		ExposedAssetsCount: len(declared.elements),
		Counts:             counts,
		Categories:         categories,
		Elements:           declared.elements,
	}
	if dominant != "" {
		zone.DominantCategory = &dominant
	}
	return zone
}

// sortInfrastructureZones keeps the documented order a property of this package:
// descending exposure index, ties broken by ascending zone id.
func sortInfrastructureZones(zones []InfrastructureZone) {
	sort.SliceStable(zones, func(i, j int) bool {
		if zones[i].ExposureScore != zones[j].ExposureScore {
			return zones[i].ExposureScore > zones[j].ExposureScore
		}
		return zones[i].ZoneID < zones[j].ZoneID
	})
}

// infrastructureZoneFixture is one zone before its score and counts are derived.
type infrastructureZoneFixture struct {
	zoneID   string
	elements []InfrastructureElement
}

// infrastructureFixture returns the fictional set. The literal is deliberately
// not in response order: descending score and the ascending zone-ID tie-break
// are properties of the response contract, not of how this list is written.
//
// Zone IDs are seeded commune codes and each geometry lies inside that commune's
// territory, so the fictional element is linked to a real seeded zone without
// borrowing any real asset identity or location. The positions are interior
// points chosen for the fixture, not positions of schools, homes or hydrants.
func infrastructureFixture() []infrastructureZoneFixture {
	return []infrastructureZoneFixture{
		{
			zoneID: "05801",
			elements: []InfrastructureElement{
				pointElement("fixture-05801-vivienda-1", "vivienda", -71.259774, -33.151081),
				routeElement("fixture-05801-ruta-1", [2]float64{-71.253774, -33.147081}, [2]float64{-71.223774, -33.147081}),
			},
		},
		{
			zoneID: "05109",
			elements: []InfrastructureElement{
				pointElement("fixture-05109-colegio-1", "colegio", -71.521291, -33.031628),
				pointElement("fixture-05109-vivienda-1", "vivienda", -71.510291, -33.032628),
				routeElement("fixture-05109-ruta-1", [2]float64{-71.515291, -33.027628}, [2]float64{-71.485291, -33.027628}),
			},
		},
		{
			zoneID: "05101",
			elements: []InfrastructureElement{
				pointElement("fixture-05101-colegio-1", "colegio", -71.578878, -33.133609),
				pointElement("fixture-05101-vivienda-1", "vivienda", -71.567878, -33.134609),
				pointElement("fixture-05101-hospital-1", "hospital", -71.570878, -33.123609),
				routeElement("fixture-05101-ruta-1", [2]float64{-71.572878, -33.129609}, [2]float64{-71.542878, -33.129609}),
				pointElement("fixture-05101-hidrante-1", "hidrante", -71.580878, -33.126609),
			},
		},
		{
			zoneID: "05401",
			elements: []InfrastructureElement{
				pointElement("fixture-05401-hospital-1", "hospital", -71.277137, -32.35779),
				pointElement("fixture-05401-hidrante-1", "hidrante", -71.266137, -32.35879),
			},
		},
	}
}

func pointElement(id, elementType string, lon, lat float64) InfrastructureElement {
	return InfrastructureElement{
		ID:   id,
		Type: elementType,
		Geometry: InfrastructureGeometry{
			Type:        infrastructurePoint,
			Coordinates: [][2]float64{{lon, lat}},
		},
	}
}

func routeElement(id string, positions ...[2]float64) InfrastructureElement {
	return InfrastructureElement{
		ID:   id,
		Type: "ruta",
		Geometry: InfrastructureGeometry{
			Type:        infrastructureLineString,
			Coordinates: positions,
		},
	}
}
