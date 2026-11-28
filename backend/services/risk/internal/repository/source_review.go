package repository

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
)

// The two decisions of the source review resource, as the wire names them. The
// vocabulary is closed: a third spelling of "approved" is refused before storage,
// because the stored decision is what the page and the trace consist of.
const (
	SourceReviewIncorporated = "incorporated"
	SourceReviewAcknowledged = "acknowledged"
)

// SourceReviewDecision is one decision an admin may record about a source.
type SourceReviewDecision string

// The two literal decisions, typed.
const (
	SourceReviewDecisionIncorporated SourceReviewDecision = SourceReviewIncorporated
	SourceReviewDecisionAcknowledged SourceReviewDecision = SourceReviewAcknowledged
)

// Valid reports whether the decision is one of the two closed literals.
func (d SourceReviewDecision) Valid() bool {
	return d == SourceReviewDecisionIncorporated || d == SourceReviewDecisionAcknowledged
}

// SourceReviewNoteLimit is the longest note the resource stores, in characters.
// The schema states the same bound, so a note this package accepts cannot fail the
// INSERT on a length the database refuses.
const SourceReviewNoteLimit = 500

var (
	// ErrUnknownSourceReviewDecision means the requested decision is not one of the
	// two literals. It is refused 422 by the route instead of becoming a row.
	ErrUnknownSourceReviewDecision = errors.New("unknown source review decision")
	// ErrSourceReviewNoteTooLong means the note exceeds the documented bound.
	ErrSourceReviewNoteTooLong = errors.New("source review note too long")
	// ErrSourceReviewSourceRequired means the review names no source.
	ErrSourceReviewSourceRequired = errors.New("source review source id required")
	// ErrSourceReviewActorRequired means the review names no verified actor. An
	// actor the client can name is not an identity, so a blank one is not a row.
	ErrSourceReviewActorRequired = errors.New("source review actor required")
	// ErrSourceReviewInstantRequired means the review carries no instant. The
	// handler sets it from the server clock; an absent one is a composition defect.
	ErrSourceReviewInstantRequired = errors.New("source review instant required")
)

// SourceReview is one stored review: the decision an operator recorded about one
// source, with the actor the API gate proved and the instant the server set.
//
// Note is empty when the operator wrote none: the note is optional, and an empty
// note is the absence of one rather than a placeholder.
type SourceReview struct {
	SourceID   string
	Decision   SourceReviewDecision
	Note       string
	ReviewedBy string
	ReviewedAt time.Time
}

// SourceReviewRequest is one review the caller asked to append. It carries the
// same members as the stored row because the store is what decides the row; the
// handler builds it from the verified request and never from the body alone.
type SourceReviewRequest struct {
	SourceID   string
	Decision   SourceReviewDecision
	Note       string
	ReviewedBy string
	ReviewedAt time.Time
}

// Validate states what is storable, so the transport and the store cannot disagree
// about which requests are appendable.
func (r SourceReviewRequest) Validate() error {
	if strings.TrimSpace(r.SourceID) == "" {
		return ErrSourceReviewSourceRequired
	}
	if !r.Decision.Valid() {
		return ErrUnknownSourceReviewDecision
	}
	if len([]rune(r.Note)) > SourceReviewNoteLimit {
		return ErrSourceReviewNoteTooLong
	}
	if strings.TrimSpace(r.ReviewedBy) == "" {
		return ErrSourceReviewActorRequired
	}
	if r.ReviewedAt.IsZero() {
		return ErrSourceReviewInstantRequired
	}
	return nil
}

// Normalised returns the review with its instant in UTC, which is the form the
// wire serves and the form stored: the same review is never two different answers
// depending on the host's zone.
func (r SourceReview) Normalised() SourceReview {
	r.ReviewedAt = r.ReviewedAt.UTC()
	return r
}

// sourceReviewInsertSQL appends one review. The table is append-only, so a later
// decision is a new row and the previous ones stay readable as the trace.
const sourceReviewInsertSQL = `INSERT INTO source_quality_reviews(id, source_id, decision, note, reviewed_by, reviewed_at)
	VALUES($1,$2,$3,$4,$5,$6)`

// RecordSourceReview appends one review and answers the row it wrote.
//
// The instant is the caller's, not the database's default: the answer the route
// serves has to be the instant that was stored, and a default would make the two
// differ by the microseconds the statement took.
func (s Store) RecordSourceReview(ctx context.Context, request SourceReviewRequest) (SourceReview, error) {
	if err := request.Validate(); err != nil {
		return SourceReview{}, err
	}
	review := SourceReview{
		SourceID:   request.SourceID,
		Decision:   request.Decision,
		Note:       request.Note,
		ReviewedBy: request.ReviewedBy,
		ReviewedAt: request.ReviewedAt.UTC(),
	}
	if _, err := s.DB.Exec(ctx, sourceReviewInsertSQL, uuid.NewString(), review.SourceID, review.Decision, review.Note, review.ReviewedBy, review.ReviewedAt); err != nil {
		return SourceReview{}, err
	}
	return review, nil
}

// sourceReviewsLatestSQL answers the newest review of every source in one read.
// DISTINCT ON keeps it one row per source; the instant decides first and review_seq,
// the database-drawn append order, breaks a tie deterministically. The identifier is
// NOT the tie-break: it is a random uuid, so ordering by it would make "the latest
// review" depend on a value nobody chose and every reader would have to guess.
const sourceReviewsLatestSQL = `SELECT DISTINCT ON (source_id) source_id, decision, note, reviewed_by, reviewed_at
	FROM source_quality_reviews
	ORDER BY source_id, reviewed_at DESC, review_seq DESC`

// LatestSourceReviews returns the newest review of every source that has one,
// keyed by source id. A source with no review is absent from the map, which the
// route serves as the explicit null: an absence is not an empty review.
func (s Store) LatestSourceReviews(ctx context.Context) (map[string]SourceReview, error) {
	rows, err := s.DB.Query(ctx, sourceReviewsLatestSQL)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	reviews := make(map[string]SourceReview, 0)
	for rows.Next() {
		var review SourceReview
		if err := rows.Scan(&review.SourceID, &review.Decision, &review.Note, &review.ReviewedBy, &review.ReviewedAt); err != nil {
			return nil, err
		}
		reviews[review.SourceID] = review.Normalised()
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return reviews, nil
}
