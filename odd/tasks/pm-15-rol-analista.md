# PM-15 — Rol `analista` y matriz de permisos táctica

**Unidad:** `PM-15` (frente 16, ítem 16 «Roles y usuarios»), grupo **G2** de
[`v1-produccion.md`](v1-produccion.md), decisión de política de acceso **D-C**.
**Rama:** `feat/pm-15-rol-analista` (worktree `.worktrees/pm-15-rol-analista`).
**Ruta:** worker. **Compuerta:** D-C **resuelta** por el responsable del proyecto.

## Specs

### S1 — El realm declara tres roles y un usuario determinista por rol

`backend/deploy/local/firewatch-realm.json` declara los tres roles de aplicación
del mandante —`viewer`, `analista` y `admin`— y un usuario determinista por rol.
El usuario **nuevo**, `demo-analista`, lleva `id`, `username`, `firstName`,
`lastName` y `email` no vacíos: su `id` es un UUID estable y determinista
(`5b1f9c2e-3a4d-4c8b-9e7f-0a1b2c3d4e5f`) porque el directorio del proveedor de
identidad direcciona a las personas por ese valor y una asignación de acción
preventiva lo persiste.

`demo-admin` (con `admin`+`viewer`) y `demo-viewer` (con `viewer`) **se conservan
tal como el fixture existente los exporta**: ni sus roles ni sus campos cambian, y
**ninguno de los dos lleva un campo `id` explícito** — Keycloak les asigna el suyo
al importar el reino, y añadírselo aquí sería una modificación de cuentas que ya
estaban probadas sin que nada la pida. La prueba del reino fija esa asimetría a
propósito: exige un UUID a `demo-analista` y exige que las otras dos cuentas
sigan sin `id`, de modo que un cambio futuro en cualquiera de las dos sea una
decisión explícita y no un descuido.

`default-roles-firewatch` sigue compuesto solo con `viewer`: el rol `analista`
**no** entra ahí, así que un recién registrado sigue siendo `viewer`, que es el
mínimo privilegio ya probado.

### S2 — Vocabulario cerrado de roles y precedencia `admin > analista > viewer`

Los cuatro servicios Go (`gateway`, `risk`, `jobs`, `prevention`) admiten
exactamente tres roles: `viewer`, `analista` y `admin`. Un rol no declarado
(`operator`) sigue recibiendo **403 `forbidden`**; un token que no se puede
verificar sigue recibiendo **401 `unauthorized`**, antes de cualquier decisión de
rol. La precedencia se decide por **pertenencia al conjunto**, nunca por el primer
elemento reconocido de la lista: un token con `["viewer","analista","admin"]`
conserva los derechos de `admin`, y uno con `["viewer","analista"]` los de
`analista`.

### S3 — La matriz de permisos se aplica ruta por ruta

Decisión ratificada del responsable del proyecto (D-C), citada literal en
[`../plan-produccion/16-producto-mandante.md`](../plan-produccion/16-producto-mandante.md):

| Operación | `viewer` | `analista` | `admin` |
| --- | :---: | :---: | :---: |
| Consultas `GET` (riesgo, historial, CSV, PDF, fuentes, auditoría, alertas, usuarios, trabajos) | Sí | Sí | Sí |
| Marcas personales de alertas (`PUT /v1/risk/alerts/{id}/state`) | Sí | Sí | Sí |
| Disparar evaluación / jobs (`POST /v1/risk/cycle/run`, `POST /v1/jobs`, `POST /v1/jobs/{id}/replay`) | No | Sí | Sí |
| Publicar lote evaluado (`POST /v1/risk/batches/{id}/publish`) | No | No | Sí |
| Crear/asignar acciones, subir evidencia, registrar/adoptar observaciones | No | Sí | Sí |
| Revisar fuentes (`POST /v1/risk/sources/{id}/review`) | No | Sí | Sí |
| Aprobar/rechazar revisión final de evidencia y `CANCELLED` | No | No | Sí |

Lectura operativa de esta Spec, ruta por ruta sobre el árbol, con las tres
precisiones que el contrato real impone:

- **Disparar evaluación** es `POST /v1/risk/cycle/run` (no existe
  `POST /v1/risk/evaluate`). `POST /v1/risk/simulate` es un recálculo
  contrafactual **sin escritura**, documentado como lectura, y conserva el acceso
  de los tres roles.
- **`POST /v1/risk/batches/{id}/publish` y `POST /v1/risk/sources/{id}/review` no
  existen en este árbol** (publicación manual y revisión de fuentes viven en ramas
  propias). La fila queda declarada en el contrato y en esta matriz como
  `admin`/`analista+admin` respectivamente, sin ruta que guardar aquí.
- **Revisión final de evidencia** es
  `POST /v1/prevention/actions/{id}/evidence/{evidence_id}/reviews` (no
  `/review`), y las transiciones restringidas son las que **terminan** en
  `aceptada`, `devuelta` o `cancelada`. El `403` se decide **antes** de tocar el
  almacenamiento: un `analista` que pide `aceptada` no escribe historia ni
  evidencia.

### S4 — El contrato declara los tres roles y la matriz

`backend/contracts/openapi/firewatch-v1.yaml` nombra los tres roles en la
descripción de cada operación, con el veredicto por rol de S3, y un contract test
Go comprueba (a) que el documento sigue siendo OpenAPI 3 válido, (b) que toda
operación declara su política de roles en la descripción y (c) que `analista`
obtiene 2xx donde la matriz dice Sí y `403 forbidden` donde dice No.

### S5 — El cliente declara el rol y ofrece solo lo que la matriz permite

`frontend/src/` gana `UserRole = 'viewer' | 'analista' | 'admin'` con precedencia
`admin > analista > viewer` sobre el claim **no verificado**
`realm_access.roles`. `SessionView` muestra el rol efectivo y una matriz de
**cinco columnas** —`Capacidad`, `Sin token`, `viewer`, `analista`, `admin`—
donde la celda de capacidad cita la guarda real por `ruta#token` y la columna
`Sin token` declara el veredicto de una petición sin credencial (401 en toda
ruta autenticada, 204 en la sonda de disponibilidad).

La fila táctica y la fila final se distinguen también en su texto: la táctica
nombra `devuelta → en_curso` (reabrir una acción devuelta, que un `analista` sí
hace) y la final nombra `enviada → aceptada`, `enviada → devuelta` y cualquier
transición a `cancelada`, que quedan en `admin`.

`JobsView`, `ActionsView` y `ObservationsView` habilitan con `analista` la
evaluación, el alta de acciones, la evidencia y las observaciones, y **explican en
texto visible** que la revisión final de evidencia (`aceptada`/`devuelta`) y la
cancelación (`cancelada`) requieren `admin`. `ActionsView` nombra el caso
`analista` con su propio mensaje: nunca le dice «viewer» ni le anuncia una vista
de solo lectura, porque no lo es. La página no concede permisos: el servidor
sigue siendo la única autoridad y su `403` se muestra tal cual.

## Tasks

- [x] `odd/tasks/pm-15-rol-analista.md` creado y `16-producto-mandante.md`
      actualizado con la cita literal de D-C.
- [x] S1: rol `analista` y usuario `demo-analista` en `firewatch-realm.json`,
      sin tocar `viewer`, `admin` ni `default-roles-firewatch`.
- [x] S1: prueba Go que lee el realm y exige los tres roles y los usuarios
      deterministas (incluido el nuevo).
- [x] S2: `analista` en el vocabulario cerrado de `gateway`, `risk`, `jobs` y
      `prevention`; precedencia por pertenencia; `operator` sigue en 403.
- [x] S3: guardas ruta por ruta en `risk` (`cycle/run` táctico, marcas de alerta
      abiertas a los tres roles) y en `jobs` (`POST /v1/jobs` y `replay`
      tácticos).
- [x] S3: guardas de `prevention` separadas en táctica (`analista`+`admin`) y
      final (`admin`), con la negativa final decidida antes de escribir.
- [x] S4: descripciones de rol por operación en `firewatch-v1.yaml`.
- [x] S4: contract tests Go de esquema y de comportamiento `analista` 2xx/403.
- [x] S5: `UserRole`, precedencia, `SessionView` de cinco columnas (`Capacidad`,
      `Sin token`, `viewer`, `analista`, `admin`) con la guarda en la celda de
      capacidad, y guardas de `JobsView`, `ActionsView` y `ObservationsView`.
- [x] S5: `OverviewView` **no tiene guarda de rol que ajustar** y se declara: la página
      solo importa lecturas (`batches`, `history`, `latest`, `modelVersions`, `zones`),
      no dispara evaluación ni escribe nada. La evaluación que pide el rol `analista`
      se dispara en `JobsView` (`POST /v1/jobs`), que sí quedó guardada; se registra
      aquí en vez de inventar un control que la página no tiene.
- [x] S5: pruebas de cliente (vitest) para `analista`, `viewer` y `admin`.
- [x] Validación: `GOWORK=off go test -count=1 ./...` en los cuatro servicios,
      `npx vitest run --cache=false`, `npx tsc --noEmit` y
      `node scripts/check.mjs`.

## Log

- **L1 — Se abre el registro con la decisión D-C ya ratificada.** El responsable
  del proyecto ratificó D-C: «Operación táctica: evalúa y gestiona acciones, sin
  admin», con la matriz de tres roles que S3 transcribe. La compuerta de
  [`../plan-produccion/16-producto-mandante.md`](../plan-produccion/16-producto-mandante.md)
  queda levantada y la fila `PM-15` pasa de `bloqueado` a `worker`.
  - **Lo que la lectura del árbol corrigió sobre el enunciado.** Tres rutas que el
    texto de D-C nombra no existen con ese literal: `POST /v1/risk/evaluate` es
    `POST /v1/risk/cycle/run`, `POST /v1/prevention/actions/{id}/transition` es
    `.../transitions` y `.../evidence/{evidence_id}/review` es `.../reviews`. La
    matriz se aplica sobre las rutas reales; ninguna se inventa.
  - **Lo que no se toca.** `POST /v1/models/{version}/activate` sigue siendo
    `admin` (configuración del modelo, no operación táctica) y
    `POST /v1/risk/simulate` sigue abierto a los tres roles porque no escribe.
  - **Límite declarado.** Este registro se escribe antes de ejecutar las pruebas;
    la evidencia de las corridas se anexa como L2 cuando existe.

- **L2 — La unidad queda implementada y validada en su rama, sin fusión ni aceptación.**
  Corridas de esta sesión, sobre `feat/pm-15-rol-analista`, todas en verde:
  - **Go, los cuatro módulos:** `GOWORK=off go test -count=1 ./...` en
    `backend/services/{gateway,risk,jobs,prevention}` — `ok` en los 26 paquetes,
    sin una sola falla.
  - **Cliente:** `npx tsc --noEmit` sin diagnósticos, `npx vitest run --cache=false`
    **871/871 en 63 archivos**, `npx eslint .` sin hallazgos y
    `node scripts/check.mjs` **PASS** (80 archivos, incluida la regla de que no
    exista una guarda de rol en el cliente: la página solo deshabilita
    controles y el servidor sigue decidiendo).
  - **La secuencia RED→GREEN se observó en cada capa, no se declara.** Realm: la
    prueba falló con `the realm does not declare the ratified role "analista"`.
    `risk`: `analista` recibía 403 en `/v1/risk/latest` y en `/v1/risk/cycle/run`, y
    `viewer` en el `PUT` de la marca personal. `jobs`: `analista` recibía 403 en
    `GET /v1/jobs/{id}` y en el alta. `prevention`: `analista` recibía 403 en las
    siete rutas tácticas. `gateway`: `/v1/status` devolvía 403 a `analista`. Los
    contract tests fallaron primero por el enum ausente y por las descripciones sin
    la política nueva.
  - **Lo que la matriz cambió en `viewer`, declarado.** Cinco guardas que estaban
    cerradas a `admin` se abren a los tres roles declarados porque las filas «Consultas
    `GET`» y «Marcas personales de alertas» dicen **Sí** para `viewer`:
    `GET /v1/audit`, `GET /v1/users`, `GET /v1/jobs/status`, `GET /v1/jobs/{id}` y
    `PUT /v1/risk/alerts/{id}/state`. Las pruebas que fijaban el `403` de `viewer` en
    esas cinco se reescribieron citando la decisión; el resto del comportamiento
    probado de `viewer` y `admin` no cambia.
  - **Un pendiente de configuración, fuera de la superficie de esta rama.**
    `firewatch-realm.json` expande `${DEMO_ANALISTA_PASSWORD}` y esta rama no puede
    editar los archivos de composición, el de variables de entorno de ejemplo ni el
    inicializador de entorno del backend, que sí nombran las contraseñas de los otros
    dos usuarios demo. Sin esa variable el usuario `demo-analista` se importa sin
    contraseña útil; se reporta como riesgo en vez de inventar el valor o editar
    fuera de alcance.

- **L3 — Cierre de los tres hallazgos de la verificación independiente (`gentle-ai-verify`).**
  La verificación dio por buenos S2 y S3 y señaló tres puntos concretos; los tres
  quedan cerrados en esta rama, sin fusión ni `R6`.
  - **S1 — asimetría del `id`, ahora declarada y probada.** S1 decía «con `id` …
    no vacíos» para los tres usuarios, pero `demo-admin` y `demo-viewer` no llevan
    `id` en el fixture. Se eligió **no tocar las dos cuentas existentes** (sus roles
    y campos siguen exportados tal cual; Keycloak les asigna el `id` al importar) y
    **declararlo en S1**: solo el usuario nuevo `demo-analista` lleva un UUID
    determinista, porque el directorio direcciona por él y una asignación de acción
    lo persiste. `realm_test.go` fija la asimetría en las dos direcciones — exige un
    UUID a `demo-analista` y exige que `demo-admin` y `demo-viewer` sigan **sin**
    `id` —, así que S1 y la prueba no pueden divergir.
  - **S4 — la política se prueba sobre TODA operación, no sobre una lista elegida.**
    `roles_contract_test.go` gana `TestEveryAuthenticatedOperationDeclaresItsRolePolicy`,
    que recorre `contract.Paths.Map()` y enumera los nueve métodos de cada path item,
    de modo que una ruta documentada mañana queda cubierta sin editar la prueba. Para
    cada operación autenticada exige **exactamente una** de las tres sentencias de
    política (cero = ruta muda sobre su rol; dos = promesa contradictoria), y deja
    constancia de las que se acogen a `security: []`. Se añaden además a la tabla
    explícita los dos casos que el hallazgo nombró: `GET /v1/status` y
    `POST /v1/risk/simulate` (un POST que no escribe ninguna fila y por eso es lectura
    de la matriz).
    - **Evidencia RED observada, no declarada.** El documento en `HEAD` —antes de
      PM-15— tiene **39 operaciones y las 39** incumplen el invariante nuevo
      (`git show HEAD:backend/contracts/openapi/firewatch-v1.yaml`, comprobado con un
      lector de descripciones independiente del test). Con el documento actual
      incumplen **0 de 39**. El test documenta un contrato que ya se cumple; su poder
      de discriminación está medido contra el árbol anterior.
  - **S5 — el mensaje de `analista` y la matriz de cinco columnas.**
    - `ActionsView` tenía un defecto real de ramificación: `admin` falso caía en la
      rama de `viewer`, así que a un `analista` se le decía «tu token declara el rol
      viewer» y que la vista era de solo lectura. Ahora la rama `tactical` tiene su
      propia frase: enumera lo que un `analista` **sí** hace (alta y asignación,
      evidencia, reevaluación y las transiciones tácticas, con
      `devuelta → en_curso` para reabrir una acción devuelta) y lo que **no**
      (`aceptada`, `devuelta` y `cancelada` requieren `admin`). La prueba nueva exige
      la frase de `analista` y prohíbe explícitamente «declara el rol viewer»,
      «modo lectura» y «no declara un rol» para ese token; el `viewer` conserva su
      mensaje.
    - `SessionView` pasa a la matriz de **cinco columnas** que S5 declara:
      `Capacidad`, `Sin token`, `viewer`, `analista`, `admin`. La guarda verificada
      por `ruta#token` sigue visible en la celda de capacidad y viaja además en
      `data-guards`, que es lo que la prueba relee del disco: la verificación de
      guardas no se pierde al ganar la columna. `Sin token` declara el veredicto de
      una petición sin credencial (401 en toda ruta autenticada, 204 en la sonda) y
      tiene su propia aserción.
    - **`devuelta` desambiguado.** La fila táctica nombra los seis pasos con
      `devuelta → en_curso`; la fila final nombra `enviada → aceptada`,
      `enviada → devuelta` y cualquier transición a `cancelada`. Una aserción impide
      que el texto de una fila se cuele en la otra.
    - **Límite de esta entrada.** El defecto de `ActionsView` lo observó la
      verificación independiente, no esta sesión: la rama y su prueba se escribieron
      en el mismo paso, así que **no hubo RED propio** para el punto 3a. El punto 3b
      es una corrección de estructura y documentación, tampoco con RED propio. La
      única evidencia RED medida en esta entrada es la del punto S4.
  - **Validación de esta entrada.** `npx tsc --noEmit` sin diagnósticos;
    `npx vitest run --cache=false tests/views/pm-15-roles.test.tsx
    tests/views/session.test.tsx tests/views/actions.test.tsx` **53/53**; la suite
    completa **871/871 en 63 archivos**; `node scripts/check.mjs` **PASS**;
    `GOWORK=off go test -count=1 ./internal/handler/` en `risk` **ok** y
    `./internal/directory/...` en `prevention` **ok**.

- **L4 — Precisión de la prueba de S1: presencia del `id` y el UUID exacto.**
  La verificación independiente dio por buenos S2, S3, S4 y S5 y señaló un único
  punto de precisión en `realm_test.go`; queda cerrado aquí, sin fusión ni `R6`.
  - **El defecto, con nombre.** `realmDocument.Users[].ID` era un `string`, y un
    `string` de Go **no distingue** una clave `"id"` omitida de `"id": ""` ni de
    `"id": null`: las tres desembocan en el mismo valor cero. La prueba anterior
    comparaba `id != ""` para las cuentas existentes y un `uuid.Parse` no nulo para
    la nueva, así que **no** verificaba la presencia de la clave ni fijaba el
    identificador que S1 declara: cualquier UUID distinto habría pasado.
  - **Qué se hizo.** La lectura decodificada deja de mirar `id` — el campo se retira
    del struct y el comentario explica por qué, para que nadie lo reintroduzca — y
    las dos afirmaciones se hacen contra el documento **crudo**, con
    `map[string]json.RawMessage`, cuyo conjunto de claves sí distingue presencia:
    - `demo-admin` y `demo-viewer`: se exige `!hasID`, es decir que la clave `"id"`
      **no exista**. Un `"id": ""` o un `"id": null` fallan ahora, que es justo lo
      que S1 prohíbe («se conservan tal como el fixture existente los exporta»).
    - `demo-analista`: se exige la clave presente, un valor JSON de tipo string y la
      **igualdad literal** con el identificador determinista que S1 declara,
      `5b1f9c2e-3a4d-4c8b-9e7f-0a1b2c3d4e5f`. Además se comprueba que ese literal
      sea un UUID usable y que sea su propia forma canónica, de modo que la cadena
      que S1 publica y la que el directorio guardaría no puedan divergir.
  - **El literal vive en dos sitios, y se declara.** El UUID está escrito en S1 y en
    la constante `analystUserID` de la prueba; cambiarlo exige tocar los dos, y esa
    es la intención: la prueba no lee el tracker (atar un test a un documento de
    prosa lo volvería frágil), pero tampoco acepta «cualquier UUID».
  - **Lo que esta entrada NO observó.** No hubo RED propio: el fixture del reino
    (`firewatch-realm.json`) queda **fuera** de la superficie de edición de esta
    entrada, así que no se pudo perturbarlo para ver fallar la aserción nueva. La
    evidencia es que la prueba pasa sobre el fixture real y que el mecanismo elegido
    hace la distinción por construcción (presencia de clave), no por comparación de
    valores decodificados.
  - **Validación.** `cd backend/services/prevention && GOWORK=off go test -count=1
    ./internal/directory/...` → **ok**; `go build ./...` y `go vet ./...` en el
    módulo → **BUILD_OK** / **VET_OK** (vet compila los archivos de prueba, así que
    cubre el archivo modificado).
