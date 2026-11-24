package handler

import (
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"firewatch.local/risk/internal/repository"
)

// errInvalidAlertQuery is the verdict on a malformed timeline query. It exists so
// the parse step has one failure value: the caller needs to know the request was
// refused, and every refusal is the same 400 body.
var errInvalidAlertQuery = errors.New("malformed alert query")

// alertItem is one element of the frozen alert wire. The members are the PM-07
// row plus the two references it is read through: the current catalogue label and
// the demo flag of the originating batch. zone_name is a pointer because "the
// catalogue does not name this zone" is served as null rather than hidden.
type alertItem struct {
	ID            string    `json:"id"`
	ZoneID        string    `json:"zone_id"`
	ZoneName      *string   `json:"zone_name"`
	PreviousLevel string    `json:"previous_level"`
	NewLevel      string    `json:"new_level"`
	Threshold     int       `json:"threshold"`
	OccurredAt    time.Time `json:"occurred_at"`
	Demo          bool      `json:"demo"`
}

// alertCollection is one page of the timeline. Items is never nil, so an empty
// timeline serialises as an empty array rather than JSON null, and NextCursor is
// null on the last page - both are answers, neither is an error.
type alertCollection struct {
	Items      []alertItem `json:"items"`
	NextCursor *string     `json:"next_cursor"`
}

// alertQueryKeysValid reports whether the query names only the three parameters of
// the frozen wire and names each exactly once. A repeated parameter has no single
// meaning, so it is refused rather than resolved by picking one of the values.
func alertQueryKeysValid(values url.Values) bool {
	for key, raw := range values {
		if key != "limit" && key != "order" && key != "cursor" {
			return false
		}
		if len(raw) != 1 {
			return false
		}
	}
	return true
}

// parseAlertListQuery reads the frozen query trio - limit, order and cursor - from
// the raw query string.
//
// It is pure so every accepted and refused shape is testable without a server, and it
// takes the raw string rather than url.Values because url.Values silently discards a
// pair it cannot unescape: a request for `?limit=%zz` would then be served the default
// first page as if nothing had been asked. url.ParseQuery reports that error, so
// unreadable URL encoding is a refusal like any other malformed shape.
//
// The trio is parsed in a fixed sequence rather than in map order because the cursor
// is bound to the direction it encodes: the order has to be known before the cursor
// can be judged. Reading them in url.Values' iteration order would make the same
// request valid or invalid at random.
//
// Every refusal - unreadable URL encoding, an unknown parameter, a repeated one, a
// limit outside 1..100, an order that is not desc or asc, an empty or structurally
// invalid cursor, or a cursor encoded for the other direction - is malformed input,
// so the route answers one 400 code and reads nothing.
func parseAlertListQuery(rawQuery string) (repository.AlertPageQuery, error) {
	values, err := url.ParseQuery(rawQuery)
	if err != nil || !alertQueryKeysValid(values) {
		return repository.AlertPageQuery{}, errInvalidAlertQuery
	}
	query := repository.AlertPageQuery{Limit: repository.AlertDefaultLimit, Order: repository.AlertOrderNewestFirst}
	if raw, present := values["limit"]; present {
		limit, err := strconv.Atoi(raw[0])
		if err != nil || limit < 1 || limit > repository.AlertMaxLimit {
			return repository.AlertPageQuery{}, errInvalidAlertQuery
		}
		query.Limit = limit
	}
	if raw, present := values["order"]; present {
		order := repository.AlertOrder(raw[0])
		if !order.Valid() {
			return repository.AlertPageQuery{}, errInvalidAlertQuery
		}
		query.Order = order
	}
	if raw, present := values["cursor"]; present {
		cursor, err := repository.DecodeAlertCursor(query.Order, raw[0])
		if err != nil {
			return repository.AlertPageQuery{}, errInvalidAlertQuery
		}
		query.Cursor = &cursor
	}
	return query, nil
}

// listAlerts serves one page of the persisted alert timeline.
//
// It is a read under the same viewer/admin bearer gate as every other risk route:
// 401 and 403 are answered before storage is touched, and an admitted request
// writes nothing. A malformed query - including one whose URL encoding cannot be
// read - is refused 400 before the read; a storage failure is the shared 503
// storage_unavailable, so the screen can tell "no alerts" from "the alerts could
// not be read".
//
// The recorded instant reaches the client exactly as the read canonicalised it
// (UTC), which keeps every page of the timeline in one form.
func listAlerts(store Repository) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		query, err := parseAlertListQuery(r.URL.RawQuery)
		if err != nil {
			fail(w, http.StatusBadRequest, "invalid_alert_query")
			return
		}
		page, err := store.ListAlerts(r.Context(), query)
		if err != nil {
			fail(w, http.StatusServiceUnavailable, "storage_unavailable")
			return
		}
		items := make([]alertItem, 0, len(page.Alerts))
		for _, alert := range page.Alerts {
			items = append(items, alertItem{
				ID:            alert.ID,
				ZoneID:        alert.ZoneID,
				ZoneName:      alert.ZoneName,
				PreviousLevel: alert.PreviousLevel,
				NewLevel:      alert.NewLevel,
				Threshold:     alert.Threshold,
				OccurredAt:    alert.OccurredAt,
				Demo:          alert.Demo,
			})
		}
		collection := alertCollection{Items: items}
		if page.NextCursor != "" {
			next := page.NextCursor
			collection.NextCursor = &next
		}
		respond(w, http.StatusOK, collection)
	}
}
