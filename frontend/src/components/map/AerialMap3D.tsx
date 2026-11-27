// T12 — the interactive 3D aerial stage.
//
// S6 — «que el mapa sea interactivo como lo diseñamos, que resalte, competimos
// contra un mapa fotorealista tenemos que dar el pego». This component turns the
// flat schematic of `#overview` into the oblique aerial scene of the approved board
// (`design/firewatch-v1-vuelo/01-vista-aerea.html`) over the REAL geometry served by
// `/v1/risk/zones`.
//
// Two surfaces, one camera:
//   * a Canvas 2D scene paints the immersive part — the Pacific bathymetry, the
//     graticule, the luminous shoreline, the depth-sorted extruded prisms and their
//     hillshading;
//   * the SVG layer that already carried the accessible contract of `#map-svg`
//     keeps every served comuna as a `role="button"` path with its zone classes,
//     its `aria-pressed`, its Enter/Space activation and its `<title>`. The camera
//     projects BOTH surfaces from the same arithmetic, so the choropleth cannot
//     drift from the relief underneath it.
//
// Three honesty rules survive the upgrade:
//   1. a comuna is painted with a risk colour ONLY when the session read a
//      canonical level for it; an unread comuna is a dark topographic plate, never
//      a plausible severity and never a flat pale grey;
//   2. the relief, extrusion and hillshading are ILLUSTRATIVE — derived from the
//      real mean longitude/latitude of each polygon to read as a coast-to-Andes
//      ramp — and the stage states it in `#map-3d-attribution`. No DEM is served,
//      no sensor elevation is claimed;
//   3. the island frames stay detached insets, drawn with their own local camera
//      and NEVER positioned geographically against the continent.
//
// Everything is local: Canvas 2D and the served GeoJSON. No tiles, no CDN, no
// worker, no new dependency, so the page CSP (`'self'`) is untouched.
//
// jsdom has no 2D context and no layout: `getContext('2d')` may return null and every
// rectangle may be zero-sized. The scene is therefore strictly optional — the
// vector layer and the HUD are DOM — and nothing here throws when the canvas is
// unavailable.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { canonicalLevel, levelLabel } from '../../domain/risk-level';
import type { RiskLevel } from '../../types/api';
import {
  AERIAL_DEFAULT_BEARING,
  AERIAL_DEFAULT_PITCH,
  AERIAL_PITCH_MAX,
  AERIAL_RELIEF_LIFT,
  AERIAL_SELECTED_LIFT,
  AERIAL_SIMPLIFY_TOLERANCE,
  AERIAL_VIEW,
  AERIAL_ZOOM_MAX,
  AERIAL_ZOOM_MIN,
  DEFAULT_AERIAL_CAMERA,
  clampAerialPitch,
  clampAerialZoom,
  createAerialViewport,
  projectAerialPoint,
  projectAerialRings,
  scaleBarFor,
  simplifyRings,
  unprojectAerialPoint,
  wrapAerialBearing,
  type AerialCamera,
  type AerialViewport,
  type MapFrame,
  type Point,
  type ProjectedAerialPoint,
  type ProjectedZone,
} from './projection';
import { zoneShapeClasses } from './zone-classes';

// The catalogue lookup the panel hands down. Declared structurally so this module
// never imports the panel that renders it.
export interface AerialZoneLevels {
  levelFor(zone: string): RiskLevel | '';
}

export interface AerialMap3DProps {
  mainland: MapFrame | null;
  insets: readonly MapFrame[];
  selectedCode: string;
  zoneLevels: AerialZoneLevels;
  onSelect: (code: string) => void;
  emptyMessage: string;
  showEmpty: boolean;
}

const MAINLAND_SVG_LABEL = 'Comunas seleccionables: clic, Enter o Espacio';
const INSETS_LABEL = 'Territorios insulares representados en recuadros aparte, fuera de su posición geográfica';
const HUD_LABEL = 'Controles del mapa 3D';
const LAYERS_LABEL = 'Capas del mapa';
const ATTRIBUTION = 'Relieve 3D ilustrativo · Límites oficiales SUBDERE/IGM';
const ATTRIBUTION_NOTE = 'El relieve y el sombreado son ilustrativos: no son un DEM ni una medición del terreno.';
const INTERACTION_HINT =
  'Arrastra para mover el mapa; con Mayús, arrastra para girar. La rueda acerca cuando el mapa tiene el foco, y los botones del mapa funcionan siempre.';

const DEFAULT_LAYERS = { relieve: true, nombres: true, grilla: true } as const;
type LayerId = keyof typeof DEFAULT_LAYERS;
type ProjectionMode = '3d' | '2d';

const BEARING_STEP = 0.23;
const PITCH_STEP = 0.12;
const ZOOM_STEP = 1.2;
const FOCUS_ZOOM = 2.4;
const FOCUS_MS = 420;
// A pointer that travels less than this between press and release is a tap, not a
// drag: it selects the comuna under the finger, and it never captures the pointer.
const DRAG_THRESHOLD = 4;
// The window in which the `click` a browser dispatches after a pointer gesture is
// acknowledged as the SAME gesture instead of a second selection.
const CLICK_AFTER_GESTURE_MS = 320;
// The elements that own their own pointer (a control is not a map drag).
const STAGE_CONTROL_SELECTOR = '.map-3d-hud, .map-3d-layers, .map-3d-attribution, .map-3d-tooltip, .map-insets, .map-3d-beacon';

// The ocean the scene is built from. These are the stage's own art colours: the
// palette that carries MEANING (risk levels, ink, accent, boundaries) is read from
// `tokens.css`, so the legend and the map cannot disagree.
const OCEAN_DEEP = '#081520';
const OCEAN_MID = '#0f2433';
const OCEAN_SHELF = '#173848';
// The unread-comuna relief plate: dark topographic slate shading to olive on the
// higher ground. Distinct from every risk role on purpose.
const RELIEF_LOW = '#2c3f49';
const RELIEF_HIGH = '#46585b';

interface AerialPalette {
  levels: Record<RiskLevel, string>;
  neutral: string;
  accent: string;
  ink: string;
}

function readToken(name: string, fallback: string): string {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function readPalette(): AerialPalette {
  return {
    levels: {
      bajo: readToken('--level-low-fill', '#72b1a1'),
      medio: readToken('--level-medium-fill', '#d7b16a'),
      alto: readToken('--level-high-fill', '#d97962'),
      desconocido: readToken('--level-unknown-fill', '#c4cbd1'),
    },
    neutral: readToken('--level-neutral-fill', '#71879a'),
    accent: readToken('--accent', '#94dfda'),
    ink: readToken('--ink', '#f4f1eb'),
  };
}

// The roles are document-level tokens and the product ships one palette, so the
// resolved colours are read once instead of forcing a style recalculation on every
// animated frame.
let cachedPalette: AerialPalette | null = null;
function paletteColors(): AerialPalette {
  if (cachedPalette === null) cachedPalette = readPalette();
  return cachedPalette;
}

// ── Colour arithmetic ──────────────────────────────────────────────────────

function parseHex(value: string): [number, number, number] | null {
  const match = value.trim().match(/^#([0-9a-f]{6})$/i);
  if (match === null) return null;
  const digits = match[1];
  return [parseInt(digits.slice(0, 2), 16), parseInt(digits.slice(2, 4), 16), parseInt(digits.slice(4, 6), 16)];
}

function toHex(channels: readonly number[]): string {
  return `#${channels.map(channel => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0')).join('')}`;
}

function mixHex(from: string, to: string, amount: number): string {
  const start = parseHex(from);
  const end = parseHex(to);
  if (start === null || end === null) return from;
  const t = Math.max(0, Math.min(1, amount));
  return toHex(start.map((channel, index) => channel + (end[index] - channel) * t));
}

function lighten(hex: string, amount: number): string {
  return mixHex(hex, '#ffffff', amount);
}

function darken(hex: string, amount: number): string {
  return mixHex(hex, '#000000', amount);
}

function rgba(hex: string, alpha: number): string {
  const rgb = parseHex(hex);
  if (rgb === null) return `rgba(148, 223, 218, ${alpha})`;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

// ── The scene ──────────────────────────────────────────────────────────────

interface SceneCommune {
  shape: ProjectedZone;
  rings: Point[][];
  base: ProjectedAerialPoint[][];
  top: ProjectedAerialPoint[][];
  path: string;
  depth: number;
  lift: number;
  level: RiskLevel | '';
  selected: boolean;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
}

interface SimplifiedCommune {
  shape: ProjectedZone;
  rings: Point[][];
}

interface AerialScene {
  frame: MapFrame;
  camera: AerialCamera;
  view: AerialViewport;
  communes: SceneCommune[];
  layers: { relieve: boolean; grilla: boolean };
}

function ringBBox(rings: readonly (readonly ProjectedAerialPoint[])[]): SceneCommune['bbox'] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (const point of ring) {
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: 0, maxY: 0 };
}

// The camera-independent half of the scene: the decimated rings of every served
// comuna. Simplifying is a pass over the whole catalogue, so it is computed once
// per catalogue and never on a camera frame.
function simplifyCommunes(frame: MapFrame | null): SimplifiedCommune[] {
  if (frame === null) return [];
  return frame.shapes.map(shape => ({ shape, rings: simplifyRings(shape.rings, AERIAL_SIMPLIFY_TOLERANCE) }));
}

function buildScene(
  communes: readonly SimplifiedCommune[],
  camera: AerialCamera,
  selectedCode: string,
  levels: AerialZoneLevels,
  layers: { relieve: boolean },
  view: AerialViewport,
): SceneCommune[] {
  return communes.map(({ shape, rings }) => {
    const level = canonicalLevel(levels.levelFor(shape.code));
    const selected = shape.code !== '' && shape.code === selectedCode;
    const reliefLift = layers.relieve ? shape.relief * AERIAL_RELIEF_LIFT : 0;
    const lift = reliefLift + (selected ? AERIAL_SELECTED_LIFT : 0);
    const top = projectAerialRings(rings, lift, camera, view);
    const base = projectAerialRings(rings, 0, camera, view);
    const center = projectAerialPoint(shape.center, lift, camera, view);
    return {
      shape,
      rings,
      base: base.rings,
      top: top.rings,
      path: top.path,
      depth: center.depth,
      lift,
      level,
      selected,
      bbox: ringBBox(top.rings),
    };
  });
}

// The painter's order: far to near, with the selection and the hover always last so
// a lifted comuna is never buried under a nearer flat one.
function painterOrder(communes: readonly SceneCommune[], hoveredCode: string): SceneCommune[] {
  const isHovered = (commune: SceneCommune) => hoveredCode !== '' && commune.shape.code === hoveredCode;
  return [...communes].sort((first, second) => {
    if (first.selected !== second.selected) return first.selected ? 1 : -1;
    const firstHovered = isHovered(first);
    const secondHovered = isHovered(second);
    if (firstHovered !== secondHovered) return firstHovered ? 1 : -1;
    return first.depth - second.depth;
  });
}

// ── Canvas painting ────────────────────────────────────────────────────────

function traceRing(context: CanvasRenderingContext2D, ring: readonly ProjectedAerialPoint[], move: boolean): void {
  ring.forEach((point, index) => {
    if (index === 0 && move) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  });
  context.closePath();
}

function paintOcean(context: CanvasRenderingContext2D, width: number, height: number): void {
  const gradient = context.createLinearGradient(0, 0, width * 0.42, height);
  gradient.addColorStop(0, OCEAN_DEEP);
  gradient.addColorStop(0.55, OCEAN_MID);
  gradient.addColorStop(1, OCEAN_SHELF);
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);

  const shelf = context.createRadialGradient(width * 0.34, height * 0.46, width * 0.04, width * 0.34, height * 0.46, width * 0.72);
  shelf.addColorStop(0, 'rgba(23, 56, 72, 0.55)');
  shelf.addColorStop(1, 'rgba(8, 21, 32, 0)');
  context.fillStyle = shelf;
  context.fillRect(0, 0, width, height);
}

// Bathymetric rings: the frame's own extent projected a little below the sea plane.
// They follow the camera, so panning the map moves the seabed with it.
function paintBathymetry(context: CanvasRenderingContext2D, scene: AerialScene): void {
  const { frame, camera, view } = scene;
  context.save();
  context.lineWidth = 1;
  for (const [index, grow] of [0.14, 0.3, 0.5, 0.74].entries()) {
    const x0 = -frame.width * grow;
    const x1 = frame.width * (1 + grow);
    const y0 = -frame.height * grow;
    const y1 = frame.height * (1 + grow);
    const corners: Point[] = [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ];
    context.beginPath();
    corners.forEach((corner, cornerIndex) => {
      const point = projectAerialPoint(corner, -6 - grow * 12, camera, view);
      if (cornerIndex === 0) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
    });
    context.closePath();
    context.strokeStyle = rgba('#94dfda', 0.09 - index * 0.012);
    context.stroke();
  }
  context.restore();

  // A soft glint line where the shelf drops away from the northern coast.
  context.save();
  context.beginPath();
  const glint = [
    { x: frame.width * 0.02, y: frame.height * 0.1 },
    { x: frame.width * 0.42, y: frame.height * 0.02 },
    { x: frame.width * 0.96, y: frame.height * 0.16 },
  ];
  glint.forEach((point, index) => {
    const projected = projectAerialPoint(point, -4, camera, view);
    if (index === 0) context.moveTo(projected.x, projected.y);
    else context.lineTo(projected.x, projected.y);
  });
  context.strokeStyle = 'rgba(148, 223, 218, 0.16)';
  context.lineWidth = 1.4;
  context.stroke();
  context.restore();
}

// The graticule is a real graticule of the fitted frame: lines every eighth of the
// extent, so the reader can see the geometry turn with the bearing.
function paintGraticule(context: CanvasRenderingContext2D, scene: AerialScene): void {
  const { frame, camera, view } = scene;
  context.save();
  context.strokeStyle = 'rgba(148, 223, 218, 0.085)';
  context.lineWidth = 0.8;
  const steps = 8;
  for (let step = 1; step < steps; step += 1) {
    const ratio = step / steps;
    context.beginPath();
    let first = projectAerialPoint({ x: frame.width * ratio, y: -frame.height * 0.08 }, 0, camera, view);
    context.moveTo(first.x, first.y);
    let last = projectAerialPoint({ x: frame.width * ratio, y: frame.height * 1.08 }, 0, camera, view);
    context.lineTo(last.x, last.y);
    context.stroke();

    context.beginPath();
    first = projectAerialPoint({ x: -frame.width * 0.08, y: frame.height * ratio }, 0, camera, view);
    context.moveTo(first.x, first.y);
    last = projectAerialPoint({ x: frame.width * 1.08, y: frame.height * ratio }, 0, camera, view);
    context.lineTo(last.x, last.y);
    context.stroke();
  }
  context.restore();
}

// The luminous shoreline: one union silhouette filled once, so the glow wraps the
// outside of the landmass instead of every internal boundary.
function paintShoreline(context: CanvasRenderingContext2D, scene: AerialScene): void {
  context.save();
  context.shadowColor = rgba('#7de3d4', 0.6);
  context.shadowBlur = 26;
  context.fillStyle = '#0a1720';
  context.beginPath();
  for (const commune of scene.communes) {
    for (const ring of commune.base) {
      // The silhouette is blurred anyway: a stride keeps the glow cheap without
      // softening the coastline the vector layer draws crisply on top.
      if (ring.length < 5) {
        traceRing(context, ring, true);
        continue;
      }
      const coarse = ring.filter((_, index) => index % 2 === 0 || index === ring.length - 1);
      traceRing(context, coarse, true);
    }
  }
  context.fill();
  context.restore();
}

function communePlate(commune: SceneCommune, palette: AerialPalette): string {
  // `desconocido` is a PUBLISHED level meaning the information is insufficient; it
  // is never a severity, and the stage paints it with the same dark relief plate as
  // an unread comuna so no pale plate implies a reading that does not exist.
  if (commune.level === '' || commune.level === 'desconocido') {
    return mixHex(RELIEF_LOW, RELIEF_HIGH, Math.min(1, commune.shape.relief * 1.15));
  }
  return palette.levels[commune.level];
}

function paintCommune(context: CanvasRenderingContext2D, commune: SceneCommune, palette: AerialPalette, hovered: boolean): void {
  const plate = communePlate(commune, palette);

  // ── Walls: one pass for the shaded faces, one for the sun-facing ones. Drawing
  // every quad with its own fill would be hundreds of fills per frame, so the
  // lighting is grouped into two tone passes over the same edges.
  if (commune.lift > 0.5) {
    context.save();
    context.beginPath();
    for (let ringIndex = 0; ringIndex < commune.top.length; ringIndex += 1) {
      const ring = commune.top[ringIndex];
      const base = commune.base[ringIndex];
      if (!base) continue;
      for (let index = 0; index < ring.length - 1; index += 1) {
        const baseA = base[index];
        const baseB = base[index + 1];
        if (!baseA || !baseB) continue;
        context.moveTo(baseA.x, baseA.y);
        context.lineTo(baseB.x, baseB.y);
        context.lineTo(ring[index + 1].x, ring[index + 1].y);
        context.lineTo(ring[index].x, ring[index].y);
        context.closePath();
      }
    }
    context.fillStyle = darken(plate, 0.46);
    context.fill();

    // NW sun: an edge whose screen normal leans up-left is lit.
    context.beginPath();
    for (let ringIndex = 0; ringIndex < commune.top.length; ringIndex += 1) {
      const ring = commune.top[ringIndex];
      const base = commune.base[ringIndex];
      if (!base) continue;
      for (let index = 0; index < ring.length - 1; index += 1) {
        const topA = ring[index];
        const topB = ring[index + 1];
        const baseA = base[index];
        const baseB = base[index + 1];
        if (!baseA || !baseB) continue;
        const dx = topB.x - topA.x;
        const dy = topB.y - topA.y;
        const length = Math.hypot(dx, dy);
        if (length < 1e-6) continue;
        const normalX = -dy / length;
        const normalY = dx / length;
        const facing = normalX * -0.62 + normalY * -0.78;
        if (facing <= 0.15) continue;
        context.moveTo(baseA.x, baseA.y);
        context.lineTo(baseB.x, baseB.y);
        context.lineTo(topB.x, topB.y);
        context.lineTo(topA.x, topA.y);
        context.closePath();
      }
    }
    context.fillStyle = darken(plate, 0.24);
    context.fill();
    context.restore();
  }

  // ── Top face: a coast-to-andes hillshade, then the choropleth plate itself.
  const { minX, minY, maxX, maxY } = commune.bbox;
  context.save();
  if (maxX - minX > 0.5 && maxY - minY > 0.5) {
    const gradient = context.createLinearGradient(minX, minY, maxX, maxY);
    gradient.addColorStop(0, lighten(plate, 0.16 + commune.shape.relief * 0.14));
    gradient.addColorStop(0.52, plate);
    gradient.addColorStop(1, darken(plate, 0.26));
    context.fillStyle = gradient;
    if (commune.selected || hovered || commune.level !== '') {
      context.shadowColor = rgba(commune.selected || hovered ? palette.accent : plate, commune.selected ? 0.55 : hovered ? 0.32 : 0.2);
      context.shadowBlur = commune.selected ? 22 : hovered ? 12 : 6;
    }
    context.beginPath();
    for (const ring of commune.top) traceRing(context, ring, true);
    context.fill();
  }
  context.restore();

  // ── Rim light: a thin NW edge reads as the sun catching the ridge.
  context.save();
  context.lineJoin = 'round';
  context.strokeStyle = rgba('#ffffff', commune.selected ? 0.16 : 0.09);
  context.lineWidth = 0.9;
  context.beginPath();
  for (const ring of commune.top) traceRing(context, ring, true);
  context.stroke();

  if (commune.selected) {
    context.strokeStyle = palette.accent;
    context.lineWidth = 2.4;
    context.shadowColor = rgba(palette.accent, 0.85);
    context.shadowBlur = 16;
    context.beginPath();
    for (const ring of commune.top) traceRing(context, ring, true);
    context.stroke();
  } else if (hovered) {
    context.strokeStyle = lighten(plate, 0.5);
    context.lineWidth = 1.6;
    context.beginPath();
    for (const ring of commune.top) traceRing(context, ring, true);
    context.stroke();
  }
  context.restore();
}

// The ocean name is map lettering, not a data label: it turns with the bearing and
// never replaces a comuna label.
function paintOceanName(context: CanvasRenderingContext2D, scene: AerialScene, palette: AerialPalette): void {
  const { frame, camera, view } = scene;
  const anchor = projectAerialPoint({ x: frame.width * 0.02, y: frame.height * 0.58 }, 0, camera, view);
  context.save();
  context.translate(anchor.x, anchor.y);
  context.rotate(camera.bearing);
  context.fillStyle = rgba(palette.ink, 0.38);
  context.font = '600 12px system-ui, -apple-system, "Segoe UI", sans-serif';
  (context as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '3px';
  context.fillText('OCÉANO PACÍFICO', 0, 0);
  context.restore();
}

function paintAerialScene(context: CanvasRenderingContext2D, scene: AerialScene, hoveredCode: string): void {
  const palette = paletteColors();
  paintBathymetry(context, scene);
  if (scene.layers.grilla) paintGraticule(context, scene);
  paintShoreline(context, scene);
  for (const commune of scene.communes) {
    paintCommune(context, commune, palette, hoveredCode !== '' && commune.shape.code === hoveredCode);
  }
  paintOceanName(context, scene, palette);
}

// ── Camera helpers ─────────────────────────────────────────────────────────

function prefersReducedMotion(): boolean {
  // No `matchMedia` (jsdom, an old engine) means "do not animate": the fallback is
  // the instant transition the accessibility contract asks for, never a tween.
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return true;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

// What the finger pressed, when the release cannot be trusted to say it. Under W3C
// pointer capture the browser retargets `pointerup` AND the trailing `click` to the
// capturing element, so the element under the press is the only honest record of
// the comuna the reader aimed at. Only the mainland vector layer participates: the
// island insets are separate figures with their own camera and their own click.
function communeUnderPointer(target: EventTarget | null): string {
  if (!(target instanceof Element)) return '';
  const shape = target.closest('path.zone-shape[data-zone]');
  if (shape === null || shape.closest('#map-svg') === null) return '';
  return shape.getAttribute('data-zone') ?? '';
}

function canvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  try {
    return canvas.getContext('2d');
  } catch {
    return null;
  }
}

function bearingDegrees(bearing: number): number {
  return (bearing * 180) / Math.PI;
}

// One pointer gesture. `moved` is the only thing that decides whether the release
// is a selection (a tap) or a camera move (a drag), and `commune` is what the press
// landed on, recorded because a captured release no longer names it.
interface DragState {
  mode: 'pan' | 'orbit';
  pointerId: number;
  x: number;
  y: number;
  moved: boolean;
  captured: boolean;
  commune: string;
}

// ── The component ──────────────────────────────────────────────────────────

export function AerialMap3D({
  mainland,
  insets,
  selectedCode,
  zoneLevels,
  onSelect,
  emptyMessage,
  showEmpty,
}: AerialMap3DProps) {
  const [camera, setCamera] = useState<AerialCamera>(DEFAULT_AERIAL_CAMERA);
  const [layers, setLayers] = useState({ ...DEFAULT_LAYERS });
  const [hover, setHover] = useState<{ code: string; name: string; level: RiskLevel | '' } | null>(null);
  const [focusCode, setFocusCode] = useState('');
  const [dragging, setDragging] = useState<'pan' | 'orbit' | null>(null);
  const [cssScale, setCssScale] = useState(1);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });

  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const coordinatesRef = useRef<HTMLSpanElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const lastDragAtRef = useRef(-Infinity);
  const lastTapAtRef = useRef(-Infinity);
  const pendingCamera = useRef<((previous: AerialCamera) => AerialCamera) | null>(null);
  const frameRequest = useRef(0);
  const animationRequest = useRef(0);

  const mode: ProjectionMode = camera.pitch > 0.0001 ? '3d' : '2d';
  const view = useMemo(() => createAerialViewport(mainland, AERIAL_VIEW, camera.zoom), [mainland, camera.zoom]);
  const enabledLayers = useMemo(
    () =>
      (Object.keys(layers) as LayerId[])
        .filter(layer => layers[layer])
        .join(' '),
    [layers],
  );

  const hoveredCode = hover?.code ?? '';
  const simplifiedMainland = useMemo(() => simplifyCommunes(mainland), [mainland]);
  const simplifiedInsets = useMemo(
    () =>
      insets.flatMap(frame => {
        const shape = frame.shapes[0];
        return shape === undefined
          ? []
          : [{ frame, shape: { ...shape, rings: simplifyRings(shape.rings, AERIAL_SIMPLIFY_TOLERANCE * 0.35) } }];
      }),
    [insets],
  );
  const communes = useMemo(
    () => buildScene(simplifiedMainland, camera, selectedCode, zoneLevels, { relieve: layers.relieve }, view),
    [simplifiedMainland, camera, selectedCode, zoneLevels, layers.relieve, view],
  );
  const ordered = useMemo(() => painterOrder(communes, hoveredCode), [communes, hoveredCode]);
  const selectedCommune = communes.find(commune => commune.selected) ?? null;

  const scene = useMemo<AerialScene | null>(
    () => (mainland ? { frame: mainland, camera, view, communes: ordered, layers: { relieve: layers.relieve, grilla: layers.grilla } } : null),
    [mainland, camera, view, ordered, layers.relieve, layers.grilla],
  );

  // ── Camera mutations ────────────────────────────────────────────────────
  const scheduleCamera = useCallback((update: (previous: AerialCamera) => AerialCamera) => {
    pendingCamera.current = update;
    if (frameRequest.current !== 0) return;
    const run = () => {
      frameRequest.current = 0;
      const pending = pendingCamera.current;
      pendingCamera.current = null;
      if (pending !== null) setCamera(pending);
    };
    frameRequest.current = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : (run(), 0);
  }, []);

  const markCameraChanged = useCallback(() => setFocusCode(''), []);

  const zoomBy = useCallback(
    (step: number) => {
      markCameraChanged();
      setCamera(previous => ({ ...previous, zoom: clampAerialZoom(previous.zoom * step) }));
    },
    [markCameraChanged],
  );

  const orbitBy = useCallback(
    (delta: number) => {
      markCameraChanged();
      setCamera(previous => ({ ...previous, bearing: wrapAerialBearing(previous.bearing + delta) }));
    },
    [markCameraChanged],
  );

  const tiltTo = useCallback(
    (pitch: number) => {
      markCameraChanged();
      setCamera(previous => ({ ...previous, pitch: clampAerialPitch(pitch) }));
    },
    [markCameraChanged],
  );

  const centerRegion = useCallback(() => {
    markCameraChanged();
    setCamera(previous => ({ ...previous, bearing: AERIAL_DEFAULT_BEARING, zoom: 1, panX: 0, panY: 0 }));
  }, [markCameraChanged]);

  const animateTo = useCallback((target: AerialCamera) => {
    if (typeof window !== 'undefined' && animationRequest.current !== 0) {
      window.cancelAnimationFrame(animationRequest.current);
      animationRequest.current = 0;
    }
    if (prefersReducedMotion() || typeof window === 'undefined' || typeof requestAnimationFrame !== 'function') {
      setCamera(target);
      return;
    }
    const start = camera;
    const startedAt = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / FOCUS_MS);
      const eased = 1 - (1 - progress) ** 3;
      setCamera({
        bearing: start.bearing + (target.bearing - start.bearing) * eased,
        pitch: start.pitch + (target.pitch - start.pitch) * eased,
        zoom: start.zoom + (target.zoom - start.zoom) * eased,
        panX: start.panX + (target.panX - start.panX) * eased,
        panY: start.panY + (target.panY - start.panY) * eased,
      });
      if (progress < 1) animationRequest.current = requestAnimationFrame(step);
    };
    animationRequest.current = requestAnimationFrame(step);
  }, [camera]);

  const focusSelected = useCallback(() => {
    if (mainland === null || selectedCommune === null) return;
    const zoom = Math.max(camera.zoom, FOCUS_ZOOM);
    const focusedView = createAerialViewport(mainland, AERIAL_VIEW, zoom);
    const center = projectAerialPoint(
      selectedCommune.shape.center,
      selectedCommune.lift,
      { ...camera, panX: 0, panY: 0 },
      focusedView,
    );
    const panX = clamp(AERIAL_VIEW.width / 2 - center.x, -AERIAL_VIEW.width * 0.6, AERIAL_VIEW.width * 0.6);
    const panY = clamp(AERIAL_VIEW.height * 0.52 - center.y, -AERIAL_VIEW.height * 0.6, AERIAL_VIEW.height * 0.6);
    setFocusCode(selectedCommune.shape.code);
    animateTo({ ...camera, zoom, panX, panY });
  }, [animateTo, camera, mainland, selectedCommune]);

  // ── Measurement (CSS pixels → viewport units) ───────────────────────────
  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;
    const measure = () => {
      const rect = stage.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const next = Math.min(rect.width / AERIAL_VIEW.width, rect.height / AERIAL_VIEW.height);
      if (next > 0) setCssScale(next);
      // The measured box is STATE, not a ref: the canvas bitmap is sized from it, so
      // a container resize has to publish itself. A ref mutation would leave the
      // Canvas 2D scene stretched at the old bitmap size while the SVG (viewBox +
      // preserveAspectRatio) had already rescale — the two surfaces would drift
      // until the next interaction asked for a frame.
      setStageSize(previous =>
        previous.width === rect.width && previous.height === rect.height
          ? previous
          : { width: rect.width, height: rect.height },
      );
    };
    measure();
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure);
      observer.observe(stage);
    }
    window.addEventListener('resize', measure);
    return () => {
      if (observer !== null) observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [mainland]);

  // ── The canvas scene ────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || scene === null) return;
    // A zero-sized canvas (jsdom, a hidden panel) has nothing to paint: returning
    // before touching `getContext` keeps the unit environment silent as well as safe.
    let request = 0;
    const paint = () => {
      request = 0;
      const rect = canvas.getBoundingClientRect();
      // The observer's published measurement is the authority: the canvas is an
      // absolutely positioned inset of the stage, and reading the state here is what
      // makes a container resize repaint the scene instead of leaving a stale,
      // stretched bitmap under the freshly rescaled SVG. The element box remains the
      // fallback for an environment with neither layout nor a ResizeObserver.
      const width = stageSize.width > 0 ? stageSize.width : rect.width;
      const height = stageSize.height > 0 ? stageSize.height : rect.height;
      if (width <= 0 || height <= 0) return;
      const context = canvasContext(canvas);
      if (context === null) return;
      const ratio = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      // The ocean is full-bleed in DEVICE pixels, so a stage whose aspect ratio does
      // not match the virtual frame shows a continuous sea instead of flat bands.
      context.setTransform(1, 0, 0, 1, 0, 0);
      paintOcean(context, canvas.width, canvas.height);
      const scale = Math.min(width / AERIAL_VIEW.width, height / AERIAL_VIEW.height);
      if (!(scale > 0)) return;
      const offsetX = (width - AERIAL_VIEW.width * scale) / 2;
      const offsetY = (height - AERIAL_VIEW.height * scale) / 2;
      context.setTransform(ratio * scale, 0, 0, ratio * scale, ratio * offsetX, ratio * offsetY);
      paintAerialScene(context, scene, hoveredCode);
    };
    request = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(paint) : (paint(), 0);
    return () => {
      if (request !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(request);
    };
  }, [scene, hoveredCode, stageSize]);

  // ── Wheel zoom, only while the map owns focus ───────────────────────────
  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null || mainland === null) return;
    const onWheel = (event: WheelEvent) => {
      // Zooming on hover would trap the page scroll; the map zooms with the wheel
      // only once the reader is inside it (a focused shape or control), and the
      // zoom buttons work everywhere.
      if (!stage.contains(document.activeElement)) return;
      event.preventDefault();
      zoomBy(event.deltaY > 0 ? 1 / 1.12 : 1.12);
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [mainland, zoomBy]);

  useEffect(
    () => () => {
      if (frameRequest.current !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameRequest.current);
      if (animationRequest.current !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(animationRequest.current);
    },
    [],
  );

  // ── Pointer: drag to pan, Shift+drag to orbit, click to select ─────────
  const updateTooltip = useCallback(
    (clientX: number, clientY: number) => {
      const stage = stageRef.current;
      const tooltip = tooltipRef.current;
      if (stage === null || tooltip === null) return;
      const rect = stage.getBoundingClientRect();
      const width = rect.width > 0 ? rect.width : AERIAL_VIEW.width;
      const height = rect.height > 0 ? rect.height : AERIAL_VIEW.height;
      const scale = Math.min(width / AERIAL_VIEW.width, height / AERIAL_VIEW.height) || 1;
      const offsetX = (width - AERIAL_VIEW.width * scale) / 2;
      const offsetY = (height - AERIAL_VIEW.height * scale) / 2;
      const virtualX = (clientX - rect.left - offsetX) / scale;
      const virtualY = (clientY - rect.top - offsetY) / scale;
      const position = unprojectAerialPoint(virtualX, virtualY, camera, view, mainland);
      if (coordinatesRef.current !== null) {
        coordinatesRef.current.textContent =
          position === null ? 'Fuera de la región' : `${position.lat.toFixed(2)}° / ${position.lon.toFixed(2)}°`;
      }
      const left = clamp(clientX - rect.left + 14, 8, Math.max(8, width - 214));
      const top = clamp(clientY - rect.top + 12, 8, Math.max(8, height - 108));
      tooltip.style.transform = `translate(${left}px, ${top}px)`;
    },
    [camera, mainland, view],
  );

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as Element | null;
    if (target !== null && target.closest(STAGE_CONTROL_SELECTOR) !== null) return;
    // Any manual camera gesture ends the "focused on this comuna" state.
    setFocusCode('');
    // NOTHING is captured here. Under W3C pointer events `setPointerCapture` makes
    // the browser retarget the following `pointerup` AND its trailing `click` to
    // the capturing stage, so capturing on press swallowed every tap on a comuna
    // `<path>`. Capture is deferred to the first movement that actually turns the
    // gesture into a drag (see `onPointerMove`); until then the release stays on
    // the comuna, and the recorded target answers the tap either way.
    const gesture: 'pan' | 'orbit' = event.shiftKey ? 'orbit' : 'pan';
    dragRef.current = {
      mode: gesture,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      moved: false,
      captured: false,
      commune: communeUnderPointer(target),
    };
    setDragging(gesture);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    updateTooltip(event.clientX, event.clientY);
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.x;
    const deltaY = event.clientY - drag.y;
    if (!drag.moved) {
      if (Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD) return;
      drag.moved = true;
      // The travel has proven this is a drag, and a drag never resolves to a click
      // on the comuna. Capturing now keeps the pan alive when the pointer leaves
      // the stage mid-gesture without ever stealing a plain tap.
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.captured = true;
      } catch {
        // Pointer capture is an optimisation: a browser without it still drags.
      }
    }
    drag.x = event.clientX;
    drag.y = event.clientY;
    const ratio = cssScale > 0 ? cssScale : 1;
    if (drag.mode === 'orbit') {
      scheduleCamera(previous => ({ ...previous, bearing: wrapAerialBearing(previous.bearing + (deltaX / ratio) * 0.008) }));
      return;
    }
    scheduleCamera(previous => ({
      ...previous,
      panX: clamp(previous.panX + deltaX / ratio, -AERIAL_VIEW.width * 0.6, AERIAL_VIEW.width * 0.6),
      panY: clamp(previous.panY + deltaY / ratio, -AERIAL_VIEW.height * 0.6, AERIAL_VIEW.height * 0.6),
    }));
  };

  // A release that never became a drag is a tap, and a tap is a selection. Answering
  // it here is what keeps the map usable when the browser delivers the release (and
  // its click) to the stage instead of the comuna `<path>`: `selectFromShape` below
  // then treats that trailing click as the same gesture instead of a second select.
  const answerTap = useCallback(
    (code: string) => {
      if (code === '') return;
      lastTapAtRef.current = nowMs();
      onSelect(code);
    },
    [onSelect],
  );

  const endDrag = (event: React.PointerEvent<HTMLDivElement>, allowSelect: boolean) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(null);
    if (drag.moved) lastDragAtRef.current = nowMs();
    else if (allowSelect) answerTap(drag.commune);
    if (!drag.captured) return;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Releasing an already-released pointer is not an error worth surfacing.
    }
  };

  const selectFromShape = useCallback(
    (code: string) => {
      const now = nowMs();
      // A drag ends with a click on the shape it started over; the camera moved, the
      // selection did not. A tap already answered its own release, so the click the
      // browser dispatches right afterwards is that same gesture, not a second one.
      // A keyboard or assistive-technology click arrives with no pointer gesture
      // and is never swallowed.
      if (now - lastDragAtRef.current < CLICK_AFTER_GESTURE_MS) return;
      if (now - lastTapAtRef.current < CLICK_AFTER_GESTURE_MS) return;
      onSelect(code);
    },
    [onSelect],
  );

  const renderShape = (commune: SceneCommune, key: string) => {
    const selected = commune.selected;
    const hovered = hoveredCode !== '' && hoveredCode === commune.shape.code;
    const classes = zoneShapeClasses(commune.level, selected);
    if (hovered) classes.push('zone-hovered');
    return (
      <path
        key={key}
        className={classes.join(' ')}
        d={commune.path}
        data-zone={commune.shape.code}
        role="button"
        tabIndex={0}
        aria-label={commune.shape.label}
        aria-pressed={selected}
        onPointerEnter={event => {
          setHover({ code: commune.shape.code, name: commune.shape.name, level: commune.level });
          // Show the glass card at the pointer immediately, so it never flashes at
          // the stage origin before the first move of the pointer.
          updateTooltip(event.clientX, event.clientY);
        }}
        onPointerLeave={() => setHover(previous => (previous?.code === commune.shape.code ? null : previous))}
        onClick={() => selectFromShape(commune.shape.code)}
        onKeyDown={event => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          onSelect(commune.shape.code);
        }}
      >
        <title>{commune.shape.label}</title>
      </path>
    );
  };

  const insetFigures = simplifiedInsets.map(({ frame, shape }, frameIndex) => {
    const reliefLift = layers.relieve ? shape.relief * AERIAL_RELIEF_LIFT * 1.6 : 0;
    const insetView = createAerialViewport(frame, { width: frame.width, height: frame.height }, 1);
    const projected = projectAerialRings(shape.rings, reliefLift, camera, insetView);
    const level = canonicalLevel(zoneLevels.levelFor(shape.code));
    const selected = shape.code !== '' && shape.code === selectedCode;
    const classes = zoneShapeClasses(level, selected);
    return (
      <figure className="map-inset" key={`${shape.code}-${frameIndex}`}>
        <svg
          viewBox={frame.viewBox}
          preserveAspectRatio="xMidYMid meet"
          role="group"
          aria-label={shape.label}
        >
          <g className="zone-layer">
            <path
              className={classes.join(' ')}
              d={projected.path}
              data-zone={shape.code}
              role="button"
              tabIndex={0}
              aria-label={shape.label}
              aria-pressed={selected}
              onClick={() => onSelect(shape.code)}
              onKeyDown={event => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                onSelect(shape.code);
              }}
            >
              <title>{shape.label}</title>
            </path>
          </g>
        </svg>
        <figcaption>{shape.label}</figcaption>
      </figure>
    );
  });

  const scaleBar = scaleBarFor(mainland, view);
  const barWidth = scaleBar === null ? 0 : scaleBar.width * cssScale;
  const hoverStatus = hover === null ? '' : hover.level === '' ? 'Sin lote publicado' : levelLabel(hover.level);

  const hiddenAttribute: { hidden?: boolean } = mainland === null ? { hidden: true } : {};
  const labels = ordered.filter(
    commune =>
      layers.nombres &&
      (commune.selected ||
        commune.shape.code === hoveredCode ||
        (commune.bbox.maxX - commune.bbox.minX > 68 && commune.bbox.maxY - commune.bbox.minY > 18)),
  );

  return (
    <div
      className="map-3d"
      data-projection-mode={mode}
      data-camera-pitch={camera.pitch.toFixed(4)}
      data-camera-bearing={camera.bearing.toFixed(4)}
      data-camera-zoom={camera.zoom.toFixed(4)}
      data-camera-focus={focusCode === '' ? undefined : focusCode}
      data-layers={enabledLayers}
      data-dragging={dragging === null ? undefined : dragging}
    >
      <div
        className="map-3d-stage"
        ref={stageRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={event => endDrag(event, true)}
        onPointerCancel={event => endDrag(event, false)}
        onPointerLeave={event => endDrag(event, false)}
      >
        {mainland === null ? null : <canvas className="map-3d-canvas" ref={canvasRef} aria-hidden="true" />}

        <svg
          id="map-svg"
          className="map-svg map-3d-vector"
          role="group"
          aria-label={MAINLAND_SVG_LABEL}
          viewBox={`0 0 ${AERIAL_VIEW.width} ${AERIAL_VIEW.height}`}
          preserveAspectRatio={mainland === null ? undefined : 'xMidYMid meet'}
          aria-describedby={mainland === null ? undefined : 'map-3d-hint'}
          {...hiddenAttribute}
        >
          <title id="map-title">Mapa aéreo 3D de las comunas de la Región de Valparaíso</title>
          <desc id="map-desc">
            Cada comuna se dibuja con la geometría servida por /v1/risk/zones, proyectada por una cámara 3D que gira,
            inclina y acerca. El relieve y el sombreado son ilustrativos: no son un DEM ni una medición del terreno. Cada
            comuna con un lote publicado conserva su color según el último lote de esa zona; el relieve topográfico oscuro
            significa que esa comuna no tiene lote publicado.
          </desc>
          <g className="zone-layer">{ordered.map(commune => renderShape(commune, commune.shape.code))}</g>
          {mainland !== null && labels.length > 0 ? (
            <g className="map-3d-labels" data-layer="nombres" aria-hidden="true">
              {labels.map(commune => (
                <text
                  key={commune.shape.code}
                  className="map-3d-label"
                  x={(commune.bbox.minX + commune.bbox.maxX) / 2}
                  y={(commune.bbox.minY + commune.bbox.maxY) / 2}
                  textAnchor="middle"
                >
                  {commune.shape.name}
                </text>
              ))}
            </g>
          ) : null}
          {selectedCommune === null ? null : (
            <g className="map-3d-beacon" aria-hidden="true" data-zone={selectedCommune.shape.code}>
              <line
                x1={(selectedCommune.bbox.minX + selectedCommune.bbox.maxX) / 2}
                y1={(selectedCommune.bbox.minY + selectedCommune.bbox.maxY) / 2 - 6}
                x2={(selectedCommune.bbox.minX + selectedCommune.bbox.maxX) / 2}
                y2={(selectedCommune.bbox.minY + selectedCommune.bbox.maxY) / 2 - 34}
              />
              <circle
                cx={(selectedCommune.bbox.minX + selectedCommune.bbox.maxX) / 2}
                cy={(selectedCommune.bbox.minY + selectedCommune.bbox.maxY) / 2 - 38}
                r={4.2}
              />
            </g>
          )}
        </svg>

        {showEmpty ? (
          <p id="map-empty" className="map-empty" role="status" aria-live="polite">
            {emptyMessage}
          </p>
        ) : null}

        {mainland === null ? null : (
          <>
            <p className="map-3d-hint" id="map-3d-hint">
              {INTERACTION_HINT}
            </p>
            <div className="map-3d-hud" role="group" aria-label={HUD_LABEL}>
              <div className="map-3d-hud-row" role="group" aria-label="Perspectiva">
                <button type="button" aria-pressed={mode === '3d'} onClick={() => tiltTo(AERIAL_DEFAULT_PITCH)}>
                  Vista 3D
                </button>
                <button type="button" aria-pressed={mode === '2d'} onClick={() => tiltTo(0)}>
                  2D Cenital
                </button>
              </div>
              <div className="map-3d-hud-row" role="group" aria-label="Orientación e inclinación">
                <button type="button" aria-label="Girar a la izquierda" title="Girar a la izquierda" onClick={() => orbitBy(-BEARING_STEP)}>
                  ⟲
                </button>
                <button type="button" aria-label="Girar a la derecha" title="Girar a la derecha" onClick={() => orbitBy(BEARING_STEP)}>
                  ⟳
                </button>
                <button
                  type="button"
                  aria-label="Aumentar la inclinación"
                  title="Aumentar la inclinación"
                  onClick={() => tiltTo(Math.min(AERIAL_PITCH_MAX, camera.pitch + PITCH_STEP))}
                >
                  ⤒
                </button>
                <button
                  type="button"
                  aria-label="Reducir la inclinación"
                  title="Reducir la inclinación"
                  onClick={() => tiltTo(Math.max(0, camera.pitch - PITCH_STEP))}
                >
                  ⤓
                </button>
              </div>
              <div className="map-3d-hud-row" role="group" aria-label="Zoom y encuadre">
                <button type="button" aria-label="Acercar" title="Acercar" onClick={() => zoomBy(ZOOM_STEP)} disabled={camera.zoom >= AERIAL_ZOOM_MAX}>
                  +
                </button>
                <button type="button" aria-label="Alejar" title="Alejar" onClick={() => zoomBy(1 / ZOOM_STEP)} disabled={camera.zoom <= AERIAL_ZOOM_MIN}>
                  −
                </button>
                <button type="button" aria-label="Centrar región" title="Centrar región" onClick={centerRegion}>
                  Centrar
                </button>
              </div>
              <button type="button" className="map-3d-focus" onClick={focusSelected} disabled={selectedCommune === null}>
                Enfocar comuna
              </button>
              <div className="map-3d-hud-meta">
                <span
                  id="map-3d-compass"
                  className="map-3d-compass"
                  aria-hidden="true"
                  style={{ transform: `rotate(${bearingDegrees(camera.bearing)}deg)` }}
                >
                  <svg viewBox="0 0 24 24" focusable="false">
                    <path d="M12 2 15 12 12 10.4 9 12Z" fill="currentColor" />
                    <path d="M12 22 9 12 12 13.6 15 12Z" fill="currentColor" opacity="0.35" />
                  </svg>
                  <span className="map-3d-compass-n">N</span>
                </span>
                <span id="map-3d-scale" className="map-3d-scale" aria-hidden="true">
                  <span className="map-3d-scale-bar" style={{ width: `${Math.max(8, barWidth)}px` }} />
                  <span className="map-3d-scale-label">{scaleBar === null ? 'Escala no disponible' : `${scaleBar.km} km`}</span>
                </span>
              </div>
            </div>

            <div className="map-3d-layers" role="group" aria-label={LAYERS_LABEL}>
              {(Object.keys(layers) as LayerId[]).map(layer => (
                <button
                  key={layer}
                  type="button"
                  aria-pressed={layers[layer]}
                  onClick={() => setLayers(previous => ({ ...previous, [layer]: !previous[layer] }))}
                >
                  {layer === 'relieve' ? 'Relieve' : layer === 'nombres' ? 'Nombres' : 'Grilla'}
                </button>
              ))}
            </div>
          </>
        )}

        {simplifiedInsets.length === 0 ? null : (
          <aside className="map-insets" id="map-insets" aria-label={INSETS_LABEL}>
            {insetFigures}
          </aside>
        )}

        <div className="map-3d-tooltip" ref={tooltipRef} aria-hidden="true" hidden={hover === null}>
          <p className="map-3d-tooltip-name">{hover?.name}</p>
          <p className="map-3d-tooltip-meta">
            CUT {hover?.code} · {hoverStatus}
          </p>
          <p className="map-3d-tooltip-coords">
            <span ref={coordinatesRef}>—</span>
          </p>
        </div>
      </div>

      {mainland === null ? null : (
        <p className="map-3d-attribution" id="map-3d-attribution">
          <span className="map-3d-attribution-line">{ATTRIBUTION}</span>
          <span className="map-3d-attribution-note">{ATTRIBUTION_NOTE}</span>
        </p>
      )}
    </div>
  );
}
