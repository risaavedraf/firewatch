# Modelo · traspaso de datos sintético (T8)

**Qué es:** el paquete de datos que el prototipo del front muestra y que después se cambia en el backend. Trae un **panel comuna-día** con la forma exacta que hoy ensambla [`backend/training/assemble.py`](../../../backend/training/assemble.py) y un **fixture de tres sectores** para la maqueta territorial. Todo es sintético, determinista y reproducible sin red.

**Qué no es:** no es la fuente real, no certifica la calidad técnica de ningún dato, no es una probabilidad de riesgo, no es una conversión espacial del panel comuna-día y no autoriza activar el artefacto. Tampoco hay métricas de modelo: no se midió desempeño. Las fechas, los eventos y las superficies son ficticios.

| Archivo | Qué es | Forma |
| --- | --- | --- |
| [`panel-synthetic.csv`](panel-synthetic.csv) | panel comuna-día, la forma del ensamblador | 36 filas × 17 columnas |
| [`sector-fixture.json`](sector-fixture.json) | tres sectores para la maqueta, un día | 3 objetos |
| [`manifest.json`](manifest.json) | metadatos: hashes, cobertura, huecos y bloqueos de acceso | un documento |
| [`generate.py`](generate.py) | el generador; solo biblioteca estándar | escribe en stdout |
| [`test_generate.py`](test_generate.py) | pruebas de contrato del paquete | 35 pruebas |

## Camino rápido

```sh
# 1. Los archivos en disco son exactamente lo que genera el generador.
python design/firewatch-v1-vuelo/model-data/generate.py --check

# 2. Regenerar: el generador NUNCA escribe archivos; redirige el shell.
python design/firewatch-v1-vuelo/model-data/generate.py --emit panel \
    > design/firewatch-v1-vuelo/model-data/panel-synthetic.csv
python design/firewatch-v1-vuelo/model-data/generate.py --emit sectors \
    > design/firewatch-v1-vuelo/model-data/sector-fixture.json
python design/firewatch-v1-vuelo/model-data/generate.py --emit manifest \
    > design/firewatch-v1-vuelo/model-data/manifest.json

# 3. Pruebas (solo lectura, sin red).
python -B design/firewatch-v1-vuelo/model-data/test_generate.py
```

El manifiesto lleva el `sha256` de los otros dos artefactos, así que se emite al final. `--check` regenera los tres en memoria y compara bytes: es de solo lectura y no acepta destino.

## Las 17 columnas del panel

Las diez primeras son `PANEL_COLUMNS` del ensamblador, en su orden; las siete últimas son las características del descriptor, en el orden que declara [`logistic.json`](../../../backend/services/inference/testdata/logistic.json). El `cut` es texto, así que el cero inicial sobrevive (`05101`).

| Bloque | Columnas |
| --- | --- |
| Llave y procedencia | `cut`, `comuna`, `comuna_unresolved`, `provincia`, `region`, `local_date` |
| Etiqueta (objetivo) | `fire_today`, `fire_count`, `burned_ha` |
| Eventos con datos meteorológicos adjuntos | `meteorology_readings` |
| Características | `temp_max`, `temp_min`, `humidity_rel`, `wind_speed`, `wind_dir`, `precip_sum`, `radiation_sol` |

**`meteorology_readings` vale `0` en las 36 filas.** Cuenta los eventos de la comuna-día que tienen al menos un valor meteorológico no nulo (un cero numérico también cuenta); se suma como máximo una unidad por evento. El fixture no adjunta datos meteorológicos a ningún evento: las siete variables vienen de una serie sintética independiente y su cobertura está en `panel.reading_coverage` del manifiesto. El formato compartido no vuelve al fixture un reemplazo directo del panel real: los estimadores del panel y del servicio pueden diferir.

## Las siete variables: misma unidad no es el mismo número

El panel se construye con el día civil completo; el servicio publica con el día en curso y lecturas instantáneas. Las unidades coinciden con el artefacto; los estimadores no.

| Variable | Unidad | Panel (entrenamiento) | Servicio ([`features.go`](../../../backend/services/risk/internal/features/features.go), [`inference.go`](../../../backend/services/risk/internal/classify/inference.go)) | Ventana |
| --- | --- | --- | --- | --- |
| `temp_max` | `degC` | máximo de las lecturas del día civil completo | máximo de las lecturas del día civil **en curso** al publicar | 1 día |
| `temp_min` | `degC` | mínimo de las lecturas del día civil completo | mínimo del día en curso | 1 día |
| `humidity_rel` | `%` | **media** de las lecturas del día | **última lectura instantánea** | 1 día |
| `wind_speed` | `m/s` | media diaria, convertida de `km/h` con ÷ 3.6 | última lectura instantánea, misma conversión | 1 día |
| `wind_dir` | `deg` | dirección dominante del día, grados desde donde sopla | última lectura instantánea | 1 día |
| `precip_sum` | `mm` | **suma** de siete días civiles que terminan en la fecha de referencia, incluida | suma de los últimos siete días locales, incluido el día en curso | 7 días |
| `radiation_sol` | `W/m2` | **media diaria de irradiancia**, no una integral | lectura instantánea; no se convierte a integral diaria | 1 día |

`precip_sum` es el caso caro: una ventana de seis días no es una suma menor, es otra cantidad, y el generador la rechaza (`ValueError`) en vez de calcularla. Una ventana con un día sin lectura se escribe vacía, nunca como suma parcial.

## Fechas y cronología

| Tramo | Qué cubre |
| --- | --- |
| 2026-11-03 → 2026-11-08 | serie modelada interna; existe solo para que el primer día exportado ya tenga su ventana de siete días completa |
| 2026-11-09 → 2026-11-20 | panel exportado: 12 días civiles contiguos × 3 comunas |
| 2026-07-01 → 2026-09-28 | evidencia histórica entregada: 90 días de tablero regional (conteo, sin meteorología) |
| 2026-09-28 09:00 −03 | la única instantánea de red disponible: un instante no es un día |
| 19 temporadas | producto de eventos del DOI, restringido; no descargado |

Todas las ventanas se cortan en `America/Santiago`, como el ensamblador y el servicio. En los dos cambios de hora del año un día civil dura 23 o 25 horas; cortar en UTC terminaría el día a las 20:00 o 21:00 locales.

## Faltantes y ceros: dos cosas distintas

Una celda vacía es *sin lectura*; un `0` es una *medición*. El paquete trae ejemplos explícitos de ambos y el manifiesto enumera cada hueco con su causa instrumental.

| Caso | Dónde | Qué significa |
| --- | --- | --- |
| `precip_sum` = `0` | las tres comunas, 2026-11-09 a 2026-11-14; en 05109 además todo el panel | siete días secos y completos: acumulación medida de 0 mm |
| `precip_sum` vacío | 05101, 2026-11-17 a 2026-11-20 | falta la lectura diaria del 17: la ventana de siete días es incompleta |
| `wind_speed` = `0` y `wind_dir` vacío | 05109, 2026-11-16 | calma medida: la velocidad es un cero real, la dirección no está definida y **no** es 0° (norte) |
| `burned_ha` = `0` | toda fila tranquila | un día sin incendio quemó cero hectáreas |
| `burned_ha` vacío | 05101, 2026-11-18 | dos eventos, uno con superficie ilegible: la superficie del día es desconocida, no cero |

**Los huecos no dependen de la etiqueta.** Son anemómetro, piranómetro o sensor de humedad sin registro, una dirección indefinida en calma y el arrastre de una lectura de lluvia faltante. Cada variable que falta alguna vez falta en días con incendio **y** en días tranquilos; una fila con incendio está completa (05101, 2026-11-13) y varias filas tranquilas no lo están. Con 4 filas con incendio de 36, cualquier hueco en un día con incendio pesa más en la tasa por fila; por eso la propiedad que las pruebas fijan es por variable y por estado, no por fila.

## La etiqueta queda fuera de las entradas

`fire_today`, `fire_count` y `burned_ha` son objetivo, nunca entrada: no se recalculan desde las características ni se usan para derivarlas. La investigación ya había medido el caso equivalente: la superficie afectada es un **dato posterior al evento** y cualquier columna derivada del acumulado reproduce la etiqueta, así que ni `sup_afec_act` ni su diferencia diaria entran en la matriz. Este paquete tampoco las trae: las siete columnas de características se construyen solo desde meteorología.

La meteorología, a su vez, es una fuente **independiente** del registro de eventos: debe existir también en los días sin incendio, porque un catálogo de eventos solo trae lecturas donde hubo uno y entonces la entrada describe incendios en vez de anticiparlos. La investigación pide lecturas horarias —o un reanálisis ya agregado— en el punto de cada comuna, en todos los días, con unidad y período declarados; el manifiesto registra por variable la agregación de cada lado y su ventana.

## Fixture sectorial (diseño, no datos del modelo)

Tres sectores en el orden aprobado del mapa, todos con `local_date` 2026-11-20. La UI calcula 7/7, parcial o sin lectura contando los campos no nulos.

| Sector | Comunas | Clima | Terreno |
| --- | --- | --- | --- |
| `quebrada-este` · Quebrada del Este | Valparaíso, Viña del Mar, Quilpué | 7/7, reusa la fila de Quilpué del 20 | completo |
| `borde-costero` · Borde costero | Viña del Mar | 5/7: falta humedad y radiación; `precip_sum` = `0` es un cero medido | completo |
| `interior-sin-lectura` · Interior sin lectura | Quilpué | 0/7 | todo nulo |

Los dos primeros sectores reutilizan la fila del 20 de noviembre de Quilpué y Viña del Mar, respectivamente. No es una conversión espacial. Temperatura, humedad, viento y radiación son estimaciones sintéticas del día completo; no son lecturas instantáneas ni corresponden a un lote publicado. El fixture tiene fecha local, no hora de observación.

## Lo que todavía falta (real)

| Falta | Qué desbloquea |
| --- | --- |
| Fuente meteorológica real, con vintage, cobertura y calidad declarados | reanálisis o red de estaciones unida por `(CUT, fecha local)`, con lectura en los días sin incendio |
| Evaluación fuera de muestra con holdout temporal real | saber si el modelo sirve; este paquete no mide nada |
| Alineación del corte entrenamiento ↔ servicio | hoy el panel usa el día completo y el servicio publica con el día en curso: la misma fila no describe el mismo instante hasta que exista una hora de corte declarada y compartida |
| Etiqueta real de eventos por comuna y fecha | ver los bloqueos abajo |
| Llave de zona para sectores | el panel sigue siendo comuna-día; un sector necesita su propia llave, que hoy no existe en el contrato |

## Bloqueos exactos de la etiqueta histórica

| Fuente | Estado | Bloqueo |
| --- | --- | --- |
| DOI `10.71578/UXAUN5` (Dataverse, CONAF 2010-2025) | real y existe: 19 archivos por temporada, por ejemplo `data/20022003/20022003.csv` de 1,55 MB | todos los archivos están `restricted = true` y una descarga anónima responde 403: requiere cuenta, condiciones de uso y una **solicitud de acceso** |
| Geoportal CONAF 2010-2025, ficha `01d06ae3-122e-41fc-9512-1dd2b5067112` | la ficha existe, con ISO 19115 y un contacto institucional publicado en ella | **no** expone distribución, ni WFS, ni descarga: describe el producto pero no entrega el archivo |
| Muestra abierta del repositorio FONDEF | una temporada de una región (Maule 2018-2019) | sirve para esquema, unión por CUT y ventanas; no sostiene una partición temporal honesta |

Las dos cosas son bloqueos distintos: el DOI es una **solicitud de acceso**, el Geoportal es una **ficha sin distribución**. La evidencia está en [`aws-ml-delivery.md`](../../../odd/tasks/plan-produccion/aws-ml-delivery.md) L5 y en [`informe-datos-y-modelo.md`](../../../odd/entrega/informe-datos-y-modelo.md) §§4–5.

## Capas candidatas de sector

Ninguna es entrada activa del modelo. Son candidatas para cuando exista una llave de zona.

| Capa | Por qué se propone |
| --- | --- |
| Combustible y cobertura | cartografía de vegetación y uso de suelo; CONAF como candidato, igual que en [`terrain-handoff.md`](../terrain-handoff.md) |
| Pendiente y elevación | modelo digital de elevación; Copernicus GLO-30 figura como candidato, no integrado |
| Humedad y lluvia antecedente | la misma fuente meteorológica independiente; una capa de sector necesita su propia ventana, no la suma de siete días del panel |
| Accesibilidad e interfaz | caminos, huellas y puntos de agua: describen la capacidad de supresión, no la probabilidad de ignición |

## Qué adaptar del lado del backend, más adelante

Nada de esto está implementado hoy; es una lista de trabajo, no un estado.

1. Unir la fuente meteorológica independiente por `(CUT, fecha civil)` antes de agregar: la unión y la maquinaria de ventanas ya existen en el ensamblador.
2. Declarar una hora de corte de publicación y construir el panel con ese mismo corte.
3. Resolver `radiation_sol` antes de comparar números: integral diaria en `MJ/m2` contra `W/m2` no se convierten entre sí, y por eso [`backend/training/README.md`](../../../backend/training/README.md) lo reporta en vez de convertirlo.
4. Mantener el descriptor del artefacto como única autoridad de nombres, orden y unidades.
5. Agregar una llave de zona propia si el producto muestra sectores; el panel sigue siendo comuna-día.

## Regenerar y verificar

| Comando | Efecto |
| --- | --- |
| `python …/generate.py --emit panel > …/panel-synthetic.csv` | escribe el panel por stdout; el shell redirige |
| `python …/generate.py --emit sectors > …/sector-fixture.json` | escribe el fixture sectorial |
| `python …/generate.py --emit manifest > …/manifest.json` | escribe los metadatos, con el `sha256` de los otros dos |
| `python …/generate.py --check` | solo lectura: compara los tres archivos y sale distinto de cero si hay deriva |
| `python -B …/test_generate.py` | 35 pruebas: bytes exactos, forma, unidades, ventana, etiqueta, huecos y ceros |

El generador importa solo la biblioteca estándar (`argparse`, `csv`, `datetime`, `hashlib`, `io`, `json`, `sys`, `dataclasses`, `pathlib`), no abre ningún archivo en escritura y escribe bytes UTF-8 en stdout para que la página de códigos de la consola no decida el contenido. No hay dependencias nuevas, ni proveedores, ni credenciales, ni rutas de la aplicación.

## Límites

- No se ejecutó el modelo, no hay inferencia, activación ni despliegue.
- No se midió desempeño: el paquete no contiene métricas, umbrales ni comparación con líneas base.
- No se descargó ni se leyó ningún dato real de etiqueta o meteorología: los valores son inventados y están rotulados como tales.
- No se tocó `frontend/`, `backend/`, autenticación, roles ni dependencias.
