package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"mime"
	"net/http"
	"strings"
	"time"

	observations "firewatch.local/contracts/observations/v1"
	"firewatch.local/risk/internal/classify"
	"firewatch.local/risk/internal/repository"
)

// simulationBodyLimit bounds the request document. The accepted body is a zone
// code and at most five numbers, so a kilobyte is generous; the bound exists so a
// caller cannot make the service parse an arbitrarily large document on a route
// that holds no lock and writes nothing.
const simulationBodyLimit = 4096

// simulationFreshnessNotEvaluated is the response's freshness status. The
// simulation pins both instants to the batch's recorded request instant, so the
// rule's staleness comparison cannot fire and the answer says nothing about
// whether the stored data is current. Naming that state explicitly is what keeps
// this route from being read as a freshness or availability signal.
const simulationFreshnessNotEvaluated = "not_evaluated"

// simulationNotice is the declaration every successful answer carries: the
// result is the stored rule applied to hypothetical values, not a forecast, not
// an official index, and not a new publication.
const simulationNotice = "Simulación contrafactual de la regla %s registrada en el lote: aplica la misma regla a variables hipotéticas. No es un pronóstico, no es un índice oficial y no modifica ningún dato publicado."

// errUnreproducibleRule means the stored batch cannot be simulated honestly: the
// version it recorded is not a rule this binary can rebuild, or the recorded policy
// reference does not match the parameters rebuilt here. It is a deterministic
// refusal, not a storage failure, so it is answered 422 instead of 503.
var errUnreproducibleRule = errors.New("the stored batch rule cannot be reproduced")

// simulationRule is a built-in rule this binary can reconstruct locally. Both
// production rules implement it, and the fingerprint they report is what binds a
// stored reference to the numbers that will actually run.
type simulationRule interface {
	classify.Classifier
	classify.PolicyFingerprinter
}

// resolveStoredRule maps the version recorded on a batch to the local rule that
// produced it. Only built-in rules are resolvable: a fixture executed by the
// inference service, a trained artifact or a placeholder never classified
// anything this process can run, and inventing a level for them would attribute a
// result to a policy nobody executed.
func resolveStoredRule(version string) (simulationRule, error) {
	switch version {
	case classify.AcademicRuleV1ID:
		return classify.NewAcademicRuleV1(), nil
	case classify.FirewatchRuleV2ID:
		return classify.NewFirewatchRuleV2(), nil
	}
	return nil, fmt.Errorf("%w: no built-in rule answers to %q", errUnreproducibleRule, version)
}

// reproduciblePolicy checks that the reference recorded with the batch names
// exactly the policy this binary would run, and returns that identity for the
// response.
//
// Four checks, all required, because each one closes a different way of claiming
// a provenance the numbers do not support:
//
//   - the reference exists, names an identifier and carries the parameter map
//     whose values it claims to have fingerprinted;
//   - the identifier is the one the resolved rule reports;
//   - the recorded fingerprint is the fingerprint of the reconstructed parameter
//     set, so an edit behind an unchanged version name is refused instead of
//     silently simulated;
//   - the recorded parameter map hashes to the fingerprint it carries, so the
//     reference is internally consistent rather than two independent claims.
//
// A frozen identifier additionally has to agree with the frozen expectation the
// registry enforces at startup, so this route cannot accept a provenance the
// publication path would have refused.
func reproduciblePolicy(rule simulationRule, recorded *classify.PolicyRef) (classify.PolicyRef, error) {
	if recorded == nil || recorded.PolicyID == "" || recorded.ParamsHash == "" || len(recorded.Parameters) == 0 {
		return classify.PolicyRef{}, fmt.Errorf("%w: the batch records no complete policy reference", errUnreproducibleRule)
	}
	if recorded.PolicyID != rule.ID() {
		return classify.PolicyRef{}, fmt.Errorf("%w: the batch records policy %q, but version %q rebuilds %q", errUnreproducibleRule, recorded.PolicyID, rule.ID(), rule.ID())
	}
	fingerprint, err := rule.PolicyFingerprint()
	if err != nil {
		return classify.PolicyRef{}, fmt.Errorf("%w: %s cannot report its policy: %v", errUnreproducibleRule, rule.ID(), err)
	}
	if recorded.ParamsHash != fingerprint {
		return classify.PolicyRef{}, fmt.Errorf("%w: the batch records fingerprint %q, but %s reports %q", errUnreproducibleRule, recorded.ParamsHash, rule.ID(), fingerprint)
	}
	if classify.ParamsHash(recorded.Parameters) != recorded.ParamsHash {
		return classify.PolicyRef{}, fmt.Errorf("%w: the recorded parameters do not hash to the recorded fingerprint", errUnreproducibleRule)
	}
	if expected, frozen := classify.ExpectedPolicyHash(rule.ID()); frozen && expected != fingerprint {
		return classify.PolicyRef{}, fmt.Errorf("%w: %s reports %q, but the frozen expectation is %q", errUnreproducibleRule, rule.ID(), fingerprint, expected)
	}
	return classify.PolicyRef{PolicyID: rule.ID(), ParamsHash: fingerprint}, nil
}

// simulationFactor is one canonical variable of a simulated assessment. Value and
// contribution are omitted when the variable is absent: a missing observation is
// not a zero, and rendering it as one would turn "we do not know" into "nothing to
// worry about".
type simulationFactor struct {
	Name         string   `json:"name"`
	Known        bool     `json:"known"`
	Value        *float64 `json:"value,omitempty"`
	Contribution *float64 `json:"contribution,omitempty"`
}

// simulationAssessment is one rule evaluation in the answer: the level and the
// factors that produced it, without the long rationale the batch endpoint keeps.
type simulationAssessment struct {
	Level   string             `json:"level"`
	Factors []simulationFactor `json:"factors"`
}

// simulationPolicy is the stored policy identity, repeated so the answer can be
// attributed without a second read.
type simulationPolicy struct {
	PolicyID   string `json:"policy_id"`
	ParamsHash string `json:"params_hash"`
}

// simulationResponse is the route's body. It is deliberately compact: identity,
// the stored level, the recomputed pair and the explicit freshness status. It
// carries no forecast member, no probability and no new publication.
type simulationResponse struct {
	BatchID            string               `json:"batch_id"`
	ZoneID             string               `json:"zone_id"`
	ModelVersion       string               `json:"model_version"`
	StoredLevel        string               `json:"stored_level"`
	Policy             simulationPolicy     `json:"policy"`
	ComputationInstant time.Time            `json:"computation_instant"`
	Freshness          string               `json:"freshness"`
	Before             simulationAssessment `json:"before"`
	After              simulationAssessment `json:"after"`
	Notice             string               `json:"notice"`
}

// simulationJSONMember is one member of a JSON object, kept in document order so duplicate
// names can be detected. encoding/json silently keeps the last of two equal keys,
// which would let a caller write two different values for one variable.
type simulationJSONMember struct {
	name  string
	value json.RawMessage
}

// simulationRequest is the parsed document: one catalogue zone and a non-empty
// subset of the five canonical variables. A nil value means the caller asked for
// that variable to be treated as absent.
type simulationRequest struct {
	zone      string
	variables map[string]*float64
}

// simulate serves POST /v1/risk/simulate.
//
// It is wrapped in the same Authorize gate as every other risk route, so the
// verified viewer/admin roles are decided before a body is read, and it uses no
// further role check. The handler performs exactly two storage reads - the zone
// catalogue membership and the newest stored batch of that zone - and writes
// nothing: no batch, no outbox, no alert, no audit row. The recomputation is local
// arithmetic over the rule the batch recorded, so no inference call is made.
func simulate(store Repository) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || media != "application/json" {
			fail(w, http.StatusUnsupportedMediaType, "json_required")
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, simulationBodyLimit))
		if err != nil {
			fail(w, http.StatusBadRequest, "invalid_simulation")
			return
		}
		input, err := parseSimulationRequest(body)
		if err != nil {
			fail(w, http.StatusBadRequest, "invalid_simulation")
			return
		}
		// Membership is asked of the catalogue, not of a literal, exactly as the
		// per-zone reads do: the accepted set is whatever the zones table holds.
		exists, err := store.ZoneExists(r.Context(), input.zone)
		if err != nil {
			fail(w, http.StatusServiceUnavailable, "storage_unavailable")
			return
		}
		if !exists {
			fail(w, http.StatusBadRequest, "invalid_zone")
			return
		}
		batches, err := store.List(r.Context(), input.zone, 1)
		if err != nil {
			fail(w, http.StatusServiceUnavailable, "storage_unavailable")
			return
		}
		if len(batches) == 0 {
			respond(w, http.StatusNotFound, map[string]string{"code": "no_published_batch", "data_status": "insufficient"})
			return
		}
		result, err := simulateBatch(r.Context(), batches[0], input.variables)
		if err != nil {
			// Every remaining failure is a refusal to attribute a level to a policy
			// that cannot be reproduced - never a fallback to the active model.
			fail(w, http.StatusUnprocessableEntity, "unsupported_original_rule")
			return
		}
		respond(w, http.StatusOK, result)
	}
}

// simulateBatch rebuilds the stored rule, checks the recorded provenance against
// it, and computes the stored and the substituted evaluation with one explicit
// instant.
//
// Both evaluations pin ObservedAt and EvaluatedAt to the batch's recorded request
// instant. That is what makes the two comparable and the answer reproducible: the
// rule never reads the system clock, no freshness decision is taken here, and the
// only difference between before and after is the caller's variables.
func simulateBatch(ctx context.Context, batch repository.Batch, variables map[string]*float64) (simulationResponse, error) {
	rule, err := resolveStoredRule(batch.ModelVersion)
	if err != nil {
		return simulationResponse{}, err
	}
	policy, err := reproduciblePolicy(rule, batch.Policy)
	if err != nil {
		return simulationResponse{}, err
	}
	features, err := storedSimulationFeatures(batch)
	if err != nil {
		return simulationResponse{}, err
	}
	before, err := evaluateSimulation(ctx, rule, features)
	if err != nil {
		return simulationResponse{}, fmt.Errorf("%w: the stored evaluation failed: %v", errUnreproducibleRule, err)
	}
	after, err := evaluateSimulation(ctx, rule, applySimulationVariables(features, variables))
	if err != nil {
		return simulationResponse{}, fmt.Errorf("%w: the substituted evaluation failed: %v", errUnreproducibleRule, err)
	}
	return simulationResponse{
		BatchID:            batch.ID,
		ZoneID:             batch.ZoneID,
		ModelVersion:       rule.ID(),
		StoredLevel:        batch.RiskLevel,
		Policy:             simulationPolicy{PolicyID: policy.PolicyID, ParamsHash: policy.ParamsHash},
		ComputationInstant: batch.RequestedAt.UTC(),
		Freshness:          simulationFreshnessNotEvaluated,
		Before:             before,
		After:              after,
		Notice:             fmt.Sprintf(simulationNotice, rule.ID()),
	}, nil
}

// storedSimulationFeatures turns the stored factors back into classifier input.
//
// Only a factor the rule recorded as known becomes a known feature; every other
// variable - recorded absent, or not recorded at all - stays absent. The instant
// is the batch's request instant, used for both bounds of the evaluation, and a
// batch that records none cannot be pinned and is refused rather than evaluated
// against the current clock.
func storedSimulationFeatures(batch repository.Batch) (classify.Features, error) {
	if batch.RequestedAt.IsZero() {
		return classify.Features{}, fmt.Errorf("%w: the batch records no request instant", errUnreproducibleRule)
	}
	var factors []classify.Factor
	if err := json.Unmarshal(batch.Factors, &factors); err != nil {
		return classify.Features{}, fmt.Errorf("%w: the stored factors are not readable: %v", errUnreproducibleRule, err)
	}
	values := make(map[string]classify.Feature, len(factors))
	for _, factor := range factors {
		if factor.Known {
			values[factor.Name] = classify.Known(factor.Value)
			continue
		}
		values[factor.Name] = classify.Unknown()
	}
	instant := batch.RequestedAt.UTC()
	return classify.Features{
		ObservedAt:          instant,
		EvaluatedAt:         instant,
		ZoneID:              batch.ZoneID,
		TemperatureC:        values[observations.VariableTemperature],
		RelativeHumidityPct: values[observations.VariableHumidity],
		WindSpeedKmh:        values[observations.VariableWind],
		VegetationCoverPct:  values[observations.VariableVegetation],
		HistoricalFires:     values[observations.VariableHistoricalFires],
	}, nil
}

// applySimulationVariables returns the input with the requested variables
// substituted. A nil value forces the variable to be absent, which is the
// documented way to ask "what if this reading were missing"; a number replaces the
// stored observation. Names are already known to be canonical, so every canonical
// variable has an arm.
func applySimulationVariables(features classify.Features, variables map[string]*float64) classify.Features {
	for name, value := range variables {
		substituted := classify.Unknown()
		if value != nil {
			substituted = classify.Known(*value)
		}
		switch name {
		case observations.VariableTemperature:
			features.TemperatureC = substituted
		case observations.VariableHumidity:
			features.RelativeHumidityPct = substituted
		case observations.VariableWind:
			features.WindSpeedKmh = substituted
		case observations.VariableVegetation:
			features.VegetationCoverPct = substituted
		case observations.VariableHistoricalFires:
			features.HistoricalFires = substituted
		}
	}
	return features
}

// evaluateSimulation runs one local evaluation and compacts it for the wire. The
// classifier reads no clock and calls no service, so this cannot publish, enqueue
// or infer.
func evaluateSimulation(ctx context.Context, rule simulationRule, features classify.Features) (simulationAssessment, error) {
	assessment, err := rule.Classify(ctx, features)
	if err != nil {
		return simulationAssessment{}, err
	}
	return simulationAssessment{
		Level:   string(assessment.Level),
		Factors: compactSimulationFactors(assessment.Factors),
	}, nil
}

// compactSimulationFactors drops the note and the zero value of an absent factor,
// so an absent variable is served as absent instead of as a zero observation.
func compactSimulationFactors(factors []classify.Factor) []simulationFactor {
	compact := make([]simulationFactor, 0, len(factors))
	for _, factor := range factors {
		entry := simulationFactor{Name: factor.Name, Known: factor.Known}
		if factor.Known {
			value, contribution := factor.Value, factor.Contribution
			entry.Value = &value
			entry.Contribution = &contribution
		}
		compact = append(compact, entry)
	}
	return compact
}

// parseSimulationRequest reads the one accepted document: a JSON object with
// exactly zone_id and variables, no unknown member, no duplicate member and no
// trailing input. Every restriction is enforced here rather than by
// encoding/json alone, because the default decoder accepts all three.
func parseSimulationRequest(body []byte) (simulationRequest, error) {
	if len(bytes.TrimSpace(body)) == 0 {
		return simulationRequest{}, errors.New("simulation body is empty")
	}
	members, err := decodeSimulationObject(body)
	if err != nil {
		return simulationRequest{}, err
	}
	var request simulationRequest
	var zoneSeen, variablesSeen bool
	for _, member := range members {
		switch member.name {
		case "zone_id":
			if err := json.Unmarshal(member.value, &request.zone); err != nil {
				return simulationRequest{}, fmt.Errorf("zone_id is not a string: %w", err)
			}
			// Surrounding whitespace is refused instead of trimmed: a trimmed code
			// would be an alias the catalogue does not hold.
			if request.zone == "" || request.zone != strings.TrimSpace(request.zone) {
				return simulationRequest{}, errors.New("zone_id is empty or padded")
			}
			zoneSeen = true
		case "variables":
			variables, err := parseSimulationVariables(member.value)
			if err != nil {
				return simulationRequest{}, err
			}
			request.variables = variables
			variablesSeen = true
		default:
			return simulationRequest{}, fmt.Errorf("unknown member %q", member.name)
		}
	}
	if !zoneSeen {
		return simulationRequest{}, errors.New("zone_id is required")
	}
	if !variablesSeen || len(request.variables) == 0 {
		return simulationRequest{}, errors.New("variables is required and must not be empty")
	}
	return request, nil
}

// parseSimulationVariables reads the substitution object. Its keys are exactly the
// canonical variable names the classifier understands, so an unknown name is
// malformed input rather than a silently ignored request.
func parseSimulationVariables(raw json.RawMessage) (map[string]*float64, error) {
	members, err := decodeSimulationObject(raw)
	if err != nil {
		return nil, fmt.Errorf("variables is not an object: %w", err)
	}
	variables := make(map[string]*float64, len(members))
	for _, member := range members {
		if !canonicalSimulationVariable(member.name) {
			return nil, fmt.Errorf("unknown variable %q", member.name)
		}
		value, err := parseSimulationValue(member.value)
		if err != nil {
			return nil, fmt.Errorf("variable %q: %w", member.name, err)
		}
		variables[member.name] = value
	}
	return variables, nil
}

// canonicalSimulationVariable reports whether name is part of the shared canonical
// vocabulary. The list is read from the contracts module rather than duplicated
// here, so a new vocabulary entry needs no edit in this service.
func canonicalSimulationVariable(name string) bool {
	for _, known := range observations.VariableNames() {
		if name == known {
			return true
		}
	}
	return false
}

// parseSimulationValue accepts a number or an explicit null. Null is not zero: it
// means the caller asks for the variable to be treated as absent. The token is
// inspected with UseNumber because json.Number would otherwise accept a QUOTED
// number literal - "30" decodes as 30 - and a string is not an observation this
// rule can score. A boolean, object, array or non-finite literal is refused the
// same way.
func parseSimulationValue(raw json.RawMessage) (*float64, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	token, err := decoder.Token()
	if err != nil {
		return nil, errors.New("value must be a number or null")
	}
	if token == nil {
		return nil, nil
	}
	number, ok := token.(json.Number)
	if !ok {
		return nil, errors.New("value must be a number or null")
	}
	value, err := number.Float64()
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		return nil, errors.New("value must be a finite number")
	}
	return &value, nil
}

// decodeSimulationObject returns an object's members in document order, refusing a
// duplicate name, a document that is not an object, and any trailing input after
// the closing brace. detection of those three is the reason this does not use the
// stdlib struct decoder: it accepts all three silently.
func decodeSimulationObject(document []byte) ([]simulationJSONMember, error) {
	decoder := json.NewDecoder(bytes.NewReader(document))
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	if delimiter, ok := token.(json.Delim); !ok || delimiter != '{' {
		return nil, errors.New("document is not a JSON object")
	}
	members := make([]simulationJSONMember, 0, 2)
	seen := make(map[string]bool, 2)
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		name, ok := token.(string)
		if !ok {
			return nil, errors.New("member name is not a string")
		}
		if seen[name] {
			return nil, fmt.Errorf("duplicate member %q", name)
		}
		seen[name] = true
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}
		members = append(members, simulationJSONMember{name: name, value: value})
	}
	if _, err := decoder.Token(); err != nil {
		return nil, err
	}
	// One document means one value: anything after the closing brace - including a
	// second object - is refused instead of being ignored.
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return nil, errors.New("trailing input after the JSON object")
	}
	return members, nil
}
