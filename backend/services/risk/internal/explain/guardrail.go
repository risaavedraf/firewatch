package explain

import (
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	// MaxQuestionRunes bounds the optional question, counted in runes. Counting
	// bytes would refuse a Spanish question for the width of its accents, which is
	// not the bound the owner ratified.
	MaxQuestionRunes = 500
	// CodeInputRejected is the stable machine-readable code every GRD-I1 refusal
	// carries. It is answered 422 by the route.
	CodeInputRejected = "GUARDRAIL_INPUT_REJECTED"
	// NoReading is the literal an answer uses for a canonical variable the batch
	// did not measure. It is never rendered as a zero.
	NoReading = "sin lectura"
)

// Input is the guarded request document. The question is optional: the ratified
// interface answers a topic with no free text, and a provided question must still
// pass every check below.
type Input struct {
	ZoneID   string
	Topic    Topic
	Question string
	// QuestionSet records that the question member was present in the document. It is
	// tracked apart from Question so the two states stay distinct: an absent member is
	// the documented "answer the topic" request, while a present but empty member is a
	// half-written request that is refused instead of being read as absent.
	QuestionSet bool
}

// Rejection is a GRD-I1 refusal. It names the field and the rule so the caller can
// tell a scope refusal from a malformed document, which is a 400 decided before
// this type is built.
type Rejection struct {
	Field string
	Rule  string
}

// Error renders the refusal with its stable code, so a log line or a test can
// recognise the guardrail without parsing prose.
func (r Rejection) Error() string {
	return fmt.Sprintf("%s: %s (%s)", CodeInputRejected, r.Rule, r.Field)
}

// asciiPatterns are matched against the lowercased question exactly as written.
// They are the injection, SQL/DDL and script families of GRD-I1. Every entry is
// spelled so a legitimate Spanish word cannot contain it: the SQL keywords carry
// their trailing space, which keeps "selecciona" and "borrador" out of reach.
var asciiPatterns = []string{
	// prompt injection and override
	"ignore previous",
	"ignore all",
	"system prompt",
	"jailbreak",
	"developer mode",
	// SQL and DDL
	"drop ",
	"select ",
	"union ",
	"insert ",
	"delete ",
	"--",
	";",
	// script and HTML injection
	"<script",
	"javascript:",
	"onerror=",
}

// foldedPatterns are the out-of-scope requests: the causes of ignition this system
// does not measure and the operational commands this service is not allowed to
// perform. They are matched against the accent-folded question, so "ignición" and
// "ignicion" are the same refusal.
var foldedPatterns = []string{
	"ignicion",
	"causa del incendio",
	"origen del incendio",
	"que provoco el incendio",
	"quien provoco el incendio",
	"publica el lote",
	"publicar el lote",
	"publicar lote",
	"ejecuta el ciclo",
	"ejecutar el ciclo",
	"corre el ciclo",
	"activa el modelo",
	"activar el modelo",
	"borra el lote",
	"elimina el lote",
	"eliminar el lote",
}

// liveTimePatterns is the input-only temporal family of GRD-I1: live time and
// forecast.
//
// The assistant explains the reading a published batch recorded at its own cutoff.
// It does not read live weather and cannot forecast, so "today", "now", "actual"
// and the coming week ask for a reading no batch contains and for a prediction this
// service does not produce.
//
// It is deliberately NOT part of foldedPatterns. That list is shared with GRD-I2,
// which scans the composed answer, and putting these words there made the guardrail
// refuse the composer's own prose: `compose.go` could not say what an answer does
// not predict without tripping the output check. Keeping the temporal family
// input-only is what makes the two lists independent, so a word may be refused in a
// question and still be the honest thing for an answer to deny.
var liveTimePatterns = []string{
	"actual",
	"ahora",
	"hoy",
	"manana",
	"ayer",
	"en vivo",
	"tiempo real",
	"este momento",
	"pronostico",
	"prediccion",
	"hara",
	"llover",
	"clima",
	"el tiempo",
	// Kept from the previous revision so "the coming week" stays refused even though
	// neither "manana" nor "hara" appears in it.
	"proxima semana",
}

// liveTimeOrForecast reports the first live-time or forecast term the folded
// question carries. It is evaluated by GRD-I1 only.
func liveTimeOrForecast(foldedQuestion string) (string, bool) {
	for _, pattern := range liveTimePatterns {
		if strings.Contains(foldedQuestion, pattern) {
			return pattern, true
		}
	}
	return "", false
}

// accents folds the Spanish accented letters onto their ASCII base so the
// out-of-scope vocabulary cannot be bypassed by dropping a diacritic.
var accents = strings.NewReplacer(
	"á", "a", "à", "a", "ä", "a", "â", "a", "ã", "a",
	"é", "e", "è", "e", "ë", "e", "ê", "e",
	"í", "i", "ì", "i", "ï", "i", "î", "i",
	"ó", "o", "ò", "o", "ö", "o", "ô", "o", "õ", "o",
	"ú", "u", "ù", "u", "ü", "u", "û", "u",
	"ñ", "n", "ç", "c",
)

// fold lowercases a text and strips its diacritics, so every vocabulary below is
// matched against one canonical spelling.
func fold(text string) string {
	return accents.Replace(strings.ToLower(text))
}

// topicKeywords is the positive half of GRD-I1: the vocabulary of each operational
// topic.
//
// The denylist alone was not enough. It decides what a caller may not say, so an
// unrelated sentence - "¿Cuál es la capital de Chile?" - carried no forbidden
// pattern, passed the guardrail, reached storage and was answered with a template
// that had nothing to do with the question. A positive list turns the guard around:
// a provided question must address the topic it selected, and a sentence about
// another subject is refused before anything is read.
//
// The entries are stems, not whole words, because Spanish inflects: "calcul" covers
// «cálculo» and «calculó», "preventiv" covers «preventiva» and «preventivas», "baj"
// covers «bajó» and «baja». The lists are scoped per topic on purpose, so a keyword
// of one topic does not admit a question about another.
var topicKeywords = map[Topic][]string{
	TopicFactors: {
		"factor", "variable", "temperatura", "humedad", "viento",
		"incendios", "historicos", "cobertura", "vegetacion", "contribucion", "regla",
		"nivel", "riesgo", "puntaje", "calcul",
	},
	TopicPriority: {
		"prioridad", "orden", "ranking", "contexto", "infraestructura",
		"exposicion", "nivel", "riesgo", "lote",
	},
	TopicTrend: {
		"tendencia", "evolucion", "cambio", "anterior", "previo", "historial",
		"compar", "subi", "baj", "mantuvo", "nivel",
	},
	TopicRecommendations: {
		"recomendacion", "sugerencia", "medida", "preventiv", "accion", "mitig",
		"hacer", "corresponde",
	},
	TopicSources: {
		"fuente", "procedencia", "sintetic", "semilla", "corte", "cutoff",
		"frescura", "origen", "dato", "lectura",
	},
}

// ValidateInput is GRD-I1. It decides scope for one request and is a pure function
// of the catalogue and the document, so the route can call it before it reads any
// storage.
//
// The order is deliberate: the zone and the topic are the closed vocabularies, and
// the question is only inspected once the request is known to address a commune
// and a topic the service answers at all.
func ValidateInput(catalogue Catalogue, input Input) error {
	// A padded code is refused instead of trimmed: a trimmed code would be an
	// alias the catalogue does not hold, and the catalogue is the whole allowlist.
	if input.ZoneID == "" || input.ZoneID != strings.TrimSpace(input.ZoneID) {
		return Rejection{Field: "zone_id", Rule: "zone_empty_or_padded"}
	}
	if _, ok := catalogue.ZoneName(input.ZoneID); !ok {
		return Rejection{Field: "zone_id", Rule: "zone_outside_catalogue"}
	}
	if _, ok := ParseTopic(string(input.Topic)); !ok {
		return Rejection{Field: "topic", Rule: "topic_outside_enum"}
	}
	// An omitted question is the documented "answer the topic" request. A provided
	// one may not be blank: a blank field is a request the caller did not finish.
	if !input.QuestionSet && input.Question == "" {
		return nil
	}
	if strings.TrimSpace(input.Question) == "" {
		return Rejection{Field: "question", Rule: "question_empty"}
	}
	if utf8.RuneCountInString(input.Question) > MaxQuestionRunes {
		return Rejection{Field: "question", Rule: "question_too_long"}
	}
	if pattern, found := forbiddenScope(input.Question); found {
		return Rejection{Field: "question", Rule: "question_forbidden_pattern:" + pattern}
	}
	folded := fold(input.Question)
	tokens := wordTokens(input.Question)
	// The temporal family is decided next, and it is an input-only rule: the answer
	// describes a published batch at its recorded cutoff, so "today", "actual" or a
	// prediction ask for a reading no batch contains.
	if pattern, found := liveTimeOrForecast(folded); found {
		return Rejection{Field: "question", Rule: "question_live_or_forecast:" + pattern}
	}
	// Another catalogue commune in the question is another territory: the answer can
	// only be grounded on the batch of the zone that was asked about, so naming a
	// different commune is refused instead of being answered with this zone's data.
	if code, named := otherCommuneNamed(catalogue, input.ZoneID, folded); named {
		return Rejection{Field: "question", Rule: "question_other_commune:" + code}
	}
	// The five canonical factors are measured independently, so a property of one
	// inside another is a quantity this service does not hold.
	if mentionsUnmeasuredFactorCombination(tokens) {
		return Rejection{Field: "question", Rule: "question_unmeasured_factor_combination"}
	}
	// The closed vocabulary. A keyword allowlist let one approved word carry an
	// arbitrary subject, so the question is now judged by whether it contains any
	// word this system does not know.
	if token, unknown := unrecognizedToken(tokens, allowedQuestionWords(catalogue, input.ZoneID)); unknown {
		return Rejection{Field: "question", Rule: "question_unrecognized_term:" + token}
	}
	if !questionAddressesTopic(catalogue, input.ZoneID, input.Topic, tokens, folded) {
		return Rejection{Field: "question", Rule: "question_outside_topic"}
	}
	return nil
}

// factorFamilies maps the tokens that name a canonical variable onto the variable
// itself. Three of the five names are written with two words, so the second word has
// to belong to the family too: "cobertura", "vegetacion" and "vegetal" are one
// variable because the batch measures cobertura_vegetal, "relativa" continues
// "humedad", and "historicos" continues "incendios".
//
// The families are exactly the five variables contracts/gen/observations/v1 declares.
// A reading the batch does not carry as a canonical variable has no family here and
// no entry in the lexicon, so a question about it is refused instead of being
// answered with the nearest variable that does exist.
var factorFamilies = map[string]string{
	"temperatura": "temperatura",
	"humedad":     "humedad",
	"relativa":    "humedad",
	"viento":      "viento",
	"incendios":   "incendios",
	"historicos":  "incendios",
	"cobertura":   "cobertura",
	"vegetacion":  "cobertura",
	"vegetal":     "cobertura",
}

// factorConnectors and factorArticles are the grammatical pieces a question uses to
// link one noun to another. The connectors are every Spanish preposition a question
// can put between two readings, not just `de`/`del`: a property of one variable
// inside another is the same unmeasured quantity whichever word joins them.
var factorConnectors = map[string]bool{
	"de": true, "del": true, "en": true, "sobre": true, "bajo": true,
	"con": true, "sin": true, "por": true, "para": true, "entre": true,
	"a": true, "al": true,
}
var factorArticles = map[string]bool{
	"el": true, "la": true, "los": true, "las": true, "un": true, "una": true,
}

// mentionsUnmeasuredFactorCombination reports whether the question links one
// canonical factor to another: "<factorA> <preposition> [article] <factorB>", with
// the prepositions and articles factorConnectors and factorArticles hold.
//
// The batch measures the five variables independently and records no property of one
// inside another, so "temperatura de la vegetación" asks for a number that exists in
// no column. Answering it with either factor would be a silent substitution, which is
// exactly the class of invention GRD-I1 exists to stop.
//
// A canonical name may occupy two tokens, and the family is one unit: its own
// continuation is skipped before looking for the preposition. Without that,
// "humedad relativa en la vegetación" passed, because "relativa" sat between
// "humedad" and "en" and the search stopped at the first word. A coordinator is not
// a connector, so two readings joined by "y" stay two readings.
func mentionsUnmeasuredFactorCombination(tokens []string) bool {
	for index := 0; index < len(tokens); index++ {
		first, held := factorFamilies[tokens[index]]
		if !held {
			continue
		}
		cursor := index + 1
		for cursor < len(tokens) && factorFamilies[tokens[cursor]] == first {
			cursor++
		}
		if cursor >= len(tokens) || !factorConnectors[tokens[cursor]] {
			continue
		}
		cursor++
		for cursor < len(tokens) && factorArticles[tokens[cursor]] {
			cursor++
		}
		if cursor >= len(tokens) {
			continue
		}
		second, held := factorFamilies[tokens[cursor]]
		if held && second != first {
			return true
		}
	}
	return false
}

// questionAnchors are the words that tie a question to this system: the published
// batch, the commune, the rule, the reading behind it and its result. A topic
// keyword is not one of them, which is what refuses "¿Qué factor explica?": with no
// subject, there is nothing the answer could legitimately be about.
var questionAnchors = []string{
	"lote", "riesgo", "nivel", "regla", "comuna", "zona", "sector",
	"lectura", "corte", "cutoff", "evaluacion", "evalua", "prioridad",
	"ranking", "exposicion", "infraestructura", "tendencia", "historial",
	"recomendacion", "preventiva", "preventivas", "fuente", "fuentes",
	"procedencia", "semilla", "sintetico", "sintetica", "aport", "calcul",
	"contribucion", "puntaje", "publicad", "registr", "accion", "mitigacion",
}

// functionalWords is the closed class of Spanish interrogation, reference and
// reporting: the words that carry no subject of their own.
var functionalWords = []string{
	"que", "cual", "cuales", "como", "cuanto", "cuanta", "cuantos", "cuantas",
	"donde", "por", "para", "de", "del", "la", "el", "los", "las", "un", "una",
	"unos", "unas", "en", "es", "son", "fue", "fueron", "tiene", "tienen", "hay",
	"esta", "estan", "este", "estos", "estas", "ese", "esa", "se", "su", "sus",
	"al", "a", "o", "u", "y", "e", "con", "sin", "mas", "menos", "mayor", "menor",
	"sobre", "entre", "respecto", "segun", "explica", "explican", "explicame",
	"indica", "indican", "muestra", "muestran", "describe", "describen", "determina",
	"determinan", "afecta", "afectan", "influye", "influyen", "influyo", "dice",
	"dime", "detalle", "resumen",
}

// domainWords is the closed FireWatch vocabulary: the operational nouns the
// assistant answers about, the requests its topics name, and the verbs an operator
// uses to ask about a recorded reading.
var domainWords = []string{
	// the rule and its result
	"factor", "factores", "variable", "variables", "regla", "reglas", "nivel",
	"niveles", "riesgo", "riesgos", "puntaje", "puntajes", "calculo", "calculos",
	"contribucion", "contribuciones", "evaluacion", "evaluo", "evalua", "evaluar",
	"aporte", "aportes", "aporta", "aportan", "aporto", "aportaron", "pesa", "pesan",
	// the four published levels and D-B criticality: "¿por qué el nivel es alto?" is
	// the question this assistant exists to answer, so its own vocabulary cannot be
	// the thing that refuses it.
	"alto", "alta", "altos", "altas", "medio", "media", "medios", "medias",
	"desconocido", "desconocida", "desconocidos", "desconocidas", "critico", "critica",
	"criticos", "criticas",
	// the canonical variables, exactly as contracts/gen/observations/v1 declares them
	"temperatura", "humedad", "relativa", "viento", "incendios", "historicos",
	"cobertura", "vegetacion", "vegetal",
	// the publication and its provenance
	"lote", "lotes", "publicacion", "publicaciones", "publicado", "publicada",
	"publicados", "publicadas", "registro", "registros", "registra", "registran",
	"fuente", "fuentes", "procedencia", "origen", "semilla", "frescura", "corte",
	"cutoff", "sintetico", "sintetica", "sinteticos", "sinteticas", "dato", "datos",
	"lectura", "lecturas", "resultado", "resultados", "vigencia",
	// the territory
	"comuna", "comunas", "zona", "zonas", "sector", "sectores", "territorio",
	"prioridad", "prioridades", "ranking", "exposicion", "infraestructura", "contexto",
	// the temporal topics
	"tendencia", "tendencias", "evolucion", "evoluciono", "cambio", "cambios",
	"anterior", "anteriores", "previo", "previa", "historial", "compara", "comparacion",
	"subio", "sube", "mantuvo", "bajo", "baja", "ordena", "ordenan",
	// the preventive catalogue
	"recomendacion", "recomendaciones", "sugerencia", "sugerencias", "sugiere",
	"sugieren", "medida", "medidas", "preventivo", "preventiva", "preventivos",
	"preventivas", "accion", "acciones", "mitigacion", "mitigaciones", "aplica",
	"aplican", "corresponde", "corresponden",
	// asking about the record
	"usa", "usan", "uso", "viene", "vienen",
}

// lexicon is the closed vocabulary every word of a question must belong to.
//
// A keyword allowlist was satisfied by one matching substring while the rest of the
// sentence stayed free, so "¿Qué factor explica la fotosíntesis?" passed: it carried
// "factor", and the guardrail never looked at the subject. Closing the vocabulary
// turns that around. The question is not judged by whether it contains an approved
// word; it is judged by whether it contains any word this system does not know.
//
// The commune of the request is added per call, because a question may name the zone
// it is about. Nothing else is: an unknown token has no provenance, no meaning here
// and no way to be grounded on the batch, so it is refused.
var lexicon = buildLexicon(functionalWords, domainWords)

// buildLexicon folds the groups into one set.
func buildLexicon(groups ...[]string) map[string]bool {
	set := make(map[string]bool, 256)
	for _, group := range groups {
		for _, word := range group {
			set[word] = true
		}
	}
	return set
}

// wordTokens splits a question into folded word tokens. A token is a run of
// letters or digits; punctuation, the interrogative marks and whitespace separate
// them. Folding is applied per token, so an accent cannot smuggle a known word past
// the check.
func wordTokens(text string) []string {
	tokens := make([]string, 0, 16)
	var current strings.Builder
	flush := func() {
		if current.Len() == 0 {
			return
		}
		tokens = append(tokens, fold(current.String()))
		current.Reset()
	}
	for _, character := range text {
		if unicode.IsLetter(character) || unicode.IsDigit(character) {
			current.WriteRune(character)
			continue
		}
		flush()
	}
	flush()
	return tokens
}

// allowedQuestionWords is the lexicon plus the one commune the request asks about.
// A copy is made per call so a caller cannot widen the shared set.
func allowedQuestionWords(catalogue Catalogue, zoneID string) map[string]bool {
	allowed := make(map[string]bool, len(lexicon)+8)
	for word := range lexicon {
		allowed[word] = true
	}
	allowed[zoneID] = true
	if name, held := catalogue.ZoneName(zoneID); held {
		for _, token := range wordTokens(name) {
			allowed[token] = true
		}
	}
	return allowed
}

// unrecognizedToken reports the first word of the question the closed vocabulary
// does not hold. Token order is document order, so the refusal names the first word
// a reader would notice.
func unrecognizedToken(tokens []string, allowed map[string]bool) (string, bool) {
	for _, token := range tokens {
		if !allowed[token] {
			return token, true
		}
	}
	return "", false
}

// questionAddressesTopic reports whether the folded question addresses the topic it
// selected. Two things are required, and a keyword alone satisfies neither: the
// keyword says what is asked, the anchor says what it is asked about.
func questionAddressesTopic(catalogue Catalogue, zoneID string, topic Topic, tokens []string, foldedQuestion string) bool {
	if !mentionsAny(foldedQuestion, topicKeywords[topic]) {
		return false
	}
	if mentionsAny(foldedQuestion, questionAnchors) {
		return true
	}
	return questionNamesTheRequestedCommune(catalogue, zoneID, tokens)
}

// questionNamesTheRequestedCommune reports whether the question names the commune
// of the request, either by its exact CUT code or by its FULL name.
//
// A single word of the name is not enough, and that is not a detail. Several
// communes begin with the article or contain the preposition that Spanish questions
// use constantly - "La Ligua", "La Cruz", "La Calera", "El Quisco", "El Tabo",
// "Viña del Mar" - so matching one constituent word made "la", "el" and "del"
// anchors: "¿Cuál es la temperatura?" satisfied the anchor check on zone 05401 and
// reached storage. The name counts only when its words appear contiguously, in
// order, which is what naming a place means.
func questionNamesTheRequestedCommune(catalogue Catalogue, zoneID string, tokens []string) bool {
	for _, token := range tokens {
		if token == zoneID {
			return true
		}
	}
	name, held := catalogue.ZoneName(zoneID)
	if !held {
		return false
	}
	return containsTokenRun(tokens, wordTokens(name))
}

// containsTokenRun reports whether run appears inside tokens as a contiguous run.
// The comparison is per token, so punctuation and spacing between words do not
// matter and a word that merely shares a prefix does not match.
func containsTokenRun(tokens, run []string) bool {
	if len(run) == 0 || len(run) > len(tokens) {
		return false
	}
	for start := 0; start+len(run) <= len(tokens); start++ {
		matched := true
		for offset := range run {
			if tokens[start+offset] != run[offset] {
				matched = false
				break
			}
		}
		if matched {
			return true
		}
	}
	return false
}

// mentionsAny reports whether the text carries any of the literals.
func mentionsAny(text string, literals []string) bool {
	for _, literal := range literals {
		if strings.Contains(text, literal) {
			return true
		}
	}
	return false
}

// otherCommuneNamed reports the first catalogue commune, other than the requested
// one, that the folded question names - by its commune name or by its CUT code.
//
// The requested commune is skipped, so asking about the zone being explained stays
// in scope. Iteration follows the catalogue's own sorted codes, so which commune is
// reported first does not depend on map order.
func otherCommuneNamed(catalogue Catalogue, requestedZone, foldedQuestion string) (string, bool) {
	for _, code := range catalogue.codes {
		if code == requestedZone {
			continue
		}
		if strings.Contains(foldedQuestion, code) {
			return code, true
		}
		if name, held := catalogue.names[code]; held && strings.Contains(foldedQuestion, fold(name)) {
			return code, true
		}
	}
	return "", false
}

// forbiddenScope reports the first GRD-I1 pattern a text carries. It is shared by
// the input guardrail and the output guardrail on purpose: the phrases a caller may
// not ask for are the same phrases an answer may not assert, so the composed text
// cannot smuggle in an ignition cause or an operational command either.
func forbiddenScope(text string) (string, bool) {
	lowered := strings.ToLower(text)
	for _, pattern := range asciiPatterns {
		if strings.Contains(lowered, pattern) {
			return pattern, true
		}
	}
	folded := accents.Replace(lowered)
	for _, pattern := range foldedPatterns {
		if strings.Contains(folded, pattern) {
			return pattern, true
		}
	}
	return "", false
}
