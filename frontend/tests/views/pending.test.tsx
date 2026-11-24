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
// entry that declared the opposite has left this inventory. Retiring a capability
// is a one-row operation: the test pins both halves of it, the absence of the
// retired entry and the untouched order of the rows that survive around it.
const RETIRED_AUDIT_CAPABILITY = 'Nombre del actor, detalle libre e id de evento';

const EXPECTED_CAPABILITIES = [
  'Cobertura y entorno por sector',
  'Contexto y prioridad por sector',
  'Estados candidate, in_progress, reviewed y closed',
  'Historial de todas las zonas',
  'Revisar e incorporar registros, y hallazgos de calidad',
  'Publicar lote, avance manual y reevaluación',
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

  // Nothing else moved: same six capabilities, same order. A retirement that also
  // dropped, reordered or rewrote a neighbour is the regression this catches.
  expect(capabilities).toEqual(EXPECTED_CAPABILITIES);
  expect(NOT_IMPLEMENTED).toHaveLength(EXPECTED_CAPABILITIES.length);

  // The two rows that used to surround the retired entry keep their full cells.
  const last = [...rows[rows.length - 1].querySelectorAll('td')].map(cell => cell.textContent?.trim());
  expect(last).toEqual([
    'Publicar lote, avance manual y reevaluación',
    'No existe endpoint: el servidor decide y publica por su cuenta; la página solo solicita el trabajo y lee el resultado.',
    'Procesamiento asíncrono',
  ]);
  const first = [...rows[0].querySelectorAll('td')].map(cell => cell.textContent?.trim());
  expect(first).toEqual([
    'Cobertura y entorno por sector',
    'La API no publica cobertura ni entorno por comuna: solo el catálogo, el lote publicado y sus factores.',
    'Tabla de sectores',
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
