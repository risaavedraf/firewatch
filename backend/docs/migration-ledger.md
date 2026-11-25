# Shared migration ledger — version rule

`risk` and `prevention` both record the migrations they apply into the same
`schema_migrations` table of the same database. The ledger key is the version
number alone: it stores no filename, no owner and no sender, and each migrator
skips any version already present. A version is therefore a repository-wide
resource shared by several services, not a per-service counter, and two services
claiming the same integer make whichever migrator runs second skip its own
migration in silence — which surfaces later as a missing table, not as an error.
`jobs` migrates its own database with its own ledger and does not participate in
this one, so its versions cannot collide with the two below.

## Current claims

| Module | Versions in the shared ledger | Source |
| --- | --- | --- |
| `risk` | 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 13, 17 | [risk embed.go](../services/risk/migrations/embed.go):68-80 |
| `prevention` | 9, 11, 14, 15, 16 | [prevention embed.go](../services/prevention/migrations/embed.go):40-48 |
| `jobs` | 1, 2, 3, 4, 5, 6 | own database, not in this ledger |

The `jobs` row is complete as of PM-10: `005_audit_event_metadata.sql` added the audit
metadata and `006_query_audit_writer.sql` the gateway's insert-only query writer.
Neither takes a number from the shared ledger above, and neither moves "next free
version": the gateway writes into the jobs database, which has its own
`schema_migrations` and its own migrator.

The gaps in risk's sequence are deliberate: 9, 11, 14, 15 and 16 belong to
`prevention` — 15 is PM-09's field observations and 16 is PM-10's adoption link — and
nothing may be inserted into a gap to "tidy" the sequence. Integrating the two chains
turned those two reservations into files without moving a number: `risk` keeps 17 for
its alert table and `prevention` keeps 15 and 16, so the claims stay disjoint.

## The rule

1. Versions are global across `risk` and `prevention`. One integer, one owner,
   across both modules.
2. A new migration takes the next free integer with **both** services counted,
   not the next integer in its own list.
3. An existing registered version is never renumbered. A version already
   recorded in a deployed ledger cannot be moved: the old row stays and the
   renamed migration never runs.
4. `jobs` versions are independent because the ledger is per database, so `jobs`
   may use 1–6 while `risk` uses 1.
5. A collision is a test failure, not a review comment. The guard below already
   exists; a reviewer does not need to spot the overlap by eye.

## Next free version = 18

The highest version claimed in this tree is **17**, `risk`'s
`backend/services/risk/migrations/017_risk_alerts.sql`, so the next free integer
across both services is **18**. Prevention's next migration must take version 18,
not the next integer in its own list: `risk` holds 12 (`012_readings.sql`), 13 and
17, and `prevention` holds 9, 11, 14, 15 and 16. This paragraph is the
determination the rule asks for: a migration is numbered against the integrated
tree, never against its own module.

The previous determinations were consumed in order, and that is the rule working,
not an exception: this section said 15 when PM-09 and PM-10 reserved 15 and 16
before either file existed here, and it said 17 once PM-10 had claimed 16 for the
[observation adoption migration](../services/prevention/migrations/016_observation_adoption.sql)
on its own branch. A version is reserved or claimed when a registered branch takes
it, and this section is updated with each claim so it never names a version someone
already owns.

## Enforcement

`TestVersionsDoNotCollideWithPrevention`
([migrations_test.go](../services/risk/migrations/migrations_test.go):76) is the
only cross-service guard. It reads
`backend/services/prevention/migrations/embed.go` as text, parses every
`{Version: N,` entry of prevention's `All()` list, and fails with `t.Errorf` for
each `risk` migration whose version prevention also claims. The pointer to the
documents rather than imports them because the two services are separate Go
modules with no shared package. It also fails when it parses no version at all,
so it cannot pass vacuously. Prevention has no reciprocal test and does not need
one: risk's guard reads prevention's file, so one test covers both directions
whenever the tree is complete.

**Known limitation.** When the sibling module is absent from the checkout the
guard skips instead of failing: the two services are separate modules and CI can
build one alone, so a per-service job or a per-service container image sees no
`prevention` directory to read. The guard therefore protects the integrated tree
and cannot protect a split one. That is a declared limit, not a passing
guarantee — a green run in a split tree proves nothing about collisions, and the
claim only holds where both modules were checked out together.

## History

Version 17 is PM-07's alert table (`017_risk_alerts.sql`). It was claimed against
the integrated tree after 15 and 16 were reserved by PM-09 and PM-10, and it is
the first version this branch adds: risk's highest claim is no longer 13, so the
ledger's claim table and the Job's name (`migrate-v17`) were updated with it.

Integration with PM-09/10 kept that claim where it was and added the independent
jobs ledger to the Job's name: the one ordered Job is now `migrate-v17-j6`
(`../deploy/k8s/base/jobs-migrate.yaml`), which the render contract derives from
both ledgers. No registered version moved, and PM-09's 15 and PM-10's 16 became
files without a renumber.

Version 11 was claimed twice: `risk`'s `ml_fixture_v1` and `prevention`'s
`011_preventive_evidence.sql` both registered it, and the second migrator to run
would have skipped its own schema. Commit `030de28` moved `ml_fixture_v1` from
11 to 13 (`011_ml_fixture_v1.sql` → `013_ml_fixture_v1.sql`), leaving 11 to
prevention. That collision is why the guard above exists, and why it is a test
rather than a convention.
