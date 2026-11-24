package handler

import (
	"errors"
	"net/http"
	"testing"
	"time"

	"firewatch.local/risk/internal/repository"
)

// TestRiskContractAlertsMatchTheContract validates the timeline route's real
// responses against the published document, so the frozen wire cannot drift from
// what the handler emits. It covers both populated shapes (a named zone, a null
// label, a next cursor) and the two bodies a notification screen must tell apart:
// the empty answer, which is a 200 with an empty list, and the storage failure,
// which is a 503 the screen renders as an error instead of as "no alerts".
func TestRiskContractAlertsMatchTheContract(t *testing.T) {
	contract := loadContract(t)
	name := "Valparaiso"
	occurredAt := time.Date(2026, time.August, 1, 12, 0, 0, 0, time.UTC)
	next := repository.EncodeAlertCursor(repository.AlertOrderNewestFirst, alertTimelineBoundary())
	named := storedAlertRow("8f14e45f-ceea-467a-9c3f-1d2b4c1b0a11", "05101", &name, occurredAt, false)
	unnamed := storedAlertRow("8f14e45f-ceea-467a-9c3f-1d2b4c1b0a12", "99999", nil, occurredAt.Add(-time.Minute), true)
	for _, tc := range []struct {
		name   string
		target string
		store  *fakeStore
		want   int
	}{
		{
			name:   "populated page with a named zone",
			target: "/v1/risk/alerts",
			store:  &fakeStore{alertPage: repository.AlertPage{Alerts: []repository.Alert{named}}},
			want:   http.StatusOK,
		},
		{
			name:   "null label, synthetic provenance and a next cursor",
			target: "/v1/risk/alerts?order=asc&limit=1",
			store:  &fakeStore{alertPage: repository.AlertPage{Alerts: []repository.Alert{unnamed}, NextCursor: next}},
			want:   http.StatusOK,
		},
		{
			name:   "empty timeline",
			target: "/v1/risk/alerts",
			store:  &fakeStore{},
			want:   http.StatusOK,
		},
		{
			name:   "storage unavailable",
			target: "/v1/risk/alerts",
			store:  &fakeStore{alertErr: errors.New("storage unavailable")},
			want:   http.StatusServiceUnavailable,
		},
		{
			name:   "malformed query",
			target: "/v1/risk/alerts?order=up",
			store:  &fakeStore{},
			want:   http.StatusBadRequest,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			base, token := authorizedServer(t, "viewer", tc.store)
			app := withCorrelationID(base)
			w := request(t, app, token, tc.target)
			if w.Code != tc.want {
				t.Fatalf("got %d want %d: %s", w.Code, tc.want, w.Body.String())
			}
			assertResponseMatchesContract(t, contract, "/v1/risk/alerts", http.MethodGet, w)
		})
	}
}
