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
		for _, role := range claims.Realm.Roles {
			if role == "admin" {
				next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), identityKey{}, identity{subject: token.Subject, name: displayName(claims)})))
				return
			}
		}
		fail(w, 403, "forbidden")
	})
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
