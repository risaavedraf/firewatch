# FireWatch v1 · Vista aérea y todas las pantallas

**Qué es:** la colección única de Gentle Design del diseño v1. [01-vista-aerea.html](01-vista-aerea.html) es la portada aprobada de Territorio y ahora también la estación de trabajo operativa: conserva el mapa aéreo aprobado y resuelve las solicitudes de lote por comuna sin salir de él. [02-vista-regional.html](02-vista-regional.html) y [03-acciones-en-el-mapa.html](03-acciones-en-el-mapa.html) siguen como complementos del mapa; los artboards `04`–`19` exponen una pantalla por archivo con su vista inicial ya seleccionada. [design.json](design.json) es el catálogo que consume el lienzo local.

## Cómo usar la portada operativa

La columna izquierda es la estación de solicitudes y la derecha la lectura territorial. El mapa queda en el centro y sigue siendo el lienzo: arrastrar, girar o hacer zoom no cambia la solicitud ni el resultado abierto.

1. **Solicitar.** Marca las comunas individualmente, añade las disponibles de una provincia con «Prov. Valparaíso» o «Prov. Marga Marga», o usa «Seleccionar todas». Los atajos no envían solicitudes ni marcan comunas que ya estén en proceso. Revisa la selección y pulsa «Solicitar lotes». Cada comuna marcada crea su propia fila y su propia solicitud. La casilla se desmarca al enviar y queda desactivada mientras esa comuna tiene un lote en proceso; las demás comunas siguen disponibles y el envío no se bloquea aunque haya lotes pendientes.
2. **Esperar sin bloquear.** Cada fila avanza por su cuenta y muestra un estado explícito: «En proceso», «Listo» o «No disponible». No se espera a la primera: el lote 2 puede estar listo antes que el 1 y la lista conserva el orden de envío para no perder el rastro.
3. **Abrir un resultado.** Una fila «Listo» ofrece «Abrir resultado». El panel inferior «Resultado abierto» muestra la comuna, el lote, el sector evaluado y el resultado. Abrirlo no mueve el mapa, no cambia el sector seleccionado y no reemplaza el resultado que ya estabas mirando; solo cambia cuando abres otro.
4. **Reintentar solo lo que falló.** Una fila «No disponible» ofrece «Reintentar». Reintenta únicamente esa solicitud, conserva la misma fila y el mismo número de lote, y no toca las demás.
5. **Volver a pedir.** Cuando una comuna termina, su casilla se reactiva y puedes solicitar otro lote: se agrega una fila nueva con el siguiente número de envío.

Los tiempos son deterministas y de maqueta: Valparaíso ~3,0 s, Viña del Mar ~0,95 s y Quilpué ~2,1 s; el primer intento de Quilpué falla a propósito y su reintento tarda ~1,1 s. Así se revisa el orden de llegada y el estado de error sin backend.

**Mapa y lectura territorial.** Los controles mantienen la vista aérea y la cenital, el giro, el zoom, la capa de riesgo, el tema y el centrado. La lectura de riesgo vive en la columna derecha, separada de la solicitud: el riesgo se lee por sector y la solicitud es por comuna, nunca al revés. El mapa muestra desde la entrada el último lote publicado para cada sector hasta la fecha de corte, con los factores disponibles. Un sector sin lote muestra «Sin evaluación». «Expandir mapa» oculta la columna de solicitudes para mirar el terreno completo.

**Navegación del producto.** Una barra global, fuera de la columna de solicitudes, aparece en los 21 tableros: «Mapa» devuelve a la portada desde cualquier pantalla, «Panel ejecutivo», «Historial de lotes» y «Acciones preventivas» quedan a un clic, y «Más destinos» agrupa el resto por uso sin depender de hover. La página actual se marca con `aria-current="page"` y «Estás en» nombra el tablero abierto. Los enlaces son relativos y nativos: funcionan sin red y el botón Atrás del navegador vuelve al tablero anterior. El flujo de un solo lote y el inventario de prototipos y alcance siguen en el catálogo como referencias, fuera de la navegación.

## Maqueta vs. real

- **No hay red.** Ningún tablero hace `fetch`, abre conexiones ni llama a servicios. Los «trabajos» de la portada son temporizadores de la propia página.
- **No hay almacenamiento.** No se usa `localStorage`, cookies ni `sessionStorage`: cada recarga vuelve al estado inicial y el tema no se recuerda.
- **No hay persistencia ni backend.** Las filas y los resultados viven solo en memoria. Solicitar, reintentar y abrir no escriben nada.
- **Los datos son ilustrativos y se identifican en este documento y en el catálogo, no en la interfaz del producto.** Comunas, sectores, lotes, fechas, niveles, factores y resultados son de escenario. El terreno, los edificios y los contornos son geometría de maqueta dibujada en canvas.
- **Los enlaces abren otros tableros** de esta misma carpeta; no generan archivos ni descargan documentos.
- **El alcance del prototipo** se documenta en [19-aun-no-implementado.html](19-aun-no-implementado.html): las siete capacidades reales que el backend no sostiene y los prototipos que las ilustran; esta colección diseña lo que necesitamos, esté implementado o no.
- **Nada de `frontend/`** se modifica desde esta colección.

## Datos del modelo

[Datos del modelo](20-datos-del-modelo.html), junto a Fuentes y servicios, describe las siete variables y la investigación de acceso histórico. [Lecturas por sector](21-lecturas-por-sector.html), junto a Cobertura, muestra un sector completo, uno parcial y uno sin lecturas. Ninguno calcula riesgo.

El [paquete de datos sintéticos](model-data/README.md) incluye el CSV comuna-día y el JSON de sectores. El lienzo conserva una copia de este JSON en el bloque `sector-fixture` del tablero `21` para abrirlo sin red; si el ejemplo cambia, actualiza ese bloque y compruébalo con `--check`.

## Artboards generados

Los `04`–`19` se generan desde los cuatro tableros fuente, que se conservan intactos:

| Fuente | Artboards |
| --- | --- |
| `../firewatch-v1-recorrido/01-prevencion-territorial.html` | `04-cobertura-territorial.html` (`territorio`), `05-historial-de-lotes.html` (`historial`), `06-acciones-preventivas.html` (`acciones`) |
| `../firewatch-v1-casos/01-decisiones.html` | `07-panel-ejecutivo.html` (`panel`), `08-comparar-sectores.html` (`comparar`), `09-notificaciones.html` (`notificaciones`) |
| `../firewatch-v1-casos/02-campo-y-entrega.html` | `10-simulacion-contrafactual.html` (`simulacion`), `11-observaciones-de-campo.html` (`campo`), `12-exportacion-csv.html` (`exportacion`), `13-ficha-de-zona.html` (`ficha`) |
| `../firewatch-v1-recorrido/02-control-y-acceso.html` | `14-acceso.html` (`acceso`), `15-fuentes-y-servicios.html` (`fuentes`), `16-procesamiento.html` (`procesamiento`), `17-sesion-y-permisos.html` (`sesion`), `18-registro-de-actividad.html` (`auditoria`), `19-aun-no-implementado.html` (`pendiente`) |

Cada archivo conserva el tablero completo y su navegación interna: solo cambian el marcador de generación, el `hidden`/`aria-current` inicial, la vista por defecto y la barra global del producto que inyecta `product-navigation.mjs`. Un enlace a otra vista con `#` sigue funcionando. La paleta, las fuentes y las interacciones se conservan.

## Regenerar y verificar

```sh
node design/firewatch-v1-vuelo/build-artboards.mjs
node design/firewatch-v1-vuelo/build-artboards.mjs --check
```

El generador no usa dependencias, instalación ni red. `--check` es de solo lectura: verifica los 16 artefactos, sin considerar diferencias entre LF y CRLF, comprueba las 21 entradas ordenadas en `design.json` y valida que el JSON de sectores coincida con el que muestra el lienzo. El modo de escritura verifica todos los destinos antes de escribir: si encuentra un archivo ajeno o enlazado, se detiene sin cambiar nada. Los mapas `01`–`03` y los cuatro tableros fuente quedan fuera de su alcance: la estación de trabajo de `01` se edita a mano.

## Navegación global del producto

[product-navigation.mjs](product-navigation.mjs) es la única fuente de la barra: define destinos, marcado y CSS, y los escribe en los 21 tableros finales. Los destinos se agrupan por uso —territorio y lectura, decisión y alertas, solicitudes y datos, acceso y control— y no repiten los cuatro atajos que ya están en la barra.

- **Fija en los mapas.** En `01`, `02` y `03` la barra queda arriba y cada tablero desplaza sus paneles con `--fw-nav-h` (48 px), así que no tapa la cabecera, los controles ni la columna de solicitudes. En `01`, bajo 1120 px la estación pasa a flujo normal y la barra se vuelve `sticky`.
- **`sticky` en el resto.** En `04`–`21` la barra vive en el flujo, se pega arriba al desplazar y ajusta `scroll-padding-top` y la navegación interna `.viewnav` para no solaparse.
- **Fuera del rail.** En `01` se retiró el bloque «Otras vistas» de la estación de solicitudes: los destinos ya están en la barra global, que no se desplaza con la columna.
- **Referencias internas.** `16-procesamiento.html` y `19-aun-no-implementado.html` siguen en el catálogo y en el lienzo, pero no son destinos del menú; ambos tableros muestran la barra completa y su nombre en «Estás en».
- **Sin hover y sin red.** «Más destinos» es un `<details>` nativo que abre con clic, Enter o Espacio, y todos los enlaces son rutas relativas a archivos hermanos.

Este es un cambio de salida intencional del generador: los `04`–`19` ahora incluyen la barra y su bloque `<style id="fw-product-nav">`. No cambian los tableros fuente, sus guards, la política de escritura, el contrato de salida ni el orden o el número de entradas del catálogo.

### Verificar la navegación

```sh
node design/firewatch-v1-vuelo/product-navigation.mjs --check
node design/firewatch-v1-vuelo/product-navigation.mjs --browser-check
```

`--check` es de solo lectura y sin red: revisa los 21 tableros, el enlace directo a `01`, el `aria-current` de la página actual, la cobertura de los 19 destinos, la ausencia de `data-nav` y de `id` en conflicto, y que `design.json` conserve sus 21 entradas en orden. `--browser-check` recorre con teclado `01 → Historial → Notificaciones → 01` en escritorio y en 390 px, mide los 21 tableros en 1440, 390 y 320 px, y falla ante desbordamiento horizontal, peticiones externas o errores de consola. Sin un Chromium local se omite sin fallar; se puede indicar con `FW_CHROMIUM`.

Los cinco tableros directos (`01`–`03`, `20`, `21`) no se reescriben con este comando. Si cambia la barra compartida, actualiza únicamente sus bloques marcados y usa `--check` para detectar diferencias.
