import { useEffect, useState } from 'react';

import { idleCopy, rejectedSessionCopy } from '../app/sessionCopy';
import { useSessionState } from '../app/store';
import { PanelHeading, UnimplementedNote } from '../components/ui';
import { timing } from '../config';
import { evaluateEffectiveClassifier, type ActiveRuleEvidence } from '../core/active-rule';
import { jobsStatus, modelRegistry, ready, riskStatus, sources, type Failure } from '../core/api';
import type { SessionState } from '../core/session';
import {
  evaluateCycle,
  evaluatePipeline,
  evaluateProvenance,
  evaluateServiceStatus,
  type CycleFreshness,
  type PipelineDecision,
  type ProvenanceDecision,
  type ServiceStatusDecision,
} from '../domain';
import { evaluateGatewayProbe, type GatewayProbeDecision } from '../domain/readiness';
import { evaluateOperationalStatus } from '../domain/operational-status';

// N8b — the sources + services view. It carries the scope declaration (S15), the
// provenance fields reproduced verbatim, the restriction text untouched, an
// integrity line that only claims what the service verified, and the pipeline
// status: a service is verified ONLY when its own snapshot earns it, a 403 reads
// as "not authorized to check" and never as "down", and the gateway readiness
// card is explicitly excluded from pipeline proof.

type Phase = 'unconsulted' | 'loading' | 'settled';

// Verified against the consumed contract: none of the routes this view reads
// (`/v1/risk/sources`, `/v1/risk/status`, `/v1/jobs/status`, `/v1/models`) publishes
// a weather provider or a weather reading. The row states the missing integration
// as a product limitation; it is never painted as a successful probe.
const WEATHER_INTEGRATION =
  'No integrada: el contrato que esta vista consulta no publica una fuente meteorológica; no hay lectura de clima que mostrar y no se inventa una.';

interface SourcesSnapshot {
  provenance: ProvenanceDecision | null;
  provenanceFailure: Failure | null;
  cycle: CycleFreshness | null;
  risk: ServiceStatusDecision | null;
  jobs: ServiceStatusDecision | null;
  pipeline: PipelineDecision | null;
  gateway: GatewayProbeDecision;
  rule: ActiveRuleEvidence;
  riskCheckedAt: string;
  jobsCheckedAt: string;
}

// Evidence is stored WITH the session instance that produced it. `useSessionState`
// publishes a new SessionState object on every transition, so a re-login makes
// the previous evidence unrenderable before the first new response lands.
interface StoredSnapshot {
  readonly owner: SessionState;
  readonly snapshot: SourcesSnapshot;
}

function provenanceFailureMessage(failure: Failure): string {
  switch (failure.kind) {
    case 'unauthorized':
      return rejectedSessionCopy();
    case 'forbidden':
      return 'La API denegó el permiso para consultar la procedencia (403). Solicita acceso a un administrador.';
    case 'malformed':
      return 'La API devolvió una procedencia ilegible; no se muestra como fuente saludable.';
    default: {
      const code =
        failure.status !== undefined && failure.reason !== `http_${failure.status}` ? ` · ${failure.reason}` : '';
      const http = failure.status !== undefined ? `HTTP ${failure.status}${code}` : 'sin conexión';
      return `Procedencia geográfica no disponible (${http}); la integridad no se acredita y no se muestra como fuente saludable.`;
    }
  }
}

function provenanceStatusText(phase: Phase, decision: ProvenanceDecision | null, failure: Failure | null, unconsulted: string): string {
  if (phase === 'unconsulted') return unconsulted;
  if (phase === 'loading') return 'Consultando procedencia…';
  if (failure !== null) return provenanceFailureMessage(failure);
  if (decision !== null && decision.available) {
    return 'Procedencia geográfica publicada e integridad del hash verificada por el servicio. La restricción de la fuente se reproduce literal; no se acredita aprobación de DIFROL ni licencia adicional.';
  }
  return decision !== null ? decision.reason : 'Procedencia no disponible.';
}

// The rule row's three values. Only the verified branch may render a version or a
// hash; every other branch names what is missing instead of borrowing a value.
// Kept out of the component so the phase mapping is one readable table rather
// than three nested ternaries inside the render.
function ruleRowValues(
  phase: Phase,
  rule: ActiveRuleEvidence | null,
): { version: string; hash: string; kind: string } {
  if (phase !== 'settled') {
    const pending = phase === 'unconsulted' ? 'Sin consultar' : 'Consultando…';
    return { version: pending, hash: pending, kind: pending };
  }
  if (rule === null) return { version: 'No verificable', hash: 'No acreditado', kind: 'No informado' };
  if (rule.state === 'verified') return { version: rule.version, hash: rule.paramsHash, kind: 'Regla' };
  if (rule.state === 'non-rule') return { version: 'No es una regla', hash: 'No aplica', kind: 'No es una regla' };
  return { version: 'No verificable', hash: 'No acreditado', kind: 'No verificado' };
}

// The service timestamps the status snapshots report, reproduced as evidence. A
// missing one stays "no informada"; the row never substitutes the client clock.
function freshnessLabel(phase: Phase, riskCheckedAt: string, jobsCheckedAt: string): string {
  if (phase !== 'settled') return phase === 'unconsulted' ? 'Sin consultar' : 'Consultando…';
  if (riskCheckedAt === '' && jobsCheckedAt === '') return 'No informada';
  const risk = riskCheckedAt !== '' ? riskCheckedAt : 'no informada';
  const jobs = jobsCheckedAt !== '' ? jobsCheckedAt : 'no informada';
  return `riesgo ${risk} · trabajos ${jobs}`;
}

export function SourcesView() {
  const session = useSessionState();
  const signedIn = session.status === 'signed-in';

  // The evidence is ignored while there is no session, so a closed session shows
  // the explicit unconsulted state even though the last read is still in memory.
  const [stored, setStored] = useState<StoredSnapshot | null>(null);

  useEffect(() => {
    if (!signedIn) return;
    const controller = new AbortController();
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (): void => {
      if (controller.signal.aborted) return;
      // Recursive setTimeout only: each cycle replaces one bounded, cancelable
      // timer while the session lives, exactly as the retired page did.
      timer = setTimeout(() => {
        void cycle();
      }, timing.pipelineRefreshMs);
    };

    const cycle = async (): Promise<void> => {
      const outcomes = await Promise.all([
        sources(controller.signal),
        riskStatus(controller.signal),
        jobsStatus(controller.signal),
        // PM-16: the authoritative effective projection travels in the same
        // bounded cycle as the status snapshots, through the existing
        // `GET /v1/models` route. The registry rows are never read here.
        modelRegistry(controller.signal),
        // A LIVE probe of the gateway, deliberately unauthenticated and kept in
        // its own row: a 204 proves the gateway answered, not the pipeline. It
        // names its own lane because the shell card probes the same route: on a
        // shared sequence either consumer discarded the other's healthy answer,
        // and here that also threw away the whole cycle.
        ready(controller.signal, 'sources'),
      ]);
      if (!active) return;
      // A superseded or aborted read belongs to a token or an effect instance that
      // no longer owns the screen. Painting it would mix two sessions' evidence,
      // so the whole cycle is abandoned and re-read under the current session.
      if (
        outcomes.some(
          (outcome) => !outcome.ok && (outcome.failure.reason === 'superseded' || outcome.failure.reason === 'aborted'),
        )
      ) {
        schedule();
        return;
      }
      const [sourcesOutcome, riskOutcome, jobsOutcome, modelsOutcome, gatewayOutcome] = outcomes;

      const provenance = sourcesOutcome.ok ? evaluateProvenance(200, sourcesOutcome.data) : null;
      const provenanceFailure = sourcesOutcome.ok ? null : sourcesOutcome.failure;
      const now = Date.now();
      // Cycle freshness travels inside the sources payload (front 1, T4). The
      // transport passes the optional object through; the domain decides what it
      // means and never invents a run time the service did not state.
      const cycleFreshness = sourcesOutcome.ok ? evaluateCycle(sourcesOutcome.data, now) : null;
      const risk = riskOutcome.ok
        ? evaluateServiceStatus({ status: 200, body: riskOutcome.data }, now)
        : evaluateServiceStatus({ status: riskOutcome.failure.status ?? 0, body: null }, now);
      const jobs = jobsOutcome.ok
        ? evaluateServiceStatus({ status: 200, body: jobsOutcome.data }, now)
        : evaluateServiceStatus({ status: jobsOutcome.failure.status ?? 0, body: null }, now);
      // The effective projection is evidence only for what it proves: a validated
      // rule identity and its hash, a resolved non-rule without identity, or a
      // truthful unknown. Raw registry rows never participate.
      const rule = evaluateEffectiveClassifier(
        modelsOutcome.ok
          ? { ok: true, effective: modelsOutcome.data.effective }
          : { ok: false, failure: modelsOutcome.failure },
      );
      const gateway = evaluateGatewayProbe(
        gatewayOutcome.ok ? { ok: true } : { ok: false, status: gatewayOutcome.failure.status },
      );
      setStored({
        owner: session,
        snapshot: {
          provenance,
          provenanceFailure,
          cycle: cycleFreshness,
          risk,
          jobs,
          pipeline: evaluatePipeline(risk, jobs),
          gateway,
          rule,
          riskCheckedAt: riskOutcome.ok ? riskOutcome.data.checked_at : '',
          jobsCheckedAt: jobsOutcome.ok ? jobsOutcome.data.checked_at : '',
        },
      });
      schedule();
    };

    void cycle();

    return () => {
      active = false;
      controller.abort();
      if (timer !== null) clearTimeout(timer);
    };
  }, [signedIn, session]);

  const current = signedIn && stored !== null && stored.owner === session ? stored.snapshot : null;
  const phase: Phase = !signedIn ? 'unconsulted' : current === null ? 'loading' : 'settled';
  const provenance = current?.provenance ?? null;
  const provenanceFailure = current?.provenanceFailure ?? null;
  const cycle = current?.cycle ?? null;
  const riskDecision = current?.risk ?? null;
  const jobsDecision = current?.jobs ?? null;
  const pipeline = current?.pipeline ?? null;
  const gateway = current?.gateway ?? null;
  const rule = current?.rule ?? null;
  const riskCheckedAt = current?.riskCheckedAt ?? '';
  const jobsCheckedAt = current?.jobsCheckedAt ?? '';

  const accepted = provenance !== null && provenance.available ? provenance.provenance : null;
  // A field that was never read states "Sin consultar"; a field whose read was
  // cleared (logout) states "No disponible", exactly as the retired page did.
  const field = (value: string | number | undefined): string => {
    if (value !== undefined && value !== '') return String(value);
    return stored === null ? 'Sin consultar' : 'No disponible';
  };

  const badge =
    phase === 'unconsulted'
      ? 'SIN CONSULTAR'
      : phase === 'loading'
        ? 'CONSULTANDO'
        : accepted !== null
          ? 'PUBLICADA'
          : 'NO DISPONIBLE';
  const statusClass =
    accepted !== null ? 'status-copy risk-good' : phase === 'settled' ? 'status-copy risk-error' : 'status-copy';

  const pipelineStatus =
    phase === 'unconsulted'
      ? idleCopy(session, 'comprobar los servicios')
      : phase === 'loading'
        ? 'Consultando servicios…'
        : pipeline !== null
          ? pipeline.status
          : 'Servicios dependientes no verificados.';
  const pipelineClass = pipeline?.verified ? 'status-copy risk-good' : 'status-copy';

  // Cycle freshness. Every field is labelled in place: an unreadable or absent
  // field is never rendered as a plausible timestamp or a zero age. The state is
  // the derived completeness of the per-source array, not a field the service
  // does not publish.
  const cycleBadge =
    phase === 'unconsulted'
      ? 'SIN CONSULTAR'
      : phase === 'loading'
        ? 'CONSULTANDO'
        : cycle !== null && cycle.available
          ? cycle.complete === true
            ? 'COMPLETA'
            : 'INCOMPLETA'
          : 'SIN INFORMAR';
  const cycleStatusText =
    phase === 'unconsulted'
      ? idleCopy(session, 'consultar la frescura del ciclo')
      : phase === 'loading'
        ? 'Consultando la frescura del ciclo…'
        : cycle !== null
          ? cycle.label
          : 'La API no devolvió la frescura del ciclo; se muestra como no disponible.';
  const cycleField = (value: string): string => (cycle !== null && cycle.available && value !== '' ? value : 'No informado');
  const cycleAge = cycle !== null && cycle.available && cycle.ageSeconds !== null ? `${cycle.ageSeconds} s` : 'No informado';
  const cycleState =
    cycle !== null && cycle.available ? (cycle.complete === true ? 'completa' : 'incompleta') : 'No informado';

  // PM-16 — the single operational verdict and the rule row it depends on. A
  // placeholder is always phase-specific: the rule row never renders a version or
  // a hash while nothing has been read.
  const provenanceAvailable = phase === 'settled' ? provenance !== null && provenance.available : null;
  const syntheticInput = provenance !== null && provenance.available ? provenance.provenance.syntheticInput : null;
  const verdict = evaluateOperationalStatus({
    phase,
    risk: riskDecision,
    jobs: jobsDecision,
    gateway,
    rule,
    provenanceAvailable,
    syntheticInput,
    weatherIntegrated: false,
  });

  const { version: ruleVersion, hash: ruleHash, kind: ruleKind } = ruleRowValues(phase, rule);
  const ruleEvidence =
    phase === 'unconsulted'
      ? idleCopy(session, 'verificar la regla activa')
      : phase === 'loading'
        ? 'Consultando el registro de versiones…'
        : (rule?.label ?? 'El registro de versiones no se pudo interpretar.');
  const gatewayEvidence =
    phase === 'unconsulted' ? 'Sin consultar' : phase === 'loading' ? 'Consultando…' : (gateway?.label ?? 'Sin consultar');
  const freshness = freshnessLabel(phase, riskCheckedAt, jobsCheckedAt);

  return (
    <section className="view" id="sources" data-view="sources" aria-labelledby="sources-title">
      <p className="eyebrow">PROCEDENCIA Y SERVICIOS</p>
      <h2 id="sources-title">Fuentes y servicios</h2>
      <div className="warning-banner" role="note" aria-label="Alcance de los datos de esta página">
        <span className="warning-icon" aria-hidden="true">
          !
        </span>
        <p>
          <strong>Entrada de demostración: todavía no hay ingestión de datos reales.</strong> La API clasifica un lote
          sintético con una regla académica propia, declarada como no oficial y no calibrada contra incendios
          observados. Esta página no predice fecha ni lugar, no emite alertas y no sustituye a CONAF ni a SENAPRED.
          Mientras esa afirmación siga siendo cierta, se mantiene visible aquí y en el aviso de alcance de la barra
          superior.
        </p>
      </div>

      <article className="panel sources-panel">
        <PanelHeading
          eyebrow="PROCEDENCIA GEOGRÁFICA"
          title="Fuentes y procedencia"
          badge={
            <span className="neutral-tag" id="sources-badge">
              {badge}
            </span>
          }
        />
        <p id="sources-status" className={statusClass} role="status" aria-live="polite">
          {provenanceStatusText(phase, provenance, provenanceFailure, idleCopy(session, 'consultar la procedencia'))}
        </p>
        <dl className="data-list">
          <div>
            <dt>Proveedor</dt>
            <dd id="sources-provider">{accepted ? accepted.provider : field(undefined)}</dd>
          </div>
          <div>
            <dt>Atribución</dt>
            <dd id="sources-attribution">{accepted ? accepted.attribution : field(undefined)}</dd>
          </div>
          <div>
            <dt>Restricción</dt>
            <dd id="sources-restriction">{accepted ? accepted.restriction : field(undefined)}</dd>
          </div>
          <div>
            <dt>Registros de la capa</dt>
            <dd id="sources-record-count">{accepted ? accepted.recordCount : field(undefined)}</dd>
          </div>
          <div>
            <dt>Hash derivado (sha256)</dt>
            <dd id="sources-derived-sha256">{accepted ? accepted.derivedSha256 : field(undefined)}</dd>
          </div>
          <div>
            <dt>Integridad declarada</dt>
            <dd id="sources-integrity">{accepted ? accepted.integrityLabel : field(undefined)}</dd>
          </div>
          <div>
            <dt>Corte de fuente</dt>
            <dd id="sources-cutoff">{accepted ? accepted.cutoffLabel : field(undefined)}</dd>
          </div>
          <div>
            <dt>Entrada de riesgo</dt>
            <dd id="sources-input">{accepted ? accepted.riskInputLabel : field(undefined)}</dd>
          </div>
        </dl>
        <UnimplementedNote>
          Hallazgos de calidad: <code>/v1/risk/sources</code> publica la procedencia y la integridad reales, no un
          catálogo de hallazgos de calidad. Las acciones preventivas sí existen y viven en su propia vista{' '}
          (<a href="#actions">#actions</a>).
        </UnimplementedNote>
      </article>

      <article className="panel pipeline-panel" id="pipeline" aria-labelledby="pipeline-title">
        <PanelHeading
          eyebrow="ESTADO COMPROBABLE"
          titleId="pipeline-title"
          title="Servicios y veredicto operativo"
          badge={
            <span className="neutral-tag" id="pipeline-badge">
              {pipeline !== null ? pipeline.badge : 'SIN VERIFICAR'}
            </span>
          }
        />
        <p id="pipeline-status" className={pipelineClass} role="status" aria-live="polite">
          {pipelineStatus}
        </p>
        <dl className="data-list compact">
          <div>
            <dt>Servicio de riesgo</dt>
            <dd id="pipeline-risk">{riskDecision !== null ? riskDecision.label : 'Sin verificar'}</dd>
          </div>
          <div>
            <dt>Servicio de trabajos</dt>
            <dd id="pipeline-jobs">{jobsDecision !== null ? jobsDecision.label : 'Sin verificar'}</dd>
          </div>
          <div>
            <dt>Gateway</dt>
            <dd id="pipeline-gateway">{gatewayEvidence}</dd>
          </div>
          <div>
            <dt>Fuente meteorológica</dt>
            <dd id="operational-weather">{WEATHER_INTEGRATION}</dd>
          </div>
          <div>
            <dt>Regla activa</dt>
            <dd id="operational-rule">{ruleVersion}</dd>
          </div>
          <div>
            <dt>Hash de parámetros</dt>
            <dd id="operational-rule-hash">{ruleHash}</dd>
          </div>
          <div>
            <dt>Tipo efectivo</dt>
            <dd id="operational-rule-kind">{ruleKind}</dd>
          </div>
          <div>
            <dt>Frescura reportada</dt>
            <dd id="operational-freshness">{freshness}</dd>
          </div>
        </dl>
        <p className="panel-note" id="operational-rule-evidence">
          {ruleEvidence}
        </p>
        <div className="operational-verdict">
          <div className="operational-verdict-head">
            <p className="eyebrow">VEREDICTO OPERATIVO</p>
            <span className="neutral-tag" id="operational-verdict-badge">
              {verdict.badge}
            </span>
          </div>
          <h4 id="operational-verdict-title">{verdict.title}</h4>
          <p id="operational-verdict">{verdict.text}</p>
          {/* The only verification announcement. Its text is derived from the
              verdict state, so a 30 s refresh that reaches the same verdict does
              not mutate this node (no repeated announcement), while a transition
              updates it once. It names the verdict only: the visible paragraph is
              not a live region, and the service/provenance paragraphs keep their
              own regions for their own facts. */}
          <p className="sr-only" id="operational-verdict-announcement" role="status" aria-live="polite">
            {verdict.state === 'unconsulted' || verdict.state === 'loading'
              ? ''
              : `Veredicto operativo: ${verdict.title}.`}
          </p>
          <p className="panel-note" id="operational-scope">
            Esta vista no consulta métricas ni telemetría y no abre una segunda pantalla de salud: solo lee los
            contratos listados. La sonda del gateway es una comprobación propia y no acredita los servicios
            autenticados.
          </p>
        </div>
      </article>

      <article className="panel cycle-panel" id="cycle" aria-labelledby="cycle-title">
        <PanelHeading
          eyebrow="CICLO DE INGESTA"
          titleId="cycle-title"
          title="Frescura y última ejecución"
          badge={
            <span className="neutral-tag" id="cycle-badge">
              {cycleBadge}
            </span>
          }
        />
        <p id="cycle-status" className="status-copy" role="status" aria-live="polite">
          {cycleStatusText}
        </p>
        <dl className="data-list compact">
          <div>
            <dt>Última ejecución</dt>
            <dd id="cycle-last-run">{cycleField(cycle?.lastRunAt ?? '')}</dd>
          </div>
          <div>
            <dt>Renovación esperada</dt>
            <dd id="cycle-next-run">{cycleField(cycle?.nextRunAt ?? '')}</dd>
          </div>
          <div>
            <dt>Estado del ciclo</dt>
            <dd id="cycle-state">{cycleState}</dd>
          </div>
          <div>
            <dt>Antigüedad</dt>
            <dd id="cycle-age">{cycleAge}</dd>
          </div>
          <div>
            <dt>Fuentes informadas</dt>
            <dd id="cycle-sources">{cycle !== null && cycle.available ? String(cycle.sourceCount) : 'No informado'}</dd>
          </div>
          <div>
            <dt>Último error</dt>
            <dd id="cycle-last-error">{cycle !== null && cycle.available && cycle.lastError !== '' ? cycle.lastError : 'Sin error informado'}</dd>
          </div>
        </dl>
      </article>
    </section>
  );
}
