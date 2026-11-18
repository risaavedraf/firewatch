# Frente 3 — Servicio `prevention` y ciclo de acciones preventivas

- **Grupo de entrega:** G5 — Producto y cierre.
- **Estado:** **Implementado (2026-10-18).** El servicio `prevention` quedó entregado y ejercitado en el recorrido HTTP/UI de la presentación (L13/L14): listar, crear, detalle con historial, transición con nota, **evidencia, revisión de evidencia, reassessment vinculado** y **`GET /v1/users`** (inventario completo en «Inventario de rutas entregadas (H18)»). **Falta:** separar la base de producción, que es una decisión de producción; el backlog FWP03 fue el origen y ya no está propuesto. **Falta también el cableado del directorio en Kubernetes:** sin las cuatro variables que lee `cmd/server/main.go:95-99`, `GET /v1/users` responde `503 directory_unavailable` en el despliegue entregado (ver «Dependencia de directorio en Kubernetes (H5)»).

> El cuerpo de este documento conserva la planificación del 2026-10-16. El estado vigente es esta línea y el `## Log`; las referencias al backlog «propuesto» describen su origen histórico.
- **Riesgo (Task Size):** alto al implementar — ítem 3 (nuevo contrato/servicio que otros consumirán).
- **Depende de:** FWP01–02 y del acuerdo de partes interesadas sobre vocabulario y ciclo.
- **Seam / superficie:** límite futuro del servicio `prevention`; contrato/modelo de operación preventiva aún por validar; `backend/docs/architecture.md:34`.

**Objetivo.** Definir y habilitar operaciones preventivas asignables, trazables y revisables (acuse, avance, bloqueo, envío, aceptación, devolución, reapertura, cancelación).

**Documentación real (redirección).** **Requiere revisión de alcance antes de implementar.**
- [`../tasks/frontend/frontend-mockup/README.md:46-54`](../tasks/frontend/frontend-mockup/README.md) — el backlog FWP03 sigue propuesto.
- [`../tasks/frontend/frontend-mockup/README.md:70-73`](../tasks/frontend/frontend-mockup/README.md) — aceptación y pruebas propuestas (FWP03).
- [`../../backend/docs/architecture.md:34`](../../backend/docs/architecture.md) — servicio futuro.

## Dependencia de directorio en Kubernetes (H5)

`prevention` construye el cliente de directorio con cuatro ajustes —`KEYCLOAK_ADMIN_URL`, `KEYCLOAK_ADMIN_REALM`, `DIRECTORY_CLIENT_ID` y `DIRECTORY_CLIENT_SECRET`— (`backend/services/prevention/cmd/server/main.go:95-99`). **El cableado entregado no inyecta ninguno.** El pod recibe `firewatch-config` y `prevention-runtime` y añade solo las tres rutas TLS (`backend/deploy/k8s/base/workloads.yaml:267-280`); el ConfigMap no declara esas claves (`backend/deploy/k8s/base/config.yaml:12-31`), el Secret se crea con `DATABASE_URL` solo (`backend/deploy/k8s/bootstrap-secrets.sh:276-277,341`, la misma lista en `backend/deploy/k8s/README.md:24`), y ningún overlay las añade: `delivery` solo fija imágenes (`backend/deploy/k8s/overlays/delivery/kustomization.yaml:28-50`) y `pitch` parchea `firewatch-config` con `OIDC_ISSUER` y `WEB_ORIGIN` únicamente (`backend/deploy/k8s/overlays/pitch/kustomization.yaml:38-45`), aunque genere el secreto del cliente de directorio en el realm (`backend/deploy/k8s/overlays/pitch/provision-realm.py:9-11,75-80`).

Sin `BaseURL` ni `ClientSecret` el cliente queda sin configurar (`backend/services/prevention/internal/directory/directory.go:444-445`; `Realm` y `ClientID` vacíos caen a `firewatch`/`firewatch-directory` en `:165-170`), así que `GET /v1/users` responde **`503 directory_unavailable`** (`backend/services/prevention/internal/handler/users.go:62-64`). El guard de `dir == nil` de `:56-58` no es alcanzable desde `main.go`, que siempre pasa un cliente construido por `directory.New` y nunca `nil` (`directory.go:157-164`). La misma dependencia hace fallar cerrado la resolución del responsable al crear una acción (`backend/services/prevention/internal/handler/api.go:208-217`).

**Es un resultado inferido del código y de los manifiestos, no una respuesta observada.** Compose sí configura los cuatro (`backend/docker-compose.yml:247-254`), y por eso la ruta se entregó y se probó ahí (`../tasks/v1-produccion.md:64,211`): la brecha es del cableado de Kubernetes, no del servicio.

**Dependencia de aceptación.** Mientras ese cableado no exista, la aceptación de la ruta en el entorno objetivo no puede incluir un `200`: la validación end-to-end del clúster sigue abierta ([`../tasks/kubernetes-deployment.md:36`](../tasks/kubernetes-deployment.md), `:348`) y hereda esta dependencia. El cableado es otro frente: aquí no se implementa, no se toca ningún manifiesto y no se escribe ni se deriva ningún valor de secreto.

## Inventario de rutas entregadas (H18)

El contrato publicado declara ocho operaciones de este servicio y las ocho están montadas en el árbol; el resumen del estado nombraba solo cinco. La ruta del router es la mitad que el contrato no puede probar: cada fila cita las dos.

| Operación | Router | Contrato |
| --- | --- | --- |
| `GET /v1/prevention/actions` | `backend/services/prevention/internal/handler/api.go:58` | `backend/contracts/openapi/firewatch-v1.yaml:627` |
| `POST /v1/prevention/actions` | `api.go:59` | `firewatch-v1.yaml:680` |
| `GET /v1/prevention/actions/{id}` — la acción con su historial | `api.go:60` | `firewatch-v1.yaml:755` |
| `POST /v1/prevention/actions/{id}/transitions` — admin-only | `api.go:61` | `firewatch-v1.yaml:807` |
| `POST /v1/prevention/actions/{id}/evidence` — admin-only | `backend/services/prevention/internal/handler/evidence.go:29` | `firewatch-v1.yaml:922` |
| `POST /v1/prevention/actions/{id}/evidence/{evidence_id}/reviews` — admin-only | `evidence.go:30` | `firewatch-v1.yaml:1028` |
| `POST /v1/prevention/actions/{id}/reassessments` — admin-only | `evidence.go:31` | `firewatch-v1.yaml:1148` |
| `GET /v1/users` — admin-only | `api.go:63` | `firewatch-v1.yaml:1273` |

Las tres rutas de evidencia y reassessment se añadieron con las migraciones `009` y `011` y no aparecen en el relato de la presentación, que solo ejercitó lista, alta, detalle y transición. `GET /v1/users` es la ruta de la dependencia de directorio de H5: existe y está montada, pero en el despliegue entregado responde `503 directory_unavailable` (`backend/services/prevention/internal/handler/users.go:56-64`) porque sus cuatro ajustes no llegan al pod. **Es una lectura de código y contrato**: no se ejecutó ninguna de las ocho rutas en esta pasada.

## Specs

- **S1** — Cada operación preventiva se vincula a comunidad/sector y, si está validado, a objetivo/acción del plan preventivo.
- **S2** — Cada operación registra responsable/equipo, fecha límite e historial atribuible.
- **S3** — El ciclo cubre acuse, avance, bloqueo, envío, aceptación, devolución, reapertura y cancelación.
- **S4** — Las transiciones válidas e inválidas se prueban **antes** de implementar el servicio.

## Tasks

| ID | Spec | Ruta | Descripción | Commit |
| --- | --- | --- | --- | --- |
| T1 | S1,S2 | inline | Validar el modelo de operación (vocabulario, vínculos, responsable, historial) con las partes. | — |
| T2 | S3 | inline | Formalizar la máquina de estados del ciclo preventivo. | — |
| T3 | S4 | inline | Definir pruebas de transiciones válidas e inválidas. | — |
| T4 | S1-S4 | inline | Implementar el servicio `prevention` **solo tras aprobación de alcance**. | — |

Ruta por defecto: **inline**. T4 queda bloqueado hasta aprobación de alcance.

## Dependencias y bloqueos humanos

- **Bloqueo humano:** revisar y aprobar la propuesta FWP03; su existencia no autoriza implementación.
- Depende de FWP01–02.
- **Depende del directorio de identidad**, que en Kubernetes no está configurado: ver «Dependencia de directorio en Kubernetes (H5)». El cableado es otro frente.

## Criterios de cierre

- `../tasks/frontend/frontend-mockup/README.md:71-73`: aceptación y pruebas propuestas; backlog pendiente de revisión en `:46-48`.

## Log

- **L1 (2026-10-16)** — Creación del desglose por spec a partir de [`README.md`](README.md) §1 (frente 3). Documento de planificación; sin implementación.
- **L2 (2026-10-20)** — Estado corregido a Implementado: servicio `prevention` entregado y ejercitado en L13/L14; el backlog FWP03 ya no está propuesto (README §1 y §7).
- **L3 (2026-11-18) — Dependencia de directorio declarada (H5 de la auditoría de despliegue).** El documento se leía como servicio completo y no lo está en Kubernetes: las cuatro variables del cliente de directorio (`backend/services/prevention/cmd/server/main.go:95-99`) no llegan al pod por ninguna vía entregada —`backend/deploy/k8s/base/workloads.yaml:267-280`, `backend/deploy/k8s/base/config.yaml:12-31`, `backend/deploy/k8s/bootstrap-secrets.sh:276-277,341`, `backend/deploy/k8s/README.md:24` y los dos overlays—, y con `BaseURL`/`ClientSecret` vacíos `GET /v1/users` responde `503 directory_unavailable` (`backend/services/prevention/internal/handler/users.go:62-64`). Es una inferencia de código y manifiestos, no una respuesta observada; el overlay de pitch ya lo dejaba dicho al aprovisionar el realm (`backend/deploy/k8s/overlays/pitch/provision-realm.py:9-11`). Compose sí configura los cuatro (`backend/docker-compose.yml:247-254`), así que la brecha es de despliegue. El cableado no se hace aquí, no se toca ningún manifiesto, no se escribe ningún valor de secreto y **H18 no se toca**.
- **L4 (2026-11-18) — Inventario de rutas al día (H18 de la auditoría de producción).** El estado resumía el servicio como «listar, crear, detalle, transición con nota e historial» y omitía tres rutas entregadas y la de directorio. El contrato declara ocho operaciones (`backend/contracts/openapi/firewatch-v1.yaml:627,680,755,807,922,1028,1148,1273`) y las ocho están montadas (`backend/services/prevention/internal/handler/api.go:58-61,63`; `backend/services/prevention/internal/handler/evidence.go:29-31`), incluidas la evidencia inmutable, su revisión y el vínculo con un lote sintético real. Se añadió el inventario con los dos lados por fila y se corrigió el resumen del estado. `GET /v1/users` se documenta aquí como ruta existente y en H5 como ruta que hoy responde `503`. Es lectura de código y contrato: ninguna ruta se ejecutó en esta pasada.
