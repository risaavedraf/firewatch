package handler

import (
	"encoding/json"
	"net/http"
	"testing"

	"firewatch.local/risk/internal/repository"
)

// TestVegetationContractMatchesTheContract validates the REAL answers of the three
// surfaces PM-12/V1-P-01 opens against the published document: the new catalogue
// route, its documented 422 refusal, and the two batch reads that now carry the
// per-zone `land_cover` member.
func TestVegetationContractMatchesTheContract(t *testing.T) {
	contract := loadContract(t)
	zone := "05101"
	// The detail read serves the batch's catalogue geometry; the aggregate read
	// deliberately does not repeat it, so the two fixtures differ in exactly that
	// member while sharing the batch identity the priority join uses.
	detail := landCoverBatch(zone)
	detail.Geometry = json.RawMessage(`{"type":"Point","coordinates":[-71.6,-33.03]}`)
	store := &fakeStore{
		zones:         map[string]bool{zone: true},
		batches:       []repository.Batch{detail},
		latestPerZone: []repository.Batch{landCoverBatch(zone), landCoverBatch("05109")},
	}
	base, token := authorizedServer(t, "viewer", store)
	app := withCorrelationID(base)

	for _, tc := range []struct {
		path   string
		target string
	}{
		{path: "/v1/risk/vegetation", target: "/v1/risk/vegetation"},
		{path: "/v1/risk/latest", target: "/v1/risk/latest?zone_id=" + zone},
		{path: "/v1/risk/batches", target: "/v1/risk/batches"},
	} {
		t.Run(tc.path, func(t *testing.T) {
			w := request(t, app, token, tc.target)
			if w.Code != http.StatusOK {
				t.Fatalf("%s got %d: %s", tc.target, w.Code, w.Body.String())
			}
			assertResponseMatchesContract(t, contract, tc.path, http.MethodGet, w)
		})
	}

	// The documented refusal is a real body, not only a documented status: an
	// undeclared parameter must answer the contract's own invalid_query schema.
	w := request(t, app, token, "/v1/risk/vegetation?zone_id="+zone)
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("got %d want %d: %s", w.Code, http.StatusUnprocessableEntity, w.Body.String())
	}
	assertResponseMatchesContract(t, contract, "/v1/risk/vegetation", http.MethodGet, w)
}

// TestLandCoverIsScopedToTheReadsThatServeIt mirrors the priority boundary: the
// member belongs to the detail read and to the aggregate read, while the shared
// core and the bounded history read must not inherit it.
func TestLandCoverIsScopedToTheReadsThatServeIt(t *testing.T) {
	contract := loadContract(t)

	latest := responseSchema(t, contract, "/v1/risk/latest", http.MethodGet, http.StatusOK)
	if !schemaProperties(latest)["land_cover"] {
		t.Error("the detail read declares no land_cover member")
	}

	collection := responseSchema(t, contract, "/v1/risk/batches", http.MethodGet, http.StatusOK)
	batchesProperty := collection.Properties["batches"]
	if batchesProperty == nil || batchesProperty.Value == nil || batchesProperty.Value.Items == nil || batchesProperty.Value.Items.Value == nil {
		t.Fatal("the aggregate read declares no item schema")
	}
	if !schemaProperties(batchesProperty.Value.Items.Value)["land_cover"] {
		t.Error("the aggregate read declares no land_cover member")
	}

	history := responseSchema(t, contract, "/v1/risk/history", http.MethodGet, http.StatusOK)
	if history.Items == nil || history.Items.Value == nil {
		t.Fatal("the history read declares no item schema")
	}
	if schemaProperties(history.Items.Value)["land_cover"] {
		t.Error("the history read declares a land_cover member it never serves")
	}

	core := contract.Components.Schemas["BatchCore"]
	if core == nil || core.Value == nil {
		t.Fatal("the contract documents no BatchCore schema")
	}
	if schemaProperties(core.Value)["land_cover"] {
		t.Error("BatchCore carries the land_cover member, so every batch route inherits it")
	}
}

// TestVegetationSchemasDocumentTheRatifiedDecision pins the vocabulary the decision
// fixes: the four scale classes as a closed enum and the declared synthetic
// provenance as members a reader can see in the document itself.
func TestVegetationSchemasDocumentTheRatifiedDecision(t *testing.T) {
	contract := loadContract(t)

	class := contract.Components.Schemas["EnvironmentClass"]
	if class == nil || class.Value == nil {
		t.Fatal("the contract documents no EnvironmentClass schema")
	}
	want := []string{"WUI_ALTA", "FORESTAL_DENSO", "MIXTO_RURAL", "PERIURBANO"}
	if len(class.Value.Enum) != len(want) {
		t.Fatalf("EnvironmentClass declares %d values, want %d", len(class.Value.Enum), len(want))
	}
	for index, value := range want {
		if class.Value.Enum[index] != value {
			t.Errorf("EnvironmentClass value %d is %v, want %q", index, class.Value.Enum[index], value)
		}
	}

	zone := contract.Components.Schemas["ZoneLandCover"]
	if zone == nil || zone.Value == nil {
		t.Fatal("the contract documents no ZoneLandCover schema")
	}
	properties := schemaProperties(zone.Value)
	for _, member := range []string{
		"zone_id", "zone_name", "ndvi_mean", "ndvi_min", "ndvi_max", "ndvi_anomaly",
		"land_cover_breakdown", "environment_class", "synthetic", "source_label",
	} {
		if !properties[member] {
			t.Errorf("ZoneLandCover declares no %q member", member)
		}
	}
	if !isRequired(zone.Value.Required, "synthetic") || !isRequired(zone.Value.Required, "source_label") {
		t.Error("ZoneLandCover does not require the declared provenance members")
	}

	breakdown := contract.Components.Schemas["LandCoverBreakdown"]
	if breakdown == nil || breakdown.Value == nil {
		t.Fatal("the contract documents no LandCoverBreakdown schema")
	}
	breakdownMembers := schemaProperties(breakdown.Value)
	for _, member := range []string{
		"bosque_nativo_pct", "plantacion_forestal_pct", "matorral_pastizal_pct",
		"interfaz_urbano_forestal_pct", "suelo_desnudo_agua_pct",
	} {
		if !breakdownMembers[member] {
			t.Errorf("LandCoverBreakdown declares no %q member", member)
		}
	}
	if len(breakdown.Value.Required) != 5 {
		t.Errorf("LandCoverBreakdown requires %d members, want the five percentages", len(breakdown.Value.Required))
	}

	catalogue := contract.Components.Schemas["VegetationCatalogue"]
	if catalogue == nil || catalogue.Value == nil {
		t.Fatal("the contract documents no VegetationCatalogue schema")
	}
	if !schemaProperties(catalogue.Value)["zones"] {
		t.Error("VegetationCatalogue declares no zones member")
	}
}

// isRequired reports whether name appears in a schema's required list.
func isRequired(required []string, name string) bool {
	for _, entry := range required {
		if entry == name {
			return true
		}
	}
	return false
}
