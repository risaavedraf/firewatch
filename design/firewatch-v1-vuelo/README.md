# FireWatch v1 · Vista aérea y todas las pantallas

**Qué es:** la colección única de Gentle Design del diseño v1. [01-vista-aerea.html](01-vista-aerea.html) sigue siendo la portada aprobada de Territorio; [02-vista-regional.html](02-vista-regional.html) y [03-acciones-en-el-mapa.html](03-acciones-en-el-mapa.html) son complementos del mapa; los artboards `04`–`19` exponen una pantalla por archivo con su vista inicial ya seleccionada. [design.json](design.json) es el catálogo que consume el lienzo local.

**Datos de maqueta:** los datos, las operaciones, las exportaciones y las señales de sesión son ilustrativos. Ningún tablero llama a la red, escribe almacenamiento, descarga archivos ni modifica `frontend/`. El artboard `19` muestra el estado transitorio «Aún no implementado», no funcionalidad del producto.

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

Cada archivo conserva el tablero completo y su navegación interna: solo cambian el marcador de generación, el `hidden`/`aria-current` inicial y la vista por defecto. Un enlace a otra vista con `#` sigue funcionando. La paleta, las fuentes y las interacciones se conservan.

## Regenerar y verificar

```sh
node design/firewatch-v1-vuelo/build-artboards.mjs
node design/firewatch-v1-vuelo/build-artboards.mjs --check
```

El generador no usa dependencias, instalación ni red. `--check` es de solo lectura: verifica los 16 artefactos, sin considerar diferencias entre LF y CRLF, comprueba las 21 entradas ordenadas en `design.json` y valida que el JSON de sectores coincida con el que muestra el lienzo. El modo de escritura verifica todos los destinos antes de escribir: si encuentra un archivo ajeno o enlazado, se detiene sin cambiar nada. Los mapas `01`–`03` y los cuatro tableros fuente quedan fuera de su alcance.
