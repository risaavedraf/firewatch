#!/usr/bin/env node
/**
 * Global product navigation for the FireWatch design collection.
 *
 * One component, one source of truth. It renders the thin product bar that sits
 * above every artboard: a direct "Mapa" return, the main destinations, and a
 * compact grouped disclosure with the rest of the product. Every destination is
 * a native relative link, so the boards keep working offline and the browser
 * Back button does its normal job.
 *
 * The bar is written into the final standalone HTML in three bounded ways:
 *
 *   - `build-artboards.mjs` calls `injectNavigation()` for the 16 generated
 *     boards (04–19). Sources stay untouched, and `--check` still compares the
 *     whole file.
 *   - The five direct boards (01–03, 20–21) embed the same marked block;
 *     their copies are verified without rewriting them.
 *   - `node product-navigation.mjs --check` verifies all 21 boards offline.
 *
 * `node product-navigation.mjs --browser-check` adds the keyboard round trip in
 * a local Chromium, when one is available. It never installs anything and never
 * touches the network.
 *
 * Constraints this component respects:
 *   - The map boards (01–03) position their panels by fixed offsets, so the bar
 *     has a deterministic height (`--fw-nav-h`, 48px) and each board shifts its
 *     own offsets by that variable. Nothing is layered over existing controls.
 *   - The generated sources keep working as multi-view prototypes: the bar adds
 *     no `data-nav`, no `class="view"` and no `id` used by the generator, so the
 *     in-document `#view` navigation and its guards are untouched.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(HERE, 'design.json');
const GENERATOR_MARKER = '<!-- Generado por design/firewatch-v1-vuelo/build-artboards.mjs';

export const NAV_START =
  '<!-- fw-product-nav:start · navegación global compartida · la escribe design/firewatch-v1-vuelo/product-navigation.mjs; no editar a mano -->';
export const NAV_END = '<!-- fw-product-nav:end -->';
export const STYLE_ID = 'fw-product-nav';

/** Height of the bar where a board pins it: the map boards own fixed offsets. */
export const NAV_HEIGHT = 48;

/**
 * Destinations in the bar itself. Labels are short so the bar still fits one
 * row at 320px; `name` carries the full destination for assistive technology
 * and always starts with the visible word.
 */
export const PRIMARY = [
  { file: '01-vista-aerea.html', label: 'Mapa', name: 'Mapa · Territorio' },
  { file: '07-panel-ejecutivo.html', label: 'Panel', name: 'Panel ejecutivo' },
  { file: '05-historial-de-lotes.html', label: 'Historial', name: 'Historial de lotes' },
  { file: '06-acciones-preventivas.html', label: 'Acciones', name: 'Acciones preventivas' }
];

/** Everything else, grouped by what the user is trying to do. */
export const GROUPS = [
  {
    key: 'territorio',
    title: 'Territorio y lectura',
    files: [
      '02-vista-regional.html',
      '03-acciones-en-el-mapa.html',
      '04-cobertura-territorial.html',
      '21-lecturas-por-sector.html',
      '08-comparar-sectores.html'
    ]
  },
  {
    key: 'decision',
    title: 'Decisión y alertas',
    files: [
      '09-notificaciones.html',
      '10-simulacion-contrafactual.html',
      '11-observaciones-de-campo.html',
      '13-ficha-de-zona.html'
    ]
  },
  {
    key: 'datos',
    title: 'Solicitudes y datos',
    files: ['12-exportacion-csv.html', '20-datos-del-modelo.html', '15-fuentes-y-servicios.html']
  },
  {
    key: 'acceso',
    title: 'Acceso y control',
    files: ['14-acceso.html', '17-sesion-y-permisos.html', '18-registro-de-actividad.html']
  }
];

/** Menu labels. Never invent a destination: every file must exist in design.json. */
export const LABELS = {
  '01-vista-aerea.html': 'Territorio · Vista aérea',
  '02-vista-regional.html': 'Vista regional',
  '03-acciones-en-el-mapa.html': 'Acciones rápidas en el mapa',
  '04-cobertura-territorial.html': 'Cobertura y contexto territorial',
  '05-historial-de-lotes.html': 'Historial de lotes',
  '06-acciones-preventivas.html': 'Acciones preventivas',
  '07-panel-ejecutivo.html': 'Panel ejecutivo',
  '08-comparar-sectores.html': 'Comparar sectores',
  '09-notificaciones.html': 'Notificaciones',
  '10-simulacion-contrafactual.html': 'Simulación contrafactual',
  '11-observaciones-de-campo.html': 'Observaciones de campo',
  '12-exportacion-csv.html': 'Exportación CSV',
  '13-ficha-de-zona.html': 'Ficha de zona · Vista previa PDF',
  '14-acceso.html': 'Acceso · Iniciar sesión',
  '15-fuentes-y-servicios.html': 'Fuentes y servicios',
  '16-procesamiento.html': 'Procesamiento',
  '17-sesion-y-permisos.html': 'Sesión y permisos',
  '18-registro-de-actividad.html': 'Registro de actividad',
  '19-aun-no-implementado.html': 'Prototipos y alcance',
  '20-datos-del-modelo.html': 'Datos del modelo',
  '21-lecturas-por-sector.html': 'Lecturas por sector'
};

/**
 * Kept in the collection and the canvas, out of the product menu: 16 is the
 * superseded single-lot flow and 19 is the internal pending inventory. Both
 * boards still carry the full bar.
 */
export const EXCLUDED = ['16-procesamiento.html', '19-aun-no-implementado.html'];

/** Read-only expectation for the 21 catalog entries; design.json is not touched. */
export const CATALOG = [
  '01-vista-aerea.html',
  '04-cobertura-territorial.html',
  '21-lecturas-por-sector.html',
  '05-historial-de-lotes.html',
  '06-acciones-preventivas.html',
  '07-panel-ejecutivo.html',
  '08-comparar-sectores.html',
  '09-notificaciones.html',
  '10-simulacion-contrafactual.html',
  '11-observaciones-de-campo.html',
  '12-exportacion-csv.html',
  '13-ficha-de-zona.html',
  '14-acceso.html',
  '15-fuentes-y-servicios.html',
  '20-datos-del-modelo.html',
  '16-procesamiento.html',
  '17-sesion-y-permisos.html',
  '18-registro-de-actividad.html',
  '19-aun-no-implementado.html',
  '02-vista-regional.html',
  '03-acciones-en-el-mapa.html'
];

/** The five standalone boards whose navigation is checked without regeneration. */
export const DIRECT_BOARDS = [
  { file: '01-vista-aerea.html', mode: 'fixed', variant: 'map' },
  { file: '02-vista-regional.html', mode: 'fixed', variant: 'map' },
  { file: '03-acciones-en-el-mapa.html', mode: 'fixed', variant: 'map' },
  { file: '20-datos-del-modelo.html', mode: 'sticky', variant: 'plain' },
  { file: '21-lecturas-por-sector.html', mode: 'sticky', variant: 'plain' }
];

/** Generated boards inherit the palette family of their source board. */
export const SOURCE_VARIANTS = {
  prevencion: 'aerial',
  campo: 'aerial',
  decisiones: 'panel',
  control: 'panel'
};

const DIRECT_BY_FILE = Object.fromEntries(DIRECT_BOARDS.map((board) => [board.file, board]));

export const NAV_CSS = `/* FireWatch · navegación global del producto (componente compartido).
   Fuente del bloque: product-navigation.mjs. */
.fw-nav {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 8px;
  margin: 0;
  padding: 5px 12px;
  border-block-end: 1px solid var(--fw-edge);
  background: var(--fw-surface);
  color: var(--fw-ink);
  font: 600 13px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif;
}
.fw-nav--map { --fw-surface: var(--panel, #17222b); --fw-ink: var(--ink, #f4f1eb); --fw-muted: var(--muted, #b8c8d2); --fw-edge: var(--border, #647b8a); --fw-accent: var(--focus, #94dfda); --fw-raised: var(--raised, #243341); }
.fw-nav--aerial { --fw-surface: var(--aerial-panel, #17222b); --fw-ink: var(--aerial-ink, #f4f1eb); --fw-muted: var(--aerial-muted, #b8c8d2); --fw-edge: var(--aerial-border, #647b8a); --fw-accent: var(--aerial-focus, #94dfda); --fw-raised: var(--aerial-raised, #243341); }
.fw-nav--panel { --fw-surface: var(--surface, #17222b); --fw-ink: var(--text, #f4f1eb); --fw-muted: var(--text-muted, #b8c8d2); --fw-edge: var(--edge, #647b8a); --fw-accent: var(--accent, #94dfda); --fw-raised: var(--surface-raised, #243341); }
.fw-nav--plain { --fw-surface: var(--surface, #17222b); --fw-ink: var(--ink, #f4f1eb); --fw-muted: var(--muted, #b8c8d2); --fw-edge: var(--edge, #647b8a); --fw-accent: var(--accent, #94dfda); --fw-raised: var(--raised, #243341); }
.fw-nav--sticky { position: sticky; top: 0; z-index: 30; min-height: 48px; }
.fw-nav--fixed { position: fixed; inset: 0 0 auto; z-index: 2; flex-wrap: nowrap; height: var(--fw-nav-h, 48px); padding-block: 3px; }
html { scroll-padding-top: calc(var(--fw-nav-h, 48px) + 56px); }
.fw-nav--sticky + .app .viewnav { top: var(--fw-nav-h, 48px); }
.fw-nav__primary { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-width: 0; margin: 0; padding: 0; list-style: none; }
.fw-nav--fixed .fw-nav__primary { flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden; padding-block: 1px; overscroll-behavior-x: contain; scrollbar-width: thin; }
.fw-nav__link { display: inline-flex; align-items: center; min-height: 40px; padding: 0 10px; border: 1px solid transparent; border-radius: 9px; color: var(--fw-ink); font-weight: 700; text-decoration: none; white-space: nowrap; }
.fw-nav__link:hover { background: var(--fw-raised); }
.fw-nav__link[aria-current="page"] { border-color: var(--fw-edge); background: var(--fw-raised); color: var(--fw-accent); text-decoration: underline; text-underline-offset: 3px; }
.fw-nav a:focus-visible, .fw-nav summary:focus-visible { outline: 3px solid var(--fw-accent); outline-offset: 2px; }
.fw-nav--fixed .fw-nav__primary .fw-nav__link:focus-visible { outline-offset: -2px; }
.fw-nav__more { display: flex; min-width: 0; }
.fw-nav__summary { display: inline-flex; align-items: center; gap: 6px; min-height: 40px; padding: 0 11px; border: 1px solid var(--fw-edge); border-radius: 9px; color: var(--fw-ink); font-weight: 700; white-space: nowrap; cursor: pointer; list-style: none; }
.fw-nav__summary::-webkit-details-marker { display: none; }
.fw-nav__summary::after { content: "▾"; font-size: 10px; line-height: 1; }
.fw-nav__summary:hover { background: var(--fw-raised); }
.fw-nav__more[open] > .fw-nav__summary { border-color: var(--fw-accent); background: var(--fw-raised); color: var(--fw-accent); }
.fw-nav__panel { position: absolute; inset-block-start: calc(100% + 4px); inset-inline-end: 10px; z-index: 40; width: min(720px, calc(100vw - 20px)); max-height: min(70dvh, 520px); overflow-y: auto; overscroll-behavior: contain; padding: 12px 14px 14px; border: 1px solid var(--fw-edge); border-radius: 12px; background: var(--fw-surface); color: var(--fw-ink); box-shadow: 0 16px 32px rgb(0 0 0 / 32%); }
.fw-nav__panel-title { margin: 0 0 9px; color: var(--fw-muted); font-size: 10px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
.fw-nav__groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px 18px; }
.fw-nav__group-title { margin: 0 0 3px; color: var(--fw-muted); font-size: 10px; font-weight: 800; letter-spacing: .09em; text-transform: uppercase; }
.fw-nav__list { display: grid; gap: 1px; margin: 0; padding: 0; list-style: none; }
.fw-nav__item { display: flex; align-items: center; min-height: 32px; padding: 2px 6px; border-radius: 6px; color: var(--fw-ink); font-size: 12.5px; font-weight: 600; line-height: 1.35; text-decoration: none; }
.fw-nav__item:hover { background: var(--fw-raised); }
.fw-nav__item[aria-current="page"] { color: var(--fw-accent); font-weight: 800; text-decoration: underline; text-underline-offset: 3px; }
.fw-nav__note { margin: 10px 0 0; padding-top: 8px; border-block-start: 1px solid var(--fw-edge); color: var(--fw-muted); font-size: 11.5px; }
.fw-nav__where { margin: 0 0 0 auto; min-width: 0; color: var(--fw-muted); font-size: 12px; }
.fw-nav__where-label { font-size: 9.5px; font-weight: 800; letter-spacing: .09em; text-transform: uppercase; }
.fw-nav__where strong { color: var(--fw-ink); font-weight: 750; }
.fw-nav--fixed .fw-nav__where { flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 560px) {
  .fw-nav--fixed .fw-nav__where { display: none; }
  .fw-nav--fixed .fw-nav__link, .fw-nav--fixed .fw-nav__summary { font-size: 12px; padding-inline: 7px; }
}
@media (max-width: 420px) {
  .fw-nav { padding-inline: 8px; }
  .fw-nav__link, .fw-nav__summary { padding-inline: 8px; }
  .fw-nav--fixed .fw-nav__summary-text { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
}
@media (prefers-reduced-motion: reduce) {
  .fw-nav, .fw-nav * { transition: none !important; animation: none !important; }
}`;

function fail(message) {
  throw new Error(message);
}

function label(file) {
  const text = LABELS[file];
  if (!text) fail(`no nav label for ${file}`);
  return text;
}

/** The bar markup. Deterministic: same board, same bytes. */
export function navMarkup({ file, mode, variant }) {
  if (!['fixed', 'sticky'].includes(mode)) fail(`unknown nav mode: ${mode}`);
  if (!['map', 'aerial', 'panel', 'plain'].includes(variant)) fail(`unknown nav variant: ${variant}`);

  const primary = PRIMARY.map((entry) => {
    const current = entry.file === file ? ' aria-current="page"' : '';
    return `    <li><a class="fw-nav__link" href="${entry.file}" aria-label="${entry.name}"${current}>${entry.label}</a></li>`;
  }).join('\n');

  const groups = GROUPS.map((group) => {
    const id = `fw-nav-group-${group.key}`;
    const items = group.files
      .map((target) => {
        const current = target === file ? ' aria-current="page"' : '';
        return `            <li><a class="fw-nav__item" href="${target}"${current}>${label(target)}</a></li>`;
      })
      .join('\n');
    return `        <div class="fw-nav__group">
          <p class="fw-nav__group-title" id="${id}">${group.title}</p>
          <ul class="fw-nav__list" aria-labelledby="${id}">
${items}
          </ul>
        </div>`;
  }).join('\n');

  return `${NAV_START}
<nav class="fw-nav fw-nav--${mode} fw-nav--${variant}" aria-label="Navegación del producto FireWatch">
  <ul class="fw-nav__primary">
${primary}
  </ul>
  <details class="fw-nav__more">
    <summary class="fw-nav__summary"><span class="fw-nav__summary-text">Más destinos</span></summary>
    <div class="fw-nav__panel">
      <p class="fw-nav__panel-title">Otras pantallas del producto</p>
      <div class="fw-nav__groups">
${groups}
      </div>
      <p class="fw-nav__note">Mapa, Panel, Historial y Acciones están siempre en esta barra.</p>
    </div>
  </details>
  <p class="fw-nav__where"><span class="fw-nav__where-label">Estás en</span> <strong>${label(file)}</strong></p>
</nav>
${NAV_END}`;
}

export function styleBlock() {
  return `<style id="${STYLE_ID}">\n${NAV_CSS}\n</style>`;
}

function insertAfter(text, index, block, eol) {
  return text.slice(0, index) + eol + block + text.slice(index);
}

/**
 * Writes the style block and the bar into one standalone document.
 * Idempotent: an existing component block is replaced, never duplicated.
 */
export function injectNavigation(html, options) {
  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  const block = navMarkup(options).replaceAll('\n', eol);
  const style = styleBlock().replaceAll('\n', eol);
  let out = html;

  const styleAt = out.indexOf(`<style id="${STYLE_ID}">`);
  if (styleAt >= 0) {
    const styleEnd = out.indexOf('</style>', styleAt);
    if (styleEnd < 0) fail(`${options.file}: unterminated product navigation style`);
    out = out.slice(0, styleAt) + style + out.slice(styleEnd + '</style>'.length);
  } else {
    const meta = /<meta name="viewport" content="[^"]*"\s*\/?>/.exec(out);
    if (!meta) fail(`${options.file}: viewport meta not found`);
    out = insertAfter(out, meta.index + meta[0].length, style, eol);
  }

  const startAt = out.indexOf(NAV_START);
  if (startAt >= 0) {
    const endAt = out.indexOf(NAV_END, startAt);
    if (endAt < 0) fail(`${options.file}: product navigation end marker not found`);
    out = out.slice(0, startAt) + block + out.slice(endAt + NAV_END.length);
  } else {
    const skip = /<a class="(?:skip-link|skip)"[^>]*>[\s\S]*?<\/a>/.exec(out);
    if (skip) {
      out = insertAfter(out, skip.index + skip[0].length, block, eol);
    } else {
      const body = /<body[^>]*>/.exec(out);
      if (!body) fail(`${options.file}: body not found`);
      out = insertAfter(out, body.index + body[0].length, block, eol);
    }
  }
  return out;
}

/** Reads design.json without touching it. */
function readManifest() {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const files = Array.isArray(manifest.artboards) ? manifest.artboards.map((board) => board.file) : [];
  return { manifest, files };
}

function navSlice(html) {
  const start = html.indexOf(NAV_START);
  if (start < 0) return undefined;
  const end = html.indexOf(NAV_END, start);
  if (end < 0) return undefined;
  return { start, end, text: html.slice(start, end + NAV_END.length) };
}

function attributes(html, name) {
  return [...html.matchAll(new RegExp(`\\b${name}="([^"]*)"`, 'g'))].map((match) => match[1]);
}

/** Static checks for one standalone board. */
export function checkBoard(file, html, config) {
  const problems = [];
  const content = html.replaceAll('\r\n', '\n');
  const expected = navMarkup({ file, ...config });

  const styleAt = content.indexOf(`<style id="${STYLE_ID}">`);
  if (styleAt < 0) {
    problems.push(`${file}: product navigation style missing`);
  } else if (content.slice(styleAt + 1).includes(`<style id="${STYLE_ID}">`)) {
    problems.push(`${file}: product navigation style appears more than once`);
  } else {
    const styleEnd = content.indexOf('</style>', styleAt);
    const actual = content.slice(styleAt, styleEnd + '</style>'.length);
    if (actual !== styleBlock()) problems.push(`${file}: product navigation style drifted from the component`);
  }

  const slice = navSlice(content);
  if (!slice) {
    problems.push(`${file}: product navigation markers missing`);
    return problems;
  }
  if (slice.text !== expected) problems.push(`${file}: product navigation markup drifted from the component`);
  if (content.indexOf(NAV_START, slice.start + 1) !== -1) problems.push(`${file}: product navigation appears more than once`);

  const nav = slice.text;
  const navs = [...content.matchAll(/<nav\b[^>]*class="[^"]*\bfw-nav\b[^"]*"/g)];
  if (navs.length !== 1) problems.push(`${file}: expected one product navigation landmark, found ${navs.length}`);

  primaryHrefs(nav, problems, file);


  if (!/<a class="fw-nav__link" href="01-vista-aerea\.html"/.test(nav)) {
    problems.push(`${file}: no direct Mapa link`);
  }

  const currents = attributes(nav, 'aria-current');
  const excluded = EXCLUDED.includes(file);
  if (excluded) {
    if (currents.length !== 0) problems.push(`${file}: a reference board is not a menu destination`);
  } else if (currents.length !== 1) {
    problems.push(`${file}: expected one aria-current in the bar, found ${currents.length}`);
  }
  const currentLink = /<a class="fw-nav__(?:link|item)"[^>]*\bhref="([^"]+)"[^>]*\baria-current="page"/.exec(nav);
  if (excluded && currentLink) problems.push(`${file}: current reference board must not claim a menu destination`);
  if (!excluded && !currentLink) {
    problems.push(`${file}: aria-current is not on a destination link`);
  } else if (!excluded && currentLink[1] !== file) {
    problems.push(`${file}: aria-current points at ${currentLink[1]}`);
  }

  for (const forbidden of ['data-nav=', 'data-view=', 'class="view"', ' tabindex=', 'role="button"', 'target=', 'http://', 'https://', 'src=', '@import', 'url(']) {
    if (nav.includes(forbidden)) problems.push(`${file}: bar must not contain ${forbidden}`);
  }
  if (/href="(?:16-procesamiento|19-aun-no-implementado)\.html"/.test(nav)) {
    problems.push(`${file}: bar must not link the excluded reference boards`);
  }
  if (/<details\b[^>]*\bopen\b/.test(nav)) problems.push(`${file}: the destination disclosure must start closed`);

  const navIds = attributes(nav, 'id');
  if (new Set(navIds).size !== navIds.length) problems.push(`${file}: duplicate ids inside the bar`);
  const documentIds = attributes(content.replace(/<!--[\s\S]*?-->/g, ''), 'id');
  for (const id of navIds) {
    if (documentIds.filter((value) => value === id).length !== 1) {
      problems.push(`${file}: id ${id} collides with the rest of the document`);
    }
  }

  if (config.mode === 'fixed') {
    if (!content.includes('--fw-nav-h: 48px')) problems.push(`${file}: fixed bar height token missing`);
    if (!/inset:\s*calc\(14px \+ var\(--fw-nav-h\)\)|inset:\s*calc\(7px \+ var\(--fw-nav-h\)\)/.test(content)) {
      problems.push(`${file}: fixed panels are not shifted below the bar`);
    }
    const rail = content.indexOf('<aside id="work-rail"');
    if (rail >= 0 && navSlice(content).start > rail) problems.push(`${file}: the bar must live outside the map job rail`);
  }
  if (config.mode === 'sticky' && !/^\.fw-nav--sticky \{ position: sticky;/m.test(NAV_CSS)) {
    problems.push(`${file}: document bar must be sticky`);
  }
  return problems;
}

function primaryHrefs(nav, problems, file) {
  const actual = [...nav.matchAll(/class="fw-nav__link" href="([^"]+)"/g)].map((match) => match[1]);
  const expected = PRIMARY.map((entry) => entry.file);
  if (actual.length !== expected.length || actual.some((href, index) => href !== expected[index])) {
    problems.push(`${file}: primary destinations are ${actual.join(', ') || 'missing'}`);
  }
}

/** Menu coverage: every catalog board except the two internal references. */
function checkCoverage(problems, manifestFiles) {
  const menu = [...PRIMARY.map((entry) => entry.file), ...GROUPS.flatMap((group) => group.files)];
  const duplicates = menu.filter((file, index) => menu.indexOf(file) !== index);
  if (duplicates.length) problems.push(`bar repeats destinations: ${[...new Set(duplicates)].join(', ')}`);

  const expected = manifestFiles.filter((file) => !EXCLUDED.includes(file));
  const missing = expected.filter((file) => !menu.includes(file));
  const extra = menu.filter((file) => !manifestFiles.includes(file));
  if (missing.length) problems.push(`bar misses catalog destinations: ${missing.join(', ')}`);
  if (extra.length) problems.push(`bar links files outside the catalog: ${extra.join(', ')}`);
  if (PRIMARY.length + GROUPS.reduce((total, group) => total + group.files.length, 0) !== expected.length) {
    problems.push('bar destination count does not match the catalog minus the excluded references');
  }
  for (const file of ['16-procesamiento.html', '19-aun-no-implementado.html']) {
    if (!manifestFiles.includes(file)) problems.push(`design.json must keep ${file}`);
  }
  for (const file of Object.keys(LABELS)) {
    if (!manifestFiles.includes(file)) problems.push(`nav label for ${file} is not in design.json`);
  }
}

/** Applies the same configuration the write path uses to one board. */
function configFor(file) {
  const direct = DIRECT_BY_FILE[file];
  if (direct) return { mode: direct.mode, variant: direct.variant };
  const variant = generatedVariant(file);
  if (!variant) return undefined;
  return { mode: 'sticky', variant };
}

function generatedVariant(file) {
  const table = {
    '04-cobertura-territorial.html': 'aerial',
    '05-historial-de-lotes.html': 'aerial',
    '06-acciones-preventivas.html': 'aerial',
    '07-panel-ejecutivo.html': 'panel',
    '08-comparar-sectores.html': 'panel',
    '09-notificaciones.html': 'panel',
    '10-simulacion-contrafactual.html': 'aerial',
    '11-observaciones-de-campo.html': 'aerial',
    '12-exportacion-csv.html': 'aerial',
    '13-ficha-de-zona.html': 'aerial',
    '14-acceso.html': 'panel',
    '15-fuentes-y-servicios.html': 'panel',
    '16-procesamiento.html': 'panel',
    '17-sesion-y-permisos.html': 'panel',
    '18-registro-de-actividad.html': 'panel',
    '19-aun-no-implementado.html': 'panel'
  };
  return table[file];
}

function checkAll() {
  const problems = [];
  const { manifest, files } = readManifest();

  if (manifest.feature !== 'odd/tasks/v1-gentle-design.md') problems.push('design.json: feature must stay odd/tasks/v1-gentle-design.md');
  if (files.length !== CATALOG.length) problems.push(`design.json: expected ${CATALOG.length} artboards, found ${files.length}`);
  CATALOG.forEach((expected, index) => {
    if (files[index] !== expected) problems.push(`design.json: artboard ${index + 1} is ${files[index] || 'missing'}, expected ${expected}`);
  });
  checkCoverage(problems, files);

  for (const file of CATALOG) {
    const path = join(HERE, file);
    if (!existsSync(path)) {
      problems.push(`${file}: missing`);
      continue;
    }
    const html = readFileSync(path, 'utf8');
    const config = configFor(file);
    if (!config) {
      problems.push(`${file}: no bar configuration`);
      continue;
    }
    const generated = html.includes(GENERATOR_MARKER);
    if (DIRECT_BY_FILE[file] && generated) problems.push(`${file}: direct board must not come from the generator`);
    if (!DIRECT_BY_FILE[file] && !generated) problems.push(`${file}: expected a generated board`);
    problems.push(...checkBoard(file, html, config));
  }

  const aerial = readFileSync(join(HERE, '01-vista-aerea.html'), 'utf8').replaceAll('\r\n', '\n');
  if (aerial.includes('Otras vistas')) problems.push('01-vista-aerea.html: the superseded "Otras vistas" block is still there');
  if (/<details class="rail-block links"/.test(aerial)) problems.push('01-vista-aerea.html: the job rail still carries a destination list');

  return problems;
}

function fileUrl(file) {
  return pathToFileURL(join(HERE, file)).href;
}

function findChromium() {
  const candidates = [process.env.FW_CHROMIUM];
  const cache = join(homedir(), 'AppData', 'Local', 'ms-playwright');
  if (existsSync(cache)) {
    for (const name of readdirSync(cache)) {
      if (name.startsWith('chromium-')) candidates.push(join(cache, name, 'chrome-win64', 'chrome.exe'));
    }
  }
  candidates.push(
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  );
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

async function waitForDebugger(port, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* the debugger is not listening yet */
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  fail('the local browser did not expose a debugging target');
}

function openSocket(url) {
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = new WebSocket(url);
    socket.addEventListener('open', () => resolveSocket(socket));
    socket.addEventListener('error', () => rejectSocket(new Error('browser socket failed')));
  });
}

function cdpClient(socket) {
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolveCommand, rejectCommand } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) rejectCommand(new Error(`${message.error.message} (${message.error.code})`));
      else resolveCommand(message.result);
      return;
    }
    const handlers = listeners.get(message.method) || [];
    for (const handler of handlers) handler(message.params);
  });
  return {
    send(method, params = {}) {
      nextId += 1;
      const id = nextId;
      return new Promise((resolveCommand, rejectCommand) => {
        pending.set(id, { resolveCommand, rejectCommand });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    on(method, handler) {
      listeners.set(method, [...(listeners.get(method) || []), handler]);
    },
    close() {
      socket.close();
    }
  };
}

const DESKTOP = { name: 'escritorio', width: 1440, height: 900, mobile: false };
const MOBILE = { name: 'móvil 390', width: 390, height: 844, mobile: true };
const NARROW = { name: 'angosto 320', width: 320, height: 720, mobile: true };

async function browserCheck() {
  const chromium = findChromium();
  if (!chromium) {
    console.log('SKIP: no local Chromium found (set FW_CHROMIUM to run the keyboard round trip).');
    return 0;
  }

  const port = 9300 + (process.pid % 400);
  const profile = join(tmpdir(), `firewatch-nav-${process.pid}`);
  const browser = spawn(
    chromium,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--mute-audio',
      '--window-size=1440,900',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      'about:blank'
    ],
    { stdio: 'ignore' }
  );

  const problems = [];
  const external = new Set();
  const consoleErrors = [];
  let overflowChecks = 0;
  let barChecks = 0;
  const barScrolls = [];
  let socket;

  try {
    const endpoint = await waitForDebugger(port);
    socket = await openSocket(endpoint);
    const cdp = cdpClient(socket);

    cdp.on('Network.requestWillBeSent', ({ request }) => {
      if (!/^(file|data|about):/.test(request.url)) external.add(request.url);
    });
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
      consoleErrors.push(exceptionDetails.exception?.description || exceptionDetails.text || 'exception');
    });
    cdp.on('Runtime.consoleAPICalled', ({ type, args }) => {
      if (type === 'error') consoleErrors.push(args.map((arg) => arg.value || arg.description || '').join(' '));
    });
    cdp.on('Log.entryAdded', ({ entry }) => {
      if (entry.level === 'error') consoleErrors.push(entry.text);
    });

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');
    await cdp.send('Page.bringToFront');

    const evaluate = async (expression) => {
      const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true
      });
      if (exceptionDetails) throw new Error(exceptionDetails.text || 'evaluation failed');
      return result.value;
    };

    const viewport = async (target) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: target.width,
        height: target.height,
        deviceScaleFactor: 1,
        mobile: target.mobile
      });
    };

    const hrefMatches = (href, file) => {
      try {
        return new URL(href).pathname.endsWith(`/${file}`);
      } catch {
        return false;
      }
    };

    const waitForFile = async (file, label) => {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        try {
          const href = await evaluate('location.href');
          if (hrefMatches(href, file)) {
            await evaluate('new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))');
            return true;
          }
        } catch {
          /* the document is being replaced */
        }
        await new Promise((done) => setTimeout(done, 50));
      }
      problems.push(`${label}: did not reach ${file}`);
      return false;
    };

    const navigate = async (file) => {
      await cdp.send('Page.navigate', { url: fileUrl(file) });
      return waitForFile(file, targetName());
    };

    let currentTarget = DESKTOP;
    const targetName = () => currentTarget.name;

    const pressKey = async (key, code, keyCode) => {
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key,
        code,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode
      });
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key,
        code,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode
      });
    };

    const focused = () =>
      evaluate(`(() => { const node = document.activeElement; if (!node) return null;
        return { tag: node.tagName, href: node.getAttribute && node.getAttribute('href'), cls: node.className || '', text: (node.textContent || '').trim().slice(0, 60) }; })()`);

    const tabTo = async (predicate, description) => {
      for (let step = 0; step < 80; step += 1) {
        await pressKey('Tab', 'Tab', 9);
        const node = await focused();
        if (node && predicate(node)) return node;
      }
      problems.push(`${targetName()}: could not reach ${description} with Tab`);
      return undefined;
    };

    const activate = async () => {
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        text: '\r',
        unmodifiedText: '\r'
      });
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13
      });
    };

    const overflow = async (file) => {
      const box = await evaluate(
        `({ inner: innerWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth })`
      );
      overflowChecks += 1;
      const widest = Math.max(box.scroll, box.body);
      if (widest > box.inner + 1) problems.push(`${file} @ ${box.inner}px: horizontal overflow ${widest}px > ${box.inner}px`);
    };

    const barLayout = async (file) => {
      const box = await evaluate(`(() => {
        const nav = document.querySelector('.fw-nav');
        if (!nav) return null;
        const bar = nav.getBoundingClientRect();
        const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect() ?? null;
        const headerNode = document.querySelector('header');
        const header = rect('header');
        const controlsNode = document.querySelector('.controls');
        const controls = rect('.controls');
        const rail = rect('#work-rail');
        const insets = rect('.insets');
        const app = rect('.app');
        const visible = (node) => Boolean(node && node.getClientRects().length);
        return { position: getComputedStyle(nav).position, scrollY,
          bar: { top: bar.top, bottom: bar.bottom, height: bar.height },
          headerTop: visible(headerNode) ? header?.top ?? null : null,
          headerClass: headerNode?.className || null,
          controlsTop: visible(controlsNode) ? controls?.top ?? null : null,
          railTop: rail?.top ?? null, insetsTop: insets?.top ?? null,
          appTop: app?.top ?? null, inner: innerWidth };
      })()`);
      if (!box) {
        problems.push(`${file}: bar missing from the rendered page`);
        return;
      }
      if (process.env.FW_NAV_DEBUG) console.log(`${file} @ ${box.inner}px ${JSON.stringify(box)}`);
      const overlaps = [
        ['header', box.headerTop],
        ['controls', box.controlsTop],
        ['work-rail', box.railTop],
        ['insets', box.insetsTop]
      ]
        .filter(([, top]) => top !== null)
        /* Sticky bars sit above content that scrolls under them: compare in
           document space so a scrolled heading is not reported as a collision. */
        .map(([name, top]) => [name, top + box.scrollY, top])
        .filter(([, docTop]) => docTop + 0.5 < box.bar.height);
      if (box.position === 'fixed') {
        if (box.bar.top > 0.5) problems.push(`${file} @ ${box.inner}px: fixed bar does not start at the viewport top`);
        if (box.bar.height > 56) problems.push(`${file} @ ${box.inner}px: fixed bar grew to ${box.bar.height}px`);
        for (const [name, , top] of overlaps) {
          problems.push(`${file} @ ${box.inner}px: ${name} overlaps the bar (${top} < ${box.bar.bottom})`);
        }
      } else if (box.position === 'sticky') {
        if (box.bar.top > 0.5) problems.push(`${file} @ ${box.inner}px: sticky bar is not anchored at the top`);
        for (const [name, docTop] of overlaps) {
          problems.push(`${file} @ ${box.inner}px: ${name} starts at ${docTop}px, inside the sticky bar`);
        }
      } else {
        problems.push(`${file} @ ${box.inner}px: bar is neither fixed nor sticky (${box.position})`);
      }
    };

    const roundTrip = async (target) => {
      currentTarget = target;
      await viewport(target);

      // 01 → Historial de lotes (primary bar destination) with the keyboard.
      if (!(await navigate('01-vista-aerea.html'))) return;
      await overflow('01-vista-aerea.html');
      await barLayout('01-vista-aerea.html');
      const historial = await tabTo((node) => node.href === '05-historial-de-lotes.html', 'el enlace Historial');
      if (!historial) return;
      await activate();
      if (!(await waitForFile('05-historial-de-lotes.html', `${target.name} tras activar Historial`))) return;
      await overflow('05-historial-de-lotes.html');

      // Historial → Notificaciones through the grouped disclosure.
      const summary = await tabTo((node) => node.tag === 'SUMMARY', 'el resumen Más destinos');
      if (!summary) return;
      await activate();
      const open = await evaluate(`document.querySelector('.fw-nav__more').open === true`);
      if (!open) {
        problems.push(`${target.name}: Enter did not open the destination disclosure`);
        return;
      }
      const notificaciones = await tabTo((node) => node.href === '09-notificaciones.html', 'Notificaciones dentro del desplegable');
      if (!notificaciones) return;
      await activate();
      if (!(await waitForFile('09-notificaciones.html', `${target.name} tras activar Notificaciones`))) return;
      await overflow('09-notificaciones.html');

      // Notificaciones → Mapa with the direct return.
      const mapa = await tabTo((node) => node.href === '01-vista-aerea.html', 'el enlace Mapa');
      if (!mapa) return;
      await activate();
      if (!(await waitForFile('01-vista-aerea.html', `${target.name} tras activar Mapa`))) return;
      await overflow('01-vista-aerea.html');

      console.log(`ok ${target.name}: 01 → Historial → Notificaciones → 01 con Tab y Enter`);
    };

    for (const target of [DESKTOP, MOBILE]) await roundTrip(target);

    // Legacy in-document view hash still selects its view on a generated board.
    currentTarget = DESKTOP;
    await viewport(DESKTOP);
    await cdp.send('Page.navigate', { url: `${fileUrl('05-historial-de-lotes.html')}#acciones` });
    if (await waitForFile('05-historial-de-lotes.html', 'hash heredado')) {
      const visible = await evaluate(`document.querySelector('section.view:not([hidden])')?.id`);
      if (visible === 'acciones') console.log('ok escritorio: el hash heredado #acciones sigue cambiando de vista');
      else problems.push(`hash heredado #acciones mostró "${visible}"`);
    }

    // Full collection: no horizontal overflow and the bar renders everywhere.
    for (const target of [DESKTOP, MOBILE, NARROW]) {
      currentTarget = target;
      await viewport(target);
      for (const file of CATALOG) {
        if (!(await navigate(file))) continue;
        await overflow(file);
        const bar = await evaluate(`(() => {
          const nav = document.querySelector('.fw-nav');
          if (!nav) return null;
          const box = nav.getBoundingClientRect();
          const summary = nav.querySelector('.fw-nav__summary')?.getBoundingClientRect();
          const list = nav.querySelector('.fw-nav__primary');
          return { width: box.width, height: box.height, summary: summary ? summary.width : 0, inner: innerWidth,
            scroll: list ? list.scrollWidth > list.clientWidth + 1 : false };
        })()`);
        if (!bar) {
          problems.push(`${file}: bar missing at ${target.width}px`);
          continue;
        }
        if (bar.summary < 24) problems.push(`${file} @ ${target.width}px: la divulgación queda fuera del ancho visible`);
        if (bar.width > bar.inner + 1) problems.push(`${file} @ ${target.width}px: la barra excede el ancho visible`);
        await barLayout(file);
        barChecks += 1;
        if (bar.scroll) barScrolls.push(`${file} @ ${target.width}px`);
      }
    }
  } catch (error) {
    problems.push(`browser check failed: ${error.message}`);
  } finally {
    if (socket) socket.close();
    browser.kill();
  }

  if (external.size) problems.push(`external requests: ${[...external].join(', ')}`);
  if (consoleErrors.length) problems.push(`console errors: ${[...new Set(consoleErrors)].join(' | ')}`);

  for (const file of CATALOG) {
    if (!existsSync(join(HERE, file))) problems.push(`${file}: missing`);
  }

  if (barScrolls.length) {
    console.log(`note: la lista primaria necesita desplazamiento horizontal en ${barScrolls.join(', ')}`);
  }
  if (problems.length) {
    console.error(`\n${problems.length} navigation problem(s):`);
    for (const problem of problems) console.error(`- ${problem}`);
    process.exitCode = 1;
    return 1;
  }
  console.log(`ok: ${barChecks} cargas de tablero y ${overflowChecks} mediciones de ancho, sin desbordamiento horizontal.`);
  console.log(`ok: sin peticiones externas ni errores de consola en la sesión de navegación.`);
  console.log(`\nok: round trip and layout verified in ${chromium}`);
  return 0;
}

function main(argv) {
  const known = new Set(['--check', '--browser-check']);
  const unknown = argv.filter((argument) => !known.has(argument));
  if (unknown.length) {
    console.error('usage: node product-navigation.mjs [--check | --browser-check]');
    process.exit(2);
  }
  if (argv.includes('--browser-check')) {
    browserCheck().then((code) => {
      if (code) process.exit(1);
    });
    return;
  }
  const problems = checkAll();
  if (problems.length) {
    console.error(`${problems.length} navigation problem(s):`);
    for (const problem of problems) console.error(`- ${problem}`);
    process.exit(1);
  }
  console.log(`ok: ${CATALOG.length} boards carry the shared product navigation; ${PRIMARY.length} direct destinations and ${GROUPS.length} groups.`);
  console.log(`ok: design.json keeps ${CATALOG.length} ordered artboards; ${EXCLUDED.length} internal references stay out of the menu.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
