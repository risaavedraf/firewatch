import { describe, expect, test } from 'vitest';

import type { ServiceStatusDecision } from '../../src/domain/readiness';
import {
  evaluateOperationalStatus,
  type OperationalInputs,
} from '../../src/domain/operational-status';

// PM-16 / S1 — ONE explicit operational verdict for API, weather source and
// services. The verdict is a fail-closed composition: anything this view cannot
// prove is a named limitation, and a demo/synthetic dataset never earns a
// production claim even when every service is verified.

const verified: ServiceStatusDecision = {
  outcome: 'verified',
  verified: true,
  unknown: false,
  unverified: false,
  label: 'Verificado: ready con checked_at fresco y profundidad de cola dentro de la cota.',
};

const unknown: ServiceStatusDecision = {
  outcome: 'unknown',
  verified: false,
  unknown: true,
  unverified: false,
  label: 'Desconocido: el estado no se acredita como saludable (HTTP 503).',
};

const denied: ServiceStatusDecision = {
  outcome: 'unverified',
  verified: false,
  unknown: false,
  unverified: true,
  label: 'No autorizado para comprobar; el servicio queda sin verificar, sin marcarlo como no disponible.',
};

const answeredGateway = {
  answered: true,
  label: 'El gateway respondió a `GET /health/ready`. Solo disponibilidad del gateway: un 204 no acredita el pipeline ni autentica al usuario.',
};

const verifiedRule = {
  state: 'verified' as const,
  version: 'academic-rule-v1',
  paramsHash: 'e17aaa5600eb67c9a91340e90057aec100f4e80ef0895662f373cffee66564c7',
};

function inputs(overrides: Partial<OperationalInputs> = {}): OperationalInputs {
  return {
    phase: 'settled',
    risk: verified,
    jobs: verified,
    gateway: answeredGateway,
    rule: verifiedRule,
    provenanceAvailable: true,
    syntheticInput: false,
    weatherIntegrated: true,
    ...overrides,
  };
}

describe('the operational verdict', () => {
  test('without a session it does not issue a verdict', () => {
    const verdict = evaluateOperationalStatus(inputs({ phase: 'unconsulted' }));

    expect(verdict.state).toBe('unconsulted');
    expect(verdict.badge).toBe('SIN CONSULTAR');
    expect(verdict.title).toMatch(/sin consultar/i);
    expect(verdict.text).toMatch(/token autorizado/i);
  });

  test('a read in flight never anticipates a verdict', () => {
    const verdict = evaluateOperationalStatus(inputs({ phase: 'loading' }));

    expect(verdict.state).toBe('loading');
    expect(verdict.badge).toBe('CONSULTANDO');
    expect(verdict.title).toMatch(/comprobando/i);
    expect(verdict.limitations).toEqual([]);
  });

  test('all evidence verified earns the scoped verdict and still refuses to certify production', () => {
    const verdict = evaluateOperationalStatus(inputs());

    expect(verdict.state).toBe('verified');
    expect(verdict.badge).toBe('SIN BRECHAS');
    expect(verdict.limitations).toEqual([]);
    expect(verdict.text).toMatch(/CONAF/);
    expect(verdict.text).toMatch(/SENAPRED/);
    expect(verdict.text).not.toMatch(/certifica producción|listo para producción/i);
  });

  test('demo data is never production-ready, even with every service verified', () => {
    const verdict = evaluateOperationalStatus(inputs({ syntheticInput: true }));

    expect(verdict.state).toBe('demo');
    expect(verdict.badge).toBe('DEMOSTRACIÓN');
    expect(verdict.title).toMatch(/demostración/i);
    expect(verdict.title).toMatch(/no producción/i);
    expect(verdict.limitations.join(' ')).toMatch(/sintética/i);
    expect(verdict.text).toMatch(/no acredita operación de producción/i);
    expect(verdict.text).not.toMatch(/producción verificada|listo para producción|aproBADO/i);
  });

  test('a service that does not earn its own snapshot blocks the verdict', () => {
    for (const decision of [unknown, denied]) {
      const verdict = evaluateOperationalStatus(inputs({ risk: decision }));

      expect(verdict.state).toBe('blocked');
      expect(verdict.badge).toBe('NO ACREDITA');
      expect(verdict.limitations.join(' ')).toMatch(/servicio de riesgo/i);
    }
  });

  test('a failed jobs snapshot blocks the verdict even when the other service is verified', () => {
    const verdict = evaluateOperationalStatus(inputs({ jobs: unknown }));

    expect(verdict.state).toBe('blocked');
    expect(verdict.limitations.join(' ')).toMatch(/servicio de trabajos/i);
  });

  test('the missing weather integration is always a named limitation, never a successful probe', () => {
    const verdict = evaluateOperationalStatus(inputs({ weatherIntegrated: false }));

    expect(verdict.state).toBe('demo');
    expect(verdict.limitations).toContain('fuente meteorológica no integrada');
    expect(verdict.text).not.toMatch(/clima en vivo|meteorología verificada/i);
  });

  test('an unknown effective identity keeps the verdict out of the verified branch', () => {
    const verdict = evaluateOperationalStatus(inputs({ rule: { state: 'unknown', version: '', paramsHash: '' } }));

    expect(verdict.state).toBe('demo');
    expect(verdict.limitations.join(' ')).toMatch(/identidad de la regla no verificable/i);
  });

  test('a resolved non-rule is named as such and never earns the rule branch', () => {
    const verdict = evaluateOperationalStatus(inputs({ rule: { state: 'non-rule', version: '', paramsHash: '' } }));

    expect(verdict.state).toBe('demo');
    expect(verdict.limitations.join(' ')).toMatch(/la regla activa no es una regla/i);
    expect(verdict.text).not.toMatch(/regla verificada/i);
  });

  test('provenance that was not earned blocks the verdict instead of being assumed healthy', () => {
    const verdict = evaluateOperationalStatus(inputs({ provenanceAvailable: false }));

    expect(verdict.state).toBe('blocked');
    expect(verdict.limitations.join(' ')).toMatch(/procedencia/i);
  });

  test('a gateway probe that did not answer blocks the explicit verdict', () => {
    const verdict = evaluateOperationalStatus(
      inputs({ gateway: { answered: false, label: 'El gateway no respondió (HTTP 503).' } }),
    );

    expect(verdict.state).toBe('blocked');
    expect(verdict.limitations).toContain('gateway sin respuesta');
  });

  test('an unconsulted input is named, never treated as healthy', () => {
    const verdict = evaluateOperationalStatus(
      inputs({ risk: null, jobs: null, gateway: null, rule: null, provenanceAvailable: null, syntheticInput: null }),
    );

    expect(verdict.state).toBe('blocked');
    expect(verdict.limitations).toEqual([
      'servicio de riesgo sin consultar',
      'servicio de trabajos sin consultar',
      'gateway sin consultar',
      'regla activa sin consultar',
      'procedencia sin consultar',
      'la entrada no se declara como real ni sintética',
    ]);
  });
});
