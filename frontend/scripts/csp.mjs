// The Content-Security-Policy the page is served with.
//
// Two programs send this policy: `serve.mjs` answers with it on every response
// when the build is served locally, and `pages-headers.mjs` writes it into
// `dist/_headers` for Cloudflare Pages, which runs no server of its own. They
// differ only in `connect-src`, so the policy lives here once. It used to sit in
// both files as two literals that agreed by hand, and a security policy that
// agrees by hand drifts with nothing failing: the copy that drifts is the one a
// browser obeys.

// `connect-src` is the directive that moves: it names the origins the page may
// reach, and those are the origins the build was compiled against. It is a
// parameter rather than a default so each caller states its own list and
// neither silently inherits the one meant for the other.
export function contentSecurityPolicy(connectSources) {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src ${connectSources.join(' ')}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}
