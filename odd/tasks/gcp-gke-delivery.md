# Destino de nube: Google Cloud con GKE

**Qué es:** el destino de nube de la entrega pasa de AWS a **Google Cloud**, y el sustrato de entrega sigue siendo Kubernetes: **GKE**. El motor de datos, los manifiestos y el plano de datos dentro del clúster no cambian.
**Estado:** abierto y en ejecución — T1 y T2 hechas; T3 bloqueada por un proyecto de Google Cloud y sus credenciales. Nada se ha desplegado: no hay proyecto, no hay clúster y `gcloud` no está instalado en la máquina donde se escribe esto.

## Specs

**S1 — El destino de nube es Google Cloud, con Kubernetes.** Decisión del responsable del proyecto, textual, del 2026-11-17:

> «mira al final nos haremos un server en google cloud para montar todo esto en kubernetes, dejemos esto avanzado porfa»

El destino deja de ser AWS y pasa a ser Google Cloud, con GKE como clúster. «dejemos esto avanzado» fija el alcance de este frente: documentar y preparar lo que no exige cuenta, y no desplegar.

**S2 — El sustrato y el motor no cambian; cambia el proveedor.** El sustrato es Kubernetes desde el 2026-11-17 ([`../entrega/acta-cierre.md`](../entrega/acta-cierre.md) §7.3) y el motor sigue siendo **PostgreSQL 17 con PostGIS 3.5**, con el plano de datos dentro del clúster. Lo que cambia es quién provee la nube y con qué servicios: **GKE** en lugar de una VM, **Artifact Registry** en lugar de ECR, **Cloud Storage** en lugar de S3 y **IAM de Google** en lugar de los roles de AWS. Ningún manifiesto de `backend/deploy/k8s/` se reescribe por esto: son Kubernetes estándar y no nombran proveedor, que es exactamente lo que el §7.3 compró al elegir el clúster.

**S3 — La residencia de los datos vuelve a Chile si el proveedor tiene región chilena.** El §7.2 del acta aceptó São Paulo (`sa-east-1`) como solución temporal porque AWS no tenía región chilena disponible, y dejó escrito que se volvería a Chile cuando la hubiera. Google Cloud sí tiene una: `southamerica-west1` es **Santiago, Chile**, según su documentación oficial de ubicaciones (`https://cloud.google.com/about/locations`, consultada el 2026-11-17). La residencia deja de ser un compromiso aceptado a regañadientes y pasa a ser una elección de región dentro del mismo proveedor. Lo que **no** se verifica hoy es qué servicios y qué tipos de máquina están disponibles en esa región: se confirma al contratar.

**S4 — Se avanza todo lo que no exija credenciales; el despliegue real queda bloqueado.** Documentar el camino, los servicios de destino y los pasos de aprovisionamiento no necesita cuenta. El despliegue queda bloqueado por dos insumos que esta máquina no tiene: un proyecto de Google Cloud con facturación, y credenciales que permitan crear el clúster. `gcloud` no está instalado, así que ni siquiera se puede comprobar la sintaxis de los comandos ejecutándolos: se escriben y se marcan como **no ejecutados**, y lo que no se sabe con certeza se escribe en prosa en lugar de inventar una bandera.

## Tasks

| ID | Tarea | Spec | Estado |
| --- | --- | --- | --- |
| T1 | Enmendar el proveedor de D1 en el acta con el mecanismo del §7.3 —sin borrar nada— y corregir la coherencia en los documentos que presentaban AWS como destino vigente. | S1, S2, S3 | Hecha — [acta §7.4](../entrega/acta-cierre.md) |
| T2 | Hacer concreto el camino GKE: GKE Standard frente a Autopilot, Artifact Registry, Cloud Storage con Workload Identity, el metrics API que GKE ya incluye, `standard-rwo` y un checklist de `gcloud` marcado como no ejecutado. | S2, S3 | Hecha — `backend/deploy/k8s/README.md`, apartado «Cluster flavor: decided — GKE» y siguientes |
| T3 | **Bloqueada.** Aprovisionar proyecto, clúster, repositorio y bucket; aplicar al clúster real el render de `overlays/delivery`; registrar la evidencia del entorno objetivo. | S1, S4 | **Bloqueada** — por proyecto de Google Cloud y credenciales: no hay cuenta, ni clúster, ni `gcloud` |

## Log

**L1 (2026-11-17, textual).** Decisión del responsable del proyecto:

> «mira al final nos haremos un server en google cloud para montar todo esto en kubernetes, dejemos esto avanzado porfa»

Lo que se decidió a partir de ella, y por qué:

- **El proveedor cambia; el sustrato y el motor no.** La frase nombra dos cosas a la vez —Google Cloud y Kubernetes— y solo la primera es nueva: Kubernetes ya era el sustrato desde el §7.3 del acta. Por eso la enmienda del §7.4 alcanza únicamente la dimensión **proveedor** de D1 y deja intactos el motor, la política de backups, los objetivos de SLA/RPO/RTO y el plano de datos dentro del clúster.
- **La residencia deja de ser un compromiso y pasa a ser una elección de región.** El §7.2 había aceptado São Paulo dejando escrita la condición de salida: que apareciera una región chilena o que se abriera cuenta en un proveedor que la tuviera. Google Cloud la tiene en `southamerica-west1` (Santiago, Chile), así que la condición se cumple por la segunda vía y no hizo falta esperar a `sa-west-1`. La fuente es la documentación oficial de ubicaciones, consultada el 2026-11-17; no hay medición propia porque no hay cuenta.
- **Se documenta, no se despliega.** El encargo explícito fue «dejemos esto avanzado». El camino concreto —sabor de clúster, registry, bucket, metrics API, StorageClass y comandos de aprovisionamiento— vive en `backend/deploy/k8s/README.md`, y cada afirmación sobre GKE está marcada como conocimiento del proveedor y no como medición de este repositorio. Los comandos de `gcloud` no se ejecutaron: no hay binario, ni proyecto, ni credenciales.
- **Lo que no se resuelve queda escrito como pendiente.** No hay proyecto, ni clúster, ni bucket, ni repositorio de imágenes; la disponibilidad de cada servicio y de cada tipo de máquina en `southamerica-west1` se confirma al contratar; y el traslado de datos y secretos, cuando exista el entorno, sigue siendo una migración con verificación y no un cambio de configuración. T3 es la tarea que lo cubre y está bloqueada por eso, no por falta de decisión.
