package repository

import (
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// alertCursorBoundary is the keyset boundary the codec tests round-trip. The
// sub-second component is deliberately microsecond precision, which is what
// timestamptz stores: the codec must survive it exactly, because a rounded
// boundary would either repeat or skip the row it was taken from.
func alertCursorBoundary() AlertCursor {
	return AlertCursor{
		OccurredAt: time.Date(2026, time.August, 1, 12, 0, 0, 123456000, time.UTC),
		ID:         "8f14e45f-ceea-467a-9c3f-1d2b4c1b0a11",
	}
}

// TestAlertCursorRoundTrip pins the wire property the pager depends on: an
// encoded cursor decodes to the exact boundary it was taken from, in the direction it
// was encoded for. Anything else would let page two overlap or skip page one.
func TestAlertCursorRoundTrip(t *testing.T) {
	for _, order := range []AlertOrder{AlertOrderNewestFirst, AlertOrderOldestFirst} {
		t.Run(string(order), func(t *testing.T) {
			boundary := alertCursorBoundary()
			encoded := EncodeAlertCursor(order, boundary)
			if encoded == "" {
				t.Fatal("EncodeAlertCursor returned no cursor")
			}
			// Opaque to the client, not confidential: the literal is the boundary
			// base64-encoded, so a stock decoder reads it and nothing here is signed.
			// What it must not do is hand a client the boundary as plain fields, and what
			// it must be is one unpadded token, so echoing it verbatim in a query is
			// unambiguous.
			if strings.Contains(encoded, boundary.ID) || strings.Contains(encoded, "2026-08-01") {
				t.Fatalf("the cursor serves its boundary as plain text: %q", encoded)
			}
			if strings.ContainsAny(encoded, "=|: ") {
				t.Fatalf("the cursor is not a single unpadded token: %q", encoded)
			}
			decoded, err := DecodeAlertCursor(order, encoded)
			if err != nil {
				t.Fatalf("DecodeAlertCursor(%q): %v", encoded, err)
			}
			if !decoded.OccurredAt.Equal(boundary.OccurredAt) {
				t.Fatalf("occurred_at = %s, want %s", decoded.OccurredAt, boundary.OccurredAt)
			}
			if decoded.ID != boundary.ID {
				t.Fatalf("id = %q, want %q", decoded.ID, boundary.ID)
			}
			// Re-encoding a decoded cursor must produce the same literal, so a
			// client can walk the timeline by echoing what it was given.
			if again := EncodeAlertCursor(order, decoded); again != encoded {
				t.Fatalf("re-encoded cursor = %q, want %q", again, encoded)
			}
		})
	}
}

// TestDecodeAlertCursorRejectsMalformedInput pins that every literal that is not
// structurally a cursor for the requested order is refused as malformed rather than
// read as "no boundary": a silently ignored cursor would answer page one to a caller
// asking for page two. The verdict is on the shape of the input, so it says nothing
// about who produced the value - see TestAlertCursorRoundTrip for what the cursor
// does and does not promise.
func TestDecodeAlertCursorRejectsMalformedInput(t *testing.T) {
	valid := EncodeAlertCursor(AlertOrderNewestFirst, alertCursorBoundary())
	payload := func(parts ...string) string {
		return base64.RawURLEncoding.EncodeToString([]byte(strings.Join(parts, "|")))
	}
	for _, tc := range []struct {
		name  string
		order AlertOrder
		raw   string
	}{
		{"empty value", AlertOrderNewestFirst, ""},
		{"not base64", AlertOrderNewestFirst, "not-base64!!"},
		{"padded base64 of a valid payload", AlertOrderNewestFirst, base64.URLEncoding.EncodeToString([]byte("v1|desc|2026-08-01T12:00:00Z|" + alertCursorBoundary().ID))},
		{"plain boundary instead of a cursor", AlertOrderNewestFirst, "2026-08-01T12:00:00Z|" + alertCursorBoundary().ID},
		{"unknown version", AlertOrderNewestFirst, payload("v2", "desc", "2026-08-01T12:00:00Z", alertCursorBoundary().ID)},
		{"three parts", AlertOrderNewestFirst, payload("v1", "desc", "2026-08-01T12:00:00Z")},
		{"five parts", AlertOrderNewestFirst, payload("v1", "desc", "2026-08-01T12:00:00Z", alertCursorBoundary().ID, "extra")},
		{"unparseable instant", AlertOrderNewestFirst, payload("v1", "desc", "yesterday", alertCursorBoundary().ID)},
		{"empty instant", AlertOrderNewestFirst, payload("v1", "desc", "", alertCursorBoundary().ID)},
		{"identifier is not a uuid", AlertOrderNewestFirst, payload("v1", "desc", "2026-08-01T12:00:00Z", "1")},
		{"unknown order", AlertOrderNewestFirst, payload("v1", "sideways", "2026-08-01T12:00:00Z", alertCursorBoundary().ID)},
		// The cursor is bound to the direction it encodes: the page it addresses in one
		// direction does not exist in the other, so reusing it after toggling the order
		// is a malformed request, not the next page.
		{"encoded for the other order", AlertOrderOldestFirst, valid},
		{"payload with a corrupted tail", AlertOrderNewestFirst, valid[:len(valid)-4] + "AAAA"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cursor, err := DecodeAlertCursor(tc.order, tc.raw)
			if err == nil {
				t.Fatalf("DecodeAlertCursor(%q) = %+v, want a malformed-cursor error", tc.raw, cursor)
			}
			if !errors.Is(err, ErrMalformedAlertCursor) {
				t.Fatalf("DecodeAlertCursor(%q) error = %v, want ErrMalformedAlertCursor", tc.raw, err)
			}
		})
	}
}

// TestDecodeAlertCursorAcceptsTheOrderItWasEncodedFor is the positive half of the
// order binding: the same literal decodes under its own direction.
func TestDecodeAlertCursorAcceptsTheOrderItWasEncodedFor(t *testing.T) {
	for _, order := range []AlertOrder{AlertOrderNewestFirst, AlertOrderOldestFirst} {
		encoded := EncodeAlertCursor(order, alertCursorBoundary())
		if _, err := DecodeAlertCursor(order, encoded); err != nil {
			t.Fatalf("DecodeAlertCursor(%q, %q): %v", order, encoded, err)
		}
	}
}

// TestAlertOrderVocabulary pins the two literals of the frozen wire and the
// direction each one selects. A third spelling would either be refused by the
// handler or silently fall back to one direction.
func TestAlertOrderVocabulary(t *testing.T) {
	if AlertOrderNewestFirst != "desc" || AlertOrderOldestFirst != "asc" {
		t.Fatalf("order vocabulary = %q, %q, want desc, asc", AlertOrderNewestFirst, AlertOrderOldestFirst)
	}
	for _, tc := range []struct {
		raw  AlertOrder
		want bool
	}{
		{AlertOrderNewestFirst, true},
		{AlertOrderOldestFirst, true},
		{"DESC", false},
		{"ascending", false},
		{"", false},
	} {
		if got := tc.raw.Valid(); got != tc.want {
			t.Fatalf("AlertOrder(%q).Valid() = %v, want %v", tc.raw, got, tc.want)
		}
	}
}

// TestAlertTimelineQueryPointsTheKeysetTheRightWay pins the two decisions the read
// makes that a wrong sign would not fail loudly on: the keyset comparison points
// past the boundary in the same direction the rows are ordered, and one row beyond
// the page is fetched to answer "is there a next page?". A mistake here would
// silently repeat or skip the boundary row in one direction only.
func TestAlertTimelineQueryPointsTheKeysetTheRightWay(t *testing.T) {
	boundary := alertCursorBoundary()
	// The statement is written with indentation, so the assertions read it as
	// single-spaced text instead of depending on that formatting.
	collapse := func(statement string) string { return strings.Join(strings.Fields(statement), " ") }

	for _, tc := range []struct {
		name      string
		order     AlertOrder
		cursor    *AlertCursor
		limit     int
		wantOrder string
		wantWhere string
		wantArgs  int
		wantFetch int
	}{
		{
			name:      "newest first continues downwards",
			order:     AlertOrderNewestFirst,
			cursor:    &boundary,
			limit:     50,
			wantOrder: "ORDER BY a.occurred_at DESC, a.id DESC",
			wantWhere: "WHERE (a.occurred_at,a.id) < ($1,$2::uuid)",
			wantArgs:  3,
			wantFetch: 51,
		},
		{
			name:      "oldest first continues upwards",
			order:     AlertOrderOldestFirst,
			cursor:    &boundary,
			limit:     2,
			wantOrder: "ORDER BY a.occurred_at ASC, a.id ASC",
			wantWhere: "WHERE (a.occurred_at,a.id) > ($1,$2::uuid)",
			wantArgs:  3,
			wantFetch: 3,
		},
		{
			name:      "the first page has no boundary predicate",
			order:     AlertOrderNewestFirst,
			limit:     100,
			wantOrder: "ORDER BY a.occurred_at DESC, a.id DESC",
			wantArgs:  1,
			wantFetch: 101,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			statement, args := alertTimelineQuery(tc.order, tc.cursor, tc.limit)
			sql := collapse(statement)
			if !strings.Contains(sql, tc.wantOrder) {
				t.Fatalf("statement does not order the way the direction requires:\n%s", sql)
			}
			if tc.wantWhere == "" {
				if strings.Contains(sql, "WHERE") {
					t.Fatalf("the first page carries a boundary predicate:\n%s", sql)
				}
			} else if !strings.Contains(sql, tc.wantWhere) {
				t.Fatalf("statement does not continue from the boundary:\n%s", sql)
			}
			// The label and the provenance are joins, not stored columns: reading
			// only risk_alerts would lose both.
			for _, join := range []string{"LEFT JOIN zones z ON z.code=a.zone_id", "LEFT JOIN batches b ON b.id=a.batch_id"} {
				if !strings.Contains(sql, join) {
					t.Fatalf("statement is missing the join %q:\n%s", join, sql)
				}
			}
			if len(args) != tc.wantArgs {
				t.Fatalf("arguments = %d (%v), want %d", len(args), args, tc.wantArgs)
			}
			if last := args[len(args)-1]; last != tc.wantFetch {
				t.Fatalf("fetched rows = %v, want %d (one beyond the page)", last, tc.wantFetch)
			}
			if tc.cursor != nil {
				if instant, ok := args[0].(time.Time); !ok || !instant.Equal(tc.cursor.OccurredAt) {
					t.Fatalf("boundary instant argument = %v, want %s", args[0], tc.cursor.OccurredAt)
				}
				if id, ok := args[1].(string); !ok || id != tc.cursor.ID {
					t.Fatalf("boundary identifier argument = %v, want %s", args[1], tc.cursor.ID)
				}
			}
		})
	}
}

// TestAlertCursorOrderNormalisesTheBoundary pins that the boundary is stored in
// UTC: a cursor taken from a UTC instant must decode to the same instant even if
// the encoder was handed another location, because the keyset comparison is
// instant-based and not textual.
func TestAlertCursorOrderNormalisesTheBoundary(t *testing.T) {
	zone := time.FixedZone("CLT", -3*60*60)
	boundary := AlertCursor{OccurredAt: time.Date(2026, time.August, 1, 9, 0, 0, 0, zone), ID: uuid.NewString()}
	decoded, err := DecodeAlertCursor(AlertOrderNewestFirst, EncodeAlertCursor(AlertOrderNewestFirst, boundary))
	if err != nil {
		t.Fatal(err)
	}
	if !decoded.OccurredAt.Equal(boundary.OccurredAt) {
		t.Fatalf("decoded instant = %s, want the same instant as %s", decoded.OccurredAt, boundary.OccurredAt)
	}
	if decoded.OccurredAt.Location() != time.UTC {
		t.Fatalf("decoded instant keeps location %s, want UTC", decoded.OccurredAt.Location())
	}
}
