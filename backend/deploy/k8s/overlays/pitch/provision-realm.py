"""Create (or update) the `firewatch` realm on the pitch cluster.

The base deliberately does not import a realm (base/keycloak.yaml): the only
realm file in the repository is the development one, whose three ${...}
placeholders no Secret supplies. For the pitch this script supplies them:

  - DEMO_ADMIN_PASSWORD and DEMO_VIEWER_PASSWORD are generated once and kept in
    the Secret `pitch-demo-users`, so a re-run reuses them;
  - DIRECTORY_CLIENT_SECRET is generated as well (the k8s base does not wire the
    directory client, so prevention answers /v1/users with 503, as it does in
    the base);
  - the `firewatch-demo` client is pointed at the public page origin only, and
    its password grant is disabled: the browser uses Authorization Code + PKCE;
  - the realm-level login settings of the realm file (self-registration, the
    `firewatch` login theme, Spanish, the password policy, the display name)
    and the `viewer` default role are applied on every run, so a realm created
    before they existed picks them up too;
  - when the Secret `pitch-google-idp` exists (keys GOOGLE_CLIENT_ID and
    GOOGLE_CLIENT_SECRET, an OAuth client from Google Cloud), the `google`
    identity provider is created or updated with it, so "Continuar con Google"
    works. Without the Secret nothing about Google is touched.

It reaches Keycloak through `kubectl port-forward`, so the admin console and the
master realm never need a public route. On a realm that already exists it
updates the client's URIs and the login settings below, and leaves users and
passwords untouched.

Usage: python3 provision-realm.py https://<page-origin>
"""
from pathlib import Path
from urllib.parse import urlencode, urlsplit
import base64
import json
import os
import secrets
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

NAMESPACE = "firewatch"
LOCAL_PORT = 18443
REALM_FILE = Path(__file__).resolve().parents[3] / "local" / "firewatch-realm.json"
DEMO_SECRET = "pitch-demo-users"
GOOGLE_SECRET = "pitch-google-idp"
GOOGLE_ALIAS = "google"


def kubectl(*args, capture=True):
    result = subprocess.run(["kubectl", "--namespace", NAMESPACE, *args],
                            capture_output=capture, text=True)
    if result.returncode != 0:
        raise SystemExit(f"kubectl {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout


def secret_value(name, key):
    # A dot inside a key belongs to the field name: kubectl reads
    # `{.data.ca.crt}` as data -> ca -> crt, finds nothing and still exits 0, so
    # the value comes back empty. Escaping the dot makes it a literal, the same
    # way bootstrap-secrets.sh writes `{.data.ca\.crt}`.
    selector = key.replace(".", r"\.")
    raw = kubectl("get", "secret", name, "-o", f"jsonpath={{.data.{selector}}}")
    return base64.b64decode(raw).decode()


def internal_ca():
    cert = secret_value("firewatch-ca", "ca.crt")
    if not cert.strip():
        raise SystemExit(
            "secret firewatch-ca has no ca.crt: the internal CA is what verifies "
            "Keycloak, so the realm cannot be provisioned without it. Re-create "
            "it with backend/deploy/k8s/bootstrap-secrets.sh and run again.")
    return cert


def demo_passwords():
    exists = subprocess.run(["kubectl", "--namespace", NAMESPACE, "get", "secret", DEMO_SECRET],
                            capture_output=True).returncode == 0
    if not exists:
        values = {key: secrets.token_urlsafe(18) for key in
                  ("DEMO_ADMIN_PASSWORD", "DEMO_VIEWER_PASSWORD", "DIRECTORY_CLIENT_SECRET")}
        kubectl("create", "secret", "generic", DEMO_SECRET,
                *[f"--from-literal={k}={v}" for k, v in values.items()])
        print(f"Created Secret {DEMO_SECRET} with generated demo passwords.")
    return {key: secret_value(DEMO_SECRET, key) for key in
            ("DEMO_ADMIN_PASSWORD", "DEMO_VIEWER_PASSWORD", "DIRECTORY_CLIENT_SECRET")}


def substitute(node, values):
    if isinstance(node, dict):
        return {k: substitute(v, values) for k, v in node.items()}
    if isinstance(node, list):
        return [substitute(v, values) for v in node]
    if isinstance(node, str) and node.startswith("${") and node.endswith("}"):
        name = node[2:-1]
        if name not in values:
            raise SystemExit(f"{REALM_FILE.name} uses ${{{name}}}, which this script does not supply")
        return values[name]
    return node


# The realm-level keys that shape sign-in and sign-up. They are copied from the
# realm file onto an existing realm, because Keycloak's import is create-only and
# an initialised realm would otherwise keep refusing registration ("Registration
# not allowed") and showing the built-in theme. A partial PUT only touches the
# keys it carries.
LOGIN_SETTINGS = (
    "displayName", "displayNameHtml",
    "registrationAllowed", "registrationEmailAsUsername", "loginWithEmailAllowed",
    "duplicateEmailsAllowed", "verifyEmail", "resetPasswordAllowed", "rememberMe",
    "passwordPolicy", "loginTheme",
    "internationalizationEnabled", "supportedLocales", "defaultLocale",
)
# What a self-registered account receives. Read access only: `admin` is never
# granted by registration.
DEFAULT_REALM_ROLES = ("viewer",)


def login_settings(realm_file):
    return {key: realm_file[key] for key in LOGIN_SETTINGS if key in realm_file}


def point_client(client, origin):
    client["redirectUris"] = [f"{origin}/"]
    client["webOrigins"] = [origin]
    client.setdefault("attributes", {})["post.logout.redirect.uris"] = f"{origin}/"
    client["directAccessGrantsEnabled"] = False


class Keycloak:
    def __init__(self, ca_file):
        self.base = f"https://localhost:{LOCAL_PORT}"
        self.context = ssl.create_default_context(cafile=ca_file)
        self.token = None

    def call(self, method, path, body=None, form=None, expect=(200,)):
        headers = {}
        data = None
        if form is not None:
            data = urlencode(form).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        elif body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        request = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, context=self.context, timeout=30) as response:
                status, payload = response.status, response.read()
        except urllib.error.HTTPError as error:
            status, payload = error.code, error.read()
        if status not in expect:
            raise SystemExit(f"{method} {path} answered {status}: {payload[:300].decode(errors='replace')}")
        return status, (json.loads(payload) if payload else None)

    def login(self, username, password):
        _, body = self.call("POST", "/realms/master/protocol/openid-connect/token", form={
            "grant_type": "password", "client_id": "admin-cli",
            "username": username, "password": password})
        self.token = body["access_token"]


def wait_for_port(process):
    deadline = time.time() + 60
    while time.time() < deadline:
        if process.poll() is not None:
            raise SystemExit("kubectl port-forward exited: " + process.stderr.read().decode(errors="replace"))
        try:
            with socket.create_connection(("127.0.0.1", LOCAL_PORT), timeout=1):
                return
        except OSError:
            time.sleep(1)
    raise SystemExit(f"port-forward to svc/identity did not open 127.0.0.1:{LOCAL_PORT} within 60 s")


def google_credentials():
    # The client secret only ever travels Secret -> this process -> Keycloak's
    # admin API: never an argument, a file in the repository or a log line.
    exists = subprocess.run(["kubectl", "--namespace", NAMESPACE, "get", "secret", GOOGLE_SECRET],
                            capture_output=True).returncode == 0
    if not exists:
        return None
    client_id = secret_value(GOOGLE_SECRET, "GOOGLE_CLIENT_ID").strip()
    client_secret = secret_value(GOOGLE_SECRET, "GOOGLE_CLIENT_SECRET").strip()
    if not client_id or not client_secret:
        raise SystemExit(f"secret {GOOGLE_SECRET} must carry both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET")
    return client_id, client_secret


def apply_google(keycloak, credentials):
    if credentials is None:
        print(f"Google sign-in: not configured (no Secret {GOOGLE_SECRET})")
        return
    client_id, client_secret = credentials
    provider = {
        "alias": GOOGLE_ALIAS,
        "displayName": "Google",
        "providerId": "google",
        "enabled": True,
        # Google only hands out addresses it has verified, so the account
        # Keycloak creates starts with a verified e-mail.
        "trustEmail": True,
        "storeToken": False,
        "firstBrokerLoginFlowAlias": "first broker login",
        "config": {
            "clientId": client_id,
            "clientSecret": client_secret,
            "defaultScope": "openid email profile",
            "syncMode": "IMPORT",
            "guiOrder": "1",
        },
    }
    path = f"/admin/realms/firewatch/identity-provider/instances/{GOOGLE_ALIAS}"
    status, _ = keycloak.call("GET", path, expect=(200, 404))
    if status == 404:
        keycloak.call("POST", "/admin/realms/firewatch/identity-provider/instances", body=provider, expect=(201,))
        print("Google sign-in: identity provider created")
    else:
        keycloak.call("PUT", path, body=provider, expect=(204,))
        print("Google sign-in: identity provider updated")
    print(f"  Google's authorized redirect URI: <issuer>/broker/{GOOGLE_ALIAS}/endpoint")


def apply_login_settings(keycloak):
    realm_file = json.loads(REALM_FILE.read_text(encoding="utf-8"))
    settings = login_settings(realm_file)
    keycloak.call("PUT", "/admin/realms/firewatch", body=settings, expect=(204,))
    print("Login settings applied: " + ", ".join(f"{k}={settings[k]}" for k in
          ("registrationAllowed", "loginTheme", "defaultLocale") if k in settings))

    _, realm = keycloak.call("GET", "/admin/realms/firewatch")
    default_role = (realm.get("defaultRole") or {}).get("name") or "default-roles-firewatch"
    _, composites = keycloak.call("GET", f"/admin/realms/firewatch/roles/{default_role}/composites/realm")
    present = {role["name"] for role in composites or []}
    missing = []
    for name in DEFAULT_REALM_ROLES:
        if name in present:
            continue
        _, role = keycloak.call("GET", f"/admin/realms/firewatch/roles/{name}")
        missing.append(role)
    if missing:
        keycloak.call("POST", f"/admin/realms/firewatch/roles/{default_role}/composites",
                      body=missing, expect=(204,))
    print(f"New accounts receive {', '.join(DEFAULT_REALM_ROLES)} through {default_role}")


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    page = urlsplit(sys.argv[1])
    if page.scheme != "https" or not page.hostname or page.path not in ("", "/"):
        raise SystemExit(f"Expected the page origin, like https://firewatch-pitch.pages.dev; got {sys.argv[1]}")
    origin = f"https://{page.netloc}"

    google = google_credentials()
    admin_user = secret_value("keycloak-bootstrap-admin", "KC_BOOTSTRAP_ADMIN_USERNAME")
    admin_password = secret_value("keycloak-bootstrap-admin", "KC_BOOTSTRAP_ADMIN_PASSWORD")
    with tempfile.NamedTemporaryFile("w", suffix=".crt", delete=False) as ca:
        ca.write(internal_ca())
    forward = subprocess.Popen(
        ["kubectl", "--namespace", NAMESPACE, "port-forward", "svc/identity", f"{LOCAL_PORT}:8443"],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        wait_for_port(forward)
        keycloak = Keycloak(ca.name)
        keycloak.login(admin_user, admin_password)
        status, _ = keycloak.call("GET", "/admin/realms/firewatch", expect=(200, 404))
        if status == 404:
            realm = substitute(json.loads(REALM_FILE.read_text(encoding="utf-8")), demo_passwords())
            realm["sslRequired"] = "external"
            for client in realm["clients"]:
                if client["clientId"] == "firewatch-demo":
                    point_client(client, origin)
            keycloak.call("POST", "/admin/realms", body=realm, expect=(201,))
            print(f"Created realm firewatch; firewatch-demo accepts {origin}/")
            apply_login_settings(keycloak)
            apply_google(keycloak, google)
        else:
            _, clients = keycloak.call("GET", "/admin/realms/firewatch/clients?clientId=firewatch-demo")
            if not clients:
                raise SystemExit("realm firewatch exists but has no firewatch-demo client")
            client = clients[0]
            point_client(client, origin)
            keycloak.call("PUT", f"/admin/realms/firewatch/clients/{client['id']}", body=client, expect=(204,))
            print(f"Realm firewatch already existed; firewatch-demo now accepts {origin}/")
            apply_login_settings(keycloak)
            apply_google(keycloak, google)
    finally:
        forward.terminate()
        os.unlink(ca.name)

    print("Demo users: demo-admin and demo-viewer. Read a password with:")
    print(f"  kubectl -n {NAMESPACE} get secret {DEMO_SECRET} -o jsonpath='{{.data.DEMO_ADMIN_PASSWORD}}' | base64 -d; echo")


if __name__ == "__main__":
    main()
