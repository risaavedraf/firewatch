package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"firewatch.local/risk/internal/cycle"
)

// CycleRunner is the handler's view of the 15 minute cycle: it can report the
// freshness of the active source and run one cycle synchronously because a
// verified operator asked for it. Keeping it an interface means the routes are
// testable without a scheduler and the SQL stays out of the transport.
//
// The runner's automatic tick is deliberately absent from this view: a request can
// only reach the manual entry point, so no route can start a run that records no
// operator while answering as if one asked.
type CycleRunner interface {
	// RunManual runs one full cycle for a verified operator. actor is the token
	// subject Authorize proved, never a field of the request.
	RunManual(ctx context.Context, actor string) cycle.RunResult
	Statuses() []cycle.SourceStatus
}

// cycleRunBodySize bounds the body this route inspects. The route declares no body
// at all, so anything longer than this is already a malformed request.
const cycleRunBodySize = 4 << 10

// cycleRun serves POST /v1/risk/cycle/run. It is wrapped in requireAdmin by the
// router. The run is synchronous so the demo shows its result immediately; with
// no runner configured the route fails clearly instead of panicking.
//
// The operator who triggered the evaluation is the verified token subject
// Authorize placed on the request context, never anything the caller sends. This
// route therefore declares no body, and a body that names an actor or a trigger is
// REFUSED instead of ignored: silently accepting `{"actor":"someone-else"}` would
// look like it was honoured, and the recorded actor must never be a value the
// client could pick. A request that arrives without a verified subject fails closed
// before the cycle starts, so no evaluation can be persisted without the identity
// that authorised it.
func cycleRun(runner CycleRunner) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// The identity is checked first: a manual evaluation that cannot name its
		// operator has no honest row to write, so it must not start.
		subject, ok := subjectFrom(r.Context())
		if !ok {
			fail(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		if runner == nil {
			fail(w, http.StatusServiceUnavailable, "cycle_unavailable")
			return
		}
		if err := rejectCycleRunBody(r); err != nil {
			fail(w, http.StatusBadRequest, "invalid_body")
			return
		}
		respond(w, http.StatusOK, runner.RunManual(r.Context(), subject))
	}
}

// rejectCycleRunBody accepts exactly the bodies this route declares - none, a
// whitespace-only body, and the empty object `{}` - and refuses everything else.
//
// The manual trigger takes its actor from the verified token, so every other body is
// a body the server would have to ignore, and an ignored actor field is exactly the
// confusion this route refuses to create. A JSON `null`, array, string, number or
// boolean is refused too instead of being coerced into "no body": the only
// documented body is one empty object, and letting a different value stand in for it
// makes the accepted set depend on encoding subtleties rather than on the contract.
func rejectCycleRunBody(r *http.Request) error {
	body, err := readCycleRunBody(r)
	if err != nil {
		return err
	}
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return nil
	}
	if trimmed[0] != '{' {
		return errors.New("the manual trigger declares no body")
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.DisallowUnknownFields()
	var decoded struct{}
	if err := decoder.Decode(&decoded); err != nil {
		return err
	}
	// A second JSON value in the same body is not the documented empty object either.
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return errors.New("the manual trigger declares no body")
	}
	return nil
}

// readCycleRunBody reads at most one byte past the bound, so a body that reaches the
// bound is refused instead of truncated. Truncation is the subtle failure this
// guards: a reader that stops exactly at the cap hands the decoder only the prefix,
// a whitespace prefix followed by `{"actor":...}` then looks like an empty body, and
// the forged field would never be examined. Reading cap+1 makes the overflow
// observable, and the bounded reader keeps a large payload from becoming an
// unbounded read.
func readCycleRunBody(r *http.Request) ([]byte, error) {
	if r.Body == nil || r.Body == http.NoBody {
		return nil, nil
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, cycleRunBodySize+1))
	if err != nil {
		return nil, err
	}
	if len(body) > cycleRunBodySize {
		return nil, errors.New("the manual trigger declares no body")
	}
	return body, nil
}
