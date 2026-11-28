package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"firewatch.local/risk/internal/cycle"
	"firewatch.local/risk/internal/quality"
	"firewatch.local/risk/internal/repository"
)

// SourceReviewStore is the handler's view of the persisted review resource. It is
// narrow on purpose: the sources route reads the newest review of every source and
// the review route appends one, and neither can reach any other storage method.
type SourceReviewStore interface {
	// LatestSourceReviews answers the newest review of every source that has one,
	// keyed by source id. A source with no review is absent from the map, which the
	// route serves as the explicit null.
	LatestSourceReviews(ctx context.Context) (map[string]repository.SourceReview, error)
	// RecordSourceReview appends one review and answers the row it wrote. A
	// refused request is an error and stores nothing.
	RecordSourceReview(ctx context.Context, request repository.SourceReviewRequest) (repository.SourceReview, error)
}

// SourceReviewAuditor is the optional audit seam of the review write. It is a
// separate interface because it is a separate concern: a repository that owns the
// review rows does not have to own the audit trail, and the process that wires no
// auditor still records the review — the append-only row is the trace.
//
// A wired auditor is called once per persisted review. Its failure is reported as
// review_audit_unavailable, and it never undoes the row: the decision is already
// stored, so answering "nothing was written" would be false.
type SourceReviewAuditor interface {
	RecordSourceReviewAudit(ctx context.Context, review repository.SourceReview) error
}

// maxSourceReviewBody bounds the review document. The document has two short
// members, so the cap is the smallest value that fits every valid spelling of a
// 500 character note; a body that needs more is not this resource's request.
const maxSourceReviewBody = 4 << 10

// sourceReviewWire is the review document. It carries the actor the token proved,
// because the caller is entitled to see who decided and when; it has no field the
// client may set.
type sourceReviewWire struct {
	SourceID   string    `json:"source_id"`
	Decision   string    `json:"decision"`
	Note       string    `json:"note"`
	ReviewedBy string    `json:"reviewed_by"`
	ReviewedAt time.Time `json:"reviewed_at"`
}

// newSourceReviewWire maps one stored review to the frozen wire. The instant is
// canonicalised to UTC so the same decision is served in one form across hosts.
func newSourceReviewWire(review repository.SourceReview) sourceReviewWire {
	return sourceReviewWire{
		SourceID:   review.SourceID,
		Decision:   string(review.Decision),
		Note:       review.Note,
		ReviewedBy: review.ReviewedBy,
		ReviewedAt: review.ReviewedAt.UTC(),
	}
}

// sourceReviewRequestWire is the accepted body: exactly two members. Unknown
// members are refused by the decoder, which is what makes a request-supplied actor
// impossible: there is no field for one, and the decoder refuses to ignore it.
type sourceReviewRequestWire struct {
	Decision string `json:"decision"`
	Note     string `json:"note"`
}

// reviewStoreFrom derives the review seam from the repository the process wired.
// A repository that does not implement it is a process with no review storage: the
// read serves no review and the write fails closed instead of implying one.
func reviewStoreFrom(store Repository) SourceReviewStore {
	reviews, _ := store.(SourceReviewStore)
	return reviews
}

// reviewAuditorFrom derives the optional audit seam, for the same reason: whether
// an audit trail is wired is a property of the repository, not of the route.
func reviewAuditorFrom(store Repository) SourceReviewAuditor {
	auditor, _ := store.(SourceReviewAuditor)
	return auditor
}

// sourceEntry is one source of the read: the cycle freshness it always carried,
// plus the findings derived from the evidence and its latest review.
//
// Review is a pointer without omitempty, so "no review recorded" is the explicit
// null the contract documents instead of a member that silently disappears.
type sourceEntry struct {
	cycle.SourceStatus
	QualityFindings []quality.Finding `json:"quality_findings"`
	Review          *sourceReviewWire `json:"review"`
}

// newSourceEntry joins one source's freshness with the evidence the caller holds
// about THAT source. The evidence is built by the caller and never inherited here:
// the findings are derived from served facts, so a stored finding can never disagree
// with the evidence that produced it, and a fact about one source can never be
// painted on another.
func newSourceEntry(
	status cycle.SourceStatus,
	evidence quality.Evidence,
	reviews map[string]repository.SourceReview,
) sourceEntry {
	entry := sourceEntry{SourceStatus: status, QualityFindings: quality.Evaluate(evidence)}
	if review, ok := reviews[status.SourceID]; ok {
		wire := newSourceReviewWire(review)
		entry.Review = &wire
	}
	return entry
}

// sourceReview serves POST /v1/risk/sources/{source_id}/review. It is wrapped in
// requireAdmin by the router, so reaching it already means the caller holds the
// admin role; the actor is still taken from the verified token and from nowhere
// else, because a subject the caller can name is not an identity.
//
// The order of the gates is deliberate and every one of them answers before
// anything is appended: an unknown source is 404, a body that cannot be honoured is
// 400, a decision outside the closed vocabulary is 422 and an oversized note is 422 -
// and all of those answer BEFORE the capability gate that reports missing review
// storage. A caller that named a source nobody serves must never be told the server
// lacks review storage, because that answer would describe a capability the request
// never reached; conversely a well-formed review of a served source is the only shape
// that can discover the store is absent. A refusal therefore never reaches storage.
func sourceReview(
	reviews SourceReviewStore,
	auditor SourceReviewAuditor,
	provider DescriptorProvider,
	runner CycleRunner,
	now func() time.Time,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		subject, ok := subjectFrom(r.Context())
		if !ok {
			fail(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		sourceID := strings.TrimSpace(r.PathValue("source_id"))
		if sourceID == "" {
			fail(w, http.StatusNotFound, "source_not_found")
			return
		}
		// The source gate answers before anything else that could describe the
		// deployment: an identifier nobody serves is a 404 whatever else is wired.
		if !knownSource(sourceID, provider, runner) {
			fail(w, http.StatusNotFound, "source_not_found")
			return
		}
		// The body gates answer before the capability gate for the same reason: a
		// malformed or unhonourable body is refused as such, not as a missing feature.
		request, status, code := decodeSourceReview(w, r)
		if status != 0 {
			fail(w, status, code)
			return
		}
		// Only a well-formed review of a served source can discover that this process
		// wired no review storage.
		if reviews == nil {
			fail(w, http.StatusServiceUnavailable, "review_store_unavailable")
			return
		}
		review, err := reviews.RecordSourceReview(r.Context(), repository.SourceReviewRequest{
			SourceID:   sourceID,
			Decision:   repository.SourceReviewDecision(request.Decision),
			Note:       request.Note,
			ReviewedBy: subject,
			ReviewedAt: now().UTC(),
		})
		switch {
		case errors.Is(err, repository.ErrUnknownSourceReviewDecision):
			fail(w, http.StatusUnprocessableEntity, "invalid_decision")
			return
		case errors.Is(err, repository.ErrSourceReviewNoteTooLong):
			fail(w, http.StatusUnprocessableEntity, "invalid_note")
			return
		case err != nil:
			fail(w, http.StatusServiceUnavailable, "storage_unavailable")
			return
		}
		if auditor != nil {
			if err := auditor.RecordSourceReviewAudit(r.Context(), review); err != nil {
				// The row is already stored: the failure is the announcement, not the
				// decision, and the answer says so instead of implying nothing happened.
				fail(w, http.StatusServiceUnavailable, "review_audit_unavailable")
				return
			}
		}
		respond(w, http.StatusOK, newSourceReviewWire(review))
	}
}

// knownSource reports whether sourceID names a source this deployment actually
// serves: the active publisher provider, or a source the cycle reports. A value
// that names neither is a review of nothing, so it is refused 404 instead of
// stored under an identifier nobody can read back.
func knownSource(sourceID string, provider DescriptorProvider, runner CycleRunner) bool {
	if provider != nil && provider.Describe().ID == sourceID {
		return true
	}
	if runner == nil {
		return false
	}
	for _, status := range runner.Statuses() {
		if status.SourceID == sourceID {
			return true
		}
	}
	return false
}

// decodeSourceReview reads exactly one JSON object with exactly the two members
// this resource declares. It answers a zero status on success and the refusal the
// caller must send otherwise, so every malformed shape is refused with one code and
// reaches storage as nothing.
func decodeSourceReview(w http.ResponseWriter, r *http.Request) (sourceReviewRequestWire, int, string) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxSourceReviewBody))
	if err != nil {
		return sourceReviewRequestWire{}, http.StatusBadRequest, "invalid_review_request"
	}
	request, ok := parseSourceReview(body)
	if !ok {
		return sourceReviewRequestWire{}, http.StatusBadRequest, "invalid_review_request"
	}
	decision := repository.SourceReviewDecision(request.Decision)
	if !decision.Valid() {
		return sourceReviewRequestWire{}, http.StatusUnprocessableEntity, "invalid_decision"
	}
	if utf8.RuneCountInString(request.Note) > repository.SourceReviewNoteLimit {
		return sourceReviewRequestWire{}, http.StatusUnprocessableEntity, "invalid_note"
	}
	return request, 0, ""
}

// parseSourceReview accepts exactly one JSON object whose members are a subset of
// {decision, note}, and refuses every other shape: another member, a repeated one,
// a document that is not an object, a malformed document, an empty body, a trailing
// second document, an explicit null and a value whose type is not the documented
// string. A repeated member is refused rather than resolved because the last one
// winning would make the accepted body depend on an encoding detail, and an
// explicit null is refused because Go would fold it into the empty string and the
// stored row would look like an omitted note.
func parseSourceReview(body []byte) (sourceReviewRequestWire, bool) {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return sourceReviewRequestWire{}, false
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	start, err := decoder.Token()
	if err != nil || start != json.Delim('{') {
		return sourceReviewRequestWire{}, false
	}
	request := sourceReviewRequestWire{}
	seen := map[string]bool{}
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			return sourceReviewRequestWire{}, false
		}
		name, ok := key.(string)
		if !ok || seen[name] {
			return sourceReviewRequestWire{}, false
		}
		seen[name] = true
		switch name {
		case "decision":
			if err := decoder.Decode(&request.Decision); err != nil {
				return sourceReviewRequestWire{}, false
			}
		case "note":
			// JSON null is not the documented optional string. Go would decode it as
			// "" and the row would look like an omitted note, so the explicit null is
			// refused here instead of being read as an absence the client never sent.
			var rawNote json.RawMessage
			if err := decoder.Decode(&rawNote); err != nil {
				return sourceReviewRequestWire{}, false
			}
			if bytes.Equal(bytes.TrimSpace(rawNote), []byte("null")) {
				return sourceReviewRequestWire{}, false
			}
			if err := json.Unmarshal(rawNote, &request.Note); err != nil {
				return sourceReviewRequestWire{}, false
			}
		default:
			return sourceReviewRequestWire{}, false
		}
	}
	if end, err := decoder.Token(); err != nil || end != json.Delim('}') {
		return sourceReviewRequestWire{}, false
	}
	// A second JSON value in the same body is not this resource's request either.
	if err := decoder.Decode(new(json.RawMessage)); err != io.EOF {
		return sourceReviewRequestWire{}, false
	}
	return request, true
}
