package handler

import (
	"encoding/json"
	"net/http"
	"sort"
	"time"

	"firewatch.local/risk/internal/classify"
	"firewatch.local/risk/internal/repository"
)

type summaryCoverage struct {
	CatalogueZones    int `json:"catalogue_zones"`
	ZonesWithoutBatch int `json:"zones_without_batch"`
	StaleZones        int `json:"stale_zones"`
	DemoZones         int `json:"demo_zones"`
}

type summaryTransition struct {
	From  string `json:"from"`
	To    string `json:"to"`
	Zones int    `json:"zones"`
}

type summaryDelta struct {
	ZonesCompared        int                 `json:"zones_compared"`
	ZonesChanged         int                 `json:"zones_changed"`
	ZonesWithoutPrevious int                 `json:"zones_without_previous"`
	ZonesIncomparable    int                 `json:"zones_incomparable"`
	Transitions          []summaryTransition `json:"transitions"`
}

type summaryVariable struct {
	Name  string `json:"name"`
	Zones int    `json:"zones"`
}

// summaryCriticalZones is D-B ("Alto sostenido dos lotes") on the wire: the zone
// ids whose two newest published batches are both "alto", ordered by zone id, and
// the count of that same list. Count is derived from ZoneIDs, never tallied
// separately, so the two members cannot disagree.
type summaryCriticalZones struct {
	Count   int      `json:"count"`
	ZoneIDs []string `json:"zone_ids"`
}

// summaryAlerts is the registered-alert tally. It states how many rows the alert
// writer stored and nothing else: no read mark, no dismissal, no unread badge.
type summaryAlerts struct {
	Count int `json:"count"`
}

type executiveReport struct {
	Coverage             summaryCoverage      `json:"coverage"`
	Levels               map[string]int       `json:"levels"`
	Delta                summaryDelta         `json:"delta"`
	PredominantVariables []summaryVariable    `json:"predominant_variables"`
	CriticalZones        summaryCriticalZones `json:"critical_zones"`
	ActiveAlerts         summaryAlerts        `json:"active_alerts"`
}

func executiveSummary(store Repository) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RawQuery != "" {
			fail(w, http.StatusBadRequest, "invalid_executive_summary_query")
			return
		}
		groups, err := store.ExecutiveBatches(r.Context())
		if err != nil {
			fail(w, http.StatusServiceUnavailable, "storage_unavailable")
			return
		}
		// The alert tally is read in the same request. A failed count is a storage
		// failure like any other: the summary never reports 0 alerts it did not
		// observe, because "no alerts" and "the table was unreadable" are different
		// answers and only one of them is true.
		alerts, err := store.ExecutiveAlertCount(r.Context())
		if err != nil {
			fail(w, http.StatusServiceUnavailable, "storage_unavailable")
			return
		}
		report, err := buildExecutiveReport(groups, alerts, time.Now())
		if err != nil {
			fail(w, http.StatusServiceUnavailable, "storage_unavailable")
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		respond(w, http.StatusOK, report)
	}
}

// buildExecutiveReport composes the whole summary from one batch snapshot and one
// alert tally. Both arrive already read: this function issues no query and holds
// no state, so every member it returns is derived from what storage answered in
// this one request.
func buildExecutiveReport(groups [][]repository.Batch, alerts int, now time.Time) (executiveReport, error) {
	// D-B is applied to the snapshot's newest two batches per zone, exactly as
	// ExecutiveBatches serves them. The list is the report's own source for count,
	// so the two members cannot drift.
	critical := repository.CriticalZones(groups)
	report := executiveReport{
		Coverage:             summaryCoverage{CatalogueZones: len(groups)},
		Levels:               make(map[string]int),
		Delta:                summaryDelta{Transitions: []summaryTransition{}},
		PredominantVariables: []summaryVariable{},
		CriticalZones:        summaryCriticalZones{Count: len(critical), ZoneIDs: critical},
		ActiveAlerts:         summaryAlerts{Count: alerts},
	}
	for _, level := range classify.Levels() {
		report.Levels[string(level)] = 0
	}

	variables := make(map[string]int)
	transitions := make(map[[2]string]int)
	for _, batches := range groups {
		if len(batches) == 0 {
			report.Coverage.ZonesWithoutBatch++
			continue
		}
		latest := batches[0]
		report.Levels[latest.RiskLevel]++
		if !now.Before(latest.ValidUntil) {
			report.Coverage.StaleZones++
		}
		if latest.Demo {
			report.Coverage.DemoZones++
		}
		var factors []classify.Factor
		if len(latest.Factors) != 0 {
			if err := json.Unmarshal(latest.Factors, &factors); err != nil {
				return executiveReport{}, err
			}
		}
		var strongest classify.Factor
		for _, factor := range factors {
			if !factor.Known || factor.Name == "" || factor.Contribution <= 0 {
				continue
			}
			if factor.Contribution > strongest.Contribution ||
				(factor.Contribution == strongest.Contribution && factor.Name < strongest.Name) {
				strongest = factor
			}
		}
		if strongest.Name != "" {
			variables[strongest.Name]++
		}

		if len(batches) == 1 {
			report.Delta.ZonesWithoutPrevious++
			continue
		}
		previous := batches[1]
		if previous.ModelVersion != latest.ModelVersion ||
			previous.Demo != latest.Demo || previous.ScenarioID != latest.ScenarioID {
			report.Delta.ZonesIncomparable++
			continue
		}
		report.Delta.ZonesCompared++
		if previous.RiskLevel != latest.RiskLevel {
			report.Delta.ZonesChanged++
			transitions[[2]string{previous.RiskLevel, latest.RiskLevel}]++
		}
	}

	for pair, zones := range transitions {
		report.Delta.Transitions = append(report.Delta.Transitions, summaryTransition{pair[0], pair[1], zones})
	}
	sort.Slice(report.Delta.Transitions, func(i, j int) bool {
		a, b := report.Delta.Transitions[i], report.Delta.Transitions[j]
		if a.From != b.From {
			return a.From < b.From
		}
		return a.To < b.To
	})
	for name, zones := range variables {
		report.PredominantVariables = append(report.PredominantVariables, summaryVariable{name, zones})
	}
	sort.Slice(report.PredominantVariables, func(i, j int) bool {
		a, b := report.PredominantVariables[i], report.PredominantVariables[j]
		if a.Zones != b.Zones {
			return a.Zones > b.Zones
		}
		return a.Name < b.Name
	})
	return report, nil
}
