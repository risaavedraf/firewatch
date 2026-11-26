package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"firewatch.local/risk/internal/repository"
)

// This file is the multi-zone comparison read: GET /v1/risk/compare.
//
// It is an ADDITIVE route and the first risk read that accepts a LIST of zones.
// No existing route changes: the per-zone reads keep their single required
// zone_id, the granular series keeps its own vocabulary, and a parameter of this
// read is an unknown parameter to them.
//
// Three rules shape the answer:
//
//  1. The cutoff is shared. Every requested zone reports the newest batch
//     strictly before To, so the comparison is taken at one instant (S5). A zone
//     whose newest eligible batch predates From still reports it with its own
//     requested_at and published_at, instead of a gap.
//  2. Position is the axis. The requested zones are echoed in the order the
//     caller sent them, including a zone with no eligible batch, which is served
//     as assessment:null. A recorded desconocido level is not null and not
//     omitted: the inputs were insufficient, and that is an answer.
//  3. Nothing is invented. There is no priority field: the comparison shows the
//     axes that exist today, and a measure the domain does not have would be
//     fabricated data (S2/S4). History keeps PM-04's semantics and freshness is
//     never derived.

// The size of the comparison. Two is the minimum that makes a comparison and
// three is the maximum the requested view has axes for; a fourth zone would be a
// checklist, not a comparison. The bound is also what keeps the shared cutoff
// affordable: the read is one statement over a fixed, small zone list.
const (
	compareMinZones = 2
	compareMaxZones = 3
)

// comparisonQueryRefusal is a malformed-query verdict that carries the documented
// 400 code. It mirrors the series refusal and exists as a type for the same
// reason: this route answers two refusal codes and the reason decides which. A
// zone that cannot be part of a comparison answers invalid_zone, exactly like the
// sibling reads; every other malformed shape answers invalid_comparison_query.
// Every refusal happens before the read, so no rejected request reaches storage.
type comparisonQueryRefusal struct{ code string }

func (r comparisonQueryRefusal) Error() string { return "malformed comparison query: " + r.code }

// errInvalidComparisonQuery is the refusal of every malformed shape that is not
// about a named zone: a missing, repeated, empty or unknown parameter, an
// unreadable query encoding, a zone list outside two or three entries or with an
// empty entry, a granularity outside the closed vocabulary, and an unparseable,
// empty, reversed or over-long window.
var errInvalidComparisonQuery = comparisonQueryRefusal{code: "invalid_comparison_query"}

// errInvalidComparisonZone is the refusal of a zone list that names the same zone
// twice or names a zone absent from the catalogue (the catalogue half is decided
// by the caller, which is the only part that needs storage).
var errInvalidComparisonZone = comparisonQueryRefusal{code: "invalid_zone"}

// comparisonQueryKeysValid reports whether the query names only the four
// parameters of this read. An unknown parameter is refused rather than ignored:
// an ignored filter would answer a different comparison than the caller asked
// for, which reads like missing data.
func comparisonQueryKeysValid(values url.Values) bool {
	for key := range values {
		if key != "zone_ids" && key != "from" && key != "to" && key != "granularity" {
			return false
		}
	}
	return true
}

// parseComparisonZoneIDs splits the one required comma-separated list.
//
// It is pure so the whole list rule is testable without a server. The list is
// bounded before anything else: two or three entries, no more and no fewer, and
// no empty entry. Duplicates are refused instead of resolved, because "compare
// this zone with itself" is a different question and the answer would either
// repeat a zone or silently drop one. No whitespace is trimmed and no code is
// normalised: an entry is a catalogue code as the caller wrote it, or the
// catalogue refuses it.
func parseComparisonZoneIDs(raw string) ([]string, error) {
	parts := strings.Split(raw, ",")
	if len(parts) < compareMinZones || len(parts) > compareMaxZones {
		return nil, errInvalidComparisonQuery
	}
	seen := make(map[string]bool, len(parts))
	for _, part := range parts {
		if part == "" {
			return nil, errInvalidComparisonQuery
		}
		if seen[part] {
			return nil, errInvalidComparisonZone
		}
		seen[part] = true
	}
	return parts, nil
}

// parseComparisonQuery reads the required zone list, window and granularity from
// the raw query string.
//
// It is pure so every accepted and refused shape is testable without a server,
// and it takes the raw string rather than url.Values for the reason the series
// read does: url.Values silently discards a pair it cannot unescape, so
// `?zone_ids=%zz` would otherwise be served as "zone_ids is missing" and the
// caller would be told to correct a parameter that was never read.
// url.ParseQuery reports that error, so unreadable encoding is a refusal like any
// other.
//
// The window and granularity are PM-04's: the same closed vocabulary, the same
// half-open [From,To) interval and the same per-granularity caps, reused through
// seriesWindowCap and seriesWindow rather than restated, so the two reads cannot
// disagree about what a valid window is.
func parseComparisonQuery(rawQuery string) (repository.ComparisonQuery, error) {
	values, err := url.ParseQuery(rawQuery)
	if err != nil || !comparisonQueryKeysValid(values) {
		return repository.ComparisonQuery{}, errInvalidComparisonQuery
	}
	// The list is judged first: a repeated parameter has no single meaning, and a
	// missing or empty list cannot name a comparison at all.
	rawZones, present := values["zone_ids"]
	if !present || len(rawZones) != 1 || rawZones[0] == "" {
		return repository.ComparisonQuery{}, errInvalidComparisonQuery
	}
	zoneIDs, err := parseComparisonZoneIDs(rawZones[0])
	if err != nil {
		return repository.ComparisonQuery{}, err
	}
	for _, required := range []string{"from", "to", "granularity"} {
		raw, present := values[required]
		if !present || len(raw) != 1 || raw[0] == "" {
			return repository.ComparisonQuery{}, errInvalidComparisonQuery
		}
	}
	granularity := repository.HistoryGranularity(values["granularity"][0])
	windowCap, ok := seriesWindowCap(granularity)
	if !ok {
		return repository.ComparisonQuery{}, errInvalidComparisonQuery
	}
	// seriesWindow answers the series code when the window is malformed; the
	// comparison has its own code, so the verdict is retranslated instead of being
	// forwarded with a vocabulary that names another route.
	from, to, err := seriesWindow(values, windowCap)
	if err != nil {
		return repository.ComparisonQuery{}, errInvalidComparisonQuery
	}
	return repository.ComparisonQuery{
		ZoneIDs:     zoneIDs,
		From:        from,
		To:          to,
		Granularity: granularity,
	}, nil
}

// comparisonRefusalCode maps a parse failure onto its documented 400 code. An
// error that is not a refusal cannot come from this parse step; treating it as
// the generic code keeps the route's vocabulary closed instead of leaking an
// internal message into the response.
func comparisonRefusalCode(err error) string {
	var refusal comparisonQueryRefusal
	if errors.As(err, &refusal) {
		return refusal.code
	}
	return errInvalidComparisonQuery.code
}

// comparisonAssessment is one zone's stored assessment at the shared cutoff.
// Assessment is a pointer in the collection below so a zone without an eligible
// batch is served as JSON null instead of an invented level.
type comparisonAssessment struct {
	BatchID      string          `json:"batch_id"`
	RequestedAt  time.Time       `json:"requested_at"`
	PublishedAt  time.Time       `json:"published_at"`
	RiskLevel    string          `json:"risk_level"`
	Factors      json.RawMessage `json:"factors"`
	ModelVersion string          `json:"model_version"`
	// Synthetic is the batch's own demo flag, read and never inferred.
	Synthetic bool `json:"synthetic"`
}

// comparisonZone is one comparison axis: the zone the caller named, its
// assessment at the shared cutoff, and its PM-04 buckets inside the window.
type comparisonZone struct {
	ZoneID string `json:"zone_id"`
	// Assessment is null when the zone has no batch strictly before the cutoff.
	// Null therefore means "no evaluation was ever stored", while a stored
	// desconocido level is an assessment that says the inputs were insufficient.
	Assessment *comparisonAssessment `json:"assessment"`
	// History is never nil, so a zone with no publication in the window serialises
	// as an empty array rather than JSON null: a gap is an answer.
	History []historyBucket `json:"history"`
}

// comparisonCollection is the route's body. Zones is never nil and keeps the
// caller's order, so position is the comparison axis and a client can attribute a
// cached answer without re-reading the request it sent.
type comparisonCollection struct {
	From        time.Time                     `json:"from"`
	To          time.Time                     `json:"to"`
	Granularity repository.HistoryGranularity `json:"granularity"`
	Zones       []comparisonZone              `json:"zones"`
}

// newComparisonResponse assembles the answer in the caller's zone order.
//
// The repository returns at most one assessment per requested zone and at most one
// point per zone and bucket; grouping here cannot invent either. A requested zone
// absent from both halves is still emitted - with a null assessment and an empty
// history - because dropping it would silently change the question, and the
// caller's position would be lost.
func newComparisonResponse(query repository.ComparisonQuery, snapshot repository.ComparisonSnapshot) comparisonCollection {
	assessments := make(map[string]*comparisonAssessment, len(snapshot.Assessments))
	for _, assessment := range snapshot.Assessments {
		assessments[assessment.ZoneID] = &comparisonAssessment{
			BatchID:      assessment.BatchID,
			RequestedAt:  assessment.RequestedAt.UTC(),
			PublishedAt:  assessment.PublishedAt.UTC(),
			RiskLevel:    assessment.RiskLevel,
			Factors:      assessment.Factors,
			ModelVersion: assessment.ModelVersion,
			Synthetic:    assessment.Synthetic,
		}
	}
	histories := make(map[string][]historyBucket, len(query.ZoneIDs))
	for _, point := range snapshot.History {
		histories[point.ZoneID] = append(histories[point.ZoneID], historyBucket{
			BucketStart:  point.BucketStart.UTC(),
			BatchID:      point.BatchID,
			RequestedAt:  point.RequestedAt.UTC(),
			PublishedAt:  point.PublishedAt.UTC(),
			RiskLevel:    point.RiskLevel,
			ModelVersion: point.ModelVersion,
			Synthetic:    point.Synthetic,
		})
	}
	zones := make([]comparisonZone, 0, len(query.ZoneIDs))
	for _, zoneID := range query.ZoneIDs {
		// A nil slice is replaced before it is served: an empty window is an empty
		// array, never JSON null. The sort is stable so the order is a property of
		// this function and not of whichever storage answered the query.
		buckets := histories[zoneID]
		if buckets == nil {
			buckets = make([]historyBucket, 0)
		}
		sort.SliceStable(buckets, func(i, j int) bool { return buckets[i].BucketStart.Before(buckets[j].BucketStart) })
		zones = append(zones, comparisonZone{ZoneID: zoneID, Assessment: assessments[zoneID], History: buckets})
	}
	return comparisonCollection{
		From:        query.From.UTC(),
		To:          query.To.UTC(),
		Granularity: query.Granularity,
		Zones:       zones,
	}
}

// compareZones serves the comparison. It is a read under the same viewer/admin
// bearer gate as every other risk route: 401 and 403 are answered before storage
// is touched, an admitted request writes nothing, and a storage failure is the
// shared 503 storage_unavailable so a client can tell "this zone has no batch"
// from "the comparison could not be read".
func compareZones(store Repository) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		query, err := parseComparisonQuery(r.URL.RawQuery)
		if err != nil {
			fail(w, http.StatusBadRequest, comparisonRefusalCode(err))
			return
		}
		// Membership is a property of the catalogue, so each named zone is asked
		// about instead of being compared against a literal. Two or three lookups
		// are the whole cost, and the first unknown code refuses the request before
		// the comparison read runs.
		for _, zoneID := range query.ZoneIDs {
			exists, err := store.ZoneExists(r.Context(), zoneID)
			if err != nil {
				fail(w, http.StatusServiceUnavailable, "storage_unavailable")
				return
			}
			if !exists {
				fail(w, http.StatusBadRequest, "invalid_zone")
				return
			}
		}
		snapshot, err := store.CompareZones(r.Context(), query)
		if err != nil {
			fail(w, http.StatusServiceUnavailable, "storage_unavailable")
			return
		}
		respond(w, http.StatusOK, newComparisonResponse(query, snapshot))
	}
}
