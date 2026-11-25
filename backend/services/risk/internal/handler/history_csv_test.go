package handler

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"testing"
	"time"

	"firewatch.local/risk/internal/repository"
)

// historyStore wraps the package fakeStore so the export tests can observe the
// zone and the window the handler asked for, and force a read failure, which
// fakeStore.List cannot express. Everything else — the catalogue membership and
// the per-zone rows — comes from the shared fake.
type historyStore struct {
	*fakeStore
	zones   []string
	limits  []int
	listErr error
}

func (s *historyStore) List(ctx context.Context, zone string, limit int) ([]repository.Batch, error) {
	s.zones = append(s.zones, zone)
	s.limits = append(s.limits, limit)
	if s.listErr != nil {
		return nil, s.listErr
	}
	return s.fakeStore.List(ctx, zone, limit)
}

// wantHistoryCSVHeader is the frozen column seam of the export. It is restated here
// instead of imported from the handler so a column rename or reorder fails this
// test rather than silently following the implementation. The frontend downloads
// these exact names, in this exact order.
var wantHistoryCSVHeader = []string{
	"zone_id",
	"batch_id",
	"job_id",
	"requested_at",
	"published_at",
	"valid_until",
	"model_version",
	"risk_level",
	"data_status",
	"synthetic",
	"scenario_id",
	"evaluated_at",
}

// historyCSVFixture is the deterministic repository answer the JSON and the CSV
// representations are compared over: two published batches of one zone in
// descending request-time order, the older one synthetic, so the comparison
// covers both provenances and the order storage returned.
func historyCSVFixture() []repository.Batch {
	evaluated := time.Date(2026, 11, 2, 7, 40, 0, 0, time.UTC)
	return []repository.Batch{
		{
			ID:           "11111111-1111-4111-8111-111111111111",
			JobID:        "22222222-2222-4222-8222-222222222222",
			ZoneID:       "05101",
			RequestedAt:  time.Date(2026, 11, 2, 8, 0, 0, 0, time.UTC),
			PublishedAt:  time.Date(2026, 11, 2, 8, 1, 0, 0, time.UTC),
			ValidUntil:   time.Date(2026, 11, 2, 8, 16, 0, 0, time.UTC),
			ModelVersion: "academic-rule-v1",
			Demo:         false,
			Geometry:     json.RawMessage(`{"type":"Point","coordinates":[-71.6,-33.0]}`),
			DataStatus:   "current",
			RiskLevel:    "alto",
			Factors:      json.RawMessage(`[]`),
			Rationale:    "Puntaje ponderado alto.",
		},
		{
			ID:           "33333333-3333-4333-8333-333333333333",
			JobID:        "44444444-4444-4444-8444-444444444444",
			ZoneID:       "05101",
			RequestedAt:  time.Date(2026, 11, 2, 7, 45, 0, 0, time.UTC),
			PublishedAt:  time.Date(2026, 11, 2, 7, 46, 0, 0, time.UTC),
			ValidUntil:   time.Date(2026, 11, 2, 8, 1, 0, 0, time.UTC),
			ModelVersion: "firewatch-rule-v2",
			Demo:         true,
			Geometry:     json.RawMessage(`{"type":"Point","coordinates":[-71.6,-33.0]}`),
			DataStatus:   "stale",
			RiskLevel:    "medio",
			Factors:      json.RawMessage(`[]`),
			Rationale:    "Perfil sintético.",
			ScenarioID:   "mixed",
			EvaluatedAt:  &evaluated,
		},
	}
}

// historyStoreWith builds one store over the catalogue and the rows a subtest
// needs, so the JSON and the CSV request each read identical repository data.
func historyStoreWith(batches []repository.Batch) *historyStore {
	return &historyStore{fakeStore: &fakeStore{batches: batches, zones: map[string]bool{"05101": true}}}
}

// parseCSV decodes a recorder's body with the standard reader, asserting the
// media type first: an export that claimed another type would break the browser
// download even when its bytes happened to be CSV.
func parseCSV(t *testing.T, response *httptest.ResponseRecorder) [][]string {
	t.Helper()
	if got := response.Header().Get("Content-Type"); got != "text/csv; charset=utf-8" {
		t.Fatalf("content type is %q, want text/csv; charset=utf-8", got)
	}
	records, err := csv.NewReader(strings.NewReader(response.Body.String())).ReadAll()
	if err != nil {
		t.Fatalf("body is not CSV: %v: %s", err, response.Body.String())
	}
	return records
}

// S1: "una prueba compara el contenido exportado contra la respuesta real". The
// comparison is made over the two real HTTP responses of one deterministic
// repository answer, so a column that means something else than its JSON peer,
// or an ordering the export invents, fails here.
func TestHistoryCSVServesTheSameRowsAsHistoryJSON(t *testing.T) {
	jsonStore := historyStoreWith(historyCSVFixture())
	csvStore := historyStoreWith(historyCSVFixture())
	jsonHandler, jsonToken := authorizedServer(t, "viewer", jsonStore)
	csvHandler, csvToken := authorizedServer(t, "viewer", csvStore)

	jsonResponse := getZones(t, jsonHandler, jsonToken, "/v1/risk/history?zone_id=05101")
	if jsonResponse.Code != http.StatusOK {
		t.Fatalf("history got %d: %s", jsonResponse.Code, jsonResponse.Body.String())
	}
	if got := jsonResponse.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("history content type is %q", got)
	}
	var batches []repository.Batch
	if err := json.Unmarshal(jsonResponse.Body.Bytes(), &batches); err != nil {
		t.Fatalf("history body is not JSON: %v: %s", err, jsonResponse.Body.String())
	}
	if len(batches) != 2 {
		t.Fatalf("history served %d rows, want the fixture's 2: %s", len(batches), jsonResponse.Body.String())
	}
	// The JSON route keeps serving the member the CSV necessarily drops, so the
	// export cannot have replaced it.
	if !strings.Contains(jsonResponse.Body.String(), `"geometry"`) || !strings.Contains(jsonResponse.Body.String(), `"rationale"`) {
		t.Fatalf("history dropped a member it used to serve: %s", jsonResponse.Body.String())
	}

	csvResponse := getZones(t, csvHandler, csvToken, "/v1/risk/history.csv?zone_id=05101")
	if csvResponse.Code != http.StatusOK {
		t.Fatalf("history.csv got %d: %s", csvResponse.Code, csvResponse.Body.String())
	}
	if got := csvResponse.Header().Get("Cache-Control"); !strings.Contains(got, "no-store") {
		// The service sets the directive; a proxy in front of it may append its own
		// no-store for the same response, so the header is a directive that must be
		// present, not an exact value with a guaranteed single occurrence.
		t.Fatalf("Cache-Control is %q, want the no-store directive", got)
	}
	if got := csvResponse.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options is %q, want nosniff", got)
	}
	// The filename declares the zone and the newest publication instant the file
	// contains, and carries nothing a header or a shell could reinterpret.
	wantDisposition := `attachment; filename="risk-history-05101-20261102T080100Z.csv"`
	if got := csvResponse.Header().Get("Content-Disposition"); got != wantDisposition {
		t.Fatalf("Content-Disposition is %q, want %q", got, wantDisposition)
	}

	records := parseCSV(t, csvResponse)
	if len(records) != len(batches)+1 {
		t.Fatalf("export served %d records, want %d data rows plus the header: %s", len(records), len(batches), csvResponse.Body.String())
	}
	if strings.Join(records[0], ",") != strings.Join(wantHistoryCSVHeader, ",") {
		t.Fatalf("header is %v, want %v", records[0], wantHistoryCSVHeader)
	}

	// Both representations select the same zone over the same bounded window, so
	// the export adds no filter and drops no row the page already showed.
	for _, store := range []*historyStore{jsonStore, csvStore} {
		if len(store.zones) != 1 || store.zones[0] != "05101" || len(store.limits) != 1 || store.limits[0] != 100 {
			t.Fatalf("read asked for zone=%v limit=%v, want zone=[05101] limit=[100]", store.zones, store.limits)
		}
	}

	for index, batch := range batches {
		synthetic := "no"
		if batch.Demo {
			synthetic = "yes"
		}
		evaluated := ""
		if batch.EvaluatedAt != nil {
			evaluated = batch.EvaluatedAt.UTC().Format(time.RFC3339Nano)
		}
		want := []string{
			batch.ZoneID,
			batch.ID,
			batch.JobID,
			batch.RequestedAt.UTC().Format(time.RFC3339Nano),
			batch.PublishedAt.UTC().Format(time.RFC3339Nano),
			batch.ValidUntil.UTC().Format(time.RFC3339Nano),
			batch.ModelVersion,
			batch.RiskLevel,
			batch.DataStatus,
			synthetic,
			batch.ScenarioID,
			evaluated,
		}
		row := records[index+1]
		if strings.Join(row, ",") != strings.Join(want, ",") {
			t.Fatalf("row %d is %v, want %v (the values the JSON response served)", index, row, want)
		}
		// parsed back so the column proves to be the JSON instant and not a
		// re-derived wall clock instant.
		for column, cell := range map[int]time.Time{3: batch.RequestedAt, 4: batch.PublishedAt, 5: batch.ValidUntil} {
			instant, err := time.Parse(time.RFC3339Nano, row[column])
			if err != nil || !instant.Equal(cell) {
				t.Fatalf("row %d column %d is %q, want the instant %s", index, column, row[column], cell.UTC().Format(time.RFC3339Nano))
			}
		}
	}

	// The same repository answer must produce the same bytes twice: nothing in
	// the document depends on when it was rendered.
	again := getZones(t, csvHandler, csvToken, "/v1/risk/history.csv?zone_id=05101")
	if again.Body.String() != csvResponse.Body.String() {
		t.Fatalf("two exports of one answer differ:\n%s\n%s", csvResponse.Body.String(), again.Body.String())
	}
}

// An empty history is a valid answer, not an error and not a 404: the export is
// the header row alone, so a spreadsheet or a reader sees named columns and no
// rows instead of an empty or invalid file.
func TestHistoryCSVWithoutRowsIsHeaderOnly(t *testing.T) {
	csvStore := historyStoreWith(nil)
	csvHandler, csvToken := authorizedServer(t, "viewer", csvStore)
	response := getZones(t, csvHandler, csvToken, "/v1/risk/history.csv?zone_id=05101")
	if response.Code != http.StatusOK {
		t.Fatalf("got %d want %d: %s", response.Code, http.StatusOK, response.Body.String())
	}
	if got, want := response.Header().Get("Content-Disposition"), `attachment; filename="risk-history-05101-empty.csv"`; got != want {
		t.Fatalf("Content-Disposition is %q, want %q", got, want)
	}
	records := parseCSV(t, response)
	if len(records) != 1 {
		t.Fatalf("export served %d records, want only the header: %s", len(records), response.Body.String())
	}
	if strings.Join(records[0], ",") != strings.Join(wantHistoryCSVHeader, ",") {
		t.Fatalf("header is %v, want %v", records[0], wantHistoryCSVHeader)
	}

	// The JSON route is deliberately unchanged, including its pre-existing empty
	// body: this export must not have "fixed" it on the way.
	jsonStore := historyStoreWith(nil)
	jsonHandler, jsonToken := authorizedServer(t, "viewer", jsonStore)
	jsonResponse := getZones(t, jsonHandler, jsonToken, "/v1/risk/history?zone_id=05101")
	if jsonResponse.Code != http.StatusOK || strings.TrimSpace(jsonResponse.Body.String()) != "null" {
		t.Fatalf("history changed its empty answer: %d %s", jsonResponse.Code, jsonResponse.Body.String())
	}
}

// The export is admitted by the same bearer gate as the read it mirrors: the
// same status for the same role, and a refused request never reaches storage.
func TestHistoryCSVAccessParity(t *testing.T) {
	for _, tc := range []struct {
		name string
		role string
		want int
	}{
		{"anonymous is refused", "", http.StatusUnauthorized},
		{"a role outside the read gate is forbidden", "operator", http.StatusForbidden},
		{"viewer reads", "viewer", http.StatusOK},
		{"admin reads", "admin", http.StatusOK},
	} {
		for _, target := range []string{"/v1/risk/history?zone_id=05101", "/v1/risk/history.csv?zone_id=05101"} {
			t.Run(tc.name+" "+target, func(t *testing.T) {
				store := historyStoreWith(historyCSVFixture())
				handler, token := authorizedServer(t, tc.role, store)
				r := httptest.NewRequest(http.MethodGet, target, nil)
				if tc.role != "" {
					r.Header.Set("Authorization", "Bearer "+token)
				}
				w := httptest.NewRecorder()
				handler.ServeHTTP(w, r)
				if w.Code != tc.want {
					t.Fatalf("got %d want %d: %s", w.Code, tc.want, w.Body.String())
				}
				if tc.want != http.StatusOK {
					if store.zoneCalls != 0 || store.calls != 0 {
						t.Fatalf("a refused request reached storage: zoneCalls=%d calls=%d", store.zoneCalls, store.calls)
					}
					if got := w.Header().Get("Content-Type"); got != "application/json" {
						t.Fatalf("refusal content type is %q, want the shared JSON error body", got)
					}
				}
			})
		}
	}
}

// A failure is answered exactly as the JSON read answers it: the same status and
// the same error document. A failure is never a CSV file, so a client that saved
// the response would save an error body, not an empty export.
func TestHistoryCSVFailureParity(t *testing.T) {
	for _, tc := range []struct {
		name    string
		query   string
		zones   map[string]bool
		zoneErr error
		listErr error
		want    int
	}{
		{"missing zone parameter", "", nil, nil, nil, http.StatusBadRequest},
		{"empty zone parameter", "?zone_id=", nil, nil, nil, http.StatusBadRequest},
		{"repeated zone parameter", "?zone_id=05101&zone_id=05101", nil, nil, nil, http.StatusBadRequest},
		// S2: the export adds no filter. Any parameter the JSON read does not
		// accept is rejected here too, instead of narrowing the file silently.
		{"unsupported filter", "?zone_id=05101&limit=5", nil, nil, nil, http.StatusBadRequest},
		{"zone outside the catalogue", "?zone_id=other", nil, nil, nil, http.StatusBadRequest},
		{"catalogue unavailable", "?zone_id=05101", nil, errors.New("storage unavailable"), nil, http.StatusServiceUnavailable},
		{"read unavailable", "?zone_id=05101", map[string]bool{"05101": true}, nil, errors.New("storage unavailable"), http.StatusServiceUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			run := func(target string) *httptest.ResponseRecorder {
				zones := tc.zones
				if zones == nil {
					zones = map[string]bool{"05101": true}
				}
				store := &historyStore{
					fakeStore: &fakeStore{batches: historyCSVFixture(), zones: zones, zoneErr: tc.zoneErr},
					listErr:   tc.listErr,
				}
				handler, token := authorizedServer(t, "viewer", store)
				return getZones(t, handler, token, target)
			}
			jsonResponse := run("/v1/risk/history" + tc.query)
			csvResponse := run("/v1/risk/history.csv" + tc.query)
			if jsonResponse.Code != tc.want || csvResponse.Code != tc.want {
				t.Fatalf("history=%d history.csv=%d want both %d: json=%s csv=%s",
					jsonResponse.Code, csvResponse.Code, tc.want, jsonResponse.Body.String(), csvResponse.Body.String())
			}
			if got := csvResponse.Header().Get("Content-Type"); got != "application/json" {
				t.Fatalf("failure content type is %q, want application/json", got)
			}
			if got := csvResponse.Header().Get("Content-Disposition"); got != "" {
				t.Fatalf("a failure was offered as a download: %q", got)
			}
			if jsonResponse.Body.String() != csvResponse.Body.String() {
				t.Fatalf("failure bodies differ: json=%s csv=%s", jsonResponse.Body.String(), csvResponse.Body.String())
			}
			var body struct {
				Code string `json:"code"`
			}
			if err := json.Unmarshal(csvResponse.Body.Bytes(), &body); err != nil || body.Code == "" {
				t.Fatalf("failure body is not the shared error document: %v: %s", err, csvResponse.Body.String())
			}
		})
	}
}

// CSV cannot escape the one shape a spreadsheet still evaluates: a cell whose
// first character starts a formula. The export serves only scalar, bounded
// values, and this pins that a value produced outside those bounds is neutralised
// instead of being handed to a spreadsheet as a formula.
func TestHistoryCSVNeutralisesSpreadsheetFormulaCells(t *testing.T) {
	const hostileZone = "=cmd|' /C calc'!A0"
	const hostileModel = "@SUM(A1:A2)"
	// A leading line break is the case a first cut of the guard missed: a
	// spreadsheet can discard it as whitespace and then read the rest as a formula.
	const hostileScenario = "\n=1+1"
	evaluated := time.Date(2026, 11, 2, 7, 40, 0, 0, time.UTC)
	batches := []repository.Batch{{
		ID:           "55555555-5555-4555-8555-555555555555",
		JobID:        "66666666-6666-4666-8666-666666666666",
		ZoneID:       hostileZone,
		RequestedAt:  time.Date(2026, 11, 2, 8, 0, 0, 0, time.UTC),
		PublishedAt:  time.Date(2026, 11, 2, 8, 1, 0, 0, time.UTC),
		ValidUntil:   time.Date(2026, 11, 2, 8, 16, 0, 0, time.UTC),
		ModelVersion: hostileModel,
		Demo:         true,
		DataStatus:   "current",
		RiskLevel:    "alto",
		Factors:      json.RawMessage(`[]`),
		ScenarioID:   hostileScenario,
		EvaluatedAt:  &evaluated,
	}}
	store := &historyStore{fakeStore: &fakeStore{batches: batches, zones: map[string]bool{hostileZone: true}}}
	handler, token := authorizedServer(t, "viewer", store)
	response := getZones(t, handler, token, "/v1/risk/history.csv?zone_id="+url.QueryEscape(hostileZone))
	if response.Code != http.StatusOK {
		t.Fatalf("got %d want %d: %s", response.Code, http.StatusOK, response.Body.String())
	}
	// The filename is a fixed shape with a validated, reduced zone segment: no
	// quote can end the header value and no control byte can split it.
	safeName := regexp.MustCompile(`^attachment; filename="risk-history-[A-Za-z0-9._-]+\.csv"$`)
	if got := response.Header().Get("Content-Disposition"); !safeName.MatchString(got) {
		t.Fatalf("filename is not reducible to a safe token: %q", got)
	}
	records := parseCSV(t, response)
	if len(records) != 2 {
		t.Fatalf("got %d records, want the header and the hostile row: %s", len(records), response.Body.String())
	}
	for _, row := range records[1:] {
		for column, cell := range row {
			switch {
			case strings.HasPrefix(cell, "="), strings.HasPrefix(cell, "+"),
				strings.HasPrefix(cell, "-"), strings.HasPrefix(cell, "@"),
				strings.HasPrefix(cell, "\t"), strings.HasPrefix(cell, "\r"),
				strings.HasPrefix(cell, "\n"):
				t.Fatalf("column %d is still evaluated as a formula: %q", column, cell)
			}
		}
	}
	// Neutralised, not rewritten: the original value survives so the row stays
	// attributable and comparable with the JSON member it came from.
	for column, want := range map[int]string{0: hostileZone, 6: hostileModel, 10: hostileScenario} {
		if got := strings.TrimPrefix(records[1][column], "'"); got != want {
			t.Fatalf("column %d is %q, want the original %q", column, records[1][column], want)
		}
	}
}

// The export is encoded by encoding/csv, not by concatenation, and the format the
// contract claims has to be the bytes on the wire: records end with a bare LF, a
// field is quoted only when it needs to be, an embedded quote is doubled, and a
// CRLF inside a quoted field is written raw. A Go reader then normalises that
// CRLF to LF, so the raw bytes and the parsed value are asserted separately
// instead of being conflated.
func TestHistoryCSVRetainsRawCRLFInsideAQuotedCell(t *testing.T) {
	const awkward = "mixed, \"legacy\"\r\nsecond line"
	batches := []repository.Batch{{
		ID:           "77777777-7777-4777-8777-777777777777",
		JobID:        "88888888-8888-4888-8888-888888888888",
		ZoneID:       "05101",
		RequestedAt:  time.Date(2026, 11, 2, 8, 0, 0, 0, time.UTC),
		PublishedAt:  time.Date(2026, 11, 2, 8, 1, 0, 0, time.UTC),
		ValidUntil:   time.Date(2026, 11, 2, 8, 16, 0, 0, time.UTC),
		ModelVersion: "academic-rule-v1",
		DataStatus:   "current",
		RiskLevel:    "bajo",
		Factors:      json.RawMessage(`[]`),
		ScenarioID:   awkward,
	}}
	store := historyStoreWith(batches)
	handler, token := authorizedServer(t, "viewer", store)
	response := getZones(t, handler, token, "/v1/risk/history.csv?zone_id=05101")
	if response.Code != http.StatusOK {
		t.Fatalf("got %d want %d: %s", response.Code, http.StatusOK, response.Body.String())
	}
	raw := response.Body.String()

	// Raw bytes: the quoted cell keeps its CRLF, the inner quotes are doubled, and
	// the only CRLF in the document is the one inside that cell, because the writer
	// terminates records with LF.
	const wantCell = "\"mixed, \"\"legacy\"\"\r\nsecond line\""
	if !strings.Contains(raw, wantCell) {
		t.Fatalf("raw export does not carry the quoted cell %q: %q", wantCell, raw)
	}
	if got := strings.Count(raw, "\r\n"); got != 1 {
		t.Fatalf("raw export carries %d CRLF sequences, want the 1 inside the quoted cell: %q", got, raw)
	}
	if !strings.HasSuffix(raw, "\n") || strings.HasSuffix(raw, "\r\n") {
		t.Fatalf("records are not terminated by a bare LF: %q", raw)
	}

	// Parsed value: the reader normalises the CRLF inside the quoted field to LF,
	// which is why the two views are asserted apart and neither is described as RFC
	// 4180 without the caveat.
	records := parseCSV(t, response)
	if len(records) != 2 {
		t.Fatalf("a quoted separator or line break split the file into %d records: %q", len(records), raw)
	}
	if got, want := records[1][10], strings.ReplaceAll(awkward, "\r\n", "\n"); got != want {
		t.Fatalf("parsed scenario_id is %q, want %q", got, want)
	}
	if strings.Contains(records[1][10], "\r") {
		t.Fatalf("the reader returned a carriage return: %q", records[1][10])
	}
}

// The formula guard covers the four symbol prefixes and the leading whitespace a
// spreadsheet may discard before reading the rest of a cell as a formula. This
// pins the line break, the prefix the first cut of the guard missed.
func TestCSVSafeCellNeutralisesLeadingLineBreaks(t *testing.T) {
	for _, tc := range []struct {
		name  string
		value string
		want  string
	}{
		{"a catalogue code is untouched", "05101", "05101"},
		{"a trigger inside the value is untouched", "a=b", "a=b"},
		{"an equals prefix is neutralised", "=1+1", "'=1+1"},
		{"a plus prefix is neutralised", "+1+1", "'+1+1"},
		{"a minus prefix is neutralised", "-1+1", "'-1+1"},
		{"an at prefix is neutralised", "@SUM(A1)", "'@SUM(A1)"},
		{"a tab prefix is neutralised", "\t=1+1", "'\t=1+1"},
		{"a carriage return prefix is neutralised", "\r=1+1", "'\r=1+1"},
		{"a line feed prefix is neutralised", "\n=1+1", "'\n=1+1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := csvSafeCell(tc.value); got != tc.want {
				t.Fatalf("csvSafeCell(%q) = %q, want %q", tc.value, got, tc.want)
			}
		})
	}
}

// The attachment name is the only part of the export a caller sees before
// opening it, and it is built from a validated zone code. It must stay a fixed,
// bounded token whatever the catalogue holds: no quote can end the header value,
// no separator can escape the filename, no control byte can split the header and
// no unbounded code can grow it.
func TestHistoryCSVFilenameStaysASafeBoundedToken(t *testing.T) {
	const newest = "20261102T080100Z"
	safeName := regexp.MustCompile(`^attachment; filename="risk-history-[A-Za-z0-9._-]+-` + newest + `\.csv"$`)
	limit := len(`attachment; filename="risk-history-`) + 64 + len(`-`+newest+`.csv"`)
	for _, tc := range []struct {
		name string
		zone string
	}{
		{"a CUT code", "05101"},
		{"the legacy demo code", "valparaiso-demo"},
		{"a path separator", "../../etc/passwd"},
		{"a quote and a space", `a" b`},
		{"a control byte", "05101\r\nX-Evil: 1"},
		{"a code longer than the bound", strings.Repeat("z", 200)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &historyStore{fakeStore: &fakeStore{batches: historyCSVFixture(), zones: map[string]bool{tc.zone: true}}}
			handler, token := authorizedServer(t, "viewer", store)
			response := getZones(t, handler, token, "/v1/risk/history.csv?zone_id="+url.QueryEscape(tc.zone))
			if response.Code != http.StatusOK {
				t.Fatalf("got %d want %d: %s", response.Code, http.StatusOK, response.Body.String())
			}
			disposition := response.Header().Get("Content-Disposition")
			if !safeName.MatchString(disposition) {
				t.Fatalf("filename is not a safe bounded token: %q", disposition)
			}
			if len(disposition) > limit {
				t.Fatalf("filename grew with the zone code: %d bytes: %q", len(disposition), disposition)
			}
		})
	}
}
