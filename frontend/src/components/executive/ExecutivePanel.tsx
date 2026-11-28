// PM-01 — the executive panel: the server's own summary of the territory.
//
// T4 made it the body of two destinations: the executive route (`#executive)`
// and the overview, which keeps the same section for the zone it describes. The
// read belongs to `useExecutiveSummary`, so neither view issues a second request
// for the same answer.
//
// Four honesty rules shape this section:
//   1. every number here was computed by the server from its own snapshots; this
//      component performs no arithmetic, so no member can silently become a
//      ratio, a forecast or an invented zero;
//   2. "zona crítica" is D-B, the responsible's already-decided definition (the two
//      newest published batches at `alto`), and it is shown with its own literal —
//      "Alto en los dos últimos lotes" — rather than a severity colour a reader
//      would have to interpret; the panel states it as decided, because it is;
//   3. the summary's failure is stated inline and owns only this section: the
//      rest of the overview keeps working, and a pending read is bounded by the
//      transport deadline instead of an endless spinner;
//   4. the classification is an active rule, not a model, and the panel says so
//      in its tag and in its note.
//
// The component is presentational on purpose: the hook owns the read, its abort
// and its failure copy, so each state can be rendered and tested on its own and
// both views print the same refusal.

import type { ExecutiveLevelCounts, ExecutiveSummary } from '../../core/api';
import { levelLabel } from '../../domain';
import { DataList } from '../ui';
import '../../styles/decision-workspace.css';

// The two literals the section is required to show. They are constants so the
// visible copy and the test that pins it cannot drift apart.
export const RULE_TAG = 'Regla activa, no modelo';
export const CRITICAL_RULE = 'Alto en los dos últimos lotes';
export const SYNTHETIC_TAG = 'Datos sintéticos';

export type ExecutiveSummaryState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; summary: ExecutiveSummary }
  | { kind: 'failed'; message: string };

export interface ExecutivePanelProps {
  state: ExecutiveSummaryState;
  // Display names the loaded catalogue carries, keyed by the code the summary
  // reports. A critical zone the catalogue does not name is listed by its code:
  // the panel never invents a label for a zone it cannot identify.
  zoneNames?: ReadonlyMap<string, string>;
  // Whether the batch this page already read declares demo inputs. It is an OR
  // with the summary's own demo count, so "Datos sintéticos" appears when either
  // source states it and never because a style wanted it there.
  batchIsDemo?: boolean;
}

const LEVEL_ORDER: ReadonlyArray<keyof ExecutiveLevelCounts> = ['alto', 'medio', 'bajo', 'desconocido'];

function zonesText(count: number): string {
  return count === 1 ? '1 zona' : `${count} zonas`;
}

function statusText(state: ExecutiveSummaryState): string {
  switch (state.kind) {
    case 'idle':
      return 'Sin consultar: el resumen ejecutivo se lee del servidor al iniciar la sesión.';
    case 'loading':
      return 'Consultando el resumen ejecutivo del servidor…';
    case 'failed':
      return state.message;
    case 'ready':
      return 'Resumen recibido del servidor. Los conteos son los que el servicio calculó sobre sus propios lotes; esta sección no los recalcula ni los estima.';
  }
}

export function ExecutivePanel({ state, zoneNames, batchIsDemo = false }: ExecutivePanelProps) {
  const summary = state.kind === 'ready' ? state.summary : null;
  const demoZones = summary === null ? 0 : summary.coverage.demo_zones;
  const synthetic = demoZones > 0 || batchIsDemo;

  return (
    <section className="panel executive-panel" id="executive-panel" aria-labelledby="executive-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">RESUMEN DEL SERVIDOR</p>
          <h3 id="executive-title">Panel ejecutivo</h3>
        </div>
        <span className="neutral-tag" id="executive-rule-tag">
          {RULE_TAG}
        </span>
      </div>

      <p id="executive-status" className="status-copy" role="status" aria-live="polite">
        {statusText(state)}
      </p>

      {synthetic ? (
        <p id="executive-synthetic" className="panel-note">
          <span className="neutral-tag">{SYNTHETIC_TAG}</span>{' '}
          {demoZones > 0
            ? `${zonesText(demoZones)} del catálogo se clasificaron con lotes de demostración: no representan riesgo real observado.`
            : 'El último lote publicado declara entradas de demostración: no representan riesgo real observado.'}
        </p>
      ) : null}

      {summary !== null ? (
        <>
          {/*
            The board's counts band, with the server's own numbers. The cells are
            a reading, not a filter: the summary endpoint publishes counts and no
            per-level listing, so there is no list to narrow and no pressed state
            to invent.
          */}
          <section className="decision-band" aria-labelledby="executive-levels-title">
            <div className="decision-band__head">
              <h4 id="executive-levels-title">Niveles</h4>
              <p className="decision-band__hint">
                Un conteo por nivel publicado. Los calcula el servidor sobre sus propios lotes; esta sección no los
                recalcula ni los estima.
              </p>
            </div>
            <ul className="decision-summary" id="executive-levels">
              {LEVEL_ORDER.map((key) => (
                <li className="decision-summary__cell" key={key} data-level={key}>
                  <span className="decision-summary__label">{levelLabel(key)}</span>
                  <strong id={`executive-level-${key}`}>{summary.levels[key]}</strong>
                </li>
              ))}
            </ul>
          </section>

          <div className="executive-grid">
            <section className="executive-block" aria-labelledby="executive-coverage-title">
              <h4 id="executive-coverage-title">Cobertura</h4>
              <DataList
                items={[
                  {
                    label: 'Zonas del catálogo',
                    value: <span id="executive-coverage-catalogue">{summary.coverage.catalogue_zones}</span>,
                  },
                  {
                    label: 'Sin lote publicado',
                    value: <span id="executive-coverage-without-batch">{summary.coverage.zones_without_batch}</span>,
                  },
                  {
                    label: 'Obsoletas',
                    value: <span id="executive-coverage-stale">{summary.coverage.stale_zones}</span>,
                  },
                  {
                    label: 'Demo',
                    value: <span id="executive-coverage-demo">{summary.coverage.demo_zones}</span>,
                  },
                ]}
              />
          </section>

          <section className="executive-block" aria-labelledby="executive-delta-title">
            <h4 id="executive-delta-title">Variación reciente</h4>
            <DataList
              items={[
                {
                  label: 'Zonas comparadas',
                  value: <span id="executive-delta-compared">{summary.delta.zones_compared}</span>,
                },
                {
                  label: 'Zonas cambiadas',
                  value: <span id="executive-delta-changed">{summary.delta.zones_changed}</span>,
                },
                {
                  label: 'Sin lote anterior',
                  value: <span id="executive-delta-without-previous">{summary.delta.zones_without_previous}</span>,
                },
                {
                  label: 'Incomparables',
                  value: <span id="executive-delta-incomparable">{summary.delta.zones_incomparable}</span>,
                },
              ]}
            />
            <h5 id="executive-transitions-title">Transiciones</h5>
            <ul id="executive-transitions" aria-labelledby="executive-transitions-title">
              {summary.delta.transitions.length === 0 ? (
                <li>Sin transiciones entre lotes comparables.</li>
              ) : (
                summary.delta.transitions.map((transition) => (
                  <li key={`${transition.from}->${transition.to}`}>
                    {`${levelLabel(transition.from)} → ${levelLabel(transition.to)}: ${zonesText(transition.zones)}`}
                  </li>
                ))
              )}
            </ul>
          </section>

          <section className="executive-block" aria-labelledby="executive-variables-title">
            <h4 id="executive-variables-title">Variables predominantes</h4>
            {/* The server's order is kept: it already answers how many zones each
                variable led, and re-sorting here would present a ranking this page
                decided instead. */}
            <ul id="executive-variables" aria-labelledby="executive-variables-title">
              {summary.predominant_variables.length === 0 ? (
                <li>Sin variables predominantes en el resumen recibido.</li>
              ) : (
                summary.predominant_variables.map((variable) => (
                  <li key={variable.name}>{`${variable.name}: ${zonesText(variable.zones)}`}</li>
                ))
              )}
            </ul>
          </section>

          <section className="executive-block" aria-labelledby="executive-critical-title">
            <h4 id="executive-critical-title">Zonas críticas</h4>
            <p className="neutral-tag" id="executive-critical-rule">
              {CRITICAL_RULE}
            </p>
            <p>
              <strong id="executive-critical-count">{summary.critical_zones.count}</strong>{' '}
              {summary.critical_zones.count === 1 ? 'zona crítica' : 'zonas críticas'}
            </p>
            <ul id="executive-critical-list" aria-labelledby="executive-critical-title">
              {summary.critical_zones.zone_ids.length === 0 ? (
                <li>Ninguna zona cumple la regla en el resumen recibido.</li>
              ) : (
                summary.critical_zones.zone_ids.map((zone) => <li key={zone}>{zoneNames?.get(zone) ?? zone}</li>)
              )}
            </ul>
          </section>

          <section className="executive-block" aria-labelledby="executive-alerts-title">
            <h4 id="executive-alerts-title">Alertas registradas</h4>
            <p>
              <strong id="executive-alerts-count">{summary.active_alerts.count}</strong>{' '}
              {summary.active_alerts.count === 1 ? 'alerta registrada' : 'alertas registradas'}
            </p>
            <a id="executive-alert-link" href="#notifications">
              Centro de notificaciones
            </a>
            <p className="panel-note" id="executive-alerts-note">
              El conteo son las filas que el servicio registró en <code>/v1/risk/alerts</code>. No hay estado de leída
              ni de descartada, así que la ficha no lo inventa.
            </p>
          </section>
        </div>
        </>
      ) : null}

      {/*
        The board states the panel's limits under the reading, in its own
        disclosure band. The three statements are the ones this contract can
        actually make: no write path, commune granularity, and the responsible's
        open critical-zone definition.
      */}
      <div className="decision-limits" id="executive-limits">
        <details className="decision-limits__item">
          <summary>
            <span className="eyebrow">Alcance de la vista</span>
            <span className="decision-limits__title">Solo lectura</span>
          </summary>
          <p>
            Esta ficha no publica, no aprueba ni cambia niveles y no pide un lote nuevo: lee el agregado que el
            servidor ya calculó. Publicar, avanzar y reevaluar viven en Acciones preventivas y en Procesamiento.
          </p>
        </details>
        <details className="decision-limits__item">
          <summary>
            <span className="eyebrow">Granularidad</span>
            <span className="decision-limits__title">Por comuna, no por sector</span>
          </summary>
          <p>
            La unidad del contrato es la comuna (código CUT). El servicio no publica conteos por sector ni un porcentaje
            de cobertura por sector, así que esta ficha no muestra una tabla de sectores ni rellena ese eje con datos
            inventados.
          </p>
        </details>
        <details className="decision-limits__item">
          <summary>
            <span className="eyebrow">Definición acordada · D-B</span>
            <span className="decision-limits__title">Zonas críticas y alertas</span>
          </summary>
          <p>
            «{CRITICAL_RULE}» es la definición acordada (D-B): una zona es crítica cuando sus dos últimos lotes
            publicados tienen nivel alto. El servidor la aplica y esta página reproduce su conteo. El conteo de alertas
            son las filas que el servicio registró en <code>/v1/risk/alerts</code>: no hay estado de leída ni de
            descartada, y este panel no los supone. Una zona se nombra con el nombre del catálogo cuando esta página lo
            leyó y, si no, con el código CUT que el resumen trae; nunca con una etiqueta inventada.
          </p>
        </details>
      </div>

      <p className="panel-note" id="executive-panel-note">
        La etiqueta <q>{CRITICAL_RULE}</q> es la definición acordada (D-B) y el servidor la aplica: una zona es crítica
        cuando sus dos últimos lotes publicados tienen nivel alto; una zona con un solo lote, o con un lote alto seguido
        de otro nivel, no se cuenta. Los conteos llegan calculados del servidor y esta sección no los recalcula. La
        clasificación la produce una regla propia activa, no un modelo entrenado ni una predicción.
      </p>
    </section>
  );
}
