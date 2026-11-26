package repository

import (
	"context"
	"time"
)

// ExecutiveBatches reads up to two batches per catalogue zone, newest first,
// in one database snapshot. An empty group identifies a zone with no batch.
func (s Store) ExecutiveBatches(ctx context.Context) ([][]Batch, error) {
	rows, err := s.DB.Query(ctx, `
		SELECT z.code, b.id::text, coalesce(b.risk_level, ''),
		       coalesce(b.model_version, ''), coalesce(b.demo, false),
		       coalesce(b.scenario_id, ''), b.valid_until, coalesce(b.factors, '[]'::jsonb)
		FROM zones z
		LEFT JOIN LATERAL (
			SELECT id, requested_at, risk_level, model_version, demo, scenario_id, valid_until, factors
			FROM batches
			WHERE zone_id = z.code
			ORDER BY requested_at DESC, id DESC
			LIMIT 2
		) b ON true
		ORDER BY z.code, b.requested_at DESC, b.id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var groups [][]Batch
	var lastZone string
	for rows.Next() {
		var b Batch
		var id *string
		var validUntil *time.Time
		if err := rows.Scan(&b.ZoneID, &id, &b.RiskLevel, &b.ModelVersion,
			&b.Demo, &b.ScenarioID, &validUntil, &b.Factors); err != nil {
			return nil, err
		}
		if len(groups) == 0 || b.ZoneID != lastZone {
			groups = append(groups, nil)
			lastZone = b.ZoneID
		}
		if id != nil {
			b.ID = *id
			b.ValidUntil = *validUntil // NOT NULL for a stored batch.
			idx := len(groups) - 1
			groups[idx] = append(groups[idx], b)
		}
	}
	return groups, rows.Err()
}
