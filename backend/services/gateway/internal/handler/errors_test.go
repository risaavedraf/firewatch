package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/coreos/go-oidc/v3/oidc"
)

// BH-12: every service answers one error body with a closed category, a safe
// message and the exact correlation id of the response header. These tests pin
// that contract at the writer and at the gateway's own boundary.

// bh12Body is the canonical error envelope this unit fixes.
type bh12Body struct {
	Code      string `json:"code"`
	Category  string `json:"category"`
	Message   string `json:"message"`
	RequestID string `json:"request_id"`
}

// panickingVerifier stands in for a dependency that fails inside the
// authentication gate, before any handler chose a status.
type panickingVerifier struct{}

func (panickingVerifier) Verify(context.Context, string) (*oidc.IDToken, error) {
	panic("pq: password authentication failed for user firewatch_app")
}

// bh12Decode reads the error body and fails when it is not the envelope.
func bh12Decode(t *testing.T, w *httptest.ResponseRecorder) bh12Body {
	t.Helper()
	var body struct {
		Code      string `json:"code"`
		Category  string `json:"category"`
		Message   string `json:"message"`
		RequestID string `json:"request_id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("error body is not JSON: %v: %s", err, w.Body)
	}
	if body.RequestID == "" {
		t.Fatalf("error body carries no request_id: %s", w.Body)
	}
	// The committed header, not the live header map: net/http freezes the
	// response headers at the first WriteHeader, so an id set after it would be in
	// the body and absent from what the client receives. Reading Result().Header
	// is what makes that difference observable here.
	if committed := w.Result().Header.Get("X-Request-ID"); body.RequestID != committed {
		t.Fatalf("body request_id %q and the committed X-Request-ID header %q must be one literal", body.RequestID, committed)
	}
	if body.Category == "" || body.Message == "" {
		t.Fatalf("error body carries no category/message: %s", w.Body)
	}
	return bh12Body{Code: body.Code, Category: body.Category, Message: body.Message, RequestID: body.RequestID}
}

// bh12CaptureLogs redirects the structured logger for the duration of one test,
// so the diagnostic path can be observed instead of assumed.
func bh12CaptureLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	logs := &bytes.Buffer{}
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(previous) })
	return logs
}

// TestErrorCategoryTaxonomyIsClosedAndTotal pins the one status-to-category
// mapping every service shares: a status may never fall into a category by
// accident, so the unlisted 4xx and 5xx cases are pinned too.
func TestErrorCategoryTaxonomyIsClosedAndTotal(t *testing.T) {
	for _, tc := range []struct {
		status int
		want   string
	}{
		{http.StatusBadRequest, "VALIDATION"},
		{http.StatusRequestEntityTooLarge, "VALIDATION"},
		{http.StatusUnsupportedMediaType, "VALIDATION"},
		{http.StatusUnprocessableEntity, "VALIDATION"},
		{http.StatusUnauthorized, "UNAUTHORIZED"},
		{http.StatusForbidden, "FORBIDDEN"},
		{http.StatusNotFound, "NOT_FOUND"},
		{http.StatusConflict, "CONFLICT"},
		{http.StatusTooManyRequests, "RATE_LIMITED"},
		{http.StatusBadGateway, "UPSTREAM_UNAVAILABLE"},
		{http.StatusServiceUnavailable, "UPSTREAM_UNAVAILABLE"},
		{http.StatusGatewayTimeout, "UPSTREAM_UNAVAILABLE"},
		{http.StatusInternalServerError, "INTERNAL"},
		{http.StatusNotImplemented, "INTERNAL"},
		{599, "INTERNAL"},
		{http.StatusTeapot, "VALIDATION"},
	} {
		if got := string(categoryForStatus(tc.status)); got != tc.want {
			t.Errorf("status %d maps to %q, want %q", tc.status, got, tc.want)
		}
	}
}

// TestGatewayErrorEnvelopeCarriesOneCategoryAndOneRequestID drives a real
// gateway failure: the bearer gate answers 401 through the same writer every
// other error uses.
func TestGatewayErrorEnvelopeCarriesOneCategoryAndOneRequestID(t *testing.T) {
	app := newTestGateway(t, allowedOrigin)

	request := httptest.NewRequest(http.MethodGet, "/v1/risk/latest?zone_id=valparaiso-demo", nil)
	response := httptest.NewRecorder()
	app.ServeHTTP(response, request)

	if response.Code != http.StatusUnauthorized {
		t.Fatalf("got %d want %d", response.Code, http.StatusUnauthorized)
	}
	body := bh12Decode(t, response)
	if body.Code != "unauthorized" || body.Category != "UNAUTHORIZED" {
		t.Fatalf("code=%q category=%q, want unauthorized/UNAUTHORIZED", body.Code, body.Category)
	}
}

// TestGatewayRecoversAPanicAsAGenericInternal pins the boundary the unit adds:
// a panic is answered 500 INTERNAL with a message that names nothing internal,
// while the cause and the correlation id reach the structured log.
func TestGatewayRecoversAPanicAsAGenericInternal(t *testing.T) {
	logs := bh12CaptureLogs(t)
	jobs, _ := url.Parse("http://jobs.invalid")
	risk, _ := url.Parse("http://risk.invalid")
	prevention, _ := url.Parse("http://prevention.invalid")
	app := New(panickingVerifier{}, jobs, risk, prevention, allowedOrigin)

	request := httptest.NewRequest(http.MethodGet, "/v1/risk/latest?zone_id=valparaiso-demo", nil)
	request.Header.Set("Authorization", "Bearer valid")
	response := httptest.NewRecorder()
	app.ServeHTTP(response, request)

	if response.Code != http.StatusInternalServerError {
		t.Fatalf("got %d want %d: %s", response.Code, http.StatusInternalServerError, response.Body)
	}
	body := bh12Decode(t, response)
	if body.Code != "internal_error" || body.Category != "INTERNAL" {
		t.Fatalf("code=%q category=%q, want internal_error/INTERNAL", body.Code, body.Category)
	}
	if body.Message != "internal error" {
		t.Fatalf("message=%q, want the generic internal error summary", body.Message)
	}
	if strings.Contains(response.Body.String(), "password authentication") {
		t.Fatalf("the internal cause reached the caller: %s", response.Body)
	}
	if !strings.Contains(logs.String(), "password authentication failed") {
		t.Fatalf("the cause was not logged: %s", logs.String())
	}
	if !strings.Contains(logs.String(), body.RequestID) {
		t.Fatalf("the log does not carry the request id %q: %s", body.RequestID, logs.String())
	}
}

// TestErrorWriterMintsACorrelationIDWhenTheResponseHasNone keeps the body and
// the header from ever disagreeing: an error written before any middleware set
// the id still answers one, and the header is part of the committed response.
func TestErrorWriterMintsACorrelationIDWhenTheResponseHasNone(t *testing.T) {
	response := httptest.NewRecorder()
	failure(response, http.StatusInternalServerError, "internal_error")

	body := bh12Decode(t, response)
	if body.Category != "INTERNAL" {
		t.Fatalf("category=%q, want INTERNAL", body.Category)
	}
}

// TestRecoveredPanicIsRecordedAsAnInternalError pins the defer ordering the
// recovery depends on. Deferred functions unwind last-in-first-out, so the panic
// boundary has to be registered *after* the metrics observer for it to run first;
// registered before, the observer would read the recorder before the 500 was
// written and count a panicked request as a 200. The scrape is answered by the
// same chain, so it shows exactly what /metrics would.
func TestRecoveredPanicIsRecordedAsAnInternalError(t *testing.T) {
	bh12CaptureLogs(t)
	jobs, _ := url.Parse("http://jobs.invalid")
	risk, _ := url.Parse("http://risk.invalid")
	prevention, _ := url.Parse("http://prevention.invalid")
	app := New(panickingVerifier{}, jobs, risk, prevention, allowedOrigin)

	request := httptest.NewRequest(http.MethodGet, "/v1/risk/latest?zone_id=valparaiso-demo", nil)
	request.Header.Set("Authorization", "Bearer valid")
	response := httptest.NewRecorder()
	app.ServeHTTP(response, request)
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("got %d want %d", response.Code, http.StatusInternalServerError)
	}

	scrape := httptest.NewRecorder()
	app.ServeHTTP(scrape, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if scrape.Code != http.StatusOK {
		t.Fatalf("/metrics got %d want %d", scrape.Code, http.StatusOK)
	}
	body := scrape.Body.String()
	for _, want := range []string{
		`firewatch_http_responses_total{class="5xx"} 1`,
		"firewatch_http_errors_total 1",
		`firewatch_http_responses_total{class="2xx"} 0`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("the recovered panic is not counted as an internal error: /metrics has no %q\n%s", want, body)
		}
	}
}

// TestInternalErrorIsTheDocumentedResponse pins the 500 this unit made
// observable against the published contract, so the status, its headers and its
// body cannot drift from what the document declares.
func TestInternalErrorIsTheDocumentedResponse(t *testing.T) {
	contract := loadContract(t)
	bh12CaptureLogs(t)
	jobs, _ := url.Parse("http://jobs.invalid")
	risk, _ := url.Parse("http://risk.invalid")
	prevention, _ := url.Parse("http://prevention.invalid")
	app := New(panickingVerifier{}, jobs, risk, prevention, allowedOrigin)

	request := httptest.NewRequest(http.MethodGet, "/v1/risk/latest?zone_id=valparaiso-demo", nil)
	request.Header.Set("Authorization", "Bearer valid")
	response := httptest.NewRecorder()
	app.ServeHTTP(response, request)

	if response.Code != http.StatusInternalServerError {
		t.Fatalf("got %d want %d", response.Code, http.StatusInternalServerError)
	}
	assertResponseMatchesContract(t, contract, "/v1/risk/latest", http.MethodGet, response)
}
