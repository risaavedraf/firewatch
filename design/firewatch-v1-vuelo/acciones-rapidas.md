# FireWatch · Acciones rápidas desde el mapa

**Objetivo:** pasar de identificar un foco a preparar una acción sin abandonar la vista aérea ni perder el sector, la cámara o el corte temporal.

**Alcance:** variante interactiva en Gentle Design sobre la [Vista aérea aprobada](01-vista-aerea.html). Conserva el mapa a pantalla completa y sus controles. No reemplaza la portada aprobada ni la [variante regional](02-vista-regional.html). El selector y las tareas son de demostración; no se toca React, backend, permisos, lotes ni datos reales.

## Recorrido

1. **Seleccionar un sector.** Un clic o toque dentro de una zona dibujada —no solo sobre la etiqueta— abre una tarjeta. Elegir ese sector con el teclado desde la lista abre la misma tarjeta. Arrastrar, girar o pulsar fuera de una zona no inicia una acción.
2. **Confirmar el contexto.** La tarjeta muestra el nombre del sector y su nivel al corte actual, o «Sin evaluación». El corte informa la lectura; una acción nueva no modifica el lote ni queda fechada retroactivamente como si se hubiera ejecutado en el pasado.
3. **Actuar sin salir del mapa.** Acción principal: **Crear acción**. Alternativa: **Asignar existente**, que solo se habilita si hay una acción de ejemplo sin responsable en ese sector. Antes de entrar al formulario no se prepara ni asigna nada.

| Acción | Qué se muestra | Resultado de la maqueta |
| --- | --- | --- |
| **Crear acción** | Sector ya fijado, título obligatorio y responsable opcional (`Sin asignar` por defecto). | **Probar creación** confirma el título, sector y responsable elegido o la ausencia de asignación. |
| **Asignar existente** | Solo las acciones sin asignar del sector y un selector con responsables de ejemplo. Si no hay una acción, explicar por qué no se puede asignar. | **Probar asignación** confirma acción, sector y persona; no acepta un responsable vacío. |

En ambos casos, la confirmación dice claramente que **no se guardó ni se asignó nada en el sistema**. Los cambios pueden permanecer en memoria durante la sesión de maqueta si ayudan a entender el flujo, pero no se escriben a almacenamiento ni se envían por red.

## Tratamiento visual y comportamiento

- **Escritorio:** tarjeta compacta cerca del foco, ajustada al espacio disponible. El mapa sigue de fondo y sus controles no pasan a una página nueva. **Móvil:** tarjeta inferior con espacio para el formulario y botón de cierre accesible.
- Misma paleta de [Vista aérea](01-vista-aerea.html) en claro y oscuro. Los colores de riesgo etiquetan la lectura; no identifican botones ni sustituyen el texto. No alterar el mapa cuando la tarjeta está cerrada.
- Cierre visible y con `Escape`; devolver el foco al control que abrió la tarjeta. Etiquetas explícitas para los campos, mensajes de error en contexto y confirmación visible. Si se cambia de sector, no se transfieren título ni responsable al nuevo sector.
- **Sin evaluación no significa riesgo bajo.** Mostrar ese estado sin inventar factores. La ausencia de lectura no impide preparar una acción preventiva de muestra; la falta de una tarea existente sí impide asignarla.

## Comprobación en el lienzo

- Clic dentro del área de riesgo, selección desde lista con teclado y cierre con `Escape` en escritorio y móvil.
- Crear con y sin responsable, asignar una existente y rechazar una asignación sin persona. Cambiar de sector y comprobar que no se mezclan las tareas del ejemplo.
- Confirmar que arrastrar no abre la tarjeta. Verificar mapa, tema y cámara, que la anatomía de la tarjeta mantiene el foco visible y que no hay escrituras, solicitudes de red ni errores de página.

La Vista aérea original se conserva; la variante debe aparecer como **Vista aérea · Acciones rápidas** en la misma colección de Gentle Design.
