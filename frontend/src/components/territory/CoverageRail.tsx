// T3 — la barra de cobertura del catálogo sintético de infraestructura.
//
// El tablero de diseño (`design/firewatch-v1-vuelo/04-cobertura-territorial.html`
// y `21-lecturas-por-sector.html`) lista focos con su cobertura de lectura y
// deja el foco elegido marcado. Este producto no sirve lecturas por sector:
// `/v1/risk/infrastructure` entrega zonas que son comunas identificadas por su
// código CUT. La barra, entonces, no renombra comunas como sectores ni inventa un
// porcentaje de cobertura del territorio: cuenta, por comuna, cuántos de los
// cinco tipos del catálogo declara (`zone-coverage.ts`), que es el único hecho de
// cobertura que el payload sostiene.
//
// Es presentacional: recibe las zonas tal como el servicio las sirvió —ya
// ordenadas por puntaje descendente y código ascendente—, la comuna abierta y la
// acción que revela su desglose. No lee sesión, store ni API, y no navega por
// `hash`: el hash es el estado del router, así que un ancla interna lo sacaría de
// esta vista. La vista es dueña de la selección y del desplazamiento.

import { INFRASTRUCTURE_TYPES, type InfrastructureZone } from '../../core/infrastructure';

import { coveragePhrase, zoneCoverage } from './zone-coverage';

export interface CoverageRailProps {
  zones: readonly InfrastructureZone[];
  // La comuna cuyo desglose está abierto en esta vista, o `''`.
  activeZone: string;
  // Revela el desglose de esa comuna. La vista mueve el foco y el scroll; la
  // barra solo informa qué comuna se eligió.
  onReveal: (zoneId: string) => void;
}

export function CoverageRail({ zones, activeZone, onReveal }: CoverageRailProps) {
  return (
    <aside className="coverage-rail" aria-labelledby="coverage-rail-title">
      <div className="coverage-rail-head">
        <h3 id="coverage-rail-title">Cobertura por comuna</h3>
        <span className="count-badge" id="coverage-rail-count">
          {zones.length}
        </span>
      </div>
      <p className="coverage-rail-note" id="coverage-rail-note">
        La cobertura cuenta cuántos de los {INFRASTRUCTURE_TYPES.length} tipos del catálogo declara la comuna. No mide
        el territorio ni reemplaza una evaluación del terreno, y el orden es el del servicio.
      </p>
      <ul className="coverage-list" id="coverage-list" aria-label="Comunas del catálogo con su cobertura de tipos">
        {zones.map(zone => {
          const coverage = zoneCoverage(zone);
          const active = activeZone === zone.zone_id;
          return (
            <li key={zone.zone_id} data-zone={zone.zone_id}>
              <button
                className="coverage-entry"
                id={`coverage-entry-${zone.zone_id}`}
                type="button"
                aria-pressed={active}
                onClick={() => onReveal(zone.zone_id)}
              >
                <span className="coverage-entry-head">
                  <span className="coverage-zone">Zona {zone.zone_id}</span>
                  <span className="coverage-figure" data-coverage={`${coverage.typesInformed}/${coverage.typesTotal}`}>
                    {coveragePhrase(coverage)}
                  </span>
                </span>
                {/* Cinco marcas decorativas: la frase de la derecha es la que
                    lleva el significado, así que la figura no se anuncia. */}
                <span className="coverage-dots" aria-hidden="true">
                  {coverage.types.map(entry => (
                    <span key={entry.type} className={entry.present ? 'coverage-dot is-on' : 'coverage-dot is-off'} />
                  ))}
                </span>
                <span className="coverage-entry-types">
                  {coverage.typesInformed === 0
                    ? 'Sin elementos declarados en ningún tipo'
                    : coverage.presentLabels.join(' · ')}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="coverage-rail-note" id="coverage-rail-scoring">
        Abrir una comuna lleva a su desglose en esta misma página. El <strong>Exp</strong> de cada comuna es su índice
        ponderado por categoría: la cobertura de la tabla ratificada sobre 4,15, ponderada por el peso de cada categoría
        y no por la cantidad de elementos. No es riesgo observado.
      </p>
    </aside>
  );
}
