package handler

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"firewatch.local/risk/internal/classify"
	"firewatch.local/risk/internal/repository"
	"firewatch.local/risk/internal/service"
	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/go-jose/go-jose/v4"
)

// T6: GET /v1/models is a read route (viewer or admin) that lists the registry
// rows with their lifecycle state, so the UI can show the active version.
func TestModelsListRequiresReadRoleAndReturnsTheRegistry(t *testing.T) {
	approved := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	hash := "59259c4c0c470e5a0d512fe09f6c748c38fd29f9bc5d760d49754555c66e699b"
	store := &fakeStore{models: []repository.ModelVersion{
		{Version: "academic-rule-v1", Kind: "rule", ParamsHash: &hash, Active: true, Metrics: json.RawMessage(`{}`)},
		{Version: "firewatch-rule-v2", Kind: "rule", ParamsHash: &hash, Active: false, ApprovedAt: &approved, Metrics: json.RawMessage(`{}`)},
	}}
	for _, tc := range []struct {
		name, role string
		want       int
	}{
		{"viewer", "viewer", 200},
		{"admin", "admin", 200},
		{"other", "operator", 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			handler, token := authorizedServer(t, tc.role, store)
			w := getZones(t, handler, token, "/v1/models")
			if w.Code != tc.want {
				t.Fatalf("got %d want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if tc.want != 200 {
				return
			}
			var body struct {
				Models []repository.ModelVersion `json:"models"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if len(body.Models) != 2 || body.Models[0].Version != "academic-rule-v1" || !body.Models[0].Active {
				t.Fatalf("list body = %+v", body.Models)
			}
		})
	}
}

// T6: activation is admin-only. A viewer must be refused without touching the
// registry, and the body must be the shared error shape.
func TestModelActivationRequiresAdmin(t *testing.T) {
	store := &fakeStore{}
	handler, token := authorizedServer(t, "viewer", store)
	r := httptest.NewRequest(http.MethodPost, "/v1/models/firewatch-rule-v2/activate", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("got %d want 403: %s", w.Code, w.Body.String())
	}
	if len(store.activated) != 0 {
		t.Fatalf("a denied activation reached the registry: %v", store.activated)
	}
	var body map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if body["code"] != "forbidden" {
		t.Fatalf("error body = %v", body)
	}
}

// T6: an admin activates a version transactionally. The returned row reports the
// new state, and the version named in the path is the one the repository is
// asked to activate.
func TestModelActivationSucceedsForAdminAndReactivationIsAllowed(t *testing.T) {
	store := &fakeStore{}
	handler, token := authorizedServer(t, "admin", store)
	for _, version := range []string{"firewatch-rule-v2", "academic-rule-v1"} {
		r := httptest.NewRequest(http.MethodPost, "/v1/models/"+version+"/activate", nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("activate %s: got %d: %s", version, w.Code, w.Body.String())
		}
		var model repository.ModelVersion
		if err := json.Unmarshal(w.Body.Bytes(), &model); err != nil {
			t.Fatal(err)
		}
		if model.Version != version || !model.Active {
			t.Fatalf("activation response = %+v, want %s active", model, version)
		}
		if model.ApprovedAt == nil {
			t.Fatal("activation did not set approved_at")
		}
	}
	// Reversion is activating the previous version, which the second call above
	// already exercised. The repository recorded both in order.
	if strings.Join(store.activated, ",") != "firewatch-rule-v2,academic-rule-v1" {
		t.Fatalf("activated = %v, want both versions in order", store.activated)
	}
}

// T6: an unknown version is a 404 and a placeholder that the schema forbids from
// being active is a 409. A storage failure stays a 503.
func TestModelActivationFailsClosed(t *testing.T) {
	for _, tc := range []struct {
		name    string
		store   *fakeStore
		version string
		want    int
		code    string
	}{
		{"unknown version", &fakeStore{activateErr: repository.ErrModelNotFound}, "no-existe", 404, "model_not_found"},
		{"placeholder", &fakeStore{activateErr: repository.ErrModelNotActivatable}, "demo-fixture-v1", 409, "model_not_activatable"},
		{"storage failure", &fakeStore{activateErr: errors.New("db down")}, "firewatch-rule-v2", 503, "storage_unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			handler, token := authorizedServer(t, "admin", tc.store)
			r := httptest.NewRequest(http.MethodPost, "/v1/models/"+tc.version+"/activate", nil)
			r.Header.Set("Authorization", "Bearer "+token)
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Fatalf("got %d want %d: %s", w.Code, tc.want, w.Body.String())
			}
			var body map[string]string
			_ = json.Unmarshal(w.Body.Bytes(), &body)
			if body["code"] != tc.code {
				t.Fatalf("code = %q, want %q", body["code"], tc.code)
			}
		})
	}
}

// T6: a list failure is a 503, not an empty success: an empty registry and an
// unreachable registry mean different things.
func TestModelsListSurfacesAStorageFailure(t *testing.T) {
	store := &fakeStore{modelsErr: errors.New("db down")}
	handler, token := authorizedServer(t, "viewer", store)
	w := getZones(t, handler, token, "/v1/models")
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("got %d want 503: %s", w.Code, w.Body.String())
	}
}

// PM-16 / S1 (T3): the models read carries an additive effective projection of
// the classifier the next publication would resolve. A deployment composed
// without a resolver has no evidence at all, so the projection says so instead
// of inferring an identity from the registry's active flag.
func TestModelsEffectiveIsUnavailableWithoutAResolver(t *testing.T) {
	hash := "59259c4c0c470e5a0d512fe09f6c748c38fd29f9bc5d760d49754555c66e699b"
	store := &fakeStore{models: []repository.ModelVersion{
		{Version: "firewatch-rule-v2", Kind: "rule", ParamsHash: &hash, Active: true, Metrics: json.RawMessage(`{}`)},
	}}
	handler, token := authorizedServer(t, "viewer", store)
	w := getZones(t, handler, token, "/v1/models")
	if w.Code != http.StatusOK {
		t.Fatalf("got %d want 200: %s", w.Code, w.Body.String())
	}
	var body struct {
		Models    []repository.ModelVersion `json:"models"`
		Effective map[string]string         `json:"effective"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not JSON: %v: %s", err, w.Body.String())
	}
	// The list envelope is preserved: an unavailable projection does not replace
	// or hide the registry rows.
	if len(body.Models) != 1 || body.Models[0].Version != "firewatch-rule-v2" || !body.Models[0].Active {
		t.Fatalf("models = %+v, want the unchanged registry list", body.Models)
	}
	if len(body.Effective) != 1 || body.Effective["status"] != "unavailable" {
		t.Fatalf("effective = %v, want exactly {status: unavailable}", body.Effective)
	}
}

// fixedActiveModel is the production resolver's registry read fixed to one row,
// to a read failure, or to "no active row" when the row is empty.
type fixedActiveModel struct {
	model repository.ModelVersion
	err   error
}

func (f fixedActiveModel) ActiveModel(context.Context) (repository.ModelVersion, error) {
	if f.err != nil {
		return repository.ModelVersion{}, f.err
	}
	if f.model.Version == "" {
		return repository.ModelVersion{}, repository.ErrNoActiveModel
	}
	return f.model, nil
}

// seededModel is the registry row a migration seeds: active, but with no record
// of an operator's activation decision.
func seededModel(version, hash string) repository.ModelVersion {
	return repository.ModelVersion{Version: version, Kind: "rule", ParamsHash: &hash, Active: true, Metrics: json.RawMessage(`{"official":false}`)}
}

// activatedModel is the registry row ActivateModel writes: active and carrying
// the activation record that makes it authoritative for inference.
func activatedModel(version, hash string) repository.ModelVersion {
	return repository.ModelVersion{Version: version, Kind: "rule", ParamsHash: &hash, Active: true, Metrics: json.RawMessage(`{"activation":{"at":"2026-10-18T12:00:00Z"}}`)}
}

// stubTrainedClassifier is a resolved non-rule: it has an identity, but the
// projection must not present it as a rule version or fingerprint.
type stubTrainedClassifier struct {
	id   string
	hash string
}

func (s stubTrainedClassifier) ID() string                         { return s.id }
func (s stubTrainedClassifier) Kind() classify.Kind                { return classify.KindTrained }
func (s stubTrainedClassifier) PolicyFingerprint() (string, error) { return s.hash, nil }
func (s stubTrainedClassifier) Classify(context.Context, classify.Features) (classify.Assessment, error) {
	return classify.Assessment{}, nil
}

// stubRuleClassifier is a rule that is not one of the frozen identifiers, so it
// can report any fingerprint the test needs, valid or not.
type stubRuleClassifier struct {
	id             string
	hash           string
	fingerprintErr error
}

func (s stubRuleClassifier) ID() string          { return s.id }
func (s stubRuleClassifier) Kind() classify.Kind { return classify.KindRule }
func (s stubRuleClassifier) PolicyFingerprint() (string, error) {
	if s.fingerprintErr != nil {
		return "", s.fingerprintErr
	}
	return s.hash, nil
}
func (s stubRuleClassifier) Classify(context.Context, classify.Features) (classify.Assessment, error) {
	return classify.Assessment{}, nil
}

// opaqueRuleClassifier claims rule kind without a policy fingerprint, so the
// projection has no verified hash it may publish.
type opaqueRuleClassifier struct{ id string }

func (s opaqueRuleClassifier) ID() string          { return s.id }
func (s opaqueRuleClassifier) Kind() classify.Kind { return classify.KindRule }
func (s opaqueRuleClassifier) Classify(context.Context, classify.Features) (classify.Assessment, error) {
	return classify.Assessment{}, nil
}

// countingClassifierSource proves the read gate runs before any resolution.
type countingClassifierSource struct {
	calls  int
	source ClassifierSource
}

func (c *countingClassifierSource) ActiveClassifier(ctx context.Context) (classify.Classifier, error) {
	c.calls++
	return c.source.ActiveClassifier(ctx)
}

// effectiveTestRegistry registers the two real frozen rules exactly as the
// service does at startup, plus the stubs each case needs.
func effectiveTestRegistry(t *testing.T, extra ...classify.Classifier) *classify.Registry {
	t.Helper()
	registry := classify.NewRegistry()
	all := append([]classify.Classifier{classify.NewAcademicRuleV1(), classify.NewFirewatchRuleV2()}, extra...)
	for _, classifier := range all {
		if err := registry.Register(classifier); err != nil {
			t.Fatalf("register %q: %v", classifier.ID(), err)
		}
	}
	return registry
}

// classifierAuthorizedServer mirrors authorizedServerWith and additionally wires
// the production resolver, so the projection is exercised through the real
// authorized handler and not through a handler-shaped stub.
func classifierAuthorizedServer(t *testing.T, role string, store Repository, classifiers ClassifierSource) (http.Handler, string) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key}, nil)
	if err != nil {
		t.Fatal(err)
	}
	verifier := oidc.NewVerifier("https://issuer.test", &oidc.StaticKeySet{PublicKeys: []crypto.PublicKey{&key.PublicKey}}, &oidc.Config{ClientID: "firewatch-api"})
	payload, _ := json.Marshal(map[string]any{"iss": "https://issuer.test", "aud": "firewatch-api", "sub": "subject", "exp": time.Now().Add(time.Minute).Unix(), "typ": "Bearer", "realm_access": map[string]any{"roles": []string{role}}})
	signed, err := signer.Sign(payload)
	if err != nil {
		t.Fatal(err)
	}
	token, err := signed.CompactSerialize()
	if err != nil {
		t.Fatal(err)
	}
	return NewWithCycleAndClassifier(store, verifier, nil, nil, classifiers), token
}

// PM-16 / S1 (T3): GET /v1/models projects the classifier the next publication
// would actually resolve through the publisher's own source. Every case goes
// through the real authorized handler, and none of them may borrow an identity
// from the registry's active flag, a fixture row or private configuration.
func TestModelsEffectiveProjectsTheProductionResolver(t *testing.T) {
	const (
		trainedID      = "ml-fixture-v1"
		trainedHash    = "992bd6ac53c75c2d31829c1126c8d2cb97d5a61cad4348d1047d5c93b15a15b5"
		futureRuleID   = "future-rule-v3"
		futureRuleHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		badFormatID    = "future-rule-v4"
		badFormatHash  = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
		errorRuleID    = "future-rule-v5"
		errorRuleHash  = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
		opaqueRuleID   = "future-rule-v6"
		opaqueRuleHash = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
		shortRuleID    = "future-rule-v7"
	)
	divergent := strings.Repeat("0", 64)
	shortFingerprint := strings.Repeat("e", 63)
	registry := effectiveTestRegistry(t,
		stubTrainedClassifier{id: trainedID, hash: trainedHash},
		stubRuleClassifier{id: futureRuleID, hash: futureRuleHash},
		stubRuleClassifier{id: badFormatID, hash: badFormatHash},
		stubRuleClassifier{id: errorRuleID, hash: errorRuleHash, fingerprintErr: errors.New("cannot report a policy")},
		stubRuleClassifier{id: shortRuleID, hash: shortFingerprint},
		opaqueRuleClassifier{id: opaqueRuleID},
	)
	list := []repository.ModelVersion{
		seededModel(classify.AcademicRuleV1ID, classify.AcademicRuleV1ParamsHash),
		{Version: classify.FirewatchRuleV2ID, Kind: "rule", ParamsHash: stringPtr(classify.FirewatchRuleV2ParamsHash)},
	}

	for _, tc := range []struct {
		name      string
		model     repository.ModelVersion
		modelErr  error
		bootstrap classify.Classifier
		want      map[string]string
	}{
		{
			name:      "startup selection serves while the active row is only a seed",
			model:     seededModel(classify.AcademicRuleV1ID, classify.AcademicRuleV1ParamsHash),
			bootstrap: classify.NewFirewatchRuleV2(),
			want:      map[string]string{"status": "rule", "version": classify.FirewatchRuleV2ID, "params_hash": classify.FirewatchRuleV2ParamsHash},
		},
		{
			name:      "explicit activation selects the activated version",
			model:     activatedModel(classify.FirewatchRuleV2ID, classify.FirewatchRuleV2ParamsHash),
			bootstrap: classify.NewAcademicRuleV1(),
			want:      map[string]string{"status": "rule", "version": classify.FirewatchRuleV2ID, "params_hash": classify.FirewatchRuleV2ParamsHash},
		},
		{
			name:      "an activated non-rule is resolved without identity",
			model:     activatedModel(trainedID, trainedHash),
			bootstrap: classify.NewAcademicRuleV1(),
			want:      map[string]string{"status": "non_rule"},
		},
		{
			name:      "a startup-selected non-rule is resolved without identity",
			bootstrap: stubTrainedClassifier{id: trainedID, hash: trainedHash},
			want:      map[string]string{"status": "non_rule"},
		},
		{
			name:      "an activated version this binary cannot execute is unavailable",
			model:     activatedModel("trained-model-v9", "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"),
			bootstrap: classify.NewAcademicRuleV1(),
			want:      map[string]string{"status": "unavailable"},
		},
		{
			name:      "a frozen fingerprint mismatch is unavailable",
			model:     activatedModel(classify.AcademicRuleV1ID, divergent),
			bootstrap: classify.NewAcademicRuleV1(),
			want:      map[string]string{"status": "unavailable"},
		},
		{
			name:      "a registry read failure is unavailable",
			modelErr:  errors.New("db down"),
			bootstrap: classify.NewAcademicRuleV1(),
			want:      map[string]string{"status": "unavailable"},
		},
		{
			name: "no active row and no executable default is unavailable",
			want: map[string]string{"status": "unavailable"},
		},
		{
			name:      "a rule reporting a non-canonical fingerprint is unavailable",
			model:     activatedModel(badFormatID, badFormatHash),
			bootstrap: classify.NewAcademicRuleV1(),
			want:      map[string]string{"status": "unavailable"},
		},
		{
			name:      "a truncated fingerprint is unavailable",
			model:     activatedModel(shortRuleID, shortFingerprint),
			bootstrap: classify.NewAcademicRuleV1(),
			want:      map[string]string{"status": "unavailable"},
		},
		{
			name:      "a rule that cannot report a fingerprint is unavailable",
			model:     activatedModel(errorRuleID, errorRuleHash),
			bootstrap: classify.NewAcademicRuleV1(),
			want:      map[string]string{"status": "unavailable"},
		},
		{
			name:      "a rule with no fingerprint reporter is unavailable",
			model:     activatedModel(opaqueRuleID, opaqueRuleHash),
			bootstrap: classify.NewAcademicRuleV1(),
			want:      map[string]string{"status": "unavailable"},
		},
		{
			name:      "an unfrozen rule with a canonical fingerprint is a rule",
			model:     activatedModel(futureRuleID, futureRuleHash),
			bootstrap: classify.NewAcademicRuleV1(),
			want:      map[string]string{"status": "rule", "version": futureRuleID, "params_hash": futureRuleHash},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &fakeStore{models: list}
			source := service.RegistryClassifierSource{
				Models:    fixedActiveModel{model: tc.model, err: tc.modelErr},
				Registry:  registry,
				Bootstrap: tc.bootstrap,
			}
			handler, token := classifierAuthorizedServer(t, "viewer", store, source)
			w := getZones(t, handler, token, "/v1/models")
			if w.Code != http.StatusOK {
				t.Fatalf("got %d want 200: %s", w.Code, w.Body.String())
			}
			var body struct {
				Models    []repository.ModelVersion `json:"models"`
				Effective map[string]string         `json:"effective"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatalf("response is not JSON: %v: %s", err, w.Body.String())
			}
			// Preservation: the projection is additive and never replaces or
			// filters the registry list.
			if len(body.Models) != len(list) {
				t.Fatalf("models = %+v, want the unchanged %d-row list", body.Models, len(list))
			}
			if len(body.Effective) != len(tc.want) {
				t.Fatalf("effective = %v, want %v", body.Effective, tc.want)
			}
			for key, want := range tc.want {
				if body.Effective[key] != want {
					t.Fatalf("effective[%q] = %q, want %q (body %v)", key, body.Effective[key], want, body.Effective)
				}
			}
			// Reading the projection must not write: activation stays a separate
			// admin route.
			if len(store.activated) != 0 {
				t.Fatalf("the models read mutated the registry: %v", store.activated)
			}
		})
	}
}

// PM-16 / S1 (T3): the projection is added behind the existing read gate. A
// request without a token or with a role other than viewer/admin is refused
// before the classifier is resolved.
func TestEffectiveProjectionKeepsTheExistingReadGate(t *testing.T) {
	hash := classify.FirewatchRuleV2ParamsHash
	source := &countingClassifierSource{source: service.RegistryClassifierSource{
		Models:    fixedActiveModel{model: activatedModel(classify.FirewatchRuleV2ID, hash)},
		Registry:  effectiveTestRegistry(t),
		Bootstrap: classify.NewAcademicRuleV1(),
	}}
	store := &fakeStore{models: []repository.ModelVersion{activatedModel(classify.FirewatchRuleV2ID, hash)}}

	unauthenticated, _ := classifierAuthorizedServer(t, "viewer", store, source)
	w := httptest.NewRecorder()
	unauthenticated.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/models", nil))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated got %d want 401: %s", w.Code, w.Body.String())
	}

	forbidden, token := classifierAuthorizedServer(t, "operator", store, source)
	w = getZones(t, forbidden, token, "/v1/models")
	if w.Code != http.StatusForbidden {
		t.Fatalf("operator got %d want 403: %s", w.Code, w.Body.String())
	}
	if source.calls != 0 {
		t.Fatalf("a refused request resolved the classifier %d times", source.calls)
	}

	allowed, token := classifierAuthorizedServer(t, "admin", store, source)
	w = getZones(t, allowed, token, "/v1/models")
	if w.Code != http.StatusOK {
		t.Fatalf("admin got %d want 200: %s", w.Code, w.Body.String())
	}
	if source.calls != 1 {
		t.Fatalf("an admitted request resolved the classifier %d times, want once", source.calls)
	}
}

func stringPtr(value string) *string { return &value }

// staticClassifierSource answers with one classifier directly, so the projection
// itself can be checked against a source that has already resolved something it
// should not publish. The production resolver refuses these cases first; this
// test keeps the read's own claim gate from depending on that.
type staticClassifierSource struct {
	classifier classify.Classifier
	err        error
}

func (s staticClassifierSource) ActiveClassifier(context.Context) (classify.Classifier, error) {
	return s.classifier, s.err
}

// PM-16 / S1 (T3): the projection does not trust an arbitrary resolver to hand
// it a publishable identity. A frozen identifier with a divergent fingerprint, a
// rule with no fingerprint and an unknown kind all degrade to unavailable while
// the list stays a successful 200.
func TestModelsEffectiveRefusesAnUnverifiedClassifierWithoutTrustingTheSource(t *testing.T) {
	models := []repository.ModelVersion{seededModel(classify.AcademicRuleV1ID, classify.AcademicRuleV1ParamsHash)}
	for _, tc := range []struct {
		name       string
		classifier classify.Classifier
	}{
		{"frozen identifier with a divergent fingerprint", stubRuleClassifier{id: classify.AcademicRuleV1ID, hash: strings.Repeat("f", 64)}},
		{"rule without a fingerprint reporter", opaqueRuleClassifier{id: "opaque-rule-v1"}},
		{"unknown classifier kind", unknownKindClassifier{id: "kindless-v1"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &fakeStore{models: models}
			handler, token := classifierAuthorizedServer(t, "viewer", store, staticClassifierSource{classifier: tc.classifier})
			w := getZones(t, handler, token, "/v1/models")
			if w.Code != http.StatusOK {
				t.Fatalf("got %d want 200: %s", w.Code, w.Body.String())
			}
			var body struct {
				Effective map[string]string `json:"effective"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatalf("response is not JSON: %v: %s", err, w.Body.String())
			}
			if len(body.Effective) != 1 || body.Effective["status"] != "unavailable" {
				t.Fatalf("effective = %v, want exactly {status: unavailable}", body.Effective)
			}
		})
	}
}

// unknownKindClassifier is neither a rule nor a trained model, so it is not
// evidence of either projection state.
type unknownKindClassifier struct{ id string }

func (u unknownKindClassifier) ID() string          { return u.id }
func (u unknownKindClassifier) Kind() classify.Kind { return classify.Kind("other") }
func (u unknownKindClassifier) Classify(context.Context, classify.Features) (classify.Assessment, error) {
	return classify.Assessment{}, nil
}
