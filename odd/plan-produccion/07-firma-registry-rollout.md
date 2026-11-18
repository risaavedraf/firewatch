# Frente 7 — Firma de imágenes, promoción de registry y rollout

- **Grupo de entrega:** G1 — Base de entrega.
- **Estado:** Pendiente — planificación. La CI construye con `--sbom=true --provenance=true` y escanea la imagen por servicio (`.github/workflows/_go-service.yml:49-63`); falta firma, promoción y despliegue productivo verificado. **El camino a producción está documentado y es manual; no hay producción:** `backend/deploy/k8s/DEPLOY-GKE.md` fija los digests en el overlay (§«Phase 3 — Pin the digests into the overlay», `:263-310`), aplica con `kubectl apply -k backend/deploy/k8s/overlays/delivery` (§«Phase 5 — Apply», `:542`) y rueda atrás por la lista de digests anteriores (§«Rollback», `:866-878`). Se enlaza sin acreditarlo: **no se ha ejecutado en GKE ni en ningún destino** (`DEPLOY-GKE.md:3`; `backend/deploy/k8s/README.md:230-232`). Lo observado es un `kind` local —trece pods `1/1 Running` y los dos Jobs `Complete` (`../tasks/k8s-delivery-closure.md:46`; `backend/deploy/k8s/README.md:5,244`)—, que no es evidencia del destino.
- **Riesgo (Task Size):** alto al implementar — ítem 5 (release/deploy/CI) e ítem 2 (claves de firma).
- **Depende de:** registry, identidad/llaves de firma, pipeline de promoción y clúster Kubernetes.
- **Seam / superficie:** CI/build de imágenes; registry; manifiestos Kubernetes (`backend/README.md:98`).

**Objetivo.** Establecer una cadena verificable de imágenes desde build/registry hasta despliegue Kubernetes, con rollback.

**Documentación real (redirección).**
- [`../../Referencias/Actividad C4_FireWatch_produccion.md:229-273`](<../../Referencias/Actividad C4_FireWatch_produccion.md>) — firma, promoción y rollout objetivo.
- [`../../backend/docs/architecture.md:57`](../../backend/docs/architecture.md) — ausencia de firma/promoción.
- [`../../backend/docs/verification.md:130,134`](../../backend/docs/verification.md) — estado de firma/rollout y de lo que la CI sí produce.
- [`../../backend/README.md:98`](../../backend/README.md) — base Kubernetes de staging.

## Specs

- **S1** — Las imágenes se firman y su firma se verifica **antes** de permitir promoción/despliegue.
- **S2** — La promoción entre registry/entornos está definida y automatizada.
- **S3** — El rollout en Kubernetes se automatiza y verifica resultado y rollback.
- **S4** — Se ejecuta verificación real del rollout y del comportamiento ante fallo.

## Tasks

| ID | Spec | Ruta | Descripción | Commit |
| --- | --- | --- | --- | --- |
| T1 | S1 | inline | Firmar imágenes y verificar firma en el pipeline. | — |
| T2 | S2 | inline | Definir y automatizar la promoción entre entornos. | — |
| T3 | S3 | inline | Automatizar rollout y verificar resultado/rollback. | — |
| T4 | S4 | inline | Ejecutar verificación real del rollout y del fallo. | — |

Ruta por defecto: **inline**; el rollout/Kubernetes (larga duración) puede delegarse por regla por-acción.

## Dependencias y bloqueos humanos

- **Bloqueo humano:** determinar registry, confianza/gestión de claves, entornos y política de promoción (las fuentes no fijan esos valores).
- Depende de la base Kubernetes; no fue desplegada como producción.

## Criterios de cierre

- `../../backend/docs/architecture.md:57` y `../../backend/docs/verification.md:134` (firma/promoción ausentes); `../../backend/docs/verification.md:130` (rollout no verificado).

## Log

- **L1 (2026-10-16)** — Creación del desglose por spec a partir de [`README.md`](README.md) §1 (frente 7). Documento de planificación; sin implementación.
- **L2 (2026-11-18) — Camino manual enlazado y reparto local/CI (H15 y H21 de la auditoría de producción).** (a) **H15:** el frente se leía como si la única vía fuera la automatización pendiente. No hay producción, pero **sí hay un camino documentado y manual**: `backend/deploy/k8s/DEPLOY-GKE.md` fija los cinco digests en el overlay (§«Phase 3 — Pin the digests into the overlay», `:263-310`), aplica con `kubectl apply -k backend/deploy/k8s/overlays/delivery` (§«Phase 5 — Apply», `:542`) y rueda atrás por la lista de digests anteriores con `pin-images.sh`, no con `kubectl rollout undo` (§«Rollback», `:866-878`). Se enlaza **sin acreditarlo**, con dos estados que no se pueden mezclar: el runbook **no se ha ejecutado en GKE ni en ningún destino** (`DEPLOY-GKE.md:3`, «Status: none of this has been executed»; `backend/deploy/k8s/README.md:230-232`), mientras que los manifiestos **sí** se observaron corriendo en un `kind` local —trece pods `1/1 Running` y los dos Jobs `Complete` (`../tasks/k8s-delivery-closure.md:46`), y el propio README dice que nada de esto corrió fuera de un `kind` local (`backend/deploy/k8s/README.md:5,244`)—. Ese `kind` prueba los manifiestos, no el destino, así que no es evidencia de S2/S4. (b) **H21:** la línea de estado decía «la CI ya produce SBOM/provenance» sin separar lo cableado de lo observado ni decir qué es local. Lo cableado: `docker build --sbom=true --provenance=true` y el scan de imagen por servicio (`.github/workflows/_go-service.yml:49-63`). Lo observado **a nivel de paso** son las corridas por servicio del 2026-10-14, con `Build container with provenance and SBOM` y `Scan runtime image` en success y sus IDs (`odd/tasks/security/ci-go-1.27.2-green.md:52,131`, resumido en `backend/docs/verification.md:134`); del refresh a 1.27.4 la PR #88 solo deja registrado el verde **por job** —`govulncheck` y los dos `compose`—, no la salida de cada paso (`backend/docs/verification.md:104-110`). Lo local: `pin-images.sh`, `tests/pin-images-contract.sh` y `tests/render-contract.sh` — ningún workflow los invoca (`.github/workflows/` no los nombra) — y la firma, la promoción y la verificación de rollout que pide S1-S4, que no existen en ninguna de las dos formas. **Reparación de cita en la misma pasada:** el documento apuntaba a `backend/docs/verification.md:62-68` para firma/rollout y a `:64`/`:68` en los criterios; esas líneas pasaron a ser la tabla de checks de Go 1.27.3, y lo que se busca está en `:130` (rollout) y `:134` (publicación, firma y promoción), reapuntadas arriba. Las líneas `:19-22` que otros documentos citan quedan intactas porque todo se añade a este Log.
