# FireWatch product review chain
Base: `dev` at `742e760`. Issue: [#111](https://github.com/risaavedraf/firewatch/issues/111).
Verified source candidate: `b6282b8`; verification log: `odd/tasks/pm-product-integration.md` in the final slice.

## Specs
- S1 — «ok, me parece bien entonces, hagamoslo así»

## Tasks
- T1 [S1] Parent: assemble four cumulative review cuts on an isolated tracker based on `dev`; in progress.
- T2 [S1] Parent: open the tracker in draft and one child PR per cut, each against its immediate predecessor; pending.
- T3 [S1] Parent: integrate the reviewed chain into the tracker and deliver together to `dev`, only once review and applicable CI pass; pending.

## Review order

| Slice | Verified source boundary | Scope |
| --- | --- | --- |
| 1 | `d0d9c83` | PM-07–10: persisted alerts, notifications, field observations, adoption and decision audit. |
| 2 | `1700a83` | PM-11: synthetic infrastructure and print output. |
| 3 | `ba21008` | PM-13: selected-zone risk history CSV. |
| 4 | `b6282b8` | PM-16: service status and effective rule, plus tests-only synthetic verifier correction and integrated acceptance evidence. |

```text
dev <- product tracker <- 01 PM-07–10 <- 02 PM-11 <- 03 PM-13 <- 04 PM-16 + evidence
```

The draft tracker is **not mergeable as a delivery** until all child reviews finish. Compare each child to its assigned base. Some cuts still exceed the advisory line budget: the smallest complete review units here keep API, UI, migrations, tests and documentation together. No permission for deployment, G1 design prototypes, template changes, or job-recovery scripts is inferred from this chain.

## Log
- L1 — «ok, me parece bien entonces, hagamoslo así»
- L2 — Context: user chose the feature-branch chain after confirming that the changes will land together in GitHub `dev` at the end. Verified `status:approved` on #111 and `dev` remains at `742e760`. Preserve existing candidate `b6282b8` and original source branches.
