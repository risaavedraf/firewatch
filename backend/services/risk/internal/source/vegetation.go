package source

import (
	"fmt"
	"hash/fnv"
	"math"
	"sort"
	"sync"

	"firewatch.local/contracts/geo"
	"firewatch.local/risk/internal/zones"
)

// VegetationSourceLabel is the declared origin of the embedded land-cover layer
// (PM-12). It is repeated on every entry and in the UI badge, so a reader can tell
// the demo seed from an ingested satellite product.
//
// The layer is COMPLEMENTARY and does not replace anything: `cobertura_vegetal`
// stays the scalar variable of the five canonical rule inputs. Nothing in this
// file feeds the classifier.
const VegetationSourceLabel = "SINTETICO_SEED_V1"

// EnvironmentClass is the closed four-value scale of the ratified PM-12 decision.
type EnvironmentClass string

const (
	// EnvironmentWUIAlta is a commune where settlement meets burnable vegetation.
	EnvironmentWUIAlta EnvironmentClass = "WUI_ALTA"
	// EnvironmentForestalDenso is a commune dominated by continuous forest cover.
	EnvironmentForestalDenso EnvironmentClass = "FORESTAL_DENSO"
	// EnvironmentMixtoRural is a commune of scrub, pasture and scattered woodland.
	EnvironmentMixtoRural EnvironmentClass = "MIXTO_RURAL"
	// EnvironmentPeriurbano is a commune where built-up land is the dominant class.
	EnvironmentPeriurbano EnvironmentClass = "PERIURBANO"
)

// EnvironmentClasses returns the frozen vocabulary in the order the decision
// fixes it. It is a fresh slice: a caller cannot reorder the published scale.
func EnvironmentClasses() []EnvironmentClass {
	return []EnvironmentClass{
		EnvironmentWUIAlta,
		EnvironmentForestalDenso,
		EnvironmentMixtoRural,
		EnvironmentPeriurbano,
	}
}

// LandCoverBreakdown is the five-class percentage split of one commune. The five
// members are exactly the ones the decision names, each in 0..100, and they always
// sum to 100 because the generator works in whole points.
type LandCoverBreakdown struct {
	BosqueNativoPct           float64 `json:"bosque_nativo_pct"`
	PlantacionForestalPct     float64 `json:"plantacion_forestal_pct"`
	MatorralPastizalPct       float64 `json:"matorral_pastizal_pct"`
	InterfazUrbanoForestalPct float64 `json:"interfaz_urbano_forestal_pct"`
	SueloDesnudoAguaPct       float64 `json:"suelo_desnudo_agua_pct"`
}

// ZoneLandCover is one commune of the layer: its NDVI block, its land-cover split,
// its environment class and the declared provenance.
//
// `NDVIMin <= NDVIMean <= NDVIMax` always holds, every NDVI value is a whole
// hundredth inside 0.00..1.00, and `NDVIAnomaly` is a whole hundredth inside
// -1.00..1.00. The values are generated in hundredths and divided by 100, so a
// rounding step cannot break the ordering the client revalidates.
type ZoneLandCover struct {
	ZoneID             string             `json:"zone_id"`
	ZoneName           string             `json:"zone_name"`
	NDVIMean           float64            `json:"ndvi_mean"`
	NDVIMin            float64            `json:"ndvi_min"`
	NDVIMax            float64            `json:"ndvi_max"`
	NDVIAnomaly        float64            `json:"ndvi_anomaly"`
	LandCoverBreakdown LandCoverBreakdown `json:"land_cover_breakdown"`
	EnvironmentClass   EnvironmentClass   `json:"environment_class"`
	// Synthetic is always true: the seed is declared, never presented as an
	// observation.
	Synthetic bool `json:"synthetic"`
	// SourceLabel repeats the catalogue's declared origin per entry, so a row of
	// the sector table can state its provenance without a second read.
	SourceLabel string `json:"source_label"`
}

// VegetationCatalogue is the frozen response body of GET /v1/risk/vegetation: the
// declared origin and the 38 catalogue comunas in ascending zone_id order.
type VegetationCatalogue struct {
	Source string          `json:"source"`
	Zones  []ZoneLandCover `json:"zones"`
}

// landCoverProfile is one environment class with the whole-point split it starts
// from. Every row sums to 100, so the generator only has to keep the total.
type landCoverProfile struct {
	class EnvironmentClass
	base  [5]float64
}

// vegetationProfiles is the frozen seed vocabulary. A profile is chosen by the
// commune's stable digest, never at random and never from the clock.
var vegetationProfiles = [4]landCoverProfile{
	{class: EnvironmentWUIAlta, base: [5]float64{12, 8, 32, 38, 10}},
	{class: EnvironmentForestalDenso, base: [5]float64{52, 22, 16, 4, 6}},
	{class: EnvironmentMixtoRural, base: [5]float64{18, 16, 42, 9, 15}},
	{class: EnvironmentPeriurbano, base: [5]float64{10, 10, 18, 44, 18}},
}

// The NDVI contribution of each land-cover class, in percentage points of NDVI:
// dense forest reflects the most vegetation, bare soil and water the least. The
// weights are the seed's own arithmetic, not a calibrated model.
var vegetationNDVIWeights = [5]float64{0.90, 0.78, 0.62, 0.45, 0.12}

// vegetationCatalogue caches the built body. It is computed once per process: the
// embedded asset cannot change at runtime, and building it per request would parse
// the commune geometry on every read.
var vegetationCatalogue = sync.OnceValues(func() (VegetationCatalogue, error) {
	seeded, err := zones.ParseComunas(geo.ComunasGeoJSON)
	if err != nil {
		return VegetationCatalogue{}, fmt.Errorf("seed the land-cover catalogue: %w", err)
	}
	return buildVegetationCatalogue(seeded), nil
})

// vegetationIndex caches the per-commune lookup the batch reads use to attach
// `land_cover`. An unreadable asset yields an empty index instead of an invented
// entry, so those reads then serve their batch without the member.
var vegetationIndex = sync.OnceValue(func() map[string]ZoneLandCover {
	catalogue, err := SyntheticVegetation()
	if err != nil {
		return map[string]ZoneLandCover{}
	}
	index := make(map[string]ZoneLandCover, len(catalogue.Zones))
	for _, zone := range catalogue.Zones {
		index[zone.ZoneID] = zone
	}
	return index
})

// SyntheticVegetation returns the embedded land-cover layer for the PM-12 demo. It
// reads no database, broker or external service, and it is deterministic: two runs
// serialise to the same bytes.
//
// The returned body is shared between callers and must be treated as read-only.
func SyntheticVegetation() (VegetationCatalogue, error) {
	return vegetationCatalogue()
}

// VegetationZone answers one commune's declared land cover. The second return value
// is false for a zone the catalogue does not declare -- the legacy
// `valparaiso-demo` row, for instance -- so a caller omits the member instead of
// serving a zeroed block.
func VegetationZone(zoneID string) (ZoneLandCover, bool) {
	zone, ok := vegetationIndex()[zoneID]
	return zone, ok
}

// buildVegetationCatalogue derives one entry per seeded commune. It is the pure
// half of the builder: no clock, no randomness and no storage.
func buildVegetationCatalogue(seeded []zones.Zone) VegetationCatalogue {
	entries := make([]ZoneLandCover, 0, len(seeded))
	for _, zone := range seeded {
		entries = append(entries, newZoneLandCover(zone))
	}
	// The documented order is ascending zone_id: the sector table can be rendered
	// without sorting, and two runs cannot disagree on the row order.
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].ZoneID < entries[j].ZoneID })
	return VegetationCatalogue{Source: VegetationSourceLabel, Zones: entries}
}

// newZoneLandCover derives one commune's whole profile from its own code.
func newZoneLandCover(zone zones.Zone) ZoneLandCover {
	digest := communeDigest(zone.Code)
	profile := vegetationProfiles[int(digest%uint64(len(vegetationProfiles)))]
	breakdown := spreadBreakdown(profile.base, digest)
	meanHundredths := ndviMeanHundredths(breakdown)
	return ZoneLandCover{
		ZoneID:             zone.Code,
		ZoneName:           zone.Name,
		NDVIMean:           meanHundredths / 100,
		NDVIMin:            math.Max(0, meanHundredths-(4+float64(digest%7))) / 100,
		NDVIMax:            math.Min(100, meanHundredths+(4+float64((digest/11)%7))) / 100,
		NDVIAnomaly:        float64(int64((digest/13)%41)-20) / 100,
		LandCoverBreakdown: breakdown,
		EnvironmentClass:   profile.class,
		Synthetic:          true,
		SourceLabel:        VegetationSourceLabel,
	}
}

// communeDigest is the stable FNV-1a hash of the commune code. It replaces a
// random source and a clock: the same code always yields the same profile.
func communeDigest(code string) uint64 {
	hasher := fnv.New64a()
	_, _ = hasher.Write([]byte(code))
	return hasher.Sum64()
}

// spreadBreakdown moves one to three points between two of the profile's classes.
// The total is preserved by construction, so the five percentages always sum to
// exactly 100 and no class can leave 0..100.
func spreadBreakdown(base [5]float64, digest uint64) LandCoverBreakdown {
	points := base
	from := int((digest / 3) % 5)
	to := int((digest / 7) % 5)
	shift := float64(1 + digest%3)
	if from != to && points[from]-shift >= 0 {
		points[from] -= shift
		points[to] += shift
	}
	return LandCoverBreakdown{
		BosqueNativoPct:           points[0],
		PlantacionForestalPct:     points[1],
		MatorralPastizalPct:       points[2],
		InterfazUrbanoForestalPct: points[3],
		SueloDesnudoAguaPct:       points[4],
	}
}

// ndviMeanHundredths is the weighted vegetation share of the profile, in whole
// hundredths of NDVI. Arithmetic on the served split, so the mean can always be
// re-derived from the percentages a reader sees.
func ndviMeanHundredths(breakdown LandCoverBreakdown) float64 {
	shares := [5]float64{
		breakdown.BosqueNativoPct,
		breakdown.PlantacionForestalPct,
		breakdown.MatorralPastizalPct,
		breakdown.InterfazUrbanoForestalPct,
		breakdown.SueloDesnudoAguaPct,
	}
	weighted := 0.0
	for index, share := range shares {
		weighted += vegetationNDVIWeights[index] * share
	}
	return math.Round(weighted)
}
