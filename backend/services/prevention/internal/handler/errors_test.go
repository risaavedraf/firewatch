package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/google/uuid"
)

// BH-12: one error body, one closed category taxonomy and one correlation id in
// every service. These tests pin the writer and the panic boundary of
// prevention.

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
	// The committed header, not the live header map: net/http freezes the response
	// headers at the first WriteHeader, so an id set after it would be in the body
	// and absent from what the client receives. Reading Result().Header is what
	// makes that difference observable here.
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
// mapping every service shares, including the statuses the unit's list does not
// enumerate: an unlisted 4xx is a request rejection and an unlisted 5xx is
// internal, never the other way round.
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

// TestErrorWriterKeepsTheBodyAndTheHeaderOnOneID covers the writer on its own:
// a 403 keeps its code, gains the forbidden category, and never answers an empty
// correlation id even when no middleware has run.
func TestErrorWriterKeepsTheBodyAndTheHeaderOnOneID(t *testing.T) {
	response := httptest.NewRecorder()
	fail(response, http.StatusForbidden, "forbidden")

	body := bh12Decode(t, response)
	if body.Code != "forbidden" || body.Category != "FORBIDDEN" {
		t.Fatalf("code=%q category=%q, want forbidden/FORBIDDEN", body.Code, body.Category)
	}
}

// TestRecoveredPanicIsAGenericInternal pins the boundary this unit adds: a panic
// is answered 500 INTERNAL with a message that names nothing internal, while the
// cause and the correlation id reach the structured log.
func TestRecoveredPanicIsAGenericInternal(t *testing.T) {
	logs := bh12CaptureLogs(t)
	handler := New(nil, panickingVerifier{}, nil)

	request := httptest.NewRequest(http.MethodGet, "/v1/prevention/actions", nil)
	request.Header.Set("Authorization", "Bearer valid")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

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

// TestRecoveredPanicPreservesOnlyASafeInboundRequestID pins the propagation
// rule at the boundary: a well-formed forwarded id survives, and anything else
// is replaced instead of echoed.
func TestRecoveredPanicPreservesOnlyASafeInboundRequestID(t *testing.T) {
	valid := uuid.NewString()
	for _, tc := range []struct {
		name    string
		inbound string
		want    string
	}{
		{name: "valid inbound", inbound: valid, want: valid},
		{name: "absent inbound", inbound: "", want: ""},
		{name: "oversize inbound", inbound: strings.Repeat("a", 200), want: ""},
		{name: "control characters inbound", inbound: "abc\r\nX-Injected: 1", want: ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			bh12CaptureLogs(t)
			handler := New(nil, panickingVerifier{}, nil)
			request := httptest.NewRequest(http.MethodGet, "/v1/prevention/actions", nil)
			request.Header.Set("Authorization", "Bearer valid")
			if tc.inbound != "" {
				request.Header.Set("X-Request-ID", tc.inbound)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)

			body := bh12Decode(t, response)
			if tc.want != "" && body.RequestID != tc.want {
				t.Fatalf("request_id=%q, want the preserved inbound %q", body.RequestID, tc.want)
			}
			if tc.want == "" && body.RequestID == tc.inbound {
				t.Fatalf("request_id=%q, want a fresh id instead of the unsafe inbound value", body.RequestID)
			}
			if strings.ContainsAny(body.RequestID, "\r\n") {
				t.Fatalf("request_id=%q carries control characters", body.RequestID)
			}
		})
	}
}

// TestInternalErrorIsTheDocumentedResponse pins the 500 this unit made
// observable against the published contract, so the status, its headers and its
// body cannot drift from what the document declares.
func TestInternalErrorIsTheDocumentedResponse(t *testing.T) {
	contract := loadContract(t)
	bh12CaptureLogs(t)
	handler := New(nil, panickingVerifier{}, nil)

	request := httptest.NewRequest(http.MethodGet, "/v1/prevention/actions", nil)
	request.Header.Set("Authorization", "Bearer valid")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusInternalServerError {
		t.Fatalf("got %d want %d", response.Code, http.StatusInternalServerError)
	}
	assertResponseMatchesContract(t, contract, "/v1/prevention/actions", http.MethodGet, response)
}
