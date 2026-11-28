// Package explain is the PM-17 explanatory assistant: a local, fully
// deterministic composition over one published batch, guarded on the way in by
// GRD-I1 and on the way out by GRD-I2.
//
// Three properties are load-bearing and shape every file here:
//
//  1. There is no language model. The answer is a template rendered from the
//     published batch, so the same batch and the same topic always produce the
//     same bytes. Nothing in this package opens a connection, reads a clock or
//     calls another service.
//  2. GRD-I1 decides scope before anything is read: the zone must be one of the
//     38 catalogue communes, the topic must be one of five operational topics,
//     and a question may not carry injection, SQL, script or out-of-scope
//     instructions. It is a pure function, so it can be evaluated before the
//     handler touches storage.
//  3. GRD-I2 verifies the candidate against the source batch and fails closed.
//     Because the text is a pure function of the batch, the verifier can
//     recompose the expected answer and compare, which catches a hallucinated
//     figure that a blacklist of words would let through.
package explain

// Topic is the closed set of operational questions the assistant answers.
//
// The vocabulary is the owner's ratified list (GRD-I1) and it is deliberately
// narrow: every topic is answerable from one published batch, and no topic asks
// the system to explain a cause it never measured.
type Topic string

const (
	// TopicFactors explains how the rule reached the stored level, variable by
	// canonical variable.
	TopicFactors Topic = "FACTORES"
	// TopicPriority ranks the measured contributions of the stored batch.
	TopicPriority Topic = "PRIORIDAD"
	// TopicTrend compares the stored batch with the previous publication.
	TopicTrend Topic = "TENDENCIA"
	// TopicRecommendations names the level and the contributing variables and
	// points at the written catalogue that composes the suggestions.
	TopicRecommendations Topic = "RECOMENDACIONES"
	// TopicSources states the provenance of the answer: batch, instant, rule
	// version and synthetic mark.
	TopicSources Topic = "FUENTES"
)

// topics is the canonical order. It is a package-level slice rather than a map so
// the wire enum, the verifier and the UI cannot disagree about it.
var topics = []Topic{TopicFactors, TopicPriority, TopicTrend, TopicRecommendations, TopicSources}

// Topics returns the five accepted topics in canonical order. The slice is a copy,
// so a caller cannot mutate the shared vocabulary.
func Topics() []Topic {
	ordered := make([]Topic, len(topics))
	copy(ordered, topics)
	return ordered
}

// ParseTopic reports whether raw is one of the five accepted topics. The match is
// exact: a lowercase spelling or a padded one is a refusal, because a spelling the
// contract does not publish is not a topic this service answers.
func ParseTopic(raw string) (Topic, bool) {
	for _, topic := range topics {
		if string(topic) == raw {
			return topic, true
		}
	}
	return "", false
}
