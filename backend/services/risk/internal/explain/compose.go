package explain

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	observations "firewatch.local/contracts/observations/v1"
	"firewatch.local/risk/internal/classify"
)

const (
	// InputPass and OutputPass are the two statuses every answer carries. They are
	// literals rather than booleans so the answer states which guardrail passed and
	// a reader can grep for the code.
	InputPass  = "GRD-I1:PASS"
	OutputPass = "GRD-I2:PASS"

	// SyntheticNotice is the provenance notice every answer carries. v1.0 publishes
	// only synthetic rule output (tasks/v1-produccion.md S2), so an answer that
	// claimed otherwise would be the untrue statement.
	//
	// It says «no anticipa lo que ocurrirá» rather than naming a forecast: GRD-I1
	// refuses a request for one, and the answer should not assert the vocabulary of the
	// question it declines. The temporal list that refuses those questions is
	// input-only, so this wording is a choice about honesty rather than a constraint
	// forced by the output scan.
	SyntheticNotice = "Procedencia sintética: esta explicación se compone localmente a partir de datos sintéticos. No es un riesgo real observado, no anticipa lo que ocurrirá y no proviene de ningún modelo de lenguaje externo."

	// unclassifiedSentence is appended whenever the stored level is not one of the
	// three severities. An unclassified batch is information, never a severity, and
	// nothing is inferred from it.
	unclassifiedSentence = "El nivel es no determinado: la regla no tuvo lecturas suficientes y este asistente no infiere un nivel, una causa ni una prioridad."
)

// Source is the published batch an answer is grounded on. It is a local projection
// of the stored row rather than the persistence type, so this package owns its own
// contract and the guardrail cannot reach a database through it.
type Source struct {
	BatchID      string
	ZoneID       string
	ZoneName     string
	RiskLevel    string
	ModelVersion string
	PublishedAt  time.Time
	ValidUntil   time.Time
	// Synthetic is the batch's own synthetic/demonstrative mark, as the publication
	// path recorded it (the stored `demo` column). It is the batch's provenance, not
	// the answer's: GRD-I2 compares the two, so an answer cannot declare a synthetic
	// origin for a batch that was not published as synthetic.
	Synthetic bool
	// Factors are the variables the batch recorded. A canonical variable absent
	// from this slice is cited as unmeasured, never as zero.
	Factors []classify.Factor
}

// Guardrails is the pair of statuses the answer carries.
type Guardrails struct {
	Input  string `json:"input"`
	Output string `json:"output"`
}

// CitedFactor is one canonical variable as cited in an answer. Value and
// Contribution are omitted when the batch did not measure the variable: a missing
// reading is not the number zero, and rendering it as one would turn "we do not
// know" into "nothing to worry about".
type CitedFactor struct {
	Name         string   `json:"name"`
	Known        bool     `json:"known"`
	Value        *float64 `json:"value,omitempty"`
	Contribution *float64 `json:"contribution,omitempty"`
}

// Response is the answer document.
type Response struct {
	BatchID      string        `json:"batch_id"`
	ZoneID       string        `json:"zone_id"`
	ZoneName     string        `json:"zone_name"`
	Topic        Topic         `json:"topic"`
	RiskLevel    string        `json:"risk_level"`
	ModelVersion string        `json:"model_version"`
	Synthetic    bool          `json:"synthetic"`
	Answer       string        `json:"answer"`
	Factors      []CitedFactor `json:"factors"`
	Guardrails   Guardrails    `json:"guardrails"`
	Notice       string        `json:"notice"`
}

// factorLabels is the prose spelling of the canonical variables. The wire names
// stay untouched: this map is presentation only, and a variable the map does not
// know is printed by its canonical name rather than dropped.
var factorLabels = map[string]string{
	observations.VariableTemperature:     "temperatura",
	observations.VariableHumidity:        "humedad relativa",
	observations.VariableWind:            "viento",
	observations.VariableVegetation:      "cobertura vegetal",
	observations.VariableHistoricalFires: "incendios históricos",
}

// Compose renders the answer for one topic from one published batch. It is a pure
// function: no clock, no network, no storage, so the same arguments always produce
// the same bytes and GRD-I2 can recompose what it is about to verify.
//
// previous is the publication immediately before source, or nil when the batch is
// the only one stored for the commune. Only TopicTrend reads it.
func Compose(source Source, previous *Source, topic Topic) Response {
	answer := fmt.Sprintf("Lote %s de la comuna %s (%s). Nivel registrado: %s. %s",
		source.BatchID, source.ZoneName, source.ZoneID, levelLabel(source.RiskLevel), topicBody(source, previous, topic))
	if !classified(source.RiskLevel) {
		answer += " " + unclassifiedSentence
	}
	return Response{
		BatchID:      source.BatchID,
		ZoneID:       source.ZoneID,
		ZoneName:     source.ZoneName,
		Topic:        topic,
		RiskLevel:    source.RiskLevel,
		ModelVersion: source.ModelVersion,
		Synthetic:    true,
		Answer:       answer,
		Factors:      citedFactors(source.Factors),
		Guardrails:   Guardrails{Input: InputPass, Output: OutputPass},
		Notice:       SyntheticNotice,
	}
}

// topicBody renders the topic-specific half of the answer.
func topicBody(source Source, previous *Source, topic Topic) string {
	switch topic {
	case TopicFactors:
		return factorsBody(source)
	case TopicPriority:
		return priorityBody(source)
	case TopicTrend:
		return trendBody(previous)
	case TopicRecommendations:
		return recommendationsBody(source)
	case TopicSources:
		return sourcesBody(source)
	}
	// Unreachable through ValidateInput, which refuses any other topic. An unknown
	// topic renders a refusal sentence rather than an empty answer, and GRD-I2 will
	// refuse the document anyway because its text cannot be recomposed.
	return "El tópico solicitado no forma parte de los cinco tópicos operativos que este asistente responde."
}

// factorsBody names all five canonical variables in the rule's order, with the
// value and contribution of the ones the batch measured and «sin lectura» for the
// ones it did not.
func factorsBody(source Source) string {
	var body strings.Builder
	body.WriteString("Cómo lo calculó la regla: el lote evalúa cinco variables canónicas en este orden.")
	for _, factor := range citedFactors(source.Factors) {
		body.WriteString(" ")
		body.WriteString(factorSentence(factor))
	}
	return body.String()
}

// factorSentence renders one cited variable. An unmeasured variable is stated as
// such and receives no figure at all.
func factorSentence(factor CitedFactor) string {
	if !factor.Known || factor.Value == nil || factor.Contribution == nil {
		return fmt.Sprintf("%s: %s.", factorLabel(factor.Name), NoReading)
	}
	return fmt.Sprintf("%s: %s con aporte %s.", factorLabel(factor.Name), formatQuantity(*factor.Value), formatQuantity(*factor.Contribution))
}

// priorityBody ranks the measured contributions of the stored batch. A batch with
// no measured variable, or with measured variables that contributed nothing, says
// exactly that instead of ranking a zero.
func priorityBody(source Source) string {
	measured := measuredFactors(source.Factors)
	if len(measured) == 0 {
		return "Prioridad operativa: el lote no registra ninguna variable medida, así que la regla no tiene un aporte que ordenar."
	}
	total := totalContribution(measured)
	top := measured[0]
	if total == 0 {
		return "Prioridad operativa: el lote registra variables medidas pero ningún aporte distinto de cero, así que la regla no ordena una prioridad por aporte."
	}
	return fmt.Sprintf("Prioridad operativa: la variable medida con mayor aporte es %s, con aporte %s sobre un aporte total medido de %s.",
		factorLabel(top.Name), formatQuantity(*top.Contribution), formatQuantity(total))
}

// trendBody compares two consecutive publications, or declares that there is no
// second publication to compare. It never presents one publication as a series.
func trendBody(previous *Source) string {
	if previous == nil {
		return "Tendencia entre publicaciones: no hay una publicación anterior registrada para esta comuna, así que no hay una segunda publicación que comparar y no se informa ninguna tendencia."
	}
	return fmt.Sprintf("Tendencia entre publicaciones: la publicación anterior, lote %s del %s, registró nivel %s. Son dos publicaciones consecutivas: describen lo que cada lote registró y no una serie temporal.",
		previous.BatchID, formatInstant(previous.PublishedAt), levelLabel(previous.RiskLevel))
}

// recommendationsBody names the variables that contributed the most and points at
// the written catalogue that composes the suggestions in the zone card. It does not
// repeat that catalogue here: PM-18 is its only source, and a second copy would be
// the duplicated datum this project keeps correcting.
func recommendationsBody(source Source) string {
	const tail = "La lista de acciones se compone en la ficha de zona desde el catálogo escrito de recomendaciones. Este asistente no crea acciones, no envía notificaciones y no publica nada."
	measured := measuredFactors(source.Factors)
	contributing := make([]CitedFactor, 0, len(measured))
	for _, factor := range measured {
		if factor.Contribution != nil && *factor.Contribution > 0 {
			contributing = append(contributing, factor)
		}
	}
	if len(contributing) == 0 {
		return "Recomendaciones preventivas: el lote no registra aportes medidos, así que la sugerencia se apoya solo en el nivel registrado. " + tail
	}
	if len(contributing) > 3 {
		contributing = contributing[:3]
	}
	listed := make([]string, 0, len(contributing))
	for _, factor := range contributing {
		listed = append(listed, fmt.Sprintf("%s con aporte %s", factorLabel(factor.Name), formatQuantity(*factor.Contribution)))
	}
	return fmt.Sprintf("Recomendaciones preventivas: las variables que más aportaron fueron %s. %s", joinSpanish(listed), tail)
}

// sourcesBody states the provenance of the answer from the batch itself.
func sourcesBody(source Source) string {
	mark := "no declarada"
	if source.Synthetic {
		mark = "declarada"
	}
	return fmt.Sprintf("Fuentes y trazabilidad: publicado el %s, vigente hasta el %s, versión de la regla %s. Marca sintética del lote: %s. La respuesta se compone localmente desde ese lote publicado, sin consultar ninguna fuente externa ni ningún proveedor de lenguaje.",
		formatInstant(source.PublishedAt), formatInstant(source.ValidUntil), source.ModelVersion, mark)
}

// citedFactors projects the stored variables onto the five canonical ones, in the
// rule's order. A canonical variable the batch did not record, or recorded as
// unknown, is cited without a value and without a contribution.
func citedFactors(stored []classify.Factor) []CitedFactor {
	byName := make(map[string]classify.Factor, len(stored))
	for _, factor := range stored {
		byName[factor.Name] = factor
	}
	cited := make([]CitedFactor, 0, len(observations.VariableNames()))
	for _, name := range observations.VariableNames() {
		factor, recorded := byName[name]
		if !recorded || !factor.Known {
			cited = append(cited, CitedFactor{Name: name, Known: false})
			continue
		}
		value, contribution := factor.Value, factor.Contribution
		cited = append(cited, CitedFactor{Name: name, Known: true, Value: &value, Contribution: &contribution})
	}
	return cited
}

// measuredFactors returns the measured canonical variables, ordered by contribution
// descending with ties broken by the canonical order. The ordering is total, so a
// ranking never depends on map iteration.
func measuredFactors(stored []classify.Factor) []CitedFactor {
	cited := citedFactors(stored)
	canonicalIndex := make(map[string]int, len(cited))
	for index, factor := range cited {
		canonicalIndex[factor.Name] = index
	}
	measured := make([]CitedFactor, 0, len(cited))
	for _, factor := range cited {
		if factor.Known && factor.Value != nil && factor.Contribution != nil {
			measured = append(measured, factor)
		}
	}
	sort.SliceStable(measured, func(i, j int) bool {
		return *measured[i].Contribution > *measured[j].Contribution
	})
	return measured
}

// totalContribution sums the measured contributions. The boolean is false when
// there is nothing to sum, which is what keeps a total from being reported as zero
// for a batch with no readings.
func totalContribution(measured []CitedFactor) float64 {
	total := 0.0
	for _, factor := range measured {
		if factor.Contribution != nil {
			total += *factor.Contribution
		}
	}
	return total
}

// levelLabel renders the stored level. A level outside the three severities is
// named as undetermined and quoted as stored, so it can never be read as a
// severity the batch did not record.
func levelLabel(level string) string {
	if classified(level) {
		return level
	}
	return "no determinado (" + level + ")"
}

// classified reports whether level is one of the three severities the rule can
// publish. "desconocido" is deliberately not one of them.
func classified(level string) bool {
	return level == "bajo" || level == "medio" || level == "alto"
}

// factorLabel is the prose spelling of a canonical variable.
func factorLabel(name string) string {
	if label, ok := factorLabels[name]; ok {
		return label
	}
	return name
}

// joinSpanish joins items with commas and the last one with "y".
func joinSpanish(items []string) string {
	switch len(items) {
	case 0:
		return ""
	case 1:
		return items[0]
	}
	return strings.Join(items[:len(items)-1], ", ") + " y " + items[len(items)-1]
}

// formatQuantity renders a measured number with every significant digit it holds.
//
// It used to fix the scale at two decimals, which silently rounded the measurement:
// 0.125 came out as "0.12" and 18.375 as "18.38", so the text stated a magnitude the
// batch never recorded. GRD-I2 formats through this same function, so a fixed scale
// also made the rounded text verify against itself and no reader could notice. The
// shortest exact representation is what keeps the answer tied to the batch.
func formatQuantity(value float64) string {
	return strconv.FormatFloat(value, 'f', -1, 64)
}

// formatInstant renders an instant in UTC and RFC 3339, so the citation of a
// publication instant is stable across machines and time zones.
func formatInstant(instant time.Time) string {
	return instant.UTC().Format(time.RFC3339)
}
