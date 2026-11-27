import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test } from 'vitest';

// S7/S8 — «la unica pagina que se vé con los nuevos colores es el mapa … y así con
// las demás … tiene que ser los nuevos colores globalres … mejorar el ux un poco y
// poner de una vez el nuevo diseño más interactivo».
//
// T10 promoted the aerial night palette to `tokens.css` `:root` and retired the
// 234 px column. The seven route sheets the remaining twelve views import were
// written against the OLD light page, so once `--ink`/`--muted` turned light their
// cream/white islands became unreadable: `#edf1f2` under `--ink` measures 1.01:1,
// `#f8faf7` under `--muted` 1.64:1, `#fdf6ef` under `--muted` 1.60:1. This suite is
// the gate that keeps those islands from coming back:
//
//   1. no screen rule in the seven sheets may carry a pale/cream/white surface
//      literal — the print block is measured separately, because paper is white;
//   2. every state card, tag, chip, banner and empty state sits on a dark surface:
//      a shared role from `tokens.css`, or a local tone dark enough to white out at
//      >= 7:1, never a light island;
//   3. the text painted inside those states clears WCAG AA 4.5:1 against the
//      surface it actually resolves to;
//   4. no rule anywhere in the seven sheets paints text the surface swallows —
//      that is the class of defect behind `--forest-900` on `--soft` (1.13:1);
//   5. the coverage map is a dark cartographic plate on screen and keeps its
//      black-on-white printable ficha, markers included;
//   6. the interactive states the polish adds are declared, their focus ring is the
//      global focus role, and the motion they add is removable.
//
// jsdom has no layout engine and applies no cascade, so what is pinned is the
// shipped stylesheet plus the arithmetic a browser would otherwise be trusted for.

const SHEETS = [
  'decision-workspace.css',
  'field-workspace.css',
  'history-workspace.css',
  'notifications.css',
  'observations.css',
  'operations-workspace.css',
  'territorial-coverage.css',
] as const;

type Sheet = (typeof SHEETS)[number];

interface Rule {
  selector: string;
  declarations: Map<string, string>;
  atRules: string[];
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

// A real (tiny) brace walker instead of a regex: these sheets mix one-line and
// multi-line rules, and a `@media` wrapper must not be confused with the rule
// inside it — the print block is exactly what has to stay measurable.
function parse(source: string): Rule[] {
  const parsed: Rule[] = [];
  const walk = (text: string, atRules: string[]): void => {
    let index = 0;
    let start = 0;
    while (index < text.length) {
      if (text[index] !== '{') {
        index += 1;
        continue;
      }
      const selector = text.slice(start, index).trim();
      let depth = 1;
      let cursor = index + 1;
      while (cursor < text.length && depth > 0) {
        if (text[cursor] === '{') depth += 1;
        else if (text[cursor] === '}') depth -= 1;
        cursor += 1;
      }
      const body = text.slice(index + 1, cursor - 1);
      if (selector.startsWith('@')) {
        walk(body, [...atRules, selector]);
      } else if (selector.length > 0) {
        parsed.push({
          selector: selector.replace(/\s+/g, ' '),
          declarations: declarations(body),
          atRules,
        });
      }
      index = cursor;
      start = cursor;
    }
  };
  walk(stripComments(source), []);
  return parsed;
}

function declarations(body: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of body.split(';')) {
    const separator = part.indexOf(':');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim().toLowerCase();
    const value = part.slice(separator + 1).replace(/!important/gi, '').trim();
    if (name.length > 0 && value.length > 0) map.set(name, value);
  }
  return map;
}

const sources = new Map<Sheet, string>(
  SHEETS.map(name => [name, readFileSync(resolve(process.cwd(), 'src', 'styles', name), 'utf8')]),
);
const parsed = new Map<Sheet, Rule[]>(SHEETS.map(name => [name, parse(sources.get(name) as string)]));

function isPrint(rule: Rule): boolean {
  return rule.atRules.some(atRule => /@media\s+print/.test(atRule));
}

function screenRules(sheet: Sheet): Rule[] {
  return (parsed.get(sheet) ?? []).filter(rule => !isPrint(rule));
}

function printRules(sheet: Sheet): Rule[] {
  return (parsed.get(sheet) ?? []).filter(isPrint);
}

// A selector may be declared more than once: a `@media` override repeats it to
// change padding, and the notification chips declare their type in one rule and
// their colour in another. The cascade merges those declarations instead of
// replacing the whole rule, so the arithmetic reads the colour the surface keeps.
function declarationsIn(sheet: Sheet, selector: string, print = false): Map<string, string> {
  const wanted = selector.replace(/\s+/g, ' ');
  const merged = new Map<string, string>();
  for (const rule of parsed.get(sheet) ?? []) {
    if (isPrint(rule) !== print) continue;
    const matches = rule.selector
      .split(',')
      .map(part => part.trim())
      .includes(wanted);
    if (!matches) continue;
    for (const [name, value] of rule.declarations) merged.set(name, value);
  }
  return merged;
}

function requireSelector(sheet: Sheet, selector: string, print = false): Map<string, string> {
  const declarations = declarationsIn(sheet, selector, print);
  expect(declarations.size, `${sheet} declares no rule for \`${selector}\``).toBeGreaterThan(0);
  return declarations;
}

// ── colour maths ───────────────────────────────────────────────────────────

function channel(value: number): number {
  const ratio = value / 255;
  return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const digits = hex.replace('#', '');
  const [red, green, blue] = [0, 2, 4].map(index => channel(Number.parseInt(digits.slice(index, index + 2), 16)));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(foreground: string, background: string): number {
  const [first, second] = [luminance(foreground), luminance(background)];
  const [lighter, darker] = first > second ? [first, second] : [second, first];
  return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100;
}

// The shared roles, read from the declaration rather than duplicated here: a
// `var()` chain would hide the measured value from this arithmetic.
const PALETTE = ((): Map<string, string> => {
  const tokensCss = readFileSync(resolve(process.cwd(), 'src', 'styles', 'tokens.css'), 'utf8');
  const palette = new Map<string, string>();
  for (const rule of parse(tokensCss)) {
    if (isPrint(rule)) continue;
    for (const [name, value] of rule.declarations) {
      if (name.startsWith('--') && /^#[0-9a-f]{6}$/.test(value.toLowerCase())) {
        palette.set(name.slice(2), value.toLowerCase());
      }
    }
  }
  return palette;
})();

function paletteRole(name: string): string {
  const value = PALETTE.get(name);
  expect(value, `tokens.css declares no --${name}`).toBeDefined();
  return value as string;
}

function hexOf(value: string | undefined): string | null {
  if (value === undefined) return null;
  const text = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  const short = /^#([0-9a-f]{3})$/.exec(text);
  if (short !== null) return `#${[...short[1]].map(digit => digit + digit).join('')}`;
  const reference = /^var\(--([\w-]+)\)$/.exec(text);
  if (reference !== null) return PALETTE.get(reference[1]) ?? null;
  return null;
}

function backgroundOf(declarations: Map<string, string>): string | null {
  return hexOf(declarations.get('background') ?? declarations.get('background-color'));
}

// ── 1. no pale island survives on screen ───────────────────────────────────

const RETIRED_SURFACE_LITERALS = [
  // the cream/white page
  '#fff',
  '#ffffff',
  '#fffefa',
  '#fffdf4',
  '#f6fff9',
  '#f8faf7',
  '#f5f5ef',
  '#f3f4ed',
  '#faf7ee',
  '#f5f8f1',
  '#eef3ea',
  '#eef4f1',
  // the pale pills and inputs
  '#edf1f2',
  '#eef1ee',
  '#edf0e7',
  '#e8e9df',
  '#eef2e8',
  '#e7f0e6',
  '#e3efef',
  '#fdf6ef',
  '#fcf6f0',
  '#fdf6e8',
  '#e8f5ef',
  // the pale borders and marks those cards were drawn with
  '#c8d2c6',
  '#e0c9b6',
  '#dfe8d8',
  '#d4dfd0',
  '#ced8cb',
  '#d6e3df',
  '#ead9ca',
  '#d9e3dc',
  '#c8bda0',
  '#cfe0e8',
  // the light-theme text tones that went with them
  '#9c472f',
  '#7f641e',
  '#755a22',
  '#396246',
  '#a1b49d',
  '#65736b',
  // the deep forest greens the dark page cannot be
  '#173c3b',
  '#102c2d',
  '#233b39',
  '#285e56',
  '#41625b',
  '#254d47',
];

test('no workspace sheet paints a pale, cream or white surface on screen (S8)', () => {
  const found: string[] = [];
  for (const sheet of SHEETS) {
    for (const rule of screenRules(sheet)) {
      for (const [property, value] of rule.declarations) {
        if (!/^(?:background|background-color)$/.test(property)) continue;
        const normalised = value.toLowerCase();
        for (const retired of RETIRED_SURFACE_LITERALS) {
          if (normalised.includes(retired)) {
            found.push(`${sheet} · ${rule.selector} · ${property}: ${value}`);
          }
        }
      }
    }
  }
  expect(found).toEqual([]);
});

// ── 2. every state surface is dark ─────────────────────────────────────────

const SHARED_DARK_SURFACES = ['canvas', 'aerial-water', 'paper', 'soft', 'surface-raised'];

const STATE_SURFACES: ReadonlyArray<[Sheet, string]> = [
  ['history-workspace.css', '#history .history-empty-card'],
  ['field-workspace.css', '#actions .field-state'],
  ['field-workspace.css', '#simulator .field-state'],
  ['field-workspace.css', '#observations .field-state'],
  ['field-workspace.css', '#actions .field-state-filtered'],
  ['field-workspace.css', '#actions .field-state-error'],
  ['field-workspace.css', '#simulator .field-state-error'],
  ['field-workspace.css', '#observations .field-state-error'],
  ['field-workspace.css', '#observations .observation-type'],
  ['notifications.css', '.notification-level'],
  ['notifications.css', '.notification-level-bajo'],
  ['notifications.css', '.notification-level-medio'],
  ['notifications.css', '.notification-level-alto'],
  ['notifications.css', '#notifications .notification-empty'],
  ['observations.css', '#observations .neutral-tag'],
  ['observations.css', '.observations-form .author-note'],
  ['observations.css', '.observation-adoption'],
  ['observations.css', '.observation-adoption-link'],
  ['operations-workspace.css', '.ops-view-head'],
  ['operations-workspace.css', '.ops-block'],
  ['operations-workspace.css', '.ops-chip'],
  ['operations-workspace.css', '.ops-step-num'],
  ['decision-workspace.css', '.decision-summary__cell'],
  ['decision-workspace.css', '.decision-limits__item'],
  ['decision-workspace.css', '.decision-links'],
  ['territorial-coverage.css', '#infrastructure .coverage-entry[aria-pressed="true"]'],
  ['territorial-coverage.css', '#infrastructure .infrastructure-zone[data-active="true"]'],
  ['territorial-coverage.css', '#infrastructure .infrastructure-map'],
];

test('every state card, tag, chip, banner and empty state sits on a dark surface (S8)', () => {
  const shared = SHARED_DARK_SURFACES.map(paletteRole);
  const failures: string[] = [];

  for (const [sheet, selector] of STATE_SURFACES) {
    const background = backgroundOf(requireSelector(sheet, selector));
    if (background === null) {
      failures.push(`${sheet} · ${selector}: no resolvable background role`);
      continue;
    }
    // A shared role, or a local tone dark enough that white would white out on it
    // at >= 7:1 — the two ways a surface is allowed to be dark.
    if (!shared.includes(background) && contrast(background, '#ffffff') < 7) {
      failures.push(`${sheet} · ${selector}: ${background} is a light island (white on it ${contrast(background, '#ffffff')}:1)`);
    }
  }

  expect(failures).toEqual([]);
});

// ── 3. the text inside those states is readable ────────────────────────────

interface TextCase {
  sheet: Sheet;
  selector: string;
  /** Either a `--role` from tokens.css or the selector that paints the surface. */
  on: string;
}

const STATE_TEXT: ReadonlyArray<TextCase> = [
  { sheet: 'history-workspace.css', selector: '#history .history-empty-card strong', on: '#history .history-empty-card' },
  { sheet: 'history-workspace.css', selector: '#history .history-empty-card p', on: '#history .history-empty-card' },
  { sheet: 'field-workspace.css', selector: '#actions .field-state', on: '#actions .field-state' },
  { sheet: 'field-workspace.css', selector: '#actions .field-state > strong', on: '#actions .field-state' },
  { sheet: 'field-workspace.css', selector: '#actions .field-state .eyebrow', on: '#actions .field-state' },
  { sheet: 'field-workspace.css', selector: '#actions .field-state', on: '#actions .field-state-filtered' },
  { sheet: 'field-workspace.css', selector: '#actions .field-state-error', on: '#actions .field-state-error' },
  { sheet: 'field-workspace.css', selector: '#actions .field-state-error .eyebrow', on: '#actions .field-state-error' },
  { sheet: 'field-workspace.css', selector: '#observations .observation-type', on: '#observations .observation-type' },
  { sheet: 'notifications.css', selector: '.notification-level', on: '.notification-level' },
  { sheet: 'notifications.css', selector: '.notification-level-bajo', on: '.notification-level-bajo' },
  { sheet: 'notifications.css', selector: '.notification-level-medio', on: '.notification-level-medio' },
  { sheet: 'notifications.css', selector: '.notification-level-alto', on: '.notification-level-alto' },
  { sheet: 'notifications.css', selector: '#notifications .notification-empty-copy', on: '#notifications .notification-empty' },
  { sheet: 'notifications.css', selector: '#notifications .notification-empty-points', on: '#notifications .notification-empty' },
  { sheet: 'notifications.css', selector: '#notifications .notification-empty-points code', on: '#notifications .notification-empty' },
  { sheet: 'notifications.css', selector: '#notifications .notification-empty .eyebrow', on: '#notifications .notification-empty' },
  { sheet: 'notifications.css', selector: '.notification-demo', on: '--paper' },
  { sheet: 'observations.css', selector: '#observations .neutral-tag', on: '#observations .neutral-tag' },
  { sheet: 'observations.css', selector: '.observations-form .author-note', on: '.observations-form .author-note' },
  { sheet: 'observations.css', selector: '.observations-form .author-note strong', on: '.observations-form .author-note' },
  { sheet: 'observations.css', selector: '.observation-adoption-title', on: '.observation-adoption' },
  { sheet: 'observations.css', selector: '.observation-adoption-effect', on: '.observation-adoption' },
  { sheet: 'operations-workspace.css', selector: '.ops-chip', on: '.ops-chip' },
  { sheet: 'operations-workspace.css', selector: '.ops-view-head h2', on: '.ops-view-head' },
  { sheet: 'operations-workspace.css', selector: '.ops-lede', on: '.ops-view-head' },
  { sheet: 'operations-workspace.css', selector: '.ops-step-num', on: '.ops-step-num' },
  { sheet: 'decision-workspace.css', selector: '.decision-summary__cell strong', on: '.decision-summary__cell' },
  { sheet: 'decision-workspace.css', selector: '.decision-summary__label', on: '.decision-summary__cell' },
  { sheet: 'decision-workspace.css', selector: '.decision-limits__title', on: '.decision-limits__item' },
  { sheet: 'decision-workspace.css', selector: '.decision-limits__item p', on: '.decision-limits__item' },
  { sheet: 'decision-workspace.css', selector: '.decision-links a', on: '.decision-links' },
  { sheet: 'decision-workspace.css', selector: '.decision-links li span', on: '.decision-links' },
  { sheet: 'territorial-coverage.css', selector: '#infrastructure .coverage-entry', on: '--paper' },
  { sheet: 'territorial-coverage.css', selector: '#infrastructure .coverage-zone', on: '--paper' },
  { sheet: 'territorial-coverage.css', selector: '#infrastructure .coverage-figure', on: '--paper' },
  { sheet: 'territorial-coverage.css', selector: '#infrastructure .coverage-entry-types', on: '--paper' },
  { sheet: 'territorial-coverage.css', selector: '#infrastructure .coverage-stage-note', on: '--paper' },
  { sheet: 'territorial-coverage.css', selector: '#infrastructure .coverage-routes a', on: '--paper' },
  { sheet: 'territorial-coverage.css', selector: '#infrastructure .coverage-route-note', on: '--paper' },
  { sheet: 'territorial-coverage.css', selector: '#infrastructure .coverage-reading dd', on: '--paper' },
  { sheet: 'territorial-coverage.css', selector: '#infrastructure .infrastructure-zone-coverage', on: '--paper' },
];

test('the text inside every state clears WCAG AA 4.5:1 on the surface it resolves to (S8)', () => {
  const failures: string[] = [];

  for (const { sheet, selector, on } of STATE_TEXT) {
    const ink = hexOf(requireSelector(sheet, selector).get('color'));
    const surface = on.startsWith('--') ? hexOf(`var(${on})`) : backgroundOf(requireSelector(sheet, on));
    if (ink === null || surface === null) {
      failures.push(`${sheet} · ${selector} on ${on}: no resolvable colour pair`);
      continue;
    }
    const ratio = contrast(ink, surface);
    if (ratio < 4.5) {
      failures.push(`${sheet} · ${selector} on ${on}: ${ink} on ${surface} = ${ratio}:1`);
    }
  }

  expect(failures).toEqual([]);
});

// ── 4. no rule paints text the surface swallows ────────────────────────────

test('no rule in the seven sheets paints text below 4.5:1 on its own declared surface (S8)', () => {
  const failures: string[] = [];

  for (const sheet of SHEETS) {
    for (const rule of screenRules(sheet)) {
      const ink = hexOf(rule.declarations.get('color'));
      const surface = backgroundOf(rule.declarations);
      if (ink === null || surface === null) continue;
      const ratio = contrast(ink, surface);
      if (ratio < 4.5) failures.push(`${sheet} · ${rule.selector}: ${ink} on ${surface} = ${ratio}:1`);
    }
  }

  expect(failures).toEqual([]);

  // `--forest-900` is the legacy alias of `--paper` since T10: painting text with
  // it is invisible on the surface it names. The old sheets did, twice.
  const aliasAsText: string[] = [];
  for (const sheet of SHEETS) {
    for (const rule of screenRules(sheet)) {
      const ink = rule.declarations.get('color') ?? '';
      if (ink.includes('--forest-900')) aliasAsText.push(`${sheet} · ${rule.selector}: ${ink}`);
    }
  }
  expect(aliasAsText).toEqual([]);
});

// ── 5. the coverage map: dark plate on screen, black on white on paper ─────

test('the coverage map is a dark cartographic plate that keeps its printable ficha (S7/S8)', () => {
  const plate = declarationsIn('territorial-coverage.css', '#infrastructure .infrastructure-map-svg');
  expect(plate.size, 'the stylesheet must paint the map plate itself').toBeGreaterThan(0);
  const plateBackground = backgroundOf(plate);
  expect(plateBackground, 'the map svg must paint its own ocean').not.toBeNull();
  // Not merely "not white": a dark ocean/slate plate, the one surface the markers
  // and the risk legend are measured against.
  expect(contrast(plateBackground as string, '#ffffff')).toBeGreaterThanOrEqual(10);

  const sheet = declarationsIn('territorial-coverage.css', '#infrastructure .infrastructure-map');
  expect(backgroundOf(sheet), 'the figure keeps the water role around the plate').toBe(paletteRole('aerial-water'));

  // The decorative graticule is drawn by the component and is not announced: it is
  // a chart grid, not a basemap, and the figure's own caption says so.
  const component = readFileSync(
    resolve(process.cwd(), 'src', 'components', 'map', 'InfrastructureMap.tsx'),
    'utf8',
  );
  expect(component).toMatch(/className="infrastructure-map-graticule"[^>]*aria-hidden="true"/);
  const graticule = declarationsIn('territorial-coverage.css', '#infrastructure .infrastructure-map-graticule line');
  expect(graticule.size, 'the graticule needs a screen stroke of its own').toBeGreaterThan(0);
  expect(hexOf(graticule.get('stroke'))).not.toBeNull();

  // The printable ficha is unchanged and now carries high-contrast markers: the
  // screen hues measure under 3:1 on white, so paper gets black.
  const printed = printRules('territorial-coverage.css')
    .map(rule => `${rule.selector} { ${[...rule.declarations].map(([name, value]) => `${name}: ${value}`).join('; ')} }`)
    .join('\n');
  expect(printed).toMatch(/\.coverage-rail[^{]*\{[^}]*display:\s*none/);
  expect(printed).toMatch(/\.coverage-dot\.is-on[^{]*\{[^}]*background:\s*#000/);
  expect(printed).toMatch(/\.coverage-reading dt[^{]*\{[^}]*color:\s*#000/);
  expect(printed).toMatch(/\.infrastructure-map\s*\{[^}]*background:\s*#fff/);
  for (const type of ['colegio', 'vivienda', 'hospital', 'hidrante']) {
    expect(printed, `the ${type} marker must print black`).toMatch(
      new RegExp(`\\.infrastructure-marker-${type}[^{]*\\{[^}]*fill:\\s*#000`),
    );
    expect(printed, `the ${type} legend mark must print dark`).toMatch(
      new RegExp(`\\.infrastructure-legend-${type}[^{]*\\{[^}]*background:\\s*#000`),
    );
  }
  expect(printed).toMatch(/\.infrastructure-route[^{]*\{[^}]*stroke:\s*#000/);
});

// ── 6. interactive states, and the motion they add ─────────────────────────

const INTERACTIONS: ReadonlyArray<[Sheet, string, string]> = [
  ['territorial-coverage.css', '#infrastructure .coverage-entry', ':hover'],
  ['territorial-coverage.css', '#infrastructure .coverage-entry', ':focus-visible'],
  ['territorial-coverage.css', '#infrastructure .coverage-routes a', ':hover'],
  ['territorial-coverage.css', '#infrastructure .infrastructure-zone', ':focus'],
  ['decision-workspace.css', '.decision-summary__cell', ':hover'],
  ['decision-workspace.css', '.decision-limits__item > summary', ':hover'],
  ['decision-workspace.css', '.decision-limits__item > summary', ':focus-visible'],
  ['decision-workspace.css', '.decision-links a', ':hover'],
  ['decision-workspace.css', '.decision-links a', ':focus-visible'],
  ['field-workspace.css', '#actions textarea', ':focus-visible'],
  ['field-workspace.css', '#observations textarea', ':focus-visible'],
  ['observations.css', '.observation-adopt', ':hover'],
  ['observations.css', '.observation-adoption .field select', ':focus-visible'],
  ['history-workspace.css', '#history .history-empty-card .secondary-button', ':focus-visible'],
  ['notifications.css', '#notifications .notification-controls select', ':focus-visible'],
  ['operations-workspace.css', '.ops-layout .panel', ':focus-within'],
];

test('the interaction polish is declared, and its focus ring is the global role (S8)', () => {
  const missing: string[] = [];
  for (const [sheet, selector, state] of INTERACTIONS) {
    const declared = screenRules(sheet).some(
      rule => rule.selector.includes(selector) && rule.selector.includes(state),
    );
    if (!declared) missing.push(`${sheet} · ${selector}${state}`);
  }
  expect(missing).toEqual([]);

  // Every ring these sheets re-declare is the global focus role. The one literal
  // that stays is the shipped terracotta ring on the three textareas: it is pinned
  // by `tests/a11y/actions-accessibility.test.tsx` and measures 5.16:1 on `--paper`.
  const strayRings: string[] = [];
  for (const sheet of SHEETS) {
    for (const rule of screenRules(sheet)) {
      for (const property of ['outline', 'outline-color']) {
        const value = rule.declarations.get(property);
        if (value === undefined) continue;
        const literal = /#[0-9a-fA-F]{3,6}/.exec(value)?.[0];
        if (literal === undefined) continue;
        const pinnedTextarea = literal.toLowerCase() === '#cf7d4f' && rule.selector.includes('textarea');
        if (!pinnedTextarea) strayRings.push(`${sheet} · ${rule.selector}: ${property}: ${value}`);
      }
    }
  }
  expect(strayRings).toEqual([]);

  // Motion is added for feedback only, so it has to be removable.
  for (const sheet of SHEETS) {
    const animated = screenRules(sheet).filter(
      rule => rule.declarations.has('transition') || rule.declarations.has('animation'),
    );
    if (animated.length === 0) continue;
    const guarded = screenRules(sheet).some(rule =>
      rule.atRules.some(atRule => /prefers-reduced-motion/.test(atRule)),
    );
    expect(guarded, `${sheet} adds motion without a prefers-reduced-motion guard`).toBe(true);
  }
});
