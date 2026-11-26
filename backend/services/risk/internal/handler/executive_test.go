package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"testing"
	"time"

	"firewatch.local/risk/internal/repository"
)

func TestRiskExecutiveSummaryContract(t *testing.T) {
	const path = "/v1/risk/executive-summary"
	contract := loadContract(t)
	batch := func(level string) repository.Batch {
		return repository.Batch{RiskLevel: level, ModelVersion: "v1", ValidUntil: time.Now().Add(time.Hour)}
	}
	high := batch("alto")
	high.Factors = json.RawMessage(`[{"name":"viento","known":true,"contribution":0.7},{"name":"temperatura","known":false,"contribution":0.9},{"name":"humedad_relativa","known":true,"contribution":0}]`)
	demo := batch("bajo")
	demo.Demo = true
	demo.ValidUntil = time.Now().Add(-time.Hour)
	otherModel := batch("medio")
	otherModel.ModelVersion = "v2"
	otherScenario := batch("bajo")
	otherScenario.ScenarioID = "scenario"
	for _, tc := range []struct {
		name, query, body string
		store             *fakeStore
		status, calls     int
	}{
		{"populated", "", `{"coverage":{"catalogue_zones":7,"zones_without_batch":1,"stale_zones":1,"demo_zones":1},"levels":{"alto":1,"medio":0,"bajo":4,"desconocido":1},"delta":{"zones_compared":2,"zones_changed":1,"zones_without_previous":1,"zones_incomparable":3,"transitions":[{"from":"medio","to":"alto","zones":1}]},"predominant_variables":[{"name":"viento","zones":1}]}`,
			&fakeStore{executiveBatches: [][]repository.Batch{
				{high, batch("medio")}, {batch("bajo"), otherModel}, {demo, batch("medio")},
				{batch("bajo"), otherScenario}, {batch("bajo"), batch("bajo")},
				{batch("desconocido")}, nil,
			}}, 200, 1},
		{"empty", "", `{"coverage":{"catalogue_zones":0,"zones_without_batch":0,"stale_zones":0,"demo_zones":0},"levels":{"alto":0,"medio":0,"bajo":0,"desconocido":0},"delta":{"zones_compared":0,"zones_changed":0,"zones_without_previous":0,"zones_incomparable":0,"transitions":[]},"predominant_variables":[]}`, &fakeStore{}, 200, 1},
		{"unexpected query", "?zone_id=05101", "invalid_executive_summary_query", &fakeStore{}, 400, 0},
		{"storage unavailable", "", "storage_unavailable", &fakeStore{executiveErr: errors.New("offline")}, 503, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			base, token := authorizedServer(t, "viewer", tc.store)
			w := request(t, withCorrelationID(base), token, path+tc.query)
			if w.Code != tc.status {
				t.Fatalf("got %d want %d: %s", w.Code, tc.status, w.Body)
			}
			assertResponseMatchesContract(t, contract, path, http.MethodGet, w)
			if tc.store.executiveCalls != tc.calls || tc.store.calls != 0 {
				t.Fatalf("summary calls=%d, per-zone calls=%d", tc.store.executiveCalls, tc.store.calls)
			}
			var got, want map[string]any
			if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if tc.status != http.StatusOK {
				if got["code"] != tc.body {
					t.Fatalf("unexpected error: %s", w.Body)
				}
				return
			}
			if err := json.Unmarshal([]byte(tc.body), &want); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("got %s, want %s", w.Body, tc.body)
			}
		})
	}
}
