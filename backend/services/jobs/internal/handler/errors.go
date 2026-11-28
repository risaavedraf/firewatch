package handler

import (
	"log/slog"
	"net/http"
	"runtime/debug"

	"github.com/google/uuid"
)

// BH-12 — one error body, one closed taxonomy and one correlation id.
//
// Every failure this service answers goes through writeError, so the caller sees
// the same envelope whatever route or layer decided the status: a stable
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

// errorEnvelope is the one JSON error body of this service. The field order is
// part of the observable bytes, and the names are the ones the contract's
// ErrorResponse declares.
type errorEnvelope struct {
	Code      string        `json:"code"`
	Category  errorCategory `json:"category"`
	Message   string        `json:"message"`
	RequestID string        `json:"request_id"`
}

// correlationID returns the non-empty correlation id of this exchange, minting
// one if no middleware set it. It is what keeps the body's request_id and the
// X-Request-ID header from ever disagreeing.
func correlationID(w http.ResponseWriter) string {
	if id := w.Header().Get("X-Request-ID"); id != "" {
		return id
	}
	id := uuid.NewString()
	w.Header().Set("X-Request-ID", id)
	return id
}

// correlationIDFor is correlationID with the forwarded id as a fallback: a
// boundary that has no response header yet can still echo the id the request
// arrived with, provided that value is a UUID. Anything else — a control
// character, an oversize value, a non-UUID — is not an identity this service
// repeats; a fresh one is minted instead.
func correlationIDFor(w http.ResponseWriter, r *http.Request) string {
	if id := w.Header().Get("X-Request-ID"); id != "" {
		return id
	}
	if id, ok := safeRequestID(r.Header.Get("X-Request-ID")); ok {
		w.Header().Set("X-Request-ID", id)
		return id
	}
	return correlationID(w)
}

// safeRequestID accepts only a value that parses as a UUID and returns its
// canonical form. Parsing is the sanitizer: it rejects control characters,
// oversize values and every non-UUID shape, and canonicalisation makes the
// echoed value one literal.
func safeRequestID(raw string) (string, bool) {
	id, err := uuid.Parse(raw)
	if err != nil {
		return "", false
	}
	return id.String(), true
}

// writeError writes the one error body of this service.
func writeError(w http.ResponseWriter, status int, code string) {
	category := categoryForStatus(status)
	// The correlation id is resolved — and its header written — before respond
	// commits the status: net/http freezes the response headers at the first
	// WriteHeader, so an id minted afterwards would reach the JSON body while
	// being absent from the headers the client actually receives. Resolving it
	// first keeps request_id and X-Request-ID the same observable literal on
	// every path, including the panic boundary where no middleware ran.
	id := correlationID(w)
	respond(w, status, errorEnvelope{
		Code:      code,
		Category:  category,
		Message:   category.message(),
		RequestID: id,
	})
}

// withErrorRecovery is the panic boundary of this service. A panic inside the
// authenticated chain is answered as the generic 500 INTERNAL the contract
// declares, while the recovered value and its stack — where a driver, SQL or
// Go detail actually appears — are written only to the structured log, keyed by
// the request id the caller can quote.
//
// A response already on the wire is left alone: rewriting its status would
// corrupt a body the caller is reading, so only the log records the panic.
func withErrorRecovery(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tracked := &writeTracker{ResponseWriter: w}
		defer func() {
			recovered := recover()
			if recovered == nil {
				return
			}
			id := correlationIDFor(w, r)
			slog.Error("panic_recovered", "request_id", id, "panic", recovered, "stack", string(debug.Stack()))
			if tracked.wrote {
				return
			}
			writeError(w, http.StatusInternalServerError, codeInternalError)
		}()
		next.ServeHTTP(tracked, r)
	})
}

// writeTracker reports whether a response has already started, so a recovered
// panic never writes a second status into a body the caller is reading. Unwrap
// keeps http.ResponseController working through it.
type writeTracker struct {
	http.ResponseWriter
	wrote bool
}

func (t *writeTracker) WriteHeader(status int) {
	t.wrote = true
	t.ResponseWriter.WriteHeader(status)
}

func (t *writeTracker) Write(b []byte) (int, error) {
	t.wrote = true
	return t.ResponseWriter.Write(b)
}

func (t *writeTracker) Unwrap() http.ResponseWriter { return t.ResponseWriter }
