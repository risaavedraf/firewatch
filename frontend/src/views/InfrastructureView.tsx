// PM-11 — the dedicated synthetic infrastructure demo view.
//
// This is intentionally a separate view, not a redesign of the territory
// overview. It reads one embedded fictional catalogue from
// `GET /v1/risk/infrastructure` and states, prominently and in Spanish, that the
// data are synthetic, that the priority is provisional, and that each element
// contributes one point regardless of type. The same statements remain visible
// when the page is printed through the browser.

import { useEffect, useMemo, useState } from 'react';

import { idleCopy } from '../app/sessionCopy';
import { useSessionState } from '../app/store';
import { InfrastructureMap } from '../components/map/InfrastructureMap';
import { Metric, PanelHeading, StatusCopy } from '../components/ui';
import type { Failure } from '../core/api';
import {
  INFRASTRUCTURE_TYPES,
  infrastructure,
  infrastructureCountRows,
  infrastructureElementCount,
  infrastructureGeometrySummary,
  infrastructureScoreTotal,
  infrastructureTypeLabel,
  type InfrastructureCatalogue,
} from '../core/infrastructure';

type InfrastructureState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; catalogue: InfrastructureCatalogue }
  | { kind: 'failed'; message: string };

// The settled half of the read. `idle` and `loading` are derived from the
// session and from the absence of a settled answer, so the effect never has to
// synchronously set state just to paint a loading phase.
type ReadState =
  | { kind: 'ready'; catalogue: InfrastructureCatalogue }
  | { kind: 'failed'; message: string };

const IDLE_ACTION = 'consultar la infraestructura sintética';
const LOADING_STATUS = 'Consultando el catálogo sintético de infraestructura…';

function failureMessage(failure: Failure): string {
  if (failure.kind === 'forbidden') {
    return 'La API denegó el permiso para consultar la infraestructura (403). Solicita acceso a un administrador.';
  }
  if (failure.kind === 'unauthorized') {
    return 'La API rechazó el token (401); la sesión se cerró.';
  }
  if (failure.kind === 'malformed') {
    return 'La API devolvió un catálogo de infraestructura ilegible; se muestra como no disponible.';
  }
  const detail = failure.status !== undefined ? `HTTP ${failure.status}` : 'sin conexión';
  return `No fue posible consultar la infraestructura sintética (${detail}).`;
}

function statusFor(state: InfrastructureState, sessionReason: string): string {
  switch (state.kind) {
    case 'idle':
      return sessionReason;
    case 'loading':
      return LOADING_STATUS;
    case 'failed':
      return state.message;
    case 'ready': {
      const zones = state.catalogue.zones.length;
      const elements = infrastructureElementCount(state.catalogue);
      return `Catálogo sintético recibido: ${zones} zonas y ${elements} elementos. Origen declarado: synthetic_fixture.`;
    }
  }
}

export function InfrastructureView() {
  const session = useSessionState();
  const signedIn = session.status === 'signed-in';
  const [read, setRead] = useState<ReadState | null>(null);

  useEffect(() => {
    if (!signedIn) return undefined;
    const controller = new AbortController();
    let active = true;
    void infrastructure(controller.signal).then(outcome => {
      if (!active) return;
      if (!outcome.ok) {
        if (outcome.failure.reason === 'aborted' || outcome.failure.reason === 'superseded') return;
        setRead({ kind: 'failed', message: failureMessage(outcome.failure) });
        return;
      }
      setRead({ kind: 'ready', catalogue: outcome.data });
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [signedIn]);

  const state: InfrastructureState = !signedIn ? { kind: 'idle' } : (read ?? { kind: 'loading' });

  const catalogue = state.kind === 'ready' ? state.catalogue : null;
  // Printing prints this catalogue. While the read is in flight or after it
  // failed there is no runtime data, so the action stays unavailable instead of
  // producing a page that claims to be the demo the view never received.
  const printable = state.kind === 'ready';
  const zoneCount = catalogue === null ? '—' : String(catalogue.zones.length);
  const elementCount = catalogue === null ? '—' : String(infrastructureElementCount(catalogue));
  const pointTotal = catalogue === null ? '—' : String(infrastructureScoreTotal(catalogue));
  // `idle` is only the first render before the effect starts. Once a session
  // exists the view is already on its way to the read, so it must not say
  // "connect a token" as if the session were missing.
  const idleStatus = signedIn ? 'Preparando la consulta del catálogo sintético…' : idleCopy(session, IDLE_ACTION);
  const status = statusFor(state, idleStatus);

  const breakdowns = useMemo(
    () =>
      catalogue === null
        ? []
        : catalogue.zones.map(zone => ({
            zone,
            counts: infrastructureCountRows(zone),
          })),
    [catalogue],
  );

  return (
    <section className="view infrastructure-view" id="infrastructure" data-view="infrastructure" aria-labelledby="infrastructure-title">
      <div className="intro-row">
        <div>
          <p className="eyebrow">PREVENCIÓN · INFRAESTRUCTURA</p>
          <h2 id="infrastructure-title">Infraestructura prioritaria</h2>
          <p className="subheading">Catálogo sintético de elementos y prioridad territorial provisional.</p>
        </div>
        <div className="infrastructure-actions">
          <span className="neutral-tag" id="infrastructure-badge">
            SINTÉTICO · DEMOSTRACIÓN
          </span>
          <button
            id="infrastructure-print"
            className="secondary-button infrastructure-print-action"
            type="button"
            disabled={!printable}
            onClick={() => {
              if (!printable) return;
              window.print();
            }}
          >
            Imprimir / Guardar PDF
          </button>
          <p className="panel-note infrastructure-print-note" id="infrastructure-print-note">
            Impresión del navegador, sin generador de PDF. Conserva la etiqueta sintética, la regla y las tablas. Se
            habilita cuando el catálogo terminó de cargarse.
          </p>
        </div>
      </div>

      <article className="panel infrastructure-panel">
        <PanelHeading
          eyebrow="CATÁLOGO SINTÉTICO"
          title="Zonas, desglose y geometrías ficticias"
          badge={<span className="neutral-tag">PRIORIDAD PROVISIONAL</span>}
        />

        <div className="infrastructure-synthetic" id="infrastructure-synthetic" role="note">
          <strong>DATOS SINTÉTICOS DE DEMOSTRACIÓN</strong>
          <span>
            Este catálogo es un fixture ficticio: no es el catálogo real del mandante, no contiene ubicaciones reales de
            infraestructura y no designa zonas críticas. La interfaz lo declara para que ninguna cifra se lea como un
            hallazgo operativo.
          </span>
          <span id="infrastructure-source">
            Origen declarado: <code>synthetic_fixture</code> · 1 punto por elemento.
          </span>
        </div>

        <p className="infrastructure-formula" id="infrastructure-formula">
          <strong>Regla provisional:</strong> un punto por elemento, sin importar su tipo; el total de cada zona es la
          suma de sus conteos por tipo. Estos pesos son provisionales, no están aprobados para uso operativo y no
          modifican el clasificador de riesgo ni el estado de ninguna zona.
        </p>

        <StatusCopy id="infrastructure-status">{status}</StatusCopy>

        <section className="metrics-grid metrics-three" aria-label="Resumen del catálogo sintético">
          <Metric
            label="Zonas sintéticas"
            icon="zones"
            value={<span id="infrastructure-zone-count">{zoneCount}</span>}
            note="Zonas devueltas por el fixture, en el orden en que el servicio las sirve."
          />
          <Metric
            label="Elementos ficticios"
            icon="batches"
            value={<span id="infrastructure-element-count">{elementCount}</span>}
            note="Elementos del fixture con entidad, tipo, zona y geometría declarada."
          />
          <Metric
            label="Puntos provisionales"
            icon="attention"
            attention
            value={<span id="infrastructure-point-total">{pointTotal}</span>}
            note="Suma de un punto por elemento. Prioridad provisional: no es riesgo observado."
          />
        </section>

        {catalogue === null ? (
          <p className="empty-state" id="infrastructure-empty">
            {state.kind === 'failed'
              ? 'Sin catálogo disponible: no se muestran filas, conteos ni geometrías.'
              : 'Sin catálogo cargado todavía: no se muestran filas, conteos ni geometrías.'}
          </p>
        ) : (
          <>
            <InfrastructureMap catalogue={catalogue} />

            <div className="table-wrap">
              <table id="infrastructure-zones" className="infrastructure-table">
                <caption>
                  Desglose por zona del fixture sintético. Cada elemento aporta un punto; el total es la suma de los
                  conteos.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Zona</th>
                    {INFRASTRUCTURE_TYPES.map(type => (
                      <th key={type} scope="col">
                        {infrastructureTypeLabel(type)}
                      </th>
                    ))}
                    <th scope="col">Total</th>
                  </tr>
                </thead>
                <tbody id="infrastructure-rows">
                  {catalogue.zones.map(zone => (
                    <tr key={zone.zone_id} id={`infrastructure-zone-row-${zone.zone_id}`} data-zone={zone.zone_id}>
                      <th scope="row">{zone.zone_id}</th>
                      {infrastructureCountRows(zone).map(row => (
                        <td key={row.type} data-count={row.type} className="infrastructure-count">
                          {row.count}
                        </td>
                      ))}
                      <td data-total={zone.score} className="infrastructure-total">
                        {zone.score}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <section className="infrastructure-breakdown" id="infrastructure-breakdown" aria-labelledby="infrastructure-breakdown-title">
              <h3 id="infrastructure-breakdown-title">Desglose y geometrías por zona</h3>
              {breakdowns.map(entry => (
                <article
                  className="infrastructure-zone"
                  id={`infrastructure-zone-${entry.zone.zone_id}`}
                  key={entry.zone.zone_id}
                  aria-labelledby={`infrastructure-zone-title-${entry.zone.zone_id}`}
                >
                  <h4 id={`infrastructure-zone-title-${entry.zone.zone_id}`}>
                    Zona {entry.zone.zone_id} · {entry.zone.score} puntos provisionales
                  </h4>
                  <p className="panel-note">
                    {entry.counts.map(row => `${row.label}: ${row.count}`).join(' · ')}
                  </p>
                  {entry.zone.elements.length === 0 ? (
                    <p className="empty-state">La zona no informa elementos.</p>
                  ) : (
                    <ul
                      className="infrastructure-elements"
                      id={`infrastructure-elements-${entry.zone.zone_id}`}
                      aria-label={`Elementos ficticios de la zona ${entry.zone.zone_id}`}
                    >
                      {entry.zone.elements.map(element => (
                        <li key={element.id} data-element-id={element.id}>
                          <span className="neutral-tag">{infrastructureTypeLabel(element.type)}</span>
                          <strong>{element.id}</strong>
                          <span className="infrastructure-geometry">
                            {infrastructureGeometrySummary(element.geometry)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </article>
              ))}
            </section>
          </>
        )}
      </article>
    </section>
  );
}
