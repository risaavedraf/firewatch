package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"firewatch.local/risk/internal/handler"
)

// S4 (PM-16): the only honest evidence this deployment can offer about the
// inference service is the one risk can gather itself, because risk already
// holds the configured internal address and the internal CA that service is
// reached with. Nothing about the probe comes from a request: no caller
// credential, no caller header, no target but the configured one.
const (
	// inferenceHealthPath is the one path the probe reads. The inference service
	// documents GET /health as its readiness surface, and the address's own path
	// is never used, so a configured address cannot steer the probe elsewhere.
	inferenceHealthPath = "/health"
	// inferenceStatusTimeout bounds one probe, including reading the health body,
	// so a stalled service cannot hold the caller's read open.
	inferenceStatusTimeout = 2 * time.Second
	// inferenceHealthBodyLimit bounds how much of the health document is read. The
	// contracted document is a small object; one byte more than this is not that
	// document, which is why the read asks for one extra byte and checks the length
	// instead of quietly truncating.
	inferenceHealthBodyLimit = 4096
)

// inferenceHealth is the document inference GET /health answers, as
// contracts/openapi/inference-v1.yaml declares it (schema Health). Every field is
// required there, so a body missing one is not an answer this probe may believe;
// pointer fields distinguish "absent" from a zero value.
type inferenceHealth struct {
	Status       string `json:"status"`
	Format       string `json:"format"`
	ModelVersion string `json:"model_version"`
	DataHash     string `json:"data_hash"`
	Kind         string `json:"kind"`
	TrainedAt    string `json:"trained_at"`
	FeatureCount *int   `json:"feature_count"`
	Thresholds   *struct {
		Medium *float64 `json:"medium"`
		High   *float64 `json:"high"`
	} `json:"thresholds"`
}

// ready reports whether this document is the contracted healthy answer. It reads
// the published schema rather than one convenient field: "status":"ready" alone is
// not the health document, and accepting it would report readiness on evidence the
// inference service never promised.
func (h inferenceHealth) ready() bool {
	if h.Status != "ready" || h.Format != "firewatch-model/v1" {
		return false
	}
	if h.ModelVersion == "" || h.DataHash == "" {
		return false
	}
	if h.Kind != "logistic" && h.Kind != "forest" {
		return false
	}
	// trained_at is format: date-time in the contract, so a value that does not
	// parse is not the document either.
	if _, err := time.Parse(time.RFC3339, h.TrainedAt); err != nil {
		return false
	}
	if h.FeatureCount == nil || *h.FeatureCount < 0 {
		return false
	}
	if h.Thresholds == nil || h.Thresholds.Medium == nil || h.Thresholds.High == nil {
		return false
	}
	for _, cut := range []float64{*h.Thresholds.Medium, *h.Thresholds.High} {
		if cut < 0 || cut > 1 {
			return false
		}
	}
	return true
}

// newInferenceStatusCheck builds the evaluator the authenticated evidence route
// reports, from the same INFERENCE_URL the model path uses.
//
// An unset address is not a failure: it describes a deployment that runs rule
// classifiers only, so the evidence says not_configured and the route answers
// 200. A configured address that cannot be parsed is degraded evidence, never a
// hidden guess: this function never dials anything it could not describe, and a
// refused address is never contacted at all.
//
// environment is the same APP_ENV the rest of this process reads. Outside the
// literal development value a plaintext address is refused before the client is
// built, which is the policy this service already applies to its broker address:
// cleartext on the service network is still cleartext, and a configured internal
// CA proves nothing about an unencrypted connection.
//
// rootCAs is the internal CA this process already trusts for the model path. A
// nil pool keeps the system roots, exactly like every other outbound client of
// this process.
func newInferenceStatusCheck(rawURL string, rootCAs *x509.CertPool, timeout time.Duration, environment string) handler.InferenceStatusCheck {
	if strings.TrimSpace(rawURL) == "" {
		return func(context.Context) handler.InferenceStatus {
			return handler.InferenceStatus{CheckedAt: time.Now().UTC(), State: handler.InferenceNotConfigured, Reason: "not_configured"}
		}
	}
	degraded := func(context.Context) handler.InferenceStatus {
		return handler.InferenceStatus{CheckedAt: time.Now().UTC(), State: handler.InferenceDegraded, Reason: "inference_unavailable"}
	}
	base, err := url.Parse(rawURL)
	if err != nil || base.Host == "" || (base.Scheme != "http" && base.Scheme != "https") {
		return degraded
	}
	// The TLS policy of this process, applied before anything is dialled: outside
	// development a plaintext inference address is refused, with or without a
	// configured CA.
	if base.Scheme == "http" && environment != "development" {
		return degraded
	}
	// The target is the configured scheme and host plus the one fixed path: the
	// address's own path and query are discarded on purpose.
	target := (&url.URL{Scheme: base.Scheme, Host: base.Host, Path: inferenceHealthPath}).String()
	client := &http.Client{
		Timeout: timeout,
		// The configured service answers its own health document. Following a
		// redirect would let it choose another host to receive this service's
		// request, which is a target no configuration named.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	if rootCAs != nil {
		client.Transport = &http.Transport{TLSClientConfig: &tls.Config{RootCAs: rootCAs}}
	}
	return func(parent context.Context) handler.InferenceStatus {
		ctx, cancel := context.WithTimeout(parent, timeout)
		defer cancel()
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
		if err != nil {
			return degraded(ctx)
		}
		// No Authorization and no caller header: this is risk's own question to a
		// service it already has access to.
		response, err := client.Do(request)
		if err != nil {
			return degraded(ctx)
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			return degraded(ctx)
		}
		// One byte past the bound is read on purpose, so an oversized body is
		// recognised instead of being truncated into a prefix that happens to parse.
		body, err := io.ReadAll(io.LimitReader(response.Body, inferenceHealthBodyLimit+1))
		if err != nil || len(body) > inferenceHealthBodyLimit {
			return degraded(ctx)
		}
		var health inferenceHealth
		decoder := json.NewDecoder(bytes.NewReader(body))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&health) != nil || decoder.Decode(new(json.RawMessage)) != io.EOF || !health.ready() {
			return degraded(ctx)
		}
		return handler.InferenceStatus{CheckedAt: time.Now().UTC(), State: handler.InferenceReady}
	}
}
