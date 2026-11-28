package handler

import (
	"encoding/json"
	"net/http"
	"testing"

	"firewatch.local/risk/internal/source"
	"github.com/getkin/kin-openapi/openapi3"
)

// TestInfrastructureAuthorization pins the access contract: the demo catalogue is
// a viewer/admin read route, an authenticated role outside that pair is refused,
// and a request without a token never reaches the handler. All four cases also
// prove the answer does not depend on storage or the broker.
func TestInfrastructureAuthorization(t *testing.T) {
	for _, tc := range []struct {
		name  string
		role  string
		token string
		want  int
	}{
		{name: "viewer is admitted", role: "viewer", token: "valid", want: http.StatusOK},
		{name: "admin is admitted", role: "admin", token: "valid", want: http.StatusOK},
		{name: "another role has no access", role: "operator", token: "valid", want: http.StatusForbidden},
		{name: "no token has no access", role: "viewer", token: "", want: http.StatusUnauthorized},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &fakeStore{}
			base, token := authorizedServer(t, tc.role, store)
			requestToken := token
			if tc.token == "" {
				requestToken = ""
			}
			w := request(t, base, requestToken, "/v1/risk/infrastructure")
			if w.Code != tc.want {
				t.Fatalf("got %d want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if store.calls != 0 || store.zoneCalls != 0 || store.listZonesCall != 0 || store.aggregateCall != 0 {
				t.Errorf("the compiled-in catalogue touched storage: %+v", store)
			}
		})
	}
}

// TestInfrastructureBodyIsTheFrozenSyntheticCatalogue pins the frozen wire body:
// the declared source, the ratified weighting table, the descending-exposure/
// ascending-ID order, a complete five-key breakdown and RFC 7946 geometry per
// element type.
func TestInfrastructureBodyIsTheFrozenSyntheticCatalogue(t *testing.T) {
	base, token := authorizedServer(t, "viewer", &fakeStore{})
	w := request(t, base, token, "/v1/risk/infrastructure")
	if w.Code != http.StatusOK {
		t.Fatalf("got %d want %d: %s", w.Code, http.StatusOK, w.Body.String())
	}

	catalogue := decodeJSONObject(t, "catalogue", w.Body.Bytes())
	requireJSONKeys(t, "catalogue", catalogue, "source", "weighting", "zones")

	var declaredSource string
	if err := json.Unmarshal(catalogue["source"], &declaredSource); err != nil {
		t.Fatalf("decode source: %v", err)
	}
	if declaredSource != "synthetic_fixture" {
		t.Errorf("source is %q, want synthetic_fixture", declaredSource)
	}

	// The weighting block publishes the ratified table and nothing else: five rows,
	// the sums and the pair, plus the fold of this catalogue's own vocabulary.
	weighting := decodeJSONObject(t, "weighting", catalogue["weighting"])
	requireJSONKeys(
		t, "weighting", weighting,
		"exposure_formula", "priority_formula", "risk_formula",
		"risk_weight", "exposure_weight", "weight_sum",
		"categories", "type_categories", "unweighted_types",
	)
	var categories []json.RawMessage
	if err := json.Unmarshal(weighting["categories"], &categories); err != nil {
		t.Fatalf("decode categories: %v", err)
	}
	wantCategories := []struct {
		category string
		weight   float64
		radiusKM float64
	}{
		{category: "hospital", weight: 1.00, radiusKM: 5.0},
		{category: "escuela", weight: 0.90, radiusKM: 3.0},
		{category: "subestacion", weight: 0.85, radiusKM: 4.0},
		{category: "telecom", weight: 0.75, radiusKM: 4.0},
		{category: "vialidad", weight: 0.65, radiusKM: 2.5},
	}
	if len(categories) != len(wantCategories) {
		t.Fatalf("weighting serves %d categories, want %d", len(categories), len(wantCategories))
	}
	for index, rawCategory := range categories {
		category := decodeJSONObject(t, "category", rawCategory)
		requireJSONKeys(t, "category", category, "category", "aliases", "weight", "radius_km")
		var name string
		var weight, radiusKM float64
		if err := json.Unmarshal(category["category"], &name); err != nil {
			t.Fatalf("decode category name: %v", err)
		}
		if err := json.Unmarshal(category["weight"], &weight); err != nil {
			t.Fatalf("decode category weight: %v", err)
		}
		if err := json.Unmarshal(category["radius_km"], &radiusKM); err != nil {
			t.Fatalf("decode category radius: %v", err)
		}
		want := wantCategories[index]
		if name != want.category {
			t.Errorf("category %d is %q, want %q", index, name, want.category)
		}
		if weight != want.weight || radiusKM != want.radiusKM {
			t.Errorf(
				"category %q serves weight %v radius %v, want %v and %v",
				name, weight, radiusKM, want.weight, want.radiusKM,
			)
		}
	}

	var zones []json.RawMessage
	if err := json.Unmarshal(catalogue["zones"], &zones); err != nil {
		t.Fatalf("decode zones: %v", err)
	}
	wantZones := []struct {
		id       string
		exposure int
		assets   int
	}{
		{id: "05101", exposure: 61, assets: 5},
		{id: "05109", exposure: 37, assets: 3},
		{id: "05401", exposure: 24, assets: 2},
		{id: "05801", exposure: 16, assets: 2},
	}
	if len(zones) != len(wantZones) {
		t.Fatalf("served %d zones, want %d", len(zones), len(wantZones))
	}
	for index, rawZone := range zones {
		zone := decodeJSONObject(t, "zone", rawZone)
		requireJSONKeys(
			t, "zone", zone,
			"zone_id", "exposure_score", "weighted_points", "exposed_assets_count",
			"dominant_category", "counts", "categories", "elements",
		)

		var zoneID string
		var exposure, assets int
		if err := json.Unmarshal(zone["zone_id"], &zoneID); err != nil {
			t.Fatalf("decode zone_id: %v", err)
		}
		if err := json.Unmarshal(zone["exposure_score"], &exposure); err != nil {
			t.Fatalf("decode exposure_score: %v", err)
		}
		if err := json.Unmarshal(zone["exposed_assets_count"], &assets); err != nil {
			t.Fatalf("decode exposed_assets_count: %v", err)
		}
		if zoneID != wantZones[index].id || exposure != wantZones[index].exposure {
			t.Errorf(
				"zone %d is %s with exposure %d, want %s with exposure %d",
				index, zoneID, exposure, wantZones[index].id, wantZones[index].exposure,
			)
		}
		if assets != wantZones[index].assets {
			t.Errorf("zone %s declares %d assets, want %d", zoneID, assets, wantZones[index].assets)
		}

		categories := zone["categories"]
		var categoryRows []json.RawMessage
		if err := json.Unmarshal(categories, &categoryRows); err != nil {
			t.Fatalf("decode categories of zone %s: %v", zoneID, err)
		}
		if len(categoryRows) != len(wantCategories) {
			t.Errorf("zone %s carries %d category rows, want %d", zoneID, len(categoryRows), len(wantCategories))
		}
		for rowIndex, rawRow := range categoryRows {
			row := decodeJSONObject(t, "zone category", rawRow)
			requireJSONKeys(t, "zone category", row, "category", "weight", "radius_km", "count", "weighted_points")
			var rowCategory string
			var rowWeight float64
			if err := json.Unmarshal(row["category"], &rowCategory); err != nil {
				t.Fatalf("decode category row name: %v", err)
			}
			if err := json.Unmarshal(row["weight"], &rowWeight); err != nil {
				t.Fatalf("decode category row weight: %v", err)
			}
			wantRow := wantCategories[rowIndex]
			if rowCategory != wantRow.category || rowWeight != wantRow.weight {
				t.Errorf(
					"zone %s category row %d is %s weight %v, want %s weight %v",
					zoneID, rowIndex, rowCategory, rowWeight, wantRow.category, wantRow.weight,
				)
			}
		}

		counts := decodeJSONObject(t, "counts", zone["counts"])
		requireJSONKeys(t, "counts", counts, "colegio", "vivienda", "hospital", "ruta", "hidrante")
		decodedCounts := make(map[string]int, len(counts))
		countsTotal := 0
		for elementType, rawCount := range counts {
			var count int
			if err := json.Unmarshal(rawCount, &count); err != nil {
				t.Fatalf("decode %s count: %v", elementType, err)
			}
			decodedCounts[elementType] = count
			countsTotal += count
		}

		var elements []json.RawMessage
		if err := json.Unmarshal(zone["elements"], &elements); err != nil {
			t.Fatalf("decode elements of zone %s: %v", zoneID, err)
		}
		if countsTotal != len(elements) {
			t.Errorf("zone %s counts sum to %d but serves %d elements", zoneID, countsTotal, len(elements))
		}
		if assets != len(elements) {
			t.Errorf("zone %s declares %d assets but serves %d elements", zoneID, assets, len(elements))
		}

		seenCounts := make(map[string]int, len(elements))
		for _, rawElement := range elements {
			element := decodeJSONObject(t, "element", rawElement)
			requireJSONKeys(t, "element", element, "id", "type", "geometry")

			var elementID, elementType string
			if err := json.Unmarshal(element["id"], &elementID); err != nil {
				t.Fatalf("decode element id: %v", err)
			}
			if err := json.Unmarshal(element["type"], &elementType); err != nil {
				t.Fatalf("decode element type: %v", err)
			}
			if elementID == "" {
				t.Errorf("zone %s serves an element without an id", zoneID)
			}
			if !containsString(source.InfrastructureElementTypes(), elementType) {
				t.Errorf("element %s has type %q outside the frozen vocabulary", elementID, elementType)
			}
			seenCounts[elementType]++

			geometry := decodeJSONObject(t, "geometry", element["geometry"])
			requireJSONKeys(t, "geometry", geometry, "type", "coordinates")
			var geometryType string
			if err := json.Unmarshal(geometry["type"], &geometryType); err != nil {
				t.Fatalf("decode geometry type of %s: %v", elementID, err)
			}
			if elementType == "ruta" {
				if geometryType != "LineString" {
					t.Errorf("route %s geometry is %q, want LineString", elementID, geometryType)
				}
				var positions [][]float64
				if err := json.Unmarshal(geometry["coordinates"], &positions); err != nil {
					t.Fatalf("decode route %s coordinates: %v", elementID, err)
				}
				if len(positions) < 2 {
					t.Errorf("route %s serves %d positions, want at least 2", elementID, len(positions))
				}
				for _, position := range positions {
					if len(position) != 2 {
						t.Errorf("route %s serves position %v, want [longitude, latitude]", elementID, position)
					}
				}
				continue
			}
			if geometryType != "Point" {
				t.Errorf("%s %s geometry is %q, want Point", elementType, elementID, geometryType)
			}
			var position []float64
			if err := json.Unmarshal(geometry["coordinates"], &position); err != nil {
				t.Fatalf("decode point %s coordinates: %v", elementID, err)
			}
			if len(position) != 2 {
				t.Errorf("point %s serves %v, want one RFC 7946 position", elementID, position)
			}
		}
		for elementType, count := range decodedCounts {
			if seenCounts[elementType] != count {
				t.Errorf(
					"zone %s declares %d %s element(s) but serves %d",
					zoneID, count, elementType, seenCounts[elementType],
				)
			}
		}
	}
}

// TestInfrastructureEndpointIsDocumented keeps the published contract and the
// served route from drifting: the document must declare the endpoint and its
// read-gate answers, and the real body must validate against the documented 200
// schema.
func TestInfrastructureEndpointIsDocumented(t *testing.T) {
	contract := loadContract(t)
	item := contract.Paths.Find("/v1/risk/infrastructure")
	if item == nil {
		t.Fatal("the contract documents no /v1/risk/infrastructure path")
	}
	operation := item.GetOperation(http.MethodGet)
	if operation == nil {
		t.Fatal("the contract documents no GET operation for /v1/risk/infrastructure")
	}
	for _, status := range []int{http.StatusOK, http.StatusUnauthorized, http.StatusForbidden} {
		if operation.Responses.Status(status) == nil {
			t.Errorf("the contract documents no %d response", status)
		}
	}

	base, token := authorizedServer(t, "viewer", &fakeStore{})
	app := withCorrelationID(base)
	w := request(t, app, token, "/v1/risk/infrastructure")
	if w.Code != http.StatusOK {
		t.Fatalf("got %d want %d: %s", w.Code, http.StatusOK, w.Body.String())
	}
	assertResponseMatchesContract(t, contract, "/v1/risk/infrastructure", http.MethodGet, w)
}

// TestInfrastructureContractPinsTheProducerShape pins what the service actually
// serves, so the published document cannot certify a body the producer never
// emits: the provisional weight is exactly one point per element, a Point is one
// position of exactly two numbers, a LineString is two or more positions of exactly
// two numbers, and the element type selects the geometry type - ruta is a
// LineString while colegio, vivienda, hospital and hidrante are Points.
//
// This states the producer's shape, not a restatement of the client guard: the
// client tolerates an altitude after the two required position numbers, while the
// producer never sends one. The cases are one-object bodies validated against the
// component schemas the response references, and every valid alternate is checked
// next to its counterexample so a one-sided tightening cannot pass. The real served
// body keeps being validated end to end by TestInfrastructureEndpointIsDocumented.
func TestInfrastructureContractPinsTheProducerShape(t *testing.T) {
	contract := loadContract(t)
	catalogue := contract.Components.Schemas["InfrastructureCatalogue"]
	weighting := contract.Components.Schemas["InfrastructureWeighting"]
	zone := contract.Components.Schemas["InfrastructureZone"]
	geometry := contract.Components.Schemas["InfrastructureGeometry"]
	element := contract.Components.Schemas["InfrastructureElement"]
	if catalogue == nil || catalogue.Value == nil {
		t.Fatal("the contract documents no InfrastructureCatalogue schema")
	}
	if weighting == nil || weighting.Value == nil {
		t.Fatal("the contract documents no InfrastructureWeighting schema")
	}
	if zone == nil || zone.Value == nil {
		t.Fatal("the contract documents no InfrastructureZone schema")
	}
	if geometry == nil || geometry.Value == nil {
		t.Fatal("the contract documents no InfrastructureGeometry schema")
	}
	if element == nil || element.Value == nil {
		t.Fatal("the contract documents no InfrastructureElement schema")
	}
	weightSum := weighting.Value.Properties["weight_sum"]
	riskWeight := weighting.Value.Properties["risk_weight"]
	exposure := zone.Value.Properties["exposure_score"]
	dominant := zone.Value.Properties["dominant_category"]
	for name, property := range map[string]*openapi3.SchemaRef{
		"weight_sum": weightSum, "risk_weight": riskWeight, "exposure_score": exposure, "dominant_category": dominant,
	} {
		if property == nil || property.Value == nil {
			t.Fatalf("the contract documents no %s schema", name)
		}
	}

	// JSON numbers decode as float64, and that is what the client's parser sees, so
	// the fixtures stay in that shape instead of a Go-specific one.
	position := func(longitude, latitude float64) []any { return []any{longitude, latitude} }
	geometryBody := func(geometryType string, coordinates any) map[string]any {
		return map[string]any{"type": geometryType, "coordinates": coordinates}
	}
	elementBody := func(elementType, geometryType string, coordinates any) map[string]any {
		return map[string]any{
			"id":       "fixture-" + elementType + "-1",
			"type":     elementType,
			"geometry": geometryBody(geometryType, coordinates),
		}
	}

	for _, tc := range []struct {
		name     string
		schema   *openapi3.Schema
		body     any
		rejected bool
	}{
		{name: "the ratified weight sum", schema: weightSum.Value, body: float64(4.15)},
		{name: "a weight sum that is not the ratified one", schema: weightSum.Value, body: float64(4.2), rejected: true},
		{name: "the ratified risk weight", schema: riskWeight.Value, body: float64(0.7)},
		{name: "a risk weight that is not the ratified one", schema: riskWeight.Value, body: float64(0.6), rejected: true},
		{name: "an exposure index inside the documented range", schema: exposure.Value, body: 61},
		{name: "an exposure index above 100", schema: exposure.Value, body: 101, rejected: true},
		{name: "a negative exposure index", schema: exposure.Value, body: -1, rejected: true},
		{name: "a dominant category the table names", schema: dominant.Value, body: "hospital"},
		{name: "a dominant category the table does not name", schema: dominant.Value, body: "vivienda", rejected: true},
		{name: "no dominant category", schema: dominant.Value, body: nil},
		{name: "a Point position of two numbers", schema: geometry.Value, body: geometryBody("Point", position(-71.5, -33.1))},
		{name: "a Point position of three numbers", schema: geometry.Value, body: geometryBody("Point", []any{-71.5, -33.1, 12.5}), rejected: true},
		{name: "a Point position of one number", schema: geometry.Value, body: geometryBody("Point", []any{-71.5}), rejected: true},
		{name: "a Point whose coordinates are positions", schema: geometry.Value, body: geometryBody("Point", []any{position(-71.5, -33.1)}), rejected: true},
		{name: "a LineString of two positions", schema: geometry.Value, body: geometryBody("LineString", []any{position(-71.5, -33.1), position(-71.4, -33)})},
		{name: "a LineString of three positions", schema: geometry.Value, body: geometryBody("LineString", []any{position(-71.5, -33.1), position(-71.4, -33), position(-71.3, -33.2)})},
		{name: "a LineString of one position", schema: geometry.Value, body: geometryBody("LineString", []any{position(-71.5, -33.1)}), rejected: true},
		{name: "a LineString position of three numbers", schema: geometry.Value, body: geometryBody("LineString", []any{[]any{-71.5, -33.1, 9.0}, position(-71.4, -33)}), rejected: true},
		{name: "a LineString carrying one flat position", schema: geometry.Value, body: geometryBody("LineString", position(-71.5, -33.1)), rejected: true},
		{name: "a colegio carrying a Point", schema: element.Value, body: elementBody("colegio", "Point", position(-71.5, -33.1))},
		{name: "a vivienda carrying a Point", schema: element.Value, body: elementBody("vivienda", "Point", position(-71.5, -33.1))},
		{name: "a hospital carrying a Point", schema: element.Value, body: elementBody("hospital", "Point", position(-71.5, -33.1))},
		{name: "a hidrante carrying a Point", schema: element.Value, body: elementBody("hidrante", "Point", position(-71.5, -33.1))},
		{name: "a ruta carrying a LineString", schema: element.Value, body: elementBody("ruta", "LineString", []any{position(-71.5, -33.1), position(-71.4, -33)})},
		{name: "a ruta carrying a Point", schema: element.Value, body: elementBody("ruta", "Point", position(-71.5, -33.1)), rejected: true},
		{name: "a colegio carrying a LineString", schema: element.Value, body: elementBody("colegio", "LineString", []any{position(-71.5, -33.1), position(-71.4, -33)}), rejected: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.schema.VisitJSON(tc.body); (err != nil) != tc.rejected {
				t.Errorf("rejected=%t, want rejected=%t (validation error: %v)", err != nil, tc.rejected, err)
			}
		})
	}
}

func decodeJSONObject(t *testing.T, label string, raw []byte) map[string]json.RawMessage {
	t.Helper()
	decoded := map[string]json.RawMessage{}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("%s is not a JSON object: %v", label, err)
	}
	return decoded
}

func requireJSONKeys(t *testing.T, label string, object map[string]json.RawMessage, want ...string) {
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

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
