import type { Failure } from './api';

// The EFFECTIVE classifier identity, read from the additive `effective` object of
// `GET /v1/models` (PM-16 / S1; frozen backend contract, L6).
//
// This module deliberately does NOT read the registry rows. A row's `active` flag
// is lifecycle data, an activated row can name a version this binary cannot
// execute or whose fingerprint diverges, and a fixture row is not a rule at all.
// The service already resolves the classifier the NEXT publication would run and
// publishes exactly one of three documented shapes beside the unchanged list:
//
//   {"status":"rule","version":"…","params_hash":"…"}  verified rule identity
//   {"status":"non_rule"}                               resolved non-rule, no identity
//   {"status":"unavailable"}                            missing evidence or failure
//
// The client still validates the claim instead of trusting the status label: a
// rule is accepted only with a non-empty version and exactly one canonical
// lowercase SHA-256. Anything absent, invalid or unrecognised is a truthful
// unknown, and a non-rule is never rendered as a rule. `models` remains the
// overview panel's source through `domain/model.ts`, which this module does not
// touch.

export type ActiveRuleState = 'verified' | 'non-rule' | 'unknown';

export interface ActiveRuleEvidence {
  readonly state: ActiveRuleState;
  /** The effective rule identifier; populated only on a validated rule. */
  readonly version: string;
  /** The effective policy fingerprint; populated only on a validated rule. */
  readonly paramsHash: string;
  readonly label: string;
}

export type EffectiveRead =
  | { readonly ok: true; readonly effective: unknown }
  | { readonly ok: false; readonly failure: Failure };

const CANONICAL_SHA256 = /^[0-9a-f]{64}$/;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The length check is load-bearing: JavaScript's `$` also matches before a final
// newline, so the pattern alone would accept 64 hex characters plus "\n".
function isCanonicalSha256(value: unknown): value is string {
  return typeof value === 'string' && value.length === 64 && CANONICAL_SHA256.test(value);
}

function unknownEvidence(label: string): ActiveRuleEvidence {
  return { state: 'unknown', version: '', paramsHash: '', label };
}

function failureEvidence(failure: Failure): ActiveRuleEvidence {
  switch (failure.kind) {
    case 'unauthorized':
      return unknownEvidence(
        'La API rechazó la credencial al leer el modelo efectivo (401); la regla efectiva queda sin verificar.',
      );
    case 'forbidden':
      return unknownEvidence(
        'La API denegó el permiso para leer el modelo efectivo (403); la regla efectiva queda sin verificar y no se marca como no disponible.',
      );
    case 'malformed':
      return unknownEvidence(
        'La API devolvió una proyección efectiva ilegible; la regla efectiva queda sin verificar.',
      );
    default: {
      const http = failure.status !== undefined ? `HTTP ${failure.status}` : 'sin conexión';
      return unknownEvidence(`Modelo efectivo no disponible (${http}); la regla efectiva queda sin verificar.`);
    }
  }
}

export function evaluateEffectiveClassifier(read: EffectiveRead): ActiveRuleEvidence {
  if (!read.ok) return failureEvidence(read.failure);
  if (!record(read.effective)) {
    return unknownEvidence(
      'La respuesta de `/v1/models` no publica el objeto `effective`; la regla efectiva queda sin verificar.',
    );
  }

  const status = typeof read.effective.status === 'string' ? read.effective.status : '';
  if (status === '') {
    return unknownEvidence('La proyección efectiva no declara estado; la regla efectiva queda sin verificar.');
  }

  switch (status) {
    case 'rule': {
      const version = typeof read.effective.version === 'string' ? read.effective.version.trim() : '';
      if (version === '') {
        return unknownEvidence(
          'La proyección efectiva declara una regla sin versión; la regla efectiva queda sin verificar.',
        );
      }
      const hash = read.effective.params_hash;
      if (!isCanonicalSha256(hash)) {
        // The unverified version is deliberately not echoed here: the row must not
        // read like an identity when the fingerprint failed validation.
        return unknownEvidence(
          'La proyección efectiva declara una regla, pero su `params_hash` no es un SHA-256 canónico en minúsculas; no se acredita versión ni hash.',
        );
      }
      return {
        state: 'verified',
        version,
        paramsHash: hash,
        label: `El servicio resuelve \`${version}\` como regla para la próxima publicación en el momento de la lectura, con un hash de parámetros canónico. No acredita una publicación ya ocurrida.`,
      };
    }
    case 'non_rule':
      // Identity fields are never read on this branch, so a hostile payload cannot
      // turn a resolved non-rule into a rule claim.
      return {
        state: 'non-rule',
        version: '',
        paramsHash: '',
        label:
          'El servicio resuelve un clasificador que no es una regla; esta vista no lo presenta como regla ni publica su identidad.',
      };
    case 'unavailable':
      return unknownEvidence(
        'El servicio declara la proyección efectiva como `unavailable`: no se acredita versión ni hash de una regla.',
      );
    default:
      return unknownEvidence(
        'La proyección efectiva declara un estado que esta vista no reconoce; la regla efectiva queda sin verificar.',
      );
  }
}
