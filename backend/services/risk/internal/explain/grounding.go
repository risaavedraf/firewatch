package explain

import (
	"errors"
	"fmt"
	"regexp"
	"strings"

	"firewatch.local/risk/internal/classify"
)

// numericLiteral matches a figure in prose. It is used by GRD-I2 to prove that every
// number an answer states is anchored in the published batch, so a hallucinated
// figure is refused even if the blacklist of phrases does not happen to name it.
var numericLiteral = regexp.MustCompile(`[0-9]+(?:\.[0-9]+)?`)

// VerifyOutputGrounding is GRD-I2: the output guardrail.
//
// It is the last thing that runs before the route writes a response, and it fails
// closed. Eight properties are checked, each one closing a different way of claiming
// something the batch does not support:
//
//  1. the answer declares a synthetic provenance that the published batch actually
//     carries, and it carries both guardrail statuses, so a document cannot present
//     itself as verified - or as synthetic - when it was not;
//  2. every identity field - batch, zone, zone name, level, rule version - equals the
//     source batch, so an answer cannot be attributed to a batch the service did not
//     read;
//  3. the topic equals the one the validated request asked for. The request is a
//     parameter on purpose: a candidate that swapped BOTH its topic and its prose to
//     another valid topic is internally consistent, so only the request can refuse
//     it;
//  4. every cited factor equals the source: the five canonical variables in the
//     rule's order, with a value and a contribution if and only if the batch
//     measured them;
//  5. the text is exactly the composition of the source for the REQUESTED topic,
//     which is what refuses a hallucinated sentence rather than merely a
//     hallucinated number;
//  6. the notice is exactly the provenance notice the composer emits. The page
//     renders it verbatim, so it is part of what is served and must be grounded
//     like the rest;
//  7. the text carries none of the GRD-I1 patterns, so an answer cannot assert an
//     ignition cause, a prompt override, an operational command or a forecast
//     either;
//  8. every figure in the text is anchored in the batch, so a number that survived
//     the recomposition by construction cannot be invented later.
//
// Checks 5-8 overlap on purpose: 5 is the strong one, and 6, 7 and 8 are the direct
// statements of the ratified requirement, kept so a future composer change cannot
// quietly widen what the guardrail accepts.
func VerifyOutputGrounding(candidate Response, requested Input, source Source, previous *Source) error {
	// The provenance is checked against the batch, not only against the document. An
	// answer that declares a synthetic origin can only be grounded on a batch that was
	// published as synthetic, so a batch without the mark is refused instead of being
	// explained with a provenance nobody recorded. The two checks below cover both
	// directions of "the answer and the batch disagree".
	if !source.Synthetic {
		return errors.New("grd-i2: the source batch is not marked synthetic, so a synthetic provenance cannot be grounded")
	}
	if !candidate.Synthetic {
		return errors.New("grd-i2: the answer does not declare its synthetic provenance")
	}
	if candidate.Guardrails.Input != InputPass || candidate.Guardrails.Output != OutputPass {
		return fmt.Errorf("grd-i2: the answer carries guardrails %q / %q, want %q and %q",
			candidate.Guardrails.Input, candidate.Guardrails.Output, InputPass, OutputPass)
	}
	if err := verifyIdentity(candidate, source); err != nil {
		return err
	}
	if err := verifyCitedFactors(candidate.Factors, source.Factors); err != nil {
		return err
	}

	// The topic comes from the request. Recomposing with the candidate's own topic
	// would let an answer choose which question it replies to.
	if candidate.Topic != requested.Topic {
		return fmt.Errorf("grd-i2: the answer addresses topic %q, but the validated request asked %q", candidate.Topic, requested.Topic)
	}
	expected := Compose(source, previous, requested.Topic)
	if candidate.Answer != expected.Answer {
		return errors.New("grd-i2: the answer text is not the composition of the published batch for the requested topic")
	}
	// The notice is rendered verbatim by the page, so it is part of what the guardrail
	// must ground. A notice the composer did not emit - an empty one included - would
	// carry a provenance statement nobody verified.
	if candidate.Notice != expected.Notice {
		return errors.New("grd-i2: the notice is not the provenance notice a grounded answer carries")
	}
	if pattern, found := forbiddenScope(candidate.Answer); found {
		return fmt.Errorf("grd-i2: the answer asserts the forbidden claim %q", pattern)
	}
	return verifyGroundedNumbers(candidate.Answer, groundedTokens(source, previous))
}

// verifyIdentity compares every field the answer cites from the batch.
func verifyIdentity(candidate Response, source Source) error {
	for _, field := range []struct {
		name      string
		got, want string
	}{
		{"batch_id", candidate.BatchID, source.BatchID},
		{"zone_id", candidate.ZoneID, source.ZoneID},
		{"zone_name", candidate.ZoneName, source.ZoneName},
		{"risk_level", candidate.RiskLevel, source.RiskLevel},
		{"model_version", candidate.ModelVersion, source.ModelVersion},
	} {
		if field.got != field.want {
			return fmt.Errorf("grd-i2: %s is %q, but the published batch records %q", field.name, field.got, field.want)
		}
	}
	if _, ok := ParseTopic(string(candidate.Topic)); !ok {
		return fmt.Errorf("grd-i2: topic %q is not one of the five accepted topics", candidate.Topic)
	}
	return nil
}

// verifyCitedFactors requires the citation to be exactly the source projection: the
// same length, the same order, and a value and contribution present if and only if
// the batch measured them.
func verifyCitedFactors(candidate []CitedFactor, stored []classify.Factor) error {
	expected := citedFactors(stored)
	if len(candidate) != len(expected) {
		return fmt.Errorf("grd-i2: the answer cites %d factors, but the batch has %d canonical variables", len(candidate), len(expected))
	}
	for index, want := range expected {
		got := candidate[index]
		if got.Name != want.Name {
			return fmt.Errorf("grd-i2: factor %d is %q, but the canonical variable is %q", index, got.Name, want.Name)
		}
		if got.Known != want.Known {
			return fmt.Errorf("grd-i2: factor %q is cited as known=%t, but the batch records known=%t", want.Name, got.Known, want.Known)
		}
		if !equalQuantity(got.Value, want.Value) {
			return fmt.Errorf("grd-i2: factor %q cites a value the batch does not record", want.Name)
		}
		if !equalQuantity(got.Contribution, want.Contribution) {
			return fmt.Errorf("grd-i2: factor %q cites a contribution the batch does not record", want.Name)
		}
	}
	return nil
}

// equalQuantity compares two optional quantities: both absent, or both present with
// the same value. An absent quantity is not zero, so nil and a pointer to zero are
// different answers.
func equalQuantity(candidate, expected *float64) bool {
	if candidate == nil || expected == nil {
		return candidate == nil && expected == nil
	}
	return *candidate == *expected
}

// groundedTokens lists every literal a figure in the text may come from: the two
// identities, the instants, the rule version and every measured quantity, each
// formatted exactly as the composer formats it.
func groundedTokens(source Source, previous *Source) []string {
	tokens := []string{
		source.BatchID,
		source.ZoneID,
		source.ModelVersion,
		formatInstant(source.PublishedAt),
		formatInstant(source.ValidUntil),
	}
	if previous != nil {
		tokens = append(tokens, previous.BatchID, formatInstant(previous.PublishedAt))
	}
	measured := measuredFactors(source.Factors)
	for _, factor := range measured {
		tokens = append(tokens, formatQuantity(*factor.Value), formatQuantity(*factor.Contribution))
	}
	if len(measured) > 0 {
		tokens = append(tokens, formatQuantity(totalContribution(measured)))
	}
	return tokens
}

// verifyGroundedNumbers refuses a figure the batch does not contain. A literal is
// grounded when it appears inside one of the grounded tokens, which is what lets the
// digits of an instant, a UUID or a zone code through while refusing an invented
// quantity.
func verifyGroundedNumbers(text string, tokens []string) error {
	for _, literal := range numericLiteral.FindAllString(text, -1) {
		grounded := false
		for _, token := range tokens {
			if strings.Contains(token, literal) {
				grounded = true
				break
			}
		}
		if !grounded {
			return fmt.Errorf("grd-i2: the answer cites the figure %q, which the published batch does not contain", literal)
		}
	}
	return nil
}
