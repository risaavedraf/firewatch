// PM-09 field observations: the append-only record of what an operator saw in a
// zone, with the zone read from the authoritative catalogue and the author taken
// from the verified token subject by the transport.
package repository

import (
	"context"
	"errors"
	"time"

	"firewatch.local/prevention/internal/state"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// ErrZoneNotFound means the zone code is not in the shared zone catalogue. The
// write is a select-from-the-catalogue, so an unknown code inserts no row; the
// transport maps this to the documented 422 and nothing is written. It is a
// client-input refusal, not a storage failure, and never a 404 on the route.
var ErrZoneNotFound = errors.New("zone is not in the catalogue")

// ErrObservationNotFound means no observation holds the addressed id. It is the
// 404 of the addressed resource, and nothing is written.
var ErrObservationNotFound = errors.New("field observation not found")

// ErrAdoptionActionNotFound means the adoption names an action that
// prevention.actions does not hold. It is the same refusal the observation insert
// applies to an unknown zone: a body reference the server cannot resolve is 422
// client input, not the 404 of the route's own resource, and no link is written.
var ErrAdoptionActionNotFound = errors.New("adoption names a preventive action that does not exist")

// ErrAdoptionActionCancelled means the action exists but is cancelada, so the
// service refuses to create a NEW link to it. pm-10 does not implement the
// action's state machine: cancellation is read here, never written. An existing
// link survives the cancellation untouched and a repeated identical confirmation
// is answered from it, because a cancellation must not erase the historical
// record of why the work was confirmed in the first place.
var ErrAdoptionActionCancelled = errors.New("adoption of a cancelled preventive action is refused")

// ErrObservationAlreadyAdopted means the observation is already linked to a
// different action. At most one action per observation is the rule, so the second
// link is refused instead of overwriting the first: the earlier confirmation is a
// record of a decision, not a value to be updated.
var ErrObservationAlreadyAdopted = errors.New("observation is already linked to another action")

// Observation is one PM-09 field observation as it appears on the wire.
//
// ZoneName is the name the catalogue reports for ZoneID, read by the same
// statement that writes or lists the row. It is a pointer because the catalogue
// owns the zone: a retrospective read of a code the catalogue no longer holds
// reports null instead of inventing a name or hiding the observation.
type Observation struct {
	ID string `json:"id"`
	// Type is one of the five members of the closed PM-09 catalogue. It is
	// validated by the transport and again by the table's CHECK.
	Type   string `json:"type"`
	ZoneID string `json:"zone_id"`
	// ZoneName is the catalogue name, or null when the catalogue does not hold
	// the code any more.
	ZoneName *string `json:"zone_name"`
	// ObservedOn is a plain calendar date (YYYY-MM-DD), not an instant: the
	// observation happened on a day, and a time of day would be fabricated
	// precision.
	ObservedOn string `json:"observed_on"`
	// Description is what the operator saw, as sent. Empty is unrepresentable:
	// the column and the transport both refuse a blank description.
	Description string `json:"description"`
	// CreatedBy is the verified token subject (the author). It is never a
	// client-supplied field.
	CreatedBy string    `json:"created_by"`
	CreatedAt time.Time `json:"created_at"`
	// AdoptedActionID is the action this observation was durably confirmed to
	// justify, or null when no confirmation has been recorded. It is read from
	// prevention.observation_adoptions by the same statement that lists or writes
	// the observation, so it is never a second copy of the association. The field
	// is additive and optional: an observation without an adoption reports null,
	// and a link created by PM-10 is reported by the reads PM-09 already serves.
	AdoptedActionID *string `json:"adopted_action_id"`
}

// ObservationAdoption is the durable confirmation that one observation justifies
// one existing preventive action: the row PM-10 writes when an authorized operator
// states that the work is needed. It deliberately carries no status and no
// assignee: confirming the need is not assigning the work, not starting it and not
// moving the action's state.
//
// The provenance is returned to the transport for the audit line only; the wire
// answer is the observation, whose adopted_action_id names the link.
type ObservationAdoption struct {
	// Observation is the observation in its post-link state.
	Observation Observation
	// ActionID is the action the observation was confirmed to justify.
	ActionID string
	// ConfirmedBy is the verified token subject that first confirmed the need and
	// ConfirmedAt the server instant of that confirmation. On a repeated identical
	// link these are the values already stored: a repeat writes nothing, so it must
	// not claim a new confirmation.
	ConfirmedBy string
	ConfirmedAt time.Time
	// Recorded reports whether this call wrote the link (false for a repeat).
	Recorded bool
}

// Zone is one entry of the authoritative zone catalogue the observation form
// offers. It is the same `zones` table the risk service publishes as GeoJSON;
// this projection exists because a select needs every zone, including the ones
// that carry no geometry and are therefore absent from the map layer.
type Zone struct {
	Code string `json:"code"`
	Name string `json:"name"`
	// Province is nullable in the catalogue, so it is nullable here too. The
	// empty string is not substituted, because "no province recorded" and
	// "province with an empty name" are not the same fact.
	Province *string `json:"province"`
}

// NewObservation is the validated create command. The type has already been
// checked against the closed catalogue and the date against the calendar by the
// transport; the zone is checked against the catalogue by the insert itself, in
// the same statement, so there is no window between validating it and using it.
type NewObservation struct {
	Type        string
	ZoneID      string
	ObservedOn  string
	Description string
	CreatedBy   string
}

// defaultObservationListLimit bounds one list read. The contract documents no
// page size, so the bound is stated here rather than assumed by the caller; the
// same size the action list uses keeps one page of either entity comparable.
const defaultObservationListLimit = 200

// observationColumns is the single projection every observation read shares, so
// a column cannot be selected in one query and forgotten in another. The date is
// rendered in SQL so the wire format is a calendar date regardless of the
// driver's time zone, exactly as due_date is. It addresses three aliases — o for
// prevention.observations, z for the zone catalogue and a for the adoption — so
// every read joins the same three and reports the durable link the same way.
const observationColumns = `o.id::text,o.type,o.zone_id,z.name,to_char(o.observed_on,'YYYY-MM-DD'),o.description,o.created_by,o.created_at,a.action_id::text`

// adoptionJoin is the join every observation read shares. It is a LEFT JOIN on
// purpose: an observation with no confirmation is a complete observation, and an
// adoption is reported as an association rather than as a second copy of the row.
const adoptionJoin = `LEFT JOIN prevention.observation_adoptions a ON a.observation_id = o.id`

// scanObservation reads the shared projection in the shared ordered list.
func scanObservation(row pgx.Row) (Observation, error) {
	var o Observation
	err := row.Scan(&o.ID, &o.Type, &o.ZoneID, &o.ZoneName, &o.ObservedOn, &o.Description, &o.CreatedBy, &o.CreatedAt, &o.AdoptedActionID)
	return o, err
}

// observationByID reads one observation with the shared projection inside the
// caller's transaction or pool, so a write can answer the row it just linked
// without a second round trip and without a stale read outside the transaction.
func observationByID(ctx context.Context, q queryer, id string) (Observation, error) {
	observation, err := scanObservation(q.QueryRow(ctx, `SELECT `+observationColumns+` FROM prevention.observations o
		LEFT JOIN zones z ON z.code = o.zone_id
		`+adoptionJoin+`
		WHERE o.id=$1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Observation{}, ErrObservationNotFound
	}
	if err != nil {
		return Observation{}, err
	}
	return observation, nil
}

// ListObservations returns observations newest first. An empty observationType
// is not a filter, exactly as an omitted query parameter narrows nothing. The
// zone name is a left join on purpose: the observation is the record of what was
// seen, and losing it because a catalogue row was removed would erase the field
// record instead of reporting the missing name.
func (s Store) ListObservations(ctx context.Context, observationType string) ([]Observation, error) {
	rows, err := s.DB.Query(ctx, `SELECT `+observationColumns+` FROM prevention.observations o
		LEFT JOIN zones z ON z.code = o.zone_id
		`+adoptionJoin+`
		WHERE ($1='' OR o.type=$1)
		ORDER BY o.observed_on DESC, o.created_at DESC, o.id DESC
		LIMIT $2`, observationType, defaultObservationListLimit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	observations := make([]Observation, 0)
	for rows.Next() {
		observation, err := scanObservation(rows)
		if err != nil {
			return nil, err
		}
		observations = append(observations, observation)
	}
	return observations, rows.Err()
}

// CreateObservation inserts one observation, resolving its zone in the same
// statement. The insert selects from the catalogue by code, so an unknown zone
// produces zero rows and therefore ErrZoneNotFound: there is no read-then-write
// window in which the catalogue could change under the write, and a refusal
// cannot leave a row behind.
//
// The id is generated here, so it is known before the row exists and can never
// collide with a client-supplied value. There is deliberately no foreign key to
// `zones`: the prevention and risk migration runners are independent in the
// compose test profile, so a foreign key would add a startup ordering dependency
// between two migrations — the same reason migration 011 documents no foreign key
// to `batches`. The select makes the catalogue the gate instead of the schema.
func (s Store) CreateObservation(ctx context.Context, input NewObservation) (Observation, error) {
	observation, err := scanObservation(s.DB.QueryRow(ctx, `WITH inserted AS (
		INSERT INTO prevention.observations (id,type,zone_id,observed_on,description,created_by)
		SELECT $1,$2,z.code,$3,$4,$5 FROM zones z WHERE z.code=$6
		RETURNING id,type,zone_id,observed_on,description,created_by,created_at)
		SELECT `+observationColumns+` FROM inserted o JOIN zones z ON z.code = o.zone_id
		`+adoptionJoin,
		uuid.NewString(), input.Type, input.ObservedOn, input.Description, input.CreatedBy, input.ZoneID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Observation{}, ErrZoneNotFound
	}
	if err != nil {
		return Observation{}, err
	}
	return observation, nil
}

// ListZones returns the zone catalogue in display order: name, then code, so a
// select is alphabetical while two zones sharing a name stay deterministic. The
// catalogue, not an application allowlist, is the authority, so this reads the
// table the risk migrations create and seed and adds every row, not only the
// zones that carry a geometry.
func (s Store) ListZones(ctx context.Context) ([]Zone, error) {
	rows, err := s.DB.Query(ctx, `SELECT code,name,province FROM zones ORDER BY name, code`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	zones := make([]Zone, 0)
	for rows.Next() {
		var zone Zone
		if err := rows.Scan(&zone.Code, &zone.Name, &zone.Province); err != nil {
			return nil, err
		}
		zones = append(zones, zone)
	}
	return zones, rows.Err()
}

// adoptionDecision is the one rule the adoption transaction enforces, written as
// a pure function so the matrix is proved without a database and the transaction
// only has to supply the locked facts.
//
//   - An identical link already stored is answered, not rewritten: a repeat is
//     idempotent and must work even when the action has since been cancelled,
//     because the confirmation is a historical record and cancelling the work
//     later must not erase why it was confirmed.
//   - A different link is refused: one observation justifies at most one action,
//     and the first confirmation is never overwritten.
//   - A fresh link is allowed for any non-cancelled action, including propuesta:
//     the operator confirms the need for the work, which is not the same fact as
//     assigning it, starting it or changing its status.
//   - A fresh link to a cancelled action is refused. The status machine stays
//     untouched: cancellation is read here and never written.
func adoptionDecision(existing *string, actionStatus, requested string) (bool, error) {
	if existing != nil {
		if *existing == requested {
			return false, nil
		}
		return false, ErrObservationAlreadyAdopted
	}
	if actionStatus == string(state.Cancelada) {
		return false, ErrAdoptionActionCancelled
	}
	return true, nil
}

// AdoptObservation durably confirms that one observation justifies one existing
// preventive action and links the two, in one transaction.
//
// A transaction-scoped advisory lock serializes confirmations for the same
// observation without requiring UPDATE on the append-only observation table.
// The link is read after acquiring the lock, in a fresh READ COMMITTED statement
// snapshot, so a retry sees the winning confirmation. A fresh link also locks
// the action row to serialize its eligibility check with cancellation. Both
// locks have the same order in every adoption transaction.
//
// Nothing here changes the action: no status, no assignee, no history row. The
// only write is the link itself, and the only read of the action is its status.
func (s Store) AdoptObservation(ctx context.Context, observationID, actionID, confirmedBy string) (ObservationAdoption, error) {
	tx, err := s.DB.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return ObservationAdoption{}, err
	}
	defer tx.Rollback(ctx)

	// Use the canonical UUID as part of a namespaced key. A hash collision only
	// serializes unrelated observations; the link itself is keyed by the UUID.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(
		hashtextextended('prevention.observation_adoption:' || $1::uuid::text, 0))`, observationID); err != nil {
		return ObservationAdoption{}, err
	}
	var exists int
	err = tx.QueryRow(ctx, `SELECT 1 FROM prevention.observations WHERE id=$1`, observationID).Scan(&exists)
	if errors.Is(err, pgx.ErrNoRows) {
		return ObservationAdoption{}, ErrObservationNotFound
	}
	if err != nil {
		return ObservationAdoption{}, err
	}

	var existingAction, existingBy string
	var existingAt time.Time
	err = tx.QueryRow(ctx, `SELECT action_id::text,confirmed_by,confirmed_at
		FROM prevention.observation_adoptions WHERE observation_id=$1`, observationID).
		Scan(&existingAction, &existingBy, &existingAt)
	found := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return ObservationAdoption{}, err
	}

	actionStatus := ""
	if !found {
		// A fresh link is only possible against an action that exists. Reading the
		// status under the same row lock makes the cancelled check race-free.
		err = tx.QueryRow(ctx, `SELECT status FROM prevention.actions WHERE id=$1 FOR UPDATE`, actionID).Scan(&actionStatus)
		if errors.Is(err, pgx.ErrNoRows) {
			return ObservationAdoption{}, ErrAdoptionActionNotFound
		}
		if err != nil {
			return ObservationAdoption{}, err
		}
	}

	var existing *string
	if found {
		existing = &existingAction
	}
	link, err := adoptionDecision(existing, actionStatus, actionID)
	if err != nil {
		return ObservationAdoption{}, err
	}
	if !link {
		observation, err := observationByID(ctx, tx, observationID)
		if err != nil {
			return ObservationAdoption{}, err
		}
		return ObservationAdoption{
			Observation: observation, ActionID: existingAction,
			ConfirmedBy: existingBy, ConfirmedAt: existingAt, Recorded: false,
		}, tx.Commit(ctx)
	}

	var confirmedAt time.Time
	err = tx.QueryRow(ctx, `INSERT INTO prevention.observation_adoptions(observation_id,action_id,confirmed_by)
		VALUES($1,$2,$3) RETURNING confirmed_at`, observationID, actionID, confirmedBy).Scan(&confirmedAt)
	if err != nil {
		// The primary key is one row per observation. Another writer can only reach
		// this insert by holding the same observation lock, so a violation is a
		// defensive mapping of a race the lock already prevents, never a silent
		// second link.
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return ObservationAdoption{}, ErrObservationAlreadyAdopted
		}
		return ObservationAdoption{}, err
	}
	// The answer is read inside the transaction, so it describes exactly the row
	// this confirmation produced.
	observation, err := observationByID(ctx, tx, observationID)
	if err != nil {
		return ObservationAdoption{}, err
	}
	return ObservationAdoption{
		Observation: observation, ActionID: actionID,
		ConfirmedBy: confirmedBy, ConfirmedAt: confirmedAt, Recorded: true,
	}, tx.Commit(ctx)
}
