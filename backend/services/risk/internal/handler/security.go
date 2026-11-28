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

// rolesContextKey carries the verified realm roles from Authorize to a
// per-route guard, so a route can require admin without verifying the token a
// second time.
type rolesContextKey struct{}

// subjectContextKey carries the verified token subject from Authorize to a route
// that scopes its answer to the caller. It is unexported so only this package can
// attach it: a subject a client could name is not an identity, and the personal
// state routes read it from here rather than from a header, a query or a body.
type subjectContextKey struct{}

// rolesFrom returns the verified roles placed on the request context by
// Authorize. An unauthenticated request carries none.
func rolesFrom(ctx context.Context) []string {
	roles, _ := ctx.Value(rolesContextKey{}).([]string)
	return roles
}

// subjectFrom returns the verified token subject Authorize placed on the request
// context. The boolean is false when the request was not authenticated; a route
// that scopes storage by the subject must refuse rather than fall back to an empty
// key, which would be a shared state every caller could read.
func subjectFrom(ctx context.Context) (string, bool) {
	subject, ok := ctx.Value(subjectContextKey{}).(string)
	return subject, ok && subject != ""
}

// Authorize authenticates the bearer token and admits the viewer, analista and
// admin roles, the closed vocabulary the ratified D-C matrix declares. It stores
// the verified roles on the request context so a route whose policy is narrower
// than "any declared role" wraps itself with requireTactical or requireAdmin
// instead of re-verifying the token.
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
		var claims struct {
			Type      string `json:"typ"`
			NotBefore int64  `json:"nbf"`
			Realm     struct {
				Roles []string `json:"roles"`
			} `json:"realm_access"`
		}
		if token.Claims(&claims) != nil || claims.Type != "Bearer" || claims.NotBefore > time.Now().Unix() {
			fail(w, 401, "unauthorized")
			return
		}
		for _, role := range claims.Realm.Roles {
			if role == "viewer" || role == "analista" || role == "admin" {
				ctx := context.WithValue(r.Context(), rolesContextKey{}, claims.Realm.Roles)
				// The verified subject travels with the same request context as the
				// roles, so a personal route scopes storage to an identity this gate
				// already proved instead of asking the client who it is.
				ctx = context.WithValue(ctx, subjectContextKey{}, token.Subject)
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}
		}
		fail(w, 403, "forbidden")
	})
}

// requireTactical admits the two roles that operate the system: analista and
// admin (ratified D-C, «Operación táctica: evalúa y gestiona acciones, sin
// admin»). It is applied inside the router, after Authorize has already verified
// the token and stored the roles, so it neither re-verifies nor lets an
// unauthenticated request through: Authorize's 401 runs first. A viewer is still
// authorised to read and is refused here with the documented 403, which is a
// permission decision and never a storage one.
//
// The decision is membership in the role set, like requireAdmin below: the order
// of realm_access.roles belongs to the identity provider, so a token that lists
// viewer before analista keeps its tactical rights.
func requireTactical(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		for _, role := range rolesFrom(r.Context()) {
			if role == "analista" || role == "admin" {
				next(w, r)
				return
			}
		}
		fail(w, 403, "forbidden")
	}
}

// requireAdmin admits only the admin role. It is applied inside the router, after
// Authorize has already verified the token and stored the roles, so it neither
// re-verifies nor lets an unauthenticated request through: Authorize's 401 runs
// first.
func requireAdmin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		for _, role := range rolesFrom(r.Context()) {
			if role == "admin" {
				next(w, r)
				return
			}
		}
		fail(w, 403, "forbidden")
	}
}

func respond(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func fail(w http.ResponseWriter, status int, code string) {
	respond(w, status, map[string]string{"code": code, "request_id": w.Header().Get("X-Request-ID")})
}
