# Cambio de arquitectura — de Oracle Cloud a AWS

**Decisión:** el despliegue de producción de FireWatch pasa de Oracle Cloud a AWS EC2.
**Fecha:** 2026-11-06 · **Alcance:** proveedor cloud, almacenamiento de objetos y forma de despliegue.
**Estado:** decidido; el despliegue no está cerrado (ver §4). **Superseded en su proveedor el 2026-11-17:** el destino de nube vigente es **Google Cloud con GKE** ([`../../entrega/acta-cierre.md`](../../entrega/acta-cierre.md) §7.4), no AWS EC2. El título y la decisión de arriba se conservan como historia, y lo que se sustituye es el proveedor y los servicios que lo nombran —la VM, S3, ECR y los roles de AWS—. Lo demás de este documento sigue vigente: el registro del cambio de arquitectura (§1-§2), la ejecución del modelo en Go (§3) y la forma de despliegue en Kubernetes (§4).

## 1. Por qué se registra

Los documentos evaluados del proyecto describen otra arquitectura. Si el cambio no queda escrito, la corrección encuentra una entrega que declara algo distinto a lo que esos documentos muestran, y eso se lee como inconsistencia, no como decisión.

Evidencia de lo documentado, sin interpretación:

| Documento | Qué dice |
| --- | --- |
| `Referencias/Actividad C4_FireWatch_produccion.md:235` | Nodo de despliegue «Oracle Cloud» |
| `Referencias/Actividad C4_FireWatch_produccion.md:239` | «Kubernetes: réplicas y despliegue automatizado; Compose solo para desarrollo» |
| `Referencias/Actividad C4_FireWatch_produccion.md:61` | Contenedor de predicción: «Go, ONNX» |
| `Referencias/Actividad C4_FireWatch_produccion.md:259-261` | Almacenamiento: «Oracle Object Storage» |
| `Referencias/Actividad Dimensionamiento_FireWatch_produccion.md:48-50` | «Oracle Cloud como proveedor principal» |
| `Referencias/EP1_Equipo3_Armijo_Calderon_Saavedra2_produccion.md:474-478` | Decisión propuesta: Oracle Cloud |
| `Referencias/EP1_Equipo3_Armijo_Calderon_Saavedra2_produccion.md:492-496` | Decisión: ONNX ejecutado en Go |

Ninguna referencia del repositorio exige AWS. `Referencias/tareas_verificacion_implementacion_IA.md:327` acepta «Kubernetes / AWS ECS u otra» para escalado horizontal, es decir, deja el proveedor abierto.

## 2. Qué motiva el cambio

El plan `Referencias/FireWatch-Plan-implementacion-modelo-AWS.md` propone AWS por dos razones operativas, no por requisito académico:

1. **Costo y tiempo de operación.** Una VM con Docker Compose levanta el stack completo; un clúster de Kubernetes exige trabajo de plataforma que no produce ningún artefacto evaluable adicional.
2. **Credenciales por rol.** S3 con rol IAM evita llaves en disco en la instancia, que es un requisito de seguridad razonable y más simple de verificar que un equivalente autogestionado.

El argumento del plan que **no** se sostiene es que «la guía exige AWS (EC2)». Ver §1.

Esas dos razones explican la elección de AWS del 2026-11-06. El sustrato de entrega cambió después por un requisito externo y eso está en §4: no fue un análisis de costo, fue un pedido del responsable.

## 3. Qué cambia

| Tema | Antes (documentado) | Ahora |
| --- | --- | --- |
| Proveedor | Oracle Cloud | AWS EC2 |
| Almacenamiento de objetos | Oracle Object Storage | S3, acceso por rol IAM |
| Base de datos | Oracle Autonomous | PostGIS en contenedor sobre Kubernetes (StatefulSet dentro del clúster); administrada solo si se adopta un servicio gestionado, que queda documentado y no adoptado (§4) |
| Ejecución del modelo | Go + ONNX | Go interpretando un artefacto JSON propio (§4) |

**Corrección del 2026-11-17, sobre las dos primeras filas.** La columna «Ahora» se lee con el §7.4 del acta: **Google Cloud con GKE** en lugar de AWS EC2, **Cloud Storage** en lugar de S3 y **IAM de Google** —con Workload Identity, sin claves estáticas— en lugar de los roles de AWS. La fila de la base de datos no cambia: PostGIS sigue dentro del clúster desde el §7.3. El resto de la tabla queda como está.

## 4. Qué no se cierra

**Forma de despliegue.** **Superseded el 2026-11-17; el texto original se conserva como historia.** Decía: «Se implementa Docker Compose en una VM y Kubernetes queda documentado como objetivo. No se declara despliegue productivo cerrado, y la documentación debe leerse así: Compose es lo que existe, Kubernetes es lo que se planea». La decisión vigente es la contraria: el sustrato de entrega es Kubernetes, con manifiestos en `backend/deploy/k8s/` —`base` como plantilla y `overlays/delivery` con los cinco digests— y el plano de datos dentro del clúster. El Compose de producción deja de ser sustrato productivo: `backend/docker-compose.prod.yml` no incluye `inference` (`:21`) y declara `APP_ENV: production` (`:35`) con `AMQP_URL: amqp://` (`:193`, `:205`) y DSN con `sslmode=disable` (`:192`, `:204`), así que no pasaría sus propias guardas de transporte. Sigue sin declararse despliegue productivo cerrado, y ahora por las razones correctas: falta el entorno autorizado (T9), y la elección vinculante de clúster ya está tomada —GKE, acta §7.4— aunque no esté aprovisionada. La corrección completa, con su evidencia, está en [`../../entrega/acta-cierre.md`](../../entrega/acta-cierre.md) §7.3, y la del proveedor en el §7.4.

**Ejecución del modelo.** Se descarta `onnxruntime` en Go porque exige cgo y glibc, y los cuatro servicios compilan hoy con `CGO_ENABLED=0` sobre `gcr.io/distroless/static-debian12:nonroot` (`backend/services/*/Dockerfile:3,12-14`). El artefacto es un JSON versionado con pesos o árboles y el preprocesamiento declarado. La equivalencia se prueba contra un scorer de Python sobre un set congelado, no se asume.

**Base de datos administrada.** La pregunta «RDS o PostGIS autogestionado» está sobre la mesa desde que se adoptó Kubernetes (2026-11-17, acta §7.3): se documenta con su costo y sus condiciones y **no se adopta**. El plano de datos sigue dentro del clúster, como StatefulSet.

## 5. Cómo se lee la entrega

- Los documentos de `Referencias/` **no se reescriben**: son la evidencia de lo que se decidió en su momento y siguen siendo válidos como registro.
- Este documento es la fuente para saber qué cambió y por qué. Cualquier lector que compare C4 con el despliegue real debe pasar por aquí primero.
- Si se requiere una versión actualizada de C4, EP1 o Dimensionamiento para la entrega final, se produce como documento nuevo y fechado, no como edición silenciosa del original.

## 6. Pendientes que este cambio crea

| Pendiente | Dónde se resuelve |
| --- | --- |
| Dominio y certificado | `backend/deploy/k8s/README.md`, sección «Path to a real production cluster». El runbook Compose de `backend/deploy/prod/README.md`, que era el destino anterior de esta fila, quedó superseded como camino de entrega el 2026-11-17 (`../kubernetes-deployment.md` L25) |
| Rol IAM con permiso de lectura sobre el bucket de datos y modelos | El permiso de lectura del bucket sigue pendiente, hoy en **Cloud Storage con IAM de Google**: lo cubre T3 de [`../gcp-gke-delivery.md`](../gcp-gke-delivery.md), y el detalle del camino vive en `backend/deploy/k8s/README.md` |
| Apagado de la instancia al terminar las demostraciones | Ya no aplica: con el sustrato de Kubernetes (§7.3) y el proveedor del §7.4 no hay instancia que apagar |
| Actualización de C4/EP1 para la entrega final, si se pide | Documento nuevo, fechado |
