import { useEffect, useState, useSyncExternalStore } from 'react';

import { executiveSummary, type Failure } from '../../core/api';
import { getSessionGeneration, subscribeSessionGeneration } from '../../core/session';
import type { ExecutiveSummaryState } from './ExecutivePanel';

// PM-01 / T4 — the executive summary read, in one place.
//
// The overview and the executive route show the same server summary, so the read
// lives here instead of being copied into the second view. Three properties
// matter:
//
//   1. one read per mounted view. The hook owns the request, its abort and the
//      state machine, so a view that renders the panel cannot issue a second call;
//   2. a failure is an outcome, never zeros. The transport's own deadline bounds a
//      pending read, so the panel cannot advertise "consulting" forever, and both
//      views state a refusal with the same Spanish copy;
//   3. an answer belongs to the session instance that asked for it. The stored
//      summary is kept beside the `core/session` generation, so a token adopted
//      after a sign-out invalidates it instead of showing the previous session's
//      counts while the new read is in flight.

export const EXECUTIVE_SUMMARY_ACTION = 'consultar el resumen ejecutivo';

// The copy both views print. A 403 is the server's permission verdict, and the
// action is named so the reader knows which read was refused.
export function executiveFailureMessage(failure: Failure): string {
  if (failure.kind === 'forbidden') {
    return 'La API denegó el permiso para esta acción (403). Solicita acceso a un administrador.';
  }
  const detail = failure.status !== undefined ? `HTTP ${failure.status}` : 'sin conexión';
  return `No se pudo ${EXECUTIVE_SUMMARY_ACTION} (${detail}).`;
}

interface SettledSummary {
  generation: number;
  state: ExecutiveSummaryState;
}

// `enabled` is the established session, not a role: the route is the same for
// every role and the server decides whether it answers.
export function useExecutiveSummary(enabled: boolean): ExecutiveSummaryState {
  const generation = useSyncExternalStore(subscribeSessionGeneration, getSessionGeneration, getSessionGeneration);
  const [settled, setSettled] = useState<SettledSummary | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    let active = true;
    void (async () => {
      const outcome = await executiveSummary(controller.signal);
      if (!active || generation !== getSessionGeneration()) return;
      if (outcome.ok) {
        setSettled({ generation, state: { kind: 'ready', summary: outcome.data } });
        return;
      }
      // A superseded or aborted answer belongs to a request this view already
      // replaced, and an unauthorized one is the session's own verdict: neither
      // is a failure of the summary this page should print.
      if (
        outcome.failure.reason === 'superseded' ||
        outcome.failure.reason === 'aborted' ||
        outcome.failure.kind === 'unauthorized'
      ) {
        return;
      }
      setSettled({ generation, state: { kind: 'failed', message: executiveFailureMessage(outcome.failure) } });
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [enabled, generation]);

  // A signed-out view never shows a number it did not read; a signed-in view with
  // no settled answer for THIS session generation is consulting.
  if (!enabled) return { kind: 'idle' };
  if (settled !== null && settled.generation === generation) return settled.state;
  return { kind: 'loading' };
}
