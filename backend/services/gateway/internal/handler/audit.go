package handler

// Query recording (PM-10 / V1-P-07, S1 item 3 and S3).
//
// The gateway is the only server-side boundary every business read crosses, so it
// is where a "consulta" is written down. Two rules shape everything here:
//
//  1. The recorded read is a route of this gateway, not a request. The table
//     below is the whole scope; the URL's query string, the headers and the token
//     are never read into a record.
//  2. A read is recorded only once the upstream confirmed it. ModifyResponse in
//     gateway.go runs after the upstream status is known and before a byte of its
//     body is copied, so a write that fails answers 503 storage_unavailable
//     instead of forwarding a success nobody recorded.

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
)

// QueryRecord is the whole of what a query record may contain: the verified
// subject, the display name the provider asserted for it, one action from the
// closed vocabulary below, and the correlation id this gateway minted. There is
// deliberately no field for a URL, a filter, a header or a token, so none of them
// can be added to a record by accident at a call site.
type QueryRecord struct {
	ActorID   string
	ActorName string
	Action    string
	TraceID   string
}

// QueryRecorder writes one recorded read. The implementation lives outside this
// package because it holds the database credential; everything above it is
// transport logic and is tested without a database.
type QueryRecorder interface {
	RecordQuery(ctx context.Context, record QueryRecord) error
}

// queryRoute is one selected business read. Detail is not carried here on
// purpose: the stored label is fixed inside the narrow SQL writer, which is the
// surface that must not be spoofable, so the sentence a person reads cannot be a
// caller-supplied string.
type queryRoute struct {
	Method string
	Path   string
	Action string
}

// queryRoutes is the closed scope selected for S3: the current and historical
// risk reads, the aggregate batch read the map and the page use, the field
// observations and the preventive actions. The audit log itself is not recorded
// (reading the trail is not business activity), and neither are the technical
// loads the question disclosed as excluded: the zone catalogue and map geometry,
// the synthetic scenario catalogue, the model registry and the user directory.
//
// Collection matching is exact and method-aware. Action detail uses the same
// UUID parser as prevention and belongs to the same category as its collection.
// An action may cover more than one route when the routes are one read: the
// historical risk export selects the same bounded window of the same collection
// as the JSON history and is recorded as the same consultation.
var queryRoutes = []queryRoute{
	{Method: "GET", Path: "/v1/risk/latest", Action: "risk.current.read"},
	{Method: "GET", Path: "/v1/risk/history", Action: "risk.history.read"},
	{Method: "GET", Path: "/v1/risk/history.csv", Action: "risk.history.read"},
	{Method: "GET", Path: "/v1/risk/batches", Action: "risk.batches.read"},
	{Method: "GET", Path: "/v1/prevention/observations", Action: "prevention.observations.read"},
	{Method: "GET", Path: "/v1/prevention/actions", Action: "prevention.actions.read"},
}

const actionDetailPrefix = "/v1/prevention/actions/"

// queryRouteFor resolves the selected read without storing the resource ID.
func queryRouteFor(method, path string) (queryRoute, bool) {
	for _, route := range queryRoutes {
		if route.Method != method {
			continue
		}
		if route.Path == path {
			return route, true
		}
		if route.Method == http.MethodGet && route.Path+"/" == actionDetailPrefix {
			if pathID, ok := strings.CutPrefix(path, actionDetailPrefix); ok {
				if id, err := uuid.Parse(pathID); err == nil && id != uuid.Nil {
					return route, true
				}
			}
		}
	}
	return queryRoute{}, false
}

// queryAuditTimeout bounds the write of one record. The insert is a single call
// to a function that inserts one row, so the budget is about a stuck connection,
// not about work: it must be short enough that a caller waiting on an ordinary
// page load is not held hostage by an unavailable audit database, and long enough
// that a healthy insert never loses the race.
const queryAuditTimeout = 2 * time.Second

// errQueryAuditUnavailable marks the failure of the record write itself, not of
// the read it describes. The proxy's error handler distinguishes the two so a
// storage failure answers 503 storage_unavailable instead of the 502 an
// unreachable service gets: the upstream succeeded, and forwarding that success
// would report a read this gateway never wrote down.
var errQueryAuditUnavailable = errors.New("query audit write failed")

// unrecordedQueries is the recorder the constructors that take no recorder use,
// and the only way this package can record nothing. It is a named type rather
// than a nil check so that "this construction performs no query recording" is a
// decision a reviewer can find at the call site: New and NewWithRootCAs exist for
// callers that only exercise the transport, and cmd/server wires the database
// writer instead.
type unrecordedQueries struct{}

func (unrecordedQueries) RecordQuery(context.Context, QueryRecord) error { return nil }

// pendingQuery is the record a routed request owes, stashed in the request
// context until the upstream answer says whether it is owed at all.
type pendingQuery struct {
	recorder QueryRecorder
	record   QueryRecord
}

// queryAuditKey is the context key of the pending record. An unexported struct
// type is used as the key so no other package can write or overwrite it.
type queryAuditKey struct{}

// withPendingQuery attaches the record a request will owe if its upstream answers
// with a success.
func withPendingQuery(ctx context.Context, recorder QueryRecorder, record QueryRecord) context.Context {
	return context.WithValue(ctx, queryAuditKey{}, pendingQuery{recorder: recorder, record: record})
}

// pendingQueryFrom returns the pending record of a request, if this request is a
// selected read that reached the upstream at all.
func pendingQueryFrom(ctx context.Context) (pendingQuery, bool) {
	pending, ok := ctx.Value(queryAuditKey{}).(pendingQuery)
	return pending, ok && pending.recorder != nil
}

// flush writes the record under its own bounded budget. context.WithoutCancel is
// what makes the write independent of the caller: the upstream already answered,
// so a client that hung up between the answer and this line must not be able to
// cancel the trail that explains the read. The error travels back to the proxy,
// which answers 503 rather than forwarding an unrecorded success.
func (p pendingQuery) flush(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), queryAuditTimeout)
	defer cancel()
	return p.recorder.RecordQuery(ctx, p.record)
}
