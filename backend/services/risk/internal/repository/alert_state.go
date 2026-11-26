package repository

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// The three states of the personal notification resource, as the wire names them.
// Unread is the absence of a mark, not a stored value: it has no instant and no
// row of its own.
const (
	AlertStateUnread    = "unread"
	AlertStateRead      = "read"
	AlertStateDismissed = "dismissed"
)

// AlertMark is one state an admin may append for themselves. The vocabulary is
// closed: unread can never be applied, because it is the initial state rather than
// a mark, and an alert already marked cannot go back.
type AlertMark string

const (
	// AlertMarkRead records that the subject has seen the alert.
	AlertMarkRead AlertMark = AlertStateRead
	// AlertMarkDismissed records that the subject has dismissed the alert. It
	// dominates a read regardless of the order the two requests arrived in.
	AlertMarkDismissed AlertMark = AlertStateDismissed
)

// Valid reports whether the mark is one of the two appendable states. It keeps the
// handler and the store on one vocabulary instead of each comparing to its own
// literals.
func (m AlertMark) Valid() bool {
	return m == AlertMarkRead || m == AlertMarkDismissed
}

// Rank orders the marks monotonically. Unread ranks below both because it is the
// state before any mark, so the writer can compare "where this request would put
// the alert" with "where it already is" without a second vocabulary.
func (m AlertMark) Rank() int {
	switch m {
	case AlertMarkRead:
		return 1
	case AlertMarkDismissed:
		return 2
	default:
		return 0
	}
}

// ErrAlertNotFound means the identifier names no stored alert. It is a
// deterministic answer about the timeline, not a storage failure, so the route can
// answer 404 instead of 503.
var ErrAlertNotFound = errors.New("alert not stored")

// ErrUnknownAlertMark means the requested mark is not in the two-literal
// vocabulary. It is refused before storage: an unknown state must never become a
// row, because a stored mark is what the trace consists of.
var ErrUnknownAlertMark = errors.New("unknown alert mark")

// AlertState is one subject's effective mark on one alert, as the personal
// resource serves it. It deliberately carries no actor: the subject is the
// verified token the request was already scoped by, and repeating it in the answer
// would expose an identity the caller did not ask for.
//
// MarkedAt is nil exactly when State is unread: unread is the absence of a mark,
// so there is no instant to report and none is invented.
type AlertState struct {
	AlertID  string
	State    string
	MarkedAt *time.Time
}

// AlertStateSubjectKey derives the storage key of one verified token subject.
//
// It is a SHA-256 digest, not the subject itself: the key has to be stable so the
// same person's two requests address the same personal state, and it has to be
// opaque so the raw identity is neither stored nor served. An unkeyed digest is a
// pseudonym rather than anonymity - a very low-entropy subject could be guessed -
// so this is a data-minimisation measure, not a claim that the subject is secret.
//
// There is deliberately no API that accepts an already-derived key from a client:
// the only caller is the handler, which reads the subject from the verified bearer
// token.
func AlertStateSubjectKey(subject string) string {
	digest := sha256.Sum256([]byte(subject))
	return hex.EncodeToString(digest[:])
}

// alertStateRankOrder is the single definition of which stored mark wins. Dismissed
// dominates read, and the instant is the tie-break a later vocabulary extension
// would need. Both the read and the write's current-state check use this fragment,
// so the two paths cannot disagree about the effective mark.
const alertStateRankOrder = `CASE state WHEN 'dismissed' THEN 2 WHEN 'read' THEN 1 ELSE 0 END`

// alertStateReadSQL answers one personal read in a single statement. The alert is
// the left side, so an identifier that names no stored alert is distinguishable
// from an alert this subject never marked: the former returns no row, the latter
// returns a row with null mark columns.
const alertStateReadSQL = `SELECT s.state, s.marked_at
	FROM risk_alerts a
	LEFT JOIN LATERAL (
		SELECT state, marked_at
		FROM risk_alert_state
		WHERE alert_id = a.id AND subject_key = $2
		ORDER BY ` + alertStateRankOrder + ` DESC, marked_at DESC
		LIMIT 1
	) s ON true
	WHERE a.id = $1`

// alertStateCurrentSQL is the write path's current-mark read inside the calling
// transaction. It is deliberately the same ordering rule as alertStateReadSQL.
const alertStateCurrentSQL = `SELECT state, marked_at
	FROM risk_alert_state
	WHERE alert_id=$1 AND subject_key=$2
	ORDER BY ` + alertStateRankOrder + ` DESC, marked_at DESC
	LIMIT 1`

// alertStateLockSQL serialises the marks of one (alert, subject) pair inside the
// calling transaction.
//
// The lock is transaction-scoped, so it is released by the commit or the rollback
// and needs no cleanup. Without it, two concurrent requests could both read "no
// mark" and both append, which would invent a second event and a second instant.
// The key is the pair itself, so different subjects never wait on each other.
// Hashes are used because the advisory lock takes integers; a collision only makes
// two unrelated pairs wait in turn, never produces a wrong answer.
const alertStateLockSQL = `SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))`

// alertStateInsertSQL appends one mark and returns the instant the append itself
// happened. clock_timestamp() is evaluated when this statement runs, which is
// after the advisory lock above has been granted; now()/transaction_timestamp()
// would record the instant the waiting transaction began, so a mark that waited
// for the lock could be stamped earlier than the mark it is advancing past. The
// no-op path never reaches this statement, which is what preserves the original
// instant on a replay. The instant is never taken from the client: a request that
// could name its own time could rewrite the trace.
const alertStateInsertSQL = `INSERT INTO risk_alert_state(id, alert_id, subject_key, state, marked_at)
	VALUES ($1,$2,$3,$4, clock_timestamp())
	RETURNING marked_at`

// ReadAlertState reads one subject's effective mark on one alert.
//
// An alert with no mark of this subject is unread with a nil instant, and that is
// a valid answer rather than an error. Only an identifier that names no stored
// alert is ErrAlertNotFound.
func (s Store) ReadAlertState(ctx context.Context, alertID, subjectKey string) (AlertState, error) {
	var state *string
	var markedAt *time.Time
	err := s.DB.QueryRow(ctx, alertStateReadSQL, alertID, subjectKey).Scan(&state, &markedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return AlertState{}, ErrAlertNotFound
	}
	if err != nil {
		return AlertState{}, err
	}
	if state == nil {
		return AlertState{AlertID: alertID, State: AlertStateUnread}, nil
	}
	if markedAt == nil {
		// The schema stores both columns as NOT NULL, so this can only be a
		// projection defect. Fail closed instead of serving a mark with no instant.
		return AlertState{}, errors.New("stored alert mark carries no instant")
	}
	instant := markedAt.UTC()
	return AlertState{AlertID: alertID, State: *state, MarkedAt: &instant}, nil
}

// MarkAlertState applies one mark to one subject's state on one alert.
//
// The write is a no-op when the requested mark does not advance the state: a
// replay of the effective mark, or a read after a dismissal, appends nothing and
// returns the state that is actually stored, including its original instant. That
// is why the route answers 200 for both "applied" and "already there" instead of
// 409: the caller asked for a state and that state holds, so there is nothing to
// conflict with.
//
// The whole decision runs in one transaction: the pair is serialised with an
// advisory lock, the current effective mark is read, and only a strictly higher
// mark is appended. Concurrent read and dismissed requests therefore commit one
// dismissal with one instant, never a last-writer-wins read.
func (s Store) MarkAlertState(ctx context.Context, alertID, subjectKey string, mark AlertMark) (AlertState, error) {
	if !mark.Valid() {
		return AlertState{}, ErrUnknownAlertMark
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return AlertState{}, err
	}
	defer func() {
		// A committed transaction ignores this rollback; an early return releases
		// the advisory lock and leaves no partial state.
		_ = tx.Rollback(ctx)
	}()

	// The alert has to exist before a mark of it can exist. This is checked before
	// the lock so an identifier nobody stored never holds a key.
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM risk_alerts WHERE id = $1)`, alertID).Scan(&exists); err != nil {
		return AlertState{}, err
	}
	if !exists {
		return AlertState{}, ErrAlertNotFound
	}
	if _, err := tx.Exec(ctx, alertStateLockSQL, alertID, subjectKey); err != nil {
		return AlertState{}, err
	}
	current, err := readAlertStateTx(ctx, tx, alertID, subjectKey)
	if err != nil {
		return AlertState{}, err
	}
	if current.State != AlertStateUnread && AlertMark(current.State).Rank() >= mark.Rank() {
		if err := tx.Commit(ctx); err != nil {
			return AlertState{}, err
		}
		return current, nil
	}
	var markedAt time.Time
	if err := tx.QueryRow(ctx, alertStateInsertSQL, uuid.NewString(), alertID, subjectKey, string(mark)).Scan(&markedAt); err != nil {
		return AlertState{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AlertState{}, err
	}
	instant := markedAt.UTC()
	return AlertState{AlertID: alertID, State: string(mark), MarkedAt: &instant}, nil
}

// readAlertStateTx is the write path's effective-mark read. No row is unread.
func readAlertStateTx(ctx context.Context, tx pgx.Tx, alertID, subjectKey string) (AlertState, error) {
	var state string
	var markedAt time.Time
	err := tx.QueryRow(ctx, alertStateCurrentSQL, alertID, subjectKey).Scan(&state, &markedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return AlertState{AlertID: alertID, State: AlertStateUnread}, nil
	}
	if err != nil {
		return AlertState{}, err
	}
	instant := markedAt.UTC()
	return AlertState{AlertID: alertID, State: state, MarkedAt: &instant}, nil
}
