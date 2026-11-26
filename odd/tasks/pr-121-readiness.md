# PR #121 — readiness probe isolation
Existing draft only; no merge before verification.

## Specs
- S1 — «excelente, continuemos, dejemos todo en la rama dev nomás, hay varios pr abiertos todavía»

## Tasks
- T1 [S1] Correct competing readiness probes; worker; commit pending.
- T2 [S1] Verify, publish and integrate the corrected cut; parent; pending.

## Log
- L1 — «excelente, continuemos, dejemos todo en la rama dev nomás, hay varios pr abiertos todavía»
- L2 — Independent HOLD: Shell and Sources share a request sequence; overlapping healthy reads can appear superseded. Inherited Compose failure fixed in #119; preserve that fix and CSV audit when assembling.
