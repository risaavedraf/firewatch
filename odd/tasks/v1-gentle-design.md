# gentle-design v1 — rediseño del front end de FireWatch (prototipos)

**What this is:** the ODD tracker for the front-end redesign the responsible ordered in L1 and narrowed to G1 and G6 in L3 — `V1-U-04` stays the assignment flow G2 had already deferred to G1, not a wider G2 redesign. The scope is established elsewhere and is not re-decided here: [`odd/tasks/v1-produccion.md`](v1-produccion.md) G1 (`V1-D-01`…`V1-D-05`, with `V1-U-04`), G6 (`V1-P-01`…`V1-P-07`) and `V1-F-09`, plus [`odd/plan-produccion/16-producto-mandante.md`](../plan-produccion/16-producto-mandante.md) for the destinations those rows do not carry. Every task below produces **prototypes only** — no production rewrite, no behavior change, no new endpoint, no contract change, no role policy and no sign-in or authorization change.
**State:** T1's source-backed baseline exists under `design/` (`system.md` and `system.html`); T2–T4 stay pending, the four rows keep `Route = worker` and `commit: pending`, and no direction board exists yet.
**Delivery:** authored lines are forecast **over 400** once the design documents land (T2 alone is three directions). The expected shape is one branch with commits per direction, sliced by direction rather than by file, and an **ask-on-risk** decision with the responsible before any slice beyond the ~400-line review budget is published. This document grants **no** merge, no tag and no publication.

## Specs

**S1 — Pedido, primer párrafo, textual.**

> excelente, dale pasemos todo al gentle-design al menos ya sabemos que es lo que necesitamos

**S2 — Pedido, segundo párrafo, textual.**

> realmente si me gustaría hacer todo de nuevo, ví los front de otros participantes y si bien nuestro sistema es el más solido, es el que peor front tenemos, o almenos comparado con el que ví, así que realmente me gustaría ponerle más color a todo esto del diseño del front y si es necesario rehacer todo de nuevo lo hacemos total ya sabemos el stack a utilizar

**S3 — Alcance de los grupos, textual (corrige L2).**

> g1 como g6 disculpa me confundi

Consecuencia, y solo esta: los grupos de este documento son **G1 y G6**. El selector y la visualización del responsable siguen dentro por `V1-U-04`, que G2 ya había diferido a G1, y por nada más. `PM-15` sigue bloqueada por D-C y esta Spec no fija política de roles ni toca el alta de `analista`; `V1-F-09` conserva su alcance de accesibilidad declarada.

## Tasks

| ID | Task | S# | Route | Commit |
| --- | --- | --- | --- | --- |
| T1 | Sync the baseline from the active frontend only: read `frontend/src/app/routes.ts`, `frontend/src/components/Shell.tsx`, `frontend/src/styles/tokens.css` and the mounted views, and record what each screen is for — no assumption taken from the withdrawn designs under `odd/urgent/rediseno-pagina/`. | S1 | worker | pending |
| T2 | Produce three distinct, more colorful visual directions for Territory — the `#overview` route labelled «Territorio» at `frontend/src/app/routes.ts:23`, rendered by `frontend/src/views/OverviewView.tsx` — and for the Actions/responsible picker flow (`frontend/src/views/ActionsView.tsx`, `V1-U-04`), each direction showing the responsible selector, the assigned responsible as displayed, the unassigned case and the directory-failure case; the three must be mutually distinguishable, not three shades of one. | S1, S2, S3 | worker | pending |
| T3 | Extend the selected direction to the existing v1 screens, entry (`frontend/src/views/AuthView.tsx`), the transitional `frontend/src/views/PendingView.tsx`, and the home screen of each of the seven `V1-P` capabilities — `V1-P-01` coverage and environment by sector, `V1-P-02` context and priority by sector, `V1-P-03` the four action states, `V1-P-04` history of all zones, `V1-P-05` record review plus quality findings, `V1-P-06` publish/advance/re-evaluate, `V1-P-07` actor with free detail and event id — so each is designed where it will actually live and not as a `PendingView` row, without changing behavior, role policy, sign-in or authorization, or the identifiers and accessible names the current tests pin. | S1, S2, S3 | worker | pending |
| T4 | Prototype the new v1 destinations and their supporting flows that G6 does not already own, document exports included (CSV `PM-13`, zone PDF `PM-14`), labelling every unavailable or synthetic datum in the visible text. | S1, S2, S3 | worker | pending |

## Log

- **L1 (2026-11-20) — El pedido, completo y verbatim.** Mensaje del responsable que autoriza este documento, con su salto de párrafo:

  > excelente, dale pasemos todo al gentle-design al menos ya sabemos que es lo que necesitamos
  >
  > realmente si me gustaría hacer todo de nuevo, ví los front de otros participantes y si bien nuestro sistema es el más solido, es el que peor front tenemos, o almenos comparado con el que ví, así que realmente me gustaría ponerle más color a todo esto del diseño del front y si es necesario rehacer todo de nuevo lo hacemos total ya sabemos el stack a utilizar

  Consecuencia registrada, y nada más: este documento existe y sus cuatro tareas están pendientes. No hay artefacto de diseño, no se ejecutó prueba ni compilación, no se tocó `frontend/src/` ni ningún plan previo; la fila de `V1-U-04` en [`odd/tasks/v1-produccion.md`](v1-produccion.md) conserva su texto, su estado y su criterio.

- **L2 (2026-11-20) — Ampliación de alcance registrada, verbatim, y superada por L3.**

  > lo sumamos a este plan de diseño tanto g1 como g2, as;i los diseñamos altiro

  Se registra por lo que dice y no por lo que un lector querría que dijera: nombra G1 y G2. Quedó superada en el turno siguiente por L3, antes de que existiera ningún artefacto de diseño, así que este documento **no** contiene Specs, filas ni diseño alguno derivado de la parte de G2 que L2 nombraba: no hay selector de rol, ni matriz de permisos, ni atribución de actor de `PM-06`, ni alta de `analista`. Lo único que sobrevive de ese turno es `S3`, que es la corrección.

- **L3 (2026-11-20) — Corrección del alcance: G1 y G6, verbatim.**

  > g1 como g6 disculpa me confundi

  Consecuencia registrada: el alcance queda en **G1 y G6**, y `S3` es la cita vigente de ese alcance. G2 no entra por esta vía; lo único de G2 que sigue aquí es `V1-U-04`, el selector y la visualización del responsable, que G2 ya había diferido a G1 por L12 de [`odd/tasks/v1-produccion.md`](v1-produccion.md) y cuya fila sigue abierta con su criterio intacto. `PM-15` sigue bloqueada por D-C y ningún prototipo define el rol `analista`, su matriz de acceso ni su alta; tampoco se diseña un cambio de inicio de sesión ni de autorización.
  - **Qué cubre G6 en este documento.** Los siete casos `V1-P-01`…`V1-P-07` reciben destino de diseño en su pantalla de origen dentro de `T3`, además de la `PendingView` transitoria. Diseñar el destino **no** cierra ninguna de las siete filas: sacar una entrada de `NOT_IMPLEMENTED` en producción exige el criterio de su fila en [`odd/tasks/v1-produccion.md`](v1-produccion.md), y este documento no lo declara cumplido.
  - **Qué sigue fuera.** Cualquier comportamiento nuevo: no se crea endpoint, no se toca contrato, no se modifica `viewer` ni `admin`, y ningún prototipo se publica como implementación.

- **L4 (2026-11-20) — Bootstrap del tracker, verificado por estructura y no por comportamiento.** Base `4acbad7`, árbol limpio antes de escribir.
  - **Excepción de test-first, declarada.** No hay RED/GREEN de comportamiento: el único cambio es un documento nuevo de seguimiento y ningún archivo ejecutable, contrato, vista o política de rol se toca. Un test de comportamiento antes de la implementación no existiría para nada; el sustituto son las comprobaciones de estructura y de igualdad literal que siguen, más la prueba de que no hay delta ajeno.
  - **RED observado.** Antes de escribir, la comprobación de estructura sobre `odd/tasks/v1-gentle-design.md` salió con código 1 y una sola línea, `MISSING: odd/tasks/v1-gentle-design.md`.
  - **GREEN observado.** Con el archivo escrito, la misma comprobación sale con código 0 y `STRUCTURE CHECK: PASS`: encabezado de título más tres líneas, secciones `Specs`, `Tasks` y `Log` en ese orden con `Log` al final, exactamente tres specs `S1`/`S2`/`S3`, exactamente cuatro filas de tarea de una sola línea con celdas `T1`–`T4`, `S#`, `Route = worker` y `Commit = pending`, sin tabulaciones, sin retornos de carro y sin espacios al final de línea.
  - **Igualdad literal, no parecido.** Los dos párrafos de L1, la cita de L2, la cita de L3 y las tres citas de `S1`, `S2` y `S3` se compararon carácter por carácter contra el texto del responsable: los cinco pares son idénticos, incluidos `ví`, `más`, `solido` sin tilde como se escribió, `almenos`, el `as;i` literal de L2, el `disculpa me confundi` sin coma de L3 y el salto de párrafo entre las dos partes de L1. `S3` es la cita de L3 y no la de L2: la de L2 se conserva solo en el Log.
  - **Rutas y archivos enlazados.** Los nueve caminos citados existen en el árbol: `odd/tasks/v1-produccion.md`, `odd/plan-produccion/16-producto-mandante.md`, `frontend/src/app/routes.ts`, `frontend/src/styles/tokens.css`, `frontend/src/components/Shell.tsx`, `frontend/src/views/OverviewView.tsx`, `frontend/src/views/ActionsView.tsx`, `frontend/src/views/PendingView.tsx` y `frontend/src/views/AuthView.tsx`.
  - **Nada ajeno se movió.** `git status --porcelain` devuelve solo `?? odd/tasks/v1-gentle-design.md`; el hash de objeto de `odd/tasks/v1-produccion.md` es `cd043cf6de7a325c2d2ae5cc2d956b6cc5007367` antes y después, y el de `odd/plan-produccion/16-producto-mandante.md` `0a1721658635b58e444329e5ed4a97aa8c3bdbaa` antes y después; `git diff --check` sale con código 0 y `python -B odd/tools/check_md_links.py` cierra con `BROKEN: 0`.
  - **Límites.** No se ejecutó `npm`, ni `tsc`, ni una compilación, ni nada en el navegador: este registro no tiene comportamiento que probar. No se creó `design/`, que no existe en el árbol, y no se creó ni se modificó ningún artefacto de diseño. Ningún commit, `git add`, `push` ni PR.

- **L5 (2026-11-20) — Sincronización de T1: línea base tomada solo del frontend activo, verificada de forma determinista.** Ejecuta T1 y nada más: no hay tableros de dirección, no se abrió el canvas y no se tocó comportamiento, política de roles, inicio de sesión ni autorización.
  - **Fuentes leídas.** `frontend/src/styles/tokens.css` (las 27 propiedades), `frontend/src/styles/app.css`, `frontend/src/styles/auth.css`, `frontend/src/app/routes.ts`, `frontend/src/components/Shell.tsx`, `frontend/src/components/ui.tsx`, `frontend/src/App.tsx`, `frontend/src/views/AuthView.tsx` y las vistas montadas, más `frontend/index.html`. No se abrió ningún archivo de `odd/urgent/rediseno-pagina/referencia-mockup/`: de esos dos snapshots históricos solo se observaron las rutas y quedan excluidos como fuente, según el alcance aprobado.
  - **Resultado contado.** 27 variables CSS personalizadas declaradas: 14 de paleta, 10 de nivel y 3 de estructura. No hay otro archivo de tokens ni bloque `@theme` en el frontend activo. Los valores quedaron copiados tal cual, incluido `--shadow` y la pila `--font`; ninguno se propone cambiar.
  - **Lo que las fuentes no tienen y quedó declarado como ausente.** No hay escala tipográfica, ni escala de espaciado, ni tokens de z-index: los tamaños, pesos, paddings, gaps y radios literales se registraron como valores en uso con su selector de origen, no como tokens. Inter está declarada en `--font` pero no se carga: no hay `@font-face`, `@import`, paquete ni enlace de fuente en el frontend activo, así que el producto y el tablero renderizan con las fuentes del sistema.
  - **Artefactos nuevos.** `design/system.md` documenta las 27 variables en tablas con nombre y valor respaldados, tipografía y espaciado realmente en uso, radios, sombras, superficies literales, reglas de componentes, las cinco etiquetas de riesgo, 35 pares de contraste medidos y el inventario de las ocho rutas más AUTH. `design/system.html` es un tablero autónomo de 1440 px, sin assets, fuentes, scripts ni URLs externas, con etiquetas visibles en español y foco, landmarks y movimiento reducido.
  - **Riesgo y contraste.** Las etiquetas `BAJO`, `MEDIO`, `ALTO`, `INFORMACIÓN INSUFICIENTE` y `Sin evaluación para esta zona` se reproducen como texto, nunca solo como color. Los ratios se calcularon desde los hex declarados. Hallazgos registrados y no corregidos: el chip base mide 4.36:1, la etiqueta neutral 4.27:1 y el anillo de foco 2.86:1 sobre el canvas; casi todos los rellenos de nivel quedan bajo 3:1 contra la superficie del mapa y el relleno alto no admite texto normal encima. Son mediciones, no una certificación WCAG AA.
  - **RED observado.** Antes de escribir, la comprobación determinista de T1 salió con código 1 y dos líneas: `MISSING: design/system.md` y `MISSING: design/system.html`.
  - **GREEN observado.** Con los dos artefactos escritos y este registro, la misma comprobación sale con código 0: las 46 comprobaciones pasan. Incluye correspondencia exacta de las 27 variables entre `tokens.css`, las filas de `system.md` y las declaraciones de `system.html`, los 35 ratios recalculados presentes en ambos artefactos, ausencia de URL y asset externo, un solo `h1`, landmarks, `:focus-visible`, `prefers-reduced-motion`, enlaces internos con destino existente, cinco etiquetas de riesgo, rutas y AUTH inventariados, y árbol de trabajo limitado a los tres archivos permitidos.
  - **Frontend intacto.** `git status --porcelain --untracked-files=all` devuelve solo `?? design/system.md`, `?? design/system.html` y `?? odd/tasks/v1-gentle-design.md`; `git diff --stat` está vacío; `python -B odd/tools/check_md_links.py` cierra con `BROKEN: 0`; `git diff --check` sale con código 0. Los objetos de `odd/tasks/v1-produccion.md` (`cd043cf6…`) y `odd/plan-produccion/16-producto-mandante.md` (`0a172165…`) siguen idénticos a L4.
  - **Límites.** No se abrió navegador, no se tomó captura y no hubo inspección visual del tablero: la revisión fue estructural, de valores y de contraste calculado. No se ejecutó `npm`, `tsc`, compilación ni prueba de comportamiento, porque T1 no cambia código ejecutable. No hay tableros de dirección, canvas abierto, commit ni `git add`: el commit de T1 queda **commit: pending** hasta que el flujo principal haga sus comprobaciones.
