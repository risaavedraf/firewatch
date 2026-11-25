// PM-11 — the synthetic infrastructure catalogue and its boundary guard.
//
// The demo serves an embedded fictional fixture from
// `GET /v1/risk/infrastructure`. This module owns the two facts the view is not
// allowed to invent: the wire shape of that answer and the one-point scoring
// rule it declares. Nothing here touches the risk classifier, a database or a
// shared auth/gateway path; the read uses the same bearer the other risk routes
// use.
//
// The guard is deliberately stricter than a shape check. The view will say, in
// visible text, that each element contributes one point and that every zone's
// total is the sum of its per-type counts. A payload that does not satisfy that
// claim is rejected as unreadable instead of being rendered as if it did.

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

export type InfrastructureGeometry =
  | { type: 'Point'; coordinates: number[] }
  | { type: 'LineString'; coordinates: number[][] };

export interface InfrastructureElement {
  id: string;
  type: InfrastructureType;
  geometry: InfrastructureGeometry;
}

export type InfrastructureCounts = Record<InfrastructureType, number>;

export interface InfrastructureZone {
  zone_id: string;
  score: number;
  counts: InfrastructureCounts;
  elements: InfrastructureElement[];
}

export interface InfrastructureCatalogue {
  source: 'synthetic_fixture';
  points_per_element: number;
  zones: InfrastructureZone[];
}

const DEADLINE_MS = 10_000;
const SYNTHETIC_SOURCE = 'synthetic_fixture';
const POINTS_PER_ELEMENT = 1;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isInfrastructureType(value: unknown): value is InfrastructureType {
  return typeof value === 'string' && (INFRASTRUCTURE_TYPES as readonly string[]).includes(value);
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

function isZone(value: unknown, pointsPerElement: number): value is InfrastructureZone {
  if (!record(value)) return false;
  if (!nonempty(value.zone_id)) return false;
  if (typeof value.score !== 'number' || !Number.isFinite(value.score)) return false;
  const countsValue = value.counts;
  if (!isCounts(countsValue)) return false;
  if (!Array.isArray(value.elements) || !value.elements.every(isElement)) return false;

  // The visible formula is the contract: every element is worth the declared
  // points, each count must match the entries actually carried, and the total
  // must equal the sum of the five counts.
  const expected = countElements(value.elements);
  for (const type of INFRASTRUCTURE_TYPES) {
    if (countsValue[type] !== expected[type]) return false;
  }
  const total = INFRASTRUCTURE_TYPES.reduce((sum, type) => sum + countsValue[type], 0);
  return value.score === total * pointsPerElement;
}

// Returns the catalogue exactly in the order the service served it (the server
// sorts by descending score, then ascending zone id), or `null` when any part of
// the claim cannot be trusted. No zone, count or geometry is repaired here.
export function parseInfrastructure(value: unknown): InfrastructureCatalogue | null {
  if (!record(value)) return null;
  if (value.source !== SYNTHETIC_SOURCE) return null;
  if (value.points_per_element !== POINTS_PER_ELEMENT) return null;
  if (!Array.isArray(value.zones)) return null;

  const zones: InfrastructureZone[] = [];
  const seen = new Set<string>();
  for (const entry of value.zones) {
    if (!isZone(entry, POINTS_PER_ELEMENT)) return null;
    if (seen.has(entry.zone_id)) return null;
    seen.add(entry.zone_id);
    zones.push(entry);
  }
  return { source: SYNTHETIC_SOURCE, points_per_element: POINTS_PER_ELEMENT, zones };
}

export function infrastructureTypeLabel(type: InfrastructureType): string {
  return INFRASTRUCTURE_TYPE_LABELS[type];
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

export function infrastructureScoreTotal(catalogue: InfrastructureCatalogue): number {
  return catalogue.zones.reduce((sum, zone) => sum + zone.score, 0);
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
