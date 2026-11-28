import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test } from 'vitest';

// S2 — the registered report must leave no open code condition:
//
//   «Un informe registrado evalúa los criterios WCAG AA aplicables a las ocho
//   vistas, con herramienta, versión y fecha declaradas, y cada criterio tiene
//   resultado pasa/falla; los fallos quedan corregidos.»
//
// This suite is the executable half of that sentence; `frontend/WCAG-AA-CONFORMANCE.md`
// is the prose half and quotes the numbers computed here.
//
//   SC 1.4.4 Resize Text — the type scale must survive a 200% text resize. A
//   `font-size` in `px`/`pt` never grows when the reader raises the browser's
//   default font size, and a `clamp()` whose preferred term is a viewport unit
//   stops growing at twice nothing: `clamp(1.5rem, min(3vw, 4.8dvh), 2.5rem)`
//   computes 38.4 px at a 16 px root and only 48 px at a 32 px root (1.25×). So the
//   gate does not pattern-match the unit of the value; it evaluates the value the
//   way the browser would at both roots and requires the used size to double.
//
//   SC 1.4.11 Non-text Contrast — every choropleth state must be perceivable. The
//   fill is what encodes the level, so the fill is measured, not only the outline:
//   the outline alone would pass while `.zone-neutral` and `.level-desconocido`
//   sat at 1.60–1.71:1, and the shared `--edge-strong` edge cannot tell those two
//   states apart. Both parts are required to clear 3:1, which is the stricter
//   reading of "fill OR stroke boundary" and the only reading that makes the state
//   itself visible. Translucent paint is composited — `rgba()`, `hsla()`, 8-digit
//   hex, `fill-opacity` and `stroke-opacity` alike — because a 20%-opaque outline
//   is a 1.1:1 outline however opaque the colour it names.
//
// Three mutation escapes were reported against the first version of this file and
// each one is now a regression test of its own, at the bottom: a `font-size` with
// `!important` or a space before its unit, a ratio of 2.9999 that rounded up to a
// pass, and a translucent `stroke` that was compared as if it were opaque. A gate
// that cannot be shown to reject those is not a gate.
//
// jsdom applies no cascade and paints nothing, so what is pinned is the shipped
// source plus the WCAG 2.1 arithmetic a browser would be trusted for.

const STYLE_DIR = resolve(process.cwd(), 'src', 'styles');
const MAP_DIR = resolve(process.cwd(), 'src', 'components', 'map');

// ── a real (tiny) CSS reader ───────────────────────────────────────────────
// These sheets mix one-line and multi-line rules and wrap several of them in
// `@media`/`@supports`; a regex would confuse a wrapper with the rule inside it.

interface Rule {
  selector: string;
  declarations: Map<string, string>;
  atRules: string[];
}

interface SheetSource {
  name: string;
  source: string;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
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
        parsed.push({ selector: selector.replace(/\s+/g, ' '), declarations: declarations(body), atRules });
      }
      index = cursor;
      start = cursor;
    }
  };
  walk(stripComments(source), []);
  return parsed;
}

const SHEETS = readdirSync(STYLE_DIR)
  .filter(name => name.endsWith('.css'))
  .sort();

const SOURCES: SheetSource[] = SHEETS.map(name => ({
  name,
  source: readFileSync(resolve(STYLE_DIR, name), 'utf8'),
}));

const PARSED = new Map<string, Rule[]>(SOURCES.map(({ name, source }) => [name, parse(source)]));

function isPrint(rule: Rule): boolean {
  return rule.atRules.some(atRule => /@media\s+print/.test(atRule));
}

// A selector may be declared more than once (a `@media` override repeats it, and a
// family of states is declared in one comma list). The cascade merges those
// declarations, so the measurement reads the colour the surface keeps on screen.
function declarationsFor(sheet: string, selector: string): Map<string, string> {
  const wanted = selector.replace(/\s+/g, ' ');
  const merged = new Map<string, string>();
  for (const rule of PARSED.get(sheet) ?? []) {
    if (isPrint(rule)) continue;
    const matches = rule.selector
      .split(',')
      .map(part => part.trim())
      .includes(wanted);
    if (!matches) continue;
    for (const [name, value] of rule.declarations) merged.set(name, value);
  }
  return merged;
}

// ── SC 1.4.4 — the type scale ──────────────────────────────────────────────

// An absolute length unit. The scan reads the whole raw declaration, so a value
// written `13px !important`, `13 px` or `13PX` is caught the same way: what makes
// a unit absolute is the number-unit pair, not the spelling around it.
const ABSOLUTE_LENGTH = /(?:\d|\.)\s*(?:px|pt|pc|in|cm|mm|q)\b/i;

// A relative length: `rem`/`em` for the type scale, a viewport unit or `%` for the
// fluid headings that already existed. A bare number is an SVG user unit, which
// does not answer the browser's default-font-size setting either.
const RELATIVE_LENGTH = /^-?\d*\.?\d+(?:rem|em|ex|ch|%|vw|vh|dvw|dvh|vmin|vmax|vi|vb)$/;
const KEYWORDS = new Set(['inherit', 'unset', 'revert', 'revert-layer', 'initial']);

interface FontSizeDeclaration {
  sheet: string;
  property: 'font-size' | 'font';
  value: string;
}

// Read straight out of the comment-stripped text, independently of the rule
// walker: a declaration the walker mis-nests is still a declaration the browser
// applies, so the unit gate must not share the walker's blind spots.
function fontSizeDeclarations(sources: SheetSource[]): FontSizeDeclaration[] {
  const found: FontSizeDeclaration[] = [];
  for (const { name, source } of sources) {
    const text = stripComments(source);
    for (const match of text.matchAll(/font-size\s*:\s*([^;}]+)/gi)) {
      found.push({ sheet: name, property: 'font-size', value: (match[1] ?? '').trim() });
    }
    // The `font` shorthand carries a size too: `font: 13px/1.4 Inter` pins text to
    // an absolute size exactly as `font-size` would.
    for (const match of text.matchAll(/(?:^|[;{])\s*font\s*:\s*([^;}]+)/gi)) {
      found.push({ sheet: name, property: 'font', value: (match[1] ?? '').trim() });
    }
  }
  return found;
}

// The value's own tokens, with the comparing/rounding functions stripped: a
// `clamp(24px, 4.4dvh, 40px)` declares two absolute lengths and this must see them.
function fontTokens(value: string): string[] {
  return value
    .replace(/!important/gi, ' ')
    .replace(/(?:clamp|min|max|calc)\(/g, ' ')
    .replace(/[(),]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 0);
}

// ── the 200% text-resize evaluator ────────────────────────────────────────
// A browser raises the *root* font size; `rem` follows it, `vw`/`dvh` do not, and
// a `clamp()` can pin the used value to a bound the root can no longer move. So the
// gate evaluates each `font-size` at two roots and requires the used size to double.
//
// The evaluator supports what a `font-size` may honestly contain here: lengths with
// `rem`, `em`, `%`, `px`, `pt`, `pc`, `in`, `cm`, `mm`, `q`, `vw`, `vh`, `dvh`,
// `svh`, `lvh`, `vmin`, `vmax`, `vi`, `vb`, and the `clamp()`/`min()`/`max()`/
// `calc()` functions with `+ - * /`. `em` and `%` are resolved against the root,
// which models a chain in which every ancestor size is itself required to double by
// this same gate (all 293 declarations are).
interface LengthContext {
  root: number;
  width: number;
  height: number;
}

const LENGTH = /^([+-]?(?:\d+\.?\d*|\.\d+))([a-z%]*)$/i;

function unitValue(unit: string, amount: number, context: LengthContext): number | null {
  switch (unit.toLowerCase()) {
    case '':
      return amount === 0 ? 0 : null;
    case 'rem':
    case 'em':
      return amount * context.root;
    case '%':
      return (amount / 100) * context.root;
    case 'px':
      return amount;
    case 'pt':
      return (amount * 4) / 3;
    case 'pc':
      return amount * 16;
    case 'in':
      return amount * 96;
    case 'cm':
      return (amount * 96) / 2.54;
    case 'mm':
      return (amount * 96) / 25.4;
    case 'q':
      return (amount * 96) / 101.6;
    case 'vw':
    case 'dvw':
    case 'vi':
      return (amount / 100) * context.width;
    case 'vh':
    case 'dvh':
    case 'svh':
    case 'lvh':
    case 'vb':
      return (amount / 100) * context.height;
    case 'vmin':
      return (amount / 100) * Math.min(context.width, context.height);
    case 'vmax':
      return (amount / 100) * Math.max(context.width, context.height);
    default:
      return null;
  }
}

// Recursive descent over the small grammar a `font-size` uses. `null` means "this
// gate cannot decide it", which is a failure of the gate rather than a pass.
function evaluateExpression(input: string, context: LengthContext): number | null {
  let index = 0;
  const text = input.trim();

  const skip = (): void => {
    while (index < text.length && /\s/.test(text[index] ?? '')) index += 1;
  };
  const peek = (): string => text[index] ?? '';
  const eat = (token: string): boolean => {
    skip();
    if (!text.startsWith(token, index)) return false;
    index += token.length;
    return true;
  };

  const parseArgs = (): number[] | null => {
    const args: number[] = [];
    for (;;) {
      const value = parseSum();
      if (value === null) return null;
      args.push(value);
      skip();
      if (eat(',')) continue;
      return args;
    }
  };

  function parsePrimary(): number | null {
    skip();
    if (eat('(')) {
      const inner = parseSum();
      if (inner === null || !eat(')')) return null;
      return inner;
    }
    const name = /^[a-z]+/i.exec(text.slice(index))?.[0];
    if (name !== undefined) {
      index += name.length;
      const lower = name.toLowerCase();
      if (lower !== 'clamp' && lower !== 'min' && lower !== 'max' && lower !== 'calc') return null;
      if (!eat('(')) return null;
      const args = parseArgs();
      if (args === null || !eat(')')) return null;
      const values = lower === 'calc' ? args : args;
      if (lower === 'clamp') {
        if (values.length !== 3) return null;
        const [low, preferred, high] = values as [number, number, number];
        return Math.max(low, Math.min(preferred, high));
      }
      if (values.length === 0) return null;
      return lower === 'min' ? Math.min(...values) : lower === 'max' ? Math.max(...values) : (values[0] as number);
    }
    const token = /^[+-]?(?:\d+\.?\d*|\.\d+)[a-z%]*/i.exec(text.slice(index))?.[0];
    if (token === undefined) return null;
    index += token.length;
    const parts = LENGTH.exec(token);
    if (parts === null) return null;
    return unitValue(parts[2] ?? '', Number.parseFloat(parts[1] ?? '0'), context);
  }

  function parseProduct(): number | null {
    let left = parsePrimary();
    if (left === null) return null;
    for (;;) {
      skip();
      const operator = peek();
      if (operator !== '*' && operator !== '/') return left;
      index += 1;
      const right = parsePrimary();
      if (right === null) return null;
      left = operator === '*' ? left * right : left / right;
    }
  }

  function parseSum(): number | null {
    let left = parseProduct();
    if (left === null) return null;
    for (;;) {
      skip();
      const operator = peek();
      if (operator !== '+' && operator !== '-') return left;
      index += 1;
      const right = parseProduct();
      if (right === null) return null;
      left = operator === '+' ? left + right : left - right;
    }
  }

  const result = parseSum();
  skip();
  return index === text.length ? result : null;
}

// The two reference viewports the report names: a desktop at 1280×800 and a phone
// at 390×844. A size that doubles at both has doubled for the criterion.
const REFERENCE_VIEWPORTS: ReadonlyArray<readonly [string, number, number]> = [
  ['1280×800', 1280, 800],
  ['390×844', 390, 844],
];

function usedSize(value: string, root: number, width: number, height: number): number | null {
  return evaluateExpression(value.replace(/!important/gi, '').trim(), { root, width, height });
}

test('every stylesheet declares its type scale in relative units (SC 1.4.4)', () => {
  expect(SHEETS.length, `the shipped stylesheet set changed: ${SHEETS.join(', ')}`).toBe(12);

  const declared = fontSizeDeclarations(SOURCES);
  const sizes = declared.filter(entry => entry.property === 'font-size');
  const absolute = declared.filter(entry => ABSOLUTE_LENGTH.test(entry.value));
  const unmeasured: string[] = [];

  for (const entry of sizes) {
    for (const token of fontTokens(entry.value)) {
      if (RELATIVE_LENGTH.test(token) || KEYWORDS.has(token.toLowerCase())) continue;
      unmeasured.push(`${entry.sheet} · ${entry.value} (token ${token})`);
    }
  }

  // A gate that finds nothing must not pass: the scale is the whole point, and an
  // empty scan would go green the moment a sheet stopped being read.
  expect(sizes.length, 'no font-size declaration was found; this gate would pass vacuously').toBeGreaterThan(280);

  const site = (entry: FontSizeDeclaration): string => `${entry.sheet} · ${entry.property}: ${entry.value}`;
  expect(
    absolute.slice(0, 8),
    `an absolute size cannot answer a browser default-font-size change: ${absolute.map(site).join(' | ')}`,
  ).toEqual([]);
  expect(absolute.length).toBe(0);

  expect(
    unmeasured.slice(0, 8),
    `a size with no relative unit neither scales nor can be measured: ${unmeasured.join(' | ')}`,
  ).toEqual([]);
  expect(unmeasured.length).toBe(0);
});

test('every declared size doubles when the root font doubles (SC 1.4.4)', () => {
  const sizes = fontSizeDeclarations(SOURCES).filter(entry => entry.property === 'font-size');
  expect(sizes.length, 'no font-size declaration was found; this gate would pass vacuously').toBeGreaterThan(280);

  const failures: string[] = [];
  let evaluated = 0;
  for (const entry of sizes) {
    for (const [label, width, height] of REFERENCE_VIEWPORTS) {
      const sixteen = usedSize(entry.value, 16, width, height);
      const thirtyTwo = usedSize(entry.value, 32, width, height);
      if (sixteen === null || thirtyTwo === null) {
        failures.push(`${entry.sheet} · ${entry.value} cannot be evaluated at ${label}`);
        continue;
      }
      evaluated += 1;
      // The same size in the same viewport, only the root differs: 200% text
      // resize means the used size must double, not grow a little.
      if (thirtyTwo < sixteen * 2) {
        failures.push(
          `${entry.sheet} · ${entry.value} at ${label}: ${sixteen.toFixed(2)}px → ${thirtyTwo.toFixed(2)}px (${
            thirtyTwo / sixteen
          }× of 2×)`,
        );
      }
    }
  }

  expect(evaluated, 'the resize gate evaluated nothing').toBeGreaterThan(280);
  expect(failures.slice(0, 8), `a size does not reach 200%: ${failures.join(' | ')}`).toEqual([]);
  expect(failures.length).toBe(0);
});

test('the 200% gate rejects a viewport-pinned size (SC 1.4.4, mutation case)', () => {
  // The shapes that produced the reported defect. Each must be reported by the same
  // evaluator the gate above uses, or the gate is decoration.
  const pinned = [
    'clamp(1.5rem, min(3vw, 4.8dvh), 2.5rem)', // the sign-in hero before the fix: 38.4 → 48 px
    'clamp(1.5rem, 4.4dvh, 2.5rem)', // 35.2 → 48 px
    'clamp(1.6875rem, 2.5vw, 2.3125rem)', // 32 → 54? measured below
    'clamp(1.375rem, 2.2vw, 1.5rem)',
    '2.5vw',
    'clamp(1rem, 2vw, 3rem)',
  ];
  for (const value of pinned) {
    const sixteen = usedSize(value, 16, 1280, 800) as number;
    const thirtyTwo = usedSize(value, 32, 1280, 800) as number;
    expect(sixteen, `${value} did not evaluate`).not.toBeNull();
    expect(thirtyTwo / sixteen, `${value} was expected to miss 200% and did not`).toBeLessThan(2);
  }

  // And the shape the fix uses: a rem-only clamp doubles exactly.
  const sixteen = usedSize('clamp(1.5rem, 2.4rem, 2.5rem)', 16, 1280, 800) as number;
  const thirtyTwo = usedSize('clamp(1.5rem, 2.4rem, 2.5rem)', 32, 1280, 800) as number;
  expect(thirtyTwo).toBe(sixteen * 2);
});

test('no map component pins a text size in pixels (SC 1.4.4)', () => {
  const files = readdirSync(MAP_DIR)
    .filter(name => /\.tsx?$/.test(name))
    .sort();
  expect(files.length, 'the map component directory was not read').toBeGreaterThanOrEqual(5);

  const offenders: string[] = [];
  for (const file of files) {
    const source = stripComments(readFileSync(resolve(MAP_DIR, file), 'utf8')).replace(/^\s*\/\/.*$/gm, '');
    // A React style prop: `style={{ fontSize: '10px' }}`, `fontSize: 10`.
    for (const match of source.matchAll(/fontSize\s*[:=]\s*([^,;}\n]+)/g)) {
      const value = (match[1] ?? '').trim();
      if (ABSOLUTE_LENGTH.test(value) || /^-?\d*\.?\d+$/.test(value.replace(/['"]/g, ''))) {
        offenders.push(`${file} · fontSize: ${value}`);
      }
    }
    // An SVG presentation attribute on a text node: `<text fontSize="10">`.
    for (const match of source.matchAll(/<text\b[^>]*>/g)) {
      if (/(?:fontSize|font-size)\s*=/.test(match[0])) offenders.push(`${file} · ${match[0].trim()}`);
    }
  }

  expect(offenders, `an inline pixel text size defeats the root rem scale: ${offenders.join(' | ')}`).toEqual([]);

  // The SVG labels are the one place a map draws words of its own. They keep their
  // size in the stylesheet, in `rem`, so the root scale reaches them too.
  const label = declarationsFor('aerial-workspace.css', '#overview .map-3d-label');
  expect(label.get('font-size'), 'the 3D commune label lost its declared size').toBeDefined();
  expect(label.get('font-size'), 'the 3D commune label must scale with the root font').toMatch(/^[\d.]+rem$/);
});

// ── colour maths, WCAG 2.1 relative luminance ──────────────────────────────

function channel(value: number): number {
  const ratio = value / 255;
  return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
}

function rgbOf(hex: string): [number, number, number] {
  const digits = hex.replace('#', '');
  return [
    Number.parseInt(digits.slice(0, 2), 16),
    Number.parseInt(digits.slice(2, 4), 16),
    Number.parseInt(digits.slice(4, 6), 16),
  ];
}

function hexOfRgb([red, green, blue]: [number, number, number]): string {
  return `#${[red, green, blue].map(value => Math.round(value).toString(16).padStart(2, '0')).join('')}`;
}

function luminance(hex: string): number {
  const [red, green, blue] = rgbOf(hex).map(channel);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

// The raw ratio, never rounded: rounding before the comparison is how 2.9999:1
// became a pass in the previous version of this file.
function contrast(foreground: string, background: string): number {
  const [first, second] = [luminance(foreground), luminance(background)];
  const [lighter, darker] = first > second ? [first, second] : [second, first];
  return (lighter + 0.05) / (darker + 0.05);
}

// A declared paint: a colour plus the alpha the declaration carries. `rgba()`,
// `hsla()` and 8-digit hex are real declarations a stylesheet may carry, and an
// outline painted at 20% opacity is not the opaque colour it names.
interface Paint {
  hex: string;
  alpha: number;
}

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const h = ((hue % 360) + 360) % 360;
  const s = Math.min(1, Math.max(0, saturation));
  const l = Math.min(1, Math.max(0, lightness));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function numberOrPercent(token: string, scale: number): number {
  const text = token.trim();
  if (text.endsWith('%')) return (Number.parseFloat(text) / 100) * scale;
  return Number.parseFloat(text);
}

function paintFromFunction(name: string, body: string): Paint | null {
  const parts = body
    .replace(/\//g, ' / ')
    .split(/[\s,]+/)
    .filter(part => part.length > 0 && part !== '/');
  const alphaToken = body.includes('/') ? parts[parts.length - 1] : parts.length > 3 ? parts[3] : undefined;
  const alpha = alphaToken === undefined ? 1 : Math.min(1, Math.max(0, numberOrPercent(alphaToken, 1)));
  if (name === 'rgb' || name === 'rgba') {
    const [r, g, b] = [numberOrPercent(parts[0] ?? '0', 255), numberOrPercent(parts[1] ?? '0', 255), numberOrPercent(parts[2] ?? '0', 255)];
    return { hex: hexOfRgb([r, g, b]), alpha };
  }
  if (name === 'hsl' || name === 'hsla') {
    const hue = Number.parseFloat(parts[0] ?? '0');
    const saturation = (parts[1] ?? '0%').endsWith('%') ? Number.parseFloat(parts[1]) / 100 : Number.parseFloat(parts[1] ?? '0');
    const lightness = (parts[2] ?? '0%').endsWith('%') ? Number.parseFloat(parts[2]) / 100 : Number.parseFloat(parts[2] ?? '0');
    return { hex: hexOfRgb(hslToRgb(hue, saturation, lightness)), alpha };
  }
  return null;
}

// ── the shipped palette, read from its declaration ─────────────────────────

const PALETTE = ((): Map<string, string> => {
  const palette = new Map<string, string>();
  for (const rule of PARSED.get('tokens.css') ?? []) {
    if (isPrint(rule)) continue;
    for (const [name, value] of rule.declarations) {
      if (name.startsWith('--') && /^#[0-9a-f]{6}$/.test(value.toLowerCase())) {
        palette.set(name.slice(2), value.toLowerCase());
      }
    }
  }
  return palette;
})();

function role(name: string): string {
  const value = PALETTE.get(name);
  expect(value, `tokens.css declares no --${name}`).toBeDefined();
  return value as string;
}

// Resolve a declared colour to a paint: a hex, an `rgb()`/`hsl()` literal, an
// 8-digit hex, `transparent`, or a `var(--role)` chain that ends in one of those.
function paintOf(value: string | undefined): Paint | null {
  if (value === undefined) return null;
  const text = value.trim().toLowerCase();
  if (text === '') return null;
  if (text === 'transparent') return { hex: '#000000', alpha: 0 };
  if (/^#[0-9a-f]{8}$/.test(text)) {
    return { hex: text.slice(0, 7), alpha: Number.parseInt(text.slice(7, 9), 16) / 255 };
  }
  if (/^#[0-9a-f]{6}$/.test(text)) return { hex: text, alpha: 1 };
  const short = /^#([0-9a-f]{4})$/.exec(text);
  if (short !== null) {
    const [r, g, b, a] = [...short[1]];
    return { hex: `#${r}${r}${g}${g}${b}${b}`, alpha: Number.parseInt(`${a}${a}`, 16) / 255 };
  }
  const shortHex = /^#([0-9a-f]{3})$/.exec(text);
  if (shortHex !== null) {
    return { hex: `#${[...shortHex[1]].map(digit => digit + digit).join('')}`, alpha: 1 };
  }
  const reference = /^var\(--([\w-]+)\)$/.exec(text);
  if (reference !== null) return paintOf(PALETTE.get(reference[1]));
  const fun = /^(rgba?|hsla?)\(([^()]*)\)$/.exec(text);
  if (fun !== null) return paintFromFunction(fun[1] as string, fun[2] as string);
  return null;
}

function opacityOf(value: string | undefined): number {
  if (value === undefined) return 1;
  const parsed = Number.parseFloat(value);
  expect(Number.isFinite(parsed), `opacity ${value} is not a number`).toBe(true);
  return Math.min(1, Math.max(0, parsed));
}

// `fill-opacity`, `stroke-opacity` and the declaration's own alpha all composite
// the paint over what is behind it. The blend is the one the compositor performs,
// done in sRGB bytes.
function composite(paint: Paint, opacity: number, background: string): string {
  const foreground = rgbOf(paint.hex);
  const behind = rgbOf(background);
  const alpha = Math.min(1, Math.max(0, paint.alpha * opacity));
  return hexOfRgb([
    foreground[0] * alpha + behind[0] * (1 - alpha),
    foreground[1] * alpha + behind[1] * (1 - alpha),
    foreground[2] * alpha + behind[2] * (1 - alpha),
  ]);
}

// ── SC 1.4.11 — the map backdrops ─────────────────────────────────────────

const BACKDROPS: ReadonlyArray<readonly [string, string]> = [
  ['canvas', role('canvas')],
  ['aerial-water', role('aerial-water')],
  ['surface-raised', role('surface-raised')],
];

test('the measured backdrops are the shipped surface roles (SC 1.4.11)', () => {
  expect(role('canvas'), 'the page floor moved; the measurement below must follow it').toBe('#0f1922');
  expect(role('aerial-water'), 'the map stage moved; the measurement below must follow it').toBe('#152934');
  expect(role('surface-raised'), 'the inset gradient stop moved; the measurement below must follow it').toBe('#243341');
  // The deepest ocean stop the aerial canvas paints, recorded so a darker stage
  // cannot slip below the measured floor unnoticed.
  expect(
    readFileSync(resolve(MAP_DIR, 'AerialMap3D.tsx'), 'utf8'),
    'the deep ocean stop the 3D stage paints',
  ).toContain('#081520');
});

interface MapState {
  level: string;
  selector: string;
}

// The four levels the API serves plus the absence fallback. `extreme` is the top
// severity role the palette reserves; no view paints it today, so it is measured
// straight from its tokens instead of through a class that does not exist.
const SERVED_STATES: ReadonlyArray<MapState> = [
  { level: 'bajo', selector: '.level-bajo' },
  { level: 'medio', selector: '.level-medio' },
  { level: 'alto', selector: '.level-alto' },
  { level: 'desconocido', selector: '.level-desconocido' },
  { level: 'neutral', selector: '.zone-neutral' },
];

interface Sample {
  what: string;
  level: string;
  fill: Paint;
  fillOpacity: number;
  stroke: Paint;
  strokeOpacity: number;
}

const SAMPLES: Sample[] = [];
for (const state of SERVED_STATES) {
  const flat = declarationsFor('app.css', state.selector);
  const flatFill = paintOf(flat.get('fill'));
  const flatStroke = paintOf(flat.get('stroke'));
  expect(flatFill, `app.css ${state.selector} declares no measurable fill`).not.toBeNull();
  expect(flatStroke, `app.css ${state.selector} declares no measurable outline`).not.toBeNull();
  SAMPLES.push({
    what: '2D map',
    level: state.level,
    fill: flatFill as Paint,
    fillOpacity: opacityOf(flat.get('fill-opacity')),
    stroke: flatStroke as Paint,
    strokeOpacity: opacityOf(flat.get('stroke-opacity')),
  });

  const scoped = `#overview .map-3d ${state.selector}`;
  const aerial = declarationsFor('aerial-workspace.css', scoped);
  // The stage inherits the fill from `app.css` and may override only its opacity
  // and its outline; a missing declaration here is the inherited one.
  SAMPLES.push({
    what: '3D stage',
    level: state.level,
    fill: paintOf(aerial.get('fill')) ?? (flatFill as Paint),
    fillOpacity: opacityOf(aerial.get('fill-opacity') ?? flat.get('fill-opacity')),
    stroke: paintOf(aerial.get('stroke')) ?? (flatStroke as Paint),
    strokeOpacity: opacityOf(aerial.get('stroke-opacity') ?? flat.get('stroke-opacity')),
  });
}
// The reserved role is measured straight from its tokens: the palette is the
// contract even where no class paints it yet. (`neutral` needs no entry here —
// `.zone-neutral` already reads the same two tokens.)
SAMPLES.push({
  what: '2D map',
  level: 'extremo',
  fill: paintOf(role('level-extreme-fill')) as Paint,
  fillOpacity: 1,
  stroke: paintOf(role('level-extreme-line')) as Paint,
  strokeOpacity: 1,
});

interface Violation {
  sample: Sample;
  surface: string;
  part: 'fill' | 'outline';
  ratio: number;
  composited: string;
  backdrop: string;
}

function measureSamples(samples: Sample[], backdrops: ReadonlyArray<readonly [string, string]>): Violation[] {
  const violations: Violation[] = [];
  for (const sample of samples) {
    for (const [surface, backdrop] of backdrops) {
      for (const part of ['fill', 'outline'] as const) {
        const paint = part === 'fill' ? sample.fill : sample.stroke;
        const opacity = part === 'fill' ? sample.fillOpacity : sample.strokeOpacity;
        const composited = composite(paint, opacity, backdrop);
        const ratio = contrast(composited, backdrop);
        // Raw comparison: `ratio >= 3`, never `Number(ratio.toFixed(2)) >= 3`.
        if (ratio < 3) violations.push({ sample, surface, part, ratio, composited, backdrop });
      }
    }
  }
  return violations;
}

test('every map zone state measures at least 3:1 against every map backdrop (SC 1.4.11)', () => {
  // 11 samples — five served states on both maps plus the reserved top severity —
  // against three backdrops, for a fill and an outline each. A shorter list means
  // the scan stopped reading a surface.
  expect(SAMPLES.length * BACKDROPS.length).toBe(33);

  const measured: string[] = [];
  for (const sample of SAMPLES) {
    for (const [surface, backdrop] of BACKDROPS) {
      const plate = contrast(composite(sample.fill, sample.fillOpacity, backdrop), backdrop);
      const outline = contrast(composite(sample.stroke, sample.strokeOpacity, backdrop), backdrop);
      measured.push(`${sample.what} ${sample.level} on ${surface}: fill ${plate.toFixed(2)}:1 · outline ${outline.toFixed(2)}:1`);
    }
  }
  expect(measured.length).toBe(33);

  const violations = measureSamples(SAMPLES, BACKDROPS);
  expect(
    violations.map(
      violation =>
        `${violation.sample.what} ${violation.sample.level} ${violation.part} on ${violation.surface} measures ` +
        `${violation.ratio.toFixed(2)}:1 (${violation.composited} over ${violation.backdrop})`,
    ),
  ).toEqual([]);
});

test('the level text and badge pairs stay at 4.5:1 (SC 1.4.3)', () => {
  // Closing the plate against the backdrop must not have been paid for by the text
  // a level paints on its own chip: every `-text`/`-surface` and `-ink`/`-fill`
  // pair is measured here rather than trusted, raw and unrounded.
  const failures: string[] = [];
  for (const name of ['low', 'medium', 'high', 'extreme', 'unknown', 'neutral']) {
    const textRatio = contrast(role(`level-${name}-text`), role(`level-${name}-surface`));
    const inkRatio = contrast(role(`level-${name}-ink`), role(`level-${name}-fill`));
    if (textRatio < 4.5) failures.push(`--level-${name}-text on its surface measures ${textRatio.toFixed(2)}:1`);
    if (inkRatio < 4.5) failures.push(`--level-${name}-ink on its fill measures ${inkRatio.toFixed(2)}:1`);
  }
  expect(failures, `a map text pair fell below 4.5:1: ${failures.join(' | ')}`).toEqual([]);
});

// ── the three reported mutation escapes, as regression tests ───────────────

test('a font size with `!important` or a spaced unit is still absolute (SC 1.4.4, mutation case)', () => {
  // The reported escape: a `font-size: 13px !important` declaration. The scan reads
  // the whole raw value, so the marker, the spelling and the whitespace around the
  // unit cannot hide it — and the `font` shorthand carries a size too.
  const mutants: ReadonlyArray<readonly [string, string]> = [
    ['important.css', '.x { font-size: 13px !important; }'],
    ['spaced.css', '.x { font-size: 13 px; }'],
    ['no-space.css', '.x{font-size:13PX!important}'],
    ['points.css', '.x { font-size: 12pt; }'],
    ['print.css', '@media print { .x { font-size: 13px !important; } }'],
    ['shorthand.css', '.x { font: 13px/1.4 Inter, sans-serif; }'],
    ['nested.css', '@supports (display: grid) { .x { font-size: 9.5px; } }'],
  ];
  for (const [name, source] of mutants) {
    const declared = fontSizeDeclarations([{ name, source }]);
    expect(declared.length, `${name} declared no size at all`).toBeGreaterThan(0);
    const absolute = declared.filter(entry => ABSOLUTE_LENGTH.test(entry.value));
    expect(absolute.length, `${name} escaped the absolute-unit gate`).toBe(1);
  }

  // And a relative declaration is not a false positive: it carries the `!important`
  // marker the scan must ignore rather than mistrust.
  const relative = fontSizeDeclarations([{ name: 'ok.css', source: '.x { font-size: 0.8125rem !important; }' }]);
  expect(relative.filter(entry => ABSOLUTE_LENGTH.test(entry.value))).toEqual([]);
});

test('a ratio of 2.9999:1 is a failure, not 3:1 (SC 1.4.11, mutation case)', () => {
  // `#606565` on `--canvas` measures 2.99946:1. The previous version rounded to two
  // decimals before comparing, which turned it into a pass.
  const ratio = contrast('#606565', '#0f1922');
  expect(ratio).toBeGreaterThan(2.99);
  expect(ratio).toBeLessThan(3);
  expect(Number(ratio.toFixed(2)), 'this pair is the rounding trap: it prints as 3.00').toBe(3);
  expect(ratio >= 3, 'an unrounded comparison must reject it').toBe(false);
  expect(ratio >= 4.5).toBe(false);
});

test('a translucent outline is composited before it is measured (SC 1.4.11, mutation case)', () => {
  // The reported escape: `stroke-opacity` (or an `rgba()`/`hsla()`/8-digit colour)
  // applied to an otherwise readable outline. Comparing the named colour as if it
  // were opaque reported 5.79:1; what the reader sees is 1.13:1.
  const base: Sample = {
    what: 'mutant',
    level: 'neutral',
    fill: paintOf('#71879a') as Paint,
    fillOpacity: 1,
    stroke: paintOf(role('edge-strong')) as Paint,
    strokeOpacity: 1,
  };
  expect(measureSamples([base], BACKDROPS)).toEqual([]);

  const fadedByProperty: Sample = { ...base, strokeOpacity: 0.2 };
  const violations = measureSamples([fadedByProperty], BACKDROPS);
  expect(violations.length, 'a 20%-opaque outline escaped the gate').toBe(BACKDROPS.length);
  expect(violations[0]?.part).toBe('outline');
  expect(violations[0]?.ratio).toBeLessThan(1.5);

  // The alpha may arrive in the colour itself, in all four spellings. Each one is
  // the same outline and must be measured the same way.
  const rgba = paintOf('rgba(244, 241, 235, 0.2)') as Paint;
  expect(rgba.alpha).toBeCloseTo(0.2, 5);
  const hsla = paintOf('hsla(40, 30%, 93%, 0.2)') as Paint;
  expect(hsla.alpha).toBeCloseTo(0.2, 5);
  const eightDigit = paintOf('#f4f1eb33') as Paint;
  expect(eightDigit.alpha).toBeCloseTo(0.2, 1);
  const transparent = paintOf('transparent') as Paint;
  expect(transparent.alpha).toBe(0);

  for (const paint of [rgba, hsla, eightDigit]) {
    const sample: Sample = { ...base, stroke: paint };
    const found = measureSamples([sample], [['aerial-water', role('aerial-water')]]);
    expect(found.length, `${paint.hex} at alpha ${paint.alpha} escaped the gate`).toBe(1);
  }
});
