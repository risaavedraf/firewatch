import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { MapPanel, type ZoneLevelLookup } from '../../src/components/map/MapPanel';
import {
  AERIAL_DEFAULT_BEARING,
  AERIAL_DEFAULT_PITCH,
  AERIAL_ZOOM_MAX,
  AERIAL_ZOOM_MIN,
} from '../../src/components/map/projection';
import type { JobProgress } from '../../src/domain/job-progress';
import type { RiskLevel, ZoneCollection, ZoneFeature } from '../../src/types/api';

// T12 — the interactive 3D aerial stage.
//
// The stage is a Canvas 2D scene (ocean, bathymetry, illustrative relief,
// extrusion, glow) with the real commune geometry projected through ONE camera,
// and a synchronized SVG vector layer that carries the accessible contract of
// `#map-svg`: every served commune stays a `role="button"` path with its zone
// classes, its keyboard activation and its pressed state. This suite pins exactly
// that split, because the immersive surface is worthless if the keyboard or the
// real catalogue is dropped on the way.
//
// jsdom has no canvas implementation, so `getContext('2d')` returns null. The
// stage must degrade silently — the vector layer and the HUD are DOM, so they are
// still fully testable — and that fallback is pinned here rather than assumed.

const MAINLAND_SVG_NAME = 'Comunas seleccionables: clic, Enter o Espacio';
const INSETS_LABEL = 'Territorios insulares representados en recuadros aparte, fuera de su posición geográfica';

function square(minLon: number, minLat: number, size = 0.1): ZoneFeature['geometry'] {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [minLon, minLat],
        [minLon + size, minLat],
        [minLon + size, minLat + size],
        [minLon, minLat],
      ],
    ],
  };
}

const VALPARAISO: ZoneFeature = {
  type: 'Feature',
  properties: { code: '05101', name: 'Valparaíso', province: 'Valparaíso' },
  geometry: square(-71.7, -33.1),
};
const VINA_DEL_MAR: ZoneFeature = {
  type: 'Feature',
  properties: { code: '05102', name: 'Viña del Mar', province: 'Valparaíso' },
  geometry: square(-71.6, -33.0),
};
const JUAN_FERNANDEZ: ZoneFeature = {
  type: 'Feature',
  properties: { code: '05104', name: 'Juan Fernández', province: 'Valparaíso' },
  geometry: square(-78.9, -33.6, 0.4),
};

const CATALOGUE: ZoneCollection = { type: 'FeatureCollection', features: [VALPARAISO, VINA_DEL_MAR, JUAN_FERNANDEZ] };
const EMPTY_CATALOGUE: ZoneCollection = { type: 'FeatureCollection', features: [] };

function noLevels(): ZoneLevelLookup {
  return { levelFor: () => '' };
}

function rememberedLevels(entries: Record<string, RiskLevel>): ZoneLevelLookup {
  return { levelFor: zone => entries[zone] ?? '' };
}

const IDLE: JobProgress = { kind: 'idle', zone: '' };

function baseProps(overrides: Partial<ComponentProps<typeof MapPanel>> = {}): ComponentProps<typeof MapPanel> {
  return {
    collection: CATALOGUE,
    loadState: 'ready',
    sessionReason: null,
    selectedCode: '05101',
    zoneLevels: noLevels(),
    onSelect: vi.fn(),
    jobProgress: IDLE,
    ...overrides,
  };
}

// jsdom logs an unimplemented-method error for every `getContext('2d')` call. The
// fallback under test is the null context itself, so the stub keeps the suite quiet
// while still returning exactly what jsdom returns.
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

function stage(): HTMLElement {
  const node = document.querySelector<HTMLElement>('.map-3d');
  if (node === null) throw new Error('the 3D aerial stage is missing');
  return node;
}

// The surface that owns the pan/orbit/select pointer handlers.
function stageSurface(): HTMLElement {
  const node = document.querySelector<HTMLElement>('.map-3d-stage');
  if (node === null) throw new Error('the 3D aerial stage surface is missing');
  return node;
}

function cameraNumber(attribute: string): number {
  const raw = stage().getAttribute(attribute);
  if (raw === null) throw new Error(`the stage declares no ${attribute}`);
  return Number(raw);
}

function mainlandSvg(): Element {
  const svg = document.getElementById('map-svg');
  if (svg === null) throw new Error('missing DOM map-svg');
  return svg;
}

function pathData(code: string): string {
  const path = document.querySelector(`#map-svg [data-zone="${code}"]`);
  if (path === null) throw new Error(`missing mainland path for ${code}`);
  return path.getAttribute('d') ?? '';
}

describe('3D aerial stage: camera and projection mode', () => {
  test('the stage opens in the oblique 3D camera over the served geometry', () => {
    render(<MapPanel {...baseProps()} />);

    expect(stage()).toHaveAttribute('data-projection-mode', '3d');
    expect(cameraNumber('data-camera-pitch')).toBeCloseTo(AERIAL_DEFAULT_PITCH, 3);
    expect(cameraNumber('data-camera-bearing')).toBeCloseTo(AERIAL_DEFAULT_BEARING, 3);
    expect(cameraNumber('data-camera-zoom')).toBe(1);

    // The canvas is the immersive surface; the SVG stays the accessible one.
    const canvas = document.querySelector('canvas.map-3d-canvas');
    expect(canvas).not.toBeNull();
    expect(canvas).toHaveAttribute('aria-hidden', 'true');
    expect(mainlandSvg()).toHaveAttribute('role', 'group');
    expect(mainlandSvg()).toHaveAttribute('aria-label', MAINLAND_SVG_NAME);
    expect(mainlandSvg().querySelectorAll('path.zone-shape')).toHaveLength(2);
  });

  test('2D Cenital flattens the camera to zero degrees and Vista 3D restores it', async () => {
    const user = userEvent.setup();
    render(<MapPanel {...baseProps()} />);

    const cenital = screen.getByRole('button', { name: '2D Cenital' });
    const aerial = screen.getByRole('button', { name: 'Vista 3D' });
    expect(aerial).toHaveAttribute('aria-pressed', 'true');
    expect(cenital).toHaveAttribute('aria-pressed', 'false');

    await user.click(cenital);
    expect(stage()).toHaveAttribute('data-projection-mode', '2d');
    expect(cameraNumber('data-camera-pitch')).toBe(0);
    expect(cenital).toHaveAttribute('aria-pressed', 'true');
    expect(aerial).toHaveAttribute('aria-pressed', 'false');

    await user.click(aerial);
    expect(stage()).toHaveAttribute('data-projection-mode', '3d');
    expect(cameraNumber('data-camera-pitch')).toBeCloseTo(AERIAL_DEFAULT_PITCH, 3);
  });

  test('the camera is real: zooming re-projects the vector geometry', async () => {
    const user = userEvent.setup();
    render(<MapPanel {...baseProps()} />);

    const before = pathData('05101');
    await user.click(screen.getByRole('button', { name: 'Acercar' }));

    expect(cameraNumber('data-camera-zoom')).toBeGreaterThan(1);
    expect(pathData('05101')).not.toBe(before);
  });

  test('zoom steps and clamps inside the documented range', () => {
    render(<MapPanel {...baseProps()} />);

    const zoomIn = screen.getByRole('button', { name: 'Acercar' });
    const zoomOut = screen.getByRole('button', { name: 'Alejar' });

    // `fireEvent` rather than `userEvent` for the clamp: this test is about the
    // arithmetic bound, and 90 pointer-driven clicks would measure the harness.
    for (let step = 0; step < 30; step += 1) fireEvent.click(zoomIn);
    expect(cameraNumber('data-camera-zoom')).toBeCloseTo(AERIAL_ZOOM_MAX, 5);

    for (let step = 0; step < 60; step += 1) fireEvent.click(zoomOut);
    expect(cameraNumber('data-camera-zoom')).toBeCloseTo(AERIAL_ZOOM_MIN, 5);
  });

  test('orbit and tilt buttons move the camera and keep their limits', async () => {
    const user = userEvent.setup();
    render(<MapPanel {...baseProps()} />);

    const bearing = cameraNumber('data-camera-bearing');
    await user.click(screen.getByRole('button', { name: 'Girar a la derecha' }));
    expect(cameraNumber('data-camera-bearing')).toBeGreaterThan(bearing);
    await user.click(screen.getByRole('button', { name: 'Girar a la izquierda' }));
    expect(cameraNumber('data-camera-bearing')).toBeCloseTo(bearing, 5);

    const pitch = cameraNumber('data-camera-pitch');
    await user.click(screen.getByRole('button', { name: 'Aumentar la inclinación' }));
    expect(cameraNumber('data-camera-pitch')).toBeGreaterThan(pitch);
    await user.click(screen.getByRole('button', { name: 'Reducir la inclinación' }));
    expect(cameraNumber('data-camera-pitch')).toBeCloseTo(pitch, 5);
  });

  test('Centrar región returns the camera to the region pose and keeps the mode', async () => {
    const user = userEvent.setup();
    render(<MapPanel {...baseProps()} />);

    await user.click(screen.getByRole('button', { name: 'Acercar' }));
    await user.click(screen.getByRole('button', { name: 'Girar a la derecha' }));
    await user.click(screen.getByRole('button', { name: '2D Cenital' }));

    await user.click(screen.getByRole('button', { name: 'Centrar región' }));

    expect(cameraNumber('data-camera-zoom')).toBe(1);
    expect(cameraNumber('data-camera-bearing')).toBeCloseTo(AERIAL_DEFAULT_BEARING, 3);
    // The reset recentres the camera; it does not silently switch perspective.
    expect(stage()).toHaveAttribute('data-projection-mode', '2d');
  });

  test('Enfocar comuna marks the selected comuna as the camera target', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const { rerender } = render(<MapPanel {...baseProps({ onSelect })} />);

    await user.click(screen.getByRole('button', { name: 'Viña del Mar (05102)' }));
    expect(onSelect).toHaveBeenCalledWith('05102');
    rerender(<MapPanel {...baseProps({ selectedCode: '05102', onSelect })} />);

    const before = pathData('05102');
    await user.click(screen.getByRole('button', { name: 'Enfocar comuna' }));

    expect(stage()).toHaveAttribute('data-camera-focus', '05102');
    // jsdom has no `matchMedia`, so the documented reduced-motion fallback applies:
    // the focus is applied immediately instead of tweened.
    expect(pathData('05102')).not.toBe(before);
  });
});

describe('3D aerial stage: layers and honest labelling', () => {
  test('the layer chips toggle relief, names and graticule and keep their pressed state', async () => {
    const user = userEvent.setup();
    render(<MapPanel {...baseProps()} />);

    for (const name of ['Relieve', 'Nombres', 'Grilla']) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true');
    }
    expect(stage().getAttribute('data-layers')).toContain('grilla');

    await user.click(screen.getByRole('button', { name: 'Grilla' }));
    expect(screen.getByRole('button', { name: 'Grilla' })).toHaveAttribute('aria-pressed', 'false');
    expect(stage().getAttribute('data-layers')).not.toContain('grilla');

    await user.click(screen.getByRole('button', { name: 'Nombres' }));
    expect(stage().getAttribute('data-layers')).not.toContain('nombres');

    await user.click(screen.getByRole('button', { name: 'Relieve' }));
    expect(stage().getAttribute('data-layers')).not.toContain('relieve');
  });

  test('the stage states that its relief is illustrative and the limits official', () => {
    render(<MapPanel {...baseProps()} />);

    const badge = document.getElementById('map-3d-attribution');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain('Relieve 3D ilustrativo');
    expect(badge?.textContent).toContain('Límites oficiales SUBDERE/IGM');

    // The provenance the source declares is still rendered verbatim, untouched by
    // the immersive surface.
    expect(document.getElementById('map-attribution')?.textContent).toContain('SUBDERE');
    expect(document.getElementById('map-restriction')?.textContent).toContain('DIFROL');
  });

  test('the labels layer draws names for the selected comuna without replacing the accessible path name', () => {
    render(<MapPanel {...baseProps({ selectedCode: '05102' })} />);

    const labels = mainlandSvg().querySelector('[data-layer="nombres"]');
    expect(labels).not.toBeNull();
    expect(labels).toHaveAttribute('aria-hidden', 'true');
    expect(labels?.textContent).toContain('Viña del Mar');
    // The path keeps the catalogue identity as its accessible name.
    expect(screen.getByRole('button', { name: 'Viña del Mar (05102)' })).toBeInTheDocument();
  });

  test('the compass and the metric scale bar are drawn from the real extent', () => {
    render(<MapPanel {...baseProps()} />);

    expect(document.getElementById('map-3d-compass')).not.toBeNull();
    const scale = document.getElementById('map-3d-scale');
    expect(scale).not.toBeNull();
    expect(scale?.textContent).toMatch(/\d+(?:[.,]\d+)?\s*km/);
  });
});

describe('3D aerial stage: pointer and keyboard contract', () => {
  test('hovering a comuna raises the glass tooltip with its CUT and risk state', () => {
    render(<MapPanel {...baseProps({ zoneLevels: rememberedLevels({ '05102': 'medio' }) })} />);

    const tooltip = document.querySelector<HTMLElement>('.map-3d-tooltip');
    expect(tooltip).not.toBeNull();
    expect(tooltip).toHaveAttribute('hidden');

    const vina = screen.getByRole('button', { name: 'Viña del Mar (05102)' });
    fireEvent.pointerOver(vina);

    expect(tooltip).not.toHaveAttribute('hidden');
    expect(tooltip?.textContent).toContain('Viña del Mar');
    expect(tooltip?.textContent).toContain('CUT 05102');
    expect(tooltip?.textContent).toContain('MEDIO');

    fireEvent.pointerMove(vina, { clientX: 40, clientY: 30 });
    expect(tooltip?.textContent).toMatch(/-?\d+[.,]\d+°\s*\/\s*-?\d+[.,]\d+°/);

    fireEvent.pointerOut(vina);
    expect(tooltip).toHaveAttribute('hidden');
  });

  test('an unread comuna says so in the tooltip instead of inventing a level', () => {
    render(<MapPanel {...baseProps()} />);

    fireEvent.pointerOver(screen.getByRole('button', { name: 'Valparaíso (05101)' }));

    const tooltip = document.querySelector('.map-3d-tooltip');
    expect(tooltip?.textContent).toContain('Sin lote publicado');
    expect(tooltip?.textContent).not.toMatch(/BAJO|MEDIO|ALTO/);
  });

  test('click, Enter and Space still select through the 3D vector layer', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<MapPanel {...baseProps({ onSelect })} />);

    const vina = screen.getByRole('button', { name: 'Viña del Mar (05102)' });
    await user.click(vina);
    expect(onSelect).toHaveBeenLastCalledWith('05102');

    fireEvent.keyDown(vina, { key: 'Enter' });
    expect(onSelect).toHaveBeenLastCalledWith('05102');
    fireEvent.keyDown(vina, { key: ' ' });
    expect(onSelect).toHaveBeenLastCalledWith('05102');
    expect(onSelect).toHaveBeenCalledTimes(3);
  });

  test('the selected comuna keeps its aqua outline class in the 3D layer', () => {
    render(<MapPanel {...baseProps({ selectedCode: '05102', zoneLevels: rememberedLevels({ '05102': 'alto' }) })} />);

    const selected = screen.getByRole('button', { name: 'Viña del Mar (05102)' });
    expect(selected).toHaveClass('zone-shape', 'level-alto', 'zone-selected');
    expect(selected).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('3D aerial stage: real catalogue and empty states', () => {
  test('all 38 served communes stay selectable in the 3D layer (36 continental + 2 islands)', () => {
    const fixturePath = resolve(process.cwd(), '../backend/contracts/gen/geo/valparaiso-comunas.geojson');
    const raw = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      features: Array<{ geometry: ZoneFeature['geometry']; properties: { CUT_COM: string; COMUNA: string; PROVINCIA: string } }>;
    };
    const collection: ZoneCollection = {
      type: 'FeatureCollection',
      features: raw.features.map(feature => ({
        type: 'Feature',
        geometry: feature.geometry,
        properties: { code: feature.properties.CUT_COM, name: feature.properties.COMUNA, province: feature.properties.PROVINCIA },
      })),
    };

    render(<MapPanel {...baseProps({ collection, selectedCode: '05101' })} />);

    expect(mainlandSvg().querySelectorAll('path.zone-shape')).toHaveLength(36);
    const insets = document.getElementById('map-insets');
    expect(insets).not.toBeNull();
    expect(insets).toHaveAttribute('aria-label', INSETS_LABEL);
    expect(insets?.querySelectorAll('path.zone-shape')).toHaveLength(2);

    const captions = [...(insets?.querySelectorAll('figcaption') ?? [])].map(node => node.textContent ?? '');
    expect(captions).toHaveLength(2);
    expect(captions.join(' ')).toContain('Juan Fernández');
    expect(captions.join(' ')).toContain('Isla de Pascua');

    // 38 commune buttons, each one the accessible name of a real catalogue row.
    const buttons = [...document.querySelectorAll<HTMLElement>('path.zone-shape')];
    expect(buttons).toHaveLength(38);
    for (const button of buttons) {
      expect(button.getAttribute('role')).toBe('button');
      expect(button.getAttribute('aria-label')).toMatch(/\(.+\)$/);
    }
    expect(screen.getByRole('button', { name: /Isla de Pascua \(05201\)/ })).toBeInTheDocument();
  });

  test('without a 2D context the stage degrades to its vector layer instead of throwing', () => {
    // jsdom has no canvas implementation. A sized element is forced so the effect
    // really reaches `getContext` and meets the null the browserless environment
    // returns: the stage must survive it with its vector layer intact.
    const rect = { width: 900, height: 520, top: 0, left: 0, right: 900, bottom: 520, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(rect);

    expect(() => render(<MapPanel {...baseProps()} />)).not.toThrow();
    expect(document.querySelector('canvas.map-3d-canvas')).not.toBeNull();
    expect(HTMLCanvasElement.prototype.getContext).toBeDefined();
    expect(mainlandSvg().querySelectorAll('path.zone-shape')).toHaveLength(2);
  });

  test('an empty catalogue keeps the honest empty state and offers no camera', () => {
    render(<MapPanel {...baseProps({ collection: EMPTY_CATALOGUE })} />);

    expect(document.getElementById('map-empty')?.textContent).toBe('El catálogo de zonas no informa geometrías: no hay nada que dibujar.');
    expect(screen.queryByRole('button', { name: 'Acercar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Vista 3D' })).toBeNull();
    expect(document.querySelector('canvas.map-3d-canvas')).toBeNull();
    expect(mainlandSvg()).toHaveAttribute('hidden');
  });

  test('the island-only catalogue keeps the mainland hidden and still renders the 3D insets', () => {
    const islandOnly: ZoneCollection = { type: 'FeatureCollection', features: [JUAN_FERNANDEZ] };
    render(<MapPanel {...baseProps({ collection: islandOnly })} />);

    expect(mainlandSvg()).toHaveAttribute('hidden');
    expect(document.getElementById('map-empty')).toHaveTextContent(
      'El catálogo no informa geometrías continentales; se muestran solo los territorios insulares.',
    );
    const insets = document.getElementById('map-insets');
    expect(insets).not.toBeNull();
    expect(within(insets as HTMLElement).getByRole('button', { name: 'Juan Fernández (05104)' })).toBeInTheDocument();
  });
});

// ── Real-browser defects ───────────────────────────────────────────────────
//
// Two defects that only a real browser shows, pinned so the stage cannot bring
// them back:
//   * `setPointerCapture` on `pointerdown` retargets the following `pointerup` AND
//     the trailing `click` to the capturing stage, so a clean tap never reached the
//     comuna `<path>` under the finger;
//   * a container resize moved the SVG (viewBox + preserveAspectRatio) but left the
//     Canvas 2D bitmap stretched until the next interaction asked for a frame.

// jsdom implements neither pointer-capture method, so the spies are installed on
// the real prototype: the assertion then measures the component, not the harness.
function pointerCaptureSpy() {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  for (const name of ['setPointerCapture', 'releasePointerCapture', 'hasPointerCapture']) {
    if (typeof proto[name] !== 'function') {
      Object.defineProperty(Element.prototype, name, { configurable: true, writable: true, value: () => undefined });
    }
  }
  return vi.spyOn(Element.prototype, 'setPointerCapture');
}

function boxRect(width: number, height: number): DOMRect {
  return { width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
}

// A 2D context stub: the scene only ever calls these members, and property writes
// (`fillStyle`, `shadowBlur`, …) land on the plain object.
function stub2dContext() {
  const gradient = { addColorStop: vi.fn() };
  return {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillRect: vi.fn(),
    setTransform: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    fillText: vi.fn(),
    createLinearGradient: vi.fn(() => gradient),
    createRadialGradient: vi.fn(() => gradient),
  };
}

// jsdom has no ResizeObserver, so its absence is exactly what the component sees
// today: the fake one is what turns "the container changed size" into an event the
// test can fire.
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly observed: Element[] = [];
  private readonly notify: ResizeObserverCallback;

  constructor(notify: ResizeObserverCallback) {
    this.notify = notify;
    FakeResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.observed.push(target);
  }

  unobserve(): void {}

  disconnect(): void {
    this.observed.length = 0;
  }

  trigger(): void {
    this.notify([], this as unknown as ResizeObserver);
  }
}

describe('3D aerial stage: pointer capture and canvas repaint', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeResizeObserver.instances = [];
  });

  test('a stationary tap selects the comuna exactly once and never captures the pointer', () => {
    const onSelect = vi.fn();
    render(<MapPanel {...baseProps({ onSelect })} />);

    const capture = pointerCaptureSpy();
    const vina = screen.getByRole('button', { name: 'Viña del Mar (05102)' });

    fireEvent.pointerDown(vina, { pointerId: 7, button: 0, clientX: 120, clientY: 90 });
    // Capturing here is what real Chromium/Firefox use to retarget the release: a
    // tap that has not moved yet must NOT capture.
    expect(capture).not.toHaveBeenCalled();

    // The release a capturing ancestor would receive instead of the `<path>`.
    fireEvent.pointerUp(stageSurface(), { pointerId: 7, clientX: 120, clientY: 90 });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('05102');

    // The browser still delivers its own `click` after the release; it must not
    // select the same comuna a second time.
    fireEvent.click(vina);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  test('a drag captures the pointer only past the threshold and never selects', async () => {
    const onSelect = vi.fn();
    render(<MapPanel {...baseProps({ onSelect })} />);

    const capture = pointerCaptureSpy();
    const surface = stageSurface();
    const vina = screen.getByRole('button', { name: 'Viña del Mar (05102)' });

    fireEvent.pointerDown(vina, { pointerId: 11, button: 0, clientX: 100, clientY: 100 });

    // Sub-threshold movement is still a tap: nothing is captured, so a release here
    // would still reach the comuna.
    fireEvent.pointerMove(surface, { pointerId: 11, clientX: 101, clientY: 101 });
    expect(capture).not.toHaveBeenCalled();

    // Crossing the threshold turns the gesture into a camera drag; only then is
    // capture safe, because a drag never resolves to a click on the comuna.
    await act(async () => {
      fireEvent.pointerMove(surface, { pointerId: 11, clientX: 140, clientY: 130 });
      // The camera mutation is coalesced into a requestAnimationFrame.
      await new Promise(resolve => setTimeout(resolve, 40));
    });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.contexts[0]).toBe(surface);

    fireEvent.pointerUp(surface, { pointerId: 11, clientX: 140, clientY: 130 });
    expect(onSelect).not.toHaveBeenCalled();

    // The trailing click of a drag belongs to the camera move, not to a selection.
    fireEvent.click(vina);
    expect(onSelect).not.toHaveBeenCalled();
  });

  test('a container resize repaints the Canvas 2D scene at the new size', async () => {
    const context = stub2dContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);

    let box = boxRect(900, 520);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => box);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);

    render(<MapPanel {...baseProps()} />);

    const canvas = document.querySelector<HTMLCanvasElement>('canvas.map-3d-canvas');
    expect(canvas).not.toBeNull();

    // The first frame is painted for the measured stage.
    await waitFor(() => expect(context.fillRect).toHaveBeenCalled());
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 40));
    });
    expect(canvas?.width).toBe(900);
    const before = context.fillRect.mock.calls.length;
    expect(before).toBeGreaterThan(0);
    context.fillRect.mockClear();

    // The observer is watching the stage itself, which is the box the canvas fills.
    const observer = FakeResizeObserver.instances[0];
    expect(observer).toBeDefined();
    expect(observer.observed).toContain(stageSurface());

    // A new aspect ratio arrives with no pointer, keyboard or camera interaction.
    box = boxRect(1180, 640);
    await act(async () => {
      observer.trigger();
    });

    // The scene must repaint immediately instead of leaving a stale, stretched bitmap.
    await waitFor(() => expect(context.fillRect).toHaveBeenCalled());
    expect(canvas?.width).toBe(1180);
    expect(canvas?.height).toBe(640);
  });
});
