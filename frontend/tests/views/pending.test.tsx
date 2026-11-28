import { render, within } from '@testing-library/react';

import { NOT_IMPLEMENTED, PendingView } from '../../src/views/PendingView';

// N8 — the inventory of capabilities the retired mockup offered and the backend
// cannot back. Declaring them is part of the delivery: every entry is stated,
// never simulated, and the view must not expose a control that would offer any
// of them. The suite reads the exported list instead of a copy so the row count
// assertion can never drift from what the view actually renders.

test('the section carries id="pending", data-view="pending" and the legacy anchors', () => {
  const { container } = render(<PendingView />);

  const section = container.querySelector('section#pending') as HTMLElement | null;
  expect(section).toBeInTheDocument();
  expect(section).toHaveAttribute('data-view', 'pending');

  // These are the five identifiers the retired harness resolved by id; losing
  // any of them is a silent regression, not a cosmetic change.
  for (const id of ['pending-title', 'pending-badge', 'pending-status', 'pending-rows']) {
    expect(document.getElementById(id)).not.toBeNull();
  }
  // The panel states its own status instead of leaving the absence implicit.
  expect(document.getElementById('pending-badge')).toHaveTextContent(/NO IMPLEMENTADO/i);
});

test('every capability in the exported list renders as a row with its three columns filled', () => {
  render(<PendingView />);

  const tbody = document.getElementById('pending-rows') as HTMLElement | null;
  expect(tbody).not.toBeNull();

  const rows = tbody as HTMLElement;
  const rendered = [...rows.querySelectorAll('tr')];
  expect(rendered).toHaveLength(NOT_IMPLEMENTED.length);

  rendered.forEach((row, index) => {
    const expected = NOT_IMPLEMENTED[index];
    const cells = [...row.querySelectorAll('td')];

    expect(cells).toHaveLength(3);
    expect(cells[0]).toHaveTextContent(expected.capability);
    expect(cells[1]).toHaveTextContent(expected.reason);
    expect(cells[2]).toHaveTextContent(expected.location);

    for (const cell of cells) {
      expect(cell.textContent?.trim()).not.toBe('');
      // Plain text only: no cell wraps an action or a simulated control.
      expect(cell.children).toHaveLength(0);
    }
  });
});

// PM-10 / V1-P-07 — `GET /v1/audit` now returns the actor name, a free-text
// detail and a per-row event identifier, and the audit view renders them, so the
// entry that declared the opposite has left this inventory. PM-04 removed a
// second row for the same reason: `GET /v1/risk/history/series` answers every
// zone that published in a bounded window, so «Historial de todas las zonas» is
// no longer an absence. Retiring a capability is a one-row operation: the test
// pins both halves of it, the absence of each retired entry and the untouched
// order of the rows that survive around it.
const RETIRED_AUDIT_CAPABILITY = 'Nombre del actor, detalle libre e id de evento';
const RETIRED_ALL_ZONES_CAPABILITY = 'Historial de todas las zonas';

const EXPECTED_CAPABILITIES = [
  'Cobertura y entorno por sector',
  'Revisar e incorporar registros, y hallazgos de calidad',
];

test('the retired audit entry is gone and its neighbouring rows are untouched (PM-10 / V1-P-07)', () => {
  render(<PendingView />);

  const tbody = document.getElementById('pending-rows') as HTMLElement | null;
  expect(tbody).not.toBeNull();
  const rows = [...(tbody as HTMLElement).querySelectorAll('tr')];
  const capabilities = rows.map(row => row.querySelector('td')?.textContent?.trim() ?? '');

  // The delivered audit metadata retired exactly this row, in the list and in the
  // rendering: a leftover copy would claim an absence the backend no longer has.
  expect(NOT_IMPLEMENTED.map(entry => entry.capability)).not.toContain(RETIRED_AUDIT_CAPABILITY);
  expect(capabilities).not.toContain(RETIRED_AUDIT_CAPABILITY);
  expect(document.getElementById('pending-rows')).not.toHaveTextContent(/nombre del actor/i);

  // Nothing else moved: same capabilities, same order. A retirement that also
  // dropped, reordered or rewrote a neighbour is the regression this catches.
  expect(capabilities).toEqual(EXPECTED_CAPABILITIES);
  expect(NOT_IMPLEMENTED).toHaveLength(EXPECTED_CAPABILITIES.length);

  // The two rows that used to surround the retired entry keep their full cells.
  const last = [...rows[rows.length - 1].querySelectorAll('td')].map(cell => cell.textContent?.trim());
  expect(last).toEqual([
    'Revisar e incorporar registros, y hallazgos de calidad',
    'GET /v1/risk/sources publica la procedencia y la integridad reales; no existe un catálogo de hallazgos de calidad. Las acciones preventivas viven ahora en su propia vista (#actions).',
    'Fuentes y procedencia',
  ]);
  const first = [...rows[0].querySelectorAll('td')].map(cell => cell.textContent?.trim());
  expect(first).toEqual([
    'Cobertura y entorno por sector',
    'La API no publica cobertura ni entorno por comuna: solo el catálogo, el lote publicado y sus factores.',
    'Tabla de sectores',
  ]);
});

// PM-04 / V1-P-04 — the series read answers every zone that published in the
// bounded window, so the row that declared «Historial de todas las zonas» an
// absence leaves the inventory. As with the audit retirement above, both halves
// are pinned: the entry is gone from the exported list and from the rendering,
// and the row count is the real one, not a stale copy of the old total.
test('the retired all-zones history entry is gone and the count is the real one (PM-04 / V1-P-04)', () => {
  render(<PendingView />);

  const tbody = document.getElementById('pending-rows') as HTMLElement | null;
  expect(tbody).not.toBeNull();
  const rows = [...(tbody as HTMLElement).querySelectorAll('tr')];
  const capabilities = rows.map(row => row.querySelector('td')?.textContent?.trim() ?? '');

  expect(NOT_IMPLEMENTED.map(entry => entry.capability)).not.toContain(RETIRED_ALL_ZONES_CAPABILITY);
  expect(capabilities).not.toContain(RETIRED_ALL_ZONES_CAPABILITY);
  expect(document.getElementById('pending-rows')).not.toHaveTextContent(/historial de todas las zonas/i);

  // The row count the exported list and the rendering agree on.
  expect(EXPECTED_CAPABILITIES).toHaveLength(2);
  expect(NOT_IMPLEMENTED).toHaveLength(2);
  expect(rows).toHaveLength(2);
  expect(capabilities).toEqual(EXPECTED_CAPABILITIES);
});

// V1-P-06 — the three G6 actions exist as authenticated endpoints with a role
// gate, the page offers them, so the row that declared «Publicar lote, avance
// manual y reevaluación» an absence leaves the inventory. As with the two
// retirements above, both halves are pinned: the entry is gone from the exported
// list and from the rendering, and the row count is the real one — the surviving
// rows, not a stale copy of an older total.
const RETIRED_MANUAL_PUBLISH_CAPABILITY = 'Publicar lote, avance manual y reevaluación';

test('the retired manual publish entry is gone and the count is the real one (V1-P-06)', () => {
  render(<PendingView />);

  const tbody = document.getElementById('pending-rows') as HTMLElement | null;
  expect(tbody).not.toBeNull();
  const rows = [...(tbody as HTMLElement).querySelectorAll('tr')];
  const capabilities = rows.map(row => row.querySelector('td')?.textContent?.trim() ?? '');

  expect(NOT_IMPLEMENTED.map(entry => entry.capability)).not.toContain(RETIRED_MANUAL_PUBLISH_CAPABILITY);
  expect(capabilities).not.toContain(RETIRED_MANUAL_PUBLISH_CAPABILITY);
  expect(document.getElementById('pending-rows')).not.toHaveTextContent(/no existe endpoint/i);

  // The real count: the exported list, the rendered rows and the head's badge all
  // agree, and the surviving order is untouched.
  expect(NOT_IMPLEMENTED).toHaveLength(2);
  expect(rows).toHaveLength(2);
  expect(capabilities).toEqual(EXPECTED_CAPABILITIES);
  expect(document.getElementById('pending-count')).toHaveTextContent('2');
});

// V1-P-03 — the owner's ratified decision keeps the eight frozen states and
// publishes their canonical projection as four stage groups (`stage_group`),
// rendered as the chips of `#actions`, so the row that declared «Estados
// candidate, in_progress, reviewed y closed» an absence leaves the inventory. As
// with every retirement above, both halves are pinned: the entry is gone from the
// exported list and from the rendering, and the remaining three rows keep their
// order, their cells and the head's real count.
const RETIRED_STAGE_PROJECTION_CAPABILITY = 'Estados candidate, in_progress, reviewed y closed';

test('the retired stage projection entry is gone and the count is the real one (V1-P-03)', () => {
  render(<PendingView />);

  const tbody = document.getElementById('pending-rows') as HTMLElement | null;
  expect(tbody).not.toBeNull();
  const rows = [...(tbody as HTMLElement).querySelectorAll('tr')];
  const capabilities = rows.map(row => row.querySelector('td')?.textContent?.trim() ?? '');

  expect(NOT_IMPLEMENTED.map(entry => entry.capability)).not.toContain(RETIRED_STAGE_PROJECTION_CAPABILITY);
  expect(capabilities).not.toContain(RETIRED_STAGE_PROJECTION_CAPABILITY);
  expect(document.getElementById('pending-rows')).not.toHaveTextContent(/esos cuatro estados no existen/i);

  // The real count: two rows, in the order the survivors already had.
  expect(NOT_IMPLEMENTED).toHaveLength(2);
  expect(rows).toHaveLength(2);
  expect(capabilities).toEqual(EXPECTED_CAPABILITIES);
  expect(document.getElementById('pending-count')).toHaveTextContent('2');

  // The first and last surviving rows keep their three filled cells.
  const first = [...rows[0].querySelectorAll('td')].map(cell => cell.textContent?.trim());
  expect(first).toEqual([
    'Cobertura y entorno por sector',
    'La API no publica cobertura ni entorno por comuna: solo el catálogo, el lote publicado y sus factores.',
    'Tabla de sectores',
  ]);
  const last = [...rows[rows.length - 1].querySelectorAll('td')].map(cell => cell.textContent?.trim());
  expect(last).toEqual([
    'Revisar e incorporar registros, y hallazgos de calidad',
    'GET /v1/risk/sources publica la procedencia y la integridad reales; no existe un catálogo de hallazgos de calidad. Las acciones preventivas viven ahora en su propia vista (#actions).',
    'Fuentes y procedencia',
  ]);
});

// V1-P-02 / PM-11 — the ratified five-category weighting and the regional
// priority context are served by the risk reads and rendered by the zone detail
// card and the infrastructure view, so the row that declared «Contexto y
// prioridad por sector» an absence leaves the inventory. As with every retirement
// above, both halves are pinned: the entry is gone from the exported list and from
// the rendering, and the two surviving rows keep their order, their cells and the
// head's real count.
const RETIRED_PRIORITY_CONTEXT_CAPABILITY = 'Contexto y prioridad por sector';

test('the retired priority context entry is gone and the count is the real one (V1-P-02 / PM-11)', () => {
  render(<PendingView />);

  const tbody = document.getElementById('pending-rows') as HTMLElement | null;
  expect(tbody).not.toBeNull();
  const rows = [...(tbody as HTMLElement).querySelectorAll('tr')];
  const capabilities = rows.map(row => row.querySelector('td')?.textContent?.trim() ?? '');

  expect(NOT_IMPLEMENTED.map(entry => entry.capability)).not.toContain(RETIRED_PRIORITY_CONTEXT_CAPABILITY);
  expect(capabilities).not.toContain(RETIRED_PRIORITY_CONTEXT_CAPABILITY);
  expect(document.getElementById('pending-rows')).not.toHaveTextContent(/no calcula prioridad regional/i);

  // The real count: two rows, and the surviving order is the one they had around
  // the retired entry.
  expect(NOT_IMPLEMENTED).toHaveLength(2);
  expect(rows).toHaveLength(2);
  expect(capabilities).toEqual([
    'Cobertura y entorno por sector',
    'Revisar e incorporar registros, y hallazgos de calidad',
  ]);
  expect(document.getElementById('pending-count')).toHaveTextContent('2');

  // Neither surviving row was dropped, reordered or rewritten.
  const first = [...rows[0].querySelectorAll('td')].map(cell => cell.textContent?.trim());
  expect(first).toEqual([
    'Cobertura y entorno por sector',
    'La API no publica cobertura ni entorno por comuna: solo el catálogo, el lote publicado y sus factores.',
    'Tabla de sectores',
  ]);
  const last = [...rows[rows.length - 1].querySelectorAll('td')].map(cell => cell.textContent?.trim());
  expect(last).toEqual([
    'Revisar e incorporar registros, y hallazgos de calidad',
    'GET /v1/risk/sources publica la procedencia y la integridad reales; no existe un catálogo de hallazgos de calidad. Las acciones preventivas viven ahora en su propia vista (#actions).',
    'Fuentes y procedencia',
  ]);
});

test('the view offers no button, link or interactive control for any listed capability', () => {
  const { container } = render(<PendingView />);

  const view = within(container);
  expect(view.queryByRole('button')).toBeNull();
  expect(view.queryByRole('link')).toBeNull();

  const interactive = container.querySelectorAll(
    'button, a, input, select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="switch"], [role="tab"], [role="menuitem"]',
  );
  expect(interactive).toHaveLength(0);
});

// ── T7 — board 19's head, with the real count and no prototype links ───────
// Board 19 opens the inventory with its scope and its count. The production
// count is the four rows the list really carries, not the board's seven, and the
// board's links to prototype screens are not ported: this page states absences
// and offers no control that would imply the capability exists.
test('the inventory states its real count and scope without adding a control (T7)', () => {
  render(<PendingView />);

  const head = document.getElementById('pending-head');
  expect(head).not.toBeNull();
  expect(head?.querySelector('h2#pending-title')).not.toBeNull();
  expect(head?.querySelector('.eyebrow')).toHaveTextContent('ALCANCE DE ESTA ENTREGA');
  expect(head).toHaveTextContent(/no tienen respaldo en el backend actual/i);
  expect(head).toHaveTextContent('Solo lectura');

  // The count is the exported list's own length: a stale number would be a false
  // statement about the delivery.
  expect(document.getElementById('pending-count')).toHaveTextContent(String(NOT_IMPLEMENTED.length));
  expect(head).toHaveTextContent(String(NOT_IMPLEMENTED.length));

  expect(document.getElementById('pending-note')).toHaveTextContent(/no cierra ninguna fila/i);
  // Still nothing to press or follow: the inventory is a statement.
  expect(document.querySelectorAll('#pending button, #pending a, #pending summary')).toHaveLength(0);
});
