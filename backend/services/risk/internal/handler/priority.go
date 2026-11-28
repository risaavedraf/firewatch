package handler

import (
	"context"
	"encoding/json"

	"firewatch.local/risk/internal/engine"
	"firewatch.local/risk/internal/repository"
	"firewatch.local/risk/internal/source"
)

// batchWithContext is one published batch plus the additive context computed for it:
// the regional priority (V1-P-02 / PM-11) and the commune's land cover (PM-12). The
// batch is embedded, so every member the route already served keeps its name and its
// value; each context member is omitted when it could not be computed, which the
// page renders as an explicit absence instead of a plausible value.
//
// The context lives HERE and never on repository.Batch: the bounded history read
// serves the bare batch, so it must not inherit a member it never answered.
type batchWithContext struct {
	repository.Batch
	Priority  *engine.ZonePriority  `json:"priority,omitempty"`
	LandCover *source.ZoneLandCover `json:"land_cover,omitempty"`
}

// regionalRanking builds the ranking of the published batch. The second return
// value is false when the aggregate read failed: the detail route then answers the
// batch it did read, without borrowing a rank from a batch it could not see.
func regionalRanking(ctx context.Context, store Repository) (engine.Table, bool) {
	batches, err := store.LatestPerZone(ctx)
	if err != nil {
		return engine.Table{}, false
	}
	return engine.Build(batches, source.SyntheticInfrastructure()), true
}

// withPriority attaches one batch's regional context when the ranking holds that
// exact batch, and its commune's land cover when the layer declares it. The priority
// identity is (zone_id, batch_id): a newer publication of the same commune is a
// different batch, so the detail read never borrows a position it did not compute
// for the row it answers.
//
// A factor list that is present but does not match the published shape is corrupt:
// the body is normalised to the documented empty array and the regional context is
// omitted, because the priority would otherwise describe data the wire cannot
// repeat. An absent list is incomplete evidence instead, so its `insufficient`
// context is still served with an empty array. The two context members are
// independent: a batch without a regional position still states its land cover.
func withPriority(batch repository.Batch, table engine.Table) any {
	corruptFactors := len(batch.Factors) > 0 && !engine.ValidWireFactors(batch.Factors)
	batch.Factors = wireFactors(batch.Factors)
	context := batchWithContext{Batch: batch}
	if !corruptFactors {
		if entry, ok := table.For(batch.ZoneID, batch.ID); ok {
			context.Priority = &entry
		}
	}
	if cover, ok := source.VegetationZone(batch.ZoneID); ok {
		context.LandCover = &cover
	}
	if context.Priority == nil && context.LandCover == nil {
		return batch
	}
	return context
}

// wireFactors locks the batch's `factors` member to the shape the contract and the
// client both require: an array of factor objects. Storage can hold bytes that are
// not that shape — a legacy or corrupt row — and republishing them would make the
// response invalid, while inventing factors would be worse, so the documented empty
// array is served instead. A list that is already valid is returned byte for byte.
func wireFactors(raw json.RawMessage) json.RawMessage {
	if engine.ValidWireFactors(raw) {
		return raw
	}
	return json.RawMessage("[]")
}
