package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
)

// The published contract is the single source of truth for this API surface, so
// these tests validate real gateway responses against it instead of restating
// the expected shape by hand. They deliberately exercise the error paths only
// the gateway owns: the bearer gate, the global rate limiter and the
// upstream-failure handler. Service-owned bodies (503 storage, 400 validation)
// are validated by the service handler contract tests.
//
// The contract is generated nowhere: contracts/openapi/firewatch-v1.yaml is
// edited by hand and consumed here, so a response that stops matching it fails
// this test rather than drifting silently.

// contractPath locates the published contract from this package's working dir.
var contractPath = filepath.Join("..", "..", "..", "..", "contracts", "openapi", "firewatch-v1.yaml")

// loadContract loads and validates the published contract.
func loadContract(t *testing.T) *openapi3.T {
	t.Helper()
	loader := openapi3.NewLoader()
	contract, err := loader.LoadFromFile(contractPath)
	if err != nil {
		t.Fatalf("load the published contract: %v", err)
	}
	if err := contract.Validate(context.Background()); err != nil {
		t.Fatalf("the published contract is not valid: %v", err)
	}
	return contract
}

// assertResponseMatchesContract fails when the real response is not the one the
// contract documents: the status must be declared for the operation, every
// header the contract declares must be present, and the JSON body must validate
// against the declared schema.
func assertResponseMatchesContract(t *testing.T, contract *openapi3.T, target, method string, response *httptest.ResponseRecorder) {
	t.Helper()
	item := contract.Paths.Find(target)
	if item == nil {
		t.Fatalf("contract documents no path %q", target)
	}
	operation := item.GetOperation(method)
	if operation == nil {
		t.Fatalf("contract documents no %s operation for %q", method, target)
	}
	documented := operation.Responses.Status(response.Code)
	if documented == nil || documented.Value == nil {
		t.Fatalf("contract documents no %d response for %s %s", response.Code, method, target)
	}
	for name := range documented.Value.Headers {
		if response.Header().Get(name) == "" {
			t.Errorf("%s %s %d is missing the documented header %q", method, target, response.Code, name)
		}
	}
	media := documented.Value.Content.Get("application/json")
	if media == nil || media.Schema == nil || media.Schema.Value == nil {
		t.Fatalf("contract documents no application/json body for %s %s %d", method, target, response.Code)
	}
	var body any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("response body is not JSON: %v: %s", err, response.Body.String())
	}
	if err := media.Schema.Value.VisitJSON(body); err != nil {
		t.Fatalf("response body does not match the contract for %s %s %d: %v\nbody: %s", method, target, response.Code, err, response.Body.String())
	}
}

// S3: the bearer gate is answered by the gateway and its body must be the one
// the contract documents for the operation.
func TestGatewayContractUnauthorizedResponse(t *testing.T) {
	contract := loadContract(t)
	app := newTestGateway(t, allowedOrigin)

	request := httptest.NewRequest(http.MethodGet, "/v1/risk/latest?zone_id=valparaiso-demo", nil)
	response := httptest.NewRecorder()
	app.ServeHTTP(response, request)

	if response.Code != http.StatusUnauthorized {
		t.Fatalf("got %d want %d", response.Code, http.StatusUnauthorized)
	}
	assertResponseMatchesContract(t, contract, "/v1/risk/latest", http.MethodGet, response)
}

// S3: "fallo upstream" — an unreachable upstream service is answered 502 by the
// gateway, and that body must be the documented UpstreamUnavailable response.
func TestGatewayContractUpstreamUnavailableResponse(t *testing.T) {
	contract := loadContract(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	target, _ := url.Parse(upstream.URL)
	upstream.Close()
	app := New(verifier{}, target, target, target, allowedOrigin)

	request := httptest.NewRequest(http.MethodGet, "/v1/risk/latest?zone_id=valparaiso-demo", nil)
	request.Header.Set("Authorization", "Bearer valid")
	response := httptest.NewRecorder()
	app.ServeHTTP(response, request)

	if response.Code != http.StatusBadGateway {
		t.Fatalf("got %d want %d", response.Code, http.StatusBadGateway)
	}
	assertResponseMatchesContract(t, contract, "/v1/risk/latest", http.MethodGet, response)
}

// S3: "rate limit" — the global limiter answers 429 before routing. The
// documented response carries Retry-After, so the real one must too.
func TestGatewayContractRateLimitedResponse(t *testing.T) {
	contract := loadContract(t)
	app := newTestGateway(t, allowedOrigin)

	var limited *httptest.ResponseRecorder
	// No bearer is sent: the limiter runs before the bearer check, so every
	// request drains the same budget until the limiter answers 429.
	for burst := 0; burst < 200 && limited == nil; burst++ {
		request := httptest.NewRequest(http.MethodGet, "/v1/risk/latest?zone_id=valparaiso-demo", nil)
		recorder := httptest.NewRecorder()
		app.ServeHTTP(recorder, request)
		if recorder.Code == http.StatusTooManyRequests {
			limited = recorder
		}
	}
	if limited == nil {
		t.Fatal("a burst of requests never reached the rate limit")
	}
	if got := limited.Header().Get("Retry-After"); got == "" {
		t.Error("429 response must carry Retry-After")
	}
	assertResponseMatchesContract(t, contract, "/v1/risk/latest", http.MethodGet, limited)
}

// S1/S2: the published audit contract must require the durable per-row metadata
// the service now emits, not merely tolerate it as an extra property. A client
// needs a stable event id, an explicit null-or-name actor, a free-text detail and
// a closed event kind; job_id must be nullable because a query record has no job.
func TestAuditContractRequiresDurableEventMetadata(t *testing.T) {
	contract := loadContract(t)
	item := contract.Paths.Find("/v1/audit")
	if item == nil {
		t.Fatal("the contract documents no /v1/audit path")
	}
	operation := item.GetOperation(http.MethodGet)
	if operation == nil || operation.Responses.Status(http.StatusOK) == nil || operation.Responses.Status(http.StatusOK).Value == nil {
		t.Fatal("the contract documents no 200 response for GET /v1/audit")
	}
	media := operation.Responses.Status(http.StatusOK).Value.Content.Get("application/json")
	if media == nil || media.Schema == nil || media.Schema.Value == nil || media.Schema.Value.Items == nil || media.Schema.Value.Items.Value == nil {
		t.Fatal("the contract documents no audit row schema")
	}
	row := media.Schema.Value.Items.Value
	required := map[string]bool{}
	for _, name := range row.Required {
		required[name] = true
	}
	for _, name := range []string{"event_id", "actor_id", "actor_name", "action", "event_kind", "detail", "job_id", "trace_id", "occurred_at"} {
		if !required[name] {
			t.Errorf("the audit row does not require %q; every read returns it", name)
		}
	}
	for _, name := range []string{"actor_name", "detail", "job_id"} {
		property := row.Properties[name]
		if property == nil || property.Value == nil {
			t.Errorf("the audit row does not document %q", name)
			continue
		}
		if !property.Value.Nullable {
			t.Errorf("%s must be nullable so an uncaptured name, a legacy detail and a query without a job stay honest", name)
		}
	}
	eventID := row.Properties["event_id"]
	if eventID == nil || eventID.Value == nil || eventID.Value.Pattern != `^audit-[0-9]+$` {
		t.Error("event_id must document the stable audit-<identity> shape instead of a job or trace id")
	}
	kind := row.Properties["event_kind"]
	if kind == nil || kind.Value == nil {
		t.Fatal("the audit row does not document event_kind")
	}
	declared := map[string]bool{}
	for _, value := range kind.Value.Enum {
		if name, ok := value.(string); ok {
			declared[name] = true
		}
	}
	if len(declared) != 2 || !declared["mutation"] || !declared["query"] {
		t.Errorf("event_kind enum=%v want exactly mutation and query", kind.Value.Enum)
	}
}

// S1/S2: a real 200 through the gateway must match the published audit contract,
// including the explicit null actor of a system record. The upstream body mirrors
// the jobs read view; this proves the gateway adds no field and drops none.
func TestGatewayContractAuditResponse(t *testing.T) {
	contract := loadContract(t)
	name, detail := "Demo Admin", "Solicitud de trabajo para la zona valparaiso-demo"
	jobID := "11111111-1111-4111-8111-111111111111"
	traceID := "22222222-2222-4222-8222-222222222222"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/audit" {
			t.Errorf("gateway proxied %q, want /v1/audit", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{
				"event_id": "audit-41", "actor_id": "admin-subject", "actor_name": name,
				"action": "job.requested", "event_kind": "mutation", "detail": detail,
				"job_id": jobID, "trace_id": traceID, "occurred_at": "2030-01-02T03:04:05Z",
			},
			{
				"event_id": "audit-42", "actor_id": "system", "actor_name": nil,
				"action": "batch.published", "event_kind": "mutation", "detail": nil,
				"job_id": jobID, "trace_id": traceID, "occurred_at": "2030-01-02T03:05:05Z",
			},
			{
				// A query has no job and no captured name. Its action vocabulary is the
				// query recorder's, so the audit schema must not close the field to the
				// two mutation actions.
				"event_id": "audit-43", "actor_id": "query-actor", "actor_name": nil,
				"action": "risk.current.read", "event_kind": "query", "detail": "Consulta del riesgo actual",
				"job_id": nil, "trace_id": traceID, "occurred_at": "2030-01-02T03:06:05Z",
			},
		})
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	app := New(verifier{}, target, target, target, allowedOrigin)

	request := httptest.NewRequest(http.MethodGet, "/v1/audit", nil)
	request.Header.Set("Authorization", "Bearer valid")
	response := httptest.NewRecorder()
	app.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("got %d want %d body=%s", response.Code, http.StatusOK, response.Body)
	}
	assertResponseMatchesContract(t, contract, "/v1/audit", http.MethodGet, response)
}
