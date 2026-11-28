package handler

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"firewatch.local/risk/internal/repository"
	"firewatch.local/risk/internal/source"
)

// landCoverBatch is one published batch of a catalogue comuna, carrying the
// members every read serves. The factors are a valid published list so the
// regional context is computed exactly as it is in production.
func landCoverBatch(zone string) repository.Batch {
	return repository.Batch{
		ID:           "batch-" + zone,
		JobID:        "job-" + zone,
		ZoneID:       zone,
		Demo:         true,
		DataStatus:   "current",
		RiskLevel:    "alto",
		Factors:      json.RawMessage(`[{"name":"viento","known":true,"value":30,"contribution":0.40,"note":"sintética"}]`),
		Rationale:    "Regla académica",
		Notice:       "Sintético",
		ModelVersion: "academic-rule-v1",
		// The provenance columns are NOT NULL in storage (the trigger is recorded
		// with a default), so a contract-valid batch always declares one.
		EvaluationTrigger: "scheduler",
	}
}

// TestVegetationAuthorization pins the access contract of the new read: viewer and
// admin are admitted, another authenticated role is refused, an unauthenticated
// request never reaches the handler, and none of the four cases touches storage.
func TestVegetationAuthorization(t *testing.T) {
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
			w := request(t, base, requestToken, "/v1/risk/vegetation")
			if w.Code != tc.want {
				t.Fatalf("got %d want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if store.calls != 0 || store.zoneCalls != 0 || store.listZonesCall != 0 || store.aggregateCall != 0 {
				t.Errorf("the compiled-in catalogue touched storage: %+v", store)
			}
		})
	}
}

// TestVegetationBodyIsTheFrozenSyntheticCatalogue pins the served body: the
// declared source, the 38 catalogue comunas in ascending zone_id order and, per
// zona, the members the PM-12 decision fixes with its declared provenance.
func TestVegetationBodyIsTheFrozenSyntheticCatalogue(t *testing.T) {
	base, token := authorizedServer(t, "viewer", &fakeStore{})
	w := request(t, base, token, "/v1/risk/vegetation")
	if w.Code != http.StatusOK {
		t.Fatalf("got %d want %d: %s", w.Code, http.StatusOK, w.Body.String())
	}

	catalogue := decodeJSONObject(t, "catalogue", w.Body.Bytes())
	requireJSONKeys(t, "catalogue", catalogue, "source", "zones")

	var declared string
	if err := json.Unmarshal(catalogue["source"], &declared); err != nil {
		t.Fatalf("decode source: %v", err)
	}
	if declared != source.VegetationSourceLabel {
		t.Errorf("source is %q, want %q", declared, source.VegetationSourceLabel)
	}

	var zones []map[string]json.RawMessage
	if err := json.Unmarshal(catalogue["zones"], &zones); err != nil {
		t.Fatalf("decode zones: %v", err)
	}
	if len(zones) != 38 {
		t.Fatalf("the catalogue serves %d zones, want the 38 catalogue comunas", len(zones))
	}
	previous := ""
	for _, zone := range zones {
		requireJSONKeys(
			t, "zone", zone,
			"zone_id", "zone_name", "ndvi_mean", "ndvi_min", "ndvi_max", "ndvi_anomaly",
			"land_cover_breakdown", "environment_class", "synthetic", "source_label",
		)
		var name string
		if err := json.Unmarshal(zone["zone_name"], &name); err != nil || name == "" {
			t.Errorf("zone name is absent or unreadable: %v", err)
		}
		var zoneID string
		if err := json.Unmarshal(zone["zone_id"], &zoneID); err != nil {
			t.Fatalf("decode zone_id: %v", err)
		}
		if zoneID <= previous {
			t.Errorf("zone %q follows %q, want ascending zone_id", zoneID, previous)
		}
		previous = zoneID
		var synthetic bool
		if err := json.Unmarshal(zone["synthetic"], &synthetic); err != nil || !synthetic {
			t.Errorf("zone %q does not declare synthetic: true", zoneID)
		}
		var label string
		if err := json.Unmarshal(zone["source_label"], &label); err != nil || label != source.VegetationSourceLabel {
			t.Errorf("zone %q declares source_label %q, want %q", zoneID, label, source.VegetationSourceLabel)
		}
	}

	// The scale classes are the closed four the decision fixes, and every served
	// zone names one of them.
	declaredClasses := map[string]bool{}
	for _, class := range source.EnvironmentClasses() {
		declaredClasses[string(class)] = true
	}
	for _, zone := range zones {
		var class string
		if err := json.Unmarshal(zone["environment_class"], &class); err != nil {
			t.Fatalf("decode environment_class: %v", err)
		}
		if !declaredClasses[class] {
			t.Errorf("zone serves undeclared environment_class %q", class)
		}
	}
}

// TestVegetationRefusesEveryQueryParameter pins the route's closed vocabulary: it
// accepts no parameter at all, and a query string that url.Values would silently
// drop is refused instead of answered as "no filters".
func TestVegetationRefusesEveryQueryParameter(t *testing.T) {
	base, token := authorizedServer(t, "viewer", &fakeStore{})
	for _, tc := range []struct {
		name   string
		target string
		want   int
		code   string
	}{
		{name: "no query", target: "/v1/risk/vegetation", want: http.StatusOK},
		{name: "empty query", target: "/v1/risk/vegetation?", want: http.StatusOK},
		{name: "unknown parameter", target: "/v1/risk/vegetation?zone_id=05101", want: http.StatusUnprocessableEntity, code: "invalid_query"},
		{name: "unknown parameter alone", target: "/v1/risk/vegetation?bbox=1,2,3,4", want: http.StatusUnprocessableEntity, code: "invalid_query"},
		{name: "repeated parameter", target: "/v1/risk/vegetation?a=1&a=1", want: http.StatusUnprocessableEntity, code: "invalid_query"},
		{name: "unreadable encoding", target: "/v1/risk/vegetation?from=%zz", want: http.StatusUnprocessableEntity, code: "invalid_query"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := request(t, base, token, tc.target)
			if w.Code != tc.want {
				t.Fatalf("got %d want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if tc.code == "" {
				return
			}
			var body struct {
				Code string `json:"code"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatalf("decode error body: %v", err)
			}
			if body.Code != tc.code {
				t.Errorf("code is %q, want %q", body.Code, tc.code)
			}
		})
	}
}

// TestLatestBatchCarriesTheLandCoverOfItsZone pins the additive member on the
// detail read: the zone's own catalogue entry, the same one the catalogue route
// serves, and no other member of the batch disturbed.
func TestLatestBatchCarriesTheLandCoverOfItsZone(t *testing.T) {
	zone := "05101"
	store := &fakeStore{
		zones:         map[string]bool{zone: true},
		batches:       []repository.Batch{landCoverBatch(zone)},
		latestPerZone: []repository.Batch{landCoverBatch(zone)},
	}
	base, token := authorizedServer(t, "viewer", store)
	w := request(t, base, token, "/v1/risk/latest?zone_id="+zone)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d want %d: %s", w.Code, http.StatusOK, w.Body.String())
	}

	var body struct {
		ID        string                `json:"id"`
		ZoneID    string                `json:"zone_id"`
		LandCover *source.ZoneLandCover `json:"land_cover"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body.ID != "batch-"+zone || body.ZoneID != zone {
		t.Errorf("the batch body changed: id %q zone %q", body.ID, body.ZoneID)
	}
	if body.LandCover == nil {
		t.Fatalf("the detail read served no land cover: %s", w.Body.String())
	}
	want, ok := source.VegetationZone(zone)
	if !ok {
		t.Fatalf("the catalogue declares no land cover for %q", zone)
	}
	if *body.LandCover != want {
		t.Errorf("land cover is %+v, want the catalogue entry %+v", *body.LandCover, want)
	}
}

// TestBatchesCarryOneLandCoverPerZone pins the aggregate read: every element
// carries the entry of its own zone, and a zone the vegetation catalogue does not
// declare is served without the member instead of with an invented block.
func TestBatchesCarryOneLandCoverPerZone(t *testing.T) {
	store := &fakeStore{latestPerZone: []repository.Batch{
		landCoverBatch("05101"),
		landCoverBatch("05109"),
		landCoverBatch("valparaiso-demo"),
	}}
	base, token := authorizedServer(t, "viewer", store)
	w := request(t, base, token, "/v1/risk/batches")
	if w.Code != http.StatusOK {
		t.Fatalf("got %d want %d: %s", w.Code, http.StatusOK, w.Body.String())
	}

	var body struct {
		Batches []struct {
			ZoneID    string                `json:"zone_id"`
			LandCover *source.ZoneLandCover `json:"land_cover"`
		} `json:"batches"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if len(body.Batches) != 3 {
		t.Fatalf("served %d batches, want 3", len(body.Batches))
	}
	for _, entry := range body.Batches {
		want, declared := source.VegetationZone(entry.ZoneID)
		if !declared {
			if entry.LandCover != nil {
				t.Errorf("zone %q is outside the catalogue but carries a land cover", entry.ZoneID)
			}
			continue
		}
		if entry.LandCover == nil {
			t.Errorf("zone %q carries no land cover", entry.ZoneID)
			continue
		}
		if entry.LandCover.ZoneID != entry.ZoneID {
			t.Errorf("zone %q carries the land cover of %q", entry.ZoneID, entry.LandCover.ZoneID)
		}
		if *entry.LandCover != want {
			t.Errorf("zone %q land cover is %+v, want %+v", entry.ZoneID, *entry.LandCover, want)
		}
	}
}

// TestHistoryStaysUntouchedByTheLandCover pins the boundary the decision draws:
// the member belongs to the two reads that answer one regional snapshot, so the
// bounded history read keeps the body it already served.
func TestHistoryStaysUntouchedByTheLandCover(t *testing.T) {
	zone := "05101"
	store := &fakeStore{
		zones:   map[string]bool{zone: true},
		batches: []repository.Batch{landCoverBatch(zone)},
	}
	base, token := authorizedServer(t, "viewer", store)
	w := request(t, base, token, "/v1/risk/history?zone_id="+zone)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d want %d: %s", w.Code, http.StatusOK, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "land_cover") {
		t.Errorf("the history read inherits a member it never served: %s", w.Body.String())
	}
}
