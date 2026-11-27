// PM-14 — the per-zone ficha, written here as PDF 1.4 bytes.
//
// The page's CSP closes both `script-src` and `img-src` to `'self'`, so a
// CDN-loaded PDF library, a remote font and a fetched image are all unreachable.
// The document is therefore assembled from the file header up: standard Type1
// `Helvetica` and `Helvetica-Bold` with `/WinAnsiEncoding` (no embedded font, no
// external file), uncompressed content streams, and the commune map drawn with the
// page's own projection as PDF path operators instead of a raster image. That is
// what lets a viewer open the ficha natively and what lets the test compare the
// extracted text instead of the bytes.
//
// Four honesty rules shape the content:
//   1. every reading is the batch's own. A factor the batch does not carry, or
//      carries as unknown, is named as having no reading: it is never filled in,
//      never charged a contribution and never given a plausible zero;
//   2. the level travels through the same fail-closed `presentBatch` guard the
//      card uses, so a batch this page refuses to present is exported as
//      `SIN CLASIFICAR` with its omissions named, never as a severity;
//   3. the `R2` section is the rule's arithmetic, labelled with the resolved
//      `D-D` heading, and it says out loud that a contribution is not a cause and
//      not a forecast;
//   4. the `R3` disclosure is visible text — a banner in the document body — and it
//      appears only when the payload declares synthetic provenance: a `demo` batch
//      or a declared synthetic source such as `synthetic_fixture`.
//
// Reproducibility is a hard requirement: `generateZonePdf` is a pure function of
// its input. No clock read, no random or `/ID` bytes, no `/CreationDate`, no
// unordered iteration — the same input produces the same bytes and the same text.

import {
  countVertices,
  fitProjection,
  geometryBounds,
  projectedRings,
  projectionFromFit,
} from '../components/map/projection';
import type { GeoGeometry, RiskBatch } from '../types/api';
import { presentBatch, type BatchPresentation, type ValidFactor } from './batch';
import { isNonEmptyString } from './guards';
import { canonicalLevel, levelLabel } from './risk-level';
import {
  CANONICAL_FACTOR_ORDER,
  DIRECT_OBSERVATION,
  planRecommendations,
  SYNTHETIC_ENVIRONMENT_NOTICE,
  type RecommendationPlan,
} from './recommendations';

// A4 at 72 dpi. Integer bounds keep every projected coordinate reproducible.
const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const MAP_FRAME_HEIGHT = 232;
const MAP_FRAME_PADDING = 12;
const FOOTER_BASELINE = 34;

const CANONICAL_FACTORS = new Set<string>(CANONICAL_FACTOR_ORDER);
const NO_READING = 'sin lectura';
const NOT_INFORMED_BY_BATCH = 'no informada en el lote';

const RULE_ARITHMETIC_NOTE =
  'La contribución de cada variable es aritmética de la regla sobre el lote publicado: no es una causa del incendio ni un pronóstico.';

const CLASSIFICATION_SCOPE =
  'Clasificación calculada por una regla propia no oficial. La ficha reproduce las lecturas y contribuciones que el lote informa; no ejecuta la regla ni pronostica un incendio.';

const ADVISORY_NOTE =
  'Aviso: estas recomendaciones son orientativas y no crean acciones preventivas automáticamente. La ficha no envía notificaciones, no escribe datos y no pide nada a la API.';

const EMPTY_GEOMETRY_NOTE =
  'Geometría no disponible: el catálogo /v1/risk/zones no informó el polígono de esta comuna. La ficha no dibuja un mapa aproximado ni una ubicación inventada.';

const FILENAME_SEGMENT_LIMIT = 32;

/**
 * The zone the ficha describes, as the loaded `/v1/risk/zones` catalogue serves it.
 * Every member is optional because a feature the service serves without a name must
 * be labelled in place, never filled in from another field.
 */
export interface ZonePdfZone {
  code?: string;
  name?: string;
  province?: string;
}

/**
 * Everything the ficha may state, and nothing else. `batch` is the payload the card
 * already read; `geometry` is the same catalogue geometry the map draws; a synthetic
 * source is passed only when the caller actually loaded one.
 */
export interface ZonePdfInput {
  zone: ZonePdfZone | null;
  batch: RiskBatch | null;
  geometry: GeoGeometry | null;
  /** Declared sources the page loaded (PM-11's `synthetic_fixture`, for example). */
  syntheticSources?: readonly string[];
}

// ── WinAnsiEncoding ────────────────────────────────────────────────────────
//
// `/WinAnsiEncoding` addresses glyphs by byte. Latin-1 letters map to their own
// code point, and the punctuation the Spanish copy needs — « » — ° — lives in the
// CP1252 range 0x80–0x9F. A character that encoding cannot carry is written as `?`
// and declared, never silently dropped or faked with a lookalike.

const WIN_ANSI_EXTRA: Readonly<Record<string, number>> = {
  '\u20AC': 0x80,
  '\u201A': 0x82,
  '\u0192': 0x83,
  '\u201E': 0x84,
  '\u2026': 0x85,
  '\u2020': 0x86,
  '\u2021': 0x87,
  '\u02C6': 0x88,
  '\u2030': 0x89,
  '\u0160': 0x8a,
  '\u2039': 0x8b,
  '\u0152': 0x8c,
  '\u017d': 0x8e,
  '\u2018': 0x91,
  '\u2019': 0x92,
  '\u201C': 0x93,
  '\u201D': 0x94,
  '\u2022': 0x95,
  '\u2013': 0x96,
  '\u2014': 0x97,
  '\u02DC': 0x98,
  '\u2122': 0x99,
  '\u0161': 0x9a,
  '\u203A': 0x9b,
  '\u0153': 0x9c,
  '\u017e': 0x9e,
  '\u0178': 0x9f,
};

function winAnsiCode(character: string): number {
  const extra = WIN_ANSI_EXTRA[character];
  if (extra !== undefined) return extra;
  const code = character.codePointAt(0) ?? 0;
  if (code >= 0x20 && code <= 0x7e) return code;
  if (code >= 0xa0 && code <= 0xff) return code;
  // Newlines and tabs are layout, not glyphs; anything else is declared as absent.
  if (code === 0x09 || code === 0x0a || code === 0x0d) return 0x20;
  return 0x3f;
}

/** One char per WinAnsi byte, ready to be written inside a PDF string literal. */
function encodeWinAnsi(text: string): string {
  let encoded = '';
  for (const character of text) encoded += String.fromCharCode(winAnsiCode(character));
  return encoded;
}

function escapePdfString(value: string): string {
  let escaped = '';
  for (const character of value) {
    escaped += character === '\\' || character === '(' || character === ')' ? `\\${character}` : character;
  }
  return escaped;
}

// One char per byte: both the content streams and the cross-reference table are
// built as Latin-1 text, so a string length IS a byte offset.
function latin1Bytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 0xff;
  return bytes;
}

// ── Numbers and wrapping ───────────────────────────────────────────────────

/** Two decimals at most, never `-0`, so a coordinate is written the same way twice. */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value * 100) / 100;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/**
 * Deterministic greedy wrapping. Helvetica is proportional and no font metrics are
 * embedded, so the width is estimated from the point size; the estimate only ever
 * affects where a line breaks, never the text itself.
 */
function wrapLines(text: string, maxCharacters: number): string[] {
  const limit = Math.max(12, Math.floor(maxCharacters));
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter((word) => word !== '');
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of words) {
      const candidate = current === '' ? word : `${current} ${word}`;
      if (candidate.length <= limit) {
        current = candidate;
        continue;
      }
      if (current !== '') lines.push(current);
      if (word.length <= limit) {
        current = word;
        continue;
      }
      let rest = word;
      while (rest.length > limit) {
        lines.push(rest.slice(0, limit));
        rest = rest.slice(limit);
      }
      current = rest;
    }
    lines.push(current);
  }
  return lines.length === 0 ? [''] : lines;
}

function maxCharactersFor(size: number, indent: number): number {
  return (CONTENT_WIDTH - indent * 2) / (size * 0.52);
}

// ── The page flow ──────────────────────────────────────────────────────────
//
// Text and shape operators are accumulated per page; `cursor` is the top of the
// next line box, measured from the page's bottom edge. `path operators` are used
// only for the commune map: no other block constructs `m`/`l`, so the vector
// assertion in the suite can be exact.

function textOp(x: number, baseline: number, text: string, size: number, bold: boolean, gray: number): string {
  return [
    'BT',
    `/${bold ? 'F2' : 'F1'} ${formatNumber(size)} Tf`,
    `${formatNumber(gray)} g`,
    `1 0 0 1 ${formatNumber(x)} ${formatNumber(baseline)} Tm`,
    `(${escapePdfString(encodeWinAnsi(text))}) Tj`,
    'ET',
  ].join('\n');
}

interface TextOptions {
  size?: number;
  bold?: boolean;
  gray?: number;
  indent?: number;
  gap?: number;
}

class Sheet {
  private readonly pages: string[][] = [[]];
  private cursor = PAGE_HEIGHT - MARGIN;

  private current(): string[] {
    return this.pages[this.pages.length - 1];
  }

  private startPage(): void {
    this.pages.push([]);
    this.cursor = PAGE_HEIGHT - MARGIN;
  }

  /** One flowed paragraph. A page break mid-paragraph continues the same text. */
  block(text: string, options: TextOptions = {}): void {
    const size = options.size ?? 10;
    const indent = options.indent ?? 0;
    const lineHeight = size * 1.45;
    for (const line of wrapLines(text, maxCharactersFor(size, indent))) {
      if (this.cursor - lineHeight < MARGIN) this.startPage();
      this.current().push(textOp(MARGIN + indent, this.cursor - size, line, size, options.bold ?? false, options.gray ?? 0));
      this.cursor -= lineHeight;
    }
    this.cursor -= options.gap ?? 3;
  }

  heading(text: string, size = 12): void {
    if (this.cursor - (size * 1.45 + 22) < MARGIN) this.startPage();
    this.cursor -= 8;
    this.block(text, { size, bold: true, gap: 5 });
  }

  rule(): void {
    if (this.cursor - 14 < MARGIN) this.startPage();
    this.cursor -= 6;
    this.current().push(
      ['q', '0.72 G', '0.6 w', `${formatNumber(MARGIN)} ${formatNumber(this.cursor)} ${CONTENT_WIDTH} 0.6 re`, 'S', 'Q'].join('\n'),
    );
    this.cursor -= 8;
  }

  /** A boxed disclosure line: visible text on the page, not a metadata field. */
  banner(text: string): void {
    const size = 9.5;
    const pad = 7;
    const lineHeight = size * 1.45;
    const lines = wrapLines(text, maxCharactersFor(size, pad));
    const height = lines.length * lineHeight + pad * 2;
    if (this.cursor - height - 10 < MARGIN) this.startPage();
    this.cursor -= 8;
    const bottom = this.cursor - height;
    const box = `${formatNumber(MARGIN)} ${formatNumber(bottom)} ${CONTENT_WIDTH} ${formatNumber(height)} re`;
    this.current().push(['q', '0.93 g', box, 'f', '0.25 G', '0.8 w', box, 'S', 'Q'].join('\n'));
    let baseline = this.cursor - pad - size;
    for (const line of lines) {
      this.current().push(textOp(MARGIN + pad, baseline, line, size, false, 0.1));
      baseline -= lineHeight;
    }
    this.cursor = bottom - 10;
  }

  /**
   * The framed commune map. The selected commune's real ring(s) are projected with
   * the same schematic projection the page's map uses and emitted as path
   * operators: the outer ring is filled and stroked, a hole is only stroked, so a
   * hole is never painted as if it were part of the commune.
   */
  map(geometry: GeoGeometry | null): void {
    const frameBottomY = this.cursor - 6 - MAP_FRAME_HEIGHT;
    if (frameBottomY - 40 < MARGIN) this.startPage();
    this.cursor -= 6;
    const bottom = this.cursor - MAP_FRAME_HEIGHT;
    const box = `${formatNumber(MARGIN)} ${formatNumber(bottom)} ${CONTENT_WIDTH} ${formatNumber(MAP_FRAME_HEIGHT)} re`;
    const ops = this.current();
    ops.push(['q', '0.96 g', box, 'f', 'Q'].join('\n'));
    ops.push(['q', '0.25 G', '1 w', box, 'S', 'Q'].join('\n'));

    const innerWidth = CONTENT_WIDTH - MAP_FRAME_PADDING * 2;
    const innerHeight = MAP_FRAME_HEIGHT - MAP_FRAME_PADDING * 2;
    const bounds = geometryBounds(geometry);
    const rings =
      geometry === null || bounds === null
        ? []
        : projectedRings(geometry, projectionFromFit(fitProjection(bounds, { width: innerWidth, height: innerHeight }, 0)));

    if (rings.length > 0) {
      const path: string[] = ['q', '0.16 g', '0.1 G', '0.9 w'];
      rings.forEach((ring, ringIndex) => {
        ring.forEach((point, pointIndex) => {
          const x = MARGIN + MAP_FRAME_PADDING + point.x;
          const y = bottom + MAP_FRAME_PADDING + (innerHeight - point.y);
          path.push(`${formatNumber(x)} ${formatNumber(y)} ${pointIndex === 0 ? 'm' : 'l'}`);
        });
        path.push('h');
        path.push(ringIndex === 0 ? 'B' : 'S');
      });
      path.push('Q');
      ops.push(path.join('\n'));
    }

    this.cursor = bottom - 12;
    if (rings.length === 0) {
      this.block(EMPTY_GEOMETRY_NOTE, { size: 9, gray: 0.25, gap: 4 });
      return;
    }
    const ringCount = rings.length === 1 ? '1 anillo' : `${rings.length} anillos`;
    this.block(
      `Trazado vectorial del polígono servido por /v1/risk/zones: ${ringCount} y ${countVertices(geometry)} vértices, proyectado con la misma proyección esquemática del mapa de la página. No es un mapa base ni una proyección cartográfica oficial.`,
      { size: 9, gray: 0.25, gap: 4 },
    );
  }

  /** Page footers are appended once every page is known, so «de N» is never a guess. */
  finish(): string[][] {
    const total = this.pages.length;
    this.pages.forEach((ops, index) => {
      const y = FOOTER_BASELINE;
      ops.push(
        ['q', '0.72 G', '0.6 w', `${formatNumber(MARGIN)} ${formatNumber(y + 14)} ${CONTENT_WIDTH} 0.6 re`, 'S', 'Q'].join('\n'),
      );
      ops.push(textOp(MARGIN, y, 'Documento generado localmente por la ficha de FireWatch (PM-14); sin dependencias externas ni contenido remoto.', 8, false, 0.35));
      ops.push(textOp(MARGIN, y - 12, `Página ${index + 1} de ${total}`, 8, false, 0.35));
    });
    return this.pages;
  }
}

// ── The document ───────────────────────────────────────────────────────────

interface PdfObject {
  id: number;
  body: string;
}

function buildDocument(pages: readonly string[][]): Uint8Array {
  const pageObjectId = (index: number): number => 5 + index * 2;
  const contentObjectId = (index: number): number => pageObjectId(index) + 1;

  const objects: PdfObject[] = [
    { id: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    {
      id: 2,
      body: `<< /Type /Pages /Kids [${pages.map((_, index) => `${pageObjectId(index)} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    },
    { id: 3, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>' },
    { id: 4, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>' },
  ];

  pages.forEach((ops, index) => {
    objects.push({
      id: pageObjectId(index),
      body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObjectId(index)} 0 R >>`,
    });
    // Uncompressed on purpose: `/Filter` would hide the text from a native reader.
    const content = `${ops.join('\n')}\n`;
    objects.push({ id: contentObjectId(index), body: `<< /Length ${content.length} >>\nstream\n${content}endstream` });
  });

  const chunks: string[] = ['%PDF-1.4\n'];
  let size = chunks[0].length;
  const offsets = new Map<number, number>();
  for (const object of objects) {
    offsets.set(object.id, size);
    const text = `${object.id} 0 obj\n${object.body}\nendobj\n`;
    chunks.push(text);
    size += text.length;
  }

  const xrefOffset = size;
  const total = objects.length;
  const entries = ['0000000000 65535 f '];
  for (let id = 1; id <= total; id += 1) {
    const offset = offsets.get(id);
    if (offset === undefined) throw new Error(`the ficha has no object ${id}`);
    entries.push(`${String(offset).padStart(10, '0')} 00000 n `);
  }
  chunks.push(`xref\n0 ${total + 1}\n${entries.join('\n')}\n`);
  chunks.push(`trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return latin1Bytes(chunks.join(''));
}

// ── Input resolution ───────────────────────────────────────────────────────

interface NormalisedZone {
  code: string;
  name: string;
  province: string;
}

function cleanText(value: unknown): string {
  return isNonEmptyString(value) ? value.trim() : '';
}

function normaliseZone(zone: ZonePdfZone | null): NormalisedZone {
  return {
    code: cleanText(zone?.code),
    name: cleanText(zone?.name),
    province: cleanText(zone?.province),
  };
}

function zoneLine(zone: NormalisedZone): string {
  return [
    `Comuna: ${zone.name === '' ? 'no informada' : zone.name}`,
    zone.code === '' ? 'CUT no informado' : `CUT ${zone.code}`,
    `Provincia: ${zone.province === '' ? 'no informada' : zone.province}`,
  ].join(' · ');
}

// The batch's own publication instant is the evaluation date. `Date.now()` is never
// consulted: the ficha must be reproducible for the same input.
function evaluationTimestamp(batch: RiskBatch | null): string {
  if (batch !== null) {
    for (const candidate of [batch.published_at, batch.evaluated_at, batch.requested_at]) {
      const value = cleanText(candidate);
      if (value !== '') return value;
    }
  }
  return 'sin fecha informada';
}

function originLine(batch: RiskBatch | null): string {
  if (batch === null) return 'no informado';
  return batch.demo === true ? 'Sintético · Synthetic' : 'lote publicado por el servicio';
}

function policyLine(batch: RiskBatch | null, presentation: BatchPresentation | null): string {
  if (batch === null) return 'sin lote publicado';
  if (presentation === null || !presentation.policyValid) return 'no informada o inválida en el lote';
  const policy = batch.policy;
  const parameters = Object.entries(policy.parameters ?? {})
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('; ');
  const hash = `hash informado (no verificado): ${policy.params_hash}`;
  return parameters === '' ? `${policy.policy_id} · ${hash}` : `${policy.policy_id} · ${hash} · ${parameters}`;
}

function riskLine(level: string, presentation: BatchPresentation | null, batch: RiskBatch | null): string {
  if (batch === null) {
    return 'Nivel de riesgo: SIN LOTE PUBLICADO · la API no informa un lote publicado para esta zona.';
  }
  if (presentation === null || !presentation.valid) {
    const omissions = presentation === null ? 'lote' : presentation.omissions.join(', ');
    return `Nivel de riesgo: SIN CLASIFICAR · el lote no pasó la validación de la ficha (omisiones: ${omissions}).`;
  }
  return `Nivel de riesgo: ${levelLabel(level)} · valor informado por el lote: ${level}`;
}

function rationaleLine(batch: RiskBatch | null): string {
  const rationale = batch === null ? '' : cleanText(batch.rationale);
  return `Justificación informada por el lote: ${rationale === '' ? 'no informada' : rationale}`;
}

// A declared source counts as synthetic only when it says so: `synthetic_fixture`
// is PM-11's literal, and a source that names neither `synthetic` nor `fixture` is
// not silently relabelled.
function declaredSyntheticSources(sources: readonly string[] | undefined): string[] {
  const declared: string[] = [];
  for (const source of sources ?? []) {
    const value = cleanText(source);
    if (value === '') continue;
    const normalised = value.toLowerCase();
    if (!normalised.includes('synthetic') && !normalised.includes('fixture')) continue;
    if (!declared.includes(value)) declared.push(value);
  }
  return declared;
}

function disclosureText(batch: RiskBatch | null, sources: readonly string[]): string {
  const parts = ['Datos sintéticos'];
  if (batch !== null && batch.demo === true) parts.push('lote demo: true');
  if (sources.length > 0) parts.push(`origen declarado: ${sources.join(', ')}`);
  parts.push(SYNTHETIC_ENVIRONMENT_NOTICE);
  return parts.join(' · ');
}

// ── R2 — the rule's arithmetic ─────────────────────────────────────────────

function factorRow(name: string, factor: ValidFactor | undefined): string {
  const note = factor === undefined ? '' : cleanText(factor.note);
  const suffix = note === '' ? '' : ` · ${note}`;
  if (factor === undefined) return `${name}: ${NO_READING} · ${NOT_INFORMED_BY_BATCH}`;
  // A factor the batch declares unknown has no reading: it is named, never charged.
  if (factor.known !== true) return `${name}: ${NO_READING}${suffix}`;
  return `${name}: ${formatNumber(factor.value)} · contribución ${formatNumber(factor.contribution)}${suffix}`;
}

function factorRows(batch: RiskBatch | null): string[] {
  const presented = batch === null ? [] : presentBatch(batch).factors;
  const canonical = new Map<string, ValidFactor>();
  const extras: ValidFactor[] = [];
  for (const factor of presented) {
    if (CANONICAL_FACTORS.has(factor.name) && !canonical.has(factor.name)) {
      canonical.set(factor.name, factor);
      continue;
    }
    extras.push(factor);
  }
  const rows = CANONICAL_FACTOR_ORDER.map((name) => factorRow(name, canonical.get(name)));
  // A reading outside the canonical five is preserved after them, never dropped.
  return [...rows, ...extras.map((factor) => factorRow(factor.name, factor))];
}

// ── PM-18 — preventive recommendations ─────────────────────────────────────

function recommendationStatus(plan: RecommendationPlan): string {
  return plan.level === '' || plan.level === 'desconocido'
    ? 'Sin nivel clasificado, la ficha no ordena sugerencias por aporte de variables.'
    : `Sugerencias compuestas desde el nivel informado (${plan.levelLabel}) y desde los factores con lectura del lote.`;
}

function writeRecommendations(sheet: Sheet, batch: RiskBatch | null, presentation: BatchPresentation | null): void {
  if (batch === null) {
    sheet.block(
      'Sin lote publicado: la ficha no deriva recomendaciones ni crea acciones. El catálogo se compone del nivel y de los factores que un lote publicado informa.',
      { size: 10, gap: 2 },
    );
    return;
  }
  // The same composition the card uses, from the same payload and the same
  // fail-closed level, so the PDF and the page can never disagree.
  const plan = planRecommendations({
    risk_level: presentation !== null && presentation.valid ? batch.risk_level : null,
    factors: batch.factors,
    demo: batch.demo,
  });
  sheet.block(recommendationStatus(plan), { size: 10, gap: 2 });
  for (const notice of plan.notices) sheet.block(notice.text, { size: 9, gray: 0.28, gap: 1 });
  for (const item of plan.items) {
    sheet.block(`${item.id} (${item.source}) · ${item.text}`, { size: 10, gap: 1 });
  }
  sheet.block(
    `Ítem de observación directa, que no es un hallazgo de esta zona: ${DIRECT_OBSERVATION.id} · ${DIRECT_OBSERVATION.text}`,
    { size: 9, gray: 0.28, gap: 2 },
  );
  sheet.block(ADVISORY_NOTE, { size: 9, gap: 3 });
}

// ── The generator ──────────────────────────────────────────────────────────

/**
 * The per-zone ficha as PDF 1.4 bytes. Pure: every value it writes comes from
 * `input`, so identical input yields identical bytes and identical extracted text.
 */
export function generateZonePdf(input: ZonePdfInput): Uint8Array {
  const zone = normaliseZone(input.zone ?? null);
  const batch = input.batch ?? null;
  const presentation = batch === null ? null : presentBatch(batch);
  const validated = presentation !== null && presentation.valid;
  const level = batch !== null && validated ? canonicalLevel(batch.risk_level) : '';
  const sources = declaredSyntheticSources(input.syntheticSources);
  const synthetic = (batch !== null && batch.demo === true) || sources.length > 0;

  const sheet = new Sheet();
  sheet.block('Ficha de riesgo por zona', { size: 17, bold: true, gap: 6 });
  sheet.block(zoneLine(zone), { size: 11, bold: true, gap: 4 });

  // R3 — the synthetic mark is a visible body line, before any claim it qualifies.
  if (synthetic) sheet.banner(disclosureText(batch, sources));

  sheet.block(`Fecha de evaluación: ${evaluationTimestamp(batch)}`, { size: 10, gap: 2 });
  sheet.block(`Origen del lote: ${originLine(batch)}`, { size: 10, gap: 2 });
  sheet.block(`Estado del dato: ${batch === null ? 'no informado' : cleanText(batch.data_status) || 'no informado'}`, {
    size: 10,
    gap: 2,
  });
  sheet.block(`Versión del modelo: ${batch === null ? 'no informada' : cleanText(batch.model_version) || 'no informada'}`, {
    size: 10,
    gap: 2,
  });
  sheet.block(`Regla aplicada: ${policyLine(batch, presentation)}`, { size: 10, gap: 4 });
  sheet.block(CLASSIFICATION_SCOPE, { size: 9, gray: 0.28, gap: 2 });
  sheet.rule();

  sheet.heading('Clasificación de riesgo');
  sheet.block(riskLine(level, presentation, batch), { size: 11, bold: true, gap: 4 });

  sheet.heading('Mapa de la comuna');
  sheet.map(input.geometry ?? null);

  // R2 — the resolved `D-D` heading, verbatim.
  sheet.heading('Cómo lo calculó la regla');
  sheet.block(RULE_ARITHMETIC_NOTE, { size: 9, gray: 0.28, gap: 3 });
  if (batch === null) {
    sheet.block(
      'Sin lote publicado: no hay lecturas que mostrar y las cinco variables de la regla quedan sin lectura.',
      { size: 10, gap: 3 },
    );
  }
  for (const row of factorRows(batch)) sheet.block(row, { size: 10, gap: 1 });
  sheet.block(rationaleLine(batch), { size: 10, gap: 4 });

  sheet.heading('Recomendaciones preventivas');
  writeRecommendations(sheet, batch, presentation);

  return buildDocument(sheet.finish());
}

/**
 * The local file name. It declares the selected zone and stays inside the small
 * alphabet a `download` attribute may carry, so no separator, quote or control byte
 * can reach the browser's save path. No clock is consulted: the same zone always
 * produces the same name.
 */
export function zonePdfFilename(zoneCode: string): string {
  let segment = '';
  for (const character of zoneCode) {
    segment += /[A-Za-z0-9_-]/.test(character) ? character : '_';
    if (segment.length >= FILENAME_SEGMENT_LIMIT) break;
  }
  return `ficha-zona-${segment === '' ? 'zona' : segment}.pdf`;
}
