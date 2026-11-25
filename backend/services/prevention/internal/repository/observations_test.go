package repository

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// PM-09's database-side rules: one round trip through the real catalogue, the
// zone refusal that writes nothing, the closed type catalogue enforced by the
// CHECK, and the append-only grants the runtime role actually holds. The handler
// tests prove the transport; only these prove the SQL. Like the rest of this
// file's siblings they need a migrated disposable database and skip without one.

// catalogueZone returns one zone the authoritative catalogue really holds. The
// observation fixtures never invent a zone code: the catalogue is the authority,
// and a hard-coded literal here would pass even if the seed stopped running.
func catalogueZone(t *testing.T, ctx context.Context, store Store) (code, name string) {
	t.Helper()
	err := store.DB.QueryRow(ctx, `SELECT code,name FROM zones ORDER BY code LIMIT 1`).Scan(&code, &name)
	if errors.Is(err, pgx.ErrNoRows) {
		t.Skip("the zone catalogue is empty: risk migrations and their seed have not run in this database")
	}
	if err != nil {
		t.Fatalf("read the zone catalogue: %v", err)
	}
	return code, name
}

// observationsWithDescription counts the rows carrying one unique fixture marker.
// The application role holds no DELETE grant, so a test cannot clean up after
// itself; a per-run marker is what keeps "no row was added" a real assertion
// instead of a count that other runs could hide.
func observationsWithDescription(t *testing.T, ctx context.Context, store Store, description string) int {
	t.Helper()
	var count int
	if err := store.DB.QueryRow(ctx, `SELECT count(*) FROM prevention.observations WHERE description=$1`, description).Scan(&count); err != nil {
		t.Fatalf("count the observation fixtures: %v", err)
	}
	return count
}

// TestObservationRoundTripReadsTheZoneFromTheCatalogue proves the one write path
// and the filtered read against the real database: the stored row carries every
// field, the catalogue resolves the zone name, the date comes back as the plain
// calendar date, and the closed catalogue filter narrows the list.
func TestObservationRoundTripReadsTheZoneFromTheCatalogue(t *testing.T) {
	ctx, store := testStore(t)
	code, name := catalogueZone(t, ctx, store)
	marker := "observation-roundtrip-" + uuid.NewString()

	created, err := store.CreateObservation(ctx, NewObservation{
		Type:        "quema",
		ZoneID:      code,
		ObservedOn:  "2026-11-20",
		Description: marker,
		CreatedBy:   "admin-1",
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if parsed, parseErr := uuid.Parse(created.ID); parseErr != nil || parsed == uuid.Nil {
		t.Fatalf("id %q is not a server-generated UUID", created.ID)
	}
	if created.Type != "quema" || created.ZoneID != code {
		t.Errorf("stored type/zone are %q/%q, want quema/%q", created.Type, created.ZoneID, code)
	}
	if created.ZoneName == nil || *created.ZoneName != name {
		t.Errorf("zone_name is %v, want the catalogue name %q", created.ZoneName, name)
	}
	if created.ObservedOn != "2026-11-20" {
		t.Errorf("observed_on is %q, want the calendar date 2026-11-20", created.ObservedOn)
	}
	if created.Description != marker || created.CreatedBy != "admin-1" {
		t.Errorf("description/author are %q/%q, want the stored values", created.Description, created.CreatedBy)
	}
	if created.CreatedAt.IsZero() {
		t.Error("created_at is zero; the server clock must stamp it")
	}
	if got := observationsWithDescription(t, ctx, store, marker); got != 1 {
		t.Fatalf("%d rows carry the marker after one create, want exactly 1", got)
	}

	listed, err := store.ListObservations(ctx, "quema")
	if err != nil {
		t.Fatalf("list filtered: %v", err)
	}
	found := false
	for _, observation := range listed {
		if observation.ID == created.ID {
			found = true
			if observation.ZoneName == nil || *observation.ZoneName != name {
				t.Errorf("listed zone_name is %v, want %q", observation.ZoneName, name)
			}
		}
	}
	if !found {
		t.Error("the created observation is missing from its own type's list")
	}

	other, err := store.ListObservations(ctx, "microbasural")
	if err != nil {
		t.Fatalf("list other type: %v", err)
	}
	for _, observation := range other {
		if observation.ID == created.ID {
			t.Error("a quema observation appears in the microbasural list")
		}
	}

	unfiltered, err := store.ListObservations(ctx, "")
	if err != nil {
		t.Fatalf("list unfiltered: %v", err)
	}
	if len(unfiltered) == 0 {
		t.Error("an unfiltered list is empty after a successful create")
	}
}

// TestObservationRefusesAZoneTheCatalogueDoesNotHold proves the server-side
// closure of the zone reference: the insert selects the zone from the catalogue,
// so an unknown code inserts no row at all.
func TestObservationRefusesAZoneTheCatalogueDoesNotHold(t *testing.T) {
	ctx, store := testStore(t)
	marker := "observation-unknown-zone-" + uuid.NewString()

	_, err := store.CreateObservation(ctx, NewObservation{
		Type:        "quema",
		ZoneID:      "zone-" + uuid.NewString(),
		ObservedOn:  "2026-11-20",
		Description: marker,
		CreatedBy:   "admin-1",
	})
	if !errors.Is(err, ErrZoneNotFound) {
		t.Fatalf("create with an unlisted zone returned %v, want ErrZoneNotFound", err)
	}
	if got := observationsWithDescription(t, ctx, store, marker); got != 0 {
		t.Fatalf("%d rows were written for an unlisted zone, want 0", got)
	}
}

// TestObservationDatabaseKeepsTheTypeCatalogueClosed is the other half of the
// closed catalogue: the SQL CHECK refuses a value the service would have refused,
// so a future code path that skips the Go validation cannot store a new type. It
// inserts directly, deliberately bypassing the transport.
func TestObservationDatabaseKeepsTheTypeCatalogueClosed(t *testing.T) {
	ctx, store := testStore(t)
	code, _ := catalogueZone(t, ctx, store)
	marker := "observation-unknown-type-" + uuid.NewString()

	_, err := store.DB.Exec(ctx, `INSERT INTO prevention.observations(id,type,zone_id,observed_on,description,created_by)
		VALUES($1,'incendio',$2,'2026-11-20',$3,'tester')`, uuid.NewString(), code, marker)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23514" {
		t.Fatalf("inserting an unknown type returned %v, want SQLSTATE 23514", err)
	}
	if got := observationsWithDescription(t, ctx, store, marker); got != 0 {
		t.Fatalf("%d rows carry the marker after a refused type, want 0", got)
	}
}

// TestObservationGrantsAreAppendOnlyForTheApplicationRole proves the migration's
// grants against the role the service actually connects as: it may read and
// append observations, and it may never rewrite or delete one. Without this the
// append-only guarantee would be a claim in a comment.
func TestObservationGrantsAreAppendOnlyForTheApplicationRole(t *testing.T) {
	ctx, store := testStore(t)
	var usage, canSelect, canInsert, canUpdate, canDelete bool
	if err := store.DB.QueryRow(ctx, `SELECT
		has_schema_privilege(current_user,'prevention','USAGE'),
		has_table_privilege(current_user,'prevention.observations','SELECT'),
		has_table_privilege(current_user,'prevention.observations','INSERT'),
		has_table_privilege(current_user,'prevention.observations','UPDATE'),
		has_table_privilege(current_user,'prevention.observations','DELETE')`).
		Scan(&usage, &canSelect, &canInsert, &canUpdate, &canDelete); err != nil {
		t.Fatalf("read the observation grants: %v", err)
	}
	if !usage || !canSelect || !canInsert {
		t.Errorf("runtime role grants usage/select/insert = %v/%v/%v, want true/true/true", usage, canSelect, canInsert)
	}
	if canUpdate || canDelete {
		t.Errorf("runtime role may update=%v and delete=%v observations; the table must stay append-only", canUpdate, canDelete)
	}
	var zoneSelect bool
	if err := store.DB.QueryRow(ctx, `SELECT has_table_privilege(current_user,'zones','SELECT')`).Scan(&zoneSelect); err != nil {
		t.Fatalf("read the zone catalogue grant: %v", err)
	}
	if !zoneSelect {
		t.Error("the runtime role cannot read the zone catalogue, so every zone would be refused")
	}
}

// TestObservationListIsBoundedAndNewestFirst pins the ordering the page relies on
// without depending on rows other runs left behind: the fixtures share one
// observation date, so the newest one is the last created.
func TestObservationListIsBoundedAndNewestFirst(t *testing.T) {
	ctx, store := testStore(t)
	code, _ := catalogueZone(t, ctx, store)
	prefix := "observation-order-" + uuid.NewString()
	ids := make([]string, 0, 2)
	for index, day := range []string{"2026-11-19", "2026-11-21"} {
		created, err := store.CreateObservation(ctx, NewObservation{
			Type:        "otro",
			ZoneID:      code,
			ObservedOn:  day,
			Description: prefix + "-" + day,
			CreatedBy:   "admin-1",
		})
		if err != nil {
			t.Fatalf("create fixture %d: %v", index, err)
		}
		ids = append(ids, created.ID)
	}
	listed, err := store.ListObservations(ctx, "otro")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(listed) > defaultObservationListLimit {
		t.Fatalf("list returned %d rows, the bound is %d", len(listed), defaultObservationListLimit)
	}
	position := map[string]int{}
	for index, observation := range listed {
		position[observation.ID] = index
	}
	for _, id := range ids {
		if _, ok := position[id]; !ok {
			t.Fatalf("fixture %s is missing from the bounded list", id)
		}
	}
	if position[ids[1]] > position[ids[0]] {
		t.Errorf("the observation dated 2026-11-21 is listed after the one dated 2026-11-19")
	}
}
