package handler

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"firewatch.local/contracts/geo"
	observations "firewatch.local/contracts/observations/v1"
	"firewatch.local/risk/internal/cycle"
	"firewatch.local/risk/internal/quality"
	"firewatch.local/risk/internal/repository"
)

type sourcesResponse struct {
	Geography geographySource               `json:"geography"`
	RiskInput observations.SourceDescriptor `json:"risk_input"`
	// QualityCatalog is the CLOSED catalogue of five findings the service can
	// report. It is published on every answer, including one with no sources, so the
	// page never has to guess the vocabulary from the entries it received.
	QualityCatalog []quality.Definition `json:"quality_catalog"`
	// Sources is the per-source cycle state, the findings derived from served
	// evidence and the source's latest review. It is always present and never null:
	// with no runner configured it is an empty list, so the UI renders "no sources"
	// without a special case.
	Sources []sourceEntry `json:"sources"`
}

type geographySource struct {
	Provenance      map[string]any  `json:"provenance"`
	SourceCutoffAt  *string         `json:"source_cutoff_at"`
	CutoffSemantics string          `json:"cutoff_semantics"`
	Integrity       sourceIntegrity `json:"integrity"`
}

type sourceIntegrity struct {
	Algorithm      string `json:"algorithm"`
	RecordedSHA256 string `json:"recorded_sha256"`
	ComputedSHA256 string `json:"computed_sha256"`
	Matches        bool   `json:"matches"`
}

// parseGeography validates locally embedded artifacts, never paths or source URLs.
// The original bytes, including whitespace, are the integrity input.
func parseGeography(artifact, boundaries []byte) (geographySource, error) {
	var p map[string]any
	if err := json.Unmarshal(artifact, &p); err != nil || p == nil {
		return geographySource{}, fmt.Errorf("invalid provenance")
	}
	for _, key := range []string{"source_id", "provider", "endpoint", "query_sha256", "source_format", "derived_format", "retrieved_at", "cutoff_at", "raw_path", "raw_sha256", "derived_path", "derived_sha256", "attribution", "restriction", "restriction_source", "notes"} {
		value, ok := p[key].(string)
		if !ok || value == "" {
			return geographySource{}, fmt.Errorf("invalid %s", key)
		}
	}
	for _, key := range []string{"retrieved_at", "cutoff_at"} {
		if _, err := time.Parse(time.RFC3339, p[key].(string)); err != nil {
			return geographySource{}, err
		}
	}
	if p["cutoff_at"] != p["retrieved_at"] {
		return geographySource{}, fmt.Errorf("unsupported cutoff semantics")
	}
	for _, key := range []string{"requested_srid", "source_wkid", "record_count", "expected_record_count"} {
		value, ok := p[key].(float64)
		if !ok || value <= 0 || value != float64(int64(value)) {
			return geographySource{}, fmt.Errorf("invalid %s", key)
		}
	}
	for _, key := range []string{"record_count_matches_expected", "complete", "exceeded_transfer_limit"} {
		if _, ok := p[key].(bool); !ok {
			return geographySource{}, fmt.Errorf("invalid %s", key)
		}
	}
	if p["complete"] != true || p["record_count_matches_expected"] != true || p["exceeded_transfer_limit"] != false || p["record_count"] != p["expected_record_count"] {
		return geographySource{}, fmt.Errorf("incomplete artifact")
	}
	recorded := p["derived_sha256"].(string)
	sum := sha256.Sum256(boundaries)
	computed := hex.EncodeToString(sum[:])
	var collection struct {
		Type     string            `json:"type"`
		Features []json.RawMessage `json:"features"`
	}
	if json.Unmarshal(boundaries, &collection) != nil || collection.Type != "FeatureCollection" || float64(len(collection.Features)) != p["record_count"] || recorded != computed {
		return geographySource{}, fmt.Errorf("invalid geography integrity")
	}
	return geographySource{Provenance: p, CutoffSemantics: "retrieval_substitution: stored cutoff_at equals retrieved_at; actual source cutoff is unknown", Integrity: sourceIntegrity{Algorithm: "sha256", RecordedSHA256: recorded, ComputedSHA256: computed, Matches: true}}, nil
}

func sources(provider DescriptorProvider) http.HandlerFunc {
	return sourcesWithCycle(provider, nil)
}

// sourcesWithCycle serves the descriptor and the per-source cycle freshness.
func sourcesWithCycle(provider DescriptorProvider, runner CycleRunner) http.HandlerFunc {
	return sourcesFromWithCycle(provider, runner, nil, geo.ComunasProvenanceJSON, geo.ComunasGeoJSON)
}

func sourcesFrom(provider DescriptorProvider, artifact, boundaries []byte) http.HandlerFunc {
	return sourcesFromWithCycle(provider, nil, nil, artifact, boundaries)
}

// sourcesFromWithCycle serves the geography, the descriptor, the closed quality
// catalogue and one entry per source.
func sourcesFromWithCycle(provider DescriptorProvider, runner CycleRunner, reviews SourceReviewStore, artifact, boundaries []byte) http.HandlerFunc {
	return sourcesFromWithCycleAndClock(provider, runner, reviews, artifact, boundaries, time.Now)
}

// sourcesFromWithCycleAndClock is the same read with an injectable clock. The
// freshness finding is a comparison against "now", so the clock has to be a seam
// for the derivation to be testable without waiting fifteen minutes.
func sourcesFromWithCycleAndClock(
	provider DescriptorProvider,
	runner CycleRunner,
	reviews SourceReviewStore,
	artifact, boundaries []byte,
	now func() time.Time,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		geography, err := parseGeography(artifact, boundaries)
		if err != nil {
			fail(w, http.StatusServiceUnavailable, "geography_integrity_unavailable")
			return
		}
		if provider == nil {
			fail(w, http.StatusServiceUnavailable, "risk_source_unavailable")
			return
		}
		descriptor := provider.Describe()
		if descriptor.ID == "" {
			fail(w, http.StatusServiceUnavailable, "risk_source_unavailable")
			return
		}
		statuses := []cycle.SourceStatus{}
		if runner != nil {
			if reported := runner.Statuses(); reported != nil {
				statuses = reported
			}
		}
		// A failed review read is not an empty state: serving sources with no review
		// would claim nobody reviewed them, which storage did not say.
		stored := map[string]repository.SourceReview{}
		if reviews != nil {
			stored, err = reviews.LatestSourceReviews(r.Context())
			if err != nil {
				fail(w, http.StatusServiceUnavailable, "storage_unavailable")
				return
			}
		}
		// The priority is served bounded to its nominal 0..100 range, and the
		// finding that says it was bounded travels with the value. The descriptor is
		// a value, so this cannot mutate the provider's own copy.
		priority, clamped := quality.BoundedPriority(descriptor.Priority)
		descriptor.Priority = priority
		// The integrity check above already passed, so the checksum finding is a fact
		// this read established rather than a claim it repeats from the artifact.
		nowInstant := now().UTC()
		// The active descriptor describes exactly ONE source. Its synthetic
		// declaration, its canonical factor coverage and its declared priority are
		// evidence about the ACTIVE source, so they are applied only to the entry that
		// is that source. A cycle entry with another identifier is evaluated on its own
		// evidence - its freshness and the checksum this read verified - instead of
		// inheriting traits nobody observed about it: a foreign source is not
		// "synthetic" because this deployment's provider declares itself so, and it is
		// not "missing a canonical factor" because its descriptor is unknown here.
		activeTraits := quality.Evidence{
			MissingFactors:  quality.MissingCanonicalFactors(descriptor.Variables),
			ClampedPriority: clamped,
			Synthetic:       descriptor.Synthetic,
		}
		evidenceFor := func(sourceID string, status cycle.SourceStatus) quality.Evidence {
			evidence := quality.Evidence{
				Stale:            quality.Stale(status.LastRunAt, status.AgeSeconds, nowInstant),
				ChecksumVerified: true,
			}
			if sourceID == descriptor.ID {
				evidence.MissingFactors = activeTraits.MissingFactors
				evidence.ClampedPriority = activeTraits.ClampedPriority
				evidence.Synthetic = activeTraits.Synthetic
			}
			return evidence
		}
		entries := make([]sourceEntry, 0, len(statuses)+1)
		reported := make(map[string]bool, len(statuses))
		for _, status := range statuses {
			reported[status.SourceID] = true
			entries = append(entries, newSourceEntry(status, evidenceFor(status.SourceID, status), stored))
		}
		// The ACTIVE source is a source this deployment serves even when the cycle
		// reports no status for it: a manual-only deployment, or the first tick that
		// has not run yet, has no scheduler entry. Publishing it is what makes the
		// review write readable - the write route accepts a review of the active
		// source, and a read that omitted it would answer "no sources" about a source
		// the API just stored a decision for. It is appended once and last, so the
		// cycle's own order is untouched and a source it already reports is not
		// duplicated. No reading is reported for it: the instants stay null,
		// `complete` stays false and STALE_CUTOFF says exactly that.
		if !reported[descriptor.ID] {
			active := cycle.SourceStatus{SourceID: descriptor.ID}
			entries = append(entries, newSourceEntry(active, evidenceFor(active.SourceID, active), stored))
		}
		respond(w, http.StatusOK, sourcesResponse{
			Geography:      geography,
			RiskInput:      descriptor,
			QualityCatalog: quality.Catalog(),
			Sources:        entries,
		})
	}
}
