# Frente 13 — Go/No-Go y firma de aprobación de producción

- **Grupo de entrega:** No cierra esta semana — **bloqueado por los dos pendientes permitidos** (datos reales + modelo).
- **Estado:** **Bloqueado para acreditar** — planificación. El historial, la matriz y los criterios pueden prepararse; la decisión y la firma no.
- **Riesgo (Task Size):** alto — ítem 6 (no se declara aprobación sin evidencia reproducible).
- **Depende de:** evidencia de datos y modelo, reportes de infraestructura y criterios acordados.
- **Seam / superficie:** matriz Go/No-Go, reportes enlazados y registro de versiones.

**Objetivo.** Registrar una decisión de producción basada en evidencia y **firmada** por el responsable. **Se prepara como plan, no como resultado.**

**Documentación real (redirección).**
- [`../urgent/05-ct-aprobacion-demo.md:3-23`](../urgent/05-ct-aprobacion-demo.md) — matriz y firma.
- [`../../Referencias/tareas_verificacion_implementacion_IA.md:457-476`](../../Referencias/tareas_verificacion_implementacion_IA.md) — criterios por ID.

## Specs

- **S1** — Existe historial de versiones y matriz de pruebas con criterio, evidencia y resultado.
- **S2** — Se registran versiones, resultados y verificaciones de datos, modelo e infraestructura.
- **S3** — La decisión de despliegue se documenta como **APROBADO PARA PRODUCCIÓN** o **RECHAZADO**.
- **S4** — Se obtiene y registra la firma del responsable; no se declara aprobación antes de contar con la evidencia requerida.

## Tasks

| ID | Spec | Ruta | Descripción | Commit |
| --- | --- | --- | --- | --- |
| T1 | S1 | *bloqueada* | Completar historial de versiones y matriz de pruebas. | — |
| T2 | S2 | *bloqueada* | Enlazar verificaciones de datos/modelo/infraestructura. | — |
| T3 | S3 | *bloqueada* | Documentar decisión APROBADO/RECHAZADO. | — |
| T4 | S4 | *bloqueada* | Registrar la firma del responsable. | — |

Ruta por defecto: **bloqueada**. No iniciar hasta reunir la evidencia requerida.

Preparación permitida sin datos: historial de versiones, matriz de pruebas y criterios de decisión. La decisión y la firma quedan bloqueadas.

## Dependencias y bloqueos humanos

- **Bloqueo doble:** datos reales y modelo aprobado (los dos pendientes permitidos).
- **Bloqueo humano:** el responsable debe decidir y firmar; sin firma no hay aprobación de producción.
- **Continuidad de datos (H20):** la matriz no puede presentar backup, restore o SLA como evidencia. El sustrato es un `StatefulSet` de una réplica (`backend/deploy/k8s/base/postgres.yaml:44,53`), no hay `CronJob` de backup en `backend/deploy/k8s/` ni una admisión de ingreso dedicada: la única regla de los pods de PostgreSQL selecciona el par por la etiqueta `app` sobre TCP/5432 (`backend/deploy/k8s/base/network.yaml:190-202`), y su efecto en un destino no se ha observado; la política está escrita y no implementada (`backend/deploy/k8s/README.md:212-218`; `backend/deploy/k8s/DEPLOY-GKE.md:859`, §«Hard stops», ítem 4). Detalle y dueño en [`14-motor-datos-continuidad.md`](14-motor-datos-continuidad.md).

## Criterios de cierre

- `../urgent/05-ct-aprobacion-demo.md:14-23`; `../../Referencias/tareas_verificacion_implementacion_IA.md:459-476`.

## Log

- **L1 (2026-10-16)** — Creación del desglose por spec a partir de [`README.md`](README.md) §1 (frente 13). Documento de planificación; sin implementación.
- **L2 (2026-10-20)** — Estado precisado a «bloqueado para acreditar»: historial, matriz y criterios se preparan sin datos; la firma sigue bloqueada (README §5.1).
- **L3 (2026-11-18) — Continuidad fuera de la matriz (H20 de la auditoría de producción).** El documento fija qué evidencia falta para datos y modelo, y no decía que la continuidad del sustrato tampoco se puede presentar: la base es un `StatefulSet` de una réplica (`backend/deploy/k8s/base/postgres.yaml:44,53`), no existe `CronJob` ni Job de backup en `backend/deploy/k8s/` ni una admisión de ingreso dedicada, y `postgres-entry` selecciona el par por la etiqueta `app` sobre TCP/5432 (`base/network.yaml:190-202`), sin observación del efecto en un destino; la política está escrita y no implementada (`backend/deploy/k8s/README.md:212-218`; `backend/deploy/k8s/DEPLOY-GKE.md:859`, §«Hard stops», ítem 4; `odd/entrega/acta-cierre.md:194,205`). Se añadió el bloqueo con el dueño remitido al frente 14 para no duplicar el detalle. Es lectura de manifiestos: no se ejecutó ningún backup ni restore.
