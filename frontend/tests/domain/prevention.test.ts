import { describe, expect, test } from 'vitest';

import {
  ACTION_STATUSES,
  ACTION_TERMINAL_STATUSES,
  actionStatusLabel,
  isActionStatus,
  isFinalReviewTransition,
  isTransitionAllowed,
  nextStatuses,
  transitionAffordances,
} from '../../src/domain/prevention';
import { declaresAdminRole, declaresTacticalRole, effectiveRole } from '../../src/domain/roles';

// S3 — the preventive-action state machine, transcribed from the frozen
// contract in `odd/tasks/presentation-client-ready.md` §«Contrato congelado de
// prevention». The map is the single place the client claims to know the valid
// transitions; the server remains the authority and a `409 invalid_transition`
// is still rendered when the two disagree.

describe('prevention status vocabulary', () => {
  test('declares every status of the frozen contract exactly once', () => {
    expect(ACTION_STATUSES).toEqual([
      'propuesta',
      'asignada',
      'en_curso',
      'bloqueada',
      'enviada',
      'aceptada',
      'devuelta',
      'cancelada',
    ]);
    expect(new Set(ACTION_STATUSES).size).toBe(ACTION_STATUSES.length);
    expect(ACTION_TERMINAL_STATUSES).toEqual(['aceptada', 'cancelada']);
  });

  test('recognises only declared statuses', () => {
    expect(isActionStatus('en_curso')).toBe(true);
    expect(isActionStatus('EN_CURSO')).toBe(false);
    expect(isActionStatus('')).toBe(false);
    expect(isActionStatus(42)).toBe(false);
  });

  test('gives every declared status a human label and labels nothing else', () => {
    expect(actionStatusLabel('propuesta')).toBe('Propuesta');
    expect(actionStatusLabel('en_curso')).toBe('En curso');
    expect(actionStatusLabel('aceptada')).toBe('Aceptada');
    expect(actionStatusLabel('cancelada')).toBe('Cancelada');
    // An unknown status is shown raw rather than silently translated.
    expect(actionStatusLabel('inventado')).toBe('inventado');
  });
});

describe('prevention transitions', () => {
  test('follows the frozen chain from propuesta to aceptada', () => {
    expect(nextStatuses('propuesta')).toEqual(['asignada', 'cancelada']);
    expect(nextStatuses('asignada')).toEqual(['en_curso', 'cancelada']);
    expect(nextStatuses('en_curso')).toEqual(['bloqueada', 'enviada', 'cancelada']);
    expect(nextStatuses('bloqueada')).toEqual(['en_curso', 'cancelada']);
    expect(nextStatuses('enviada')).toEqual(['aceptada', 'devuelta', 'cancelada']);
    expect(nextStatuses('devuelta')).toEqual(['en_curso', 'cancelada']);
  });

  test('treats aceptada and cancelada as terminal', () => {
    expect(nextStatuses('aceptada')).toEqual([]);
    expect(nextStatuses('cancelada')).toEqual([]);
  });

  test('offers nothing for a status the contract does not declare', () => {
    expect(nextStatuses('inventado')).toEqual([]);
    expect(nextStatuses('')).toEqual([]);
  });

  test('rejects every transition the chain does not state', () => {
    expect(isTransitionAllowed('propuesta', 'en_curso')).toBe(false);
    expect(isTransitionAllowed('propuesta', 'aceptada')).toBe(false);
    expect(isTransitionAllowed('enviada', 'en_curso')).toBe(false);
    expect(isTransitionAllowed('aceptada', 'en_curso')).toBe(false);
    expect(isTransitionAllowed('cancelada', 'en_curso')).toBe(false);
    expect(isTransitionAllowed('propuesta', 'inventado')).toBe(false);
  });

  test('accepts the transitions the chain states, including reopen and cancellation', () => {
    expect(isTransitionAllowed('propuesta', 'asignada')).toBe(true);
    expect(isTransitionAllowed('en_curso', 'bloqueada')).toBe(true);
    expect(isTransitionAllowed('bloqueada', 'en_curso')).toBe(true);
    expect(isTransitionAllowed('devuelta', 'en_curso')).toBe(true);
    expect(isTransitionAllowed('enviada', 'devuelta')).toBe(true);
    expect(isTransitionAllowed('enviada', 'aceptada')).toBe(true);
    expect(isTransitionAllowed('bloqueada', 'cancelada')).toBe(true);
  });
});

describe('prevention role affordance', () => {
  test('reads an admin only from a declared role list', () => {
    expect(declaresAdminRole(['admin'])).toBe(true);
    expect(declaresAdminRole(['viewer', 'admin'])).toBe(true);
    expect(declaresAdminRole(['viewer'])).toBe(false);
    // A token that declares no usable role is never assumed to be admin.
    expect(declaresAdminRole(null)).toBe(false);
    expect(declaresAdminRole([])).toBe(false);
    expect(declaresAdminRole(undefined)).toBe(false);
  });

  test('enables every offered transition only for a signed-in admin', () => {
    const admin = transitionAffordances('propuesta', ['admin'], true);
    expect(admin.map(item => item.to)).toEqual(['asignada', 'cancelada']);
    expect(admin.every(item => item.enabled)).toBe(true);

    const viewer = transitionAffordances('propuesta', ['viewer'], true);
    expect(viewer.map(item => item.to)).toEqual(['asignada', 'cancelada']);
    expect(viewer.every(item => item.enabled)).toBe(false);

    const unknown = transitionAffordances('propuesta', null, true);
    expect(unknown.every(item => item.enabled)).toBe(false);

    const signedOut = transitionAffordances('propuesta', ['admin'], false);
    expect(signedOut.every(item => item.enabled)).toBe(false);
  });

  // PM-15 (D-C): the matrix is not one gate but two. An analista operates the
  // tactical workflow — «evalúa y gestiona acciones, sin admin» — and the final
  // decisions stay administrative. The page must never offer an analista a
  // control the server would refuse.
  test('offers an analista the tactical transitions and withholds the final ones', () => {
    const proposal = transitionAffordances('propuesta', ['analista'], true);
    expect(proposal.map(item => item.to)).toEqual(['asignada', 'cancelada']);
    expect(proposal.find(item => item.to === 'asignada')?.enabled).toBe(true);
    expect(proposal.find(item => item.to === 'cancelada')?.enabled).toBe(false);
    expect(proposal.find(item => item.to === 'cancelada')?.finalReview).toBe(true);

    // `enviada` offers aceptada and devuelta, both final: neither is offered.
    const submitted = transitionAffordances('enviada', ['analista'], true);
    expect(submitted.map(item => item.to)).toEqual(['aceptada', 'devuelta', 'cancelada']);
    expect(submitted.every(item => item.enabled)).toBe(false);
    expect(submitted.every(item => item.finalReview)).toBe(true);

    // The workflow steps an analista owns stay enabled.
    for (const from of ['asignada', 'bloqueada', 'devuelta'] as const) {
      const affordances = transitionAffordances(from, ['analista'], true);
      const tactical = affordances.filter(item => !item.finalReview);
      expect(tactical.length).toBeGreaterThan(0);
      expect(tactical.every(item => item.enabled)).toBe(true);
    }

    // An admin keeps both halves, and a multi-role token keeps the strongest role
    // it holds wherever that role appears in the list.
    expect(transitionAffordances('propuesta', ['viewer', 'admin'], true).every(item => item.enabled)).toBe(true);
    expect(transitionAffordances('propuesta', ['analista', 'viewer'], true).find(item => item.to === 'asignada')?.enabled).toBe(true);
  });

  test('names the final-review targets and derives the effective role by membership', () => {
    for (const target of ['aceptada', 'devuelta', 'cancelada']) {
      expect(isFinalReviewTransition(target)).toBe(true);
    }
    for (const target of ['propuesta', 'asignada', 'en_curso', 'bloqueada', 'enviada']) {
      expect(isFinalReviewTransition(target)).toBe(false);
    }

    expect(effectiveRole(['viewer'])).toBe('viewer');
    expect(effectiveRole(['analista'])).toBe('analista');
    expect(effectiveRole(['viewer', 'analista'])).toBe('analista');
    expect(effectiveRole(['analista', 'admin'])).toBe('admin');
    expect(effectiveRole(['viewer', 'admin'])).toBe('admin');
    expect(effectiveRole(['operator'])).toBeNull();
    expect(effectiveRole(null)).toBeNull();
    expect(declaresTacticalRole(['analista'])).toBe(true);
    expect(declaresTacticalRole(['admin'])).toBe(true);
    expect(declaresTacticalRole(['viewer'])).toBe(false);
    expect(declaresTacticalRole(['operator'])).toBe(false);
  });
});
