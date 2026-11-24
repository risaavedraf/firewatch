package source

import (
	"encoding/json"
	"fmt"
	"sort"
)

// InfrastructureSourceID is the declared origin of the embedded infrastructure
// catalogue. It is repeated in the response and in the UI/PDF label so a reader
// can tell the demo fixture from the mandante's real infrastructure catalogue.
const InfrastructureSourceID = "synthetic_fixture"

// InfrastructurePointsPerElement is the provisional demo weight: one point per
// element, regardless of type. It describes exposure in the demo only; it is not
// an approved production weight and it does not change the risk classifier.
const InfrastructurePointsPerElement = 1

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

// InfrastructureZone is one seeded zone with its derived score, breakdown and
// fictional elements.
type InfrastructureZone struct {
	ZoneID   string                  `json:"zone_id"`
	Score    int                     `json:"score"`
	Counts   InfrastructureCounts    `json:"counts"`
	Elements []InfrastructureElement `json:"elements"`
}

// InfrastructureCatalogue is the frozen response body: the declared origin, the
// provisional demo weight and the zones ordered by descending score, then
// ascending zone ID.
type InfrastructureCatalogue struct {
	Source           string               `json:"source"`
	PointsPerElement int                  `json:"points_per_element"`
	Zones            []InfrastructureZone `json:"zones"`
}

// SyntheticInfrastructure returns the embedded fictional infrastructure
// catalogue for the PM-11 demo. It reads no database, broker or external
// service: the entries are compiled in, every element contributes one point, and
// counts and scores are derived from those same entries.
func SyntheticInfrastructure() InfrastructureCatalogue {
	fixture := infrastructureFixture()
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
		zones = append(zones, InfrastructureZone{
			ZoneID:   declared.zoneID,
			Score:    InfrastructurePointsPerElement * len(declared.elements),
			Counts:   counts,
			Elements: declared.elements,
		})
	}
	sort.SliceStable(zones, func(i, j int) bool {
		if zones[i].Score != zones[j].Score {
			return zones[i].Score > zones[j].Score
		}
		return zones[i].ZoneID < zones[j].ZoneID
	})
	return InfrastructureCatalogue{
		Source:           InfrastructureSourceID,
		PointsPerElement: InfrastructurePointsPerElement,
		Zones:            zones,
	}
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
