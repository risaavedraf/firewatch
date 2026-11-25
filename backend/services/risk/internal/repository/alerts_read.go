package repository

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

// AlertDefaultLimit is the page size served when the caller asks for none, and
// AlertMaxLimit is the largest page this read will answer. Both are the frozen
// wire's bounds: a caller that asks for more is refused by the handler rather
// than silently served a smaller page pointing at a cursor it did not request.
const (
	AlertDefaultLimit = 50
	AlertMaxLimit     = 100
)

// AlertOrder is the direction of the alert timeline read: newest first, which is
// the default a notification screen wants, or oldest first for walking history.
type AlertOrder string

const (
	// AlertOrderNewestFirst serves the most recent transitions first (desc).
	AlertOrderNewestFirst AlertOrder = "desc"
	// AlertOrderOldestFirst serves the oldest stored transitions first (asc).
	AlertOrderOldestFirst AlertOrder = "asc"
)

// Valid reports whether the order is one of the two frozen literals. It exists so
// the handler and this read agree on the vocabulary instead of each comparing to
// its own strings.
func (o AlertOrder) Valid() bool {
	return o == AlertOrderNewestFirst || o == AlertOrderOldestFirst
}

// Alert is one persisted level change of one zone, as the timeline read serves it.
//
// It is the PM-07 row joined to the two references it does not store itself: the
// current catalogue label of its zone, and the demo flag of the batch that
// produced it. ZoneName is a pointer because the catalogue is a live table: an
// alert is evidence that a transition happened, so a label this service cannot
// read is served as null rather than by dropping the alert or inventing a name.
type Alert struct {
	ID            string
	ZoneID        string
	ZoneName      *string
	PreviousLevel string
	NewLevel      string
	Threshold     int
	OccurredAt    time.Time
	Demo          bool
}

// AlertCursor is a keyset boundary: one (occurred_at, id) pair that names the
// last row a page served. The identifier is the deterministic tie-break, so two
// alerts sharing an instant cannot make a page boundary repeat or skip a row.
type AlertCursor struct {
	OccurredAt time.Time
	ID         string
}

// AlertPageQuery is one page request. A nil Cursor asks for the first page in the
// selected direction; a non-nil one continues from the boundary it names. Limit
// is bounded by AlertDefaultLimit/AlertMaxLimit, and Order outside the frozen
// vocabulary falls back to newest first - the handler refuses such a request
// before it gets here, so the fallback only keeps a direct caller honest.
type AlertPageQuery struct {
	Limit  int
	Order  AlertOrder
	Cursor *AlertCursor
}

// AlertPage is one page of the timeline. Alerts is never nil, so an empty
// timeline serialises as an empty list. NextCursor is empty exactly when this page
// reached the end; otherwise it is the opaque cursor of the next page in the same
// order.
type AlertPage struct {
	Alerts     []Alert
	NextCursor string
}

// ErrMalformedAlertCursor reports a cursor literal that is not structurally a cursor
// for the requested order: empty, undecodable, of the wrong shape or version, carrying
// an unparseable instant or identifier, or encoded for the other direction. It is a
// deterministic verdict on the input, not a storage failure, so the handler answers
// 400 without reading anything.
//
// The verdict is structural. The cursor is opaque to clients in the API sense - they
// echo it verbatim and must not interpret it - but it is neither secret nor signed:
// anyone can decode the literal into a boundary, so nothing here proves this service
// produced it. The check exists so an unusable or cross-direction literal is refused
// instead of being read as "start from the beginning"; it is not tamper detection.
var ErrMalformedAlertCursor = errors.New("malformed alert cursor")

// alertCursorVersion is the first field of the encoded cursor. It is written so a
// future boundary shape can be introduced without the old literal being read as
// the new one.
const alertCursorVersion = "v1"

// EncodeAlertCursor renders a keyset boundary as the opaque cursor a client echoes
// back. The instant is written in UTC with nanosecond precision, which is more
// than timestamptz stores, so the decode is exact and never rounds a boundary onto
// its neighbour.
//
// The order is part of the payload on purpose: the page a boundary addresses
// depends on the direction, so a cursor is only meaningful for the direction it
// encodes. The encoding is plain base64, not a signature: opaque here means
// unstructured to the client, not confidential. See DecodeAlertCursor.
func EncodeAlertCursor(order AlertOrder, cursor AlertCursor) string {
	payload := strings.Join([]string{
		alertCursorVersion,
		string(order),
		cursor.OccurredAt.UTC().Format(time.RFC3339Nano),
		cursor.ID,
	}, "|")
	return base64.RawURLEncoding.EncodeToString([]byte(payload))
}

// DecodeAlertCursor reads a cursor literal back, refusing anything that is not
// structurally a cursor for this order.
//
// Every refusal is the same sentinel: the caller needs to know "this is not a cursor
// I can continue from", not which byte was wrong, and answering 400 for all of them
// is what keeps an unusable value from being read as "start over". The check is
// structural and order-bound: no signing key, no server-side record and no expiry
// list is consulted, so it validates the shape of the input rather than its origin.
// The returned boundary is canonicalised to UTC and to the canonical uuid form so
// the keyset comparison is on instants and identifiers, not on their spelling.
func DecodeAlertCursor(order AlertOrder, raw string) (AlertCursor, error) {
	if raw == "" {
		return AlertCursor{}, ErrMalformedAlertCursor
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return AlertCursor{}, ErrMalformedAlertCursor
	}
	parts := strings.Split(string(decoded), "|")
	if len(parts) != 4 {
		return AlertCursor{}, ErrMalformedAlertCursor
	}
	if parts[0] != alertCursorVersion {
		return AlertCursor{}, ErrMalformedAlertCursor
	}
	// A cursor encoded for the other direction names a page that does not exist in
	// this one, so it is malformed input rather than a boundary to continue from.
	if AlertOrder(parts[1]) != order || !order.Valid() {
		return AlertCursor{}, ErrMalformedAlertCursor
	}
	occurredAt, err := time.Parse(time.RFC3339Nano, parts[2])
	if err != nil {
		return AlertCursor{}, ErrMalformedAlertCursor
	}
	id, err := uuid.Parse(parts[3])
	if err != nil {
		return AlertCursor{}, ErrMalformedAlertCursor
	}
	return AlertCursor{OccurredAt: occurredAt.UTC(), ID: id.String()}, nil
}

// alertTimelineColumns is the projection of the alert timeline read: the stored
// transition, the live catalogue label of its zone and the demo flag of the batch
// that caused it. Both joins are LEFT so a missing reference cannot silently drop
// evidence; see ListAlerts for how each one is interpreted.
const alertTimelineColumns = `a.id::text,a.zone_id,z.name,a.previous_level,a.new_level,a.threshold,a.occurred_at,b.demo`

// alertTimelineQuery builds the statement one page of the timeline is read with,
// and the arguments it is read with.
//
// It is split out of ListAlerts so the two decisions a database is not needed to
// verify are testable on their own: which way the keyset comparison points, and
// that one row beyond the page is fetched to answer "is there a next page?". A
// comparison with the wrong sign would not fail loudly - it would repeat or skip
// the boundary row - so it is pinned by a test rather than trusted.
//
// The direction and comparison are selected from the two frozen order literals, so
// neither reaches the statement as caller-supplied text.
func alertTimelineQuery(order AlertOrder, cursor *AlertCursor, limit int) (string, []any) {
	direction, comparison := "DESC", "<"
	if order == AlertOrderOldestFirst {
		direction, comparison = "ASC", ">"
	}
	statement := `SELECT ` + alertTimelineColumns + `
		FROM risk_alerts a
		LEFT JOIN zones z ON z.code=a.zone_id
		LEFT JOIN batches b ON b.id=a.batch_id`
	args := make([]any, 0, 3)
	if cursor != nil {
		// A row comparison, not two ANDed predicates: the boundary is one point on
		// the (occurred_at, id) axis, so a row matching only half of it is not
		// beyond the boundary.
		statement += ` WHERE (a.occurred_at,a.id) ` + comparison + ` ($1,$2::uuid)`
		args = append(args, cursor.OccurredAt.UTC(), cursor.ID)
	}
	statement += ` ORDER BY a.occurred_at ` + direction + `, a.id ` + direction + `
		LIMIT $` + strconv.Itoa(len(args)+1)
	// One extra row answers "is there a next page?" without a count or a second
	// query; ListAlerts drops it from the page and never builds a cursor from it.
	args = append(args, limit+1)
	return statement, args
}

// ListAlerts reads one page of the persisted alert timeline, in the requested
// direction, with a stable keyset boundary.
//
// The order is (occurred_at, id) in the selected direction, which is exactly the
// index 017_risk_alerts.sql created: the identifier is the tie-break that keeps
// two alerts sharing an instant from making a page boundary repeat or skip a row.
// The boundary is applied as a row comparison, so the database seeks instead of
// counting offsets - page N costs the same as page one, and a row inserted
// between two pages cannot shift the boundary the client already holds.
//
// One extra row is fetched to answer "is there a next page?" without a second
// query or a count. The next cursor is taken from the last row this page actually
// served, never from the extra one, so continuing from it cannot skip that row.
//
// The zone label is joined rather than stored: it is current catalogue data, not
// part of the historical transition, so a nil label means the catalogue no longer
// names the zone and the alert is served with null instead of being hidden or
// given an invented name. The originating batch, in contrast, is provenance the
// alert is meaningless without, so an alert whose batch row is missing is
// reported as an error instead of being served with an invented demo flag.
func (s Store) ListAlerts(ctx context.Context, query AlertPageQuery) (AlertPage, error) {
	order := query.Order
	if !order.Valid() {
		order = AlertOrderNewestFirst
	}
	limit := query.Limit
	if limit < 1 {
		limit = AlertDefaultLimit
	}
	if limit > AlertMaxLimit {
		limit = AlertMaxLimit
	}
	// direction and comparison are chosen from the two frozen literals above, so
	// neither reaches the statement as caller-supplied text.
	statement, args := alertTimelineQuery(order, query.Cursor, limit)

	rows, err := s.DB.Query(ctx, statement, args...)
	if err != nil {
		return AlertPage{}, err
	}
	defer rows.Close()

	alerts := make([]Alert, 0, limit)
	for rows.Next() {
		var alert Alert
		var demo *bool
		if err := rows.Scan(&alert.ID, &alert.ZoneID, &alert.ZoneName, &alert.PreviousLevel, &alert.NewLevel, &alert.Threshold, &alert.OccurredAt, &demo); err != nil {
			return AlertPage{}, err
		}
		// The batch join is LEFT only so a missing reference reaches this check
		// instead of disappearing from the answer: an alert with no stored batch
		// cannot state whether its input was synthetic, and serving it as
		// "demo": false would claim real observations nobody recorded. It is
		// therefore a fail-closed error, never an invented flag.
		if demo == nil {
			return AlertPage{}, fmt.Errorf("alert %s names a batch that is not stored", alert.ID)
		}
		alert.Demo = *demo
		// The instant is canonicalised to UTC so every page of the timeline states
		// the same instant in the same form, whatever the connection's location.
		alert.OccurredAt = alert.OccurredAt.UTC()
		alerts = append(alerts, alert)
	}
	if err := rows.Err(); err != nil {
		return AlertPage{}, err
	}
	page := AlertPage{Alerts: alerts}
	if len(alerts) > limit {
		// The cap is repeated so the extra row fetched to answer "is there a next
		// page?" cannot reappear through a later append to the served page.
		page.Alerts = alerts[:limit:limit]
		last := page.Alerts[limit-1]
		page.NextCursor = EncodeAlertCursor(order, AlertCursor{OccurredAt: last.OccurredAt, ID: last.ID})
	}
	return page, nil
}
