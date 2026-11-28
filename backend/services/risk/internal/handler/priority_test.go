package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"firewatch.local/risk/internal/classify"
	"firewatch.local/risk/internal/repository"
	"github.com/getkin/kin-openapi/openapi3"
	"github.com/google/uuid"
)

// priorityBatch is one published batch spelled the way the contract requires, so a
// response that carries it can be validated end to end instead of only decoded.
func priorityBatch(t *testing.T, zoneID, level, factors string) repository.Batch {
	t.Helper()
	published := time.Date(2026, 11, 26, 12, 0, 0, 0, time.UTC)
	policy := classify.PolicyRef{
		PolicyID:   "academic-rule-v1",
		Parameters: map[string]string{"alto": "0.67"},
		ParamsHash: "59259c4c0c470e5a0d512fe09f6c748c38fd29f9bc5d760d49754555c66e699b",
	}
	return repository.Batch{
		ID:                uuid.NewString(),
		JobID:             uuid.NewString(),
		ZoneID:            zoneID,
		RequestedAt:       published,
		PublishedAt:       published.Add(time.Minute),
		ValidUntil:        published.Add(15 * time.Minute),
		ModelVersion:      "academic-rule-v1",
		Demo:              true,
		Geometry:          json.RawMessage(`{"type":"Point","coordinates":[-71.6127,-33.0472]}`),
		DataStatus:        "current",
		RiskLevel:         level,
		Factors:           json.RawMessage(factors),
		Rationale:         "Puntaje ponderado de la regla.",
		Notice:            "Entrada sintética.",
		Policy:            &policy,
		EvaluationTrigger: "scheduler",
		EvaluatedBy:       nil,
	}
}

const rankedFactors = `[{"name":"temperatura","known":true,"value":32,"contribution":0.6},` +
	`{"name":"viento","known":true,"value":40,"contribution":0.36},` +
	`{"name":"humedad_relativa","known":false,"contribution":0}]`

// The single-zone read serves the same regional context the aggregate read
// computes: the ficha can state a position only because the ranking was built over
// the published batch, so the detail route asks for that batch and joins it.
func TestLatestBatchServesTheRegionalPriority(t *testing.T) {
	selected := priorityBatch(t, "05101", "alto", rankedFactors)
	store := &fakeStore{
		zones:   map[string]bool{"05101": true},
		batches: []repository.Batch{selected},
		latestPerZone: []repository.Batch{
			selected,
			priorityBatch(t, "05109", "medio", rankedFactors),
			priorityBatch(t, "05201", "desconocido", `[]`),
		},
	}
	base, token := authorizedServer(t, "viewer", store)
	w := request(t, base, token, "/v1/risk/latest?zone_id=05101")
	if w.Code != http.StatusOK {
		t.Fatalf("got %d want %d: %s", w.Code, http.StatusOK, w.Body.String())
	}

	var body struct {
		ID       string `json:"id"`
		Priority *struct {
			ZoneID           string  `json:"zone_id"`
			PriorityStatus   string  `json:"priority_status"`
			RiskScore        *int    `json:"risk_score"`
			ExposureScore    int     `json:"exposure_score"`
			PriorityScore    *int    `json:"priority_score"`
			PriorityRank     *int    `json:"priority_rank"`
			TotalRankedZones int     `json:"total_ranked_zones"`
			Assets           int     `json:"exposed_assets_count"`
			Dominant         *string `json:"dominant_category"`
			Summary          string  `json:"context_summary"`
		} `json:"priority"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body.ID != selected.ID {
		t.Errorf("the batch body changed: id %q want %q", body.ID, selected.ID)
	}
	if body.Priority == nil {
		t.Fatalf("the detail read served no regional priority: %s", w.Body.String())
	}
	if body.Priority.ZoneID != "05101" {
		t.Errorf("priority zone is %q, want 05101", body.Priority.ZoneID)
	}
	if body.Priority.PriorityStatus != "ranked" {
		t.Errorf("status is %q, want ranked", body.Priority.PriorityStatus)
	}
	if body.Priority.RiskScore == nil || *body.Priority.RiskScore != 96 {
		t.Errorf("risk score is %v, want the 96 the contributions sum to", body.Priority.RiskScore)
	}
	if body.Priority.ExposureScore != 61 {
		t.Errorf("exposure is %d, want the catalogue's 61", body.Priority.ExposureScore)
	}
	if body.Priority.PriorityScore == nil || *body.Priority.PriorityScore != 86 {
		t.Errorf("priority is %v, want 86", body.Priority.PriorityScore)
	}
	if body.Priority.PriorityRank == nil || *body.Priority.PriorityRank != 1 {
		t.Errorf("rank is %v, want 1", body.Priority.PriorityRank)
	}
	if body.Priority.TotalRankedZones != 2 {
		t.Errorf("%d ranked zones, want the 2 scoreable ones", body.Priority.TotalRankedZones)
	}
	if body.Priority.Assets != 5 {
		t.Errorf("%d declared assets, want the fixture's 5", body.Priority.Assets)
	}
	if body.Priority.Dominant == nil || *body.Priority.Dominant != "hospital" {
		t.Errorf("dominant category is %v, want hospital", body.Priority.Dominant)
	}
	if !strings.Contains(body.Priority.Summary, "puesto 1 de 2") {
		t.Errorf("context summary lost the regional position: %q", body.Priority.Summary)
	}
	if store.aggregateCall != 1 {
		t.Errorf("the ranking read the batch %d times, want exactly once", store.aggregateCall)
	}
}

// A failed aggregate read is not a failed batch read: the detail route answers what
// storage did return and omits the member, so the page says "no regional context"
// instead of claiming a position it could not compute.
func TestLatestBatchOmitsThePriorityWhenTheRankingIsUnavailable(t *testing.T) {
	selected := priorityBatch(t, "05101", "alto", rankedFactors)
	store := &fakeStore{
		zones:        map[string]bool{"05101": true},
		batches:      []repository.Batch{selected},
		aggregateErr: errors.New("storage unavailable"),
	}
	base, token := authorizedServer(t, "viewer", store)
	w := request(t, base, token, "/v1/risk/latest?zone_id=05101")
	if w.Code != http.StatusOK {
		t.Fatalf("got %d want %d: %s", w.Code, http.StatusOK, w.Body.String())
	}
	if strings.Contains(w.Body.String(), `"priority"`) {
		t.Fatalf("a failed ranking still published a priority: %s", w.Body.String())
	}
	if !strings.Contains(w.Body.String(), selected.ID) {
		t.Errorf("the batch itself was dropped: %s", w.Body.String())
	}
}

// The aggregate read serves the whole ranking: a zone the rule could score holds a
// position, a zone it could not holds none and says why. The order stays ascending
// zone id, and a zone absent from the published batch is simply absent.
func TestBatchesEndpointServesTheRegionalRanking(t *testing.T) {
	store := &fakeStore{latestPerZone: []repository.Batch{
		priorityBatch(t, "05109", "medio", rankedFactors),
		priorityBatch(t, "05101", "alto", rankedFactors),
		priorityBatch(t, "05201", "desconocido", `[]`),
	}}
	base, token := authorizedServer(t, "viewer", store)
	w := request(t, base, token, "/v1/risk/batches")
	if w.Code != http.StatusOK {
		t.Fatalf("got %d want %d: %s", w.Code, http.StatusOK, w.Body.String())
	}

	var body struct {
		Batches []struct {
			ZoneID   string `json:"zone_id"`
			Priority *struct {
				PriorityStatus   string `json:"priority_status"`
				PriorityRank     *int   `json:"priority_rank"`
				TotalRankedZones int    `json:"total_ranked_zones"`
				Summary          string `json:"context_summary"`
			} `json:"priority"`
		} `json:"batches"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if len(body.Batches) != 3 {
		t.Fatalf("%d batches served, want the 3 published zones", len(body.Batches))
	}
	got := make([]string, 0, len(body.Batches))
	for _, batch := range body.Batches {
		got = append(got, batch.ZoneID)
	}
	if strings.Join(got, ",") != "05101,05109,05201" {
		t.Fatalf("zone order is %v, want ascending zone id", got)
	}
	for _, batch := range body.Batches {
		if batch.Priority == nil {
			t.Fatalf("zone %s carries no regional context", batch.ZoneID)
		}
		if batch.Priority.TotalRankedZones != 2 {
			t.Errorf("zone %s reports %d ranked zones, want 2", batch.ZoneID, batch.Priority.TotalRankedZones)
		}
		switch batch.ZoneID {
		case "05101":
			if batch.Priority.PriorityStatus != "ranked" || batch.Priority.PriorityRank == nil || *batch.Priority.PriorityRank != 1 {
				t.Errorf("05101 is %q rank %v, want ranked rank 1", batch.Priority.PriorityStatus, batch.Priority.PriorityRank)
			}
		case "05109":
			// Same risk inputs as 05101 but a lower exposure, so the tie-break is
			// not what decides this position.
			if batch.Priority.PriorityStatus != "ranked" || batch.Priority.PriorityRank == nil || *batch.Priority.PriorityRank != 2 {
				t.Errorf("05109 is %q rank %v, want ranked rank 2", batch.Priority.PriorityStatus, batch.Priority.PriorityRank)
			}
		default:
			if batch.Priority.PriorityStatus != "insufficient" {
				t.Errorf("05201 is %q, want insufficient", batch.Priority.PriorityStatus)
			}
			if batch.Priority.PriorityRank != nil {
				t.Errorf("05201 claims rank %d without a score", *batch.Priority.PriorityRank)
			}
			if !strings.Contains(batch.Priority.Summary, "sin puesto regional") {
				t.Errorf("05201 does not explain its absence: %q", batch.Priority.Summary)
			}
		}
	}
	if store.aggregateCall != 1 {
		t.Errorf("the aggregate read used %d storage reads, want exactly 1", store.aggregateCall)
	}
	if store.calls != 0 {
		t.Errorf("the aggregate read fanned out to %d per-zone reads", store.calls)
	}
}

// The published document and the served bodies must agree. This validates the real
// responses of the two batch reads and of the infrastructure catalogue against the
// YAML, so a member added on one side only fails here instead of at review.
func TestPriorityContextMatchesTheContract(t *testing.T) {
	contract := loadContract(t)
	if contract.Components.Schemas["ZonePriority"] == nil {
		t.Fatal("the contract documents no ZonePriority schema")
	}
	if weighting := contract.Components.Schemas["InfrastructureWeighting"]; weighting == nil {
		t.Fatal("the contract documents no InfrastructureWeighting schema")
	}

	selected := priorityBatch(t, "05101", "alto", rankedFactors)
	unranked := priorityBatch(t, "05201", "desconocido", `[]`)
	store := &fakeStore{
		zones:         map[string]bool{"05101": true},
		batches:       []repository.Batch{selected},
		latestPerZone: []repository.Batch{selected, unranked},
	}
	base, token := authorizedServer(t, "viewer", store)
	app := withCorrelationID(base)

	single := request(t, app, token, "/v1/risk/latest?zone_id=05101")
	if single.Code != http.StatusOK {
		t.Fatalf("latest got %d: %s", single.Code, single.Body.String())
	}
	assertResponseMatchesContract(t, contract, "/v1/risk/latest", http.MethodGet, single)
	if !strings.Contains(single.Body.String(), `"priority_status":"ranked"`) {
		t.Errorf("the ranked context is not in the response: %s", single.Body.String())
	}

	aggregate := request(t, app, token, "/v1/risk/batches")
	if aggregate.Code != http.StatusOK {
		t.Fatalf("batches got %d: %s", aggregate.Code, aggregate.Body.String())
	}
	assertResponseMatchesContract(t, contract, "/v1/risk/batches", http.MethodGet, aggregate)
	if !strings.Contains(aggregate.Body.String(), `"priority_status":"insufficient"`) {
		t.Errorf("the unranked context is not in the response: %s", aggregate.Body.String())
	}

	infrastructure := request(t, app, token, "/v1/risk/infrastructure")
	if infrastructure.Code != http.StatusOK {
		t.Fatalf("infrastructure got %d: %s", infrastructure.Code, infrastructure.Body.String())
	}
	assertResponseMatchesContract(t, contract, "/v1/risk/infrastructure", http.MethodGet, infrastructure)
}

// The ranking is a read like every other one: the bearer gate answers before
// storage is touched, and an admitted read writes nothing.
func TestRegionalPriorityKeepsTheReadVerificationPath(t *testing.T) {
	for _, tc := range []struct {
		name  string
		role  string
		want  int
		store *fakeStore
	}{
		{"anonymous is refused", "", http.StatusUnauthorized, &fakeStore{}},
		{"a role outside the read gate is forbidden", "operator", http.StatusForbidden, &fakeStore{}},
		{
			"viewer reads",
			"viewer",
			http.StatusOK,
			&fakeStore{latestPerZone: []repository.Batch{priorityBatch(t, "05101", "alto", rankedFactors)}},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			base, token := authorizedServer(t, tc.role, tc.store)
			requestToken := token
			if tc.role == "" {
				requestToken = ""
			}
			w := request(t, base, requestToken, "/v1/risk/batches")
			if w.Code != tc.want {
				t.Fatalf("got %d want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if tc.want != http.StatusOK && tc.store.aggregateCall != 0 {
				t.Fatal("a refused request reached storage")
			}
		})
	}
}

// S3(b) — the priority is joined by (batch_id, zone_id), so a newer batch
// published between the two reads of `/latest` cannot lend its position to the
// batch this route answers.
func TestLatestBatchDoesNotBorrowAPositionFromAnotherBatch(t *testing.T) {
	answered := priorityBatch(t, "05101", "alto", rankedFactors)
	newer := priorityBatch(t, "05101", "alto", rankedFactors)
	if answered.ID == newer.ID {
		t.Fatal("the fixture must use two different batch ids")
	}
	store := &fakeStore{
		zones:         map[string]bool{"05101": true},
		batches:       []repository.Batch{answered},
		latestPerZone: []repository.Batch{newer},
	}
	base, token := authorizedServer(t, "viewer", store)
	w := request(t, base, token, "/v1/risk/latest?zone_id=05101")
	if w.Code != http.StatusOK {
		t.Fatalf("got %d want %d: %s", w.Code, http.StatusOK, w.Body.String())
	}
	if strings.Contains(w.Body.String(), `"priority"`) {
		t.Fatalf("an older batch borrowed the newer batch's position: %s", w.Body.String())
	}
	if !strings.Contains(w.Body.String(), answered.ID) {
		t.Errorf("the answered batch changed: %s", w.Body.String())
	}
}

// schemaProperties collects the property names a schema declares, following the
// `allOf`/`$ref` composition the document uses. It is how these tests assert what
// a route's body does and does not declare, without re-implementing the resolver.
func schemaProperties(schema *openapi3.Schema) map[string]bool {
	properties := map[string]bool{}
	var walk func(*openapi3.Schema)
	walk = func(current *openapi3.Schema) {
		if current == nil {
			return
		}
		for name := range current.Properties {
			properties[name] = true
		}
		for _, ref := range current.AllOf {
			if ref != nil {
				walk(ref.Value)
			}
		}
	}
	walk(schema)
	return properties
}

// responseSchema resolves the application/json schema of one documented response.
func responseSchema(t *testing.T, contract *openapi3.T, target, method string, status int) *openapi3.Schema {
	t.Helper()
	item := contract.Paths.Find(target)
	if item == nil {
		t.Fatalf("contract documents no path %q", target)
	}
	operation := item.GetOperation(method)
	if operation == nil {
		t.Fatalf("contract documents no %s operation for %q", method, target)
	}
	documented := operation.Responses.Status(status)
	if documented == nil || documented.Value == nil {
		t.Fatalf("contract documents no %d response for %s %s", status, method, target)
	}
	media := documented.Value.Content.Get("application/json")
	if media == nil || media.Schema == nil || media.Schema.Value == nil {
		t.Fatalf("contract documents no application/json body for %s %s %d", method, target, status)
	}
	return media.Schema.Value
}

// S4(b) — the regional priority is scoped to the reads that can compute it. It
// belongs to the per-zone detail read and to the aggregate read, which both see the
// whole published batch; the bounded history read must not inherit a member it
// never serves, and the shared core must not carry it either.
func TestPriorityIsScopedToTheReadsThatCanServeIt(t *testing.T) {
	contract := loadContract(t)

	latest := responseSchema(t, contract, "/v1/risk/latest", http.MethodGet, http.StatusOK)
	if !schemaProperties(latest)["priority"] {
		t.Error("the detail read declares no priority member")
	}

	history := responseSchema(t, contract, "/v1/risk/history", http.MethodGet, http.StatusOK)
	if history.Items == nil || history.Items.Value == nil {
		t.Fatal("the history read declares no item schema")
	}
	if schemaProperties(history.Items.Value)["priority"] {
		t.Error("the history read declares a priority member it never serves")
	}

	collection := responseSchema(t, contract, "/v1/risk/batches", http.MethodGet, http.StatusOK)
	batchesProperty := collection.Properties["batches"]
	if batchesProperty == nil || batchesProperty.Value == nil || batchesProperty.Value.Items == nil || batchesProperty.Value.Items.Value == nil {
		t.Fatal("the aggregate read declares no item schema")
	}
	if !schemaProperties(batchesProperty.Value.Items.Value)["priority"] {
		t.Error("the aggregate read declares no priority member")
	}

	core := contract.Components.Schemas["BatchCore"]
	if core == nil || core.Value == nil {
		t.Fatal("the contract documents no BatchCore schema")
	}
	if schemaProperties(core.Value)["priority"] {
		t.Error("BatchCore carries the priority member, so every batch route inherits it")
	}
}

// S4(a) — the ratified weight-and-radius table is not only enforced, it is written
// in the contract: the five categories, their exact weights and their radii. A
// document that dropped or rounded one of them would stop describing the rule.
func TestInfrastructureCategoryDocumentsTheRatifiedTable(t *testing.T) {
	contract := loadContract(t)
	category := contract.Components.Schemas["InfrastructureCategory"]
	if category == nil || category.Value == nil {
		t.Fatal("the contract documents no InfrastructureCategory schema")
	}
	description := category.Value.Description
	for _, expected := range []string{
		"hospital", "salud", "escuela", "educacion", "subestacion", "agua_potable",
		"telecom", "cuartel_bomberos", "vialidad", "puente",
		"1.00", "0.90", "0.85", "0.75", "0.65",
		"5.0", "3.0", "4.0", "2.5",
	} {
		if !strings.Contains(description, expected) {
			t.Errorf("the ratified table description omits %q", expected)
		}
	}
}

// S4/S5 — valid insufficient evidence is not corrupt data. A batch whose five
// factors are `unknown` and omit value and contribution, with level desconocido,
// is published as `insufficient` with all three position members null, and the
// body validates against the published contract on both reads that serve it.
func TestInsufficientPriorityFromUnknownFactorsMatchesTheContract(t *testing.T) {
	contract := loadContract(t)
	unknownOnly := json.RawMessage(
		`[{"name":"temperatura","known":false},` +
			`{"name":"humedad_relativa","known":false},` +
			`{"name":"viento","known":false},` +
			`{"name":"cobertura_vegetal","known":false},` +
			`{"name":"incendios_historicos","known":false}]`,
	)
	published := priorityBatch(t, "05101", "desconocido", string(unknownOnly))
	store := &fakeStore{
		zones:         map[string]bool{"05101": true},
		batches:       []repository.Batch{published},
		latestPerZone: []repository.Batch{published},
	}
	base, token := authorizedServer(t, "viewer", store)
	app := withCorrelationID(base)

	latest := request(t, app, token, "/v1/risk/latest?zone_id=05101")
	if latest.Code != http.StatusOK {
		t.Fatalf("latest got %d: %s", latest.Code, latest.Body.String())
	}
	assertResponseMatchesContract(t, contract, "/v1/risk/latest", http.MethodGet, latest)

	var body struct {
		Priority *struct {
			PriorityStatus   string `json:"priority_status"`
			RiskScore        *int   `json:"risk_score"`
			PriorityScore    *int   `json:"priority_score"`
			PriorityRank     *int   `json:"priority_rank"`
			TotalRankedZones int    `json:"total_ranked_zones"`
			ExposureScore    int    `json:"exposure_score"`
		} `json:"priority"`
	}
	if err := json.Unmarshal(latest.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body.Priority == nil {
		t.Fatalf("valid insufficient evidence was omitted instead of published: %s", latest.Body.String())
	}
	if body.Priority.PriorityStatus != "insufficient" {
		t.Errorf("status is %q, want insufficient", body.Priority.PriorityStatus)
	}
	if body.Priority.RiskScore != nil || body.Priority.PriorityScore != nil || body.Priority.PriorityRank != nil {
		t.Errorf("insufficient evidence carries a position: %+v", body.Priority)
	}
	if body.Priority.TotalRankedZones != 0 {
		t.Errorf("%d ranked zones, want 0 when nothing can be scored", body.Priority.TotalRankedZones)
	}
	if body.Priority.ExposureScore != 61 {
		t.Errorf("exposure is %d, want the catalogue's 61", body.Priority.ExposureScore)
	}

	aggregate := request(t, app, token, "/v1/risk/batches")
	if aggregate.Code != http.StatusOK {
		t.Fatalf("batches got %d: %s", aggregate.Code, aggregate.Body.String())
	}
	assertResponseMatchesContract(t, contract, "/v1/risk/batches", http.MethodGet, aggregate)
	if !strings.Contains(aggregate.Body.String(), `"priority_status":"insufficient"`) {
		t.Errorf("the aggregate read lost the insufficient context: %s", aggregate.Body.String())
	}
}

// A factor list that is not a strict wire shape is sanitized to the documented
// empty array: no route republishes bytes the contract rejects, and the omission of
// the priority stays independent of the shape of the body.
//   - a `known` factor without a numeric value and contribution,
//   - an explicit `"contribution": null`,
//   - a non-string note,
//   - a null element, or bytes that are not a factor array at all.
func TestCorruptFactorsOmitThePriorityMember(t *testing.T) {
	contract := loadContract(t)
	for _, tc := range []struct {
		name    string
		factors string
	}{
		{name: "bytes that are not a factor array", factors: `{"not":"an array"}`},
		{name: "a null element", factors: `[null]`},
		{name: "a known factor with no contribution", factors: `[{"name":"viento","known":true}]`},
		{name: "a known factor with an explicit null contribution", factors: `[{"name":"viento","known":true,"value":40,"contribution":null}]`},
		{name: "a known factor with no value", factors: `[{"name":"viento","known":true,"contribution":0.4}]`},
		{name: "a negative contribution", factors: `[{"name":"viento","known":true,"value":40,"contribution":-0.1}]`},
		{name: "a non-string note", factors: `[{"name":"viento","known":true,"value":40,"contribution":0.4,"note":5}]`},
		{name: "an explicit null note", factors: `[{"name":"viento","known":false,"note":null}]`},
		{name: "an unknown factor carrying a non-zero contribution", factors: `[{"name":"viento","known":false,"contribution":0.4}]`},
		{name: "a blank name", factors: `[{"name":"   ","known":false}]`},
		{name: "a missing known member", factors: `[{"name":"viento"}]`},
		{name: "a scalar element", factors: `[5]`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			corrupt := priorityBatch(t, "05101", "alto", tc.factors)
			store := &fakeStore{
				zones:         map[string]bool{"05101": true},
				batches:       []repository.Batch{corrupt},
				latestPerZone: []repository.Batch{corrupt},
			}
			base, token := authorizedServer(t, "viewer", store)
			app := withCorrelationID(base)

			for _, target := range []string{"/v1/risk/latest", "/v1/risk/batches"} {
				path := target
				if target == "/v1/risk/latest" {
					path = "/v1/risk/latest?zone_id=05101"
				}
				w := request(t, app, token, path)
				if w.Code != http.StatusOK {
					t.Fatalf("%s got %d: %s", target, w.Code, w.Body.String())
				}
				if strings.Contains(w.Body.String(), `"priority"`) {
					t.Errorf("%s published a priority for a corrupt record: %s", target, w.Body.String())
				}
				if !strings.Contains(w.Body.String(), `"factors":[]`) {
					t.Errorf("%s did not sanitize the corrupt factors: %s", target, w.Body.String())
				}
				assertResponseMatchesContract(t, contract, target, http.MethodGet, w)
			}
		})
	}
}

// TestWireFactorsSanitizesEverythingButAValidList pins the validation itself, one
// element at a time. The preserved column is the other half of the contract: a list
// the document accepts must reach the caller byte for byte, so the sanitizer cannot
// pass by emptying everything.
func TestWireFactorsSanitizesEverythingButAValidList(t *testing.T) {
	const valid = `[{"name":"viento","known":true,"value":40,"contribution":0.4,"note":"ráfaga"}]`
	for _, tc := range []struct {
		name string
		raw  string
		want string
	}{
		{name: "a valid known factor", raw: valid, want: valid},
		{name: "an empty list", raw: `[]`, want: `[]`},
		{name: "an unknown factor that omits its numbers", raw: `[{"name":"viento","known":false}]`, want: `[{"name":"viento","known":false}]`},
		{name: "an unknown factor with an explicit zero contribution", raw: `[{"name":"viento","known":false,"value":0,"contribution":0}]`, want: `[{"name":"viento","known":false,"value":0,"contribution":0}]`},
		{name: "an absent list becomes an empty one", raw: ``, want: `[]`},
		{name: "a null list becomes an empty one", raw: `null`, want: `[]`},
		{name: "a non-object root becomes an empty list", raw: `{"not":"an array"}`, want: `[]`},
		{name: "a null element becomes an empty list", raw: `[null]`, want: `[]`},
		{name: "a scalar element becomes an empty list", raw: `[5]`, want: `[]`},
		{name: "a known factor without contribution", raw: `[{"name":"viento","known":true,"value":40}]`, want: `[]`},
		{name: "a known factor without value", raw: `[{"name":"viento","known":true,"contribution":0.4}]`, want: `[]`},
		{name: "a null contribution", raw: `[{"name":"viento","known":true,"value":40,"contribution":null}]`, want: `[]`},
		{name: "a null value", raw: `[{"name":"viento","known":true,"value":null,"contribution":0.4}]`, want: `[]`},
		{name: "a negative contribution", raw: `[{"name":"viento","known":true,"value":40,"contribution":-0.1}]`, want: `[]`},
		{name: "a string contribution", raw: `[{"name":"viento","known":true,"value":40,"contribution":"0.4"}]`, want: `[]`},
		{name: "a non-string note", raw: `[{"name":"viento","known":true,"value":40,"contribution":0.4,"note":5}]`, want: `[]`},
		{name: "a null note", raw: `[{"name":"viento","known":false,"note":null}]`, want: `[]`},
		{name: "an unknown factor carrying a non-zero contribution", raw: `[{"name":"viento","known":false,"contribution":0.4}]`, want: `[]`},
		{name: "a blank name", raw: `[{"name":"  ","known":false}]`, want: `[]`},
		{name: "a missing name", raw: `[{"known":false}]`, want: `[]`},
		{name: "a missing known member", raw: `[{"name":"viento"}]`, want: `[]`},
		{name: "a non-boolean known", raw: `[{"name":"viento","known":"yes"}]`, want: `[]`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := string(wireFactors(json.RawMessage(tc.raw))); got != tc.want {
				t.Fatalf("wireFactors(%s) = %s, want %s", tc.raw, got, tc.want)
			}
		})
	}
}

// S3 — the engine and the wire share one strict factor check, so a malformed row can
// never influence the ranking. A higher-scoring row with a missing `value` (or a
// numeric `note`) is stripped from the wire AND leaves the valid peer at `#1 of 1`
// instead of pushing it to `#2 of 2`.
func TestMalformedRowsDoNotShiftTheValidRanks(t *testing.T) {
	contract := loadContract(t)
	for _, tc := range []struct {
		name   string
		broken string
	}{
		{name: "a known factor without value", broken: `[{"name":"viento","known":true,"contribution":0.95}]`},
		{name: "a numeric note", broken: `[{"name":"viento","known":true,"value":40,"contribution":0.95,"note":5}]`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			malformed := priorityBatch(t, "05101", "alto", tc.broken)
			valid := priorityBatch(t, "05109", "alto", `[{"name":"viento","known":true,"value":40,"contribution":0.5}]`)
			store := &fakeStore{latestPerZone: []repository.Batch{malformed, valid}}
			base, token := authorizedServer(t, "viewer", store)
			app := withCorrelationID(base)

			w := request(t, app, token, "/v1/risk/batches")
			if w.Code != http.StatusOK {
				t.Fatalf("got %d want %d: %s", w.Code, http.StatusOK, w.Body.String())
			}
			assertResponseMatchesContract(t, contract, "/v1/risk/batches", http.MethodGet, w)

			var body struct {
				Batches []struct {
					ZoneID   string          `json:"zone_id"`
					Factors  json.RawMessage `json:"factors"`
					Priority *struct {
						PriorityRank     *int `json:"priority_rank"`
						TotalRankedZones int  `json:"total_ranked_zones"`
					} `json:"priority"`
				} `json:"batches"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatalf("decode body: %v", err)
			}
			if len(body.Batches) != 2 {
				t.Fatalf("%d batches served, want both published rows", len(body.Batches))
			}

			byZone := make(map[string]int, len(body.Batches))
			for index, batch := range body.Batches {
				byZone[batch.ZoneID] = index
			}

			broken := body.Batches[byZone["05101"]]
			if broken.Priority != nil {
				t.Errorf("the malformed row kept a priority: %s", w.Body.String())
			}
			if string(broken.Factors) != "[]" {
				t.Errorf("the malformed row kept its factors: %s", broken.Factors)
			}

			peer := body.Batches[byZone["05109"]]
			if peer.Priority == nil {
				t.Fatalf("the valid peer lost its priority: %s", w.Body.String())
			}
			if peer.Priority.PriorityRank == nil {
				t.Error("the valid peer carries no rank")
			} else if *peer.Priority.PriorityRank != 1 {
				t.Errorf("the valid peer holds rank %d, want 1", *peer.Priority.PriorityRank)
			}
			if peer.Priority.TotalRankedZones != 1 {
				t.Errorf("the valid peer reports %d ranked zones, want 1", peer.Priority.TotalRankedZones)
			}
		})
	}
}
