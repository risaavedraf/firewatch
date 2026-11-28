# Frente 15 — Procedencia geoespacial (restricción DIFROL)

- **Grupo de entrega:** G5 — Producto y cierre.
- **Estado:** Parcial — procedencia registrada y restricción DIFROL declarada en tabla y README; la validación DIFROL del producto derivado sigue pendiente. La cartografía **no está validada**.
- **Riesgo (Task Size):** alto al implementar — ítem 1 (trazabilidad/procedencia persistida) e ítem 3 (producto que se publica/consume).
- **Depende de:** datos y metadatos del servicio geoespacial; revisión/validación DIFROL como condición de producción.
- **Seam / superficie:** `backend/contracts/gen/geo/` (procedencia y derivado versionados), `backend/scripts/fetch_comunas.py`, `backend/services/risk/internal/handler/sources.go` y README.

**Objetivo.** Registrar procedencia y declarar la restricción DIFROL para la cartografía derivada antes de asumir la fuente lista para producción.

**Documentación real (redirección).**
- [`../tasks/backend/firewatch-geospatial-map.md:21-32,34-40`](../tasks/backend/firewatch-geospatial-map.md) — trazabilidad y restricción DIFROL.

## Specs

- **S1** — Se registra la primera fila real de trazabilidad con endpoint, huella de consulta, `retrieved_at`, `cutoff_at` y formatos de origen/derivado.
- **S2** — Se registra atribución a SUBDERE, IGM e INE según metadatos del servicio.
- **S3** — Se declara **textualmente** en la tabla y el README que los productos derivados deben revisarse y validarse por DIFROL.
- **S4** — Se mantiene el límite de procedencia: la cartografía no está validada; el mapa comunal cuenta como producto derivado.

## Tasks

| ID | Spec | Ruta | Descripción | Commit |
| --- | --- | --- | --- | --- |
| T1 | S1 | inline | Registrar la fila real de trazabilidad (endpoint, huella, `retrieved_at`, `cutoff_at`, formatos). | `backend/contracts/gen/geo/valparaiso-comunas.provenance.json:4-11` |
| T2 | S2 | inline | Registrar atribución SUBDERE/IGM/INE. | mismo artefacto, `attribution` (`:21`) |
| T3 | S3 | inline | Declarar la restricción DIFROL en tabla y README. | restricción en el artefacto (`:22`) y declarada en [`README.md`](../../README.md#geospatial-provenance-and-difrol-restriction) con prueba de alineación en `TestProvenance` (sin modificar el descargador); commit `8c9a444` |

Ruta por defecto: **inline** (trabajo documental acotado).

## Dependencias y bloqueos humanos

- **Bloqueo humano:** determinar cómo se obtiene y acredita la revisión/validación DIFROL antes de producción; **no afirmar que ya existe**.

## Criterios de cierre

- Procedencia completa y restricción declarada en tabla y README: `../tasks/backend/firewatch-geospatial-map.md:27-32`.

## Log

- **L1 (2026-10-16)** — Creación del desglose por spec a partir de [`README.md`](README.md) §1 (frente 15). Documento de planificación; sin implementación.
- **L2 (2026-11-18) — Estado corregido a Parcial (H10 de la auditoría de despliegue).** El frente decía «Pendiente — planificación» y apuntaba la procedencia a `data/trazabilidad/`, una ruta que no existe en el árbol: la fila real está registrada y versionada en `backend/contracts/gen/geo/valparaiso-comunas.provenance.json:4-11` (endpoint, `query_sha256`, `retrieved_at`, `cutoff_at`, formatos de origen y derivado), con la atribución en `:21` y la restricción DIFROL en `:22`. La escribe `backend/scripts/fetch_comunas.py:32-33`, la embebe `backend/contracts/gen/geo/geo.go:19,24` y la sirve `backend/services/risk/internal/handler/sources.go:93`. Lo que sigue abierto es la validación DIFROL del producto derivado (el mapa comunal) y la declaración textual de la restricción en el README; la cartografía **no** se declara validada.
- **L3 (2026-11-27) — T3 cerrado en su parte declarativa: README alineado y fijado por prueba.** [`README.md`](../../README.md#geospatial-provenance-and-difrol-restriction) gana la sección «Geospatial provenance and DIFROL restriction» con la tabla de procedencia copiada del artefacto (provider, endpoint, `query_sha256`, `retrieved_at`, `cutoff_at`, formato de origen y derivado) y repite **verbatim** la atribución SUBDERE/IGM/INE, la restricción DIFROL y su `restriction_source`, las tres dentro de comillas «…» en la prosa. `backend/scripts/test_fetch_comunas.py` fija la alineación en `TestProvenance`: parsea la tabla del README fila por fila y exige el valor exacto de cada uno de los diez campos en su propia fila, compara los tres spans «…» de la prosa byte a byte, recalcula el `query_sha256` con `hashlib.sha256(fetch_comunas.QUERY_URL)` en la propia prueba y **falla cerrado** ante etiquetas de fila duplicadas, filas inesperadas, marcadores o spans de prosa repetidos o ambiguos, y tablas mal formadas: exige un único bloque contiguo de líneas con `|`, sin líneas con pipe fuera de él, con cabecera y separador de exactamente dos celdas y filas de cuerpo que empiezan y terminan con `|` y tienen exactamente dos celdas. `backend/scripts/fetch_comunas.py` **no se modifica**. Ciclo observado: RED 9 fallos / 21 pasados (exit 1) contra el chequeo laxo anterior, que aceptaba las mutaciones de `provider`, el intercambio de formatos y la mutación de solo `cutoff_at` devolviendo `[]`; segundo RED 4 fallos / 30 pasados (exit 1) al añadir las mutaciones de fila duplicada contradictoria, fila extra y prosa repetida, que el parser anterior aceptaba o solo etiquetaba de forma genérica; tercer RED 7 fallos / 34 pasados (exit 1) al añadir las mutaciones estructurales (fila de 3 celdas, fila de 1 celda, línea con pipe sin cerrar, segunda tabla, pipe fuera de la tabla, cabecera y separador mal formados), que el parser anterior saltaba en silencio; GREEN 41/41 (exit 0) con el chequeo fila a fila, los spans delimitados y el bloque de tabla estricto, en `unittest` y `pytest`. El límite no cambia: la revisión y validación por DIFROL del producto derivado es una condición externa, el README declara que **no se afirma que exista** y la cartografía sigue **no validada**; commit `8c9a444`.
