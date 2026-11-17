// Writes dist/_headers for a Cloudflare Pages deployment.
//
// scripts/serve.mjs sends the page's security headers when the build is served
// locally. Cloudflare Pages does not run that server, so the same headers travel
// in a `_headers` file instead. The policy is serve.mjs's, with `connect-src`
// pointed at the gateway and the identity provider the production build was
// compiled against: the same variables `npm run build` required, read the same
// way Vite read them, so the bundle and its policy cannot name different hosts.
import { stat, writeFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { loadEnv } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const env = loadEnv('production', root, 'VITE_');

function httpsOrigin(name) {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set for the production build`);
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error(`${name} must be https:// on Cloudflare Pages, got ${value}`);
  return url.origin;
}

const gateway = httpsOrigin('VITE_GATEWAY_ORIGIN');
const identity = httpsOrigin('VITE_ISSUER');
const page = httpsOrigin('VITE_REDIRECT_URI');

const policy = `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ${gateway} ${identity}; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

const dist = path.join(root, 'dist');
try {
  await stat(path.join(dist, 'index.html'));
} catch {
  console.error('dist/index.html is missing: run `npm run build` first.');
  process.exit(1);
}

await writeFile(path.join(dist, '_headers'), [
  '/*',
  `  Content-Security-Policy: ${policy}`,
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: no-referrer',
  '  Cache-Control: no-store',
  '',
].join('\n'));

console.log(`dist/_headers written for ${page}: connect-src ${gateway} ${identity}`);
