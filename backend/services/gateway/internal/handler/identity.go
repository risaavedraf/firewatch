package handler

// Verified identity helpers. They live beside the query recorder for the same
// reason the jobs service keeps its own copy next to its writer: the subject and
// the display name they resolve are the only identity values an audit row may
// carry, and nothing the caller writes may add or replace them.
//
// There is no shared package with the services on purpose. Every service of this
// deployment owns its own identity policy (the repository duplicates those guards
// deliberately), and the gateway is a separate module: importing one service's
// internal package here would couple two deployables that are built alone.

import (
	"strings"

	"github.com/coreos/go-oidc/v3/oidc"
)

// tokenClaims is the subset of a verified token this package reads: the display
// claims the provider signs for the profile scope. A token without them leaves
// the recorded name empty, and the audit store keeps NULL rather than deriving a
// name from the opaque subject.
type tokenClaims struct {
	Name              string `json:"name"`
	PreferredUsername string `json:"preferred_username"`
	GivenName         string `json:"given_name"`
	FamilyName        string `json:"family_name"`
}

// verifiedActor converts a token the verifier already accepted into the actor a
// query record carries.
//
// A claim set that cannot be decoded is not an authentication failure: the token
// itself was verified before this point, and rejecting the request here would
// turn an optional display name into a new way to be locked out. The name is
// simply empty and the store records the subject alone.
func verifiedActor(token *oidc.IDToken) (actorID, actorName string) {
	if token == nil {
		return "", ""
	}
	var claims tokenClaims
	if err := token.Claims(&claims); err != nil {
		return token.Subject, ""
	}
	return token.Subject, displayName(claims)
}

// displayName resolves the one display name the verified claims assert. The full
// name wins, then the preferred username, then the given/family pair. An absent or
// blank claim yields "" so the store keeps NULL; the subject is never a candidate,
// because an opaque identifier is not a name.
func displayName(claims tokenClaims) string {
	for _, candidate := range []string{
		claims.Name,
		claims.PreferredUsername,
		claims.GivenName + " " + claims.FamilyName,
	} {
		if name := strings.TrimSpace(candidate); name != "" {
			return name
		}
	}
	return ""
}
