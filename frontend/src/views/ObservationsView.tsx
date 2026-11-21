import { useEffect, useState, type FormEvent } from 'react';

import { idleCopy } from '../app/sessionCopy';
import { useSessionState } from '../app/store';
import { PanelHeading } from '../components/ui';
import { createObservation, observationZones, observations, type Failure, type Outcome } from '../core/api';
import { getSessionSnapshot, subscribeSession } from '../core/session';
import { declaresAdminRole } from '../domain';
import {
  OBSERVATION_TYPES,
  type Observation,
  type ObservationType,
  type ObservationZone,
} from '../types/api';
import '../styles/observations.css';

// S2/S3 — field observations (PM-09), built against the frozen seam in
// `odd/tasks/pm-09-incidents.md` (L5).
//
// Four properties travel with this code:
//   1. the zone picker is the REAL catalogue (`/zones`), including zones without
//      map geometry, and the page never contributes a sector of its own;
//   2. the type is the closed catalogue of S2; the labels are the Spanish words
//      of S3 and the server rejects any value outside it;
//   3. the author is server-authored: `created_by` is the verified token `sub`
//      and the creation body carries only zone, type, date and description;
//   4. the filter is a server read (`?type=`) and a saved record is re-read from
//      the service — the page never stitches a local row into the list.

const LIST_ACTION = 'consultar las observaciones de campo';
const CREATE_ACTION = 'guardar la observación';
const ZONES_ACTION = 'consultar el catálogo de zonas';

const OBSERVATION_TYPE_LABELS: Record<ObservationType, string> = {
  vegetacion_seca: 'Vegetación seca',
  microbasural: 'Microbasural',
  quema: 'Quema',
  acceso_bloqueado: 'Acceso bloqueado',
  otro: 'Otro',
};

function observationTypeLabel(type: string): string {
  return OBSERVATION_TYPES.includes(type as ObservationType)
    ? OBSERVATION_TYPE_LABELS[type as ObservationType]
    : type;
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

// A zone's own label: the catalogue name plus its province, or the service code
// when the catalogue states no province. Nothing is filled in from another zone.
function zoneOptionLabel(zone: ObservationZone): string {
  return `${zone.name} · ${nonempty(zone.province) ? zone.province : zone.code}`;
}

function zoneLabel(entry: Observation): string {
  return nonempty(entry.zone_name) ? `${entry.zone_name} · ${entry.zone_id}` : entry.zone_id;
}

// One builder for every refusal, so the list, the zones read and the creation all
// name the HTTP status, the server `code` and the `request_id` when they have one.
function failureMessage(failure: Failure, action: string): string {
  const status = failure.status !== undefined ? `HTTP ${failure.status}` : 'sin conexión';
  const code = nonempty(failure.reason) && failure.reason !== `http_${failure.status}` ? ` · ${failure.reason}` : '';
  const request = failure.requestId !== undefined ? ` · request_id ${failure.requestId}` : '';
  const detail = `${status}${code}${request}`;
  switch (failure.reason) {
    case 'invalid_observation_request':
      return `La API rechazó la observación (${detail}); revisa la zona, el tipo, la fecha y la descripción (máximo 240 caracteres).`;
    case 'invalid_query':
      return `La API rechazó el filtro (${detail}); el tipo debe ser un valor del catálogo cerrado.`;
    case 'zone_not_found':
      return `La zona elegida no existe en el catálogo del servicio (${detail}).`;
    case 'storage_unavailable':
      return `El almacenamiento de prevención no está disponible (${detail}).`;
    default:
      break;
  }
  if (failure.kind === 'forbidden') {
    return `La API denegó el permiso para ${action} (${detail}). El servidor decide los permisos; solicita acceso a un administrador.`;
  }
  if (failure.kind === 'unauthorized') {
    return `La API rechazó el token (${detail}). La sesión se cerró; conecta nuevamente un token autorizado.`;
  }
  if (failure.kind === 'missing') {
    return `La API no encontró el recurso consultado (${detail}).`;
  }
  if (failure.kind === 'malformed') {
    return `La API no devolvió una respuesta utilizable (${detail}); no se muestran valores parciales ni inventados.`;
  }
  return `No se pudo ${action} (${detail}).`;
}

type Phase = 'unconsulted' | 'loading' | 'read' | 'denied' | 'unavailable';

interface ListState {
  phase: Phase;
  badge: string;
  message: string;
  observations: readonly Observation[];
}

interface ZonesState {
  phase: Phase;
  message: string;
  zones: readonly ObservationZone[];
}

const IDLE_LIST: ListState = {
  phase: 'unconsulted',
  badge: 'SIN CONSULTAR',
  message: 'Conecta un token autorizado para consultar las observaciones de campo.',
  observations: [],
};

const IDLE_ZONES: ZonesState = {
  phase: 'unconsulted',
  message: 'El catálogo de zonas se consulta con una sesión conectada.',
  zones: [],
};

const LOADING_LIST: ListState = {
  phase: 'loading',
  badge: 'CONSULTANDO',
  message: 'Consultando las observaciones registradas…',
  observations: [],
};

const LOADING_ZONES: ZonesState = {
  phase: 'loading',
  message: 'Consultando el catálogo de zonas del servicio…',
  zones: [],
};

function listFromOutcome(outcome: Outcome<Observation[]>, filterType: string): ListState {
  if (outcome.ok) {
    if (outcome.data.length === 0) {
      return {
        phase: 'read',
        badge: 'LEÍDO',
        message:
          filterType === ''
            ? 'El servicio todavía no registra observaciones de campo.'
            : `El servicio no devolvió observaciones del tipo «${observationTypeLabel(filterType)}» para el filtro elegido.`,
        observations: [],
      };
    }
    const filter = filterType === '' ? '' : ` con el filtro «${observationTypeLabel(filterType)}»`;
    return {
      phase: 'read',
      badge: 'LEÍDO',
      message: `Observaciones devueltas por /v1/prevention/observations (${outcome.data.length})${filter}.`,
      observations: outcome.data,
    };
  }
  const { failure } = outcome;
  if (failure.kind === 'forbidden') {
    return { phase: 'denied', badge: 'SIN PERMISO', message: failureMessage(failure, LIST_ACTION), observations: [] };
  }
  return { phase: 'unavailable', badge: 'NO DISPONIBLE', message: failureMessage(failure, LIST_ACTION), observations: [] };
}

function zonesFromOutcome(outcome: Outcome<ObservationZone[]>): ZonesState {
  if (outcome.ok) {
    if (outcome.data.length === 0) {
      return {
        phase: 'read',
        message: 'El catálogo del servicio no devolvió zonas: no se puede registrar una observación todavía.',
        zones: [],
      };
    }
    return {
      phase: 'read',
      message: `Catálogo del servicio: ${outcome.data.length} ${outcome.data.length === 1 ? 'zona disponible' : 'zonas disponibles'}.`,
      zones: outcome.data,
    };
  }
  return {
    phase: outcome.failure.kind === 'forbidden' ? 'denied' : 'unavailable',
    message: failureMessage(outcome.failure, ZONES_ACTION),
    zones: [],
  };
}

interface FormState {
  zoneId: string;
  type: string;
  observedOn: string;
  description: string;
}

const EMPTY_FORM: FormState = { zoneId: '', type: '', observedOn: '', description: '' };

export function ObservationsView() {
  const session = useSessionState();
  const signedIn = session.status === 'signed-in';
  // The role is a token FACT, read without verifying the signature. It only
  // decides which affordances this page shows; the server decides the action.
  const admin = signedIn && declaresAdminRole(session.roles);

  const [list, setList] = useState<ListState | null>(null);
  const [zones, setZones] = useState<ZonesState | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [filterType, setFilterType] = useState('');
  const [revision, setRevision] = useState(0);
  const [zonesRevision, setZonesRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  // The zone catalogue is re-read on every connection and after a retry. A failed
  // read empties it instead of leaving a stale catalogue selectable.
  useEffect(() => {
    if (!signedIn) return undefined;
    const controller = new AbortController();
    let active = true;
    void (async () => {
      const outcome = await observationZones(controller.signal);
      if (!active) return;
      setZones(zonesFromOutcome(outcome));
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [signedIn, zonesRevision]);

  // The list, re-read on every session, filter and revision change. A refused
  // token closes the session from inside the transport, so the refusal is
  // captured even though this effect's cleanup has already fenced the answer.
  useEffect(() => {
    if (!signedIn) return undefined;
    const controller = new AbortController();
    let active = true;
    void (async () => {
      const outcome = await observations(filterType === '' ? {} : { type: filterType }, controller.signal);
      if (!active) {
        if (!outcome.ok && outcome.failure.kind === 'unauthorized') {
          setNotice(failureMessage(outcome.failure, LIST_ACTION));
        }
        return;
      }
      setList(listFromOutcome(outcome, filterType));
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [signedIn, revision, filterType]);

  // Closing the session empties the private state. A refused token keeps the
  // notice — it carries the request id — while an ordinary logout clears it.
  useEffect(
    () =>
      subscribeSession(() => {
        if (getSessionSnapshot().status === 'signed-in') return;
        const reason = getSessionSnapshot().reason;
        setList(null);
        setZones(null);
        setForm(EMPTY_FORM);
        setFilterType('');
        setBusy(false);
        if (reason !== 'rejected') setNotice('');
      }),
    [],
  );

  // Loading is DERIVED from the absence of a settled snapshot, exactly like
  // `SourcesView`: no effect sets it synchronously, and no stale answer is painted
  // as the current one.
  const settledList: ListState = list ?? LOADING_LIST;
  const settledZones: ZonesState = zones ?? LOADING_ZONES;
  const listState: ListState = signedIn ? settledList : IDLE_LIST;
  const zonesState: ZonesState = signedIn ? settledZones : IDLE_ZONES;

  function selectFilter(value: string): void {
    if (value === filterType) return;
    // The rows of the previous filter are not the answer to the new one, so the
    // list returns to its loading state until the server answers.
    setList(null);
    setFilterType(value);
  }

  function clearFilter(): void {
    selectFilter('');
  }

  function retryZones(): void {
    setZones(null);
    setZonesRevision(value => value + 1);
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!signedIn || !admin || busy) return;
    const description = form.description.trim();
    if (form.zoneId === '' || form.type === '' || form.observedOn === '' || description === '') {
      setNotice('Completa zona, tipo, fecha y descripción antes de guardar la observación.');
      return;
    }
    setBusy(true);
    setNotice('');
    void (async () => {
      const outcome = await createObservation({
        zoneId: form.zoneId,
        type: form.type,
        observedOn: form.observedOn,
        description,
      });
      setBusy(false);
      if (!outcome.ok) {
        // Every entered value stays in place: a refusal is not a reason to make
        // the operator retype the record.
        setNotice(failureMessage(outcome.failure, CREATE_ACTION));
        return;
      }
      setForm(previous => ({ ...EMPTY_FORM, zoneId: previous.zoneId }));
      setNotice(`Observación guardada (${outcome.data.id}) en ${zoneLabel(outcome.data)}; la lista se vuelve a leer desde el servicio.`);
      setRevision(value => value + 1);
    })();
  }

  const zonesReady = zonesState.phase === 'read' && zonesState.zones.length > 0;
  const fieldDisabled = !admin || busy;
  const submitDisabled = !admin || busy || !zonesReady;
  const badge = signedIn ? listState.badge : 'SIN CONSULTAR';
  const countLabel =
    listState.phase === 'read'
      ? `${listState.observations.length} ${listState.observations.length === 1 ? 'observación' : 'observaciones'}`
      : listState.badge;
  // A refused token closes the session, so the list falls back to its idle state;
  // the captured refusal is shown instead, because it carries the request id.
  const statusText =
    listState.phase === 'unconsulted' && notice !== '' ? notice : listState.phase === 'unconsulted' ? idleCopy(session, LIST_ACTION) : listState.message;
  const roleNote = !signedIn
    ? 'Conecta una sesión para registrar observaciones: la página no concede permisos.'
    : admin
      ? 'Tu token declara el rol admin, así que esta página ofrece el registro. La firma del token no se verifica aquí: el servidor fija el autor desde el token verificado y decide cada permiso; su respuesta se muestra tal cual.'
      : session.roles === null
        ? 'Tu token no declara un rol utilizable, así que el registro queda deshabilitado. Puedes leer las observaciones; el servidor sigue siendo la única autoridad y su negativa se mostraría tal cual.'
        : 'Tu token no declara el rol admin, así que el registro queda deshabilitado en esta página. Puedes leer las observaciones; el servidor decide cada permiso y su negativa se mostraría tal cual.';

  return (
    <section className="view" id="observations" data-view="observations" aria-labelledby="observations-title">
      <div className="intro-row">
        <div>
          <p className="eyebrow">PREVENCIÓN · PM-09</p>
          <h2 id="observations-title">Observaciones de campo</h2>
        </div>
        <span className="neutral-tag" id="observations-badge">
          {badge}
        </span>
      </div>
      <p className="subheading" id="observations-lede">
        Una observación exige zona, tipo, fecha y descripción. El tipo sale de un catálogo cerrado, la zona del
        catálogo real del servicio y el autor lo toma el servidor del token verificado: el cliente no lo envía.
      </p>
      <p
        id="observations-status"
        className={listState.phase === 'read' ? 'status-copy risk-good' : 'status-copy'}
        role="status"
        aria-live="polite"
      >
        {statusText}
      </p>

      <div className="observations-layout">
        <article className="panel observations-panel" aria-labelledby="observation-form-title">
          <PanelHeading eyebrow="REGISTRO DE CAMPO" title="Nueva observación" titleId="observation-form-title" />
          <p className="panel-note" id="observation-role-note">
            {roleNote}
          </p>
          <p className="panel-note" id="observation-zones-status" role="status" aria-live="polite">
            {zonesState.message}
          </p>
          {zonesState.phase === 'unavailable' ? (
            <button
              id="observation-zones-retry"
              className="secondary-button"
              type="button"
              onClick={retryZones}
            >
              Reintentar catálogo de zonas
            </button>
          ) : null}

          <form id="observation-form" className="observations-form" onSubmit={submit}>
            <div className="field">
              <label htmlFor="observation-zone">Zona o sector</label>
              <select
                id="observation-zone"
                required
                value={form.zoneId}
                disabled={fieldDisabled || !zonesReady}
                aria-describedby="observation-zone-note"
                onChange={event => setForm(previous => ({ ...previous, zoneId: event.target.value }))}
              >
                <option value="">Selecciona una zona del catálogo</option>
                {zonesState.zones.map(zone => (
                  <option key={zone.code} value={zone.code}>
                    {zoneOptionLabel(zone)}
                  </option>
                ))}
              </select>
              <p className="field-note" id="observation-zone-note">
                En producción, la zona la fija el catálogo del servicio; las zonas sin geometría de mapa también se
                pueden registrar.
              </p>
            </div>

            <div className="field">
              <label htmlFor="observation-type">Tipo de observación</label>
              <select
                id="observation-type"
                required
                value={form.type}
                disabled={fieldDisabled}
                aria-describedby="observation-type-note"
                onChange={event => setForm(previous => ({ ...previous, type: event.target.value }))}
              >
                <option value="">Selecciona un tipo del catálogo</option>
                {OBSERVATION_TYPES.map(type => (
                  <option key={type} value={type}>
                    {OBSERVATION_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
              <p className="field-note" id="observation-type-note">
                Catálogo cerrado de PM-09. Un valor fuera de esta lista lo rechaza el servidor; no hay campo libre de
                tipo.
              </p>
            </div>

            <div className="field">
              <label htmlFor="observation-date">Fecha de la observación</label>
              <input
                id="observation-date"
                type="date"
                required
                value={form.observedOn}
                disabled={fieldDisabled}
                aria-describedby="observation-date-note"
                onChange={event => setForm(previous => ({ ...previous, observedOn: event.target.value }))}
              />
              <p className="field-note" id="observation-date-note">
                La fecha la elige la persona que registra; la página no impone un rango fijo.
              </p>
            </div>

            <div className="field">
              <label htmlFor="observation-description">Descripción</label>
              <textarea
                id="observation-description"
                rows={3}
                maxLength={240}
                required
                value={form.description}
                disabled={fieldDisabled}
                aria-describedby="observation-description-hint observation-description-count"
                onChange={event => setForm(previous => ({ ...previous, description: event.target.value }))}
              />
              <p className="field-meta" id="observation-description-hint">
                <span>Qué se vio y dónde, sin conclusiones sobre el riesgo.</span>
                <span id="observation-description-count">{`${form.description.length} / 240`}</span>
              </p>
            </div>

            <div className="author-note" id="observation-author-note">
              <p>
                <strong>AUTOR</strong> Lo toma el servidor del token verificado y el cliente no lo envía. La
                observación queda atribuida a la sesión conectada, no a un nombre escrito aquí.
              </p>
            </div>

            <div className="form-actions">
              <button id="observation-submit" className="primary-button" type="submit" disabled={submitDisabled}>
                {busy ? 'Guardando…' : 'Guardar observación'}
              </button>
              <p className="panel-note">
                El servicio valida la zona, el tipo, la fecha y la descripción antes de guardar. Un rechazo conserva lo
                escrito.
              </p>
            </div>

            <p id="observation-feedback" className="status-copy" role="status" aria-live="polite">
              {notice}
            </p>
          </form>
        </article>

        <article className="panel observations-list-panel" aria-labelledby="observation-list-title">
          <PanelHeading
            eyebrow="LISTADO"
            title="Observaciones registradas"
            titleId="observation-list-title"
            badge={
              <span className="count-badge" id="observation-count">
                {countLabel}
              </span>
            }
          />

          <div className="observations-toolbar">
            <div className="field">
              <label htmlFor="observation-filter">Filtrar por tipo</label>
              <select
                id="observation-filter"
                value={filterType}
                disabled={!signedIn}
                onChange={event => selectFilter(event.target.value)}
              >
                <option value="">Todos los tipos</option>
                {OBSERVATION_TYPES.map(type => (
                  <option key={type} value={type}>
                    {OBSERVATION_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
            </div>
            <button
              id="observation-filter-reset"
              className="secondary-button"
              type="button"
              disabled={!signedIn || filterType === ''}
              onClick={clearFilter}
            >
              Quitar filtro
            </button>
          </div>

          <p className="panel-note" id="observation-list-note">
            La lista se lee de <code>/v1/prevention/observations</code>, más reciente primero. El filtro es una
            consulta al servicio, no un filtro local, y la atribución de cada fila es la que guardó el servidor.
          </p>

          <ul className="observation-list" id="observation-rows" aria-busy={listState.phase === 'loading'}>
            {listState.observations.map(entry => (
              <li key={entry.id} className="observation-item" data-observation-id={entry.id}>
                <div className="observation-item-head">
                  <strong>{observationTypeLabel(entry.type)}</strong>
                  <span className="observation-date">{entry.observed_on}</span>
                </div>
                <p className="observation-zone">{zoneLabel(entry)}</p>
                <p className="observation-description">{entry.description}</p>
                <p className="observation-meta">
                  Registrada por {entry.created_by} · {entry.created_at}
                </p>
              </li>
            ))}
          </ul>

          {listState.phase === 'read' && listState.observations.length === 0 ? (
            <div className="empty-state" id="observation-empty">
              {filterType === '' ? (
                <>
                  <p>
                    <strong>El servicio todavía no registra observaciones de campo.</strong>
                  </p>
                  <p className="panel-note">
                    Cuando se guarde una, aparecerá aquí leída del servicio, no de un borrador local.
                  </p>
                </>
              ) : (
                <>
                  <p>
                    <strong>No hay observaciones registradas de ese tipo.</strong>
                  </p>
                  <p className="panel-note">
                    El filtro no se borró. Quítalo para volver a las observaciones del servicio.
                  </p>
                  <button id="observation-empty-reset" className="secondary-button" type="button" onClick={clearFilter}>
                    Quitar el filtro
                  </button>
                </>
              )}
            </div>
          ) : null}
        </article>
      </div>
    </section>
  );
}
