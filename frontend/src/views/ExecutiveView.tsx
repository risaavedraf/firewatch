// T4 — the executive route.
//
// `design/firewatch-v1-vuelo/07-panel-ejecutivo.html` is the board: a head that
// says what the reading answers, the counts band, the recent variation and the
// panel's limits. The production view keeps that hierarchy and drops everything
// the service cannot back:
//
//   1. there is no per-sector table. The contract's unit is the comuna (CUT) and
//      the summary publishes counts, so a sector list would be an invented axis;
//   2. there is no alert preview and no filter over a list nothing served. The
//      alert count is the stored rows the service answered, and the page says so;
//   3. nothing is recomputed here. Every number on the screen comes from one
//      `GET /v1/risk/executive-summary` read, which the shared hook owns so this
//      view and the overview cannot issue two calls for the same answer.
//
// The view is a reading, not a control surface: its links lead to the screens
// that hold the detail (the territory, the comparator, the notification centre
// and the preventive actions).

import { useSessionState } from '../app/store';
import { ExecutivePanel } from '../components/executive/ExecutivePanel';
import { useExecutiveSummary } from '../components/executive/useExecutiveSummary';
import '../styles/decision-workspace.css';

const RELATED = [
  {
    hash: '#overview',
    label: 'Estado de la zona',
    note: 'El mapa del territorio y el último lote publicado de la comuna seleccionada.',
  },
  {
    hash: '#compare',
    label: 'Comparador de zonas',
    note: 'Dos o tres comunas en una sola llamada: nivel, variables e historial en la misma ventana.',
  },
  {
    hash: '#notifications',
    label: 'Notificaciones',
    note: 'Las alertas de cambio de nivel que el servicio registró, con su fecha y su sector.',
  },
  {
    hash: '#actions',
    label: 'Acciones preventivas',
    note: 'Las medidas en curso de la comuna, con su historial, su evidencia y su revisión.',
  },
] as const;

export function ExecutiveView() {
  const session = useSessionState();
  const signedIn = session.status === 'signed-in';
  // One read for the whole view: the panel below is its only consumer.
  const executiveState = useExecutiveSummary(signedIn);

  return (
    <section className="view" id="executive" data-view="executive" aria-labelledby="executive-view-title">
      <div className="intro-row decision-head">
        <div>
          <p className="eyebrow">PANEL EJECUTIVO · LECTURA AGREGADA</p>
          <h2 id="executive-view-title">Panel ejecutivo</h2>
          <p className="subheading">
            El corte que el servidor calcula sobre el catálogo completo: cobertura, niveles, variación reciente y zonas
            críticas. Esta página solo lee ese resumen; no publica, no aprueba y no estima nada por su cuenta.
          </p>
        </div>
        <span className="neutral-tag" id="executive-scope-badge">
          SOLO LECTURA
        </span>
      </div>

      <ExecutivePanel state={executiveState} />

      {/*
        The board's sector table has no contract here. What the screen can offer
        instead is the way to the readings that do exist, each one a declared
        route — never a link to a screen this application does not serve. It is a
        labelled `section`, not a second `nav`: the product keeps one navigation
        landmark per route, so a cross-reference list is a reading, not a menu.
      */}
      <section className="decision-links" aria-labelledby="executive-related-title">
        <h3 id="executive-related-title">Lecturas relacionadas</h3>
        <ul>
          {RELATED.map(entry => (
            <li key={entry.hash}>
              <a href={entry.hash}>{entry.label}</a>
              <span>{entry.note}</span>
            </li>
          ))}
        </ul>
        <p className="panel-note" id="executive-related-note">
          Cada enlace abre una pantalla que ya existe en el producto y lee su propio contrato. Este panel no copia sus
          datos ni los resume: la clasificación se queda en la ficha que la sostiene.
        </p>
      </section>
    </section>
  );
}
