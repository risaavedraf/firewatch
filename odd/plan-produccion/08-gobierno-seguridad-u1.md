# Frente 8 — Gobierno, seguridad y protección de datos/modelo (U1)

- **Grupo de entrega:** G3 — Robustez de backend.
- **Estado:** Pendiente — planificación. No acredita implementación ni evidencia.
- **Riesgo (Task Size):** alto al implementar — ítem 2 (seguridad: auth, permisos, secretos, guardas).
- **Depende de:** responsables y decisiones de clasificación/aprobación/controles aplicables.
- **Seam / superficie:** gobierno de modelos, datos/datasets, API y pipeline de inferencia, contenedores, observabilidad y respuesta operacional.

**Objetivo.** Reunir amenazas, controles de acceso, procedencia, privacidad y operación segura en una unidad verificable.

**Documentación real (redirección).**
- [`../urgent/01-seguridad-gobierno.md:3-23`](../urgent/01-seguridad-gobierno.md) — unidad U1 y criterio de cierre.
- [`../../Referencias/tareas_verificacion_implementacion_IA.md:51-187`](../../Referencias/tareas_verificacion_implementacion_IA.md) — requisitos por ID.

## Continuidad de datos: lo que este frente no puede acreditar (H20)

La U1 incluye respuesta operacional, y el sustrato de datos no tiene hoy continuidad. No se repite aquí la política —su dueño es el frente 14— sino el estado del árbol, para que ninguna evidencia de U1 lo lea como cubierto: la base es un `StatefulSet` de **una réplica** (`backend/deploy/k8s/base/postgres.yaml:44,53`) con un claim `ReadWriteOnce` de 8 Gi por réplica (`:200-207`), **no hay ningún `CronJob` ni Job de backup** en `backend/deploy/k8s/` (los únicos Jobs son `base/broker-provision.yaml:23` y `base/jobs-migrate.yaml:30`), y `postgres-entry` es una regla de ingreso que selecciona el par por la etiqueta `app` —valores `jobs`, `risk`, `prevention`, `keycloak` y `migrate`— sobre TCP/5432 (`base/network.yaml:190-202`); los manifiestos no traen **ninguna carga de backup ni una admisión dedicada a ella**, y el efecto de esa política en un destino no se ha observado (`backend/deploy/k8s/README.md:238`). La política está escrita y no implementada (`backend/deploy/k8s/README.md:212-218`; `backend/deploy/k8s/DEPLOY-GKE.md:859`, §«Hard stops», ítem 4; `odd/entrega/acta-cierre.md:194,205`).

Consecuencia para esta unidad: ni el backup ni el restore probado pueden figurar como evidencia de S3/S5. El destino de la redirección es [`14-motor-datos-continuidad.md`](14-motor-datos-continuidad.md). **Es lectura de manifiestos**: no se ejecutó ningún backup, ningún restore ni ningún `kubectl`.

## Specs

- **S1** — Se define clasificación de riesgo, responsable de seguridad IA y aprobación previa a producción; se verifica consistencia regulatoria.
- **S2** — Se modelan amenazas IA con MITRE ATLAS, vinculando controles y justificando cada N/A.
- **S3** — Se documentan segmentación, autenticación, mínimo privilegio, linaje e integridad de fuentes y auditoría de dependencias/modelos.
- **S4** — Se evalúa sensibilidad, anonimización/privacidad y riesgo de reidentificación; se mide robustez adversaria.
- **S5** — Se verifican guardrails, aislamiento, alertas de deriva, red teaming, rollback y respuesta a incidentes.
- **S6** — Para cada ID existe estado, evidencia, criterio de aprobación y resultado; cada N/A se justifica.

## Tasks

| ID | Spec | Ruta | Descripción | Commit |
| --- | --- | --- | --- | --- |
| T1 | S1 | inline | Definir clasificación de riesgo, responsable y aprobación previa a producción. | — |
| T2 | S2 | inline | Modelar amenazas con MITRE ATLAS y vincular controles. | — |
| T3 | S3 | inline | Documentar segmentación, autenticación, mínimo privilegio y linaje. | — |
| T4 | S4 | inline | Evaluar privacidad/reidentificación y robustez adversaria. | — |
| T5 | S5 | inline | Verificar guardrails, aislamiento, deriva, red teaming y respuesta. | — |
| T6 | S6 | inline | Registrar estado/evidencia/criterio/resultado por ID (41 IDs U1). | — |

Ruta por defecto: **inline** (trabajo documental/de gobierno). Delegar solo por disparador.

## Dependencias y bloqueos humanos

- **Bloqueo humano:** designar responsable y aprobar política/categoría; justificar cada N/A.
- Depende de los requisitos por ID y de los pendientes permitidos (datos/modelo) para los ID que los exigen.

## Criterios de cierre

- `../urgent/01-seguridad-gobierno.md:21-23`.

## Log

- **L1 (2026-10-16)** — Creación del desglose por spec a partir de [`README.md`](README.md) §1 (frente 8). Documento de planificación; sin implementación.
- **L2 (2026-11-18) — Continuidad de datos acotada (H20 de la auditoría de producción).** El frente podía leerse como si la respuesta operacional de S5 incluyera continuidad del sustrato. No la incluye: la base del despliegue es un `StatefulSet` de una réplica (`backend/deploy/k8s/base/postgres.yaml:44,53`) con un claim `ReadWriteOnce` por réplica (`:200-207`), no hay `CronJob` ni Job de backup en el árbol, y `postgres-entry` selecciona el par por la etiqueta `app` —cinco valores de aplicación— sobre TCP/5432 (`base/network.yaml:190-202`), sin una carga de backup ni una admisión dedicada en los manifiestos, y sin observación del efecto en un destino (`backend/deploy/k8s/README.md:238`); su estado es «escrita, no implementada» (`backend/deploy/k8s/README.md:212-218`; `backend/deploy/k8s/DEPLOY-GKE.md:859`, §«Hard stops», ítem 4). Se añadió la sección que lo declara y que remite al dueño, el frente 14. El detalle completo vive en [`14-motor-datos-continuidad.md`](14-motor-datos-continuidad.md) y no se duplica aquí. Es lectura de manifiestos: no se ejecutó ningún backup ni restore.
