import { PanelHeading, StatusCopy, TableWrap, UnimplementedBadge } from '../components/ui';

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
  {
    capability: 'Publicar lote, avance manual y reevaluación',
    reason:
      'No existe endpoint: el servidor decide y publica por su cuenta; la página solo solicita el trabajo y lee el resultado.',
    location: 'Procesamiento asíncrono',
  },
];

export function PendingView() {
  return (
    <section className="view" id="pending" data-view="pending" aria-labelledby="pending-title">
      <article className="panel pending-panel">
        <PanelHeading
          eyebrow="ALCANCE DE ESTA ENTREGA"
          title="Aún no implementado"
          titleId="pending-title"
          level={2}
          badge={
            <span id="pending-badge">
              <UnimplementedBadge />
            </span>
          }
        />
        <StatusCopy id="pending-status">
          Estas capacidades del mockup retirado no tienen respaldo en el backend actual. Declararlas es parte de la
          entrega: no se simulan y ningún control de esta página las ofrece.
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
      </article>
    </section>
  );
}
