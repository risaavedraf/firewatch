// V1-P-01 / PM-12 — what the served land-cover layer means to a reader.
//
// The backend computed every number here; this module only decides how to say it
// and what to say when it is absent. It never derives a value the payload did not
// carry: an NDVI or a class the API did not serve is shown as an absence with its
// reason, because a derived reading would be a measurement nobody took.
//
// The layer is COMPLEMENTARY to the scalar `cobertura_vegetal` variable of the
// rule. Nothing here is a factor, a level or an input of the classifier, and no
// copy in this module may suggest otherwise.
import {
  ENVIRONMENT_CLASSES,
  LAND_COVER_KEYS,
  VEGETATION_SOURCE_LABEL,
  type EnvironmentClass,
  type LandCoverBreakdown,
  type LandCoverKey,
  type VegetationCatalogue,
  type ZoneLandCover,
} from '../types/api';

// Two different facts, said differently: a payload that never arrived and a payload
// that contradicts itself. Neither prints a number.
export const LAND_COVER_ABSENT_COPY =
  'Sin cobertura de suelo: la API no publicó la capa de vegetación para esta comuna, así que no se muestra ningún NDVI ni ninguna clase de entorno.';

export const LAND_COVER_CONTRADICTORY_COPY =
  'Sin cobertura de suelo: la capa recibida no cumple las invariantes declaradas (NDVI, porcentajes, clase de entorno o procedencia sintética), así que no se muestra.';

// The visible provenance badge. It names the declared seed, never a satellite
// product, and it is the same literal the API serves in `source_label`.
export const LAND_COVER_BADGE = `SINTÉTICO · ${VEGETATION_SOURCE_LABEL}`;

// The visible names of the four closed classes, in the decision's order.
export const ENVIRONMENT_CLASS_LABELS: Record<EnvironmentClass, string> = {
  WUI_ALTA: 'Interfaz urbano-forestal alta',
  FORESTAL_DENSO: 'Forestal denso',
  MIXTO_RURAL: 'Mixto rural',
  PERIURBANO: 'Periurbano',
};

// The visible names of the five declared percentages, in the decision's order.
export const LAND_COVER_LABELS: Record<LandCoverKey, string> = {
  bosque_nativo_pct: 'Bosque nativo',
  plantacion_forestal_pct: 'Plantación forestal',
  matorral_pastizal_pct: 'Matorral y pastizal',
  interfaz_urbano_forestal_pct: 'Interfaz urbano-forestal',
  suelo_desnudo_agua_pct: 'Suelo desnudo y agua',
};

// One declared share, formatted once so the table and the detail card cannot
// print the same number two ways.
export interface LandCoverShare {
  key: LandCoverKey;
  label: string;
  value: number;
  percent: string;
}

export type LandCoverView =
  | { kind: 'absent'; reason: string }
  | {
      kind: 'present';
      zoneId: string;
      zoneName: string;
      environment: string;
      environmentClass: EnvironmentClass;
      ndviMean: string;
      ndviRange: string;
      ndviAnomaly: string;
      dominant: LandCoverShare;
      shares: LandCoverShare[];
      synthetic: string;
      summary: string;
    };

// The brevity of the tolerance matches the transport guard: the producer emits whole
// points, and the tolerance only absorbs binary float error in a five-term sum.
const BREAKDOWN_TOLERANCE = 1e-6;

function finiteBetween(value: unknown, lower: number, upper: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= lower && value <= upper;
}

// sharesOf projects the five served percentages. It returns an empty list when the
// split is not the declared five, so a caller never prints a partial breakdown.
//
// The guard runs here as well as in `violatesInvariants` because this helper is
// exported: a caller can hand it anything the type allows at compile time, and a
// missing or null split must answer with no shares instead of throwing.
export function sharesOf(breakdown: LandCoverBreakdown): LandCoverShare[] {
  if (!validBreakdown(breakdown)) return [];
  const shares: LandCoverShare[] = [];
  for (const key of LAND_COVER_KEYS) {
    const value = breakdown[key];
    if (!finiteBetween(value, 0, 100)) return [];
    shares.push({ key, label: LAND_COVER_LABELS[key], value, percent: `${value}%` });
  }
  return shares;
}

// validBreakdown is the shape half of the re-check: an object carrying EXACTLY the
// five declared keys. A missing, null, array or non-object split is not a shape this
// page may read, and an extra or dropped key is a contract change — the transport
// guard refuses both, so the domain refuses them too instead of printing a profile
// the payload never declared.
function validBreakdown(breakdown: unknown): breakdown is LandCoverBreakdown {
  if (breakdown === null || typeof breakdown !== 'object' || Array.isArray(breakdown)) return false;
  const keys = Object.keys(breakdown);
  if (keys.length !== LAND_COVER_KEYS.length) return false;
  return keys.every(key => (LAND_COVER_KEYS as readonly string[]).includes(key));
}

// dominantShare is the heaviest class, with ties broken by the declared order. The
// order is the decision's own, so the answer is deterministic: a reader can
// reproduce it by reading the table left to right.
export function dominantShare(breakdown: LandCoverBreakdown): LandCoverShare | null {
  const shares = sharesOf(breakdown);
  if (shares.length === 0) return null;
  let best = shares[0];
  for (const share of shares) {
    if (share.value > best.value) best = share;
  }
  return best;
}

// violatesInvariants is the domain's own re-check. The transport already refuses a
// broken payload, and this second pass exists because a caller may hand any object
// over directly: the page must not print a claim the data contradicts either way.
function violatesInvariants(zone: ZoneLandCover): boolean {
  if (zone.zone_id === '' || zone.zone_name === '') return true;
  if (!finiteBetween(zone.ndvi_min, 0, 1)) return true;
  if (!finiteBetween(zone.ndvi_mean, 0, 1)) return true;
  if (!finiteBetween(zone.ndvi_max, 0, 1)) return true;
  if (zone.ndvi_min > zone.ndvi_mean || zone.ndvi_mean > zone.ndvi_max) return true;
  if (!finiteBetween(zone.ndvi_anomaly, -1, 1)) return true;
  if (!(ENVIRONMENT_CLASSES as readonly string[]).includes(zone.environment_class)) return true;
  if (zone.synthetic !== true) return true;
  if (zone.source_label !== VEGETATION_SOURCE_LABEL) return true;
  // The split is judged before it is read: a missing, null or non-object breakdown has
  // no shares at all, so no projection below can throw on it.
  if (!validBreakdown(zone.land_cover_breakdown)) return true;
  const shares = sharesOf(zone.land_cover_breakdown);
  if (shares.length !== LAND_COVER_KEYS.length) return true;
  const total = shares.reduce((sum, share) => sum + share.value, 0);
  return Math.abs(total - 100) >= BREAKDOWN_TOLERANCE;
}

// landCoverView answers what the page may say about one commune's layer entry. Three
// states exist because the page distinguishes them: the payload carried nothing, the
// payload carried a contradiction, and the payload carried a usable entry.
export function landCoverView(landCover: ZoneLandCover | null | undefined): LandCoverView {
  if (landCover === null || landCover === undefined) {
    return { kind: 'absent', reason: LAND_COVER_ABSENT_COPY };
  }
  if (violatesInvariants(landCover)) {
    return { kind: 'absent', reason: LAND_COVER_CONTRADICTORY_COPY };
  }
  const shares = sharesOf(landCover.land_cover_breakdown);
  const dominant = dominantShare(landCover.land_cover_breakdown);
  if (dominant === null) {
    return { kind: 'absent', reason: LAND_COVER_CONTRADICTORY_COPY };
  }
  const environment = ENVIRONMENT_CLASS_LABELS[landCover.environment_class];
  const ndviMean = landCover.ndvi_mean.toFixed(2);
  return {
    kind: 'present',
    zoneId: landCover.zone_id,
    zoneName: landCover.zone_name,
    environment,
    environmentClass: landCover.environment_class,
    ndviMean,
    ndviRange: `${landCover.ndvi_min.toFixed(2)}–${landCover.ndvi_max.toFixed(2)}`,
    ndviAnomaly: landCover.ndvi_anomaly.toFixed(2),
    dominant,
    shares,
    synthetic: LAND_COVER_BADGE,
    summary: `Cobertura de suelo (${LAND_COVER_BADGE}): entorno ${environment}; NDVI medio ${ndviMean} con rango ${landCover.ndvi_min.toFixed(2)}–${landCover.ndvi_max.toFixed(2)}; clase dominante ${dominant.label} (${dominant.percent}). No sustituye la variable escalar de cobertura vegetal de la regla.`,
  };
}

// One row of the sector table. The row is only built from an entry that survived
// `landCoverView`, so a contradiction is never printed as a plausible profile.
export interface SectorCoverageRow {
  zoneId: string;
  zoneName: string;
  environment: string;
  ndviMean: string;
  dominant: string;
  synthetic: string;
}

// sectorCoverageRows projects the whole catalogue in the order the service served it
// (ascending zone_id). A null catalogue -- not read yet, or failed -- yields no
// rows: the table then states the absence instead of showing invented comunas.
export function sectorCoverageRows(catalogue: VegetationCatalogue | null): SectorCoverageRow[] {
  if (catalogue === null) return [];
  const rows: SectorCoverageRow[] = [];
  for (const zone of catalogue.zones) {
    const view = landCoverView(zone);
    if (view.kind === 'absent') continue;
    rows.push({
      zoneId: view.zoneId,
      zoneName: view.zoneName,
      environment: view.environment,
      ndviMean: view.ndviMean,
      dominant: `${view.dominant.label} (${view.dominant.percent})`,
      synthetic: view.synthetic,
    });
  }
  return rows;
}

// The counts the territory summary states. They are read from the served rows, never
// from a target: the distribution is whatever the layer answered.
export function environmentDistribution(catalogue: VegetationCatalogue | null): Array<{
  environmentClass: EnvironmentClass;
  label: string;
  count: number;
}> {
  const counts = new Map<EnvironmentClass, number>();
  for (const environmentClass of ENVIRONMENT_CLASSES) counts.set(environmentClass, 0);
  if (catalogue !== null) {
    for (const zone of catalogue.zones) {
      if (landCoverView(zone).kind === 'absent') continue;
      counts.set(zone.environment_class, (counts.get(zone.environment_class) ?? 0) + 1);
    }
  }
  return ENVIRONMENT_CLASSES.map(environmentClass => ({
    environmentClass,
    label: ENVIRONMENT_CLASS_LABELS[environmentClass],
    count: counts.get(environmentClass) ?? 0,
  }));
}
