// Package migrations carries the schema migrations of the prevention service.
//
// Each SQL file is embedded verbatim, so the migration a deployed binary applies
// is exactly the migration in the repository: there is no external file that can
// drift or be forgotten at deploy time. Migrations are forward-only and guarded
// so that re-applying one is a no-op.
package migrations

import _ "embed"

//go:embed 009_preventive_actions.sql
var preventiveActions string

//go:embed 011_preventive_evidence.sql
var preventiveEvidence string

//go:embed 014_action_assignee.sql
var actionAssignee string

//go:embed 015_field_observations.sql
var fieldObservations string

//go:embed 016_observation_adoption.sql
var observationAdoption string

// Migration is one forward-only schema migration.
//
// Name exists so a failure can be attributed without reading the SQL.
type Migration struct {
	Version int
	Name    string
	SQL     string
}

// All returns the known migrations in ascending version order.
//
// These versions share the risk database's schema_migrations ledger. Risk
// claims 1–8, 10, 12, 13 and 17; prevention claims 9, 11, 14, 15 and 16. A collision
// would silently skip one migration. See backend/docs/migration-ledger.md.
func All() []Migration {
	return []Migration{
		{Version: 9, Name: "preventive_actions", SQL: preventiveActions},
		{Version: 11, Name: "preventive_evidence", SQL: preventiveEvidence},
		{Version: 14, Name: "action_assignee", SQL: actionAssignee},
		{Version: 15, Name: "field_observations", SQL: fieldObservations},
		{Version: 16, Name: "observation_adoption", SQL: observationAdoption},
	}
}
