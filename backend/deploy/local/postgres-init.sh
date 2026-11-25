#!/bin/sh
# Roles and databases of a *fresh* local cluster. This file only runs on the
# first start of an empty volume, which is why it is not the way an existing
# database gains the query recorder's role: that is the migration's job
# (services/jobs/migrations/006_query_audit_writer.sql), which creates
# audit_query_app NOLOGIN, closes the trail to it and grants the one function it
# may execute. What is provisioning's, and must never be a file in this
# repository, is the credential: that is what the audit_query_app lines below set.
set -eu
psql --username "$POSTGRES_USER" --dbname postgres -v ON_ERROR_STOP=1 \
  -v jobs_password="$JOBS_DB_PASSWORD" -v risk_password="$RISK_DB_PASSWORD" \
  -v audit_password="$AUDIT_DB_PASSWORD" \
  -v identity_password="$KEYCLOAK_DB_PASSWORD" <<'SQL'
CREATE ROLE jobs_app LOGIN PASSWORD :'jobs_password';
CREATE ROLE risk_app LOGIN PASSWORD :'risk_password';
CREATE ROLE identity_app LOGIN PASSWORD :'identity_password';
-- The gateway's query recorder. It is created with a way to log in and nothing
-- to run: every privilege it holds is granted by the jobs migrations.
CREATE ROLE audit_query_app LOGIN PASSWORD :'audit_password';
CREATE DATABASE jobs;
CREATE DATABASE risk;
CREATE DATABASE jobs_test;
CREATE DATABASE risk_test;
CREATE DATABASE identity OWNER identity_app;
REVOKE CONNECT ON DATABASE jobs FROM PUBLIC;
REVOKE CONNECT ON DATABASE risk FROM PUBLIC;
REVOKE CONNECT ON DATABASE jobs_test FROM PUBLIC;
REVOKE CONNECT ON DATABASE risk_test FROM PUBLIC;
REVOKE CONNECT ON DATABASE identity FROM PUBLIC;
GRANT CONNECT ON DATABASE jobs TO jobs_app;
-- Only the jobs database: the audit trail lives there, and a second database
-- would be a second place the same credential could write to.
GRANT CONNECT ON DATABASE jobs TO audit_query_app;
GRANT CONNECT ON DATABASE risk TO risk_app;
GRANT CONNECT ON DATABASE jobs_test TO jobs_app;
GRANT CONNECT ON DATABASE risk_test TO risk_app;
SQL
psql --username "$POSTGRES_USER" --dbname jobs -v ON_ERROR_STOP=1 <<'SQL'
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO jobs_app;
GRANT USAGE ON SCHEMA public TO audit_query_app;
SQL
psql --username "$POSTGRES_USER" --dbname risk -v ON_ERROR_STOP=1 <<'SQL'
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO risk_app;
SQL
