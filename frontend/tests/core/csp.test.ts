import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// `scripts/` is plain ESM that `node` runs directly, with no bundler and no
// types of its own, so it is loaded by path here rather than through a static
// import TypeScript would need a declaration for. It is the same file the two
// scripts import and the same one this test reads from disk below.
const cspModuleUrl = pathToFileURL(resolve(process.cwd(), 'scripts/csp.mjs')).href;
const { contentSecurityPolicy } = (await import(/* @vite-ignore */ cspModuleUrl)) as {
  contentSecurityPolicy: (connectSources: string[]) => string;
};

const LOCAL_CONNECT_SOURCES = ['http://localhost:8080', 'http://localhost:8081'];

// The policy the page is served with locally, pinned directive for directive.
// It is a security policy: a directive that silently disappears or moves is the
// failure this literal is here to catch, so it is written out in full rather
// than compared against the module's own output.
const LOCAL_POLICY = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src http://localhost:8080 http://localhost:8081; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// `serve.mjs` sends this policy on every answer and `pages-headers.mjs` writes
// it into `dist/_headers` for Cloudflare Pages. They used to hold two copies of
// the same literal that differed in one directive, which is how the two can
// drift apart with nothing failing, so both must import the module instead.
const SCRIPTS = ['serve.mjs', 'pages-headers.mjs'];

function directives(policy: string): string[] {
  return policy.split('; ');
}

describe('content security policy', () => {
  it('pins the local policy exactly', () => {
    expect(contentSecurityPolicy(LOCAL_CONNECT_SOURCES)).toBe(LOCAL_POLICY);
  });

  it('replaces only the connect-src directive for another source list', () => {
    const sources = ['https://api.example.test', 'https://auth.example.test'];

    const policy = contentSecurityPolicy(sources);

    expect(policy).toBe(LOCAL_POLICY.replace('http://localhost:8080 http://localhost:8081', 'https://api.example.test https://auth.example.test'));
    expect(directives(policy).filter((entry) => !entry.startsWith('connect-src '))).toEqual(directives(LOCAL_POLICY).filter((entry) => !entry.startsWith('connect-src ')));
    // Exactly one `connect-src`: appended a second time it would widen the list
    // rather than replace it, since a browser intersects repeated directives.
    expect(policy.match(/connect-src/g)).toHaveLength(1);
  });

  it('keeps the policy in the module instead of inlined in the scripts', () => {
    for (const script of SCRIPTS) {
      const source = readFileSync(resolve(process.cwd(), 'scripts', script), 'utf8');

      // The policy literal ends with this directive and nothing else in either
      // file names a CSP directive, so the substring can only appear here again
      // if a script spells the policy out once more.
      expect(source).not.toContain('frame-ancestors');
      expect(source).toContain("from './csp.mjs'");
    }
  });
});
