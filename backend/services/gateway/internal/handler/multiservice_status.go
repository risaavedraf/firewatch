package handler

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
)

// The multi-service status is the one question a service board asks without
// asking it four times: which declared status surface is ready, and which is
// not. It is answered by this process, from evidence this process obtained, so
// it is never a proxy, never an end-to-end delivery test and never a single
// global readiness verdict.
const (
	// statusAggregateBudget bounds the whole fan-out, including reading each
	// response body. It is short on purpose: a status read must not become the
	// slowest thing a page waits for, and a slow dependency is itself the evidence
	// this read reports.
	statusAggregateBudget = 2 * time.Second
	// statusBodyLimit bounds how much of one upstream body is read. Every
	// contracted status body is a few hundred bytes, so this is generous while
	// staying far from an unbounded read of whatever an upstream decides to send.
	statusBodyLimit = 4096
	// maxStatusServices is the hard bound of the fan-out. The four declared
	// services are the whole list; the cap makes that a property of this handler
	// instead of a property of whichever wiring happens to pass four probes.
	maxStatusServices = 4
)

// The states one entry can hold. It is the documented enum of the aggregate.
const (
	serviceReady = "ready"
	// serviceDegraded and serviceUnknown are the only two states that make the
	// aggregate answer 503: they are the two that describe a service that did not
	// prove itself ready.
	serviceDegraded = "degraded"
	serviceUnknown  = "unknown"
	// serviceUnauthorized reports the caller's permission, not the service: a
	// 403 from an admin-only check says nothing about whether that service is up.
	serviceUnauthorized = "unauthorized"
	// serviceNotConfigured reports an unset configuration, which is a rule-only
	// deployment rather than a failure.
	serviceNotConfigured = "not_configured"
)

// statusCredential is the only caller-supplied material that reaches a status
// target: the caller's own verified bearer token, and the correlation id this
// gateway minted. No other inbound header is forwarded.
type statusCredential struct {
	authorization string
	requestID     string
}

func statusCredentialOf(r *http.Request) statusCredential {
	return statusCredential{authorization: r.Header.Get("Authorization"), requestID: r.Header.Get("X-Request-ID")}
}

// statusProbe is one fixed target of the fan-out. Its evaluate returns exactly
// one documented state.
type statusProbe struct {
	service  string
	evaluate func(context.Context, statusCredential) string
}

type aggregateGateway struct {
	State string `json:"state"`
}

type aggregateService struct {
	Service string `json:"service"`
	State   string `json:"state"`
}

// aggregateStatus is the body of this route. It carries no overall boolean on
// purpose: the answer is the per-service list, so a caller reads which service
// is not ready instead of only that something is not.
type aggregateStatus struct {
	CheckedAt time.Time          `json:"checked_at"`
	Gateway   aggregateGateway   `json:"gateway"`
	Services  []aggregateService `json:"services"`
}

// statusRolesKey carries the verified ID token from the bearer gate to the one
// route that reads its claims.
type statusRolesKey struct{}

// withVerifiedIDToken attaches the token the bearer gate just verified, so the
// aggregate can read its realm roles without verifying it a second time. It is
// inert for every route that forwards a request.
func withVerifiedIDToken(ctx context.Context, token *oidc.IDToken) context.Context {
	return context.WithValue(ctx, statusRolesKey{}, token)
}

// statusRoleAllowed reports whether the verified token holds one of the two roles
// this aggregate is declared for. The roles come from the signed token the bearer
// gate already verified: a caller-supplied X-User-Role header is never consulted,
// and the gateway deletes it before proxying anything.
func statusRoleAllowed(ctx context.Context) bool {
	token, _ := ctx.Value(statusRolesKey{}).(*oidc.IDToken)
	if token == nil {
		return false
	}
	var claims struct {
		Realm struct {
			Roles []string `json:"roles"`
		} `json:"realm_access"`
	}
	if token.Claims(&claims) != nil {
		return false
	}
	for _, role := range claims.Realm.Roles {
		if role == "viewer" || role == "admin" {
			return true
		}
	}
	return false
}

// multiserviceStatusHandler is the route the deployment registers: the declared
// role policy first, the aggregate second. A caller without viewer or admin is
// refused before a single probe runs, so a token that may not read the status
// surfaces cannot use this route to ask them either.
func multiserviceStatusHandler(probes []statusProbe, budget time.Duration) http.HandlerFunc {
	aggregate := multiserviceStatus(probes, budget)
	return func(w http.ResponseWriter, r *http.Request) {
		if !statusRoleAllowed(r.Context()) {
			failure(w, http.StatusForbidden, "forbidden")
			return
		}
		aggregate(w, r)
	}
}

// multiserviceStatus answers the aggregate from the fixed probes it was built
// with. The budget is a parameter so a test can drive the deadline without
// waiting for the deployed one.
func multiserviceStatus(probes []statusProbe, budget time.Duration) http.HandlerFunc {
	if len(probes) > maxStatusServices {
		probes = probes[:maxStatusServices]
	}
	return func(w http.ResponseWriter, r *http.Request) {
		states := evaluateStatusProbes(r.Context(), probes, statusCredentialOf(r), budget)
		body := aggregateStatus{
			CheckedAt: time.Now().UTC(),
			// This handler is the gateway process. Whenever a body exists, the
			// process that answered is reachable, and that stays true when every
			// dependency it asked is not: the two facts are reported separately.
			Gateway:  aggregateGateway{State: serviceReady},
			Services: make([]aggregateService, 0, len(probes)),
		}
		code := http.StatusOK
		for index, probe := range probes {
			// The status comes from the evidence, never from the aggregate's own
			// opinion: a service is 503 only when it (or its absence) says so.
			if states[index] == serviceDegraded || states[index] == serviceUnknown {
				code = http.StatusServiceUnavailable
			}
			body.Services = append(body.Services, aggregateService{Service: probe.service, State: states[index]})
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		_ = json.NewEncoder(w).Encode(body)
	}
}

// evaluateStatusProbes runs every probe at once and waits no longer than the
// budget for the answers. A probe still running when the deadline fires is
// reported unknown: the aggregate states what it observed, not what it hoped.
func evaluateStatusProbes(parent context.Context, probes []statusProbe, credential statusCredential, budget time.Duration) []string {
	ctx, cancel := context.WithTimeout(parent, budget)
	defer cancel()
	type probeResult struct {
		index int
		state string
	}
	// The channel holds one answer per probe, so a probe that finishes after the
	// deadline is never blocked on a channel nobody reads any more: the fan-out
	// leaves no goroutine behind even when it has already answered.
	results := make(chan probeResult, len(probes))
	for index, probe := range probes {
		go func(index int, probe statusProbe) {
			// One broken probe is one unknown entry, not a crashed gateway. The
			// same reason the fan-out is bounded applies to its failures.
			defer func() {
				if recover() != nil {
					results <- probeResult{index: index, state: serviceUnknown}
				}
			}()
			results <- probeResult{index: index, state: probe.evaluate(ctx, credential)}
		}(index, probe)
	}
	states := make([]string, len(probes))
	for index := range states {
		states[index] = serviceUnknown
	}
	for pending := len(probes); pending > 0; pending-- {
		select {
		case result := <-results:
			states[result.index] = knownStatusState(result.state)
		case <-ctx.Done():
			return states
		}
	}
	return states
}

// knownStatusState keeps a reported state inside the documented enum: a probe
// that answers anything else is not evidence of anything.
func knownStatusState(state string) string {
	switch state {
	case serviceReady, serviceDegraded, serviceUnknown, serviceUnauthorized, serviceNotConfigured:
		return state
	}
	return serviceUnknown
}

// httpStatusProbe is one target of the fixed fan-out. Its address is the
// configured base of a service plus the one path this probe was built with, so
// no part of the caller's request - not its path, not its query - chooses where
// the request goes.
func httpStatusProbe(client *http.Client, service string, base *url.URL, path string, parse func(int, []byte) string) statusProbe {
	return statusProbe{service: service, evaluate: func(ctx context.Context, credential statusCredential) string {
		if base == nil || base.Host == "" {
			return serviceUnknown
		}
		target := (&url.URL{Scheme: base.Scheme, Host: base.Host, Path: path}).String()
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
		if err != nil {
			return serviceUnknown
		}
		// The caller's own credential and nothing else: this gateway holds no
		// service credential, and it never invents one.
		if credential.authorization != "" {
			request.Header.Set("Authorization", credential.authorization)
		}
		if credential.requestID != "" {
			request.Header.Set("X-Request-ID", credential.requestID)
		}
		response, err := client.Do(request)
		if err != nil {
			return serviceUnknown
		}
		defer response.Body.Close()
		// One byte past the bound is read on purpose, so an oversized body is
		// recognised instead of being truncated into a prefix that happens to parse.
		// The request context bounds the read as well.
		body, err := io.ReadAll(io.LimitReader(response.Body, statusBodyLimit+1))
		if err != nil || len(body) > statusBodyLimit {
			return serviceUnknown
		}
		return parse(response.StatusCode, body)
	}}
}

// parseOperationalStatus reads the operational body risk, jobs and prevention
// publish. A refusal is the caller's permission, not a dependency state. The code
// and the body must agree - 200 means ready, 503 means not ready - and any other
// pair is unknown, so the aggregate never invents a state the service did not
// report.
func parseOperationalStatus(code int, body []byte) string {
	if code == http.StatusUnauthorized || code == http.StatusForbidden {
		return serviceUnauthorized
	}
	var parsed struct {
		Ready *bool `json:"ready"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil || parsed.Ready == nil {
		return serviceUnknown
	}
	switch code {
	case http.StatusOK:
		if *parsed.Ready {
			return serviceReady
		}
	case http.StatusServiceUnavailable:
		if !*parsed.Ready {
			return serviceDegraded
		}
	}
	return serviceUnknown
}

// parseInferenceEvidence reads the evidence risk publishes about the inference
// service it is configured to call. The only compatible pairs are 200 with ready
// or not_configured, and 503 with degraded or unknown. A 503 that claims an unset
// configuration contradicts itself, and reading it as not_configured would turn a
// failure into a success, so an incompatible pair is unknown.
func parseInferenceEvidence(code int, body []byte) string {
	if code == http.StatusUnauthorized || code == http.StatusForbidden {
		return serviceUnauthorized
	}
	var parsed struct {
		State string `json:"state"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return serviceUnknown
	}
	switch code {
	case http.StatusOK:
		if parsed.State == serviceReady || parsed.State == serviceNotConfigured {
			return parsed.State
		}
	case http.StatusServiceUnavailable:
		if parsed.State == serviceDegraded || parsed.State == serviceUnknown {
			return parsed.State
		}
	}
	return serviceUnknown
}

// multiserviceStatusProbes is the fixed fan-out of this deployment, in the order
// the answer documents. It is built from configuration, so the list of targets
// cannot depend on a request, and a caller cannot widen it.
func multiserviceStatusProbes(jobs, risk, prevention *url.URL, rootCAs *x509.CertPool) []statusProbe {
	client := &http.Client{
		Timeout: statusAggregateBudget,
		// A status probe reads one service's own document. Following a redirect
		// would let that service choose another host to receive this request, which
		// is a target no configuration named.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Transport:     newUpstreamTransport(rootCAs),
	}
	return []statusProbe{
		httpStatusProbe(client, "risk", risk, "/v1/risk/status", parseOperationalStatus),
		httpStatusProbe(client, "jobs", jobs, "/v1/jobs/status", parseOperationalStatus),
		httpStatusProbe(client, "prevention", prevention, "/v1/prevention/status", parseOperationalStatus),
		// S4: inference is reached through risk, the only service that already
		// holds the configured internal address and the internal CA it trusts. This
		// gateway never talks to inference and never holds a credential for it.
		httpStatusProbe(client, "inference", risk, "/v1/risk/inference/status", parseInferenceEvidence),
	}
}
