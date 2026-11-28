package handler

import (
	"net/http"
	"net/url"

	"firewatch.local/risk/internal/source"
)

// listVegetation serves the embedded land-cover layer (PM-12): NDVI, the five-class
// breakdown and the environment class of every catalogue commune, with the declared
// synthetic provenance. The source package owns every number, so the handler adds
// only the read route and the same viewer/admin authorization as every other risk
// read. It reads no database and no broker: the layer must stay answerable while
// dependencies are down.
//
// The route accepts no parameter at all. The query is read from the raw string, not
// from url.Values, because url.Values silently discards a pair it cannot unescape:
// `?from=%zz` would otherwise be served as "no filters", so unreadable encoding is a
// refusal like any other.
func listVegetation() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		values, err := url.ParseQuery(r.URL.RawQuery)
		if err != nil || len(values) != 0 {
			fail(w, http.StatusUnprocessableEntity, "invalid_query")
			return
		}
		catalogue, err := source.SyntheticVegetation()
		if err != nil {
			// The asset is compiled in, so this answer means the binary itself is
			// broken. It is stated as an unavailable catalogue instead of an empty
			// one, because an empty array would read as "the layer covers nothing".
			fail(w, http.StatusServiceUnavailable, "catalogue_unavailable")
			return
		}
		respond(w, http.StatusOK, catalogue)
	}
}
