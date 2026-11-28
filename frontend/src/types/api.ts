// Payload shapes as the API actually serves them. These are *declarations*, not
// guarantees: the gateway is a separate origin written in another language, so
// nothing here is trusted at runtime. Every consumer validates at the boundary
// and fails closed, exactly as the retired page did — an unreadable or
// incomplete payload renders as "unavailable", never as a plausible value.

export type RiskLevel = 'bajo' | 'medio' | 'alto' | 'desconocido';

export const RISK_LEVELS: readonly RiskLevel[] = ['bajo', 'medio', 'alto', 'desconocido'];

// The provenance of the evaluation itself, declared once for the whole page.
// `BatchCore` is closed on exactly two values: `scheduler` means nobody asked for
// the run, `manual` means a verified operator did. The union lives here, with the
// shared payload declarations, so the domain, the transport guard and the view
// cannot drift into three spellings of the same two words.
export type EvaluationTrigger = 'scheduler' | 'manual';

export const EVALUATION_TRIGGERS: readonly EvaluationTrigger[] = ['scheduler', 'manual'];

// V1-P-02 / PM-11 — the regional context of one published zone. `priority_status`
// is closed on two values: `ranked` means the zone holds a position in the
// published batch, `insufficient` means the rule could not score it and it holds
// none. The numeric members are nullable for exactly that reason: a zero would
// read as the lowest priority instead of as the absence of one.
export type PriorityStatus = 'ranked' | 'insufficient';

export const PRIORITY_STATUSES: readonly PriorityStatus[] = ['ranked', 'insufficient'];

export interface ZonePriority {
  zone_id: string;
  risk_level: RiskLevel | string;
  priority_status: PriorityStatus;
  risk_score: number | null;
  exposure_score: number;
  priority_score: number | null;
  priority_rank: number | null;
  total_ranked_zones: number;
  exposed_assets_count: number;
  dominant_category: string | null;
  context_summary: string;
}

export interface Factor {
  name: string;
  known: boolean;
  value: number;
  contribution: number;
  note?: string;
}

export interface RiskPolicy {
  policy_id: string;
  params_hash: string;
  parameters?: Record<string, unknown>;
}

export interface RiskBatch {
  zone_id: string;
  id: string;
  job_id: string;
  demo: boolean;
  risk_level: RiskLevel | string;
  factors: Factor[];
  rationale: string;
  policy: RiskPolicy;
  notice?: unknown;
  geometry?: GeoGeometry;
  published_at?: string;
  valid_until?: string;
  requested_at?: string;
  model_version?: string;
  data_status?: string;
  scenario_id?: string | null;
  evaluated_at?: string | null;
  // PM-06 BatchCore provenance: which evaluation produced this batch, and, for a
  // manual one, the token subject of the operator who asked for it. `evaluated_by`
  // is null (never an empty string) for a scheduled run, so "nobody asked" stays
  // distinguishable from a blank actor. Both are optional because a row written
  // before the provenance columns existed carries neither, and the declaration is
  // not a runtime guarantee: the transport validates their types and the domain
  // validates the closed vocabulary before the page shows either.
  evaluation_trigger?: EvaluationTrigger;
  evaluated_by?: string | null;
  // V1-P-02 / PM-11: the regional priority the backend computed over the published
  // batch. It is optional because only the reads that can see the whole batch
  // serve it (`latest` and `batches`), and because a batch whose regional context
  // could not be computed is served without it instead of with an invented one.
  priority?: ZonePriority | null;
}

export type GeoGeometry =
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] }
  | { type: 'Point'; coordinates: number[] };

// `/v1/risk/batches` serves the aggregate inside an envelope rather than as the
// bare array `/v1/risk/history` serves: one element per zone that has a published
// batch, and no zone with none. Each element carries the members of the per-zone
// read EXCEPT the batch geometry, because the map takes geometry from
// `/v1/risk/zones` and the contract deliberately does not repeat every polygon.
export interface BatchCollection {
  batches: RiskBatch[];
}

export interface ZoneProperties {
  code: string;
  name: string;
  province?: string;
}

export interface ZoneFeature {
  type: 'Feature';
  properties: ZoneProperties;
  geometry: GeoGeometry;
}

export interface ZoneCollection {
  type: 'FeatureCollection';
  features: ZoneFeature[];
}

// `/v1/risk/sources` does not serve a flat record: it nests the provenance under
// `geography`, states integrity as an object with a boolean `matches`, and carries
// its own cutoff semantics. The retired page read exactly this shape and failed
// closed on any part of it, so the declaration follows the payload rather than a
// flattened convenience shape.
export interface SourceProvenance {
  geography: {
    provenance: {
      provider: string;
      attribution: string;
      restriction: string;
      derived_sha256: string;
      record_count: number;
    };
    integrity: { matches: boolean; algorithm?: string };
    source_cutoff_at?: string | null;
    cutoff_semantics: string;
  };
  risk_input?: { synthetic?: boolean; display_name?: string; id?: string } | null;
  // Per-source cycle state and freshness (front 1, T4). The real payload always
  // carries a non-null `sources` array of `SourceStatus`; it is typed `unknown`
  // on purpose, because the transport does not re-shape it and `domain/cycle.ts`
  // decides what each entry means.
  sources?: unknown;
  code?: string;
}

// A dependency states its own readiness under `state` (`ready`, `degraded`, …).
// It is never inferred from the enclosing `ready` flag, and a missing, null or
// non-object entry is missing evidence rather than agreement.
export interface DependencyState {
  state?: string;
  [key: string]: unknown;
}

// `/v1/risk/status` and `/v1/jobs/status` share this snapshot shape. A service is
// only ever reported as verified when the payload carries `ready: true`, an empty
// `reason`, a fresh `checked_at`, a known dead-letter depth inside the payload's
// own `max_age_seconds` bound and three dependencies that each state `ready`;
// anything else is unknown.
export interface ServiceSnapshot {
  ready: boolean;
  reason: string;
  checked_at: string;
  dependencies: {
    database?: DependencyState;
    broker?: DependencyState;
    dead_letter?: DependencyState & {
      max_age_seconds?: number;
      age_seconds?: number;
      depth?: number | null;
      max_depth?: number | null;
    };
  };
}

// ── Effective classifier (`GET /v1/models`, PM-16 / S1) ──────────────────────
//
// The additive `effective` projection of the classifier the NEXT publication
// would resolve, published beside the unchanged registry `models` list (frozen
// backend contract, L6). These are declarations, not guarantees: `models` is
// never an identity source here, and `core/active-rule.ts` validates the three
// shapes before anything is shown. An absent or malformed projection is
// `unknown`, not an inferred identity.
export interface EffectiveRuleClassifier {
  status: 'rule';
  version: string;
  params_hash: string;
}

export interface EffectiveNonRuleClassifier {
  status: 'non_rule';
}

export interface EffectiveUnavailableClassifier {
  status: 'unavailable';
}

export type EffectiveClassifier =
  | EffectiveRuleClassifier
  | EffectiveNonRuleClassifier
  | EffectiveUnavailableClassifier;

export interface ModelRegistry {
  /** The registry rows, kept for the overview panel; never an identity source. */
  models: unknown[];
  /** Declared `unknown` on purpose: the client fails closed on an absent or malformed projection. */
  effective?: unknown;
}

export interface Job {
  id: string;
  zone_id: string;
  state: string;
  // The jobs service stores `batch_id` as a nullable column and serializes it
  // without `omitempty`, so a job that has not been published yet answers
  // `"batch_id": null` rather than omitting the field. `undefined` covers a
  // payload that omits it; `null` is the wire's own spelling of "not yet".
  batch_id?: string | null;
  scenario_id?: string | null;
  evaluated_at?: string | null;
  requested_at?: string;
}

export interface Scenario {
  id: string;
  description: string;
}

// The durable audit row returned by `GET /v1/audit`. `event_id` is the row's own
// stable identity (never the job or trace id), so two events of one job remain
// distinguishable. `actor_name` is the display name captured from verified token
// claims; it is null when no name was captured, and the view falls back to the
// opaque `actor_id` instead of synthesizing one. `detail` is server-generated
// free text and `job_id` is null on a query record.
export interface AuditEntry {
  event_id: string;
  actor_id: string;
  actor_name: string | null;
  action: string;
  event_kind: 'mutation' | 'query';
  detail: string | null;
  job_id: string | null;
  trace_id: string;
  occurred_at: string;
}

// ── Preventive actions (frozen `prevention` contract) ───────────────────────
//
// The fields are the columns of `prevention.actions` named in
// `odd/tasks/presentation-client-ready.md` §«Contrato congelado». Declarations
// are not guarantees: every payload is validated at the transport boundary and
// `action_history` is required by the detail route.

// V1-P-03 — the canonical four-group projection of the eight frozen preventive
// action statuses. The owner's ratified decision keeps the eight states exactly as
// they are and publishes this projection on top of them: candidate (propuesta,
// asignada), in_progress (en_curso, enviada), reviewed (bloqueada, devuelta) and
// closed (aceptada, cancelada). It is derived from `status` and stored nowhere, so
// it can never disagree with the state the action is in.
export type ActionStageGroup = 'candidate' | 'in_progress' | 'reviewed' | 'closed';

export interface PreventiveAction {
  id: string;
  community_code: string;
  title: string;
  description?: string;
  priority?: string;
  status: string;
  // The group `status` projects onto. The service sends it on every read; it is
  // optional here because a payload recorded before the projection existed omits
  // it, and the page then derives the same group from `status` instead of
  // inventing one. An undeclared value is shown as it arrived, never translated.
  stage_group?: ActionStageGroup;
  // Nullable on the wire: the column is `*string`, so an unassigned action
  // carries `null` rather than an absent field.
  assignee?: string | null;
  // Directory reference of the responsible, or `null` when unassigned. The
  // contract types it `format: uuid` and nullable, and the service serializes it
  // without `omitempty`, so a present value is null or a dashed UUID. It is the
  // reference NEW assignments use; `assignee` above is the legacy free text.
  // Optional here because older payloads and fixtures omit it entirely.
  assignee_id?: string | null;
  due_date?: string | null;
  created_by?: string;
  created_at?: string;
  updated_at?: string;
}

export interface ActionHistoryEntry {
  // The service's `action_history.id` is an int64, so it arrives as a number.
  id?: number;
  action_id?: string;
  from_status?: string | null;
  to_status: string;
  actor_sub?: string;
  note?: string;
  created_at?: string;
}

export interface PreventiveActionDetail extends PreventiveAction {
  history: ActionHistoryEntry[];
  // The S2 append-only collections. The server always sends them on the detail
  // route (never on the list route).
  evidence: PreventiveEvidence[];
  evidence_reviews: PreventiveEvidenceReview[];
  reassessments: PreventiveReassessment[];
  // Server-computed: the CURRENT evidence snapshot carries a sufficient human
  // review. The transition route remains the authority on acceptance.
  evidence_sufficient: boolean;
}

export interface PreventiveEvidence {
  id?: number;
  action_id?: string;
  criterion: string;
  references: string[];
  created_by?: string;
  created_at?: string;
}

export interface PreventiveEvidenceReview {
  id?: number;
  action_id?: string;
  evidence_id: number;
  decision: string;
  reviewer_sub?: string;
  note?: string;
  reviewed_at?: string;
}

// ── Field observations (PM-09) ──────────────────────────────────────────────
//
// The frozen seam is `GET|POST /v1/prevention/observations` and
// `GET /v1/prevention/observations/zones`. The type is a closed catalogue on the
// wire: the labels are the Spanish words of S2/S3 and the values are what the
// server accepts. `created_by` is the verified token `sub`; the client never
// sends it and never invents one.

export type ObservationType = 'vegetacion_seca' | 'microbasural' | 'quema' | 'acceso_bloqueado' | 'otro';

export const OBSERVATION_TYPES: readonly ObservationType[] = [
  'vegetacion_seca',
  'microbasural',
  'quema',
  'acceso_bloqueado',
  'otro',
];

export interface Observation {
  id: string;
  // The closed catalogue of PM-09. The transport refuses a served value outside
  // it as a contract change, so the Spanish label map always covers the type.
  type: ObservationType;
  zone_id: string;
  // Nullable on the wire: a catalog zone without a name answers `null`.
  zone_name: string | null;
  // `YYYY-MM-DD`; the observation's own date, not its creation instant.
  observed_on: string;
  description: string;
  created_by: string;
  created_at: string;
  // PM-10 (S4): the preventive action this observation was durably confirmed to
  // justify, as the service reports it on every observation read. `null` (or an
  // absent field in an older payload) means no confirmation has been recorded.
  // It is an identifier and not a copy of the action: the record is historical,
  // so it keeps naming the adopted action after that action is cancelled.
  adopted_action_id?: string | null;
}

export interface ObservationZone {
  // `code` is the catalogue key the creation posts as `zone_id`.
  code: string;
  name: string;
  province: string | null;
}

export interface PreventiveReassessment {
  id?: number;
  action_id?: string;
  job_id: string;
  batch_id: string;
  version: string;
  risk_level: string;
  zone_id: string;
  synthetic: boolean;
  // Always false: a synthetic classification is never causal proof of risk
  // reduction.
  causal_proof: boolean;
  batch_published_at?: string;
  linked_by?: string;
  linked_at?: string;
}
