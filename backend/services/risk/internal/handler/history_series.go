package handler

import (
	"errors"
	"net/http"
	"net/url"
	"sort"
	"time"

	"firewatch.local/risk/internal/repository"
)

// This file is the granular history read: GET /v1/risk/history/series.
//
// It is an ADDITIVE sibling of GET /v1/risk/history and its CSV export. Those two
// keep serving the fixed 100 row window of one zone, with the exact body the
// frontend already parses; this one answers a different question - the value of
// every zone, per hour, day or week, between two instants. Nothing here changes an
// existing route: the path is its own exact registration, the query vocabulary is
// its own, and a parameter of this read is an unknown parameter to the others.
//
// Three rules shape the answer:
//
//  1. The window and the granularity are the bound. A caller cannot ask for "all
//     history": the window is a required half-open interval and its length is
//     capped per granularity, so the number of buckets - and therefore the size of
//     the answer - is bounded before storage is touched.
//  2. Nothing is interpolated. A bucket with no publication is a gap, not a
//     repeated level and not an "unknown" point; a zone with no point in the window
//     has no series at all. The series shows what was recorded.
//  3. The point is history, so it carries no freshness. data_status, notice and
//     valid_until describe the current state of a batch and would be recomputed at
//     read time, which would make an old point look fresh; the level, the batch
//     identity and the synthetic/model provenance are what a series needs.

// The hard caps of the window, per granularity. They are chosen so the bucket
// count stays small enough to serve whole: 48 hours is 49 hour buckets, and 31 days
// can intersect 33 civil day buckets or 6 week buckets. The cap is inclusive - a window of
// exactly the cap is accepted - and it is measured on the instants as given, so a
// caller cannot widen it by declaring an offset.
const (
	seriesHourCap  = 48 * time.Hour
	seriesCivilCap = 31 * 24 * time.Hour
)

// seriesQueryRefusal is a malformed-query verdict that carries the documented 400
// code. It exists as a type rather than a sentinel error because the route answers
// two refusal codes and the reason decides which: a zone parameter that cannot name
// a zone answers invalid_zone, exactly like the sibling reads, and every other
// malformed shape answers invalid_series_query. Every refusal happens before the
// read, so no rejected request reaches storage.
type seriesQueryRefusal struct{ code string }

func (r seriesQueryRefusal) Error() string { return "malformed history series query: " + r.code }

// errInvalidSeriesQuery is the refusal of every malformed shape that is not about
// the zone: a missing, repeated, empty or unknown parameter, an unreadable query
// encoding, a granularity outside the closed vocabulary, an unparseable instant, an
// empty or reversed window, or a window longer than its cap.
var errInvalidSeriesQuery = seriesQueryRefusal{code: "invalid_series_query"}

// errInvalidSeriesZone is the refusal of a zone parameter that cannot name a zone:
// repeated, empty, or absent from the catalogue (the catalogue half is decided by
// the caller, which is the only part that needs storage).
var errInvalidSeriesZone = seriesQueryRefusal{code: "invalid_zone"}

// seriesQueryKeysValid reports whether the query names only the four parameters of
// this read. An unknown parameter is refused rather than ignored: an ignored filter
// would answer a different question than the caller asked, which reads like missing
// data. Repetition is judged per parameter below, because the code a repeated
// parameter answers depends on which parameter it is.
func seriesQueryKeysValid(values url.Values) bool {
	for key := range values {
		if key != "from" && key != "to" && key != "granularity" && key != "zone_id" {
			return false
		}
	}
	return true
}

// seriesWindowCap returns the accepted window length for a granularity.
func seriesWindowCap(granularity repository.HistoryGranularity) (time.Duration, bool) {
	switch granularity {
	case repository.HistoryHourly:
		return seriesHourCap, true
	case repository.HistoryDaily, repository.HistoryWeekly:
		return seriesCivilCap, true
	default:
		return 0, false
	}
}

// seriesWindow parses and validates the required window of one read: both instants
// must be RFC 3339, the interval must be non-empty, and its length may not exceed
// the cap of the granularity. It is split out of the query parse so the two rules -
// what a parameter is and what a window is - stay readable separately.
func seriesWindow(values url.Values, windowCap time.Duration) (time.Time, time.Time, error) {
	from, err := time.Parse(time.RFC3339, values["from"][0])
	if err != nil {
		return time.Time{}, time.Time{}, errInvalidSeriesQuery
	}
	to, err := time.Parse(time.RFC3339, values["to"][0])
	if err != nil {
		return time.Time{}, time.Time{}, errInvalidSeriesQuery
	}
	if !from.Before(to) || to.Sub(from) > windowCap {
		return time.Time{}, time.Time{}, errInvalidSeriesQuery
	}
	return from.UTC(), to.UTC(), nil
}

// parseHistorySeriesQuery reads the required window and granularity, plus the
// optional zone, from the raw query string.
//
// It is pure so every accepted and refused shape is testable without a server, and
// it takes the raw string rather than url.Values because url.Values silently
// discards a pair it cannot unescape: `?from=%zz` would otherwise be served as
// "from is missing", and the caller would be told to correct a parameter that was
// never read. url.ParseQuery reports that error, so unreadable encoding is a
// refusal like any other.
//
// The accepted window is [from, to) on requested_at: an instant equal to from
// belongs to this window and an instant equal to to belongs to the next one, so two
// adjacent windows never both contain a batch and never both omit it.
func parseHistorySeriesQuery(rawQuery string) (repository.HistorySeriesQuery, error) {
	values, err := url.ParseQuery(rawQuery)
	if err != nil || !seriesQueryKeysValid(values) {
		return repository.HistorySeriesQuery{}, errInvalidSeriesQuery
	}
	// The zone is judged before the window because its code is the one the sibling
	// reads already answer, and a repeated or empty zone_id cannot name a zone at
	// all. A repeated parameter anywhere has no single meaning and is refused rather
	// than resolved by picking one of the values. Membership is not decided here:
	// this function reads no storage.
	zone := ""
	if raw, present := values["zone_id"]; present {
		if len(raw) != 1 || raw[0] == "" {
			return repository.HistorySeriesQuery{}, errInvalidSeriesZone
		}
		zone = raw[0]
	}
	for _, required := range []string{"from", "to", "granularity"} {
		raw, present := values[required]
		if !present || len(raw) != 1 || raw[0] == "" {
			return repository.HistorySeriesQuery{}, errInvalidSeriesQuery
		}
	}
	granularity := repository.HistoryGranularity(values["granularity"][0])
	windowCap, ok := seriesWindowCap(granularity)
	if !ok {
		return repository.HistorySeriesQuery{}, errInvalidSeriesQuery
	}
	from, to, err := seriesWindow(values, windowCap)
	if err != nil {
		return repository.HistorySeriesQuery{}, err
	}
	return repository.HistorySeriesQuery{
		From:        from,
		To:          to,
		Granularity: granularity,
		ZoneID:      zone,
	}, nil
}

// seriesRefusalCode maps a parse failure onto its documented 400 code. An error
// that is not a refusal cannot come from this parse step; treating it as the
// generic code keeps the route's vocabulary closed instead of leaking an internal
// message into the response.
func seriesRefusalCode(err error) string {
	var refusal seriesQueryRefusal
	if errors.As(err, &refusal) {
		return refusal.code
	}
	return errInvalidSeriesQuery.code
}

// historyBucket is one point of one series: the explicit start of the bucket, the
// identity of the batch the bucket reports, and that batch's provenance.
//
// The members are deliberately few. There is no data_status, no notice and no
// valid_until - freshness is derived from the read instant, so serving it on a
// historical point would make the past look current. There is no interpolation
// either: a bucket is present only because a batch fell in it.
type historyBucket struct {
	// BucketStart is the instant the bucket begins, in UTC. For day and week it is
	// the America/Santiago civil day or Monday-starting week that begins there; for
	// hour it is the UTC hour.
	BucketStart time.Time `json:"bucket_start"`
	// BatchID is the batch the bucket reports: the newest requested_at in the
	// bucket, with the id as the deterministic tie-break.
	BatchID      string    `json:"batch_id"`
	RequestedAt  time.Time `json:"requested_at"`
	PublishedAt  time.Time `json:"published_at"`
	RiskLevel    string    `json:"risk_level"`
	ModelVersion string    `json:"model_version"`
	// Synthetic is the batch's own demo flag, read and never inferred from the
	// environment.
	Synthetic bool `json:"synthetic"`
}

// historyZoneSeries is one zone's series. Buckets are chronological, so a client
// plots a line without sorting and a gap in the array means exactly what it says:
// no publication in that bucket.
type historyZoneSeries struct {
	ZoneID  string          `json:"zone_id"`
	Buckets []historyBucket `json:"buckets"`
}

// historySeriesCollection is the route's body. Series is never nil, so an empty
// window serialises as {"series":[]} rather than JSON null: nothing published is an
// answer, not a failure. The echoed window and granularity let a caller attribute a
// cached answer without re-reading the request it sent.
type historySeriesCollection struct {
	From        time.Time                     `json:"from"`
	To          time.Time                     `json:"to"`
	Granularity repository.HistoryGranularity `json:"granularity"`
	Series      []historyZoneSeries           `json:"series"`
}

// newHistorySeriesResponse groups the read into one series per zone.
//
// A zone appears only when it has a point, so no series is ever emitted with an
// empty bucket array: the storage read cannot produce one, and the grouping here
// cannot invent one. Series are ordered by zone_id and buckets chronologically, so
// the documented order is a property of this function rather than of whichever
// storage answered the query.
func newHistorySeriesResponse(query repository.HistorySeriesQuery, points []repository.HistoryPoint) historySeriesCollection {
	series := make([]historyZoneSeries, 0, len(points))
	positions := make(map[string]int, len(points))
	for _, point := range points {
		position, seen := positions[point.ZoneID]
		if !seen {
			position = len(series)
			positions[point.ZoneID] = position
			series = append(series, historyZoneSeries{ZoneID: point.ZoneID, Buckets: make([]historyBucket, 0, 1)})
		}
		series[position].Buckets = append(series[position].Buckets, historyBucket{
			BucketStart:  point.BucketStart.UTC(),
			BatchID:      point.BatchID,
			RequestedAt:  point.RequestedAt.UTC(),
			PublishedAt:  point.PublishedAt.UTC(),
			RiskLevel:    point.RiskLevel,
			ModelVersion: point.ModelVersion,
			Synthetic:    point.Synthetic,
		})
	}
	sort.SliceStable(series, func(i, j int) bool { return series[i].ZoneID < series[j].ZoneID })
	for index := range series {
		sort.SliceStable(series[index].Buckets, func(i, j int) bool {
			return series[index].Buckets[i].BucketStart.Before(series[index].Buckets[j].BucketStart)
		})
	}
	return historySeriesCollection{
		From:        query.From.UTC(),
		To:          query.To.UTC(),
		Granularity: query.Granularity,
		Series:      series,
	}
}

// historySeries serves the bucketed window. It is a read under the same
// viewer/admin bearer gate as every other risk route: 401 and 403 are answered
// before storage is touched, an admitted request writes nothing, and a storage
// failure is the shared 503 storage_unavailable so a client can tell "no
// publication in this window" from "the window could not be read".
//
// Omitting zone_id asks for the whole territory in ONE bucketed read. Resolving
// that as one read per zone would turn a single request into as many round trips as
// there are communes, so the filter is passed down instead of being expanded here.
func historySeries(store Repository) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		query, err := parseHistorySeriesQuery(r.URL.RawQuery)
		if err != nil {
			fail(w, http.StatusBadRequest, seriesRefusalCode(err))
			return
		}
		if query.ZoneID != "" {
			exists, err := store.ZoneExists(r.Context(), query.ZoneID)
			if err != nil {
				fail(w, http.StatusServiceUnavailable, "storage_unavailable")
				return
			}
			if !exists {
				fail(w, http.StatusBadRequest, "invalid_zone")
				return
			}
		}
		points, err := store.HistorySeries(r.Context(), query)
		if err != nil {
			fail(w, http.StatusServiceUnavailable, "storage_unavailable")
			return
		}
		respond(w, http.StatusOK, newHistorySeriesResponse(query, points))
	}
}
