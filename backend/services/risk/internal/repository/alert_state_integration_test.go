package repository

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// These tests exercise the personal state write against Postgres. They need the
// migrated disposable risk database the other integration tests use, so they skip
// without TEST_DATABASE_URL and a skip is not a pass. They are separate from the
// shadowed timeline reads on purpose: a mark is a real append into a real table
// with real grants, and shadowing it would prove nothing about either.
//
// Isolation is by subject, not by table: every test derives its subject key from a
// random subject, so rows an earlier run left behind can never be read or counted
// here. The alert rows come from the store's own publication path, which is the
// same path a real alert takes.

// alertStateFixtureAlert publishes one level transition through the store and
// returns the identifier of the alert it recorded. A transition (not the first
// assessment) is what PM-07 stores, so the fixture has to publish a baseline level
// first and then move away from it.
func alertStateFixtureAlert(ctx context.Context, t *testing.T, store Store) string {
	t.Helper()
	const zone = "valparaiso-demo"
	base := instantNewerThanEveryStoredBatch(ctx, t, store.DB, zone)
	_, _ = publishTestBatch(ctx, t, store, zone, base, "medio")
	_, transitionBatchID := publishTestBatch(ctx, t, store, zone, base.Add(time.Second), "alto")
	var alertID string
	if err := store.DB.QueryRow(ctx, `SELECT id::text FROM risk_alerts WHERE batch_id=$1`, transitionBatchID).Scan(&alertID); err != nil {
		t.Fatalf("read the alert of the transition batch: %v", err)
	}
	return alertID
}

// assertAlertState reads one personal state and fails unless it is exactly the
// expected state, with no instant when unread.
func assertAlertState(t *testing.T, ctx context.Context, store Store, alertID, subjectKey, wantState string, wantAt *time.Time) AlertState {
	t.Helper()
	state, err := store.ReadAlertState(ctx, alertID, subjectKey)
	if err != nil {
		t.Fatalf("ReadAlertState(%s, %s): %v", alertID, subjectKey, err)
	}
	if state.AlertID != alertID || state.State != wantState {
		t.Fatalf("state = %+v, want alert %s state %q", state, alertID, wantState)
	}
	if wantAt == nil {
		if state.MarkedAt != nil {
			t.Fatalf("state %q carries instant %v, want null", wantState, state.MarkedAt)
		}
		return state
	}
	if state.MarkedAt == nil || !state.MarkedAt.Equal(*wantAt) {
		t.Fatalf("state %q carries instant %v, want %s", wantState, state.MarkedAt, wantAt)
	}
	return state
}

// stateRowCounts returns how many read and dismissed rows one (alert, subject)
// pair holds. It is the append-only evidence no handler test can produce: a replay
// must leave the count where it was, and a dismissed mark must be written at most
// once.
func stateRowCounts(t *testing.T, ctx context.Context, store Store, alertID, subjectKey string) (int, int) {
	t.Helper()
	var read, dismissed int
	if err := store.DB.QueryRow(ctx, `SELECT count(*) FILTER (WHERE state='read'), count(*) FILTER (WHERE state='dismissed')
		FROM risk_alert_state WHERE alert_id=$1 AND subject_key=$2`, alertID, subjectKey).Scan(&read, &dismissed); err != nil {
		t.Fatalf("count the marks of one subject: %v", err)
	}
	return read, dismissed
}

// TestAlertStateMarksAreIsolatedPerSubject is the storage-side actor isolation
// property: two subjects marking the same alert never observe or change each
// other's state, and an alert with no mark of the subject is unread without an
// instant.
func TestAlertStateMarksAreIsolatedPerSubject(t *testing.T) {
	ctx, db := alertTestPool(t)
	store := Store{DB: db}
	alertID := alertStateFixtureAlert(ctx, t, store)
	first := AlertStateSubjectKey("alice-" + uuid.NewString())
	second := AlertStateSubjectKey("bob-" + uuid.NewString())

	assertAlertState(t, ctx, store, alertID, first, AlertStateUnread, nil)

	read, err := store.MarkAlertState(ctx, alertID, first, AlertMarkRead)
	if err != nil {
		t.Fatalf("MarkAlertState(read): %v", err)
	}
	if read.State != AlertStateRead || read.MarkedAt == nil {
		t.Fatalf("read mark = %+v, want read with an instant", read)
	}
	// The other subject's view is untouched by the first subject's mark.
	assertAlertState(t, ctx, store, alertID, second, AlertStateUnread, nil)

	dismissed, err := store.MarkAlertState(ctx, alertID, second, AlertMarkDismissed)
	if err != nil {
		t.Fatalf("MarkAlertState(dismissed): %v", err)
	}
	if dismissed.State != AlertStateDismissed || dismissed.MarkedAt == nil {
		t.Fatalf("dismissed mark = %+v, want dismissed with an instant", dismissed)
	}

	// Both views are unchanged by the other's write.
	assertAlertState(t, ctx, store, alertID, first, AlertStateRead, read.MarkedAt)
	assertAlertState(t, ctx, store, alertID, second, AlertStateDismissed, dismissed.MarkedAt)
	if readRows, dismissedRows := stateRowCounts(t, ctx, store, alertID, first); readRows != 1 || dismissedRows != 0 {
		t.Fatalf("first subject rows = read %d dismissed %d, want 1 and 0", readRows, dismissedRows)
	}
	if readRows, dismissedRows := stateRowCounts(t, ctx, store, alertID, second); readRows != 0 || dismissedRows != 1 {
		t.Fatalf("second subject rows = read %d dismissed %d, want 0 and 1", readRows, dismissedRows)
	}
}

// TestAlertStateMarksAppendOnlyWhenTheyAdvance is the monotonic contract on real
// rows: read -> dismissed advances once, a replay of the effective mark appends
// nothing and keeps the instant, and a lower mark after a dismissal is a no-op
// that returns the dominating state.
func TestAlertStateMarksAppendOnlyWhenTheyAdvance(t *testing.T) {
	ctx, db := alertTestPool(t)
	store := Store{DB: db}
	alertID := alertStateFixtureAlert(ctx, t, store)
	subjectKey := AlertStateSubjectKey("monotonic-" + uuid.NewString())

	first, err := store.MarkAlertState(ctx, alertID, subjectKey, AlertMarkRead)
	if err != nil {
		t.Fatalf("first read mark: %v", err)
	}
	if readRows, dismissedRows := stateRowCounts(t, ctx, store, alertID, subjectKey); readRows != 1 || dismissedRows != 0 {
		t.Fatalf("after the first mark rows = read %d dismissed %d, want 1 and 0", readRows, dismissedRows)
	}

	replay, err := store.MarkAlertState(ctx, alertID, subjectKey, AlertMarkRead)
	if err != nil {
		t.Fatalf("read replay: %v", err)
	}
	if replay.MarkedAt == nil || first.MarkedAt == nil || !replay.MarkedAt.Equal(*first.MarkedAt) {
		t.Fatalf("read replay changed the instant: %v then %v", first.MarkedAt, replay.MarkedAt)
	}
	if readRows, _ := stateRowCounts(t, ctx, store, alertID, subjectKey); readRows != 1 {
		t.Fatalf("read replay appended a second row: read rows = %d", readRows)
	}

	dismissed, err := store.MarkAlertState(ctx, alertID, subjectKey, AlertMarkDismissed)
	if err != nil {
		t.Fatalf("dismissed mark: %v", err)
	}
	if dismissed.State != AlertStateDismissed || dismissed.MarkedAt == nil {
		t.Fatalf("dismissed = %+v, want dismissed with an instant", dismissed)
	}
	if dismissed.MarkedAt.Before(*first.MarkedAt) {
		t.Errorf("dismissed instant %s precedes the read instant %s", dismissed.MarkedAt, first.MarkedAt)
	}

	// A read after the dismissal is accepted but appends nothing: dismissed
	// dominates whatever the order of the two requests was.
	lower, err := store.MarkAlertState(ctx, alertID, subjectKey, AlertMarkRead)
	if err != nil {
		t.Fatalf("read after dismissed: %v", err)
	}
	if lower.State != AlertStateDismissed {
		t.Fatalf("read after dismissed answered %q, want dismissed", lower.State)
	}
	if lower.MarkedAt == nil || !lower.MarkedAt.Equal(*dismissed.MarkedAt) {
		t.Fatalf("read after dismissed rewrote the instant: %v then %v", dismissed.MarkedAt, lower.MarkedAt)
	}
	if readRows, dismissedRows := stateRowCounts(t, ctx, store, alertID, subjectKey); readRows != 1 || dismissedRows != 1 {
		t.Fatalf("after the lower mark rows = read %d dismissed %d, want 1 and 1", readRows, dismissedRows)
	}

	// The dismissed replay is the same answer again, with the same instant.
	again, err := store.MarkAlertState(ctx, alertID, subjectKey, AlertMarkDismissed)
	if err != nil {
		t.Fatalf("dismissed replay: %v", err)
	}
	if again.MarkedAt == nil || !again.MarkedAt.Equal(*dismissed.MarkedAt) {
		t.Fatalf("dismissed replay changed the instant: %v then %v", dismissed.MarkedAt, again.MarkedAt)
	}
	if _, dismissedRows := stateRowCounts(t, ctx, store, alertID, subjectKey); dismissedRows != 1 {
		t.Fatalf("dismissed replay appended a row: dismissed rows = %d", dismissedRows)
	}
}

// TestAlertStateMarkStampsTheAppendAfterTheLock is the deterministic proof that
// the stored instant is the append's own and not the transaction's start. It
// holds the pair's advisory lock in one transaction while a mark begins and
// blocks, then releases the lock and checks that the mark was stamped at or after
// the release. now()/transaction_timestamp() would carry the instant the blocked
// mark began its transaction, before the release; clock_timestamp() is evaluated
// after the lock is granted. The replay then has to keep that same instant.
func TestAlertStateMarkStampsTheAppendAfterTheLock(t *testing.T) {
	ctx, db := alertTestPool(t)
	store := Store{DB: db}
	alertID := alertStateFixtureAlert(ctx, t, store)
	subjectKey := AlertStateSubjectKey("append-instant-" + uuid.NewString())

	holder, err := db.Begin(ctx)
	if err != nil {
		t.Fatalf("begin the lock-holding transaction: %v", err)
	}
	defer func() {
		// The explicit rollback below is the real release; this one makes an early
		// failure release the lock too and is a no-op after a committed rollback.
		_ = holder.Rollback(ctx)
	}()
	if _, err := holder.Exec(ctx, alertStateLockSQL, alertID, subjectKey); err != nil {
		t.Fatalf("take the pair's advisory lock: %v", err)
	}

	type outcome struct {
		state AlertState
		err   error
	}
	completed := make(chan outcome, 1)
	go func() {
		state, err := store.MarkAlertState(ctx, alertID, subjectKey, AlertMarkRead)
		completed <- outcome{state: state, err: err}
	}()

	// Wait until the mark is actually blocked on the lock, so the release instant
	// below is provably later than the waiting transaction's start.
	waitForAdvisoryWaiter(t, ctx, db)
	// The comparison is made on the database clock, which is the clock the stored
	// instant comes from; reading it here also proves the waiter is still blocked
	// when the release instant is taken.
	var released time.Time
	if err := db.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&released); err != nil {
		t.Fatalf("read the release instant: %v", err)
	}
	released = released.UTC()
	if err := holder.Rollback(ctx); err != nil {
		t.Fatalf("release the pair's advisory lock: %v", err)
	}

	var result outcome
	select {
	case result = <-completed:
	case <-time.After(10 * time.Second):
		t.Fatal("the mark did not complete after the lock was released")
	}
	if result.err != nil {
		t.Fatalf("MarkAlertState: %v", result.err)
	}
	if result.state.MarkedAt == nil {
		t.Fatal("the appended mark carries no instant")
	}
	if result.state.MarkedAt.Before(released) {
		t.Fatalf("mark stamped %s, before the lock was released at %s; it recorded its transaction start instead of the append instant", result.state.MarkedAt, released)
	}

	replay, err := store.MarkAlertState(ctx, alertID, subjectKey, AlertMarkRead)
	if err != nil {
		t.Fatalf("replay the mark: %v", err)
	}
	if replay.MarkedAt == nil || !replay.MarkedAt.Equal(*result.state.MarkedAt) {
		t.Fatalf("replay stamped %v, want the stored instant %s", replay.MarkedAt, result.state.MarkedAt)
	}
}

// waitForAdvisoryWaiter waits until some transaction is blocked on an advisory
// lock. The state tests run sequentially and write their own subject pair, so a
// waiter observed here is the mark this test just started.
func waitForAdvisoryWaiter(t *testing.T, ctx context.Context, db *pgxpool.Pool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var waiting int
		if err := db.QueryRow(ctx, `SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND NOT granted`).Scan(&waiting); err != nil {
			t.Fatalf("read advisory lock waiters: %v", err)
		}
		if waiting > 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("the mark never blocked on the advisory lock")
}

// TestAlertStateConcurrentMarksStayMonotonic is the concurrency proof the unit
// suite cannot write: read and dismissed marks race for one pair, and the committed
// result must be one dismissal with one instant, never a last-writer-wins read.
func TestAlertStateConcurrentMarksStayMonotonic(t *testing.T) {
	ctx, db := alertTestPool(t)
	store := Store{DB: db}
	alertID := alertStateFixtureAlert(ctx, t, store)
	subjectKey := AlertStateSubjectKey("race-" + uuid.NewString())

	const workers = 8
	start := make(chan struct{})
	results := make([]AlertState, 0, workers)
	errorsSeen := make(chan error, workers)
	var wait sync.WaitGroup
	var lock sync.Mutex
	for index := 0; index < workers; index++ {
		mark := AlertMarkRead
		if index%2 == 1 {
			mark = AlertMarkDismissed
		}
		wait.Add(1)
		go func(mark AlertMark) {
			defer wait.Done()
			<-start
			state, err := store.MarkAlertState(ctx, alertID, subjectKey, mark)
			if err != nil {
				errorsSeen <- err
				return
			}
			lock.Lock()
			results = append(results, state)
			lock.Unlock()
		}(mark)
	}
	close(start)
	wait.Wait()
	close(errorsSeen)
	for err := range errorsSeen {
		t.Fatalf("a concurrent mark failed: %v", err)
	}
	if len(results) != workers {
		t.Fatalf("collected %d results, want %d", len(results), workers)
	}

	final, err := store.ReadAlertState(ctx, alertID, subjectKey)
	if err != nil {
		t.Fatalf("final read: %v", err)
	}
	if final.State != AlertStateDismissed || final.MarkedAt == nil {
		t.Fatalf("final state = %+v, want dismissed with an instant; a concurrent read must not win over a dismissal", final)
	}
	readRows, dismissedRows := stateRowCounts(t, ctx, store, alertID, subjectKey)
	if dismissedRows != 1 {
		t.Fatalf("dismissed rows = %d, want exactly 1", dismissedRows)
	}
	if readRows > 1 {
		t.Fatalf("read rows = %d, want at most 1", readRows)
	}

	// Every answer that reports the dismissal must carry the one stored instant.
	for _, result := range results {
		if result.State == AlertStateDismissed {
			if result.MarkedAt == nil || !result.MarkedAt.Equal(*final.MarkedAt) {
				t.Fatalf("a concurrent answer reported dismissal at %v, want %s", result.MarkedAt, final.MarkedAt)
			}
		}
		if result.State == AlertStateRead && readRows == 0 {
			t.Fatalf("an answer reported read at %v while no read row is stored", result.MarkedAt)
		}
	}
}

// TestAlertStateConcurrentReplaysAppendOnce is the idempotency half of the race:
// identical marks arriving together must produce one row and one instant, so a
// double click cannot make the same mark look like two events.
func TestAlertStateConcurrentReplaysAppendOnce(t *testing.T) {
	ctx, db := alertTestPool(t)
	store := Store{DB: db}
	alertID := alertStateFixtureAlert(ctx, t, store)
	subjectKey := AlertStateSubjectKey("replay-" + uuid.NewString())

	const workers = 8
	start := make(chan struct{})
	results := make([]AlertState, 0, workers)
	errorsSeen := make(chan error, workers)
	var wait sync.WaitGroup
	var lock sync.Mutex
	for index := 0; index < workers; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			state, err := store.MarkAlertState(ctx, alertID, subjectKey, AlertMarkRead)
			if err != nil {
				errorsSeen <- err
				return
			}
			lock.Lock()
			results = append(results, state)
			lock.Unlock()
		}()
	}
	close(start)
	wait.Wait()
	close(errorsSeen)
	for err := range errorsSeen {
		t.Fatalf("a concurrent replay failed: %v", err)
	}
	if readRows, _ := stateRowCounts(t, ctx, store, alertID, subjectKey); readRows != 1 {
		t.Fatalf("read rows = %d, want exactly 1", readRows)
	}
	var instant *time.Time
	for _, result := range results {
		if result.State != AlertStateRead || result.MarkedAt == nil {
			t.Fatalf("a concurrent replay answered %+v, want the one read mark", result)
		}
		if instant == nil {
			instant = result.MarkedAt
			continue
		}
		if !result.MarkedAt.Equal(*instant) {
			t.Fatalf("concurrent replays report different instants: %s and %s", instant, result.MarkedAt)
		}
	}
}

// TestAlertStateMissingAlertAndUnknownMarkAreDeterministic keeps the two refusals
// distinct from a storage failure: an identifier that names no stored alert is
// ErrAlertNotFound and appends nothing, and an unknown mark is refused before any
// connection is used.
func TestAlertStateMissingAlertAndUnknownMarkAreDeterministic(t *testing.T) {
	ctx, db := alertTestPool(t)
	store := Store{DB: db}
	subjectKey := AlertStateSubjectKey("missing-" + uuid.NewString())
	missingID := uuid.NewString()

	if _, err := store.ReadAlertState(ctx, missingID, subjectKey); !errors.Is(err, ErrAlertNotFound) {
		t.Fatalf("ReadAlertState of a missing alert returned %v, want ErrAlertNotFound", err)
	}
	if _, err := store.MarkAlertState(ctx, missingID, subjectKey, AlertMarkRead); !errors.Is(err, ErrAlertNotFound) {
		t.Fatalf("MarkAlertState of a missing alert returned %v, want ErrAlertNotFound", err)
	}
	var rows int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM risk_alert_state WHERE alert_id=$1`, missingID).Scan(&rows); err != nil {
		t.Fatalf("count marks of the missing alert: %v", err)
	}
	if rows != 0 {
		t.Fatalf("a mark was stored for an alert that does not exist: %d rows", rows)
	}
	if _, err := store.MarkAlertState(ctx, missingID, subjectKey, AlertMark("unread")); !errors.Is(err, ErrUnknownAlertMark) {
		t.Fatalf("an unknown mark returned %v, want ErrUnknownAlertMark", err)
	}
}

// TestAlertStateSchemaBacksTheStore proves the real table, not only the Go writer:
// the foreign key refuses an orphan, the CHECK refuses a state outside the closed
// vocabulary and a subject key that is not a digest, the unique index refuses a
// second mark of the same rank, and the application role holds SELECT and INSERT
// with no UPDATE, DELETE or TRUNCATE.
func TestAlertStateSchemaBacksTheStore(t *testing.T) {
	ctx, db := alertTestPool(t)
	store := Store{DB: db}
	alertID := alertStateFixtureAlert(ctx, t, store)
	subjectKey := AlertStateSubjectKey("schema-" + uuid.NewString())

	for _, tc := range []struct {
		name string
		sql  string
		args []any
	}{
		{
			name: "an unknown state is refused by the schema",
			sql:  `INSERT INTO risk_alert_state(id,alert_id,subject_key,state,marked_at) VALUES($1,$2,$3,'unread',now())`,
			args: []any{uuid.NewString(), alertID, subjectKey},
		},
		{
			name: "a subject key that is not a digest is refused by the schema",
			sql:  `INSERT INTO risk_alert_state(id,alert_id,subject_key,state,marked_at) VALUES($1,$2,'alice','read',now())`,
			args: []any{uuid.NewString(), alertID},
		},
		{
			name: "an alert that is not stored is refused by the foreign key",
			sql:  `INSERT INTO risk_alert_state(id,alert_id,subject_key,state,marked_at) VALUES($1,$2,$3,'read',now())`,
			args: []any{uuid.NewString(), uuid.NewString(), subjectKey},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := db.Exec(ctx, tc.sql, tc.args...)
			if err == nil {
				t.Fatal("the row was accepted; the schema does not back the store")
			}
			var pgErr *pgconn.PgError
			if !errors.As(err, &pgErr) || (pgErr.Code != "23514" && pgErr.Code != "23503") {
				t.Fatalf("insert returned %v, want SQLSTATE 23514 or 23503", err)
			}
		})
	}

	// The real write path stores the first mark and the unique index refuses a
	// second row of the same rank, so a future writer cannot make a replay look
	// like a new event even if it skips the store's no-op branch.
	if _, err := store.MarkAlertState(ctx, alertID, subjectKey, AlertMarkRead); err != nil {
		t.Fatalf("store the first mark: %v", err)
	}
	_, err := db.Exec(ctx, `INSERT INTO risk_alert_state(id,alert_id,subject_key,state,marked_at) VALUES($1,$2,$3,'read',now())`, uuid.NewString(), alertID, subjectKey)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23505" {
		t.Fatalf("a duplicate rank returned %v, want SQLSTATE 23505 from the unique mark index", err)
	}

	// The foreign key is explicit about deletion: an alert is immutable evidence,
	// so the schema refuses to delete one out from under a mark.
	var deleteAction string
	if err := db.QueryRow(ctx, `SELECT c.confdeltype::text
		FROM pg_constraint c
		JOIN pg_class t ON t.oid = c.conrelid
		WHERE t.relname='risk_alert_state' AND c.contype='f'`).Scan(&deleteAction); err != nil {
		t.Fatalf("read the state foreign key: %v", err)
	}
	if deleteAction != "r" {
		t.Errorf("the state foreign key is ON DELETE %q, want 'r' (RESTRICT)", deleteAction)
	}

	// Privileges are read from the catalogue, so the assertion holds even when the
	// test connects as the migration owner instead of the application role.
	var canSelect, canInsert, canUpdate, canDelete, canTruncate bool
	if err := db.QueryRow(ctx, `SELECT has_table_privilege('risk_app','risk_alert_state','SELECT'),
		has_table_privilege('risk_app','risk_alert_state','INSERT'),
		has_table_privilege('risk_app','risk_alert_state','UPDATE'),
		has_table_privilege('risk_app','risk_alert_state','DELETE'),
		has_table_privilege('risk_app','risk_alert_state','TRUNCATE')`).
		Scan(&canSelect, &canInsert, &canUpdate, &canDelete, &canTruncate); err != nil {
		t.Fatalf("read risk_app's state privileges: %v", err)
	}
	if !canSelect || !canInsert {
		t.Errorf("risk_app select=%v insert=%v, want both granted", canSelect, canInsert)
	}
	if canUpdate || canDelete || canTruncate {
		t.Errorf("risk_app update=%v delete=%v truncate=%v, want none: a stored mark is never rewritten or removed", canUpdate, canDelete, canTruncate)
	}

	// When this suite runs under the application role, the denial is observed
	// rather than inferred from the catalogue.
	var currentUser string
	if err := db.QueryRow(ctx, `SELECT current_user`).Scan(&currentUser); err != nil {
		t.Fatalf("read current_user: %v", err)
	}
	if currentUser == "risk_app" {
		for _, statement := range []string{
			`UPDATE risk_alert_state SET state='dismissed' WHERE alert_id=$1`,
			`DELETE FROM risk_alert_state WHERE alert_id=$1`,
		} {
			_, err := db.Exec(ctx, statement, alertID)
			var denied *pgconn.PgError
			if !errors.As(err, &denied) || denied.Code != "42501" {
				t.Fatalf("%s returned %v, want SQLSTATE 42501 permission denied", statement, err)
			}
		}
	} else {
		t.Logf("connected as %q rather than risk_app; the denial is asserted from the catalogue above", currentUser)
	}
}

// TestAlertStateReadIsOneStatement pins that a personal read does not need a
// separate existence query: one statement joins the alert to the marks so a
// missing alert and an unmarked alert are distinguished without a race between
// two reads.
func TestAlertStateReadIsOneStatement(t *testing.T) {
	if strings.Count(alertStateReadSQL, ";") != 0 {
		t.Fatalf("the personal read is more than one statement: %s", alertStateReadSQL)
	}
	if !strings.Contains(alertStateReadSQL, "WHERE a.id = $1") {
		t.Fatalf("the personal read does not address the alert: %s", alertStateReadSQL)
	}
}
