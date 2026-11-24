package handler

import (
	"encoding/json"
	"net/http"
	"testing"

	"firewatch.local/risk/internal/source"
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
// the declared source, one point per element, the descending-score/ascending-ID
// order, a complete five-key breakdown and RFC 7946 geometry per element type.
func TestInfrastructureBodyIsTheFrozenSyntheticCatalogue(t *testing.T) {
	base, token := authorizedServer(t, "viewer", &fakeStore{})
	w := request(t, base, token, "/v1/risk/infrastructure")
	if w.Code != http.StatusOK {
		t.Fatalf("got %d want %d: %s", w.Code, http.StatusOK, w.Body.String())
	}

	catalogue := decodeJSONObject(t, "catalogue", w.Body.Bytes())
	requireJSONKeys(t, "catalogue", catalogue, "source", "points_per_element", "zones")

	var declaredSource string
	if err := json.Unmarshal(catalogue["source"], &declaredSource); err != nil {
		t.Fatalf("decode source: %v", err)
	}
	if declaredSource != "synthetic_fixture" {
		t.Errorf("source is %q, want synthetic_fixture", declaredSource)
	}
	var pointsPerElement int
	if err := json.Unmarshal(catalogue["points_per_element"], &pointsPerElement); err != nil {
		t.Fatalf("decode points_per_element: %v", err)
	}
	if pointsPerElement != 1 {
		t.Errorf("points_per_element is %d, want the provisional demo weight 1", pointsPerElement)
	}

	var zones []json.RawMessage
	if err := json.Unmarshal(catalogue["zones"], &zones); err != nil {
		t.Fatalf("decode zones: %v", err)
	}
	wantZones := []struct {
		id    string
		score int
	}{
		{id: "05101", score: 5},
		{id: "05109", score: 3},
		{id: "05401", score: 2},
		{id: "05801", score: 2},
	}
	if len(zones) != len(wantZones) {
		t.Fatalf("served %d zones, want %d", len(zones), len(wantZones))
	}
	for index, rawZone := range zones {
		zone := decodeJSONObject(t, "zone", rawZone)
		requireJSONKeys(t, "zone", zone, "zone_id", "score", "counts", "elements")

		var zoneID string
		if err := json.Unmarshal(zone["zone_id"], &zoneID); err != nil {
			t.Fatalf("decode zone_id: %v", err)
		}
		var score int
		if err := json.Unmarshal(zone["score"], &score); err != nil {
			t.Fatalf("decode score: %v", err)
		}
		if zoneID != wantZones[index].id || score != wantZones[index].score {
			t.Errorf(
				"zone %d is %s with score %d, want %s with score %d",
				index, zoneID, score, wantZones[index].id, wantZones[index].score,
			)
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
		if score != pointsPerElement*len(elements) {
			t.Errorf("zone %s score %d is not %d point(s) for %d elements", zoneID, score, pointsPerElement, len(elements))
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
