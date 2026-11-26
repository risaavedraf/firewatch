package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"firewatch.local/risk/internal/repository"
)

// batchFixture builds one published batch for one catalogue zone. The zone code
// is carried on every element because D-B answers zone ids: a fixture without one
// could not tell a critical zone from an empty string.
func batchFixture(zone, level string) repository.Batch {
	return repository.Batch{ZoneID: zone, RiskLevel: level, ModelVersion: "v1", ValidUntil: time.Now().Add(time.Hour)}
}

func TestRiskExecutiveSummaryContract(t *testing.T) {
	const path = "/v1/risk/executive-summary"
	contract := loadContract(t)
	high := batchFixture("05101", "alto")
	high.Factors = json.RawMessage(`[{"name":"viento","known":true,"contribution":0.7},{"name":"temperatura","known":false,"contribution":0.9},{"name":"humedad_relativa","known":true,"contribution":0}]`)
	demo := batchFixture("05103", "bajo")
	demo.Demo = true
	demo.ValidUntil = time.Now().Add(-time.Hour)
	otherModel := batchFixture("05105", "alto")
	otherModel.ModelVersion = "v2"
	otherScenario := batchFixture("05104", "bajo")
	otherScenario.ScenarioID = "scenario"
	// The populated catalogue, newest batch first per zone:
	//   05101 alto after medio            - a rise, not D-B
	//   05102 alto, alto                  - D-B
	//   05103 bajo (demo, stale) after medio, demo flag differs -> incomparable
	//   05104 bajo after otro escenario   - incomparable
	//   05105 alto, alto across versions  - D-B: the rule asks for levels, not comparability
	//   05106 desconocido                 - one batch only
	//   a catalogue zone with no batch    - counted as without batch, never as unknown
	populated := [][]repository.Batch{
		{high, batchFixture("05101", "medio")},
		{batchFixture("05102", "alto"), batchFixture("05102", "alto")},
		{demo, batchFixture("05103", "medio")},
		{batchFixture("05104", "bajo"), otherScenario},
		{otherModel, batchFixture("05105", "alto")},
		{batchFixture("05106", "desconocido")},
		nil,
	}
	for _, tc := range []struct {
		name, query, body         string
		store                     *fakeStore
		status, calls, alertCalls int
	}{
		{"populated", "", `{"coverage":{"catalogue_zones":7,"zones_without_batch":1,"stale_zones":1,"demo_zones":1},"levels":{"alto":3,"medio":0,"bajo":2,"desconocido":1},"delta":{"zones_compared":2,"zones_changed":1,"zones_without_previous":1,"zones_incomparable":3,"transitions":[{"from":"medio","to":"alto","zones":1}]},"predominant_variables":[{"name":"viento","zones":1}],"critical_zones":{"count":2,"zone_ids":["05102","05105"]},"active_alerts":{"count":4}}`,
			&fakeStore{alertCount: 4, executiveBatches: populated}, 200, 1, 1},
		{"empty", "", `{"coverage":{"catalogue_zones":0,"zones_without_batch":0,"stale_zones":0,"demo_zones":0},"levels":{"alto":0,"medio":0,"bajo":0,"desconocido":0},"delta":{"zones_compared":0,"zones_changed":0,"zones_without_previous":0,"zones_incomparable":0,"transitions":[]},"predominant_variables":[],"critical_zones":{"count":0,"zone_ids":[]},"active_alerts":{"count":0}}`, &fakeStore{}, 200, 1, 1},
		{"unexpected query", "?zone_id=05101", "invalid_executive_summary_query", &fakeStore{}, 400, 0, 0},
		{"storage unavailable", "", "storage_unavailable", &fakeStore{executiveErr: errors.New("offline")}, 503, 1, 0},
		// A failed alert tally is a storage failure, never `count: 0`: the two
		// answers mean different things and only one of them was observed.
		{"alert count unavailable", "", "storage_unavailable", &fakeStore{alertCountErr: errors.New("offline"), executiveBatches: populated}, 503, 1, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			base, token := authorizedServer(t, "viewer", tc.store)
			w := request(t, withCorrelationID(base), token, path+tc.query)
			if w.Code != tc.status {
				t.Fatalf("got %d want %d: %s", w.Code, tc.status, w.Body)
			}
			assertResponseMatchesContract(t, contract, path, http.MethodGet, w)
			if tc.store.executiveCalls != tc.calls || tc.store.calls != 0 || tc.store.alertCountCalls != tc.alertCalls {
				t.Fatalf("summary calls=%d, per-zone calls=%d, alert count calls=%d",
					tc.store.executiveCalls, tc.store.calls, tc.store.alertCountCalls)
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

// TestExecutiveCriticalZones pins D-B exactly as the responsible wrote it: "Alto
// sostenido dos lotes". Every case is a rule boundary, not a variation of the same
// input: what makes a zone critical is the pair of levels in its two newest
// published batches, so a single high batch, a high batch followed by a lower
// newest level, and a zone with no batches all stay out.
//
// The last two cases name what the definition deliberately does NOT restrict.
// Freshness and comparability belong to the coverage and delta blocks; D-B asks
// only for the two stored levels, so a stale pair and a pair across model versions
// still count. Dropping either would make the panel's label ("Alto en los dos
// últimos lotes") claim something the count did not do.
func TestExecutiveCriticalZones(t *testing.T) {
	locate := func(zone string) []repository.Batch {
		return []repository.Batch{batchFixture(zone, "alto"), batchFixture(zone, "alto")}
	}
	stale := batchFixture("05103", "alto")
	stale.ValidUntil = time.Now().Add(-time.Hour)
	demo := batchFixture("05104", "alto")
	demo.Demo = true
	olderModel := batchFixture("05105", "alto")
	olderModel.ModelVersion = "v0"
	for _, tc := range []struct {
		name   string
		groups [][]repository.Batch
		want   []string
	}{
		{"two consecutive high batches", [][]repository.Batch{locate("05102")}, []string{"05102"}},
		{"high after a lower level is a rise, not D-B", [][]repository.Batch{{batchFixture("05101", "alto"), batchFixture("05101", "medio")}}, []string{}},
		{"a lower newest level is not D-B even after a high batch", [][]repository.Batch{{batchFixture("05101", "medio"), batchFixture("05101", "alto")}}, []string{}},
		{"a single high batch is not enough", [][]repository.Batch{{batchFixture("05106", "alto")}}, []string{}},
		{"a zone without batches is not critical", [][]repository.Batch{nil}, []string{}},
		{"the answer is ordered by zone id", [][]repository.Batch{
			locate("05109"),
			locate("05101"),
			locate("05105"),
		}, []string{"05101", "05105", "05109"}},
		{"a stale pair still counts: freshness is the coverage block's claim", [][]repository.Batch{{stale, batchFixture("05103", "alto")}}, []string{"05103"}},
		{"a demo pair still counts", [][]repository.Batch{{demo, batchFixture("05104", "alto")}}, []string{"05104"}},
		{"a pair across model versions still counts: comparability is the delta block's claim", [][]repository.Batch{{batchFixture("05105", "alto"), olderModel}}, []string{"05105"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			report, err := buildExecutiveReport(tc.groups, 0, time.Now())
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(report.CriticalZones.ZoneIDs, tc.want) {
				t.Fatalf("got zone_ids %v, want %v", report.CriticalZones.ZoneIDs, tc.want)
			}
			// Count is the length of the list it reports, so the two members can
			// never disagree on the wire.
			if report.CriticalZones.Count != len(report.CriticalZones.ZoneIDs) {
				t.Fatalf("count=%d but zone_ids has %d elements", report.CriticalZones.Count, len(report.CriticalZones.ZoneIDs))
			}
			if tc.want != nil && len(tc.want) == 0 && report.CriticalZones.ZoneIDs == nil {
				t.Fatal("zone_ids is nil, so the empty answer would serialise as null instead of []")
			}
		})
	}
}

// TestExecutiveSummarySerialisesEmptyCriticalZonesAsList pins the wire shape of
// the two new members. The contract declares an array of strings and an integer,
// so an empty catalogue must answer [] and 0 - never null, and never an absent
// member the panel would have to guess about.
func TestExecutiveSummarySerialisesEmptyCriticalZonesAsList(t *testing.T) {
	report, err := buildExecutiveReport(nil, 0, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"critical_zones":{"count":0,"zone_ids":[]}`, `"active_alerts":{"count":0}`} {
		if !strings.Contains(string(body), want) {
			t.Fatalf("summary body lost %s: %s", want, body)
		}
	}
}
