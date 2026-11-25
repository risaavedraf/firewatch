# FireWatch production visual audit

Baseline: `742e760`; the existing prototype at `docs/pitch-g1-design` (`d651459`) is a design reference, not the runtime. This first pass compares sampled production styles against the [visual baseline](VISUAL-BASELINE.md). It does not describe the entire prototype-to-product delta.

Chromium rendered the eight production routes after a real admin sign-in on the disposable stack at 1280×720 and 390×844. No horizontal page overflow or uncaught page errors were observed. The sixteen before captures are under ignored `tmp/g1-browser-baseline/before-<route>-<width>.png`. Captures establish that each view rendered, not that every asynchronous data state settled before the screenshot.

| View | Baseline observation |
| --- | --- |
| Actions | Sampled neutral tag uses the existing Actions override, 10.51:1 (`src/styles/app.css:388`). Keep it unchanged. |
| Audit | Neutral tag is 4.27:1 at 8 px, below 4.5:1 (`src/styles/app.css:117`, `src/views/AuditView.tsx:147`). |
| History | Route rendered; no targeted contrast selector was sampled. Populated, empty and filter states still need inspection. |
| Jobs | Sampled primary button text is 11.65:1. Job progress, error and completion states not audited. |
| Overview | Neutral tag is 4.27:1 at 8 px, below 4.5:1 (`src/styles/app.css:117`, `src/views/OverviewView.tsx:608`). |
| Pending | Sampled table header uses `#5c6c65` on `#f3f4ed`; the pair is documented in the baseline. No deviation established for this sample. |
| Session | Neutral tag is 4.27:1 at 8 px, below 4.5:1 (`src/styles/app.css:117`, `src/views/SessionView.tsx:297`). |
| Sources | Neutral tag is 4.27:1 at 8 px, below 4.5:1 (`src/styles/app.css:117`, `src/views/SourcesView.tsx:204`). |

## First correction: neutral tag contrast

The shared neutral tag now uses `--muted` on the same `#edf1f2` background. Before the change, the browser contrast gate failed for eight samples (four views at two sizes). After the change, all ten samples passed: Audit, Overview, Session and Sources measured **4.87:1** at both widths; Actions stayed at **10.51:1**. The sixteen corresponding after captures use `tmp/g1-browser-baseline/after-<route>-<width>.png`. The regression check targets the computed colors, not the data returned by each route; some requests were throttled during the checks.

The other source-level findings, prototype alignment, full keyboard and WCAG checks remain open.
