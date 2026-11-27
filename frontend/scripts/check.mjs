import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import console from 'node:console';

// Source gate for the FireWatch app.
//
// It is the deliberate inverse of the retired mockup's checker, which forbade the
// words "demo", "synthetic", "scenario" and "fixtures" and asserted the page made
// no network call at all. The real page must do exactly the opposite: it must
// state the scope of its data and it must call the gateway. So here the honesty
// vocabulary is *required* and the fixture vocabulary is *forbidden*.
//
// Every rule is scoped to what the browser actually receives: `src/**` and
// `index.html`. The scripts, the test suites and the odd/ documents are not
// shipped, and several of them legitimately quote the words this gate forbids —
// including this file, which names them in order to forbid them.
//
// This is a static gate. What can only be observed by rendering (duplicate ids,
// which view a role can reach, fail-closed rendering of a malformed payload) is
// covered by the Vitest suites instead, not asserted here.

const root = fileURLToPath(new URL('../', import.meta.url));
const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'coverage', '.git']);

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const groups = await Promise.all(
    entries
      .filter(entry => !IGNORED_DIRECTORIES.has(entry.name))
      .map(entry => (entry.isDirectory() ? filesIn(path.join(directory, entry.name)) : [path.join(directory, entry.name)])),
  );
  return groups.flat();
}

function isShipped(relative) {
  return relative === 'index.html' || relative.startsWith(`src${path.sep}`);
}

const files = await filesIn(root);
const shipped = files.filter(file => isShipped(path.relative(root, file)));
assert.ok(shipped.length > 0, 'no shipped source files were found; the gate would pass vacuously');

const sources = new Map();
for (const file of shipped) sources.set(path.relative(root, file), await readFile(file, 'utf8'));

const joined = [...sources.entries()].map(([name, source]) => `${name}\n${source}`).join('\n');

// ── 1. The honesty statement must be present, in the app that ships ────────
const required = [
  ['the synthetic-input scope declaration', /entrada (?:de demostración|sintética)|entorno de demostración/i],
  ['the no-calibration statement', /no calibrad/i],
  ['the not-official / academic-rule statement', /no oficial|regla académica/i],
  ['the CONAF non-substitution statement', /CONAF/],
  ['the SENAPRED non-substitution statement', /SENAPRED/],
  ['the source attribution', /SUBDERE/],
  ['the source restriction', /DIFROL/],
  ['the "not implemented yet" inventory', /NO IMPLEMENTADO/],
  ['the server-decides authorization statement', /el servidor/i],
];
for (const [what, pattern] of required) {
  assert.match(joined, pattern, `missing honesty statement: ${what}`);
}

// ── 2. Invented data must not come back ───────────────────────────────────
// Note what is *not* forbidden here: the word "fixture". The retired mockup's
// checker banned that vocabulary because the mockup was pretending. This page
// names the backend's legacy fixture truthfully — "Sin escenario (fixture
// analítico heredado)" is an honest description of what the server will do — and a
// gate that silenced it would remove a true statement to satisfy a word list.
// What is forbidden is shipping invented data: a fixture module, a frozen clock,
// the mockup's sector identifiers, an alias that invents names, client-side
// random data or a hardcoded demo identity.
const invented = [
  ['a fixture module', /(?:from|require\()\s*['"][^'"]*fixtures?/i],
  ['a frozen clock', /2026-01-15T15:00:00Z/],
  ['the mockup sector identifiers', /\bs[1-4]\b\s*:/],
  ['an alias that invents a display name', /presentationName/],
  ['random or synthetic client-side data', /Math\.random\s*\(/],
  ['a demo identity hardcoded in the client', /demo-admin|demo-viewer/],
];
for (const [what, pattern] of invented) {
  assert.doesNotMatch(joined, pattern, `invented data must not be shipped: ${what}`);
}

// ── 3. The real integration must exist ────────────────────────────────────
for (const route of [
  '/health/ready',
  '/v1/risk/zones',
  '/v1/risk/latest',
  '/v1/risk/history',
  '/v1/risk/batches',
  '/v1/risk/sources',
  '/v1/risk/status',
  '/v1/jobs/status',
  '/v1/risk/synthetic-scenarios',
  '/v1/audit',
  '/v1/prevention/actions',
  '/v1/models',
]) {
  assert.ok(joined.includes(route), `the consumed route is missing from the app: ${route}`);
}
assert.match(joined, /\bfetch\s*\(/, 'the app must really call the API');
assert.match(joined, /http:\/\/localhost:8080/, 'every gateway call is absolute against the gateway origin');
assert.match(joined, /http:\/\/localhost:8081\/realms\/firewatch/, 'the issuer is the identity provider, not the gateway');

// ── 4. No client-side authorization boundary ──────────────────────────────
// The client cannot grant permissions, so no route or view may decide anything
// from a role: a `viewer` must be able to open `#audit` and read the server's
// 403. The rule is deliberately about readers and guards rather than about any
// operation on a role array — the decoder itself legitimately filters its own
// list, and a blunt rule would forbid the honest code along with the false
// boundary.
const routes = sources.get(path.join('src', 'app', 'routes.ts'));
assert.ok(routes, 'src/app/routes.ts must exist');
assert.doesNotMatch(routes, /\badmin\b/i, 'no route is marked as admin-only in the client');
assert.match(routes, /audit/, 'the activity register is a declared view for every role');

const sessionPath = path.join('src', 'core', 'session.ts');
const otherReaders = [...sources.entries()].filter(([name, source]) => name !== sessionPath && /decodeRoles/.test(source));
assert.equal(
  otherReaders.length,
  0,
  `the decoded token payload must have exactly one reader (the session store): ${otherReaders.map(([name]) => name).join(', ')}`,
);

for (const [name, source] of sources) {
  assert.doesNotMatch(source, /allowedRoute|requiresRole|requireRole/i, `no client-side route guard: ${name}`);
  // The presentation layer is where a false boundary would appear.
  if (name.startsWith(`src${path.sep}views${path.sep}`) || name.startsWith(`src${path.sep}components${path.sep}`)) {
    assert.doesNotMatch(source, /\broles?\b\s*(?:\?\.)?\s*\.\s*(?:includes|some|filter|every)\b/i, `no view or component may branch on roles: ${name}`);
    assert.doesNotMatch(source, /\broles?\b\s*===?\s*['"]/, `no view or component may compare a role literal: ${name}`);
  }
}

// ── 5. Session and secret hygiene ─────────────────────────────────────────
for (const [name, source] of sources) {
  assert.doesNotMatch(source, /localStorage/, `tokens are never persisted: ${name}`);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/, `no raw HTML injection: ${name}`);
  assert.doesNotMatch(source, /\bdocument\.cookie\b/, `no cookies are written: ${name}`);
  // The PKCE transaction is the single, deliberate storage exception, and it is
  // keyed by file so this gate points at it if it ever spreads.
  const storageWrites = source.match(/sessionStorage\.\w+/g) ?? [];
  assert.ok(
    storageWrites.every(() => name === path.join('src', 'core', 'session.ts')),
    `sessionStorage is only used for the PKCE transaction: ${name}`,
  );
}
assert.doesNotMatch(joined, /client_secret|BEGIN [A-Z ]*PRIVATE KEY|VITE_[A-Z_]*SECRET/, 'no secret may be bundled');
assert.doesNotMatch(joined, /Basic\s+[A-Za-z0-9+/=]{8,}/, 'no embedded credential');

// ── 6. No external assets, and no inline handlers in the served document ──
const entry = sources.get('index.html');
assert.ok(entry, 'index.html must exist');
assert.doesNotMatch(entry, /\son[a-z]+\s*=/i, 'no inline event handlers');
for (const [name, source] of sources) {
  if (!/\.(?:html|css)$/.test(name)) continue;
  assert.doesNotMatch(source, /(?:src|href)\s*=\s*["'](?:https?:|\/\/)/i, `no external asset: ${name}`);
  assert.doesNotMatch(source, /@import\s+(?:url\()?["']?(?:https?:|\/\/)/i, `no remote stylesheet import: ${name}`);
}

// ── 7. The shell keeps the offset and the scroll that keep its controls visible ─
// This is the one layout property a static gate can honestly protect. The column
// is a viewport-bounded sticky box whose content is taller than the box at common
// laptop heights, and it still holds the brand, the workspace, the gateway card
// and the only sign-out control. The column keeping its own overflow is necessary
// but not sufficient: scrolling the whole column is exactly what pushed the
// session card below the fold. The bound is the viewport minus the sticky product
// bar the column sits below, so the two offsets must agree.
//
// T8 retired the `.sidebar nav` assertion this section used to carry: T1 moved the
// destinations into `ProductNav`, the column stopped rendering a list, and the
// rule had no consumer. The equivalent active contract is the bar and its menu:
// the bar stays sticky at the page's zero offset and reserves its declared height,
// and the grouped menu stays out of flow — so opening it cannot push the shell,
// the column or the sign-out control down — bounded to the viewport and scrolling
// inside itself. Geometry still needs a browser: this rule cannot tell whether
// the controls fit, only that the declarations which keep the reader able to
// reach them are still there.
const styles = sources.get(path.join('src', 'styles', 'app.css'));
assert.ok(styles, 'src/styles/app.css must exist');
const productNavStyles = sources.get(path.join('src', 'styles', 'product-nav.css'));
assert.ok(productNavStyles, 'src/styles/product-nav.css must exist');

// One declaration, read at its own boundaries: comments are removed the way a CSS
// parser removes them, the property name is compared whole, and the value ends at
// the `;` that closes it. Whitespace runs are collapsed. Nothing else is
// interpreted: these declarations are intentional contracts compared exactly, not
// a grammar. A substring or token match is how a gate stops guarding anything —
// `/top: 0/` accepts `top: 0.5rem`, a zero-with-a-suffix pattern accepts
// `top: 0foo`, and a viewport-token search accepts
// `min(9999px, 9999px /* 70dvh */)`. When the design changes one of these values,
// this guard is updated in the same deliberate change.
function declarationValue(rule, property) {
  const body = rule
    .slice(rule.indexOf('{') + 1, rule.lastIndexOf('}'))
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  for (const part of body.split(';')) {
    const colon = part.indexOf(':');
    if (colon !== -1 && part.slice(0, colon).trim() === property) {
      return part.slice(colon + 1).replace(/\s+/g, ' ').trim();
    }
  }
  return null;
}

function requiredDeclaration(rule, property, what) {
  const value = declarationValue(rule, property);
  assert.ok(value !== null, `${what} must declare ${property}`);
  return value;
}

const sidebarRule = styles.match(/^\.sidebar\s*\{([^}]*)\}/m);
assert.ok(sidebarRule, 'the .sidebar rule must exist');
assert.equal(
  requiredDeclaration(sidebarRule[0], 'position', 'the column'),
  'sticky',
  'the sticky column this rule protects is gone',
);
assert.match(
  requiredDeclaration(sidebarRule[0], 'top', 'the column'),
  /^var\(--product-nav-h(?:\s*,|\))/,
  'the column must stay pinned below the sticky bar instead of sliding under it',
);
assert.match(
  requiredDeclaration(sidebarRule[0], 'overflow-y', 'the column'),
  /^(?:auto|scroll)$/,
  'the sidebar must declare its own vertical scroll',
);
// The bound is the viewport minus the bar. The shell reserved the demonstration
// strip's height before the strip stopped being rendered, and a column that
// subtracts nothing extends under the sticky bar and loses its first control.
assert.match(
  requiredDeclaration(sidebarRule[0], 'height', 'the column'),
  /^calc\(\s*100vh\s*-\s*var\(--product-nav-h/,
  'the sidebar must keep its height bounded by the viewport minus the bar, which is what the scroll is for',
);

const productNavRule = productNavStyles.match(/^\.product-nav\s*\{([^}]*)\}/m);
assert.ok(productNavRule, 'the .product-nav rule must exist');
assert.equal(
  requiredDeclaration(productNavRule[0], 'position', 'the product bar'),
  'sticky',
  'the product bar must stay sticky',
);
// The bar has to sit exactly on the viewport edge; the shell subtracts the bar's
// full height from `100vh`. Only the two accepted spellings of zero are values — a
// zero-prefixed token such as `0foo` is not one.
const barTop = requiredDeclaration(productNavRule[0], 'top', 'the product bar');
assert.ok(
  barTop === '0' || barTop === '0px',
  'the product bar must declare exactly `top: 0` or `top: 0px`; any other value is a different offset',
);
assert.match(
  requiredDeclaration(productNavRule[0], 'min-height', 'the product bar'),
  /^var\(--product-nav-h/,
  'the bar must reserve the height the shell and the column subtract',
);

const menuRule = productNavStyles.match(/^\.product-nav__panel\s*\{([^}]*)\}/m);
assert.ok(menuRule, 'the .product-nav__panel rule must exist');
assert.equal(
  requiredDeclaration(menuRule[0], 'position', 'the grouped menu'),
  'absolute',
  'the grouped menu must stay out of flow so it cannot push the shell',
);
// `position` is checked before the bound so a moved panel fails on its own
// invariant; the bound itself is the exact intended value, comments removed. A
// value that merely contains `dvh` — including one hidden in a comment — is not
// the bound, and a value that ignores the viewport entirely is not either.
assert.equal(
  requiredDeclaration(menuRule[0], 'max-height', 'the grouped menu'),
  'min(70dvh, 520px)',
  'the grouped menu max-height must be exactly `min(70dvh, 520px)`; a different design updates this guard with it',
);
assert.match(
  requiredDeclaration(menuRule[0], 'overflow-y', 'the grouped menu'),
  /^(?:auto|scroll)$/,
  'the bounded menu must scroll inside itself',
);

// The 720px override is the most load-bearing branch at small widths: the bar is
// the only fixed vertical offset there and the panel spans nearly the full width,
// so the same bound is read from the breakpoint itself.
const smallScreenRules = productNavStyles.match(/@media\s*\(max-width:\s*720px\)[\s\S]*?\n\}/)?.[0];
assert.ok(smallScreenRules, 'the 720px product-navigation breakpoint must exist');
const mobileMenuRule = smallScreenRules.match(/\.product-nav__panel\s*\{([^}]*)\}/);
assert.ok(mobileMenuRule, 'the 720px breakpoint must keep its .product-nav__panel override');
assert.equal(
  requiredDeclaration(mobileMenuRule[0], 'max-height', 'the 720px menu'),
  'min(72dvh, 480px)',
  'the 720px menu max-height must be exactly `min(72dvh, 480px)`; a different design updates this guard with it',
);

// The mobile breakpoint must keep dropping the fixed sidebar height: that is what
// makes the column's scroll declaration harmless at small widths.
assert.match(
  styles,
  /@media\s*\(max-width:\s*720px\)[\s\S]*?\.sidebar\s*\{[^}]*height:\s*auto/,
  'the 720px breakpoint must keep the sidebar height automatic',
);

console.log(
  `PASS: ${sources.size} shipped source files checked. The honesty statement is present (${required.length} required statements), no fixture, frozen clock, invented identity or alias ships, all twelve consumed routes and both external origins are present, no client-side role guard exists, tokens are never persisted, no secret is bundled, the sidebar keeps its viewport-bounded height below the sticky product bar with the internal scroll that reveals its controls, the bar declares an exact zero offset and reserves its declared height, and the grouped menu stays out of flow with the exact intended viewport bound in both the base rule and the 720px override, and no external asset or inline handler is served.`,
);
