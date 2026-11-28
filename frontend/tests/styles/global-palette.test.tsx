import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test } from 'vitest';

// S8 — «mejorar los colores que ya vimos que solo se vé en mapa, tiene que ser los
// nuevos colores globalres».
//
// T2 put the approved dark palette behind `body:has(#overview)`, so eleven of the
// twelve views kept the cream/forest chrome and only the map looked like the
// board. T10 promotes that palette to the one place the whole application reads
// its roles from — `tokens.css` `:root` — and this suite is the gate that keeps it
// there:
//
//   1. the base roles are the board's slate/aqua values, and they are explicit hex
//      literals so contrast can be COMPUTED here instead of eyeballed in a browser;
//   2. every text pair the global sheets paint clears 4.5:1, and every boundary or
//      focus indicator clears 3:1, on the surfaces they are actually declared for;
//   3. the six risk roles (low, medium, high, extreme, unknown, neutral) carry a
//      text-on-fill pair of their own, so a chip or a tablet never has to invent a
//      colour the map does not know;
//   4. the legacy aliases (`--forest-*`, `--gold`, `--terracotta`) still resolve,
//      but to slate/aqua/amber/coral tones — the old cream and forest literals must
//      not come back through an alias;
//   5. `@media print` keeps a light paper palette, so the views that print for a
//      handover stay readable on white.
//
// jsdom has no layout engine and applies no cascade, so what is pinned is the
// shipped stylesheet plus the arithmetic the browser would otherwise be trusted
// for.

const tokensCss = readFileSync(resolve(process.cwd(), 'src', 'styles', 'tokens.css'), 'utf8');
const appCss = readFileSync(resolve(process.cwd(), 'src', 'styles', 'app.css'), 'utf8');
const productNavCss = readFileSync(resolve(process.cwd(), 'src', 'styles', 'product-nav.css'), 'utf8');
const aerialCss = readFileSync(resolve(process.cwd(), 'src', 'styles', 'aerial-workspace.css'), 'utf8');
const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

// Prose is not a rule: a comment may name the route gate this suite forbids (or
// the literal it retires) without shipping it, so comments are removed before any
// "must not contain" check, exactly the way a CSS parser drops them.
function screenCss(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media\s+print[\s\S]*?\n\}/g, '');
}

// The screen palette is every `:root` declaration before the first print block:
// the print override is measured separately, because it is a paper palette.
const screenTokensCss = tokensCss.split(/@media\s+print/)[0];

function tokens(source: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of source.matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/g)) map.set(match[1], match[2]);
  return map;
}

const palette = tokens(screenTokensCss);

function token(name: string): string {
  const value = palette.get(name);
  if (value === undefined) throw new Error(`tokens.css declares no --${name} as an explicit hex value`);
  return value;
}

function channel(value: number): number {
  const ratio = value / 255;
  return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const digits = hex.replace('#', '');
  const [red, green, blue] = [0, 2, 4].map(index => parseInt(digits.slice(index, index + 2), 16) / 255);
  return 0.2126 * channel(red * 255) + 0.7152 * channel(green * 255) + 0.0722 * channel(blue * 255);
}

function contrast(foreground: string, background: string): number {
  const [first, second] = [luminance(foreground), luminance(background)];
  const [lighter, darker] = first > second ? [first, second] : [second, first];
  return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100;
}

// The print block that paints one route, read as text: jsdom applies no cascade, so
// what is pinned is the declaration the browser would use on paper. Comments go
// first — prose may name a literal or a rule without shipping it.
function routePrintBlock(css: string, marker: string): string {
  for (const match of css.matchAll(/@media\s+print\s*\{[\s\S]*?\n\}/g)) {
    if (match[0].includes(marker)) return match[0].replace(/\/\*[\s\S]*?\*\//g, ' ');
  }
  throw new Error(`no @media print block paints ${marker}`);
}

// The value a printed selector declares for a property, read at its own boundaries:
// the selector is compared whole after collapsing whitespace, and the value ends at
// the `;` that closes it, so a lookalike selector or a value in a comment cannot
// stand in for the declaration the symbol is actually painted with.
function printedDeclaration(block: string, selector: string, property: string): string | undefined {
  for (const rule of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = rule[1].split(',').map(part => part.trim().replace(/\s+/g, ' '));
    if (!selectors.includes(selector)) continue;
    for (const part of rule[2].split(';')) {
      const colon = part.indexOf(':');
      if (colon !== -1 && part.slice(0, colon).trim() === property) {
        return part.slice(colon + 1).replace(/\s+/g, ' ').trim();
      }
    }
  }
  return undefined;
}

test('the aerial night palette is the global base palette, declared once in tokens.css (S8)', () => {
  // A dark scheme is a document-level decision: the form controls, the scrollbars
  // and the native pickers follow it, so declaring the surfaces dark without it
  // would leave white selects on a slate page.
  expect(screenTokensCss).toMatch(/color-scheme:\s*dark/);

  // The board's exact roles, as required by the design migration.
  expect(token('canvas')).toBe('#0f1922');
  expect(token('aerial-water')).toBe('#152934');
  expect(token('paper')).toBe('#17222b');
  expect(token('soft')).toBe('#21313f');
  expect(token('surface-raised')).toBe('#243341');
  expect(token('ink')).toBe('#f4f1eb');
  expect(token('muted')).toBe('#b8c8d2');
  expect(token('line')).toBe('#354b5c');
  expect(token('edge')).toBe('#647b8a');
  expect(token('accent')).toBe('#94dfda');
  expect(token('focus')).toBe('#94dfda');
  // The ink the accent is filled with. `#94dfda` is a light tone: light-on-light
  // is the defect this role exists to prevent.
  expect(token('accent-ink')).toBe('#0c1b24');

  // The old cream/forest palette must not survive anywhere in the base tokens,
  // including behind an alias.
  for (const retired of [
    '#f5f5ef',
    '#fffefa',
    '#233b39',
    '#5c6c65',
    '#dde3da',
    '#eef1e9',
    '#102c2d',
    '#173c3b',
    '#285e56',
    '#638579',
    '#a74d34',
    '#85691e',
  ]) {
    expect(screenTokensCss.toLowerCase(), `${retired} is a retired light-theme literal`).not.toContain(retired);
  }
});

test('every global text pair clears 4.5:1 on the surface it is painted on (S8)', () => {
  const surfaces: Array<[string, string]> = [
    ['canvas', token('canvas')],
    ['aerial water', token('aerial-water')],
    ['paper', token('paper')],
    ['soft', token('soft')],
    ['raised', token('surface-raised')],
  ];

  for (const [name, surface] of surfaces) {
    for (const role of ['ink', 'muted', 'accent']) {
      expect(contrast(token(role), surface), `${role} on ${name}`).toBeGreaterThanOrEqual(4.5);
    }
  }

  // The accent as a filled control: its label is the dark ink, never the light one.
  expect(contrast(token('accent-ink'), token('accent'))).toBeGreaterThanOrEqual(4.5);
  expect(contrast(token('ink'), token('accent')), 'the light ink must NOT be the accent label').toBeLessThan(4.5);

  // Boundaries and the focus indicator are non-text: 3:1 on every surface the
  // global sheets paint a control border or a ring on. The board's `--edge`
  // measures 2.92 on the raised role, so a boundary painted there uses
  // `--edge-strong` — the same one-step correction T2 made for its route edge.
  for (const [name, surface] of surfaces.filter(([surfaceName]) => surfaceName !== 'raised')) {
    expect(contrast(token('edge'), surface), `edge boundary on ${name}`).toBeGreaterThanOrEqual(3);
  }
  for (const [name, surface] of surfaces) {
    expect(contrast(token('edge-strong'), surface), `edge-strong boundary on ${name}`).toBeGreaterThanOrEqual(3);
  }
  for (const [name, surface] of surfaces) {
    expect(contrast(token('focus'), surface), `focus ring on ${name}`).toBeGreaterThanOrEqual(3);
  }

  // The readable text roles the legacy sheets still paint with.
  for (const role of ['forest-700', 'forest-950', 'gold', 'terracotta', 'muted']) {
    expect(contrast(token(role), token('paper')), `${role} on paper`).toBeGreaterThanOrEqual(4.5);
  }
});

test('the six risk roles carry their own text-on-fill pair instead of borrowing the light palette (S8)', () => {
  const levels = ['low', 'medium', 'high', 'extreme', 'unknown', 'neutral'] as const;

  for (const level of levels) {
    const fill = token(`level-${level}-fill`);
    const line = token(`level-${level}-line`);
    const ink = token(`level-${level}-ink`);
    const surface = token(`level-${level}-surface`);
    const text = token(`level-${level}-text`);

    // Shapes on the map: the fill is legible against the map surface and against
    // the card the legend sits on (graphics: 3:1).
    expect(contrast(fill, token('aerial-water')), `${level} fill on the map`).toBeGreaterThanOrEqual(3);
    expect(contrast(fill, token('paper')), `${level} fill on paper`).toBeGreaterThanOrEqual(3);
    expect(contrast(line, token('aerial-water')), `${level} outline on the map`).toBeGreaterThanOrEqual(3);
    // Text painted on the fill (tablets, marks that carry a glyph).
    expect(contrast(ink, fill), `${level} ink on its fill`).toBeGreaterThanOrEqual(4.5);
    // Text painted on the chip surface.
    expect(contrast(text, surface), `${level} text on its surface`).toBeGreaterThanOrEqual(4.5);
  }

  // The map and the legend promise the same colour: the fills are one set of roles.
  expect(aerialCss).not.toMatch(/--level-(?:low|medium|high|extreme|unknown|neutral)-(?:fill|line|ink|surface|text)\s*:/);
  expect(appCss).toMatch(/\.swatch-bajo\s*\{[^}]*background:\s*var\(--level-low-fill\)/);
});

test('the legacy aliases still resolve, but to the dark-harmonious tones (S8)', () => {
  // Explicit hex literals, not `var()` chains: the automated contrast readers in
  // this suite and in `actions-accessibility` read the declaration itself.
  expect(token('forest-950')).toBe('#f4f1eb');
  expect(token('forest-900')).toBe('#17222b');
  expect(token('forest-700')).toBe('#94dfda');
  expect(token('forest-500')).toBe('#b8c8d2');
  expect(token('terracotta')).toBe('#f0a184');
  expect(token('gold')).toBe('#e5c87e');
  expect(token('terracotta-soft')).toBe('#3b2a24');
  expect(token('gold-soft')).toBe('#33301f');

  // The alias families keep their meaning: a gold chip is still gold-on-gold-soft,
  // a coral note is still coral-on-coral-soft.
  expect(contrast(token('gold'), token('gold-soft'))).toBeGreaterThanOrEqual(4.5);
  expect(contrast(token('terracotta'), token('terracotta-soft'))).toBeGreaterThanOrEqual(4.5);
});

test('the palette is global: no stylesheet traps it behind a route or styles the removed sidebar (S7/S8)', () => {
  // The document metadata follows the palette, so a phone's browser chrome is slate
  // instead of the old forest green.
  expect(indexHtml).toMatch(/<meta\s+name="theme-color"\s+content="#152934"\s*\/?>/);

  const app = screenCss(appCss);
  const nav = screenCss(productNavCss);
  const aerial = screenCss(aerialCss);

  // The shell and its sheets are route-independent now: no view gate may own the
  // palette again.
  expect(app).not.toMatch(/body:has\(#overview\)/);
  expect(nav).not.toMatch(/body:has\(#overview\)/);

  // The aerial sheet keeps the composition of its route and nothing else: it may
  // read the shared roles, but it may not declare them.
  expect(aerial).not.toMatch(/--aerial-[\w-]+\s*:/);
  expect(aerial).not.toMatch(/--canvas\s*:|--paper\s*:|--soft\s*:|--ink\s*:|--muted\s*:|--line\s*:/);

  // S7 retired the column: no sheet may keep styling a `.sidebar` the DOM no
  // longer renders.
  for (const [name, css] of [
    ['app.css', app],
    ['product-nav.css', nav],
    ['aerial-workspace.css', aerial],
  ] as const) {
    expect(css, `${name} still styles the retired .sidebar`).not.toMatch(/\.sidebar\b/);
  }

  // The product navigation is always slate/aqua, not forest green.
  expect(productNavCss).toMatch(/background:\s*var\(--paper\)/);
  for (const retired of ['#f0eee0', '#e7faf5', '#90aaa0', '#254d47', '#1e4241', '#a5c8bf', '#c3d6cf', '#d7aa73', '#41625b']) {
    expect(nav.toLowerCase(), `${retired} is a retired forest literal`).not.toContain(retired);
  }
});

test('the global sheets are painted with roles, not with light-theme literals (S8)', () => {
  // The print blocks legitimately force black on white, and a comment may name a
  // literal it retired; both are removed before the screen literals are checked.
  const screen = screenCss(appCss);

  for (const retired of [
    '#f5f5ef',
    '#fffefa',
    '#edf1f2',
    '#f3f4ed',
    '#f8faf7',
    '#eef2e8',
    '#e8f5ef',
    '#e7f0e6',
    '#e3efef',
    '#faf7ee',
    '#fcf6f0',
    '#fdf6e8',
    '#f5f8f1',
    '#eef3ea',
    '#eef4f1',
    '#d4dfd0',
    '#ced8cb',
    '#d6e3df',
    '#ead9ca',
    '#d9e3dc',
    '#eef1ee',
    '#edf0e7',
    '#e8e9df',
    '#a1b49d',
    '#65736b',
    '#944a39',
    '#9c472f',
    '#7d6c3f',
    '#c8bda0',
    '#cf7d4f',
  ]) {
    expect(screen.toLowerCase(), `${retired} is a retired light-theme literal`).not.toContain(retired);
  }

  // A white overlay on a dark card is not a surface; the roles are.
  expect(screen).not.toMatch(/rgb\(255 255 255/);

  // The page, the shared focus ring and the primary control read the global roles.
  expect(appCss).toMatch(/body\s*\{[^}]*background:\s*var\(--canvas\);[^}]*color:\s*var\(--ink\)/);
  expect(appCss).toMatch(/\[tabindex\]:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--focus\)/);
  expect(appCss).toMatch(/\.primary-button[^{}]*\{[^}]*background:\s*var\(--accent\);[^}]*color:\s*var\(--accent-ink\)/);
  expect(appCss).toMatch(/input, select, textarea\s*\{[^}]*background:\s*var\(--paper\);[^}]*color:\s*var\(--ink\)/);
});

test('print keeps a light paper palette for the pages that are printed (S8)', () => {
  const printBlock = tokensCss.slice(tokensCss.indexOf('@media print'));
  const paper = tokens(printBlock);

  expect(paper.get('canvas')).toBe('#ffffff');
  expect(paper.get('paper')).toBe('#ffffff');
  expect(paper.get('aerial-water')).toBe('#ffffff');
  expect(paper.get('ink')).toBe('#111111');

  for (const name of ['ink', 'muted', 'accent', 'forest-700', 'gold', 'terracotta']) {
    const value = paper.get(name);
    expect(value, `the print block keeps --${name}`).toBeDefined();
    expect(contrast(value as string, '#ffffff'), `${name} on printed paper`).toBeGreaterThanOrEqual(4.5);
  }
});

test('print repaints every infrastructure map symbol for the white paper (S8)', () => {
  // The marker hues are dark-adapted for the slate map surface they are drawn on,
  // and the infrastructure print block forces that surface to `#ffffff` ("Print-to-PDF
  // without a library"). Repainting the background without repainting the symbols
  // left the printed catalogue almost empty: measured on white, the shipped screen
  // fills are 1.70:1 (hydrant), 2.00:1 (housing), 2.25:1 (hospital), 2.27:1 (school)
  // and 2.41:1 (route) — and the default legend swatch 1.36:1. Print therefore
  // restates all five symbols in deeper versions of their own hues, so the printed
  // sheet keeps both the shapes and the distinctions between them.
  const print = routePrintBlock(appCss, '#infrastructure');

  const symbols: Array<[selector: string, property: string, what: string]> = [
    ['body:has(#infrastructure) .infrastructure-legend-marker', 'background', 'the legend default swatch'],
    ['body:has(#infrastructure) .infrastructure-legend-colegio', 'background', 'the school legend swatch'],
    ['body:has(#infrastructure) .infrastructure-legend-vivienda', 'background', 'the housing legend swatch'],
    ['body:has(#infrastructure) .infrastructure-legend-hospital', 'background', 'the hospital legend swatch'],
    ['body:has(#infrastructure) .infrastructure-legend-hidrante', 'background', 'the hydrant legend swatch'],
    ['body:has(#infrastructure) .infrastructure-legend-ruta', 'background', 'the route legend swatch'],
    ['body:has(#infrastructure) .infrastructure-marker-colegio', 'fill', 'the school marker'],
    ['body:has(#infrastructure) .infrastructure-marker-vivienda', 'fill', 'the housing marker'],
    ['body:has(#infrastructure) .infrastructure-marker-hospital', 'fill', 'the hospital marker'],
    ['body:has(#infrastructure) .infrastructure-marker-hidrante', 'fill', 'the hydrant marker'],
    ['body:has(#infrastructure) .infrastructure-route', 'stroke', 'the route line'],
  ];

  // Distinct hues: one printed colour for every symbol would keep the contrast and
  // lose the legend, because the shapes are the only other distinction and the
  // legend states them in the same sentence.
  const printed = new Set<string>();

  for (const [selector, property, what] of symbols) {
    const value = printedDeclaration(print, selector, property);
    expect(value, `${what} must be repainted by \`${selector} { ${property}: … }\` inside @media print`).toBeDefined();
    expect(value as string, `${what} must be an explicit hex literal so the printed paper can be measured`).toMatch(/^#[0-9a-fA-F]{6}$/);

    // 4.5:1 rather than the 3:1 a non-text graphic is allowed: a printed sheet adds
    // ink spread, a grey substrate and a consumer printer to the same symbol.
    expect(contrast(value as string, '#ffffff'), `${what} (${value as string}) on printed paper`).toBeGreaterThanOrEqual(4.5);
    printed.add((value as string).toLowerCase());
  }

  expect(printed.size, 'the printed symbols must stay distinguishable from each other').toBe(6);
});
