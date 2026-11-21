#!/usr/bin/env node
/**
 * Builds the direct-view artboards of this collection from the four source
 * boards that already contain the 16 v1 screens. Dependency-free and
 * deterministic: same inputs, same bytes.
 *
 *   node design/firewatch-v1-vuelo/build-artboards.mjs          write snapshots
 *   node design/firewatch-v1-vuelo/build-artboards.mjs --check  read-only drift check
 *
 * With line endings normalized, each output is its source board except for
 * the generated marker, the initial `hidden`/`aria-current` state and the
 * bootstrap's default view. Palette, fonts, layout and interactions are
 * unchanged. The three map artboards are never read or written here.
 */
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESIGN = resolve(HERE, '..');
const MANIFEST = join(HERE, 'design.json');
const GENERATOR = 'design/firewatch-v1-vuelo/build-artboards.mjs';
const MARKER = `<!-- Generado por ${GENERATOR}`;
const FEATURE = 'odd/tasks/v1-gentle-design.md';
const CANVAS = { width: 1440, height: 900 };

/**
 * Each source board is a multi-view prototype whose bootstrap falls back to a
 * known view when the URL carries no hash. `boot` names the two exact literals
 * that select that fallback, so a source change fails loudly instead of
 * silently producing the wrong initial artboard.
 */
const SOURCES = {
  prevencion: {
    file: 'firewatch-v1-recorrido/01-prevencion-territorial.html',
    defaultView: 'territorio',
    boot: ["name = 'territorio';", "? initialHash : 'territorio', false);"]
  },
  control: {
    file: 'firewatch-v1-recorrido/02-control-y-acceso.html',
    defaultView: 'acceso',
    boot: ["? hash : 'acceso';", "id = 'acceso';"]
  },
  decisiones: {
    file: 'firewatch-v1-casos/01-decisiones.html',
    defaultView: 'panel',
    boot: ["? hash : 'panel';", "id = 'panel';"]
  },
  campo: {
    file: 'firewatch-v1-casos/02-campo-y-entrega.html',
    defaultView: 'simulacion',
    boot: ["name = 'simulacion';", "? initialHash : 'simulacion', false);"]
  }
};

/** Catalog order, titles and generated file names. All 19 are 1440×900. */
const ARTBOARDS = [
  { file: '01-vista-aerea.html', title: 'Territorio · Vista aérea', map: true },
  { file: '04-cobertura-territorial.html', title: 'Cobertura y contexto territorial', source: 'prevencion', view: 'territorio' },
  { file: '05-historial-de-lotes.html', title: 'Historial de lotes', source: 'prevencion', view: 'historial' },
  { file: '06-acciones-preventivas.html', title: 'Acciones preventivas', source: 'prevencion', view: 'acciones' },
  { file: '07-panel-ejecutivo.html', title: 'Panel ejecutivo', source: 'decisiones', view: 'panel' },
  { file: '08-comparar-sectores.html', title: 'Comparar sectores', source: 'decisiones', view: 'comparar' },
  { file: '09-notificaciones.html', title: 'Notificaciones', source: 'decisiones', view: 'notificaciones' },
  { file: '10-simulacion-contrafactual.html', title: 'Simulación contrafactual', source: 'campo', view: 'simulacion' },
  { file: '11-observaciones-de-campo.html', title: 'Observaciones de campo', source: 'campo', view: 'campo' },
  { file: '12-exportacion-csv.html', title: 'Exportación CSV', source: 'campo', view: 'exportacion' },
  { file: '13-ficha-de-zona.html', title: 'Ficha de zona · Vista previa PDF', source: 'campo', view: 'ficha' },
  { file: '14-acceso.html', title: 'Acceso · Iniciar sesión y crear cuenta', source: 'control', view: 'acceso' },
  { file: '15-fuentes-y-servicios.html', title: 'Fuentes y servicios', source: 'control', view: 'fuentes' },
  { file: '16-procesamiento.html', title: 'Procesamiento', source: 'control', view: 'procesamiento' },
  { file: '17-sesion-y-permisos.html', title: 'Sesión y permisos', source: 'control', view: 'sesion' },
  { file: '18-registro-de-actividad.html', title: 'Registro de actividad', source: 'control', view: 'auditoria' },
  { file: '19-aun-no-implementado.html', title: 'Aún no implementado', source: 'control', view: 'pendiente' },
  { file: '02-vista-regional.html', title: 'Complemento · Vista regional', map: true },
  { file: '03-acciones-en-el-mapa.html', title: 'Complemento · Acciones rápidas desde el mapa', map: true }
];

function fail(message) {
  throw new Error(message);
}

/** Reads one source board and describes its initial static view state. */
function sourceShape(html, file) {
  const sections = [...html.matchAll(/<section class="view" id="([^"]+)" data-view="([^"]+)"[^>]*>/g)]
    .map((match) => ({
      id: match[1],
      view: match[2],
      hidden: /\shidden(?=[\s>])/.test(match[0])
    }));
  const navs = [...html.matchAll(/<a\b[^>]*\bdata-nav="([^"]+)"[^>]*>/g)]
    .map((match) => ({ view: match[1], current: /\saria-current="page"/.test(match[0]) }));

  if (sections.length < 2) fail(`${file}: no view sections found`);
  if (sections.some((section) => section.id !== section.view)) fail(`${file}: section id/data-view mismatch`);
  if (new Set(sections.map((section) => section.view)).size !== sections.length) fail(`${file}: duplicate section views`);

  const visible = sections.filter((section) => !section.hidden);
  const current = navs.filter((nav) => nav.current);
  if (visible.length !== 1) fail(`${file}: expected exactly one initially visible view, found ${visible.length}`);
  if (current.length !== 1) fail(`${file}: expected exactly one aria-current nav, found ${current.length}`);
  if (navs.length !== sections.length) fail(`${file}: ${navs.length} nav links for ${sections.length} views`);
  if (new Set(navs.map((nav) => nav.view)).size !== navs.length) fail(`${file}: duplicate nav views`);
  if (visible[0].view !== current[0].view) fail(`${file}: visible view differs from aria-current`);

  return { sections, visible: visible[0].view };
}

function sectionSlice(html, view) {
  const needle = `<section class="view" id="${view}" data-view="${view}"`;
  const start = html.indexOf(needle);
  if (start < 0) fail(`section for view "${view}" not found`);
  if (html.indexOf(needle, start + needle.length) !== -1) fail(`section for view "${view}" is not unique`);
  const end = html.indexOf('>', start);
  if (end < 0) fail(`unterminated section for view "${view}"`);
  return { start, end, tag: html.slice(start, end) };
}

function setSectionHidden(html, view, hidden) {
  const { start, end, tag } = sectionSlice(html, view);
  const attrs = tag.replace(/\s+hidden(?=\s|$)/g, '');
  const next = hidden ? attrs.replace(`data-view="${view}"`, `data-view="${view}" hidden`) : attrs;
  return html.slice(0, start) + next + html.slice(end);
}

function navSlice(html, view) {
  const pattern = new RegExp(`<a\\b[^>]*\\bdata-nav="${view}"[^>]*>`);
  const match = html.match(pattern);
  if (!match) fail(`nav link for view "${view}" not found`);
  const start = html.indexOf(match[0]);
  if (html.indexOf(match[0], start + 1) !== -1) fail(`nav link for view "${view}" is not unique`);
  return { start, end: start + match[0].length, tag: match[0] };
}

function setNavCurrent(html, view, current) {
  const { start, end, tag } = navSlice(html, view);
  let next = tag.replace(/\s+aria-current="page"/g, '');
  if (current) next = next.replace(/>$/, ' aria-current="page">');
  return html.slice(0, start) + next + html.slice(end);
}

/** Points the existing bootstrap fallback at the requested view. */
function setBootDefault(html, source, view) {
  if (source.defaultView === view) return html;
  for (const pattern of source.boot) {
    const at = html.indexOf(pattern);
    if (at < 0 || html.includes(pattern, at + pattern.length)) {
      fail(`${source.file}: expected one occurrence of bootstrap literal: ${pattern}`);
    }
    const replacement = pattern.replaceAll(`'${source.defaultView}'`, `'${view}'`);
    if (replacement === pattern) fail(`${source.file}: bootstrap literal does not name ${source.defaultView}`);
    html = html.slice(0, at) + replacement + html.slice(at + pattern.length);
  }
  return html;
}

function markGenerated(html, source, entry) {
  if (html.indexOf('<!doctype html>') !== 0) fail(`${source.file}: unexpected document start`);
  const notice = `${MARKER} desde ${source.file} (vista ${entry.view}). No editar: se regenera con \`node build-artboards.mjs\`. -->`;
  const marked = html.replace('<!doctype html>', `<!doctype html>\n${notice}`);
  const meta = `<meta name="generator" content="${GENERATOR}" />`;
  const complete = marked.replace(/<meta charset="[^"]*" \/>/, (tag) => `${tag}\n${meta}`);
  if (complete === marked) fail(`${source.file}: charset meta not found`);
  return complete;
}

function buildArtboard(source, entry) {
  const known = source.shape.sections.some((section) => section.view === entry.view);
  if (!known) fail(`${entry.file}: view "${entry.view}" is not in ${source.file}`);
  let html = source.text;
  if (source.defaultView !== entry.view) {
    html = setSectionHidden(html, source.defaultView, true);
    html = setNavCurrent(html, source.defaultView, false);
  }
  html = setSectionHidden(html, entry.view, false);
  html = setNavCurrent(html, entry.view, true);
  return markGenerated(setBootDefault(html, source, entry.view), source, entry);
}

function firstDifferingLine(actual, expected) {
  const left = actual.split('\n');
  const right = expected.split('\n');
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) return index + 1;
  }
  return 1;
}

/** Read-only consistency between design.json and the expected collection. */
function checkManifest() {
  const problems = [];
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  } catch (error) {
    return [`design.json: ${error.message}`];
  }
  if (manifest.feature !== FEATURE) problems.push(`design.json: feature must stay ${FEATURE}`);
  const boards = Array.isArray(manifest.artboards) ? manifest.artboards : [];
  if (boards.length !== ARTBOARDS.length) {
    problems.push(`design.json: expected ${ARTBOARDS.length} artboards, found ${boards.length}`);
  }
  ARTBOARDS.forEach((expected, index) => {
    const board = boards[index];
    if (!board) {
      problems.push(`design.json: missing artboard ${index + 1} (${expected.file})`);
      return;
    }
    if (board.file !== expected.file) problems.push(`design.json: artboard ${index + 1} is ${board.file}, expected ${expected.file}`);
    if (board.title !== expected.title) problems.push(`design.json: ${expected.file} title must be "${expected.title}"`);
    if (board.width !== CANVAS.width || board.height !== CANVAS.height) {
      problems.push(`design.json: ${expected.file} must stay ${CANVAS.width}×${CANVAS.height}`);
    }
    if (typeof board.tradeoff !== 'string' || board.tradeoff.trim().length < 40) {
      problems.push(`design.json: ${expected.file} needs a tradeoff sentence`);
    }
  });
  const files = boards.map((board) => board.file);
  if (new Set(files).size !== files.length) problems.push('design.json: duplicate artboard filenames');
  return problems;
}

function readHtml(path) {
  return readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
}

function inspectOutput(entry) {
  const path = join(HERE, entry.file);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  const linkedOrSpecial = stat && (!stat.isFile() || stat.nlink !== 1);
  const actual = stat && !linkedOrSpecial ? readHtml(path) : undefined;
  const expectedHeader = entry.content.split('\n', 2).join('\n') + '\n';
  const conflict = linkedOrSpecial || (stat && !actual.startsWith(expectedHeader));
  return { ...entry, path, actual, conflict };
}

function readSources() {
  const sources = {};
  for (const [key, config] of Object.entries(SOURCES)) {
    const path = join(DESIGN, config.file);
    if (!existsSync(path)) fail(`source board missing: ${config.file}`);
    const text = readHtml(path);
    const shape = sourceShape(text, config.file);
    if (shape.visible !== config.defaultView) {
      fail(`${config.file}: initial view is "${shape.visible}", expected "${config.defaultView}"`);
    }
    sources[key] = { ...config, text, shape };
  }
  return sources;
}

function main(argv) {
  const unknown = argv.filter((argument) => argument !== '--check');
  if (unknown.length) {
    console.error(`usage: node ${GENERATOR} [--check]`);
    process.exit(2);
  }
  const checking = argv.includes('--check');
  const sources = readSources();
  const generated = ARTBOARDS.filter((entry) => entry.source).map((entry) => {
    const source = sources[entry.source];
    return { ...entry, content: buildArtboard(source, entry) };
  }).map(inspectOutput);

  if (checking) {
    const problems = [];
    for (const entry of generated) {
      if (entry.conflict) {
        problems.push(`${entry.file}: not an independent file generated for this view`);
      } else if (entry.actual === undefined) {
        problems.push(`${entry.file}: missing (run the builder without --check)`);
      } else if (entry.actual !== entry.content) {
        problems.push(`${entry.file}: drift at line ${firstDifferingLine(entry.actual, entry.content)}`);
      } else {
        console.log(`ok ${entry.file}`);
      }
    }
    problems.push(...checkManifest());
    if (problems.length) {
      console.error(`\n${problems.length} drift problem(s):`);
      problems.forEach((problem) => console.error(`- ${problem}`));
      process.exit(1);
    }
    console.log(`\nok: ${generated.length} generated artboards match their sources; ${ARTBOARDS.length} catalog entries are ordered and titled as expected.`);
    return;
  }

  const conflicts = generated.filter((entry) => entry.conflict);
  if (conflicts.length) {
    console.error(`refusing to overwrite ${conflicts.length} file(s) that are not independent generated artboards:`);
    conflicts.forEach((entry) => console.error(`- ${entry.file}`));
    process.exit(1);
  }

  let written = 0;
  for (const entry of generated) {
    if (entry.actual === entry.content) {
      console.log(`unchanged ${entry.file}`);
      continue;
    }
    writeFileSync(entry.path, entry.content, 'utf8');
    written += 1;
    console.log(`wrote ${entry.file}`);
  }
  console.log(`\n${written} written, ${generated.length - written} unchanged, ${generated.length} generated artboards.`);
  console.log(`verify with: node ${GENERATOR} --check`);
}

main(process.argv.slice(2));
