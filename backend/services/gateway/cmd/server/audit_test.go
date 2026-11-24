package main

// The recorder's wiring (PM-10 / V1-P-07, T3 risk item 5).
//
// Three things are pinned here and none of them needs a cluster: the credential is
// required and its transport is guarded, the binary really builds the recording
// transport instead of the one that records nothing, and the store calls exactly
// one function. The insert itself is proved against a disposable PostgreSQL in
// TestQueryAuditStoreWritesThroughTheNarrowWriter, which skips without one.

import (
	"context"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strings"
	"testing"
	"time"

	"firewatch.local/gateway/internal/handler"
)

// TestQueryAuditCredentialIsRequiredAndGuarded proves the deployment cannot end up
// recording nothing by omission, and cannot send a credential that writes the
// trail over an unverified connection.
func TestQueryAuditCredentialIsRequiredAndGuarded(t *testing.T) {
	if _, err := newQueryAuditStore("", "development"); err == nil || !strings.Contains(err.Error(), auditDatabaseURLEnv) {
		t.Fatalf("an unset %s was accepted (%v); the recorded reads must not silently stop being recorded", auditDatabaseURLEnv, err)
	}
	if _, err := newQueryAuditStore("postgres://audit_query_app@postgres:5432/jobs?sslmode=disable", "development"); err != nil {
		t.Fatalf("development refused a plaintext DSN, which is what the local stack uses: %v", err)
	}
	store, err := newQueryAuditStore("postgres://audit_query_app@postgres:5432/jobs?sslmode=disable", "development")
	if err != nil {
		t.Fatal(err)
	}
	store.Close()
	for _, tc := range []struct{ name, dsn, environment string }{
		{"plaintext outside development", "postgres://audit_query_app@postgres:5432/jobs?sslmode=disable", "staging"},
		{"unset mode outside development", "postgres://audit_query_app@postgres:5432/jobs", "production"},
		{"encrypted but unverified", "postgres://audit_query_app@postgres:5432/jobs?sslmode=require", "staging"},
		{"a plaintext fallback", "postgres://audit_query_app@postgres:5432/jobs?sslmode=prefer", "production"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := newQueryAuditStore(tc.dsn, tc.environment); err == nil || !strings.Contains(err.Error(), auditDatabaseURLEnv) {
				t.Fatalf("%s was accepted (%v)", tc.name, err)
			}
		})
	}
	if _, err := newQueryAuditStore("not a dsn", "development"); err == nil || !strings.Contains(err.Error(), "invalid") {
		t.Fatalf("an unparsable DSN was accepted (%v)", err)
	}
}

// TestServerWiresTheRecordingTransport is the guard against the one mistake this
// feature cannot afford: a gateway that starts with the transport which records
// nothing and answers every audited read 200. It reads main.go, because the wiring
// is what it checks and there is no way to observe it without a cluster.
func TestServerWiresTheRecordingTransport(t *testing.T) {
	file, err := parser.ParseFile(token.NewFileSet(), "main.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	wired := false
	ast.Inspect(file, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		selector, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		owner, ok := selector.X.(*ast.Ident)
		if !ok || owner.Name != "handler" {
			return true
		}
		switch selector.Sel.Name {
		case "NewWithQueryRecorder":
			wired = true
		case "New", "NewWithRootCAs":
			t.Errorf("main.go builds the transport with handler.%s, which records no query", selector.Sel.Name)
		}
		return true
	})
	if !wired {
		t.Fatal("main.go never calls handler.NewWithQueryRecorder, so the recorded reads would answer success without a record")
	}
	source, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(source), "newQueryAuditStore(os.Getenv(auditDatabaseURLEnv)") {
		t.Fatal("main.go does not build the audit store from the required DSN")
	}
}

// TestQueryAuditStoreWritesThroughTheNarrowWriter is the database half: one
// recorded read lands as a 'query' row with no job reference, and an action
// outside the closed set is refused by the writer instead of being stored.
func TestQueryAuditStoreWritesThroughTheNarrowWriter(t *testing.T) {
	dsn := os.Getenv("TEST_AUDIT_DATABASE_URL")
	if testing.Short() || dsn == "" {
		t.Skip("requires a migrated disposable jobs database in TEST_AUDIT_DATABASE_URL (audit_query_app)")
	}
	store, err := newQueryAuditStore(dsn, "development")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	record := handler.QueryRecord{ActorID: "subject-1", ActorName: "Demo Admin", Action: "risk.current.read", TraceID: "8f1d0a52-7b3c-4a19-9e21-8a1b2c3d4e5f"}
	if err := store.RecordQuery(ctx, record); err != nil {
		t.Fatalf("the writer refused an eligible read: %v", err)
	}
	// A label the gateway does not send is refused, and the failure keeps the
	// SQLSTATE without carrying the row into the error.
	refused := record
	refused.Action = "job.requested"
	err = store.RecordQuery(ctx, refused)
	if err == nil {
		t.Fatal("the writer accepted a mutation label")
	}
	if !strings.Contains(err.Error(), "22023") {
		t.Fatalf("refusal = %v, want the invalid-parameter SQLSTATE", err)
	}
	if strings.Contains(err.Error(), record.ActorID) || strings.Contains(err.Error(), record.TraceID) {
		t.Fatalf("the refusal quotes the row: %v", err)
	}
}
