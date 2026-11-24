package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"firewatch.local/prevention/internal/repository"
	"github.com/google/uuid"
)

// The PM-09 observation routes are exercised through the same authenticated chain
// as every other prevention route: the bearer token is minted with the production
// claim policy, the request reaches the handler through New(), and the response is
// validated against the published contract. A hand-built handler call would prove
// the function, not the route.

// fixedObservationID is a valid observation id for path-free tests: the stub store
// never needs a real row for it.
const fixedObservationID = "0b7c9a1f-0d2e-4f5a-9b6c-8d1e2f3a4b5c"

// observationStore stands in for the real store. It embeds matrixStore so the
// frozen action routes keep working through the same handler, and adds the three
// observation operations the handler's ObservationRepository declares. It decides
// nothing: validation belongs to the transport, and the SQL rules belong to the
// repository integration tests.
type observationStore struct {
	*matrixStore

	list      []repository.Observation
	listErr   error
	listCalls int
	lastType  string

	created     repository.Observation
	createErr   error
	createCalls int
	lastInput   repository.NewObservation

	zones      []repository.Zone
	zonesErr   error
	zonesCalls int

	adoption           repository.ObservationAdoption
	adoptionErr        error
	adoptionCalls      int
	lastAdoptionID     string
	lastAdoptionAction string
	lastAdoptionActor  string
}

func (s *observationStore) ListObservations(_ context.Context, observationType string) ([]repository.Observation, error) {
	s.listCalls++
	s.lastType = observationType
	if s.listErr != nil {
		return nil, s.listErr
	}
	return s.list, nil
}

func (s *observationStore) CreateObservation(_ context.Context, input repository.NewObservation) (repository.Observation, error) {
	s.createCalls++
	s.lastInput = input
	if s.createErr != nil {
		return repository.Observation{}, s.createErr
	}
	// Echo the stored fields back exactly as the real store does, so a response
	// assertion proves the transport passed them through instead of proving the
	// fixture.
	created := s.created
	created.Type, created.ZoneID, created.ObservedOn = input.Type, input.ZoneID, input.ObservedOn
	created.Description, created.CreatedBy = input.Description, input.CreatedBy
	return created, nil
}

func (s *observationStore) ListZones(_ context.Context) ([]repository.Zone, error) {
	s.zonesCalls++
	if s.zonesErr != nil {
		return nil, s.zonesErr
	}
	return s.zones, nil
}

// AdoptObservation mirrors the store's shape: it records what the route passed and
// answers the observation in its post-link state. Whether a link is new, repeated
// or refused is the repository's single decision, and that rule is proved against
// the real database rather than by this stub.
func (s *observationStore) AdoptObservation(_ context.Context, observationID, actionID, confirmedBy string) (repository.ObservationAdoption, error) {
	s.adoptionCalls++
	s.lastAdoptionID, s.lastAdoptionAction, s.lastAdoptionActor = observationID, actionID, confirmedBy
	if s.adoptionErr != nil {
		return repository.ObservationAdoption{}, s.adoptionErr
	}
	result := s.adoption
	// The answer is the stored observation, exactly as the real store re-reads it
	// inside the adoption transaction, so a body assertion proves the transport.
	result.Observation = s.created
	result.Observation.ID = observationID
	if result.ActionID == "" {
		result.ActionID = actionID
	}
	if result.ConfirmedBy == "" {
		result.ConfirmedBy = confirmedBy
	}
	linked := result.ActionID
	result.Observation.AdoptedActionID = &linked
	return result, nil
}

// newObservationStore builds a stub whose create answer is the documented wire
// object, so a 201 body can be validated against the contract.
func newObservationStore() *observationStore {
	zone := "Valparaiso (demo)"
	return &observationStore{
		matrixStore: &matrixStore{},
		created: repository.Observation{
			ID:          fixedObservationID,
			Type:        "quema",
			ZoneID:      "valparaiso-demo",
			ZoneName:    &zone,
			ObservedOn:  "2026-11-20",
			Description: "Pastizal seco junto a la escalera de acceso",
			CreatedBy:   "admin-1",
			CreatedAt:   time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC),
		},
	}
}

const observationBody = `{"zone_id":"valparaiso-demo","type":"quema","observed_on":"2026-11-20","description":"Pastizal seco junto a la escalera de acceso"}`

// fixedAdoptionActionID is a valid action id for the adoption route. The stub
// store answers it; no real action row is needed to prove the transport.
const fixedAdoptionActionID = "3f2b1c7d-5e6a-4b8c-9d0e-1a2b3c4d5e6f"

// adoptionBody is the only documented adoption body: one action reference. The
// confirming actor is the verified subject, never a field, and no status is sent.
const adoptionBody = `{"action_id":"` + fixedAdoptionActionID + `"}`

// newAdoptionStore builds a stub whose adoption answer is a fresh confirmation of
// the documented action, so the 200 body can be asserted as the durable link.
func newAdoptionStore() *observationStore {
	store := newObservationStore()
	store.adoption = repository.ObservationAdoption{
		ActionID:    fixedAdoptionActionID,
		ConfirmedBy: "admin-1",
		ConfirmedAt: time.Date(2026, 11, 21, 9, 0, 0, 0, time.UTC),
		Recorded:    true,
	}
	return store
}

// TestObservationRouteAuthorization pins the role boundary of PM-09: reads are
// open to viewer and admin, writes are admin only, and a role this service does
// not accept is refused before the route is reached. A refused write must never
// reach storage.
func TestObservationRouteAuthorization(t *testing.T) {
	for _, tc := range []struct {
		method, target, role string
		body                 string
		want                 int
		wantCreateCalls      int
	}{
		{method: http.MethodGet, target: "/v1/prevention/observations", role: "", want: http.StatusUnauthorized},
		{method: http.MethodGet, target: "/v1/prevention/observations", role: "operator", want: http.StatusForbidden},
		{method: http.MethodGet, target: "/v1/prevention/observations", role: "viewer", want: http.StatusOK},
		{method: http.MethodGet, target: "/v1/prevention/observations", role: "admin", want: http.StatusOK},
		{method: http.MethodPost, target: "/v1/prevention/observations", role: "", body: observationBody, want: http.StatusUnauthorized},
		{method: http.MethodPost, target: "/v1/prevention/observations", role: "operator", body: observationBody, want: http.StatusForbidden},
		{method: http.MethodPost, target: "/v1/prevention/observations", role: "viewer", body: observationBody, want: http.StatusForbidden},
		{method: http.MethodPost, target: "/v1/prevention/observations", role: "admin", body: observationBody, want: http.StatusCreated, wantCreateCalls: 1},
		{method: http.MethodGet, target: "/v1/prevention/observations/zones", role: "", want: http.StatusUnauthorized},
		{method: http.MethodGet, target: "/v1/prevention/observations/zones", role: "operator", want: http.StatusForbidden},
		{method: http.MethodGet, target: "/v1/prevention/observations/zones", role: "viewer", want: http.StatusOK},
		{method: http.MethodGet, target: "/v1/prevention/observations/zones", role: "admin", want: http.StatusOK},
	} {
		name := strings.Join([]string{tc.method, tc.target, tc.role, http.StatusText(tc.want)}, "_")
		t.Run(name, func(t *testing.T) {
			store := newObservationStore()
			h, signer := app(t, store)
			bearer := ""
			if tc.role != "" {
				bearer = token(t, signer, tc.role, "subject-1")
			}
			w := requestWith(t, h, tc.method, tc.target, bearer, tc.body)
			if w.Code != tc.want {
				t.Fatalf("answered %d, want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if store.createCalls != tc.wantCreateCalls {
				t.Fatalf("the write reached storage %d times, want %d", store.createCalls, tc.wantCreateCalls)
			}
		})
	}
}

// TestCreateObservationAcceptsTheWholeClosedCatalogue walks every member of the
// catalogue through the route. The catalogue is closed, so this test also proves
// the accepted set is exactly the documented five and not a superset a broad
// "any non-blank string" check would admit.
func TestCreateObservationAcceptsTheWholeClosedCatalogue(t *testing.T) {
	if got := len(ObservationTypes()); got != 5 {
		t.Fatalf("the closed catalogue has %d members, PM-09 names 5", got)
	}
	for _, observationType := range ObservationTypes() {
		t.Run(observationType, func(t *testing.T) {
			store := newObservationStore()
			store.created.Type = observationType
			h, signer := app(t, store)
			body := strings.Replace(observationBody, `"quema"`, `"`+observationType+`"`, 1)
			w := requestWith(t, h, http.MethodPost, "/v1/prevention/observations",
				token(t, signer, "admin", "admin-1"), body)
			if w.Code != http.StatusCreated {
				t.Fatalf("answered %d, want 201: %s", w.Code, w.Body.String())
			}
			if store.lastInput.Type != observationType {
				t.Errorf("the store received type %q, want %q", store.lastInput.Type, observationType)
			}
			// PM-09 publishes no detail route, so the created representation is the
			// whole answer: a Location here would name a URI the contract does not serve.
			if got := w.Header().Get("Location"); got != "" {
				t.Errorf("Location %q was set, but the contract serves no observation detail route", got)
			}
			var created repository.Observation
			if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
				t.Fatalf("body is not an observation: %v", err)
			}
			if created.Type != observationType {
				t.Errorf("response type %q, want %q", created.Type, observationType)
			}
		})
	}
}

// TestCreateObservationDerivesTheAuthorFromTheVerifiedSubject is the S3 rule: the
// author is the server's verified subject, never a client field. The body carries
// no author at all, and the value that reaches storage is the token's subject.
func TestCreateObservationDerivesTheAuthorFromTheVerifiedSubject(t *testing.T) {
	store := newObservationStore()
	h, signer := app(t, store)
	w := requestWith(t, h, http.MethodPost, "/v1/prevention/observations",
		token(t, signer, "admin", "admin-9"), observationBody)
	if w.Code != http.StatusCreated {
		t.Fatalf("answered %d, want 201: %s", w.Code, w.Body.String())
	}
	if store.lastInput.CreatedBy != "admin-9" {
		t.Errorf("the store received author %q, want the verified subject %q", store.lastInput.CreatedBy, "admin-9")
	}
	var created repository.Observation
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.CreatedBy != "admin-9" {
		t.Errorf("response author %q, want the verified subject %q", created.CreatedBy, "admin-9")
	}
}

// TestCreateObservationRefusesAClientSuppliedAuthor proves the same rule from the
// other side: a body that tries to name the author (or the id, or the catalogue
// name) is not silently narrowed, it is refused and nothing is written.
func TestCreateObservationRefusesAClientSuppliedAuthor(t *testing.T) {
	for name, body := range map[string]string{
		"created_by": `{"zone_id":"valparaiso-demo","type":"quema","observed_on":"2026-11-20","description":"x","created_by":"someone-else"}`,
		"author":     `{"zone_id":"valparaiso-demo","type":"quema","observed_on":"2026-11-20","description":"x","author":"someone-else"}`,
		"id":         `{"zone_id":"valparaiso-demo","type":"quema","observed_on":"2026-11-20","description":"x","id":"6f1e7b0a-2f4f-4a3f-9a5b-1d3c7e9f2a44"}`,
		"zone_name":  `{"zone_id":"valparaiso-demo","type":"quema","observed_on":"2026-11-20","description":"x","zone_name":"Inventada"}`,
	} {
		t.Run(name, func(t *testing.T) {
			store := newObservationStore()
			h, signer := app(t, store)
			w := requestWith(t, h, http.MethodPost, "/v1/prevention/observations",
				token(t, signer, "admin", "admin-1"), body)
			if w.Code != http.StatusUnprocessableEntity {
				t.Fatalf("answered %d, want 422: %s", w.Code, w.Body.String())
			}
			if code := errorBody(t, w)["code"]; code != "invalid_observation_request" {
				t.Errorf("code %q, want invalid_observation_request", code)
			}
			if store.createCalls != 0 {
				t.Fatalf("a client-authored body reached storage %d times", store.createCalls)
			}
		})
	}
}

// TestCreateObservationRefusesAnUnknownTypeWithoutWriting is S2's closed
// catalogue: a value outside the five is refused before storage, so no row is
// added. The design's accented label is deliberately not a wire value.
func TestCreateObservationRefusesAnUnknownTypeWithoutWriting(t *testing.T) {
	for _, observationType := range []string{
		"incendio",
		"vegetación seca",
		"vegetacion seca",
		"vegetacion-seca",
		"QUEMA",
		"quema ",
		"",
	} {
		t.Run(observationType, func(t *testing.T) {
			store := newObservationStore()
			h, signer := app(t, store)
			body := `{"zone_id":"valparaiso-demo","type":"` + observationType + `","observed_on":"2026-11-20","description":"x"}`
			w := requestWith(t, h, http.MethodPost, "/v1/prevention/observations",
				token(t, signer, "admin", "admin-1"), body)
			if w.Code != http.StatusUnprocessableEntity {
				t.Fatalf("answered %d, want 422: %s", w.Code, w.Body.String())
			}
			if code := errorBody(t, w)["code"]; code != "invalid_observation_request" {
				t.Errorf("code %q, want invalid_observation_request", code)
			}
			if store.createCalls != 0 {
				t.Fatalf("an unknown type reached storage %d times", store.createCalls)
			}
		})
	}
}

// TestCreateObservationRejectsInvalidFields covers the documented refusals: every
// one answers 422 (or 415 for a non-JSON body) and writes nothing.
func TestCreateObservationRejectsInvalidFields(t *testing.T) {
	longDescription := strings.Repeat("a", maxObservationDescription+1)
	for _, tc := range []struct {
		name, body, contentType string
		want                    int
	}{
		{name: "missing zone", body: `{"type":"quema","observed_on":"2026-11-20","description":"x"}`, want: http.StatusUnprocessableEntity},
		{name: "blank zone", body: `{"zone_id":"   ","type":"quema","observed_on":"2026-11-20","description":"x"}`, want: http.StatusUnprocessableEntity},
		{name: "missing type", body: `{"zone_id":"valparaiso-demo","observed_on":"2026-11-20","description":"x"}`, want: http.StatusUnprocessableEntity},
		{name: "missing date", body: `{"zone_id":"valparaiso-demo","type":"quema","description":"x"}`, want: http.StatusUnprocessableEntity},
		{name: "instant instead of date", body: `{"zone_id":"valparaiso-demo","type":"quema","observed_on":"2026-11-20T10:00:00Z","description":"x"}`, want: http.StatusUnprocessableEntity},
		{name: "day that does not exist", body: `{"zone_id":"valparaiso-demo","type":"quema","observed_on":"2026-11-31","description":"x"}`, want: http.StatusUnprocessableEntity},
		{name: "another date order", body: `{"zone_id":"valparaiso-demo","type":"quema","observed_on":"20-11-2026","description":"x"}`, want: http.StatusUnprocessableEntity},
		{name: "missing description", body: `{"zone_id":"valparaiso-demo","type":"quema","observed_on":"2026-11-20"}`, want: http.StatusUnprocessableEntity},
		{name: "blank description", body: `{"zone_id":"valparaiso-demo","type":"quema","observed_on":"2026-11-20","description":"   "}`, want: http.StatusUnprocessableEntity},
		{name: "over-long description", body: `{"zone_id":"valparaiso-demo","type":"quema","observed_on":"2026-11-20","description":"` + longDescription + `"}`, want: http.StatusUnprocessableEntity},
		{name: "unknown field", body: `{"zone_id":"valparaiso-demo","type":"quema","observed_on":"2026-11-20","description":"x","severity":"alta"}`, want: http.StatusUnprocessableEntity},
		{name: "trailing document", body: observationBody + observationBody, want: http.StatusUnprocessableEntity},
		{name: "not json", body: `zone_id=valparaiso-demo`, want: http.StatusUnprocessableEntity},
		{name: "wrong content type", body: observationBody, contentType: "text/plain", want: http.StatusUnsupportedMediaType},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := newObservationStore()
			h, signer := app(t, store)
			contentType := tc.contentType
			if contentType == "" {
				contentType = "application/json"
			}
			w := requestWithContentType(t, h, http.MethodPost, "/v1/prevention/observations",
				token(t, signer, "admin", "admin-1"), tc.body, contentType)
			if w.Code != tc.want {
				t.Fatalf("answered %d, want %d: %s", w.Code, tc.want, w.Body.String())
			}
			errorBody(t, w)
			if store.createCalls != 0 {
				t.Fatalf("an invalid body reached storage %d times", store.createCalls)
			}
		})
	}
}

// TestCreateObservationMapsAZoneRefusalAndAStorageFailure keeps the two outcomes
// distinct: a zone code the catalogue does not hold is a documented 422 on the
// client's input, while an unavailable store is a 503 that never claims the zone
// was invalid.
func TestCreateObservationMapsAZoneRefusalAndAStorageFailure(t *testing.T) {
	for _, tc := range []struct {
		name     string
		err      error
		want     int
		wantCode string
	}{
		{name: "zone not in the catalogue", err: repository.ErrZoneNotFound, want: http.StatusUnprocessableEntity, wantCode: "zone_not_found"},
		{name: "storage unavailable", err: errors.New("connection refused"), want: http.StatusServiceUnavailable, wantCode: "storage_unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := newObservationStore()
			store.createErr = tc.err
			h, signer := app(t, store)
			w := requestWith(t, h, http.MethodPost, "/v1/prevention/observations",
				token(t, signer, "admin", "admin-1"), observationBody)
			if w.Code != tc.want {
				t.Fatalf("answered %d, want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if code := errorBody(t, w)["code"]; code != tc.wantCode {
				t.Errorf("code %q, want %q", code, tc.wantCode)
			}
		})
	}
}

// TestListObservationsAppliesTheTypeFilterAndAnswersEmptyList pins the read
// contract: an omitted filter narrows nothing, a known type reaches storage, and
// an empty result is the documented [] rather than null.
func TestListObservationsAppliesTheTypeFilterAndAnswersEmptyList(t *testing.T) {
	t.Run("filter", func(t *testing.T) {
		store := newObservationStore()
		store.list = []repository.Observation{store.created}
		h, signer := app(t, store)
		w := requestWith(t, h, http.MethodGet, "/v1/prevention/observations?type=quema",
			token(t, signer, "viewer", "viewer-1"), "")
		if w.Code != http.StatusOK {
			t.Fatalf("answered %d, want 200: %s", w.Code, w.Body.String())
		}
		if store.lastType != "quema" {
			t.Errorf("the store received filter %q, want %q", store.lastType, "quema")
		}
		var listed []repository.Observation
		if err := json.Unmarshal(w.Body.Bytes(), &listed); err != nil {
			t.Fatalf("body is not a list: %v", err)
		}
		if len(listed) != 1 || listed[0].ID != fixedObservationID {
			t.Errorf("listed %+v, want the one stored observation", listed)
		}
	})

	t.Run("omitted filter narrows nothing", func(t *testing.T) {
		store := newObservationStore()
		h, signer := app(t, store)
		w := requestWith(t, h, http.MethodGet, "/v1/prevention/observations?type=",
			token(t, signer, "viewer", "viewer-1"), "")
		if w.Code != http.StatusOK {
			t.Fatalf("an empty filter answered %d, want 200: %s", w.Code, w.Body.String())
		}
		if store.lastType != "" {
			t.Errorf("an empty filter reached storage as %q, want the empty string", store.lastType)
		}
	})

	t.Run("empty list is []", func(t *testing.T) {
		store := newObservationStore()
		h, signer := app(t, store)
		w := requestWith(t, h, http.MethodGet, "/v1/prevention/observations",
			token(t, signer, "viewer", "viewer-1"), "")
		if w.Code != http.StatusOK {
			t.Fatalf("answered %d, want 200: %s", w.Code, w.Body.String())
		}
		if got := strings.TrimSpace(w.Body.String()); got != "[]" {
			t.Errorf("empty result is %q, want the documented []", got)
		}
	})

	t.Run("storage failure", func(t *testing.T) {
		store := newObservationStore()
		store.listErr = errors.New("connection refused")
		h, signer := app(t, store)
		w := requestWith(t, h, http.MethodGet, "/v1/prevention/observations",
			token(t, signer, "viewer", "viewer-1"), "")
		if w.Code != http.StatusServiceUnavailable {
			t.Fatalf("answered %d, want 503: %s", w.Code, w.Body.String())
		}
		if code := errorBody(t, w)["code"]; code != "storage_unavailable" {
			t.Errorf("code %q, want storage_unavailable", code)
		}
	})
}

// TestListObservationsRejectsAnInvalidQuery pins the same rule the action list
// applies: a repeated parameter, an unknown parameter, or a type outside the
// closed catalogue is malformed input (422), not an empty answer that reads as
// "no such observations".
func TestListObservationsRejectsAnInvalidQuery(t *testing.T) {
	for _, target := range []string{
		"/v1/prevention/observations?type=incendio",
		"/v1/prevention/observations?type=QUEMA",
		"/v1/prevention/observations?type=quema&type=otro",
		"/v1/prevention/observations?status=quema",
		"/v1/prevention/observations?zone_id=valparaiso-demo",
	} {
		t.Run(target, func(t *testing.T) {
			store := newObservationStore()
			h, signer := app(t, store)
			w := requestWith(t, h, http.MethodGet, target, token(t, signer, "viewer", "viewer-1"), "")
			if w.Code != http.StatusUnprocessableEntity {
				t.Fatalf("answered %d, want 422: %s", w.Code, w.Body.String())
			}
			if code := errorBody(t, w)["code"]; code != "invalid_query" {
				t.Errorf("code %q, want invalid_query", code)
			}
			if store.listCalls != 0 {
				t.Fatalf("an invalid query reached storage %d times", store.listCalls)
			}
		})
	}
}

// TestListObservationZonesServesTheCatalogue proves the zone options come from
// the service's catalogue read rather than a hard-coded list, and that an empty
// catalogue is [] instead of null.
func TestListObservationZonesServesTheCatalogue(t *testing.T) {
	province := "Valparaiso"
	t.Run("catalogue", func(t *testing.T) {
		store := newObservationStore()
		store.zones = []repository.Zone{{Code: "valparaiso-demo", Name: "Valparaiso (demo)", Province: &province}}
		h, signer := app(t, store)
		w := requestWith(t, h, http.MethodGet, "/v1/prevention/observations/zones",
			token(t, signer, "viewer", "viewer-1"), "")
		if w.Code != http.StatusOK {
			t.Fatalf("answered %d, want 200: %s", w.Code, w.Body.String())
		}
		var zones []repository.Zone
		if err := json.Unmarshal(w.Body.Bytes(), &zones); err != nil {
			t.Fatalf("body is not a zone list: %v", err)
		}
		if len(zones) != 1 || zones[0].Code != "valparaiso-demo" {
			t.Errorf("zones %+v, want the one catalogue row", zones)
		}
	})

	t.Run("empty catalogue is []", func(t *testing.T) {
		store := newObservationStore()
		h, signer := app(t, store)
		w := requestWith(t, h, http.MethodGet, "/v1/prevention/observations/zones",
			token(t, signer, "viewer", "viewer-1"), "")
		if got := strings.TrimSpace(w.Body.String()); w.Code != http.StatusOK || got != "[]" {
			t.Fatalf("answered %d with %q, want 200 and the documented []", w.Code, got)
		}
	})

	t.Run("storage failure", func(t *testing.T) {
		store := newObservationStore()
		store.zonesErr = errors.New("connection refused")
		h, signer := app(t, store)
		w := requestWith(t, h, http.MethodGet, "/v1/prevention/observations/zones",
			token(t, signer, "viewer", "viewer-1"), "")
		if w.Code != http.StatusServiceUnavailable {
			t.Fatalf("answered %d, want 503: %s", w.Code, w.Body.String())
		}
	})
}

// TestObservationRoutesFailClosedWithoutObservationPersistence is the wiring
// guard: a store that does not implement the observation operations must answer
// 503 storage_unavailable, never 404 (which would read as "no such route") and
// never 200 with an invented empty list.
func TestObservationRoutesFailClosedWithoutObservationPersistence(t *testing.T) {
	h, signer := app(t, &matrixStore{})
	for _, tc := range []struct{ method, target, body string }{
		{method: http.MethodGet, target: "/v1/prevention/observations"},
		{method: http.MethodPost, target: "/v1/prevention/observations", body: observationBody},
		{method: http.MethodGet, target: "/v1/prevention/observations/zones"},
	} {
		t.Run(tc.method+"_"+tc.target, func(t *testing.T) {
			w := requestWith(t, h, tc.method, tc.target, token(t, signer, "admin", "admin-1"), tc.body)
			if w.Code != http.StatusServiceUnavailable {
				t.Fatalf("answered %d, want 503: %s", w.Code, w.Body.String())
			}
			if code := errorBody(t, w)["code"]; code != "storage_unavailable" {
				t.Errorf("code %q, want storage_unavailable", code)
			}
		})
	}
}

// TestObservationContractResponses validates the real answers of the three routes
// against the published contract, so the wire shape cannot drift from the
// document the frontend integrates with.
func TestObservationContractResponses(t *testing.T) {
	contract := loadContract(t)
	province := "Valparaiso"

	cases := []struct {
		name    string
		method  string
		target  string
		role    string
		body    string
		prepare func(store *observationStore)
	}{
		{name: "list", method: http.MethodGet, target: "/v1/prevention/observations", role: "viewer",
			prepare: func(store *observationStore) { store.list = []repository.Observation{store.created} }},
		{name: "list empty", method: http.MethodGet, target: "/v1/prevention/observations", role: "admin"},
		{name: "zones", method: http.MethodGet, target: "/v1/prevention/observations/zones", role: "viewer",
			prepare: func(store *observationStore) {
				store.zones = []repository.Zone{{Code: "valparaiso-demo", Name: "Valparaiso (demo)", Province: &province}}
			}},
		{name: "create", method: http.MethodPost, target: "/v1/prevention/observations", role: "admin", body: observationBody},
		{name: "forbidden write", method: http.MethodPost, target: "/v1/prevention/observations", role: "viewer", body: observationBody},
		{name: "invalid create", method: http.MethodPost, target: "/v1/prevention/observations", role: "admin",
			body: `{"zone_id":"valparaiso-demo","type":"incendio","observed_on":"2026-11-20","description":"x"}`},
		{name: "unknown zone", method: http.MethodPost, target: "/v1/prevention/observations", role: "admin", body: observationBody,
			prepare: func(store *observationStore) { store.createErr = repository.ErrZoneNotFound }},
		{name: "storage unavailable", method: http.MethodPost, target: "/v1/prevention/observations", role: "admin", body: observationBody,
			prepare: func(store *observationStore) { store.createErr = errors.New("connection refused") }},
		{name: "invalid query", method: http.MethodGet, target: "/v1/prevention/observations?type=incendio", role: "viewer"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := newObservationStore()
			if tc.prepare != nil {
				tc.prepare(store)
			}
			h, signer := app(t, store)
			w := requestWith(t, h, tc.method, tc.target, token(t, signer, tc.role, "subject-1"), tc.body)
			assertResponseMatchesContract(t, contract, strings.Split(tc.target, "?")[0], tc.method, w)
		})
	}
}

// requestWithContentType is requestWith with an explicit Content-Type, so the
// documented 415 of a non-JSON body can be exercised without changing the shared
// helper the other handler tests use.
func requestWithContentType(t *testing.T, h http.Handler, method, target, bearer, body, contentType string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, target, strings.NewReader(body))
	r.Header.Set("X-Request-ID", uuid.NewString())
	r.Header.Set("Authorization", "Bearer "+bearer)
	r.Header.Set("Content-Type", contentType)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

// TestAdoptionRouteAuthorization pins the role boundary of PM-10's adoption
// operation: it is a write, so it stays admin only, while the observation reads
// keep the PM-09 viewer/admin posture. A refused write must never reach storage.
func TestAdoptionRouteAuthorization(t *testing.T) {
	target := "/v1/prevention/observations/" + fixedObservationID + "/adoption"
	for _, tc := range []struct {
		role      string
		want      int
		wantCalls int
	}{
		{role: "", want: http.StatusUnauthorized},
		{role: "operator", want: http.StatusForbidden},
		{role: "viewer", want: http.StatusForbidden},
		{role: "admin", want: http.StatusOK, wantCalls: 1},
	} {
		name := "adoption_" + tc.role
		t.Run(name, func(t *testing.T) {
			store := newAdoptionStore()
			h, signer := app(t, store)
			bearer := ""
			if tc.role != "" {
				bearer = token(t, signer, tc.role, "admin-1")
			}
			w := requestWith(t, h, http.MethodPost, target, bearer, adoptionBody)
			if w.Code != tc.want {
				t.Fatalf("answered %d, want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if store.adoptionCalls != tc.wantCalls {
				t.Fatalf("the write reached storage %d times, want %d", store.adoptionCalls, tc.wantCalls)
			}
		})
	}
}

// TestAdoptObservationConfirmsTheNeedAndEchoesTheDurableLink is S4's timing rule
// at the transport: one authorized operation confirms that the observation
// justifies an existing action, and the answer is the observation in its
// post-link state. Nothing here assigns personnel or moves the action: the body
// carries no status, assignee or note, so those cannot be sent at all.
func TestAdoptObservationConfirmsTheNeedAndEchoesTheDurableLink(t *testing.T) {
	store := newAdoptionStore()
	h, signer := app(t, store)
	w := requestWith(t, h, http.MethodPost, "/v1/prevention/observations/"+fixedObservationID+"/adoption",
		token(t, signer, "admin", "encargado-7"), adoptionBody)
	if w.Code != http.StatusOK {
		t.Fatalf("answered %d, want 200: %s", w.Code, w.Body.String())
	}
	if store.lastAdoptionID != fixedObservationID {
		t.Errorf("the store received observation %q, want the path id %q", store.lastAdoptionID, fixedObservationID)
	}
	if store.lastAdoptionAction != fixedAdoptionActionID {
		t.Errorf("the store received action %q, want %q", store.lastAdoptionAction, fixedAdoptionActionID)
	}
	if store.lastAdoptionActor != "encargado-7" {
		t.Errorf("the store received confirmer %q, want the verified subject %q", store.lastAdoptionActor, "encargado-7")
	}
	var adopted repository.Observation
	if err := json.Unmarshal(w.Body.Bytes(), &adopted); err != nil {
		t.Fatalf("body is not an observation: %v", err)
	}
	if adopted.AdoptedActionID == nil || *adopted.AdoptedActionID != fixedAdoptionActionID {
		t.Errorf("adopted_action_id is %v, want %q", adopted.AdoptedActionID, fixedAdoptionActionID)
	}
	if adopted.ID != fixedObservationID || adopted.CreatedBy != "admin-1" {
		t.Errorf("the answer is not the stored observation: %+v", adopted)
	}
	if got := w.Header().Get("Location"); got != "" {
		t.Errorf("Location %q was set; the answer is the observation representation", got)
	}
}

// TestAdoptObservationRepeatsTheDurableLinkWithoutRewritingIt proves the
// idempotent half of the link rule on the wire: a repeat of the identical link is
// a 200 that reports the link already stored, and the answer keeps the original
// observation author rather than attributing the observation to the repeater.
// The repository reports that no row was written; the transport must not turn
// that into an error or a second confirmation.
func TestAdoptObservationRepeatsTheDurableLinkWithoutRewritingIt(t *testing.T) {
	store := newAdoptionStore()
	store.adoption.Recorded = false
	store.adoption.ConfirmedBy = "admin-1"
	store.adoption.ConfirmedAt = time.Date(2026, 11, 20, 18, 30, 0, 0, time.UTC)
	h, signer := app(t, store)
	w := requestWith(t, h, http.MethodPost, "/v1/prevention/observations/"+fixedObservationID+"/adoption",
		token(t, signer, "admin", "encargado-7"), adoptionBody)
	if w.Code != http.StatusOK {
		t.Fatalf("a repeated identical link answered %d, want 200: %s", w.Code, w.Body.String())
	}
	var adopted repository.Observation
	if err := json.Unmarshal(w.Body.Bytes(), &adopted); err != nil {
		t.Fatal(err)
	}
	if adopted.AdoptedActionID == nil || *adopted.AdoptedActionID != fixedAdoptionActionID {
		t.Errorf("a repeated link lost the durable association: %v", adopted.AdoptedActionID)
	}
	if adopted.CreatedBy != "admin-1" {
		t.Errorf("observation author became %q; the repeater must not be attributed as its author", adopted.CreatedBy)
	}
}
