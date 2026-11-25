package handler

// Verified identity helpers. They live beside Authorize because the display name
// they resolve is the only value the audit writer may record as actor_name.

import (
	"context"
	"strings"

	"firewatch.local/jobs/internal/repository"
	"github.com/coreos/go-oidc/v3/oidc"
)

// identity is the verified caller. Name is the display name the provider
// asserted in the signed claims; it is empty when the token carried none, and it
// is never synthesized from the subject.
type identity struct {
	subject string
	name    string
}

type identityKey struct{}

// tokenClaims is the subset of the verified token this service reads. The name
// claims are mapped from the provider's profile scope; a token without them
// leaves the audit name NULL instead of inventing one.
type tokenClaims struct {
	Type              string `json:"typ"`
	NotBefore         int64  `json:"nbf"`
	Name              string `json:"name"`
	PreferredUsername string `json:"preferred_username"`
	GivenName         string `json:"given_name"`
	FamilyName        string `json:"family_name"`
	Realm             struct {
		Roles []string `json:"roles"`
	} `json:"realm_access"`
}

// verifiedClaims parses the signed claims of a token the verifier already
// accepted. A decode failure is the only failure reported here; the Bearer and
// not-before policy stay in Authorize so the rejection path is unchanged.
func verifiedClaims(token *oidc.IDToken) (tokenClaims, bool) {
	var claims tokenClaims
	if token.Claims(&claims) != nil {
		return tokenClaims{}, false
	}
	return claims, true
}

// displayName resolves the one display name the verified claims assert. The full
// name wins, then the preferred username, then the given/family pair. An absent
// or blank claim yields "" so the caller stores NULL; the subject is never a
// candidate because an opaque identifier is not a name.
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

// identityFrom returns the verified identity the Authorize middleware attached.
// A missing value is the zero identity; the middleware is the only writer and
// every routed handler runs behind it.
func identityFrom(ctx context.Context) identity {
	value, _ := ctx.Value(identityKey{}).(identity)
	return value
}

// actorFromContext converts the verified identity into the store's Actor. The
// display name is whatever the signed claims asserted; no request header or body
// field can add or replace it.
func actorFromContext(ctx context.Context) repository.Actor {
	verified := identityFrom(ctx)
	return repository.Actor{ID: verified.subject, Name: verified.name}
}
