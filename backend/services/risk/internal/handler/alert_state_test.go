package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"firewatch.local/risk/internal/repository"
	"github.com/google/uuid"
)

// alertStatePath is the one path these tests exercise. The identifier is a real
// canonical uuid because the route refuses any other spelling before storage.
const alertStatePath = "/v1/risk/alerts/8f14e45f-ceea-467a-9c3f-1d2b4c1b0a11/state"

// alertStateResponseBody is the state wire, decoded for assertions. It has no
// subject member on purpose: the actor is the verified token, never a field of
// the answer.
type alertStateResponseBody struct {
	AlertID  string     `json:"alert_id"`
	State    string     `json:"state"`
	MarkedAt *time.Time `json:"marked_at"`
}

// alertStateCall sends one request to the state route with an explicit content
// type. The body is sent verbatim so a malformed shape stays malformed.
func alertStateCall(t *testing.T, handler http.Handler, token, method, target, contentType, body string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	r := httptest.NewRequest(method, target, reader)
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	if contentType != "" {
		r.Header.Set("Content-Type", contentType)
	}
	r.Header.Set("X-Request-ID", uuid.NewString())
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

// TestAlertStateReadIsScopedToTheVerifiedSubject is the HTTP-side actor isolation
// property: a viewer reads only the mark of the subject its verified token names,
// the repository receives the derived subject key instead of any request value,
// and the answer carries neither the subject nor an actor member.
func TestAlertStateReadIsScopedToTheVerifiedSubject(t *testing.T) {
	const subject = "encargado.uno@example.test"
	markedAt := time.Date(2026, time.October, 2, 9, 30, 0, 0, time.UTC)
	key := repository.AlertStateSubjectKey(subject)
	const alertID = "8f14e45f-ceea-467a-9c3f-1d2b4c1b0a11"
	store := &fakeStore{alertStates: map[string]repository.AlertState{
		alertStateMapKey(alertID, key): {AlertID: alertID, State: repository.AlertStateRead, MarkedAt: &markedAt},
	}}
	handler, token := authorizedServerWithSubject(t, "viewer", subject, store)

	w := alertStateCall(t, handler, token, http.MethodGet, alertStatePath, "", "")
	if w.Code != http.StatusOK {
		t.Fatalf("got %d want 200: %s", w.Code, w.Body.String())
	}
	if len(store.stateReads) != 1 {
		t.Fatalf("storage reads = %d, want 1", len(store.stateReads))
	}
	read := store.stateReads[0]
	if read.AlertID != alertID {
		t.Errorf("storage was asked about alert %q, want %q", read.AlertID, alertID)
	}
	if read.SubjectKey != key {
		t.Errorf("storage was asked for subject key %q, want the digest of the verified subject %q", read.SubjectKey, key)
	}
	var body alertStateResponseBody
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode state body: %v: %s", err, w.Body.String())
	}
	if body.AlertID != alertID || body.State != repository.AlertStateRead {
		t.Fatalf("body = %+v, want the stored read mark", body)
	}
	if body.MarkedAt == nil || !body.MarkedAt.Equal(markedAt) {
		t.Fatalf("marked_at = %v, want %s", body.MarkedAt, markedAt)
	}
	// The subject is a verified fact about the caller, not part of the document.
	if strings.Contains(w.Body.String(), "subject") || strings.Contains(w.Body.String(), subject) || strings.Contains(w.Body.String(), "actor") {
		t.Fatalf("the state body exposes the caller identity: %s", w.Body.String())
	}
}

// TestAlertStateReadAnswersUnreadAndMissing covers the two deterministic reads:
// an existing alert with no mark of this subject is unread with no timestamp, and
// an identifier that names no stored alert is 404 without a fabricated mark.
func TestAlertStateReadAnswersUnreadAndMissing(t *testing.T) {
	const alertID = "8f14e45f-ceea-467a-9c3f-1d2b4c1b0a11"
	for _, tc := range []struct {
		name       string
		target     string
		store      *fakeStore
		wantStatus int
		wantCode   string
		wantReads  int
	}{
		{
			name:       "no mark is unread with no timestamp",
			target:     alertStatePath,
			store:      &fakeStore{},
			wantStatus: http.StatusOK,
			wantReads:  1,
		},
		{
			name:       "an alert that is not stored is 404",
			target:     alertStatePath,
			store:      &fakeStore{missingAlerts: map[string]bool{alertID: true}},
			wantStatus: http.StatusNotFound,
			wantCode:   "alert_not_found",
			wantReads:  1,
		},
		{
			name:       "a path that is not a canonical uuid names no alert",
			target:     "/v1/risk/alerts/not-a-uuid/state",
			store:      &fakeStore{},
			wantStatus: http.StatusNotFound,
			wantCode:   "alert_not_found",
		},
		{
			name:       "an upper-case uuid spelling is not the stored identifier",
			target:     "/v1/risk/alerts/8F14E45F-CEEA-467A-9C3F-1D2B4C1B0A11/state",
			store:      &fakeStore{},
			wantStatus: http.StatusNotFound,
			wantCode:   "alert_not_found",
		},
		{
			name:       "storage failure is storage_unavailable",
			target:     alertStatePath,
			store:      &fakeStore{alertStateErr: errors.New("storage unavailable")},
			wantStatus: http.StatusServiceUnavailable,
			wantCode:   "storage_unavailable",
			wantReads:  1,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			handler, token := authorizedServer(t, "viewer", tc.store)
			w := alertStateCall(t, handler, token, http.MethodGet, tc.target, "", "")
			if w.Code != tc.wantStatus {
				t.Fatalf("got %d want %d: %s", w.Code, tc.wantStatus, w.Body.String())
			}
			if len(tc.store.stateReads) != tc.wantReads {
				t.Fatalf("storage reads = %d, want %d", len(tc.store.stateReads), tc.wantReads)
			}
			if tc.wantCode != "" {
				if !strings.Contains(w.Body.String(), `"code":"`+tc.wantCode+`"`) {
					t.Fatalf("body = %s, want code %q", w.Body.String(), tc.wantCode)
				}
				return
			}
			var body alertStateResponseBody
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatalf("decode state body: %v: %s", err, w.Body.String())
			}
			if body.State != repository.AlertStateUnread {
				t.Fatalf("state = %q, want unread", body.State)
			}
			if body.MarkedAt != nil {
				t.Fatalf("unread carries marked_at %v, want null", body.MarkedAt)
			}
			if !strings.Contains(w.Body.String(), `"marked_at":null`) {
				t.Fatalf("unread is not served with a null timestamp: %s", w.Body.String())
			}
		})
	}
}

// TestAlertStateKeepsTheReadGate pins that the state read is a read under the
// same bearer gate as the timeline: 401 and 403 are answered before storage, and
// both read roles are admitted.
func TestAlertStateKeepsTheReadGate(t *testing.T) {
	for _, tc := range []struct {
		name  string
		role  string
		want  int
		reads int
	}{
		{"anonymous is refused", "", http.StatusUnauthorized, 0},
		{"a role outside the gate is forbidden", "operator", http.StatusForbidden, 0},
		{"viewer reads own state", "viewer", http.StatusOK, 1},
		{"admin reads own state", "admin", http.StatusOK, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &fakeStore{}
			handler, token := authorizedServer(t, tc.role, store)
			if tc.role == "" {
				// The harness always signs a token; an anonymous request omits it.
				token = ""
			}
			w := alertStateCall(t, handler, token, http.MethodGet, alertStatePath, "", "")
			if w.Code != tc.want {
				t.Fatalf("got %d want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if len(store.stateReads) != tc.reads {
				t.Fatalf("storage reads = %d, want %d", len(store.stateReads), tc.reads)
			}
		})
	}
}

// TestAlertStateMarkIsAdminOnlyAndOwnSubjectOnly pins the authorization policy:
// a mark is applied by an admin, to the admin's own state, and a viewer is
// refused before storage. The subject reaches the repository as the digest of the
// verified token subject; the request body cannot name an actor.
func TestAlertStateMarkIsAdminOnlyAndOwnSubjectOnly(t *testing.T) {
	const subject = "admin.uno@example.test"
	store := &fakeStore{}
	handler, token := authorizedServerWithSubject(t, "admin", subject, store)

	w := alertStateCall(t, handler, token, http.MethodPut, alertStatePath, "application/json", `{"state":"read"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d want 200: %s", w.Code, w.Body.String())
	}
	if len(store.markWrites) != 1 {
		t.Fatalf("storage writes = %d, want 1", len(store.markWrites))
	}
	write := store.markWrites[0]
	if write.AlertID != "8f14e45f-ceea-467a-9c3f-1d2b4c1b0a11" {
		t.Errorf("mark written for alert %q", write.AlertID)
	}
	if write.SubjectKey != repository.AlertStateSubjectKey(subject) {
		t.Errorf("mark written for subject key %q, want the verified subject's digest", write.SubjectKey)
	}
	if write.Mark != repository.AlertMarkRead {
		t.Errorf("mark written = %q, want read", write.Mark)
	}
	if strings.Contains(w.Body.String(), subject) || strings.Contains(w.Body.String(), "subject") || strings.Contains(w.Body.String(), "actor") {
		t.Fatalf("the mark body exposes the caller identity: %s", w.Body.String())
	}

	// A viewer never reaches the write: 403 is a role decision, not a storage
	// failure, so nothing is written.
	viewerStore := &fakeStore{}
	viewerHandler, viewerToken := authorizedServerWithSubject(t, "viewer", subject, viewerStore)
	refused := alertStateCall(t, viewerHandler, viewerToken, http.MethodPut, alertStatePath, "application/json", `{"state":"dismissed"}`)
	if refused.Code != http.StatusForbidden {
		t.Fatalf("viewer got %d want 403: %s", refused.Code, refused.Body.String())
	}
	if len(viewerStore.markWrites) != 0 {
		t.Fatal("a viewer's mark reached storage")
	}

	// The same refusal for a token whose role is outside the read gate, and a 401
	// for no token at all; neither touches storage.
	for _, tc := range []struct {
		name string
		role string
		want int
	}{
		{"anonymous is refused", "", http.StatusUnauthorized},
		{"an unknown role is forbidden", "operator", http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			refusedStore := &fakeStore{}
			refusedHandler, refusedToken := authorizedServer(t, tc.role, refusedStore)
			if tc.role == "" {
				refusedToken = ""
			}
			w := alertStateCall(t, refusedHandler, refusedToken, http.MethodPut, alertStatePath, "application/json", `{"state":"read"}`)
			if w.Code != tc.want {
				t.Fatalf("got %d want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if len(refusedStore.markWrites) != 0 {
				t.Fatal("a refused request reached storage")
			}
		})
	}
}

// TestAlertStateMarkInputIsExact pins the bounded input: one JSON document with
// one member, no unknown member (so no request-supplied actor), a closed state
// vocabulary, and a body cap. Every refusal happens before storage.
func TestAlertStateMarkInputIsExact(t *testing.T) {
	oversized := `{"state":"read","padding":"` + strings.Repeat("x", 600) + `"}`
	for _, tc := range []struct {
		name        string
		contentType string
		body        string
		wantStatus  int
		wantCode    string
	}{
		{"json content type is required", "", `{"state":"read"}`, http.StatusUnsupportedMediaType, "json_required"},
		{"a non-json content type is refused", "text/plain", `{"state":"read"}`, http.StatusUnsupportedMediaType, "json_required"},
		{"an unknown member is refused", "application/json", `{"state":"read","actor_id":"someone-else"}`, http.StatusBadRequest, "invalid_alert_state"},
		{"a subject member is refused", "application/json", `{"state":"read","subject":"someone-else"}`, http.StatusBadRequest, "invalid_alert_state"},
		{"unread is not an appendable mark", "application/json", `{"state":"unread"}`, http.StatusBadRequest, "invalid_alert_state"},
		{"an upper-case mark is refused", "application/json", `{"state":"READ"}`, http.StatusBadRequest, "invalid_alert_state"},
		{"an empty body is refused", "application/json", ``, http.StatusBadRequest, "invalid_alert_state"},
		{"a case-variant member is refused", "application/json", `{"State":"read"}`, http.StatusBadRequest, "invalid_alert_state"},
		{"a duplicate state member is refused", "application/json", `{"state":"read","state":"dismissed"}`, http.StatusBadRequest, "invalid_alert_state"},
		{"a missing state is refused", "application/json", `{}`, http.StatusBadRequest, "invalid_alert_state"},
		{"a second document is refused", "application/json", `{"state":"read"}{"state":"dismissed"}`, http.StatusBadRequest, "invalid_alert_state"},
		{"an over-long body is refused", "application/json", oversized, http.StatusBadRequest, "invalid_alert_state"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &fakeStore{}
			handler, token := authorizedServer(t, "admin", store)
			w := alertStateCall(t, handler, token, http.MethodPut, alertStatePath, tc.contentType, tc.body)
			if w.Code != tc.wantStatus {
				t.Fatalf("got %d want %d: %s", w.Code, tc.wantStatus, w.Body.String())
			}
			if !strings.Contains(w.Body.String(), `"code":"`+tc.wantCode+`"`) {
				t.Fatalf("body = %s, want code %q", w.Body.String(), tc.wantCode)
			}
			if len(store.markWrites) != 0 {
				t.Fatal("a malformed mark reached storage")
			}
		})
	}
}

// TestAlertStateMarkIsIdempotentAndDismissedDominates pins the no-op semantics the
// contract documents: replaying the effective mark returns the stored answer with
// its original instant, and a mark below the current rank appends nothing and
// returns the dominating state.
func TestAlertStateMarkIsIdempotentAndDismissedDominates(t *testing.T) {
	store := &fakeStore{}
	handler, token := authorizedServerWithSubject(t, "admin", "admin.dos@example.test", store)

	first := alertStateCall(t, handler, token, http.MethodPut, alertStatePath, "application/json", `{"state":"read"}`)
	if first.Code != http.StatusOK {
		t.Fatalf("first mark got %d: %s", first.Code, first.Body.String())
	}
	firstBody := decodeAlertState(t, first)
	if firstBody.State != repository.AlertStateRead || firstBody.MarkedAt == nil {
		t.Fatalf("first mark = %+v, want read with an instant", firstBody)
	}

	replay := alertStateCall(t, handler, token, http.MethodPut, alertStatePath, "application/json", `{"state":"read"}`)
	replayed := decodeAlertState(t, replay)
	if replayed.State != repository.AlertStateRead || replayed.MarkedAt == nil || !replayed.MarkedAt.Equal(*firstBody.MarkedAt) {
		t.Fatalf("replay = %+v, want the same read instant %s", replayed, firstBody.MarkedAt)
	}

	dismissed := alertStateCall(t, handler, token, http.MethodPut, alertStatePath, "application/json", `{"state":"dismissed"}`)
	dismissedBody := decodeAlertState(t, dismissed)
	if dismissedBody.State != repository.AlertStateDismissed || dismissedBody.MarkedAt == nil {
		t.Fatalf("dismissed = %+v, want dismissed with an instant", dismissedBody)
	}

	// A read after a dismissal is a lower mark: it must not replace the dismissal
	// or rewrite its instant, even though the request is accepted.
	lower := alertStateCall(t, handler, token, http.MethodPut, alertStatePath, "application/json", `{"state":"read"}`)
	lowerBody := decodeAlertState(t, lower)
	if lowerBody.State != repository.AlertStateDismissed {
		t.Fatalf("read after dismissed answered %q, want the dominating dismissed state", lowerBody.State)
	}
	if lowerBody.MarkedAt == nil || !lowerBody.MarkedAt.Equal(*dismissedBody.MarkedAt) {
		t.Fatalf("read after dismissed rewrote the instant: %v then %v", dismissedBody.MarkedAt, lowerBody.MarkedAt)
	}

	again := decodeAlertState(t, alertStateCall(t, handler, token, http.MethodPut, alertStatePath, "application/json", `{"state":"dismissed"}`))
	if again.MarkedAt == nil || !again.MarkedAt.Equal(*dismissedBody.MarkedAt) {
		t.Fatalf("dismissed replay rewrote the instant: %v then %v", dismissedBody.MarkedAt, again.MarkedAt)
	}

	// A different verified subject reading the same alert is unaffected: the store
	// is scoped by the subject key, so one person's marks are not another's state.
	otherHandler, otherToken := authorizedServerWithSubject(t, "viewer", "viewer.otro@example.test", store)
	other := decodeAlertState(t, alertStateCall(t, otherHandler, otherToken, http.MethodGet, alertStatePath, "", ""))
	if other.State != repository.AlertStateUnread || other.MarkedAt != nil {
		t.Fatalf("another subject sees %+v, want unread with no instant", other)
	}
}

func decodeAlertState(t *testing.T, w *httptest.ResponseRecorder) alertStateResponseBody {
	t.Helper()
	if w.Code != http.StatusOK {
		t.Fatalf("got %d want 200: %s", w.Code, w.Body.String())
	}
	var body alertStateResponseBody
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode state body: %v: %s", err, w.Body.String())
	}
	return body
}

// TestAlertStateMarkMissingAlertIs404 pins that a well-formed mark for an alert
// that is not stored is the documented 404, not a state row invented for an
// alert nobody recorded and not a storage failure.
func TestAlertStateMarkMissingAlertIs404(t *testing.T) {
	store := &fakeStore{missingAlerts: map[string]bool{"8f14e45f-ceea-467a-9c3f-1d2b4c1b0a11": true}}
	handler, token := authorizedServer(t, "admin", store)
	w := alertStateCall(t, handler, token, http.MethodPut, alertStatePath, "application/json", `{"state":"read"}`)
	if w.Code != http.StatusNotFound {
		t.Fatalf("got %d want 404: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"code":"alert_not_found"`) {
		t.Fatalf("body = %s", w.Body.String())
	}
	if len(store.markWrites) != 1 {
		t.Fatalf("storage writes = %d, want the one lookup", len(store.markWrites))
	}
}

// TestAlertStateMarkStorageFailureIs503 pins the failure vocabulary the screen
// already renders: the mark could not be applied, so it is a dependency failure
// and not a silent success.
func TestAlertStateMarkStorageFailureIs503(t *testing.T) {
	store := &fakeStore{alertStateErr: errors.New("storage unavailable")}
	handler, token := authorizedServer(t, "admin", store)
	w := alertStateCall(t, handler, token, http.MethodPut, alertStatePath, "application/json", `{"state":"read"}`)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("got %d want 503: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"code":"storage_unavailable"`) {
		t.Fatalf("body = %s", w.Body.String())
	}
}

// TestAlertTimelineWireStaysFreeOfState is the legacy compatibility pin: the
// PM-07 timeline is additive-only here, so its element keeps exactly the eight
// frozen members and gains no read mark, timestamp or actor.
func TestAlertTimelineWireStaysFreeOfState(t *testing.T) {
	name := "Valparaiso"
	store := &fakeStore{alertPage: repository.AlertPage{Alerts: []repository.Alert{
		storedAlertRow("8f14e45f-ceea-467a-9c3f-1d2b4c1b0a11", "05101", &name, time.Date(2026, time.August, 1, 12, 0, 0, 0, time.UTC), false),
	}}}
	handler, token := authorizedServer(t, "viewer", store)
	w := getZones(t, handler, token, "/v1/risk/alerts")
	if w.Code != http.StatusOK {
		t.Fatalf("got %d want 200: %s", w.Code, w.Body.String())
	}
	var body struct {
		Items []map[string]json.RawMessage `json:"items"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode timeline: %v: %s", err, w.Body.String())
	}
	if len(body.Items) != 1 {
		t.Fatalf("items = %d, want 1", len(body.Items))
	}
	want := map[string]bool{"id": true, "zone_id": true, "zone_name": true, "previous_level": true, "new_level": true, "threshold": true, "occurred_at": true, "demo": true}
	for member := range body.Items[0] {
		if !want[member] {
			t.Errorf("the timeline element gained the member %q; PM-07 rows are immutable and PM-08 state is a separate resource", member)
		}
		delete(want, member)
	}
	for missing := range want {
		t.Errorf("the timeline element lost the member %q", missing)
	}
}
