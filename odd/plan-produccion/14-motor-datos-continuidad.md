# Frente 14 — Decisión del motor de datos y continuidad/recuperación

- **Grupo de entrega:** G1 — Base de entrega.
- **Estado:** Parcial — motor decidido; continuidad sin implementar ni medir. El motor quedó decidido el 2026-11-09 y su sustrato es Kubernetes desde el 2026-11-17 ([`../entrega/acta-cierre.md`](../entrega/acta-cierre.md) §7 y §7.3): PostgreSQL 17 con PostGIS 3.5, autogestionado dentro del clúster. Lo que sigue pendiente es la continuidad —política de backups implementada, restore probado y SLA/RPO/RTO medidos— y nada de eso está implementado ni medido.
- **Riesgo (Task Size):** alto al implementar — ítem 1 (motor/persistencia y backups) e ítem 5 (infraestructura/despliegue).
- **Depende de:** decisión de motor/infraestructura; frente 7 para despliegue redundante; procedimientos operativos y pruebas.
- **Seam / superficie:** persistencia `risk`/`jobs`, migraciones PostgreSQL/PostGIS y el motor productivo elegido; almacenamiento de objetos para modelos/datasets/backups.

**Objetivo.** Cerrar la continuidad y la recuperación que respalden el SLA objetivo, sobre el motor ya decidido en el acta §7.

**Documentación real (redirección).**
- [`../../Referencias/EP1_Equipo3_Armijo_Calderon_Saavedra2_produccion.md:76,90,102-104`](../../Referencias/EP1_Equipo3_Armijo_Calderon_Saavedra2_produccion.md) — SLA/frescura y metas iniciales (p. ej. disponibilidad mensual de 99,5%).
- [`../../Referencias/Actividad C4_FireWatch_produccion.md:63-65,253-263`](<../../Referencias/Actividad C4_FireWatch_produccion.md>) — continuidad y recuperación.
- [`../../backend/docs/architecture.md:61`](../../backend/docs/architecture.md) — PostgreSQL/PostGIS aprobado en local; el motor productivo queda decidido en el acta §7.
- [`../../backend/docs/verification.md:130`](../../backend/docs/verification.md) — recuperación y SLA no probados.
- [`../tasks/backend/firewatch-data-contract.md:25-29`](../tasks/backend/firewatch-data-contract.md) — PostGIS local aprobado.

## Specs

- **S1** — Se resuelve el motor de datos de producción (referencias citan Oracle; local está aprobado PostgreSQL/PostGIS; el backend **no** declara compatibilidad Oracle).
- **S2** — Se definen continuidad y recuperación, con redundancia y procedimientos que sostengan las últimas estimaciones válidas ante fallos.
- **S3** — Se define y **prueba** la política de backups/restauración.
- **S4** — Se valida el objetivo de disponibilidad mensual y se acuerdan metas medibles de recuperación (RPO/RTO).
- **S5** — Se confirman las metas de rendimiento y carga mediante pruebas (son metas iniciales sujetas a validación).

## Tasks

| ID | Spec | Ruta | Descripción | Commit |
| --- | --- | --- | --- | --- |
| T1 | S1 | inline | Motor productivo decidido y documentado con su impacto en migraciones y persistencia: acta §7, con el sustrato enmendado en §7.3. | — |
| T2 | S2 | inline | Definir continuidad/recuperación y procedimientos de degradación. | — |
| T3 | S3 | inline | Definir y probar backups/restauración. | — |
| T4 | S4 | inline | Validar la disponibilidad mensual y medir los RPO/RTO ya acordados en el acta §7. | — |
| T5 | S5 | inline | Confirmar metas de rendimiento/carga con pruebas. | — |

Ruta por defecto: **inline**. T1 quedó resuelto con el acta §7 y ya no bloquea T2–T5; lo que bloquea es la aprobación de metas y el restore probado.

## Dependencias y bloqueos humanos

- **Bloqueo humano:** la **implementación y medición** de las metas de recuperación (disponibilidad, RPO y RTO) —un restore probado, cronometrado y registrado— y, si no consta ya, su **firma**. Las metas no se deciden aquí: están escritas en el acta §7. El motor ya no es un bloqueo: está decidido en el acta §7.
- Los objetivos de RPO (15 min) y RTO (1 h) están acordados en el acta §7 y **ninguno está medido**; lo que falta no es volver a acordarlos, sino implementarlos y medirlos, y el criterio de restauración sigue sin probarse.

## Criterios de cierre

- SLA/frescura y metas: `../../Referencias/EP1_Equipo3_Armijo_Calderon_Saavedra2_produccion.md:76,90,104`.
- Decisión de motor: acta §7, sobre la aprobación local de `../../backend/docs/architecture.md:61`; recuperación/SLA no probados: `../../backend/docs/verification.md:130`.

## Log

- **L1 (2026-10-16)** — Creación del desglose por spec a partir de [`README.md`](README.md) §1 (frente 14). Documento de planificación; sin implementación.
- **L2 (2026-11-18) — Estado del sustrato y de la continuidad, con los manifiestos delante (H20 de la auditoría de producción).** El documento decía que la continuidad no está implementada ni medida y no nombraba contra qué se comprueba. Lo que hay hoy: la base es un `StatefulSet` de **una réplica** (`backend/deploy/k8s/base/postgres.yaml:44,53`) con un claim `ReadWriteOnce` de 8 Gi por réplica (`:200-207`); **no existe ningún `CronJob` ni Job de backup** en `backend/deploy/k8s/` (los únicos Jobs son `base/broker-provision.yaml:23` y `base/jobs-migrate.yaml:30`); y `postgres-entry` es la regla de ingreso de esos pods: selecciona el par por la etiqueta `app` —valores `jobs`, `risk`, `prevention`, `keycloak` y `migrate`— sobre TCP/5432 (`base/network.yaml:190-202`); no existe una carga de backup ni una admisión dedicada a ella, y el efecto de la política en un destino no se ha observado (`backend/deploy/k8s/README.md:238`). El estado de la política es «escrita, no implementada» (`backend/deploy/k8s/README.md:212-218`), el runbook lo dice con todas las letras —«Backups are not delivered» (`backend/deploy/k8s/DEPLOY-GKE.md:859`, §«Hard stops», ítem 4)— y el acta fija el mismo estado y las metas (`odd/entrega/acta-cierre.md:189-192,200-205`). Todo eso es **evidencia de destino, no de acreditación**: T3 y T4 siguen abiertas y ningún backup, restore o RPO/RTO se ejecutó. **Reparación de cita en la misma pasada:** `backend/docs/verification.md:100` pasó a ser una fila de la tabla de toolchain; lo que declara recuperación y SLA no probados está en `:130`, y las dos referencias se reapuntaron ahí. Las líneas `:32-33` y `:40-41` que otros documentos citan quedan intactas: todo se añade a este Log.
