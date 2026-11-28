import { render, within } from '@testing-library/react';

import { NOT_IMPLEMENTED, PendingView } from '../../src/views/PendingView';

// N8 — the inventory of capabilities the retired mockup offered and the backend
// cannot back. Declaring them is part of the delivery: every entry is stated,
// never simulated, and the view must not expose a control that would offer any
// of them. The suite reads the exported list instead of a copy so the row count
// assertion can never drift from what the view actually renders.
//
// V1-P-05 empties the inventory: the last capability it declared has been
// delivered, so the page states an empty inventory instead of a row. The suite
// pins that state — zero entries, one accessible empty-state row, a count of 0 —
// because a page that keeps claiming an absence after the backend answers it is
// as wrong as one that hides an absence it still has.

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
  // With no row left, the panel states the empty inventory instead of repeating
  // the "not implemented" badge over nothing.
  expect(document.getElementById('pending-badge')).toHaveTextContent(/sin filas abiertas/i);
  expect(document.getElementById('pending-badge')).not.toHaveTextContent(/NO IMPLEMENTADO/i);
});

test('an empty inventory renders one accessible empty-state row and no capability row', () => {
  render(<PendingView />);

  const tbody = document.getElementById('pending-rows') as HTMLElement | null;
  expect(tbody).not.toBeNull();

  const rendered = [...(tbody as HTMLElement).querySelectorAll('tr')];
  expect(NOT_IMPLEMENTED).toHaveLength(0);
  // A zero-row table is not a silent table: the body states the inventory is
  // empty, in one row that spans the three columns of the head.
  expect(rendered).toHaveLength(1);
  const cells = [...rendered[0].querySelectorAll('td')];
  expect(cells).toHaveLength(1);
  expect(cells[0]).toHaveAttribute('colspan', '3');
  expect(cells[0].textContent?.trim()).toMatch(/ninguna capacidad/i);
  expect(cells[0].children).toHaveLength(0);
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

// V1-P-05 — the last row leaves the inventory. `GET /v1/risk/sources` now publishes
// the closed five-finding quality catalogue, `POST
// /v1/risk/sources/{source_id}/review` records a review and `#sources` renders both,
// so the capability the row declared absent is answered and the list is EMPTY. The
// expected capability set is the empty list, which is the real count, not a stale
// copy of an older total.
const EXPECTED_CAPABILITIES: string[] = [];

// The real count every retirement test pins: the exported list, the rendered
// capability rows and the head's badge agree on zero.
function expectEmptyInventory(): void {
  render(<PendingView />);

  const tbody = document.getElementById('pending-rows') as HTMLElement | null;
  expect(tbody).not.toBeNull();
  const rows = [...(tbody as HTMLElement).querySelectorAll('tr')];
  const capabilities = rows
    .map(row => row.querySelector('td')?.textContent?.trim() ?? '')
    .filter(text => text !== '' && !/ninguna capacidad/i.test(text));

  expect(capabilities).toEqual(EXPECTED_CAPABILITIES);
  expect(NOT_IMPLEMENTED).toHaveLength(0);
  expect(capabilities).toHaveLength(0);
  expect(document.getElementById('pending-count')).toHaveTextContent('0');
}

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
  const capabilities = [...(tbody as HTMLElement).querySelectorAll('tr')].map(
    row => row.querySelector('td')?.textContent?.trim() ?? '',
  );

  expect(NOT_IMPLEMENTED.map(entry => entry.capability)).not.toContain(RETIRED_ALL_ZONES_CAPABILITY);
  expect(capabilities).not.toContain(RETIRED_ALL_ZONES_CAPABILITY);
  expect(document.getElementById('pending-rows')).not.toHaveTextContent(/historial de todas las zonas/i);

  expect(EXPECTED_CAPABILITIES).toHaveLength(0);
  expect(NOT_IMPLEMENTED).toHaveLength(0);
});

// V1-P-06 — the three G6 actions exist as authenticated endpoints with a role
// gate, the page offers them, so the row that declared «Publicar lote, avance
// manual y reevaluación» an absence leaves the inventory.
const RETIRED_MANUAL_PUBLISH_CAPABILITY = 'Publicar lote, avance manual y reevaluación';

test('the retired manual publish entry is gone and the count is the real one (V1-P-06)', () => {
  render(<PendingView />);

  const tbody = document.getElementById('pending-rows') as HTMLElement | null;
  expect(tbody).not.toBeNull();
  const capabilities = [...(tbody as HTMLElement).querySelectorAll('tr')].map(
    row => row.querySelector('td')?.textContent?.trim() ?? '',
  );

  expect(NOT_IMPLEMENTED.map(entry => entry.capability)).not.toContain(RETIRED_MANUAL_PUBLISH_CAPABILITY);
  expect(capabilities).not.toContain(RETIRED_MANUAL_PUBLISH_CAPABILITY);
  expect(document.getElementById('pending-rows')).not.toHaveTextContent(/no existe endpoint/i);

  // The real count, which V1-P-05 leaves at zero.
  expect(NOT_IMPLEMENTED).toHaveLength(0);
  expect(document.getElementById('pending-count')).toHaveTextContent('0');
});

// V1-P-03 — the owner's ratified decision keeps the eight frozen states and
// publishes their canonical projection as four stage groups (`stage_group`),
// rendered as the chips of `#actions`, so the row that declared «Estados
// candidate, in_progress, reviewed y closed» an absence leaves the inventory.
const RETIRED_STAGE_PROJECTION_CAPABILITY = 'Estados candidate, in_progress, reviewed y closed';

test('the retired stage projection entry is gone and the count is the real one (V1-P-03)', () => {
  render(<PendingView />);

  const tbody = document.getElementById('pending-rows') as HTMLElement | null;
  expect(tbody).not.toBeNull();
  const capabilities = [...(tbody as HTMLElement).querySelectorAll('tr')].map(
    row => row.querySelector('td')?.textContent?.trim() ?? '',
  );

  expect(NOT_IMPLEMENTED.map(entry => entry.capability)).not.toContain(RETIRED_STAGE_PROJECTION_CAPABILITY);
  expect(capabilities).not.toContain(RETIRED_STAGE_PROJECTION_CAPABILITY);
  expect(document.getElementById('pending-rows')).not.toHaveTextContent(/esos cuatro estados no existen/i);

  expect(NOT_IMPLEMENTED).toHaveLength(0);
  expect(document.getElementById('pending-count')).toHaveTextContent('0');
});

// V1-P-02 / PM-11 — the ratified five-category weighting and the regional
// priority context are served by the risk reads and rendered by the zone detail
// card and the infrastructure view, so the row that declared «Contexto y
// prioridad por sector» an absence leaves the inventory.
const RETIRED_PRIORITY_CONTEXT_CAPABILITY = 'Contexto y prioridad por sector';

test('the retired priority context entry is gone and the count is the real one (V1-P-02 / PM-11)', () => {
  render(<PendingView />);

  const tbody = document.getElementById('pending-rows') as HTMLElement | null;
  expect(tbody).not.toBeNull();
  const capabilities = [...(tbody as HTMLElement).querySelectorAll('tr')].map(
    row => row.querySelector('td')?.textContent?.trim() ?? '',
  );

  expect(NOT_IMPLEMENTED.map(entry => entry.capability)).not.toContain(RETIRED_PRIORITY_CONTEXT_CAPABILITY);
  expect(capabilities).not.toContain(RETIRED_PRIORITY_CONTEXT_CAPABILITY);
  expect(document.getElementById('pending-rows')).not.toHaveTextContent(/no calcula prioridad regional/i);

  expect(NOT_IMPLEMENTED).toHaveLength(0);
  expect(document.getElementById('pending-count')).toHaveTextContent('0');
});

// V1-P-01 / PM-12 — the coverage and environment row left the inventory before
// V1-P-05 emptied it, and the land-cover layer it declared absent is still served
// (`GET /v1/risk/vegetation` plus the `land_cover` member of `latest`/`batches`).
const RETIRED_COVERAGE_CAPABILITY = 'Cobertura y entorno por sector';

test('the retired coverage entry is gone and the count is the real one (V1-P-01 / PM-12)', () => {
  render(<PendingView />);

  const tbody = document.getElementById('pending-rows') as HTMLElement | null;
  expect(tbody).not.toBeNull();
  const capabilities = [...(tbody as HTMLElement).querySelectorAll('tr')].map(
    row => row.querySelector('td')?.textContent?.trim() ?? '',
  );

  expect(NOT_IMPLEMENTED.map(entry => entry.capability)).not.toContain(RETIRED_COVERAGE_CAPABILITY);
  expect(capabilities).not.toContain(RETIRED_COVERAGE_CAPABILITY);
  expect(document.getElementById('pending-rows')).not.toHaveTextContent(/no publica cobertura ni entorno/i);
  expect(document.getElementById('pending-rows')).not.toHaveTextContent(/Tabla de sectores/);

  expect(NOT_IMPLEMENTED).toHaveLength(0);
  expect(document.getElementById('pending-count')).toHaveTextContent(String(NOT_IMPLEMENTED.length));
});

// V1-P-05 — the row that declared «Revisar e incorporar registros, y hallazgos de
// calidad» an absence leaves the inventory: the closed five-finding catalogue is
// published by `GET /v1/risk/sources`, `POST
// /v1/risk/sources/{source_id}/review` records the review with the verified actor,
// and `#sources` renders both. Both halves are pinned, and the inventory is empty.
const RETIRED_SOURCE_REVIEW_CAPABILITY = 'Revisar e incorporar registros, y hallazgos de calidad';

test('the retired source review entry is gone and the inventory is empty (V1-P-05)', () => {
  render(<PendingView />);

  const tbody = document.getElementById('pending-rows') as HTMLElement | null;
  expect(tbody).not.toBeNull();
  const capabilities = [...(tbody as HTMLElement).querySelectorAll('tr')].map(
    row => row.querySelector('td')?.textContent?.trim() ?? '',
  );

  // Gone from the exported list and from the rendering: a leftover copy would
  // claim an absence the backend no longer has.
  expect(NOT_IMPLEMENTED.map(entry => entry.capability)).not.toContain(RETIRED_SOURCE_REVIEW_CAPABILITY);
  expect(capabilities).not.toContain(RETIRED_SOURCE_REVIEW_CAPABILITY);
  expect(document.getElementById('pending-rows')).not.toHaveTextContent(/no existe un catálogo de hallazgos/i);

  // The real count is zero, stated by the list, the body and the head.
  expectEmptyInventory();
  expect(document.getElementById('pending-count')).toHaveTextContent('0');
  expect(document.getElementById('pending-status')).toHaveTextContent(/ninguna capacidad/i);
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
// count is the one the list really carries — zero after V1-P-05 — not the board's
// seven, and the board's links to prototype screens are not ported: this page
// states absence and offers no control that would imply the capability exists.
test('the inventory states its real count and scope without adding a control (T7)', () => {
  render(<PendingView />);

  const head = document.getElementById('pending-head');
  expect(head).not.toBeNull();
  expect(head?.querySelector('h2#pending-title')).not.toBeNull();
  expect(head?.querySelector('.eyebrow')).toHaveTextContent('ALCANCE DE ESTA ENTREGA');
  expect(head).toHaveTextContent(/sin respaldo en el backend actual/i);
  expect(head).toHaveTextContent('Solo lectura');

  // The count is the exported list's own length: a stale number would be a false
  // statement about the delivery.
  expect(document.getElementById('pending-count')).toHaveTextContent(String(NOT_IMPLEMENTED.length));
  expect(document.getElementById('pending-count')).toHaveTextContent('0');
  expect(head).toHaveTextContent(String(NOT_IMPLEMENTED.length));

  // R6: an entry leaves THIS inventory when the contract and the backend back it;
  // it is not the code that closes the ODD row, which stays a human acceptance.
  expect(head).toHaveTextContent(/retiró del inventario/i);
  expect(head).toHaveTextContent(/contrato y el backend/i);
  expect(head).toHaveTextContent(/aceptación/i);
  expect(head).not.toHaveTextContent(/se cerró/i);
  expect(document.getElementById('pending-note')).toHaveTextContent(/no cierra ninguna fila/i);
  // Still nothing to press or follow: the inventory is a statement.
  expect(document.querySelectorAll('#pending button, #pending a, #pending summary')).toHaveLength(0);
});
