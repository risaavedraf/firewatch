# Frente 10 — OpenAPI como fuente de verdad y contract tests

- **Grupo de entrega:** G3 — Robustez de backend.
- **Estado:** **Implementado, verificado y re-verificado (2026-10-16).** El contrato pasó de validar solo sintácticamente a describir las respuestas observables, con contract tests que ejecutan rutas reales y fallan contra el documento previo (`750cd80`, `1436dae`) y una corrección posterior de una descripción que prometía una lista de códigos por respuesta que el documento no lleva (`cf23d20`). **Corrección 2026-11-17:** el `502` de dos capas se declara por operación (ver «Capas del `502`» y L3); el cierre de 2026-10-16 no se reescribe. **Falta:** nada propio de este frente; la re-verificación fue **en línea** porque la admisión en tiempo de ejecución rechazó el verificador independiente (el candidato no declara ítem de riesgo alto ante esa compuerta). Detalle y límites en [`../tasks/security/backend-hardening/08-openapi-errors.md`](../tasks/security/backend-hardening/08-openapi-errors.md).
- **Riesgo (Task Size):** alto al implementar — ítem 3 (contrato publicado que otros consumen).
- **Depende de:** BH-01 (tests ejecutables); coordinar con BH-03; **BH-12 no es requisito**.
- **Seam / superficie:** `contracts/openapi/firewatch-v1.yaml`, handlers y gateway.

**Objetivo.** Alinear el contrato OpenAPI con las respuestas observables y probar esa paridad con rutas reales.

**Documentación real (redirección).**
- [`../tasks/security/backend-hardening/08-openapi-errors.md:7-20`](../tasks/security/backend-hardening/08-openapi-errors.md) — criterios de aceptación (BH-08).
- [`../tasks/security/backend-hardening.md:24`](../tasks/security/backend-hardening.md) — encuadre del plan de hardening.

> Nota de solape: este frente **es** la unidad BH-08 del frente 11. Se mantiene como frente propio por su rol de *fuente de verdad*; al implementar, coordinar con el frente 11 para no duplicar.

## Specs

- **S1** — Se prepara la matriz operación-error según el comportamiento actual; GET 503 y gateway 502/429 sólo donde apliquen.
- **S2** — Se reutilizan esquemas de error y se describe cuerpo, headers y request ID observables.
- **S3** — Se añaden pruebas de contrato contra rutas reales de dependencia no disponible, fallo *upstream* y rate limit.
- **S4** — BH-12 permanece diferido: no es requisito para cerrar la paridad.

## Tasks

| ID | Spec | Ruta | Descripción | Commit |
| --- | --- | --- | --- | --- |
| T1 | S1 | inline | Construir la matriz operación-error desde el comportamiento vigente. | Hecho: `750cd80` |
| T2 | S2 | inline | Alinear esquemas de error (cuerpo/headers/request ID). | Hecho: `750cd80`; descripción de `ErrorResponse.code` corregida en `cf23d20` |
| T3 | S3 | inline | Añadir contract tests contra rutas reales. | Hecho: `750cd80` (`gateway` y `risk`), RED reproducido contra el contrato previo |

Ruta por defecto: **inline**. Delegar el contrato a un verificador solo si el diff nombra un ítem de riesgo alto.

## Capas del `502` (corrección 2026-11-17)

`POST /v1/prevention/actions` y `GET /v1/users` pueden responder `502` desde dos capas distintas, y el `code` del cuerpo dice cuál: el gateway responde `upstream_unavailable` cuando no alcanza el servicio, y `prevention` responde `directory_upstream_failed` cuando el directorio responde un error o no se alcanza. Antes, la creación declaraba solo `UpstreamUnavailable` y la lista de usuarios solo `DirectoryUpstreamFailed`, así que cada operación ocultaba una de las dos capas.

El documento lo declara en una respuesta compuesta compartida por las dos operaciones, `components/responses/UpstreamOrDirectoryFailed`, con `enum: [upstream_unavailable, directory_upstream_failed]`. No se regeneró contrato ni se tocó ningún handler: el documento no genera `contracts/gen`, y los consumidores no se editaron.

**Fuera de esta corrección.** El `503` de la creación también tiene dos fuentes —`storage_unavailable` (`backend/services/prevention/internal/handler/api.go:184`) y `directory_unavailable` (`api.go:211,216`)— y el documento sigue declarando solo `StorageUnavailable` (`firewatch-v1.yaml:752`). Es un hueco real que esta corrección **no** cierra: H3 se limita a los dos `502`, así que queda registrado como pendiente para decisión posterior y no se amplía aquí.

**Comprobación (2026-11-17).** El `enum` de las dos respuestas `502` se leyó del YAML con un parseo local: antes la creación no enumeraba un `code` y `/v1/users` solo enumeraba `directory_upstream_failed`; después, las dos capas en ambos `502`. La aserción contra el baseline confirma que solo cambian esos dos `$ref`: el `503` de la creación y los demás `502`/`503` no se tocaron. El validador que usa la CI (`kin-openapi` 0.133.0, el comando de `.github/workflows/integration.yml:36-37`) termina sin errores al ejecutarlo desde el módulo `gateway`, que fija esa versión, y `go test ./internal/handler -run 'Contract|Users'` sigue en verde en `prevention` (valida los cuerpos reales contra el documento). No hubo corrida de CI en esta sesión.

## Dependencias y bloqueos humanos

- **Bloqueo humano:** confirmar aplicabilidad por operación a partir del comportamiento vigente; **no inventar garantías**.
- Depende de BH-01 para tests ejecutables.

## Criterios de cierre

- `../tasks/security/backend-hardening/08-openapi-errors.md:11-20`.

## Log

- **L1 (2026-10-16)** — Creación del desglose por spec a partir de [`README.md`](README.md) §1 (frente 10). Documento de planificación; sin implementación.
- **L2 (2026-10-16, cierre de la sesión A)** — El frente **es** la unidad BH-08 y quedó entregado con ella: matriz operación-error, esquemas compartidos, `429`/`502` en cada operación y los `503`/`404`/`415` que faltaban, más contract tests que cargan el documento y validan respuestas reales. La re-verificación se hizo en línea (RED reproducido en un export aislado con el contrato de `02911d5`; GREEN en el árbol; matriz contrastada contra los handlers; validador de CI en 0) y encontró una promesa de más del contrato, corregida en `cf23d20`. **BH-12 sigue diferida y no fue requisito.** El frente no queda «terminado» según §5 del README del plan solo en el sentido de que la revisión independiente no corrió; el contenido y sus pruebas sí están.
- **L3 (2026-11-17)** — `502` de dos capas declarado por operación: `POST /v1/prevention/actions` y `GET /v1/users` comparten `UpstreamOrDirectoryFailed` (gateway `upstream_unavailable` / directorio `directory_upstream_failed`). Sin regenerar `contracts/gen` ni editar handlers; validador de CI y pruebas de contrato de `prevention` en verde. El `503` de la creación no se toca y su segunda fuente (`directory_unavailable`) queda registrada como pendiente. Detalle en §«Capas del `502`».
