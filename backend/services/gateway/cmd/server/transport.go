package main

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"sort"
	"time"

	"firewatch.local/gateway/internal/handler"
)

// requireSecureUpstreams refuses plaintext service-to-service hops outside
// development. The gateway is the one place that knows every upstream name.
func requireSecureUpstreams(environment string, upstreams map[string]string) error {
	// Same exception as the OIDC URL checks: the literal value "development" and
	// nothing else, so an unset or differently spelled APP_ENV fails closed.
	if environment == "development" {
		return nil
	}
	names := make([]string, 0, len(upstreams))
	for name := range upstreams {
		names = append(names, name)
	}
	// A map has no order, but the operator reads one message: sorting keeps the
	// named offender stable across replicas of the same misconfigured deployment.
	sort.Strings(names)
	for _, name := range names {
		raw := upstreams[name]
		// An empty upstream never reaches this guard in the running gateway: its own
		// configuration step rejects a missing URL first. Skipping it keeps that
		// message and this guard's scope unchanged.
		if raw == "" {
			continue
		}
		parsed, err := url.Parse(raw)
		if err != nil || parsed.Scheme != "https" {
			return fmt.Errorf("%s must use https outside development", name)
		}
	}
	return nil
}

// startupTransport reads the upstream variables and refuses a plaintext hop
// before the proxy is built. It is the seam run() calls, so the refusal is
// testable without a token issuer, an upstream or a listener.
func startupTransport(environment string) error {
	return requireSecureUpstreams(environment, map[string]string{
		"JOBS_URL":       os.Getenv("JOBS_URL"),
		"RISK_URL":       os.Getenv("RISK_URL"),
		"PREVENTION_URL": os.Getenv("PREVENTION_URL"),
	})
}

// The listener's crossing contract is the one every service of the deployment
// shares (odd/tasks/kubernetes-deployment.md, L10): a PEM key pair in these two
// variables turns the listener into TLS, and outside the development exception
// plaintext is refused. There is no shared package on purpose; the repository
// duplicates this guard per service so each binary owns its own transport
// decision. TLS_CA_FILE is the same contract's outbound half: the internal CA
// the proxy and the key-set client trust.
const (
	tlsCertFileEnv = "TLS_CERT_FILE"
	tlsKeyFileEnv  = "TLS_KEY_FILE"
	tlsCAFileEnv   = "TLS_CA_FILE"
)

// requireListenerTLS decides how the listener is served. Both halves present is
// TLS. Neither half present is the plaintext of development and nothing else: an
// unset or differently spelled APP_ENV describes a deployment, and a deployment
// must not serve in the clear. A half-configured pair is refused even in
// development, because a mount that lost one half is a configuration error, not a
// reason to fall back to plaintext.
func requireListenerTLS(environment, certFile, keyFile string) error {
	if certFile != "" && keyFile != "" {
		return nil
	}
	// The exception is the literal value the local stack sets, matched the same way
	// the OIDC and database guards match it.
	if certFile == "" && keyFile == "" && environment == "development" {
		return nil
	}
	// The operator needs the name of the missing half, so a pair with neither half
	// names both instead of only the first one checked.
	if certFile == "" && keyFile == "" {
		return fmt.Errorf(
			"%s is required outside development: set %s and %s, or run with APP_ENV=development for plaintext",
			tlsCertFileEnv, tlsCertFileEnv, tlsKeyFileEnv,
		)
	}
	if certFile == "" {
		return fmt.Errorf("%s is required when %s is set", tlsCertFileEnv, tlsKeyFileEnv)
	}
	return fmt.Errorf("%s is required when %s is set", tlsKeyFileEnv, tlsCertFileEnv)
}

// startupListenerTLS reads the two variables and returns the key pair the
// listener must serve. It is the seam run() calls, so the decision is testable
// without binding a port or mounting a certificate.
func startupListenerTLS(environment string) (certFile, keyFile string, err error) {
	certFile, keyFile = os.Getenv(tlsCertFileEnv), os.Getenv(tlsKeyFileEnv)
	if err := requireListenerTLS(environment, certFile, keyFile); err != nil {
		return "", "", err
	}
	return certFile, keyFile, nil
}

// listenAndServe binds the only listener this service has. A configured pair is
// served with ListenAndServeTLS; the plaintext branch is reachable only after
// requireListenerTLS accepted the development exception, because the key pair it
// returns is the one this function receives.
func listenAndServe(server *http.Server, certFile, keyFile string) error {
	if certFile == "" {
		return server.ListenAndServe()
	}
	// The served configuration is built in one place so its key pair and its
	// protocol floor are both decided here instead of inside ListenAndServeTLS.
	config, err := newListenerTLSConfig(certFile, keyFile)
	if err != nil {
		return err
	}
	server.TLSConfig = config
	// The pair is already in TLSConfig; ServeTLS only loads one when the
	// configuration carries none.
	return server.ListenAndServeTLS("", "")
}

// newListenerTLSConfig is the configuration the listener serves with. It loads the
// key pair the mount holds and states the same protocol floor as the outbound
// clients, because ListenAndServeTLS(cert, key) would build that configuration
// internally, where neither half can be asserted. The certificate is served as the
// mount has it: an expired or wrongly named leaf is the client's verification
// decision, and refusing it here would hide the handshake this deployment has to
// report instead of prevent.
func newListenerTLSConfig(certFile, keyFile string) (*tls.Config, error) {
	certificate, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, err
	}
	return &tls.Config{Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS12}, nil
}

// startupRootCAs reads TLS_CA_FILE and loads the internal CA. No variable is no
// pool, so every outbound client keeps the system roots it uses today; a
// variable that cannot be loaded stops startup and names itself, so a deployment
// never runs with trust it did not ask for.
func startupRootCAs() (*x509.CertPool, error) {
	pool, err := handler.RootCAsFromFile(os.Getenv(tlsCAFileEnv))
	if err != nil {
		return nil, fmt.Errorf("%s: %w", tlsCAFileEnv, err)
	}
	return pool, nil
}

// newJWKSClient is the client the OIDC key-set fetches use. It always carries an
// explicit TLS configuration: a nil pool keeps the system roots this process used
// before TLS_CA_FILE existed, and the TLS 1.2 floor is stated either way, so no
// outbound client of this process depends on a default it does not own. A
// configured pool makes that pool the only trust anchor the identity provider is
// reached with.
func newJWKSClient(rootCAs *x509.CertPool) *http.Client {
	return &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{TLSClientConfig: newOutboundTLSConfig(rootCAs)}}
}

// newOutboundTLSConfig is the client configuration every outbound client of this
// process verifies with, built from the pool TLS_CA_FILE produced. When a pool is
// configured it is the only anchor; verification stays on because no field here can
// switch it off; and the TLS 1.2 floor is stated instead of inherited from
// whatever default the toolchain happens to ship, so a future default cannot lower
// what this deployment requires.
func newOutboundTLSConfig(rootCAs *x509.CertPool) *tls.Config {
	return &tls.Config{RootCAs: rootCAs, MinVersion: tls.VersionTLS12}
}
