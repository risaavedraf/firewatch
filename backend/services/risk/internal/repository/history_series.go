package repository

import (
	"context"
	"fmt"
	"time"
)

// This file is the granular history read: one point per zone and bucket, over a
// bounded window of requested_at.
//
// It is a sibling of List and LatestPerZone rather than a variant of them. Those
// two serve "the newest N batches of one zone" and "the newest batch of every
// zone"; this one serves "the value of every bucket between two instants", which
// is a different question with a different bound. Keeping it separate means the
// existing reads keep their exact contract, their exact order and their exact
// response shape, which is what the frontend already consumes.
//
// Nothing is interpolated and nothing is invented: a zone is present only if it
// has at least one batch inside the window, and a bucket is present only if a
// batch falls in it. An empty bucket is a gap in the series, never a synthesized
// point and never a repeat of the previous level.

// CivilZone is the time zone the daily and weekly buckets are cut in. A civil day
// is a property of the commune, not of the caller: the whole risk product is
// Chilean, so the series is aligned to the same zone the model's daily aggregates
// already use (internal/features.Location), and a client in another offset still
// reads the days the territory actually lived.
const CivilZone = "America/Santiago"

// HistoryGranularity is the closed vocabulary of bucket sizes the series read
// serves. It is a named type because the value selects a SQL expression: a caller
// must never be able to turn a query parameter into SQL text, so the repository
// maps these constants onto fixed expressions and refuses anything else.
type HistoryGranularity string

const (
	// HistoryHourly buckets by UTC hour. Hourly buckets are deliberately NOT cut
	// in the civil zone: an hour has no civil-day boundary to respect, and UTC
	// alignment keeps every bucket unambiguous across a daylight-saving change.
	// The consequence is documented for callers: on the night a clock goes back,
	// the repeated wall-clock hour appears as two distinct UTC buckets.
	HistoryHourly HistoryGranularity = "hour"
	// HistoryDaily buckets by America/Santiago civil day.
	HistoryDaily HistoryGranularity = "day"
	// HistoryWeekly buckets by America/Santiago civil week, Monday to Sunday:
	// PostgreSQL's date_trunc('week') is ISO-8601 and starts on Monday.
	HistoryWeekly HistoryGranularity = "week"
)

// Valid reports whether g is one of the three bucket sizes the read serves.
func (g HistoryGranularity) Valid() bool {
	switch g {
	case HistoryHourly, HistoryDaily, HistoryWeekly:
		return true
	default:
		return false
	}
}

// bucketStartExpression returns the SQL that maps a batch's instant onto the
// start of its bucket.
//
// Every expression is self-contained and independent of any session setting,
// because the answer must not depend on how a connection happens to be
// configured:
//
//   - hourly floors the epoch, which is UTC by definition. date_trunc('hour',
//     timestamptz) would NOT do: it truncates in the session TimeZone, so the same
//     row would land in a different bucket depending on a connection variable.
//   - daily and weekly first render the instant as a civil wall clock in
//     America/Santiago, truncate THAT (a plain timestamp, so no zone rules apply),
//     and convert the result back to an instant. On the spring-forward night the
//     local midnight does not exist; PostgreSQL resolves that local time with the
//     pre-transition (standard) offset, which yields the transition instant itself
//   - exactly the first instant that belongs to that civil day. On the
//     fall-back night, midnight exists once, so the bucket start is unambiguous.
func (g HistoryGranularity) bucketStartExpression() (string, error) {
	switch g {
	case HistoryHourly:
		return `to_timestamp(floor(extract(epoch FROM b.requested_at) / 3600) * 3600)`, nil
	case HistoryDaily:
		return `(date_trunc('day', b.requested_at AT TIME ZONE 'America/Santiago')) AT TIME ZONE 'America/Santiago'`, nil
	case HistoryWeekly:
		return `(date_trunc('week', b.requested_at AT TIME ZONE 'America/Santiago')) AT TIME ZONE 'America/Santiago'`, nil
	default:
		// The granularity reaches this function only from the handler's closed
		// vocabulary, so an unknown value is a programming defect, not a request
		// error: it is returned as one instead of being defaulted to something
		// plausible.
		return "", fmt.Errorf("history series: unknown granularity %q", string(g))
	}
}

// HistorySeriesQuery is one validated series read: a half-open window of
// requested_at, one granularity, and optionally one zone.
//
// ZoneID empty means "every zone that has a point in the window". There is
// deliberately no page size, no limit and no offset: the window and the
// granularity are the bound, and a caller cannot ask for more than the caps the
// handler enforces (hour: 48h, day and week: 31 days).
type HistorySeriesQuery struct {
	From        time.Time
	To          time.Time
	Granularity HistoryGranularity
	// ZoneID narrows the read to one catalogue zone. The handler has already
	// checked membership; the read treats it as a filter only.
	ZoneID string
}

// HistoryPoint is one stored batch, attributed to the bucket it starts.
//
// It is deliberately narrower than Batch: a series point is history, so it
// carries no freshness at all - no data_status, no notice, no valid_until. Those
// describe the CURRENT state of a batch and would be recomputed at read time,
// which would make an old point look fresh because it was read today. Synthetic
// and model provenance travel with the point instead, so a bucket declares where
// its value came from.
type HistoryPoint struct {
	ZoneID      string
	BucketStart time.Time
	// BatchID is the identity of the batch the bucket reports: the newest
	// requested_at in the bucket, with the batch id as the deterministic
	// tie-break. A caller can fetch that exact batch from the per-zone reads.
	BatchID      string
	RequestedAt  time.Time
	PublishedAt  time.Time
	ModelVersion string
	// RiskLevel is the recorded level, including desconocido: the latest
	// assessment is shown even when its level is unknown, because "the inputs were
	// insufficient" is the answer that batch recorded.
	RiskLevel string
	// Synthetic is the batch's demo flag, read and never inferred.
	Synthetic bool
}

// HistorySeries reads at most one point per zone and bucket inside [From, To).
//
// The selection rule is the one the contract states: within a bucket the batch
// with the newest requested_at wins, and a tie is broken by the batch id in
// descending order, which is the same newest-first convention the per-zone reads
// use. DISTINCT ON (zone_id, bucket) applies that rule inside one statement, so
// the result is bounded by (zones with a point) x (buckets in the window) - at
// most 49 hour buckets or 33 civil day buckets - instead of by the number of stored
// batches. That bound is what makes the answer safe to serve whole.
//
// It is one read: no per-zone query, no fan-out and no second round trip, so a
// thirty-eight zone window costs one statement rather than thirty-eight. The
// window is half-open, so a batch at exactly To belongs to the next window and
// appears in neither twice nor never.
//
// An empty result is a valid answer, not an error: a window with no publication is
// an empty series collection, and the caller decides how to present a gap.
func (s Store) HistorySeries(ctx context.Context, query HistorySeriesQuery) ([]HistoryPoint, error) {
	bucket, err := query.Granularity.bucketStartExpression()
	if err != nil {
		return nil, err
	}
	// The filter is assembled here, from values, and never from request text: the
	// granularity selected the expression above through a closed switch, and the
	// zone is a bound parameter like the window.
	filter := `b.requested_at >= $1 AND b.requested_at < $2`
	args := []any{query.From.UTC(), query.To.UTC()}
	if query.ZoneID != "" {
		filter += ` AND b.zone_id = $3`
		args = append(args, query.ZoneID)
	}
	statement := `SELECT DISTINCT ON (b.zone_id, bucket_start)
			b.zone_id, b.bucket_start, b.id::text, b.requested_at, b.published_at, b.model_version, b.demo, b.risk_level
		FROM (
			SELECT b.zone_id, ` + bucket + ` AS bucket_start, b.id, b.requested_at, b.published_at, b.model_version, b.demo, b.risk_level
			FROM batches b
			WHERE ` + filter + `
		) b
		ORDER BY b.zone_id, b.bucket_start, b.requested_at DESC, b.id DESC`
	rows, err := s.DB.Query(ctx, statement, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	points := make([]HistoryPoint, 0)
	for rows.Next() {
		var point HistoryPoint
		if err := rows.Scan(&point.ZoneID, &point.BucketStart, &point.BatchID, &point.RequestedAt, &point.PublishedAt, &point.ModelVersion, &point.Synthetic, &point.RiskLevel); err != nil {
			return nil, err
		}
		// Instants are canonicalised to UTC, the same way the per-zone reads
		// canonicalise the one optional instant they carry: a timestamptz decoded in
		// the connection's location must not change the rendering the client parses.
		point.BucketStart = point.BucketStart.UTC()
		point.RequestedAt = point.RequestedAt.UTC()
		point.PublishedAt = point.PublishedAt.UTC()
		points = append(points, point)
	}
	return points, rows.Err()
}
