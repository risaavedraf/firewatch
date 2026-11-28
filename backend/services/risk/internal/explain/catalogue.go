package explain

import (
	"sort"
	"sync"

	"firewatch.local/contracts/geo"
	"firewatch.local/risk/internal/zones"
)

// Catalogue is the closed set of communes this assistant answers about: the 38
// communes of the Valparaíso region that the zones package already parses from the
// versioned geographic asset.
//
// It exists so GRD-I1 can decide membership without a storage read. The data is
// still the single source the migrate path uses: writing the 38 CUT codes into Go
// would create the second source for one datum that the zones migration avoids on
// purpose, and a new commune would then need two edits.
type Catalogue struct {
	names map[string]string
	codes []string
}

var (
	catalogueOnce  sync.Once
	catalogueValue Catalogue
	catalogueErr   error
)

// DefaultCatalogue returns the commune catalogue parsed from the embedded asset.
//
// It is parsed once per process: the asset is compiled in, so a second parse would
// only add work to a request. A malformed asset is returned as an error instead of
// an empty catalogue, because an empty catalogue would refuse every zone and hide
// a build defect behind an ordinary scope refusal.
func DefaultCatalogue() (Catalogue, error) {
	catalogueOnce.Do(func() {
		parsed, err := zones.ParseComunas(geo.ComunasGeoJSON)
		if err != nil {
			catalogueErr = err
			return
		}
		catalogueValue = newCatalogue(parsed)
	})
	return catalogueValue, catalogueErr
}

// newCatalogue indexes the parsed communes by their CUT code.
func newCatalogue(communes []zones.Zone) Catalogue {
	names := make(map[string]string, len(communes))
	codes := make([]string, 0, len(communes))
	for _, commune := range communes {
		names[commune.Code] = commune.Name
		codes = append(codes, commune.Code)
	}
	sort.Strings(codes)
	return Catalogue{names: names, codes: codes}
}

// ZoneName reports the catalogue name of a commune code. A code the catalogue does
// not hold is simply absent: it is not an error, and the caller must refuse it
// rather than invent a name for it.
func (c Catalogue) ZoneName(code string) (string, bool) {
	name, ok := c.names[code]
	return name, ok
}

// Codes returns the accepted commune codes in ascending order. The slice is a
// copy, so a caller cannot mutate the catalogue.
func (c Catalogue) Codes() []string {
	ordered := make([]string, len(c.codes))
	copy(ordered, c.codes)
	return ordered
}
