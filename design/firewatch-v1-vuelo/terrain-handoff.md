# Regional aerial map: real terrain at each scale

Keep the full-screen aerial experience from the [original artboard](01-vista-aerea.html) and the regional framing, grouped urban footprint and risk styles from the [regional variant](02-vista-regional.html). For the future system, realistic means **elevation and land cover supported by sources**, not photorealistic textures. The artboards still use schematic relief, urban footprints and risk readings.

## What changes as you zoom

| View | What to show |
| --- | --- |
| **Region** | Read the coastline, main ridges and visible changes in elevation. Use muted relief, subtle administrative boundaries and simplified urban footprints. Keep territorial risk independently toggleable. |
| **Local sector** | Reveal terrain relief, hills and ravines only to the detail supported by the source. Show mapped forest, scrub, grassland and urban cover with a separate legend. Never infer forest cover from the terrain shading. |
| **Island or archipelago** | Use the insets as navigation, not as the only representation. Opening Rapa Nui or Juan Fernández should center its own map and offer the same aerial and overhead views, zoom, terrain and vegetation layers. Return to the regional view without losing the selected date. |

Use progressive detail and load map tiles for the current area and zoom rather than drawing the entire region at maximum detail. A grouped urban footprint is the default at regional distance; add detail only if useful and supported. This is a design recommendation, not a measured performance claim.

## Keep the layers independent

- **Elevation.** Prefer a bare-earth digital terrain model when available at suitable resolution. [Copernicus DEM GLO-30](https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM) is a candidate for regional context: its nominal spacing is about 30 m, and it measures the surface, which can include buildings and vegetation. Check actual tile coverage and quality on the mainland and for each island before selecting it. Do not imply a ravine or a slope is more precisely mapped just because the camera can zoom in.
- **Vegetation and land use.** CONAF's [regional land-use monitoring](https://www.conaf.cl/conaf-incluyo-por-primera-vez-al-territorio-insular-en-estudio-sobre-usos-de-suelo/) included the continental region, Rapa Nui and Juan Fernández. Check the available layers, their dates, scale and coverage independently of elevation. Land-use classes are not live fuel readings.
- **Risk.** Keep the existing sector and shared-cutoff behavior. Risk and land-cover colors use separate legends; show synthetic readings and missing coverage explicitly. Real geography does not make the synthetic risk layer an assessment.

## Check before a production handoff

On the mainland, Rapa Nui and Juan Fernández, compare a known ridgeline and a recognizable low area against the underlying elevation source; check that opening an inset reveals its own navigable map. Record source, date, resolution, attribution and missing coverage by layer. The [geospatial provenance plan](../../odd/plan-produccion/15-procedencia-geoespacial.md) governs the current boundary source and its DIFROL review requirement for publication. No data or production pipeline has been added by this design handoff.
