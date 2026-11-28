package explain

import (
	"strings"
	"testing"
	"time"

	"firewatch.local/risk/internal/classify"
)

// fixtures ---------------------------------------------------------------------

var composePublished = time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)

// findAllFactors is the five canonical variables a complete batch records, in the
// rule's own order.
func findAllFactors() []classify.Factor {
	return []classify.Factor{
		{Name: "temperatura", Known: true, Value: 32.5, Contribution: 0.4, Note: "lectura alta"},
		{Name: "humedad_relativa", Known: true, Value: 21, Contribution: 0.3, Note: "aire seco"},
		{Name: "viento", Known: true, Value: 44, Contribution: 0.2, Note: "viento fuerte"},
		{Name: "cobertura_vegetal", Known: false, Contribution: 0, Note: "sin lectura"},
		{Name: "incendios_historicos", Known: true, Value: 3, Contribution: 0.1, Note: ""},
	}
}

func fullSource() Source {
	return Source{
		BatchID:      "1e0f6d5c-9a4b-4c3d-8f2a-7b1c0d9e8f77",
		ZoneID:       "05101",
		ZoneName:     "Valparaíso",
		RiskLevel:    "alto",
		ModelVersion: "academic-rule-v1",
		PublishedAt:  composePublished,
		ValidUntil:   composePublished.Add(15 * time.Minute),
		Synthetic:    true,
		Factors:      findAllFactors(),
	}
}

func previousSource() *Source {
	return &Source{
		BatchID:      "2a1b7e6d-0c5e-4d4f-9a3b-8c2d1e0f9a88",
		ZoneID:       "05101",
		ZoneName:     "Valparaíso",
		RiskLevel:    "medio",
		ModelVersion: "academic-rule-v1",
		PublishedAt:  composePublished.Add(-15 * time.Minute),
		ValidUntil:   composePublished,
		Synthetic:    true,
		Factors:      findAllFactors(),
	}
}

// S2/S4: every answer cites the zone it used and the batch it used, carries both
// guardrail statuses, declares its synthetic provenance, and names all five
// canonical variables in the rule's order for every topic.
func TestComposeCitesTheBatchAndAllFiveCanonicalFactorsForEveryTopic(t *testing.T) {
	source := fullSource()
	previous := previousSource()
	for _, topic := range Topics() {
		t.Run(string(topic), func(t *testing.T) {
			answer := Compose(source, previous, topic)
			if answer.BatchID != source.BatchID {
				t.Errorf("batch_id = %q, want %q", answer.BatchID, source.BatchID)
			}
			if answer.ZoneID != source.ZoneID || answer.ZoneName != source.ZoneName {
				t.Errorf("zone = (%q, %q), want (%q, %q)", answer.ZoneID, answer.ZoneName, source.ZoneID, source.ZoneName)
			}
			if answer.Topic != topic {
				t.Errorf("topic = %q, want %q", answer.Topic, topic)
			}
			if answer.RiskLevel != source.RiskLevel {
				t.Errorf("risk_level = %q, want %q", answer.RiskLevel, source.RiskLevel)
			}
			if !answer.Synthetic {
				t.Error("synthetic is false, want the declared synthetic provenance")
			}
			if answer.Guardrails.Input != InputPass || answer.Guardrails.Output != OutputPass {
				t.Errorf("guardrails = %+v, want both PASS", answer.Guardrails)
			}
			if !strings.Contains(answer.Answer, source.BatchID) {
				t.Error("the answer text does not cite the batch it used")
			}
			if !strings.Contains(answer.Answer, source.ZoneID) || !strings.Contains(answer.Answer, source.ZoneName) {
				t.Error("the answer text does not cite the zone it used")
			}
			if len(answer.Factors) != 5 {
				t.Fatalf("cites %d factors, want the five canonical variables", len(answer.Factors))
			}
			for index, factor := range answer.Factors {
				if factor.Name != source.Factors[index].Name {
					t.Errorf("factor %d = %q, want canonical %q", index, factor.Name, source.Factors[index].Name)
				}
			}
			if err := VerifyOutputGrounding(answer, requestFor(source, topic), source, previous); err != nil {
				t.Errorf("the composed answer does not pass GRD-I2: %v", err)
			}
		})
	}
}

// S2/S4: a variable the batch did not measure is cited as unmeasured, and no
// number is ever attached to it. This is the non-invention rule the mandante's
// item 20 asks for, enforced at composition and at verification.
func TestComposeNeverInventsAValueForAnUnmeasuredFactor(t *testing.T) {
	source := fullSource()
	source.Factors = []classify.Factor{
		{Name: "temperatura", Known: true, Value: 32.5, Contribution: 0.4},
		{Name: "humedad_relativa", Known: false, Contribution: 0},
	}
	answer := Compose(source, nil, TopicFactors)
	unmeasured := 0
	for _, factor := range answer.Factors {
		if factor.Known {
			if factor.Value == nil || factor.Contribution == nil {
				t.Errorf("known factor %q cites no value or contribution", factor.Name)
			}
			continue
		}
		unmeasured++
		if factor.Value != nil || factor.Contribution != nil {
			t.Errorf("unmeasured factor %q cites a value or contribution", factor.Name)
		}
	}
	if unmeasured != 4 {
		t.Fatalf("cited %d unmeasured factors, want the four the batch does not record", unmeasured)
	}
	if !strings.Contains(answer.Answer, NoReading) {
		t.Errorf("the answer text does not state %q for the unmeasured variables", NoReading)
	}
	if err := VerifyOutputGrounding(answer, requestFor(source, TopicFactors), source, nil); err != nil {
		t.Fatalf("GRD-I2 refused the composed answer: %v", err)
	}
}

// S2/S4: an `desconocido` level is information, not a severity, and the assistant
// must not infer a level, a priority or a cause from it.
func TestComposeDoesNotInferFromAnUnknownLevel(t *testing.T) {
	source := fullSource()
	source.RiskLevel = "desconocido"
	source.Factors = []classify.Factor{
		{Name: "temperatura", Known: false},
		{Name: "humedad_relativa", Known: false},
		{Name: "viento", Known: false},
		{Name: "cobertura_vegetal", Known: false},
		{Name: "incendios_historicos", Known: false},
	}
	for _, topic := range Topics() {
		answer := Compose(source, nil, topic)
		lowered := strings.ToLower(answer.Answer)
		for _, forbidden := range []string{"nivel alto", "nivel medio", "nivel bajo"} {
			if strings.Contains(lowered, forbidden) {
				t.Errorf("%s answer infers a severity: %q", topic, forbidden)
			}
		}
		if err := VerifyOutputGrounding(answer, requestFor(source, topic), source, nil); err != nil {
			t.Errorf("%s answer does not pass GRD-I2: %v", topic, err)
		}
	}
}

// S2: the trend topic compares two consecutive publications or states that it
// cannot compare. It never presents one publication as a series.
func TestComposeTrendUsesThePreviousPublicationOrDeclaresItsAbsence(t *testing.T) {
	source := fullSource()

	withoutPrevious := Compose(source, nil, TopicTrend)
	if !strings.Contains(strings.ToLower(withoutPrevious.Answer), "no se informa ninguna tendencia") {
		t.Errorf("single-publication trend does not declare the absence: %q", withoutPrevious.Answer)
	}
	if err := VerifyOutputGrounding(withoutPrevious, requestFor(source, TopicTrend), source, nil); err != nil {
		t.Fatalf("GRD-I2 refused the single-publication trend: %v", err)
	}

	previous := previousSource()
	withPrevious := Compose(source, previous, TopicTrend)
	if !strings.Contains(withPrevious.Answer, previous.BatchID) {
		t.Errorf("trend does not cite the previous publication: %q", withPrevious.Answer)
	}
	if !strings.Contains(withPrevious.Answer, previous.RiskLevel) {
		t.Errorf("trend does not cite the previous level %q: %q", previous.RiskLevel, withPrevious.Answer)
	}
	if err := VerifyOutputGrounding(withPrevious, requestFor(source, TopicTrend), source, previous); err != nil {
		t.Fatalf("GRD-I2 refused the two-publication trend: %v", err)
	}
}

// S4: a fixed two-decimal scale silently rounded the measurement. A factor recorded
// as 0.125 was rendered "0.13" and a value of 18.375 became "18.38", so the text
// stated a magnitude the batch never recorded — and GRD-I2, which formats through
// this same function, could not tell the difference. The formatter keeps every
// significant digit now.
func TestFormatQuantityKeepsEveryDigit(t *testing.T) {
	for _, tc := range []struct {
		value float64
		want  string
	}{
		{0.125, "0.125"},
		{18.375, "18.375"},
		{0.4, "0.4"},
		{0.5, "0.5"},
		{32.5, "32.5"},
		{0, "0"},
		{1, "1"},
		{-0.125, "-0.125"},
	} {
		if got := formatQuantity(tc.value); got != tc.want {
			t.Errorf("formatQuantity(%v) = %q, want %q", tc.value, got, tc.want)
		}
	}
}

// S5: the assistant is a pure function of the published batch. Two compositions
// of the same input are byte-identical, which is what makes the verification
// possible and the answer reproducible.
func TestComposeIsDeterministic(t *testing.T) {
	source := fullSource()
	previous := previousSource()
	for _, topic := range Topics() {
		first := Compose(source, previous, topic)
		second := Compose(source, previous, topic)
		if first.Answer != second.Answer {
			t.Errorf("%s is not deterministic:\n%s\n%s", topic, first.Answer, second.Answer)
		}
	}
}
