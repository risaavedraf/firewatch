# FireWatch

Two parts, deliberately separate:

- [`backend/`](backend/README.md) — the executable slice: authenticated job submission, asynchronous processing through RabbitMQ, a 15-minute ingestion cycle with per-record validation, synthetic PostGIS batch publication, preventive actions, model-version activation, history, audit and Prometheus metrics.
- [`frontend/`](frontend/README.md) — the browser page, served on its own origin and calling the backend API.

## Running the local demonstration

```sh
cd backend
python scripts/init_env.py
docker compose up -d --build
python scripts/smoke.py
```

That starts the API on `http://localhost:8080`. It does **not** open a web page: the gateway is API only and answers `404` on `/`. Start the page separately — it is a Vite build, so it must be built before it is served — and open `http://localhost:4173`:

```sh
cd frontend
npm install
npm run build   # serve.mjs serves dist/, so build first
npm run serve
```

Open it as `localhost`, never as `127.0.0.1`. The identity provider and the gateway both have the `localhost:4173` origin registered, and a browser treats the two spellings as different origins.

## Documentation

- [Backend: run, API walkthrough and limits](backend/README.md#quick-start)
- [Frontend: the page and how to run it](frontend/README.md)
- [Architecture and delivery boundaries](backend/docs/architecture.md)
- [HTTP contract](backend/contracts/openapi/firewatch-v1.yaml)
- [Keycloak realm setup for the separated frontend](backend/docs/keycloak-realm-setup.md)
- [Kubernetes deployment base](backend/deploy/k8s/README.md)
- [Pitch demo on one VM: the VM deployment path](backend/deploy/k8s/overlays/pitch/README.md)
- [Original project references](Referencias/)

The current backend uses demonstration data only. It does not estimate real wildfire risk.

**Delivery status (2026-10-18).** The presentation delivery landed on `main` at `f509666` (PR #31, issue #30): ingestion cycle, model v2, preventive actions and browser login. The local monitoring wave followed in PRs #33–#35, so the current `main` baseline is `ef686c0` (the PR #41 merge). The trained model and real data sources are still pending. See the [documentation map](odd/README.md) for where each state lives, and the [task index](odd/tasks/README.md) for the delivered/missing state and its limits.

## Geospatial provenance and DIFROL restriction

The boundary cartography served by the risk service is the 38 communes of Valparaiso from the official DPA layer of MOP/IDE Chile. Its row of the traceability table is the versioned artifact [`backend/contracts/gen/geo/valparaiso-comunas.provenance.json`](backend/contracts/gen/geo/valparaiso-comunas.provenance.json), written by [`backend/scripts/fetch_comunas.py`](backend/scripts/fetch_comunas.py); the derived product is [`backend/contracts/gen/geo/valparaiso-comunas.geojson`](backend/contracts/gen/geo/valparaiso-comunas.geojson). A regression test fails if this section and that artifact stop matching.

| Field | Value |
| --- | --- |
| `provider` | `MOP - IDE Chile (SERVICIO_DPA, capa Comunas)` |
| `endpoint` | `https://rest-sit.mop.gob.cl/arcgis/rest/services/INTEROP/SERVICIO_DPA/MapServer/1/query?where=CUT_REG%3D%2705%27&outFields=CUT_COM,COMUNA,PROVINCIA,CUT_PROV&returnGeometry=true&outSR=4326&f=json` |
| `query_sha256` | `9bef5bd58006f9053c3d6603b622a0064f721cd33213e10fe8619adf324b4a4f` |
| `retrieved_at` | `2026-10-11T18:42:42+00:00` |
| `cutoff_at` | `2026-10-11T18:42:42+00:00` |
| `source_format` | `Esri JSON` |
| `derived_format` | `GeoJSON (RFC 7946)` |
| `attribution` | `Subsecretaria de Desarrollo Regional y Administrativo (SUBDERE), Instituto Geografico Militar (IGM) e Instituto Nacional de Estadisticas (INE)` |
| `restriction` | `las publicaciones y productos derivados de esta cartografia deben ser revisadas y validadas por DIFROL.` |
| `restriction_source` | `Metadatos del servicio INTEROP/SERVICIO_DPA, capa Comunas (MapServer/1) de IDE Chile: https://rest-sit.mop.gob.cl/arcgis/rest/services/INTEROP/SERVICIO_DPA/MapServer/1?f=json` |

The service publishes no cutoff date: `cutoff_at` is set identical to `retrieved_at` and no other value is estimated.

Attribution, verbatim from the service metadata: «Subsecretaria de Desarrollo Regional y Administrativo (SUBDERE), Instituto Geografico Militar (IGM) e Instituto Nacional de Estadisticas (INE)».

Restriction, verbatim from the service metadata: «las publicaciones y productos derivados de esta cartografia deben ser revisadas y validadas por DIFROL.»

Restriction source, the metadata record that carries it: «Metadatos del servicio INTEROP/SERVICIO_DPA, capa Comunas (MapServer/1) de IDE Chile: https://rest-sit.mop.gob.cl/arcgis/rest/services/INTEROP/SERVICIO_DPA/MapServer/1?f=json».

No external DIFROL authority review or validation is claimed. The communal boundary map is a derived product, so DIFROL review and validation remains an external condition for production; until that record exists, the cartography is declared **not validated**.
