# V1-F-01 — Ingesta de fuentes reales: fixture determinista, ciclo de 15 min y frescura reproducible

**Qué es:** unidad `V1-F-01` de G4 (frente 1, [`../plan-produccion/01-ingesta-scheduler.md`](../plan-produccion/01-ingesta-scheduler.md)). Entrega las tres piezas verificables que la fila deja abiertas: el fixture determinista con semilla, la cadencia nominal de 15 min con jitter acotado y los umbrales de frescura por fuente, cada una fijada por pruebas que se ejecutan sin fuente real ni reloj de pared. **No ingiere fuentes reales**: el acceso y la periodicidad real de las fuentes siguen siendo una decisión humana pendiente, y esta unidad no la sustituye.
**Base:** rama `feat/v1-f-01-ingesta-freshness`, creada desde `origin/dev`. **No fusiona, no publica, no despliega.**

## Specs

**S1 — Fixture determinista con semilla y sustitución de `source.Provider`.** Un proveedor de fixture con semilla (`seed = 42` por defecto, configurable) produce exactamente las mismas lecturas para la misma semilla y el mismo `cutoff`, en corridas distintas y en procesos distintos. La sustitución de `source.Provider` —fixture sin semilla, fixture con semilla, escenario sintético— ocurre sin cambios fuera de `backend/services/risk/internal/source/`: el consumidor es el mismo código para todo proveedor, y lo que se congela es el contrato `Provider`/`ObservationSet`/`Provenance`, no una implementación.

**S2 — Cadencia nominal de 15 min con jitter acotado y reproducible.** El ciclo automático dispara ingesta → validación → inferencia → publicación cada `15m0s` (`900s`). El jitter por ciclo está acotado a `<= 30s`, se deriva de una semilla —no del reloj ni del azar— y por lo tanto dos corridas del mismo calendario simulado dan la misma secuencia de instantes. La tolerancia de deriva en reloj simulado o en prueba es `<= 30s` sobre cada intervalo y sobre el promedio de la serie, de modo que el jitter no sesga la cadencia. **Los ciclos son seriales y nunca se solapan**, así que el intervalo inicio-a-inicio queda determinado por la duración medida del ciclo: mientras `elapsed <= Schedule.Delay(ordinal)`, la espera posterior es `Delay(ordinal) - elapsed` y el intervalo inicio-a-inicio es exactamente `Schedule.Delay(ordinal)`, dentro de `[870s, 930s]` (`900s ± 30s`); cuando un solo ciclo se excede de `Schedule.Delay(ordinal)` —el ciclo de `20m` de la prueba— la espera posterior se topa en `0s` y el ciclo siguiente arranca inmediatamente al terminar, sin espera negativa, sin solapamiento y sin arrastrar la deuda a ciclos posteriores.

**S3 — Umbrales de frescura por fuente y hallazgo `STALE_CUTOFF`.** La edad de una fuente se mide contra su `cutoff_at` y cae en tres bandas cerradas: `FRESH` con edad `<= 15m` (`900s`), `WARNING` (`DEGRADED`) con `15m < edad <= 30m` (`1800s`, dos ciclos) y `STALE` con `edad > 30m` (`> 1800s`), que dispara el hallazgo `STALE_CUTOFF`. Los bordes exactos —`0s`, `15m`, `15m1s`, `30m`, `30m1s`— quedan fijados por prueba, y una fuente sin `cutoff_at` registrado se trata como `STALE` en vez de suponerla fresca.

**Decisión del responsable (textual, ratificada):**

> «Ciclo 15m (±30s jitter), fresh <=15m, stale >30m — Fixture determinista con semilla (`seed = 42` / configurable): prueba de sustitución de `source.Provider` pasa sin cambios fuera de `backend/services/risk/internal/source/`. Cadencia del scheduler: intervalo nominal `15m0s` (`900s`), tolerancia de deriva en reloj simulado/prueba `<= 30s`. Umbrales de frescura (`freshness`) por fuente: `FRESH`: edad `<= 15m` (`900s`) desde `cutoff_at`; `WARNING` (`DEGRADED`): `15m < edad <= 30m` (`1800s`, 2 ciclos); `STALE`: `edad > 30m` (`> 1800s`, dispara hallazgo `STALE_CUTOFF`). Actualiza `backend/docs/verification.md:98-101` con la evidencia reproducible.»

## Tasks

**T1 — Specs y registro (S1, S2, S3).** Escribir esta unidad con las tres specs y la decisión textual antes de tocar código Go.

**T2 — RED de frescura (S3).** Añadir `backend/services/risk/internal/source/freshness_test.go` con las bandas y los bordes exactos, el uso de `cutoff_at` en vez de `retrieved_at`, el caso de `cutoff_at` ausente y el de un instante futuro.

**T3 — RED de fixture con semilla y sustitución (S1).** Añadir `backend/services/risk/internal/source/seeded_fixture_test.go` con la reproducibilidad por semilla y `cutoff`, la sensibilidad a la semilla, las unidades y rangos publicables, y un consumidor único que recorre tres implementaciones de `Provider` sin ninguna rama por proveedor.

**T4 — RED de cadencia (S2).** Añadir `backend/services/risk/internal/scheduler/schedule_test.go` con la cadencia nominal, el jitter acotado y determinista, el contraste contra `cycle.DefaultInterval` y la secuencia de frescura sobre un reloj simulado.

**T5 — GREEN (S1, S2, S3).** Implementar `internal/source/freshness.go`, `internal/source/seeded_fixture.go` e `internal/scheduler/schedule.go` con lo mínimo que satisface las pruebas.

**T6 — Preservación.** Re-ejecutar la suite completa de `backend/services/risk` (`GOWORK=off go test ./...`) y comprobar cero regresiones.

**T7 — Evidencia (S3).** Quitar el ciclo de 15 min de la lista de lo no establecido en `backend/docs/verification.md`, documentar ahí los umbrales acordados y el comando reproducible, y registrar el resultado en esta unidad y en el plan del frente 1.

**T8 — Cableado del ciclo (S2).** Añadir `backend/services/risk/internal/cycle/` al alcance activo y hacer que `Runner.Start` tome su cadencia de `internal/scheduler` —`scheduler.Schedule.Delay(ordinal)` por ciclo, con `After` inyectable y `DefaultInterval` como alias— con prueba primero, y mantener intactos los ganchos deterministas (`Now`, `NewID`).

## Allowed edit surfaces

- `odd/tasks/v1-f-01-ingesta-freshness.md`
- `odd/plan-produccion/01-ingesta-scheduler.md`
- `backend/docs/verification.md`
- `backend/services/risk/internal/source/`
- `backend/services/risk/internal/scheduler/`

## Log

- **L1 (2026-11-28) — Se abre la unidad.** El frente 1 tiene el contrato `Provider` y el ciclo cableado, pero la fila `V1-F-01` sigue abierta por tres huecos verificables: el fixture no tenía semilla, la cadencia no estaba fijada por prueba y la frescura no tenía umbrales acordados. Esta unidad los cierra con pruebas y documentos; no ingiere fuentes reales ni declara cerrada la fila, que además exige aceptación humana.

- **L2 (2026-11-28) — RED observado (S1, S2, S3).** Se añaden primero las pruebas, sin código de producción. `GOWORK=off go test ./internal/source/... ./internal/scheduler/...` falló con los dos paquetes en `[build failed]`:

  ```text
  internal\source\freshness_test.go:14:5: undefined: FreshnessWarningAfter
  internal\source\freshness_test.go:17:5: undefined: FreshnessStaleAfter
  internal\source\freshness_test.go:22:5: undefined: FreshnessWarning
  internal\source\freshness_test.go:25:5: undefined: FindingStaleCutoff
  internal\scheduler\schedule_test.go:16:5: undefined: NominalInterval
  internal\scheduler\schedule_test.go:19:5: undefined: MaxJitter
  internal\scheduler\schedule_test.go:22:5: undefined: DefaultSeed
  internal\scheduler\schedule_test.go:36:14: undefined: New
  internal\scheduler\schedule_test.go:237:28: undefined: source.Freshness
  FAIL	firewatch.local/risk/internal/source [build failed]
  FAIL	firewatch.local/risk/internal/scheduler [build failed]
  ```

  El fixture con semilla tampoco existía: la prueba de S1 referenciaba `NewSeededFixtureProvider`, `SeededFixtureRecords` y `FixtureSeed`, que el mismo build rechazó. Ninguna prueba de esta unidad pasó antes de la implementación.

- **L3 (2026-11-28) — GREEN y preservación (S1, S2, S3).** `GOWORK=off go test ./internal/source/... ./internal/scheduler/... -count=1` → `ok firewatch.local/risk/internal/source 0.165s` y `ok firewatch.local/risk/internal/scheduler 0.594s`, con **50** pruebas y subpruebas en `-v` y cero `FAIL`. La suite completa del módulo, `GOWORK=off go test ./... -count=1`, terminó con los **13 paquetes `ok`** (`cmd/server`, `classify`, `cycle`, `features`, `handler`, `messaging`, `metrics`, `repository`, `scheduler`, `service`, `source`, `zones`, `migrations`) y ninguna regresión. `gofmt -l internal/source internal/scheduler` no devolvió rutas. `go build` y `go vet` del paquete nuevo pasan tanto con `GOWORK=off` como en modo workspace desde `backend/`.

- **L4 (2026-11-28) — Sustitución de `source.Provider` (S1).** `git status --short` lista solo altas: `internal/scheduler/`, `internal/source/freshness.go`, `internal/source/freshness_test.go`, `internal/source/seeded_fixture.go`, `internal/source/seeded_fixture_test.go` y este documento. Ningún archivo rastreado fuera de `backend/services/risk/internal/source/` aparece como modificado, y una sola función consumidora, escrita contra la interfaz `Provider`, recorre el fixture sin semilla, el fixture con semilla 42, el fixture con semilla 7 y un escenario sintético sin ninguna rama por tipo concreto: la sustitución no exige cambios fuera del paquete.

- **L5 (2026-11-28) — Evidencia documental (S3).** `backend/docs/verification.md` incorpora la sección «Ingestion cadence and freshness thresholds» en `:128-154` con las tres bandas, el intervalo nominal, el jitter acotado, el comando reproducible y el resultado observado; la viñeta de la lista de lo no establecido deja de citar el scheduler de 15 min y queda en `:159`. Las dos citas de `odd/plan-produccion/01-ingesta-scheduler.md` se reapuntaron a `:128-154` y `:157-163`, y su estado, seam y L6 registran esta pasada. La viñeta de alcance queda en `:160`. La fila `V1-F-01` no se declara cerrada: fuente real, periodicidad real y aceptación humana siguen pendientes, y no hay commit ni push.

- **L6 (2026-11-28) — S2: el ciclo automático pasa a la cadencia del scheduler (corrección de la verificación independiente).** La verificación aprobó S1 y S3 y señaló un hueco de S2: `backend/services/risk/internal/cycle/runner.go:252-268` esperaba con un `time.NewTicker(r.interval)` fijo, así que el jitter acotado vivía en `internal/scheduler` pero no en el bucle que corre en producción. **RED:** `GOWORK=off go test ./internal/cycle/ -count=1` → `[build failed]`, `unknown field Schedule in struct literal of type Options` y `unknown field After in struct literal of type Options`. **GREEN:** `cycle.Options` acepta `Schedule *scheduler.Schedule` y `After func(time.Duration) <-chan time.Time`; `Runner.Start` espera `schedule.Delay(ordinal)` por ciclo por esa costura, y `cycle.DefaultInterval` pasa a ser alias de `scheduler.NominalInterval`. La primera implementación volvió a fallar la prueba por una omisión real —`New` no asignaba `options.After`, de modo que el bucle caía a `time.After` y esperaba los quince minutos reales—, corregida en la misma pasada. **Corrección de dependencia:** la prueba de `internal/scheduler` importaba `internal/cycle` para anclar la constante y, con el cableado nuevo, producía `import cycle not allowed in test`; el anclaje se movió a `internal/cycle`, que es el importador.

  ```text
  GOWORK=off go test ./internal/source/... ./internal/scheduler/... ./internal/cycle/... -count=1
  ok  firewatch.local/risk/internal/source
  ok  firewatch.local/risk/internal/scheduler
  ok  firewatch.local/risk/internal/cycle
  ```

  59 pruebas y subpruebas en total, 9 en `internal/cycle`. `GOWORK=off go test ./... -count=1` → 13 paquetes `ok` y cero fallos; `go build ./...` sin error; `gofmt -l internal/source internal/scheduler internal/cycle` sin salida. Los ganchos deterministas se conservan: la prueba inyecta `Now`, `NewID` y `After`, y verifica que las esperas caen en `900s ± 30s`, que no son todas nominales, que siguen un límite inyectado de `5s`, que con jitter deshabilitado dan la grilla exacta de `900s` y que dos corridas con el mismo calendario son idénticas.

- **L7 (2026-11-28) — S2: la espera pasa a ser intervalo inicio-a-inicio, descontando la duración del ciclo.** La verificación independiente señaló que `Runner.Start` esperaba el `Schedule.Delay(ordinal)` completo **después** de terminar `RunOnce`, de modo que el intervalo inicio-a-inicio era `duración del ciclo + espera` y un ciclo lento lo empujaba por encima de `900s + 30s`. **RED:** `GOWORK=off go test ./internal/cycle/ -count=1 -run 'TestRunnerSubtractsTheCycleRuntimeFromTheScheduledDelay|TestRunnerClampsTheWaitWhenTheCycleOutlastsThePeriod' -v` falló con `wait 0 = 15m19.192s, want 14m34.192s (delay 15m19.192s minus the 45s the cycle spent)` y `wait 0 = 15m19.192s, want 0 when the cycle outlasted its period`. La prueba nueva inyecta un reloj que avanza `45s` dentro de cada publicación y otro que avanza `20m`, más que cualquier período. **GREEN:** `Start` toma `cycleStart := r.now()` antes de `RunOnce` y espera `max(0, Delay(ordinal) - (r.now() - cycleStart))`; el bucle único hace que el primer ciclo también aporte su duración, y el descuento se topa en `0` para no esperar un lapso negativo. El resto de las pruebas de cadencia no cambia de resultado porque con reloj estático `elapsed` es `0` y la espera sigue siendo el delay completo.

  ```text
  GOWORK=off go test ./internal/cycle/ -count=1 -v        → 11 pruebas PASS, ok
  GOWORK=off go test ./internal/source/... ./internal/scheduler/... ./internal/cycle/... -count=1 → 61 pruebas y subpruebas, ok
  GOWORK=off go test -count=1 ./...  → 13 paquetes ok, cero fallos
  gofmt -l internal/source internal/scheduler internal/cycle → sin salida
  ```

  `backend/docs/verification.md:138-154` describe ahora el descuento inicio-a-inicio y el tope en `0`, y sus cifras pasan a 61 y 11. Sin fuente real, sin clúster, sin commit ni push.

- **L8 (2026-11-28) — S2: la regla de sobrepaso en ciclos seriales queda explícita (solo documentos).** La verificación independiente aprobó S1 y S3, confirmó que `Runner.Start` descuenta correctamente la duración del ciclo (la prueba de `45s` pasa) y señaló únicamente una precisión de redacción en S2. Se escribe la condición que faltaba: los ciclos son **seriales y nunca se solapan**; con `elapsed <= Schedule.Delay(ordinal)` el intervalo inicio-a-inicio es exactamente `Schedule.Delay(ordinal)`, dentro de `[870s, 930s]` (`900s ± 30s`); cuando un solo ciclo se excede de `Schedule.Delay(ordinal)` —el caso del ciclo de `20m`— la espera posterior se topa en `0s` y el ciclo siguiente arranca inmediatamente al terminar, sin espera negativa, sin solapamiento y sin arrastrar la deuda a ciclos posteriores. La misma regla queda en `backend/docs/verification.md:138-153` y en el estado del frente 1. **No se tocó código:** las dos ramas ya estaban cubiertas por `TestRunnerSubtractsTheCycleRuntimeFromTheScheduledDelay` (`45s`) y `TestRunnerClampsTheWaitWhenTheCycleOutlastsThePeriod` (`20m`). Validación de esta pasada: `GOWORK=off go test ./internal/cycle/ -count=1` → `ok`, y `python -B odd/tools/check_md_links.py --self-test` → `self-test: 22/22 checks passed`. Sin commit ni push.
