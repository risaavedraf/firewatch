// PM-11 — the dedicated synthetic infrastructure demo view.
//
// This is intentionally a separate view, not a redesign of the territory
// overview. It reads one embedded fictional catalogue from
// `GET /v1/risk/infrastructure` and states, prominently and in Spanish, that the
// data are synthetic, that the priority is provisional, and that each element
// contributes one point regardless of type. The same statements remain visible
// when the page is printed through the browser.

import { useEffect, useMemo, useState } from 'react';

import { routes, type ViewId } from '../app/routes';
import { idleCopy } from '../app/sessionCopy';
import { useSessionState } from '../app/store';
import { InfrastructureMap } from '../components/map/InfrastructureMap';
import { CoverageRail } from '../components/territory/CoverageRail';
import { coveragePhrase, zoneCoverage } from '../components/territory/zone-coverage';
import { Metric, PanelHeading, StatusCopy, TableWrap } from '../components/ui';
import { batches, type Failure } from '../core/api';
import {
  INFRASTRUCTURE_RATIFIED_TABLE,
  INFRASTRUCTURE_TYPES,
  infrastructure,
  infrastructureCategoryLabel,
  infrastructureCountRows,
  infrastructureElementCount,
  infrastructureGeometrySummary,
  infrastructureMaxExposure,
  infrastructureTypeLabel,
  type InfrastructureCatalogue,
  type InfrastructureWeighting,
} from '../core/infrastructure';
import { priorityLineCopy, priorityNumber, priorityRankLabel, priorityView, type PriorityView } from '../domain';
import type { ZonePriority } from '../types/api';
import '../styles/territorial-coverage.css';

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

// V1-P-02 — the regional context is a second, independent read: the aggregate
// published batch. A failed or absent answer leaves every priority column as an
// explicit unknown instead of turning the whole catalogue into a failure.
type PriorityRead =
  | { kind: 'idle' }
  | { kind: 'ready'; byZone: Map<string, ZonePriority> }
  | { kind: 'failed' };

function priorityOf(read: PriorityRead, zoneID: string): PriorityView {
  if (read.kind !== 'ready') return priorityView(null);
  return priorityView(read.byZone.get(zoneID));
}

const IDLE_ACTION = 'consultar la infraestructura sintética';
const LOADING_STATUS = 'Consultando el catálogo sintético de infraestructura…';

// T3 — las rutas que el catálogo no puede resolver por sí solo. Cada etiqueta
// nombra su destino en el texto visible (no repite el nombre de un destino de la
// navegación global) y cada `href` se deriva de `routes`, así que una vista que
// el router no declare no puede aparecer aquí.
interface RelatedLink {
  id: ViewId;
  anchor: string;
  label: string;
  note: string;
}

const RELATED_LINKS: readonly RelatedLink[] = [
  {
    id: 'history',
    anchor: 'infrastructure-history-link',
    label: 'Abrir los lotes publicados por comuna',
    note: 'El historial se lee para la zona seleccionada en Territorio.',
  },
  {
    id: 'compare',
    anchor: 'infrastructure-compare-link',
    label: 'Comparar dos o tres comunas',
    note: 'El comparador cruza los últimos lotes de las comunas elegidas.',
  },
  {
    id: 'sources',
    anchor: 'infrastructure-sources-link',
    label: 'Revisar la procedencia y las fuentes',
    note: 'La procedencia y las restricciones se declaran en esa vista.',
  },
];

const relatedLinks = RELATED_LINKS.flatMap(link => {
  const route = routes.find(candidate => candidate.id === link.id);
  return route === undefined ? [] : [{ ...link, hash: route.hash }];
});

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

// V1-P-02 / PM-11 — la tabla ratificada, publicada en la página. Los valores
// mostrados son la referencia ratificada del cliente y el servidor los repite en
// `weighting`; una respuesta que declare otra tabla es rechazada en el borde, así
// que las dos no pueden divergir sin que la lectura se marque ilegible.
function WeightingTable({ weighting }: { weighting: InfrastructureWeighting | null }) {
  const weightSum = weighting === null ? '4.15' : weighting.weight_sum.toFixed(2);
  const fold =
    weighting === null
      ? 'colegio → escuela · hospital → hospital · ruta → vialidad'
      : weighting.type_categories.map(entry => `${entry.type} → ${entry.category}`).join(' · ');
  return (
    <section className="infrastructure-weighting" aria-labelledby="infrastructure-weighting-title">
      <h3 id="infrastructure-weighting-title">Tabla ponderada ratificada</h3>
      {/*
        Cinco filas y cuatro columnas caben sin desplazamiento, así que esta tabla
        no lleva el envoltorio con rol de región: agregaría un segundo destino de
        Tab y una región con nombre propio a la vista sin necesidad. Conserva su
        caption, sus encabezados de columna y su encabezado de fila.
      */}
      <table id="infrastructure-weighting" className="infrastructure-weighting-table">
        <caption>
          Cinco categorías de infraestructura crítica con su peso y su radio de exposición. Los pesos son los
          ratificados: no cambian por comuna ni según el número de elementos.
        </caption>
        <thead>
          <tr>
            <th scope="col">Categoría</th>
            <th scope="col">Alias</th>
            <th scope="col">Peso</th>
            <th scope="col">Radio</th>
          </tr>
        </thead>
        <tbody>
          {INFRASTRUCTURE_RATIFIED_TABLE.map(row => (
            <tr key={row.category} data-category={row.category}>
              <th scope="row">{infrastructureCategoryLabel(row.category)}</th>
              <td data-aliases>{row.aliases.join(' · ')}</td>
              <td data-weight>{row.weight.toFixed(2)}</td>
              <td data-radius>{row.radiusKm.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="panel-note" id="infrastructure-weighting-note">
        Suma de pesos {weightSum}: normaliza el índice de exposición. Plegado del catálogo sobre la tabla: {fold}. Los
        tipos que la tabla no nombra —vivienda e hidrante— quedan declarados con entidad, zona y geometría, y aportan 0
        al índice. La prioridad usa la pareja ratificada 0.70 / 0.30 sobre el lote publicado.
      </p>
    </section>
  );
}

export function InfrastructureView() {
  const session = useSessionState();
  const signedIn = session.status === 'signed-in';
  const [read, setRead] = useState<ReadState | null>(null);
  // T3 — la comuna cuyo desglose está abierto. Es estado de esta vista y de
  // nadie más: no toca el store, no reescribe el hash del router y no cambia la
  // zona seleccionada en Territorio.
  const [activeZone, setActiveZone] = useState('');
  const [priorityRead, setPriorityRead] = useState<PriorityRead>({ kind: 'idle' });

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
    // The regional priority is read on the same signal so a closed session or a
    // changed zone cannot leave a half-applied pair of answers on screen.
    void batches(controller.signal).then(outcome => {
      if (!active) return;
      if (!outcome.ok) {
        if (outcome.failure.reason === 'aborted' || outcome.failure.reason === 'superseded') return;
        setPriorityRead({ kind: 'failed' });
        return;
      }
      const byZone = new Map<string, ZonePriority>();
      for (const batch of outcome.data) {
        if (batch.priority === undefined || batch.priority === null) continue;
        byZone.set(batch.zone_id, batch.priority);
      }
      setPriorityRead({ kind: 'ready', byZone });
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
  const highestExposure = catalogue === null ? null : infrastructureMaxExposure(catalogue);
  const maxExposure = highestExposure === null ? '—' : String(highestExposure);
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
            coverage: zoneCoverage(zone),
          })),
    [catalogue],
  );

  // Abrir una comuna no navega: mueve el foco y el scroll al desglose que ya
  // está en esta página. `scrollIntoView` no existe en jsdom, así que se llama
  // solo cuando el navegador lo ofrece; el foco es el que anuncia el destino.
  const revealZone = (zoneId: string) => {
    setActiveZone(zoneId);
    const target = document.getElementById(`infrastructure-zone-${zoneId}`);
    if (target === null) return;
    target.scrollIntoView?.({ block: 'start' });
    target.focus({ preventScroll: true });
  };

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
          {/* T3 — la unidad real del catálogo, declarada junto a la etiqueta
              sintética: las zonas son comunas por código CUT, no sectores. */}
          <span className="neutral-tag" id="infrastructure-granularity">
            GRANULARIDAD · COMUNA (CUT)
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
            Origen declarado: <code>synthetic_fixture</code> · tabla ponderada de cinco categorías.
          </span>
        </div>

        {/*
          V1-P-02 / PM-11 — la regla ratificada, dicha en la página: cinco
          categorías con peso y radio, un índice de exposición que es la cobertura
          ponderada de esa tabla y una prioridad 70/30 sobre el lote publicado. La
          política provisional de un punto por elemento queda retirada.
        */}
        <p className="infrastructure-formula" id="infrastructure-formula">
          <strong>Tabla ratificada:</strong> la tabla ponderada de cinco categorías define el peso y el radio de cada tipo
          de infraestructura crítica. La exposición de una comuna (0..100) es la cobertura ponderada de esa tabla, y la
          prioridad territorial se calcula sobre el lote publicado como{' '}
          <code>round(0.70 × risk_score + 0.30 × exposure_score)</code>. No modifica el clasificador de riesgo, no
          designa zonas críticas y no es una medición de campo.
        </p>

        <WeightingTable weighting={catalogue === null ? null : catalogue.weighting} />

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
            label="Exposición máxima"
            icon="attention"
            attention
            value={<span id="infrastructure-exposure-max">{maxExposure}</span>}
            note="Índice 0..100 de la comuna con mayor cobertura ponderada de la tabla ratificada."
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
            {/*
              T3 — la etapa de cobertura. El tablero de diseño pone el mapa como
              lienzo y una barra de lecturas a su lado; aquí el mapa conserva su
              figura real y la barra cuenta, por comuna, cuántos tipos declara el
              catálogo. No se renombran comunas como sectores ni se simula la
              cobertura de lectura del prototipo.
            */}
            <div className="coverage-stage">
              <section className="coverage-canvas" aria-labelledby="coverage-map-title">
                <div className="coverage-stage-head">
                  <div>
                    <p className="eyebrow">GEOMETRÍAS DECLARADAS · FIXTURE SINTÉTICO</p>
                    <h3 id="coverage-map-title">Mapa de los elementos declarados</h3>
                  </div>
                  <span className="neutral-tag" id="coverage-map-badge">
                    PUNTOS Y LÍNEAS FICTICIAS
                  </span>
                </div>
                <p className="coverage-stage-note" id="coverage-granularity">
                  Cada zona del catálogo es una comuna identificada por su código CUT. El servicio no publica una
                  lectura por sector, así que esta vista no presenta el resultado de una comuna como lectura de sector.
                  El mapa dibuja solo las posiciones y líneas ficticias que el catálogo declara, sin cartografía base.
                </p>
                <InfrastructureMap catalogue={catalogue} />
              </section>

              <CoverageRail zones={catalogue.zones} activeZone={activeZone} onReveal={revealZone} />
            </div>

            <TableWrap label="Desglose por zona de infraestructura">
              <table id="infrastructure-zones" className="infrastructure-table">
                <caption>
                  Desglose por zona del fixture sintético. Cada elemento se declara con su tipo; la exposición es la
                  cobertura ponderada de la tabla ratificada y la prioridad es la que el backend calculó sobre el lote
                  publicado. Cada zona es una comuna por código CUT y ninguna fila es una lectura de sector.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Zona</th>
                    {INFRASTRUCTURE_TYPES.map(type => (
                      <th key={type} scope="col">
                        {infrastructureTypeLabel(type)}
                      </th>
                    ))}
                    <th scope="col">Exposición</th>
                    <th scope="col">Prioridad</th>
                    <th scope="col">Puesto</th>
                  </tr>
                </thead>
                <tbody id="infrastructure-rows">
                  {catalogue.zones.map(zone => {
                    const view = priorityOf(priorityRead, zone.zone_id);
                    return (
                      <tr key={zone.zone_id} id={`infrastructure-zone-row-${zone.zone_id}`} data-zone={zone.zone_id}>
                        <th scope="row">{zone.zone_id}</th>
                        {infrastructureCountRows(zone).map(row => (
                          <td key={row.type} data-count={row.type} className="infrastructure-count">
                            {row.count}
                          </td>
                        ))}
                        <td data-exposure={zone.exposure_score} className="infrastructure-exposure">
                          {zone.exposure_score}
                        </td>
                        <td data-priority={view.kind === 'ranked' ? view.priorityScore : '—'} className="infrastructure-priority">
                          {view.kind === 'ranked' ? priorityNumber(view.priorityScore) : '—'}
                        </td>
                        <td data-rank={view.kind === 'ranked' ? view.rank : '—'} className="infrastructure-rank">
                          {view.kind === 'ranked' ? priorityRankLabel(view.rank, view.total) : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>

            <section className="infrastructure-breakdown" id="infrastructure-breakdown" aria-labelledby="infrastructure-breakdown-title">
              <h3 id="infrastructure-breakdown-title">Desglose y geometrías por zona</h3>
              {breakdowns.map(entry => (
                <article
                  className="infrastructure-zone"
                  id={`infrastructure-zone-${entry.zone.zone_id}`}
                  key={entry.zone.zone_id}
                  aria-labelledby={`infrastructure-zone-title-${entry.zone.zone_id}`}
                  tabIndex={-1}
                  data-active={activeZone === entry.zone.zone_id ? 'true' : undefined}
                >
                  <h4 id={`infrastructure-zone-title-${entry.zone.zone_id}`}>
                    Zona {entry.zone.zone_id} · exposición {entry.zone.exposure_score} de 100
                  </h4>
                  <p className="panel-note">
                    {entry.counts.map(row => `${row.label}: ${row.count}`).join(' · ')}
                  </p>
                  {/* V1-P-02 — la prioridad regional de esta comuna, tal como la
                      sirvió el lote publicado. Si la lectura no respondió, la línea
                      lo dice y no se inventa ni prioridad ni puesto. */}
                  <p className="infrastructure-priority-line" id={`infrastructure-priority-${entry.zone.zone_id}`}>
                    {priorityLineCopy(priorityOf(priorityRead, entry.zone.zone_id))}
                  </p>
                  {/* La cobertura que la barra resume se repite aquí, en el
                      destino del enlace: tipos declarados por el fixture, no
                      cobertura del territorio. */}
                  <p
                    className="infrastructure-zone-coverage"
                    id={`infrastructure-zone-coverage-${entry.zone.zone_id}`}
                  >
                    Cobertura: {coveragePhrase(entry.coverage)} con elementos declarados
                    {entry.coverage.typesInformed === 0
                      ? ' · sin elementos'
                      : ` · ${entry.coverage.presentLabels.join(', ')}`}
                    .
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

            {/*
              T3 — el cierre del tablero de cobertura: qué mide el catálogo y
              qué no, con las rutas reales que continúan la lectura. Ambas
              columnas son estáticas: no piden nada ni crean nada.
            */}
            <div className="coverage-detail">
              <section className="coverage-note" aria-labelledby="coverage-reading-title">
                <p className="eyebrow">CÓMO LEER ESTE CATÁLOGO</p>
                <h3 id="coverage-reading-title">Granularidad, cobertura y puntaje son cosas distintas</h3>
                <dl className="coverage-reading" id="coverage-reading">
                  <div>
                    <dt>Granularidad</dt>
                    <dd>
                      Comuna, por código CUT. El servicio no publica lecturas por sector y esta vista no las presenta:
                      un resultado de comuna no se etiqueta como lectura de sector.
                    </dd>
                  </div>
                  <div>
                    <dt>Cobertura de tipos</dt>
                    <dd>
                      Cuántos de los {INFRASTRUCTURE_TYPES.length} tipos del catálogo declara la comuna. Es un conteo
                      del fixture, no cobertura del territorio ni una evaluación del terreno.
                    </dd>
                  </div>
                  <div>
                    <dt>Un conteo en cero</dt>
                    <dd>
                      El fixture no declara elementos de ese tipo en esa comuna. No es un dato faltante ni prueba de
                      que el tipo no exista en el territorio real.
                    </dd>
                  </div>
                  <div>
                    <dt>Exposición ponderada</dt>
                    <dd>
                      La cobertura de las cinco categorías ratificadas, con el peso de cada una sobre la suma 4.15. No
                      se deriva del nivel de riesgo ni modifica el clasificador; una comuna sin elementos ponderados
                      vale 0, que es un cero real y no un dato faltante.
                    </dd>
                  </div>
                  <div>
                    <dt>Prioridad territorial</dt>
                    <dd>
                      La calcula el backend sobre el lote publicado: <code>round(0.70 × risk_score + 0.30 ×
                      exposure_score)</code>. El puesto es regional y usa ese orden, nunca una comparación hecha en esta
                      página.
                    </dd>
                  </div>
                </dl>
              </section>

              <section className="coverage-note coverage-note-routes" aria-labelledby="coverage-routes-title">
                <p className="eyebrow">RUTAS DE LECTURA</p>
                <h3 id="coverage-routes-title">Dónde sigue la lectura real</h3>
                <ul className="coverage-routes" id="coverage-routes" aria-label="Rutas de lectura relacionadas">
                  {relatedLinks.map(link => (
                    <li key={link.anchor}>
                      <a id={link.anchor} href={link.hash}>
                        {link.label}
                      </a>
                      <span className="coverage-route-note">{link.note}</span>
                    </li>
                  ))}
                </ul>
                <p className="panel-note">
                  Esta vista no crea solicitudes ni acciones: enlaza las rutas que ya resuelven cada lectura.
                </p>
              </section>
            </div>
          </>
        )}
      </article>
    </section>
  );
}
