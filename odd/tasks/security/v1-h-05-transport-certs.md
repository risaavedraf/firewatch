# V1-H-05 — Pruebas TLS de certificado vencido y discordancia de hostname
**Objetivo:** cerrar el tramo de evidencia de BH-05 que hoy no tiene ninguna comprobación registrada —certificado vencido y discordancia de hostname— con pruebas de handshake TLS deterministas y una CA interna efímera, sobre los cuatro servicios que hoy declaran su listener por el mismo contrato de transporte.
**Rama:** `test/v1-h-05-transport-certs`, desde `dev` `bfd3c8a`. **Risk:** item 2 — security/TLS certificate validation.

## Specs

**S1 — Autorización del responsable del proyecto, textual.**

> «ataquemos primero lo que marcaste como 1 porfa, luego vemos el resto»

Consecuencia: esta sesión hace **solo** el ítem 1 de lo que el responsable vio marcado —el hueco de evidencia de BH-05— y no toca el resto. Ninguna otra unidad de hardening se abre, se adelanta ni se cierra por este documento.

**S2 — Criterio de `V1-H-05`, textual, y el hueco exacto que esta unidad cierra.** La fila de la tabla G5 de [`v1-produccion.md`](../v1-produccion.md) (`:171`) dice, literal:

> «Cada ruta de transporte tiene su prueba: el texto plano se rechaza en configuración no de desarrollo, un certificado no confiable o vencido falla, y la excepción de desarrollo no puede habilitar texto plano en producción.»

El documento de la unidad en [`05-transport-security.md`](backend-hardening/05-transport-security.md) (`:46`) acota lo que falta, literal:

> «An expired certificate and a hostname mismatch have no recorded check in that deployment record.»

Consecuencia y alcance de la prueba, sin adelantar la aceptación de la unidad:

- **Casos exigidos, uno por caso y en los cuatro servicios con listener propio** —`gateway`, `risk`, `jobs`, `prevention`, cada uno bajo `backend/services/<servicio>/cmd/server/`—: (a) un certificado de servidor firmado por la CA interna configurada completa el handshake y la petición llega al handler; (b) un certificado firmado por una CA distinta de la configurada falla la verificación; (c) un certificado **vencido** falla la verificación; (d) un certificado con **SAN de otro host** que el `ServerName` que el cliente exige falla la verificación.
- **Deterministas y efímeros.** CA, certificado de servidor y clave se generan por prueba con `crypto/x509` en `t.TempDir()` y se escriben como PEM, que es como `TLS_CERT_FILE`, `TLS_KEY_FILE` y `TLS_CA_FILE` los leen en producción; nada se comparte con el repositorio ni con el despliegue, y la CA real de `bootstrap-secrets.sh` no aparece en el árbol. Ningún caso depende de la red externa, de un host resoluble ni de una CA pública: los handshakes van a un listener en loopback con deadline acotado. El caso vencido fija `NotBefore`/`NotAfter` en el pasado dentro de la propia prueba, y el caso de discordancia usa un SAN distinto del `ServerName` del cliente, de modo que ningún resultado dependa del reloj de la máquina más allá de la ventana que la prueba declara.
- **Se prueba el handshake, no la configuración.** Cada caso abre una conexión TLS real contra el `TLSConfig` que el servicio arma a partir de sus variables y falla por el resultado del handshake, no por inspeccionar un struct ni por `InsecureSkipVerify` leído como texto. Una prueba que solo afirme que la variable existe no cuenta para esta fila.
- **Frontera con `V1-H-11`, sin mezclarse.** Estas pruebas demuestran la lógica de verificación de los clientes y servidores del repositorio; **no** demuestran un despliegue. La verificación en el runtime objetivo —material montado, `fsGroup`, probes HTTPS, CA del clúster— sigue siendo [`11-deployment-security-verification.md`](backend-hardening/11-deployment-security-verification.md) y `V1-H-11`, y ninguna evidencia de este documento se presenta como handshake observado en el entorno autorizado.

## Tasks

- T1 · S1–S2 · worker · done · pruebas Go de handshake TLS con CA interna efímera en `gateway`, `risk`, `jobs` y `prevention` para los cuatro casos (CA válida, CA no confiable, certificado vencido, discordancia de hostname/SAN), con la verificación de runtime objetivo de `V1-H-11` declarada aparte · commit: 39bde07

## Log

- L1 — Pedido original del responsable del proyecto, textual:

  > «ataquemos primero lo que marcaste como 1 porfa, luego vemos el resto»

  Este es un paso de **seguimiento solo-Markdown antes de la primera escritura de fuente**: se crea este documento en `test/v1-h-05-transport-certs` (desde `dev` `bfd3c8a`) y no se escribe fuente, configuración, manifiesto ni prueba en esta edición. Por eso aplica la exención de comportamiento de RED/GREEN: no hay ciclo rojo-verde que observar en una escritura documental, y la evidencia de RED/GREEN se registrará cuando `T1` escriba la primera prueba. Nada se ejecutó contra el clúster, ningún certificado se emitió fuera del árbol de pruebas y no se registra ningún commit.
- L2 — `T1` ejecutado con disciplina de prueba-primero. Los cuatro servicios recibieron el mismo bloque de prueba con su propio nombre de servicio, y cada uno pasó por RED, GREEN y PRESERVE. Nada se ejecutó contra un clúster; la CA, la hoja y la clave de cada caso se generan con `crypto/x509` en `t.TempDir()` y se escriben como PEM, que es la forma en que `TLS_CERT_FILE`, `TLS_KEY_FILE` y `TLS_CA_FILE` se leen. No se ejecutó `git commit`.

  **RED 1 — comportamiento, sobre la costura existente.** `GOWORK=off go test -run TestOutboundTLSStatesTheProtocolFloor ./cmd/server/...` en los cuatro servicios: `FAIL` con código de salida 1, el mismo defecto en cada uno.

  ```text
  transport_test.go: the outbound TLS minimum version = 0x0, want tls.VersionTLS12 (0x303)
  --- FAIL: TestOutboundTLSStatesTheProtocolFloor
  ```

  **RED 2 — la costura de servidor no existía.** `GOWORK=off go test -run TestTLSHandshakeVerificationMatrix ./cmd/server/...` (gateway, y el mismo resultado en los otros tres tras replicar el bloque): la compilación falla porque ninguna de las dos costuras de producción estaba expuesta.

  ```text
  cmd\server\transport_test.go:603:14: undefined: newOutboundTLSConfig
  cmd\server\transport_test.go:648:27: undefined: newListenerTLSConfig
  FAIL   firewatch.local/gateway/cmd/server [build failed]
  exit=1
  ```

  **GREEN.** Se añadieron a cada `cmd/server/transport.go` las dos costuras que las pruebas exigían: `newListenerTLSConfig` (carga el par de `TLS_CERT_FILE`/`TLS_KEY_FILE` y fija `MinVersion: tls.VersionTLS12`) y `newOutboundTLSConfig` (pool de `TLS_CA_FILE` y el mismo piso). `listenAndServe` ahora construye la configuración servida por esa costura en lugar de delegar los nombres de archivo a `ListenAndServeTLS`, y `newJWKSClient` usa la costura de cliente. Resultado por servicio, `exit=0` en los cuatro:

  ```text
  --- PASS: TestOutboundTLSStatesTheProtocolFloor
  --- PASS: TestTLSHandshakeVerificationMatrix  (4/4 subtests)
      --- PASS: a_certificate_from_the_internal_CA_matching_the_SAN_is_accepted
      --- PASS: a_certificate_from_a_CA_outside_TLS_CA_FILE_is_refused
      --- PASS: an_expired_certificate_from_the_internal_CA_is_refused
      --- PASS: a_certificate_for_another_host_is_refused
  --- PASS: TestListenerTLSRefusesBelowTheProtocolFloor
  ok     firewatch.local/{gateway,risk,jobs,prevention}/cmd/server
  ```

  Los rechazos se afirman por tipo: `x509.UnknownAuthorityError` para la CA ajena, `x509.CertificateInvalidError` con `Reason == x509.Expired` para el vencido y `x509.HostnameError` para la discordancia, de modo que un puerto cerrado no satisface la prueba. Cada caso rechazado lleva un control sobre el mismo listener: el mismo certificado completa el handshake con la verificación desactivada, lo que demuestra que el rechazo es la decisión de verificación. El caso válido además entrega `204` al handler y se repite con `ServerName` = `<servicio>.firewatch.svc` sobre loopback, y la discordancia se prueba por los dos nombres.

  **PRESERVE.** `GOWORK=off go test -v ./cmd/server/...` con `exit=0` en los cuatro servicios: gateway 44 resultados en PASS (incluidos subtests) y 0 en FAIL, risk 114/0, jobs 81/0, prevention 45/0. Siguen en verde las pruebas que no podían romperse: `TestRequireListenerTLS`, `TestStartupListenerTLSTakesTheDecisionFromTheEnvironment`, `TestDevelopmentWithoutTLSKeepsServingPlaintext`, `TestListenAndServeTakesTheTLSBranchForAConfiguredPair`, `TestListenerServesPlaintextInDevelopment`, `TestListenerServesTLSWithTheConfiguredKeyPair`, `TestRequireTLSOutsideDevelopment` (incluido `sslmode=disable` y el fallback `prefer`), `TestRequireSecureBrokerURL` (incluido `verify=verify_none`), `TestStartupRootCAs*`, `TestNewJWKSClientCarriesTheInternalCA` y `TestJWKSClientTrustsOnlyTheConfiguredCA`. `GOWORK=off go vet ./...` con `exit=0` en los cuatro.

  **Diferencial.** Se mutó la política de producción y se comprobó que las pruebas lo detectan, antes de revertir la mutación (el archivo quedó byte a byte igual al de partida, verificado con `diff`):

  ```text
  # A: InsecureSkipVerify: true en newOutboundTLSConfig
  --- FAIL: TestTLSHandshakeVerificationMatrix
      transport_test.go:605: the outbound configuration disables certificate verification
  exit=1
  # B: MinVersion: tls.VersionTLS10 en newListenerTLSConfig
  --- FAIL: TestTLSHandshakeVerificationMatrix
  --- FAIL: TestListenerTLSRefusesBelowTheProtocolFloor
      transport_test.go:706: a client capped at TLS 1.1 completed a handshake, want the TLS 1.2 floor to refuse it
  exit=1
  # revertidas ambas mutaciones
  ok     firewatch.local/gateway/cmd/server
  exit=0
  ```

  **Suites completas.** `GOWORK=off go test ./...` con `exit=0` en gateway (4 paquetes), jobs (6) y prevention (8). En risk la primera corrida terminó con `exit=1` por una prueba de otro paquete, `internal/classify/TestInferenceClassifierTrustsTheConfiguredCA`, que falló con `context deadline exceeded` en lugar del fallo de verificación esperado; el paquete no está tocado por esta unidad y la repetición aislada (`-count=3`) y la segunda corrida completa dieron `exit=0` con los 12 paquetes en `ok`. Se registra como intermitencia previa, no como efecto de este cambio.

  **Frontera con `V1-H-11`.** La matriz es evidencia del repositorio: demuestra lo que verifica el código de este árbol. No es una observación de despliegue; el handshake en el runtime objetivo sigue en [`11-deployment-security-verification.md`](backend-hardening/11-deployment-security-verification.md), `V1-H-11` y T9, y la matriz quedó registrada en [`05-transport-security.md`](backend-hardening/05-transport-security.md) con esa distinción explícita.

  **Riesgo residual declarado.** El piso TLS 1.2 explícito quedó en las costuras de `cmd/server` (listener y cliente JWKS), que es la superficie de edición autorizada para esta unidad. Otros clientes salientes del árbol (`gateway/internal/handler.newUpstreamTransport`, `risk/internal/classify`, `risk/cmd/server/inference_status.go`, `prevention/internal/directory`) siguen construyendo `tls.Config{RootCAs: ...}` sin declarar `MinVersion`; hoy heredan el mínimo TLS 1.2 del toolchain y su verificación de SAN y vencimiento quedó probada sobre el mismo pool, pero el piso no está fijado por el repositorio ahí y queda como trabajo de una unidad con esa superficie.

- L3 — Segunda pasada de `T1`, disparada por la verificación independiente (`verifier`): S1 en PASS, S2 en FAIL con tres hallazgos. Los tres quedaron cerrados, con la misma disciplina de prueba-primero. Nada se ejecutó contra un clúster y no se hizo `git commit`. Las cifras de este registro son de corridas sin caché (`-count=1`).

  **Hallazgo 1 — el piso TLS 1.2 no se declaraba cuando `TLS_CA_FILE` estaba vacío.** `newJWKSClient(rootCAs)` solo construía transporte propio si el pool no era nil; sin `TLS_CA_FILE` el cliente quedaba sobre el transporte por defecto, con el piso heredado del toolchain y no fijado por el repositorio. Se escribió primero `TestJWKSClientWithoutTLSCAFileKeepsTheSystemRootsAndTheFloor` en los cuatro servicios, exigiendo `*http.Transport` no nil, `TLSClientConfig` no nil, `RootCAs == nil` (raíces del sistema) y `MinVersion == tls.VersionTLS12`. RED observado en los cuatro, `exit=1`:

  ```text
  gateway:    transport_test.go:391: the key-set client without TLS_CA_FILE carries no explicit transport: <nil>
  risk:       transport_test.go:305: the key-set client without TLS_CA_FILE carries no explicit transport: <nil>
  jobs:       transport_test.go:308: the key-set client without TLS_CA_FILE carries no explicit transport: <nil>
  prevention: transport_test.go:367: the key-set client without TLS_CA_FILE carries no explicit transport: <nil>
  --- FAIL: TestJWKSClientWithoutTLSCAFileKeepsTheSystemRootsAndTheFloor
  exit=1
  ```

  GREEN: `newJWKSClient` ahora siempre devuelve `&http.Client{Timeout: 5s, Transport: &http.Transport{TLSClientConfig: newOutboundTLSConfig(rootCAs)}}`, con el pool nil preservando las raíces del sistema. Las dos pruebas anteriores que fijaban el contrato viejo («sin `TLS_CA_FILE` no hay `Transport`») se actualizaron al nuevo: `TestNewJWKSClientCarriesTheInternalCA` en `risk`, `jobs` y `prevention`, y `TestJWKSClientTrustsOnlyTheConfiguredCA` en `gateway`. Resultado en los cuatro: `--- PASS` y `exit=0`. El comportamiento de verificación no se relajó: el cliente sin CA sigue rechazando el certificado de prueba porque las raíces del sistema no lo firman.

  **Hallazgo 2 — faltaba probar que TLS 1.2 se negocia y se acepta.** `TestListenerTLSRefusesBelowTheProtocolFloor` ahora limita también al cliente aceptado con `MaxVersion: tls.VersionTLS12` y exige, sobre la respuesta HTTPS real, `response.TLS != nil && response.TLS.Version == tls.VersionTLS12`. Observación honesta: la aserción pasó en su primera corrida en los cuatro servicios (`--- PASS`, `exit=0`), porque el comportamiento ya era correcto; no hubo RED que observar y no se inventa uno. Para demostrar que la aserción no es vacía se mutó temporalmente el listener a `MinVersion: tls.VersionTLS13` en `gateway`, de modo que un cliente limitado a TLS 1.2 no puede negociar:

  ```text
  --- FAIL: TestListenerTLSRefusesBelowTheProtocolFloor
      transport_test.go:746: a client capped at TLS 1.2 was refused: Get "https://127.0.0.1:58519/": remote error: tls: protocol version not supported
  exit=1
  ```

  La mutación se revirtió de inmediato: no queda `VersionTLS13` en ninguno de los cuatro `transport.go`, y `go build`, `go vet` y la prueba vuelven a `exit=0`.

  **Hallazgo 3 — dos exageraciones en `05-transport-security.md`.** Se corrigió la frase que afirmaba que ninguna prueba mira un struct: ahora dice que cada caso es un handshake real en loopback y que el piso (`TLSClientConfig.MinVersion`) y el anclaje (`RootCAs`) se leen además como comprobación emparejada, nunca en lugar del handshake. También se ajustó el párrafo del piso para nombrar la aserción exacta de la versión negociada (`resp.TLS.Version == tls.VersionTLS12`) y para declarar que el cliente JWKS fija el piso aun sin `TLS_CA_FILE`. Se agregó `L4` al log de ese documento con esta misma evidencia.

  **PRESERVE, corridas sin caché.** En los cuatro servicios, `GOWORK=off go test -count=1 -v ./cmd/server/...` con `exit=0`: gateway 45 resultados en PASS y 0 en FAIL, risk 115/0, jobs 82/0, prevention 46/0. `GOWORK=off go vet ./cmd/server/...` con `exit=0` en los cuatro. `gofmt -l` sobre los cuatro `cmd/server` sin salida y `git diff --check` con `exit=0`. Siguen en verde los guardas previos: rechazo de texto plano por `APP_ENV` fuera de `development`, rechazo de `verify=verify_none`, rechazo de `sslmode=disable` y del fallback `prefer`, y `TestListenerServesTLSWithTheConfiguredKeyPair`. La frontera con `V1-H-11` no cambia: esta matriz es evidencia del repositorio, no un handshake observado en el runtime objetivo.
- L4 — Cierre registral de `T1`. La unidad quedó en el commit `39bde07` («test(security): verify TLS certificate expiry, SAN mismatch and 1.2 floor») sobre `test/v1-h-05-transport-certs`, y la verificación independiente `gentle-ai-verify` devolvió **S1 PASS · S2 PASS** para los cuatro servicios: `gateway`, `risk`, `jobs` y `prevention`. Los conteos sin caché sobre `./cmd/server/...` que respaldan ese veredicto son los ya observados y registrados en `L3`: `gateway` 45, `risk` 115, `jobs` 82 y `prevention` 46 resultados en PASS, sin fallos, con `GOWORK=off go test -count=1` y `GOWORK=off go vet ./cmd/server/...` en `exit=0`. No se ejecutó `git push` ni se hizo merge: el commit vive solo en la rama de trabajo y la integración queda en manos del responsable. La verificación en el runtime objetivo sigue fuera de este registro: material montado, `fsGroup`, probes HTTPS y CA del clúster pertenecen a [`11-deployment-security-verification.md`](backend-hardening/11-deployment-security-verification.md), `V1-H-11` y T9 de `odd/tasks/kubernetes-deployment.md`, y ninguna evidencia de `L2`/`L3` se presenta como un handshake observado en el entorno autorizado. Este `L4` no cambia ninguna prueba: solo asienta el commit y el veredicto.
