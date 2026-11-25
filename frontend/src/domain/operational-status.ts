import type { ServiceStatusDecision } from './readiness';

// The single operational verdict of the sources screen (PM-16 / S1).
//
// It composes the evidence this view actually holds — the gateway probe, the two
// authenticated service snapshots, the online rule identity and the provenance
// acceptance — into ONE explicit state. The composition is fail-closed:
//
//   * a service snapshot that did not earn its own verification, a gateway that
//     did not answer, or provenance that was not accepted BLOCKS the verdict;
//   * a demo/synthetic input, an unverified or non-rule classifier identity or a
//     missing weather integration keeps it out of the verified branch even when
//     every service answered, so the screen never claims production readiness from
//     a green health check;
//   * the verified branch is scoped: it states what this view checked and still
//     refuses to certify production or replace CONAF/SENAPRED.
//
// This module takes no transport type and performs no request: the view reads,
// this decides, and the rendered row states the same distinction.

export type OperationalPhase = 'unconsulted' | 'loading' | 'settled';

export type OperationalState = 'unconsulted' | 'loading' | 'blocked' | 'demo' | 'verified';

export interface OperationalRuleEvidence {
  // The three states of the authoritative `effective` projection: a validated
  // rule, a resolved non-rule (never presented as a rule), or missing/invalid
  // evidence. Only `verified` may carry a version or a fingerprint.
  readonly state: 'verified' | 'non-rule' | 'unknown';
  readonly version: string;
  readonly paramsHash: string;
}

export interface OperationalGatewayEvidence {
  readonly answered: boolean;
  readonly label: string;
}

export interface OperationalInputs {
  readonly phase: OperationalPhase;
  readonly risk: ServiceStatusDecision | null;
  readonly jobs: ServiceStatusDecision | null;
  readonly gateway: OperationalGatewayEvidence | null;
  readonly rule: OperationalRuleEvidence | null;
  /** `null` while nothing was consulted; `false` when the read did not accept. */
  readonly provenanceAvailable: boolean | null;
  /** `null` when the payload does not declare it; never assumed to be `false`. */
  readonly syntheticInput: boolean | null;
  /** A weather source is not part of the contract this view reads. */
  readonly weatherIntegrated: boolean;
}

export interface OperationalVerdict {
  readonly state: OperationalState;
  readonly badge: string;
  readonly title: string;
  readonly text: string;
  readonly limitations: readonly string[];
}

const SCOPE = 'Esta vista no sustituye la vigilancia de CONAF ni de SENAPRED.';

function serviceLimitation(name: string, decision: ServiceStatusDecision | null): string | null {
  if (decision === null) return `${name} sin consultar`;
  if (decision.verified) return null;
  return decision.unverified ? `${name} no autorizado para comprobar` : `${name} en estado desconocido`;
}

function ruleLimitation(rule: OperationalRuleEvidence | null): string | null {
  if (rule === null) return 'regla activa sin consultar';
  if (rule.state === 'verified') return null;
  return rule.state === 'non-rule' ? 'la regla activa no es una regla' : 'identidad de la regla no verificable';
}

function limitationsOf(input: OperationalInputs): string[] {
  const limitations: string[] = [];
  const risk = serviceLimitation('servicio de riesgo', input.risk);
  if (risk !== null) limitations.push(risk);
  const jobs = serviceLimitation('servicio de trabajos', input.jobs);
  if (jobs !== null) limitations.push(jobs);

  if (input.gateway === null) limitations.push('gateway sin consultar');
  else if (!input.gateway.answered) limitations.push('gateway sin respuesta');

  const rule = ruleLimitation(input.rule);
  if (rule !== null) limitations.push(rule);

  if (input.provenanceAvailable === null) limitations.push('procedencia sin consultar');
  else if (!input.provenanceAvailable) limitations.push('procedencia no acreditada');

  if (input.syntheticInput === true) limitations.push('entrada sintética: no es riesgo real observado');
  else if (input.syntheticInput === null) limitations.push('la entrada no se declara como real ni sintética');

  if (!input.weatherIntegrated) limitations.push('fuente meteorológica no integrada');

  return limitations;
}

function blockedBy(input: OperationalInputs): boolean {
  return (
    input.risk === null ||
    !input.risk.verified ||
    input.jobs === null ||
    !input.jobs.verified ||
    input.gateway === null ||
    !input.gateway.answered ||
    input.provenanceAvailable !== true
  );
}

export function evaluateOperationalStatus(input: OperationalInputs): OperationalVerdict {
  if (input.phase === 'unconsulted') {
    return {
      state: 'unconsulted',
      badge: 'SIN CONSULTAR',
      title: 'Veredicto sin consultar',
      text: `Sin sesión no se ejecuta ninguna lectura: conecta un token autorizado para comprobar API, servicios y regla activa. ${SCOPE}`,
      limitations: [],
    };
  }

  if (input.phase === 'loading') {
    return {
      state: 'loading',
      badge: 'CONSULTANDO',
      title: 'Comprobando servicios y regla activa',
      text: 'La lectura está en curso; no se adelanta un veredicto.',
      limitations: [],
    };
  }

  const limitations = limitationsOf(input);

  if (blockedBy(input)) {
    return {
      state: 'blocked',
      badge: 'NO ACREDITA',
      title: 'Sin verificación operativa completa',
      text: `La evidencia disponible no acredita un estado operativo completo: ${limitations.join('; ')}. ${SCOPE}`,
      limitations,
    };
  }

  if (limitations.length > 0) {
    return {
      state: 'demo',
      badge: 'DEMOSTRACIÓN',
      title: 'Demostración, no producción',
      text: `La demostración no acredita operación de producción: ${limitations.join('; ')}. ${SCOPE}`,
      limitations,
    };
  }

  return {
    state: 'verified',
    badge: 'SIN BRECHAS',
    title: 'Sin brechas en lo que esta vista comprueba',
    text: `Los servicios, el gateway, la procedencia, la entrada y la regla activa acreditan lo que esta vista puede comprobar. No es una certificación de producción. ${SCOPE}`,
    limitations,
  };
}
