package handler

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"

	observations "firewatch.local/contracts/observations/v1"
	"firewatch.local/risk/internal/repository"
	"firewatch.local/risk/internal/source"
)

type Repository interface {
	List(context.Context, string, int) ([]repository.Batch, error)
	// LatestPerZone reads the newest published batch of every zone in one query,
	// ordered by zone_id. A zone with no published batch is absent from the
	// answer, and an empty result is a valid answer rather than an error.
	LatestPerZone(ctx context.Context) ([]repository.Batch, error)
	// ExecutiveBatches reads the newest two published batches of every catalogue
	// zone, newest first, in one snapshot. D-B criticality and the delta block are
	// both decided from this single read, so a zone can never be counted in one
	// block from batches the other block did not see.
	ExecutiveBatches(ctx context.Context) ([][]repository.Batch, error)
	// ExecutiveAlertCount counts the stored level-change alerts for the executive
	// summary. It filters nothing and reports no read or dismissed state: the
	// summary states how many alert rows exist, and the lifecycle is PM-08's. A
	// failed count is a storage failure, never a zero.
	ExecutiveAlertCount(ctx context.Context) (int, error)
	// ZoneExists reports whether the zone catalogue holds code. Membership is a
	// property of the data, not of a literal compiled into this service, so the
	// read path asks the catalogue instead of comparing to a hardcoded zone.
	ZoneExists(ctx context.Context, code string) (bool, error)
	// ListZones reads the catalogue. A nil bbox asks for every zone that has a
	// geometry; a non-nil bbox asks for the ones intersecting it. An empty
	// result is a valid answer, not an error.
	ListZones(ctx context.Context, bbox *repository.BBox) ([]repository.Zone, error)
	// ListModels reads the model registry for the version panel.
	ListModels(ctx context.Context) ([]repository.ModelVersion, error)
	// ActivateModel makes one version active and records its approval atomically.
	ActivateModel(ctx context.Context, version string) (repository.ModelVersion, error)
	// ListAlerts reads one page of the persisted level-change alerts, newest first
	// by default, with a stable keyset boundary. An empty page is a valid answer,
	// not an error.
	ListAlerts(ctx context.Context, query repository.AlertPageQuery) (repository.AlertPage, error)
	// HistorySeries reads at most one point per zone and bucket inside a half-open
	// window of requested_at, in one bucketed query. It exists so the granular
	// history is answered by one read for the whole territory instead of one read
	// per zone; an empty result is a valid answer, not an error.
	HistorySeries(ctx context.Context, query repository.HistorySeriesQuery) ([]repository.HistoryPoint, error)
	// CompareZones reads one comparison snapshot in a single statement: the newest
	// batch of each requested zone strictly before the shared cutoff, plus the
	// PM-04 buckets inside the half-open window. A requested zone with no eligible
	// batch is simply absent from the assessment half, which the handler serves as
	// a null assessment; an empty result is a valid answer, not an error.
	CompareZones(ctx context.Context, query repository.ComparisonQuery) (repository.ComparisonSnapshot, error)
}

// DescriptorProvider is the read-only description surface of the active publisher provider.
type DescriptorProvider interface {
	Describe() observations.SourceDescriptor
}

func New(store Repository, verifier Verifier, providers ...DescriptorProvider) http.Handler {
	return NewWithCycle(store, verifier, nil, nil, providers...)
}

// NewWithStatus preserves the descriptor-only New API and its provider identity.
func NewWithStatus(store Repository, verifier Verifier, check StatusCheck, providers ...DescriptorProvider) http.Handler {
	return NewWithCycle(store, verifier, check, nil, providers...)
}

// NewWithCycle is the full constructor: it adds the 15 minute cycle to the read
// routes. A nil runner keeps every existing route working and makes the manual
// trigger answer cycle_unavailable, so a deployment that does not schedule a
// cycle is still valid. The sources route (sources.go) carries the freshness.
func NewWithCycle(store Repository, verifier Verifier, check StatusCheck, runner CycleRunner, providers ...DescriptorProvider) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/risk/status", statusHandler(check))
	mux.HandleFunc("GET /v1/risk/latest", latestBatch(store))
	mux.HandleFunc("GET /v1/risk/history", history(store))
	// The export is registered as its own exact path next to the JSON read it
	// mirrors: it is additive, and the pair shares one read (readHistory), one
	// zone gate and one window, so neither representation can drift from the other.
	mux.HandleFunc("GET /v1/risk/history.csv", historyCSV(store))
	// The granular series is a sibling read, not a revision of the window above:
	// it is registered as its own exact path with its own query vocabulary, so the
	// 100 row history and its export keep their bodies byte for byte.
	mux.HandleFunc("GET /v1/risk/history/series", historySeries(store))
	mux.HandleFunc("HEAD /v1/risk/history/series", func(w http.ResponseWriter, _ *http.Request) {
		// ServeMux otherwise runs the GET handler for HEAD, outside GET auditing.
		w.Header().Set("Allow", http.MethodGet)
		w.WriteHeader(http.StatusMethodNotAllowed)
	})
	// The comparison is additive and takes a zone LIST, which no other risk route
	// does; it is its own exact path so the single-zone reads keep their exact
	// vocabulary and bodies. HEAD is refused explicitly for the same reason the
	// series refuses it: ServeMux would otherwise run the GET handler, unrecorded.
	mux.HandleFunc("GET /v1/risk/compare", compareZones(store))
	mux.HandleFunc("HEAD /v1/risk/compare", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Allow", http.MethodGet)
		w.WriteHeader(http.StatusMethodNotAllowed)
	})
	mux.HandleFunc("GET /v1/risk/batches", latestPerZone(store))
	mux.HandleFunc("GET /v1/risk/executive-summary", executiveSummary(store))
	// The alert timeline is a viewer/admin read like its neighbours: it is inside
	// the Authorize gate and requires no further role check, and it stores nothing.
	mux.HandleFunc("GET /v1/risk/alerts", listAlerts(store))
	mux.HandleFunc("GET /v1/risk/zones", listZones(store))
	mux.HandleFunc("GET /v1/risk/synthetic-scenarios", listSyntheticScenarios())
	mux.HandleFunc("GET /v1/risk/infrastructure", listInfrastructure())
	// Model registry: the list is a read route; activation is admin-only through
	// requireAdmin, defined in security.go.
	mux.HandleFunc("GET /v1/models", listModels(store))
	mux.HandleFunc("POST /v1/models/{version}/activate", requireAdmin(activateModel(store)))
	mux.HandleFunc("POST /v1/risk/cycle/run", requireAdmin(cycleRun(runner)))
	var provider DescriptorProvider
	if len(providers) == 1 {
		provider = providers[0]
	}
	mux.HandleFunc("GET /v1/risk/sources", sourcesWithCycle(provider, runner))
	return Authorize(verifier, mux)
}

// historyWindow is the bounded number of batches the per-zone history serves, in
// the order storage returns them (descending request time). It is defined once
// because the JSON read and the CSV export must answer the same window.
const historyWindow = 100

// zoneParam validates the one zone_id parameter every per-zone read accepts and
// asks the catalogue for membership. On failure it has already written the
// response and the caller only returns: a missing, repeated, empty or unknown
// zone is a malformed request, never an empty answer.
func zoneParam(w http.ResponseWriter, r *http.Request, store Repository) (string, bool) {
	zone := r.URL.Query().Get("zone_id")
	// Exactly one zone_id parameter is required. A missing, repeated or
	// empty parameter is a malformed request, not an unknown zone.
	if zone == "" || len(r.URL.Query()) != 1 || len(r.URL.Query()["zone_id"]) != 1 {
		fail(w, 400, "invalid_zone")
		return "", false
	}
	exists, err := store.ZoneExists(r.Context(), zone)
	if err != nil {
		fail(w, 503, "storage_unavailable")
		return "", false
	}
	if !exists {
		fail(w, 400, "invalid_zone")
		return "", false
	}
	return zone, true
}

// latestBatch serves the newest requested batch of one zone. No batch is the
// documented insufficient-data answer, not an empty array.
func latestBatch(store Repository) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		zone, ok := zoneParam(w, r, store)
		if !ok {
			return
		}
		batches, err := store.List(r.Context(), zone, 1)
		if err != nil {
			fail(w, 503, "storage_unavailable")
			return
		}
		if len(batches) == 0 {
			respond(w, 404, map[string]string{"code": "no_published_batch", "data_status": "insufficient"})
			return
		}
		respond(w, 200, batches[0])
	}
}

// readHistory is the single bounded history read: the JSON route and the CSV
// export both call it, so the accepted zone, the window and the failure
// vocabulary cannot drift between the two representations. It returns the
// validated zone as well, because the export's filename declares it. On failure
// the response is already written.
func readHistory(w http.ResponseWriter, r *http.Request, store Repository) (string, []repository.Batch, bool) {
	zone, ok := zoneParam(w, r, store)
	if !ok {
		return "", nil, false
	}
	batches, err := store.List(r.Context(), zone, historyWindow)
	if err != nil {
		fail(w, 503, "storage_unavailable")
		return "", nil, false
	}
	return zone, batches, true
}

// history serves the bounded window as JSON. Its body is unchanged, including
// the empty answer storage produced: this route is the reference the CSV export
// is compared against, not a place to redefine.
func history(store Repository) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		_, batches, ok := readHistory(w, r, store)
		if !ok {
			return
		}
		respond(w, 200, batches)
	}
}

// NewWithCycleAndClassifier is the additive form of NewWithCycle: it wires the
// classifier source the publisher already uses, so GET /v1/models can project
// the runtime selection instead of guessing it from the registry. The existing
// constructors keep their behaviour; without a source the projection reports
// unavailable. Authentication, roles and every other route are unchanged: the
// source is attached to the request context and only the models read consumes it.
func NewWithCycleAndClassifier(store Repository, verifier Verifier, check StatusCheck, runner CycleRunner, classifiers ClassifierSource, providers ...DescriptorProvider) http.Handler {
	handler := NewWithCycle(store, verifier, check, runner, providers...)
	if classifiers == nil {
		return handler
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler.ServeHTTP(w, r.WithContext(withClassifierSource(r.Context(), classifiers)))
	})
}

// batchCollection is the aggregate read's body. Batches is never nil, so an empty
// publication state serialises as {"batches":[]} rather than JSON null: nothing
// published is an answer, not a failure, and it is never a 404.
type batchCollection struct {
	Batches []repository.Batch `json:"batches"`
}

// latestPerZone serves the newest published batch of every zone that has one, so
// the map can be coloured on load from one request instead of one read per zone.
// It takes no parameter, it never writes, and it is admitted by the same bearer
// gate as the per-zone reads: 401 and 403 are answered before storage is touched.
//
// The query already answers in zone_id order; sorting here keeps the documented
// order a property of this route rather than of whichever storage answered it.
func latestPerZone(store Repository) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		batches, err := store.LatestPerZone(r.Context())
		if err != nil {
			fail(w, 503, "storage_unavailable")
			return
		}
		ordered := make([]repository.Batch, len(batches))
		copy(ordered, batches)
		sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].ZoneID < ordered[j].ZoneID })
		respond(w, 200, batchCollection{Batches: ordered})
	}
}

// zoneFeatureCollection is an RFC 7946 FeatureCollection of catalogue zones.
type zoneFeatureCollection struct {
	Type     string        `json:"type"`
	Features []zoneFeature `json:"features"`
}

// zoneFeature is one RFC 7946 Feature. Geometry is raw JSON so it is embedded
// exactly as ST_AsGeoJSON produced it: re-encoding or string-escaping it would
// turn a geometry object into a string, which RFC 7946 does not allow.
type zoneFeature struct {
	Type       string             `json:"type"`
	Properties zoneFeatureDetails `json:"properties"`
	Geometry   json.RawMessage    `json:"geometry"`
}

type zoneFeatureDetails struct {
	Code     string `json:"code"`
	Name     string `json:"name"`
	Province string `json:"province"`
	Kind     string `json:"kind"`
}

// newZoneCollection maps catalogue rows to a FeatureCollection. The slice is
// built with an explicit capacity and never nil, so an empty catalogue serialises
// as an empty array rather than JSON null: an empty result is a valid, honest
// answer and not an error.
func newZoneCollection(zones []repository.Zone) zoneFeatureCollection {
	features := make([]zoneFeature, 0, len(zones))
	for _, zone := range zones {
		features = append(features, zoneFeature{
			Type: "Feature",
			Properties: zoneFeatureDetails{
				Code:     zone.Code,
				Name:     zone.Name,
				Province: zone.Province,
				Kind:     zone.Kind,
			},
			Geometry: zone.Geometry,
		})
	}
	return zoneFeatureCollection{Type: "FeatureCollection", Features: features}
}

// listZones serves the catalogue. bbox is the only accepted parameter: an
// unknown parameter or a repeated bbox is malformed input, not an unknown
// zone, so both are rejected with the same code as an unparseable bbox.
func listZones(store Repository) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		for key := range query {
			if key != "bbox" {
				fail(w, 400, "invalid_bbox")
				return
			}
		}
		values := query["bbox"]
		if len(values) > 1 {
			fail(w, 400, "invalid_bbox")
			return
		}
		var bbox *repository.BBox
		if len(values) == 1 {
			parsed, err := parseBBox(values[0])
			if err != nil {
				fail(w, 400, "invalid_bbox")
				return
			}
			bbox = parsed
		}
		zones, err := store.ListZones(r.Context(), bbox)
		if err != nil {
			fail(w, 503, "storage_unavailable")
			return
		}
		respond(w, 200, newZoneCollection(zones))
	}
}

// listSyntheticScenarios serves the built-in demonstration catalogue. The list
// comes from the provider package, so the API, the generator and the tests read
// one vocabulary instead of the IDs being duplicated in a UI-facing constant. It
// reads no database and no broker: the profiles are compiled in, and the route
// must stay answerable when storage is down. Authorization is the same
// viewer/admin read gate as every other risk read route.
func listSyntheticScenarios() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		respond(w, 200, source.SyntheticScenarios())
	}
}

// parseBBox parses the optional bbox query value, exactly four comma-separated
// WGS84 numbers minLon,minLat,maxLon,maxLat.
//
// It is pure so the whole validation table is testable without a server. It
// rejects what cannot describe a box: a wrong part count, a non-numeric part, a
// non-finite part (NaN or an infinity), an out-of-range longitude or latitude,
// and a minimum that is not strictly below its maximum. Rejecting rather than
// clamping matters because a clamped box would silently answer a question the
// caller did not ask.
func parseBBox(raw string) (*repository.BBox, error) {
	parts := strings.Split(raw, ",")
	if len(parts) != 4 {
		return nil, errors.New("bbox needs four comma-separated numbers")
	}
	values := make([]float64, len(parts))
	for index, part := range parts {
		value, err := strconv.ParseFloat(part, 64)
		if err != nil {
			return nil, errors.New("bbox part is not a number")
		}
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return nil, errors.New("bbox part is not finite")
		}
		values[index] = value
	}
	minLon, minLat, maxLon, maxLat := values[0], values[1], values[2], values[3]
	if minLon < -180 || minLon > 180 || maxLon < -180 || maxLon > 180 {
		return nil, errors.New("bbox longitude out of range")
	}
	if minLat < -90 || minLat > 90 || maxLat < -90 || maxLat > 90 {
		return nil, errors.New("bbox latitude out of range")
	}
	if minLon >= maxLon || minLat >= maxLat {
		return nil, errors.New("bbox minimum is not below its maximum")
	}
	return &repository.BBox{MinLon: minLon, MinLat: minLat, MaxLon: maxLon, MaxLat: maxLat}, nil
}
