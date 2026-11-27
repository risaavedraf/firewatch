import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test } from 'vitest';

// The aerial route is the only place where the product leaves its light chrome
// (`tokens.css` is `color-scheme: light`) for the dark slate console of the
// approved board. jsdom has no layout engine and applies no cascade, so what can
// be pinned here is the shipped stylesheet itself plus the arithmetic the browser
// would otherwise have to be trusted for: contrast is COMPUTED from the declared
// values, never eyeballed, and every selector is read from the file the browser
// receives.
//
// Four defects are owned by this suite:
//   1. a palette declared anywhere except the route scope would recolour the other
//      eleven views, which is the item-3 risk of this slice;
//   2. a dark surface without re-measured text, border and risk colours would ship
//      unreadable labels that no jsdom test can see;
//   3. a "dark theme" that changed one background and left the map a light card
//      would not be the map-first composition the design decision asks for;
//   4. removing the risk fills from the map to make the dark surface "work" would
//      silently drop the only meaning the fills carry.

const aerialCss = readFileSync(resolve(process.cwd(), 'src', 'styles', 'aerial-workspace.css'), 'utf8');
const tokenCss = readFileSync(resolve(process.cwd(), 'src', 'styles', 'tokens.css'), 'utf8');

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

function roots(): CssRule[] {
  return rules.filter(rule => rule.selector.startsWith('body:has(#overview)'));
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

// The route palette is read from the custom properties the file declares, so a
// colour changed anywhere in the file is measured again instead of passing on the
// strength of a literal that happens to be repeated here.
function aerialValue(name: string): string {
  for (const rule of roots()) {
    const value = declaredIn(rule, `--aerial-${name}`);
    if (value !== undefined) return value;
  }
  throw new Error(`the route palette declares no --aerial-${name}`);
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
  return (lighter + 0.05) / (darker + 0.05);
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

// The shell rows this route is allowed to re-base, by their own root class. The
// list is checked as a prefix so `body:has(#overview) .product-nav__link` is
// allowed while a bare `.panel`, a bare element or a wildcard is not: those would
// restyle a shared surface on every route, which is exactly the risk this slice
// carries.
const SHELL_ROOTS = [
  ':focus-visible',
  'main',
  'footer',
  '.topbar',
  '.breadcrumbs',
  '.zone-chip',
  '.update-bar',
  '.product-nav',
  '.sidebar',
  '.sidebar-bottom',
  '.brand',
  '.workspace',
  '.health-card',
  '.health-head',
  '.side-action',
  '.session-card',
  '.session-mark',
];

test('the dark console is declared only for this route, and the global tokens stay light (T2)', () => {
  // No `:root` block: a token edited here would be a global token edit, and
  // `tokens.css` is the one file that owns them.
  expect(rules.filter(rule => rule.selector === ':root')).toEqual([]);

  // Every rule is anchored to the route: either the view's own subtree or the
  // shell rows of the route that renders it.
  const unanchored = rules.filter(
    rule => !rule.selector.startsWith('#overview') && !rule.selector.startsWith('body:has(#overview)'),
  );
  expect(unanchored.map(rule => rule.selector)).toEqual([]);

  // The palette itself is declared on the route anchor, so the nav/header rows can
  // read the same roles the console does.
  const paletteOwners = rules.filter(rule => declaredIn(rule, '--aerial-water') !== undefined);
  expect(paletteOwners.map(rule => rule.selector)).toEqual(['body:has(#overview)']);

  // The shared palette is untouched: still a light scheme, and none of the aerial
  // roles leaked into it.
  expect(tokenCss).toMatch(/color-scheme:\s*light/);
  for (const name of ['--aerial-water', '--aerial-panel', '--aerial-raised', '--aerial-accent']) {
    expect(tokenCss, `${name} belongs to the route, not to the shared tokens`).not.toContain(name);
  }
});

test('the route re-bases the shell rows it owns and nothing else (T2)', () => {
  const targets = new Set<string>();
  for (const rule of roots()) {
    for (const part of rule.selector.replace(/body:has\(#overview\)/g, '').trim().split(',')) {
      const target = part.trim().replace(/\s+/g, ' ');
      if (target !== '') targets.add(target);
    }
  }
  // Every target must start at one of the shell roots this route owns. A bare
  // element, a wildcard or another route's class is a leak and fails here.
  const leaked = [...targets].filter(target => {
    const root = target.split(/[\s>+~]/)[0];
    // A root is allowed when it IS one of the shell roots, or when it is that
    // root's own BEM block/modifier/pseudo (`.brand-mark`, `.product-nav__link`,
    // `.session-card button`). Bare elements and other views' classes are not.
    return !SHELL_ROOTS.some(allowed => {
      if (root === allowed) return true;
      if (!allowed.startsWith('.')) return false;
      return /^(?:__|-|\[|:)/.test(root.slice(allowed.length)) && root.startsWith(allowed);
    });
  });
  expect(leaked).toEqual([]);

  // The visible chrome of this route is the approved slate, bound to the measured
  // roles rather than to new literals.
  const navRule = roots().find(rule => rule.selector === 'body:has(#overview) .product-nav');
  const sidebarRule = roots().find(rule => rule.selector === 'body:has(#overview) .sidebar');
  expect(declaredIn(navRule!, 'background')).toBe('var(--aerial-panel)');
  expect(declaredIn(sidebarRule!, 'background')).toBe('var(--aerial-water)');

  // Nothing on this route may be hidden to make the fold fit: the correction is
  // spacing and colour, never `display: none` of required content.
  expect(aerialCss).not.toMatch(/display:\s*none/);

  // The console itself carries a surface, a boundary and the room the board gives
  // its canvas: without them the dark palette would sit as a bare background.
  const surfaces = viewRules().filter(rule => rule.selector === '#overview');
  const surface = surfaces.map(rule => declarations(rule.body));
  const background = surface.map(entry => entry.get('background')).find(value => value !== undefined);
  expect(background).toMatch(/var\(--(?:aerial-water|water)\)/);
  expect(surface.map(entry => entry.get('padding')).find(value => value !== undefined)).toBeTruthy();
  expect(surface.map(entry => entry.get('border')).find(value => value !== undefined)).toBeTruthy();
});

test('the dark palette is the approved board’s, and every new pair is measured for WCAG AA (T2)', () => {
  // The four roles the design decision names, as declared.
  expect(aerialValue('water')).toBe('#152934');
  expect(aerialValue('panel')).toBe('#17222b');
  expect(aerialValue('raised')).toBe('#243341');
  expect(aerialValue('accent')).toBe('#94dfda');

  const water = aerialValue('water');
  const panel = aerialValue('panel');
  const raised = aerialValue('raised');
  const edge = aerialValue('edge');

  // Normal text on both surfaces the route paints: 4.5:1 minimum.
  const text: Array<[string, string, string]> = [
    ['ink on panel', aerialValue('ink'), panel],
    ['ink on raised', aerialValue('ink'), raised],
    ['muted on panel', aerialValue('muted'), panel],
    ['muted on raised', aerialValue('muted'), raised],
    ['accent on panel', aerialValue('accent'), panel],
    ['accent on raised', aerialValue('accent'), raised],
    ['risk label on panel', aerialValue('warm'), panel],
    ['range label on panel', aerialValue('gold'), panel],
    ['ink on water', aerialValue('ink'), water],
    ['muted on water', aerialValue('muted'), water],
    ['nav link on the bar', aerialValue('muted'), panel],
    ['current nav item on its surface', aerialValue('accent'), raised],
    ['nav panel item on the bar', aerialValue('ink'), panel],
    ['brand mark glyph on its block', water, aerialValue('accent')],
    ['session label on the column', aerialValue('ink'), water],
    ['logout label on the column', aerialValue('ink'), water],
  ];
  for (const [label, foreground, background] of text) {
    expect(rounded(contrast(foreground, background)), `${label}: ${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
  }

  // Boundaries and the focus indicator: 3:1 minimum.
  for (const [label, background] of [
    ['panel', panel],
    ['water', water],
    ['raised', raised],
  ] as const) {
    expect(rounded(contrast(edge, background)), `border against ${label}`).toBeGreaterThanOrEqual(3);
  }
  expect(rounded(contrast(edge, panel)), 'nav summary border on the bar').toBeGreaterThanOrEqual(3);
  expect(rounded(contrast(edge, water)), 'workspace frame and logout border on the column').toBeGreaterThanOrEqual(3);
  expect(rounded(contrast(aerialValue('accent'), panel)), 'focus ring on panel').toBeGreaterThanOrEqual(3);
  expect(rounded(contrast(aerialValue('accent'), water)), 'focus ring on the map').toBeGreaterThanOrEqual(3);

  // The focus ring of the route is the measured accent, not the light-theme
  // literal, which was chosen against paper.
  const focus = roots().find(rule => rule.selector === 'body:has(#overview) :focus-visible');
  expect(focus, 'the route declares no focus ring').toBeDefined();
  expect(declaredIn(focus!, 'outline-color')).toMatch(/var\(--aerial-accent\)/);

  // The shipped status dots are graphics, not text: 3:1 against the column they
  // are painted on. Their hues are unchanged; only the surface moved.
  for (const [label, hue] of [
    ['ready dot', '#67c99a'],
    ['down dot', '#d77b67'],
    ['unknown dot', '#a1b3ae'],
  ] as const) {
    expect(rounded(contrast(hue, water)), `${label} on the column`).toBeGreaterThanOrEqual(3);
  }
});

test('the map reads as the canvas, and the risk fills keep the meaning they carry (T2)', () => {
  // The map is the dominant surface: the biggest floor of the route, on the
  // water tone, with the keyboard-reachable legend beside it. The floor is 480 px
  // rather than taller because at 1440×900 the whole canvas — not a slice of it —
  // has to reach the first fold after the shell's own rows; 560 px pushed the
  // bottom of the map below it, which is the opposite of map-first.
  const viewport = viewRules().filter(rule => /\.map-viewport\s*$/.test(rule.selector) && rule.atRule === null);
  expect(viewport).toHaveLength(1);
  const floor = Number.parseInt(declaredIn(viewport[0], 'min-height') ?? '0', 10);
  expect(floor, 'the map must be the tallest surface of the route').toBeGreaterThanOrEqual(480);
  expect(declaredIn(viewport[0], 'background')).toMatch(/var\(--aerial-water\)/);
  expect(declaredIn(viewport[0], 'border')).toBe(`1px solid var(--aerial-edge)`);

  // The canvas track is the flexible one and the rail is the bounded supporting
  // column: the workspace reads as a canvas plus an instrument panel.
  const workspace = viewRules().find(rule => rule.selector === '#overview .aerial-workspace');
  expect(workspace, 'the composition rule is missing').toBeDefined();
  const columns = declaredIn(workspace!, 'grid-template-columns') ?? '';
  expect(columns).toMatch(/minmax\(0,\s*1fr\)/);
  const railWidth = Number.parseInt((columns.match(/minmax\(\s*\d+px,\s*(\d+)px\s*\)/) ?? [])[1] ?? '0', 10);
  expect(railWidth).toBeGreaterThan(0);
  expect(railWidth).toBeLessThanOrEqual(336);

  // The four level fills are the map's vocabulary. Recolouring them for the dark
  // surface would break the legend's promise that a swatch is what the map shows.
  expect(aerialCss).not.toMatch(/--level-(?:low|medium|high|unknown|neutral)-(?:fill|line)\s*:/);

  // …and they stay legible as shapes against the new surface (graphics: 3:1).
  const fills: Array<[string, string]> = [
    ['low', '#84ab8e'],
    ['medium', '#d0b756'],
    ['high', '#c77454'],
    ['unknown', '#c3cbcd'],
    ['neutral', '#e6ecea'],
  ];
  for (const [level, fill] of fills) {
    expect(rounded(contrast(fill, aerialValue('water'))), `the ${level} fill on the map surface`).toBeGreaterThanOrEqual(3);
  }
});

test('the workstation stays a supporting surface with its target sizes intact (T2)', () => {
  const rail = viewRules().find(rule => rule.selector === '#overview .aerial-rail');
  expect(rail, 'the rail rule is missing').toBeDefined();
  expect(declaredIn(rail!, 'background')).toMatch(/var\(--aerial-raised\)/);
  expect(declaredIn(rail!, 'border')).toBe('1px solid var(--aerial-edge)');
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
// a stack of shell chrome, and the route's own chrome was still forest green. The
// browser probe measures the fold itself; what can be pinned here is the shape of
// the correction, so a later edit cannot quietly undo it.
test('the narrow viewport compacts the enclosing chrome instead of hiding it (T2)', () => {
  const narrow = rules.filter(rule => rule.atRule === '@media (max-width: 720px)');
  expect(narrow.length).toBeGreaterThan(0);
  const narrowRules = new Map(narrow.map(rule => [rule.selector, rule.body]));

  // The column becomes a row of the same landmarks, not a shorter list of them.
  const sidebar = narrowRules.get('body:has(#overview) .sidebar');
  expect(sidebar, 'the narrow sidebar rule is missing').toBeDefined();
  expect(sidebar).toMatch(/flex-direction:\s*row/);
  expect(sidebar).toMatch(/flex-wrap:\s*wrap/);
  // …and it may not pin a height: a fixed 560px column on a phone is the defect.
  expect(sidebar).not.toMatch(/height:\s*\d/);

  // Each shell row keeps a rule in the narrow block, so the compaction is explicit
  // per row instead of a blanket scale that could swallow a control.
  for (const selector of [
    'body:has(#overview) .topbar',
    'body:has(#overview) main',
    'body:has(#overview) .session-card button',
  ]) {
    expect(narrowRules.get(selector), `${selector} must keep a narrow rule`).toBeDefined();
  }

  // The logout control keeps a real target size on the phone: it is the one
  // control the shell may never trade away for space.
  const logout = narrowRules.get('body:has(#overview) .session-card button') ?? '';
  const minHeight = Number.parseInt((logout.match(/min-height:\s*(\d+)px/) ?? [])[1] ?? '0', 10);
  expect(minHeight).toBeGreaterThanOrEqual(24);
});
