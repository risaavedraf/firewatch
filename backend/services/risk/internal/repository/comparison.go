package repository

import (
	"context"
	"encoding/json"
	"time"
)

// This file is the multi-zone comparison read: GET /v1/risk/compare.
//
// It is an ADDITIVE sibling of the per-zone reads and of the granular series. No
// existing query changes: List, LatestPerZone and HistorySeries keep their exact
// contracts, and this read asks a question none of them answers - "how do two or
// three named zones compare at one shared cutoff, and what did each of them record
// inside the requested window".
//
// Two rules shape it:
//
//  1. One snapshot, one cutoff. The newest batch of every requested zone strictly
//     before To is selected in the same statement that selects the window, so all
//     zones are compared at the same instant. A zone whose newest eligible batch
//     predates From still reports it: S5 asks for the previous evaluation with its
//     own date rather than for a gap, and the date travels with the assessment.
//  2. History stays history. The window part keeps PM-04's semantics exactly - the
//     same closed bucket expressions, the same [From,To) half-open interval, the
//     same newest-requested_at-with-id-tie-break rule - and no freshness is
//     derived for either part. data_status, notice and valid_until describe the
//     current state of a batch and would make an old assessment look fresh.

// ComparisonQuery is one validated comparison read.
//
// ZoneIDs is the requested zones in the caller's order: the handler echoes that
// order, so a comparison axis keeps the position the caller chose. It always
// holds two or three distinct catalogue codes, already checked against the
// catalogue by the handler.
type ComparisonQuery struct {
	ZoneIDs     []string
	From        time.Time
	To          time.Time
	Granularity HistoryGranularity
}

// ComparisonAssessment is one zone's stored assessment at the shared cutoff.
//
// It is deliberately narrower than Batch: a comparison reports the recorded risk,
// its factors and its provenance, and no freshness at all. The level travels
// verbatim, including desconocido, because "the inputs were insufficient" is what
// that batch stored; the handler distinguishes it from the absence of a batch.
type ComparisonAssessment struct {
	ZoneID       string
	BatchID      string
	RequestedAt  time.Time
	PublishedAt  time.Time
	ModelVersion string
	RiskLevel    string
	// Factors is the stored factors document, read verbatim. It is never
	// recomputed from the current inputs: a comparison shows what produced the
	// level it reports.
	Factors json.RawMessage
	// Synthetic is the batch's demo flag, read and never inferred.
	Synthetic bool
}

// ComparisonSnapshot is the answer of one comparison read.
//
// Assessments holds at most one row per requested zone - the zones that have an
// eligible batch at all - and History holds at most one point per zone and
// bucket. A requested zone absent from Assessments has no batch before the cutoff
// and the handler serves it with a null assessment; it is not an error and it is
// not dropped from the answer.
type ComparisonSnapshot struct {
	Assessments []ComparisonAssessment
	History     []HistoryPoint
}

// CompareZones reads one comparison snapshot in a single statement.
//
// The statement is one SQL snapshot by construction: both halves are common table
// expressions of the same query, so the cutoff assessment and the window cannot
// observe different commits. No lower bound is applied to the assessment half -
// the batch that is newest before To may predate From - while the history half is
// restricted to [From,To) exactly as HistorySeries is.
//
// A cutoff assessment cannot use a batch published at or after To. Among
// eligible batches, selection follows the same newest-first rule: newest
// requested_at wins, and the batch id breaks a tie in descending order. The
// answer is bounded by the requested zones (two or three) and by the PM-04 bucket
// count of the window, never by how much is stored, because a caller cannot widen
// the window past the caps the handler enforces.
//
// An empty result is a valid answer: a requested zone with no eligible batch and
// no publication inside the window produces no rows, and the caller decides how to
// present the absence.
func (s Store) CompareZones(ctx context.Context, query ComparisonQuery) (ComparisonSnapshot, error) {
	bucket, err := query.Granularity.bucketStartExpression()
	if err != nil {
		return ComparisonSnapshot{}, err
	}
	// Every value is a bound parameter and the only interpolated text is the bucket
	// expression selected by a closed switch, so a request can never become SQL.
	statement := `WITH latest AS (
			SELECT DISTINCT ON (b.zone_id)
				b.zone_id, b.id, b.requested_at, b.published_at, b.model_version, b.demo, b.risk_level,
				coalesce(b.factors, '[]'::jsonb)::text AS factors
			FROM batches b
			WHERE b.zone_id = ANY($1::text[]) AND b.requested_at < $2 AND b.published_at < $2
			ORDER BY b.zone_id, b.requested_at DESC, b.id DESC
		), history AS (
			SELECT DISTINCT ON (b.zone_id, b.bucket_start)
				b.zone_id, b.bucket_start, b.id, b.requested_at, b.published_at, b.model_version, b.demo, b.risk_level
			FROM (
				SELECT b.zone_id, ` + bucket + ` AS bucket_start,
					b.id, b.requested_at, b.published_at, b.model_version, b.demo, b.risk_level
				FROM batches b
				WHERE b.zone_id = ANY($1::text[]) AND b.requested_at >= $3 AND b.requested_at < $2
			) b
			ORDER BY b.zone_id, b.bucket_start, b.requested_at DESC, b.id DESC
		)
		SELECT 'assessment'::text AS kind, zone_id, id::text, requested_at, published_at, model_version, demo, risk_level, factors, NULL::timestamptz AS bucket_start FROM latest
		UNION ALL
		SELECT 'history'::text AS kind, zone_id, id::text, requested_at, published_at, model_version, demo, risk_level, NULL::text AS factors, bucket_start FROM history
		ORDER BY zone_id, kind, bucket_start`
	rows, err := s.DB.Query(ctx, statement, query.ZoneIDs, query.To.UTC(), query.From.UTC())
	if err != nil {
		return ComparisonSnapshot{}, err
	}
	defer rows.Close()
	snapshot := ComparisonSnapshot{Assessments: make([]ComparisonAssessment, 0), History: make([]HistoryPoint, 0)}
	for rows.Next() {
		var kind, zoneID, batchID, modelVersion, riskLevel string
		var requestedAt, publishedAt time.Time
		var synthetic bool
		var factors *string
		var bucketStart *time.Time
		if err := rows.Scan(&kind, &zoneID, &batchID, &requestedAt, &publishedAt, &modelVersion, &synthetic, &riskLevel, &factors, &bucketStart); err != nil {
			return ComparisonSnapshot{}, err
		}
		switch kind {
		case "assessment":
			var stored string
			if factors != nil {
				stored = *factors
			}
			snapshot.Assessments = append(snapshot.Assessments, ComparisonAssessment{
				ZoneID:       zoneID,
				BatchID:      batchID,
				RequestedAt:  requestedAt.UTC(),
				PublishedAt:  publishedAt.UTC(),
				ModelVersion: modelVersion,
				RiskLevel:    riskLevel,
				Factors:      json.RawMessage(stored),
				Synthetic:    synthetic,
			})
		case "history":
			if bucketStart == nil {
				continue
			}
			// Instants are canonicalised to UTC, exactly as HistorySeries does it: a
			// timestamptz decoded in the connection's location must not change the
			// rendering the client parses.
			snapshot.History = append(snapshot.History, HistoryPoint{
				ZoneID:       zoneID,
				BucketStart:  bucketStart.UTC(),
				BatchID:      batchID,
				RequestedAt:  requestedAt.UTC(),
				PublishedAt:  publishedAt.UTC(),
				ModelVersion: modelVersion,
				RiskLevel:    riskLevel,
				Synthetic:    synthetic,
			})
		}
	}
	return snapshot, rows.Err()
}
