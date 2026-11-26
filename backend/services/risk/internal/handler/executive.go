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

type executiveReport struct {
	Coverage             summaryCoverage   `json:"coverage"`
	Levels               map[string]int    `json:"levels"`
	Delta                summaryDelta      `json:"delta"`
	PredominantVariables []summaryVariable `json:"predominant_variables"`
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
		report, err := buildExecutiveReport(groups, time.Now())
		if err != nil {
			fail(w, http.StatusServiceUnavailable, "storage_unavailable")
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		respond(w, http.StatusOK, report)
	}
}

func buildExecutiveReport(groups [][]repository.Batch, now time.Time) (executiveReport, error) {
	report := executiveReport{
		Coverage:             summaryCoverage{CatalogueZones: len(groups)},
		Levels:               make(map[string]int),
		Delta:                summaryDelta{Transitions: []summaryTransition{}},
		PredominantVariables: []summaryVariable{},
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
