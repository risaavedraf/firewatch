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
| `risk` | 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 13, 17, 18, 19, 20, 21 | [risk embed.go](../services/risk/migrations/embed.go):75-93 |
| `prevention` | 9, 11, 14, 15, 16 | [prevention embed.go](../services/prevention/migrations/embed.go):40-48 |
| `jobs` | 1, 2, 3, 4, 5, 6, 7 | own database, not in this ledger |

The `jobs` row covers PM-10 and PM-05: `005_audit_event_metadata.sql` added the audit
metadata, `006_query_audit_writer.sql` the gateway's insert-only query writer, and
`007_comparison_audit_action.sql` (PM-05) adds the named comparison action by
replacing that same function forward-only. None takes a number from the shared
ledger above, and none moves "next free version": the gateway writes into the jobs
database, which has its own `schema_migrations` and its own migrator.

The gaps in risk's sequence are deliberate: 9, 11, 14, 15 and 16 belong to
`prevention` — 15 is PM-09's field observations and 16 is PM-10's adoption link — and
nothing may be inserted into a gap to "tidy" the sequence. Integrating the two chains
turned those two reservations into files without moving a number: `risk` keeps 17 for
its alert table, 18 for the time-led index of the granular history series, 19 for
PM-08's personal alert state, 20 for PM-06's evaluation actor and 21 for V1-P-05's
source quality reviews, and `prevention` keeps 15 and 16, so the claims stay
disjoint.

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

## Next free version = 22

The highest version claimed in this tree is **21**, `risk`'s
`backend/services/risk/migrations/021_source_quality_reviews.sql`, so the next free
integer across both services is **22**. PM-05's jobs migration 7 is independent: it
lives in the jobs database's own ledger and does not change this determination.
Prevention's next migration must take version
22, not the next integer in its own list: `risk` holds 12 (`012_readings.sql`), 13, 17,
18, 19, 20 and 21, and `prevention` holds 9, 11, 14, 15 and 16. This paragraph is the
determination the rule asks for: a migration is numbered against the integrated tree,
never against its own module.

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

Version 21 is V1-P-05's source quality reviews (`021_source_quality_reviews.sql`). It was
claimed against the integrated tree after 20 was taken by the evaluation actor, and it
takes the next free integer the previous determination named instead of the next
integer in risk's own list. It creates one append-only table, `source_quality_reviews`,
whose CHECK constraints state the closed decision vocabulary (`incorporated`,
`acknowledged`), the 500-character note bound in CHARACTERS - so the database and the
API refuse the same notes - and a non-blank source and verified actor. `reviewed_by`
is the verified token subject, never a client-supplied field, and `reviewed_at` is set
by the server: a review is a trace of who decided and when, so no default rewrites it.
The application role holds SELECT and INSERT only, so a later decision is a new row
and no stored decision is edited or erased. The catalogue of findings those reviews
answer is not stored: it is the service's closed five-value vocabulary, derived on
every read from evidence the read already serves, so no row can disagree with the
evidence that produced it.

Version 20 is PM-06's evaluation actor (`020_batch_evaluation_actor.sql`). It was
claimed against the integrated tree after 19 was taken by the personal notification
state, and it takes the next free integer the previous determination named instead of
the next integer in risk's own list. It is additive on `batches`: two columns, one
`CHECK` and no rewrite. `evaluation_trigger` is `NOT NULL DEFAULT 'scheduler'` so the
rows written before it existed keep an honest value instead of a backfilled claim, and
`evaluated_by` stays `NULL` for a scheduled evaluation. The `CHECK` refuses
`(scheduler, actor)` and `(manual, NULL)` - and any blank actor - so the provenance
cannot contradict itself even if a future writer forgot the rule. The application role
keeps the table-level `SELECT`/`INSERT` grant from 001, so no new grant is added and
no rewrite of a stored trigger or actor becomes possible.

Version 19 is PM-08's personal notification state (`019_risk_alert_state.sql`). It was
claimed against the integrated tree after 18 was taken by the time-led history index,
and it takes the next free integer the previous determination named instead of the
next integer in risk's own list. It is additive and separate from PM-07: it creates
one append-only table keyed by the derived subject and the stored alert, rewrites no
`risk_alerts` row and changes no column of it. The application role holds SELECT and
INSERT only, the row is the trace of an explicit mark, and no gateway audit writer or
delivery record is added.

Jobs version 7 is not in this ledger: it is PM-05's
`007_comparison_audit_action.sql`, which replaces the gateway's query-writer function
in the jobs database so it accepts the named `risk.compare.read` action. It preserves
the function signature, the `SECURITY DEFINER` controls, the pinned search path, every
existing action and its sentence, and the single grant; it adds no filter parameter and
claims no shared-ledger number.

Version 18 is PM-04's time-led index for the granular history series
(`018_risk_history_series_index.sql`). It was claimed against the integrated tree
after 17 was taken by the alert table, and it takes the next free integer the
previous determination named instead of the next integer in risk's own list. It is
additive: it creates one index on `batches(requested_at, zone_id)`, rewrites no row
and leaves `batches_latest` — the index the per-zone reads use — exactly as it was.

Version 17 is PM-07's alert table (`017_risk_alerts.sql`). It was claimed against
the integrated tree after 15 and 16 were reserved by PM-09 and PM-10, and it is
the first version this branch adds: risk's highest claim is no longer 13, so the
ledger's claim table and the Job's name (`migrate-v17`) were updated with it.

Integration with PM-09/10 kept that claim where it was and added the independent
jobs ledger to the Job's name: the one ordered Job is now `migrate-v17-j6`
(`../deploy/k8s/base/jobs-migrate.yaml`), which the render contract derives from
both ledgers. No registered version moved, and PM-09's 15 and PM-10's 16 became
files without a renumber. With PM-08's 19 the derivation becomes `migrate-v19-j7`;
renaming the manifest is a deploy change and is out of scope for the migration
itself, so the Job name there still names the older versions.

Version 11 was claimed twice: `risk`'s `ml_fixture_v1` and `prevention`'s
`011_preventive_evidence.sql` both registered it, and the second migrator to run
would have skipped its own schema. Commit `030de28` moved `ml_fixture_v1` from
11 to 13 (`011_ml_fixture_v1.sql` → `013_ml_fixture_v1.sql`), leaving 11 to
prevention. That collision is why the guard above exists, and why it is a test
rather than a convention.
