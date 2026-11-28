package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	plaintextDatabaseURL = "postgres://user:pass@db:5432/x?sslmode=disable"
	// verify-full is the only mode that both encrypts and authenticates the server,
	// so it is the only URL these tests may treat as acceptable outside development.
	encryptedDatabaseURL = "postgres://user:pass@db:5432/x?sslmode=verify-full"
	// sslmode=require encrypts without checking who answered, and sslmode=prefer
	// keeps a plaintext fallback. Both look encrypted at a glance and are not.
	unauthenticatedDatabaseURL = "postgres://user:pass@db:5432/x?sslmode=require"
	fallbackDatabaseURL        = "postgres://user:pass@db:5432/x?sslmode=prefer"
	plaintextBrokerURL         = "amqp://user:pass@broker:5672/firewatch"
	encryptedBrokerURL         = "amqps://user:pass@broker:5671/firewatch"
	unverifiedBrokerURL        = "amqps://user:pass@broker:5671/firewatch?verify=verify_none"

	tlsGuardMessage    = "DATABASE_URL must require TLS outside development"
	tlsFallbackMessage = "DATABASE_URL must not fall back to a plaintext connection outside development"
	tlsVerifyMessage   = "DATABASE_URL must verify the server certificate outside development"
	amqpsGuardMessage  = "AMQP_URL must use amqps outside development"
	verifyGuardMessage = "AMQP_URL must not disable certificate verification outside development"
)

// databaseConfigFor builds the pool configuration from a URL exactly as startup
// does, so the guard is exercised against what pgx derives from sslmode instead
// of a hand-made struct that proves nothing about the parsed value.
func databaseConfigFor(t *testing.T, databaseURL string) *pgxpool.Config {
	t.Helper()
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatalf("parse %q: %v", databaseURL, err)
	}
	return config
}

// assertGuardResult states the observable contract of every guard in this file:
// either it accepts the configuration or it refuses it with exactly the message
// the operator will read. An empty want means the guard must accept.
func assertGuardResult(t *testing.T, err error, want string) {
	t.Helper()
	if want == "" {
		if err != nil {
			t.Fatalf("the guard refused a configuration it must accept: %v", err)
		}
		return
	}
	if err == nil {
		t.Fatalf("the guard accepted a configuration it must refuse, want %q", want)
	}
	if err.Error() != want {
		t.Fatalf("the guard refused with %q, want %q", err.Error(), want)
	}
}

// TestRequireTLSOutsideDevelopment pins the database rule: a URL that negotiates
// no TLS is a plaintext connection, and the only exception is the literal
// environment value "development". An unset or differently spelled value has to
// fail closed, because that spelling is what a deployment gets wrong.
func TestRequireTLSOutsideDevelopment(t *testing.T) {
	for _, tc := range []struct {
		name        string
		environment string
		databaseURL string
		want        string
	}{
		{name: "plaintext outside development", environment: "production", databaseURL: plaintextDatabaseURL, want: tlsGuardMessage},
		{name: "verified tls outside development", environment: "production", databaseURL: encryptedDatabaseURL},
		// Encrypted but unauthenticated, and encrypted with a way out: both are
		// refusals, because either one lets an active attacker succeed.
		{name: "require without verification outside development", environment: "production", databaseURL: unauthenticatedDatabaseURL, want: tlsVerifyMessage},
		{name: "prefer with a plaintext fallback outside development", environment: "production", databaseURL: fallbackDatabaseURL, want: tlsFallbackMessage},
		{name: "plaintext in development", environment: "development", databaseURL: plaintextDatabaseURL},
		{name: "plaintext with an unset environment", environment: "", databaseURL: plaintextDatabaseURL, want: tlsGuardMessage},
		{name: "the development exception is not case-insensitive", environment: "Development", databaseURL: plaintextDatabaseURL, want: tlsGuardMessage},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assertGuardResult(t, requireTLSOutsideDevelopment(databaseConfigFor(t, tc.databaseURL), tc.environment), tc.want)
		})
	}
}

// TestRequireSecureBrokerURL pins the broker rule, including the "do not verify"
// switch: amqps with verification disabled protects nothing against an active
// attacker, so it is refused wherever plaintext is refused.
func TestRequireSecureBrokerURL(t *testing.T) {
	for _, tc := range []struct {
		name        string
		environment string
		brokerURL   string
		want        string
	}{
		{name: "plaintext outside development", environment: "production", brokerURL: plaintextBrokerURL, want: amqpsGuardMessage},
		{name: "amqps outside development", environment: "production", brokerURL: encryptedBrokerURL},
		{name: "plaintext in development", environment: "development", brokerURL: plaintextBrokerURL},
		{name: "plaintext with an unset environment", environment: "", brokerURL: plaintextBrokerURL, want: amqpsGuardMessage},
		{name: "the development exception is not case-insensitive", environment: "Development", brokerURL: plaintextBrokerURL, want: amqpsGuardMessage},
		{name: "verification disabled outside development", environment: "production", brokerURL: unverifiedBrokerURL, want: verifyGuardMessage},
		{name: "verification disabled in development", environment: "development", brokerURL: unverifiedBrokerURL},
		{name: "unparsable URL outside development", environment: "production", brokerURL: "amqps://user:pass@broker:5671/%zz", want: amqpsGuardMessage},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assertGuardResult(t, requireSecureBrokerURL(tc.brokerURL, tc.environment), tc.want)
		})
	}
}

// TestRunRefusesPlaintextDatabaseOutsideDevelopment pins the wiring, not only
// the guard: the process stops on DATABASE_URL before it opens the pool, so a
// production start cannot reach a connection attempt. The address is a closed
// loopback port, so even a run that got as far as the pool fails immediately
// instead of reaching for a database that might exist.
func TestRunRefusesPlaintextDatabaseOutsideDevelopment(t *testing.T) {
	t.Setenv("APP_ENV", "production")
	t.Setenv("DATABASE_URL", "postgres://user:pass@127.0.0.1:1/x?sslmode=disable")
	t.Setenv("AMQP_URL", encryptedBrokerURL)
	assertGuardResult(t, run(), tlsGuardMessage)
}

// TestStartupBrokerURLRefusesPlaintextOutsideDevelopment pins the broker guard to
// the read the worker is built from. The migrate path returns before this read,
// which is what keeps a migration job that holds only DATABASE_URL working.
func TestStartupBrokerURLRefusesPlaintextOutsideDevelopment(t *testing.T) {
	t.Setenv("AMQP_URL", plaintextBrokerURL)
	_, err := startupBrokerURL("production")
	assertGuardResult(t, err, amqpsGuardMessage)
}

// The three messages the operator can read, and the paths the guard is given.
// Naming the variable is the point: an operator with a half-mounted secret must
// not have to guess which half is missing.
const (
	certMissingOutsideDevelopment = "TLS_CERT_FILE is required outside development: set TLS_CERT_FILE and TLS_KEY_FILE, or run with APP_ENV=development for plaintext"
	certMissingForConfiguredKey   = "TLS_CERT_FILE is required when TLS_KEY_FILE is set"
	keyMissingForConfiguredCert   = "TLS_KEY_FILE is required when TLS_CERT_FILE is set"
	// Any path works here: the guard decides from the strings alone, and the
	// listener is the only place that opens the files.
	certPath = "/mnt/tls/tls.crt"
	keyPath  = "/mnt/tls/tls.key"
)

// TestRequireListenerTLS pins T7.2's inbound half of the crossing contract: a
// configured key pair serves TLS; no key pair keeps the plaintext of development
// and nothing else; every other combination refuses to start and names the
// variable that is missing, including a half pair in development.
func TestRequireListenerTLS(t *testing.T) {
	for _, tc := range []struct {
		name        string
		environment string
		certFile    string
		keyFile     string
		want        string
	}{
		{name: "key pair outside development", environment: "staging", certFile: certPath, keyFile: keyPath},
		{name: "key pair in production", environment: "production", certFile: certPath, keyFile: keyPath},
		{name: "key pair in development", environment: "development", certFile: certPath, keyFile: keyPath},
		{name: "no key pair in development", environment: "development"},
		{name: "no key pair outside development", environment: "staging", want: certMissingOutsideDevelopment},
		{name: "no key pair with an unset environment", want: certMissingOutsideDevelopment},
		{name: "the development exception is not case-insensitive", environment: "Development", want: certMissingOutsideDevelopment},
		{name: "certificate without a key outside development", environment: "staging", certFile: certPath, want: keyMissingForConfiguredCert},
		{name: "key without a certificate outside development", environment: "staging", keyFile: keyPath, want: certMissingForConfiguredKey},
		{name: "certificate without a key in development", environment: "development", certFile: certPath, want: keyMissingForConfiguredCert},
		{name: "key without a certificate in development", environment: "development", keyFile: keyPath, want: certMissingForConfiguredKey},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assertGuardResult(t, requireListenerTLS(tc.environment, tc.certFile, tc.keyFile), tc.want)
		})
	}
}

// TestStartupListenerTLSTakesTheDecisionFromTheEnvironment pins the wiring, not
// only the guard: startup reads the two variables, and the values it accepts are
// exactly the ones handed to the listener.
func TestStartupListenerTLSTakesTheDecisionFromTheEnvironment(t *testing.T) {
	t.Setenv(tlsCertFileEnv, certPath)
	t.Setenv(tlsKeyFileEnv, keyPath)
	cert, key, err := startupListenerTLS("staging")
	if err != nil || cert != certPath || key != keyPath {
		t.Fatalf("configured key pair = %q, %q, %v", cert, key, err)
	}
	t.Setenv(tlsCertFileEnv, "")
	t.Setenv(tlsKeyFileEnv, "")
	if _, _, err = startupListenerTLS("production"); err == nil || !strings.Contains(err.Error(), tlsCertFileEnv) {
		t.Fatalf("startup outside development without TLS = %v, want a refusal naming %s", err, tlsCertFileEnv)
	}
	// The development plaintext case is the only accepted one that serves without
	// a key pair, and it resolves to no certificate and no key.
	if cert, key, err = startupListenerTLS("development"); err != nil || cert != "" || key != "" {
		t.Fatalf("development without TLS = %q, %q, %v", cert, key, err)
	}
}

// TestStartupRootCAsLoadsTheInternalCA pins T7.2's outbound half: no TLS_CA_FILE
// is no pool, so every client keeps the system roots it uses today, and a
// configured bundle is loaded from disk. A bundle that cannot be trusted is a
// refusal that names the variable, never a silent fall back to the system roots.
func TestStartupRootCAsLoadsTheInternalCA(t *testing.T) {
	t.Setenv(tlsCAFileEnv, "")
	if pool, err := startupRootCAs(); err != nil || pool != nil {
		t.Fatalf("no CA = %v, %v; want no pool and the system roots", pool, err)
	}
	_, _, caFile := testKeyPair(t)
	t.Setenv(tlsCAFileEnv, caFile)
	if pool, err := startupRootCAs(); err != nil || pool == nil {
		t.Fatalf("configured CA = %v, %v; want a loaded pool", pool, err)
	}
	dir := t.TempDir()
	blank := filepath.Join(dir, "blank.crt")
	if err := os.WriteFile(blank, []byte("not a certificate"), 0o600); err != nil {
		t.Fatalf("write blank bundle: %v", err)
	}
	for _, tc := range []struct{ name, path string }{
		{"missing file", filepath.Join(dir, "absent.crt")},
		{"bundle without a certificate", blank},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(tlsCAFileEnv, tc.path)
			_, err := startupRootCAs()
			if err == nil || !strings.Contains(err.Error(), tlsCAFileEnv) {
				t.Fatalf("startup with %s = %v, want a refusal naming %s", tc.path, err, tlsCAFileEnv)
			}
		})
	}
}

// TestNewJWKSClientCarriesTheInternalCA pins the key-set client of T7.2: the
// configured pool is the trust anchor it verifies the issuer with, and without
// TLS_CA_FILE it keeps the system roots behind an explicit TLS configuration with
// the same pinned TLS 1.2 floor, so an unset variable cannot drop the floor.
func TestNewJWKSClientCarriesTheInternalCA(t *testing.T) {
	_, _, caFile := testKeyPair(t)
	t.Setenv(tlsCAFileEnv, caFile)
	pool, err := startupRootCAs()
	if err != nil {
		t.Fatalf("load CA: %v", err)
	}
	client := newJWKSClient(pool)
	transport, ok := client.Transport.(*http.Transport)
	if !ok || transport.TLSClientConfig == nil || transport.TLSClientConfig.RootCAs != pool {
		t.Fatalf("the key-set client does not carry the configured CA: %#v", client.Transport)
	}
	t.Setenv(tlsCAFileEnv, "")
	if pool, err = startupRootCAs(); err != nil {
		t.Fatalf("load no CA: %v", err)
	}
	bare := newJWKSClient(pool)
	bareTransport, ok := bare.Transport.(*http.Transport)
	if !ok || bareTransport.TLSClientConfig == nil {
		t.Fatalf("without TLS_CA_FILE the key-set client carries no explicit TLS configuration, got %#v", bare.Transport)
	}
	if bareTransport.TLSClientConfig.RootCAs != nil || bareTransport.TLSClientConfig.MinVersion != tls.VersionTLS12 {
		t.Fatalf("without TLS_CA_FILE the client must keep the system roots and the pinned floor, got %#v", bareTransport.TLSClientConfig)
	}
	for _, c := range []*http.Client{client, bare} {
		if c.Timeout != 5*time.Second {
			t.Fatalf("key-set client timeout %v, want the 5s bound it always had", c.Timeout)
		}
	}
}

// TestOutboundTLSStatesTheProtocolFloor pins the client floor of the crossing
// contract: the configuration every outbound client of this process verifies with
// names TLS 1.2 as its minimum, so the floor is a decision of this binary instead
// of a default inherited from whichever toolchain built it.
func TestOutboundTLSStatesTheProtocolFloor(t *testing.T) {
	_, _, caFile := testKeyPair(t)
	t.Setenv(tlsCAFileEnv, caFile)
	rootCAs, err := startupRootCAs()
	if err != nil || rootCAs == nil {
		t.Fatalf("the generated CA did not load: %v", err)
	}
	client := newJWKSClient(rootCAs)
	transport, ok := client.Transport.(*http.Transport)
	if !ok || transport.TLSClientConfig == nil {
		t.Fatalf("the key-set client carries no TLS configuration: %#v", client.Transport)
	}
	if got := transport.TLSClientConfig.MinVersion; got != tls.VersionTLS12 {
		t.Fatalf("the outbound TLS minimum version = %#x, want tls.VersionTLS12 (%#x)", got, tls.VersionTLS12)
	}
}

// TestJWKSClientWithoutTLSCAFileKeepsTheSystemRootsAndTheFloor pins the no-CA half
// of the client contract: with no TLS_CA_FILE the key-set client still carries an
// explicit TLS configuration. A nil pool keeps the system roots this process used
// before the internal CA existed, and the TLS 1.2 floor is stated by the repository
// instead of inherited from whichever toolchain built it, so no outbound client of
// this process depends on a default it does not own.
func TestJWKSClientWithoutTLSCAFileKeepsTheSystemRootsAndTheFloor(t *testing.T) {
	client := newJWKSClient(nil)
	transport, ok := client.Transport.(*http.Transport)
	if !ok || transport == nil {
		t.Fatalf("the key-set client without TLS_CA_FILE carries no explicit transport: %#v", client.Transport)
	}
	if transport.TLSClientConfig == nil {
		t.Fatal("the key-set client without TLS_CA_FILE carries no TLS configuration")
	}
	if transport.TLSClientConfig.RootCAs != nil {
		t.Fatalf("the client without TLS_CA_FILE replaced the system roots with %v", transport.TLSClientConfig.RootCAs)
	}
	if got := transport.TLSClientConfig.MinVersion; got != tls.VersionTLS12 {
		t.Fatalf("the outbound TLS minimum version without TLS_CA_FILE = %#x, want tls.VersionTLS12 (%#x)", got, tls.VersionTLS12)
	}
	if client.Timeout != 5*time.Second {
		t.Fatalf("the key-set client timeout = %v, want the 5s bound kept", client.Timeout)
	}
}

// The outcomes the handshake matrix records. They are strings so a failing case
// names the outcome it expected instead of only printing an error.
const (
	handshakeAccepted         = "accepted"
	handshakeUntrustedCA      = "untrusted_ca"
	handshakeExpired          = "expired"
	handshakeHostnameMismatch = "hostname_mismatch"
)

// serviceDNSName is the name the deployment issues as a SAN and the name this
// service's callers dial. The tests reach the listener over loopback, the only
// address this suite needs and the only one it may depend on.
const serviceDNSName = "jobs.firewatch.svc"

// testIssuer is one ephemeral CA generated in memory for a single test run: the
// internal CA TLS_CA_FILE names, or a rogue one that must not be trusted. The
// deployment's CA comes from bootstrap-secrets.sh and never appears in the tree.
type testIssuer struct {
	key  *ecdsa.PrivateKey
	cert *x509.Certificate
}

func newTestIssuer(t *testing.T, commonName string) *testIssuer {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("issuer key: %v", err)
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: commonName},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("issuer certificate: %v", err)
	}
	certificate, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("parse issuer certificate: %v", err)
	}
	return &testIssuer{key: key, cert: certificate}
}

// issueServer signs template with this issuer and writes the leaf as the PEM pair
// TLS_CERT_FILE and TLS_KEY_FILE name, so the listener reads a file and not a
// hand-built certificate. A template whose window is in the past is signed and
// written on purpose: expiry is the client's verification decision, never a reason
// for the listener to refuse to serve what the mount holds.
func (issuer *testIssuer) issueServer(t *testing.T, template *x509.Certificate) (certFile, keyFile string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("server key: %v", err)
	}
	der, err := x509.CreateCertificate(rand.Reader, template, issuer.cert, &key.PublicKey, issuer.key)
	if err != nil {
		t.Fatalf("server certificate: %v", err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatalf("server key encoding: %v", err)
	}
	dir := t.TempDir()
	certFile, keyFile = filepath.Join(dir, "tls.crt"), filepath.Join(dir, "tls.key")
	if err = os.WriteFile(certFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		t.Fatalf("write certificate: %v", err)
	}
	if err = os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}), 0o600); err != nil {
		t.Fatalf("write key: %v", err)
	}
	return certFile, keyFile
}

// bundle writes this issuer's certificate as the PEM bundle TLS_CA_FILE names, so
// the trusted pool is built from a file exactly as startup builds it.
func (issuer *testIssuer) bundle(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "ca.crt")
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: issuer.cert.Raw}), 0o600); err != nil {
		t.Fatalf("write CA bundle: %v", err)
	}
	return path
}

// serverCertificateTemplate is the certificate the deployment issues for this
// service: a leaf for server authentication whose SANs name the Service and the
// loopback address the tests dial. The window is an argument so the expired case
// fixes it in the past inside the test instead of waiting for a clock.
func serverCertificateTemplate(commonName string, dnsNames []string, ipAddresses []net.IP, notBefore, notAfter time.Time) *x509.Certificate {
	return &x509.Certificate{
		SerialNumber:          big.NewInt(2),
		Subject:               pkix.Name{CommonName: commonName},
		NotBefore:             notBefore,
		NotAfter:              notAfter,
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              dnsNames,
		IPAddresses:           ipAddresses,
	}
}

// serveHandshakeCase starts the listener this service serves - listenAndServe, the
// same call run() makes - with the key pair of one case, and returns the loopback
// address it bound.
func serveHandshakeCase(t *testing.T, certFile, keyFile string) string {
	t.Helper()
	// The port is reserved and released before the server binds it, because
	// ListenAndServeTLS takes an address and not a listener.
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve a loopback port: %v", err)
	}
	addr := probe.Addr().String()
	if err = probe.Close(); err != nil {
		t.Fatalf("release the loopback port: %v", err)
	}
	server := &http.Server{
		Addr:              addr,
		Handler:           http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }),
		ReadHeaderTimeout: 5 * time.Second,
	}
	served := make(chan error, 1)
	go func() { served <- listenAndServe(server, certFile, keyFile) }()
	t.Cleanup(func() { _ = server.Close() })
	// Readiness, not verification: this probe skips certificate checks so it
	// completes against every certificate in the matrix. The assertion itself never
	// uses it.
	deadline := time.Now().Add(5 * time.Second)
	for {
		select {
		case err := <-served:
			t.Fatalf("the listener stopped before the handshake case ran: %v", err)
		default:
		}
		conn, err := tls.DialWithDialer(&net.Dialer{Timeout: time.Second}, "tcp", addr, &tls.Config{InsecureSkipVerify: true, MinVersion: tls.VersionTLS12})
		if err == nil {
			_ = conn.Close()
			return addr
		}
		if time.Now().After(deadline) {
			t.Fatalf("the listener never answered on %s: %v", addr, err)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// dialTLS is one real handshake against addr with the configuration under test.
// The configuration is cloned so a case that pins a ServerName cannot reshape the
// one the process builds.
func dialTLS(t *testing.T, config *tls.Config, addr, serverName string) error {
	t.Helper()
	clone := config.Clone()
	if serverName != "" {
		clone.ServerName = serverName
	}
	conn, err := tls.DialWithDialer(&net.Dialer{Timeout: 5 * time.Second}, "tcp", addr, clone)
	if err != nil {
		return err
	}
	return conn.Close()
}

// assertHandshakeRefusal states the contract of a refused case: the handshake
// failed inside certificate verification, with the reason that says why. A failure
// anywhere else - a closed port, a protocol error - would satisfy "err != nil"
// without proving anything about the certificate, which is why the reason is named.
func assertHandshakeRefusal(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil {
		t.Fatalf("the handshake completed, want the %s refusal", want)
	}
	var verification *tls.CertificateVerificationError
	if !errors.As(err, &verification) {
		t.Fatalf("the handshake failed outside certificate verification: %v, want %s", err, want)
	}
	switch want {
	case handshakeUntrustedCA:
		var unknown x509.UnknownAuthorityError
		if !errors.As(verification.Err, &unknown) {
			t.Fatalf("verification failed with %v, want x509.UnknownAuthorityError", verification.Err)
		}
	case handshakeExpired:
		var invalid x509.CertificateInvalidError
		if !errors.As(verification.Err, &invalid) || invalid.Reason != x509.Expired {
			t.Fatalf("verification failed with %v, want x509.CertificateInvalidError with Reason Expired", verification.Err)
		}
	case handshakeHostnameMismatch:
		var hostname x509.HostnameError
		if !errors.As(verification.Err, &hostname) {
			t.Fatalf("verification failed with %v, want x509.HostnameError", verification.Err)
		}
	default:
		t.Fatalf("the case wants %q, which is not a refusal", want)
	}
}

// TestTLSHandshakeVerificationMatrix records the four handshake outcomes the
// transport unit has to demonstrate on a real loopback connection: a certificate
// the internal CA signed whose SAN matches what the client dials is accepted and
// the request reaches the handler; a certificate from a CA outside TLS_CA_FILE, an
// expired certificate and a certificate for another host are all refused with the
// verification error that names why.
//
// Nothing here inspects a struct. Every case writes the CA, the leaf and the key as
// PEM into t.TempDir() - the shape TLS_CA_FILE, TLS_CERT_FILE and TLS_KEY_FILE are
// read in - and then either completes or refuses a TLS handshake.
func TestTLSHandshakeVerificationMatrix(t *testing.T) {
	now := time.Now()
	internalCA, rogueCA := newTestIssuer(t, "firewatch-internal-ca"), newTestIssuer(t, "firewatch-rogue-ca")
	// The pool comes from a PEM bundle through the same startup seam the deployment
	// uses, so the anchor is a file and not a hand-made pool.
	t.Setenv(tlsCAFileEnv, internalCA.bundle(t))
	rootCAs, err := startupRootCAs()
	if err != nil || rootCAs == nil {
		t.Fatalf("the internal CA bundle did not load: %v", err)
	}
	outbound := newOutboundTLSConfig(rootCAs)
	if outbound.InsecureSkipVerify {
		t.Fatal("the outbound configuration disables certificate verification")
	}
	loopback := []net.IP{net.ParseIP("127.0.0.1")}
	matchingSANs := []string{serviceDNSName, "localhost"}

	for _, tc := range []struct {
		name     string
		issuer   *testIssuer
		template *x509.Certificate
		want     string
	}{
		{
			name:     "a certificate from the internal CA matching the SAN is accepted",
			issuer:   internalCA,
			template: serverCertificateTemplate(serviceDNSName, matchingSANs, loopback, now.Add(-time.Hour), now.Add(time.Hour)),
			want:     handshakeAccepted,
		},
		{
			name:     "a certificate from a CA outside TLS_CA_FILE is refused",
			issuer:   rogueCA,
			template: serverCertificateTemplate(serviceDNSName, matchingSANs, loopback, now.Add(-time.Hour), now.Add(time.Hour)),
			want:     handshakeUntrustedCA,
		},
		{
			// The window is fixed in the past here: nothing waits for a real
			// certificate to expire, and nothing depends on the machine's clock
			// beyond the window this case declares.
			name:     "an expired certificate from the internal CA is refused",
			issuer:   internalCA,
			template: serverCertificateTemplate(serviceDNSName, matchingSANs, loopback, now.Add(-2*time.Hour), now.Add(-time.Hour)),
			want:     handshakeExpired,
		},
		{
			name:     "a certificate for another host is refused",
			issuer:   internalCA,
			template: serverCertificateTemplate("other.firewatch.svc", []string{"other.firewatch.svc"}, nil, now.Add(-time.Hour), now.Add(time.Hour)),
			want:     handshakeHostnameMismatch,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			certFile, keyFile := tc.issuer.issueServer(t, tc.template)
			// The listener configuration is built for every case, expired included:
			// the floor it states is part of what this service serves.
			listenerConfig, err := newListenerTLSConfig(certFile, keyFile)
			if err != nil {
				t.Fatalf("the listener configuration did not load the key pair: %v", err)
			}
			if listenerConfig.MinVersion != tls.VersionTLS12 {
				t.Fatalf("the listener minimum version = %#x, want tls.VersionTLS12", listenerConfig.MinVersion)
			}
			addr := serveHandshakeCase(t, certFile, keyFile)
			if tc.want == handshakeAccepted {
				if err := dialTLS(t, outbound, addr, ""); err != nil {
					t.Fatalf("the handshake with a matching certificate failed: %v", err)
				}
				client := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{TLSClientConfig: outbound}}
				response, err := client.Get("https://" + addr + "/")
				if err != nil {
					t.Fatalf("the accepted certificate did not reach the handler: %v", err)
				}
				_ = response.Body.Close()
				if response.StatusCode != http.StatusNoContent {
					t.Fatalf("the handler answered %d, want %d", response.StatusCode, http.StatusNoContent)
				}
				// The SAN the deployment names, dialled by name over loopback: the
				// accepted chain is not accepted only for the IP literal.
				if err := dialTLS(t, outbound, addr, serviceDNSName); err != nil {
					t.Fatalf("the handshake against the SAN %s failed: %v", serviceDNSName, err)
				}
				assertHandshakeRefusal(t, dialTLS(t, outbound, addr, "other.firewatch.svc"), handshakeHostnameMismatch)
				return
			}
			assertHandshakeRefusal(t, dialTLS(t, outbound, addr, ""), tc.want)
			// Both names this case can be dialled by are refused, not only the one the
			// certificate happens to omit.
			if tc.want == handshakeHostnameMismatch {
				assertHandshakeRefusal(t, dialTLS(t, outbound, addr, serviceDNSName), handshakeHostnameMismatch)
			}
			// The differential control: the same certificate, reachable at the same
			// address, completes a handshake with verification switched off. That is
			// what proves the refusal above is the verification decision and not a
			// listener that never answered.
			if err := dialTLS(t, &tls.Config{InsecureSkipVerify: true, MinVersion: tls.VersionTLS12}, addr, ""); err != nil {
				t.Fatalf("the certificate is not even presentable: %v", err)
			}
		})
	}
}

// TestListenerTLSRefusesBelowTheProtocolFloor proves the server floor at handshake
// level: a client capped at TLS 1.1 never completes a handshake with the listener
// this process builds from its key pair, while the same client at the floor does.
func TestListenerTLSRefusesBelowTheProtocolFloor(t *testing.T) {
	now := time.Now()
	issuer := newTestIssuer(t, "firewatch-internal-ca")
	certFile, keyFile := issuer.issueServer(t, serverCertificateTemplate(serviceDNSName, []string{serviceDNSName, "localhost"}, []net.IP{net.ParseIP("127.0.0.1")}, now.Add(-time.Hour), now.Add(time.Hour)))
	addr := serveHandshakeCase(t, certFile, keyFile)
	roots := x509.NewCertPool()
	roots.AddCert(issuer.cert)
	capped := &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS10, MaxVersion: tls.VersionTLS11}
	if err := dialTLS(t, capped, addr, ""); err == nil {
		t.Fatal("a client capped at TLS 1.1 completed a handshake, want the TLS 1.2 floor to refuse it")
	}
	// The positive half pins what actually got negotiated, not only that a dial
	// returned: a client capped at TLS 1.2 must complete on TLS 1.2, so the floor
	// this service states is the version a peer ends up using.
	cappedAt12 := newOutboundTLSConfig(roots)
	cappedAt12.MaxVersion = tls.VersionTLS12
	client := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{TLSClientConfig: cappedAt12}}
	response, err := client.Get("https://" + addr + "/")
	if err != nil {
		t.Fatalf("a client capped at TLS 1.2 was refused: %v", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.TLS == nil || response.TLS.Version != tls.VersionTLS12 {
		t.Fatalf("the negotiated version = %+v, want TLS 1.2 (%#x)", response.TLS, tls.VersionTLS12)
	}
}
