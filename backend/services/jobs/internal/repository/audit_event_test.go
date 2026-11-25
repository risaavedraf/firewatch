package repository

import (
	"testing"
)

// TestAuditEventIDComesFromTheAuditIdentity pins the stable per-row identifier:
// it is derived from the audit table's own identity and never from the job or
// trace, so two events of the same job still have different, durable ids.
func TestAuditEventIDComesFromTheAuditIdentity(t *testing.T) {
	if got := auditEventID(42); got != "audit-42" {
		t.Fatalf("auditEventID(42)=%q want %q", got, "audit-42")
	}
	const jobID, traceID = "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"
	got := auditEventID(7)
	if got == jobID || got == traceID {
		t.Fatalf("event id %q reused a job or trace id", got)
	}
}

// TestAuditActorNameIsAbsentWhenNoVerifiedNameWasCaptured pins that an absent or
// blank verified name stays NULL. The store must never fall back to the subject
// or synthesize a display name from an opaque identifier.
func TestAuditActorNameIsAbsentWhenNoVerifiedNameWasCaptured(t *testing.T) {
	for _, tc := range []struct {
		name  string
		input string
		want  *string
	}{
		{"empty stays absent", "", nil},
		{"blank stays absent", "   ", nil},
		{"verified name is preserved", "Demo Admin", stringPtr("Demo Admin")},
		{"surrounding space is trimmed", "  Demo Admin  ", stringPtr("Demo Admin")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := auditActorName(tc.input)
			if (got == nil) != (tc.want == nil) || (got != nil && *got != *tc.want) {
				t.Fatalf("auditActorName(%q)=%v want %v", tc.input, got, tc.want)
			}
		})
	}
}

// TestAuditDetailsAreServerGeneratedAndFreeText pins the detail each mutation
// write generates. The text is server-owned; no caller-supplied field reaches
// it, and the zone/scenario/batch it quotes are validated first-party values.
func TestAuditDetailsAreServerGeneratedAndFreeText(t *testing.T) {
	for _, tc := range []struct {
		name string
		got  string
		want string
	}{
		{"legacy request", jobRequestedDetail("valparaiso-demo", ""), "Solicitud de trabajo para la zona valparaiso-demo"},
		{"scenario request", jobRequestedDetail("valparaiso-demo", "dry-windy"), "Solicitud de trabajo para la zona valparaiso-demo con escenario sintético dry-windy"},
		{"published batch", batchPublishedDetail("valparaiso-demo", "batch-7"), "Lote batch-7 publicado para la zona valparaiso-demo"},
		{"manual replay", replayDetail(), "Reenvío manual del trabajo a la cola de procesamiento"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.got != tc.want {
				t.Fatalf("detail=%q want %q", tc.got, tc.want)
			}
		})
	}
}

// TestAuditEventKindsAreTheClosedVocabulary pins the two kinds the database CHECK
// and the read contract share. A query is a recorded read, never a mutation.
func TestAuditEventKindsAreTheClosedVocabulary(t *testing.T) {
	kinds := AuditEventKinds()
	if len(kinds) != 2 || kinds[0] != AuditEventMutation || kinds[1] != AuditEventQuery {
		t.Fatalf("AuditEventKinds()=%v want [%q %q]", kinds, AuditEventMutation, AuditEventQuery)
	}
	if AuditEventMutation != "mutation" || AuditEventQuery != "query" {
		t.Fatalf("kinds=%q/%q want mutation/query", AuditEventMutation, AuditEventQuery)
	}
}
