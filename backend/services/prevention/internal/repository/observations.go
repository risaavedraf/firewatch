// PM-09 field observations: the append-only record of what an operator saw in a
// zone, with the zone read from the authoritative catalogue and the author taken
// from the verified token subject by the transport.
package repository

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ErrZoneNotFound means the zone code is not in the shared zone catalogue. The
// write is a select-from-the-catalogue, so an unknown code inserts no row; the
// transport maps this to the documented 422 and nothing is written. It is a
// client-input refusal, not a storage failure, and never a 404 on the route.
var ErrZoneNotFound = errors.New("zone is not in the catalogue")

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
// driver's time zone, exactly as due_date is.
const observationColumns = `o.id::text,o.type,o.zone_id,z.name,to_char(o.observed_on,'YYYY-MM-DD'),o.description,o.created_by,o.created_at`

// scanObservation reads the shared projection in the shared ordered list.
func scanObservation(row pgx.Row) (Observation, error) {
	var o Observation
	err := row.Scan(&o.ID, &o.Type, &o.ZoneID, &o.ZoneName, &o.ObservedOn, &o.Description, &o.CreatedBy, &o.CreatedAt)
	return o, err
}

// ListObservations returns observations newest first. An empty observationType
// is not a filter, exactly as an omitted query parameter narrows nothing. The
// zone name is a left join on purpose: the observation is the record of what was
// seen, and losing it because a catalogue row was removed would erase the field
// record instead of reporting the missing name.
func (s Store) ListObservations(ctx context.Context, observationType string) ([]Observation, error) {
	rows, err := s.DB.Query(ctx, `SELECT `+observationColumns+` FROM prevention.observations o
		LEFT JOIN zones z ON z.code = o.zone_id
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
		SELECT `+observationColumns+` FROM inserted o JOIN zones z ON z.code = o.zone_id`,
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
