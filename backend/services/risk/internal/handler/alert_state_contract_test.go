package handler

import (
	"errors"
	"net/http"
	"testing"
	"time"

	"firewatch.local/risk/internal/repository"
)

// TestRiskContractAlertStateMatchesTheContract validates the two real responses
// of the personal state resource against the published document: the unread and
// marked bodies of the read, the accepted and no-op bodies of the write, and each
// refusal that has its own code. The resource is personal, so the actor is only
// ever the verified token subject; no body here carries it.
func TestRiskContractAlertStateMatchesTheContract(t *testing.T) {
	contract := loadContract(t)
	const alertID = "8f14e45f-ceea-467a-9c3f-1d2b4c1b0a11"
	const target = "/v1/risk/alerts/" + alertID + "/state"
	const subject = "contrato@example.test"
	markedAt := time.Date(2026, time.October, 2, 9, 30, 0, 0, time.UTC)
	key := repository.AlertStateSubjectKey(subject)
	marked := repository.AlertState{AlertID: alertID, State: repository.AlertStateRead, MarkedAt: &markedAt}
	dismissed := repository.AlertState{AlertID: alertID, State: repository.AlertStateDismissed, MarkedAt: &markedAt}
	missing := map[string]bool{alertID: true}

	for _, tc := range []struct {
		name        string
		role        string
		method      string
		contentType string
		body        string
		store       *fakeStore
		want        int
	}{
		{"read unread", "viewer", http.MethodGet, "", "", &fakeStore{}, http.StatusOK},
		{"read marked", "viewer", http.MethodGet, "", "", &fakeStore{alertStates: map[string]repository.AlertState{alertStateMapKey(alertID, key): marked}}, http.StatusOK},
		{"read missing alert", "viewer", http.MethodGet, "", "", &fakeStore{missingAlerts: missing}, http.StatusNotFound},
		{"read storage failure", "viewer", http.MethodGet, "", "", &fakeStore{alertStateErr: errors.New("storage unavailable")}, http.StatusServiceUnavailable},
		{"mark read", "admin", http.MethodPut, "application/json", `{"state":"read"}`, &fakeStore{}, http.StatusOK},
		{"mark dismissed", "admin", http.MethodPut, "application/json", `{"state":"dismissed"}`, &fakeStore{}, http.StatusOK},
		{"mark no-op returns the actual state", "admin", http.MethodPut, "application/json", `{"state":"read"}`, &fakeStore{alertStates: map[string]repository.AlertState{alertStateMapKey(alertID, key): dismissed}}, http.StatusOK},
		{"mark invalid body", "admin", http.MethodPut, "application/json", `{"state":"unread"}`, &fakeStore{}, http.StatusBadRequest},
		{"mark non-json body", "admin", http.MethodPut, "text/plain", `{"state":"read"}`, &fakeStore{}, http.StatusUnsupportedMediaType},
		// PM-15 (D-C): a personal mark is a per-caller preference, not an
		// administrative action. The ratified matrix answers «Sí» for viewer,
		// analista and admin, and an undeclared role is still refused 403.
		{"mark accepted for a viewer", "viewer", http.MethodPut, "application/json", `{"state":"read"}`, &fakeStore{}, http.StatusOK},
		{"mark accepted for an analista", "analista", http.MethodPut, "application/json", `{"state":"read"}`, &fakeStore{}, http.StatusOK},
		{"mark forbidden for an undeclared role", "operator", http.MethodPut, "application/json", `{"state":"read"}`, &fakeStore{}, http.StatusForbidden},
		{"mark missing alert", "admin", http.MethodPut, "application/json", `{"state":"read"}`, &fakeStore{missingAlerts: missing}, http.StatusNotFound},
		{"mark storage failure", "admin", http.MethodPut, "application/json", `{"state":"read"}`, &fakeStore{alertStateErr: errors.New("storage unavailable")}, http.StatusServiceUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			base, token := authorizedServerWithSubject(t, tc.role, subject, tc.store)
			app := withCorrelationID(base)
			w := alertStateCall(t, app, token, tc.method, target, tc.contentType, tc.body)
			if w.Code != tc.want {
				t.Fatalf("got %d want %d: %s", w.Code, tc.want, w.Body.String())
			}
			assertResponseMatchesContract(t, contract, "/v1/risk/alerts/{id}/state", tc.method, w)
		})
	}
}
