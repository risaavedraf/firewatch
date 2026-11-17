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
- Docker, y el stack de Docker Compose detenido (`docker compose down` en `backend/`).

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

## Usuarios de la demo

`demo-admin` y `demo-viewer`, con contraseñas generadas y guardadas en el Secret
`pitch-demo-users`:

```bash
kubectl -n firewatch get secret pitch-demo-users -o jsonpath='{.data.DEMO_ADMIN_PASSWORD}' | base64 -d; echo
```

## Apagar y encender

Con la VM detenida el clúster se detiene con ella. Al encenderla, kind y Caddy
vuelven solos (`restart unless-stopped`); confirmen con
`kubectl -n firewatch get pods` y `curl https://api.<ip>.sslip.io/health/ready`.

## Diferencias con `overlays/delivery`, solo para el pitch

- Imágenes por etiqueta `pitch` cargadas en el nodo, no por digest de un registro.
- `KC_HOSTNAME` público; el issuer que comparan los servicios es esa URL, y la
  JWKS se sigue leyendo por `https://identity:8443`.
- `WEB_ORIGIN` del gateway apunta a Cloudflare Pages.
- Un segundo Ingress para el login y una NetworkPolicy que admite a ingress-nginx
  en Keycloak por 8443.
- El tramo Caddy → ingress-nginx es loopback y no verifica certificado; de
  ingress-nginx hacia adentro, todo es TLS verificado como declara la base.
- El realm se crea desde el de desarrollo, con contraseñas generadas, solo la
  URL pública como redirect y sin password grant en `firewatch-demo`.

## Lo que no se ha ejecutado

Este overlay se escribió sin un clúster ni acceso a red: no se ha renderizado con
`kubectl kustomize`, ni aplicado, ni probado el login. Lo verificado es estático:
sintaxis de los scripts, que cada parche apunta a un objeto que existe en `base/`
con la forma esperada, y la sustitución del realm. La primera corrida de `up.sh`
en la VM es la prueba real.
