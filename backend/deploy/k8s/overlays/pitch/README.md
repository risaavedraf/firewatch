# Despliegue del pitch: Kubernetes (kind) en la VM de Google Cloud

Los manifiestos de `base/` corren en un clúster kind de un nodo dentro de la VM
`firewatch-vm` (`southamerica-west1`). Es la lectura literal de la decisión del
§7.4 del acta («un server en google cloud para montar todo esto en kubernetes»)
sin la tarifa de gestión de GKE, que el crédito gratuito no cubre para un
clúster regional. GKE sigue siendo el destino documentado en `deploy/k8s/README.md`.

```text
navegador ──► Cloudflare Pages (frontend)
    │
    ├─► https://api.<ip>.sslip.io  ─┐
    └─► https://auth.<ip>.sslip.io ─┤  Caddy en la VM (Let's Encrypt)
                                    ▼
                         127.0.0.1:8443 ── kind ── ingress-nginx
                                    │ TLS verificado con la CA interna
                         gateway (/v1, /health)   keycloak (/realms/firewatch, /resources)
```

| Público | No público |
| --- | --- |
| API del gateway (`/v1/`, `/health/`) | Consola de admin y realm `master` de Keycloak |
| Login del realm `firewatch` | `/metrics`, RabbitMQ, PostgreSQL, inferencia |

## Requisitos de la VM

- `e2-standard-4` (4 vCPU, 16 GB). Los manifiestos reservan 1,6 vCPU y 2,3 GB
  en 13 pods; con el plano de control de kind e ingress-nginx no caben en 2 vCPU.
- IP estática y regla de firewall `tcp:80,tcp:443`.
- Docker: el motor y el plugin de Compose, en la forma que estos comandos usan
  (`docker compose`; el binario suelto `docker-compose` no es el que se invoca aquí).
  Docker no está fijado a una versión. El usuario de la VM tiene que poder ejecutar
  Docker **sin `sudo`**, porque `install-tools.sh`, `up.sh` y kind hablan con el daemon
  directamente.
- El stack de Docker Compose de `backend/` detenido (`docker compose down` en `backend/`).

## Primera vez

En la VM:

```bash
cd ~/firewatch-dev/backend/deploy/k8s/overlays/pitch
bash install-tools.sh
bash up.sh <ip-estatica> https://<proyecto>.pages.dev <correo-del-equipo>
```

`up.sh` crea el clúster, instala metrics-server e ingress-nginx con las recetas
de `local/`, genera Secrets y CA con `bootstrap-secrets.sh`, construye las cinco
imágenes y las carga con `kind load`, aplica este overlay, espera los Jobs y los
Deployments, crea el realm (`provision-realm.py`) y levanta Caddy. Al final
imprime las tres líneas `VITE_*` del frontend.

En el computador, dentro de `frontend/`, con esas tres líneas en `.env.production`:

```cmd
npm install
npm run build:pages
npx wrangler pages deploy dist --project-name <proyecto> --branch main
```

`build:pages` es el `build` de producción más `dist/_headers`, con la misma CSP
que `scripts/serve.mjs` apuntada al gateway y a Keycloak públicos.

## Actualizar después de un `git pull`

```bash
bash up.sh
```

Reconstruye las imágenes, las vuelve a cargar y reinicia los Deployments. El
clúster, los Secrets, el realm y los certificados se reutilizan.

## CD automático, dormido

`CD.md` describe el workflow que despliega `main` reejecutando este mismo `up.sh`.
Queda dormido hasta que se configure: la activación, los valores de conexión y lo que
hay que observar antes de encenderlo están ahí, y no hace falta tocar este README ni
el script para activarlo.

La CI que ese CD exige para un SHA de `main` es `pitch-main-ci.yml`: corre en cada
push a `main`, sin filtro de `paths`, y llama a los ocho workflows de cobertura. Los
triggers filtrados existentes se conservan, así que un push a `main` puede correr
los checks dos veces; `CD.md` explica el motivo y el costo.

## Usuarios de la demo

`demo-admin` y `demo-viewer`, con contraseñas generadas y guardadas en el Secret
`pitch-demo-users`:

```bash
kubectl -n firewatch get secret pitch-demo-users -o jsonpath='{.data.DEMO_ADMIN_PASSWORD}' | base64 -d; echo
```

## Apagar y encender

Con la VM detenida el clúster se detiene con ella. Al encenderla Caddy vuelve
solo (`restart unless-stopped`); el contenedor del nodo de kind no lleva esa
política y puede quedarse detenido, con Caddy arriba y las dos rutas públicas sin
respuesta. La revisión es `kubectl -n firewatch get pods`: si el servidor de la
API no contesta, el nodo está parado y el remedio es
`docker start firewatch-control-plane`.

## Diferencias con `overlays/delivery`, solo para el pitch

- Imágenes por etiqueta `pitch` cargadas en el nodo, no por digest de un registro.
- `KC_HOSTNAME` público; el issuer que comparan los servicios es esa URL, y la
  JWKS se sigue leyendo por `https://identity:8443`.
- `WEB_ORIGIN` del gateway apunta a Cloudflare Pages.
- Un segundo Ingress para el login y una NetworkPolicy que admite a ingress-nginx
  en Keycloak por 8443 (ver «NetworkPolicy: soportadas por kindnet»).
- El tramo Caddy → ingress-nginx es loopback y no verifica certificado; de
  ingress-nginx hacia adentro, todo es TLS verificado como declara la base.
- El realm se crea desde el de desarrollo, con contraseñas generadas, solo la
  URL pública como redirect y sin password grant en `firewatch-demo`.

## NetworkPolicy: soportadas por kindnet

El overlay instala las NetworkPolicies de `base/` y añade una propia. kindnet, el
CNI que kind pone por defecto, implementa NetworkPolicy desde kind v0.24.0
mediante `sigs.k8s.io/kube-network-policies`: la
[release v0.24.0](https://github.com/kubernetes-sigs/kind/releases/tag/v0.24.0) lo
anuncia entre sus novedades, y es el paquete cuyo controlador arranca kindnetd
([`main.go:220-235`](https://github.com/kubernetes-sigs/kind/blob/v0.29.0/images/kindnetd/cmd/kindnetd/main.go#L220-L235)).
Este overlay fija kind v0.29.0 en `install-tools.sh`.

**kindnet las soporta; la aplicación efectiva está pendiente de prueba en la
VM.** Que el CNI traiga el controlador no es lo mismo que haber medido que las
aplica en este clúster. Lo que se declara en `base/network.yaml` es lo que
debería pasar: `default-deny` cierra el namespace y cada regla abre un flujo
concreto.

Por eso `identity-from-ingress.yaml` no es decorativo. La política
`identity-entry-and-data` de la base admite solo a los cuatro servicios, y el
login del navegador llega por el ingress controller: sin esa política del
overlay, ingress-nginx no alcanza Keycloak en 8443 y el login responde 502.

La consecuencia vale para depurar: cuando algo detrás del Ingress falla, lo
primero que hay que revisar son las políticas de red, no lo último. Un 502 en el
login, un timeout entre servicios o un Job de bootstrap que no termina pueden ser
una regla que falta y no un problema de TLS ni de imagen.

### Comprobarlo: un par, no una sonda suelta

La comprobación es un par de pods, uno que las políticas no admiten y otro que
sí. Un `status` distinto de cero en solitario no prueba nada: un fallo del propio
sondeo imprime lo mismo. Se leen los dos, y se crean nuevos en cada corrida: un
pod que sobrevive de la corrida anterior devuelve su veredicto viejo.

El namespace exige `restricted` (`base/namespace.yaml:6`), así que el
`securityContext` es parte de la sonda y no un adorno. Cuatro de estos campos son
requisito del
[estándar de Pod Security](https://kubernetes.io/docs/concepts/security/pod-security-standards/#restricted);
los otros dos no lo son y están ahí por razones propias del sondeo:

| Campo | Valor | ¿`restricted` lo exige? | Por qué |
| --- | --- | --- | --- |
| `runAsNonRoot` | `true` | sí | no acepta `false` ni el campo ausente |
| `allowPrivilegeEscalation` | `false` | sí | solo admite `false` |
| `capabilities.drop` | `[ALL]` | sí | la lista tiene que incluir `ALL` |
| `seccompProfile.type` | `RuntimeDefault` | sí | solo admite `RuntimeDefault` o `Localhost`; el perfil ausente también se rechaza |
| `runAsUser` | `65532` | no, solo prohíbe `0` | la imagen no declara usuario, así que sin un UID explícito no hay forma de cumplir `runAsNonRoot` |
| `readOnlyRootFilesystem` | `true` | no | el sondeo no escribe en disco; se deja cerrado |

Los flags de `kubectl run` no tienen un campo para `securityContext`: el único que
lo admitiría es `--overrides` con el JSON entero a mano, así que la sonda va como
manifiesto. El bloque siguiente, pegado entero en una sesión de shell, corre los dos
pods en dos pares seguidos (sonda denegada y control permitido) e imprime cada
`status` con el nombre que el API le asignó (`generateName`). Todo va dentro de un
paréntesis: las variables no entran ni salen de la shell que lo pega, y cada pod se
borra en el mismo bloque que lo creó, sin nombre de reserva. `set -eu` corta el
bloque en el primer fallo, así que un `create` rechazado o un `wait` vencido no
llegan a imprimir veredicto.

```sh
(
set -eu

# Un solo manifiesto: prefijo y etiqueta son lo único que cambia, y el nombre lo
# asigna el API. `\$?` queda literal para el `sh` del pod.
probe() {
  kubectl -n firewatch create -f - -o jsonpath='{.metadata.name}' <<EOF
apiVersion: v1
kind: Pod
metadata: {generateName: $1, labels: {app: $2}}
spec:
  restartPolicy: Never
  securityContext: {runAsNonRoot: true, runAsUser: 65532, seccompProfile: {type: RuntimeDefault}}
  containers:
    - name: probe
      image: postgis/postgis:17-3.5
      command: ["sh", "-c", "pg_isready -h postgres -p 5432 -U postgres -d postgres -t 10; echo status=\$?; exit 0"]
      securityContext:
        allowPrivilegeEscalation: false
        capabilities: {drop: [ALL]}
        readOnlyRootFilesystem: true
EOF
}

# Sonda denegada: leer y borrar en el mismo par, con el nombre que devolvió el create.
deny=$(probe netpol-deny- netprobe)
echo "deny=$deny"
kubectl -n firewatch wait --for=jsonpath='{.status.phase}'=Succeeded "pod/$deny" --timeout=180s
kubectl -n firewatch logs "$deny"
kubectl -n firewatch delete pod "$deny" --ignore-not-found

# Control permitido: el mismo par, con la etiqueta que `postgres-entry` sí admite.
allow=$(probe netpol-allow- migrate)
echo "allow=$allow"
kubectl -n firewatch wait --for=jsonpath='{.status.phase}'=Succeeded "pod/$allow" --timeout=180s
kubectl -n firewatch logs "$allow"
kubectl -n firewatch delete pod "$allow" --ignore-not-found
)
```

**Esperado:** el deny, `postgres:5432 - no response` y `status=2`; el allow,
`postgres:5432 - accepting connections` y `status=0`. `app: netprobe` no lo admite
ninguna política: `postgres-entry` admite solo a los pods con `app` en
`jobs, risk, prevention, keycloak, migrate` (`base/network.yaml:196-201`) y
`default-deny` cierra todo lo demás, incluida la salida del propio pod
(`policyTypes: [Ingress, Egress]`, `:5-6`). `app: migrate` sí está admitido
(`:196-201`) y tiene salida al 5432 (`:244-251`). Se elige `migrate` y no `jobs`
porque el Service `jobs` selecciona `{app: jobs}` (`base/workloads.yaml:317`): un
pod con esa etiqueta entraría como endpoint y el gateway le mandaría tráfico real
mientras viva. `app: migrate` no lo selecciona ningún Service.

`pg_isready` sale `2` cuando no hubo respuesta y `1` cuando el servidor rechaza
([códigos de salida](https://www.postgresql.org/docs/17/app-pg-isready.html)). El
nombre `postgres` se resuelve porque `dns-and-oidc` permite DNS a todo el
namespace; lo que no se alcanza es el puerto.

`-U postgres -d postgres` no son credenciales y no autentican nada: son los mismos
argumentos de la readiness probe (`base/postgres.yaml:160`). Sin `-U`, libpq
resuelve primero el usuario del UID del pod; si ese UID no tiene entrada en
`/etc/passwd`, falla antes de abrir la conexión y la sonda sale `3` con
independencia de la red
([fe-connect.c:1274-1281](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/interfaces/libpq/fe-connect.c#L1274-L1281)).
El pod no monta Secrets ni declara variables de entorno, y la imagen es la que ya
corre en el nodo (`base/postgres.yaml:83`), así que no descarga nada.

Qué significa cada resultado, para este camino y solo para él: los dos pods contra
`postgres:5432`.

| Lo que ves | Qué significa |
| --- | --- |
| `Forbidden: … violates PodSecurity "restricted:latest"` | la admisión rechazó el pod: no hay veredicto |
| el bloque se detiene antes de imprimir los dos `status` (`create` rechazado, `wait` vencido, `logs` que falla) | tampoco hay veredicto; el nombre quedó impreso en la línea `deny=` o `allow=`, y `kubectl -n firewatch describe pod <nombre>` muestra qué pasó |
| deny `status=2` y allow `status=0` | el par se cumple: el camino cerrado está cerrado y el admitido pasa |
| deny `status=0` | el camino que debía estar cerrado respondió: el par no se cumple. Esta sonda no dice por qué |
| deny `status=1` | el servidor contestó y rechazó: la conexión llegó, así que el camino cerrado también está abierto |
| allow `status=2` | `no response` en el camino que debía pasar: falta una regla, o el destino no está sano. La sonda no distingue |
| `status=3` / `no attempt` | no se llegó a intentar la conexión: es un problema de invocación o de entorno, no un veredicto de red |
| `status=127` o `pg_isready: not found` | la imagen no trae el cliente: la sonda no midió red |

Si el bloque se detiene después de un `create` y antes del `delete`, queda un pod:
su nombre es el que imprimió la línea `deny=` o `allow=`, y se borra con
`kubectl -n firewatch delete pod <nombre>`. No hay otro nombre que borrar, y el
bloque no hereda ni deja variables: la shell donde se pega conserva las suyas.

## Lo que no se ha ejecutado

Este overlay se escribió sin un clúster ni acceso a red: no se ha renderizado con
`kubectl kustomize`, ni aplicado, ni probado el login, ni ejecutado el par de
sondas de NetworkPolicy. Lo verificado es estático:
sintaxis de los scripts, que cada parche apunta a un objeto que existe en `base/`
con la forma esperada, y la sustitución del realm. La primera corrida de `up.sh`
en la VM es la prueba real.
