package repository

import (
	"context"
	"errors"
	"time"

	"firewatch.local/risk/internal/classify"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// AlertLevelChangeThreshold is the agreed threshold that turns a stored level
// change into an alert: one severity step, the smallest change two determined
// levels can have. It is a declared value rather than a literal hidden in the
// writer: it is written into every alert row, restated as the column default of
// 017_risk_alerts.sql, and pinned by a test.
//
// The agreed policy (S2) is "an alert on any ascent or descent between known
// levels", so a higher threshold would drop exactly the transitions the policy
// requires. `desconocido` is not a severity and never takes part.
const AlertLevelChangeThreshold = 1

// alertZoneLockNamespace is the first key of the per-zone advisory lock. The
// two-argument form of pg_advisory_xact_lock lives in a lock space separate from
// the one-argument form the migration runner takes, so a publication and a
// migration can never wait on each other's key.
const alertZoneLockNamespace int32 = 20707

// newestBatchFirst is the chronological rule that decides which stored batch is a
// zone's effective level: newest requested_at first, with the batch id as the
// deterministic tie-break. List and LatestPerZone apply the same rule, and the
// alert writer states it again here so the level an alert compares against is
// exactly the level those reads served before the new batch.
const newestBatchFirst = "requested_at DESC, id DESC"

// lockZoneTransition serializes the publications of one zone inside the calling
// transaction.
//
// It is a transaction-scoped advisory lock, so it is released by the commit or the
// rollback of the transaction that took it and needs no cleanup path of its own.
// The key is derived from the zone code, so two publications of different zones
// never wait on each other while two publications of the same zone are ordered:
// the second one sees the first one's committed batch, which is what makes the
// "immediately preceding level" a real sequence instead of two transactions
// reading the same predecessor.
//
// An advisory lock rather than SELECT ... FOR UPDATE on zones is deliberate: the
// application role holds SELECT on the catalogue and FOR UPDATE would need a write
// privilege it must not have. Hash collisions between two zone codes only make
// unrelated publications wait in turn, never produce a wrong answer.
func lockZoneTransition(ctx context.Context, tx pgx.Tx, zoneID string) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1::integer, hashtext($2))`, alertZoneLockNamespace, zoneID)
	return err
}

// levelRank maps a determined level to its severity rank and reports whether the
// value is a risk level at all.
//
// The ranks are the only place severity is ordered, and they exist to answer one
// question: did the level move by the agreed threshold? `desconocido` and any
// value outside the three determined levels are not ranked, because an unknown
// level is a lack of data and not a severity, and treating it as one would alert
// on "we stopped knowing" as if it were a rise or a fall.
func levelRank(level string) (int, bool) {
	switch classify.Level(level) {
	case classify.LevelBajo:
		return 1, true
	case classify.LevelMedio:
		return 2, true
	case classify.LevelAlto:
		return 3, true
	}
	return 0, false
}

// levelChangeAlerts reports whether a transition between two levels is one the
// agreed policy authorizes an alert for: an ascent or a descent of at least the
// agreed threshold between two determined levels. No previous level (a zone's
// first assessment) and no change are both refusals, and so is a transition with
// an unknown level on either side.
func levelChangeAlerts(previous, next string) bool {
	before, known := levelRank(previous)
	if !known {
		return false
	}
	after, known := levelRank(next)
	if !known {
		return false
	}
	change := after - before
	if change < 0 {
		change = -change
	}
	return change >= AlertLevelChangeThreshold
}

// recordTransitionAlert writes the alert for the batch stored by the calling
// transaction, inside that same transaction.
//
// It is called after the batch insert and before the commit, so an alert can never
// name a batch that was rolled back and a committed batch that crossed the
// threshold can never be served without its alert. The caller has already taken
// lockZoneTransition, so the predecessor read below cannot interleave with another
// publication of the same zone.
//
// There is deliberately no per-zone level column to overwrite: the effective level
// is the newest batch, which is what List and LatestPerZone read. A batch that
// arrives out of order is therefore history by construction - this function sees
// that the newest stored batch is not the one it stored and writes nothing - and a
// late publication cannot rewrite the state a later transition compares against.
//
// Idempotency has two layers. The caller only reaches this function for a batch it
// inserted (an inbox-gated redelivery and a re-dispatch of a stored job return
// earlier), and risk_alerts.batch_id is unique, so a retried transaction that
// reaches the insert twice collides and commits with one row instead of two.
func recordTransitionAlert(ctx context.Context, tx pgx.Tx, zoneID, batchID string, occurredAt time.Time, newLevel string) error {
	rows, err := tx.Query(ctx, `SELECT id::text, risk_level FROM batches WHERE zone_id=$1 ORDER BY `+newestBatchFirst+` LIMIT 2`, zoneID)
	if err != nil {
		return err
	}
	type storedLevel struct {
		id    string
		level string
	}
	stored := make([]storedLevel, 0, 2)
	for rows.Next() {
		var entry storedLevel
		if err = rows.Scan(&entry.id, &entry.level); err != nil {
			rows.Close()
			return err
		}
		stored = append(stored, entry)
	}
	rowsErr := rows.Err()
	rows.Close()
	if rowsErr != nil {
		return rowsErr
	}
	if len(stored) == 0 {
		// The batch was inserted by this transaction, so it must be visible to it.
		// An empty read means storage answered something unrelated to this write;
		// returning an error retries the delivery instead of committing without the
		// alert the batch is entitled to.
		return errors.New("the batch stored in this transaction is not visible to it")
	}
	if stored[0].id != batchID {
		// A newer batch of this zone is already stored, so this one is history and
		// the zone's effective level did not change.
		return nil
	}
	if len(stored) < 2 {
		// The first assessment of a zone: there is no preceding level to change
		// from, so there is no transition to alert about.
		return nil
	}
	previousLevel := stored[1].level
	if !levelChangeAlerts(previousLevel, newLevel) {
		return nil
	}
	_, err = tx.Exec(ctx, `INSERT INTO risk_alerts(id,zone_id,batch_id,previous_level,new_level,threshold,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, uuid.NewString(), zoneID, batchID, previousLevel, newLevel, AlertLevelChangeThreshold, occurredAt.UTC())
	return err
}
