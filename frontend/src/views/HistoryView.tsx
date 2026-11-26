import { useEffect, useMemo, useRef, useState } from 'react';

import { idleCopy, rejectedSessionCopy } from '../app/sessionCopy';
import {
  getHistoryFilters,
  getSelectedZone,
  resetHistoryFilters,
  setHistoryQuery,
  setHistoryStatus,
  useHistoryFilters,
  useSelectedZone,
  useSessionState,
} from '../app/store';
import { DataList, Icon, TableWrap } from '../components/ui';
import {
  history,
  historySeries,
  historySeriesWindow,
  type Failure,
  type HistoryGranularity,
  type HistoryZoneSeries,
} from '../core/api';
import { historyCsv, saveHistoryCsv } from '../core/history-csv';
import { getSessionSnapshot } from '../core/session';
import {
  filterHistoryRows,
  historyStatusOptions,
  historyVisibleCount,
  levelLabel,
  selectHistoryStatus,
} from '../domain';
import type { RiskBatch } from '../types/api';

// N8b + PM-04 — the history view has two scopes.
//
// «Por zona» is the panel the page already shipped: the rows
// `/v1/risk/history` returned for the SELECTED zone (the route requires
// `zone_id`), its in-memory search and data-status filter, and its CSV export.
// Search and filter narrow ONLY those rows: they issue no read and cannot reach
// another zone.
//
// «Todas las zonas» is the additive granular series: one read of
// `/v1/risk/history/series` with no `zone_id`, one bucket size (hour, day or
// week) and a window capped at what the route accepts (48 h for hours, 31 days
// for days and weeks). The service reports the newest published batch per
// bucket and fills no gaps, so the view renders exactly the intervals it was
// served, each with its own `bucket_start`, and never interpolates between them.
//
// The two reads have separate lifecycles on purpose: a series failure cannot
// empty the per-zone table, and a per-zone failure cannot empty the series.

type HistoryStatus =
  | { kind: 'signed-out' }
  | { kind: 'no-zone' }
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'ready'; allDemo: boolean }
  | { kind: 'failure'; failure: Failure };

// The export has its own lifecycle, keyed to the zone it was read for. It is not
// part of the table status: a download can be in flight while the table shows
// rows, fail while the table stays readable, and vice versa.
type DownloadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'saved'; filename: string; headerOnly: boolean }
  | { kind: 'failure'; failure: Failure };

const EXPORT_NO_FILE = ' No se descargó ningún archivo.';

function exportFailureMessage(failure: Failure): string {
  switch (failure.kind) {
    case 'unauthorized':
      return `${rejectedSessionCopy()}${EXPORT_NO_FILE}`;
    case 'forbidden':
      return `La API denegó el permiso para exportar el historial (403).${EXPORT_NO_FILE}`;
    case 'malformed':
      return `La API no devolvió una exportación CSV legible.${EXPORT_NO_FILE}`;
    case 'missing':
      return `No existe historial exportable para la zona consultada (404).${EXPORT_NO_FILE}`;
    case 'unavailable':
      if (failure.reason === 'save_failed') return `El navegador no pudo guardar el archivo.${EXPORT_NO_FILE}`;
      return failure.status !== undefined
        ? `No se pudo descargar el historial (HTTP ${failure.status}).${EXPORT_NO_FILE}`
        : `No se pudo descargar el historial (sin conexión).${EXPORT_NO_FILE}`;
  }
}

function exportMessage(state: DownloadState, signedIn: boolean, zone: string): string {
  switch (state.kind) {
    case 'loading':
      return `Preparando la descarga del historial de la zona ${zone}…`;
    case 'saved':
      // The empty answer is a valid export of the header row alone, so it is
      // stated as that instead of as a failure or as a document with rows.
      return state.headerOnly
        ? `Descarga iniciada: ${state.filename} — solo el encabezado, porque la API no devolvió filas para esta zona.`
        : `Descarga iniciada: ${state.filename} — las mismas filas que la API devuelve para la zona.`;
    case 'failure':
      return exportFailureMessage(state.failure);
    case 'idle':
      if (!signedIn) return 'La descarga necesita una sesión autorizada; no se solicitó nada.';
      if (zone === '') return 'Selecciona una zona para descargar su historial.';
      return `Listo para descargar el historial de la zona ${zone}.`;
  }
}

// The export row. It is its own component because it is its own lifecycle, and
// the parent REMOUNTS it for every selection/session instance (see the `key` at
// the render site). A download belongs to the selection it was started in:
// keying the state by zone id alone was not enough, because returning to a zone
// whose request had been abandoned restored that dead `loading` state and made
// every retry impossible. A new instance starts idle, which is what it is.
function HistoryExport({ zone, signedIn }: { zone: string; signedIn: boolean }) {
  const [state, setState] = useState<DownloadState>({ kind: 'idle' });
  const abort = useRef<AbortController | null>(null);

  // This instance is unmounted both when the view leaves and when the selection
  // or the session changes (the parent's key). Either way its in-flight request
  // is aborted, so its bytes can never be saved under a different context. The
  // state does not need clearing here: it belongs to this instance, and the next
  // context gets a new one.
  useEffect(() => {
    return () => {
      abort.current?.abort();
      abort.current = null;
    };
  }, []);

  const busy = state.kind === 'loading';
  // Without a session or a selection there is nothing the export could read.
  const blocked = !signedIn || zone === '';

  const start = (): void => {
    if (blocked || busy) return;
    const selection = zone;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setState({ kind: 'loading' });
    void historyCsv(selection, controller.signal).then((outcome) => {
      // Only the newest export may answer, and only while its own zone is still
      // the selection in the stores — the authoritative read, not this render's
      // props, so an answer that lands across a selection or session change is
      // dropped instead of saved.
      if (abort.current !== controller) return;
      if (getSelectedZone() !== selection || getSessionSnapshot().status !== 'signed-in') return;
      abort.current = null;
      if (!outcome.ok) {
        setState({ kind: 'failure', failure: outcome.failure });
        return;
      }
      try {
        saveHistoryCsv(outcome.data);
      } catch {
        // A browser that refuses the save (no object URLs, a blocked download) is
        // a stated outcome, never an empty success.
        setState({ kind: 'failure', failure: { kind: 'unavailable', reason: 'save_failed' } });
        return;
      }
      setState({
        kind: 'saved',
        filename: outcome.data.filename,
        headerOnly: outcome.data.headerOnly,
      });
    });
  };

  return (
    <div className="history-export">
      <button
        id="history-csv-download"
        className="secondary-button"
        type="button"
        // `disabled` only when the export cannot be attempted at all. While a
        // download is in flight the control keeps focus through `aria-disabled`
        // and `aria-busy`, so the keyboard reader does not lose its place and the
        // status region announces the work.
        disabled={blocked}
        aria-disabled={blocked || busy || undefined}
        aria-busy={busy || undefined}
        aria-describedby="history-csv-note"
        onClick={start}
      >
        Descargar CSV
      </button>
      <p id="history-csv-note" className="panel-note">
        Descarga el historial de la zona seleccionada tal como lo devuelve <code>/v1/risk/history.csv</code>: las filas
        que la API devuelve para la zona, sin aplicar la búsqueda ni el filtro de estado de la tabla. El archivo no se
        recodifica; cada fila declara su zona, su fecha de publicación y si el dato es sintético.
      </p>
      <p
        id="history-csv-status"
        className={state.kind === 'failure' ? 'status-copy risk-error' : 'status-copy'}
        role="status"
        aria-live="polite"
      >
        {exportMessage(state, signedIn, zone)}
      </p>
    </div>
  );
}

interface LoadedHistory {
  rows: RiskBatch[];
  status: Extract<HistoryStatus, { kind: 'empty' | 'ready' | 'failure' }>;
}

const EMPTY_ROWS: RiskBatch[] = [];

function failureMessage(failure: Failure): string {
  if (failure.reason === 'zone_mismatch') {
    return 'La API devolvió un historial de otra zona; se descartó.';
  }
  switch (failure.kind) {
    case 'unauthorized':
      return rejectedSessionCopy();
    case 'forbidden':
      return 'La API denegó el permiso para consultar el historial (403). Solicita acceso a un administrador.';
    case 'malformed':
      return 'La API devolvió un historial ilegible; no se muestran filas.';
    case 'missing':
      return 'No existe historial para la zona consultada (404).';
    case 'unavailable':
      return failure.status !== undefined
        ? `No se pudo consultar el historial (HTTP ${failure.status}).`
        : 'No se pudo consultar el historial (sin conexión).';
  }
}

function stateMessage(status: HistoryStatus, signedOutMessage: string): string {
  switch (status.kind) {
    case 'signed-out':
      return signedOutMessage;
    case 'no-zone':
      return 'Selecciona una zona para consultar el historial.';
    case 'loading':
      return 'Consultando historial…';
    case 'empty':
      return 'La API devolvió un historial vacío.';
    case 'ready':
      return status.allDemo ? 'Registros sintéticos devueltos por la API.' : 'Registros devueltos por la API.';
    case 'failure':
      return failureMessage(status.failure);
  }
}

// --- PM-04 — the granular series -------------------------------------------

type HistoryScope = 'zone' | 'all';

// The series has its own states. It needs no zone, because omitting `zone_id` is
// exactly what asks for every zone that published in the window.
type SeriesStatus =
  | { kind: 'signed-out' }
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'ready'; zones: number; allSynthetic: boolean }
  | { kind: 'failure'; failure: Failure };

interface LoadedSeries {
  // The window the request asked for. It is stated as text beside the answer, so
  // the reader can see exactly which interval produced the series.
  range: { from: string; to: string };
  series: HistoryZoneSeries[];
  status: Extract<SeriesStatus, { kind: 'empty' | 'ready' | 'failure' }>;
}

// The question a stored series answers. The session state, the scope, the
// selected zone and the bucket size are its four inputs, and the answer is
// attributed to all four — never to the bucket size alone.
//
// The identity of the question is the key, not a digest of its inputs: a digest
// repeats when the same inputs come back, so leaving «Todas las zonas» and
// returning to it would match the answer read for the earlier visit. A question
// object is minted per combination, so the answer of an abandoned visit can never
// be attributed to the new one.
interface SeriesQuestion {
  readonly signedIn: boolean;
  readonly scope: HistoryScope;
  readonly selectedZone: string;
  readonly granularity: HistoryGranularity;
}

const EMPTY_SERIES: HistoryZoneSeries[] = [];

// The three bucket sizes the route serves, spelled with the cut the contract
// states: hours are UTC hours, day and week buckets are America/Santiago civil
// days and Monday-starting weeks.
const GRANULARITY_LABELS: Record<HistoryGranularity, string> = {
  hour: 'Horas (intervalo UTC)',
  day: 'Días (día civil de America/Santiago)',
  week: 'Semanas (semana civil, lunes)',
};

const GRANULARITY_CAPS: Record<HistoryGranularity, string> = {
  hour: '48 h',
  day: '31 días',
  week: '31 días',
};

function zoneCountLabel(zones: number): string {
  return zones === 1 ? '1 zona' : `${zones} zonas`;
}

function seriesFailureMessage(failure: Failure): string {
  // An answer that echoes another window or zone describes another question, so
  // it is named as that instead of being shown as this query's series.
  if (failure.reason === 'window_mismatch') {
    return 'La API devolvió una serie de otra ventana o granularidad; se descartó.';
  }
  if (failure.reason === 'zone_mismatch') {
    return 'La API devolvió una serie de otra zona; se descartó.';
  }
  switch (failure.kind) {
    case 'unauthorized':
      return rejectedSessionCopy();
    case 'forbidden':
      return 'La API denegó el permiso para consultar la serie (403). Solicita acceso a un administrador.';
    case 'malformed':
      return 'La API devolvió una serie ilegible; no se muestran intervalos.';
    case 'missing':
      return 'La serie consultada no está disponible (404).';
    case 'unavailable':
      return failure.status !== undefined
        ? `No se pudo consultar la serie de todas las zonas (HTTP ${failure.status}).`
        : 'No se pudo consultar la serie de todas las zonas (sin conexión).';
  }
}

function seriesStateMessage(status: SeriesStatus, signedOutMessage: string): string {
  switch (status.kind) {
    case 'signed-out':
      return signedOutMessage;
    case 'loading':
      return 'Consultando la serie de todas las zonas…';
    case 'empty':
      return 'La API devolvió una serie vacía: ninguna zona publicó lotes en la ventana consultada.';
    case 'ready':
      return status.allSynthetic
        ? `${zoneCountLabel(status.zones)} con intervalos publicados; todos los intervalos declaran dato sintético.`
        : `${zoneCountLabel(status.zones)} con al menos un intervalo publicado en la ventana.`;
    case 'failure':
      return seriesFailureMessage(status.failure);
  }
}

export function HistoryView() {
  const session = useSessionState();
  const selectedZone = useSelectedZone();
  const signedIn = session.status === 'signed-in';

  // The scope and the bucket size are the only two controls this unit adds. The
  // page keeps «Por zona» as its default, so every route and export the panel
  // already offered is reached exactly as before.
  const [scope, setScope] = useState<HistoryScope>('zone');
  const [granularity, setGranularity] = useState<HistoryGranularity>('day');

  // The loaded rows travel with the zone they were read for, so a sign-out or a
  // zone change cannot keep showing another zone's rows: the derived status and
  // the rendered rows both require the stored key to match the current selection.
  const [stored, setStored] = useState<{ key: string; loaded: LoadedHistory } | null>(null);
  // The series travels with the question it answers, for the same reason. A new
  // object is minted whenever any of the four inputs changes — including a return
  // to a combination seen before — so a stored answer only ever describes the
  // current question, and nothing has to be cleared before the read starts.
  const seriesQuestion: SeriesQuestion = useMemo(
    () => ({ signedIn, scope, selectedZone, granularity }),
    [signedIn, scope, selectedZone, granularity],
  );
  const [seriesStored, setSeriesStored] = useState<{ question: SeriesQuestion; loaded: LoadedSeries } | null>(null);
  // The filters are shared state, not local: the footer's reset control owns them
  // too, and a search term must not survive a sign-out.
  const { query, status: statusFilter } = useHistoryFilters();

  useEffect(() => {
    if (!signedIn || scope !== 'zone' || selectedZone === '') return;
    const controller = new AbortController();
    let active = true;
    void history(selectedZone, controller.signal).then((outcome) => {
      if (!active) return;
      if (!outcome.ok) {
        setStored({
          key: selectedZone,
          loaded: { rows: [], status: { kind: 'failure', failure: outcome.failure } },
        });
        return;
      }
      const data = outcome.data;
      // A status option that no longer exists in the fresh read is dropped, so a
      // stale selection cannot silently narrow rows that no longer carry it.
      setHistoryStatus(selectHistoryStatus(getHistoryFilters().status, historyStatusOptions(data)));
      setStored({
        key: selectedZone,
        loaded: {
          rows: data,
          status:
            data.length === 0
              ? { kind: 'empty' }
              : { kind: 'ready', allDemo: data.every((batch) => batch.demo === true) },
        },
      });
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [signedIn, scope, selectedZone]);

  // The series read. It asks for the whole window the route accepts for the
  // selected granularity and sends no `zone_id`, which is what makes the answer
  // "every zone that published in the window" instead of one zone's history.
  //
  // Nothing is cleared before the read starts, and nothing has to be: the answer
  // is filed under the question above, so as soon as any of its inputs changes the
  // render side stops attributing it to the current question and states the load.
  useEffect(() => {
    if (!signedIn || scope !== 'all') return;
    const controller = new AbortController();
    let active = true;
    const range = historySeriesWindow(granularity);
    void historySeries({ ...range, granularity }, controller.signal).then((outcome) => {
      if (!active) return;
      if (!outcome.ok) {
        setSeriesStored({
          question: seriesQuestion,
          loaded: { range, series: [], status: { kind: 'failure', failure: outcome.failure } },
        });
        return;
      }
      const series = outcome.data.series;
      setSeriesStored({
        question: seriesQuestion,
        loaded: {
          range,
          series,
          status:
            series.length === 0
              ? { kind: 'empty' }
              : {
                  kind: 'ready',
                  zones: series.length,
                  allSynthetic: series.every((entry) => entry.buckets.every((bucket) => bucket.synthetic === true)),
                },
        },
      });
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [signedIn, scope, granularity, seriesQuestion]);

  const current =
    signedIn && selectedZone !== '' && stored !== null && stored.key === selectedZone ? stored.loaded : null;
  const status: HistoryStatus = !signedIn
    ? { kind: 'signed-out' }
    : selectedZone === ''
      ? { kind: 'no-zone' }
      : current !== null
        ? current.status
        : { kind: 'loading' };
  const rows = current !== null ? current.rows : EMPTY_ROWS;

  // The series describes a question, so an answer is rendered only for the exact
  // question it was read for: a scope, granularity, zone or session change stops
  // the match immediately, and the previous answer is never painted as this one's.
  const seriesCurrent =
    signedIn && scope === 'all' && seriesStored !== null && seriesStored.question === seriesQuestion
      ? seriesStored.loaded
      : null;
  const seriesStatus: SeriesStatus = !signedIn
    ? { kind: 'signed-out' }
    : seriesCurrent !== null
      ? seriesCurrent.status
      : { kind: 'loading' };
  const series = seriesCurrent !== null ? seriesCurrent.series : EMPTY_SERIES;
  const range = seriesCurrent !== null ? seriesCurrent.range : null;

  const options = useMemo(() => historyStatusOptions(rows), [rows]);
  const visible = useMemo(
    () => filterHistoryRows(rows, { query, status: statusFilter }) as RiskBatch[],
    [rows, query, statusFilter],
  );

  const zoneLoaded = status.kind === 'ready' || status.kind === 'empty';
  const seriesLoaded = seriesStatus.kind === 'ready' || seriesStatus.kind === 'empty';
  // The badge reports what the ACTIVE scope returned: rows for one zone, zones
  // for the whole territory. It never mixes the two counts.
  const countLabel =
    scope === 'all'
      ? seriesLoaded
        ? String(series.length)
        : '—'
      : zoneLoaded
        ? String(rows.length)
        : '—';
  const visibleLabel = zoneLoaded ? historyVisibleCount(visible.length, rows.length) : '—';
  // The stylesheet hides the empty table and the filter bar of a panel that does
  // not carry `has-rows`, so this class reports the rows the active scope
  // returned — not the rows that survived the filter. A search that narrows the
  // table to zero rows must not hide the controls that clear it.
  const hasRows = scope === 'all' ? series.length > 0 : rows.length > 0;
  // A zone that returned no row at all is not a zone measured as low risk, and
  // the artboard says so instead of leaving one sentence. Rows hidden by the
  // filters are a different state: the data exists, so the panel offers the
  // whole period back through the same reset the shell's control uses.
  const filtersActive = query !== '' || statusFilter !== '';
  const hiddenByFilters = zoneLoaded && rows.length > 0 && visible.length === 0 && filtersActive;

  return (
    <section className="view" id="history" data-view="history" aria-labelledby="history-title">
      <div className="intro-row">
        <div>
          <p className="eyebrow">TRAZABILIDAD</p>
          <h2 id="history-title">Historial de lotes</h2>
        </div>
        {/* The badge shows a number; a reader needs the noun. The name sits in the
            document before the number, so the reading matches what the badge means. */}
        <span className="sr-only">Lotes devueltos: </span>
        <span
          className="count-badge"
          id="history-count"
          // The badge reports the ACTIVE scope, so its meaning travels with it:
          // rows of the selected zone, or zones with a series in the window.
          title={scope === 'all' ? 'Zonas con serie en la ventana' : 'Registros devueltos por la API'}
        >
          {countLabel}
        </span>
      </div>
      <article className={`panel history-panel${hasRows ? ' has-rows' : ''}`}>
        <p className="panel-note">
          {scope === 'zone' ? (
            <>
              Registros devueltos por <code>/v1/risk/history</code>; sin agregar métricas calculadas.
            </>
          ) : (
            <>
              Serie devuelta por <code>/v1/risk/history/series</code>: el último lote publicado por intervalo, sin
              relleno de huecos. Un intervalo sin publicación no aparece y ningún nivel se interpola entre intervalos.
            </>
          )}
        </p>
        <div className="history-scope-bar">
          <label className="filter-label">
            Alcance del historial
            <select
              id="history-scope"
              aria-label="Elegir el alcance del historial"
              value={scope}
              onChange={(event) => setScope(event.target.value === 'all' ? 'all' : 'zone')}
            >
              <option value="zone">Por zona</option>
              <option value="all">Todas las zonas</option>
            </select>
          </label>
          {scope === 'all' && (
            <label className="filter-label">
              Granularidad
              <select
                id="history-granularity"
                aria-label="Elegir la granularidad de la serie"
                value={granularity}
                onChange={(event) =>
                  setGranularity(
                    event.target.value === 'hour' ? 'hour' : event.target.value === 'week' ? 'week' : 'day',
                  )
                }
              >
                <option value="hour">Horas</option>
                <option value="day">Días</option>
                <option value="week">Semanas</option>
              </select>
            </label>
          )}
        </div>
        {scope === 'zone' ? (
          <>
            <div className="filter-bar">
              <div className="search-field">
                <Icon name="search" />
                <input
                  id="history-query"
                  type="search"
                  aria-label="Buscar en el historial de la zona"
                  placeholder="Buscar por fecha, estado o lote"
                  value={query}
                  onChange={(event) => setHistoryQuery(event.target.value)}
                />
              </div>
              <label className="filter-label">
                Estado del dato
                <select
                  id="history-status-filter"
                  aria-label="Filtrar el historial por estado del dato"
                  value={statusFilter}
                  onChange={(event) => setHistoryStatus(event.target.value)}
                >
                  <option value="">Todos los estados</option>
                  {options.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <span className="result-count" id="history-visible-count" role="status" aria-live="polite">
                {visibleLabel}
              </span>
            </div>
            <div id="history-state" className={status.kind === 'failure' ? 'empty-state risk-error' : 'empty-state'}>
              {stateMessage(status, idleCopy(session, 'consultar el historial'))}
              {status.kind === 'empty' ? (
                <>
                  <strong>Esta zona no tiene lotes ni evaluación al corte.</strong>
                  <p>La ausencia de datos no es un nivel bajo. Cambia de zona o revisa el corte compartido.</p>
                </>
              ) : null}
              {hiddenByFilters ? (
                <>
                  <strong>No hay lotes que coincidan con los filtros.</strong>
                  <p>Los filtros no cambian los datos: ocultan filas que la API ya devolvió.</p>
                  <button
                    id="history-show-period"
                    className="secondary-button"
                    type="button"
                    onClick={resetHistoryFilters}
                  >
                    Ver todo el periodo
                  </button>
                </>
              ) : null}
            </div>
            <TableWrap label="Historial de lotes de la zona">
              <table>
                <thead>
                  <tr>
                    <th>Solicitado</th>
                    <th>Estado</th>
                    <th>Lote</th>
                  </tr>
                </thead>
                <tbody id="history-rows">
                  {visible.map((batch) => (
                    <tr key={batch.id}>
                      <td>{batch.requested_at ?? 'No informado'}</td>
                      <td>{batch.data_status ?? 'No informado'}</td>
                      <td>{batch.id}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            {/* The export row sits outside `.filter-bar` on purpose: a history with
                no rows hides the filter bar, while a header-only export is still a
                valid answer and must be able to say that it carries no rows.
                The key is the instance identity: the download state belongs to the
                selection and session it was started in, so leaving and returning
                gets a fresh, idle control instead of an abandoned request's state. */}
            <HistoryExport
              key={`${signedIn ? 'open' : 'closed'}:${selectedZone}`}
              zone={selectedZone}
              signedIn={signedIn}
            />
          </>
        ) : (
          <>
            <div
              id="history-state"
              className={seriesStatus.kind === 'failure' ? 'empty-state risk-error' : 'empty-state'}
              // The series is its own request with its own states, so its region
              // announces the load and the answer instead of repainting silently.
              role="status"
              aria-live="polite"
            >
              {seriesStateMessage(seriesStatus, idleCopy(session, 'consultar la serie de todas las zonas'))}
            </div>
            {/* The window is stated as text, with the cap of the selected
                granularity, so the reader knows exactly which interval the answer
                describes. Each interval then declares its own `bucket_start`. */}
            {range !== null && (
              <div className="history-series-range" id="history-series-range">
                <DataList
                  compact
                  items={[
                    { label: 'Ventana consultada: desde', value: <code>{range.from}</code> },
                    { label: 'Ventana consultada: hasta', value: <code>{range.to}</code> },
                    { label: 'Granularidad', value: GRANULARITY_LABELS[granularity] },
                    { label: 'Tope del endpoint', value: GRANULARITY_CAPS[granularity] },
                  ]}
                />
              </div>
            )}
            {series.length > 0 && (
              <ul id="history-series" className="history-series" aria-label="Series de riesgo por zona">
                {series.map((entry) => (
                  <li key={entry.zone_id} className="history-series-zone">
                    <p className="history-series-zone-head">
                      <strong>Zona {entry.zone_id}</strong>
                      <span className="history-series-count">
                        {entry.buckets.length === 1 ? '1 intervalo' : `${entry.buckets.length} intervalos`}
                      </span>
                    </p>
                    <ul className="history-buckets" aria-label={`Intervalos de la zona ${entry.zone_id}`}>
                      {entry.buckets.map((bucket) => (
                        <li key={bucket.bucket_start} className="history-bucket">
                          <span className="history-bucket-start">
                            <code>{bucket.bucket_start}</code>
                          </span>
                          <span className="history-bucket-level">{levelLabel(bucket.risk_level)}</span>
                          <span className="history-bucket-provenance">
                            lote <code>{bucket.batch_id}</code> · modelo <code>{bucket.model_version}</code>
                          </span>
                          <span className={bucket.synthetic ? 'history-bucket-demo' : 'history-bucket-neutral'}>
                            {bucket.synthetic ? 'Dato sintético' : 'Sin marca sintética'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
            <p className="panel-note">
              Cada intervalo declara su propio inicio (<code>bucket_start</code>) y el lote que lo produjo. Las horas son
              intervalos UTC; los días y las semanas son cortes civiles de America/Santiago, así que el primer intervalo
              puede empezar antes del inicio de la ventana. La descarga CSV sigue siendo por zona y se ofrece en «Por
              zona».
            </p>
          </>
        )}
      </article>
    </section>
  );
}
