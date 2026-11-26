package handler

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	observations "firewatch.local/contracts/observations/v1"
	"firewatch.local/risk/internal/classify"
	"firewatch.local/risk/internal/repository"
	"github.com/google/uuid"
)

// simulationZone is a catalogue commune code, not the demo literal, so the route
// is exercised against the data-driven zone gate the other reads use.
const simulationZone = "05101"

// simulationInstant is the batch's recorded request instant. The route pins it as
// the single computation instant of both evaluations, so a test can assert the
// value instead of tolerating a clock read.
var simulationInstant = time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)

// policyReportingRule is the pair of classifier contracts the route needs: the
// identity the batch recorded, and the fingerprint that identity promised.
type policyReportingRule interface {
	classify.Classifier
	classify.PolicyFingerprinter
}

// stableRule is a built-in rule the simulation can reproduce locally. Both
// production rules report a policy, so the table covers both versions instead of
// a single hardcoded one.
var stableRule = map[string]policyReportingRule{
	classify.AcademicRuleV1ID:  classify.NewAcademicRuleV1(),
	classify.FirewatchRuleV2ID: classify.NewFirewatchRuleV2(),
}

// simulationBaseFeatures is the stored input of the batch every case starts from.
// Its values are chosen so the academic-rule-v1 level is bajo and the substitution
// below moves it to alto: a test that passed without substituting anything could
// not reach the second level.
func simulationBaseFeatures() classify.Features {
	return classify.Features{
		ObservedAt:          simulationInstant,
		EvaluatedAt:         simulationInstant,
		ZoneID:              simulationZone,
		TemperatureC:        classify.Known(20),
		RelativeHumidityPct: classify.Known(50),
		WindSpeedKmh:        classify.Known(20),
		VegetationCoverPct:  classify.Known(20),
		HistoricalFires:     classify.Known(1),
	}
}

// simulationHighVariables substitutes every canonical variable with a value in
// the highest band of both rules.
const simulationHighVariables = `{"temperatura":40,"humedad_relativa":0,"viento":60,"cobertura_vegetal":80,"incendios_historicos":5}`

// storedSimulationBatch builds the row the route reads: the real assessment of a
// built-in rule over the base features, with the policy reference that rule would
// have recorded. Nothing here is invented, so a successful simulation proves the
// route reproduces a genuinely reproducible provenance.
func storedSimulationBatch(t *testing.T, rule policyReportingRule) repository.Batch {
	t.Helper()
	fingerprint, err := rule.PolicyFingerprint()
	if err != nil {
		t.Fatalf("%s cannot report its policy: %v", rule.ID(), err)
	}
	assessment, err := rule.Classify(context.Background(), simulationBaseFeatures())
	if err != nil {
		t.Fatalf("classify the stored input with %s: %v", rule.ID(), err)
	}
	if assessment.Policy.PolicyID != rule.ID() || assessment.Policy.ParamsHash != fingerprint {
		t.Fatalf("%s stamped %+v, want id %q and fingerprint %q", rule.ID(), assessment.Policy, rule.ID(), fingerprint)
	}
	factors, err := json.Marshal(assessment.Factors)
	if err != nil {
		t.Fatalf("encode the stored factors: %v", err)
	}
	policy := assessment.Policy
	return repository.Batch{
		ID:           uuid.NewString(),
		JobID:        uuid.NewString(),
		ZoneID:       simulationZone,
		RequestedAt:  simulationInstant,
		PublishedAt:  simulationInstant.Add(time.Minute),
		ValidUntil:   simulationInstant.Add(15 * time.Minute),
		ModelVersion: rule.ID(),
		DataStatus:   "current",
		RiskLevel:    string(assessment.Level),
		Factors:      factors,
		Rationale:    assessment.Rationale,
		Policy:       &policy,
	}
}

// simulationBody is the response contract as a client sees it. It is decoded into
// test-owned types so the assertions pin the wire body instead of whatever struct
// the implementation happens to use.
type simulationBody struct {
	BatchID            string                   `json:"batch_id"`
	ZoneID             string                   `json:"zone_id"`
	ModelVersion       string                   `json:"model_version"`
	StoredLevel        string                   `json:"stored_level"`
	Policy             simulationPolicyBody     `json:"policy"`
	ComputationInstant time.Time                `json:"computation_instant"`
	Freshness          string                   `json:"freshness"`
	Before             simulationAssessmentBody `json:"before"`
	After              simulationAssessmentBody `json:"after"`
	Notice             string                   `json:"notice"`
}

type simulationPolicyBody struct {
	PolicyID   string `json:"policy_id"`
	ParamsHash string `json:"params_hash"`
}

type simulationAssessmentBody struct {
	Level   string                 `json:"level"`
	Factors []simulationFactorBody `json:"factors"`
}

type simulationFactorBody struct {
	Name         string   `json:"name"`
	Known        bool     `json:"known"`
	Value        *float64 `json:"value"`
	Contribution *float64 `json:"contribution"`
}

// postSimulation posts one simulation document through the real authorized handler
// wrapped in the production correlation-id middleware, so the error bodies carry
// the same request_id every other risk route echoes.
func postSimulation(t *testing.T, handler http.Handler, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	return postSimulationAs(t, handler, token, body, "application/json")
}

// postSimulationAs is the same request with an explicit media type, so the
// documented 415 answer is exercised through the real handler.
func postSimulationAs(t *testing.T, handler http.Handler, token, body, contentType string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "/v1/risk/simulate", strings.NewReader(body))
	r.Header.Set("Content-Type", contentType)
	r.Header.Set("X-Request-ID", uuid.NewString())
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	withCorrelationID(handler).ServeHTTP(w, r)
	return w
}

func decodeSimulation(t *testing.T, w *httptest.ResponseRecorder) simulationBody {
	t.Helper()
	var body simulationBody
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("simulation body is not JSON: %v: %s", err, w.Body.String())
	}
	return body
}

// factorOf returns one canonical factor from an assessment, failing when the
// route dropped or renamed it.
func factorOf(t *testing.T, factors []simulationFactorBody, name string) simulationFactorBody {
	t.Helper()
	for _, factor := range factors {
		if factor.Name == name {
			return factor
		}
	}
	t.Fatalf("assessment carries no factor %q: %+v", name, factors)
	return simulationFactorBody{}
}

// requireValue asserts a factor is present with the given number. Both rules
// report an absent input without value or contribution, so a nil pointer here
// would mean the substitution was not applied.
func requireValue(t *testing.T, factor simulationFactorBody, want float64) {
	t.Helper()
	if factor.Value == nil {
		t.Fatalf("%s carries no value, want %v", factor.Name, want)
	}
	if math.Abs(*factor.Value-want) > 1e-9 {
		t.Fatalf("%s value = %v, want %v", factor.Name, *factor.Value, want)
	}
}

func requireContribution(t *testing.T, factor simulationFactorBody, want float64) {
	t.Helper()
	if factor.Contribution == nil {
		t.Fatalf("%s carries no contribution, want %v", factor.Name, want)
	}
	if math.Abs(*factor.Contribution-want) > 1e-9 {
		t.Fatalf("%s contribution = %v, want %v", factor.Name, *factor.Contribution, want)
	}
}

// TestSimulateSubstitutesVariablesWithoutWritingProtectingTheStoredBatch is S5's
// first half at the HTTP contract level: an authenticated viewer recalculation
// substitutes the requested variables, returns the level the stored rule produces
// with them, and leaves the stored batch exactly as it was. There is no write path
// in the route - the fake store only counts reads - so an unexpected read of a
// different batch or a second call is evidence the naive implementation changed.
func TestSimulateSubstitutesVariablesWithoutWritingProtectingTheStoredBatch(t *testing.T) {
	stored := storedSimulationBatch(t, stableRule[classify.AcademicRuleV1ID])
	if stored.RiskLevel != string(classify.LevelBajo) {
		t.Fatalf("the stored input classifies as %q, want %q: the substitution below must be what moves the level", stored.RiskLevel, classify.LevelBajo)
	}
	store := &fakeStore{zones: map[string]bool{simulationZone: true}, batches: []repository.Batch{stored}}
	before := append([]repository.Batch(nil), store.batches...)
	handler, token := authorizedServer(t, "viewer", store)

	w := postSimulation(t, handler, token, `{"zone_id":"`+simulationZone+`","variables":`+simulationHighVariables+`}`)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d want 200: %s", w.Code, w.Body.String())
	}
	body := decodeSimulation(t, w)

	if body.BatchID != stored.ID || body.ZoneID != simulationZone {
		t.Fatalf("batch_id=%q zone_id=%q, want %q and %q", body.BatchID, body.ZoneID, stored.ID, simulationZone)
	}
	if body.ModelVersion != classify.AcademicRuleV1ID {
		t.Fatalf("model_version = %q, want the batch's historical %q", body.ModelVersion, classify.AcademicRuleV1ID)
	}
	if body.StoredLevel != stored.RiskLevel {
		t.Fatalf("stored_level = %q, want the stored %q", body.StoredLevel, stored.RiskLevel)
	}
	if body.Policy.PolicyID != classify.AcademicRuleV1ID || body.Policy.ParamsHash != classify.AcademicRuleV1ParamsHash {
		t.Fatalf("policy = %+v, want the recorded %s identity", body.Policy, classify.AcademicRuleV1ID)
	}
	if !body.ComputationInstant.Equal(simulationInstant) {
		t.Fatalf("computation_instant = %s, want the batch's recorded %s", body.ComputationInstant, simulationInstant)
	}
	if body.Freshness != "not_evaluated" {
		t.Fatalf("freshness = %q, want the explicit %q: the route claims no freshness", body.Freshness, "not_evaluated")
	}
	if !strings.Contains(strings.ToLower(body.Notice), "no es un pronóstico") {
		t.Fatalf("notice %q must declare that the answer is not a forecast", body.Notice)
	}

	// The before assessment reproduces the stored level from the stored factors,
	// so the difference below is attributable to the substitution alone.
	if body.Before.Level != stored.RiskLevel {
		t.Fatalf("before.level = %q, want the stored %q", body.Before.Level, stored.RiskLevel)
	}
	requireValue(t, factorOf(t, body.Before.Factors, observations.VariableTemperature), 20)
	requireContribution(t, factorOf(t, body.Before.Factors, observations.VariableTemperature), 0.0625)

	// The after assessment carries the substituted values under the same rule: the
	// level moves to alto and the contributions are academic-rule-v1's numbers.
	if body.After.Level != string(classify.LevelAlto) {
		t.Fatalf("after.level = %q, want %q with every variable in the highest band", body.After.Level, classify.LevelAlto)
	}
	if body.After.Level == body.Before.Level {
		t.Fatal("before and after report the same level: no substitution was applied")
	}
	requireValue(t, factorOf(t, body.After.Factors, observations.VariableTemperature), 40)
	requireContribution(t, factorOf(t, body.After.Factors, observations.VariableTemperature), 0.25)
	requireValue(t, factorOf(t, body.After.Factors, observations.VariableHumidity), 0)
	requireContribution(t, factorOf(t, body.After.Factors, observations.VariableHumidity), 0.25)
	if !reflect.DeepEqual(store.batches, before) {
		t.Fatalf("the stored batch changed: %+v", store.batches)
	}
	if store.calls != 1 {
		t.Fatalf("storage read %d times, want exactly one latest-batch read", store.calls)
	}
	if store.zoneCalls != 1 {
		t.Fatalf("zone catalogue read %d times, want exactly one membership check", store.zoneCalls)
	}
	if store.aggregateCall != 0 || len(store.activated) != 0 {
		t.Fatalf("the simulation touched an unrelated read or a write: aggregate=%d activated=%v", store.aggregateCall, store.activated)
	}
}

// TestSimulateTreatsNullAsMissing proves the explicit absence rule: a null member
// forces the variable to be absent, and the rule answers desconocido instead of
// reading the null as a zero observation. This is the single most dangerous
// substitution the route could get wrong.
func TestSimulateTreatsNullAsMissing(t *testing.T) {
	stored := storedSimulationBatch(t, stableRule[classify.AcademicRuleV1ID])
	store := &fakeStore{zones: map[string]bool{simulationZone: true}, batches: []repository.Batch{stored}}
	handler, token := authorizedServer(t, "viewer", store)

	w := postSimulation(t, handler, token, `{"zone_id":"`+simulationZone+`","variables":{"humedad_relativa":null}}`)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d want 200: %s", w.Code, w.Body.String())
	}
	body := decodeSimulation(t, w)
	if body.After.Level != string(classify.LevelDesconocido) {
		t.Fatalf("after.level = %q, want %q when a variable is forced missing", body.After.Level, classify.LevelDesconocido)
	}
	humidity := factorOf(t, body.After.Factors, observations.VariableHumidity)
	if humidity.Known || humidity.Value != nil || humidity.Contribution != nil {
		t.Fatalf("humidity factor = %+v, want an absent factor with no value and no contribution", humidity)
	}
	// The untouched variables keep their stored observations.
	requireValue(t, factorOf(t, body.After.Factors, observations.VariableTemperature), 20)
}

// TestSimulateUsesTheBatchsRecordedRuleNotTheActiveOne is the S4/L2 guarantee at
// the HTTP contract level: the version recorded on the batch decides the
// parameters, even when the registry marks a different version active. The
// academic-rule-v1 weights (0.25/0.25) and the firewatch-rule-v2 weights
// (0.30/0.30) differ, so the contributions prove which parameter set ran.
func TestSimulateUsesTheBatchsRecordedRuleNotTheActiveOne(t *testing.T) {
	stored := storedSimulationBatch(t, stableRule[classify.FirewatchRuleV2ID])
	store := &fakeStore{
		zones:   map[string]bool{simulationZone: true},
		batches: []repository.Batch{stored},
		// The registry presents academic-rule-v1 as active. A fallback to it would
		// stamp the wrong policy and use its weights.
		models: []repository.ModelVersion{
			{Version: classify.AcademicRuleV1ID, Kind: "rule", ParamsHash: stringPtr(classify.AcademicRuleV1ParamsHash), Active: true, Metrics: json.RawMessage(`{}`)},
			{Version: classify.FirewatchRuleV2ID, Kind: "rule", ParamsHash: stringPtr(classify.FirewatchRuleV2ParamsHash), Active: false, Metrics: json.RawMessage(`{}`)},
		},
	}
	handler, token := authorizedServer(t, "viewer", store)

	w := postSimulation(t, handler, token, `{"zone_id":"`+simulationZone+`","variables":`+simulationHighVariables+`}`)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d want 200: %s", w.Code, w.Body.String())
	}
	body := decodeSimulation(t, w)
	if body.ModelVersion != classify.FirewatchRuleV2ID || body.Policy.PolicyID != classify.FirewatchRuleV2ID {
		t.Fatalf("model_version=%q policy=%+v, want the batch's %q", body.ModelVersion, body.Policy, classify.FirewatchRuleV2ID)
	}
	if body.Policy.ParamsHash != classify.FirewatchRuleV2ParamsHash {
		t.Fatalf("policy.params_hash = %q, want the recorded v2 fingerprint %q", body.Policy.ParamsHash, classify.FirewatchRuleV2ParamsHash)
	}
	// v2 weights: temperature 0.30 and humidity 0.30, not v1's 0.25 and 0.25.
	requireContribution(t, factorOf(t, body.After.Factors, observations.VariableTemperature), 0.30)
	requireContribution(t, factorOf(t, body.After.Factors, observations.VariableHumidity), 0.30)
	// v2 aggregates the dominant factor instead of the sum, so the same substituted
	// variables answer medio here where v1 answered alto. The level itself is
	// therefore the second proof that the batch's rule ran: a fallback to the active
	// v1 would answer alto.
	if body.After.Level != string(classify.LevelMedio) {
		t.Fatalf("after.level = %q, want %q: the dominant v2 contribution is 0.30, inside the medio band, where v1's weighted sum would answer %q", body.After.Level, classify.LevelMedio, classify.LevelAlto)
	}
}

// TestSimulateRefusesAnUnreproducibleOriginalRule covers S4's refusal: when the
// recorded provenance cannot be reproduced locally - no reference, a different
// identifier, a different fingerprint, a version this binary cannot rebuild, an
// unreadable factor payload or a batch with no recorded instant - the answer is
// unsupported and never a result computed with a fallback policy.
func TestSimulateRefusesAnUnreproducibleOriginalRule(t *testing.T) {
	trained := "ml-fixture-v1"
	fixturePolicy := classify.PolicyRef{PolicyID: trained, Parameters: map[string]string{"artifact": "logistic.json"}, ParamsHash: "992bd6ac53c75c2d31829c1126c8d2cb97d5a61cad4348d1047d5c93b15a15b5"}
	placeholderPolicy := classify.PolicyRef{PolicyID: "demo-fixture-v1", Parameters: map[string]string{}, ParamsHash: "0000000000000000000000000000000000000000000000000000000000000000"}

	for _, tc := range []struct {
		name   string
		mutate func(*repository.Batch)
		reason string
	}{
		{
			name:   "no recorded policy",
			mutate: func(batch *repository.Batch) { batch.Policy = nil },
			reason: "a row written before policy persistence has no reference to reproduce",
		},
		{
			name:   "different policy identifier",
			mutate: func(batch *repository.Batch) { batch.Policy.PolicyID = classify.FirewatchRuleV2ID },
			reason: "the recorded identifier is not the one the version rebuilds",
		},
		{
			name:   "different policy fingerprint",
			mutate: func(batch *repository.Batch) { batch.Policy.ParamsHash = classify.FirewatchRuleV2ParamsHash },
			reason: "the recorded fingerprint is not the frozen one",
		},
		{
			name:   "no recorded parameters",
			mutate: func(batch *repository.Batch) { batch.Policy.Parameters = nil },
			reason: "the reference records an identity without any parameter set",
		},
		{
			name: "fixture-backed model version",
			mutate: func(batch *repository.Batch) {
				batch.ModelVersion = trained
				batch.Policy = &fixturePolicy
			},
			reason: "the fixture is executed by the inference service, not rebuildable here",
		},
		{
			name: "placeholder model version",
			mutate: func(batch *repository.Batch) {
				batch.ModelVersion = "demo-fixture-v1"
				batch.Policy = &placeholderPolicy
			},
			reason: "a placeholder never classified anything",
		},
		{
			name:   "unreadable stored factors",
			mutate: func(batch *repository.Batch) { batch.Factors = json.RawMessage(`{"temperatura":20}`) },
			reason: "the stored inputs cannot be read back",
		},
		{
			name:   "no recorded request instant",
			mutate: func(batch *repository.Batch) { batch.RequestedAt = time.Time{} },
			reason: "there is no recorded instant to pin as the computation instant",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stored := storedSimulationBatch(t, stableRule[classify.AcademicRuleV1ID])
			tc.mutate(&stored)
			store := &fakeStore{zones: map[string]bool{simulationZone: true}, batches: []repository.Batch{stored}}
			handler, token := authorizedServer(t, "viewer", store)

			w := postSimulation(t, handler, token, `{"zone_id":"`+simulationZone+`","variables":{"temperatura":40}}`)
			if w.Code != http.StatusUnprocessableEntity {
				t.Fatalf("got %d want 422 (%s): %s", w.Code, tc.reason, w.Body.String())
			}
			assertSimulationError(t, w, "unsupported_original_rule")
		})
	}
}

// TestSimulateRejectsMalformedInput is the bounded-input table: the route accepts
// exactly one JSON object with zone_id and a non-empty subset of the five
// canonical variables, and refuses everything else before storage is touched.
func TestSimulateRejectsMalformedInput(t *testing.T) {
	for _, tc := range []struct {
		name  string
		body  string
		want  int
		code  string
		zones map[string]bool
	}{
		{name: "not an object", body: `[1]`, want: 400, code: "invalid_simulation"},
		{name: "empty body", body: ``, want: 400, code: "invalid_simulation"},
		{name: "unknown member", body: `{"zone_id":"05101","variables":{"temperatura":30},"forecast":true}`, want: 400, code: "invalid_simulation"},
		{name: "duplicate member", body: `{"zone_id":"05101","zone_id":"05101","variables":{"temperatura":30}}`, want: 400, code: "invalid_simulation"},
		{name: "trailing input", body: `{"zone_id":"05101","variables":{"temperatura":30}} {}`, want: 400, code: "invalid_simulation"},
		{name: "missing zone", body: `{"variables":{"temperatura":30}}`, want: 400, code: "invalid_simulation"},
		{name: "null zone", body: `{"zone_id":null,"variables":{"temperatura":30}}`, want: 400, code: "invalid_simulation"},
		{name: "unknown zone", body: `{"zone_id":"99999","variables":{"temperatura":30}}`, want: 400, code: "invalid_zone"},
		{name: "missing variables", body: `{"zone_id":"05101"}`, want: 400, code: "invalid_simulation"},
		{name: "empty variables", body: `{"zone_id":"05101","variables":{}}`, want: 400, code: "invalid_simulation"},
		{name: "variables not an object", body: `{"zone_id":"05101","variables":[30]}`, want: 400, code: "invalid_simulation"},
		{name: "unknown variable", body: `{"zone_id":"05101","variables":{"temperatura":30,"presion":1}}`, want: 400, code: "invalid_simulation"},
		{name: "duplicate variable", body: `{"zone_id":"05101","variables":{"temperatura":30,"temperatura":31}}`, want: 400, code: "invalid_simulation"},
		{name: "string variable", body: `{"zone_id":"05101","variables":{"temperatura":"30"}}`, want: 400, code: "invalid_simulation"},
		{name: "boolean variable", body: `{"zone_id":"05101","variables":{"temperatura":true}}`, want: 400, code: "invalid_simulation"},
		{name: "non-finite variable", body: `{"zone_id":"05101","variables":{"temperatura":1e400}}`, want: 400, code: "invalid_simulation"},
		{name: "oversized body", body: `{"zone_id":"05101","variables":{"temperatura":30},"pad":"` + strings.Repeat("x", 8192) + `"}`, want: 400, code: "invalid_simulation"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			zones := tc.zones
			if zones == nil {
				zones = map[string]bool{simulationZone: true}
			}
			store := &fakeStore{zones: zones, batches: []repository.Batch{storedSimulationBatch(t, stableRule[classify.AcademicRuleV1ID])}}
			handler, token := authorizedServer(t, "viewer", store)

			w := postSimulation(t, handler, token, tc.body)
			if w.Code != tc.want {
				t.Fatalf("got %d want %d: %s", w.Code, tc.want, w.Body.String())
			}
			assertSimulationError(t, w, tc.code)
			if store.calls != 0 {
				t.Fatalf("a rejected body reached the batch read %d times", store.calls)
			}
		})
	}
}

// TestSimulateEmptyStateAndStorageFailures keeps the failure vocabulary aligned
// with the neighbouring reads: nothing published is the documented empty state,
// and a storage failure is 503 rather than an empty simulation.
func TestSimulateEmptyStateAndStorageFailures(t *testing.T) {
	body := `{"zone_id":"` + simulationZone + `","variables":{"temperatura":30}}`
	for _, tc := range []struct {
		name  string
		store *fakeStore
		want  int
		code  string
	}{
		{name: "nothing published", store: &fakeStore{zones: map[string]bool{simulationZone: true}}, want: 404, code: "no_published_batch"},
		{name: "catalogue unavailable", store: &fakeStore{zoneErr: errStorage}, want: 503, code: "storage_unavailable"},
		{name: "batch read unavailable", store: nil, want: 503, code: "storage_unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var store Repository = tc.store
			if tc.store == nil {
				store = listFailingStore{&fakeStore{zones: map[string]bool{simulationZone: true}}}
			}
			handler, token := authorizedServer(t, "viewer", store)
			w := postSimulation(t, handler, token, body)
			if w.Code != tc.want {
				t.Fatalf("got %d want %d: %s", w.Code, tc.want, w.Body.String())
			}
			assertSimulationError(t, w, tc.code)
		})
	}
}

// TestSimulateRequiresTheReadGate reuses the gate every risk read already has: a
// valid token is required before the body is read, and a role outside viewer/admin
// is forbidden. The token check must run first, so an unauthenticated caller
// never learns whether its document was well formed.
func TestSimulateRequiresTheReadGate(t *testing.T) {
	store := &fakeStore{zones: map[string]bool{simulationZone: true}, batches: []repository.Batch{storedSimulationBatch(t, stableRule[classify.AcademicRuleV1ID])}}
	handler, _ := authorizedServer(t, "operator", store)

	w := postSimulation(t, handler, "", `{"zone_id":"`+simulationZone+`","variables":{"temperatura":40}}`)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("no token: got %d want 401: %s", w.Code, w.Body.String())
	}
	if store.calls != 0 || store.zoneCalls != 0 {
		t.Fatal("an unauthenticated request reached storage")
	}

	operatorHandler, operatorToken := authorizedServer(t, "operator", store)
	w = postSimulation(t, operatorHandler, operatorToken, `{"zone_id":"`+simulationZone+`","variables":{"temperatura":40}}`)
	if w.Code != http.StatusForbidden {
		t.Fatalf("role operator: got %d want 403: %s", w.Code, w.Body.String())
	}

	for _, role := range []string{"viewer", "admin"} {
		t.Run(role, func(t *testing.T) {
			allowed, token := authorizedServer(t, role, store)
			w := postSimulation(t, allowed, token, `{"zone_id":"`+simulationZone+`","variables":{"temperatura":40}}`)
			if w.Code != http.StatusOK {
				t.Fatalf("role %s: got %d want 200: %s", role, w.Code, w.Body.String())
			}
		})
	}
}

// TestSimulateRequiresJSONContentType mirrors the other POST bodies: a document
// that is not declared as JSON is refused with the shared json_required code
// before it is parsed.
func TestSimulateRequiresJSONContentType(t *testing.T) {
	store := &fakeStore{zones: map[string]bool{simulationZone: true}, batches: []repository.Batch{storedSimulationBatch(t, stableRule[classify.AcademicRuleV1ID])}}
	handler, token := authorizedServer(t, "viewer", store)

	r := httptest.NewRequest(http.MethodPost, "/v1/risk/simulate", strings.NewReader(`{"zone_id":"`+simulationZone+`","variables":{"temperatura":40}}`))
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("Content-Type", "text/plain")
	w := httptest.NewRecorder()
	withCorrelationID(handler).ServeHTTP(w, r)
	if w.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("got %d want 415: %s", w.Code, w.Body.String())
	}
	assertSimulationError(t, w, "json_required")
	if store.calls != 0 {
		t.Fatal("a non-JSON body reached storage")
	}
}

// TestSimulateNeverClaimsAForecast pins the wording of the response: it carries no
// probability, no horizon and no forecast member, and the notice says so. A later
// edit that starts implying prediction breaks this test instead of the demo.
func TestSimulateNeverClaimsAForecast(t *testing.T) {
	store := &fakeStore{zones: map[string]bool{simulationZone: true}, batches: []repository.Batch{storedSimulationBatch(t, stableRule[classify.AcademicRuleV1ID])}}
	handler, token := authorizedServer(t, "viewer", store)

	w := postSimulation(t, handler, token, `{"zone_id":"`+simulationZone+`","variables":`+simulationHighVariables+`}`)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d want 200: %s", w.Code, w.Body.String())
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &document); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	for _, forbidden := range []string{"forecast", "prediction", "probability", "horizon", "confidence"} {
		if _, found := document[forbidden]; found {
			t.Fatalf("the response claims %q: %s", forbidden, w.Body.String())
		}
	}
	notice := decodeSimulation(t, w).Notice
	lowered := strings.ToLower(notice)
	if !strings.Contains(lowered, "no es un pronóstico") || !strings.Contains(lowered, "no modifica") {
		t.Fatalf("notice %q must declare both that this is not a forecast and that nothing published changes", notice)
	}
	if !strings.Contains(notice, classify.AcademicRuleV1ID) {
		t.Fatalf("notice %q must name the rule that produced the counterfactual", notice)
	}
}

// errStorage stands in for a storage failure so the route's 503 path is exercised
// without a database.
var errStorage = errors.New("storage unavailable")

// listFailingStore fails the latest-batch read while keeping every other read
// working, so the route's failure vocabulary can be pinned per dependency.
type listFailingStore struct{ *fakeStore }

func (s listFailingStore) List(context.Context, string, int) ([]repository.Batch, error) {
	return nil, errStorage
}

// assertSimulationError checks the shared error body of a refused call.
func assertSimulationError(t *testing.T, w *httptest.ResponseRecorder, code string) {
	t.Helper()
	var body struct {
		Code      string `json:"code"`
		RequestID string `json:"request_id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("error body is not JSON: %v: %s", err, w.Body.String())
	}
	if body.Code != code {
		t.Fatalf("code = %q, want %q: %s", body.Code, code, w.Body.String())
	}
	if code == "no_published_batch" {
		return
	}
	if body.RequestID == "" {
		t.Fatalf("error body carries no request_id: %s", w.Body.String())
	}
}
