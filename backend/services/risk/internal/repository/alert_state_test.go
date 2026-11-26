package repository

import (
	"context"
	"regexp"
	"strings"
	"testing"
)

// subjectDigestPattern is the shape the schema accepts for one stored subject
// key: a lower-case SHA-256 hex digest. It is written here independently of the
// migration so the Go derivation and the SQL CHECK are pinned against the same
// literal instead of against each other's implementation.
var subjectDigestPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// TestAlertStateSubjectKeyIsAStableOpaqueDigest pins the privacy property of the
// actor reference: the verified token subject is never stored or served as it
// arrived, and the same subject always derives the same key, which is what makes
// two requests from one person the same personal state.
func TestAlertStateSubjectKeyIsAStableOpaqueDigest(t *testing.T) {
	const subject = "encargado@example.test"
	key := AlertStateSubjectKey(subject)
	if !subjectDigestPattern.MatchString(key) {
		t.Fatalf("subject key %q is not a lower-case SHA-256 digest", key)
	}
	if strings.Contains(key, subject) || strings.Contains(key, "encargado") {
		t.Fatalf("subject key %q carries the raw subject", key)
	}
	if again := AlertStateSubjectKey(subject); again != key {
		t.Fatalf("the same subject derived %q then %q", key, again)
	}
	if other := AlertStateSubjectKey("otro@example.test"); other == key {
		t.Fatal("two different subjects derived the same key, so their marks would collide")
	}
	if empty := AlertStateSubjectKey(""); empty != AlertStateSubjectKey("") {
		t.Fatal("the empty subject derivation is not deterministic")
	}
}

// TestAlertMarkVocabularyIsMonotonic pins the state machine the store enforces:
// unread is the absence of a mark, and the two appendable marks increase strictly
// read -> dismissed so "dismissed dominates" is a property of the vocabulary and
// not of whichever row happened to be written last.
func TestAlertMarkVocabularyIsMonotonic(t *testing.T) {
	if AlertMarkRead.Valid() == false || AlertMarkDismissed.Valid() == false {
		t.Fatal("a documented mark is not valid")
	}
	for _, invalid := range []AlertMark{"", "unread", "READ", "dismissed ", "unknown"} {
		if invalid.Valid() {
			t.Errorf("mark %q is accepted; only read and dismissed are appendable", invalid)
		}
	}
	if AlertMarkRead.Rank() >= AlertMarkDismissed.Rank() {
		t.Fatalf("read ranks %d and dismissed ranks %d; dismissed must dominate", AlertMarkRead.Rank(), AlertMarkDismissed.Rank())
	}
	if AlertMark("unread").Rank() != 0 {
		t.Fatalf("unread ranks %d, want 0 so it is below every appendable mark", AlertMark("unread").Rank())
	}
}

// TestMarkAlertStateRefusesAnUnknownMarkBeforeStorage uses a store with no pool:
// an invalid mark has to be refused by the vocabulary, before any connection is
// taken. A nil pool would panic if the method touched storage first.
func TestMarkAlertStateRefusesAnUnknownMarkBeforeStorage(t *testing.T) {
	for _, mark := range []AlertMark{"unread", "READ", ""} {
		if _, err := (Store{}).MarkAlertState(context.Background(), "8f14e45f-ceea-467a-9c3f-1d2b4c1b0a11", AlertStateSubjectKey("subject"), mark); err != ErrUnknownAlertMark {
			t.Errorf("MarkAlertState(%q) returned %v, want ErrUnknownAlertMark", mark, err)
		}
	}
}

// TestAlertStateStatementsAreBoundedAndParameterised guards the two properties a
// reviewer cannot see by reading the handler: the read is one statement scoped by
// the alert and the subject key, and the write serialises the pair with an
// advisory lock before it decides whether to append. None of the caller's values
// is interpolated into SQL text.
func TestAlertStateStatementsAreBoundedAndParameterised(t *testing.T) {
	for _, fragment := range []string{"WHERE a.id = $1", "subject_key = $2", "LIMIT 1", "risk_alerts a"} {
		if !strings.Contains(alertStateReadSQL, fragment) {
			t.Errorf("the state read does not contain %q: %s", fragment, alertStateReadSQL)
		}
	}
	if strings.Contains(alertStateReadSQL, "risk_alert_state ") && !strings.Contains(alertStateReadSQL, "LEFT JOIN LATERAL") {
		t.Error("the state read does not join the append-only marks to the alert it addresses")
	}
	if !strings.Contains(alertStateLockSQL, "pg_advisory_xact_lock") || !strings.Contains(alertStateLockSQL, "hashtext($1::text)") || !strings.Contains(alertStateLockSQL, "hashtext($2::text)") {
		t.Errorf("the write does not serialise the (alert, subject) pair: %s", alertStateLockSQL)
	}
	for _, fragment := range []string{"INSERT INTO risk_alert_state", "VALUES ($1,$2,$3,$4, clock_timestamp())", "RETURNING marked_at"} {
		if !strings.Contains(alertStateInsertSQL, fragment) {
			t.Errorf("the append does not contain %q: %s", fragment, alertStateInsertSQL)
		}
	}
	// The rank order is defined once so the read path and the write path cannot
	// disagree about which mark wins.
	if !strings.Contains(alertStateRankOrder, "dismissed") || !strings.Contains(alertStateRankOrder, "read") {
		t.Errorf("the rank order does not name both marks: %s", alertStateRankOrder)
	}
}

// TestAlertStateAppendStampsTheAppendNotTheTransactionStart pins the clock the
// stored mark carries. The write waits on an advisory lock before it appends, so
// now()/transaction_timestamp() would record the instant the waiting transaction
// began - which can be older than the mark it is advancing past, and would make a
// later dismissal look earlier than the read it dominates. clock_timestamp() is
// evaluated when the INSERT runs, after the lock is granted, so the instant is
// the append's own. The no-op path inserts nothing and keeps the original one.
func TestAlertStateAppendStampsTheAppendNotTheTransactionStart(t *testing.T) {
	if strings.Contains(alertStateInsertSQL, "now()") {
		t.Errorf("the append still uses now(), which stamps the transaction start: %s", alertStateInsertSQL)
	}
	if !strings.Contains(alertStateInsertSQL, "clock_timestamp()") {
		t.Errorf("the append does not stamp the append instant with clock_timestamp(): %s", alertStateInsertSQL)
	}
}
