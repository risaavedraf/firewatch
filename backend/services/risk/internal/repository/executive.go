package repository

import (
	"context"
	"sort"
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

// ExecutiveAlertCount counts every row the alert writer has stored, for the
// executive summary. It applies no filter at all: the count answers "how many
// level-change alerts exist", so it deliberately invents neither a read flag nor
// a dismissed flag - the alert lifecycle belongs to PM-08, and a count that
// silently excluded some rows would state a number the table does not hold.
//
// It is a separate read rather than part of ExecutiveBatches because the two
// answer unrelated questions over unrelated tables; folding them into one
// snapshot would tie the catalogue read to the alert table's availability.
func (s Store) ExecutiveAlertCount(ctx context.Context) (int, error) {
	var count int
	err := s.DB.QueryRow(ctx, `SELECT count(*) FROM risk_alerts`).Scan(&count)
	if err != nil {
		return 0, err
	}
	return count, nil
}

// criticalLevel is the level D-B ("Alto sostenido dos lotes") requires in both of
// a zone's two newest published batches. It is a named constant so the rule reads
// as the definition and cannot drift from the label the panel shows.
const criticalLevel = "alto"

// CriticalZones applies D-B to the snapshot ExecutiveBatches returned: a zone is
// critical exactly when its two newest published batches both carry level "alto".
//
// The definition is the responsible's own text, so this function adds nothing to
// it: a zone with a single batch never enters, and neither does a zone whose
// newest two batches are "alto" then any other level. Freshness is not part of
// the rule - an old "alto" pair still counts, because the summary's coverage block
// already states how many zones are stale - and neither is comparability: D-B
// asks about the levels of the two stored batches, not about whether they came
// from the same model version, demo flag or scenario, which is what the delta
// block compares.
//
// The answer is ordered by zone code and never nil, so an empty catalogue
// serialises as [] rather than null and two calls over the same snapshot return
// the same list in the same order.
func CriticalZones(groups [][]Batch) []string {
	zones := []string{}
	for _, batches := range groups {
		if len(batches) < 2 {
			continue
		}
		if batches[0].RiskLevel != criticalLevel || batches[1].RiskLevel != criticalLevel {
			continue
		}
		zones = append(zones, batches[0].ZoneID)
	}
	sort.Strings(zones)
	return zones
}
