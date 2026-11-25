package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"firewatch.local/risk/internal/repository"
)

// alertTimelineBoundary is the keyset boundary the pager tests hand back to the
// route. Its instant carries microseconds, which is the precision the database
// stores, so a cursor that rounded it would be caught here.
func alertTimelineBoundary() repository.AlertCursor {
	return repository.AlertCursor{
		OccurredAt: time.Date(2026, time.August, 1, 12, 0, 0, 123456000, time.UTC),
		ID:         "8f14e45f-ceea-467a-9c3f-1d2b4c1b0a11",
	}
}

// assertAlertQuery pins what the route handed the repository: the page window, the
// direction and the keyset boundary, which are the three inputs that decide which
// alerts the caller sees.
func assertAlertQuery(t *testing.T, got repository.AlertPageQuery, want repository.AlertPageQuery) {
	t.Helper()
	if got.Limit != want.Limit {
		t.Fatalf("limit = %d, want %d", got.Limit, want.Limit)
	}
	if got.Order != want.Order {
		t.Fatalf("order = %q, want %q", got.Order, want.Order)
	}
	if (got.Cursor == nil) != (want.Cursor == nil) {
		t.Fatalf("cursor = %+v, want %+v", got.Cursor, want.Cursor)
	}
	if want.Cursor != nil {
		if !got.Cursor.OccurredAt.Equal(want.Cursor.OccurredAt) || got.Cursor.ID != want.Cursor.ID {
			t.Fatalf("cursor = %+v, want %+v", *got.Cursor, *want.Cursor)
		}
	}
}

// TestParseAlertListQuery pins the query validation table. It is pure so every
// accepted and every refused shape is exercised without a server, and the refusals
// are the point: an unreadable limit must not become the default page size, a cursor
// that is not structurally a cursor for this direction must not become page one, and
// a query whose URL encoding cannot be read must not be read as "no parameter".
func TestParseAlertListQuery(t *testing.T) {
	descending := repository.EncodeAlertCursor(repository.AlertOrderNewestFirst, alertTimelineBoundary())
	ascending := repository.EncodeAlertCursor(repository.AlertOrderOldestFirst, alertTimelineBoundary())
	boundary := alertTimelineBoundary()
	for _, tc := range []struct {
		name    string
		raw     string
		want    repository.AlertPageQuery
		wantErr bool
	}{
		{
			name: "no parameter is the documented first page",
			want: repository.AlertPageQuery{Limit: repository.AlertDefaultLimit, Order: repository.AlertOrderNewestFirst},
		},
		{
			name: "the smallest page",
			raw:  "limit=1",
			want: repository.AlertPageQuery{Limit: 1, Order: repository.AlertOrderNewestFirst},
		},
		{
			name: "the largest page",
			raw:  "limit=100",
			want: repository.AlertPageQuery{Limit: repository.AlertMaxLimit, Order: repository.AlertOrderNewestFirst},
		},
		{
			name: "explicit newest first",
			raw:  "order=desc",
			want: repository.AlertPageQuery{Limit: repository.AlertDefaultLimit, Order: repository.AlertOrderNewestFirst},
		},
		{
			name: "oldest first",
			raw:  "order=asc",
			want: repository.AlertPageQuery{Limit: repository.AlertDefaultLimit, Order: repository.AlertOrderOldestFirst},
		},
		{
			name: "a cursor for the selected direction",
			raw:  "cursor=" + descending,
			want: repository.AlertPageQuery{Limit: repository.AlertDefaultLimit, Order: repository.AlertOrderNewestFirst, Cursor: &boundary},
		},
		{
			name: "an ascending cursor with an ascending order",
			raw:  "limit=7&order=asc&cursor=" + ascending,
			want: repository.AlertPageQuery{Limit: 7, Order: repository.AlertOrderOldestFirst, Cursor: &boundary},
		},
		// URL encoding is read strictly: the pairs url.Values would silently drop are
		// refused, because dropping one changes the question the caller asked.
		{name: "limit has unreadable percent encoding", raw: "limit=%zz", wantErr: true},
		{name: "cursor has unreadable percent encoding", raw: "cursor=%", wantErr: true},
		{name: "order has unreadable percent encoding", raw: "order=asc&order=%E0%A4%A", wantErr: true},
		// Strictness is about unreadable bytes, not about escaping: a well-formed value
		// written with percent escapes is still decoded and accepted, so the route does
		// not quietly narrow the wire to one spelling per value.
		{
			name: "percent-encoded values are decoded",
			raw:  "order=%61sc&limit=%37",
			want: repository.AlertPageQuery{Limit: 7, Order: repository.AlertOrderOldestFirst},
		},
		{name: "limit zero", raw: "limit=0", wantErr: true},
		{name: "limit above the maximum", raw: "limit=101", wantErr: true},
		{name: "limit is not a number", raw: "limit=ten", wantErr: true},
		{name: "limit is a decimal", raw: "limit=1.5", wantErr: true},
		{name: "limit is negative", raw: "limit=-1", wantErr: true},
		{name: "limit is empty", raw: "limit=", wantErr: true},
		{name: "limit is repeated", raw: "limit=1&limit=2", wantErr: true},
		{name: "order is empty", raw: "order=", wantErr: true},
		{name: "order is upper case", raw: "order=DESC", wantErr: true},
		{name: "order is not a direction", raw: "order=sideways", wantErr: true},
		{name: "order is repeated", raw: "order=asc&order=desc", wantErr: true},
		{name: "cursor is empty", raw: "cursor=", wantErr: true},
		{name: "cursor is not a cursor", raw: "cursor=page-two", wantErr: true},
		{name: "cursor is repeated", raw: "cursor=" + descending + "&cursor=" + descending, wantErr: true},
		// A cursor encodes the boundary of one direction; the page it addresses does
		// not exist in the other, so pairing it with the other order is refused
		// instead of being read as "start from the beginning".
		{name: "cursor encoded for the other order", raw: "order=asc&cursor=" + descending, wantErr: true},
		{name: "unknown parameter", raw: "zone_id=05101", wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseAlertListQuery(tc.raw)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("parseAlertListQuery(%q) = %+v, want a malformed-query error", tc.raw, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseAlertListQuery(%q): %v", tc.raw, err)
			}
			assertAlertQuery(t, got, tc.want)
		})
	}
}

// alertResponseBody is the frozen wire read back independently of the handler's own
// types, so a renamed or retyped member fails here instead of passing because the
// producer and the assertion share one definition.
type alertResponseBody struct {
	Items []struct {
		ID            string    `json:"id"`
		ZoneID        string    `json:"zone_id"`
		ZoneName      *string   `json:"zone_name"`
		PreviousLevel string    `json:"previous_level"`
		NewLevel      string    `json:"new_level"`
		Threshold     int       `json:"threshold"`
		OccurredAt    time.Time `json:"occurred_at"`
		Demo          bool      `json:"demo"`
	} `json:"items"`
	NextCursor *string `json:"next_cursor"`
}

func decodeAlertResponse(t *testing.T, w *httptest.ResponseRecorder) alertResponseBody {
	t.Helper()
	var body alertResponseBody
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not JSON: %v: %s", err, w.Body.String())
	}
	return body
}

// storedAlertRow is a fixture the fake store answers with. It is built through the
// repository type so the handler test does not re-declare the row's members.
func storedAlertRow(id, zoneID string, zoneName *string, occurredAt time.Time, demo bool) repository.Alert {
	return repository.Alert{
		ID:            id,
		ZoneID:        zoneID,
		ZoneName:      zoneName,
		PreviousLevel: "bajo",
		NewLevel:      "alto",
		Threshold:     1,
		OccurredAt:    occurredAt,
		Demo:          demo,
	}
}

// TestAlertsEndpoint pins the collection the notification screen consumes: the
// frozen members, an empty list rather than null, a null cursor on the last page,
// and the storage failure vocabulary its neighbouring reads already use.
func TestAlertsEndpoint(t *testing.T) {
	name := "Valparaiso"
	occurredAt := time.Date(2026, time.August, 1, 12, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name       string
		target     string
		page       repository.AlertPage
		storageErr error
		wantStatus int
		wantItems  int
		wantCode   string
		wantCursor bool
		wantQuery  repository.AlertPageQuery
	}{
		{
			name:       "nothing stored is an empty list",
			target:     "/v1/risk/alerts",
			wantStatus: http.StatusOK,
			wantQuery:  repository.AlertPageQuery{Limit: repository.AlertDefaultLimit, Order: repository.AlertOrderNewestFirst},
		},
		{
			name:   "a stored page keeps its provenance and nullable label",
			target: "/v1/risk/alerts",
			page: repository.AlertPage{Alerts: []repository.Alert{
				storedAlertRow("8f14e45f-ceea-467a-9c3f-1d2b4c1b0a11", "05101", &name, occurredAt, false),
				storedAlertRow("8f14e45f-ceea-467a-9c3f-1d2b4c1b0a12", "99999", nil, occurredAt.Add(-time.Minute), true),
			}},
			wantStatus: http.StatusOK,
			wantItems:  2,
			wantQuery:  repository.AlertPageQuery{Limit: repository.AlertDefaultLimit, Order: repository.AlertOrderNewestFirst},
		},
		{
			name:   "more rows behind the page expose the next cursor",
			target: "/v1/risk/alerts",
			page: repository.AlertPage{
				Alerts:     []repository.Alert{storedAlertRow("8f14e45f-ceea-467a-9c3f-1d2b4c1b0a11", "05101", &name, occurredAt, false)},
				NextCursor: repository.EncodeAlertCursor(repository.AlertOrderNewestFirst, alertTimelineBoundary()),
			},
			wantStatus: http.StatusOK,
			wantItems:  1,
			wantCursor: true,
			wantQuery:  repository.AlertPageQuery{Limit: repository.AlertDefaultLimit, Order: repository.AlertOrderNewestFirst},
		},
		{
			name:       "storage failure is storage_unavailable",
			target:     "/v1/risk/alerts",
			storageErr: errors.New("storage unavailable"),
			wantStatus: http.StatusServiceUnavailable,
			wantCode:   "storage_unavailable",
			wantQuery:  repository.AlertPageQuery{Limit: repository.AlertDefaultLimit, Order: repository.AlertOrderNewestFirst},
		},
		{
			name:       "a malformed query is refused before storage",
			target:     "/v1/risk/alerts?limit=500",
			wantStatus: http.StatusBadRequest,
			wantCode:   "invalid_alert_query",
		},
		{
			// The request line is readable - only one parameter value is not - so the
			// route has to read the raw query strictly. url.Values would drop the pair
			// it cannot unescape and serve the default first page as if nothing was
			// asked, which is a silently different question than the one sent.
			name:       "unreadable URL encoding is refused before storage",
			target:     "/v1/risk/alerts?limit=%zz",
			wantStatus: http.StatusBadRequest,
			wantCode:   "invalid_alert_query",
		},
		{
			name:       "the selected window and direction reach the repository",
			target:     "/v1/risk/alerts?limit=2&order=asc",
			wantStatus: http.StatusOK,
			wantQuery:  repository.AlertPageQuery{Limit: 2, Order: repository.AlertOrderOldestFirst},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &fakeStore{alertPage: tc.page, alertErr: tc.storageErr}
			handler, token := authorizedServer(t, "viewer", store)
			w := getZones(t, handler, token, tc.target)
			if w.Code != tc.wantStatus {
				t.Fatalf("got %d want %d: %s", w.Code, tc.wantStatus, w.Body.String())
			}
			if tc.wantStatus != http.StatusOK {
				if !strings.Contains(w.Body.String(), `"code":"`+tc.wantCode+`"`) {
					t.Fatalf("failure body = %s, want code %q", w.Body.String(), tc.wantCode)
				}
				if tc.wantStatus == http.StatusBadRequest && len(store.alertQueries) != 0 {
					t.Fatal("a malformed query reached the repository")
				}
				return
			}
			// Every accepted request asked storage exactly once, with the window and
			// keyset the caller named.
			if len(store.alertQueries) != 1 {
				t.Fatalf("storage calls = %d, want 1", len(store.alertQueries))
			}
			assertAlertQuery(t, store.alertQueries[0], tc.wantQuery)

			body := decodeAlertResponse(t, w)
			if len(body.Items) != tc.wantItems {
				t.Fatalf("items = %d, want %d: %s", len(body.Items), tc.wantItems, w.Body.String())
			}
			if tc.wantItems == 0 {
				// Nothing stored is an answer: an empty array, never null and never
				// a 404, and no cursor to follow.
				if !strings.Contains(w.Body.String(), `"items":[]`) {
					t.Fatalf("empty timeline is not an empty array: %s", w.Body.String())
				}
				if body.NextCursor != nil {
					t.Fatalf("empty timeline carries cursor %q", *body.NextCursor)
				}
				return
			}
			first := body.Items[0]
			if first.ID != tc.page.Alerts[0].ID || first.ZoneID != tc.page.Alerts[0].ZoneID {
				t.Fatalf("first item identity = %+v", first)
			}
			if first.PreviousLevel != "bajo" || first.NewLevel != "alto" || first.Threshold != 1 {
				t.Fatalf("first item transition = %+v", first)
			}
			if !first.OccurredAt.Equal(tc.page.Alerts[0].OccurredAt) {
				t.Fatalf("first item occurred_at = %s, want %s", first.OccurredAt, tc.page.Alerts[0].OccurredAt)
			}
			if first.Demo {
				t.Fatal("a real transition is labelled demo")
			}
			if first.ZoneName == nil || *first.ZoneName != name {
				t.Fatalf("first item zone_name = %+v, want %q", first.ZoneName, name)
			}
			if tc.wantItems == 2 {
				second := body.Items[1]
				// A zone the catalogue no longer names is served as null, not omitted
				// and not invented.
				if second.ZoneName != nil {
					t.Fatalf("second item zone_name = %q, want null", *second.ZoneName)
				}
				if !strings.Contains(w.Body.String(), `"zone_name":null`) {
					t.Fatalf("a null label is not served as null: %s", w.Body.String())
				}
				if !second.Demo {
					t.Fatal("a synthetic transition lost its demo label")
				}
			}
			if tc.wantCursor {
				if body.NextCursor == nil || *body.NextCursor == "" {
					t.Fatalf("page with a cursor behind it served %+v", body.NextCursor)
				}
			} else if body.NextCursor != nil {
				t.Fatalf("last page carries cursor %q", *body.NextCursor)
			}
		})
	}
}

// TestAlertsEndpointKeepsTheReadVerificationPath pins that the timeline is a read
// like every other one: the shared bearer gate answers 401 and 403 before storage
// is touched, both read roles are admitted, and an admitted read never mutates.
func TestAlertsEndpointKeepsTheReadVerificationPath(t *testing.T) {
	name := "Valparaiso"
	page := repository.AlertPage{Alerts: []repository.Alert{storedAlertRow("8f14e45f-ceea-467a-9c3f-1d2b4c1b0a11", "05101", &name, time.Date(2026, time.August, 1, 12, 0, 0, 0, time.UTC), false)}}
	for _, tc := range []struct {
		name  string
		role  string
		want  int
		store *fakeStore
	}{
		{"anonymous is refused", "", http.StatusUnauthorized, &fakeStore{alertPage: page}},
		{"a role outside the read gate is forbidden", "operator", http.StatusForbidden, &fakeStore{alertPage: page}},
		{"viewer reads", "viewer", http.StatusOK, &fakeStore{alertPage: page}},
		{"admin reads", "admin", http.StatusOK, &fakeStore{alertPage: page}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			handler, token := authorizedServer(t, tc.role, tc.store)
			r := httptest.NewRequest(http.MethodGet, "/v1/risk/alerts", nil)
			if tc.role != "" {
				r.Header.Set("Authorization", "Bearer "+token)
			}
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Fatalf("got %d want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if tc.want != http.StatusOK {
				if len(tc.store.alertQueries) != 0 {
					t.Fatal("a refused request reached storage")
				}
				return
			}
			if len(tc.store.alertQueries) != 1 {
				t.Fatalf("storage calls = %d, want 1", len(tc.store.alertQueries))
			}
		})
	}
}

// TestAlertsEndpointNavigation pins the pager the screen implements: the cursor a
// page returns is exactly the cursor the next request continues from, in the
// direction it was encoded for, and toggling the order invalidates it instead of
// replaying page one.
func TestAlertsEndpointNavigation(t *testing.T) {
	name := "Valparaiso"
	boundary := alertTimelineBoundary()
	descCursor := repository.EncodeAlertCursor(repository.AlertOrderNewestFirst, boundary)
	store := &fakeStore{alertPage: repository.AlertPage{
		Alerts:     []repository.Alert{storedAlertRow("8f14e45f-ceea-467a-9c3f-1d2b4c1b0a11", "05101", &name, time.Date(2026, time.August, 1, 12, 0, 0, 0, time.UTC), false)},
		NextCursor: descCursor,
	}}
	handler, token := authorizedServer(t, "viewer", store)

	first := getZones(t, handler, token, "/v1/risk/alerts?limit=1")
	if first.Code != http.StatusOK {
		t.Fatalf("first page got %d: %s", first.Code, first.Body.String())
	}
	body := decodeAlertResponse(t, first)
	if body.NextCursor == nil {
		t.Fatal("the first page offered no cursor to continue from")
	}
	if *body.NextCursor != descCursor {
		t.Fatalf("next_cursor = %q, want the cursor the repository returned", *body.NextCursor)
	}

	// Page two echoes the cursor verbatim; the route must translate it back into
	// the same keyset boundary, not into a page number or a fresh start.
	store.alertQueries = nil
	second := getZones(t, handler, token, "/v1/risk/alerts?limit=1&cursor="+url.QueryEscape(*body.NextCursor))
	if second.Code != http.StatusOK {
		t.Fatalf("second page got %d: %s", second.Code, second.Body.String())
	}
	if len(store.alertQueries) != 1 {
		t.Fatalf("storage calls = %d, want 1", len(store.alertQueries))
	}
	assertAlertQuery(t, store.alertQueries[0], repository.AlertPageQuery{Limit: 1, Order: repository.AlertOrderNewestFirst, Cursor: &boundary})

	// The same literal after toggling the order addresses a page that does not
	// exist: it is refused 400 before storage, because serving it as page one would
	// silently repeat the first page under a different direction.
	store.alertQueries = nil
	toggled := getZones(t, handler, token, "/v1/risk/alerts?order=asc&cursor="+url.QueryEscape(descCursor))
	if toggled.Code != http.StatusBadRequest {
		t.Fatalf("a cursor from the other direction got %d: %s", toggled.Code, toggled.Body.String())
	}
	if !strings.Contains(toggled.Body.String(), `"code":"invalid_alert_query"`) {
		t.Fatalf("toggled-order body = %s", toggled.Body.String())
	}
	if len(store.alertQueries) != 0 {
		t.Fatal("a cursor from the other direction reached storage")
	}
}
