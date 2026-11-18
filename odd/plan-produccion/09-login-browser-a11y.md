# Frente 9 — Login real en navegador, móvil y accesibilidad

- **Grupo de entrega:** G5 — Producto y cierre.
- **Estado:** Parcial — el recorrido browser/Keycloak y la revisión móvil/accesibilidad se midieron en L14/L23 (Chrome, 390 px, teclado y contraste calculado). **Falta:** certificación WCAG y prueba con lector de pantalla; los límites están en README §7.
- **Riesgo (Task Size):** medio — ítem 6 si no hay prueba automatizada que capture regresiones de login; sin datos/seguridad nuevos más allá del flujo OIDC existente.
- **Depende de:** realm Keycloak inicializado, cliente `firewatch-demo` configurado y entorno navegador/API disponible.
- **Seam / superficie:** `firewatch-demo` (OIDC Authorization Code + PKCE S256), callback y URI post-logout; la API conserva autorización *server-side*.

**Objetivo.** Completar y verificar el acceso OIDC real y la experiencia de login/logout en navegador, móvil y accesibilidad.

**Documentación real (redirección).**
- [`../tasks/frontend/client-proposal-page.md:13-26,39-45`](../tasks/frontend/client-proposal-page.md) — checks y próximo paso.
- [`../tasks/README.md:77-88`](../tasks/README.md) — estado frontend.

## Specs

- **S1** — El realm persistente aplica la URI de post-logout documentada y los valores requeridos para login.
- **S2** — Login/logout real con Keycloak y una llamada API autenticada completan el recorrido.
- **S3** — La interfaz se verifica visualmente en navegador y en móvil.
- **S4** — Se evalúa accesibilidad formal (las pruebas existentes no la demuestran).

## Tasks

| ID | Spec | Ruta | Descripción | Commit |
| --- | --- | --- | --- | --- |
| T1 | S1 | inline | Aplicar los ajustes no destructivos del cliente (post-logout, valores de login) en el realm vivo. | `../tasks/presentation-client-ready.md` L23 |
| T2 | S2 | inline | Ejecutar login/logout real + llamada API autenticada. | `../tasks/presentation-client-ready.md` L23 (T17, Chrome) |
| T3 | S3 | inline | Verificación visual navegador y móvil. | `../tasks/presentation-client-ready.md` L23 (390 px, teclado) |
| T4 | S4 | inline | Evaluación de accesibilidad formal. | — |

Ruta por defecto: **inline**. El recorrido de navegador puede ejecutarse con el actor de revisión de página.

## Dependencias y bloqueos humanos

- **Bloqueo humano:** el realm local ya quedó ajustado y medido (post-logout corregido en la base viva y verificado, L23); el realm del entorno objetivo se aprovisiona fuera de banda y necesita ese valor por su cuenta. Sigue abierta la selección nativa de archivos antes de declarar revisión/cierre.

## Criterios de cierre

- `../tasks/frontend/client-proposal-page.md:24-26,42-45`: checks y próximo paso. La prueba live ya se tomó —login y logout con Keycloak vivo, 390 px, teclado y contraste— en [`../tasks/presentation-client-ready.md`](../tasks/presentation-client-ready.md) L23; falta certificación WCAG y lector de pantalla.

## Log

- **L1 (2026-10-16)** — Creación del desglose por spec a partir de [`README.md`](README.md) §1 (frente 9). Documento de planificación; sin implementación.
- **L2 (2026-10-20)** - Estado corregido a Parcial: recorrido browser/Keycloak y revisión móvil/accesibilidad medidos en L14/L23; faltan certificación WCAG y lector de pantalla (README §7).
- **L3 (2026-11-18) — T1 y la prueba live corregidos (H13 de la auditoría de despliegue).** «Aplicar los ajustes no destructivos en Admin Console» y «falta prueba live» eran ciertos al planificar y dejaron de serlo. L23 corrigió `post.logout.redirect.uris` del realm vivo por base —la Admin Console no sirve con las credenciales documentadas, que responden `invalid_grant`— y midió `PASS BROWSER: Keycloak logout clears private session`; T17 ya había medido login/logout, 390 px, teclado y contraste. El realm del entorno objetivo es independiente y no hereda ese ajuste. Lo que falta sigue siendo certificación WCAG y lector de pantalla.
