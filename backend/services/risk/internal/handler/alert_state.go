package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"time"

	"firewatch.local/risk/internal/repository"
	"github.com/google/uuid"
)

// maxAlertStateBody bounds the mark document. The document has one short member,
// so the cap is the smallest value that fits every valid spelling of the two
// accepted states: a body that needs more than this is not this resource's
// request, and refusing it before storage keeps the input surface exact.
const maxAlertStateBody = 512

// alertStateWire is the personal state document. It has three members and no
// actor: the subject is the verified token the request was already scoped by, so
// repeating it would expose an identity the caller did not ask for. marked_at is
// null exactly when state is unread, because unread is the absence of a mark.
type alertStateWire struct {
	AlertID  string     `json:"alert_id"`
	State    string     `json:"state"`
	MarkedAt *time.Time `json:"marked_at"`
}

// newAlertStateWire maps one stored state to the frozen wire. The instant is
// canonicalised to UTC so the same mark is served in one form across hosts.
func newAlertStateWire(state repository.AlertState) alertStateWire {
	wire := alertStateWire{AlertID: state.AlertID, State: state.State}
	if state.MarkedAt != nil {
		instant := state.MarkedAt.UTC()
		wire.MarkedAt = &instant
	}
	return wire
}

// alertStatePathID reads the alert identifier from the path and accepts only its
// canonical uuid spelling. A non-canonical spelling (upper case, braces, no dashes)
// names no stored alert, so it is the same 404 as a missing row - but it is refused
// before storage, which keeps the path parameter bounded and prevents a database
// cast error from becoming a 500.
func alertStatePathID(r *http.Request) (string, bool) {
	raw := r.PathValue("id")
	parsed, err := uuid.Parse(raw)
	if err != nil || parsed.String() != raw {
		return "", false
	}
	return parsed.String(), true
}

// alertStateSubject resolves the personal scope from the verified request.
//
// Authorize already proved the token and stored its subject, so a missing subject
// here is a composition defect rather than an anonymous caller. It is still
// refused 401 instead of being defaulted: an empty subject key would be one shared
// state every caller could read.
func alertStateSubject(w http.ResponseWriter, r *http.Request) (string, bool) {
	subject, ok := subjectFrom(r.Context())
	if !ok {
		fail(w, http.StatusUnauthorized, "unauthorized")
		return "", false
	}
	return repository.AlertStateSubjectKey(subject), true
}

// alertStateRead serves GET /v1/risk/alerts/{id}/state: the caller's own mark on
// one stored alert. A viewer and an admin both read, and each sees only their own
// state. An alert with no mark is unread with no instant; an alert that is not
// stored is 404; a storage failure is the shared 503.
func alertStateRead(store Repository) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		alertID, ok := alertStatePathID(r)
		if !ok {
			fail(w, http.StatusNotFound, "alert_not_found")
			return
		}
		subjectKey, ok := alertStateSubject(w, r)
		if !ok {
			return
		}
		state, err := store.ReadAlertState(r.Context(), alertID, subjectKey)
		switch {
		case errors.Is(err, repository.ErrAlertNotFound):
			fail(w, http.StatusNotFound, "alert_not_found")
		case err != nil:
			fail(w, http.StatusServiceUnavailable, "storage_unavailable")
		default:
			respond(w, http.StatusOK, newAlertStateWire(state))
		}
	}
}

// alertStateMark serves PUT /v1/risk/alerts/{id}/state. It is wrapped in
// requireAdmin by the router, so reaching it already means the caller holds the
// admin role; the mark is still applied only to the caller's own state, because
// the subject comes from the verified token and the body cannot name anyone.
//
// The answer is the state that is actually stored. A mark that advances the state
// is appended and answered; a replay of the effective mark, or a read after a
// dismissal, is a no-op that answers the current state with its original instant.
// Both are 200: the caller asked for a state and that state holds, so there is no
// conflict to report. A body that is empty, malformed, oversized or names a state
// outside the closed vocabulary never reaches storage and is refused 400; a
// non-JSON declaration is refused 415.
func alertStateMark(store Repository) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		alertID, ok := alertStatePathID(r)
		if !ok {
			fail(w, http.StatusNotFound, "alert_not_found")
			return
		}
		subjectKey, ok := alertStateSubject(w, r)
		if !ok {
			return
		}
		mark, ok := decodeAlertMark(w, r)
		if !ok {
			return
		}
		state, err := store.MarkAlertState(r.Context(), alertID, subjectKey, mark)
		switch {
		case errors.Is(err, repository.ErrAlertNotFound):
			fail(w, http.StatusNotFound, "alert_not_found")
		case errors.Is(err, repository.ErrUnknownAlertMark):
			fail(w, http.StatusBadRequest, "invalid_alert_state")
		case err != nil:
			fail(w, http.StatusServiceUnavailable, "storage_unavailable")
		default:
			respond(w, http.StatusOK, newAlertStateWire(state))
		}
	}
}

// decodeAlertMark reads exactly one JSON document with exactly one member, the
// state. Unknown members are refused, which is what makes a request-supplied actor
// impossible: there is no field for one, and the decoder refuses to ignore it.
// A second document, an empty body, an oversized body or a value outside the two
// accepted literals is refused with the same 400 code, so every malformed shape
// reaches storage as nothing.
func decodeAlertMark(w http.ResponseWriter, r *http.Request) (repository.AlertMark, bool) {
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		fail(w, http.StatusUnsupportedMediaType, "json_required")
		return "", false
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxAlertStateBody))
	if err != nil {
		fail(w, http.StatusBadRequest, "invalid_alert_state")
		return "", false
	}
	mark, valid := parseAlertMark(body)
	if !valid {
		fail(w, http.StatusBadRequest, "invalid_alert_state")
		return "", false
	}
	return mark, true
}

func parseAlertMark(body []byte) (repository.AlertMark, bool) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	if start, err := decoder.Token(); err != nil || start != json.Delim('{') {
		return "", false
	}
	if key, err := decoder.Token(); err != nil || key != "state" {
		return "", false
	}
	var mark repository.AlertMark
	if decoder.Decode(&mark) != nil || !mark.Valid() {
		return "", false
	}
	if end, err := decoder.Token(); err != nil || end != json.Delim('}') {
		return "", false
	}
	return mark, decoder.Decode(new(json.RawMessage)) == io.EOF
}
