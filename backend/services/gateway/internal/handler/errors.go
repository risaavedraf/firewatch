package handler

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"runtime/debug"
)

// BH-12 — one error body, one closed taxonomy and one correlation id.
//
// Every failure this gateway answers goes through failure, so the caller sees
// the same envelope whatever layer decided the status: a stable
// machine-readable code, the closed error category that decided the status, a
// safe human-readable message, and the correlation id the response header
// carries. The category mapping lives here, once, instead of being restated at
// each call site where the two could drift apart.

// errorCategory is the closed taxonomy every service in this repository
// reports. The set is deliberately small and total: a failure is a request
// rejection, an identity problem, a missing resource, a conflict, a rate limit,
// an unavailable dependency or an internal defect, and nothing else.
type errorCategory string

const (
	categoryValidation          errorCategory = "VALIDATION"
	categoryUnauthorized        errorCategory = "UNAUTHORIZED"
	categoryForbidden           errorCategory = "FORBIDDEN"
	categoryNotFound            errorCategory = "NOT_FOUND"
	categoryConflict            errorCategory = "CONFLICT"
	categoryRateLimited         errorCategory = "RATE_LIMITED"
	categoryUpstreamUnavailable errorCategory = "UPSTREAM_UNAVAILABLE"
	categoryInternal            errorCategory = "INTERNAL"
)

// codeInternalError is the code of the one status no handler chooses: a failure
// that escaped its own error path. It is a constant because every service and
// the contract describe the same literal.
const codeInternalError = "internal_error"

// categoryForStatus maps one HTTP status to its category, deterministically and
// totally.
//
// The enumerated cases are the ones the unit's activation names. The two
// defaults exist so the mapping is a function, not a table with holes: an
// unlisted client error is still a rejected request (413 and 415 are refused
// bodies, not internal defects), and every other status — an unlisted 5xx or a
// non-error status that reached an error writer — is internal. Two services can
// therefore never classify the same status differently.
func categoryForStatus(status int) errorCategory {
	switch status {
	case http.StatusBadRequest,
		http.StatusRequestEntityTooLarge,
		http.StatusUnsupportedMediaType,
		http.StatusUnprocessableEntity:
		return categoryValidation
	case http.StatusUnauthorized:
		return categoryUnauthorized
	case http.StatusForbidden:
		return categoryForbidden
	case http.StatusNotFound:
		return categoryNotFound
	case http.StatusConflict:
		return categoryConflict
	case http.StatusTooManyRequests:
		return categoryRateLimited
	case http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return categoryUpstreamUnavailable
	}
	if status >= 400 && status < 500 {
		return categoryValidation
	}
	return categoryInternal
}

// message is the only client-facing text a category carries. It is derived from
// the category and never from the underlying error, so an internal failure can
// only ever say so: the cause is recorded in the structured log under the same
// request id instead of being handed to the caller.
func (c errorCategory) message() string {
	switch c {
	case categoryValidation:
		return "request rejected"
	case categoryUnauthorized:
		return "authentication required"
	case categoryForbidden:
		return "not permitted"
	case categoryNotFound:
		return "resource not found"
	case categoryConflict:
		return "request conflicts with current state"
	case categoryRateLimited:
		return "too many requests"
	case categoryUpstreamUnavailable:
		return "upstream service unavailable"
	default:
		return "internal error"
	}
}

// errorEnvelope is the one JSON error body of this gateway. The field order is
// part of the observable bytes, and the names are the ones the contract's
// ErrorResponse declares.
type errorEnvelope struct {
	Code      string        `json:"code"`
	Category  errorCategory `json:"category"`
	Message   string        `json:"message"`
	RequestID string        `json:"request_id"`
}

// newCorrelationID mints the canonical lower-case dashed UUID this gateway
// stamps on a request. It is formatted here because this module has no uuid
// dependency and this boundary does not add one.
func newCorrelationID() string {
	b := randomID()
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// correlationID returns the non-empty correlation id of this exchange, minting
// one if no middleware set it. It is what keeps the body's request_id and the
// X-Request-ID header from ever disagreeing.
func correlationID(w http.ResponseWriter) string {
	if id := w.Header().Get("X-Request-ID"); id != "" {
		return id
	}
	id := newCorrelationID()
	w.Header().Set("X-Request-ID", id)
	return id
}

// writeError writes the one error body of this gateway.
//
// The correlation id is resolved — and its header written — before the status is
// committed: net/http freezes the response headers at the first WriteHeader, so
// an id minted afterwards would reach the JSON body while being absent from the
// headers the client actually receives. Resolving it first keeps the body's
// request_id and X-Request-ID the same observable literal even on the panic
// path, where no middleware has stamped the response yet.
func writeError(w http.ResponseWriter, status int, code string) {
	category := categoryForStatus(status)
	id := correlationID(w)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(errorEnvelope{
		Code:      code,
		Category:  category,
		Message:   category.message(),
		RequestID: id,
	})
}

// recoverPanic is the panic boundary of this gateway, called from the deferred
// function of the request chain once the correlation id and the status recorder
// exist. A panic is answered as the generic 500 INTERNAL the contract declares,
// while the recovered value and its stack — where a driver, SQL or Go detail
// actually appears — are written only to the structured log, keyed by the
// request id the caller can quote.
//
// The metrics defer runs after this one and reads the recorded status, so the
// recovered request is counted as the 500 it became. A response already on the
// wire is left alone: rewriting its status would corrupt a body the caller is
// reading, so only the log records the panic.
func recoverPanic(w http.ResponseWriter, id string, observed *statusRecorder) {
	recovered := recover()
	if recovered == nil {
		return
	}
	slog.Error("panic_recovered", "request_id", id, "panic", recovered, "stack", string(debug.Stack()))
	if observed.status != 0 {
		return
	}
	writeError(w, http.StatusInternalServerError, codeInternalError)
}
