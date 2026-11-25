package handler

import (
	"context"
	"errors"
	"net/http"

	"firewatch.local/risk/internal/classify"
	"firewatch.local/risk/internal/repository"
)

// ClassifierSource resolves the classifier the next publication would run. It is
// satisfied by service.RegistryClassifierSource, the same source the publisher
// uses, so the models route observes runtime selection instead of reinterpreting
// registry rows, configuration or a second rule engine of its own.
type ClassifierSource interface {
	ActiveClassifier(ctx context.Context) (classify.Classifier, error)
}

// classifierSourceContextKey is unexported so only this package can attach a
// resolver, and the struct type cannot collide with another package's key.
type classifierSourceContextKey struct{}

// withClassifierSource attaches the runtime resolver the models read projects.
func withClassifierSource(ctx context.Context, source ClassifierSource) context.Context {
	return context.WithValue(ctx, classifierSourceContextKey{}, source)
}

// classifierSourceFromContext returns the attached resolver, or nil when the
// handler was composed without one.
func classifierSourceFromContext(ctx context.Context) ClassifierSource {
	source, _ := ctx.Value(classifierSourceContextKey{}).(ClassifierSource)
	return source
}

// The three documented projection states. They are mutually exclusive and the
// identity fields belong to the rule state alone: a non-rule or an unresolved
// selection must never borrow a version or a fingerprint.
const (
	effectiveStatusRule        = "rule"
	effectiveStatusNonRule     = "non_rule"
	effectiveStatusUnavailable = "unavailable"
)

// effectiveClassifier is the additive `effective` projection of the classifier
// the next publication would resolve at read time. It is not a claim about the
// last publication, about inference availability or about an artifact being
// published: it reports only which selection the service would make now.
type effectiveClassifier struct {
	Status     string `json:"status"`
	Version    string `json:"version,omitempty"`
	ParamsHash string `json:"params_hash,omitempty"`
}

// modelListResponse is the GET /v1/models body. The list is wrapped rather than
// returned bare so a future field (the active version, for instance) is additive.
type modelListResponse struct {
	Models    []repository.ModelVersion `json:"models"`
	Effective effectiveClassifier       `json:"effective"`
}

// listModels serves the registry. It never invents rows: an empty registry is an
// empty list, and a storage failure is a 503, so "nothing registered" and "cannot
// read" stay distinguishable.
func listModels(store Repository) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		models, err := store.ListModels(r.Context())
		if err != nil {
			fail(w, http.StatusServiceUnavailable, "storage_unavailable")
			return
		}
		if models == nil {
			models = []repository.ModelVersion{}
		}
		respond(w, http.StatusOK, modelListResponse{
			Models:    models,
			Effective: projectEffectiveClassifier(r.Context(), classifierSourceFromContext(r.Context())),
		})
	}
}

// projectEffectiveClassifier reports the classifier the next publication would
// resolve, using the publisher's own resolver. Any failure to establish a
// verified identity degrades the projection to unavailable: it never fails the
// registry list, and it never claims a version or a hash it cannot prove.
func projectEffectiveClassifier(ctx context.Context, source ClassifierSource) effectiveClassifier {
	unavailable := effectiveClassifier{Status: effectiveStatusUnavailable}
	if source == nil {
		return unavailable
	}
	classifier, err := source.ActiveClassifier(ctx)
	if err != nil || classifier == nil {
		return unavailable
	}
	switch classifier.Kind() {
	case classify.KindTrained:
		// A resolved trained classifier is a non-rule: report that it is not a
		// rule without borrowing an identity the projection cannot verify.
		return effectiveClassifier{Status: effectiveStatusNonRule}
	case classify.KindRule:
		// A rule is claimed only with its verified policy fingerprint below.
	default:
		// An unknown kind is not evidence of either state, so it fails closed.
		return unavailable
	}
	version := classifier.ID()
	if version == "" {
		return unavailable
	}
	reporter, ok := classifier.(classify.PolicyFingerprinter)
	if !ok {
		return unavailable
	}
	fingerprint, err := reporter.PolicyFingerprint()
	if err != nil || !canonicalSHA256(fingerprint) {
		return unavailable
	}
	// The frozen identifiers carry a promise about their numbers. The resolver
	// already enforces it for the version it selects, and this read refuses to
	// publish a different hash anyway, so the projection cannot contradict code
	// the binary claims to run.
	if expected, frozen := classify.ExpectedPolicyHash(version); frozen && expected != fingerprint {
		return unavailable
	}
	return effectiveClassifier{Status: effectiveStatusRule, Version: version, ParamsHash: fingerprint}
}

// canonicalSHA256 reports whether value is exactly one canonical SHA-256 hex
// digest: 64 lowercase hexadecimal characters. An uppercase, truncated or
// otherwise shaped value is not a fingerprint this route may publish.
func canonicalSHA256(value string) bool {
	if len(value) != 64 {
		return false
	}
	for i := 0; i < len(value); i++ {
		c := value[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// activateModel makes one version active. It is wrapped in requireAdmin by the
// router, so reaching it already means the caller holds the admin role. The
// failure codes are distinct on purpose: a missing version is 404, a version the
// schema forbids from being active is 409, and a storage failure is 503.
func activateModel(store Repository) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		version := r.PathValue("version")
		if version == "" {
			fail(w, http.StatusBadRequest, "invalid_version")
			return
		}
		model, err := store.ActivateModel(r.Context(), version)
		switch {
		case errors.Is(err, repository.ErrModelNotFound):
			fail(w, http.StatusNotFound, "model_not_found")
		case errors.Is(err, repository.ErrModelNotActivatable):
			fail(w, http.StatusConflict, "model_not_activatable")
		case err != nil:
			fail(w, http.StatusServiceUnavailable, "storage_unavailable")
		default:
			respond(w, http.StatusOK, model)
		}
	}
}
