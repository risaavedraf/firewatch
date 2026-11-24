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
| `prevention` | 9, 11, 14 | [prevention embed.go](../services/prevention/migrations/embed.go):39-45 |
| `jobs` | 1, 2, 3, 4 | own database, not in this ledger |

The gaps are deliberate: 9, 11 and 14 belong to `prevention`, and nothing may be
inserted into a gap to "tidy" the sequence. Versions 15 and 16 are reserved by
the registered sibling branches of PM-09 and PM-10, so no module in this tree
claims them either: taking one of those numbers here would make the sibling's
migration skip in silence once the branches are integrated.

## The rule

1. Versions are global across `risk` and `prevention`. One integer, one owner,
   across both modules.
2. A new migration takes the next free integer with **both** services counted,
   not the next integer in its own list.
3. An existing registered version is never renumbered. A version already
   recorded in a deployed ledger cannot be moved: the old row stays and the
   renamed migration never runs.
4. `jobs` versions are independent because the ledger is per database, so `jobs`
   may use 1–4 while `risk` uses 1.
5. A collision is a test failure, not a review comment. The guard below already
   exists; a reviewer does not need to spot the overlap by eye.

## Next free version = 18

The highest version claimed in this tree is **17**, `risk`'s
`backend/services/risk/migrations/017_risk_alerts.sql`, so the next free integer
across both services is **18**. Prevention's next migration must take version 18,
not the next integer in its own list: `risk` holds 12 (`012_readings.sql`), 13 and
17, `prevention` holds 9, 11 and 14, and 15 and 16 are reserved by the sibling
branches of PM-09 and PM-10. This paragraph is the determination the rule asks
for: a migration is numbered against the integrated tree, never against its own
module.

The previous determination said 15 and was consumed twice over by the PM-09 and
PM-10 reservations before any file existed in this tree. That is the rule working,
not an exception: a version is reserved when a registered branch claims it, and
this section is updated with the claim so it never names a version someone already
owns.

## Enforcement

`TestVersionsDoNotCollideWithPrevention`
([migrations_test.go](../services/risk/migrations/migrations_test.go):75) is the
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

Version 11 was claimed twice: `risk`'s `ml_fixture_v1` and `prevention`'s
`011_preventive_evidence.sql` both registered it, and the second migrator to run
would have skipped its own schema. Commit `030de28` moved `ml_fixture_v1` from
11 to 13 (`011_ml_fixture_v1.sql` → `013_ml_fixture_v1.sql`), leaving 11 to
prevention. That collision is why the guard above exists, and why it is a test
rather than a convention.
