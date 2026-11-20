# Requerimientos de producto del mandante — 20 funcionalidades

**Propósito:** fijar como fuente versionada el pedido de producto del mandante —veinte funcionalidades de interfaz y análisis— y registrar, con anclaje en el árbol, cuánto de cada una existe hoy. Sin este documento el pedido vive en una conversación y no se puede ni ejecutar ni auditar.
**Fuente:** transcripción literal del pedido del mandante. **No existía documento en el repositorio**: se buscó en `Referencias/` y en `odd/` por las cadenas distintivas (`Simulador`, `Qué pasaría si`, `NDVI`, `hidrantes`, `microbasural`, `Bitácora de decisiones`, `Asistente IA`) y no hay ningún archivo que contenga la lista. La única coincidencia de «simulador» es una metáfora en [`presentacion-mandante.md:148`](presentacion-mandante.md).
**Base de código:** `d4afba7`, rama `main`, corte del **2026-11-18**.
**Regla del documento:** un estado **no** es una casilla marcada. Este corte **no cierra ninguna funcionalidad** y **no cierra ningún ID** del checklist de 132. Toda fila marca «existe» porque se leyó un archivo o se buscó en el árbol; **no se levantó el stack ni se ejecutó una prueba funcional** para escribirlo.

---

## 1. El pedido, literal

Transcrito sin reordenar, sin corregir y sin traducir. Las 20 filas y su texto son del mandante; la numeración es la que él usó.

| # | Funcionalidad | Qué debería hacer |
|--:|---|---|
| 1 | Panel ejecutivo de riesgo | Mostrar cantidad de zonas en riesgo Alto/Medio/Bajo, zonas críticas, variación reciente, alertas activas y variables predominantes |
| 2 | Priorización territorial | Ordenar automáticamente las zonas que requieren mayor atención considerando riesgo + viviendas + colegios + infraestructura + vegetación |
| 3 | Explicación del riesgo | No mostrar solo «ALTO»; explicar qué variables provocaron el resultado: viento, humedad, temperatura, vegetación, historial |
| 4 | Simulador «¿Qué pasaría si...?» | Modificar viento, temperatura, humedad u otra variable y recalcular el riesgo |
| 5 | Recomendaciones preventivas | Según nivel y factores de riesgo, sugerir acciones preventivas diferenciadas |
| 6 | Alertas inteligentes | Generar una alerta cuando una zona cambie de nivel o supere un umbral definido |
| 7 | Evolución temporal | Mostrar cómo ha cambiado el riesgo de una zona durante horas/días/semanas |
| 8 | Comparador de zonas | Seleccionar 2–3 sectores y comparar riesgo, variables, historial y prioridad |
| 9 | Historial de evaluaciones | Guardar cada cálculo de riesgo con fecha, variables, resultado y usuario |
| 10 | Gestión de incidentes preventivos | Registrar observaciones: vegetación seca, microbasural, quema, acceso bloqueado, etc. |
| 11 | Seguimiento de acciones | Crear una acción preventiva, asignar responsable, estado y fecha de ejecución |
| 12 | Infraestructura crítica | Mostrar colegios, viviendas, hospitales, rutas, hidrantes u otros elementos expuestos |
| 13 | Capas satelitales/vegetación | Incorporar NDVI, condición de vegetación o combustible como capa complementaria |
| 14 | Reporte automático PDF | Generar ficha de una zona con riesgo, causas, mapa, recomendaciones y fecha |
| 15 | Exportación de datos | Descargar resultados en CSV/PDF para análisis o entrega al mandante |
| 16 | Roles y usuarios | Administrador, analista, visualizador/mandante |
| 17 | Bitácora de decisiones | Registrar quién consultó, qué observó y qué acción preventiva se adoptó |
| 18 | Centro de notificaciones | Historial de alertas, cambios de riesgo y eventos relevantes |
| 19 | Estado de servicios | Mostrar si API, modelo, datos meteorológicos y servicios están operativos |
| 20 | Asistente IA explicativo | Permitir preguntas como «¿por qué esta zona tiene riesgo alto?» usando los resultados reales del sistema |

---

## 2. Por qué este documento es un documento aparte

El repositorio ya tiene una familia de requerimientos y **estas 20 filas no pertenecen a ella**. Confundirlas costaría caro en ambos sentidos.

| Familia | Qué es | Dónde vive | Qué la cierra |
|---|---|---|---|
| **132 IDs** (`GOB-I1`, `DAT-V2`, …) | Criterios de aceptación de IA, datos, modelo, operación y gobierno | [`Referencias/tareas_verificacion_implementacion_IA.md`](../Referencias/tareas_verificacion_implementacion_IA.md), con su corte en [`estado-requerimientos-cliente.md`](estado-requerimientos-cliente.md) | Evidencia reproducible + umbrales acordados + responsable nombrado + datos reales cuando el criterio los pide |
| **20 funcionalidades** (este documento) | Superficie de producto: qué ve y qué hace el usuario | Este archivo | Que la capacidad exista de punta a punta —contrato, backend y página— y que alguien la ejercite |

Ninguna de las dos cierra a la otra. Un panel ejecutivo perfecto no aporta evidencia de sesgo ni de robustez; un `MET-V1` cerrado no le sirve de nada al mandante frente a la pantalla.

**El cruce que ya existía y nadie había anotado.** La página declara por escrito siete capacidades que el backend no respalda, en `NOT_IMPLEMENTED` de [`frontend/src/views/PendingView.tsx`](../frontend/src/views/PendingView.tsx), y esas siete están planificadas como `V1-P-01`…`V1-P-07` en [`tasks/v1-produccion.md`](tasks/v1-produccion.md) (G6). **Tres de las veinte funcionalidades del mandante son, casi palabra por palabra, tres de esas siete filas.** Eso es lo primero que hay que aprovechar: parte del pedido nuevo ya tiene tarea, criterio de cierre y forma de cerrarse.

---

## 3. Corte verificado de las 20

Estados: **Ausente** = no existe artefacto; **Parcial** = existe algo ejecutable que hace parte o la mayoría, y falta lo que la columna dice; **Implementado** = el usuario puede ejercitarla hoy por la API y por la página.

| # | Funcionalidad | Estado | Ancla | Qué existe y qué falta |
|--:|---|---|---|---|
| 1 | Panel ejecutivo | **Parcial** | [`risk/zones`](../backend/contracts/openapi/firewatch-v1.yaml), [`risk/latest`](../backend/contracts/openapi/firewatch-v1.yaml), [`OverviewView.tsx`](../frontend/src/views/OverviewView.tsx) | Existe el catálogo de zonas, el último lote y la contribución por variable. Falta el agregado por nivel (hoy se cuenta en el cliente), la definición de «zona crítica» —no hay umbral acordado—, la **variación reciente** como delta explícito y las **alertas activas**, que no existen porque no hay entidad de alerta |
| 2 | Priorización territorial | **Ausente** | `V1-P-02` en [`tasks/v1-produccion.md`](tasks/v1-produccion.md) | El backend clasifica una zona con el lote publicado y **no calcula prioridad**. No hay viviendas, colegios, hospitales ni hidrantes en ninguna tabla: `zones` solo tiene `code, name, province, kind, geometry` ([`004_zones.sql:1-7`](../backend/services/risk/migrations/004_zones.sql)). Tampoco hay pesos acordados para la suma |
| 3 | Explicación del riesgo | **Parcial — el backend ya lo hace** | [`classifier.go:140-152`](../backend/services/risk/internal/classify/classifier.go), [`academic_rule.go:222-246`](../backend/services/risk/internal/classify/academic_rule.go), [`firewatch-v1.yaml:1793`](../backend/contracts/openapi/firewatch-v1.yaml) | **La corrección más importante de este corte.** `Factor{name, known, value, contribution, note}` ya se calcula, se persiste en `batches.factors` ([`classifier.go:145`](../backend/services/risk/internal/classify/classifier.go)) y **el contrato lo exige con `contribution`** ([`:1836-1848`](../backend/contracts/openapi/firewatch-v1.yaml)). Las cinco variables canónicas son `temperatura`, `humedad_relativa`, `viento`, `cobertura_vegetal`, `incendios_historicos` ([`observations.go:160-166`](../backend/contracts/gen/observations/v1/observations.go)) — **exactamente la lista que pide el mandante**. Falta la presentación que lo lea como explicación, el resumen de factor dominante y la advertencia de que es aritmética de una regla, no atribución causal |
| 4 | Simulador | **Ausente** | — | El clasificador es una función pura con parámetros congelados por hash ([`academic_rule.go:19-25`](../backend/services/risk/internal/classify/academic_rule.go)), así que **el cálculo contrafactual es viable sin datos nuevos**. Faltan el endpoint y la interfaz. Restricción de diseño: no puede reutilizar `POST /v1/risk/cycle/run`, porque ese escribe lote y contaminaría el historial |
| 5 | Recomendaciones preventivas | **Parcial** | [`prevention/actions`](../backend/contracts/openapi/firewatch-v1.yaml), [`ActionsView.tsx`](../frontend/src/views/ActionsView.tsx) | El **registro** de una acción está resuelto y es de lo más maduro del sistema. Lo que no existe es la **sugerencia**: no hay catálogo de recomendación por nivel ni por factor, y ningún endpoint propone una acción |
| 6 | Alertas inteligentes | **Ausente** | — | Hay un contador Prometheus y siete reglas que evalúan, pero **sin Alertmanager, así que no las envía a nadie** ([`presentacion-mandante.md:58`](presentacion-mandante.md)). No hay tabla de alertas, ni detección de cambio de nivel, ni umbral aplicado al producto. Ninguna migración crea una entidad de alerta |
| 7 | Evolución temporal | **Parcial** | [`risk/history`](../backend/contracts/openapi/firewatch-v1.yaml), [`012_readings.sql:1-12`](../backend/services/risk/migrations/012_readings.sql) | Existe la serie por zona y la tabla `readings` con `variable, observed_at, value, unit, source_id, quality` por zona. Falta: el historial **exige `zone_id`** —declarado en `NOT_IMPLEMENTED`, fila «Historial de todas las zonas»—, no hay agregación por granularidad (horas/días/semanas) y no hay serie del *nivel* a lo largo del tiempo |
| 8 | Comparador de zonas | **Ausente** | [`005_zone_reference.sql:24`](../backend/services/risk/migrations/005_zone_reference.sql) | El sustrato **no está bloqueado**: la migración `005` retiró el `CHECK (zone_id = 'valparaiso-demo')` que congelaba una sola zona, así que varias zonas ya son legítimas. Falta el endpoint multi-zona, la vista, y la prioridad del ítem 2, que es uno de los cuatro ejes de comparación |
| 9 | Historial de evaluaciones | **Parcial** | [`001_initial.sql:1-18`](../backend/services/risk/migrations/001_initial.sql), `GET /v1/audit` | Fecha, variables de entrada, resultado y versión del modelo quedan guardados por lote. Falta el **usuario**: el ciclo corre desde el programador sin actor, y solo una corrida manual tiene actor, reconstruible únicamente uniendo por `audit`/`job_id`. No hay columna de actor en `batches` |
| 10 | Incidentes preventivos | **Ausente** | — | No existe entidad de observación de campo. `prevention` gestiona **acciones**, no **observaciones**: vegetación seca, microbasural, quema y acceso bloqueado no tienen dónde registrarse. Sin `#10` no hay origen que alimente `#17` |
| 11 | Seguimiento de acciones | **Implementado** | [`009_preventive_actions.sql:9-40`](../backend/services/prevention/migrations/009_preventive_actions.sql), [`/actions/{id}/transitions`](../backend/contracts/openapi/firewatch-v1.yaml) | Los cuatro elementos que pide existen: creación autenticada, `assignee_id` con clave foránea al directorio del proveedor de identidad (migración 14, `V1-U-01`…`V1-U-03` cerradas), una máquina de estados de ocho valores (`propuesta`…`cancelada` con historial por transición) y `due_date`. Único hueco: la **vista** para elegir y ver el responsable, diferida por decisión del responsable (`V1-U-04`, L12). El backend que la necesita ya está hecho |
| 12 | Infraestructura crítica | **Ausente** | — | No hay modelo de punto expuesto: ni colegios, ni viviendas, ni hospitales, ni rutas, ni hidrantes. `zones` no tiene esos campos y no hay tabla paralela. Es el mismo bloqueo que el ítem 2 |
| 13 | Capas satelitales / NDVI | **Parcial** | [`observations.go:162`](../backend/contracts/gen/observations/v1/observations.go) | La **vegetación ya es una variable del modelo**, con peso propio y umbrales `VegetationSparsePct`/`VegetationDensePct` ([`academic_rule.go:182`](../backend/services/risk/internal/classify/academic_rule.go)). Lo que no existe es la **capa**: `grep -ri ndvi` no devuelve nada, no hay ráster, ni ingesta satelital, ni condición de combustible |
| 14 | Reporte PDF | **Ausente** | — | No hay generación de documentos en ningún servicio. Una ficha con mapa, causas y recomendaciones depende de `#3`, `#5` y `#12` |
| 15 | Exportación CSV/PDF | **Ausente** | — | Ninguna operación de exportación en el contrato. La única aparición de `csv` en `backend/` es un valor de fixture en una prueba, no una ruta |
| 16 | Roles y usuarios | **Parcial** | [`firewatch-realm.json`](../backend/deploy/local/firewatch-realm.json), `GET /v1/users` | El realm declara **dos** roles de aplicación, `viewer` y `admin`. El mandante pide **tres**: administrador, **analista** y visualizador. Falta `analista` y falta la matriz de qué puede cada uno. El directorio de usuarios sí está cerrado y probado (`V1-U-01`), y las rutas ya rechazan por rol |
| 17 | Bitácora de decisiones | **Parcial** | `GET /v1/audit`, `V1-P-07` | Hay bitácora de **mutaciones** con `actor_id, action, job_id, trace_id, occurred_at` — identificadores opacos, sin nombre ni detalle libre; es literalmente la fila «Nombre del actor, detalle libre e id de evento» de `NOT_IMPLEMENTED`. Falta además registrar **consultas** («quién consultó») y el vínculo observación→acción, que depende de `#10` |
| 18 | Centro de notificaciones | **Ausente** | — | Depende de `#6`: sin entidad de alerta no hay historial que mostrar. No existe tabla de notificaciones ni de eventos de cambio de nivel |
| 19 | Estado de servicios | **Parcial** | [`risk/status`](../backend/contracts/openapi/firewatch-v1.yaml), [`jobs/status`](../backend/contracts/openapi/firewatch-v1.yaml), [`risk/sources`](../backend/contracts/openapi/firewatch-v1.yaml), [`SourcesView.tsx`](../frontend/src/views/SourcesView.tsx) | Existen los dos estados y la procedencia con frescura por fuente, y el scrape de cinco objetivos está **medido** ([`observability-measurement.md`](../backend/docs/observability-measurement.md)). Falta un tablero único con veredicto operativo, y la salud del «modelo» no puede existir como tal: hoy no hay modelo, hay una regla ([`main.go:352-363`](../backend/services/risk/cmd/server/main.go)) |
| 20 | Asistente IA explicativo | **Ausente** | — | Depende de `#3`, `#4` y `#7`. Es además el ítem con más gobierno encima: [`security/ai-risk-classification-policy.md`](security/ai-risk-classification-policy.md) ya clasifica este sistema y `GRD-I1`/`GRD-I2` —capa anti-inyección de prompts y revisión del contenido de salida— siguen abiertos ([`estado-requerimientos-cliente.md:78`](estado-requerimientos-cliente.md)) |

**Conteo:** **10 ausentes**, **9 parciales**, **1 implementado**. Ninguna de las 20 está cerrada: «implementado» describe que se puede ejercitar, no que esté verificada bajo carga ni con datos reales.

---

## 4. Lo que corrige la intuición, y por qué importa

Tres conclusiones que cambian el orden de trabajo y que no se ven mirando la pantalla:

1. **La explicación no hay que inventarla: ya está calculada y publicada.** El contrato exige `factors` con `contribution` por variable, y las cinco variables son las que el mandante nombró. El ítem 3 es, sobre todo, trabajo de interfaz y de redacción honesta. Es el mejor retorno por unidad de esfuerzo de las veinte.
2. **El simulador tampoco necesita un modelo.** La regla es pura y determinista con parámetros congelados por hash. Un contrafactual es la misma función con una entrada distinta, y por eso puede probarse con valores dorados: misma entrada, misma salida. El riesgo real no es técnico, es de etiquetado — que alguien crea que simular es predecir.
3. **«Una sola zona» ya no es cierto.** La migración `005` retiró la restricción que congelaba `valparaiso-demo`, así que la comparación entre zonas y la priorización territorial no están bloqueadas por el sustrato de datos: están bloqueadas por **infraestructura crítica** (`#12`), que es otra cosa y tiene otro dueño.

---

## 5. Lo que no existe en ninguna forma

Cuatro cosas no están en el árbol de ninguna manera, y conviene decirlas antes de que las pregunten:

| Ausente por completo | Prueba de ausencia |
|---|---|
| Modelo de infraestructura crítica (`#12`) y, con él, la priorización (`#2`) | `zones` solo tiene `code, name, province, kind, geometry`; ninguna migración crea tablas de colegios, viviendas, hospitales, rutas o hidrantes |
| Entidad de alerta y notificación (`#6`, `#18`) | Ninguna migración crea `alerts` ni `notifications`; las tablas existentes son `audit`, `batches`, `inbox`, `jobs`, `models`, `outbox`, `readings`, `zones` y las seis de `prevention` |
| Capa ráster / NDVI (`#13`) | `grep -ri ndvi backend/` sin resultados; la vegetación existe solo como variable escalar |
| Generación de documentos y exportación (`#14`, `#15`) | Ninguna operación de exportación en el contrato; ninguna dependencia de PDF o de CSV en los `go.mod` ni en `package.json` |

---

## 6. Dependencias: no son veinte tareas, son cinco capas

El orden no lo decide el atractivo, lo decide la dependencia.

| Capa | Funcionalidades | Por qué en este orden |
|---|---|---|
| **A — Cálculo sobre lo que ya hay** | 3, 1, 7, 8, 4 | Cero migraciones, cero datos nuevos. Todo sale de `batches.factors`, `readings` y la regla pura. Es la capa con mejor retorno y la única que se puede probar con valores dorados |
| **B — Persistencia nueva** | 9, 6, 17, 18, 10 | Exige migraciones. Sin entidad de alerta no hay centro de notificaciones (`#18` depende de `#6`), y sin observación de campo no hay vínculo observación→acción (`#17` depende de `#10`) |
| **C — Datos externos** | 12, 13, 2 | **Bloqueada por el mandante.** Catálogo de infraestructura crítica y fuente NDVI. Sin eso, la priorización del ítem 2 se calcula sobre datos inventados |
| **D — Entrega** | 14, 15 | Depende de A para las causas y de C para el mapa y el entorno |
| **E — Transversal** | 16, 19 | `analista` es una decisión de política de acceso; el tablero de servicios ya tiene casi todas sus fuentes |
| **Última** | 20 | Depende de 3, 4 y 7 juntos, y exige cerrar antes `GRD-I1`/`GRD-I2` |

---

## 7. Decisiones que no son de ingeniería

Cuatro, y ninguna se resuelve con código:

| # | Decisión | Quién | Qué desbloquea |
|--:|---|---|---|
| D-A | ¿Los datos de infraestructura crítica los entrega el mandante o se aceptan fixtures **declarados como sintéticos** en la interfaz y en el PDF? | Mandante | Ítems 12, 2, 14 |
| D-B | ¿«Zona crítica» significa un nivel Alto sostenido N ciclos, o riesgo Alto **y** exposición? | Mandante + equipo | Ítem 1; es la definición que hoy falta |
| D-C | ¿Se agrega el rol `analista` al realm y con qué permisos frente a `viewer` y `admin`? | Responsable del proyecto | Ítem 16, y con él la matriz de acceso del ítem 17 |
| D-D | ¿La explicación se rotula «por qué se quemaría» o «cómo lo calculó la regla»? | Mandante | Ítems 3, 4 y 20. Es una decisión de honestidad, no de redacción: con una regla no calibrada y datos sintéticos, lo primero es una afirmación que el sistema no puede sostener |

---

## 8. Cruces con lo que ya está planificado

No se abre trabajo nuevo donde ya hay criterio escrito:

| Funcionalidad | Ya cubierta por | Estado de esa tarea |
|---|---|---|
| 1, 2 («Contexto y prioridad por sector») | `V1-P-02` en [`tasks/v1-produccion.md`](tasks/v1-produccion.md) | Abierta |
| 7 («Historial de todas las zonas») | `V1-P-04` | Abierta |
| 11 (vista del responsable) | `V1-U-04` | Diferida por decisión del responsable (L12) |
| 17 (nombre de actor, detalle, id de evento) | `V1-P-07` | Abierta |
| 13 (vegetación como variable) | Frente 1 y contrato de observaciones | Entregado como variable, no como capa |
| 19 (estado y procedencia) | Frente 5, [`observability-measurement.md`](../backend/docs/observability-measurement.md) | Medido |

El frente nuevo [`plan-produccion/16-producto-mandante.md`](plan-produccion/16-producto-mandante.md) toma estas veinte filas como su spec y **no reabre** lo que ya está cerrado.

---

## 9. Límites de este corte

- **No se ejecutó nada.** Ni stack, ni pruebas, ni la página. Cada ancla es una lectura de archivo o una búsqueda en el árbol.
- **No hay fuente firmada del pedido.** La transcripción de §1 es literal, pero la entrega original no tiene documento ni acta. Mientras eso siga así, cualquier discusión sobre «qué pidió el mandante» se resuelve contra este archivo, y conviene que él lo confirme.
- **«Implementado» no es «verificado».** El ítem 11 se puede ejercitar; eso no dice nada sobre comportamiento bajo carga, con datos reales ni con un responsable ejercitando la vista que falta.
- **Este documento no cierra ningún ID de los 132** ni cambia el conteo de [`estado-requerimientos-cliente.md`](estado-requerimientos-cliente.md). Son familias distintas y ese documento sigue siendo el corte autoritativo de la otra.
- **Los estados envejecen.** El corte es del 2026-11-18 sobre `d4afba7`; cualquier fusión posterior obliga a releer, no a heredar.
