# Frente 12 — Evaluación científica (sesgo, leakage, robustez, Champion/Challenger, drift)

- **Grupo de entrega:** No cierra esta semana — **bloqueado por los dos pendientes permitidos** (datos reales + modelo).
- **Estado:** **Bloqueado para acreditar** — planificación. La evidencia sintética no cierra los IDs; el protocolo, las métricas y los criterios pueden prepararse sin datos reales.
- **Riesgo (Task Size):** alto al implementar — ítem 1 (datos/partición) e ítem 6 (resultados sin *ground truth* no son válidos).
- **Depende de:** datos reales representativos; artefacto de modelo evaluable/*ground truth*; grupos, métricas y umbrales acordados.
- **Seam / superficie:** fuentes/esquema y partición de datos; artefacto/versionado del modelo; logging de inputs, outputs y *ground truth*.

**Objetivo.** Completar la evaluación con datos reales, protocolo reproducible y criterios aprobados. **Se prepara como plan, no como resultado.**

**Documentación real (redirección).**
- [`../urgent/02-pruebas-datos.md:22-35`](../urgent/02-pruebas-datos.md) — calidad, sesgo y fugas de datos.
- [`../urgent/03-pruebas-modelo.md:21-34`](../urgent/03-pruebas-modelo.md) — evaluación y robustez del modelo.
- [`../../Referencias/tareas_verificacion_implementacion_IA.md:217-239,257-280,303-318`](../../Referencias/tareas_verificacion_implementacion_IA.md) — criterios por ID.

## Specs

- **S1** — Con datos reales, se definen grupos/métrica/mitigación de sesgo, se mide cobertura/paridad y se justifica cada N/A.
- **S2** — Se documenta la partición temporal/geográfica y se verifica que el test sea posterior y sin fuga (*leakage*).
- **S3** — Se acuerdan escenarios y tolerancia de robustez; se mide degradación y fallos catastróficos.
- **S4** — Se compara Champion/Challenger con métricas y umbrales acordados; no se sustituye ante regresión sin justificación aceptada.
- **S5** — Se define monitoreo/frecuencia de drift y, con *ground truth*, se recalculan métricas.

## Tasks

| ID | Spec | Ruta | Descripción | Commit |
| --- | --- | --- | --- | --- |
| T1 | S1 | *bloqueada* | Protocolo de sesgo con datos reales. | — |
| T2 | S2 | *bloqueada* | Partición temporal/geográfica sin fuga. | — |
| T3 | S3 | *bloqueada* | Robustez: escenarios, tolerancia, degradación. | — |
| T4 | S4 | *bloqueada* | Champion/Challenger con umbrales. | — |
| T5 | S5 | *bloqueada* | Monitoreo/frecuencia de drift + recálculo. | — |

Ruta por defecto: **bloqueada para acreditar**, no para ensayar. Ningún resultado se presenta como acreditado hasta que datos y modelo reales estén disponibles y aprobados.

Preparación permitida sin datos: protocolo, métricas, tolerancias y criterios de evaluación. La **acreditación** queda bloqueada; el **ensayo** no: `backend/training/REPORT-delivered-data.md:11,53` registra una corrida temporal (2026-11-06) con dos modelos y dos líneas base sobre julio–agosto contra septiembre, y `:74-78` dictamina que ningún modelo entrenado gana a su línea base en esa data. Eso no acredita ningún ID.

**Reproducir ese ensayo exige un export externo (H22).** El reporte no se rehace desde el repositorio: su entrada es el CSV entregado, que **no está en el árbol** — el default de `train_delivered.py` es `backend/training/data/dashboard_conaf_202609281623 (1).csv` (`backend/training/train_delivered.py:89`) y solo se nombra por `--source` (`:1848-1849`)—. Lo que el repositorio conserva son fixtures: el panel de `tests/fixtures/conaf-maule-sample.csv` (`backend/training/README.md:33`) y el de `train_delivered.py` (`:58`), y el único que la CI ejecuta es el primero (`.github/workflows/training.yml:44-46`). Ninguna workflow invoca `train_delivered.py`, así que rehacer el número de `:11` pide el export por fuera con su sha256 (`:10`) y el `--source` correspondiente. **Es lectura de código y del reporte**: no se reejecutó el entrenamiento.

## Dependencias y bloqueos humanos

- **Bloqueo doble:** datos reales y modelo aprobado (los dos pendientes permitidos).
- **Bloqueo humano:** el equipo define grupos, métricas, tolerancias y umbrales; no presentar cifras "por medir" como resultados.

## Criterios de cierre

- `../urgent/02-pruebas-datos.md:26-35`; `../urgent/03-pruebas-modelo.md:25-34`.

## Log

- **L1 (2026-10-16)** — Creación del desglose por spec a partir de [`README.md`](README.md) §1 (frente 12). Documento de planificación; sin implementación.
- **L2 (2026-10-20)** — Estado precisado a «bloqueado para acreditar»: protocolo y criterios se preparan sin datos; la ejecución sigue bloqueada (README §5.1).
- **L3 (2026-11-18) — Precisión: el ensayo existe, la acreditación no (H12 de la auditoría de despliegue).** «La ejecución y la acreditación quedan bloqueadas» era falso para la ejecución: `backend/training/REPORT-delivered-data.md` conserva una corrida medida del 2026-11-06 (`:11`) con split temporal julio–agosto contra septiembre (`:38-41`), dos modelos y dos líneas base (`:53`), y veredicto de que ninguno gana a su línea base (`:74-78`). Se mantiene el bloqueo de acreditación: el ensayo no cierra los IDs y el modelo sigue sin aprobación.
- **L4 (2026-11-18) — El ensayo pide un export externo (H22 de la auditoría de producción).** El documento describía el ensayo como reproducible sin decir que su entrada no viaja en el repositorio. `train_delivered.py` toma por default `backend/training/data/dashboard_conaf_202609281623 (1).csv` (`backend/training/train_delivered.py:89`) y lo recibe por `--source` (`:1848-1849`), pero el árbol solo lleva fixtures (el default offline está en `backend/training/README.md:58`) y el único CSV que la CI ensambla es el fixture (`/.github/workflows/training.yml:44-46`); `train_delivered.py` no aparece en ningún workflow. Se añadió el requisito de export externo con su sha256 (`backend/training/REPORT-delivered-data.md:10,11`) y el comando con `--source`. Es lectura de código y reporte: no se reejecutó el entrenamiento.
