import { useEffect, useState } from 'react';

import { idleCopy, rejectedSessionCopy } from '../app/sessionCopy';
import { useSessionState } from '../app/store';
import { PanelHeading, StatusCopy } from '../components/ui';
import { evaluateEffectiveClassifier, type ActiveRuleEvidence } from '../core/active-rule';
import {
  aggregateStatus,
  modelRegistry,
  sources,
  type Failure,
  type MultiserviceStatus,
  type ServiceName,
  type ServiceState,
} from '../core/api';
import type { SessionState } from '../core/session';
import type { SourceProvenance } from '../types/api';

// PM-16 — the single operational board (`#status`).
//
// One bounded read of the gateway's own aggregate `GET /v1/status`, composed with
// the weather source of `GET /v1/risk/sources` and the effective rule identity of
// `GET /v1/models`. Three properties travel with this code:
//
//   1. The verdict is explicit and derived from the served states alone:
//      «Operativo» only when every declared service is `ready`, «Operación
//      degradada» for every other state. A 503 is the aggregate's own answer and
//      its body is rendered — it is never collapsed into a generic error.
//   2. Nothing is invented. A row without evidence says so; `unauthorized` reads
//      as a permission fact («requiere admin»), not as an outage; `not_configured`
//      is a deployment fact; a weather source the payload does not publish is
//      «no configurada» and the rule row never claims a version or a hash the
//      `effective` projection did not validate.
//   3. The model row is the ACTIVE RULE, not a trained model. This view never
//      presents a rule as a model and never claims a trained model exists.

type Phase = 'unconsulted' | 'loading' | 'settled';

const SERVICE_LABELS: Record<ServiceName, string> = {
  risk: 'Servicio de riesgo',
  jobs: 'Servicio de trabajos',
  prevention: 'Servicio de prevención',
  inference: 'Servicio de inferencia',
};

// The label is text, not only colour (S3): every row states its state in words.
const STATE_LABELS: Record<ServiceState, string> = {
  ready: 'Listo',
  degraded: 'Degradado',
  unknown: 'Desconocido',
  unauthorized: 'Requiere admin',
  not_configured: 'No configurado',
};

const STATE_REASONS: Record<ServiceState, string> = {
  ready: 'Respondió su propio estado documentado como listo.',
  degraded: 'Respondió 503 con un cuerpo que declara no estar listo; el motivo concreto lo decide el servicio.',
  unknown:
    'El gateway no obtuvo evidencia usable: inalcanzable, demasiado lento, otro estado o un cuerpo que no es el contractual.',
  unauthorized:
    'Requiere admin: el token de esta sesión no está autorizado para comprobarlo (403/401). Es un hecho sobre el permiso de esta sesión, no una caída del servicio.',
  not_configured:
    'No configurado en este despliegue: la configuración no declara una dirección de inferencia que sondear. Es una decisión de despliegue, no un fallo.',
};

const IDLE_ACTION = 'consultar el estado de los servicios';

// The gateway row is not one of the four probed services: the contract states the
// gateway is reachable whenever a body exists, and the aggregate reports it
// separately so the reachability of the API is never confused with the state of
// its dependencies.
const GATEWAY_ROW = {
  label: 'API / gateway',
  wire: 'gateway',
  reason:
    'Proceso que respondió este resumen. El contrato lo declara listo siempre que exista un cuerpo, aunque sus dependencias no lo estén: la alcanzabilidad de la API no acredita la de los servicios.',
} as const;

interface WeatherSource {
  readonly name: string;
  readonly identifier: string;
  readonly synthetic: boolean | null;
}

interface StoredSnapshot {
  readonly owner: SessionState;
  readonly aggregate: { readonly status: 200 | 503; readonly data: MultiserviceStatus } | null;
  readonly aggregateFailure: Failure | null;
  readonly provenance: SourceProvenance | null;
  readonly provenanceFailure: Failure | null;
  readonly rule: ActiveRuleEvidence;
}

// The weather source is the active publisher descriptor of `/v1/risk/sources`
// (`risk_input`). It is read fail-closed here: only a non-empty name or id is a
// configured source, an absent and an unusable one both mean the payload does not
// publish a weather source, and neither is replaced by a guess.
function weatherSourceOf(provenance: SourceProvenance): WeatherSource | null {
  const riskInput = provenance.risk_input;
  if (riskInput === null || riskInput === undefined) return null;
  if (typeof riskInput !== 'object') return null;
  const name = typeof riskInput.display_name === 'string' ? riskInput.display_name.trim() : '';
  const identifier = typeof riskInput.id === 'string' ? riskInput.id.trim() : '';
  if (name === '' && identifier === '') return null;
  return {
    name: name !== '' ? name : identifier,
    identifier,
    synthetic: typeof riskInput.synthetic === 'boolean' ? riskInput.synthetic : null,
  };
}

function failureText(failure: Failure, subject: string): string {
  switch (failure.kind) {
    case 'unauthorized':
      return rejectedSessionCopy();
    case 'forbidden':
      return `La API denegó el permiso para ${subject} (403). El agregado la declara para viewer y admin; solicita uno de esos roles.`;
    case 'malformed':
      return `La API devolvió una respuesta ilegible para ${subject}; no se muestra como un estado saludable.`;
    default: {
      const code =
        failure.status !== undefined && failure.reason !== `http_${failure.status}` ? ` · ${failure.reason}` : '';
      const detail = failure.status !== undefined ? `HTTP ${failure.status}${code}` : 'sin conexión';
      return `No fue posible leer ${subject} (${detail}).`;
    }
  }
}

type VerdictState = 'unconsulted' | 'loading' | 'operational' | 'degraded' | 'unavailable';

interface Verdict {
  readonly state: VerdictState;
  readonly badge: string;
  readonly title: string;
  readonly text: string;
}

// The verdict is ONE table instead of nested ternaries in the render. The
// degraded branch is the only one that names rows, and it names them from the
// served entries — never from a list this view keeps.
function verdictOf(
  phase: Phase,
  aggregate: StoredSnapshot['aggregate'],
  aggregateFailure: Failure | null,
  idle: string,
): Verdict {
  if (phase === 'unconsulted') {
    return {
      state: 'unconsulted',
      badge: 'SIN CONSULTAR',
      title: 'Veredicto sin consultar',
      text: `${idle} El tablero no ejecuta comprobaciones propias: solo reproduce lo que publica el gateway.`,
    };
  }
  if (phase === 'loading') {
    return {
      state: 'loading',
      badge: 'CONSULTANDO',
      title: 'Consultando el estado de los servicios',
      text: 'Esperando el agregado `/v1/status` y las dos lecturas que lo acompañan…',
    };
  }
  if (aggregate === null) {
    return {
      state: 'unavailable',
      badge: 'NO DISPONIBLE',
      title: 'No fue posible leer el estado',
      text:
        aggregateFailure !== null
          ? `${failureText(aggregateFailure, 'el agregado de estado `/v1/status`')} No se muestran filas que la API no haya publicado.`
          : 'El agregado de estado no está disponible. No se muestran filas que la API no haya publicado.',
    };
  }
  const notReady = aggregate.data.services.filter(entry => entry.state !== 'ready');
  if (notReady.length === 0) {
    return {
      state: 'operational',
      badge: 'OPERATIVO',
      title: 'Operativo',
      text:
        'Los cuatro servicios declarados (risk, jobs, prevention, inference) respondieron listos y la API del gateway entregó este resumen. La lectura es acotada: no acredita el clima real observado ni sustituye la vigilancia de CONAF ni de SENAPRED.',
    };
  }
  const named = notReady.map(entry => `${SERVICE_LABELS[entry.service]} (${STATE_LABELS[entry.state].toLowerCase()})`);
  const notReadySentence = `No todos los servicios están listos: ${named.join(', ')}.`;
  const preserved =
    aggregate.status === 503
      ? ' El agregado respondió 503 con este mismo cuerpo: esa respuesta no es un error genérico, y sus filas se muestran completas.'
      : '';
  return {
    state: 'degraded',
    badge: 'OPERACIÓN DEGRADADA',
    title: 'Operación degradada',
    text: `${notReadySentence}${preserved}`,
  };
}

function ruleRow(phase: Phase, rule: ActiveRuleEvidence | null): { version: string; hash: string; detail: string } {
  if (phase !== 'settled') {
    const pending = phase === 'unconsulted' ? 'Sin consultar' : 'Consultando…';
    return { version: pending, hash: pending, detail: pending };
  }
  if (rule === null) return { version: 'No verificable', hash: 'No acreditado', detail: 'La regla activa no se pudo interpretar.' };
  if (rule.state === 'verified') return { version: rule.version, hash: rule.paramsHash, detail: rule.label };
  if (rule.state === 'non-rule') {
    return { version: 'Sin regla activa', hash: 'No aplica', detail: rule.label };
  }
  return { version: 'No verificable', hash: 'No acreditado', detail: rule.label };
}

function weatherRow(
  phase: Phase,
  provenance: SourceProvenance | null,
  failure: Failure | null,
): { source: string; detail: string } {
  if (phase !== 'settled') {
    const pending = phase === 'unconsulted' ? 'Sin consultar' : 'Consultando…';
    return { source: pending, detail: pending };
  }
  if (failure !== null) {
    return {
      source: 'No disponible',
      detail: failureText(failure, 'la fuente meteorológica de `/v1/risk/sources`'),
    };
  }
  const source = provenance === null ? null : weatherSourceOf(provenance);
  if (source === null) {
    return {
      source: 'No configurada',
      detail: '`/v1/risk/sources` no publica una fuente meteorológica en esta lectura; esta vista no inventa una.',
    };
  }
  const detail =
    source.synthetic === true
      ? 'El proveedor declara esta fuente como sintética para demostración: no es una lectura meteorológica observada.'
      : source.synthetic === false
        ? 'El proveedor declara esta fuente como no sintética.'
        : 'El proveedor no declara si la fuente es sintética; esta vista no lo asume.';
  return { source: source.identifier !== '' ? `${source.name} · ${source.identifier}` : source.name, detail };
}

export function StatusView() {
  const session = useSessionState();
  const signedIn = session.status === 'signed-in';

  // Evidence is stored WITH the session instance that produced it, exactly like
  // `#sources`: a re-login makes the previous answer unrenderable before the first
  // new response lands, so two sessions can never be mixed in one board.
  const [stored, setStored] = useState<StoredSnapshot | null>(null);

  useEffect(() => {
    if (!signedIn) return;
    const controller = new AbortController();
    let active = true;
    void (async () => {
      // The three reads are independent on purpose: sources and the rule are
      // COMPOSED onto the aggregate, so one of them failing leaves the other two
      // on screen instead of blanking the board (partial degradation).
      const [aggregateOutcome, sourcesOutcome, modelsOutcome] = await Promise.all([
        aggregateStatus(controller.signal),
        sources(controller.signal),
        modelRegistry(controller.signal),
      ]);
      if (!active) return;
      // A superseded or aborted read belongs to a token or an effect instance that
      // no longer owns the screen; painting it would mix two sessions' evidence.
      const abandoned = (failure: Failure): boolean =>
        failure.reason === 'superseded' || failure.reason === 'aborted';
      if (
        (!aggregateOutcome.ok && abandoned(aggregateOutcome.failure)) ||
        (!sourcesOutcome.ok && abandoned(sourcesOutcome.failure)) ||
        (!modelsOutcome.ok && abandoned(modelsOutcome.failure))
      ) {
        return;
      }
      setStored({
        owner: session,
        aggregate: aggregateOutcome.ok
          ? { status: aggregateOutcome.status, data: aggregateOutcome.data }
          : null,
        aggregateFailure: aggregateOutcome.ok ? null : aggregateOutcome.failure,
        provenance: sourcesOutcome.ok ? sourcesOutcome.data : null,
        provenanceFailure: sourcesOutcome.ok ? null : sourcesOutcome.failure,
        rule: evaluateEffectiveClassifier(
          modelsOutcome.ok
            ? { ok: true, effective: modelsOutcome.data.effective }
            : { ok: false, failure: modelsOutcome.failure },
        ),
      });
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [signedIn, session]);

  const current = signedIn && stored !== null && stored.owner === session ? stored : null;
  const phase: Phase = !signedIn ? 'unconsulted' : current === null ? 'loading' : 'settled';

  const aggregate = current?.aggregate ?? null;
  const aggregateFailure = current?.aggregateFailure ?? null;
  const entries = aggregate?.data.services ?? [];
  const verdict = verdictOf(phase, aggregate, aggregateFailure, idleCopy(session, IDLE_ACTION));

  const rule = current?.rule ?? null;
  const { version: ruleVersion, hash: ruleHash, detail: ruleDetail } = ruleRow(phase, rule);
  const { source: weatherSource, detail: weatherDetail } = weatherRow(
    phase,
    current?.provenance ?? null,
    current?.provenanceFailure ?? null,
  );
  const checkedAt = aggregate?.data.checked_at ?? '';

  // The composed rows are the only ones this board reads beyond the aggregate, so
  // a failure there is stated as a partial degradation instead of silently
  // dropping the row.
  const partial: string[] = [];
  if (phase === 'settled') {
    if (current?.provenanceFailure != null) partial.push('la fuente meteorológica (`/v1/risk/sources`)');
    if (rule !== null && rule.state === 'unknown') partial.push('la regla activa (`/v1/models`)');
  }

  return (
    <section className="view" id="status" data-view="status" aria-labelledby="status-title">
      <p className="eyebrow">SERVICIOS Y AGREGADO</p>
      <h2 id="status-title">Estado de servicios</h2>
      <p className="panel-note" id="status-scope">
        Una lectura acotada del agregado <code>/v1/status</code> del gateway, compuesta con la fuente meteorológica de{' '}
        <code>/v1/risk/sources</code> y la regla activa de <code>/v1/models</code>. Esta página no ejecuta
        comprobaciones propias, no consulta métricas ni telemetría, no emite alertas y no sustituye la vigilancia de
        CONAF ni de SENAPRED.
      </p>

      <article className="panel status-panel" aria-labelledby="status-verdict-title">
        <PanelHeading
          eyebrow="AGREGADO DEL GATEWAY"
          title="Veredicto operativo"
          titleId="status-verdict-title"
          badge={
            <span className="neutral-tag" id="status-verdict-badge">
              {verdict.badge}
            </span>
          }
        />
        <StatusCopy id="status-verdict">{verdict.text}</StatusCopy>
        <dl className="data-list compact">
          <div>
            <dt>Leído por el gateway</dt>
            <dd id="status-checked-at">{checkedAt !== '' ? checkedAt : phase === 'settled' && aggregate !== null ? 'No informado' : 'Sin consultar'}</dd>
          </div>
          <div>
            <dt>Respuesta</dt>
            <dd id="status-http-status">
              {aggregate !== null ? `${aggregate.status} con las cuatro filas` : 'Sin respuesta del agregado'}
            </dd>
          </div>
          <div>
            <dt>Servicios</dt>
            <dd id="status-services-count">
              {aggregate !== null ? String(entries.filter(entry => entry.state === 'ready').length) : 'Sin consultar'} listos
              {' · '}
              {aggregate !== null ? String(entries.filter(entry => entry.state !== 'ready').length) : 'Sin consultar'} sin
              estar listos
            </dd>
          </div>
          <div>
            <dt>Fuente meteorológica</dt>
            <dd id="status-weather-source">{weatherSource}</dd>
            <dd id="status-weather-detail" className="status-detail">
              {weatherDetail}
            </dd>
          </div>
          <div>
            <dt>Regla activa</dt>
            <dd id="status-rule-version">{ruleVersion}</dd>
          </div>
          <div>
            <dt>Hash de parámetros</dt>
            <dd id="status-rule-hash">{ruleHash}</dd>
            <dd id="status-rule-detail" className="status-detail">
              {ruleDetail}
            </dd>
          </div>
        </dl>
        <p className="panel-note" id="status-partial">
          {partial.length > 0
            ? `Lectura parcial: no se pudo comprobar ${partial.join(' ni ')}. El veredicto de arriba solo refleja el agregado del gateway y estas filas no se rellenan con valores inventados.`
            : 'Las tres lecturas de esta página compusieron el tablero: el agregado del gateway, la fuente meteorológica y la regla activa.'}
        </p>
      </article>

      <article className="panel status-panel" aria-labelledby="status-services-title">
        <PanelHeading
          eyebrow="CUATRO SUPERFICIES DECLARADAS"
          title="Servicios"
          titleId="status-services-title"
          badge={<span className="neutral-tag" id="status-services-badge">ORDEN DEL SERVIDOR</span>}
        />
        {aggregate !== null ? (
          <div className="table-wrap" tabIndex={0} role="group" aria-label="Tabla de servicios del agregado">
            <table className="status-table">
              <caption>
                Estado de cada superficie tal como lo informó el agregado <code>/v1/status</code>. El orden es el del
                servidor: gateway, risk, jobs, prevention, inference. Esta página no lo reordena ni lo completa.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Componente</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Qué significa</th>
                </tr>
              </thead>
              <tbody>
                <tr data-service={GATEWAY_ROW.wire} data-state={aggregate.data.gateway.state}>
                  <th scope="row">
                    {GATEWAY_ROW.label} <code>{GATEWAY_ROW.wire}</code>
                  </th>
                  <td>
                    <span className="status-state status-state-ready">{STATE_LABELS.ready}</span>
                  </td>
                  <td>{GATEWAY_ROW.reason}</td>
                </tr>
                {entries.map(entry => (
                  <tr key={entry.service} data-service={entry.service} data-state={entry.state}>
                    <th scope="row">
                      {SERVICE_LABELS[entry.service]} <code>{entry.service}</code>
                    </th>
                    <td>
                      <span className={`status-state status-state-${entry.state}`}>{STATE_LABELS[entry.state]}</span>
                    </td>
                    <td>{STATE_REASONS[entry.state]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <StatusCopy id="status-services-unavailable">
            {phase === 'unconsulted'
              ? idleCopy(session, IDLE_ACTION)
              : phase === 'loading'
                ? 'Consultando el agregado `/v1/status`…'
                : `${failureText(aggregateFailure ?? { kind: 'unavailable', reason: 'unavailable' }, 'el agregado `/v1/status`')} Sin cuerpo no hay filas que mostrar: esta vista no fabrica un estado por servicio.`}
          </StatusCopy>
        )}
      </article>
    </section>
  );
}
