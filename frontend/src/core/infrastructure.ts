// V1-P-02 / PM-11 — the synthetic infrastructure catalogue, the ratified weighting
// table and its boundary guard.
//
// The demo serves an embedded fictional fixture from
// `GET /v1/risk/infrastructure`. This module owns the three facts the view is not
// allowed to invent: the wire shape of that answer, the ratified weight-and-radius
// table, and the exposure index the table produces. Nothing here touches the risk
// classifier, a database or a shared auth/gateway path; the read uses the same
// bearer the other risk routes use.
//
// The guard is deliberately stricter than a shape check. The view says, in visible
// text, that each category weighs what the owner ratified and that a zone's
// exposure is the weighted coverage of that table. A payload that does not satisfy
// those claims is rejected as unreadable instead of being rendered as if it did.

import { gatewayOrigin, routes } from '../config';

import type { Failure, Outcome } from './api';
import { getAccessToken, resetSession } from './session';

export const INFRASTRUCTURE_TYPES = ['colegio', 'vivienda', 'hospital', 'ruta', 'hidrante'] as const;

export type InfrastructureType = (typeof INFRASTRUCTURE_TYPES)[number];

// Display order and vocabulary. `ruta` is the only line type; the other four are
// points, exactly as the frozen PM-11 response declares.
export const INFRASTRUCTURE_TYPE_LABELS: Record<InfrastructureType, string> = {
  colegio: 'Colegio',
  vivienda: 'Vivienda',
  hospital: 'Hospital',
  ruta: 'Ruta',
  hidrante: 'Hidrante',
};

// The ratified five categories, in the owner's order. This client reference exists
// to check the served table, not to replace it: a payload that declares different
// weights, radii or aliases is refused instead of displayed as if it were the
// ratified decision.
export const INFRASTRUCTURE_CATEGORIES = [
  'hospital',
  'escuela',
  'subestacion',
  'telecom',
  'vialidad',
] as const;

export type InfrastructureCategoryName = (typeof INFRASTRUCTURE_CATEGORIES)[number];

export const INFRASTRUCTURE_CATEGORY_LABELS: Record<InfrastructureCategoryName, string> = {
  hospital: 'Hospital / salud',
  escuela: 'Escuela / educación',
  subestacion: 'Subestación / agua potable',
  telecom: 'Telecom / cuartel de bomberos',
  vialidad: 'Vialidad / puente',
};

export const INFRASTRUCTURE_RATIFIED_TABLE: readonly {
  category: InfrastructureCategoryName;
  aliases: readonly string[];
  weight: number;
  radiusKm: number;
}[] = [
  { category: 'hospital', aliases: ['hospital', 'salud'], weight: 1.0, radiusKm: 5.0 },
  { category: 'escuela', aliases: ['escuela', 'educacion'], weight: 0.9, radiusKm: 3.0 },
  { category: 'subestacion', aliases: ['subestacion', 'agua_potable'], weight: 0.85, radiusKm: 4.0 },
  { category: 'telecom', aliases: ['telecom', 'cuartel_bomberos'], weight: 0.75, radiusKm: 4.0 },
  { category: 'vialidad', aliases: ['vialidad', 'puente'], weight: 0.65, radiusKm: 2.5 },
];

export const INFRASTRUCTURE_WEIGHT_SUM = 4.15;
export const INFRASTRUCTURE_RISK_WEIGHT = 0.7;
export const INFRASTRUCTURE_EXPOSURE_WEIGHT = 0.3;

export type InfrastructureGeometry =
  | { type: 'Point'; coordinates: number[] }
  | { type: 'LineString'; coordinates: number[][] };

export interface InfrastructureElement {
  id: string;
  type: InfrastructureType;
  geometry: InfrastructureGeometry;
}

export type InfrastructureCounts = Record<InfrastructureType, number>;

export interface InfrastructureCategory {
  category: InfrastructureCategoryName;
  aliases: string[];
  weight: number;
  radius_km: number;
}

export interface InfrastructureTypeCategory {
  type: InfrastructureType;
  category: InfrastructureCategoryName;
  weight: number;
  radius_km: number;
}

export interface InfrastructureWeighting {
  exposure_formula: string;
  priority_formula: string;
  risk_formula: string;
  risk_weight: number;
  exposure_weight: number;
  weight_sum: number;
  categories: InfrastructureCategory[];
  type_categories: InfrastructureTypeCategory[];
  unweighted_types: string[];
}

export interface InfrastructureZoneCategory {
  category: InfrastructureCategoryName;
  weight: number;
  radius_km: number;
  count: number;
  weighted_points: number;
}

export interface InfrastructureZone {
  zone_id: string;
  exposure_score: number;
  weighted_points: number;
  exposed_assets_count: number;
  dominant_category: InfrastructureCategoryName | null;
  counts: InfrastructureCounts;
  categories: InfrastructureZoneCategory[];
  elements: InfrastructureElement[];
}

export interface InfrastructureCatalogue {
  source: 'synthetic_fixture';
  weighting: InfrastructureWeighting;
  zones: InfrastructureZone[];
}

const DEADLINE_MS = 10_000;
const SYNTHETIC_SOURCE = 'synthetic_fixture';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isInfrastructureType(value: unknown): value is InfrastructureType {
  return typeof value === 'string' && (INFRASTRUCTURE_TYPES as readonly string[]).includes(value);
}

function isCategoryName(value: unknown): value is InfrastructureCategoryName {
  return typeof value === 'string' && (INFRASTRUCTURE_CATEGORIES as readonly string[]).includes(value);
}

function closeTo(left: number, right: number): boolean {
  return Math.abs(left - right) < 1e-9;
}

// RFC 7946 positions carry at least longitude and latitude (altitude is allowed
// after them). A non-finite, out-of-range or wrongly nested position is rejected
// rather than projected into a plausible-looking shape.
function isPosition(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length < 2) return false;
  if (!value.every(coordinate => typeof coordinate === 'number' && Number.isFinite(coordinate))) return false;
  const [longitude, latitude] = value;
  return longitude >= -180 && longitude <= 180 && latitude >= -90 && latitude <= 90;
}

function isLineStringCoordinates(value: unknown): value is number[][] {
  return Array.isArray(value) && value.length >= 2 && value.every(isPosition);
}

function hasGeometryFor(elementType: InfrastructureType, geometry: unknown): geometry is InfrastructureGeometry {
  if (!record(geometry)) return false;
  if (elementType === 'ruta') {
    return geometry.type === 'LineString' && isLineStringCoordinates(geometry.coordinates);
  }
  return geometry.type === 'Point' && isPosition(geometry.coordinates);
}

function isElement(value: unknown): value is InfrastructureElement {
  if (!record(value)) return false;
  if (!nonempty(value.id) || !isInfrastructureType(value.type)) return false;
  return hasGeometryFor(value.type, value.geometry);
}

function isCounts(value: unknown): value is InfrastructureCounts {
  if (!record(value)) return false;
  return INFRASTRUCTURE_TYPES.every(type => {
    const count = value[type];
    return typeof count === 'number' && Number.isInteger(count) && count >= 0;
  });
}

function countElements(elements: readonly InfrastructureElement[]): InfrastructureCounts {
  const result: InfrastructureCounts = { colegio: 0, vivienda: 0, hospital: 0, ruta: 0, hidrante: 0 };
  for (const element of elements) result[element.type] += 1;
  return result;
}

// The served table must be the ratified one: same categories, same order, same
// aliases, same weights, same radii, same normaliser. Anything else is a different
// decision and is not displayed as this one.
function isRatifiedCategory(value: unknown, index: number): value is InfrastructureCategory {
  if (!record(value)) return false;
  const ratified = INFRASTRUCTURE_RATIFIED_TABLE[index];
  if (ratified === undefined) return false;
  if (value.category !== ratified.category) return false;
  if (!Array.isArray(value.aliases) || value.aliases.length !== ratified.aliases.length) return false;
  if (!value.aliases.every((alias, position) => alias === ratified.aliases[position])) return false;
  if (typeof value.weight !== 'number' || !closeTo(value.weight, ratified.weight)) return false;
  if (typeof value.radius_km !== 'number' || !closeTo(value.radius_km, ratified.radiusKm)) return false;
  return true;
}

function isTypeCategory(value: unknown): value is InfrastructureTypeCategory {
  if (!record(value)) return false;
  if (!isInfrastructureType(value.type) || !isCategoryName(value.category)) return false;
  const ratified = INFRASTRUCTURE_RATIFIED_TABLE.find(category => category.category === value.category);
  if (ratified === undefined) return false;
  if (typeof value.weight !== 'number' || !closeTo(value.weight, ratified.weight)) return false;
  if (typeof value.radius_km !== 'number' || !closeTo(value.radius_km, ratified.radiusKm)) return false;
  return true;
}

function isWeighting(value: unknown): value is InfrastructureWeighting {
  if (!record(value)) return false;
  if (!Array.isArray(value.categories) || value.categories.length !== INFRASTRUCTURE_RATIFIED_TABLE.length) {
    return false;
  }
  if (!value.categories.every((category, index) => isRatifiedCategory(category, index))) return false;
  if (typeof value.weight_sum !== 'number' || !closeTo(value.weight_sum, INFRASTRUCTURE_WEIGHT_SUM)) return false;
  if (typeof value.risk_weight !== 'number' || !closeTo(value.risk_weight, INFRASTRUCTURE_RISK_WEIGHT)) return false;
  if (
    typeof value.exposure_weight !== 'number' ||
    !closeTo(value.exposure_weight, INFRASTRUCTURE_EXPOSURE_WEIGHT)
  ) {
    return false;
  }
  if (!Array.isArray(value.type_categories) || !value.type_categories.every(isTypeCategory)) return false;
  if (!Array.isArray(value.unweighted_types) || !value.unweighted_types.every(nonempty)) return false;
  return nonempty(value.exposure_formula) && nonempty(value.priority_formula) && nonempty(value.risk_formula);
}

// The fold the server publishes is what decides which categories a zone declares.
// The client applies it instead of re-deriving it, so a type the server leaves
// unweighted cannot start contributing here.
function categoryCounts(
  elements: readonly InfrastructureElement[],
  weighting: InfrastructureWeighting,
): Map<InfrastructureCategoryName, number> {
  const counts = new Map<InfrastructureCategoryName, number>();
  for (const entry of weighting.type_categories) {
    if (counts.get(entry.category) === undefined) counts.set(entry.category, 0);
  }
  for (const element of elements) {
    const folded = weighting.type_categories.find(entry => entry.type === element.type);
    if (folded === undefined) continue;
    counts.set(folded.category, (counts.get(folded.category) ?? 0) + 1);
  }
  return counts;
}

function expectedExposure(counts: Map<InfrastructureCategoryName, number>): number {
  let present = 0;
  for (const [category, count] of counts) {
    if (count <= 0) continue;
    const ratified = INFRASTRUCTURE_RATIFIED_TABLE.find(entry => entry.category === category);
    if (ratified === undefined) continue;
    present += ratified.weight;
  }
  return Math.round((100 * present) / INFRASTRUCTURE_WEIGHT_SUM);
}

function isCategoryRow(value: unknown, weighting: InfrastructureWeighting): value is InfrastructureZoneCategory {
  if (!record(value)) return false;
  if (!isCategoryName(value.category)) return false;
  const ratified = weighting.categories.find(category => category.category === value.category);
  if (ratified === undefined) return false;
  if (typeof value.weight !== 'number' || !closeTo(value.weight, ratified.weight)) return false;
  if (typeof value.radius_km !== 'number' || !closeTo(value.radius_km, ratified.radius_km)) return false;
  if (typeof value.count !== 'number' || !Number.isInteger(value.count) || value.count < 0) return false;
  if (typeof value.weighted_points !== 'number' || !Number.isFinite(value.weighted_points)) return false;
  return closeTo(value.weighted_points, ratified.weight * value.count);
}

function isZone(value: unknown, weighting: InfrastructureWeighting): value is InfrastructureZone {
  if (!record(value)) return false;
  if (!nonempty(value.zone_id)) return false;
  if (typeof value.exposure_score !== 'number' || !Number.isInteger(value.exposure_score)) return false;
  if (typeof value.weighted_points !== 'number' || !Number.isFinite(value.weighted_points)) return false;
  if (
    typeof value.exposed_assets_count !== 'number' ||
    !Number.isInteger(value.exposed_assets_count) ||
    value.exposed_assets_count < 0
  ) {
    return false;
  }
  const countsValue = value.counts;
  if (!isCounts(countsValue)) return false;
  if (!Array.isArray(value.elements) || !value.elements.every(isElement)) return false;
  if (!Array.isArray(value.categories) || !value.categories.every(row => isCategoryRow(row, weighting))) return false;
  if (value.dominant_category !== null && !isCategoryName(value.dominant_category)) return false;

  // The visible formula is the contract: every count must match the entries
  // actually carried, every category row must match the published fold, the total
  // weighted points must be the sum of those rows, and the exposure index must be
  // what the ratified table produces.
  const expectedCounts = countElements(value.elements);
  for (const type of INFRASTRUCTURE_TYPES) {
    if (countsValue[type] !== expectedCounts[type]) return false;
  }
  if (value.exposed_assets_count !== value.elements.length) return false;
  if (value.categories.length !== weighting.categories.length) return false;

  const counted = categoryCounts(value.elements, weighting);
  let weighted = 0;
  let dominant: InfrastructureCategoryName | null = null;
  let best = 0;
  for (const row of value.categories) {
    if (row.count !== (counted.get(row.category) ?? 0)) return false;
    weighted += row.weighted_points;
    if (row.count > 0 && (dominant === null || row.weighted_points > best)) {
      dominant = row.category;
      best = row.weighted_points;
    }
  }
  if (!closeTo(value.weighted_points, weighted)) return false;
  if (value.exposure_score !== expectedExposure(counted)) return false;
  return value.dominant_category === dominant;
}

// Returns the catalogue exactly in the order the service served it (the server
// sorts by descending exposure index, then ascending zone id), or `null` when any
// part of the claim cannot be trusted. No zone, count or geometry is repaired here.
export function parseInfrastructure(value: unknown): InfrastructureCatalogue | null {
  if (!record(value)) return null;
  if (value.source !== SYNTHETIC_SOURCE) return null;
  if (!isWeighting(value.weighting)) return null;
  if (!Array.isArray(value.zones)) return null;

  const zones: InfrastructureZone[] = [];
  const seen = new Set<string>();
  for (const entry of value.zones) {
    if (!isZone(entry, value.weighting)) return null;
    if (seen.has(entry.zone_id)) return null;
    seen.add(entry.zone_id);
    zones.push(entry);
  }
  return { source: SYNTHETIC_SOURCE, weighting: value.weighting, zones };
}

export function infrastructureTypeLabel(type: InfrastructureType): string {
  return INFRASTRUCTURE_TYPE_LABELS[type];
}

export function infrastructureCategoryLabel(category: InfrastructureCategoryName): string {
  return INFRASTRUCTURE_CATEGORY_LABELS[category];
}

export function infrastructureCategoryRows(
  zone: InfrastructureZone,
): Array<{ category: InfrastructureCategoryName; label: string; count: number; weight: number; radiusKm: number }> {
  return zone.categories.map(row => ({
    category: row.category,
    label: INFRASTRUCTURE_CATEGORY_LABELS[row.category],
    count: row.count,
    weight: row.weight,
    radiusKm: row.radius_km,
  }));
}

export function infrastructureCountRows(
  zone: InfrastructureZone,
): Array<{ type: InfrastructureType; label: string; count: number }> {
  return INFRASTRUCTURE_TYPES.map(type => ({
    type,
    label: INFRASTRUCTURE_TYPE_LABELS[type],
    count: zone.counts[type],
  }));
}

export function infrastructureElementCount(catalogue: InfrastructureCatalogue): number {
  return catalogue.zones.reduce((sum, zone) => sum + zone.elements.length, 0);
}

// The tallest exposure index the catalogue declares. It is a real reading of the
// served rows, not a target: an empty catalogue has none.
export function infrastructureMaxExposure(catalogue: InfrastructureCatalogue): number | null {
  if (catalogue.zones.length === 0) return null;
  return catalogue.zones.reduce((highest, zone) => Math.max(highest, zone.exposure_score), 0);
}

export function infrastructureGeometrySummary(geometry: InfrastructureGeometry): string {
  if (geometry.type === 'Point') {
    const [longitude, latitude] = geometry.coordinates;
    return `Punto ficticio (${longitude.toFixed(4)}, ${latitude.toFixed(4)})`;
  }
  return `Línea ficticia de ${geometry.coordinates.length} posiciones`;
}

function failure(kind: Failure['kind'], reason: string, status?: number, requestId?: string): Failure {
  const value: Failure = { kind, reason };
  if (status !== undefined) value.status = status;
  if (requestId !== undefined && requestId !== '') value.requestId = requestId;
  return value;
}

function failureOutcome<T>(value: Failure): Outcome<T> {
  return { ok: false, failure: value };
}

// The one read this view performs. It carries the same bearer and the same
// bounded deadline as every other gateway read, and it resets the session on a
// 401 exactly like the shared transport does.
export async function infrastructure(signal?: AbortSignal): Promise<Outcome<InfrastructureCatalogue>> {
  const token = getAccessToken();
  const controller = new AbortController();
  let stopped: 'none' | 'aborted' | 'deadline' = 'none';
  // Read through an accessor: the assignments happen in callbacks, so the
  // control-flow analysis would otherwise narrow the variable to its initial
  // value and treat the comparisons below as unreachable.
  const stopReason = (): 'none' | 'aborted' | 'deadline' => stopped;

  const onAbort = (): void => {
    stopped = 'aborted';
    controller.abort();
  };
  if (signal) {
    if (signal.aborted) return failureOutcome(failure('unavailable', 'aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
  }

  const deadline = setTimeout(() => {
    stopped = 'deadline';
    controller.abort();
  }, DEADLINE_MS);

  try {
    const response = await fetch(`${gatewayOrigin}${routes.infrastructure}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
    });

    // A token change means the session that issued this read is gone; the answer
    // must not repopulate a view the new session never asked for.
    if (getAccessToken() !== token) return failureOutcome(failure('unavailable', 'superseded'));

    const requestId = response.headers.get('X-Request-ID') ?? '';
    if (response.status === 401) {
      resetSession(token !== '' ? 'rejected' : null);
      return failureOutcome(failure('unauthorized', 'unauthorized', 401, requestId));
    }
    if (response.status === 403) {
      return failureOutcome(failure('forbidden', 'forbidden', 403, requestId));
    }
    if (!response.ok) {
      return failureOutcome(failure('unavailable', `http_${response.status}`, response.status, requestId));
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return failureOutcome(failure('malformed', 'malformed_json', response.status, requestId));
    }
    if (getAccessToken() !== token) return failureOutcome(failure('unavailable', 'superseded'));

    const catalogue = parseInfrastructure(body);
    if (catalogue === null) {
      return failureOutcome(failure('malformed', 'invalid_shape', response.status, requestId));
    }
    return { ok: true, data: catalogue };
  } catch {
    const reason = stopReason();
    if (reason === 'deadline') return failureOutcome(failure('unavailable', 'deadline'));
    if (reason === 'aborted') return failureOutcome(failure('unavailable', 'aborted'));
    return failureOutcome(failure('unavailable', 'network'));
  } finally {
    clearTimeout(deadline);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}
