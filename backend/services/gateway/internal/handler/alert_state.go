package handler

import (
	"net/http"
	"strings"

	"github.com/google/uuid"
)

// legacyPreflightMethods is the method list this gateway advertised before the
// personal alert-state write existed. It stays the answer for every preflight
// except the one exact shape below, byte for byte.
const legacyPreflightMethods = "GET, POST, OPTIONS"

// personalStatePreflightMethods appends PUT for the one write the configured
// origin serves today. Appending keeps every legacy value in its original
// position instead of reordering a list callers may already compare.
const personalStatePreflightMethods = legacyPreflightMethods + ", PUT"

// alertStatePreflight reports whether this preflight asks for the personal state
// write of one stored alert: method PUT, path exactly
// /v1/risk/alerts/{canonical UUID}/state.
//
// It is deliberately exact. A preflight for a sibling route, for another verb,
// or for a malformed or suffixed path is not this request and keeps the legacy
// method list. Ordering the checks this way also means a preflight for a PUT to
// a path that is not this one never gains a method the risk service would not
// accept. The requested method is read from the CORS header, never inferred from
// the path: a PUT to another path and another method to this path both stay
// legacy.
func alertStatePreflight(r *http.Request) bool {
	if r.Method != http.MethodOptions {
		return false
	}
	if r.Header.Get("Access-Control-Request-Method") != http.MethodPut {
		return false
	}
	// EscapedPath preserves encoded separators; they are not route boundaries.
	return canonicalAlertStatePath(r.URL.EscapedPath())
}

// canonicalAlertStatePath reports whether path is exactly the personal state
// resource for one canonical alert identifier.
//
// "Canonical" is the same spelling the risk handler accepts: the dashed
// lower-case form uuid.UUID.String() produces. Parsing and re-printing the
// segment is what rejects the bare 32-hex, upper-case, brace-wrapped and
// urn-prefixed forms, which are all different path values even though some
// parsers accept them. A trailing slash, an extra segment or an empty identifier
// is not this path either.
func canonicalAlertStatePath(path string) bool {
	const prefix = "/v1/risk/alerts/"
	const suffix = "/state"
	if !strings.HasPrefix(path, prefix) || !strings.HasSuffix(path, suffix) {
		return false
	}
	raw := path[len(prefix) : len(path)-len(suffix)]
	if raw == "" || strings.Contains(raw, "/") {
		return false
	}
	id, err := uuid.Parse(raw)
	return err == nil && id.String() == raw
}
