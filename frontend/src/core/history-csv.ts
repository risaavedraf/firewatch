// PM-13 — the risk-history CSV export, read as a byte document.
//
// This module is deliberately separate from `core/api.ts`. The JSON transport is
// comparison-safe and unchanged: it parses and guards a payload, while this read
// downloads the bytes `/v1/risk/history.csv` already produced. Sharing the JSON
// request helper would have meant teaching it to skip `response.json()` and its
// guards, which is exactly the kind of shared-path change that turns a
// twenty-two-way differential match into a review question. The properties that
// DO travel with the JSON transport are copied here on purpose:
//
//   1. one monotonic sequence for this read kind, so a superseded export is
//      discarded instead of being saved after the selection changed;
//   2. the bearer is captured per request and a 401 lowers the session with the
//      same `rejected`/`null` distinction the JSON transport makes;
//   3. the caller's `AbortSignal` and a bounded deadline both stop the read, so a
//      hung gateway cannot leave a download pending forever.
//
// What this read will NOT do: apply the view's in-memory search or data-status
// filter (the export is the zone's history, not the filtered table), send a
// limit or an offset (the server owns the 100-row window and its order), parse
// and rebuild the document (the bytes are saved as served), or save anything at
// all unless the answer is a `200 text/csv` document. `206 Partial Content` is a
// successful HTTP status and still not this document, so it is a failure here.
// A failure is the shared JSON error body of the route this one mirrors, so it is
// a failure here too.
import { gatewayOrigin, routes } from '../config';
import type { Failure, FailureKind, Outcome } from './api';

import { getAccessToken, resetSession } from './session';

export interface HistoryCsvDocument {
  // The selection the document was read for, so the caller can relate the bytes
  // to the context that asked for them.
  zoneId: string;
  // Deterministic and locally built: the cross-origin page cannot read the
  // server's `Content-Disposition` (it is not a CORS-exposed header), and this
  // page does not ask for one to be exposed.
  filename: string;
  // The served bytes, unmodified. `blob`-saving them copies them verbatim; the
  // page never re-serialises a parsed document.
  bytes: Uint8Array;
  // True only when the body is the export's header alone, which is how an empty
  // history is declared (`200`, never `404`). It is a display flag, not a parse
  // result: see `headerOnlyBody`.
  headerOnly: boolean;
}

// The frozen column seam of the backend export
// (backend/services/risk/internal/handler/history_csv.go and
// backend/contracts/openapi/firewatch-v1.yaml). The page does not build a
// document from it and does not validate the columns it receives; it compares
// the body against this string only to tell "the header alone" apart from "the
// header and at least one record". A column change on the server therefore
// changes what this constant recognises, never what the download contains.
const HEADER_ROW =
  'zone_id,batch_id,job_id,requested_at,published_at,valid_until,model_version,risk_level,data_status,synthetic,scenario_id,evaluated_at';
const HEADER_BYTES = new TextEncoder().encode(HEADER_ROW);
const LINE_FEED = 0x0a;

// The same bound the JSON transport applies to one read. Kept local because this
// read is not that transport; the value is a policy and it is not user-tunable.
const DEADLINE_MS = 10_000;

// How long the object URL must outlive the click that starts the save. The
// download begins synchronously in `click()`; this delay only keeps the bytes
// reachable long enough for browsers that read the blob on a later task, and it
// is the delay FileSaver.js has used for that reason. No test in this repository
// observes a real browser save.
const REVOKE_DELAY_MS = 40;

const FILENAME_SEGMENT_LIMIT = 64;

function failureSpec(kind: FailureKind, reason: string, status?: number, requestId?: string): Failure {
  const failure: Failure = { kind, reason };
  if (status !== undefined) failure.status = status;
  if (requestId !== undefined && requestId !== '') failure.requestId = requestId;
  return failure;
}

function failureOutcome<T>(failure: Failure): Outcome<T> {
  return { ok: false, failure };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

// One counter for this kind only: the CSV read never supersedes the JSON
// `/history` read that filled the table, and vice versa.
let sequence = 0;

function nextSequence(): number {
  sequence += 1;
  return sequence;
}

function isSuperseded(requestSequence: number, token: string): boolean {
  return requestSequence !== sequence || token !== getAccessToken();
}

async function errorCode(response: Response, signal: AbortSignal): Promise<string> {
  try {
    const body: unknown = await abortable(response.json(), signal);
    if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
      const code = (body as Record<string, unknown>).code;
      if (typeof code === 'string' && code.trim() !== '') return code.trim();
    }
  } catch {
    // A non-JSON error body is not a reason to pretend the request succeeded:
    // the status below is the reason, exactly as it is for the JSON transport.
  }
  return `http_${response.status}`;
}

// The served document is UTF-8 CSV under one of the two spellings the contract
// allows (`text/csv` and `text/csv; charset=utf-8`). A 200 with another type is
// not this document — a proxy login page is the realistic case — so it is
// refused instead of being saved with a `.csv` name.
function isCsvContentType(value: string | null): boolean {
  if (value === null) return false;
  return value.split(';')[0].trim().toLowerCase() === 'text/csv';
}

function headerOnlyBody(bytes: Uint8Array): boolean {
  if (bytes.length < HEADER_BYTES.length) return false;
  for (let index = 0; index < HEADER_BYTES.length; index += 1) {
    if (bytes[index] !== HEADER_BYTES[index]) return false;
  }
  if (bytes.length === HEADER_BYTES.length) return true;
  // `encoding/csv` terminates every record with a bare LF: a header-only body is
  // the header plus one LF, and anything after that is a record.
  return bytes.length === HEADER_BYTES.length + 1 && bytes[HEADER_BYTES.length] === LINE_FEED;
}

// The local file name. It declares the selected zone and stays inside the small
// alphabet a download attribute may carry, so no separator, quote or control
// byte can reach the browser's save path. No clock is consulted: the same zone
// always produces the same name. The publication instant and the synthetic flag
// are declared inside the file, per row, where the server put them.
export function historyCsvFilename(zoneId: string): string {
  let segment = '';
  for (const character of zoneId) {
    segment += /[A-Za-z0-9_-]/.test(character) ? character : '_';
    if (segment.length >= FILENAME_SEGMENT_LIMIT) break;
  }
  return `risk-history-${segment === '' ? 'zona' : segment}.csv`;
}

// Reads the export for one zone. The only parameter sent is the selection: the
// display filters are the table's, the window and its order are the server's.
export async function historyCsv(zoneId: string, signal?: AbortSignal): Promise<Outcome<HistoryCsvDocument>> {
  const requestSequence = nextSequence();
  const token = getAccessToken();
  const controller = new AbortController();
  let stop: 'none' | 'aborted' | 'deadline' = 'none';
  const stopReason = (): 'none' | 'aborted' | 'deadline' => stop;
  const onCallerAbort = (): void => {
    stop = 'aborted';
    controller.abort();
  };
  if (signal) {
    if (signal.aborted) return failureOutcome<HistoryCsvDocument>(failureSpec('unavailable', 'aborted'));
    signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const deadline = setTimeout(() => {
    stop = 'deadline';
    controller.abort();
  }, DEADLINE_MS);
  try {
    const url = `${gatewayOrigin}${routes.historyCsv}?zone_id=${encodeURIComponent(zoneId)}`;
    const response = await abortable(
      fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        // The export is a snapshot of one read; it is never cached, and the
        // cookie the identity provider may hold is not part of this request.
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
      }),
      controller.signal,
    );
    // Supersession is checked before the status, so a stale 401 cannot reset the
    // session of the selection that replaced it — the JSON transport's rule.
    if (isSuperseded(requestSequence, token)) {
      return failureOutcome<HistoryCsvDocument>(failureSpec('unavailable', 'superseded'));
    }
    const requestId = response.headers.get('X-Request-ID') ?? '';
    if (response.status === 401) {
      resetSession(token !== '' ? 'rejected' : null);
      return failureOutcome<HistoryCsvDocument>(
        failureSpec('unauthorized', 'unauthorized', 401, requestId),
      );
    }
    if (response.status === 403) {
      return failureOutcome<HistoryCsvDocument>(failureSpec('forbidden', 'forbidden', 403, requestId));
    }
    // `response.ok` is true for 206 and every other 2xx, and a partial or
    // non-document success is not the export. The contract's success status is
    // 200 and only 200; every other status keeps the error mapping it had.
    if (response.status !== 200) {
      const reason = await errorCode(response, controller.signal);
      const kind: FailureKind =
        response.status === 400 ? 'malformed' : response.status === 404 ? 'missing' : 'unavailable';
      return failureOutcome<HistoryCsvDocument>(failureSpec(kind, reason, response.status, requestId));
    }
    if (!isCsvContentType(response.headers.get('Content-Type'))) {
      return failureOutcome<HistoryCsvDocument>(
        failureSpec('malformed', 'invalid_shape', response.status, requestId),
      );
    }    const bytes = new Uint8Array(await abortable(response.arrayBuffer(), controller.signal));
    if (isSuperseded(requestSequence, token)) {
      return failureOutcome<HistoryCsvDocument>(failureSpec('unavailable', 'superseded'));
    }
    // The contract's smallest document is the header row. A zero-byte 200 is not
    // that document, so it is refused rather than saved as an empty `.csv`.
    if (bytes.length === 0) {
      return failureOutcome<HistoryCsvDocument>(
        failureSpec('malformed', 'invalid_shape', response.status, requestId),
      );
    }
    return {
      ok: true,
      data: {
        zoneId,
        filename: historyCsvFilename(zoneId),
        bytes,
        headerOnly: headerOnlyBody(bytes),
      },
    };
  } catch {
    // Read through the accessor: the assignment happens in a callback, so the
    // control-flow analysis cannot see it.
    const reason = stopReason();
    if (reason === 'deadline') return failureOutcome<HistoryCsvDocument>(failureSpec('unavailable', 'deadline'));
    if (reason === 'aborted') return failureOutcome<HistoryCsvDocument>(failureSpec('unavailable', 'aborted'));
    return failureOutcome<HistoryCsvDocument>(failureSpec('unavailable', 'network'));
  } finally {
    clearTimeout(deadline);
    if (signal) signal.removeEventListener('abort', onCallerAbort);
  }
}

// Saves a served document. The bytes are copied into a Blob and handed to a
// synthetic anchor with `download`; nothing is parsed, re-quoted or re-encoded.
// The object URL is released after the click has started the download, so it
// cannot leak and cannot be revoked before the browser reads it.
export function saveHistoryCsv(csv: HistoryCsvDocument): void {
  const bytes = new Uint8Array(csv.bytes.length);
  bytes.set(csv.bytes);
  const blob = new Blob([bytes], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = csv.filename;
  anchor.rel = 'noopener';
  anchor.hidden = true;
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
  }
}
