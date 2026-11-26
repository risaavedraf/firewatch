# PR #120 — historical CSV audit correction
Target: existing `risaavedraf/firewatch` PR #120, head `349c4aa`; keep it in draft and preserve its base.
Local tracking only; do not include this file in the correction commit.

## Specs
- S1 — «manda el arreglo porfa»

## Tasks
- T1 [S1] Worker: fix CSV audit coverage, preserve JSON behavior, and observe focused RED/GREEN; done; commit pending.
- T2 [S1] Parent + verifier: independently verify the fix and run applicable checks before publication; done.
- T3 [S1] Parent: publish only the verified correction to #120 and observe exact-head CI; in progress.

## Log
- L1 — «manda el arreglo porfa»
- L2 — Follow-up to the immediately preceding proposal: register CSV as `risk.history.read`; return a JSON `503` without a download if audit persistence fails; test both, and verify a real download before integration. Independent review `mww4jeze-5-di70` returned HOLD. Job-17 verified original head `349c4aa`, open draft, base `feat/pm-review-02-infrastructure`. No merge or updates to #121, #117 or `dev` authorized.
- L3 — Worker `mww4wskb-6-205u` observed RED exit 1 for missing CSV audit and GREEN exit 0 for the new route and handler assertions. Full gateway module tests, vet, build, and diff check passed. Three intended files changed. Real-stack download/audit acceptance not run and remains an integration gate.
- L4 — Parent job-18 risk handler, OpenAPI validator and diff check passed. Independent recheck `mww57stk-7-66de` PASS (5 focused tests, no skips, exact three-file scope). Ready to publish one correction commit. No merge is authorized.
- L5 — Job-19 published one correction commit, `ddf1277a2eea8857a2d967bc2ddcb5ae5e0d76ac`, on the existing #120 branch, with remote `dev` unchanged at `742e760`. Exact-head CI watcher job-20 is running.
