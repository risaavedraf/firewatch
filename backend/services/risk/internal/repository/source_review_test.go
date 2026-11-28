package repository

import (
	"strings"
	"testing"
	"time"
)

// The decision vocabulary is closed: the two literals the ratified decision names,
// and nothing else. A third decision is refused before storage, because a stored
// decision is what the page and the audit trail consist of.
func TestSourceReviewDecisionIsClosed(t *testing.T) {
	for _, decision := range []SourceReviewDecision{SourceReviewIncorporated, SourceReviewAcknowledged} {
		if !decision.Valid() {
			t.Fatalf("%q is not valid", decision)
		}
	}
	for _, decision := range []SourceReviewDecision{"", "Incorporated", "approved", "incorporated ", "rejected"} {
		if decision.Valid() {
			t.Fatalf("%q was accepted", decision)
		}
	}
}

// Every refusal the handler answers with its own 422/404 code is stated here as a
// pure rule, so the transport and the store cannot disagree about what is storable.
func TestSourceReviewRequestValidation(t *testing.T) {
	at := time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)
	valid := SourceReviewRequest{SourceID: "fixture-sample", Decision: SourceReviewIncorporated, ReviewedBy: "subject", ReviewedAt: at}
	if err := valid.Validate(); err != nil {
		t.Fatalf("a valid request was refused: %v", err)
	}
	withNote := valid
	withNote.Note = strings.Repeat("á", 500)
	if err := withNote.Validate(); err != nil {
		t.Fatalf("a 500 character note was refused: %v", err)
	}
	tooLong := valid
	tooLong.Note = strings.Repeat("á", 501)
	if err := tooLong.Validate(); err != ErrSourceReviewNoteTooLong {
		t.Fatalf("a 501 character note answered %v, want ErrSourceReviewNoteTooLong", err)
	}
	unknown := valid
	unknown.Decision = "approved"
	if err := unknown.Validate(); err != ErrUnknownSourceReviewDecision {
		t.Fatalf("an unknown decision answered %v, want ErrUnknownSourceReviewDecision", err)
	}
	for _, blank := range []string{"", " ", "\t\n"} {
		missingSource := valid
		missingSource.SourceID = blank
		if err := missingSource.Validate(); err != ErrSourceReviewSourceRequired {
			t.Fatalf("a %q source id answered %v", blank, err)
		}
		missingActor := valid
		missingActor.ReviewedBy = blank
		if err := missingActor.Validate(); err != ErrSourceReviewActorRequired {
			t.Fatalf("a %q actor answered %v", blank, err)
		}
	}
	noInstant := valid
	noInstant.ReviewedAt = time.Time{}
	if err := noInstant.Validate(); err != ErrSourceReviewInstantRequired {
		t.Fatalf("an absent instant answered %v", err)
	}
}

// The instant the row records is canonicalised to UTC, exactly as the wire serves
// it: the same mark is not two different answers depending on the host's zone.
func TestSourceReviewNormalisesTheInstant(t *testing.T) {
	zone := time.FixedZone("CLT", -4*60*60)
	review := SourceReview{ReviewedAt: time.Date(2026, 11, 20, 12, 0, 0, 0, zone)}
	if got := review.Normalised().ReviewedAt; got.Location() != time.UTC || !got.Equal(review.ReviewedAt) {
		t.Fatalf("normalised instant = %s, want the same instant in UTC", got)
	}
}

// The latest read must break timestamp ties by INSERTION ORDER, not by the random
// identifier: two reviews recorded in the same instant have to answer the same
// "latest" on every host and every replay, and a UUID carries no order at all. The
// monotonic column is what makes the tie-break reproducible; the query and the append
// are pinned together so a future edit cannot drop one half.
func TestLatestSourceReviewsBreaksTiesByInsertionOrder(t *testing.T) {
	if !strings.Contains(sourceReviewsLatestSQL, "DISTINCT ON (source_id)") {
		t.Fatalf("the latest read does not keep one row per source: %s", sourceReviewsLatestSQL)
	}
	if !strings.Contains(sourceReviewsLatestSQL, "ORDER BY source_id, reviewed_at DESC, review_seq DESC") {
		t.Fatalf("the latest read does not break ties by insertion order: %s", sourceReviewsLatestSQL)
	}
	// The identifier is a random uuid: ordering by it would make the answer depend on
	// a value nobody chose.
	if strings.Contains(sourceReviewsLatestSQL, "id DESC") {
		t.Fatalf("the latest read still breaks ties by the random identifier: %s", sourceReviewsLatestSQL)
	}
	// The append leaves the monotonic value to the database, so a caller can neither
	// supply nor rewrite the order the trace is read in.
	if strings.Contains(sourceReviewInsertSQL, "review_seq") {
		t.Fatalf("the append enumerates the monotonic column: %s", sourceReviewInsertSQL)
	}
}
