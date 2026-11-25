import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { gatewayOrigin, issuer, pkceTransactionKey } from '../../src/config';
import { historyCsv, historyCsvFilename } from '../../src/core/history-csv';
import type { Failure, Outcome } from '../../src/core/api';
import { completeLogin, getAccessToken, getSessionSnapshot, resetSession } from '../../src/core/session';

import { createCryptoStub, createStorageStub, flush, jwt } from './harness';

// PM-13 — the CSV export transport. The unit is deliberately separate from
// `/v1/risk/history`: the JSON read is comparison-safe and unchanged, and this
// read only downloads the bytes the export route already produced.
//
// What this suite establishes: the request carries the selected zone and the
// session bearer and nothing else (no display filter, no limit, no offset); the
// served bytes are returned exactly, including a raw CRLF inside a quoted cell
// and the leading-LF spreadsheet guard; a header-only 200 is a successful
// document; every failure is a failure and never a document; a 401 keeps the
// session lifecycle of the JSON transport; and an aborted or superseded read
// cannot become a download.
//
// The fetch double lives here instead of `tests/core/harness.ts` because that
// shared double only speaks JSON, while this route is a byte document. Keeping
// the raw-response double local leaves every existing JSON suite untouched.

const TOKEN_URL = `${issuer}/protocol/openid-connect/token`;
const ZONE = '05102';
const CSV_URL = `${gatewayOrigin}/v1/risk/history.csv?zone_id=${ZONE}`;

// The frozen column seam of the export (backend/services/risk/internal/handler/
// history_csv.go, contracts/openapi/firewatch-v1.yaml). The page never builds a
// document from it; it names it only to recognise the header-only answer.
const HEADER =
  'zone_id,batch_id,job_id,requested_at,published_at,valid_until,model_version,risk_level,data_status,synthetic,scenario_id,evaluated_at';

interface Reply {
  status: number;
  body?: Uint8Array;
  json?: unknown;
  contentType?: string | null;
  requestId?: string;
}

interface StubCall {
  url: string;
  init: RequestInit;
}

// A transport double that can answer a raw byte document. `fetch` stays pending
// until the test answers it, exactly like the shared JSON double, so a test can
// assert the in-flight state and the abort paths.
function createCsvFetchStub() {
  const calls: StubCall[] = [];
  const pending: { url: string; resolve: (reply: Reply) => void }[] = [];

  const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return new Promise<Response>((resolve, reject) => {
      pending.push({ url, resolve: (reply: Reply) => resolve(toResponse(reply)) });
      const signal = init?.signal ?? null;
      if (signal === null) return;
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  };

  function take(url: string, which: 'first' | 'last' = 'first'): (reply: Reply) => void {
    const matches = pending.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.url === url);
    if (matches.length === 0) throw new Error(`no pending request for ${url}`);
    const chosen = which === 'last' ? matches[matches.length - 1] : matches[0];
    return pending.splice(chosen.index, 1)[0].resolve;
  }

  function bodyInit(reply: Reply): BodyInit {
    if (reply.json !== undefined) return JSON.stringify(reply.json);
    const bytes = reply.body ?? new Uint8Array();
    const copy = new ArrayBuffer(bytes.length);
    new Uint8Array(copy).set(bytes);
    return copy;
  }

  function toResponse(reply: Reply): Response {
    const headers = new Headers();
    if (reply.contentType !== null) headers.set('Content-Type', reply.contentType ?? 'text/csv; charset=utf-8');
    if (reply.requestId !== undefined && reply.requestId !== '') headers.set('X-Request-ID', reply.requestId);
    return new Response(bodyInit(reply), { status: reply.status, headers });
  }

  return {
    fetch,
    calls,
    answerCsv(url: string, text: string, status = 200, contentType = 'text/csv; charset=utf-8'): void {
      take(url)({ status, body: new TextEncoder().encode(text), contentType });
    },
    answerCsvBytes(url: string, bytes: Uint8Array, status = 200): void {
      take(url)({ status, body: bytes });
    },
    // Two identical in-flight reads are the supersession case; the newest one is
    // answered first so the older answer arrives after it.
    answerNewestCsv(url: string, text: string): void {
      take(url, 'last')({ status: 200, body: new TextEncoder().encode(text) });
    },
    answerJson(url: string, body: unknown, status: number): void {
      take(url)({ status, json: body, contentType: 'application/json' });
    },
    callsFor(url: string): StubCall[] {
      return calls.filter((call) => call.url === url);
    },
  };
}

function bytesEqual(actual: Uint8Array, expected: Uint8Array): boolean {
  if (actual.length !== expected.length) return false;
  return actual.every((value, index) => value === expected[index]);
}

function expectFailure<T>(outcome: Outcome<T>): Failure {
  if (outcome.ok) throw new Error('expected a failure outcome');
  return outcome.failure;
}

async function connect(stub: ReturnType<typeof createCsvFetchStub>): Promise<string> {
  const storageStub = createStorageStub();
  vi.stubGlobal('sessionStorage', storageStub.storage);
  vi.stubGlobal('crypto', createCryptoStub());
  vi.stubGlobal('fetch', stub.fetch);
  const token = jwt({ realm_access: { roles: ['viewer'] } });
  storageStub.storage.setItem(pkceTransactionKey, JSON.stringify({ state: 's', verifier: 'v' }));
  const login = completeLogin('?code=code-1&state=s');
  await flush();
  stub.answerJson(TOKEN_URL, { access_token: token }, 200);
  await login;
  stub.calls.length = 0;
  return token;
}

beforeEach(() => {
  resetSession();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('requests the exact export path with the selected zone and the session bearer', async () => {
  const stub = createCsvFetchStub();
  const token = await connect(stub);

  const read = historyCsv(ZONE);
  await flush();
  stub.answerCsv(CSV_URL, `${HEADER}\n`);
  const outcome = await read;

  expect(outcome.ok).toBe(true);
  expect(stub.callsFor(CSV_URL)).toHaveLength(1);
  const call = stub.callsFor(CSV_URL)[0];
  // The selection is the only parameter: no display filter, no limit, no offset.
  // The window and the order are the server's; the page asks for the same zone
  // the JSON read asked for and adds nothing.
  expect(call.url).toBe(CSV_URL);
  expect(call.url).not.toMatch(/[?&](q|query|status|data_status|limit|offset|page)=/);
  const headers = call.init.headers as Record<string, string>;
  expect(headers.Authorization).toBe(`Bearer ${token}`);
  expect(call.init.cache).toBe('no-store');
  expect(call.init.credentials).toBe('omit');
});

test('returns the served bytes unchanged, CRLF inside a quoted cell included', async () => {
  const stub = createCsvFetchStub();
  await connect(stub);

  // A raw CRLF inside a quoted cell and a leading-LF cell the server guards with
  // an apostrophe: neither is normalised, re-quoted or re-encoded here.
  const served = [
    HEADER,
    `05102,batch-1,job-1,2026-05-01T00:00:00Z,2026-05-01T01:00:00Z,2026-05-02T00:00:00Z,model-v1,alto,sufficient,yes,"primera linea\r\nsegunda linea",2026-05-01T00:30:00Z`,
    `05102,batch-2,job-2,2026-05-01T02:00:00Z,2026-05-01T03:00:00Z,2026-05-02T02:00:00Z,model-v1,medio,insufficient,yes,"'=SUM(A1:A2)",2026-05-01T02:30:00Z`,
    '',
  ].join('\n');
  const expected = new TextEncoder().encode(served);

  const read = historyCsv(ZONE);
  await flush();
  stub.answerCsvBytes(CSV_URL, expected);
  const outcome = await read;

  if (!outcome.ok) throw new Error('expected a document');
  expect(bytesEqual(outcome.data.bytes, expected)).toBe(true);
  expect(outcome.data.bytes.length).toBe(expected.length);
  expect(outcome.data.headerOnly).toBe(false);
  expect(outcome.data.zoneId).toBe(ZONE);
  expect(outcome.data.filename).toBe('risk-history-05102.csv');
});

test('a header-only 200 is a successful document that declares no rows', async () => {
  const stub = createCsvFetchStub();
  await connect(stub);

  const read = historyCsv(ZONE);
  await flush();
  stub.answerCsv(CSV_URL, `${HEADER}\n`);
  const outcome = await read;

  if (!outcome.ok) throw new Error('expected a document');
  expect(outcome.data.headerOnly).toBe(true);
  expect(new TextDecoder().decode(outcome.data.bytes)).toBe(`${HEADER}\n`);
  expect(outcome.data.filename).toBe('risk-history-05102.csv');
});

test('a header-only body is recognised byte for byte, without re-serialising it', async () => {
  const stub = createCsvFetchStub();
  await connect(stub);

  // A document with a column the page does not know about is still NOT empty:
  // the page must not report "no rows" for a body it cannot account for.
  const extended = `${HEADER},extra_column\n05102,b,j,2026-05-01T00:00:00Z,2026-05-01T01:00:00Z,2026-05-02T00:00:00Z,m,alto,sufficient,yes,"",2026-05-01T00:30:00Z,valor\n`;
  const read = historyCsv(ZONE);
  await flush();
  stub.answerCsv(CSV_URL, extended);
  const outcome = await read;

  if (!outcome.ok) throw new Error('expected a document');
  expect(outcome.data.headerOnly).toBe(false);
  expect(new TextDecoder().decode(outcome.data.bytes)).toBe(extended);
});

test('a 403 is a denied permission and never a document', async () => {
  const stub = createCsvFetchStub();
  await connect(stub);

  const read = historyCsv(ZONE);
  await flush();
  stub.answerJson(CSV_URL, { code: 'forbidden' }, 403);
  const failure = expectFailure(await read);

  expect(failure.kind).toBe('forbidden');
  expect(failure.status).toBe(403);
  expect(failure.reason).toBe('forbidden');
});

test('a 503 is unavailable and keeps the served error code', async () => {
  const stub = createCsvFetchStub();
  await connect(stub);

  const read = historyCsv(ZONE);
  await flush();
  stub.answerJson(CSV_URL, { code: 'storage_unavailable' }, 503);
  const failure = expectFailure(await read);

  expect(failure.kind).toBe('unavailable');
  expect(failure.status).toBe(503);
  expect(failure.reason).toBe('storage_unavailable');
});

test('a 400 invalid zone is a malformed request, not an empty export', async () => {
  const stub = createCsvFetchStub();
  await connect(stub);

  const read = historyCsv(ZONE);
  await flush();
  stub.answerJson(CSV_URL, { code: 'invalid_zone' }, 400);
  const failure = expectFailure(await read);

  expect(failure.kind).toBe('malformed');
  expect(failure.reason).toBe('invalid_zone');
  expect(failure.status).toBe(400);
});

test('a 200 that is not a CSV document is rejected instead of downloaded', async () => {
  const stub = createCsvFetchStub();
  await connect(stub);

  // A proxy or a misrouted host answering 200 with an HTML page must not become a
  // `.csv` file: the attachment is the response the contract describes, not any
  // 200 body.
  const read = historyCsv(ZONE);
  await flush();
  stub.answerCsv(CSV_URL, '<!doctype html><title>login</title>', 200, 'text/html; charset=utf-8');
  const failure = expectFailure(await read);

  expect(failure.kind).toBe('malformed');
  expect(failure.reason).toBe('invalid_shape');
});

test('a 200 with an empty body is rejected: the export always carries its header', async () => {
  const stub = createCsvFetchStub();
  await connect(stub);

  const read = historyCsv(ZONE);
  await flush();
  stub.answerCsvBytes(CSV_URL, new Uint8Array());
  const failure = expectFailure(await read);

  expect(failure.kind).toBe('malformed');
  expect(failure.reason).toBe('invalid_shape');
});

// L7 blocker: `response.ok` is true for 206, so a partial document used to
// become a downloadable file. The documented success status is 200 and only 200;
// every other status keeps the error mapping it already had.
test('a 206 partial content is a failure, never a downloadable document', async () => {
  const stub = createCsvFetchStub();
  await connect(stub);

  const read = historyCsv(ZONE);
  await flush();
  stub.answerCsv(CSV_URL, `${HEADER}\n05102,batch-1,job-1`, 206);
  const failure = expectFailure(await read);

  expect(failure.status).toBe(206);
  expect(failure.kind).toBe('unavailable');
  expect(failure.reason).toBe('http_206');
});

test('another non-200 success status is a failure too', async () => {
  const stub = createCsvFetchStub();
  await connect(stub);

  const read = historyCsv(ZONE);
  await flush();
  stub.answerCsv(CSV_URL, `${HEADER}\n`, 201);
  const failure = expectFailure(await read);

  expect(failure.status).toBe(201);
  expect(failure.kind).toBe('unavailable');
  expect(failure.reason).toBe('http_201');
});

test('a 401 keeps the JSON transport session lifecycle and downloads nothing', async () => {
  const stub = createCsvFetchStub();
  await connect(stub);
  expect(getAccessToken()).not.toBe('');

  const read = historyCsv(ZONE);
  await flush();
  stub.answerJson(CSV_URL, { code: 'unauthorized' }, 401);
  const failure = expectFailure(await read);

  expect(failure.kind).toBe('unauthorized');
  expect(failure.status).toBe(401);
  expect(getAccessToken()).toBe('');
  expect(getSessionSnapshot().status).toBe('signed-out');
  expect(getSessionSnapshot().reason).toBe('rejected');
});

test('an aborted read is an aborted outcome, never a document', async () => {
  const stub = createCsvFetchStub();
  await connect(stub);
  const controller = new AbortController();

  const read = historyCsv(ZONE, controller.signal);
  await flush();
  controller.abort();
  const failure = expectFailure(await read);

  expect(failure.kind).toBe('unavailable');
  expect(failure.reason).toBe('aborted');
});

test('a superseded read cannot answer over the newer one', async () => {
  const stub = createCsvFetchStub();
  await connect(stub);

  const first = historyCsv(ZONE);
  await flush();
  const second = historyCsv(ZONE);
  await flush();

  stub.answerNewestCsv(CSV_URL, `${HEADER}\n`);
  const newest = await second;
  stub.answerCsv(CSV_URL, `${HEADER}\n`);
  const stale = expectFailure(await first);

  expect(newest.ok).toBe(true);
  expect(stale.kind).toBe('unavailable');
  expect(stale.reason).toBe('superseded');
});

test('the local filename is deterministic and carries no path or control byte', () => {
  expect(historyCsvFilename(ZONE)).toBe('risk-history-05102.csv');
  expect(historyCsvFilename(ZONE)).toBe(historyCsvFilename(ZONE));
  expect(historyCsvFilename('valparaiso-demo')).toBe('risk-history-valparaiso-demo.csv');

  const hostile = historyCsvFilename('../../etc/passwd\u0000añadido');
  expect(hostile).toMatch(/^risk-history-[A-Za-z0-9_-]+\.csv$/);
  expect(hostile).not.toContain('/');
  expect(hostile).not.toContain('\\');
  expect(hostile).not.toContain('..');
  expect(historyCsvFilename('')).toBe('risk-history-zona.csv');
});
