import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test } from 'vitest';

// The aerial route was the only place where the product left its light chrome for
// the dark slate console of the approved board: T2 declared the palette under
// `body:has(#overview)`, so eleven of the twelve views kept the cream/forest
// shell. S8 asks for the new colours to be the global ones, and T10 promotes the
// palette to `tokens.css` `:root`. This suite pins the consequence:
//
//   1. `aerial-workspace.css` declares no palette of its own — no `:root`, no
//      `body:has(#overview)`, no `--aerial-*` roles — it only reads the shared
//      ones. A colour edited here would be a second source of truth again;
//   2. every rule it keeps is anchored to `#overview`, so the route still owns its
//      composition and only its composition;
//   3. the composition itself is unchanged: the map is the flexible canvas, the
//      workstation is the bounded supporting rail, and the level fills keep the
//      meaning the legend promises;
//   4. the route styles no `.sidebar`, because S7 removed the element it styled.
//
// jsdom has no layout engine and applies no cascade, so what can be pinned here is
// the shipped stylesheet plus the arithmetic the browser would otherwise have to
// be trusted for: contrast is COMPUTED from the declared token values, never
// eyeballed.

const aerialCss = readFileSync(resolve(process.cwd(), 'src', 'styles', 'aerial-workspace.css'), 'utf8');
const tokenCss = readFileSync(resolve(process.cwd(), 'src', 'styles', 'tokens.css'), 'utf8');
const appCss = readFileSync(resolve(process.cwd(), 'src', 'styles', 'app.css'), 'utf8');

interface CssRule {
  selector: string;
  body: string;
  atRule: string | null;
}

// A brace walker rather than a CSS parser dependency: the file is flat, and every
// assertion below fails loudly if the walk stops recognising what it is asked for.
function parseRules(css: string): CssRule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: CssRule[] = [];
  const open: Array<string | null> = [];
  let head = '';
  for (const character of text) {
    if (character === '{') {
      const selector = head.trim().replace(/\s+/g, ' ');
      head = '';
      if (selector.startsWith('@')) {
        open.push(selector);
        continue;
      }
      rules.push({ selector, body: '', atRule: open.find(entry => entry !== null) ?? null });
      open.push(null);
      continue;
    }
    if (character === '}') {
      open.pop();
      continue;
    }
    if (open.includes(null)) {
      rules[rules.length - 1].body += character;
      continue;
    }
    head += character;
  }
  return rules;
}

const rules = parseRules(aerialCss);

// Prose is not a rule: a comment may name the route gate or the token this change
// retires without shipping it, so comments are removed for the "must not
// contain" checks the way a CSS parser drops them.
const aerialRulesSource = aerialCss.replace(/\/\*[\s\S]*?\*\//g, '');

const palette = new Map<string, string>();
for (const match of tokenCss.split(/@media\s+print/)[0].matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/g)) {
  palette.set(match[1], match[2]);
}

function token(name: string): string {
  const value = palette.get(name);
  if (value === undefined) throw new Error(`tokens.css declares no --${name} as an explicit hex value`);
  return value;
}

function viewRules(): CssRule[] {
  return rules.filter(rule => rule.selector.startsWith('#overview'));
}

function declarations(body: string): Map<string, string> {
  const declared = new Map<string, string>();
  for (const part of body.split(';')) {
    const index = part.indexOf(':');
    if (index === -1) continue;
    declared.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return declared;
}

function declaredIn(rule: CssRule, property: string): string | undefined {
  return declarations(rule.body).get(property);
}

// A role reference (`var(--x)`) is resolved through `tokens.css`.
function colour(value: string | undefined): string {
  if (value === undefined) throw new Error('missing colour declaration');
  const reference = value.match(/var\(--([\w-]+)\)/);
  if (reference !== null) return token(reference[1]);
  const hex = value.match(/#[0-9a-f]{6}/i);
  if (hex === null) throw new Error(`no resolvable colour in ${value}`);
  return hex[0];
}

function channel(value: number): number {
  const ratio = value / 255;
  return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const digits = hex.replace('#', '');
  const full = digits.length === 3 ? digits.replace(/./g, character => character + character) : digits;
  const [red, green, blue] = [0, 2, 4].map(index => parseInt(full.slice(index, index + 2), 16) / 255);
  return 0.2126 * channel(red * 255) + 0.7152 * channel(green * 255) + 0.0722 * channel(blue * 255);
}

function contrast(foreground: string, background: string): number {
  const [first, second] = [luminance(foreground), luminance(background)];
  const [lighter, darker] = first > second ? [first, second] : [second, first];
  return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100;
}

test('the aerial sheet reads the global palette instead of declaring one (S8)', () => {
  // No `:root` block and no route anchor: a token declared here would be a second
  // source of truth, and the one file that owns the roles is `tokens.css`.
  expect(rules.filter(rule => rule.selector === ':root')).toEqual([]);
  expect(aerialRulesSource).not.toMatch(/body:has\(#overview\)/);
  expect(aerialRulesSource).not.toMatch(/--aerial-[\w-]+\s*:/);

  // Neither does it re-declare the shared roles it re-based while the palette was
  // route-scoped.
  for (const role of ['canvas', 'paper', 'soft', 'ink', 'muted', 'line', 'forest-900', 'forest-700', 'gold', 'terracotta']) {
    expect(aerialRulesSource, `--${role} belongs to tokens.css`).not.toMatch(new RegExp(`--${role}\\s*:`));
  }

  // The palette itself is global, and the aerial roles are part of it.
  expect(token('aerial-water')).toBe('#152934');
  expect(token('paper')).toBe('#17222b');
  expect(token('surface-raised')).toBe('#243341');
  expect(token('accent')).toBe('#94dfda');

  // Every rule left in the file is the route's own composition.
  const unanchored = rules.filter(rule => !rule.selector.startsWith('#overview'));
  expect(unanchored.map(rule => rule.selector)).toEqual([]);

  // S7 removed the column: nothing here may style it.
  expect(aerialRulesSource).not.toMatch(/\.sidebar\b/);
  // And the shared surfaces are not re-coloured per route: the shell rows the
  // route used to repaint keep the global roles.
  for (const selector of ['.topbar', '.product-nav', '.session-card', '.health-card', '.breadcrumbs', '.zone-chip', '.update-bar', 'footer']) {
    expect(viewRules().some(rule => rule.selector.startsWith(`#overview ${selector}`)), `${selector} must not be re-coloured by the route`).toBe(false);
  }
});

test('the route paints the console with the measured roles, on the map surface (S8)', () => {
  const consoleRule = viewRules().filter(rule => rule.selector === '#overview' && rule.atRule === null);
  expect(consoleRule).toHaveLength(1);

  // The console carries a surface, a boundary and the room the board gives its
  // canvas: without them the palette would sit as a bare background.
  expect(colour(declaredIn(consoleRule[0], 'background'))).toBe(token('aerial-water'));
  expect(colour(declaredIn(consoleRule[0], 'border'))).toBe(token('edge'));
  expect(declaredIn(consoleRule[0], 'padding')).toBeTruthy();

  // The route's ink roles: text on the console and on the raised rail.
  const water = token('aerial-water');
  const raised = token('surface-raised');
  expect(contrast(token('ink'), water), 'ink on the console').toBeGreaterThanOrEqual(4.5);
  expect(contrast(token('muted'), water), 'muted on the console').toBeGreaterThanOrEqual(4.5);
  expect(contrast(token('ink'), raised), 'ink on the rail').toBeGreaterThanOrEqual(4.5);
  expect(contrast(token('muted'), raised), 'muted on the rail').toBeGreaterThanOrEqual(4.5);
  expect(contrast(token('accent'), raised), 'accent on the rail').toBeGreaterThanOrEqual(4.5);

  // The focus ring is the global focus role, not a light-theme literal chosen
  // against paper. A control paints it as an `outline`; an SVG shape paints it as a
  // stroke (an outline on an SVG path is not the visible ring), and both forms are
  // resolved here so neither can smuggle a stale colour in.
  expect(token('focus')).toBe(token('accent'));
  const focusable = viewRules().filter(rule => rule.selector.includes(':focus-visible'));
  expect(focusable.length).toBeGreaterThan(0);
  for (const rule of focusable) {
    const declared = declarations(rule.body);
    const indicator = [declared.get('outline-color'), declared.get('stroke'), declared.get('outline')].find(
      value => value !== undefined && /var\(--|#[0-9a-f]{6}/i.test(value),
    );
    expect(indicator, `${rule.selector} must declare a focus colour`).toBeDefined();
    expect(colour(indicator), `${rule.selector} focus colour`).toBe(token('focus'));
  }

  // Nothing on this route may be hidden to make the fold fit: the correction is
  // spacing and colour, never `display: none` of required content.
  expect(aerialRulesSource).not.toMatch(/display:\s*none/);
});

test('the map reads as the canvas, and the risk fills keep the meaning they carry (T2/S8/T12)', () => {
  // T12 — the flat schematic becomes an immersive 3D stage. The canvas is the
  // dominant surface: it takes the whole route width (S7 removed the column) with a
  // viewport-relative floor, and it stays on the water tone.
  const viewport = viewRules().filter(rule => /\.map-viewport\s*$/.test(rule.selector) && rule.atRule === null);
  expect(viewport).toHaveLength(1);
  const floor = declaredIn(viewport[0], 'min-height') ?? '';
  const clamp = floor.match(/^clamp\(\s*(\d+)px\s*,\s*(\d+(?:\.\d+)?)vh\s*,\s*(\d+)px\s*\)$/);
  expect(clamp, 'the map floor must be a viewport-relative clamp, not a fixed strip').not.toBeNull();
  expect(Number.parseInt(clamp![1], 10)).toBeGreaterThanOrEqual(440);
  expect(Number.parseFloat(clamp![2])).toBeGreaterThanOrEqual(60);
  expect(Number.parseInt(clamp![3], 10)).toBeGreaterThanOrEqual(680);
  expect(colour(declaredIn(viewport[0], 'background'))).toBe(token('aerial-water'));
  expect(colour(declaredIn(viewport[0], 'border'))).toBe(token('edge'));

  // The canvas track is the flexible one and the rail is the bounded supporting
  // column: the workspace reads as a canvas plus an instrument panel.
  const workspace = viewRules().find(rule => rule.selector === '#overview .aerial-workspace');
  expect(workspace, 'the composition rule is missing').toBeDefined();
  const columns = declaredIn(workspace!, 'grid-template-columns') ?? '';
  expect(columns).toMatch(/minmax\(0,\s*1fr\)/);
  const railWidth = Number.parseInt((columns.match(/minmax\(\s*\d+px,\s*(\d+)px\s*\)/) ?? [])[1] ?? '0', 10);
  expect(railWidth).toBeGreaterThan(0);
  expect(railWidth).toBeLessThanOrEqual(336);

  // The six level roles are the map's vocabulary, declared once in `tokens.css`.
  // Recolouring them for one surface would break the legend's promise that a
  // swatch is what the map shows, so the sheet may not redeclare them.
  expect(aerialRulesSource).not.toMatch(/--level-[\w-]+\s*:/);
  expect(appCss).toMatch(/\.level-bajo\s*\{[^}]*fill:\s*var\(--level-low-fill\)/);

  // …and every fill stays legible as a shape against the map surface (graphics:
  // 3:1). The values are read from the tokens, so a change is measured again.
  for (const level of ['low', 'medium', 'high', 'extreme', 'unknown', 'neutral']) {
    const fill = token(`level-${level}-fill`);
    expect(contrast(fill, token('aerial-water')), `the ${level} fill on the map surface`).toBeGreaterThanOrEqual(3);
    expect(contrast(token(`level-${level}-line`), token('aerial-water')), `the ${level} outline on the map surface`).toBeGreaterThanOrEqual(3);
  }
});

test('the workstation stays a supporting surface with its target sizes intact (T2)', () => {
  const rail = viewRules().find(rule => rule.selector === '#overview .aerial-rail');
  expect(rail, 'the rail rule is missing').toBeDefined();
  expect(colour(declaredIn(rail!, 'background'))).toBe(token('surface-raised'));
  expect(colour(declaredIn(rail!, 'border'))).toBe(token('edge-strong'));
  // Still the second column of the composition, still bounded to the same offset.
  expect(declaredIn(rail!, 'position')).toBe('sticky');
  expect(declaredIn(rail!, 'top')).toContain('var(--product-nav-h');

  // The rail's only controls are links and they keep their shipped target size.
  const link = viewRules().find(rule => rule.selector === '#overview .aerial-links a');
  expect(link, 'the rail link rule is missing').toBeDefined();
  expect(Number.parseInt(declaredIn(link!, 'min-height') ?? '0', 10)).toBeGreaterThanOrEqual(36);
});

test('the changed screen keeps a reduced-motion contract (T2)', () => {
  const reduce = rules.filter(rule => rule.atRule === '@media (prefers-reduced-motion: reduce)');
  expect(reduce.length).toBeGreaterThan(0);
  expect(reduce.map(rule => rule.body).join(' ')).toMatch(/transition:\s*none/);
  expect(reduce.map(rule => rule.body).join(' ')).toMatch(/scroll-behavior:\s*auto/);
});

// The regression the parent observed: at 390×844 the map started at y=777, below
// a stack of shell chrome. T10 removed the column that stacked it, so the narrow
// block only has to compact the route itself — and it may not hide any of it.
test('the narrow viewport compacts the route instead of hiding it (T2/S7/T12)', () => {
  const narrow = rules.filter(rule => rule.atRule === '@media (max-width: 720px)');
  expect(narrow.length).toBeGreaterThan(0);
  // A rule may group its selectors; the lookup reads the selector list.
  const narrowBody = (selector: string): string => {
    const rule = narrow.find(candidate =>
      candidate.selector
        .split(',')
        .map(part => part.trim().replace(/\s+/g, ' '))
        .includes(selector),
    );
    return rule?.body ?? '';
  };

  // The console and its canvas keep a narrow rule: the compaction is explicit per
  // surface instead of a blanket scale that could swallow a control.
  for (const selector of ['#overview', '#overview .aerial-canvas .panel-heading', '#overview .aerial-canvas .map-viewport']) {
    expect(narrowBody(selector), `${selector} must keep a narrow rule`).not.toBe('');
  }

  const canvas = narrowBody('#overview .aerial-canvas .map-viewport');
  expect(Number.parseInt((canvas.match(/min-height:\s*(\d+)px/) ?? [])[1] ?? '0', 10)).toBeGreaterThanOrEqual(280);

  // The rail stops being a second column long before the phone layout.
  const wide = rules.filter(rule => rule.atRule === '@media (max-width: 1100px)');
  expect(wide.map(rule => rule.selector)).toContain('#overview .aerial-rail');
  expect(wide.find(rule => rule.selector === '#overview .aerial-rail')?.body).toMatch(/position:\s*static/);

  // The rail links keep a comfortable target on the phone.
  const links = narrowBody('#overview .aerial-links a');
  expect(Number.parseInt((links.match(/min-height:\s*(\d+)px/) ?? [])[1] ?? '0', 10)).toBeGreaterThanOrEqual(36);

  // T12 — the floating 3D HUD is a map control: it keeps a real target at every
  // width instead of shrinking into an untappable strip.
  const hud = narrowBody('#overview .map-3d-hud button');
  expect(Number.parseInt((hud.match(/min-height:\s*(\d+)px/) ?? [])[1] ?? '0', 10)).toBeGreaterThanOrEqual(36);
});

// T12 — the immersive aerial stage. What can be pinned without a canvas engine is
// the shipped palette contract: the stage paints a deep coastal scene and never a
// pale flat map, it gives unread comunas a dark topographic relief instead of a
// light grey plate, and it labels its relief as illustrative.
test('the 3D stage paints a deep coastal scene, never a pale flat map (T12)', () => {
  const source = readFileSync(resolve(process.cwd(), 'src', 'components', 'map', 'AerialMap3D.tsx'), 'utf8');

  // The ocean bathymetry the scene is built from.
  for (const stop of ['#081520', '#0f2433', '#173848']) {
    expect(source, `the ocean gradient must keep ${stop}`).toContain(stop);
  }
  // The unread-comuna relief ramp: dark topographic slate/olive, distinct from the
  // risk vocabulary and from any pale plate.
  for (const relief of ['#2c3f49', '#46585b']) {
    expect(source, `the topographic relief must keep ${relief}`).toContain(relief);
  }
  // The canvas reads the ONE risk palette instead of re-declaring it. The token
  // names are the shared roles: low/medium/high/unknown are the levels the API may
  // serve, and the canvas maps the Spanish level to its role.
  for (const level of ['low', 'medium', 'high', 'unknown', 'neutral']) {
    expect(source, `the canvas must read --level-${level}-fill`).toContain(`--level-${level}-fill`);
  }
  // The pale legacy map plate cannot come back through the stage.
  for (const pale of ['#f8faf7', '#fffefa', '#e5e7eb']) {
    expect(source.toLowerCase(), `the stage must not paint ${pale}`).not.toContain(pale);
    expect(aerialRulesSource.toLowerCase(), `the route must not paint ${pale}`).not.toContain(pale);
  }

  // The unread comuna keeps a dark slate boundary and paints its plate at the
  // strength the 3:1 minimum requires instead of a translucent wash: the old
  // `fill-opacity: .34` let the illustrative relief through but measured 1.62:1 on
  // `--canvas` against the 3:1 SC 1.4.11 minimum, so the plate is now the measured
  // token fill (4.76 · 4.03 · 3.47 over canvas, water and the inset gradient). The
  // measured contract lives in `tests/a11y/wcag-conformance.test.ts`; what this
  // pins is that the outline stays the system boundary and that no dimming comes
  // back under the threshold.
  const neutral = viewRules().find(rule => rule.selector === '#overview .map-3d .zone-neutral');
  expect(neutral, 'the 3D neutral comuna rule is missing').toBeDefined();
  expect(colour(declaredIn(neutral!, 'stroke'))).toBe(token('edge-strong'));
  expect(Number.parseFloat(declaredIn(neutral!, 'fill-opacity') ?? '1')).toBeGreaterThanOrEqual(0.88);

  const selected = viewRules().find(rule => rule.selector === '#overview .map-3d .zone-selected');
  expect(selected, 'the 3D selection outline is missing').toBeDefined();
  expect(colour(declaredIn(selected!, 'stroke'))).toBe(token('accent'));

  // The HUD controls are glass panels over the stage and keep a real target.
  const hud = viewRules().find(rule => rule.selector === '#overview .map-3d-hud');
  expect(hud, 'the floating HUD rule is missing').toBeDefined();
  expect(declaredIn(hud!, 'position')).toBe('absolute');
  const button = viewRules().find(rule => rule.selector === '#overview .map-3d-hud button');
  expect(button, 'the HUD button rule is missing').toBeDefined();
  expect(Number.parseInt(declaredIn(button!, 'min-height') ?? '0', 10)).toBeGreaterThanOrEqual(36);

  // The attribution badge is a real, readable plate over the map, not a tooltip.
  const badge = viewRules().find(rule => rule.selector === '#overview .map-3d-attribution');
  expect(badge, 'the illustrative-relief attribution rule is missing').toBeDefined();
  expect(colour(declaredIn(badge!, 'color'))).toBe(token('ink'));
});
