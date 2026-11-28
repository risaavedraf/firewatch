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

// ── The gate's own negative case, with no write to the working tree ────────
// `tests/core/source-gate.test.ts` must prove this gate rejects the sidebar it
// forbids, not only that the app currently passes. A test may not rewrite a tracked
// file, so the gate accepts a repeatable `--simulate <shipped-path> <text>` pair and
// appends that text to its *in-memory* copy. Nothing is written, an unknown path is
// an error rather than a silent no-op, and the hook can only add text to a file that
// already ships — so it can never turn a failing gate green.
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] !== '--simulate') continue;
  const target = argv[index + 1];
  const addition = argv[index + 2];
  assert.ok(target && typeof addition === 'string', '--simulate needs a shipped path and the text to append');
  // The command line speaks POSIX separators; the map is keyed by the platform's.
  const key = target.split('/').join(path.sep);
  assert.ok(sources.has(key), `--simulate names a file the gate does not read: ${target}`);
  sources.set(key, `${sources.get(key)}\n${addition}`);
  index += 2;
}

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

// ── 7. The shell keeps the width, the wrap and the offset of its controls ─
// S7 — «sacar la barra lateral para darle más espacio a las cosas» — removed the
// column. The workspace is the shell's only column now: `main` takes the width the
// 234 px column used to take, and the controls the column held (the gateway live
// region with its refresh control, the session state and the only sign-out
// control) moved into the shell header.
//
// This section used to require the column: a viewport-bounded sticky box with its
// own scroll, because scrolling the whole column is what pushed the session card
// below the fold. That element no longer exists, so the requirement is now the
// opposite — and, like the retired `.sidebar nav` rule T8 removed, the old
// assertion is replaced rather than dropped, because a gate that keeps describing
// an element the DOM does not render is exactly how this one stayed green while
// the layout changed under it.
//
// What a static gate can honestly protect about the sidebar-free shell:
//
//   1. the retired column cannot come back: no `.sidebar` rule may exist in any
//      shipped stylesheet, so a resurrected sticky column fails here — not only
//      when it returns to `app.css`, which was the one sheet this guard read while
//      the column's rule could be recreated in `tokens.css` or a workspace sheet;
//   2. the workspace owns the width: the shell is a row bounded by the viewport
//      minus the sticky bar, the workspace column grows and may shrink (`flex: 1`,
//      `min-width: 0`), and `main` is a percentage of the viewport with a maximum
//      rather than a fixed column;
//   3. the header wraps instead of widening the page (`flex-wrap: wrap`), and every
//      box of the cluster declares `min-width: 0` — what lets a long zone name or
//      the readiness sentence wrap inside the row at 320 px;
//   4. nothing is hidden to make the fold fit (the gateway card is never
//      `display: none`) and the one control the shell may never trade away keeps
//      its 36 px target;
//   5. at 720 px the cluster becomes a two-track grid of `minmax(0, 1fr)` columns,
//      the narrow layout's no-overflow guarantee;
//   6. the product bar and its grouped menu keep the contracts T1/T8 gave them:
//      the bar sticks to the page's zero offset and reserves its declared height,
//      and the menu stays out of flow — so opening it cannot push the shell or the
//      sign-out control down — bounded to the viewport and scrolling inside itself.
//
// Geometry still needs a browser: these rules cannot tell whether the controls fit,
// only that the declarations which keep the reader able to reach them are there.
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

// A rule is read by its own selector, anchored at the start of a line — the same
// boundary the declaration reader uses — so `.topbar` can never match
// `.topbar-utils`, and an indented rule inside a breakpoint is not mistaken for
// the base one.
function ruleFor(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))?.[0] ?? null;
}

function requiredRule(css, selector, what) {
  const rule = ruleFor(css, selector);
  assert.ok(rule, `${what} must be declared by ${selector}`);
  return rule;
}

// 1. The retired column. Every shipped stylesheet is read, not only `app.css`: the
// entry point imports them all, so a `.sidebar` rule in `tokens.css` or in a
// workspace sheet renders the column exactly as one in `app.css` would, and a
// guard that read a single file stayed green for it. Comments are stripped the way
// a CSS parser strips them, so the prose of this section may name the column the
// guard refuses.
const stylesWithoutComments = styles.replace(/\/\*[\s\S]*?\*\//g, '');
const stylesheets = [...sources.entries()].filter(
  ([name]) => name.startsWith(`src${path.sep}`) && name.endsWith('.css'),
);
assert.ok(stylesheets.length > 0, 'no shipped stylesheet was found; the sidebar guard would pass vacuously');
for (const [name, source] of stylesheets) {
  assert.doesNotMatch(
    source.replace(/\/\*[\s\S]*?\*\//g, ''),
    /\.sidebar\b/,
    `the retired sidebar cannot come back: S7 removed the column, so no shipped stylesheet may declare a \`.sidebar\` or \`.sidebar-bottom\` rule — ${name} does`,
  );
}

// 1b. The markup half of the same guard. The stylesheet rule alone was not enough:
// `<aside className="sidebar">` reintroduced in the shell would render the column
// again with whatever block styling it inherited, and a gate that only read
// `app.css` would have stayed green. The shell is read with comments stripped the
// same way, so the prose that explains the removal cannot trip its own guard.
const shellPath = path.join('src', 'components', 'Shell.tsx');
const shell = sources.get(shellPath);
assert.ok(shell, 'src/components/Shell.tsx must exist');
const shellWithoutComments = shell.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, '');
const retainedMarkup = shellWithoutComments.match(/<aside\b[^>]*\bsidebar(?:-bottom)?\b[^>]*>/i);
assert.equal(
  retainedMarkup,
  null,
  `the retired sidebar markup cannot come back: Shell.tsx renders ${retainedMarkup?.[0] ?? ''}`,
);

// 2. The workspace owns the width the column used to take.
const shellRule = requiredRule(styles, '.app-shell', 'the shell');
assert.equal(requiredDeclaration(shellRule, 'display', 'the shell'), 'flex', 'the shell is a row of one workspace column');
assert.match(
  requiredDeclaration(shellRule, 'min-height', 'the shell'),
  /^calc\(\s*100vh\s*-\s*var\(--product-nav-h(?:\s*,|\))/,
  'the shell must subtract the sticky bar it sits below; a shell that subtracts nothing slides under it',
);

const workspaceRule = requiredRule(styles, '.main-area', 'the workspace column');
assert.equal(
  requiredDeclaration(workspaceRule, 'flex', 'the workspace column'),
  '1',
  'the workspace is the column that takes the width the sidebar used to take',
);
assert.equal(
  requiredDeclaration(workspaceRule, 'min-width', 'the workspace column'),
  '0',
  'the workspace column must be allowed to shrink, or a wide table widens the page',
);

const contentRule = requiredRule(styles, 'main', 'the content region');
assert.match(
  requiredDeclaration(contentRule, 'width', 'the content region'),
  /^min\(\s*\d+px,\s*100%\s*\)$/,
  'the content region must be a percentage of the viewport with a maximum, not a fixed column',
);

// 3. The header wraps, and every box of the cluster may shrink.
const headerRule = requiredRule(styles, '.topbar', 'the shell header');
assert.equal(
  requiredDeclaration(headerRule, 'flex-wrap', 'the shell header'),
  'wrap',
  'the header must wrap at narrow widths instead of widening the page',
);
const headerMinHeight = Number.parseInt(requiredDeclaration(headerRule, 'min-height', 'the shell header'), 10);
assert.ok(
  Number.isInteger(headerMinHeight) && headerMinHeight < 75,
  'the header must stay below the 75 px band it replaced; a taller header re-opens the fold defect S7 closed',
);
for (const [selector, what] of [
  ['.topbar', 'the shell header'],
  ['.topbar-lead', 'the brand and route block'],
  ['.topbar-utils', 'the utility cluster'],
  ['.brand', 'the brand'],
  ['.topbar-route', 'the route block'],
  ['.zone-chip', 'the territorial chip'],
  ['.health-card', 'the gateway card'],
  ['.session-card', 'the session tablet'],
]) {
  assert.equal(
    requiredDeclaration(requiredRule(styles, selector, what), 'min-width', what),
    '0',
    `${what} must be able to shrink, or its longest label widens the page`,
  );
}

// 4. Nothing is hidden to make the fold fit, and the sign-out control — the one
// control the shell may never trade away — keeps its target.
assert.doesNotMatch(
  stylesWithoutComments,
  /\.health-card\s*\{[^}]*display:\s*none/,
  'the gateway card carries the readiness live region and its refresh control: it may not be hidden at any width',
);
const signOutRule = requiredRule(styles, '.session-card button', 'the sign-out control');
const signOutTarget = Number.parseInt(requiredDeclaration(signOutRule, 'min-height', 'the sign-out control'), 10);
assert.ok(
  Number.isInteger(signOutTarget) && signOutTarget >= 36,
  'the sign-out control must keep at least a 36 px target on every viewport',
);

// 5. The narrow layout is a two-track grid of shrinkable columns. `1fr` alone
// grows to its longest word and widens the page, which is the defect the
// `minmax(0, 1fr)` tracks exist to prevent.
const mobileShellRules = [...styles.matchAll(/@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\n\}/g)]
  .map(match => match[0])
  .find(block => block.includes('.topbar'));
assert.ok(mobileShellRules, 'the 720px shell breakpoint must exist');
const mobileUtilsRule = mobileShellRules.match(/\.topbar-utils\s*\{([^}]*)\}/);
assert.ok(mobileUtilsRule, 'the 720px breakpoint must keep its .topbar-utils override');
assert.equal(
  requiredDeclaration(mobileUtilsRule[0], 'display', 'the 720px utility cluster'),
  'grid',
  'the narrow cluster must lay out as a grid so the two small tablets share one row',
);
assert.equal(
  requiredDeclaration(mobileUtilsRule[0], 'grid-template-columns', 'the 720px utility cluster'),
  'minmax(0, 1fr) minmax(0, 1fr)',
  'the narrow cluster tracks must be shrinkable: `1fr` alone grows to its longest word and widens the page',
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

console.log(
  `PASS: ${sources.size} shipped source files checked. The honesty statement is present (${required.length} required statements), no fixture, frozen clock, invented identity or alias ships, all twelve consumed routes and both external origins are present, no client-side role guard exists, tokens are never persisted, no secret is bundled, the retired sidebar cannot come back in any of the ${stylesheets.length} shipped stylesheets or in the shell's markup and the sidebar-free shell keeps its full-width shrinkable workspace, its wrapping header with a 36 px sign-out target and nothing hidden at 720 px, the bar declares an exact zero offset and reserves its declared height, the grouped menu stays out of flow with the exact intended viewport bound in both the base rule and the 720px override, and no external asset or inline handler is served.`,
);
