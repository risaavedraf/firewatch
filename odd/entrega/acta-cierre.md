# Acta de cierre de la entrega

Registra las decisiones tomadas en la sesión de definición del 2026-11-09 sobre qué se entrega, en qué documento y con qué disparador de cierre. No acredita implementación: el estado de cada frente vive en [`../plan-produccion/README.md`](../plan-produccion/README.md) y en [`../tasks/README.md`](../tasks/README.md).

## 1. Decisiones tomadas

### E1 — Qué se entrega: entrega académica defendible

El sistema completo, más la demostración de que el modelo no es viable con los datos entregados. Se firma con el documento, no con un modelo en producción.

La no-viabilidad deja de ser una disculpa y pasa a ser el hallazgo principal: dos modelos medidos contra dos baselines de tipo climatología, con la regla de victoria declarada antes de mirar el resultado, y ninguno gana. El detalle técnico vive en `backend/training/REPORT-delivered-data.md` y `backend/training/ANALYSIS-delivered-data.md`.

Queda fuera de esta entrega entrenar un modelo real. Eso exige una fuente meteorológica independiente unida por (comuna, fecha) —ERA5-Land o la red DMC—, que no existe en el repositorio. Se puede retomar después del cierre; no condiciona esta entrega.

### E2 — Qué documento lee el mandante: informe propio en español

`odd/entrega/informe-datos-y-modelo.md`, escrito a mano, con los dos reportes generados como anexos técnicos. Razón: los reportes generados están en inglés, declaran que editarlos a mano es un defecto, y no son el documento que alguien lee para decidir si aprueba.

Los anexos no se editan nunca a mano. Cualquier número del informe que no esté en ellos es un defecto del informe.

### E3 — Superficie de entrega: repositorio remoto

`main` al día en `origin`, rama publicada y PR #54 como evidencia de revisión. Antes de esta sesión el entregable completo existía únicamente en un disco local: `main` estaba dos commits adelante del remoto y la rama de trabajo no se había publicado nunca.

### E4 — Disparador de cierre: tag de versión

**Superseded por la corrección del §5.** El disparador original era el tag `v1.0-produccion` sobre el commit de merge de PR #54. Esta acta lo conserva como historia, no como decisión vigente: la corrección del 2026-11-09 establece que esta entrega **no** es la versión 1.0 y que el tag no puede emitirse hasta cerrar lo que el §5 enumera.

## 2. Decisiones pendientes

Ninguna de las cinco bloquea la entrega de E1. Todas bloquean la versión 1.0. **D1 quedó resuelta el 2026-11-09 y se registra en el §7**; las otras cuatro siguen sin responsable asignado a la fecha de esta acta.

| # | Decisión | Bloquea | Quién decide |
| --- | --- | --- | --- |
| D1 | Motor de datos productivo, backups y SLA | Frente 14 y parte del 6 | **Resuelta el 2026-11-09: ver §7.** La decide el responsable del proyecto |
| D2 | Registry, llaves de firma y acceso al clúster | Frente 7 y la ejecución del 6 | Infraestructura |
| D3 | Responsables de gobierno y aprobación de controles U1 | Frente 8 — 41 de los 132 IDs | Cliente / jefe de proyecto |
| D4 | Qué subconjunto de los 132 IDs es requisito real | Todo el marcado de IDs | Cliente |
| D5 | Alcance de accesibilidad: ¿WCAG AA? ¿lector de pantalla? | Cierre del frente 9 | Producto |

## 3. Tareas abiertas al momento de esta acta

| # | Tarea | Responsable |
| --- | --- | --- |
| A1 | Informe de E2 revisado y commiteado | Sesión de trabajo actual |
| A2 | CI de PR #54 en verde: dos jobs fallan y se están corrigiendo | Sesión de trabajo actual |
| A3 | Los 17 tests de Go que necesitan Postgres, y el Caddyfile, nunca ejecutados en el host de desarrollo | Requiere entorno con Docker disponible |
| A4 | T9 bloqueado: el producto CONAF tiene DOI restringido (403 anónimo) | Tercero |
| A5 | T10 bloqueado: EC2, dominio, security group e IAM | Infraestructura |
| A6 | T11 pendiente: `deploy.yml` | Sesión de trabajo actual |

## 4. Estado verificado en esta sesión

Ejecutado en el host de desarrollo, con su resultado:

| Verificación | Resultado |
| --- | --- |
| `pytest -q` (paneles de entrenamiento) | 306 pruebas pasan |
| `ruff check .` | limpio, tras corregir dos `E731` que habrían roto el job de lint |
| `govulncheck` v1.9.0 en `risk` e `inference` | sin vulnerabilidades |
| Configuración de Prometheus y alertas | parsea; la alerta de target caído cubre los cinco jobs de aplicación |

No ejecutado, con causa declarada:

| Verificación | Causa |
| --- | --- |
| `go test -race` | requiere cgo y no hay compilador C en el host; lo ejecuta CI sobre Linux |
| 17 tests de Go con Postgres | no hay daemon Docker ni credencial para el PostgreSQL del puerto 5432 |
| Caddyfile | no hay binario `caddy` ni daemon |

Ninguna de las tres se declara cumplida por aparecer en esta lista.

## 5. Corrección del 2026-11-09: esta entrega no es la versión 1.0

Corrección del responsable del proyecto, textual:

> «con esto estoy dando por hecho de que la app NO está terminada, aún nos falta terminar el diseño de la pagina web, tener el modelo funcionando, agregar los usuarios para designarles los trabajos, el modelo de datos que necesitamos para que funcione la app, aún queda e, con esto listo no terminamos el trabajo, hay un monton de tasks no cerradas en odd que tenemos que cerrar antes de llamar a esta version el tav 1.0 produccion»

Lo que esta corrección establece, y que las secciones anteriores de esta acta no decían:

1. **La aplicación no está terminada.** Lo entregado es un corte verificable de un sistema en construcción, no su versión final.
2. **El tag `v1.0-produccion` queda bloqueado** hasta cerrar las tareas abiertas de `odd/` y las capacidades faltantes.
3. **Cuatro capacidades nombradas faltan**, y ninguna estaba mapeada como tal en los quince frentes de `odd/plan-produccion/README.md`:

| # | Capacidad faltante | Estado en la documentación de ODD |
| --- | --- | --- |
| F1 | Diseño terminado de la página web | Parcial: hay vista general y procedencia; el frente 9 cubre login y accesibilidad, no el diseño |
| F2 | Modelo funcionando | No existe: el servicio de inferencia está, el modelo válido no. Medido en `REPORT-delivered-data.md` |
| F3 | Usuarios y asignación de trabajos | No mapeado como frente propio; hay autenticación por Keycloak |
| F4 | Modelo de datos de la aplicación | Parcial: motor de datos pendiente (D1), sin esquema de dominio documentado |

La consecuencia operativa es una sola: **la entrega de E1 no se llama `v1.0-produccion`**. El inventario de lo que falta para llegar a esa versión, con los IDs de ODD que hay que cerrar, es trabajo de la fase siguiente y no se resuelve en esta acta.

## 6. Alcance de la versión 1.0

Decisión del responsable del proyecto, textual:

> «B, se cierra sin modelo real, no importa que no funcione bien pero dejamos el frente abierto para que más adelante consigamos los datos y armemos un modelo con los datos que si nos sirven»

Consecuencias:

1. **La versión 1.0 se cierra sin modelo real.** Un modelo que no funciona bien no es requisito: el que existe es un ensayo y así queda declarado.
2. **El frente del modelo queda abierto**, no abandonado. Lo que lo desbloquea está medido, no supuesto: meteorología diaria en días **sin** incendio (ERA5-Land o la red DMC) unida por (comuna, fecha), y acceso al registro de eventos de CONAF (DOI `10.71578/UXAUN5`, hoy 403 anónimo).
3. **El cómputo de v1.0 se hace sobre lo demás**: diseño web terminado, usuarios y asignación de trabajos, modelo de datos de la aplicación, los doce frentes abiertos del plan de producción y las unidades de hardening pendientes.

El plan de v1.0 con sus tareas vive en [`../tasks/v1-produccion.md`](../tasks/v1-produccion.md).

## 7. D1 resuelta — motor de datos productivo, backups y SLA (2026-11-09)

**Decisión del responsable del proyecto: Ricardo Saavedra F., 2026-11-09.** Cierra D1. Es una decisión de arquitectura del proyecto; el mandante no la contrafirma, y el §7.2 registra lo que sí queda abierto de su lado: la residencia de los datos.

### Motor elegido

**PostgreSQL 17 con PostGIS 3.5, autogestionado en contenedor, sobre AWS EC2 con Docker Compose.** No es una decisión nueva: es la que ya estaba tomada en [`../tasks/plan-produccion/architecture-change-aws.md`](../tasks/plan-produccion/architecture-change-aws.md) §3-§4 el 2026-11-06 —«PostGIS en contenedor (con Compose); administrada solo si se adopta Kubernetes»— y que el registro de decisiones nunca recogió, por eso D1 seguía figurando como abierta.

**Superseded en su sustrato por la corrección del §7.3 (2026-11-17).** El párrafo anterior se conserva como historia, no como decisión vigente: el motor no cambia y el sustrato de entrega sí. El Compose en una VM deja de ser la forma de producción y el despliegue pasa a un clúster de Kubernetes. El §7.3 fija qué se sustituye, qué queda igual, con qué evidencia y qué sigue abierto.

### 7.1 Por qué se propuso Oracle y por qué quedó fuera

**Oracle nunca fue un requisito del mandante.** Fue una propuesta del propio responsable del proyecto, y su motivo no era técnico sino de **residencia de datos**: los servidores están en Santiago y Valparaíso, y así los datos no salen de Chile. Corrección del responsable, textual:

> «usar oracle nunca fué un requisito del mandante, fué una idea mia porque los servidores estan en stgo y en valpo, asi los datos no salen de chile, lo de aws es una solución porque no podiamos crear la cuenta en oracle y la profe dijo que igual sería una buena opción, al menos para que funcione ya que la ultima presentación no lo pudimos tener montado funcionando en servidor»

Quedó fuera por una razón práctica, no por un análisis: no se pudo crear la cuenta en Oracle, y AWS entró como salida para tener el sistema **funcionando en un servidor**, que es lo que la presentación anterior no logró. El motor que se registra aquí es el que el código usa.

Lo que sí ata al código —medido en el repositorio, no supuesto— es lo siguiente, y es lo que costaría volver a Oracle:

| Dependencia | Dónde | Qué exige de Oracle |
| --- | --- | --- |
| `ON CONFLICT` (upsert) | 6 sitios, incluidos el outbox de `jobs` y `risk` y la proyección del directorio en `prevention` | No existe el mismo constructo: se escribe con `MERGE`, uno por uno |
| PostGIS (`geography`, `ST_*`) | geometría de zonas y GeoJSON de salida | SDO_GEOMETRY: funciones, índices y semántica distintas: se reescribe la capa geográfica |
| Tipo `uuid` | `directory_users` y los contratos | No nativo antes de 23ai: `RAW(16)` o `VARCHAR2`, y eso toca esquema y mapeo |
| `pgxpool` | los tres servicios | Otro driver (`godror`), en cada constructor de repositorio y sus pruebas |
| Runner de migraciones | aplica DDL y escribe el ledger en la misma transacción | El DDL de Oracle hace **commit implícito**: una migración fallida deja esquema a medias y sin fila en el ledger |

**Costo de volver a Oracle, sin adornos:** no es configuración, es un proyecto —reescribir SQL y capa geográfica en tres servicios, rehacer el runner, levantar un Oracle real para las pruebas de repositorio y volver a correr la verificación completa— y mientras dure deja esperando a los frentes 2, 6 y 12. Este acta no lo autoriza ni lo descarta: lo dejó de ser necesario al dejar de ser un requisito.

### 7.2 Residencia de datos: lo que verifiqué hoy

La preocupación original era real y no quedó resuelta por elegir AWS. Comprobado en las fuentes de AWS el 2026-11-09:

| Evidencia | Qué dice |
| --- | --- |
| `https://aws.amazon.com/about-aws/global-infrastructure/regions_az/` | Declara la región «South America (Chile)» con id **`sa-west-1`**, en Santiago, y la marca **`"available": false`** con **0** zonas de disponibilidad |
| `https://ip-ranges.amazonaws.com/ip-ranges.json` (`createDate` 2026-11-09) | Contiene `sa-west-1` y `sa-east-1`; ninguna región con otro código aparece en Sudamérica |

**Consecuencia, sin rodeos:** desplegar hoy en AWS significa desplegar en **São Paulo (`sa-east-1`)**, y los datos salen de Chile. La región chilena está anunciada pero no disponible, así que la meta de residencia **no se cumple con el despliegue actual** y no hay forma de que este acta la cumpla escribiéndola mejor.

Las tres salidas posibles, para que la decisión sea explícita cuando toque:

1. **Aceptar São Paulo** y registrar que los datos salen de Chile. Es lo que ocurre si se despliega sin cambiar nada.
2. **Esperar `sa-west-1`**, sin fecha de disponibilidad publicada en la fuente consultada; bloquea el despliegue indefinidamente.
3. **Buscar un proveedor con región en Chile** — Oracle Cloud u otro —, lo que devuelve el problema del motor del §7.1 a la mesa con su costo.

**Decisión registrada el 2026-11-09: se despliega en São Paulo (`sa-east-1`) como solución temporal**, aceptando de forma explícita que los datos salen de Chile. La condición para revisarla está escrita, no implícita: que `sa-west-1` pase a disponible, o que se pueda abrir una cuenta en un proveedor con región en Chile.

**El traslado a Santiago no es un cambio de configuración: es una migración.** Cuando la región exista, hay que mover datos, backups y secretos, y volver a correr la verificación; por eso la política de backups del §7 tiene que poder exportar a la región de destino desde el primer día, y esa es la única decisión de este acta que mira hacia adelante en vez de registrar el presente.

Lo que **no** se hace: desplegar en São Paulo y dejar de mencionar la residencia. Queda escrito que hoy no se cumple, con fecha y con su condición de salida.

### 7.3 Sustrato de entrega: corrección del 2026-11-17

**Supersede el sustrato de D1, no el motor.** Requisito del responsable del proyecto, textual: «por pedido de la profe tenemos que usar si o si kubernetes para montar la app por lo que dejemoslonpreparado para kubernetes» (S1 de [`../tasks/kubernetes-deployment.md`](../tasks/kubernetes-deployment.md)) y «me quedo con ti tercera opción, todo en el cister y documentado» (S3 del mismo documento). La entrega se monta en Kubernetes y el plano de datos vive dentro del clúster.

**Qué se sustituye, textualmente.** De este §7, la frase «PostgreSQL 17 con PostGIS 3.5, autogestionado en contenedor, sobre AWS EC2 con Docker Compose» deja de leerse como decisión vigente en su parte de sustrato: **sobre AWS EC2 con Docker Compose** pasa a **sobre un clúster de Kubernetes, con el plano de datos dentro del clúster**. Del mismo modo queda sustituida la forma de despliegue que fijaba [`../tasks/plan-produccion/architecture-change-aws.md`](../tasks/plan-produccion/architecture-change-aws.md) §4: «Se implementa Docker Compose en una VM y Kubernetes queda documentado como objetivo». Las dos frases se conservan como historia en sus documentos, no como decisión vigente.

**Qué no cambia, y esto no es un cambio de motor.** El motor sigue siendo **PostgreSQL 17 con PostGIS 3.5**. La residencia de datos del §7.2 y la política de backups de este §7 —`pg_dump` a S3 cada 15 minutos, retención de 30 días, restore mensual probado, con los objetivos de SLA/RPO/RTO— se mantienen tal como están escritas, incluidas sus dos salvedades: **no están implementadas ni medidas**. Y el plano de datos sigue **dentro del clúster**: PostgreSQL con PostGIS y RabbitMQ como StatefulSet. La sustitución por servicios gestionados queda documentada con su costo y sus condiciones, **no adoptada**.

**Qué cambia.** El sustrato de despliegue y operación: manifiestos en `backend/deploy/k8s/`, con `base` como plantilla y `overlays/delivery` fijando los cinco digests. El Compose de producción deja de ser sustrato productivo, y no por preferencia: `backend/docker-compose.prod.yml` no incluye el servicio `inference`, declara `APP_ENV: production` con `AMQP_URL: amqp://` y lleva DSN con `sslmode=disable`, así que no pasaría sus propias guardas de transporte. Estaba registrado en [`../tasks/kubernetes-deployment.md`](../tasks/kubernetes-deployment.md) L10 y se resuelve aquí.

**Evidencia, fusionada en `main` antes de esta corrección.** PR #67 `4457d38` (CI en verde, ocho workflows), PR #68 `0edf263` (overlay de entrega con los cinco digests; trece pods en `Running` y ambos Jobs en `Complete`), PR #69 `2687ec0` (metrics-server y HPA escalando de 2 a 6 con evento `SuccessfulRescale` medido) y PR #70 `638c55e` (borde TLS ejercitado: `401` del gateway a través del ingress y `502` con ancla equivocada). Los registros de fusión #71 `835d820` y #72 `734670c` quedaron en el mismo frente. El detalle observado, con lo que no se observó, está en [`../tasks/kubernetes-deployment.md`](../tasks/kubernetes-deployment.md) L20 y L22 y en [`../tasks/k8s-delivery-closure.md`](../tasks/k8s-delivery-closure.md).

**Qué sigue abierto, y no se disimula.** (1) El entorno objetivo: todo lo observado es un clúster local de evidencia, sin despliegue en el entorno autorizado (T9). (2) El realm de Keycloak se sigue aprovisionando fuera de banda. (3) La elección vinculante del sabor de clúster no está tomada y se documenta en T10.2 de [`../tasks/kubernetes-deployment.md`](../tasks/kubernetes-deployment.md). (4) La política de backups y el restore probado siguen sin implementar ni medir, igual que antes de esta corrección.

**Cómo se lee el resto del §7.** Esta corrección es parcial: alcanza al sustrato de entrega y a las frases que lo describían. Todo lo demás de este §7 —motor, impacto en migraciones y persistencia, residencia, política de backups, SLA y sus salvedades— sigue vigente tal como está escrito.

### Impacto en migraciones

**Ninguno.** Las 14 versiones del ledger compartido se aplican tal como están sobre el motor elegido. La regla de versiones y el conteo por servicio viven en [`../../backend/docs/migration-ledger.md`](../../backend/docs/migration-ledger.md); `risk` y `prevention` comparten `schema_migrations` y `jobs` migra su propia base. La restricción que sí introduce un motor autogestionado es otra y está abajo: el volumen persiste, y su backup es responsabilidad nuestra, no del proveedor.

### Impacto en persistencia

Se mantiene lo construido: PostGIS `geography` para zonas y su GeoJSON, `uuid` para identidades, `timestamptz` para instantes y `pgxpool` como pool. El inventario real —22 relaciones, 138 columnas, 19 claves primarias, 10 claves foráneas— vive en [`../../backend/docs/schema-inventory.md`](../../backend/docs/schema-inventory.md) y su modelo de dominio en [`../../backend/docs/domain-model.md`](../../backend/docs/domain-model.md). Con el volumen gestionado por nosotros —Compose en la VM cuando se escribió esto, StatefulSet en el clúster desde el §7.3— no hay backup automático de plataforma, y por eso la política de la sección siguiente no es opcional.

### Política de backups

| Parámetro | Valor |
| --- | --- |
| Método | Backup completo lógico (`pg_dump`) cada 15 minutos hacia S3, con retención de 30 días y cifrado en reposo |
| Verificación | Un restore completo sobre una instancia aislada, contabilizado y registrado con su duración |
| Frecuencia de prueba | Mensual, y después de cualquier cambio de esquema mayor |
| Qué no se promete | PITR por segundo: el RPO elegido no lo exige, y añadirlo es una mejora posterior, no un requisito de la 1.0 |

**Estado real: la política está escrita y no implementada.** No existe hoy ni el envío a S3 ni el restore probado; `../../backend/docs/verification.md:64` ya declaraba recuperación y SLA sin probar. Implementarla y probarla es trabajo de las tareas T3 y T4 del frente 14, no de esta acta, y este documento no acredita lo que no existe.

### SLA acordado

| Métrica | Meta |
| --- | --- |
| Disponibilidad mensual | **99,5%** (metas iniciales de `Referencias/EP1_Equipo3_Armijo_Calderon_Saavedra2_produccion.md:90`) |
| RPO | **15 minutos** — el ciclo de ingesta es de 15 minutos, así que una restauración cuesta como máximo un ciclo de trabajo aceptado |
| RTO | **1 hora** |
| Frescura de datos | Ciclo de 15 minutos, con alerta de trabajo atascado a los 1200 s (el doble del ciclo) |

**Ninguna de las cuatro está medida.** Son objetivos acordados, no resultados: el frente 6 mide carga y p95 con su benchmark, y el frente 14 debe ejecutar un restore real para convertir el RTO en un número observado. Ninguna cifra de este §7 se declara medición.

### Lo que este §7 no cierra

- **El restore probado.** Sin él, RPO y RTO son una promesa, no una capacidad.
- **La pregunta por el motor administrado.** Dejó de ser hipotética al adoptarse Kubernetes (§7.3): se documenta con su costo y sus condiciones y **no se adopta**. El plano de datos sigue dentro del clúster.
- **El entorno objetivo del despliegue.** Con el sustrato del §7.3, el runbook de Compose en `../../backend/deploy/prod/README.md` ya no describe el camino productivo. El entorno autorizado, su dominio y el certificado de borde se resuelven en T9 y en la elección vinculante de clúster de T10.2 de `../tasks/kubernetes-deployment.md`.
- **La residencia permanente en Chile.** Hoy se acepta São Paulo como solución temporal (decisión del 2026-11-09, §7.2); que los datos vuelvan a Chile depende de que `sa-west-1` esté disponible o de abrir la cuenta en un proveedor con región chilena, y el traslado será una migración con verificación, no un cambio de configuración.

### 7.4 Proveedor de nube: corrección del 2026-11-17

**Supersede la dimensión proveedor de D1, y solo esa.** Decisión del responsable del proyecto, textual, del 2026-11-17: «mira al final nos haremos un server en google cloud para montar todo esto en kubernetes, dejemos esto avanzado porfa» (S1 de [`../tasks/gcp-gke-delivery.md`](../tasks/gcp-gke-delivery.md)). El sustrato sigue siendo Kubernetes, que es lo que el §7.3 fijó; lo que cambia es quién provee la nube y con qué servicios.

**Qué se sustituye, textualmente.** De la frase del «Motor elegido» —«PostgreSQL 17 con PostGIS 3.5, autogestionado en contenedor, sobre AWS EC2 con Docker Compose», ya enmendada en su sustrato por el §7.3— deja de leerse como vigente la parte de proveedor: **AWS EC2** pasa a **Google Cloud con GKE**. La frase original y la corrección del §7.3 se conservan como historia; esta corrección alcanza solo a la dimensión de proveedor.

| Dimensión de D1 | Antes (historia) | Ahora |
| --- | --- | --- |
| Proveedor y sustrato de despliegue | AWS EC2, con Docker Compose (este §7, 2026-11-09) | **Google Cloud con GKE**, un clúster de Kubernetes (este §7.4, sobre el sustrato del §7.3) |
| Registro de imágenes | Amazon ECR | **Artifact Registry** |
| Almacenamiento de objetos para los `pg_dump` | Amazon S3, acceso por rol IAM | **Cloud Storage**, acceso por IAM de Google con Workload Identity, sin claves estáticas |
| Autorización de acceso a esos servicios | Roles de IAM de AWS | **IAM de Google**: cuentas de servicio, y `roles/iam.workloadIdentityUser` para que un ServiceAccount del clúster use una de ellas |
| Región | São Paulo (`sa-east-1`), compromiso temporal del §7.2 | **`southamerica-west1` — Santiago, Chile** |

**Qué no cambia, y esto no es un cambio de motor ni de sustrato.** (1) El motor: **PostgreSQL 17 con PostGIS 3.5**. (2) El sustrato: Kubernetes, con los manifiestos de `backend/deploy/k8s/` —`base` como plantilla y `overlays/delivery` con los cinco digests— y el plano de datos **dentro del clúster** como StatefulSet, con la sustitución por servicios gestionados documentada y **no adoptada**. (3) La política de backups de este §7 —`pg_dump` a S3 cada 15 minutos, retención de 30 días, restore mensual probado, con los objetivos de SLA/RPO/RTO— se mantiene tal como está escrita, incluidas sus dos salvedades: **no está implementada ni medida**. El destino del envío cambia de S3 a Cloud Storage, que es la pieza equivalente en el proveedor nuevo; la política no cambia. (4) Los objetivos de SLA/RPO/RTO: 99,5 % de disponibilidad mensual, RPO 15 minutos y RTO 1 hora, ninguno medido. Nada de eso estaba atado a AWS: estaba atado al motor y al clúster, y los dos siguen donde estaban.

**Qué resuelve.** El §7.2 dejó São Paulo como solución temporal **porque no había región chilena**, y escribió su condición de salida en dos ramas: que `sa-west-1` estuviera disponible, o que se abriera la cuenta en un proveedor con región en Chile. La segunda rama se cumple: según la documentación oficial de ubicaciones de Google Cloud (`https://cloud.google.com/about/locations`, consultada el **2026-11-17**), **`southamerica-west1` es Santiago, Chile**. Es decir, el compromiso de residencia del §7.2 deja de ser un compromiso y pasa a ser una elección de región dentro del mismo proveedor. No hay medición propia detrás de esa frase —la fuente es del proveedor y la fecha es la de la consulta— porque no hay cuenta que medir.

**Qué no resuelve.** (1) **No hay proyecto, ni clúster, ni credenciales.** Esta subsección registra una decisión, no un despliegue, y `gcloud` no está instalado en la máquina donde se escribe. (2) **La disponibilidad de cada servicio y de cada tipo de máquina en `southamerica-west1` se verifica al contratar**: que la región exista no implica que cada pieza ofrecida esté ahí, y este documento no afirma lo segundo. (3) **El traslado sigue siendo una migración**: cuando exista el entorno hay que mover datos, backups y secretos y volver a correr la verificación, igual que el §7.2 ya advertía. (4) La política de backups y el restore probado siguen sin implementar ni medir.

**Consecuencia sobre el §7.2, explícita.** El retorno de los datos a Chile **deja de depender de encontrar un proveedor** y pasa a ser una **elección de región**: el destino es `southamerica-west1` y la residencia se configura en lugar de negociarse. La decisión del 2026-11-09 —«se despliega en São Paulo (`sa-east-1`) como solución temporal»— queda superseded como destino: se conserva como historia, y su condición de salida se satisface por la segunda rama que ella misma escribió. La viñeta «La residencia permanente en Chile» de «Lo que este §7 no cierra», inmediatamente arriba, se lee con esta consecuencia y no como estado vigente.

**Consecuencia sobre el §7.3.** Su punto abierto (3) —«la elección vinculante del sabor de clúster no está tomada y se documenta en T10.2»— **queda cerrado aquí**: el sabor es **GKE** por esta decisión, y `backend/deploy/k8s/README.md` registra el camino concreto, con GKE Standard como forma recomendada frente a Autopilot y sus restricciones reales. El resto de lo que el §7.3 dejó abierto sigue abierto: el entorno objetivo (T9), el realm de Keycloak aprovisionado fuera de banda y la política de backups sin implementar.

**Qué lo acredita, y qué no.** Acredita la decisión la frase del responsable, con su fecha, y esta subsección. **No** acredita nada desplegado: no hay cuenta, ni proyecto, ni clúster, ni bucket, ni repositorio de imágenes, y ningún comando de `gcloud` se ejecutó. La tarea T3 de [`../tasks/gcp-gke-delivery.md`](../tasks/gcp-gke-delivery.md) es la que lo cubre, y está bloqueada precisamente por eso.

**Cómo se lee esta subsección.** Es parcial, con el mismo mecanismo del §7.3: no borra ni reescribe nada de lo anterior, cambia lo que se lee como vigente y lo declara. Todo lo que este §7 dice del motor, de las migraciones, de la persistencia, de la política de backups y del SLA sigue como está escrito; lo único sustituido es el proveedor y los nombres de sus servicios. La tabla del §3 no se reescribe: describe el 2026-11-09 y su fila A5 sigue nombrando EC2 y los roles de AWS porque eso era lo que estaba abierto entonces.

**Nota de ubicación.** Esta subsección se agrega **al final del §7** y no entre el §7.3 y «Impacto en migraciones» a propósito: las citas por número de línea que hoy apuntan a `:185-212` de este archivo —en `backend/deploy/k8s/README.md` y en L24 de [`../tasks/kubernetes-deployment.md`](../tasks/kubernetes-deployment.md), que es un Log con fecha y no se reescribe— siguen resolviendo al mismo contenido.
