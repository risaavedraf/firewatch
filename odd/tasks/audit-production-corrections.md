# Correcciones de producción — auditoría de despliegue

**Estado:** bootstrap del plan — 2026-11-17. Ninguna tarea iniciada; ningún archivo fuente tocado.
**Origen:** auditoría de 23 hallazgos (H1–H23) sobre el camino de despliegue. Este documento fija alcance, citas y orden; no implementa.
**Base:** rama `docs/audit-deploy-gates` en `9e05b51`.
**Tareas:** 7 (T1–T7). **PRs autorizados:** 4 (A, B, H9–H14, H5).

## Specs

**S1 — Bloque A, primero y en un PR propio.** «Bloque A — primero, sin esperar nada. H1 (precondición de la CA en el runbook, separando CA nueva deliberada de reutilización y verificando el par contra el Secret), H2 (el `401` es ruteo, no verificación TLS: añadir control negativo y comparación de huella) y H7 + el matiz de kindnet. Son los tres que pueden quemar a alguien mañana. Un PR propio.»

**S2 — Bloque B y H9–H14, en PRs distintos.** «Bloque B — después. H3 (OpenAPI: los dos 502 distintos), H4 (el informe se subestima: siete mapeos, no dos), H6 (scheduler e inferencia ya cableados), H8 (handoff del administrador con usuario **y** contraseña). Otro PR.» La enmienda posterior: «**B** (H3, H4, H6, H8) **y H9–H14**, en la misma wave editorial pero en **PRs distintos**. […] Separa B de 9-14 para que cada PR se revise solo, pero cierra los dos en esta pasada.»

**S3 — Bloque C: propuesta, luego solo H5.** «Bloque C — no lo escribas todavía. Los 10 «ausentes» son trabajo editorial sobre 15 frentes y el plan es entregable. **Propón al humano un desglose frente por frente con esfuerzo estimado** y espera su alcance. El que más urge es H5: `prevention` consume `KEYCLOAK_ADMIN_URL`, `DIRECTORY_CLIENT_ID` y `DIRECTORY_CLIENT_SECRET` (`cmd/server/main.go:96-99`) y ni `base/workloads.yaml:267-280` ni `bootstrap-secrets.sh:341` los inyectan; eso explica el 503 de `/v1/users`.» La enmienda posterior: «**C — solo H5** ahora: frentes 03 y 11, la dependencia de directorio de `prevention`. Estrictamente documental. El resto de C queda esperando tu desglose y una segunda decisión del humano.» Y el cierre: «**H5 va solo.** H18 queda **fuera** de esta wave, aunque comparta archivo con H5 (`odd/plan-produccion/03-prevention.md`). […] C completo —los otros nueve ausentes **y** H18— se difiere a una sesión distinta».

**S4 — Un hallazgo, una cita, una prueba.** «**Un hallazgo, una cita, una prueba.** No agrupes correcciones de archivos distintos sin decirlo en el cuerpo del PR.» «**No reescribas documentos enteros.** Cada arreglo dice qué línea está mal y qué debería decir. Si un frente entero está desalineado, es propuesta de alcance, no edición sorpresa.» «**Nada de afirmaciones absolutas sin clúster.** «Pendiente de prueba en la VM» es una frase válida; «funciona» no lo es.» «**Terceros se verifican en su fuente**, como hiciste con kind.» «`60d674e` es un callejón sin salida con una premisa falsa sobre kubeadm. No lo cites como verdad en ningún documento nuevo.»

**S5 — Flujo del repo y autorización de merge.** «**Flujo del repo:** rama `tipo/descripcion`, Conventional Commits sin `Co-Authored-By`, PR contra `main` con la plantilla completa, exactamente un label `type:*`, e **issue con `status:approved`** antes de abrir el PR (es lo que exige `.github/PULL_REQUEST_TEMPLATE.md`; si el arreglo cuelga del #77 o del #76, `Refs` alcanza). Espera `checks` y `compose` en verde antes de mergear; `main` no tiene branch protection, así que el verde es tu única red.» «Nada de fuerza, nada de `main` directo.» La autorización posterior: «Puedes mergear tus propios PR de estos bloques cuando `checks` y `compose` estén en verde, con merge commit, igual que se hizo con #78, #76 y #79. Si un check falla, no mergeas: me lo reportas con el log.»

**S6 — Reporte por PR y cierre de wave.** «Un mensaje por bloque cerrado: PR, archivos tocados, qué hallazgos cubre cada uno, y qué quedó **sin verificar** y por qué.» «Uno por PR, con: número de PR, rama, archivos tocados, qué hallazgos cubre cada uno por ID, el SHA del merge cuando ocurra, y **qué quedó sin verificar y por qué**. Sin prosa que suavice: si algo estaba mal, se dice que estaba mal.» Al cerrar los cuatro PR: «paras y me reportas. No abras frentes nuevos, no propongas el siguiente bloque, no empieces C.» El reporte final debe anotar «los hallazgos que quedaron cubiertos, por ID», los diferidos «H18 y los otros nueve ausentes» con la frase «diferidos a la wave editorial de C», y «cualquier cosa que hayas descubierto al escribir y que no esté en tu informe original».

## Releases y PRs

| Release | Tareas | Hallazgos | PR | Rama | Base | Estado |
| --- | --- | --- | --- | --- | --- | --- |
| **A** | T1, T2 | H1, H2, H7 + matiz kindnet | 1 PR propio | `docs/audit-deploy-gates` | `9e05b51` | Pendiente |
| **B** | T3, T4, T5 | H3, H4, H6, H8 | 1 PR propio | `docs/audit-production-b` | `main` tras A | Pendiente |
| **H9–H14** | T6 | H9–H14 | 1 PR propio, separado de B | `docs/audit-status-claims` | `main` tras A | Pendiente |
| **H5** | T7 | H5 solamente | 1 PR propio | `docs/prevention-directory-gap` | `main` tras A | Pendiente |
| **C — resto** | — | H15–H23 (incluye H18) | Ninguno | — | — | Bloqueado; propuesta-only |

**Orden.** A primero. B, H9–H14 y H5 después, cada uno contra `main` actualizado tras el merge de A. No se apilan ramas salvo que un conflicto real lo exija; los archivos de A y B se cruzan solo en `DEPLOY-GKE.md` (T1/T5), y A se mergea antes.

## Tasks

| ID | Release | Hallazgo(s) | Superficie permitida | Estado |
| --- | --- | --- | --- | --- |
| T1 | A | H1, H2 | `backend/deploy/k8s/DEPLOY-GKE.md` | Pendiente — bootstrap |
| T2 | A | H7 + matiz kindnet | `backend/deploy/k8s/overlays/pitch/README.md` | Pendiente — bootstrap |
| T3 | B | H3 | `backend/contracts/openapi/firewatch-v1.yaml`, `odd/plan-produccion/10-openapi-contract-tests.md` | Pendiente — bootstrap |
| T4 | B | H4, H6 | `odd/entrega/informe-datos-y-modelo.md`, `odd/plan-produccion/01-ingesta-scheduler.md`, `odd/plan-produccion/02-modelo-inferencia.md` | Pendiente — bootstrap |
| T5 | B | H8 | `backend/deploy/k8s/DEPLOY-GKE.md` | Pendiente — bootstrap |
| T6 | H9–H14 | H9–H14 | `odd/plan-produccion/06-autoscaling-carga-slo.md`, `09-login-browser-a11y.md`, `12-evaluacion-cientifica.md` y los documentos de H12–H14 que confirme la auditoría | Pendiente — bootstrap |
| T7 | H5 | H5 solamente | `odd/plan-produccion/03-prevention.md`, `odd/plan-produccion/11-hardening-bh.md` | Pendiente — bootstrap |

**T7 no toca H18.** Aunque H18 comparta `odd/plan-produccion/03-prevention.md`, no se edita «porque ya estamos en el archivo»: el frente 03 recibirá una segunda pasada en la wave diferida. En T7 solo se documenta H5.

**Ninguna tarea se marca hecha en este bootstrap.** Las casillas de implementación quedan sin marcar hasta que exista PR, check y merge.

## Hallazgos y correcciones

### A — T1: H1, H2 en `DEPLOY-GKE.md`

**H1 — La precondición de la CA no distingue autoridad nueva de reutilización.**
- **Cita rota:** `backend/deploy/k8s/DEPLOY-GKE.md:317` valida solo `test -s` sobre `${FIREWATCH_CA_KEY:-$HOME/.firewatch-internal-ca/ca.key}`. `backend/deploy/k8s/bootstrap-secrets.sh:146-165` toma el camino `else` cuando no existe `firewatch-ca`, genera una CA nueva y hace `cp "$workdir/ca.key" "$ca_key_file"` sobre la ruta recibida. El camino de reutilización (`:146-151`) nunca compara la clave local con el `ca.crt` del Secret.
- **Qué está mal:** el runbook puede destruir la autoridad aportada creyendo que la reutiliza. `test -s` prueba que hay un archivo, no que sea la clave de la CA del clúster.
- **Corrección:** separar en 4.1 dos precondiciones explícitas. (a) **Reutilización:** `firewatch-ca` existe; exigir `$FIREWATCH_CA_KEY`, derivar su clave pública y compararla con la del `ca.crt` leído del Secret; si no coinciden, parar y no ejecutar el bootstrap. (b) **CA nueva deliberada:** `firewatch-ca` no existe; exigir una confirmación explícita del operador y un respaldo/ausencia de la clave en la ruta; decir que se creará una autoridad nueva y que eso invalida la anterior. El runbook no cambia el script: el guard del script queda como riesgo declarado, no como edición de esta wave.
- **Evidencia:** `bootstrap-secrets.sh:152-165`; `DEPLOY-GKE.md:317`; la propia precondición de `DEPLOY-GKE.md:45` ya nombra el riesgo, pero 4.1 no lo convierte en compuerta.

**H2 — El `401` prueba ruteo, no verificación TLS.**
- **Cita rota:** `backend/deploy/k8s/DEPLOY-GKE.md:567-581` afirma que el `401` es «the only cheap proof that the hop is *verified* and not merely encrypted».
- **Qué está mal:** el `401` lo produce el gateway; prueba que la petición atravesó el Ingress y llegó al gateway, no que el Ingress haya verificado el certificado del upstream. Un `proxy_ssl_verify` apagado también devuelve `401`.
- **Corrección:** renombrar 6.3 a una compuerta de ruteo (`401`) y añadir dos pruebas separadas: (a) **control negativo** con un ancla incorrecta —cambiar `proxy-ssl-secret` a un Secret desechable con la CA equivocada, observar `502` con `upstream SSL certificate verify error: (21:unable to verify the first certificate)`, restaurar y volver a observar `401`—; (b) **comparación de huella** —SHA-256 del certificado que sirve `gateway:8443` desde dentro del clúster contra el SHA-256 del certificado de `gateway-tls`/el que el Ingress declara como ancla—. 6.4 sigue siendo la comprobación del certificado público del borde.
- **Evidencia:** `base/ingress.yaml:14-37`; `DEPLOY-GKE.md:567-590`; el `502` de ancla equivocada ya está descrito en `:585`, pero hoy se lee como diagnóstico, no como control negativo obligatorio.

### A — T2: H7 y matiz kindnet en `overlays/pitch/README.md`

**H7 — La sonda de NetworkPolicy no pasa la admisión `restricted`, y la frase sobre kindnet promete más que la evidencia.**
- **Cita rota:** `backend/deploy/k8s/base/namespace.yaml:5-6` declara `pod-security.kubernetes.io/enforce: restricted`. `backend/deploy/k8s/overlays/pitch/README.md:123` crea `netpol-probe` con `busybox` y ningún `securityContext`; la admisión lo rechaza antes de probar la política. La línea `:102` dice «en este clúster esas políticas se cumplen».
- **Qué está mal:** (a) la sonda no llega a ejecutarse, así que no prueba nada; (b) «se cumplen» es más fuerte que la evidencia: kindnet las soporta, pero la aplicación efectiva no se midió en la VM.
- **Corrección:** (a) reemplazar la frase por «kindnet las soporta; aplicación efectiva pendiente de prueba en la VM»; (b) hacer la sonda admisible con `securityContext` explícito —`runAsNonRoot: true`, `runAsUser` no root, `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, `capabilities.drop: [ALL]`, `seccompProfile.type: RuntimeDefault`— y usarla desde un manifiesto o `--overrides`, no desde los flags de `kubectl run`; (c) distinguir rechazo de admisión (`Forbidden`) de timeout de red, para que un `exit≠0` por admisión no se lea como política aplicada; (d) conservar «Lo que no se ha ejecutado» y mantener la prueba como pendiente de la VM.
- **Evidencia:** `namespace.yaml:5-6`; `overlays/pitch/README.md:99-135`; la sonda actual no declara `securityContext` en ninguno de sus argumentos.

### B — T3: H3 en OpenAPI y frente 10

**H3 — Los dos `502` son capas distintas y el contrato los confunde.**
- **Cita rota:** `backend/contracts/openapi/firewatch-v1.yaml:677` declara `502` como `UpstreamUnavailable`, pero la descripción de la misma operación (`:693`) promete `502 directory_upstream_failed`. `UpstreamUnavailable` (`:1407`) es el fallo de transporte del gateway; `DirectoryUpstreamFailed` (`:1446`) es el fallo del directorio de `prevention`. `/v1/users` (`:1315`) sí usa el segundo.
- **Qué está mal:** un solo `$ref` no puede describir los dos `502`; el lector del contrato no sabe si el `code` es `upstream_unavailable` o `directory_upstream_failed`.
- **Corrección:** en las operaciones que consultan el directorio, declarar ambos códigos —o una respuesta compuesta que nombre la capa— y dejar explícito que el `502` del gateway y el `502` de `prevention` son distintos. En `odd/plan-produccion/10-openapi-contract-tests.md`, registrar la distinción y la comprobación. Si la corrección exige regenerar `contracts/gen` o cambiar handlers, **parar**: eso es código, no esta wave.
- **Evidencia:** `firewatch-v1.yaml:677,693,1315,1407,1446`; `backend/services/prevention/internal/handler/api.go:229`; `backend/services/prevention/internal/handler/users.go:73`.

### B — T4: H4 y H6

**H4 — El informe subestima el cableado: siete mapeos, no dos.**
- **Cita rota:** `odd/entrega/informe-datos-y-modelo.md:125` dice que el camino de publicación «solo puede poblar 2 de las 7 variables del contrato».
- **Qué está mal:** confunde «mapeado» con «medido». `backend/services/risk/internal/classify/inference.go:799-853` declara los siete mapeos (`temp_max`, `temp_min`, `humidity_rel`, `wind_speed`, `wind_dir`, `precip_sum`, `radiation_sol`); `backend/services/risk/internal/features/features.go:24-31,150-174` construye el vector completo con cuatro lecturas instantáneas y tres agregados del historial. Un valor es nulo solo cuando la ventana no alcanza, y entonces el artefacto lo imputa.
- **Corrección:** decir «siete mapeos; el vector se construye entero —cuatro lecturas instantáneas y tres agregados— y un valor es nulo solo si la ventana no alcanza, con imputación registrada». No afirmar que las siete tienen valor medido en producción.
- **Evidencia:** `inference.go:799-853`; `features.go:24-31,150-174`; `inference.go:84` ya enumera las siete características del artefacto.

**H6 — Scheduler e inferencia ya están cableados; falta la prueba viva, no el cable.**
- **Cita rota:** `odd/plan-produccion/01-ingesta-scheduler.md:4,47` y `odd/plan-produccion/02-modelo-inferencia.md:4` dejan el estado en «pendiente» sin distinguir el cableado de la prueba viva; `backend/docs/verification.md:101` sigue listando el scheduler y la inferencia real como no cubiertos sin decir que el cable existe.
- **Qué está mal:** el scheduler corre cada 15 min (`backend/services/risk/internal/cycle/runner.go:23-25,249-268`) y `risk` lo arranca (`backend/services/risk/cmd/server/main.go:245-249`). La inferencia está desplegada (`backend/deploy/k8s/base/inference.yaml`) y `risk` la alcanza por `INFERENCE_URL` (`backend/deploy/k8s/base/config.yaml:31`). Lo que falta es la evidencia end-to-end con datos reales y modelo aprobado, no el cableado.
- **Corrección:** actualizar los estados y criterios de los frentes 01 y 02: «cableado; prueba viva y datos/modelo reales pendientes». Mantener el límite de que no hay modelo entrenado aprobado ni fuente real.
- **Evidencia:** `runner.go:23-25,249-268`; `risk/cmd/server/main.go:245-249`; `base/inference.yaml`; `base/config.yaml:31`.

### B — T5: H8 en `DEPLOY-GKE.md`

**H8 — El handoff del administrador entrega usuario, no contraseña.**
- **Cita rota:** `backend/deploy/k8s/DEPLOY-GKE.md:366-372` lee solo `KC_BOOTSTRAP_ADMIN_USERNAME` y dice «hand it over».
- **Qué está mal:** el Secret `keycloak-bootstrap-admin` contiene `KC_BOOTSTRAP_ADMIN_USERNAME` y `KC_BOOTSTRAP_ADMIN_PASSWORD` (`bootstrap-secrets.sh:291-293`; `base/keycloak.yaml:114-123`). Sin la contraseña, el receptor no puede iniciar sesión para crear el realm.
- **Corrección:** leer y decodificar **ambas** claves del Secret, entregar usuario **y** contraseña, y declarar que solo son válidas en el primer arranque contra una base `identity` vacía. No escribirlas en el repositorio. Añadir la compuerta: si falta cualquiera de las dos, no continuar a la prueba autenticada.
- **Evidencia:** `DEPLOY-GKE.md:366-372`; `bootstrap-secrets.sh:291-293`; `base/keycloak.yaml:114-123`.

### T6 — H9–H14: seis afirmaciones de estado falsas

La auditoría numera seis afirmaciones que un lector tomaría como estado vigente y que el repositorio desmiente. Se corrigen en un PR propio, solo documentación. Las tres que el pedido transcribe:

**H9 — El HPA ya está definido y medido.** `odd/plan-produccion/06-autoscaling-carga-slo.md:50` dice «el path de HPA debe determinarse». `backend/deploy/k8s/base/autoscaling.yaml` define cuatro HPA y `odd/tasks/k8s-delivery-closure.md` L5/L8 registra el escalado de `gateway` de 2 a 6 con `SuccessfulRescale`. Corrección: «HPA definido y escalado observado en clúster local; carga, SLO y RTO siguen pendientes». No convertir el escalado local en prueba de producción.

**H10 — La ciencia no está bloqueada para ensayar.** `odd/plan-produccion/12-evaluacion-cientifica.md:4,28-36` dice «Bloqueado para acreditar» y marca las cinco tareas como bloqueadas. `odd/entrega/informe-datos-y-modelo.md` registra un ensayo medido con dos modelos y dos líneas base sobre 90 días. Corrección: «bloqueado para acreditar, no para ensayar; el ensayo existe y no cierra los IDs». Mantener que no hay datos reales ni modelo aprobado.

**H11 — El login live ya se midió.** `odd/plan-produccion/09-login-browser-a11y.md:39` dice «falta prueba live». `odd/tasks/presentation-client-ready.md` L14/L18/L23 y `odd/tasks/README.md` (frente 9) registran login/logout con Keycloak vivo, 390 px, teclado y contraste. Corrección: «login live medido; faltan certificación WCAG y lector de pantalla». No declarar accesibilidad certificada.

**H12–H14.** Son las otras tres afirmaciones de estado que la auditoría numera. Antes de editar, transcribir cada una desde el informe de auditoría y verificar su cita `archivo:línea`; no se inventan aquí. Se corrigen en el mismo PR de T6, sin ampliar el alcance a código.

### T7 — H5: la dependencia de directorio de `prevention` (solo documentación)

**H5 — `prevention` no tiene configurado el directorio en Kubernetes.**
- **Cita rota:** `backend/services/prevention/cmd/server/main.go:96-99` construye el cliente de directorio con `KEYCLOAK_ADMIN_URL`, `KEYCLOAK_ADMIN_REALM`, `DIRECTORY_CLIENT_ID` y `DIRECTORY_CLIENT_SECRET`. `backend/deploy/k8s/base/workloads.yaml:267-280` no inyecta ninguna de esas cuatro variables: `prevention-runtime` solo trae `DATABASE_URL`, y el resto es `firewatch-config` y TLS. `backend/deploy/k8s/bootstrap-secrets.sh:276-278` crea `prevention-runtime` solo con `DATABASE_URL`, y `:341` lo dice.
- **Qué está mal:** el 503 de `/v1/users` está explicado por configuración ausente, no por un fallo del código. Los frentes 03 y 11 no lo declaran y pueden leerse como servicio completo.
- **Corrección:** en `odd/plan-produccion/03-prevention.md` y `odd/plan-produccion/11-hardening-bh.md`, declarar la dependencia: el cliente de directorio queda sin configurar en Kubernetes; `GET /v1/users` responde `503 directory_unavailable` hasta que se inyecten las cuatro variables; el arreglo de cableado es otro frente y no se hace aquí. En el frente 03, una sola pasada sobre H5; **H18 no se toca**.
- **Evidencia:** `cmd/server/main.go:96-99`; `base/workloads.yaml:267-280`; `bootstrap-secrets.sh:276-278,341`; `backend/services/prevention/internal/handler/users.go:45,73`.

### C — diferido

Los IDs **H15–H23** (incluye **H18**) quedan **diferidos a la wave editorial de C**. No se escriben, no se propone su desglose en esta wave y no se tocan aunque compartan archivo con H5. El humano coordinará esa wave por separado.

## Verificación test-first

**Excepción documentada para este bootstrap.** Este artefacto es editorial y no tiene comportamiento ejecutable; no existe un test de comportamiento que pueda fallar antes de escribirlo. Por eso:
- **RED:** no activo — no hay comportamiento que observar.
- **GREEN:** el artefacto existe, contiene T1–T7 y las tres entradas L1/L2/L3; se comprueba con presencia/conteo y con el verificador de enlaces.
- **PRESERVE:** `python -B odd/tools/check_md_links.py` informa `BROKEN: 0`; `git diff --check` no informa errores.

**Protocolo para cada PR editorial.** No se inventan tests de comportamiento; se usa una aserción documental verificable:
- **RED:** antes de editar, `grep -n` reproduce la cita rota exacta en el archivo citado. Se registra la línea observada en el cuerpo del PR.
- **GREEN:** después de editar, la cita rota ya no aparece y la corrección sí; `python -B odd/tools/check_md_links.py` sigue en `BROKEN: 0`.
- **PRESERVE:** `git diff --name-only` solo muestra las superficies permitidas; no se tocaron manifiestos, scripts ni código. `bash backend/deploy/k8s/tests/render-contract.sh` no es aplicable porque no se editan manifiestos; si se editara un manifiesto, sería obligatorio.
- **T3 (YAML):** no aplica un check Markdown al contrato. La comprobación es `cd backend && go run github.com/getkin/kin-openapi/cmd/validate@v0.133.0 contracts/openapi/firewatch-v1.yaml` (el comando de `.github/workflows/integration.yml:36-37`), más el verificador de enlaces para el frente 10.
- **Excepción editorial:** cuando la corrección sea solo prosa sin aserción ejecutable, RED es la cita falsa reproducida y GREEN es la cita corregida más el verificador de enlaces; no se simula un test de comportamiento.

## Protocolo de PR

- **A:** rama `docs/audit-deploy-gates`, base `9e05b51`; `Refs #56` y `Refs #77` (ambos conservan `status:approved`). **#76 queda fuera.**
- **B, H9–H14 y H5:** rama propia desde `main` actualizado tras A. Issue con `status:approved` antes de abrir; si el alcance cuelga de #56 o #77, `Refs` alcanza. No usar #76.
- **Label:** exactamente uno `type:docs` en cada PR. Si T3 deja de ser documental y exige regenerar contrato/código, se detiene y se reporta.
- **Commits:** Conventional Commits, sin `Co-Authored-By`.
- **Merge:** merge commit, solo con `checks` y `compose` en verde. Sin fuerza, sin `main` directo.
- **Cuerpo del PR:** cada afirmación sobre código cita `archivo:línea`; cada afirmación sobre terceros cita la fuente externa. Un hallazgo, una cita, una prueba. Si una corrección toca archivos distintos, se dice en el cuerpo.

## Cierre de wave

Al mergear los cuatro PRs, **parar** y reportar. No abrir frentes nuevos, no proponer el siguiente bloque, no iniciar C. El reporte final de la wave debe incluir:
1. Los hallazgos cubiertos, por ID.
2. Los diferidos **H15–H23** (incluye **H18**) con la frase «diferidos a la wave editorial de C».
3. Cualquier hallazgo nuevo descubierto al escribir que no esté en el informe original, con la nota de que no tiene dueño todavía.

## Log

### L1 — Pedido original (verbatim)

Decisión del humano: **tú quedas como orquestador de los arreglos** de los 23 hallazgos de tu auditoría. Yo salgo del camino de implementación y me quedo en coordinación y presentación.

## Qué te toca

Orquestar, priorizar y llevar a `main` las correcciones, con el flujo del repo. Verifiqué dos de tus hallazgos por mi cuenta y **los dos se sostienen**, así que arrancas con crédito:

- **H1 confirmado.** `bootstrap-secrets.sh:152-165`: el `else` genera CA nueva y hace `cp "$workdir/ca.key" "$ca_key_file"` sobre la ruta que recibe. El `test -s` de `DEPLOY-GKE.md:317` no valida correspondencia con el Secret. Se puede destruir la autoridad aportada creyendo que se reutiliza.
- **H7 confirmado.** `base/namespace.yaml:5-6` tiene `enforce: restricted`; la sonda que documenté en `overlays/pitch/README.md` se rechaza en admisión con un `busybox` sin `securityContext`. Es mi error, no el del parche original.

También me quedo con tu matiz sobre `kindnetd/main.go:211-244`: «esas políticas se cumplen» es más fuerte que la evidencia. Cambiar por «kindnet las soporta; aplicación efectiva pendiente de prueba en la VM».

## Orden que quiero

**Bloque A — primero, sin esperar nada.** H1 (precondición de la CA en el runbook, separando CA nueva deliberada de reutilización y verificando el par contra el Secret), H2 (el `401` es ruteo, no verificación TLS: añadir control negativo y comparación de huella) y H7 + el matiz de kindnet. Son los tres que pueden quemar a alguien mañana. Un PR propio.

**Bloque B — después.** H3 (OpenAPI: los dos 502 distintos), H4 (el informe se subestima: siete mapeos, no dos), H6 (scheduler e inferencia ya cableados), H8 (handoff del administrador con usuario **y** contraseña). Otro PR.

**Bloque C — no lo escribas todavía.** Los 10 «ausentes» son trabajo editorial sobre 15 frentes y el plan es entregable. **Propón al humano un desglose frente por frente con esfuerzo estimado** y espera su alcance. El que más urge es H5: `prevention` consume `KEYCLOAK_ADMIN_URL`, `DIRECTORY_CLIENT_ID` y `DIRECTORY_CLIENT_SECRET` (`cmd/server/main.go:96-99`) y ni `base/workloads.yaml:267-280` ni `bootstrap-secrets.sh:341` los inyectan; eso explica el 503 de `/v1/users`.

## Reglas de trabajo

1. **Un hallazgo, una cita, una prueba.** No agrupes correcciones de archivos distintos sin decirlo en el cuerpo del PR.
2. **No reescribas documentos enteros.** Cada arreglo dice qué línea está mal y qué debería decir. Si un frente entero está desalineado, es propuesta de alcance, no edición sorpresa.
3. **Nada de afirmaciones absolutas sin clúster.** «Pendiente de prueba en la VM» es una frase válida; «funciona» no lo es. El repo ya tiene sección «Lo que no se ha ejecutado»: úsala.
4. **Terceros se verifican en su fuente**, como hiciste con kind. Nada de «el consenso del review dice».
5. `60d674e` es un callejón sin salida con una premisa falsa sobre kubeadm. No lo cites como verdad en ningún documento nuevo.
6. **Flujo del repo:** rama `tipo/descripcion`, Conventional Commits sin `Co-Authored-By`, PR contra `main` con la plantilla completa, exactamente un label `type:*`, e **issue con `status:approved`** antes de abrir el PR (es lo que exige `.github/PULL_REQUEST_TEMPLATE.md`; si el arreglo cuelga del #77 o del #76, `Refs` alcanza). Espera `checks` y `compose` en verde antes de mergear; `main` no tiene branch protection, así que el verde es tu única red.
7. Nada de fuerza, nada de `main` directo.

## Qué necesito de vuelta

Un mensaje por bloque cerrado: PR, archivos tocados, qué hallazgos cubre cada uno, y qué quedó **sin verificar** y por qué. Y antes de tocar C, el desglose.

Ojo con una cosa: el humano está al tanto del error de kubeadm y del de netpol, así que no hace falta suavizar nada. Prefiere el reporte que dice «esto estaba mal» al que lo disuelve en prosa.

### L2 — Autorizado por el humano. Paquete completo, con un cambio en tu agrupación.

## Alcance aprobado

**A** — como lo tienes, ya corriendo en `docs/audit-deploy-gates`. H1, H2, H7 + el matiz de kindnet. `Refs #56` y `Refs #77` verificados: ambos conservan `status:approved`. #76 queda fuera, tienes razón en que es un PR.

**B** (H3, H4, H6, H8) **y H9–H14**, en la misma wave editorial pero en **PRs distintos**. El humano quiere que 9-14 no queden huérfanos: son seis afirmaciones falsas —HPA «debe determinarse» cuando ya está, ciencia «bloqueada» cuando hay un ensayo, login «falta prueba live» cuando T17 lo cerró— y un lector que cree eso decide peor que quien enfrenta un vacío. Separa B de 9-14 para que cada PR se revise solo, pero cierra los dos en esta pasada.

**C — solo H5** ahora: frentes 03 y 11, la dependencia de directorio de `prevention`. Estrictamente documental. El resto de C queda esperando tu desglose y una segunda decisión del humano.

## Autorización de entrega

Puedes mergear tus propios PR de estos bloques cuando `checks` y `compose` estén en verde, con merge commit, igual que se hizo con #78, #76 y #79. Si un check falla, no mergeas: me lo reportas con el log.

No hay autorización para nada fuera de estos bloques. Si al escribir descubres que un hallazgo exige tocar código de producción —cablear `KEYCLOAK_ADMIN_*`, el selector de frontend, cualquier cosa que cambie comportamiento— paras y me lo dices: eso es otro frente, no esta wave.

## Cómo quiero los reportes

Uno por PR, con: número de PR, rama, archivos tocados, qué hallazgos cubre cada uno por ID, el SHA del merge cuando ocurra, y **qué quedó sin verificar y por qué**. Sin prosa que suavice: si algo estaba mal, se dice que estaba mal.

Un detalle de método que quiero explícito en cada PR editorial: cuando corrijas una afirmación sobre el código, cita el `archivo:línea` que la respalda en el cuerpo del PR. Cuando la afirmación sea sobre terceros, la fuente externa. Es lo que hace que estos arreglos se puedan auditar después sin volver a discutirlos.

Arranca.

### L3 — Alcance cerrado, y una confirmación explícita para que no quede ambiguo.

**H5 va solo.** H18 queda **fuera** de esta wave, aunque comparta archivo con H5 (`odd/plan-produccion/03-prevention.md`). Decisión del humano: C completo —los otros nueve ausentes **y** H18— se difiere a una sesión distinta que arrancará cuando termine todo el trabajo actual, no ahora. No lo incluyas «porque ya estás en el archivo»: el frente 03 recibirá una segunda pasada más adelante y así está decidido.

**Tus cuatro PR autorizados quedan como estaban:** A, B, H9–H14 y H5 documental en 03 y 11. Nada más.

**Cuando cierres los cuatro, paras y me reportas.** No abras frentes nuevos, no propongas el siguiente bloque, no empieces C. Yo coordino el arranque de la wave diferida con el humano cuando corresponda.

Dejame anotado en el reporte final de la wave, junto al SHA de cada merge, esto:

- los hallazgos que quedaron cubiertos, por ID;
- los que quedaron fuera por decisión (H18 y los otros nueve ausentes), con la frase «diferidos a la wave editorial de C»;
- y cualquier cosa que hayas descubierto al escribir y que no esté en tu informe original, porque esos hallazgos nuevos no tienen dueño todavía y no quiero que se pierdan en el cuerpo de un PR.
