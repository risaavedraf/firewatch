package handler

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"firewatch.local/prevention/internal/repository"
	"github.com/google/uuid"
)

// Body bound and field bound for PM-09. The observation body is a small flat
// document; the description bound is the one the published design states for the
// field (the mock counts characters up to 240), so the server refuses what the
// page already cannot produce instead of storing text the form said it would not.
// Both are server-side limits: the client's own input cap is not a validation.
const (
	maxObservationBody        = 8192
	maxObservationDescription = 240
	// maxAdoptionBody bounds the adoption body. It carries one UUID and nothing
	// else, so a larger document is not a confirmation this service defines.
	maxAdoptionBody = 1024
)

// ObservationType is one member of PM-09's closed observation catalogue. There is
// no free-text type: an unknown value is refused before storage, and the table's
// CHECK refuses it again so a future code path cannot bypass the vocabulary.
type ObservationType string

const (
	ObservationDryVegetation ObservationType = "vegetacion_seca"
	ObservationMicroDump     ObservationType = "microbasural"
	ObservationBurn          ObservationType = "quema"
	ObservationBlockedAccess ObservationType = "acceso_bloqueado"
	ObservationOther         ObservationType = "otro"
)

// observationTypes is the single Go-side copy of the closed catalogue, in the
// documented order. The Spanish labels the page renders are a presentation
// concern: "vegetacion_seca" is "Vegetación seca", "microbasural" is
// "Microbasural", "quema" is "Quema", "acceso_bloqueado" is "Acceso bloqueado"
// and "otro" is "Otro".
var observationTypes = []string{
	string(ObservationDryVegetation),
	string(ObservationMicroDump),
	string(ObservationBurn),
	string(ObservationBlockedAccess),
	string(ObservationOther),
}

// ObservationTypes returns the closed catalogue in its documented order. It is
// exported so the migration guard can compare the SQL CHECK with this list: the
// vocabulary exists twice (Go and SQL) and the only defence against drift is a
// test that reads both.
func ObservationTypes() []string {
	return append([]string(nil), observationTypes...)
}

// ValidObservationType reports whether value is a member of the closed
// catalogue. The comparison is exact: a label with an accent, an upper-case
// spelling or a trailing space is not a member.
func ValidObservationType(value string) bool {
	return slices.Contains(observationTypes, value)
}

// ObservationRepository is the persistence the observation routes need. It is a
// separate interface from Repository on purpose: the frozen action contract must
// not grow methods because PM-09 arrived, and a store that does not implement
// these operations is answered 503 instead of being served an invented empty
// list.
type ObservationRepository interface {
	// ListObservations returns the observations matching the optional closed
	// catalogue type, newest first. An empty type narrows nothing.
	ListObservations(ctx context.Context, observationType string) ([]repository.Observation, error)
	// CreateObservation inserts one observation, resolving the zone against the
	// catalogue in the same statement.
	CreateObservation(ctx context.Context, input repository.NewObservation) (repository.Observation, error)
	// ListZones returns the zone catalogue in display order.
	ListZones(ctx context.Context) ([]repository.Zone, error)
	// AdoptObservation durably confirms that the observation justifies the named
	// existing action and links the two in one row-locked transaction, or refuses
	// with one of the documented errors leaving nothing written.
	AdoptObservation(ctx context.Context, observationID, actionID, confirmedBy string) (repository.ObservationAdoption, error)
}

// registerObservationRoutes mounts the PM-09 routes below the prevention prefix
// the gateway already proxies. Reads stay open to viewer and admin, exactly as
// the action reads do; each write checks the admin role itself, so a viewer gets
// 403 (authorized, not permitted) rather than 401.
func registerObservationRoutes(mux *http.ServeMux, store Repository) {
	observations, ok := store.(ObservationRepository)
	if !ok {
		// Fail closed. A missing persistence implementation is a wiring defect,
		// and answering 404 would read as "this service has no such route" while
		// an empty 200 would claim there are no observations to show.
		slog.Error("observation_store_unavailable", "missing", "ObservationRepository")
		mux.HandleFunc("GET /v1/prevention/observations", observationsUnavailable)
		mux.HandleFunc("POST /v1/prevention/observations", observationsUnavailable)
		mux.HandleFunc("GET /v1/prevention/observations/zones", observationsUnavailable)
		mux.HandleFunc("POST /v1/prevention/observations/{id}/adoption", observationsUnavailable)
		return
	}
	mux.HandleFunc("GET /v1/prevention/observations", listObservations(observations))
	mux.HandleFunc("POST /v1/prevention/observations", createObservation(observations))
	mux.HandleFunc("GET /v1/prevention/observations/zones", listObservationZones(observations))
	// PM-10's one authorized operation: confirmation of need, which links an
	// existing observation to an existing action without assigning or advancing it.
	mux.HandleFunc("POST /v1/prevention/observations/{id}/adoption", adoptObservation(observations))
}

// observationsUnavailable is the documented 503 of a service whose observation
// persistence is not wired. It never pretends the collection is empty.
func observationsUnavailable(w http.ResponseWriter, r *http.Request) {
	slog.Error("observation_store_unavailable", "request_id", r.Header.Get("X-Request-ID"))
	fail(w, http.StatusServiceUnavailable, "storage_unavailable")
}

// listObservations serves GET /v1/prevention/observations. The only query
// parameter is the optional type filter: an omitted or empty one narrows nothing,
// while a repeated parameter, an unknown parameter or a type outside the closed
// catalogue is malformed input and is refused before storage is touched. An
// unknown type would otherwise return an empty list, which reads as "there are no
// observations of that type" instead of "that type does not exist".
func listObservations(store ObservationRepository) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		observationType, ok := observationFilter(r)
		if !ok {
			fail(w, http.StatusUnprocessableEntity, "invalid_query")
			return
		}
		observations, err := store.ListObservations(r.Context(), observationType)
		if err != nil {
			slog.Error("list_observations_failed", "request_id", r.Header.Get("X-Request-ID"))
			fail(w, http.StatusServiceUnavailable, "storage_unavailable")
			return
		}
		// A nil slice would marshal as null, which is not the documented list. An
		// empty result is a valid answer, so it is normalised to [] here.
		if observations == nil {
			observations = []repository.Observation{}
		}
		respond(w, http.StatusOK, observations)
	}
}

// observationFilter validates the list query and returns the type filter.
func observationFilter(r *http.Request) (string, bool) {
	query := r.URL.Query()
	for key := range query {
		if key != "type" {
			return "", false
		}
	}
	if len(query["type"]) > 1 {
		return "", false
	}
	observationType := query.Get("type")
	if observationType != "" && !ValidObservationType(observationType) {
		return "", false
	}
	return observationType, true
}

// observationRequest is the create body. Every field is a pointer so an omitted
// field is distinguishable from a present empty one, and unknown fields are
// refused: a client cannot send the id, the catalogue name or the author. The
// author is the verified subject, never a field.
type observationRequest struct {
	ZoneID      *string `json:"zone_id"`
	Type        *string `json:"type"`
	ObservedOn  *string `json:"observed_on"`
	Description *string `json:"description"`
}

// createObservation serves POST /v1/prevention/observations: admin only.
//
// The zone is checked against the catalogue by the insert itself, so a code the
// catalogue does not hold is the documented 422 zone_not_found with no row
// written. An observation is append-only: there is no update and no delete route,
// and the application role holds neither grant.
func createObservation(store ObservationRepository) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !isAdmin(r.Context()) {
			fail(w, http.StatusForbidden, "forbidden")
			return
		}
		if !jsonContentType(r) {
			fail(w, http.StatusUnsupportedMediaType, "json_required")
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxObservationBody))
		if err != nil {
			fail(w, http.StatusUnprocessableEntity, "invalid_observation_request")
			return
		}
		var request observationRequest
		if !decodeStrict(body, &request) {
			fail(w, http.StatusUnprocessableEntity, "invalid_observation_request")
			return
		}
		input, ok := newObservationFrom(request, subjectOf(r.Context()))
		if !ok {
			fail(w, http.StatusUnprocessableEntity, "invalid_observation_request")
			return
		}
		observation, err := store.CreateObservation(r.Context(), input)
		if errors.Is(err, repository.ErrZoneNotFound) {
			fail(w, http.StatusUnprocessableEntity, "zone_not_found")
			return
		}
		if err != nil {
			slog.Error("create_observation_failed", "request_id", r.Header.Get("X-Request-ID"))
			fail(w, http.StatusServiceUnavailable, "storage_unavailable")
			return
		}
		// Durable audit: the row plus this line, keyed by the verified actor and
		// the request trace, exactly as the action routes record theirs.
		slog.Info("audit",
			"actor_id", observation.CreatedBy,
			"action", "prevention.observation.recorded",
			"observation_id", observation.ID,
			"zone_id", observation.ZoneID,
			"type", observation.Type,
			"trace_id", r.Header.Get("X-Request-ID"),
			"occurred_at", observation.CreatedAt)
		// 201 with the created representation and no Location: PM-09 publishes no
		// observation detail route, so a Location would name a URI this service
		// does not serve.
		respond(w, http.StatusCreated, observation)
	}
}

// newObservationFrom validates the create body. The author is the verified
// subject, which is not read from the body at all. The type must be a member of
// the closed catalogue and observed_on a real calendar date; the description is
// stored as sent, but a blank or over-long one is refused.
func newObservationFrom(request observationRequest, actor string) (repository.NewObservation, bool) {
	if request.ZoneID == nil || strings.TrimSpace(*request.ZoneID) == "" {
		return repository.NewObservation{}, false
	}
	if request.Type == nil || !ValidObservationType(*request.Type) {
		return repository.NewObservation{}, false
	}
	if request.ObservedOn == nil {
		return repository.NewObservation{}, false
	}
	parsed, err := time.Parse("2006-01-02", *request.ObservedOn)
	if err != nil || parsed.Format("2006-01-02") != *request.ObservedOn {
		return repository.NewObservation{}, false
	}
	if request.Description == nil || strings.TrimSpace(*request.Description) == "" {
		return repository.NewObservation{}, false
	}
	if utf8.RuneCountInString(*request.Description) > maxObservationDescription {
		return repository.NewObservation{}, false
	}
	return repository.NewObservation{
		Type:        *request.Type,
		ZoneID:      *request.ZoneID,
		ObservedOn:  *request.ObservedOn,
		Description: *request.Description,
		CreatedBy:   actor,
	}, true
}

// listObservationZones serves GET /v1/prevention/observations/zones: the zone
// options the registration form offers. The list comes from the zone catalogue
// the risk service owns, not from a literal in this service or in the page, so a
// new zone is a catalogue row and never an application allowlist. It includes the
// zones without geometry, which the map layer omits, because a registration form
// must be able to name every zone the catalogue holds.
func listObservationZones(store ObservationRepository) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		zones, err := store.ListZones(r.Context())
		if err != nil {
			slog.Error("list_observation_zones_failed", "request_id", r.Header.Get("X-Request-ID"))
			fail(w, http.StatusServiceUnavailable, "storage_unavailable")
			return
		}
		if zones == nil {
			zones = []repository.Zone{}
		}
		respond(w, http.StatusOK, zones)
	}
}

// adoptionRequest is the adoption body. The action is the only field: the
// confirming actor is the verified subject, the observation is addressed by the
// path, and the body carries no status, assignee, note or date, so a client
// cannot assign the work, move the action or backdate a confirmation.
type adoptionRequest struct {
	ActionID *string `json:"action_id"`
}

// adoptObservation serves POST /v1/prevention/observations/{id}/adoption: admin
// only.
//
// It is the one authorized operation of PM-10's relationship: an operator states
// that the recorded observation justifies the selected existing action, and the
// pair is linked durably. Linking is allowed in propuesta and confined to
// non-cancelled actions; the operation never assigns personnel, never advances the
// action and never reviews evidence. The four distinguishable refusals are kept
// apart: a malformed path is 400, an action the service does not hold is the 422
// reference refusal (the same posture as zone_not_found), and a cancelled action or
// an observation already linked to another action are 409 conflicts because both
// records exist and the rule refuses.
func adoptObservation(store ObservationRepository) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !isAdmin(r.Context()) {
			fail(w, http.StatusForbidden, "forbidden")
			return
		}
		if !jsonContentType(r) {
			fail(w, http.StatusUnsupportedMediaType, "json_required")
			return
		}
		observationID, ok := observationID(r)
		if !ok {
			fail(w, http.StatusBadRequest, "invalid_observation_id")
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxAdoptionBody))
		if err != nil {
			fail(w, http.StatusUnprocessableEntity, "invalid_adoption_request")
			return
		}
		var request adoptionRequest
		if !decodeStrict(body, &request) {
			fail(w, http.StatusUnprocessableEntity, "invalid_adoption_request")
			return
		}
		actionID, ok := adoptionActionID(request)
		if !ok {
			fail(w, http.StatusUnprocessableEntity, "invalid_adoption_request")
			return
		}
		result, err := store.AdoptObservation(r.Context(), observationID, actionID, subjectOf(r.Context()))
		switch {
		case errors.Is(err, repository.ErrObservationNotFound):
			fail(w, http.StatusNotFound, "observation_not_found")
			return
		case errors.Is(err, repository.ErrAdoptionActionNotFound):
			fail(w, http.StatusUnprocessableEntity, "action_not_found")
			return
		case errors.Is(err, repository.ErrAdoptionActionCancelled):
			fail(w, http.StatusConflict, "action_cancelled")
			return
		case errors.Is(err, repository.ErrObservationAlreadyAdopted):
			fail(w, http.StatusConflict, "observation_already_adopted")
			return
		case err != nil:
			slog.Error("adopt_observation_failed", "request_id", r.Header.Get("X-Request-ID"))
			fail(w, http.StatusServiceUnavailable, "storage_unavailable")
			return
		}
		// Durable audit: the link row plus this line, keyed by the actor who owns
		// the durable confirmation. A repeat writes no row, so its line reports the
		// original confirmation with recorded=false instead of claiming a new one.
		slog.Info("audit",
			"actor_id", result.ConfirmedBy,
			"action", "prevention.observation.adopted",
			"observation_id", result.Observation.ID,
			"action_id", result.ActionID,
			"recorded", result.Recorded,
			"trace_id", r.Header.Get("X-Request-ID"),
			"occurred_at", result.ConfirmedAt)
		respond(w, http.StatusOK, result.Observation)
	}
}

// observationID parses the {id} path value of the observation routes as a UUID.
// The path addresses an observation or it is malformed; nothing else addresses
// one, so it is refused before storage is touched.
func observationID(r *http.Request) (string, bool) {
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil || id == uuid.Nil {
		return "", false
	}
	return id.String(), true
}

// adoptionActionID validates the adoption body and returns the canonical action
// id. An omitted, blank or non-UUID value is malformed input: the action must be
// an existing row the service can resolve, not a name or a partial reference.
func adoptionActionID(request adoptionRequest) (string, bool) {
	if request.ActionID == nil || strings.TrimSpace(*request.ActionID) == "" {
		return "", false
	}
	parsed, err := uuid.Parse(*request.ActionID)
	if err != nil || parsed == uuid.Nil {
		return "", false
	}
	return parsed.String(), true
}
