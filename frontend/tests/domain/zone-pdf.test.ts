// PM-14 — the per-zone PDF ficha, read back through its own operators.
//
// The acceptance criterion says it plainly: «la generación es reproducible para la
// misma entrada y la prueba compara el texto, no los bytes del archivo». So this
// suite is a small PDF reader, not a snapshot of a byte array:
//
//   * the header, the cross-reference table and the object offsets are parsed, so
//     the file is proved to be a valid PDF 1.4 that a viewer can open;
//   * the uncompressed content streams are walked with a real operator lexer —
//     string literals with escapes, arrays, names, numbers and operators — and the
//     text-showing operators are reassembled per text line, decoded from
//     WinAnsiEncoding;
//   * the commune map is asserted as path operators (`m`, `l`, `h`, `B`/`S`)
//     projected inside the framed map box, never as an image;
//   * the assertions compare the extracted text — headings, variables, values, the
//     `R2` label, the `R3` disclosure, the date — so a layout change cannot fail
//     the suite while a content regression cannot hide behind it.
//
// No fixture reads the clock: the publication instant comes from the batch, as the
// generator requires, and determinism is proved by changing the system clock
// between two calls and comparing the whole document.

import { afterEach, expect, test, vi } from 'vitest';

import { generateZonePdf, zonePdfFilename } from '../../src/domain/zonePdf';
import type { GeoGeometry, RiskBatch } from '../../src/types/api';

// --- WinAnsiEncoding ------------------------------------------------------
//
// A standard Type1 font with `/WinAnsiEncoding` addresses glyphs by byte, and the
// bytes 0x80–0x9F carry the CP1252 punctuation instead of the Latin-1 controls.
// Decoding them is what lets the assertions compare Spanish text as text.

const WIN_ANSI: Readonly<Record<number, string>> = {
  0x80: '\u20AC',
  0x82: '\u201A',
  0x83: '\u0192',
  0x84: '\u201E',
  0x85: '\u2026',
  0x86: '\u2020',
  0x87: '\u2021',
  0x88: '\u02C6',
  0x89: '\u2030',
  0x8a: '\u0160',
  0x8b: '\u2039',
  0x8c: '\u0152',
  0x8e: '\u017D',
  0x91: '\u2018',
  0x92: '\u2019',
  0x93: '\u201C',
  0x94: '\u201D',
  0x95: '\u2022',
  0x96: '\u2013',
  0x97: '\u2014',
  0x98: '\u02DC',
  0x99: '\u2122',
  0x9a: '\u0161',
  0x9b: '\u203A',
  0x9c: '\u0153',
  0x9e: '\u017E',
  0x9f: '\u0178',
};

function decodeWinAnsi(value: string): string {
  let decoded = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    decoded += WIN_ANSI[code] ?? character;
  }
  return decoded;
}

// One char per byte, so the raw file can be sliced with the offsets the
// cross-reference table declares.
function latin1(bytes: Uint8Array): string {
  let text = '';
  const chunk = 8192;
  for (let index = 0; index < bytes.length; index += chunk) {
    text += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return text;
}

// --- A content-stream lexer ----------------------------------------------
//
// The tokens are the ones a PDF content stream really carries: literal strings
// with the escape forms `\(`, `\)`, `\\` and octal, hex strings, arrays, names,
// numbers and operators. The lexer records which operator painted which path, so
// the commune geometry can be proved to be vector graphics.

interface PathBlock {
  construction: string[];
  paint: string;
  points: Array<{ x: number; y: number }>;
}

interface ParsedContent {
  lines: string[];
  operators: string[];
  paths: PathBlock[];
  points: Array<{ op: string; x: number; y: number }>;
}

const CONSTRUCTION_OPERATORS = new Set(['m', 'l', 'c', 'v', 'y', 're', 'h']);
const PAINT_OPERATORS = new Set(['B', 'B*', 'b', 'b*', 'S', 's', 'f', 'f*', 'n']);
const LINE_OPERATORS = new Set(['Tm', 'Td', 'TD', 'T*', 'ET']);

function readLiteralString(stream: string, start: number): { value: string; next: number } {
  let index = start + 1;
  let depth = 1;
  let value = '';
  while (index < stream.length) {
    const character = stream[index];
    if (character === '\\') {
      const escape = stream[index + 1] ?? '';
      index += 2;
      if (escape === 'n') value += '\n';
      else if (escape === 'r') value += '\r';
      else if (escape === 't') value += '\t';
      else if (escape === 'b') value += '\b';
      else if (escape === 'f') value += '\f';
      else if (/[0-7]/.test(escape)) {
        let octal = escape;
        while (octal.length < 3 && /[0-7]/.test(stream[index] ?? '')) {
          octal += stream[index];
          index += 1;
        }
        value += String.fromCharCode(Number.parseInt(octal, 8));
      } else value += escape;
      continue;
    }
    if (character === '(') {
      depth += 1;
      value += character;
      index += 1;
      continue;
    }
    if (character === ')') {
      depth -= 1;
      index += 1;
      if (depth === 0) return { value, next: index };
      value += character;
      continue;
    }
    value += character;
    index += 1;
  }
  throw new Error('unterminated literal string in the content stream');
}

function readHexString(stream: string, start: number): { value: string; next: number } {
  const end = stream.indexOf('>', start);
  if (end === -1) throw new Error('unterminated hex string in the content stream');
  const digits = stream.slice(start + 1, end).replace(/[^0-9a-fA-F]/g, '');
  let value = '';
  for (let index = 0; index < digits.length; index += 2) {
    value += String.fromCharCode(Number.parseInt(digits.slice(index, index + 2).padEnd(2, '0'), 16));
  }
  return { value, next: end + 1 };
}

function parseContent(stream: string): ParsedContent {
  const lines: string[] = [];
  const operators: string[] = [];
  const paths: PathBlock[] = [];
  const points: Array<{ op: string; x: number; y: number }> = [];

  let operands: Array<string | number> = [];
  let construction: string[] = [];
  let blockPoints: Array<{ x: number; y: number }> = [];
  let currentLine = '';
  let index = 0;

  const flushLine = (): void => {
    const text = currentLine.trim();
    if (text !== '') lines.push(text);
    currentLine = '';
  };

  const paint = (operator: string): void => {
    if (construction.length === 0) return;
    paths.push({ construction, paint: operator, points: blockPoints });
    construction = [];
    blockPoints = [];
  };

  const operate = (operator: string): void => {
    operators.push(operator);
    if (LINE_OPERATORS.has(operator)) flushLine();
    if (operator === 'Tj') {
      const text = operands.find((operand): operand is string => typeof operand === 'string');
      if (text !== undefined) currentLine += text;
    } else if (operator === 'TJ') {
      for (const operand of operands) if (typeof operand === 'string') currentLine += operand;
    } else if (CONSTRUCTION_OPERATORS.has(operator)) {
      construction.push(operator);
      if (operator === 'm' || operator === 'l') {
        const x = Number(operands[0]);
        const y = Number(operands[1]);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          blockPoints.push({ x, y });
          points.push({ op: operator, x, y });
        }
      }
    } else if (PAINT_OPERATORS.has(operator)) {
      paint(operator);
    }
    operands = [];
  };

  while (index < stream.length) {
    const character = stream[index];
    if (character === '%') {
      while (index < stream.length && stream[index] !== '\n') index += 1;
      continue;
    }
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === '(') {
      const read = readLiteralString(stream, index);
      operands.push(decodeWinAnsi(read.value));
      index = read.next;
      continue;
    }
    if (character === '<' && stream[index + 1] !== '<') {
      const read = readHexString(stream, index);
      operands.push(decodeWinAnsi(read.value));
      index = read.next;
      continue;
    }
    if (character === '[') {
      index += 1;
      while (index < stream.length && stream[index] !== ']') {
        const next = stream[index];
        if (/\s/.test(next)) {
          index += 1;
          continue;
        }
        if (next === '(') {
          const read = readLiteralString(stream, index);
          operands.push(decodeWinAnsi(read.value));
          index = read.next;
          continue;
        }
        let token = '';
        while (index < stream.length && !/[\s\]]/.test(stream[index])) {
          token += stream[index];
          index += 1;
        }
        if (token !== '') operands.push(Number(token));
      }
      index += 1;
      continue;
    }
    if (character === '/') {
      let name = '/';
      index += 1;
      while (index < stream.length && !/[\s/<>[\](){}%]/.test(stream[index])) {
        name += stream[index];
        index += 1;
      }
      operands.push(name);
      continue;
    }
    let token = '';
    while (index < stream.length && !/[\s/<>[\](){}%]/.test(stream[index])) {
      token += stream[index];
      index += 1;
    }
    if (token === '') {
      index += 1;
      continue;
    }
    const numeric = Number(token);
    if (/^[+-]?(?:\d|\.\d)/.test(token) && Number.isFinite(numeric)) {
      operands.push(numeric);
      continue;
    }
    operate(token);
  }
  flushLine();
  return { lines, operators, paths, points };
}

// --- The whole document ---------------------------------------------------

interface ParsedPdf {
  raw: string;
  lines: string[];
  /** The lines joined with single spaces: a wrapped sentence still reads whole. */
  flow: string;
  operators: string[];
  paths: PathBlock[];
  points: Array<{ op: string; x: number; y: number }>;
  streams: string[];
  objects: number;
  startxref: number;
}

function readPdf(bytes: Uint8Array): ParsedPdf {
  const raw = latin1(bytes);
  const objects = [...raw.matchAll(/^(\d+) 0 obj\n([\s\S]*?)\nendobj$/gm)].map(match => match[2]);
  const streams: string[] = [];
  for (const body of objects) {
    const declared = /\/Length (\d+)/.exec(body);
    const marker = body.indexOf('stream\n');
    if (declared === null || marker === -1) continue;
    // Read the stream through its own declaration: a `/Length` that disagrees with
    // the bytes is exactly what makes a viewer truncate or reject the page.
    const start = marker + 'stream\n'.length;
    const length = Number(declared[1]);
    const stream = body.slice(start, start + length);
    if (stream.length !== length) throw new Error('the declared /Length does not match the stream');
    if (!body.startsWith('endstream', start + length)) throw new Error('the stream is not terminated by endstream');
    streams.push(stream);
  }
  const lines: string[] = [];
  const operators: string[] = [];
  const paths: PathBlock[] = [];
  const points: Array<{ op: string; x: number; y: number }> = [];
  for (const stream of streams) {
    const parsed = parseContent(stream);
    lines.push(...parsed.lines);
    operators.push(...parsed.operators);
    paths.push(...parsed.paths);
    points.push(...parsed.points);
  }
  const startxref = Number(/(?:^|\n)startxref\n(\d+)\n/.exec(raw)?.[1] ?? Number.NaN);
  return {
    raw,
    lines,
    flow: lines.join(' ').replace(/\s+/g, ' ').trim(),
    operators,
    paths,
    points,
    streams,
    objects: objects.length,
    startxref,
  };
}

// --- Fixtures -------------------------------------------------------------
//
// The batch is complete: the generator applies the same fail-closed guard the page
// does, so only a batch the card would present can carry a level into the ficha.

const EVALUATED_AT = '2026-11-25T12:00:00Z';
const CANONICAL_FACTORS = ['temperatura', 'humedad_relativa', 'viento', 'cobertura_vegetal', 'incendios_historicos'];

function completeBatch(overrides: Partial<RiskBatch> = {}): RiskBatch {
  return {
    zone_id: '05101',
    id: 'batch-pm14',
    job_id: 'job-pm14',
    demo: true,
    risk_level: 'alto',
    factors: [
      { name: 'temperatura', known: true, value: 31.2, contribution: 0.34, note: 'lectura de la estación' },
      { name: 'humedad_relativa', known: false, value: 0, contribution: 0, note: 'sensor sin dato' },
      { name: 'viento', known: true, value: 18, contribution: 0.12, note: 'rachas del sector' },
      { name: 'incendios_historicos', known: true, value: 6, contribution: 0.08, note: 'eventos registrados' },
    ],
    rationale: 'Regla académica de pesos fijos sobre las cinco variables de la regla.',
    policy: { policy_id: 'academic-rule-v1', params_hash: 'abc123', parameters: { weight: '0.2' } },
    notice: 'Entrada sintética',
    published_at: EVALUATED_AT,
    data_status: 'final',
    model_version: 'academic-rule-v1',
    ...overrides,
  };
}

// Two rings of five vertices: the outer boundary and its hole. A ring count the
// reader can count keeps the vector assertion exact.
const POLYGON: GeoGeometry = {
  type: 'Polygon',
  coordinates: [
    [
      [-71.65, -33.05],
      [-71.6, -33.05],
      [-71.6, -33.0],
      [-71.65, -33.0],
      [-71.65, -33.05],
    ],
    [
      [-71.64, -33.04],
      [-71.61, -33.04],
      [-71.61, -33.01],
      [-71.64, -33.01],
      [-71.64, -33.04],
    ],
  ],
};

interface PdfInput {
  zone: { code?: string; name?: string; province?: string } | null;
  batch: RiskBatch | null;
  geometry: GeoGeometry | null;
  syntheticSources?: readonly string[];
}

function input(overrides: Partial<PdfInput> = {}): PdfInput {
  return {
    zone: { code: '05101', name: 'Valparaíso', province: 'Valparaíso' },
    batch: completeBatch(),
    geometry: POLYGON,
    ...overrides,
  };
}

function ficha(overrides: Partial<PdfInput> = {}): ParsedPdf {
  return readPdf(generateZonePdf(input(overrides)));
}

function rowFor(pdf: ParsedPdf, factor: string): string {
  const row = pdf.lines.find(line => line.startsWith(`${factor}:`));
  if (row === undefined) throw new Error(`the ficha carries no row for ${factor}`);
  return row;
}

afterEach(() => {
  vi.useRealTimers();
});

// --- The file itself ------------------------------------------------------

test('emits a valid PDF 1.4 document whose cross-reference table points at its own objects', () => {
  const pdf = ficha();

  // The signature a viewer sniffs, and the end marker it requires.
  expect(pdf.raw.startsWith('%PDF-1.4')).toBe(true);
  expect(pdf.raw.endsWith('%%EOF\n')).toBe(true);

  // The cross-reference table: `startxref` must land on the `xref` keyword, and
  // every `n` entry must point at the object it claims.
  expect(Number.isInteger(pdf.startxref)).toBe(true);
  expect(pdf.raw.slice(pdf.startxref, pdf.startxref + 4)).toBe('xref');
  const table = pdf.raw.slice(pdf.startxref);
  const declaredSize = Number(/\/Size (\d+)/.exec(table)?.[1] ?? 0);
  expect(declaredSize).toBe(pdf.objects + 1);
  expect(table).toContain('/Root 1 0 R');

  const entries = [...table.matchAll(/^(\d{10}) (\d{5}) ([fn]) $/gm)];
  expect(entries).toHaveLength(pdf.objects + 1);
  expect(entries[0].slice(1)).toEqual(['0000000000', '65535', 'f']);
  for (let id = 1; id < entries.length; id += 1) {
    const [offset, , kind] = entries[id].slice(1);
    expect(kind).toBe('n');
    expect(pdf.raw.slice(Number(offset), Number(offset) + `${id} 0 obj`.length)).toBe(`${id} 0 obj`);
  }

  // Self-contained: the standard Type1 fonts and their WinAnsi encoding, with no
  // external file, no embedded font and no compressed stream the reader has to
  // decompress before the text can be extracted.
  expect(pdf.raw).toContain('/BaseFont /Helvetica /Encoding /WinAnsiEncoding');
  expect(pdf.raw).toContain('/BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding');
  expect(pdf.raw).toContain('/Encoding /WinAnsiEncoding');
  expect(pdf.raw).not.toContain('/Subtype /Image');
  expect(pdf.raw).not.toContain('/Filter');
  expect(pdf.streams.length).toBeGreaterThan(0);

  // Reproducibility forbids the two fields a PDF writer would otherwise fill with
  // the clock and with random bytes.
  expect(pdf.raw).not.toContain('/CreationDate');
  expect(pdf.raw).not.toContain('/ModDate');
  expect(pdf.raw).not.toMatch(/\/ID\s*\[/);
});

// --- Required content (PM-14) --------------------------------------------

test('states the zone, its commune identifier, the evaluation date and the rule that classified it', () => {
  const pdf = ficha();

  expect(pdf.flow).toContain('Ficha de riesgo por zona');
  expect(pdf.flow).toContain('Comuna: Valparaíso');
  expect(pdf.flow).toContain('CUT 05101');
  expect(pdf.flow).toContain('Provincia: Valparaíso');
  // The date is the batch's own publication instant, extracted as text.
  expect(pdf.flow).toContain(`Fecha de evaluación: ${EVALUATED_AT}`);
  // The active rule and model metadata travel with the document.
  expect(pdf.flow).toContain('Regla aplicada: academic-rule-v1');
  expect(pdf.flow).toContain('hash informado (no verificado): abc123');
  expect(pdf.flow).toContain('weight=0.2');
  expect(pdf.flow).toContain('Estado del dato: final');
  expect(pdf.flow).toContain('Versión del modelo: academic-rule-v1');
  // …and it says what the classification is not.
  expect(pdf.flow).toContain('regla propia no oficial');
  expect(pdf.flow).toContain('no ejecuta la regla ni pronostica un incendio');
});

test('keeps an unreadable batch unclassified, with the omission named instead of a plausible level', () => {
  const invalid = ficha({ batch: completeBatch({ policy: { policy_id: '', params_hash: '', parameters: {} } }) });
  expect(invalid.flow).toContain('Nivel de riesgo: SIN CLASIFICAR');
  expect(invalid.flow).toContain('no pasó la validación de la ficha');
  expect(invalid.flow).toContain('política');

  // «desconocido» is a fourth honest state, not a severity and not a synonym.
  const unknown = ficha({ batch: completeBatch({ risk_level: 'desconocido' }) });
  expect(unknown.flow).toContain('Nivel de riesgo: INFORMACIÓN INSUFICIENTE');
  expect(unknown.flow).toContain('valor informado por el lote: desconocido');

  // No batch at all is an absence, never a low risk.
  const absent = ficha({ batch: null });
  expect(absent.flow).toContain('Nivel de riesgo: SIN LOTE PUBLICADO');
  expect(absent.flow).toContain('no informa un lote publicado para esta zona');
});

test('draws the commune polygon as PDF path operators inside the framed map box', () => {
  const pdf = ficha();

  const ringBlocks = pdf.paths.filter(block => block.construction.includes('m'));
  expect(ringBlocks).toHaveLength(2);
  // The outer ring is filled and stroked, the hole is only stroked, so a hole is
  // never painted as if it were part of the commune.
  expect(ringBlocks.map(block => block.paint)).toEqual(['B', 'S']);
  for (const block of ringBlocks) {
    expect(block.construction.filter(operator => operator === 'm')).toHaveLength(1);
    expect(block.construction.filter(operator => operator === 'h')).toHaveLength(1);
    expect(block.points).toHaveLength(5);
  }

  // Two rings of five vertices: two `m`, eight `l`, two `h`.
  expect(pdf.points.filter(point => point.op === 'm')).toHaveLength(2);
  expect(pdf.points.filter(point => point.op === 'l')).toHaveLength(8);
  expect(pdf.operators.filter(operator => operator === 'h')).toHaveLength(2);
  expect(pdf.operators.filter(operator => operator === 'B')).toHaveLength(1);
  expect(pdf.operators.filter(operator => operator === 'S').length).toBeGreaterThan(1);

  // The frame itself is a rectangle path painted immediately before the rings, so
  // the geometry is visibly drawn inside a bordered box.
  const firstRing = pdf.paths.findIndex(block => block.construction.includes('m'));
  expect(firstRing).toBeGreaterThan(0);
  expect(pdf.paths[firstRing - 1].construction).toEqual(['re']);
  expect(pdf.paths[firstRing - 1].paint).toBe('S');

  // Every projected vertex stays inside the inner map box: 595 × 842 A4 with a
  // 48 pt margin and 12 pt of breathing room inside the frame.
  for (const point of pdf.points) {
    expect(point.x).toBeGreaterThanOrEqual(60);
    expect(point.x).toBeLessThanOrEqual(535);
    expect(point.y).toBeGreaterThan(0);
    expect(point.y).toBeLessThan(842);
  }

  // And the map says where the shape came from, how much of it there is, and what
  // it is not.
  expect(pdf.flow).toContain('Mapa de la comuna');
  expect(pdf.flow).toContain('servido por /v1/risk/zones');
  expect(pdf.flow).toContain('2 anillos');
  expect(pdf.flow).toContain('10 vértices');
  expect(pdf.flow).toContain('No es un mapa base ni una proyección cartográfica oficial');
});

test('names the absence of geometry instead of drawing a map it does not have', () => {
  const pdf = ficha({ geometry: null });

  // No path construction operator at all: there is no shape, and no invented one.
  expect(pdf.points).toHaveLength(0);
  expect(pdf.operators.filter(operator => operator === 'h')).toHaveLength(0);
  expect(pdf.flow).toContain('Geometría no disponible');
  expect(pdf.flow).toContain('no dibuja un mapa aproximado');
  expect(pdf.flow).not.toContain('anillos');
});

// --- R2 — «Cómo lo calculó la regla» -------------------------------------

test('states the rule arithmetic with all five canonical variables and never invents a reading (R2)', () => {
  const pdf = ficha();

  // The heading is the resolved `D-D` label, verbatim.
  expect(pdf.lines).toContain('Cómo lo calculó la regla');
  // The section states what its numbers are and are not.
  expect(pdf.flow).toContain('aritmética de la regla sobre el lote publicado');
  expect(pdf.flow).toContain('no es una causa del incendio ni un pronóstico');

  // All five canonical variables are named, in the rule's own order.
  for (const name of CANONICAL_FACTORS) {
    expect(pdf.lines.some(line => line.startsWith(`${name}:`)), `the ficha names ${name}`).toBe(true);
  }
  expect(pdf.lines.indexOf('temperatura: 31.2 · contribución 0.34 · lectura de la estación')).toBeLessThan(
    pdf.lines.findIndex(line => line.startsWith('cobertura_vegetal:')),
  );

  // A measured variable shows its value, its contribution and its note.
  expect(pdf.lines).toContain('temperatura: 31.2 · contribución 0.34 · lectura de la estación');
  expect(pdf.lines).toContain('viento: 18 · contribución 0.12 · rachas del sector');
  expect(pdf.lines).toContain('incendios_historicos: 6 · contribución 0.08 · eventos registrados');

  // A variable the batch declares unknown says so, and carries no number at all.
  expect(rowFor(pdf, 'humedad_relativa')).toBe('humedad_relativa: sin lectura · sensor sin dato');
  expect(rowFor(pdf, 'humedad_relativa')).not.toContain('contribución');
  expect(rowFor(pdf, 'humedad_relativa')).not.toMatch(/\d/);

  // A variable the batch does not carry at all is named, not hidden.
  expect(rowFor(pdf, 'cobertura_vegetal')).toBe('cobertura_vegetal: sin lectura · no informada en el lote');

  // The batch's own rationale is reproduced as the batch stated it.
  expect(pdf.flow).toContain('Justificación informada por el lote: Regla académica de pesos fijos');
});

test('keeps a factor outside the canonical five as an extra row instead of dropping its reading', () => {
  const pdf = ficha({
    batch: completeBatch({
      factors: [
        ...completeBatch().factors,
        { name: 'precipitacion', known: true, value: 0, contribution: 0, note: 'sin eventos en la ventana' },
      ],
    }),
  });

  expect(pdf.lines).toContain('precipitacion: 0 · contribución 0 · sin eventos en la ventana');
  // The canonical five keep their order and their place: the extra row follows.
  const temperature = pdf.lines.findIndex(line => line.startsWith('temperatura:'));
  const extra = pdf.lines.findIndex(line => line.startsWith('precipitacion:'));
  expect(extra).toBeGreaterThan(temperature);
});

test('keeps the five variables visible, all without a reading, when there is no batch at all', () => {
  const pdf = ficha({ batch: null, geometry: null });

  for (const name of CANONICAL_FACTORS) {
    expect(pdf.lines).toContain(`${name}: sin lectura · no informada en el lote`);
  }
  expect(pdf.flow).toContain('Sin lote publicado: no hay lecturas que mostrar');
  expect(pdf.flow).toContain('Justificación informada por el lote: no informada');
});

// --- PM-18 — preventive recommendations ----------------------------------

test('composes the preventive recommendations of the level and the measured factors, as advisory only (PM-18)', () => {
  const pdf = ficha();

  expect(pdf.lines).toContain('Recomendaciones preventivas');
  // Factor items first (ordered by contribution), then the level's base pair.
  for (const id of ['R-06', 'R-08', 'R-03', 'R-04']) {
    expect(pdf.flow, `the ficha carries ${id}`).toContain(id);
  }
  expect(pdf.flow).toContain('En días calurosos, evita herramientas y trabajos que generen chispas');
  expect(pdf.flow).toContain('Restringe fogatas, parrillas, quema de desechos');

  // The variables without a reading still reach the reader, as the page states them.
  expect(pdf.flow).toContain('Sin lectura: humedad_relativa, cobertura_vegetal.');
  // …and the limit of the suggestions is written, not implied.
  expect(pdf.flow).toContain('no crean acciones preventivas automáticamente');
  expect(pdf.flow).toContain('no son una alerta oficial');
  expect(pdf.flow).toContain('no es un hallazgo de esta zona');
});

test('derives no recommendation from a batch that does not exist', () => {
  const pdf = ficha({ batch: null });

  expect(pdf.flow).toContain('Sin lote publicado: la ficha no deriva recomendaciones');
  for (const id of ['R-01', 'R-02', 'R-03', 'R-04', 'R-06', 'R-08']) {
    expect(pdf.flow, `an absent batch composes no ${id}`).not.toContain(id);
  }
});

// --- R3 — synthetic disclosure -------------------------------------------

test('declares synthetic data in visible text, and only when the payload declares it (R3)', () => {
  // The demo batch the page marks is marked here in extracted text too.
  const demo = ficha();
  expect(demo.flow).toContain('Datos sintéticos');
  expect(demo.flow).toContain('Entorno sintético: no riesgo real observado.');
  expect(demo.flow).toContain('lote demo');

  // The loaded fixture source is the same disclosure: `synthetic_fixture` is named.
  const fixture = ficha({ batch: completeBatch({ demo: false }), syntheticSources: ['synthetic_fixture'] });
  expect(fixture.flow).toContain('Datos sintéticos');
  expect(fixture.flow).toContain('synthetic_fixture');

  // A batch that declares itself real carries no synthetic mark at all.
  const real = ficha({ batch: completeBatch({ demo: false }) });
  expect(real.flow).not.toContain('Datos sintéticos');
  expect(real.flow).not.toContain('synthetic_fixture');
  expect(real.flow).not.toContain('Entorno sintético');
  expect(real.flow).toContain('Origen del lote: lote publicado por el servicio');
});

// --- Determinism ----------------------------------------------------------

test('is reproducible for identical input: no clock read, no random identifier', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  const first = generateZonePdf(input());
  const firstText = readPdf(first).flow;

  // Two different instants produce the same document, byte for byte.
  vi.setSystemTime(new Date('2031-07-04T09:30:00Z'));
  const second = generateZonePdf(input());
  expect(second).toHaveLength(first.length);
  expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
  expect(readPdf(second).flow).toBe(firstText);

  // The same input built twice yields the same bytes as well.
  expect(Buffer.from(generateZonePdf(input())).equals(Buffer.from(generateZonePdf(input())))).toBe(true);
});

// --- The local file name -------------------------------------------------

test('names the file after the zone and never carries an unsafe character', () => {
  expect(zonePdfFilename('05101')).toBe('ficha-zona-05101.pdf');
  expect(zonePdfFilename('')).toBe('ficha-zona-zona.pdf');
  expect(zonePdfFilename('05/1 1')).toBe('ficha-zona-05_1_1.pdf');
  expect(zonePdfFilename('05/1 1')).toBe(zonePdfFilename('05/1 1'));
});
