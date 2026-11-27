// PM-01 — the executive panel.
//
// The component is presentational, so every case here is a state the view can
// hand it: the populated summary, the empty one, a stated failure and a pending
// read. No fetch is stubbed because the panel issues none: what it renders is
// exactly what the server answered, and the suite asserts the counts it was
// given rather than recomputing them.

import { render, screen, within } from '@testing-library/react';

import {
  CRITICAL_RULE,
  ExecutivePanel,
  RULE_TAG,
  SYNTHETIC_TAG,
} from '../../src/components/executive/ExecutivePanel';
import type { ExecutiveSummary } from '../../src/core/api';

function summary(overrides: Partial<ExecutiveSummary> = {}): ExecutiveSummary {
  return {
    coverage: { catalogue_zones: 38, zones_without_batch: 2, stale_zones: 3, demo_zones: 0 },
    levels: { alto: 5, medio: 9, bajo: 20, desconocido: 4 },
    delta: {
      zones_compared: 30,
      zones_changed: 7,
      zones_without_previous: 4,
      zones_incomparable: 4,
      transitions: [
        { from: 'medio', to: 'alto', zones: 4 },
        { from: 'bajo', to: 'medio', zones: 3 },
      ],
    },
    // Deliberately not the order a page would sort by: the server's own order is
    // the order the panel must show.
    predominant_variables: [
      { name: 'viento', zones: 6 },
      { name: 'temperatura', zones: 12 },
    ],
    critical_zones: { count: 2, zone_ids: ['05101', '05102'] },
    active_alerts: { count: 4 },
    ...overrides,
  };
}

function textOf(id: string): string {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing DOM ${id}`);
  return node.textContent ?? '';
}

function listItems(name: string): string[] {
  return within(screen.getByRole('list', { name }))
    .getAllByRole('listitem')
    .map((item) => item.textContent ?? '');
}

test('a served summary renders every count the server answered, without recomputing any of them', () => {
  render(<ExecutivePanel state={{ kind: 'ready', summary: summary() }} />);

  // The hierarchy the view establishes: the panel is a region labelled by its own
  // level-3 heading, and each block below is a level-4 section.
  expect(screen.getByRole('heading', { level: 3, name: 'Panel ejecutivo' })).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Panel ejecutivo' })).toBeInTheDocument();
  for (const name of ['Cobertura', 'Niveles', 'Variación reciente', 'Variables predominantes', 'Zonas críticas', 'Alertas registradas']) {
    expect(screen.getByRole('heading', { level: 4, name })).toBeInTheDocument();
  }

  expect(textOf('executive-coverage-catalogue')).toBe('38');
  expect(textOf('executive-coverage-without-batch')).toBe('2');
  expect(textOf('executive-coverage-stale')).toBe('3');
  expect(textOf('executive-coverage-demo')).toBe('0');

  expect(textOf('executive-level-alto')).toBe('5');
  expect(textOf('executive-level-medio')).toBe('9');
  expect(textOf('executive-level-bajo')).toBe('20');
  expect(textOf('executive-level-desconocido')).toBe('4');

  expect(textOf('executive-delta-compared')).toBe('30');
  expect(textOf('executive-delta-changed')).toBe('7');
  expect(textOf('executive-delta-without-previous')).toBe('4');
  expect(textOf('executive-delta-incomparable')).toBe('4');

  // Transitions are named as from → to plus the zone count, and the variables
  // keep the order the server returned: 6 zones of viento precede 12 of
  // temperatura because the payload said so, not because of a local sort.
  expect(listItems('Transiciones')).toEqual(['MEDIO → ALTO: 4 zonas', 'BAJO → MEDIO: 3 zonas']);
  expect(listItems('Variables predominantes')).toEqual(['viento: 6 zonas', 'temperatura: 12 zonas']);
});

test('critical zones carry D-B as its own label and use the catalogue name only when it has one', () => {
  render(
    <ExecutivePanel
      state={{ kind: 'ready', summary: summary() }}
      zoneNames={new Map([['05101', 'Valparaíso']])}
    />,
  );

  expect(textOf('executive-critical-rule')).toBe(CRITICAL_RULE);
  expect(CRITICAL_RULE).toBe('Alto en los dos últimos lotes');
  expect(textOf('executive-critical-count')).toBe('2');
  expect(textOf('executive-critical-count')).not.toBe('4');
  // A named zone is shown by name; a zone the catalogue does not name keeps the
  // identifier the summary sent instead of an invented label.
  expect(listItems('Zonas críticas')).toEqual(['Valparaíso', '05102']);
  // The rule and the count are text, not only a colour: the label above the list
  // states what "critical" means here.
  expect(textOf('executive-panel')).toMatch(/dos últimos lotes publicados/);
});

test('the alert count is the registered total and links to the notification centre', () => {
  render(<ExecutivePanel state={{ kind: 'ready', summary: summary() }} />);

  expect(textOf('executive-alerts-count')).toBe('4');
  expect(textOf('executive-alerts-count')).not.toBe('0');
  const link = document.getElementById('executive-alert-link');
  expect(link).not.toBeNull();
  expect(link?.tagName).toBe('A');
  expect(link?.getAttribute('href')).toBe('#notifications');
  expect(link?.textContent).toBe('Centro de notificaciones');
  // The member is a stored-row count, and the panel says so: no unread badge and
  // no dismissed state are implied anywhere in the block.
  const note = textOf('executive-alerts-note');
  expect(note).toMatch(/\/v1\/risk\/alerts/);
  expect(note).toMatch(/ni de descartada/);
});

test('the empty summary is rendered as real zeros, with named empty lists instead of blank ones', () => {
  render(
    <ExecutivePanel
      state={{
        kind: 'ready',
        summary: summary({
          coverage: { catalogue_zones: 0, zones_without_batch: 0, stale_zones: 0, demo_zones: 0 },
          levels: { alto: 0, medio: 0, bajo: 0, desconocido: 0 },
          delta: {
            zones_compared: 0,
            zones_changed: 0,
            zones_without_previous: 0,
            zones_incomparable: 0,
            transitions: [],
          },
          predominant_variables: [],
          critical_zones: { count: 0, zone_ids: [] },
          active_alerts: { count: 0 },
        }),
      }}
    />,
  );

  // Zero is a measurement the server made, so it is shown - unlike an unknown,
  // which this component never receives as a number.
  expect(textOf('executive-coverage-catalogue')).toBe('0');
  expect(textOf('executive-level-alto')).toBe('0');
  expect(textOf('executive-critical-count')).toBe('0');
  expect(textOf('executive-alerts-count')).toBe('0');
  expect(within(screen.getByRole('region', { name: 'Alertas registradas' })).getByText(/alertas registradas/)).toBeInTheDocument();

  expect(listItems('Transiciones')).toEqual(['Sin transiciones entre lotes comparables.']);
  expect(listItems('Variables predominantes')).toEqual(['Sin variables predominantes en el resumen recibido.']);
  expect(listItems('Zonas críticas')).toEqual(['Ninguna zona cumple la regla en el resumen recibido.']);
});

test('a failed read is stated inline and shows no number it did not receive', () => {
  render(
    <ExecutivePanel
      state={{ kind: 'failed', message: 'No se pudo consultar el resumen ejecutivo (HTTP 503).' }}
    />,
  );

  expect(textOf('executive-status')).toBe('No se pudo consultar el resumen ejecutivo (HTTP 503).');
  // No block is rendered, so no zero stands in for the failed read: "0 alerts"
  // and "the summary could not be read" are different answers.
  expect(document.getElementById('executive-coverage')).toBeNull();
  expect(document.getElementById('executive-critical-count')).toBeNull();
  expect(document.getElementById('executive-alerts-count')).toBeNull();
  expect(screen.queryByText('0')).toBeNull();
  // The section still names itself and its rule, so the failure is scoped and
  // readable instead of an empty card.
  expect(screen.getByRole('heading', { level: 3, name: 'Panel ejecutivo' })).toBeInTheDocument();
  expect(textOf('executive-rule-tag')).toBe(RULE_TAG);
  expect(textOf('executive-panel-note')).toMatch(/regla propia\s+activa|regla propia activa/i);
});

test('a pending read states that it is consulting and never renders a placeholder number', () => {
  render(<ExecutivePanel state={{ kind: 'loading' }} />);

  expect(textOf('executive-status')).toBe('Consultando el resumen ejecutivo del servidor…');
  expect(document.getElementById('executive-level-alto')).toBeNull();
  expect(document.getElementById('executive-critical-count')).toBeNull();
});

test('without a session the panel says it has not read the summary instead of showing zeros', () => {
  render(<ExecutivePanel state={{ kind: 'idle' }} />);

  expect(textOf('executive-status')).toMatch(/Sin consultar/);
  expect(document.getElementById('executive-coverage-catalogue')).toBeNull();
  expect(textOf('executive-rule-tag')).toBe(RULE_TAG);
});

test('the honesty tags state the rule and the synthetic origin only when a source declares it', () => {
  const { unmount } = render(<ExecutivePanel state={{ kind: 'ready', summary: summary() }} />);
  // The rule is always named; the synthetic mark is absent because neither the
  // summary nor the batch this page read declared demo inputs.
  expect(textOf('executive-rule-tag')).toBe('Regla activa, no modelo');
  expect(textOf('executive-panel-note')).toMatch(/no un modelo entrenado ni una predicción/);
  expect(document.getElementById('executive-synthetic')).toBeNull();
  unmount();

  // Coverage declares demo zones: the mark appears and names how many.
  const demoCoverage = render(
    <ExecutivePanel
      state={{ kind: 'ready', summary: summary({ coverage: { catalogue_zones: 38, zones_without_batch: 2, stale_zones: 3, demo_zones: 5 } }) }}
    />,
  );
  expect(textOf('executive-synthetic')).toContain(SYNTHETIC_TAG);
  expect(textOf('executive-synthetic')).toMatch(/5 zonas/);
  demoCoverage.unmount();

  // The summary declares none, but the batch this page already read does.
  render(<ExecutivePanel state={{ kind: 'ready', summary: summary() }} batchIsDemo />);
  expect(textOf('executive-synthetic')).toContain(SYNTHETIC_TAG);
  expect(textOf('executive-synthetic')).toMatch(/último lote publicado declara entradas de demostración/);
});

// ── T4 · the approved board's reading hierarchy ─────────────────────────────
//
// `design/firewatch-v1-vuelo/07-panel-ejecutivo.html` opens with a band of level
// counts, each a large number under its level label, and states the panel's
// limits in a disclosure band under the reading. The panel keeps every count the
// server answered and the identifiers other suites read; what changes is the
// shape — and the band is a reading, not a filter, because the summary endpoint
// publishes counts and no per-level listing.

test('the level counts are the board band, with the numbers the server sent and no invented filter', () => {
  render(<ExecutivePanel state={{ kind: 'ready', summary: summary() }} />);

  const band = document.getElementById('executive-levels');
  expect(band).not.toBeNull();
  const cells = [...(band?.querySelectorAll('.decision-summary__cell') ?? [])];
  // One cell per member of the closed level vocabulary, labelled with the domain's
  // own Spanish label so the band and the map legend cannot disagree.
  expect(cells).toHaveLength(4);
  expect(cells.map(cell => cell.querySelector('.decision-summary__label')?.textContent)).toEqual([
    'ALTO',
    'MEDIO',
    'BAJO',
    'INFORMACIÓN INSUFICIENTE',
  ]);
  expect(cells.map(cell => cell.querySelector('strong')?.textContent)).toEqual(['5', '9', '20', '4']);

  // The identifiers the rest of the product reads are the count nodes themselves.
  expect(textOf('executive-level-alto')).toBe('5');
  expect(textOf('executive-level-medio')).toBe('9');
  expect(textOf('executive-level-bajo')).toBe('20');
  expect(textOf('executive-level-desconocido')).toBe('4');

  // The board filters its invented sector list from these cells. This panel has no
  // per-level list to filter and the endpoint publishes no such read, so it renders
  // no control and no pressed state instead of a dead one.
  expect(band?.querySelector('button')).toBeNull();
  expect(document.getElementById('executive-panel')?.querySelector('[aria-pressed]')).toBeNull();
});

test('the panel states its own limits in the board disclosure band without inventing a sector reading', () => {
  render(<ExecutivePanel state={{ kind: 'ready', summary: summary() }} />);

  const limits = document.getElementById('executive-limits');
  expect(limits).not.toBeNull();
  const summaries = [...(limits?.querySelectorAll('summary') ?? [])].map(node => node.textContent ?? '');
  expect(summaries.join(' ')).toMatch(/Solo lectura/);
  expect(summaries.join(' ')).toMatch(/comuna/i);
  // Closed by default: the disclosures are the board's secondary layer, and the
  // counts above them are what the reader sees first.
  expect(limits?.querySelector('details[open]')).toBeNull();

  const text = limits?.textContent ?? '';
  // The board's table is per sector; this contract is per comuna (CUT), and the
  // panel says so instead of rendering an empty fourth axis.
  expect(text).toMatch(/no publica conteos por sector/i);
  expect(text).toMatch(/no publica, no aprueba ni cambia niveles/i);
});

// D-B is not an open question in this product: `odd/tasks/pm-01-executive-panel.md`
// records the responsible's decision ("the two last published lots at high") and
// the server applies it. The panel must not label it as undecided, and the decision
// still has to be explained where the count is read.
test('D-B is the resolved definition the server applies, not an open decision', () => {
  render(<ExecutivePanel state={{ kind: 'ready', summary: summary() }} />);

  const limits = document.getElementById('executive-limits');
  const summaries = [...(limits?.querySelectorAll('summary') ?? [])].map(node => node.textContent ?? '');
  expect(summaries.join(' ')).toMatch(/Definición acordada · D-B/);
  // The misleading label and its "without deciding" framing are gone everywhere in
  // the panel, not only in the summary row.
  const panelText = document.getElementById('executive-panel')?.textContent ?? '';
  expect(panelText).not.toMatch(/Definición abierta/i);
  expect(panelText).not.toMatch(/sin decidir/i);

  // The explanation the count depends on is preserved: what makes a zone critical,
  // and that the server computes it.
  expect(panelText).toMatch(/dos últimos lotes publicados tienen\s+nivel alto/i);
  expect(textOf('executive-critical-rule')).toBe(CRITICAL_RULE);
  expect(textOf('executive-panel-note')).toMatch(/definición acordada/i);
  expect(textOf('executive-panel-note')).toMatch(/no un modelo entrenado ni una predicción/);
});
