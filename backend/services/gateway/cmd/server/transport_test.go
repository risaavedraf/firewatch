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
	"fmt"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// secureUpstreams is the configuration a production gateway must be given; every
// case below starts from it and changes only the value under test, so a failure
// names the upstream that made the hop plaintext.
func secureUpstreams() map[string]string {
	return map[string]string{
		"JOBS_URL":       "https://jobs:8080",
		"RISK_URL":       "https://risk:8080",
		"PREVENTION_URL": "https://prevention:8080",
	}
}

// plaintextUpstreams is the development configuration this guard has to keep
// accepting, because the local stack runs every service over plain HTTP.
func plaintextUpstreams() map[string]string {
	return map[string]string{
		"JOBS_URL":       "http://jobs:8080",
		"RISK_URL":       "http://risk:8090",
		"PREVENTION_URL": "http://prevention:8084",
	}
}

// withUpstream returns the secure set with one value replaced.
func withUpstream(name, value string) map[string]string {
	upstreams := secureUpstreams()
	upstreams[name] = value
	return upstreams
}

// assertGuardResult states the observable contract of the guard: either it
// accepts the configuration or it refuses it with exactly the message the
// operator will read. An empty want means the guard must accept.
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

// TestRequireSecureUpstreams pins the gateway rule: outside development every
// upstream it proxies to must be https, and the refusal names the variable the
// operator has to change. The only exception is the literal "development"; an
// unset or differently spelled environment fails closed.
func TestRequireSecureUpstreams(t *testing.T) {
	for _, tc := range []struct {
		name        string
		environment string
		upstreams   map[string]string
		want        string
	}{
		{name: "https outside development", environment: "production", upstreams: secureUpstreams()},
		{name: "plaintext jobs outside development", environment: "production", upstreams: withUpstream("JOBS_URL", "http://jobs:8080"), want: "JOBS_URL must use https outside development"},
		{name: "plaintext prevention outside development", environment: "production", upstreams: withUpstream("PREVENTION_URL", "http://prevention:8084"), want: "PREVENTION_URL must use https outside development"},
		{name: "every plaintext upstream names the same stable offender", environment: "production", upstreams: plaintextUpstreams(), want: "JOBS_URL must use https outside development"},
		{name: "unparsable upstream outside development", environment: "production", upstreams: withUpstream("RISK_URL", "https://risk:8080/%zz"), want: "RISK_URL must use https outside development"},
		{name: "plaintext in development", environment: "development", upstreams: plaintextUpstreams()},
		{name: "plaintext with an unset environment", environment: "", upstreams: plaintextUpstreams(), want: "JOBS_URL must use https outside development"},
		{name: "the development exception is not case-insensitive", environment: "Development", upstreams: plaintextUpstreams(), want: "JOBS_URL must use https outside development"},
		// An empty upstream never reaches this guard in the running gateway: its
		// own configuration step rejects a missing URL first. Skipping it keeps that
		// message and this guard's scope unchanged.
		{name: "empty upstreams are not refused here", environment: "production", upstreams: map[string]string{"JOBS_URL": "", "RISK_URL": "", "PREVENTION_URL": ""}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assertGuardResult(t, requireSecureUpstreams(tc.environment, tc.upstreams), tc.want)
		})
	}
}

// TestStartupTransportRefusesPlaintextUpstreamsOutsideDevelopment pins the wiring:
// startup reads the upstream variables and returns the refusal, so the process
// stops before the proxy is built and before the listener is opened.
func TestStartupTransportRefusesPlaintextUpstreamsOutsideDevelopment(t *testing.T) {
	t.Setenv("JOBS_URL", "http://jobs:8080")
	t.Setenv("RISK_URL", "https://risk:8080")
	t.Setenv("PREVENTION_URL", "https://prevention:8080")
	assertGuardResult(t, startupTransport("production"), "JOBS_URL must use https outside development")
}

// The three messages the operator can read for the listener. They are the ones
// every service of the deployment emits (odd/tasks/kubernetes-deployment.md,
// L10), so an operator reading two services' logs sees one wording.
const (
	listenerCertMissingOutsideDevelopment = "TLS_CERT_FILE is required outside development: set TLS_CERT_FILE and TLS_KEY_FILE, or run with APP_ENV=development for plaintext"
	listenerCertMissingForConfiguredKey   = "TLS_CERT_FILE is required when TLS_KEY_FILE is set"
	listenerKeyMissingForConfiguredCert   = "TLS_KEY_FILE is required when TLS_CERT_FILE is set"
	// Any path works here: the guard decides from the strings alone, and the
	// listener is the only place that opens the files.
	listenerCertPath = "/etc/tls/tls.crt"
	listenerKeyPath  = "/etc/tls/tls.key"
)

// TestRequireListenerTLS pins the crossing contract of T7.1: a configured key
// pair serves TLS; no key pair keeps the plaintext of development and nothing
// else; every other combination refuses to start and names the variable that is
// missing. A half-configured pair is refused even in development, because a
// mount that lost one half is a configuration error, not a reason to fall back
// to plaintext.
func TestRequireListenerTLS(t *testing.T) {
	for _, tc := range []struct {
		name        string
		environment string
		certFile    string
		keyFile     string
		want        string
	}{
		{name: "key pair outside development", environment: "staging", certFile: listenerCertPath, keyFile: listenerKeyPath},
		{name: "key pair in production", environment: "production", certFile: listenerCertPath, keyFile: listenerKeyPath},
		{name: "key pair in development", environment: "development", certFile: listenerCertPath, keyFile: listenerKeyPath},
		// The development exception is the literal value the local stack sets and
		// only with neither half configured. An unset or differently spelled
		// APP_ENV describes a deployment, and a deployment must not serve plaintext.
		{name: "no key pair in development", environment: "development"},
		{name: "no key pair outside development", environment: "staging", want: listenerCertMissingOutsideDevelopment},
		{name: "no key pair with an unset environment", want: listenerCertMissingOutsideDevelopment},
		{name: "the development exception is not case-insensitive", environment: "Development", want: listenerCertMissingOutsideDevelopment},
		{name: "the development exception does not apply to production", environment: "production", want: listenerCertMissingOutsideDevelopment},
		{name: "certificate without a key outside development", environment: "staging", certFile: listenerCertPath, want: listenerKeyMissingForConfiguredCert},
		{name: "key without a certificate outside development", environment: "staging", keyFile: listenerKeyPath, want: listenerCertMissingForConfiguredKey},
		{name: "certificate without a key in development", environment: "development", certFile: listenerCertPath, want: listenerKeyMissingForConfiguredCert},
		{name: "key without a certificate in development", environment: "development", keyFile: listenerKeyPath, want: listenerCertMissingForConfiguredKey},
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
	t.Setenv(tlsCertFileEnv, listenerCertPath)
	t.Setenv(tlsKeyFileEnv, listenerKeyPath)
	cert, key, err := startupListenerTLS("staging")
	if err != nil || cert != listenerCertPath || key != listenerKeyPath {
		t.Fatalf("configured key pair = %q, %q, %v", cert, key, err)
	}

	t.Setenv(tlsCertFileEnv, "")
	t.Setenv(tlsKeyFileEnv, "")
	if _, _, err := startupListenerTLS("production"); err == nil || !strings.Contains(err.Error(), tlsCertFileEnv) {
		t.Fatalf("startup outside development without TLS = %v, want a refusal naming %s", err, tlsCertFileEnv)
	}

	// The development plaintext case is the only accepted one without a key pair,
	// and it resolves to no certificate and no key.
	cert, key, err = startupListenerTLS("development")
	if err != nil || cert != "" || key != "" {
		t.Fatalf("development without TLS = %q, %q, %v", cert, key, err)
	}
}

// freeAddr reserves and releases a loopback port so a real listener can bind it
// in the same test. The window between the two is what makes this a probe and
// not a reservation, so the serving tests retry instead of assuming the bind
// succeeded on the first attempt.
func freeAddr(t *testing.T) string {
	t.Helper()
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve a loopback port: %v", err)
	}
	addr := probe.Addr().String()
	if err := probe.Close(); err != nil {
		t.Fatalf("release the loopback port: %v", err)
	}
	return addr
}

// TestDevelopmentWithoutTLSKeepsServingPlaintext pins the behaviour that must
// not break: in development with no key pair the gateway still binds and answers
// over plaintext, exactly as it did before the TLS work.
func TestDevelopmentWithoutTLSKeepsServingPlaintext(t *testing.T) {
	certFile, keyFile, err := startupListenerTLS("development")
	if err != nil {
		t.Fatalf("development without TLS = %v, want the plaintext exception", err)
	}
	server := &http.Server{
		Addr:              freeAddr(t),
		Handler:           http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }),
		ReadHeaderTimeout: 5 * time.Second,
	}
	served := make(chan error, 1)
	go func() { served <- listenAndServe(server, certFile, keyFile) }()
	t.Cleanup(func() {
		_ = server.Close()
		<-served
	})

	client := &http.Client{Timeout: time.Second}
	url := "http://" + server.Addr + "/health/live"
	deadline := time.Now().Add(5 * time.Second)
	for {
		response, err := client.Get(url)
		if err == nil {
			_ = response.Body.Close()
			if response.StatusCode != http.StatusNoContent {
				t.Fatalf("plaintext gateway answered %d, want %d", response.StatusCode, http.StatusNoContent)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("the development gateway never answered in the clear: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// TestListenAndServeTakesTheTLSBranchForAConfiguredPair pins that a configured
// pair is served by ListenAndServeTLS: with an unreadable certificate the call
// must return the file error, and a plaintext branch would instead keep serving
// and never report it.
func TestListenAndServeTakesTheTLSBranchForAConfiguredPair(t *testing.T) {
	certFile := filepath.Join(t.TempDir(), "absent.crt")
	server := &http.Server{Addr: freeAddr(t), ReadHeaderTimeout: 5 * time.Second}
	served := make(chan error, 1)
	go func() { served <- listenAndServe(server, certFile, filepath.Join(t.TempDir(), "absent.key")) }()
	t.Cleanup(func() { _ = server.Close() })

	select {
	case err := <-served:
		if err == nil || !strings.Contains(err.Error(), certFile) {
			t.Fatalf("a configured key pair with an absent certificate = %v, want the file error naming %s", err, certFile)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the listener kept serving in the clear instead of taking the TLS branch")
	}
}

// caBundleFromServer writes the certificate a test server presents as the PEM
// bundle TLS_CA_FILE names, inside a fresh temp dir.
func caBundleFromServer(t *testing.T, server *httptest.Server) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "ca.crt")
	bundle := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw})
	if err := os.WriteFile(path, bundle, 0o600); err != nil {
		t.Fatalf("write the CA bundle: %v", err)
	}
	return path
}

// TestStartupRootCAsKeepsSystemRootsWithoutTLSCAFile pins the no-CA case of the
// trust side: no path is no pool, so every outbound client keeps the system
// roots it uses today.
func TestStartupRootCAsKeepsSystemRootsWithoutTLSCAFile(t *testing.T) {
	t.Setenv(tlsCAFileEnv, "")
	pool, err := startupRootCAs()
	if err != nil || pool != nil {
		t.Fatalf("no TLS_CA_FILE = %v, %v; want the system roots", pool, err)
	}
}

// TestStartupRootCAsLoadsTheConfiguredBundle pins the trust side: the PEM named
// by TLS_CA_FILE becomes the pool, and that pool actually vouches for the
// certificate the bundle holds.
func TestStartupRootCAsLoadsTheConfiguredBundle(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))
	defer server.Close()
	t.Setenv(tlsCAFileEnv, caBundleFromServer(t, server))
	pool, err := startupRootCAs()
	if err != nil || pool == nil {
		t.Fatalf("configured TLS_CA_FILE = %v, %v", pool, err)
	}
	if _, err := server.Certificate().Verify(x509.VerifyOptions{Roots: pool, DNSName: "127.0.0.1"}); err != nil {
		t.Fatalf("the loaded pool does not vouch for the bundle it was built from: %v", err)
	}
}

// TestStartupRootCAsNamesTheVariableWhenTheBundleIsUnusable pins the refusal: a
// set-but-unreadable or certificate-free bundle stops startup and names the
// variable, instead of quietly falling back to the system roots.
func TestStartupRootCAsNamesTheVariableWhenTheBundleIsUnusable(t *testing.T) {
	garbage := filepath.Join(t.TempDir(), "ca.crt")
	if err := os.WriteFile(garbage, []byte("not a certificate"), 0o600); err != nil {
		t.Fatalf("write the unusable bundle: %v", err)
	}
	for _, path := range []string{filepath.Join(t.TempDir(), "absent.crt"), garbage} {
		t.Setenv(tlsCAFileEnv, path)
		if pool, err := startupRootCAs(); err == nil || pool != nil || !strings.Contains(err.Error(), tlsCAFileEnv) {
			t.Fatalf("%s = %v, %v; want a refusal naming %s", path, pool, err, tlsCAFileEnv)
		}
	}
}

// TestJWKSClientTrustsOnlyTheConfiguredCA is the negotiation for the outbound
// identity client: given the pool from TLS_CA_FILE it reaches a key endpoint
// whose certificate only that CA vouches for, keeps its five second timeout, and
// without a CA it is exactly the bare client this process used before, which is
// what makes the absence of trust visible instead of silent.
func TestJWKSClientTrustsOnlyTheConfiguredCA(t *testing.T) {
	keys := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"keys":[]}`)
	}))
	defer keys.Close()
	t.Setenv(tlsCAFileEnv, caBundleFromServer(t, keys))
	rootCAs, err := startupRootCAs()
	if err != nil || rootCAs == nil {
		t.Fatalf("configured TLS_CA_FILE = %v, %v", rootCAs, err)
	}

	client := newJWKSClient(rootCAs)
	transport, ok := client.Transport.(*http.Transport)
	if !ok || transport.TLSClientConfig == nil || transport.TLSClientConfig.RootCAs != rootCAs {
		t.Fatalf("the JWKS client does not carry the configured pool: %+v", client.Transport)
	}
	if client.Timeout != 5*time.Second {
		t.Fatalf("the JWKS timeout = %v, want 5s kept", client.Timeout)
	}
	response, err := client.Get(keys.URL)
	if err != nil {
		t.Fatalf("the JWKS client does not trust the CA it was given: %v", err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("the JWKS endpoint answered %d, want %d", response.StatusCode, http.StatusOK)
	}

	bare := newJWKSClient(nil)
	bareTransport, ok := bare.Transport.(*http.Transport)
	if !ok || bareTransport.TLSClientConfig == nil {
		t.Fatalf("the client without a CA carries no explicit TLS configuration: %#v", bare.Transport)
	}
	if bareTransport.TLSClientConfig.RootCAs != nil || bareTransport.TLSClientConfig.MinVersion != tls.VersionTLS12 || bare.Timeout != 5*time.Second {
		t.Fatalf("the client without a CA lost the system roots, the pinned floor or the timeout: %#v, %v", bareTransport.TLSClientConfig, bare.Timeout)
	}
	if _, err := bare.Get(keys.URL); err == nil {
		t.Fatal("the client without a CA trusted a certificate no system root vouches for")
	}
}

// TestOutboundTLSStatesTheProtocolFloor pins the client floor of the crossing
// contract: the configuration every outbound client of this process verifies with
// names TLS 1.2 as its minimum, so the floor is a decision of this binary instead
// of a default inherited from whichever toolchain built it.
func TestOutboundTLSStatesTheProtocolFloor(t *testing.T) {
	keys := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer keys.Close()
	t.Setenv(tlsCAFileEnv, caBundleFromServer(t, keys))
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
const serviceDNSName = "gateway.firewatch.svc"

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
