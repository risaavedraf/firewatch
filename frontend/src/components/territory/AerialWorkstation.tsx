// T2 — la estación de trabajo de la vista aérea.
//
// El tablero de diseño pone una barra de trabajo junto al mapa, pero la suya pide
// lotes por comuna, mantiene una cola de filas simuladas y ofrece controles de
// cámara y de fecha de corte. Nada de eso tiene datos servidos detrás: el producto
// procesa una sola solicitud de lote a la vez, la pide en `#jobs` y publica el
// resultado como lote. Esta barra, entonces, no simula la cola: informa el estado
// real que el procesamiento ya registró, nombra la zona con la etiqueta del
// catálogo y enlaza las rutas reales que resuelven cada lectura.
//
// El componente es presentacional a propósito: la vista es dueña de las lecturas,
// la selección y los textos de estado, así que cada estado se puede renderizar y
// probar por separado. Los enlaces se derivan de `routes`, igual que la navegación
// global, de modo que una ruta que el router no declara no puede aparecer aquí.

import { routes, type ViewId } from '../../app/routes';

export interface AerialWorkstationProps {
  // Lo que el procesamiento registró para la única solicitud de la sesión.
  requestText: string;
  // El mapa ya anuncia ese mismo hecho para la zona seleccionada. Cuando la
  // solicitud es de otra comuna, o de una zona que el mapa no está mostrando, el
  // mapa no dice nada y esta línea es la única que puede anunciarlo.
  announceRequest: boolean;
  // La zona compartida que el mapa y la ficha ya usan.
  zoneText: string;
  // El tipo de respuesta del último lote de esa zona, nunca su nivel.
  resultText: string;
  // Cuántas comunas tienen un nivel realmente leído en esta sesión.
  levelsText: string;
}

type LinkBlock = 'request' | 'readings';

interface WorkstationLink {
  id: ViewId;
  label: string;
  anchor: string;
  block: LinkBlock;
}

// Cada enlace nombra su destino en el propio texto visible (WCAG 2.5.3): no hay
// `aria-label` que lo reemplace ni un "ver más" que no diga a dónde va. Las
// etiquetas no repiten el nombre de un destino de la navegación global: dos
// enlaces con el mismo nombre accesible en una página son dos destinos que un
// lector no puede distinguir al recorrer los enlaces.
const LINKS: readonly WorkstationLink[] = [
  { id: 'jobs', label: 'Pedir y seguir un lote', anchor: 'aerial-jobs-link', block: 'request' },
  { id: 'sources', label: 'Ver el estado del gateway y las fuentes', anchor: 'aerial-gateway-link', block: 'request' },
  { id: 'history', label: 'Abrir los lotes publicados de la zona', anchor: 'aerial-history-link', block: 'readings' },
  { id: 'compare', label: 'Comparar esta zona con otra', anchor: 'aerial-compare-link', block: 'readings' },
];

// Un destino sin ruta declarada no se renderiza: un enlace a una vista que el
// router no sirve sería una acción que la página no puede cumplir.
const links = LINKS.flatMap(link => {
  const route = routes.find(candidate => candidate.id === link.id);
  return route === undefined ? [] : [{ ...link, hash: route.hash }];
});

function linksFor(block: LinkBlock) {
  return links.filter(link => link.block === block);
}

export function AerialWorkstation({
  requestText,
  announceRequest,
  zoneText,
  resultText,
  levelsText,
}: AerialWorkstationProps) {
  return (
    <aside className="aerial-rail" aria-labelledby="aerial-work-title">
      <h3 id="aerial-work-title">Estación de trabajo</h3>

      <section className="aerial-block" aria-labelledby="aerial-request-title">
        <h4 id="aerial-request-title">Solicitud de lote</h4>
        {/* Una sola línea de estado: la sesión tiene una solicitud a la vez, así
            que una lista aquí volvería a dibujar la cola que el producto no tiene.
            La región viva se declara solo cuando el mapa no está anunciando el
            mismo hecho: dos regiones vivas diciendo lo mismo son ruido. */}
        <p
          id="aerial-request-state"
          className="aerial-state"
          role={announceRequest ? 'status' : undefined}
          aria-live={announceRequest ? 'polite' : undefined}
        >
          {requestText}
        </p>
        <p className="aerial-note">
          El servicio procesa una solicitud a la vez. Esta vista no crea solicitudes: informa el estado que
          Procesamiento ya registró y enlaza la ruta donde se pide y se sigue el lote.
        </p>
        <ul className="aerial-links" aria-label="Rutas del lote">
          {linksFor('request').map(link => (
            <li key={link.anchor}>
              <a id={link.anchor} href={link.hash}>
                {link.label}
              </a>
            </li>
          ))}
        </ul>
      </section>

      <section className="aerial-block" aria-labelledby="aerial-readings-title">
        <h4 id="aerial-readings-title">Lecturas y resultados</h4>
        <dl className="aerial-readings">
          <div>
            <dt>Zona seleccionada</dt>
            <dd id="aerial-zone">{zoneText}</dd>
          </div>
          <div>
            <dt>Resultado leído</dt>
            <dd id="aerial-result">{resultText}</dd>
          </div>
          <div>
            <dt>Comunas con nivel leído</dt>
            <dd id="aerial-levels">{levelsText}</dd>
          </div>
        </dl>
        <p className="aerial-note">
          El detalle del último lote —nivel, factores, política y vigencia— está en «Último lote publicado», en esta
          misma página.
        </p>
        <ul className="aerial-links" aria-label="Rutas de lectura">
          {linksFor('readings').map(link => (
            <li key={link.anchor}>
              <a id={link.anchor} href={link.hash}>
                {link.label}
              </a>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}
