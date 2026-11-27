import { StatusCopy, TableWrap, UnimplementedBadge } from '../components/ui';
import { OperationsViewHead } from '../components/operations/OperationsPrimitives';
import '../styles/operations-workspace.css';

// N8 — the inventory of capabilities the retired mockup offered and the backend
// cannot back. Declaring them is part of the delivery: naming an absence here is
// the only place they appear, so it can never be mistaken for a working feature.
// Nothing in this list is simulated and no control anywhere on the page offers it.
//
// Each entry is ported verbatim from the retired `NOT_IMPLEMENTED` array in
// `legacy/proposal.js`: the copy is Spanish because it is the copy the page
// already shipped, not a new translation.
export type UnimplementedCapability = {
  readonly capability: string;
  readonly reason: string;
  readonly location: string;
};

// The inventory is exported so the test pins the row count to the rendered
// content instead of a copy that could drift. The react-refresh rule wants a
// view module to export components only; this is a read-only data table, not a
// fast-refresh boundary, so its advisory is suppressed here on purpose.
//
// Rows leave this list only when the backend answers the capability they declare.
// PM-10 / V1-P-07 retired the audit entry («Nombre del actor, detalle libre e id
// de evento»): `GET /v1/audit` now returns the actor name, a free-text detail and
// a per-row event identifier, and `#audit` renders them.
//
// PM-04 / V1-P-04 retired «Historial de todas las zonas»: `GET
// /v1/risk/history/series` answers every zone that published in a bounded window,
// and `#history` renders that series. A retired entry is not kept here as a
// "recently fixed" note: an absence list that also lists what exists is no longer
// a statement of what the page cannot do.
//
// V1-P-06 retired «Publicar lote, avance manual y reevaluación»: the three G6
// actions exist as authenticated endpoints with a role gate — `POST
// /v1/risk/cycle/run` (admin-only manual publication, offered by `#jobs`),
// `POST /v1/prevention/actions/{id}/transitions` and `POST
// /v1/prevention/actions/{id}/reassessments` (both in `#actions`) — and one test
// covers the role rejection of each together with the state it leaves published.
// The entry declared the opposite, so it leaves the inventory and the count is
// the four rows that remain.
// eslint-disable-next-line react-refresh/only-export-components
export const NOT_IMPLEMENTED: readonly UnimplementedCapability[] = [
  {
    capability: 'Cobertura y entorno por sector',
    reason:
      'La API no publica cobertura ni entorno por comuna: solo el catálogo, el lote publicado y sus factores.',
    location: 'Tabla de sectores',
  },
  {
    capability: 'Contexto y prioridad por sector',
    reason:
      'El backend clasifica la zona con el lote publicado y no calcula prioridad regional ni contexto por comuna.',
    location: 'Ficha de detalle de la zona',
  },
  {
    capability: 'Estados candidate, in_progress, reviewed y closed',
    reason:
      'El backend informa el estado del trabajo (en cola, publicado) y el estado del dato; esos cuatro estados no existen en ningún contrato.',
    location: 'Chips de estado',
  },
  {
    capability: 'Revisar e incorporar registros, y hallazgos de calidad',
    reason:
      'GET /v1/risk/sources publica la procedencia y la integridad reales; no existe un catálogo de hallazgos de calidad. Las acciones preventivas viven ahora en su propia vista (#actions).',
    location: 'Fuentes y procedencia',
  },
];

export function PendingView() {
  return (
    <section className="view" id="pending" data-view="pending" aria-labelledby="pending-title">
      <article className="panel pending-panel">
        {/* Board 19's head, with the real count instead of the board's seven: the
            number is the exported list's own length, so it cannot drift from the
            rows below it. No prototype link from the board is ported. */}
        <OperationsViewHead
          id="pending-head"
          eyebrow="ALCANCE DE ESTA ENTREGA"
          title="Aún no implementado"
          titleId="pending-title"
          lede="Estas capacidades del mockup retirado no tienen respaldo en el backend actual. Declararlas es parte de la entrega: no se simulan y ningún control de esta página las ofrece."
        >
          <span className="ops-chip">Solo lectura</span>
          <span className="count-badge" id="pending-count">
            {NOT_IMPLEMENTED.length}
          </span>
          <span id="pending-badge">
            <UnimplementedBadge />
          </span>
        </OperationsViewHead>
        <StatusCopy id="pending-status">
          Inventario de solo lectura: cada fila declara la capacidad ausente, por qué no está y dónde iría. Ninguna
          fila es un control ni una simulación, y el backend actual no respalda ninguna de ellas.
        </StatusCopy>
        <TableWrap label="Capacidades sin respaldo en el backend">
          <table>
            <caption className="sr-only">
              Capacidades sin respaldo en el backend, con su motivo y su ubicación prevista
            </caption>
            <thead>
              <tr>
                <th scope="col">Capacidad</th>
                <th scope="col">Por qué no está</th>
                <th scope="col">Dónde iría</th>
              </tr>
            </thead>
            <tbody id="pending-rows">
              {NOT_IMPLEMENTED.map(entry => (
                <tr key={entry.capability}>
                  <td>{entry.capability}</td>
                  <td>{entry.reason}</td>
                  <td>{entry.location}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
        <p className="ops-note" id="pending-note">
          Mostrar una ausencia no cierra ninguna fila: cada entrada sale de esta lista solo cuando el backend responde
          la capacidad que declara. Esta página no enlaza prototipos ni ofrece controles deshabilitados que aparenten
          una función.
        </p>
      </article>
    </section>
  );
}
