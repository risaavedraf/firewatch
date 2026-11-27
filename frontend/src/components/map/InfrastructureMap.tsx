// PM-11 — the fictional point/line map of the synthetic infrastructure demo.
//
// It is intentionally props-driven and dependency-free: no tile provider, no
// basemap and no mapping library. The projection is the same schematic helper
// the territorial map uses, and the whole drawing is produced from the
// catalogue's declared geometries. These coordinates are fixture values, never
// real asset locations, and the figure says so in visible text.

import { useMemo, type ReactElement } from 'react';

import {
  INFRASTRUCTURE_TYPES,
  infrastructureTypeLabel,
  type InfrastructureCatalogue,
  type InfrastructureElement,
  type InfrastructureType,
} from '../../core/infrastructure';

import { createProjection, type Bounds, type Point } from './projection';

const MAP_WIDTH = 760;
const MAP_HEIGHT = 360;
const MAP_PADDING = 18;

// The chart grid. It is drawn from the viewBox, carries no place, coast or boundary,
// and is the only decoration the drawing adds: S7/S8 asked the coverage map to read
// like a cartographic plate instead of a flat diagram, and a graticule does that
// without inventing terrain the repository has no source for. The group is
// `aria-hidden`, so a screen reader meets the figures and the legend, not the grid.
const GRATICULE_STEP = 60;
const GRATICULE_MAJOR_EVERY = 3;

interface ProjectedElement {
  zone: string;
  element: InfrastructureElement;
  points: Point[];
}

interface MapLayout {
  viewBox: string;
  elements: ProjectedElement[];
}

function elementPositions(element: InfrastructureElement): number[][] {
  return element.geometry.type === 'Point' ? [element.geometry.coordinates] : element.geometry.coordinates;
}

function buildLayout(catalogue: InfrastructureCatalogue): MapLayout | null {
  const entries = catalogue.zones.flatMap(zone =>
    zone.elements.map(element => ({ zone: zone.zone_id, element })),
  );
  const positions = entries.flatMap(entry => elementPositions(entry.element));
  if (positions.length === 0) return null;

  const bounds: Bounds = { minLon: Infinity, minLat: Infinity, maxLon: -Infinity, maxLat: -Infinity };
  for (const position of positions) {
    const longitude = position[0];
    const latitude = position[1];
    if (longitude < bounds.minLon) bounds.minLon = longitude;
    if (latitude < bounds.minLat) bounds.minLat = latitude;
    if (longitude > bounds.maxLon) bounds.maxLon = longitude;
    if (latitude > bounds.maxLat) bounds.maxLat = latitude;
  }

  const projection = createProjection(bounds, { width: MAP_WIDTH, height: MAP_HEIGHT }, MAP_PADDING);
  const elements = entries.map(entry => ({
    zone: entry.zone,
    element: entry.element,
    points: elementPositions(entry.element).map(position => projection.project(position[0], position[1])),
  }));
  return { viewBox: `0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`, elements };
}

function linePath(points: readonly Point[]): string {
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(' ');
}

function graticuleMarks(size: number): number[] {
  const marks: number[] = [];
  for (let step = 1; step * GRATICULE_STEP < size; step += 1) marks.push(step * GRATICULE_STEP);
  return marks;
}

function graticuleClass(step: number): string | undefined {
  return step % GRATICULE_MAJOR_EVERY === 0 ? 'is-major' : undefined;
}

function markerLabel(element: InfrastructureElement): string {
  return `${infrastructureTypeLabel(element.type)} · ${element.id}`;
}

// Each point type gets a distinct silhouette as well as a distinct colour, so the
// map does not rely on colour alone. The four point types are the only ones this
// function receives; routes are drawn as paths below.
function pointMarker(element: InfrastructureElement, point: Point, key: string): ReactElement | null {
  const label = markerLabel(element);
  const className = `infrastructure-marker infrastructure-marker-${element.type}`;
  switch (element.type as Exclude<InfrastructureType, 'ruta'>) {
    case 'colegio':
      return (
        <rect
          key={key}
          className={className}
          data-element-id={element.id}
          data-element-type={element.type}
          x={point.x - 4.5}
          y={point.y - 4.5}
          width={9}
          height={9}
          rx={1.5}
        >
          <title>{label}</title>
        </rect>
      );
    case 'vivienda':
      return (
        <circle
          key={key}
          className={className}
          data-element-id={element.id}
          data-element-type={element.type}
          cx={point.x}
          cy={point.y}
          r={4.5}
        >
          <title>{label}</title>
        </circle>
      );
    case 'hospital':
      return (
        <polygon
          key={key}
          className={className}
          data-element-id={element.id}
          data-element-type={element.type}
          points={`${point.x},${point.y - 5.5} ${point.x + 5.5},${point.y} ${point.x},${point.y + 5.5} ${point.x - 5.5},${point.y}`}
        >
          <title>{label}</title>
        </polygon>
      );
    case 'hidrante':
      return (
        <polygon
          key={key}
          className={className}
          data-element-id={element.id}
          data-element-type={element.type}
          points={`${point.x},${point.y - 5.5} ${point.x + 5.2},${point.y + 4.5} ${point.x - 5.2},${point.y + 4.5}`}
        >
          <title>{label}</title>
        </polygon>
      );
  }
}

export function InfrastructureMap({ catalogue }: { catalogue: InfrastructureCatalogue }) {
  const layout = useMemo(() => buildLayout(catalogue), [catalogue]);

  return (
    <figure className="infrastructure-map" id="infrastructure-map">
      <figcaption id="infrastructure-map-caption">Geometrías ficticias del catálogo sintético</figcaption>
      {layout === null ? (
        <p className="empty-state" id="infrastructure-map-empty" role="status" aria-live="polite">
          El catálogo sintético no informa elementos con geometría para dibujar.
        </p>
      ) : (
        <svg
          id="infrastructure-map-svg"
          className="infrastructure-map-svg"
          viewBox={layout.viewBox}
          role="img"
          aria-labelledby="infrastructure-map-title infrastructure-map-desc"
        >
          <title id="infrastructure-map-title">Mapa ficticio de infraestructura sintética</title>
          <desc id="infrastructure-map-desc">
            Geometrías ficticias de un fixture sintético: colegios, viviendas, hospitales e hidrantes como puntos, y
            rutas como líneas. No son ubicaciones reales de infraestructura ni un mapa base.
          </desc>
          <g className="infrastructure-map-graticule" aria-hidden="true">
            {graticuleMarks(MAP_WIDTH).map((x, index) => (
              <line
                key={`meridian-${x}`}
                className={graticuleClass(index + 1)}
                x1={x}
                y1={0}
                x2={x}
                y2={MAP_HEIGHT}
              />
            ))}
            {graticuleMarks(MAP_HEIGHT).map((y, index) => (
              <line
                key={`parallel-${y}`}
                className={graticuleClass(index + 1)}
                x1={0}
                y1={y}
                x2={MAP_WIDTH}
                y2={y}
              />
            ))}
          </g>
          <g className="infrastructure-map-shapes">
            {layout.elements.map((entry, index) => {
              const key = `${entry.zone}-${entry.element.id}-${index}`;
              if (entry.element.geometry.type === 'LineString') {
                return (
                  <path
                    key={key}
                    className={`infrastructure-route infrastructure-route-${entry.element.type}`}
                    data-element-id={entry.element.id}
                    data-element-type={entry.element.type}
                    data-zone={entry.zone}
                    d={linePath(entry.points)}
                  >
                    <title>{markerLabel(entry.element)}</title>
                  </path>
                );
              }
              const point = entry.points[0];
              return point === undefined ? null : pointMarker(entry.element, point, key);
            })}
          </g>
        </svg>
      )}
      <ul
        className="infrastructure-map-legend"
        id="infrastructure-map-legend"
        aria-label="Leyenda de tipos y geometrías ficticias"
      >
        {INFRASTRUCTURE_TYPES.map(type => (
          <li key={type}>
            <span className={`infrastructure-legend-marker infrastructure-legend-${type}`} aria-hidden="true" />
            {infrastructureTypeLabel(type)} · {type === 'ruta' ? 'línea' : 'punto'}
          </li>
        ))}
      </ul>
      <p className="infrastructure-map-note" id="infrastructure-map-note">
        Posiciones y líneas ficticias del fixture <code>synthetic_fixture</code>. No corresponden a ubicaciones reales
        de infraestructura, no son cartografía oficial y no designan zonas críticas.
      </p>
    </figure>
  );
}
