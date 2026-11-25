package handler

import (
	"net/http"

	"firewatch.local/risk/internal/source"
)

// listInfrastructure serves the embedded fictional infrastructure catalogue for
// the PM-11 demo. The source, the provisional one-point-per-element policy, the
// per-type counts and the element identities all come from the source package,
// so the handler adds only the read route and the same viewer/admin authorization
// as every other risk read. It reads no database and no broker: the demo must
// stay answerable while dependencies are down.
func listInfrastructure() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		respond(w, http.StatusOK, source.SyntheticInfrastructure())
	}
}
