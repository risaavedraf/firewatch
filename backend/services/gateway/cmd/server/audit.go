package main

// The query recorder's database half.
//
// It holds the one credential this gateway has to a database, and that credential
// is a dedicated insert-only principal: audit_query_app may execute one function
// and nothing else (services/jobs/migrations/006_query_audit_writer.sql). The
// function fixes event_kind='query', leaves job_id NULL and chooses the stored
// detail sentence from a closed set, so this surface cannot write a mutation and
// cannot store a caller-supplied label.
//
// The gateway writes to the jobs database directly instead of calling an endpoint
// because there is no endpoint to call: the audit trail is append-only and must
// not gain a public write route for the sake of one internal writer.

import (
	"context"
	"errors"
	"fmt"
	"time"

	"firewatch.local/gateway/internal/handler"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// auditDatabaseURLEnv names the DSN of that principal. It is required, never
// optional: an unset value stops startup instead of turning the recorded reads
// into silent successes, and the value itself is never logged.
const auditDatabaseURLEnv = "AUDIT_DATABASE_URL"

// recordQuerySQL is the entire write surface of this gateway. The casts pin the
// parameter types so a change in the function's signature fails here at the first
// call instead of being inferred into something else.
const recordQuerySQL = `SELECT public.audit_record_query($1::text, $2::text, $3::text, $4::text)`

// queryAuditStore implements handler.QueryRecorder against that function.
type queryAuditStore struct{ pool *pgxpool.Pool }

// RecordQuery writes one recorded read and returns the writer's error untouched
// in kind, so the transport can answer 503 storage_unavailable instead of
// forwarding a success nobody recorded.
func (s queryAuditStore) RecordQuery(ctx context.Context, record handler.QueryRecord) error {
	var id int64
	if err := s.pool.QueryRow(ctx, recordQuerySQL, record.ActorID, record.ActorName, record.Action, record.TraceID).Scan(&id); err != nil {
		return recordFailure(err)
	}
	return nil
}

// Close releases the pool on shutdown. A nil pool is a store that was never
// built, which the caller cannot reach because startup refuses without a DSN.
func (s queryAuditStore) Close() {
	if s.pool != nil {
		s.pool.Close()
	}
}

// recordFailure keeps the cause of a failed write without copying the server's
// message into the process log. PostgreSQL quotes the offending row in several
// messages (a CHECK violation names every column value), and that row carries the
// actor and the trace id: they belong in the trail, not in a log line.
func recordFailure(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return fmt.Errorf("audit writer rejected the record: sqlstate %s constraint %q", pgErr.Code, pgErr.ConstraintName)
	}
	return fmt.Errorf("audit writer unavailable: %T", err)
}

// newQueryAuditStore builds the pool the recorder writes through. The pool is
// lazy on purpose: an audit database that is briefly unavailable must not stop a
// gateway from serving the routes that record nothing, and the recorded reads are
// answered 503 until it answers again. The credential is still required at
// startup, and the transport rule below still applies, so a deployment can never
// fall back to unrecorded audited reads by omission.
func newQueryAuditStore(raw, environment string) (queryAuditStore, error) {
	if raw == "" {
		return queryAuditStore{}, fmt.Errorf("%s is required: the gateway records the selected business reads through the narrow audit writer", auditDatabaseURLEnv)
	}
	config, err := pgxpool.ParseConfig(raw)
	if err != nil {
		return queryAuditStore{}, fmt.Errorf("invalid %s", auditDatabaseURLEnv)
	}
	if err = requireAuditDatabaseTLS(config, environment); err != nil {
		return queryAuditStore{}, err
	}
	// Two connections are enough for one insert per recorded read, and no minimum
	// keeps an idle replica from holding a database session it never uses.
	config.MaxConns = 2
	config.MinConns = 0
	config.ConnConfig.ConnectTimeout = 5 * time.Second
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		return queryAuditStore{}, fmt.Errorf("audit database setup failed: %w", err)
	}
	return queryAuditStore{pool: pool}, nil
}

// requireAuditDatabaseTLS refuses a DSN that does not both encrypt and
// authenticate outside development, exactly as the services refuse their own. The
// rules are stated here rather than shared because this binary owns its transport
// decision: sslmode=prefer/allow keep a plaintext fallback, and sslmode=require
// encrypts without proving who answered, so only verify-full passes.
func requireAuditDatabaseTLS(config *pgxpool.Config, environment string) error {
	if environment == "development" {
		return nil
	}
	for _, fallback := range config.ConnConfig.Fallbacks {
		if fallback.TLSConfig == nil {
			return fmt.Errorf("%s must not fall back to a plaintext connection outside development", auditDatabaseURLEnv)
		}
	}
	if config.ConnConfig.TLSConfig == nil {
		return fmt.Errorf("%s must require TLS outside development", auditDatabaseURLEnv)
	}
	if config.ConnConfig.TLSConfig.InsecureSkipVerify {
		return fmt.Errorf("%s must verify the server certificate outside development", auditDatabaseURLEnv)
	}
	return nil
}
