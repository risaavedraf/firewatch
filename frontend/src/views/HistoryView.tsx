import { useEffect, useMemo, useRef, useState } from 'react';

import { idleCopy, rejectedSessionCopy } from '../app/sessionCopy';
import {
  getHistoryFilters,
  getSelectedZone,
  setHistoryQuery,
  setHistoryStatus,
  useHistoryFilters,
  useSelectedZone,
  useSessionState,
} from '../app/store';
import { Icon, UnimplementedNote } from '../components/ui';
import { history, type Failure } from '../core/api';
import { historyCsv, saveHistoryCsv } from '../core/history-csv';
import { getSessionSnapshot } from '../core/session';
import {
  filterHistoryRows,
  historyStatusOptions,
  historyVisibleCount,
  selectHistoryStatus,
} from '../domain';
import type { RiskBatch } from '../types/api';

// N8b — the history view. The panel shows the rows `/v1/risk/history` returned
// for the SELECTED zone (the route requires `zone_id`), and search plus the
// data-status filter narrow ONLY those rows in memory: they issue no read and
// cannot reach another zone. The badge keeps reporting what the API returned
// while the result count reports what survived the filters, and the per-zone
// limit stays stated inside the view.

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

export function HistoryView() {
  const session = useSessionState();
  const selectedZone = useSelectedZone();
  const signedIn = session.status === 'signed-in';

  // The loaded rows travel with the zone they were read for, so a sign-out or a
  // zone change cannot keep showing another zone's rows: the derived status and
  // the rendered rows both require the stored key to match the current selection.
  const [stored, setStored] = useState<{ key: string; loaded: LoadedHistory } | null>(null);
  // The filters are shared state, not local: the footer's reset control owns them
  // too, and a search term must not survive a sign-out.
  const { query, status: statusFilter } = useHistoryFilters();

  useEffect(() => {
    if (!signedIn || selectedZone === '') return;
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
  }, [signedIn, selectedZone]);

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

  const options = useMemo(() => historyStatusOptions(rows), [rows]);
  const visible = useMemo(
    () => filterHistoryRows(rows, { query, status: statusFilter }) as RiskBatch[],
    [rows, query, statusFilter],
  );

  const loaded = status.kind === 'ready' || status.kind === 'empty';
  const countLabel = loaded ? String(rows.length) : '—';
  const visibleLabel = loaded ? historyVisibleCount(visible.length, rows.length) : '—';
  // The stylesheet hides the empty table and the filter bar of a panel that does
  // not carry `has-rows`, so this class reports the rows the API returned — not
  // the rows that survived the filter. A search that narrows the table to zero
  // rows must not hide the controls that clear it.
  const hasRows = rows.length > 0;

  return (
    <section className="view" id="history" data-view="history" aria-labelledby="history-title">
      <div className="intro-row">
        <div>
          <p className="eyebrow">TRAZABILIDAD</p>
          <h2 id="history-title">Historial de lotes</h2>
        </div>
        <span className="count-badge" id="history-count">
          {countLabel}
        </span>
      </div>
      <article className={`panel history-panel${hasRows ? ' has-rows' : ''}`}>
        <p className="panel-note">
          Registros devueltos por <code>/v1/risk/history</code>; sin agregar métricas calculadas.
        </p>
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
          <span className="result-count" id="history-visible-count">
            {visibleLabel}
          </span>
        </div>
        <div id="history-state" className={status.kind === 'failure' ? 'empty-state risk-error' : 'empty-state'}>
          {stateMessage(status, idleCopy(session, 'consultar el historial'))}
        </div>
        <div className="table-wrap">
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
        </div>
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
        <UnimplementedNote>
          Historial de todas las zonas: <code>/v1/risk/history</code> exige <code>zone_id</code> y no existe endpoint
          agregado, así que esta tabla muestra siempre la zona consultada.
        </UnimplementedNote>
      </article>
    </section>
  );
}
