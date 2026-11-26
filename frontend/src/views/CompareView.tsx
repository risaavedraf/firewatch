import { useEffect, useState } from 'react';

import { idleCopy, rejectedSessionCopy } from '../app/sessionCopy';
import { useSessionState } from '../app/store';
import { Chip, DataList, PanelHeading, UnimplementedNote, type ChipTone } from '../components/ui';
import {
  COMPARISON_GRANULARITIES,
  COMPARISON_MAX_ZONES,
  compare,
  comparisonWindow,
  observationZones,
  type ComparisonCollection,
  type ComparisonGranularity,
  type ComparisonPoint,
  type ComparisonZone,
  type Failure,
  type Outcome,
} from '../core/api';
import { levelLabel } from '../domain';
import type { ObservationZone, RiskLevel } from '../types/api';

// PM-05 — the zone comparator. One `GET /v1/risk/compare` answers two or three
// catalogue zones in a single request: each zone's stored assessment at a shared
// cutoff, the variables that assessment carries, and PM-04's history buckets
// inside one window. Four properties travel with this code:
//
//   1. the selection is 2–3 DISTINCT catalogue zones and the chosen order is the
//      comparison order, because position is the only axis the route has;
//   2. the window is the endpoint's own cap (48 h for `hour`, 31 days for `day`
//      and `week`) and it is stated in text; the view interpolates no bucket and
//      fills no gap;
//   3. a zone whose assessment is null says so. A null assessment means no batch
//      was ever stored, and `desconocido` is a stored answer, so the two are never
//      collapsed into an invented level;
//   4. there is NO priority axis. PM-11 has no accepted weights yet, so a fourth
//      axis would be fabricated data; the view says that in writing instead of
//      rendering an empty measure.

const GRANULARITY_LABELS: Record<ComparisonGranularity, string> = {
  hour: 'Hora',
  day: 'Día',
  week: 'Semana',
};

// The cap of each granularity, written the way the endpoint states it. It is the
// text the view declares, so the reader knows the window the numbers cover.
const GRANULARITY_WINDOWS: Record<ComparisonGranularity, string> = {
  hour: 'las últimas 48 horas',
  day: 'los últimos 31 días',
  week: 'los últimos 31 días',
};

const ZONES_ACTION = 'leer el catálogo de zonas';
const COMPARE_ACTION = 'comparar las zonas';

type CatalogueState =
  | { kind: 'loading' }
  | { kind: 'ready'; zones: readonly ObservationZone[] }
  | { kind: 'failure'; failure: Failure };

type CompareStatus =
  | { kind: 'signed-out' }
  | { kind: 'insufficient' }
  | { kind: 'loading' }
  | { kind: 'empty'; data: ComparisonCollection }
  | { kind: 'ready'; data: ComparisonCollection }
  | { kind: 'failure'; failure: Failure };

interface LoadedComparison {
  status: Extract<CompareStatus, { kind: 'empty' | 'ready' | 'failure' }>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

// A zone's own label: the catalogue name with its code, or the code alone when
// the catalogue cannot name it. Nothing is filled in from another zone.
function zoneLabel(code: string, zones: readonly ObservationZone[]): string {
  const zone = zones.find(entry => entry.code === code);
  return nonempty(zone?.name) ? `${zone.name} · ${code}` : code;
}

// The chip tone follows the canonical level the payload stated; anything else is
// neutral, because a colour must never claim a severity the API did not serve.
function levelTone(level: RiskLevel): ChipTone {
  switch (level) {
    case 'alto':
      return 'high';
    case 'medio':
      return 'medium';
    case 'bajo':
      return 'low';
    default:
      return 'neutral';
  }
}

// One builder for every refusal, so the catalogue read and the comparison name
// the HTTP status and the server `code` when they have one.
function failureMessage(failure: Failure, action: string): string {
  const status = failure.status !== undefined ? `HTTP ${failure.status}` : 'sin conexión';
  const code = nonempty(failure.reason) && failure.reason !== `http_${failure.status}` ? ` · ${failure.reason}` : '';
  const detail = `${status}${code}`;
  switch (failure.reason) {
    case 'comparison_echo_mismatch':
      return 'La API devolvió una comparación de otra ventana, otra granularidad u otras zonas; se descartó y no se muestra ningún valor.';
    case 'invalid_comparison_request':
      return 'La comparación no se solicitó: hacen falta dos o tres zonas distintas, una granularidad del catálogo y una ventana con inicio anterior al fin.';
    case 'invalid_comparison_query':
      return `La API rechazó la consulta de comparación (${detail}); revisa las zonas, la granularidad y la ventana.`;
    case 'invalid_zone':
      return `La API no reconoce alguna de las zonas comparadas (${detail}); el catálogo no la contiene.`;
    case 'storage_unavailable':
      return `El almacenamiento de riesgo no está disponible (${detail}); la comparación no se pudo leer.`;
    default:
      break;
  }
  if (failure.kind === 'forbidden') {
    return `La API denegó el permiso para ${action} (${detail}). El servidor decide los permisos; solicita acceso a un administrador.`;
  }
  if (failure.kind === 'unauthorized') {
    return rejectedSessionCopy();
  }
  if (failure.kind === 'malformed') {
    return `La API no devolvió una comparación utilizable (${detail}); no se muestran valores parciales ni inventados.`;
  }
  return `No se pudo ${action} (${detail}).`;
}

function compareStatusMessage(status: CompareStatus, signedOut: string): string {
  switch (status.kind) {
    case 'signed-out':
      return signedOut;
    case 'insufficient':
      return `Elige al menos dos zonas del catálogo: una comparación necesita dos o tres, y el orden elegido es el orden de la comparación.`;
    case 'loading':
      return 'Comparando las zonas seleccionadas…';
    case 'empty':
      return 'La API no devolvió evaluación ni historial para las zonas comparadas en esta ventana.';
    case 'ready':
      return `Comparación devuelta por la API para ${status.data.zones.length} zonas.`;
    case 'failure':
      return failureMessage(status.failure, COMPARE_ACTION);
  }
}

// The variables of a stored assessment, read verbatim: a factor without a name is
// counted and stated instead of being rendered as if it had one, and a value the
// payload did not state is omitted rather than shown as zero.
interface FactorLine {
  key: string;
  text: string;
}

function factorLines(factors: readonly unknown[]): { lines: FactorLine[]; omitted: number } {
  const lines: FactorLine[] = [];
  let omitted = 0;
  factors.forEach((factor, index) => {
    if (!record(factor) || !nonempty(factor.name)) {
      omitted += 1;
      return;
    }
    const parts: string[] = [];
    if (typeof factor.value === 'number' && Number.isFinite(factor.value)) parts.push(`valor ${factor.value}`);
    if (typeof factor.contribution === 'number' && Number.isFinite(factor.contribution)) {
      parts.push(`contribución ${factor.contribution}`);
    }
    if (factor.known === false) parts.push('no medido');
    lines.push({
      key: `${factor.name}-${index}`,
      text: parts.length > 0 ? `${factor.name} · ${parts.join(' · ')}` : factor.name,
    });
  });
  return { lines, omitted };
}

function AssessmentBlock({ zone }: { zone: ComparisonZone }) {
  if (zone.assessment === null) {
    return (
      <div className="compare-absent">
        <p>
          <strong>Sin evaluación publicada.</strong> La API no informó un nivel para esta zona antes del corte de la
          comparación, así que esta ficha no muestra ninguno.
        </p>
      </div>
    );
  }
  const assessment = zone.assessment;
  const { lines, omitted } = factorLines(assessment.factors);
  return (
    <>
      <div className="compare-level">
        <Chip tone={levelTone(assessment.risk_level)}>{levelLabel(assessment.risk_level)}</Chip>
        <span className="compare-origin">{assessment.synthetic ? 'Lote sintético' : 'Lote real'}</span>
      </div>
      <DataList
        items={[
          { label: 'Lote', value: assessment.batch_id },
          { label: 'Solicitado', value: assessment.requested_at },
          { label: 'Publicado', value: assessment.published_at },
          { label: 'Versión del modelo', value: assessment.model_version },
        ]}
      />
      <h5>Variables del lote</h5>
      <ul className="compare-factors">
        {lines.map(line => (
          <li key={line.key}>{line.text}</li>
        ))}
        {lines.length === 0 ? <li className="compare-quiet">El lote no informó variables.</li> : null}
        {omitted > 0 ? (
          <li className="compare-quiet">
            {omitted === 1 ? 'Una variable sin nombre no se muestra.' : `${omitted} variables sin nombre no se muestran.`}
          </li>
        ) : null}
      </ul>
    </>
  );
}

function HistoryBlock({ zone, label }: { zone: ComparisonZone; label: string }) {
  return (
    <>
      <h5>Historial en la ventana</h5>
      {zone.history.length === 0 ? (
        <p className="compare-quiet">Sin publicaciones en la ventana consultada.</p>
      ) : (
        <div className="table-wrap">
          <table className="compare-history">
            <caption className="sr-only">
              Intervalos del historial de {label} dentro de la ventana consultada, en orden cronológico
            </caption>
            <thead>
              <tr>
                <th scope="col">Intervalo</th>
                <th scope="col">Nivel</th>
                <th scope="col">Lote</th>
                <th scope="col">Origen</th>
              </tr>
            </thead>
            <tbody>
              {zone.history.map((point: ComparisonPoint) => (
                <tr key={`${point.bucket_start}-${point.batch_id}`}>
                  <td>{point.bucket_start}</td>
                  <td>{levelLabel(point.risk_level)}</td>
                  <td>{point.batch_id}</td>
                  <td>{point.synthetic ? 'Sintético' : 'Real'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function CompareView() {
  const session = useSessionState();
  const signedIn = session.status === 'signed-in';

  const [catalogue, setCatalogue] = useState<CatalogueState>({ kind: 'loading' });
  const [catalogueRevision, setCatalogueRevision] = useState(0);
  const [selection, setSelection] = useState<readonly string[]>([]);
  const [granularity, setGranularity] = useState<ComparisonGranularity>('day');
  const [revision, setRevision] = useState(0);
  const [stored, setStored] = useState<{ key: string; loaded: LoadedComparison } | null>(null);

  // The zone picker is the authoritative catalogue, not a literal list: this read
  // is the same `zones` table the comparison route validates membership against,
  // and it also lists the zones without map geometry.
  useEffect(() => {
    if (!signedIn) return undefined;
    const controller = new AbortController();
    let active = true;
    void observationZones(controller.signal).then((outcome: Outcome<ObservationZone[]>) => {
      if (!active) return;
      if (!outcome.ok) {
        setCatalogue({ kind: 'failure', failure: outcome.failure });
        return;
      }
      setCatalogue({ kind: 'ready', zones: outcome.data });
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [signedIn, catalogueRevision]);

  // A new attempt is a new question even when the selection did not change, so
  // the attempt belongs to the identity of the read: a stored answer that does
  // not carry the current key is never shown.
  const key = `${granularity}:${selection.join(',')}:${revision}`;

  // One read per comparison: two or three zones, one window, one granularity.
  // The answer is stored beside the key it was read for, so a sign-out or a
  // selection change can never keep showing another comparison's numbers.
  useEffect(() => {
    if (!signedIn || selection.length < 2) return undefined;
    const controller = new AbortController();
    let active = true;
    const window = comparisonWindow(granularity);
    void compare({ zoneIds: selection, granularity, from: window.from, to: window.to }, controller.signal).then(
      outcome => {
        if (!active) return;
        // A superseded or aborted answer belongs to a request this view already
        // replaced: it owns nothing and must not repaint the panel.
        if (outcome.ok === false && (outcome.failure.reason === 'superseded' || outcome.failure.reason === 'aborted')) {
          return;
        }
        if (!outcome.ok) {
          setStored({ key, loaded: { status: { kind: 'failure', failure: outcome.failure } } });
          return;
        }
        const empty = outcome.data.zones.every(zone => zone.assessment === null && zone.history.length === 0);
        setStored({ key, loaded: { status: empty ? { kind: 'empty', data: outcome.data } : { kind: 'ready', data: outcome.data } } });
      },
    );
    return () => {
      active = false;
      controller.abort();
    };
  }, [signedIn, selection, granularity, key]);

  const current = signedIn && selection.length >= 2 && stored !== null && stored.key === key ? stored.loaded : null;
  const status: CompareStatus = !signedIn
    ? { kind: 'signed-out' }
    : selection.length < 2
      ? { kind: 'insufficient' }
      : current !== null
        ? current.status
        : { kind: 'loading' };

  const zones = signedIn && catalogue.kind === 'ready' ? catalogue.zones : [];
  const selectionFull = selection.length >= COMPARISON_MAX_ZONES;
  const catalogueMessage = !signedIn
    ? ''
    : catalogue.kind === 'loading'
      ? 'Leyendo el catálogo de zonas…'
      : catalogue.kind === 'failure'
        ? failureMessage(catalogue.failure, ZONES_ACTION)
        : '';

  // The answer belongs to the question that was asked, and changing the zones
  // asks a new one: the stored snapshot is dropped in the same update as the
  // selection, so a re-added zone (which restores a key this view already
  // answered) enters loading instead of repainting the earlier numbers.
  function addZone(code: string): void {
    if (code === '' || selectionFull || selection.includes(code)) return;
    setStored(null);
    setSelection([...selection, code]);
  }

  function removeZone(code: string): void {
    setStored(null);
    setSelection(selection.filter(entry => entry !== code));
  }

  const ready = status.kind === 'ready' || status.kind === 'empty';
  const zonesWithData = ready ? status.data.zones : [];
  const windowText = GRANULARITY_WINDOWS[granularity];

  return (
    <section className="view" id="compare" data-view="compare" aria-labelledby="compare-title">
      <div className="intro-row">
        <div>
          <p className="eyebrow">PREVENCIÓN</p>
          <h2 id="compare-title">Comparador de zonas</h2>
        </div>
        <span className="count-badge" id="compare-count">
          {selection.length}
        </span>
      </div>

      <article className="panel compare-panel">
        <PanelHeading eyebrow="COMPARACIÓN MÚLTIPLE" title="Riesgo, variables e historial en una sola llamada" />

        <p className="panel-note">
          Una sola llamada a <code>/v1/risk/compare</code> compara dos o tres zonas en riesgo, variables e historial. La
          ventana es la del tope del endpoint, {windowText} para la granularidad elegida, y no se interpolan intervalos
          ni se rellenan huecos. El orden elegido es el orden de la comparación.
        </p>

        <div className="compare-controls">
          <label htmlFor="compare-zone-picker">
            Añadir zona
            <select
              id="compare-zone-picker"
              value=""
              // The picker only ADDS: the chosen order lives in the ordered list
              // below, so a duplicate cannot be selected and a fourth zone cannot
              // be added, instead of being rejected after the choice.
              disabled={!signedIn || catalogue.kind !== 'ready' || selectionFull || zones.length === 0}
              aria-describedby="compare-catalogue-status"
              onChange={event => addZone(event.target.value)}
            >
              <option value="">
                {selectionFull ? 'Ya hay tres zonas elegidas' : 'Selecciona una zona del catálogo'}
              </option>
              {zones
                .filter(zone => !selection.includes(zone.code))
                .map(zone => (
                  <option key={zone.code} value={zone.code}>
                    {zoneLabel(zone.code, zones)}
                  </option>
                ))}
            </select>
          </label>

          <label htmlFor="compare-granularity">
            Granularidad
            <select
              id="compare-granularity"
              value={granularity}
              aria-describedby="compare-window"
              onChange={event => {
                const next = COMPARISON_GRANULARITIES.find(entry => entry === event.target.value);
                if (next === undefined) return;
                setGranularity(next);
                // The stored answer belongs to the previous granularity, so it is
                // dropped rather than shown under the new one while the read is
                // in flight.
                setStored(null);
              }}
            >
              {COMPARISON_GRANULARITIES.map(entry => (
                <option key={entry} value={entry}>
                  {GRANULARITY_LABELS[entry]} ({GRANULARITY_WINDOWS[entry]})
                </option>
              ))}
            </select>
          </label>
        </div>

        <p
          id="compare-catalogue-status"
          className={catalogue.kind === 'failure' ? 'status-copy risk-error' : 'status-copy'}
          role="status"
          aria-live="polite"
        >
          {catalogueMessage}
        </p>
        {catalogue.kind === 'failure' ? (
          <button
            id="compare-catalogue-retry"
            className="secondary-button"
            type="button"
            onClick={() => setCatalogueRevision(value => value + 1)}
          >
            Reintentar el catálogo
          </button>
        ) : null}

        <ol
          id="compare-selection"
          className="compare-selection"
          aria-label="Zonas seleccionadas, en el orden de la comparación"
        >
          {selection.map((code, index) => {
            const label = zoneLabel(code, zones);
            return (
              <li key={code}>
                <span className="compare-order" aria-hidden="true">
                  {index + 1}
                </span>
                <span className="compare-selection-label">{label}</span>
                <button
                  type="button"
                  className="button-text"
                  onClick={() => removeZone(code)}
                  aria-label={`Quitar ${label}`}
                >
                  Quitar
                </button>
              </li>
            );
          })}
        </ol>

        <p
          id="compare-window"
          className="panel-note"
        >
          {ready
            ? `Ventana aceptada por la API: desde ${status.data.from} hasta ${status.data.to}, granularidad ${status.data.granularity}.`
            : `Ventana solicitada: ${windowText}, la del tope del endpoint para esta granularidad.`}
        </p>

        <p
          id="compare-state"
          className={status.kind === 'failure' ? 'status-copy risk-error' : 'status-copy'}
          role="status"
          aria-live="polite"
        >
          {compareStatusMessage(status, idleCopy(session, COMPARE_ACTION))}
        </p>
        {status.kind === 'failure' ? (
          <button
            id="compare-retry"
            className="secondary-button"
            type="button"
            onClick={() => setRevision(value => value + 1)}
          >
            Reintentar la comparación
          </button>
        ) : null}

        <div id="compare-zones" className="compare-zones">
          {zonesWithData.map(zone => {
            const label = zoneLabel(zone.zone_id, zones);
            const headingId = `compare-zone-${zone.zone_id}`;
            return (
              <section className="compare-zone" key={zone.zone_id} aria-labelledby={headingId} data-zone={zone.zone_id}>
                <h4 id={headingId}>
                  {label}
                  {zone.assessment !== null ? ` · ${levelLabel(zone.assessment.risk_level)}` : ' · sin evaluación publicada'}
                </h4>
                <AssessmentBlock zone={zone} />
                <HistoryBlock zone={zone} label={label} />
              </section>
            );
          })}
        </div>

        <UnimplementedNote>
          Prioridad: se sumará a la comparación cuando PM-11 tenga pesos aceptados. Hoy esa medida no existe en el
          servicio, así que esta vista no ofrece un cuarto eje vacío.
        </UnimplementedNote>
      </article>
    </section>
  );
}
