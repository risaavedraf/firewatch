import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { expect, test } from 'vitest';

// The shipped-source gate (`scripts/check.mjs`, the `npm run check` step of
// `npm run verify`) is the one place that asserts a layout property from source
// instead of from a rendered browser.
//
// Section 7 of that gate stayed green while S7 removed the column it guarded: it
// required a sticky `.sidebar` long after the element was gone. Nothing in this
// suite noticed, because the gate is not part of `npm test`. This test closes that
// gap by running the exact command `npm run check` runs, so a layout guard that no
// longer matches the app fails here too — with the gate's own message.
//
// It reads the repository only: no fixture, no temporary copy and no mutation of
// the working tree. What the gate's section 7 asserts is measured from the
// stylesheet side by `tests/styles/layout-padding.test.tsx`.
//
// A gate that only ever sees the healthy tree is half a gate: it would stay green
// if its own rule stopped matching. The negative cases below therefore re-run the
// same script with one *simulated* mutation — `--simulate <shipped-path> <text>`
// appends text to the gate's in-memory copy of that file — so the rule is measured
// against the offender it exists to reject, and the tracked files on disk are
// never touched.
const run = promisify(execFile);
// The suite's working directory is `frontend/`; every stylesheet test resolves its
// files the same way.
const gate = resolve(process.cwd(), 'scripts', 'check.mjs');

interface GateRun {
  code: number;
  output: string;
}

// `execFile` rejects on a non-zero exit, which is precisely the outcome the
// negative cases expect, so the rejection is unwrapped here into the exit code and
// the whole diagnostic — the test asserts the reason, not the fact of a failure.
async function gateRun(args: readonly string[]): Promise<GateRun> {
  try {
    const { stdout, stderr } = await run(process.execPath, [gate, ...args], { cwd: process.cwd(), timeout: 60_000 });
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}

test('the shipped source gate passes against the sidebar-free shell (S7)', async () => {
  expect(existsSync(gate), `${gate} must exist; run the suite from frontend/`).toBe(true);

  const { code, output } = await gateRun([]);

  // All sections ran to the end: the gate prints its summary only after its last
  // assertion, so a clean `PASS:` is the whole contract.
  expect(code, output).toBe(0);
  expect(output).toContain('PASS:');
  expect(output).toContain('shipped source files checked');
});

test('the gate rejects a reintroduced .sidebar rule in app.css (S7)', async () => {
  const { code, output } = await gateRun(['--simulate', 'src/styles/app.css', '.sidebar { display: flex; }']);

  expect(code, output).not.toBe(0);
  expect(output).toContain('the retired sidebar cannot come back');
});

test('the gate rejects a reintroduced .sidebar rule in any shipped stylesheet (S7)', async () => {
  // Section 7 read only `app.css`, so the retired column could be recreated in any
  // other sheet the entry point imports and the gate would still pass: a rule in
  // `tokens.css` or `product-nav.css` renders the column exactly as app.css would.
  // The guard now reads every shipped stylesheet, so the negative case is measured
  // against each of them.
  for (const [stylesheet, expectPath] of [
    ['src/styles/tokens.css', 'tokens.css'],
    ['src/styles/product-nav.css', 'product-nav.css'],
  ] as const) {
    const reintroduced = await gateRun(['--simulate', stylesheet, '.sidebar { width: 200px; }']);

    expect(reintroduced.code, `${stylesheet}\n${reintroduced.output}`).not.toBe(0);
    expect(reintroduced.output).toContain('the retired sidebar cannot come back');
    // The gate names the offending file, so the failure says where the column came
    // back instead of only that it did.
    expect(reintroduced.output, reintroduced.output).toContain(expectPath);
  }

  // Triangulation: the retired column had a second class of its own, so the ban
  // covers the suffix in every sheet rather than the exact first spelling in one.
  const footer = await gateRun(['--simulate', 'src/styles/tokens.css', '.sidebar-bottom { width: 200px; }']);

  expect(footer.code, footer.output).not.toBe(0);
  expect(footer.output).toContain('the retired sidebar cannot come back');
});

test('the gate rejects reintroduced sidebar markup in Shell.tsx (S7)', async () => {
  // The stylesheet rule was the only guard, so an `<aside>` carrying the retired
  // class name would have rendered a column with no rule complaining: the markup is
  // now read too, comments stripped, and the shell is the file that renders it.
  const school = await gateRun([
    '--simulate',
    'src/components/Shell.tsx',
    '<aside className="sidebar" aria-label="Barra lateral" />',
  ]);

  expect(school.code, school.output).not.toBe(0);
  expect(school.output).toContain('the retired sidebar markup cannot come back');

  // Triangulation: the column had a second class of its own, so the ban covers the
  // suffix rather than the exact first spelling only.
  const footer = await gateRun(['--simulate', 'src/components/Shell.tsx', '<aside className="sidebar-bottom" />']);

  expect(footer.code, footer.output).not.toBe(0);
  expect(footer.output).toContain('the retired sidebar markup cannot come back');
});

test('the gate still passes when the sidebar is only named in prose (S7)', async () => {
  // Prose is not markup: a comment may explain why the column is gone, exactly the
  // way this section's own text names it. A blunt substring ban would fail here and
  // would silence the honest explanation instead of the offending element.
  const { code, output } = await gateRun([
    '--simulate',
    'src/styles/app.css',
    '/* .sidebar and .sidebar-bottom are retired; the workspace owns the width. */',
    // The prose exemption holds for every shipped sheet the guard now reads, not
    // only for the one it used to read.
    '--simulate',
    'src/styles/tokens.css',
    '/* .sidebar { width: 200px; } is the column S7 retired. */',
    '--simulate',
    'src/components/Shell.tsx',
    '// The retired <aside className="sidebar"> column is not rendered here.',
  ]);

  expect(code, output).toBe(0);
  expect(output).toContain('PASS:');
});
