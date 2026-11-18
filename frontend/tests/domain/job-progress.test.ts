import { describe, expect, test } from 'vitest';

import { IDLE_JOB_PROGRESS, mapProgressState } from '../../src/domain/job-progress';

// The map reads one fact from the jobs view: is a batch being produced for the
// comuna it is showing? These tests pin the answer for every state, because the
// defect they guard against is a missing state — the map used to have only
// "level" and "no level", so "still processing" was painted as "no data".
describe('map progress state', () => {
  test('a batch in process is processing, never missing information', () => {
    const state = mapProgressState({ kind: 'processing', zone: '05101' }, '05101');

    expect(state.kind).toBe('processing');
    if (state.kind !== 'processing') throw new Error('expected processing');
    expect(state.text).toMatch(/proceso/i);
    // The three ways of saying "there is no information" must all be absent: this
    // is the distinction the issue asks for.
    expect(state.text).not.toMatch(/insuficiente|sin información|sin evaluación|no hay nada/i);
  });

  test('progress that belongs to another comuna is not claimed by the selection', () => {
    expect(mapProgressState({ kind: 'processing', zone: '05102' }, '05101')).toEqual({ kind: 'none' });
  });

  test('an unverified publication is its own state, not an absence', () => {
    const state = mapProgressState({ kind: 'unconfirmed', zone: '05101' }, '05101');

    expect(state.kind).toBe('unconfirmed');
    if (state.kind !== 'unconfirmed') throw new Error('expected unconfirmed');
    expect(state.text).toMatch(/sin confirmar|sin confirmación|no está confirmada/i);
    expect(state.text).not.toMatch(/insuficiente|sin información/i);
  });

  test('a failed request is named as a failure, not as missing information', () => {
    const state = mapProgressState({ kind: 'failed', zone: '05101' }, '05101');

    expect(state.kind).toBe('failed');
    if (state.kind !== 'failed') throw new Error('expected failed');
    expect(state.text).toMatch(/falló/i);
    expect(state.text).not.toMatch(/insuficiente|sin información/i);
  });

  test('an idle job says nothing, so the map keeps its own absence vocabulary', () => {
    expect(mapProgressState(IDLE_JOB_PROGRESS, '05101')).toEqual({ kind: 'none' });
    // A selection that is not the zone the progress belongs to says nothing even
    // when the jobs view is still following another comuna.
    expect(mapProgressState({ kind: 'failed', zone: '05102' }, '')).toEqual({ kind: 'none' });
  });
});
