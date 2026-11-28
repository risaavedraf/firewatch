package directory

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/google/uuid"
)

// realmPath locates the development realm from this package's working dir, the
// same way the risk service's contract tests locate the published OpenAPI
// document: the file a deployment imports is the file these tests read, so the
// realm and the directory this service projects from it cannot drift silently.
var realmPath = filepath.Join("..", "..", "..", "..", "deploy", "local", "firewatch-realm.json")

// realmDocument is the subset of the Keycloak realm import this package reads.
// Only declared shape, never a credential: the password placeholders are read as
// literals and asserted to stay placeholders, so no secret value is needed or
// stored here.
type realmDocument struct {
	Roles struct {
		Realm []struct {
			Name       string `json:"name"`
			Composite  bool   `json:"composite"`
			Composites struct {
				Realm []string `json:"realm"`
			} `json:"composites"`
		} `json:"realm"`
	} `json:"roles"`
	DefaultRole struct {
		Name string `json:"name"`
	} `json:"defaultRole"`
	Users []struct {
		// The `id` field is deliberately NOT decoded here. A Go string field cannot
		// distinguish an omitted `"id"` key from `"id": ""` or `"id": null` — all
		// three collapse into the same zero value — and S1 makes a claim about
		// PRESENCE. The id assertions read the raw document instead, through
		// loadRawRealmUsers below.
		Username          string   `json:"username"`
		FirstName         string   `json:"firstName"`
		LastName          string   `json:"lastName"`
		Email             string   `json:"email"`
		Enabled           bool     `json:"enabled"`
		RealmRoles        []string `json:"realmRoles"`
		ServiceAccountFor string   `json:"serviceAccountClientId"`
		Credentials       []struct {
			Type  string `json:"type"`
			Value string `json:"value"`
		} `json:"credentials"`
	} `json:"users"`
}

func loadRealm(t *testing.T) realmDocument {
	t.Helper()
	raw, err := os.ReadFile(realmPath)
	if err != nil {
		t.Fatalf("read the development realm: %v", err)
	}
	var realm realmDocument
	if err := json.Unmarshal(raw, &realm); err != nil {
		t.Fatalf("the development realm is not valid JSON: %v", err)
	}
	return realm
}

// analystUserID is the exact deterministic identifier S1 pins for `demo-analista`.
//
// It is compared as a literal string, never as "some UUID": the directory keys a
// preventive-action assignment by this value, so the exact bytes are the contract.
// The literal is parsed once in the test as a guard that S1 itself pins something
// the directory can address (a well-formed, non-nil UUID).
const analystUserID = "5b1f9c2e-3a4d-4c8b-9e7f-0a1b2c3d4e5f"

// rawRealmUser is one user entry of the realm import exactly as the document
// carries it: a map whose KEY SET says which fields are present. That is the only
// way a test can tell an absent `id` from a present one holding "" or null, which
// is precisely the asymmetry S1 declares between the new analista account and the
// two pre-existing accounts.
type rawRealmUser = map[string]json.RawMessage

// loadRawRealmUsers reads the same file as the decoded realm, but keeps every user
// as a literal key set. It shares realmPath on purpose: the file a deployment
// imports is the file both readers read.
func loadRawRealmUsers(t *testing.T) []rawRealmUser {
	t.Helper()
	raw, err := os.ReadFile(realmPath)
	if err != nil {
		t.Fatalf("read the development realm: %v", err)
	}
	var document struct {
		Users []rawRealmUser `json:"users"`
	}
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatalf("the development realm has no readable users array: %v", err)
	}
	if len(document.Users) == 0 {
		t.Fatal("the development realm declares no users")
	}
	return document.Users
}

// rawUsersByUsername indexes the raw entries by their declared username, so an
// assertion can name a user the way S1 does.
func rawUsersByUsername(t *testing.T) map[string]rawRealmUser {
	t.Helper()
	byUsername := make(map[string]rawRealmUser)
	for _, user := range loadRawRealmUsers(t) {
		var username string
		if err := json.Unmarshal(user["username"], &username); err != nil || username == "" {
			t.Fatalf("a raw realm user carries no readable username: %v (%s)", err, user["username"])
		}
		byUsername[username] = user
	}
	return byUsername
}

// TestRealmDeclaresTheThreeRatifiedRoles pins S1 of PM-15: the realm declares the
// three application roles the owner ratified (viewer, analista, admin) exactly
// once each, and the composite default role keeps granting only the least
// privilege already proved, so a self-registered account is still a viewer.
func TestRealmDeclaresTheThreeRatifiedRoles(t *testing.T) {
	realm := loadRealm(t)

	names := make([]string, 0, len(realm.Roles.Realm))
	for _, role := range realm.Roles.Realm {
		if slices.Contains(names, role.Name) {
			t.Fatalf("the realm declares %q more than once", role.Name)
		}
		names = append(names, role.Name)
		if role.Composite && role.Name == "default-roles-firewatch" {
			for _, composite := range role.Composites.Realm {
				if composite == "analista" || composite == "admin" {
					t.Fatalf("the default realm role grants %q; a new account must stay a viewer", composite)
				}
			}
			if !slices.Contains(role.Composites.Realm, "viewer") {
				t.Fatal("the default realm role no longer grants viewer")
			}
		}
	}
	for _, want := range []string{"viewer", "analista", "admin"} {
		if !slices.Contains(names, want) {
			t.Fatalf("the realm does not declare the ratified role %q; declared: %v", want, names)
		}
	}

	if realm.DefaultRole.Name != "default-roles-firewatch" {
		t.Fatalf("defaultRole = %q, want default-roles-firewatch", realm.DefaultRole.Name)
	}
}

// TestRealmDeclaresOneDeterministicDemoUserPerRole pins the rest of S1: each of
// the three roles has a demo user the deployment and its smoke checks can sign in
// with, the analista account is fully identified (a stable id, a username, a name
// and an e-mail) and no user holds a role outside the closed vocabulary.
//
// The id asymmetry is deliberate and is asserted here so S1 and this test cannot
// drift: the NEW `demo-analista` account carries a deterministic UUID because the
// directory addresses people by it and a preventive-action assignment persists it,
// while `demo-admin` and `demo-viewer` are the pre-existing accounts exported
// exactly as they were — with no `id` field, which the identity provider fills in
// at import time.
func TestRealmDeclaresOneDeterministicDemoUserPerRole(t *testing.T) {
	realm := loadRealm(t)

	byUsername := map[string]int{}
	for index, user := range realm.Users {
		if user.Username == "" {
			t.Fatalf("user %d has no username", index)
		}
		byUsername[user.Username] = index
		for _, role := range user.RealmRoles {
			if !slices.Contains([]string{"viewer", "analista", "admin"}, role) {
				t.Fatalf("user %q holds %q, which is not a declared application role", user.Username, role)
			}
		}
	}

	// The two accounts that already existed keep exactly the roles they had: this
	// change adds a role, it does not redistribute the proven one.
	assertRoles := func(username string, want ...string) realmDocument {
		t.Helper()
		index, ok := byUsername[username]
		if !ok {
			t.Fatalf("the realm no longer declares the demo user %q", username)
		}
		got := realm.Users[index].RealmRoles
		for _, role := range want {
			if !slices.Contains(got, role) {
				t.Fatalf("user %q does not hold %q; it holds %v", username, role, got)
			}
		}
		return realm
	}
	assertRoles("demo-admin", "admin", "viewer")
	assertRoles("demo-viewer", "viewer")
	assertRoles("demo-analista", "analista")

	index := byUsername["demo-analista"]
	analyst := realm.Users[index]
	// The identifier is checked against the RAW document: the key has to be present
	// and its string has to be the exact one S1 declares. "Some nonzero UUID" would
	// pass a different identifier than the specified one, which is the drift this
	// assertion exists to stop.
	rawByUsername := rawUsersByUsername(t)
	pinned, err := uuid.Parse(analystUserID)
	if err != nil || pinned == uuid.Nil {
		t.Fatalf("the identifier S1 pins is not a usable UUID: %v", err)
	}
	// The pinned literal must also be its own canonical spelling, so the string S1
	// declares and the string the directory would store cannot diverge.
	if pinned.String() != analystUserID {
		t.Fatalf("the identifier S1 pins is not in canonical form: %q", analystUserID)
	}
	rawAnalyst, ok := rawByUsername["demo-analista"]
	if !ok {
		t.Fatal("the raw realm document does not declare demo-analista")
	}
	rawID, hasID := rawAnalyst["id"]
	if !hasID {
		t.Fatalf("demo-analista omits the id key; S1 pins the deterministic identifier %q", analystUserID)
	}
	var analystID string
	if err := json.Unmarshal(rawID, &analystID); err != nil {
		t.Fatalf("demo-analista id is not a JSON string: %s", rawID)
	}
	if analystID != analystUserID {
		t.Fatalf("demo-analista id = %q, want the exact deterministic identifier S1 declares (%q)", analystID, analystUserID)
	}
	for field, value := range map[string]string{
		"firstName": analyst.FirstName,
		"lastName":  analyst.LastName,
		"email":     analyst.Email,
	} {
		if value == "" {
			t.Fatalf("demo-analista has no %s; the directory listing would show an unnamed user", field)
		}
	}
	if !analyst.Enabled {
		t.Fatal("demo-analista is disabled")
	}

	// The two pre-existing accounts keep the shape they were exported with: the `id`
	// KEY is absent. Checking a decoded string for "" would accept `"id": ""` and
	// `"id": null` as "untouched", which is why the assertion reads the raw map and
	// requires !hasID instead.
	for _, username := range []string{"demo-admin", "demo-viewer"} {
		rawUser, ok := rawByUsername[username]
		if !ok {
			t.Fatalf("the raw realm document does not declare the demo user %q", username)
		}
		rawID, hasID := rawUser["id"]
		if hasID {
			t.Fatalf("%s carries an explicit \"id\" key (%s), but S1 keeps the pre-existing accounts exactly as exported and requires !hasID", username, rawID)
		}
	}

	// The password is a deployment placeholder, never a literal: a checked-in
	// credential is a secret in source control, which this repository does not do.
	if len(analyst.Credentials) != 1 {
		t.Fatalf("demo-analista carries %d credentials, want exactly one password", len(analyst.Credentials))
	}
	credential := analyst.Credentials[0]
	if credential.Type != "password" {
		t.Fatalf("demo-analista credential type = %q, want password", credential.Type)
	}
	if credential.Value != "${DEMO_ANALISTA_PASSWORD}" {
		t.Fatalf("demo-analista password = %q, want the deployment placeholder ${DEMO_ANALISTA_PASSWORD}", credential.Value)
	}
}
