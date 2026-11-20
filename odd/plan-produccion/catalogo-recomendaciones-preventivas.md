# Catálogo de recomendaciones preventivas — nivel × factor (PM-18)

**Qué es:** el contenido escrito del ítem 5 del mandante —«según nivel y factores de riesgo, sugerir acciones preventivas diferenciadas»—. Asocia las cuatro claves de nivel y las cinco variables canónicas con sugerencias concretas de prevención, cada una con su fuente o con la razón de FireWatch cuando el mapeo es una decisión del proyecto. Es el texto del que la ficha de zona sugiere; **no crea, guarda ni envía nada**.
**Estado:** catálogo escrito el 2026-11-20, con su composición ejecutable en la ficha de zona desde el mismo día. **PM-18 sigue abierta:** la entrega está en el árbol de trabajo, sin fusión ni revisión humana, y la disposición formal de R6 no está tomada. Crear una acción sigue siendo del ítem 11. Lo que existe y lo que falta, en §8.
**Claves de nivel y factor:** verificadas contra el contrato y el código, no supuestas. Niveles `bajo`, `medio`, `alto`, `desconocido` (`firewatch-v1.yaml:1834`, `classify/classifier.go:30-33`, `frontend/src/domain/risk-level.ts:21-33`); variables `temperatura`, `humedad_relativa`, `viento`, `cobertura_vegetal`, `incendios_historicos` (`contracts/gen/observations/v1/observations.go:159-163`).
**Fuentes de las medidas:** dos páginas públicas de SENAPRED y MINVU, verificadas y parafraseadas en §7. **Ninguna de las dos instituciones revisó ni valida el mapeo de este catálogo a nuestros niveles y variables.**

## Respuesta corta

El nivel elige una pareja base de recomendaciones. Los factores con lectura y aporte mayor que cero eligen hasta dos más, en orden de aporte. Se muestran como máximo cuatro, **sin repetir y sin rellenar**: si la composición da tres ítems porque uno se repitió o un factor no tenía lectura, se muestran tres. Ninguna sugerencia es una orden, un pronóstico ni una instrucción de emergencia.

## 1. Las claves

### Nivel — cuatro identificadores, ninguno inventado

| Identificador (contrato) | Etiqueta que muestra la página | Qué significa | Base que se muestra |
|---|---|---|---|
| `bajo` | BAJO | La regla clasificó el lote en la banda baja. | R-01, R-02 |
| `medio` | MEDIO | La regla clasificó el lote en la banda media. | R-01, R-03 |
| `alto` | ALTO | La regla clasificó el lote en la banda alta. | R-03, R-04 |
| `desconocido` | INFORMACIÓN INSUFICIENTE | Falta una variable, o hay un valor no numérico o un instante inconsistente: la regla **no clasifica**. No es una severidad. | ninguna — ver §5 |
| cualquier otro valor, `null` o ausente | SIN CLASIFICAR | No es un nivel del sistema. La página ya lo trata así (`risk-level.ts:31-32`). | ninguna — ver §5 |

### Factor — cinco variables canónicas

| Identificador | Qué aporta al puntaje la regla | Ítem de factor |
|---|---|---|
| `temperatura` | Sube con el calor. | R-06 |
| `humedad_relativa` | Sube cuando el ambiente está seco. | R-07 |
| `viento` | Sube con la velocidad del viento. | R-08 |
| `cobertura_vegetal` | Sube con la cobertura de vegetación. | R-01 |
| `incendios_historicos` | Sube con el historial de incendios del entorno. | R-04 |

El aporte de cada variable es un número entre `0` y su peso, nunca negativo (`classify/academic_rule.go:178-184, 246-258`). Por eso la composición usa **`aporte > 0`**, que es el límite natural del propio cálculo: **no se introduce ningún umbral nuevo**.

## 2. Cómo se compone (regla determinista)

Recibe el lote publicado que ya se muestra en la ficha —`risk_level` y `factors`— y devuelve una lista de ítems. Nueve pasos, todos observables:

1. Leer `risk_level`. Si no es uno de los cuatro identificadores, ir a §5: **fallback cerrado**, sin base ni factores.
2. Si es `desconocido`, ir a §5: **fallback de nivel no clasificado**.
3. Base = la pareja del nivel en §1, en el orden escrito.
4. Recorrer las cinco variables **en el orden canónico fijo** (`temperatura`, `humedad_relativa`, `viento`, `cobertura_vegetal`, `incendios_historicos`). Conservar solo las que tengan `known: true` **y** `contribution > 0`.
5. Ordenar esas variables por `contribution` de mayor a menor. **Empate:** gana la que está antes en el orden canónico. Los empates se resuelven así porque ese orden es el que el contrato y el código ya comparten; no se agrega otro criterio.
6. Tomar las **dos primeras** y traducirlas a su ítem de factor.
7. Orden de pantalla: primero los ítems de factor en el orden del paso 5, después los de la base en el orden del paso 3.
8. Quitar duplicados por identificador de ítem. **El hueco que deja un duplicado no se rellena** con otro ítem: la lista sale más corta y eso se declara, no se disimula.
9. Anteponer los avisos que correspondan: lote sintético (`demo: true`), variables sin lectura, y la nota de que la sugerencia es prevención general (§6).

**Máximo en pantalla: cuatro.** Es un límite de presentación, no un umbral de riesgo. Los dos ítems de base por nivel (§1) y los dos factores del paso 6 son la misma clase de decisión: presupuesto de lectura de la ficha, escrito aquí para que dos implementaciones no elijan distinto.

## 3. Los ítems

### Por nivel

| ID | Sugerencia (paráfrasis de la fuente) | Fuente o razón |
|---|---|---|
| R-01 | Retira la vegetación seca y los desechos acumulados alrededor de la vivienda. | SENAPRED: despejar vegetación y desechos inflamables en el entorno de las viviendas; MINVU: «Cuida tu entorno». |
| R-02 | Mantén despejadas, con anticipación, las vías de salida y los accesos que usarías ante una emergencia. | MINVU: preparar y mantener despejadas las vías de evacuación antes de que haga falta. Es preparación, no una orden de evacuación. |
| R-03 | Restringe fogatas, parrillas, quema de desechos y otras fuentes de calor cerca de vegetación. | SENAPRED: evitar fogatas, parrillas y fuentes de calor cerca de vegetación; MINVU: «Uso seguro de elementos combustibles». |
| R-04 | Coordina con la municipalidad o la junta de vecinos una revisión del entorno y de las vías de salida. | MINVU: planificación comunitaria con las municipalidades. |

### Por factor

| ID | Sugerencia (paráfrasis de la fuente) | Fuente o razón |
|---|---|---|
| R-06 | En días calurosos, evita herramientas y trabajos que generen chispas al aire libre, sobre todo cerca de vegetación. | SENAPRED: evitar herramientas que producen chispas en días calurosos o en presencia de vegetación. |
| R-07 | Con el ambiente seco, no enciendas cigarrillos, fósforos ni nada que produzca calor cerca de vegetación. | SENAPRED: evitar fumar y las fuentes de calor cerca de vegetación; MINVU: «Uso seguro de elementos combustibles». |
| R-08 | Con viento, no hagas fogatas ni quemas y no uses herramientas que produzcan chispas. | SENAPRED: evitar fogatas y chispas cerca de vegetación, y nombra el viento entre las condiciones que facilitan la propagación. |
| R-01 | Retira la vegetación seca y los desechos acumulados alrededor de la vivienda. | SENAPRED, ya citada en la tabla anterior. |
| R-04 | Coordina con la municipalidad o la junta de vecinos una revisión del entorno y de las vías de salida. | MINVU, ya citada. **Razón FireWatch del mapeo:** el historial de incendios no habilita una acción local verificable —no dice qué hay hoy en el lugar—, así que la sugerencia es de coordinación y preparación, no de intervención. |

### Ítem de observación directa, fuera de la composición

| ID | Sugerencia | Fuente y por qué no se selecciona sola |
|---|---|---|
| R-05 | Si ves vegetación en contacto con líneas eléctricas, avisa a la empresa distribuidora; no intervengas tú esa vegetación. | SENAPRED. **No se compone automáticamente:** el sistema no sabe si existe ese contacto, y afirmarlo sería inventar una condición local. Se muestra como ítem consultable, nunca como hallazgo. |

### La costura entre las dos tablas, declarada

Qué ítem acompaña a cada nivel y a cada factor es una **decisión de presentación de FireWatch**, no una recomendación de SENAPRED ni de MINVU. Las fuentes respaldan la medida preventiva; el mapeo a nuestro nivel y a nuestra variable es nuestro, y por eso está escrito y es auditable. El nivel fija la postura; el factor aporta la acción concreta sobre la variable que la regla contó.

## 4. Ejemplo trabajado

Ejemplo con las cinco variables publicadas y cifras ilustrativas —no tomadas de un lote real—:

| Variable | `known` | `contribution` | Participa |
|---|---|---|---|
| `temperatura` | true | 0,180 | sí |
| `humedad_relativa` | true | 0,000 | no — aporte cero |
| `viento` | true | 0,216 | sí |
| `cobertura_vegetal` | false | — | no — sin lectura |
| `incendios_historicos` | true | 0,050 | sí, pero queda tercero |

- `risk_level: "alto"` → base R-03, R-04.
- Factores con aporte, de mayor a menor: `viento` (0,216), `temperatura` (0,180), `incendios_historicos` (0,050). Se toman los dos primeros → R-08, R-06.
- **Salida:** R-08, R-06 (factor), R-03, R-04 (nivel). Cuatro ítems.
- Avisos: «`cobertura_vegetal` sin lectura»; y si el lote trae `demo: true`, «Entorno sintético: no riesgo real observado.».

**Cómo se lee ese orden.** La regla contó más aporte de viento que de temperatura, y la sugerencia de viento aparece primero por eso. No dice que el viento vaya a causar un incendio, ni que hoy haga viento en el lugar, ni que la zona vaya a incendiarse: dice qué contó la regla y qué medida preventiva acompaña a esa variable.

## 5. Fallbacks

| Caso de entrada | Qué se muestra | Por qué |
|---|---|---|
| `risk_level ∈ {bajo, medio, alto}` y factores normales | Composición de §2. | Camino principal. |
| `risk_level: "desconocido"` | **Solo** R-01 y R-02, más «Nivel no clasificado: el sistema no tiene una evaluación validada de esta zona». Ningún ítem de factor, aunque algún factor tenga aporte. | La regla no clasificó. Ordenar sugerencias por aporte sobre un lote no clasificado insinúa una severidad que el sistema se negó a afirmar. |
| `risk_level` ausente, `null` o fuera de los cuatro valores | Igual que la fila anterior, con «SIN CLASIFICAR» como etiqueta. | Se falla cerrado: un valor que no es nivel no se reinterpreta como uno parecido (`"critico"` no es `alto`). |
| Uno o varios factores con `known: false` | La composición sigue sin ese factor y se agrega «Sin lectura: `nombre`, …». No se inventa valor, aporte ni sugerencia para esas variables. | Es la misma regla de «sin lectura» que la ficha ya aplica a las cinco variables. |
| `factors` vacío, ausente o sin ningún factor usable | Solo la base del nivel, con el aviso «Sin factores con lectura en este lote». | La base del nivel no depende de los factores; no se rellena con ítems de variables que no se leyeron. |
| Lote sintético, `demo: true` | La misma lista, precedida por «Entorno sintético: no riesgo real observado.». | Las medidas son de prevención general y siguen siendo válidas como texto; lo que cambia es que no describen una zona real. El aviso usa el texto que la página ya muestra. |
| `data_status` distinto de `current` | El catálogo **no cambia**: no evalúa frescura. | La ficha ya declara el estado del dato por su lado; el catálogo no lo reinterpreta ni lo corrige. |

**Nunca hay salida vacía.** El peor caso son R-01 y R-02 con dos avisos. Tampoco hay salida inventada: si la composición da menos de cuatro ítems, se muestran los que hay.

Los textos entre «» de esta tabla son las cadenas propuestas para la ficha, salvo el del entorno sintético, que reutiliza literalmente el que la ficha ya renderiza: la constante vive en [`frontend/src/domain/recommendations.ts`](../../frontend/src/domain/recommendations.ts) y la vista la importa en `OverviewView.tsx:68,564-565`.

## 6. Límites y guardarraíles

- **Prevención, no emergencia.** Este catálogo sirve para planificar antes. Ante un incendio en curso la respuesta es de la autoridad: los canales de emergencia oficiales de la comuna y sus instrucciones. Nada de esta lista es una instrucción de combate al fuego, de despliegue de recursos ni de evacuación.
- **No afirma causa.** El aporte por variable es aritmética de una regla propia no oficial, no calibrada contra incendios observados (`classify/academic_rule.go:296`). Decir «por el viento» es una afirmación que el sistema no sostiene.
- **No acredita condiciones locales.** Ningún ítem prueba que en la zona haya vegetación seca, viento, sequedad ni líneas eléctricas en contacto. Las sugerencias son generales y condicionales; R-05 lo dice en su propio texto.
- **No es alerta oficial ni índice oficial**, y no sustituye a SENAPRED, CONAF ni a la autoridad.
- **No contradice el aviso del armazón.** La frase «La API no realiza predicciones ni recomendaciones operativas» (`frontend/src/components/Shell.tsx:225`) sigue siendo cierta: esto es texto de prevención general para planificar, no una recomendación operativa ni una predicción.
- **No crea ni mueve acciones.** No llama a `POST /v1/prevention/actions` ni a las transiciones del ítem 11, no escribe en `batches` ni en `prevention.*`, y no envía notificaciones. Es texto que la ficha muestra.
- **No cambia la regla.** No agrega niveles, no toca `classify`, y su único número propio es el presupuesto de pantalla (4 ítems, 2 por fuente).
- **No reemplaza lo que no es suyo.** Priorización (PM-11), alertas (PM-07), incidentes de campo (PM-09) y la ficha PDF (PM-14) quedan fuera; la ficha PDF consume este catálogo cuando exista.

## 7. Fuentes y evidencia documental

| Fuente | Qué se tomó de ella | Cómo se usó |
|---|---|---|
| [SENAPRED — Incendios forestales](https://senapred.cl/incendios-forestales/), sección «¿Cómo prevenir…?» | Despejar vegetación y desechos inflamables en el entorno de las viviendas; evitar fumar, fogatas, parrillas y fuentes de calor cerca de vegetación; evitar herramientas que generan chispas en días calurosos o en presencia de vegetación; si hay vegetación en contacto con líneas eléctricas, avisar a la empresa distribuidora. Contexto: el calor, el viento y la vegetación seca están entre las condiciones que facilitan la propagación. | Paráfrasis en R-01, R-03, R-05, R-06, R-07 y R-08. El contexto de propagación se cita como contexto de la fuente, nunca como pronóstico nuestro. |
| [MINVU — «MINVU en alerta preventiva»](https://www.minvu.gob.cl/minvu-en-alerta-preventiva/) | «Cuida tu entorno»; «Uso seguro de elementos combustibles»; preparar y mantener despejadas las vías de evacuación con anticipación; planificación comunitaria con las municipalidades. | Paráfrasis en R-01, R-02, R-03, R-04 y R-07. |

**Alcance de la cita, sin adorno.** Las dos páginas se consultaron el 2026-11-20 durante la escritura de este catálogo y se parafrasearon para no copiar su redacción. Son guías de prevención al público; **no evalúan nuestro sistema, no conocen nuestra regla y no validan que una variable concreta se traduzca al ítem que aquí se le asigna**. La atribución es a la medida, no al mapeo: el mapeo es de FireWatch y se declara en §3.

## 8. Estado de PM-18: qué existe y qué falta

La fila **sigue abierta**. El criterio pide dos cosas: el catálogo escrito —§1–§7— y que **la ficha de zona sugiera desde él sin crear la acción**. Las dos existen en el árbol de trabajo desde el 2026-11-20; ninguna de las dos está fusionada ni revisada por una persona.

| Lo que el criterio pedía | Dónde está | Qué queda fijado |
|---|---|---|
| La ficha lee esta composición y no tiene texto propio. | [`frontend/src/domain/recommendations.ts`](../../frontend/src/domain/recommendations.ts) y el panel `#recommendation-panel` de [`OverviewView.tsx`](../../frontend/src/views/OverviewView.tsx) | La composición es una función pura sobre el lote ya publicado; la vista solo la presenta. Sin lote —en vuelo, ausente o fallido— el panel nombra ese estado en vez de sugerir desde nada; un lote que el guardián rechaza no reutiliza la severidad: compone solo la pareja cerrada y la rotula como sin clasificar. |
| Las cinco variables, los cuatro niveles, el orden determinista y los fallbacks de §5. | [`frontend/tests/domain/recommendations.test.ts`](../../frontend/tests/domain/recommendations.test.ts) (29 pruebas) | `desconocido`, `null`, ausente o fuera del conjunto toman la misma rama cerrada: R-01 y R-02, sin ítem de factor aunque un aporte sea positivo. Empate por orden canónico, máximo dos factores, duplicado sin relleno. |
| Sugerir no crea nada. | El caso «suggesting creates nothing…» de [`frontend/tests/views/overview.test.tsx`](../../frontend/tests/views/overview.test.tsx) | Toda petición de la sesión es `GET`/`HEAD`, y las emitidas al cambiar de zona no tocan `/v1/prevention` ni `actions`; la lista no persiste nada. |
| La marca de datos sintéticos (R3) y el límite de prevención general. | La misma ficha | `demo: true` antepone el aviso que la tarjeta ya muestra; el panel declara que no es alerta oficial, ni clasificación oficial, ni orden. |

**Lo que falta es de una persona.** La revisión de la entrega y la disposición formal de **R6** ([`16-producto-mandante.md`](16-producto-mandante.md)). R6 pide contrato, backend probado y página, más una persona; PM-18 no abre endpoint ni cambia el contrato, así que no hay capa de contrato nueva que acreditar, y este documento **no declara R6 satisfecho** ni convierte esa ausencia en un requisito de API. El rótulo de la explicación (**R2/D-D**) sigue abierto y es de PM-02, no de esta fila. La ficha PDF (PM-14) hereda este catálogo y su marca.

**Evidencia observada, y sus límites.** La corrida `npm run verify` del árbol de trabajo terminó con código 0 e incluyó 428 pruebas de unidad e integración (frontend); 69 pruebas dirigidas se confirmaron. No se ejecutó compilación de producción —la que exige variables `VITE_*`— ni hubo evidencia manual de navegador, visual, `axe` o lector de pantalla. Este documento no re-ejecutó la corrida: toma sus cifras de quien hizo la entrega.

No se agregó endpoint, ni petición, ni persistencia de acciones, ni cambio en `classify`, en el contrato o en `prevention`. La fila conserva su criterio, su ola y su ruta; el conteo del frente no cambia.
