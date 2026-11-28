// Package cycle drives one automatic ingestion cycle: for every configured zone
// it asks the publication path to fetch, validate, classify and persist one
// assessment, and it records the freshness and state of the source so the API can
// report them.
//
// It owns scheduling and status, not data acquisition or classification. The
// publication seam keeps those contracts behind one interface, so replacing the
// fixture with a real source changes neither the cycle nor the API.
package cycle

import (
	"context"
	"log/slog"
	"strings"
	"sync"
	"time"

	v1 "firewatch.local/contracts/events/v1"
	observations "firewatch.local/contracts/observations/v1"
	"github.com/google/uuid"
)

// DefaultInterval is the automatic cycle period required by the bases: every 15
// minutes the system ingests, validates, classifies and publishes.
const DefaultInterval = 15 * time.Minute

// Publisher is the publication seam. Its methods run the whole ingest-to-persist
// path for one zone, and each one names the origin it publishes: PublishScheduled
// is the INTERNAL automatic publication (the batch is persisted but no job
// completion is emitted, because an automatic cycle is not a job and Jobs never
// stored the id the cycle mints), and PublishManual is a run a verified operator
// asked for, which records that operator as the evaluation's actor.
//
// The seams are methods of their own instead of a flag on the explicit job
// publication, so the cycle cannot accidentally settle a job, every manual run
// carries an identity the API gate already proved, and the decision is never
// derived from the actor string: a request whose ActorID happens to read
// "cycle-scheduler" still settles its job when it arrives as a real delivery, and
// a scheduled publication never does.
type Publisher interface {
	PublishScheduled(ctx context.Context, request v1.Event) error
	PublishManual(ctx context.Context, request v1.Event, actor string) error
}

// DescriptorProvider is the read-only description of the active source, used to
// label the status and derive the demo flag of a cycle request.
type DescriptorProvider interface {
	Describe() observations.SourceDescriptor
}

// Options configures a Runner. Every field is optional and has a documented
// default, so production starts without configuration and a test pins the clock
// and the identifier generator.
type Options struct {
	// Zones are the zones one cycle publishes. Only zones present in the seeded
	// catalogue are acceptable to the store's foreign key.
	Zones []string
	// Interval is the period between automatic runs. It defaults to
	// DefaultInterval (15 minutes).
	Interval time.Duration
	// Now is the clock. It defaults to time.Now and must never be read by a test
	// that wants a reproducible run without one.
	Now func() time.Time
	// NewID mints the event, trace and job identifiers of one cycle request. It
	// defaults to UUID generation.
	NewID func() string
}

// ZoneResult is the outcome of one zone inside a cycle.
type ZoneResult struct {
	ZoneID    string `json:"zone_id"`
	Published bool   `json:"published"`
	Error     string `json:"error,omitempty"`
}

// RunResult is the outcome of one full cycle.
type RunResult struct {
	SourceID   string       `json:"source_id"`
	StartedAt  time.Time    `json:"started_at"`
	FinishedAt time.Time    `json:"finished_at"`
	Complete   bool         `json:"complete"`
	Zones      []ZoneResult `json:"zones"`
}

// SourceStatus is the freshness and state of one source, as served by the API.
//
// LastRunAt is the last attempt (a failed attempt is still an execution), and
// Complete is whether that attempt published every zone. AgeSeconds is the age
// of the last attempt, so the UI can compare it against the 15 minute target.
//
// NextRunAt is the renewal deadline —the last attempt plus the configured
// interval— and NOT the scheduler's next tick: a manual run recomputes it while
// the automatic ticker keeps its own phase, so the two can legitimately differ.
// The API says the same thing, and the cycle panel labels it accordingly.
type SourceStatus struct {
	SourceID   string     `json:"source_id"`
	LastRunAt  *time.Time `json:"last_run_at"`
	NextRunAt  *time.Time `json:"next_run_at"`
	Complete   bool       `json:"complete"`
	AgeSeconds *float64   `json:"age_seconds"`
	LastError  string     `json:"last_error,omitempty"`
}

// Runner runs cycles on demand and on the 15 minute schedule, and keeps the
// state Statuses reports.
type Runner struct {
	source    DescriptorProvider
	publisher Publisher
	zones     []string
	interval  time.Duration
	now       func() time.Time
	newID     func() string

	mu        sync.Mutex
	lastRunAt *time.Time
	nextRunAt *time.Time
	complete  bool
	lastError string
}

// New returns a runner. A nil source or publisher is accepted so a misconfigured
// process fails on the first run with an attributable error instead of at
// startup; RunOnce refuses to act in that case.
func New(source DescriptorProvider, publisher Publisher, options Options) *Runner {
	runner := &Runner{
		source:    source,
		publisher: publisher,
		zones:     append([]string(nil), options.Zones...),
		interval:  options.Interval,
		now:       options.Now,
		newID:     options.NewID,
	}
	if runner.interval <= 0 {
		runner.interval = DefaultInterval
	}
	if runner.now == nil {
		runner.now = time.Now
	}
	if runner.newID == nil {
		runner.newID = uuid.NewString
	}
	return runner
}

// id returns the source identifier, or a stable placeholder when no source is
// configured so status stays attributable.
func (r *Runner) id() string {
	if r.source == nil {
		return "unconfigured"
	}
	if descriptor := r.source.Describe(); descriptor.ID != "" {
		return descriptor.ID
	}
	return "unconfigured"
}

// RunOnce executes one full cycle synchronously because the 15 minute schedule
// fired: every configured zone is published through the scheduled seam, a zone
// failure is recorded without aborting the rest, and the resulting state is kept
// for Statuses. Every zone's batch is persisted, no zone reports a job completion,
// and no zone records an actor, because nobody asked for this run. Running it is
// idempotent with respect to its inputs: the clock and identifier generator decide
// every timestamp and id.
func (r *Runner) RunOnce(ctx context.Context) RunResult {
	return r.run(ctx, evaluationOrigin{})
}

// RunManual executes one full cycle synchronously because a verified operator asked
// for it through POST /v1/risk/cycle/run. It publishes exactly as the automatic
// tick does - same validation, classification and policy checks, and still no job
// completion, because a manual run is not a job either - with one difference: every
// persisted batch records the manual origin and the verified token subject as its
// actor.
//
// actor is the subject Authorize put on the request context after verifying the
// token, never a field of the request. A run without one is refused before any zone
// is published or any row is written: a blank actor is not an identity, and the
// schema refuses the pair anyway.
func (r *Runner) RunManual(ctx context.Context, actor string) RunResult {
	return r.run(ctx, evaluationOrigin{manual: true, actor: actor})
}

// evaluationOrigin is who asked for one cycle run, in the vocabulary the
// persistence seam records. It is unexported and built only by the two entry points
// above, so a caller cannot configure an origin the runner does not own.
type evaluationOrigin struct {
	// manual reports that the run came from the manual trigger. The automatic tick
	// leaves it false.
	manual bool
	// actor is the verified token subject of a manual run and stays empty for the
	// scheduler.
	actor string
}

// run is the single loop both entry points share, so the automatic tick and the
// manual trigger cannot diverge in what they validate, classify or persist. Only
// the origin - and therefore the persistence seam and the recorded actor - differs.
func (r *Runner) run(ctx context.Context, origin evaluationOrigin) RunResult {
	result := RunResult{
		SourceID:  r.id(),
		StartedAt: r.now().UTC(),
		Complete:  true,
		Zones:     make([]ZoneResult, 0, len(r.zones)),
	}
	if r.publisher == nil {
		result.Complete = false
		result.Zones = append(result.Zones, ZoneResult{ZoneID: "", Error: "cycle publisher is not configured"})
		result.FinishedAt = r.now().UTC()
		r.record(result)
		return result
	}
	if origin.manual && strings.TrimSpace(origin.actor) == "" {
		// Fail closed before any acquisition: a manual evaluation whose operator was
		// not proved cannot be recorded honestly, and the schema refuses a manual row
		// without a non-blank actor anyway.
		result.Complete = false
		result.Zones = append(result.Zones, ZoneResult{ZoneID: "", Error: "a manual cycle run requires the verified token subject of the operator"})
		result.FinishedAt = r.now().UTC()
		r.record(result)
		return result
	}
	synthetic := false
	if r.source != nil {
		synthetic = r.source.Describe().Synthetic
	}
	for _, zone := range r.zones {
		request := v1.Event{
			ID:          r.newID(),
			Type:        v1.JobRequestedType,
			OccurredAt:  result.StartedAt,
			TraceID:     r.newID(),
			JobID:       r.newID(),
			ActorID:     "cycle-scheduler",
			ZoneID:      zone,
			RequestedAt: result.StartedAt,
			Demo:        synthetic,
		}
		// The seam decides the origin: neither seam reports a job completion for a
		// cycle, and only the manual one records an actor. ActorID is descriptive
		// metadata for logs, never the provenance of the evaluation.
		var err error
		if origin.manual {
			err = r.publisher.PublishManual(ctx, request, origin.actor)
		} else {
			err = r.publisher.PublishScheduled(ctx, request)
		}
		if err != nil {
			result.Complete = false
			result.Zones = append(result.Zones, ZoneResult{ZoneID: zone, Published: false, Error: err.Error()})
			continue
		}
		result.Zones = append(result.Zones, ZoneResult{ZoneID: zone, Published: true})
	}
	result.FinishedAt = r.now().UTC()
	r.record(result)
	return result
}

// record stores the outcome of one run for Statuses.
func (r *Runner) record(result RunResult) {
	r.mu.Lock()
	defer r.mu.Unlock()
	finished := result.FinishedAt
	next := finished.Add(r.interval)
	r.lastRunAt = &finished
	r.nextRunAt = &next
	r.complete = result.Complete
	r.lastError = ""
	if !result.Complete {
		reasons := make([]string, 0, len(result.Zones))
		for _, zone := range result.Zones {
			if zone.Error != "" {
				reasons = append(reasons, zone.ZoneID+": "+zone.Error)
			}
		}
		r.lastError = strings.Join(reasons, "; ")
	}
}

// Statuses returns the freshness of the configured source. It is a one-element
// slice because one runner observes one source; the API keeps the plural shape so
// a multi-source deployment is additive.
func (r *Runner) Statuses() []SourceStatus {
	now := r.now().UTC()
	r.mu.Lock()
	defer r.mu.Unlock()
	status := SourceStatus{SourceID: r.id(), Complete: r.complete, LastError: r.lastError}
	if r.lastRunAt != nil {
		last := *r.lastRunAt
		status.LastRunAt = &last
		age := now.Sub(last).Seconds()
		if age < 0 {
			age = 0
		}
		status.AgeSeconds = &age
	}
	if r.nextRunAt != nil {
		next := *r.nextRunAt
		status.NextRunAt = &next
	}
	return []SourceStatus{status}
}

// Start runs the cycle immediately and then on the configured interval until the
// context is cancelled. A failed run is logged and does not stop the schedule:
// the next tick retries, which is why the refusal never dead-letters.
func (r *Runner) Start(ctx context.Context) {
	run := func() {
		result := r.RunOnce(ctx)
		if !result.Complete {
			slog.Warn("cycle_incomplete", "source_id", result.SourceID, "zones", result.Zones, "error", r.Statuses()[0].LastError)
			return
		}
		slog.Info("cycle_complete", "source_id", result.SourceID, "zones", len(result.Zones), "finished_at", result.FinishedAt)
	}
	run()
	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			run()
		}
	}
}
