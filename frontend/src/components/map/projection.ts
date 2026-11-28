// Schematic geospatial projection for the territorial map.
//
// This is NOT a cartographic projection and NOT a basemap. It is a plain
// equirectangular (plate carree) mapping with a cosine correction at the mean
// latitude of the fitted extent, which keeps the communes from looking
// stretched east-west at Valparaiso's latitude. A tile basemap or a vendored
// mapping library cannot be used: the page CSP closes both `connect-src` and
// `img-src`, so no tile provider is reachable and no external asset may load.
// The requirement is to render the ANALYSED ZONES ourselves — the geography we
// are given, not a base map.
//
// Two communes of the region are oceanic archipelagos far outside the mainland
// coastline. Drawing them in the mainland frame would compress the continental
// communes into a sliver, so they are rendered as EXTERIOR INSETS, each with its
// own local projection and its own scale, and the view states plainly that they
// are NOT geographically positioned. Membership is derived from the geometry
// ALONE: a feature whose bounds lie west of the detached-longitude guard is
// insular, so a newly added island commune becomes an inset automatically and
// there is no separate list to keep in sync.
//
// Framework-free and DOM-free by design: the caller decides how to attach the
// produced path data to an SVG element.

import type { GeoGeometry, ZoneCollection, ZoneFeature, ZoneProperties } from '../../types/api';

// Mainland Valparaiso spans lon [-71.9, -70.1]; the archipelagos lie far west.
// This longitude is the SINGLE criterion for "detached", never a zone list.
export const DETACHED_LONGITUDE = -75;

export interface MapView {
  width: number;
  height: number;
  padding: number;
}

export const MAINLAND_VIEW: MapView = { width: 760, height: 420, padding: 14 };
export const INSET_VIEW: MapView = { width: 168, height: 132, padding: 10 };

export interface Bounds {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export interface ViewSize {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Projection {
  readonly latMean: number;
  readonly cosLat: number;
  readonly scale: number;
  project(lon: number, lat: number): Point;
}

export interface ZoneEntry {
  feature: ZoneFeature;
  bounds: Bounds;
}

export interface ProjectedZone {
  code: string;
  name: string;
  province: string;
  label: string;
  path: string;
  /** Every ring of the geometry, projected into the frame's local coordinates. */
  rings: Point[][];
  /** Local bounding-box centre, used for depth sorting, labels and the beacon. */
  center: Point;
  /** Mean real position of the geometry; the illustrative relief is derived from it. */
  lonLat: { lon: number; lat: number };
  /**
   * 0..1 ILLUSTRATIVE elevation index derived from the real mean longitude and
   * latitude of the served geometry. It is a rendering hint, not a calibrated
   * elevation: this repository serves no DEM, and every surface that paints it
   * labels it as illustrative.
   */
  relief: number;
}

/** The fitted projection of a frame, kept so a consumer can invert a local point. */
export interface ProjectionFit {
  latMean: number;
  cosLat: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  minLon: number;
  maxLat: number;
}

export interface MapFrame {
  /** `0 0 width height`, ready to hand to an SVG `viewBox`. */
  viewBox: string;
  width: number;
  height: number;
  shapes: ProjectedZone[];
  /** The real extent the frame was fitted to, or `null` for an empty frame. */
  bounds: Bounds | null;
  /** The fitted projection, or `null` when there was no extent to fit. */
  fit: ProjectionFit | null;
}

export interface MapLayout {
  /** The continental frame, or `null` when only islands are drawable. */
  mainland: MapFrame | null;
  /** One frame per detached territory, each with its own local projection. */
  insets: MapFrame[];
  totalFeatures: number;
  mainlandCount: number;
  insetCount: number;
}

// Walks any nesting of coordinate arrays and reports every [lon, lat] position.
// It stops at a position node so a coordinate pair is never descended into.
function visitPositions(node: unknown, onPosition: (lon: number, lat: number) => void): void {
  if (!Array.isArray(node)) return;
  const first = node[0];
  const second = node[1];
  if (typeof first === 'number' && typeof second === 'number') {
    onPosition(first, second);
    return;
  }
  for (const child of node) visitPositions(child, onPosition);
}

export function geometryBounds(geometry: GeoGeometry | null | undefined): Bounds | null {
  if (!geometry || !Array.isArray(geometry.coordinates)) return null;
  const bounds: Bounds = { minLon: Infinity, minLat: Infinity, maxLon: -Infinity, maxLat: -Infinity };
  visitPositions(geometry.coordinates, (lon, lat) => {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    if (lon < bounds.minLon) bounds.minLon = lon;
    if (lat < bounds.minLat) bounds.minLat = lat;
    if (lon > bounds.maxLon) bounds.maxLon = lon;
    if (lat > bounds.maxLat) bounds.maxLat = lat;
  });
  return Number.isFinite(bounds.minLon) ? bounds : null;
}

export function collectBounds(entries: readonly ZoneEntry[]): Bounds | null {
  const union: Bounds = { minLon: Infinity, minLat: Infinity, maxLon: -Infinity, maxLat: -Infinity };
  for (const entry of entries) {
    const bounds = entry && entry.bounds ? entry.bounds : null;
    if (!bounds) continue;
    if (bounds.minLon < union.minLon) union.minLon = bounds.minLon;
    if (bounds.minLat < union.minLat) union.minLat = bounds.minLat;
    if (bounds.maxLon > union.maxLon) union.maxLon = bounds.maxLon;
    if (bounds.maxLat > union.maxLat) union.maxLat = bounds.maxLat;
  }
  return Number.isFinite(union.minLon) ? union : null;
}

// Fits `bounds` into a `size` pixel box with a uniform scale, so the whole
// extent stays inside [0, width] x [0, height] even when the extent is a
// degenerate point. The cosine correction keeps east-west distances honest.
export function fitProjection(bounds: Bounds, size: ViewSize, padding: number): ProjectionFit {
  const innerWidth = Math.max(size.width - padding * 2, 1);
  const innerHeight = Math.max(size.height - padding * 2, 1);
  const latMean = (bounds.minLat + bounds.maxLat) / 2;
  const cosLat = Math.max(Math.cos((latMean * Math.PI) / 180), 1e-6);
  const spanX = Math.max((bounds.maxLon - bounds.minLon) * cosLat, 1e-9);
  const spanY = Math.max(bounds.maxLat - bounds.minLat, 1e-9);
  const scale = Math.min(innerWidth / spanX, innerHeight / spanY);
  return {
    latMean,
    cosLat,
    scale,
    offsetX: padding + (innerWidth - spanX * scale) / 2,
    offsetY: padding + (innerHeight - spanY * scale) / 2,
    minLon: bounds.minLon,
    maxLat: bounds.maxLat,
  };
}

export function projectionFromFit(fit: ProjectionFit): Projection {
  return {
    latMean: fit.latMean,
    cosLat: fit.cosLat,
    scale: fit.scale,
    project(lon: number, lat: number): Point {
      return {
        x: fit.offsetX + (lon - fit.minLon) * fit.cosLat * fit.scale,
        y: fit.offsetY + (fit.maxLat - lat) * fit.scale,
      };
    },
  };
}

export function createProjection(bounds: Bounds, size: ViewSize, padding: number): Projection {
  return projectionFromFit(fitProjection(bounds, size, padding));
}

// A Polygon is one polygon and a MultiPolygon is many; both reduce to the same
// list of polygons so a MultiPolygon of one part degrades exactly like a
// Polygon, and neither geometry kind is treated as a special case downstream.
function polygonList(geometry: GeoGeometry): unknown[] {
  const coordinates: unknown = geometry.coordinates;
  if (!Array.isArray(coordinates)) return [];
  if (geometry.type === 'Polygon') return [coordinates];
  if (geometry.type === 'MultiPolygon') return coordinates;
  return [];
}

export function pathData(geometry: GeoGeometry | null | undefined, projection: Projection): string {
  if (!geometry || !Array.isArray(geometry.coordinates)) return '';
  const parts: string[] = [];
  for (const polygon of polygonList(geometry)) {
    if (!Array.isArray(polygon)) continue;
    for (const ring of polygon) {
      if (!Array.isArray(ring) || ring.length === 0) continue;
      let command = 'M';
      for (const point of ring) {
        if (!Array.isArray(point)) continue;
        const projected = projection.project(point[0], point[1]);
        parts.push(`${command}${projected.x.toFixed(2)} ${projected.y.toFixed(2)}`);
        command = 'L';
      }
      parts.push('Z');
    }
  }
  return parts.join(' ');
}

// The same rings `pathData` walks, kept as points so a 3D camera can re-project
// them. Order is identical on purpose: the SVG path and the 3D scene describe the
// same rings of the same polygons.
export function projectedRings(geometry: GeoGeometry | null | undefined, projection: Projection): Point[][] {
  if (!geometry || !Array.isArray(geometry.coordinates)) return [];
  const rings: Point[][] = [];
  for (const polygon of polygonList(geometry)) {
    if (!Array.isArray(polygon)) continue;
    for (const ring of polygon) {
      if (!Array.isArray(ring)) continue;
      const points: Point[] = [];
      for (const point of ring) {
        if (!Array.isArray(point)) continue;
        points.push(projection.project(point[0], point[1]));
      }
      if (points.length > 0) rings.push(points);
    }
  }
  return rings;
}

/** The `d` attribute of already-projected rings, formatted exactly like `pathData`. */
export function ringsPath(rings: readonly (readonly Point[])[]): string {
  const parts: string[] = [];
  for (const ring of rings) {
    if (ring.length === 0) continue;
    let command = 'M';
    for (const point of ring) {
      parts.push(`${command}${point.x.toFixed(2)} ${point.y.toFixed(2)}`);
      command = 'L';
    }
    parts.push('Z');
  }
  return parts.join(' ');
}

/** Mean real position of every vertex of a geometry, or `null` when there are none. */
export function geometryCenter(geometry: GeoGeometry | null | undefined): { lon: number; lat: number } | null {
  if (!geometry || !Array.isArray(geometry.coordinates)) return null;
  let lon = 0;
  let lat = 0;
  let count = 0;
  visitPositions(geometry.coordinates, (nextLon, nextLat) => {
    if (!Number.isFinite(nextLon) || !Number.isFinite(nextLat)) return;
    lon += nextLon;
    lat += nextLat;
    count += 1;
  });
  return count === 0 ? null : { lon: lon / count, lat: lat / count };
}

// Uniform decimation for the interactive layer: a ring is a shape on a screen, so
// keeping a vertex every `tolerance` local units preserves the silhouette while
// making a per-frame camera projection affordable. It is a level-of-detail choice,
// never a claim about the boundary data itself.
export function simplifyRings(rings: readonly (readonly Point[])[], tolerance: number): Point[][] {
  if (!(tolerance > 0)) return rings.map(ring => [...ring]);
  return rings.map(ring => {
    if (ring.length <= 3) return [...ring];
    const kept: Point[] = [ring[0]];
    for (let index = 1; index < ring.length - 1; index += 1) {
      const last = kept[kept.length - 1];
      if (Math.hypot(ring[index].x - last.x, ring[index].y - last.y) >= tolerance) kept.push(ring[index]);
    }
    const closing = ring[ring.length - 1];
    const last = kept[kept.length - 1];
    if (Math.hypot(closing.x - last.x, closing.y - last.y) > 1e-9) kept.push(closing);
    return kept.length >= 3 ? kept : [...ring];
  });
}

// Splits the catalogue into mainland features and detached insular features.
// Geometry-less features are dropped: the API already filters them out, and a
// missing geometry is a declared state, not a shape to invent.
export function partitionZones(
  features: readonly (ZoneFeature | null | undefined)[],
): { mainland: ZoneEntry[]; insets: ZoneEntry[] } {
  const mainland: ZoneEntry[] = [];
  const insets: ZoneEntry[] = [];
  for (const feature of features) {
    if (!feature || !feature.geometry) continue;
    const bounds = geometryBounds(feature.geometry);
    if (!bounds) continue;
    const detached = bounds.minLon < DETACHED_LONGITUDE;
    (detached ? insets : mainland).push({ feature, bounds });
  }
  return { mainland, insets };
}

export function countVertices(geometry: GeoGeometry | null | undefined): number {
  if (!geometry || !Array.isArray(geometry.coordinates)) return 0;
  let total = 0;
  visitPositions(geometry.coordinates, () => {
    total += 1;
  });
  return total;
}

export function zoneLabel(properties: ZoneProperties | null | undefined): string {
  const name = properties && properties.name ? String(properties.name) : 'Zona sin nombre';
  const code = properties && properties.code ? String(properties.code) : 'sin código';
  return `${name} (${code})`;
}

function buildFrame(entries: readonly ZoneEntry[], view: MapView, reliefMode: 'mainland' | 'island' = 'mainland'): MapFrame {
  const viewBox = `0 0 ${view.width} ${view.height}`;
  const bounds = collectBounds(entries);
  if (!bounds) return { viewBox, width: view.width, height: view.height, shapes: [], bounds: null, fit: null };
  const fit = fitProjection(bounds, view, view.padding);
  const projection = projectionFromFit(fit);
  const shapes = entries.map((entry) => {
    const properties = entry.feature.properties;
    const rings = projectedRings(entry.feature.geometry, projection);
    const center = ringsCenter(rings);
    const mean = geometryCenter(entry.feature.geometry);
    return {
      code: typeof properties?.code === 'string' ? properties.code : '',
      name: typeof properties?.name === 'string' ? properties.name : '',
      province: typeof properties?.province === 'string' ? properties.province : '',
      label: zoneLabel(properties),
      path: ringsPath(rings),
      rings,
      center,
      lonLat: mean ?? { lon: (bounds.minLon + bounds.maxLon) / 2, lat: (bounds.minLat + bounds.maxLat) / 2 },
      relief: reliefMode === 'island' ? AERIAL_ISLAND_RELIEF : illustrativeRelief(mean?.lon ?? bounds.minLon, mean?.lat ?? bounds.minLat, bounds),
    };
  });
  return { viewBox, width: view.width, height: view.height, shapes, bounds, fit };
}

function ringsCenter(rings: readonly (readonly Point[])[]): Point {
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
  return Number.isFinite(minX) ? { x: (minX + maxX) / 2, y: (minY + maxY) / 2 } : { x: 0, y: 0 };
}

// Turns a served catalogue into the frames the map renders: one mainland frame
// for the continental features and one frame per detached island, so each island
// gets its own local scale instead of being squeezed into the mainland extent.
export function buildMapLayout(collection: ZoneCollection | null | undefined): MapLayout {
  const features = collection && Array.isArray(collection.features) ? collection.features : [];
  const split = partitionZones(features);
  return {
    mainland: split.mainland.length > 0 ? buildFrame(split.mainland, MAINLAND_VIEW) : null,
    insets: split.insets.map((entry) => buildFrame([entry], INSET_VIEW, 'island')),
    totalFeatures: features.length,
    mainlandCount: split.mainland.length,
    insetCount: split.insets.length,
  };
}

// ── The interactive 3D camera ──────────────────────────────────────────────
//
// The aerial stage renders the SAME served rings through one oblique camera in two
// synchronized surfaces: a Canvas 2D scene (ocean, bathymetry, illustrative relief,
// extrusion, glow) and the SVG vector layer that keeps the accessible contract. The
// camera lives here, framework-free, so both surfaces cannot drift.
//
// `pitch` is the angle above the horizon: `0` is the flat cenital view and the
// default is 52°. `bearing` rotates the ground plane around the vertical axis and
// `panX`/`panY` are offsets in viewport units. Nothing here samples elevation: the
// `relief` an extruded commune rises by is the illustrative index above.

export const AERIAL_VIEW: ViewSize = { width: 960, height: 560 };
export const AERIAL_DEFAULT_PITCH = (52 * Math.PI) / 180;
export const AERIAL_DEFAULT_BEARING = -0.34;
export const AERIAL_PITCH_MAX = 1.26;
export const AERIAL_ZOOM_MIN = 0.85;
export const AERIAL_ZOOM_MAX = 4.5;
// How many viewport units a commune with relief 1 rises above the sea plane.
export const AERIAL_RELIEF_LIFT = 46;
// How much the selected commune is lifted again, so the selection reads in 3D.
export const AERIAL_SELECTED_LIFT = 16;
// Detached territories rise gently: their frames carry no cordillera ramp.
export const AERIAL_ISLAND_RELIEF = 0.16;
// Level of detail for the interactive layer, in frame units.
export const AERIAL_SIMPLIFY_TOLERANCE = 1.4;

export interface AerialCamera {
  /** Rotation of the ground plane around the vertical axis, in radians. */
  bearing: number;
  /** Angle above the horizon, in radians: `0` is cenital, the default is 52°. */
  pitch: number;
  zoom: number;
  /** Pan offset in viewport units, not CSS pixels. */
  panX: number;
  panY: number;
}

export const DEFAULT_AERIAL_CAMERA: AerialCamera = {
  bearing: AERIAL_DEFAULT_BEARING,
  pitch: AERIAL_DEFAULT_PITCH,
  zoom: 1,
  panX: 0,
  panY: 0,
};

export interface AerialViewport {
  width: number;
  height: number;
  /** Frame units to viewport units, zoom included. */
  scale: number;
  /** Screen position of the frame pivot. */
  cx: number;
  cy: number;
  pivotX: number;
  pivotY: number;
}

export interface ProjectedAerialPoint {
  x: number;
  y: number;
  /** Painter's-algorithm depth: larger is nearer the viewer. */
  depth: number;
}

/** Unknown or non-finite input falls back to the neutral pose instead of NaN. */
export function clampAerialZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(AERIAL_ZOOM_MAX, Math.max(AERIAL_ZOOM_MIN, zoom));
}

export function clampAerialPitch(pitch: number): number {
  if (!Number.isFinite(pitch)) return AERIAL_DEFAULT_PITCH;
  return Math.min(AERIAL_PITCH_MAX, Math.max(0, pitch));
}

export function wrapAerialBearing(bearing: number): number {
  if (!Number.isFinite(bearing)) return AERIAL_DEFAULT_BEARING;
  const turn = Math.PI * 2;
  return (((bearing + Math.PI) % turn) + turn) % turn - Math.PI;
}

/**
 * Illustrative relief index in 0..1 from the real mean position of a commune. The
 * regional coast runs north-west and the cordillera rises to the east, so the
 * normalized eastward distance (with a small latitude tilt) is the ramp. It is a
 * cartographic hint for the 3D stage — never an elevation measurement.
 */
export function illustrativeRelief(lon: number, lat: number, bounds: Bounds): number {
  const spanLon = Math.max(bounds.maxLon - bounds.minLon, 1e-9);
  const spanLat = Math.max(bounds.maxLat - bounds.minLat, 1e-9);
  const east = (lon - bounds.minLon) / spanLon;
  const north = (lat - bounds.minLat) / spanLat;
  const t = Math.min(1, Math.max(0, east * 1.06 - 0.04 + (north - 0.5) * 0.08));
  return Math.pow(t, 1.45);
}

/**
 * Fits a frame into a viewport and returns the pivot the camera rotates around.
 * A missing frame (an empty catalogue) still yields a usable viewport so the
 * camera controls never divide by zero.
 */
export function createAerialViewport(frame: MapFrame | null, size: ViewSize, zoom: number): AerialViewport {
  const zoomed = clampAerialZoom(zoom);
  if (!frame || !frame.fit) {
    return { width: size.width, height: size.height, scale: zoomed, cx: size.width / 2, cy: size.height * 0.54, pivotX: 0, pivotY: 0 };
  }
  const pad = 0.94;
  const scale = Math.min((size.width * pad) / frame.width, (size.height * pad) / frame.height) * zoomed;
  return {
    width: size.width,
    height: size.height,
    scale,
    cx: size.width / 2,
    // The oblique view compresses north to south; the pivot sits a little below the
    // middle so the cordillera still has room above the pivot.
    cy: size.height * 0.54,
    pivotX: frame.width / 2,
    pivotY: frame.height / 2,
  };
}

/** Projects one ground point at `lift` height through the aerial camera. */
export function projectAerialPoint(
  point: Point,
  lift: number,
  camera: AerialCamera,
  view: AerialViewport,
): ProjectedAerialPoint {
  const dx = point.x - view.pivotX;
  const dy = point.y - view.pivotY;
  const cosBearing = Math.cos(camera.bearing);
  const sinBearing = Math.sin(camera.bearing);
  const xx = dx * cosBearing - dy * sinBearing;
  const yy = dx * sinBearing + dy * cosBearing;
  const cosPitch = Math.cos(camera.pitch);
  const sinPitch = Math.sin(camera.pitch);
  return {
    x: view.cx + camera.panX + view.scale * xx,
    y: view.cy + camera.panY + view.scale * (yy * cosPitch - lift * sinPitch),
    depth: yy * sinPitch + lift * cosPitch,
  };
}

/** Every ring of a shape projected at one height, plus its `d` attribute. */
export function projectAerialRings(
  rings: readonly (readonly Point[])[],
  lift: number,
  camera: AerialCamera,
  view: AerialViewport,
): { rings: ProjectedAerialPoint[][]; path: string } {
  const projected = rings.map(ring => ring.map(point => projectAerialPoint(point, lift, camera, view)));
  const parts: string[] = [];
  for (const ring of projected) {
    if (ring.length === 0) continue;
    let command = 'M';
    for (const point of ring) {
      parts.push(`${command}${point.x.toFixed(2)} ${point.y.toFixed(2)}`);
      command = 'L';
    }
    parts.push('Z');
  }
  return { rings: projected, path: parts.join(' ') };
}

/**
 * The inverse of the ground-plane projection: a viewport point back to real
 * lon/lat. Used by the cursor readout, so the coordinate under the pointer is the
 * geometry's own position rather than a decorative number.
 */
export function unprojectAerialPoint(
  x: number,
  y: number,
  camera: AerialCamera,
  view: AerialViewport,
  frame: MapFrame | null,
): { lon: number; lat: number } | null {
  const fit = frame?.fit ?? null;
  if (!fit) return null;
  const cosPitch = Math.cos(camera.pitch);
  if (Math.abs(cosPitch) < 1e-3 || view.scale === 0) return null;
  const xx = (x - view.cx - camera.panX) / view.scale;
  const yy = (y - view.cy - camera.panY) / view.scale / cosPitch;
  const cosBearing = Math.cos(camera.bearing);
  const sinBearing = Math.sin(camera.bearing);
  const dx = xx * cosBearing + yy * sinBearing;
  const dy = -xx * sinBearing + yy * cosBearing;
  const frameX = dx + view.pivotX;
  const frameY = dy + view.pivotY;
  return {
    lon: fit.minLon + (frameX - fit.offsetX) / (fit.cosLat * fit.scale),
    lat: fit.maxLat - (frameY - fit.offsetY) / fit.scale,
  };
}

/** Real width of a frame in kilometres, from the served extent. */
export function frameWidthKm(frame: MapFrame | null): number | null {
  if (!frame || !frame.bounds || !frame.fit) return null;
  return (frame.bounds.maxLon - frame.bounds.minLon) * frame.fit.cosLat * 111.32;
}

/** A round scale length, in kilometres, whose bar fits a readable pixel span. */
export function scaleBarFor(frame: MapFrame | null, view: AerialViewport): { km: number; width: number } | null {
  const kmWidth = frameWidthKm(frame);
  if (kmWidth === null || view.scale === 0) return null;
  const kmPerViewUnit = kmWidth / frame!.width;
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 150, 200, 300];
  let chosen = steps[0];
  for (const step of steps) {
    const width = (step / kmPerViewUnit) * view.scale;
    if (width <= 132) chosen = step;
  }
  return { km: chosen, width: (chosen / kmPerViewUnit) * view.scale };
}
