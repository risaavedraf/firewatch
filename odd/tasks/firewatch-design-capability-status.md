# FireWatch — prototype and product status

**Scope:** Gentle Design canvas only. Preserve product navigation, stable filenames/hashes, existing backend limitations, and unrelated work.
**Delivery:** Make the scope of the prototype clear without suggesting that a mockup implements a real service.

## Specs

- **S1.** «sigo viendo cosas marcadas como no implementadas, lo puedes arreglar?»
- **S2.** «El lienzo de diseño»

## Tasks

- **T1** — S1–S2 — Correct design status language, link evidenced mockups, regenerate dependent artboards and verify. Route: delegated bounded writer + independent and parent checks; verified; commit: pending shared navigation baseline.

## Log

- **L1.** «sigo viendo cosas marcadas como no implementadas, lo puedes arreglar?»
- **L2.** «El lienzo de diseño»
- **Design handoff for T1.** Rename the design-only inventory to «Prototipos y alcance» visibly (canvas title, local heading/nav, and generated current-page label); preserve `19-aun-no-implementado.html`, `#pendiente`, IDs and the existing internal-reference exclusion. Make each row explain separately what can be explored in the canvas and what is unavailable in the actual product. Link a prototype only when it exists and genuinely illustrates the stated capability; label partial demos as partial. If only the destination exists, say that instead. Keep the seven real limitations and distinguish a simulation from a real operation. Start with the canonical source, not generated clones; don't edit React/API. Keep the aerial style and all existing in-page anchors. Regenerate in a temporary faithful copy and only carry back the actual dependent output set after proving no unrelated drift. No changes to unrelated labels unless they make this same misleading claim and are within the named surfaces.
- **T1 evidence.** RED/GREEN checks confirmed the title, seven preserved limitations and seven prototype links. Independent verification confirmed all eight cross-board HTTP resolutions, local fragment targets and the shared navigation contract. Rows 5 and 6 were further clarified and both final copies fetched successfully from the live canvas. Catalog, navigation and whitespace checks passed. Only dependent artboards 14–19 were regenerated; the production frontend and API were not changed. No commit: the generated outputs and navigation map still overlap the earlier uncommitted navigation changes.
