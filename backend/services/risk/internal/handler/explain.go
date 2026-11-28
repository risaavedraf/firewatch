package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"

	"firewatch.local/risk/internal/classify"
	"firewatch.local/risk/internal/explain"
	"firewatch.local/risk/internal/repository"
)

// explainBodyLimit bounds the request document. The accepted body is a zone code, a
// topic and an optional bounded question, so a kilobyte would be generous; the bound
// exists so a caller cannot make the service parse an arbitrarily large document on a
// route that reads one row and writes nothing.
const explainBodyLimit = 8192

// explainWindow is the number of published batches the route reads: the newest one,
// which is the answer's only source, plus the immediately previous one, which is what
// TopicTrend compares against. One bounded read answers both.
const explainWindow = 2

// verifyExplainOutput is the GRD-I2 verifier the route runs before writing a response.
//
// It is a package variable rather than a direct call so a test can force a refusal and
// prove the route fails closed instead of serving an answer it could not ground. It is
// never reassigned in production code.
var verifyExplainOutput = explain.VerifyOutputGrounding

// explainErrUnreadableFactors means the stored factor payload is not the list the
// publication path writes. It is a storage defect, so it is answered 503 instead of
// being flattened into "this zone has no readings": the second would be a claim about
// the zone that nobody observed.
var explainErrUnreadableFactors = errors.New("the stored factors are not readable")

// explain serves POST /v1/risk/explain: the PM-17 explanatory assistant.
//
// The order of the decisions is the security design, so it is written down here:
//
//  1. the media type and the document are decided first, because neither is a
//     statement about scope;
//  2. GRD-I1 runs before any storage read, so a request outside the five topics, the
//     38 catalogue communes or the permitted question vocabulary cannot reach the
//     repository at all;
//  3. exactly one bounded read fetches the requested commune's newest published
//     batches, and a commune with nothing published is the documented empty state;
//  4. the answer is composed locally with no clock, no network and no language model;
//  5. GRD-I2 verifies the composed answer against the batch it came from and fails
//     closed. Nothing is written to storage at any point.
//
// It is mounted inside the same Authorize gate as its sibling reads, so viewer and
// admin are admitted and 401/403 are answered before a body is read.
func explainAnswer(store Repository) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || media != "application/json" {
			fail(w, http.StatusUnsupportedMediaType, "json_required")
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, explainBodyLimit))
		if err != nil {
			fail(w, http.StatusBadRequest, "invalid_explain")
			return
		}
		input, err := parseExplainRequest(body)
		if err != nil {
			fail(w, http.StatusBadRequest, "invalid_explain")
			return
		}

		// GRD-I1. The catalogue is compiled in, so this decision costs no read.
		catalogue, err := explain.DefaultCatalogue()
		if err != nil {
			fail(w, http.StatusServiceUnavailable, "guardrails_unavailable")
			return
		}
		if err := explain.ValidateInput(catalogue, input); err != nil {
			fail(w, http.StatusUnprocessableEntity, explain.CodeInputRejected)
			return
		}
		zoneName, ok := catalogue.ZoneName(input.ZoneID)
		if !ok {
			// Unreachable: ValidateInput admitted the code from this same catalogue.
			fail(w, http.StatusServiceUnavailable, "guardrails_unavailable")
			return
		}

		batches, err := store.List(r.Context(), input.ZoneID, explainWindow)
		if err != nil {
			fail(w, http.StatusServiceUnavailable, "storage_unavailable")
			return
		}
		if len(batches) == 0 {
			respond(w, http.StatusNotFound, map[string]string{"code": "no_published_batch", "data_status": "insufficient"})
			return
		}
		source, err := explainSource(batches[0], zoneName)
		if err != nil {
			fail(w, http.StatusServiceUnavailable, "storage_unavailable")
			return
		}
		if source.ZoneID != input.ZoneID {
			// A row for another zone would attribute an answer to a batch this request
			// never asked about, so it is refused instead of being explained.
			fail(w, http.StatusServiceUnavailable, "storage_unavailable")
			return
		}
		var previous *explain.Source
		if len(batches) > 1 {
			prior, err := explainSource(batches[1], zoneName)
			if err != nil {
				// The trend is part of the answer, so an unreadable earlier publication
				// cannot be silently dropped for the one topic that needs it.
				fail(w, http.StatusServiceUnavailable, "storage_unavailable")
				return
			}
			previous = &prior
		}

		// GRD-I2. It runs on the composed document, against the validated request and
		// the batch it was composed from, before anything is written.
		answer := explain.Compose(source, previous, input.Topic)
		if err := verifyExplainOutput(answer, input, source, previous); err != nil {
			fail(w, http.StatusServiceUnavailable, "GUARDRAIL_OUTPUT_BLOCKED")
			return
		}
		respond(w, http.StatusOK, answer)
	}
}

// explainSource projects one stored batch onto the source the composer and the
// verifier read.
//
// An empty factor payload is a legitimate "no variable recorded" and every canonical
// variable is then cited as unmeasured. A payload that is present but unreadable is a
// storage defect and is returned as an error: flattening it into "no readings" would
// report a fact about the zone that this service never observed.
func explainSource(batch repository.Batch, zoneName string) (explain.Source, error) {
	var factors []classify.Factor
	if len(bytes.TrimSpace(batch.Factors)) > 0 {
		if err := json.Unmarshal(batch.Factors, &factors); err != nil {
			return explain.Source{}, fmt.Errorf("%w: %v", explainErrUnreadableFactors, err)
		}
	}
	return explain.Source{
		BatchID:      batch.ID,
		ZoneID:       batch.ZoneID,
		ZoneName:     zoneName,
		RiskLevel:    batch.RiskLevel,
		ModelVersion: batch.ModelVersion,
		PublishedAt:  batch.PublishedAt,
		ValidUntil:   batch.ValidUntil,
		// The batch's own synthetic mark, not the answer's: GRD-I2 compares the two.
		Synthetic: batch.Demo,
		Factors:   factors,
	}, nil
}

// parseExplainRequest reads the one accepted document: a JSON object with zone_id,
// topic and at most one question, no unknown member, no duplicate member, no explicit
// null for a string member and no trailing input.
//
// Every restriction is enforced here rather than by encoding/json alone, because the
// default decoder accepts all of them. A null is refused instead of being read as the
// empty string, so "no question" has exactly one spelling: the member is absent.
func parseExplainRequest(body []byte) (explain.Input, error) {
	if len(bytes.TrimSpace(body)) == 0 {
		return explain.Input{}, errors.New("explain body is empty")
	}
	members, err := decodeRequestObject(body)
	if err != nil {
		return explain.Input{}, err
	}
	var input explain.Input
	var zoneSeen, topicSeen bool
	for _, member := range members {
		switch member.name {
		case "zone_id":
			value, err := parseExplainString(member.value)
			if err != nil {
				return explain.Input{}, fmt.Errorf("zone_id: %w", err)
			}
			input.ZoneID = value
			zoneSeen = true
		case "topic":
			value, err := parseExplainString(member.value)
			if err != nil {
				return explain.Input{}, fmt.Errorf("topic: %w", err)
			}
			// The value is cast, not validated: ValidateInput owns the closed enum, so
			// there is exactly one place that decides which topics exist.
			input.Topic = explain.Topic(value)
			topicSeen = true
		case "question":
			value, err := parseExplainString(member.value)
			if err != nil {
				return explain.Input{}, fmt.Errorf("question: %w", err)
			}
			input.Question = value
			input.QuestionSet = true
		default:
			return explain.Input{}, fmt.Errorf("unknown member %q", member.name)
		}
	}
	if !zoneSeen {
		return explain.Input{}, errors.New("zone_id is required")
	}
	if !topicSeen {
		return explain.Input{}, errors.New("topic is required")
	}
	return input, nil
}

// parseExplainString reads one required member as a string. An explicit null decodes
// to the empty string without an error in encoding/json, so it is refused first: a
// null is not "the caller omitted the member", and reading it as the empty string
// would answer a request nobody wrote.
func parseExplainString(raw json.RawMessage) (string, error) {
	if string(bytes.TrimSpace(raw)) == "null" {
		return "", errors.New("explicit null is not a string")
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", errors.New("member is not a string")
	}
	return value, nil
}
