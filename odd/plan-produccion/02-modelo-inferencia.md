# Frente 2 — Servicio real de inferencia y modelo aprobado

- **Grupo de entrega:** G2 — Núcleo de datos y modelo (solo el *seam*).
- **Estado:** Parcial — el clasificador por defecto `academic-rule-v1` quedó entregado en la presentación (modelo v2). El servicio de inferencia está **cableado**: tiene Deployment propio (`../../backend/deploy/k8s/base/inference.yaml`) y `risk` lo alcanza por `INFERENCE_URL` (`../../backend/deploy/k8s/base/config.yaml:31`), cuya presencia es la que registra el clasificador de modelo. El registro de modelos es una ruta real y admin-only para escribir: `GET /v1/models` lista y `POST /v1/models/{version}/activate` activa (`backend/services/risk/internal/handler/api.go:104-105`), y desde una activación la versión activada gana sobre la del arranque en cada réplica (`backend/services/risk/internal/service/classifier_source.go:54-64`); lo que `inference` sirve como vocabulario del artefacto es `GET /v1/model`, leído una vez por proceso (`backend/services/risk/internal/classify/inference.go:156,204`). Lo que sigue pendiente es el modelo **entrenado y aprobado** y su evidencia de producción (pendiente permitido). **El artefacto que monta el despliegue es un fixture del repositorio, no un modelo aprobado:** `backend/deploy/k8s/base/inference.yaml:20-34,70-71` monta el ConfigMap `inference-model` y `backend/deploy/k8s/bootstrap-secrets.sh:318-323,329` lo renderiza byte a byte desde `backend/services/inference/testdata/logistic.json`, el mismo archivo que monta Compose (`backend/docker-compose.yml:201`). El ensayo del entrenamiento (`delivered-data-rehearsal-v1`) es otra cosa y no debe registrarse ni activarse (`backend/training/REPORT-delivered-data.md:74-90`).
- **Riesgo (Task Size):** alto al implementar — ítem 1 (versión/procedencia persistida) e ítem 3 (contratos `Classifier`/`Provider`).
- **Depende de:** frente 1 (observaciones); disponibilidad de modelo y política de aprobación (decisión humana).
- **Seam / superficie:** `backend/services/risk/internal/classify/` (`classifier.go`, `academic_rule.go`); interfaces `Classifier`/`Provider`; persistencia `models` y publicación de lotes.

**Objetivo.** Sustituir la regla académica por inferencia con un modelo aprobado, trazable y utilizable en producción, dejando la frontera `Classifier` estable.

**Documentación real (redirección).**
- [`../../Referencias/EP1_Equipo3_Armijo_Calderon_Saavedra2_produccion.md:30,46-56,80`](../../Referencias/EP1_Equipo3_Armijo_Calderon_Saavedra2_produccion.md) — contrato `Provider`/`Classifier`, metadatos y aprobación.
- [`../../Referencias/Actividad C4_FireWatch_produccion.md:59-65,79-91,171-199,247-248`](<../../Referencias/Actividad C4_FireWatch_produccion.md>) — operación objetivo.
- [`../tasks/backend/firewatch-data-contract.md:18-23,68`](../tasks/backend/firewatch-data-contract.md) — define `academic-rule-v1`; los datos sintéticos no son un modelo validado.
- [`../../backend/docs/verification.md:131`](../../backend/docs/verification.md) — límite declarado.

## Specs

- **S1** — La inferencia consume un modelo **aprobado** y rechaza entradas incompletas o inválidas.
- **S2** — Cada resultado se persiste con zona, período, fecha, **versión del modelo** y datos/procedencia utilizados.
- **S3** — Existe un procedimiento para aprobar o **revertir** versiones de modelo antes de producción.
- **S4** — La frontera `Classifier`/`Provider` queda congelada con una implementación por defecto (regla académica) determinista para las suites actuales.

## Tasks

| ID | Spec | Ruta | Descripción | Commit |
| --- | --- | --- | --- | --- |
| T1 | S4 | inline | Congelar interfaces `Classifier`/`Provider` y la implementación por defecto `academic-rule-v1`. | — |
| T2 | S1 | inline | Definir el contrato de entrada y el rechazo de observaciones incompletas/inválidas. | — |
| T3 | S2 | inline | Persistir cada resultado con zona, período, fecha, versión de modelo y procedencia. | — |
| T4 | S3 | inline | Definir y documentar el procedimiento de aprobación/reversión de versiones. | — |
| T5 | S1,S4 | inline | *Seam* de sustitución del modelo real sin tocar el resto del sistema. | — |
| T6 | S4 | inline | Prueba de sustitución: cambiar el clasificador por configuración y demostrar que ningún archivo fuera de `backend/services/risk/internal/classify/` cambia. | — |

Ruta por defecto: **inline** (seam + fixtures). La sustitución real del modelo queda **fuera** de este frente.

## Dependencias y bloqueos humanos

- Aprobar modelo, métricas/umbrales y reglas de reversión (bloqueo humano): las fuentes exigen aprobación admin, pero no fijan esos umbrales.
- Depende del frente 1 para observaciones reales.

## Criterios de cierre

- Metadatos y aprobación: `../../Referencias/EP1_Equipo3_Armijo_Calderon_Saavedra2_produccion.md:54-56`.
- La prueba de sustitución (T6) pasa sin cambios fuera de `backend/services/risk/internal/classify/`, y `academic-rule-v1` sigue siendo determinista.
- `../../backend/docs/verification.md:131` no establece la inferencia real ni la precisión/calibración: el cableado existe, el modelo aprobado y la evidencia de producción no. No marcar cierre sin esos dos.

## Log

- **L1 (2026-10-16)** — Creación del desglose por spec a partir de [`README.md`](README.md) §1 (frente 2). Documento de planificación; sin implementación.
- **L2 (2026-10-20)** — Estado corregido a Parcial: `academic-rule-v1` entregado (modelo v2); el modelo entrenado sigue pendiente por decisión (README §1 y §7).
- **L3 (2026-10-20)** — Se agrega T6 (prueba de sustitución) y su criterio de cierre; el frente puede completarse sin modelo real según README §5.1.
- **L4 (2026-11-17)** — Estado precisado: el servicio está cableado (`base/inference.yaml`; `risk` lo alcanza por `INFERENCE_URL`, `base/config.yaml:31`) y lo pendiente es el modelo entrenado y aprobado y su evidencia de producción. La cita de cierre apunta a `backend/docs/verification.md:101` (límite de esos checks), no a `:65`.
- **L5 (2026-11-18) — Registro de modelos, activación y artefacto montado (H17 de la auditoría de producción).** El documento decía que «el artefacto del repositorio es un ensayo no servible», y eso mezcla dos artefactos distintos. El que monta el despliegue es un **fixture**: `backend/deploy/k8s/base/inference.yaml:20-34,70-71` monta el ConfigMap `inference-model`, renderizado byte a byte desde `backend/services/inference/testdata/logistic.json` (`backend/deploy/k8s/bootstrap-secrets.sh:318-323,329`; el mismo archivo de Compose, `backend/docker-compose.yml:201`), y sí es servible por `inference`. El **ensayo** del entrenamiento (`delivered-data-rehearsal-v1`) es el que no se puede servir ni registrar (`backend/training/REPORT-delivered-data.md:74-90`). Además faltaba la superficie de registro y activación: `GET /v1/models` y `POST /v1/models/{version}/activate`, admin-only al escribir (`backend/services/risk/internal/handler/api.go:104-105`), con la versión activada ganando sobre la del arranque en cada réplica (`backend/services/risk/internal/service/classifier_source.go:54-64`) y el documento `GET /v1/model` leído una vez por proceso (`backend/services/risk/internal/classify/inference.go:156,204`). **Reparación de cita en la misma pasada:** `backend/docs/verification.md:101` quedó en blanco tras la actualización del 2026-11-18; el límite que este frente cita está en `:131`, y las dos referencias se reapuntaron ahí.
