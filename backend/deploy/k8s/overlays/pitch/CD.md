# CD de la VM: el workflow dormido y cómo activarlo

El camino está listo y **no se dispara solo**. `pitch-vm-cd.yml` despliega `main` en
la VM reejecutando `up.sh`, y queda dormido hasta que quien tiene el acceso ponga dos
variables de repositorio, los datos de conexión y el pin del script de bootstrap. Nada
de este documento se ha ejecutado: la VM está detenida, el CD no está configurado y lo
que sigue es la vía que falta configurar, no una corrida observada (ver «Lo que no se
ha ejecutado»).

| Quién | Qué hace |
| --- | --- |
| Este repositorio | el agregado de CI, el workflow del CD, sus compuertas y este documento |
| El compañero con acceso | la ruta de red, la clave, el `known_hosts`, los dos pines, el entorno y las dos variables |
| Fuera de esta unidad | configurar el CD, desplegar y tocar la VM |

## Camino rápido

1. **#81 revisado y fusionado**, con el comportamiento de actualización verificado
   (§El prerrequisito duro). Sin eso no se activa.
2. **Prerrequisitos** (§Antes de activar): ruta SSH alcanzable **desde los runners de
   GitHub**, clave dedicada, `known_hosts` por fuera de banda, pin de la CA y pin de
   `bootstrap-secrets.sh`.
3. **Una sola vez en la VM**: el clon dedicado y la clave (§Una sola vez en la VM).
4. **En GitHub**: el entorno `pitch-cd` con sus seis valores y la clave, y
   `PITCH_CD_ENABLE_MANUAL=true` (§Configurar GitHub).
5. **Manual**: ejecutar *Pitch VM CD → Run workflow* sobre `main`, con revisor, y
   observar la corrida (§Qué observar).
6. **Automático**: solo después de que la corrida manual haya pasado,
   `PITCH_CD_ENABLE_AUTO=true`.

Con las dos variables sin definir, cada job queda en `skipped`: ningún push llega a la
VM y el workflow no hace ni una llamada a la API.

## Qué queda hecho y qué aporta el compañero

| Pieza | Dónde | Quién la aporta |
| --- | --- | --- |
| La CI autoritativa por SHA de `main` | `.github/workflows/pitch-main-ci.yml` | este repositorio |
| El workflow dormido del CD | `.github/workflows/pitch-vm-cd.yml` | este repositorio |
| La compuerta del SHA exacto | `overlays/pitch/cd/` | este repositorio |
| La ruta de despliegue | `overlays/pitch/up.sh`, sin cambios | ya existe |
| Host, usuario y puerto SSH | variables del entorno `pitch-cd` | el compañero |
| Clave privada y `known_hosts` | secreto y variable del entorno `pitch-cd` | el compañero |
| Huella de la CA activa | variable del entorno `pitch-cd` | el compañero |
| Huella de `bootstrap-secrets.sh` | variable del entorno `pitch-cd` | el compañero |
| Las dos variables de activación | variables de repositorio | el compañero |

El CD **no inventa** ninguno de esos valores. Si falta uno, el job de despliegue se
detiene enumerando los nombres que faltan y no se conecta.

La identidad también está **fijada en el workflow**: `risaavedraf/firewatch-dev` y
`github.com` son literales, y los dos jobs se niegan si `github.repository` o
`github.server_url` no coinciden. Un fork, un repositorio renombrado o otro host de
GitHub tienen que editar el archivo bajo revisión; no heredan el valor del evento.

## La CI autoritativa: `pitch-main-ci.yml`

Los workflows del repositorio tienen filtros de `paths`: un cambio en `frontend/` no
corre el de `gateway`, y uno en `backend/` corre varios. Eso está bien para un PR,
pero no responde «¿este SHA de `main` está verde?»: la respuesta depende de qué
archivos cambió.

`pitch-main-ci.yml` responde esa pregunta de forma explícita:

- corre en **cada push a `main`**, sin filtro de `paths`;
- **llama** a los ocho workflows de cobertura —`frontend`, `gateway`, `inference`,
  `integration`, `jobs`, `prevention`, `risk`, `training`— en el mismo SHA, sin
  copiar pasos;
- el job `aggregate` corre con `if: always()` y exige que los ocho resultados sean
  **exactamente `success`**: `failure`, `cancelled` y `skipped` se rechazan, y una
  dependencia que falte deja un resultado vacío que también falla. No hay verde
  neutro por un job salteado;
- declara solo `contents: read`, no mapea secretos y no usa `environment`, así que
  ningún credencial de despliegue entra en su alcance.

La compuerta pide el workflow por **nombre de archivo** (`pitch-main-ci.yml`), que es
la forma documentada para `workflow_id` («You can replace workflow_id with the
workflow file name»), y valida aparte el `path` que devuelve la corrida: acepta el
path canónico, el mismo con `@main` o `@refs/heads/main`, y la forma calificada por
repositorio (`<owner>/<repo>/.github/...@main`) **solo** si el repositorio y el ref
son los canónicos. Cualquier otro sufijo, workflow o repositorio no acredita nada.

Un **HTTP 404** de ese endpoint significa que no hay evidencia legible del agregado
para ese SHA. Que la causa sea un lag de registro es **posible**, no un hecho
establecido; se reintenta como una corrida ausente dentro del deadline, y un 401/403,
un 5xx, una respuesta malformada o una corrida ambigua son rechazos y nunca verdes. El primer aterrizaje del agregado es,
por eso, **solo CI**: hasta que exista una corrida verde suya para el SHA, el CD no
tiene nada que citar. Por eso la activación pide el camino manual primero y un
**smoke de preactivación explícito** —un dispatch sobre un SHA que ya tiene esa
corrida verde—, y eso es una instrucción al operador, no una corrida observada.

A cada uno de los ocho cuerpos se le agregó **solo** el trigger `workflow_call`: sus
triggers `push`/`pull_request` con filtros y todas sus compuertas quedan intactos, y
un llamador no puede saltarse un paso ni elevar permisos por encima de lo que declara.
`_go-service.yml` ya era reutilizable y no se tocó.

**Costo aceptado:** como los triggers filtrados siguen existiendo, un push a `main`
puede correr los checks dos veces —una en la corrida propia del workflow, otra en el
agregado—. Es el precio de una CI autoritativa y explícita, y se documenta en vez de
esconderlo recortando filtros.

## Antes de activar

### El prerrequisito duro: issue #81

El workflow reutiliza `up.sh`, y `up.sh` llama a `bootstrap-secrets.sh`. Ese script no
reescribe los Secrets que ya existen, pero tiene un camino destructivo: si
`firewatch-ca` **no existe o su lectura falla**, crea una CA nueva y **escribe
`~/.firewatch-internal-ca/ca.key` encima del anterior**. La comprobación de la CA de
este workflow, **cuando la corrida llega a ella**, compara el certificado público del
Secret: no lee ni comprueba la clave privada, y nunca se documenta como una
comprobación de clave. Cuando la clave se pisa, el certificado público también cambia
y la corrida falla, pero ya con el daño hecho.

Por eso activar el CD exige, como **prerrequisito y no como alternativa**:

- el issue **#81 revisado y fusionado**, con el comportamiento de actualización
  verificado en esa revisión, y
- que la corrida use exactamente los bytes revisados de `bootstrap-secrets.sh`.

Lo segundo se implementa con un pin: `PITCH_CD_BOOTSTRAP_SHA256` guarda el SHA-256 del
script **del commit revisado**, y el workflow lo compara **en el runner** y **otra vez
en la VM**, antes de `up.sh`. Si la variable falta o no coincide, no se conecta ni se
despliega. Son dos comprobaciones independientes contra el mismo pin: si el hash del
runner y el de la VM difieren, una de las dos falla y la corrida se detiene antes de
`up.sh`; un desajuste entre ambos nunca se promedia ni se ignora. El pin es
**evidencia de que corre el código revisado, no prueba de su semántica**: no
convierte el camino en seguro por sí solo y no reemplaza a #81. Si el script cambia,
el pin se recalcula **después** de revisar ese cambio.

La escritura destructiva tiene un orden preciso: el script crea el Secret
`firewatch-ca` **primero** y solo si esa creación termina bien copia la clave nueva a
`~/.firewatch-internal-ca/ca.key`. Es decir, el daño necesita **dos** fallas: que la
lectura del Secret crea que no existe (o que de verdad no exista) **y** que la
creación posterior salga bien. La comprobación de la CA solo se ejecuta **si la
corrida llega a ella** (después de SSH y de las precondiciones), y compara el
certificado público del Secret: no lee la clave privada y no se documenta como una
comprobación de clave.

Queda un límite irreductible, y se declara: si `kubectl` falla **dentro** de
`bootstrap-secrets.sh`, entre la comprobación de este workflow y la del script, el
script toma el camino de CA nueva. El pin no lo evita (los bytes son los revisados) y
la comprobación de la CA solo lo detecta después; no puede impedir la escritura de la
clave privada. Ese es el objeto de #81 y **no se arregla aquí**.

### La ruta de red: el runner no es tu laptop

La conexión la hace un **runner alojado por GitHub**, desde la red de GitHub, no tu
computador. Una VPN o un bastión de tu lado **no** hacen alcanzable la VM para el
runner. Por eso la ruta aprobada tiene que ser alcanzable desde los runners (por
ejemplo, el puerto SSH de la VM abierto solo al rango de IP que decida el compañero, o
un runner autoalojado, que quedaría fuera de esta unidad porque cambia el workflow).

**Si no hay una ruta segura alcanzable desde el runner, no se activa el CD**: este
workflow no abre el firewall, no publica el API de Kubernetes y no acepta un host que
nadie aprobó.

### La clave y el `known_hosts`

- Clave **dedicada**, sin passphrase (una corrida no puede escribirla), distinta de la
  que usa el compañero para trabajar.
- En la VM, en el `authorized_keys` del usuario que ya corre la instalación, con el
  prefijo `restrict`: sin PTY, sin reenvío de puertos, sin agente, sin X11. El workflow
  además pasa `BatchMode`, `IdentitiesOnly`, `StrictHostKeyChecking=yes`,
  `PasswordAuthentication=no`, `KbdInteractiveAuthentication=no`, `ForwardAgent=no`,
  `ForwardX11=no` y `ClearAllForwardings=yes`. Los comandos no necesitan terminal ni
  `sudo`: el usuario tiene que poder usar `docker`.
- `known_hosts` **por fuera de banda**: se copia de un cliente que ya confía en la VM
  o se lee del panel/serial de la VM, y se compara la huella. No se usa `ssh-keyscan`
  desde el workflow ni `accept-new`.
- Si el puerto **no es 22**, la línea va con la forma `[host]:puerto tipo clave`, que
  es la que `ssh` consulta cuando se pasa `-p`.

### El clon dedicado y su `origin`

El checkout de despliegue usa un clon aparte, `~/firewatch-cd/checkout`, y antes de
desplegar compara la **URL completa** —no la cola— contra tres formas canónicas:

- `https://<host>/<owner>/<repo>` (con o sin `.git`);
- `git@<host>:<owner>/<repo>` (con o sin `.git`);
- `ssh://git@<host>/<owner>/<repo>` (con o sin `.git`),

donde `<host>` y `<owner>/<repo>` son los valores **fijados** en el workflow
(`github.com`, `risaavedraf/firewatch-dev`). Se comprueban dos valores: el que está
configurado (`git config --get remote.origin.url`) y el **efectivo** que `git` usará
para el fetch (`git remote get-url origin`, que expande `url.*.insteadOf`). Un alias
SSH (`git@github.com-trabajo:...`), un espejo o una URL que solo termina igual se
rechazan.

La configuración de `git` y de `ssh` en la VM es del operador, así que esto es una
**comprobación de configuración, no una prueba de confianza**: la seguridad real la
dan el fetch que sigue y los pines, no el texto de la URL. En lo razonable se rechaza
además la verificación de certificado desactivada: `GIT_SSL_NO_VERIFY` en el entorno
y `http.sslVerify=false` en la configuración efectiva de `git`.

### La instalación existente: lo que una corrida reutiliza

La actualización reconstruye imágenes y reinicia Deployments, pero **no** rehace estos
objetos:

- **Secrets y TLS**: `bootstrap-secrets.sh` deja intacto todo Secret que ya existe
  (`postgres-credentials`, `broker-credentials`, `firewatch-ca`, los
  `<servicio>-tls` y `gateway-upstream-ca`). Si la clave de firma
  (`~/.firewatch-internal-ca/ca.key`) no está, conserva los certificados y no emite
  nuevos; una actualización con todos los certificados ya creados no la necesita.
- **Realm y usuarios**: `provision-realm.py` crea el realm `firewatch` la primera vez
  con contraseñas generadas y guardadas en el Secret `pitch-demo-users`. En una
  corrida posterior **solo actualiza las URIs del cliente `firewatch-demo`** (y
  desactiva el password grant); usuarios y contraseñas quedan como estaban. Llega a
  Keycloak por `kubectl port-forward` con la CA interna, así que la consola de admin y
  el realm `master` no necesitan ruta pública y no deben tenerla.
- **Borde**: `up.sh` recrea el contenedor `firewatch-edge`; sus volúmenes y
  certificados de Let's Encrypt se reutilizan.

### Esto despliega una instalación que ya existe

El CD **no es una primera instalación y no crea una CA**. Reejecuta `up.sh` **sin
argumentos**, que reutiliza el estado de la VM en vez de crearlo: los cuatro valores del
arranque salen de `~/.firewatch-pitch.env` y los Secrets, el namespace y la CA se leen
del clúster. En la forma en que lo invoca el workflow, `up.sh` no es una vía de primera
instalación; lo que despliega es una instalación existente. La primera instalación se
hace a mano, una sola vez, con `install-tools.sh` y `up.sh <ip> <pages> <correo>` como
describe [`README.md`](README.md), y hasta que exista no hay nada que el CD pueda
actualizar.

El pin de la CA es la pieza que lo dice en voz alta. El workflow lee
`secret/firewatch-ca` en la VM —el mismo comando que imprime la huella en §Una sola vez
en la VM— y **se niega a seguir si no puede leerlo**, con este mensaje:

```text
cannot read secret/firewatch-ca. This workflow only updates an existing install; it never creates a CA.
```

Se detiene antes de `up.sh`: no reconstruye imágenes, no aplica el overlay y no emite
certificado alguno. Un `firewatch-ca` que falta no es un pin mal configurado, es una
instalación que no existe, y el remedio es hacerla antes con el README, no ajustar la
variable.

## Una sola vez en la VM

Con el usuario que ya ejecutó `up.sh` (el mismo `HOME`), y desde la VM:

```bash
# 1. Los valores del arranque tienen que existir: up.sh sin argumentos los reusa.
ls -l ~/.firewatch-pitch.env

# 2. Un clon dedicado, distinto del checkout de trabajo, con el remoto canónico del
#    workflow: `github.com` y `risaavedraf/firewatch-dev`.
git clone https://github.com/risaavedraf/firewatch-dev.git ~/firewatch-cd/checkout

# 3. Una clave dedicada para el CD.
ssh-keygen -t ed25519 -N '' -C pitch-cd -f ~/.ssh/pitch-cd
printf 'restrict %s\n' "$(cat ~/.ssh/pitch-cd.pub)" >> ~/.ssh/authorized_keys

# 4. Copiar la privada al secreto del entorno y, después de pegarla, quitar la copia
#    local: la clave solo vive en GitHub y en authorized_keys queda la pública.
cat ~/.ssh/pitch-cd
```

El comando de arriba usa la forma HTTPS del remoto. `git@github.com:risaavedraf/firewatch-dev.git`
es la misma URL para una VM que autentica contra GitHub por clave SSH, y el workflow
acepta cualquiera de las tres formas que enumera §El clon dedicado y su `origin`: lo
que compara es la URL completa, no la forma de transporte. Las credenciales del clon
son las del operador en la VM; el workflow no aporta ninguna.

El `known_hosts` que se pega en `PITCH_CD_KNOWN_HOSTS` se obtiene por fuera de banda:

```bash
# En un cliente que ya confía en la VM:
ssh-keygen -F <host> -f ~/.ssh/known_hosts
# La huella se contrasta con la del panel o el serial de la VM:
#   ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

Los dos pines, que van en `PITCH_CD_CA_SHA256` y `PITCH_CD_BOOTSTRAP_SHA256`:

```bash
# El certificado de la CA activa, como lo lee el workflow:
kubectl --context kind-firewatch -n firewatch get secret firewatch-ca \
  -o jsonpath='{.data.ca\.crt}' | base64 -d | openssl x509 -outform der | sha256sum | cut -d' ' -f1

# El script revisado, desde el commit que se revisó:
git -C ~/firewatch-cd/checkout show <commit-revisado>:backend/deploy/k8s/bootstrap-secrets.sh |
  sha256sum | cut -d' ' -f1
```

El primero es el mismo comando que corre el workflow: si no responde en la VM, la
corrida tampoco va a poder leer la CA. El segundo se recalcula **solo después** de
revisar un cambio del script.

## Estado que vive en la VM y que `up.sh` reutiliza

El CD no crea nada de esto: lo exige, lo lee o lo reutiliza. Si falta una pieza, se
detiene antes de desplegar. Nada de este estado se escribe dentro del clon de
despliegue.

| En la VM | Qué es | Qué hace el CD |
| --- | --- | --- |
| `~/.firewatch-pitch.env` | los valores del arranque: `API_HOST`, `AUTH_HOST`, `WEB_ORIGIN`, `ACME_EMAIL` | los lee sin ejecutar el archivo y **valida los cuatro** antes de `up.sh`; no los crea ni los inventa |
| `~/.firewatch-internal-ca/ca.key` | la clave de firma de la CA, a propósito fuera del clúster | no la lee ni la copia. Si falta, `bootstrap-secrets.sh` conserva los certificados existentes |
| el `kubeconfig` y el contexto `kind-firewatch` | el clúster de la VM | cada `kubectl` del wrapper lleva `--context`. `up.sh` deja ese contexto como actual: es un efecto del script reutilizado, declarado abajo |
| el contenedor `firewatch-control-plane` | el nodo de kind | debe estar corriendo; si no, se niega antes de tocar la instalación |
| el contenedor `firewatch-edge` y sus volúmenes | Caddy y sus certificados del borde | `up.sh` lo recrea; el workflow no lo toca aparte |
| el stack de Docker Compose de `backend/` | los servicios de desarrollo | debe estar detenido (`docker compose down` en `backend/`); `up.sh` se niega si sigue arriba |
| `~/firewatch-cd/checkout` | el clon dedicado | se actualiza con `fetch` y `checkout --detach`, y solo si está limpio, sin archivos sin seguimiento **ni ignorados**. Nunca `pull`, `reset` ni `clean` |
| `~/firewatch-cd/last-deployed` | un marcador informativo con hora y SHA | lo escribe al final. El gate no lo lee: la verdad es `main` |

## Configurar GitHub

**Entorno** *Settings → Environments → New environment*: `pitch-cd`, con *Required
reviewers* = el compañero y con las *Deployment branches* en `main` (o «protected
branches»). El entorno está solo en el job de despliegue: la compuerta lee datos
públicos de la API y no necesita nada de esto, y ningún otro workflow del repositorio
usa un entorno.

Los revisores obligatorios y las reglas de rama del entorno dependen de la visibilidad
y el plan del repositorio (lo documenta la página de entornos de GitHub; no se verificó
aquí). Si tu plan no los ofrece, el entorno igual existe y sus variables y secretos
funcionan, pero **no hay aprobación**: decídelo antes de encender el automático.

| Nombre | Tipo | Valor |
| --- | --- | --- |
| `PITCH_CD_VM_HOST` | variable del entorno | host o IP por la ruta alcanzable desde el runner |
| `PITCH_CD_VM_USER` | variable del entorno | el usuario dueño de la instalación |
| `PITCH_CD_VM_PORT` | variable del entorno | opcional; sin valor se usa 22 |
| `PITCH_CD_KNOWN_HOSTS` | variable del entorno | la línea o líneas de `known_hosts` (`[host]:puerto` si no es 22) |
| `PITCH_CD_CA_SHA256` | variable del entorno | la huella del certificado de la CA |
| `PITCH_CD_BOOTSTRAP_SHA256` | variable del entorno | el SHA-256 del script revisado |
| `PITCH_CD_SSH_KEY` | **secreto** del entorno | la privada dedicada, sin passphrase |

Solo la clave privada es un secreto. Los otros seis son datos de operación: si se
definen como variables de repositorio en vez de variables del entorno, el workflow
funciona igual; la diferencia es que el entorno las mantiene detrás de la aprobación.
Si las variables del entorno no se resuelven, el job se detiene enumerando lo que
falta: no se despliega nada a medias.

**Variables de repositorio** *Settings → Secrets and variables → Actions → Variables*:

| Nombre | Cuándo | Valor |
| --- | --- | --- |
| `PITCH_CD_ENABLE_MANUAL` | primero | `true` |
| `PITCH_CD_ENABLE_AUTO` | después de una corrida manual verde | `true` |

`PITCH_CD_ENABLE_AUTO` **exige** que `PITCH_CD_ENABLE_MANUAL` siga en `true`: el
automático no se enciende sin el manual ya habilitado. Apagar `PITCH_CD_ENABLE_MANUAL`
apaga los dos caminos; es la forma de detener el CD sin tocar el código.

Que el manual haya **pasado** antes de encender el automático es **política del
operador**, no una condición que el workflow pueda comprobar: el workflow solo sabe
si la variable está en `true`. El paso 4 del orden de activación es esa decisión
humana, y una corrida manual roja no se convierte en verde por encender el automático.

## El orden de activación

1. Con las dos variables sin definir, abrir *Actions → Pitch VM CD* y comprobar que
   los dos jobs quedan en `skipped` y que no hay ninguna conexión a la VM.
2. `PITCH_CD_ENABLE_MANUAL=true`.
3. *Run workflow* sobre `main`. Aprobar el entorno cuando lo pida el revisor.
4. Observar (§Qué observar). No encender el automático con una corrida roja.
5. `PITCH_CD_ENABLE_AUTO=true`. El siguiente merge a `main` dispara el mismo camino.

Apagar una variable **no cancela** lo que ya está corriendo ni una aprobación en
curso; solo impide que empiecen corridas nuevas. Para detener un despliegue en vuelo
hay que intervenir a mano, y ninguna cancelación del workflow forma parte de este
diseño.

## Los dos caminos

| | Push a `main` (automático) | *Run workflow* (manual) |
| --- | --- | --- |
| Se enciende con | `PITCH_CD_ENABLE_MANUAL` **y** `PITCH_CD_ENABLE_AUTO` | `PITCH_CD_ENABLE_MANUAL` |
| Qué SHA despliega | `github.sha`: el del push | `github.sha`: el de `main` al crear la corrida; no hay campo de SHA |
| Cuándo se niega | el SHA ya no es la punta de `main`, o el agregado no está verde para ese SHA | lo mismo |

En los dos caminos el candidato es el SHA de **la corrida**, no uno resuelto después.
Un *dispatch* viejo o un *rerun* de una corrida vieja se rechazan: si `main` se movió,
no se despliega nada y se empieza una corrida nueva.

La compuerta no infiere nada del diff: pide **una** corrida de `push` de
`pitch-main-ci.yml`, en `main`, para el SHA exacto, y exige `completed` y `success`.
La espera está acotada (30 minutos en la compuerta, 5 minutos en la reconfirmación
posterior a la aprobación) y su vencimiento es un rechazo, incluso si el verde llega
justo después.

## Qué observar

En la corrida, el job **CI gate for the exact main SHA** imprime `main is still at …`
y la espera del agregado. Después, **Deploy that SHA on the pitch VM** repite `==>`
por cada etapa. Las dos compuertas se repiten **después de la aprobación y de la
cola**, así que un *rerun* de solo el despliegue vuelve a comprobar todo.

| Lo que ves | Qué significa |
| --- | --- |
| `stale: main is at …` (manual o rerun) | el SHA de la corrida ya no es la punta; no se desplegó nada, empezá una corrida nueva |
| `no completed push run … is green yet` y luego `deadline` | el agregado no corrió, no terminó o no está verde para ese SHA; no se despliega |
| `fail … failure` / `cancelled` / `skipped` | el agregado concluyó distinto de `success`; se corrige hacia adelante, la compuerta no se ensancha |
| `note … run(s) ignored: …` | filas de la API de otro SHA, rama, evento o workflow: se ignoran y se cuentan, no son un rechazo |
| `more than one push run for this SHA` | dos corridas del agregado para el mismo SHA: ambiguo, se rechaza |
| `names head_repository …, not …` | la corrida no es de este repositorio (fork o espejo): se rechaza |
| `bootstrap-secrets.sh is … and the approved pin is …` | el script cambió después de la revisión, o el pin está mal; no se conecta |
| `the active CA certificate … is not the approved one` | no se desplegó nada: el pin o el certificado están mal, y no se toca ninguno de los dos a ciegas |
| `has changes, or untracked or ignored files` | el clon dedicado no está limpio; se mira, no se limpia desde el workflow |
| `origin '…' is not one of …` | el `origin` (configurado o efectivo) no es una de las tres formas canónicas: alias o espejo, se rechaza |
| `HTTP 404 for pitch-main-ci.yml` y luego `deadline` | falta evidencia legible del agregado para ese SHA: no hay corrida que la compuerta pueda leer. Un lag de registro es **posible**, no está establecido; se reintenta como una corrida ausente y vence el deadline |
| `main moved: the fetch from origin returned …` | la VM vio otra punta justo antes de `up.sh`; no se desplegó nada |
| `https://…/health/ready answered 500` | el rollout no quedó sirviendo; no hay rollback automático (§Fallos) |

Comprobación manual, de solo lectura, con el contexto de kind explícito:

```bash
kubectl --context kind-firewatch -n firewatch get deployments
kubectl --context kind-firewatch -n firewatch get pods
kubectl --context kind-firewatch -n firewatch rollout status deployment/gateway
curl -s -o /dev/null -w '%{http_code}\n' "https://$(sed -n "s/^API_HOST='\(.*\)'$/\1/p" ~/.firewatch-pitch.env)/health/ready"
```

`~/firewatch-cd/last-deployed` guarda el último SHA desplegado con su hora. Es
**informativo**: la compuerta siguiente lee `main`, nunca ese archivo.

El `204` de `/health/ready` dice que el borde responde, **no** que esté sirviendo el SHA
de esta corrida: las imágenes se etiquetan `pitch`, sin SHA — la sonda **no** es una
atestación del SHA. La evidencia del SHA es el `HEAD` del clon y el marcador.

## Fallos, corridas viejas y la VM apagada

**No se revierte nada automáticamente.** Si `up.sh` falla a mitad, el workflow se
detiene y deja el estado como está: un rollback automático de un rollout parcial
puede empeorar lo que ya quedó aplicado y oculta la causa. La recuperación es mirar la
etapa que falló y corregir hacia adelante.

| Situación | Qué pasó | Qué hacer |
| --- | --- | --- |
| la corrida queda `cancelled` sin haber desplegado | la reemplazó una corrida más nueva en la cola; la que corre nunca se cancela | mirar la corrida más nueva |
| el agregado queda `cancelled` | otro push a `main` lo reemplazó; un cancelado no es verde | el SHA nuevo es el que se despliega |
| no hay corrida del agregado para el SHA | el push no disparó `pitch-main-ci.yml` | revisar la pestaña Actions; la compuerta vence el deadline y no despliega |
| `ssh failed (exit 255)` | la VM está apagada, la ruta está cerrada, la clave fue rechazada, el `known_hosts` no coincide **o el comando remoto devolvió 255**: el estado de la VM es **desconocido** | mirar la VM antes de repetir; no se puede afirmar que no se desplegó nada |
| `the kind node container is stopped` | la VM se apagó y el contenedor del nodo no volvió | `docker start firewatch-control-plane` y volver a correr |
| `there is no … ~/.firewatch-pitch.env` | la instalación la hizo otro usuario, u otra máquina | hacer la primera instalación a mano (README) o usar ese usuario |
| `there is no deploy checkout at …` | falta el clon dedicado del §Una sola vez | crearlo con el acceso propio |
| `git fetch failed` | el clon dedicado perdió el acceso a `origin` | arreglar el remoto o las credenciales de ese clon |
| `bootstrap-secrets.sh` no coincide con el pin | el script cambió después de la revisión, o el pin es de otro commit | revisar el cambio y recalcular el pin solo con #81 resuelto para él |
| `up.sh` falla en un paso | rollout parcial, sin rollback | leer la etapa, `kubectl --context kind-firewatch -n firewatch get pods`, corregir hacia adelante |
| `the active CA certificate changed during the run` | el certificado de la CA no es el mismo antes y después | detenerse: leer #81 y avisar antes de cualquier acción |

La VM detenida no rompe nada: el clúster se detiene con ella y el CD falla en el
`ConnectTimeout`, antes de tocar la instalación. Al encenderla, Caddy vuelve solo
(`restart unless-stopped`) y el contenedor de kind puede no hacerlo; el `README.md` de
este overlay ya describe ese caso y `docker start firewatch-control-plane` es el
remedio.

## Lo que el workflow no toca

- **Los ocho workflows de cobertura**: se les agregó **solo** `workflow_call`; sus
  triggers, filtros y pasos quedan como están. El agregado los llama, no los copia.
- **El `up.sh`** ni `bootstrap-secrets.sh`: se reutilizan como están. El pin es la
  única forma en que el segundo participa de la decisión.
- **El issue #81**: se exige revisado y fusionado; no se arregla aquí.
- **El checkout de trabajo del compañero**: el despliegue usa
  `~/firewatch-cd/checkout`, se niega si ese clon tiene cambios o archivos sin
  seguimiento o ignorados, y nunca hace `git pull`, `git reset`, `git clean` ni
  `--force`. No limpia: se niega, porque limpiar destruiría el estado de alguien más.
- **El firewall y el API de Kubernetes**: no se abren puertos ni se publica el API;
  `kubectl` habla con `--context kind-firewatch` y solo lee.
- **Cloudflare Pages del frontend**: no es parte de este workflow. Lo publica un
  workflow aparte, `pitch-pages-cd.yml`, que sigue a este (§Frontend en Cloudflare
  Pages).
- **`main`, los PRs y las ramas del compañero**: este workflow no escribe en el
  repositorio, no abre PRs y no hace `git push`.
- **Un rollback**: no lo hay, y una corrida roja no significa que la VM quedó como
  estaba.

Un efecto del script reutilizado, declarado: `up.sh` ejecuta
`kubectl config use-context kind-firewatch`, así que deja ese contexto como actual en
el `kubeconfig` del usuario de la VM. El wrapper nunca depende de eso: cada `kubectl`
suyo lleva `--context`.

## Límites de la compuerta

La compuerta lee **una** corrida, no un diff, así que no hay ventana que acotar ni
filtro que interpretar. Lo que sí acota:

- pide el endpoint del repositorio y del workflow,
  `/repos/{owner}/{repo}/actions/workflows/pitch-main-ci.yml/runs?head_sha=<sha>&branch=main&event=push`,
  y **revalida cada campo** de cada fila: `path`, `repository.full_name`,
  `head_repository.full_name`, `head_branch`, `head_sha`, `event`, `status`,
  `conclusion` y `run_attempt`;
- un `head_sha` que el servidor ignorara devuelve filas de otro SHA: se ignoran y se
  cuentan, y no acreditan nada;
- dos corridas que empatan son ambiguas y se rechazan; una corrida de otro repositorio
  también, aunque comparta el SHA;
- un `rerun` conserva el `run_id` y sube `run_attempt`: se juzga el estado y la
  conclusión de **ese** run, que son los del último intento, sin leer intentos
  anteriores;
- `skipped`, `cancelled`, `failure` y una conclusión nula en un run completado son
  rechazos, no verdes;
- el verde se acepta solo dentro del deadline; uno que llega después es un rechazo.

El helper de la compuerta se invoca como `python3` seguido de la ruta, nunca por el
bit de ejecución del archivo: un checkout sin modos sigue funcionando y el intérprete
es explícito.

Las fuentes son la documentación de
[workflow-runs](https://docs.github.com/en/rest/actions/workflow-runs) y la de
[eventos que disparan workflows](https://docs.github.com/en/actions/reference/events-that-trigger-workflows):
**citadas, no observadas en esta sesión**. Hay **dos contratos offline**. El agregado
corre, desde la rebanada de CI, el contrato de main-CI (`pitch-main-ci-contract.sh`),
que cubre el agregado y los ocho cuerpos. La rebanada del CD agrega su propio paso
(`pitch-cd-contract.sh`), que delega las comprobaciones del agregado y de los cuerpos
en el contrato de CI y suma las del CD. Los dos son shell de biblioteca estándar
(grep, awk, sed, `python3`): no necesitan `kubectl`, ni PyYAML, ni red, así que no
agregan dependencias al runner.

## Frontend en Cloudflare Pages: `pitch-pages-cd.yml`

La página vive en Cloudflare Pages, no en la VM. `pitch-vm-cd.yml` no la toca (su
contrato lo prohíbe), así que la publica un workflow aparte que **sigue** al de la VM:

| Camino | Cuándo | Qué SHA publica |
| --- | --- | --- |
| Automático | una corrida de *Pitch VM CD* termina en **success** para `main` de este repositorio | el `head_sha` de esa corrida: el mismo que quedó en la VM |
| Manual | *Pitch Pages CD → Run workflow* sobre `main` | el SHA de la corrida, para republicar solo la página |

Una corrida de la VM **skipped** (CD dormido) o fallida no publica nada: la página nunca
se adelanta a la API con la que habla. Antes de subir, repite la compuerta del CD de la
VM con el mismo `gate.sh`: `fresh` se niega si `main` ya avanzó (la corrida de la VM del
SHA nuevo disparará su propia publicación) y `wait` exige la corrida verde de
`pitch-main-ci.yml` para ese SHA. Después construye con `npm ci` y `npm run
build:pages` (que escribe `dist/_headers` con la CSP), sube con `wrangler` en una
versión exacta a la rama `main` del proyecto (producción) y comprueba que la URL de la
página sirva el mismo `index.html` que construyó.

El token de Cloudflare vive en un entorno propio, **`pitch-pages`**, separado de
`pitch-cd`: el job de Pages nunca puede leer la clave SSH de la VM, y el de la VM nunca
ve el token. Su contrato es `backend/deploy/k8s/tests/pitch-pages-contract.sh`, que el
agregado corre en cada push a `main`.

### Configurarlo

En el entorno `pitch-pages` (Settings → Environments):

| Nombre | Tipo | Valor |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | secreto | un token de API de Cloudflare con solo **Account → Cloudflare Pages → Edit** |
| `CLOUDFLARE_ACCOUNT_ID` | variable | el ID de la cuenta de Cloudflare (el panel lo muestra; `frontend/.wrangler` lo guarda tras un `wrangler` local) |
| `PITCH_PAGES_PROJECT` | variable | el nombre del proyecto de Pages, por ejemplo `firewatch-pitch` |
| `PITCH_PAGES_GATEWAY_ORIGIN` | variable | `https://api.<ip-con-guiones>.sslip.io` |
| `PITCH_PAGES_ISSUER` | variable | `https://auth.<ip-con-guiones>.sslip.io/realms/firewatch` |
| `PITCH_PAGES_REDIRECT_URI` | variable | la URL de la página con barra final, por ejemplo `https://firewatch-pitch.pages.dev/` |
| `PITCH_PAGES_GOOGLE_LOGIN` | variable, opcional | `true` para mostrar "Continuar con Google" |

Los tres orígenes son los mismos de `frontend/.env.production` y **no son secretos**:
Vite los incrusta en el bundle público. Ninguna variable `VITE_*` puede ser una
credencial.

Y a nivel de repositorio, el interruptor: `PITCH_PAGES_CD_ENABLE = true`. Sin él, cada
corrida queda en `skipped`. Primero una corrida manual; si la URL sirve el build, el
camino automático ya queda activo, porque solo depende de que el CD de la VM termine en
verde.

Lo que no se ha ejecutado de esta parte: ninguna corrida de *Pitch Pages CD*. La
primera manual es su primera prueba real (token, ID de cuenta, nombre del proyecto y la
comprobación de la URL).

## Lo que no se ha ejecutado

Este documento, el agregado y el workflow se escribieron sin correr nada contra
GitHub ni contra la VM: **ninguna corrida de Actions, ninguna conexión SSH, ningún
despliegue**. Lo verificado es estático y local:

- las decisiones de la compuerta (qué significa una corrida y qué significa `main`)
  tienen pruebas propias que corren sin red, incluidos los rechazos;
- el agregado y el CD se leen como texto y se comprueban sus propiedades, y cada bloque
  `run:` y el script que corre en la VM pasan por `bash -n`;
- el YAML parsea, y eso **no** acredita que Actions lo ejecute, que un `workflow_call`
  resuelva ni que la API conteste como se espera.

Queda sin verificar, y solo la primera corrida manual lo responde: que Actions acepte
los ocho `workflow_call`, que el agregado corra y falle cerrado como se describe, que
el endpoint del workflow se comporte como dice la documentación, que la ruta SSH y el
`known_hosts` funcionen desde la red de GitHub, que `up.sh` complete sobre el estado
real de la VM y que las dos huellas coincidan. Si algo de eso falla, el workflow se
niega y lo dice.
