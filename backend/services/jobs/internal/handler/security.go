package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
)

type Verifier interface {
	Verify(context.Context, string) (*oidc.IDToken, error)
}

// identityKey and the verified identity live in identity.go.

// rolesKey carries the verified realm roles from Authorize to the route guards
// below, so a route whose policy is narrower than "any declared role" decides
// without verifying the token a second time. A client-supplied role header is
// never consulted; the gateway deletes it before proxying anything.
type rolesKey struct{}

// rolesFrom returns the verified roles Authorize placed on the request context.
// An unauthenticated request carries none, and no route reads it before the gate.
func rolesFrom(ctx context.Context) []string {
	roles, _ := ctx.Value(rolesKey{}).([]string)
	return roles
}

// holdsTacticalRole reports whether a verified role set holds analista or admin,
// the two roles the ratified D-C matrix grants the evaluation and job-dispatch
// routes. It scans the WHOLE list on purpose: the order of realm_access.roles
// belongs to the identity provider, so the answer is membership in the set and
// never the first interesting element in it.
func holdsTacticalRole(roles []string) bool {
	for _, role := range roles {
		if role == "analista" || role == "admin" {
			return true
		}
	}
	return false
}

// requireTactical admits the two roles that dispatch work — analista and admin —
// and answers the documented 403 to a viewer before any store call, which is a
// permission decision and never a storage one. Authorize has already verified the
// token and stored the roles, so this guard neither re-verifies nor admits an
// unauthenticated request: its 401 runs first.
func requireTactical(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !holdsTacticalRole(rolesFrom(r.Context())) {
			fail(w, http.StatusForbidden, "forbidden")
			return
		}
		next(w, r)
	}
}

// Authorize is the authentication middleware of this service. The Authorization
// header must carry a Bearer token that verifies against the configured issuer and
// audience, must be a bearer token with a live not-before, and must hold one of
// the three roles the ratified D-C matrix declares: viewer, analista or admin.
//
// Reads are open to all three; dispatching work is narrower and lives in the
// routes themselves through requireTactical, so a viewer gets 403 (authorised but
// not permitted) instead of 401 on a route they may read. A role the realm does
// not declare — `operator`, for instance — is refused here with 403.
func Authorize(verifier Verifier, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Fields(r.Header.Get("Authorization"))
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
			fail(w, 401, "unauthorized")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		token, err := verifier.Verify(ctx, parts[1])
		if err != nil || token.Subject == "" {
			fail(w, 401, "unauthorized")
			return
		}
		// verifiedClaims reads the signed claims of the already-verified token. The
		// subject is authenticated; the name fields are the only source of the audit
		// actor name, and a token that asserts none stays nameless: the opaque subject
		// is never a name candidate, so the store records NULL instead of a false name.
		// The Bearer type, not-before policy and claims decode stay checked here.
		claims, ok := verifiedClaims(token)
		if !ok || claims.Type != "Bearer" || claims.NotBefore > time.Now().Unix() {
			fail(w, 401, "unauthorized")
			return
		}
		// The three declared roles of the realm are the whole vocabulary. Membership
		// decides, so a token listing viewer before analista keeps its rights, and an
		// undeclared role is refused 403 without the token ever reaching a route.
		if !holdsDeclaredRole(claims.Realm.Roles) {
			fail(w, 403, "forbidden")
			return
		}
		authorized := context.WithValue(r.Context(), identityKey{}, identity{subject: token.Subject, name: displayName(claims)})
		authorized = context.WithValue(authorized, rolesKey{}, claims.Realm.Roles)
		next.ServeHTTP(w, r.WithContext(authorized))
	})
}

// holdsDeclaredRole reports whether the verified token carries at least one of the
// three roles the ratified matrix declares.
func holdsDeclaredRole(roles []string) bool {
	for _, role := range roles {
		if role == "viewer" || role == "analista" || role == "admin" {
			return true
		}
	}
	return false
}

func respond(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func fail(w http.ResponseWriter, status int, code string) {
	writeError(w, status, code)
}
